import type { SupabaseClient } from "@supabase/supabase-js";
import type { Caller } from "@/lib/api-auth";
import { apiError, HINTS, type ApiError, type ApiErrorCode } from "@/lib/api-errors";
import { PLAN_REQUIRED_HINT, PLAN_REQUIRED_MESSAGE, paidAccessDenial } from "@/lib/paid-access";
import { accountCapacityDenial } from "@/lib/limits/guard";
import { createAdminClient } from "@/lib/supabase/admin";
import { NO_BUSINESS_RESPONSE } from "@/lib/tenancy";
import { ToolError, needsSubscription, requiredScopes, type OwnableTable, type Tool } from "./tool";
import type { ToolRegistry } from "./registry";
import { registryFor } from "./owner";
import { SITE_ARGUMENT_NAME, SiteArgument, callerForSite, takesSite } from "./site";
import { burstDenial, dailyCapDenial, recordToolCall, type LimitDenial, type LimitSubject } from "./usage";

/**
 * Runs one tool for one caller, the same way for every surface, and is
 * where tenancy for API callers is enforced (docs/API.md "Tenancy").
 *
 * In order: an API key (or an app connected over OAuth) is under its burst
 * limit; the tool exists; the account has an active plan (every tool but the
 * owner's, since 2026-11-16: one standard refusal, `planRefusal`); the
 * credential holds every scope it needs (`spend` too, for a paid tool); the
 * caller has a site, the one the input's optional `site` names when it
 * names one of the sites the credential covers (lib/tools/site.ts); the
 * input passes the tool's schema; every id the input
 * names (`owns`) is a row of the caller's user AND site; the key or app is under its daily
 * cap on the tool; for a paid tool, the account is under its daily AI spend
 * ceiling and its own daily cap on the tool, whatever the caller, a session,
 * a key or an OAuth app (lib/limits/guard.ts); the handler,
 * which gets only the caller's client, user and site; the output passes the
 * tool's schema. Every refusal is `{ code, message, hint? }` with an HTTP
 * status: the REST runner sends it as `{ error }`, MCP as a tool result with
 * `isError`.
 *
 * Every call, whatever its outcome, is then recorded in `tool_calls`
 * (lib/tools/usage.ts), without waiting and without being able to fail the
 * call; the per-key limits read that table and fail open when it cannot be
 * read.
 */

export type ToolRun =
  | { ok: true; output: Record<string, unknown> }
  | { ok: false; status: number; error: ApiError; retryAfterSeconds?: number };

export interface RunToolDeps {
  registry?: ToolRegistry;
  admin?: () => SupabaseClient;
  /** The clock the per-key limits and the audit row read; tests pin it. */
  now?: () => Date;
}

const fail = (status: number, code: ApiErrorCode, message: string, hint?: string): ToolRun => ({
  ok: false,
  status,
  error: apiError(code, message, hint),
});

/** A table's rows as a refusal names them. Partial: a table added to OWNABLE_TABLES reads as its own name until it gets a noun. */
const NOUN: Partial<Record<OwnableTable, string>> = {
  placement_targets: "reply target",
  placements: "draft",
  jobs: "job",
  keywords: "keyword",
  articles: "article",
  aeo_queries: "prompt",
  draft_feedback: "note",
  article_pushes: "push",
};

function log(level: "info" | "error", fields: Record<string, unknown>) {
  const line = JSON.stringify({ level, event: "tool.call", ...fields });
  if (level === "error") console.error(line);
  else console.info(line);
}

/** Zod issues as `path: message` sentences, the shape the routes already answer with. */
function describeIssues(issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>): string {
  return issues.map((issue) => `${issue.path.map(String).join(".") || "input"}: ${issue.message}`).join("; ");
}

/**
 * The first id in `input` that is not a row of this user and this site, or
 * null when every one is. Through the caller's own client (RLS, or the
 * owner-scoped service role) AND with both filters spelled out, so the
 * check holds whichever client it is.
 */
async function foreignId(
  caller: Caller,
  businessId: string,
  owns: Readonly<Record<string, OwnableTable>>,
  input: Record<string, unknown>
): Promise<{ field: string; table: OwnableTable } | null> {
  for (const [field, table] of Object.entries(owns)) {
    const value = input[field];
    if (value === undefined || value === null) continue;
    // One id or a list of them (delete_keywords): every one must be this site's.
    const ids = [...new Set(Array.isArray(value) ? value : [value])];
    if (ids.length === 0) continue;
    if (ids.some((id) => typeof id !== "string")) return { field, table };
    const { data, error } = await caller.client
      .from(table)
      .select("id")
      .in("id", ids)
      .eq("business_id", businessId)
      .eq("user_id", caller.userId);
    if (error || (data ?? []).length !== ids.length) return { field, table };
  }
  return null;
}

export async function runTool(caller: Caller, name: string, rawInput: unknown, deps: RunToolDeps = {}): Promise<ToolRun> {
  const admin = deps.admin ?? createAdminClient;
  const now = deps.now ?? (() => new Date());
  const startedAt = now();
  const started = Date.now();
  const meter: Meter = { costUsd: null, businessId: caller.businessId };

  const run = await execute(caller, name, rawInput, { ...deps, admin, now }, meter);

  recordToolCall(admin, {
    userId: caller.userId,
    businessId: meter.businessId,
    apiKeyId: caller.keyId,
    oauthClientId: caller.oauth?.clientId ?? null,
    tool: name,
    status: run.ok ? "ok" : run.error.code,
    costUsd: meter.costUsd,
    durationMs: Date.now() - started,
    at: startedAt,
  });
  return run;
}

/** What the handler reported it cost, and the site the call was about, for the audit row. */
interface Meter {
  costUsd: number | null;
  businessId: string | null;
}

/**
 * The input without its `site` argument, and that argument: the runner
 * resolves it, the tool's own schema never sees it.
 */
function takeSite(rawInput: unknown): { input: unknown; site: unknown } {
  if (!rawInput || typeof rawInput !== "object" || Array.isArray(rawInput) || !(SITE_ARGUMENT_NAME in rawInput)) {
    return { input: rawInput, site: undefined };
  }
  const { [SITE_ARGUMENT_NAME]: site, ...rest } = rawInput as Record<string, unknown>;
  return { input: rest, site };
}

/**
 * What the per-key limits count on for this caller: its API key, or the app
 * it connected through over OAuth (for this account). A session is not
 * limited.
 */
function limitSubject(caller: Caller): LimitSubject | null {
  if (caller.via === "api_key") return caller.keyId;
  if (caller.via === "oauth" && caller.oauth) return { oauthClientId: caller.oauth.clientId, userId: caller.userId };
  return null;
}

/**
 * The one refusal for an account without an active plan, every tool, every
 * surface: 402 `subscription_required` (lib/paid-access.ts says why it reads
 * as it does).
 */
export function planRefusal(): ToolRun {
  return fail(402, "subscription_required", PLAN_REQUIRED_MESSAGE, PLAN_REQUIRED_HINT);
}

/** A key's limit as the API's refusal. */
function limitRefusal(denial: LimitDenial): ToolRun {
  if (denial.code === "rate_limited") {
    return {
      ok: false,
      status: 429,
      error: apiError("rate_limited", denial.message, HINTS.rateLimit),
      ...(denial.retryAfterSeconds ? { retryAfterSeconds: denial.retryAfterSeconds } : {}),
    };
  }
  return fail(429, "cap_reached", denial.message, HINTS.keyCaps);
}

async function execute(
  caller: Caller,
  name: string,
  rawInput: unknown,
  deps: RunToolDeps & { admin: () => SupabaseClient; now: () => Date },
  meter: Meter
): Promise<ToolRun> {
  // An API key's (or a connected app's) burst limit comes first: it covers
  // every call, unknown names and refusals included.
  const subject = limitSubject(caller);
  if (subject) {
    const burst = await burstDenial(deps.admin, subject, deps.now());
    if (burst) return limitRefusal(burst);
  }

  const registry = deps.registry ?? registryFor(caller.userId);
  const tool: Tool | undefined = registry.get(name);
  if (!tool) return fail(404, "unknown_tool", `There is no tool named ${name}.`, "GET /api/v1/tools, or MCP tools/list, lists them.");

  // The plan comes before everything the caller could fix with a different
  // call: without one, every tool answers the same sentence, whatever its
  // scope, input or site (docs/API.md "Without a plan").
  if (needsSubscription(tool)) {
    const denial = await paidAccessDenial({ id: caller.userId }, caller.client);
    if (denial) return planRefusal();
  }

  const missing = requiredScopes(tool).filter((scope) => !caller.scopes.includes(scope));
  if (missing.length > 0) {
    const scopes = `the ${missing.join(" and ")} scope${missing.length > 1 ? "s" : ""}`;
    return caller.via === "oauth"
      ? fail(
          403,
          "forbidden_scope",
          `${tool.name} needs ${scopes}, which this connection was not granted.`,
          `Remove the connector and connect again, ticking it on the consent screen. ${HINTS.connectedApps}`
        )
      : fail(403, "forbidden_scope", `${tool.name} needs a key with ${scopes}.`, HINTS.keys);
  }

  // The site the input names, if it names one (lib/tools/site.ts): resolved
  // before anything reads the site, so ownership, caps and the handler all
  // see that site, and only one the credential covers.
  const named = takesSite(tool) ? takeSite(rawInput) : { input: rawInput, site: undefined };
  rawInput = named.input;
  if (named.site !== undefined && named.site !== null && named.site !== "") {
    const site = SiteArgument.safeParse(named.site);
    if (!site.success) return fail(400, "invalid_input", describeIssues(site.error.issues.map((i) => ({ ...i, path: ["site", ...i.path] }))));
    try {
      caller = await callerForSite(caller, site.data, deps.admin);
    } catch (error) {
      if (error instanceof ToolError) return fail(error.status, error.code, error.message, error.hint);
      log("error", { tool: tool.name, via: caller.via, user_id: caller.userId, outcome: "internal", step: "site", error: String(error).slice(0, 300) });
      return fail(500, "internal", "Could not read this account's sites. Try again; the error was logged.");
    }
    meter.businessId = caller.businessId;
  }

  const needsBusiness = tool.needsBusiness !== false;
  if (needsBusiness && !caller.businessId) {
    return fail(409, NO_BUSINESS_RESPONSE.code, NO_BUSINESS_RESPONSE.error, HINTS.addSite);
  }
  const businessId = caller.businessId ?? "";

  const parsed = tool.input.safeParse(rawInput ?? {});
  if (!parsed.success) return fail(400, "invalid_input", describeIssues(parsed.error.issues));
  const input = parsed.data as Record<string, unknown>;

  const started = Date.now();
  const fields = {
    tool: tool.name,
    via: caller.via,
    user_id: caller.userId,
    business_id: caller.businessId,
    key_id: caller.keyId,
    ...(caller.oauth ? { oauth_client_id: caller.oauth.clientId } : {}),
  };
  try {
    if (tool.owns) {
      const foreign = await foreignId(caller, businessId, tool.owns, input);
      if (foreign) {
        log("info", { ...fields, outcome: "not_found", field: foreign.field });
        const noun = NOUN[foreign.table] ?? foreign.table.replace(/_/g, " ");
        return fail(404, "not_found", `No ${noun} with that ${foreign.field} on this site.`);
      }
    }

    if (subject) {
      const capped = await dailyCapDenial(deps.admin, subject, tool.name, deps.now());
      if (capped) {
        log("info", { ...fields, outcome: capped.code });
        return limitRefusal(capped);
      }
    }

    if (tool.paid) {
      const account = await accountCapacityDenial(deps.admin, caller.userId, tool.name, deps.now());
      if (account) {
        log("info", { ...fields, outcome: account.code });
        const hint = account.code === "spend_cap_reached" ? HINTS.spendCap : account.code === "cap_reached" ? HINTS.accountCaps : undefined;
        return fail(account.status, account.code, account.message, hint);
      }
    }

    const result = await tool.handler(
      {
        via: caller.via,
        userId: caller.userId,
        businessId,
        client: caller.client,
        admin: deps.admin,
        caller,
        reportCost: (usd: number) => {
          if (Number.isFinite(usd) && usd >= 0) meter.costUsd = Number(((meter.costUsd ?? 0) + usd).toFixed(6));
        },
      },
      input
    );

    const output = tool.output.safeParse(result);
    if (!output.success) {
      log("error", { ...fields, outcome: "invalid_output", issues: describeIssues(output.error.issues).slice(0, 500) });
      return fail(500, "internal", `${tool.name} produced a result that does not match its schema. This is a bug on our side; it was logged.`);
    }
    log("info", { ...fields, outcome: "ok", ms: Date.now() - started });
    return { ok: true, output: output.data as Record<string, unknown> };
  } catch (error) {
    if (error instanceof ToolError) {
      log("info", { ...fields, outcome: error.code, ms: Date.now() - started });
      return fail(error.status, error.code, error.message, error.hint);
    }
    log("error", {
      ...fields,
      outcome: "internal",
      ms: Date.now() - started,
      error: error instanceof Error ? `${error.name}: ${error.message}`.slice(0, 500) : String(error),
    });
    return fail(500, "internal", `${tool.name} failed on our side. Try again; the error was logged.`);
  }
}
