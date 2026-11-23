import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ApiKeyScope } from "@/lib/api-keys";
import type { Caller, CallerVia } from "@/lib/api-auth";
import type { ApiErrorCode } from "@/lib/api-errors";

/**
 * A tool is the platform's public verb (docs/ARCHITECTURE.md §4): one
 * capability, with a Zod schema for what goes in and what comes out, that
 * the REST runner (`/api/v1/tools/:name`) and the MCP server (`/api/mcp`)
 * both serve from one registry, so a capability cannot behave differently
 * across them.
 *
 * A handler holds no business logic of its own: it calls the function the
 * screens' route calls and maps the result. Everything else is the
 * runner's, once, for every tool (lib/tools/runner.ts): the credential's
 * scopes, the site, the ownership of every id the input names (`owns`), the
 * paywall, input and output validation, and the error shape.
 */

/** What a tool does: reads, changes the account's data, or publishes in the owner's name. */
export type ToolScope = Exclude<ApiKeyScope, "spend">;

/** Tables whose ids a tool input may name, checked by the runner against the caller's site. */
export const OWNABLE_TABLES = [
  "placement_targets",
  "placements",
  "jobs",
  "keywords",
  "articles",
  "aeo_queries",
  "draft_feedback",
  "article_pushes",
] as const;
export type OwnableTable = (typeof OWNABLE_TABLES)[number];

export interface ToolContext {
  via: CallerVia;
  userId: string;
  /**
   * The site the call is about, picked from the caller's own businesses.
   * Always set for a tool that `needsBusiness` (the default); an empty
   * string for one that does not, which must read `caller` instead.
   */
  businessId: string;
  /**
   * The caller's Supabase client: the person's RLS client for a session, the
   * owner-scoped service role for an API key (lib/supabase/owner-scoped.ts).
   * What a route passes as `supabase`.
   */
  client: SupabaseClient;
  /**
   * The unnarrowed service role, for exactly what the routes use it for: the
   * inserts users have no policy for and the job queue. Every such write
   * names `userId` and `businessId` from this context, never from input.
   */
  admin: () => SupabaseClient;
  /** The resolved caller, for tools about the caller itself (`whoami`). */
  caller: Caller;
  /**
   * Records what this call measurably cost, in USD, on its audit row
   * (`tool_calls.cost_usd`, lib/tools/usage.ts). Call it only with a
   * measured number: a call that never reports stays null, "not measured",
   * never 0. Set by the runner; optional so a context built by hand (a
   * test) needs none.
   */
  reportCost?: (usd: number) => void;
}

export interface ToolSpec<I extends z.ZodType, O extends z.ZodType> {
  /** snake_case, verb first, what an agent calls: `list_reply_inbox`. */
  name: string;
  /** A few words for a person: "List the reply inbox". */
  title: string;
  /** What an external agent reads to decide whether to call it. */
  description: string;
  input: I;
  output: O;
  /** `read` lists and reads; `write` changes the account's data; `publish` acts in the owner's name somewhere public. */
  scope: ToolScope;
  /**
   * Costs money (a model call, or a job that makes one): the key also needs
   * the `spend` scope, and the paywall runs first (`paidAccessDenial`,
   * lib/paid-access.ts), the check the matching route makes.
   */
  paid: boolean;
  /**
   * Spends nothing, but the matching route keeps it for subscribers ("Write
   * your own"). Since 2026-11-16 every tool needs a plan (see `withoutPlan`),
   * so this only documents that the screen's route checks it too.
   */
  requiresSubscription?: boolean;
  /**
   * Callable without an active plan. Only the platform owner's tools
   * (lib/tools/owner.ts), which their handler gates on the owner: every
   * customer tool needs an active plan, and a caller without one gets the
   * one standard refusal (`PLAN_REQUIRED_MESSAGE`, lib/paid-access.ts).
   * Never on a paid tool. Default false.
   */
  withoutPlan?: boolean;
  /** False for the few tools about the caller rather than a site (`whoami`). Default true. */
  needsBusiness?: boolean;
  /**
   * Input fields that name a row, and the table it must be in. The runner
   * checks each against the caller's user AND site before the handler runs,
   * and answers 404 `not_found` otherwise: a handler never sees an id of
   * another account or another site. A field may hold one id or an array of
   * them; every one must be this site's.
   */
  owns?: Readonly<Record<string, OwnableTable>>;
  /** Deletes the customer's data (MCP's `destructiveHint`, so a client asks first). Default false. */
  destructive?: boolean;
  /** Method syntax on purpose: the registry stores tools of every input type. */
  handler(ctx: ToolContext, input: z.output<I>): Promise<z.input<O>>;
}

export type Tool<I extends z.ZodType = z.ZodType, O extends z.ZodType = z.ZodType> = Readonly<ToolSpec<I, O>>;

/** The scopes a key needs to call `tool`: its own, plus `spend` when it is paid. */
export function requiredScopes(tool: Pick<Tool, "scope" | "paid">): ApiKeyScope[] {
  return tool.paid ? [tool.scope, "spend"] : [tool.scope];
}

/**
 * Whether the paywall runs before `tool`: for every tool but the few marked
 * `withoutPlan`, and always for a paid one (owner decision, 2026-11-16: GTF
 * through MCP or the API needs an active plan, reads included).
 */
export function needsSubscription(tool: Pick<Tool, "paid" | "requiresSubscription" | "withoutPlan">): boolean {
  return tool.paid || tool.requiresSubscription === true || tool.withoutPlan !== true;
}

export type ToolErrorStatus = 400 | 402 | 403 | 404 | 409 | 429 | 500 | 502 | 503;

/**
 * A refusal a handler means: the post is gone, the move is not allowed, the
 * daily cap is reached. `code` is one of the stable API codes
 * (lib/api-errors.ts); `message` is the sentence the screens show for the
 * same case; `hint` says what to do about it.
 */
export class ToolError extends Error {
  readonly code: ApiErrorCode;
  readonly status: ToolErrorStatus;
  readonly hint?: string;

  constructor(code: ApiErrorCode, message: string, status: ToolErrorStatus, hint?: string) {
    super(message);
    this.name = "ToolError";
    this.code = code;
    this.status = status;
    this.hint = hint;
  }
}

export const TOOL_NAME = /^[a-z][a-z0-9_]{2,63}$/;

/**
 * A tool, checked once when the module loads: a malformed definition is a
 * deploy that fails its tests, not a tool that fails when an agent calls it.
 * Inputs and outputs are objects because MCP requires an object schema for
 * both, and an object leaves room to add a field without breaking callers.
 */
export function defineTool<I extends z.ZodType, O extends z.ZodType>(spec: ToolSpec<I, O>): Tool<I, O> {
  if (!TOOL_NAME.test(spec.name)) {
    throw new Error(`Tool name "${spec.name}" must be snake_case: a letter, then 2 to 63 of a-z, 0-9, _.`);
  }
  if (!spec.title.trim()) throw new Error(`Tool ${spec.name} needs a title.`);
  if (spec.description.trim().length < 20) throw new Error(`Tool ${spec.name} needs a description an agent can act on.`);
  if (!(spec.input instanceof z.ZodObject)) throw new Error(`Tool ${spec.name}: input must be a z.object schema.`);
  if (!(spec.output instanceof z.ZodObject)) throw new Error(`Tool ${spec.name}: output must be a z.object schema.`);
  if (!["read", "write", "publish"].includes(spec.scope)) {
    throw new Error(`Tool ${spec.name}: scope must be read, write or publish (paid adds spend).`);
  }
  if (typeof spec.paid !== "boolean") throw new Error(`Tool ${spec.name}: paid must be true or false.`);
  if (spec.paid && spec.scope === "read") throw new Error(`Tool ${spec.name}: a paid tool changes something; its scope cannot be read.`);
  if (spec.paid && spec.withoutPlan) throw new Error(`Tool ${spec.name}: a paid tool always needs a plan; it cannot be withoutPlan.`);
  if (typeof spec.handler !== "function") throw new Error(`Tool ${spec.name} needs a handler.`);
  const shape = (spec.input as unknown as z.ZodObject).shape;
  // The runner takes `site` off the input of every site-scoped tool (lib/tools/site.ts).
  if (spec.needsBusiness !== false && "site" in shape) {
    throw new Error(`Tool ${spec.name}: site is the runner's argument for choosing the site; name the field otherwise.`);
  }
  for (const [field, table] of Object.entries(spec.owns ?? {})) {
    if (!(field in shape)) throw new Error(`Tool ${spec.name}: owns names ${field}, which is not an input field.`);
    if (!(OWNABLE_TABLES as readonly string[]).includes(table)) {
      throw new Error(`Tool ${spec.name}: ${table} is not a table the runner can check ownership on.`);
    }
  }
  return Object.freeze({ ...spec });
}
