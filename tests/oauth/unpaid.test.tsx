import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { FakeSupabase } from "../support/fake-supabase";
import { SITE_A, USER, asClient, authorizeParams, codeForm, consent, register, seedDb } from "./support";

/**
 * A caller whose account has no active plan, at every step (owner decision,
 * 2026-11-16; docs/API.md "Without a plan"). What is pinned, through the real
 * `hasActiveSubscription` (no mock) and the real routes:
 *
 * - no account: the MCP endpoint answers 401 with `resource_metadata` (never
 *   403), and the consent page sends a stranger to sign-up and back;
 * - an account without a plan, one whose plan ended, one whose plan was
 *   cancelled: consent and the token work, the consent screen says what that
 *   means, `initialize`, `tools/list` and `prompts/list` work, and every tool
 *   call (read, write or paid, over MCP or REST) answers the one standard
 *   refusal: 402 `subscription_required`, PLAN_REQUIRED_MESSAGE, which names
 *   no price and no pricing page;
 * - an active plan (or a live trial): the same calls work.
 */

const state = vi.hoisted(() => ({ db: null as unknown as FakeSupabase }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => state.db }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { getUser: async () => ({ data: { user: null } }) } }),
}));

import { POST as mcpPost } from "@/app/api/mcp/route";
import { POST as restPost } from "@/app/api/v1/tools/[name]/route";
import { createApiKey } from "@/lib/api-keys";
import { findClient } from "@/lib/oauth/clients";
import { prepareConsent } from "@/lib/oauth/authorize";
import { exchangeAuthorizationCode } from "@/lib/oauth/tokens";
import { BILLING_URL, PLAN_REQUIRED_HINT, PLAN_REQUIRED_MESSAGE } from "@/lib/paid-access";
import { MCP_INSTRUCTIONS } from "@/lib/tools/mcp";
import { ConsentScreen } from "@/components/oauth/consent-screen";

const FUTURE = "2999-01-01T00:00:00.000Z";
const PAST = "2026-01-01T00:00:00.000Z";

function plan(status: string, currentPeriodEnd: string | null) {
  return {
    id: `sub-${status}`,
    user_id: USER,
    stripe_customer_id: "cus_1",
    stripe_subscription_id: `sub_${status}`,
    status,
    current_period_start: "2025-12-01T00:00:00.000Z",
    current_period_end: currentPeriodEnd,
    cancel_at_period_end: false,
    created_at: "2025-12-01T00:00:00.000Z",
    updated_at: "2025-12-01T00:00:00.000Z",
  };
}

const CASES = {
  "no plan at all": [],
  "a plan whose period ended": [plan("active", PAST)],
  "a cancelled plan": [plan("canceled", FUTURE)],
  "an unpaid plan": [plan("past_due", FUTURE)],
} as const;

let clientId: string;
beforeEach(async () => {
  state.db = seedDb();
  state.db.tables.subscriptions = [];
  state.db.tables.api_keys = [];
  clientId = (await register(state.db)).clientId;
});

async function accessToken(grant: string[] = ["read", "write", "spend"]): Promise<string> {
  const code = await consent(state.db, clientId, { grant, site: SITE_A }, new Date());
  const client = await findClient(asClient(state.db), clientId);
  if (!client) throw new Error("no client");
  const result = await exchangeAuthorizationCode(asClient(state.db), client, codeForm(clientId, code));
  if (!result.ok) throw new Error(result.description);
  return result.body.access_token;
}

let rpcId = 0;
async function rpc(token: string | null, method: string, params?: Record<string, unknown>) {
  const response = await mcpPost(
    new Request("https://gettrafficfa.st/api/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-06-18",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, ...(params ? { params } : {}) }),
    })
  );
  return { status: response.status, headers: response.headers, body: (await response.json()) as Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
}

const toolError = (body: Record<string, any>) => JSON.parse(body.result.content[0].text).error; // eslint-disable-line @typescript-eslint/no-explicit-any

const STANDARD = { code: "subscription_required", message: PLAN_REQUIRED_MESSAGE, hint: PLAN_REQUIRED_HINT };

describe("the standard refusal", () => {
  it("is factual: names the account's Billing page, no price, no pricing page, no sales words", () => {
    for (const text of [PLAN_REQUIRED_MESSAGE, PLAN_REQUIRED_HINT]) {
      expect(text).not.toMatch(/\$|€|£|\d+\s*(?:\/|per)\s*(?:mo|month)/i);
      expect(text).not.toMatch(/upgrade|buy|purchase|subscribe now|pricing|free trial|discount/i);
    }
    expect(PLAN_REQUIRED_MESSAGE).toBe(
      "This GetTrafficFast account has no active plan, so its tools are unavailable. The account owner can manage the plan at https://gettrafficfa.st/settings/billing."
    );
    expect(PLAN_REQUIRED_MESSAGE).toContain(BILLING_URL);
  });

  it("is what the MCP instructions tell the agent to expect and say, without promoting a plan", () => {
    expect(MCP_INSTRUCTIONS).toContain("subscription_required");
    expect(MCP_INSTRUCTIONS).toContain("do not retry");
    expect(MCP_INSTRUCTIONS).toContain(BILLING_URL);
    expect(MCP_INSTRUCTIONS).not.toMatch(/\/pricing|upgrade|buy|\$/i);
  });
});

describe("no account", () => {
  it("POST /api/mcp without a credential is 401 with resource_metadata, never 403", async () => {
    const anonymous = await rpc(null, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "scanner", version: "0" },
    });
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get("www-authenticate")).toContain(
      'resource_metadata="https://gettrafficfa.st/.well-known/oauth-protected-resource/api/mcp"'
    );
    expect(anonymous.body.error.code).toBe("unauthorized");
  });

  it("the consent page sends a stranger to sign-up, and back to the same request after", async () => {
    const step = await prepareConsent(authorizeParams(clientId), { admin: asClient(state.db), userId: null });
    expect(step.kind).toBe("redirect");
    if (step.kind !== "redirect") return;
    const url = new URL(step.location, "https://gettrafficfa.st");
    expect(url.pathname).toBe("/auth/sign-up");
    expect(url.searchParams.get("next")).toMatch(/^\/oauth\/authorize\?/);
  });
});

describe.each(Object.entries(CASES))("an account with %s", (_label, rows) => {
  beforeEach(() => {
    state.db.tables.subscriptions = rows.map((row) => ({ ...row }));
  });

  it("may connect: consent gives a code and the code a token", async () => {
    const token = await accessToken();
    expect(token).toMatch(/^gtfat_/);
  });

  it("initializes, lists tools and lists prompts, so the agent can explain", async () => {
    const token = await accessToken();
    const init = await rpc(token, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "0" },
    });
    expect(init.status).toBe(200);
    expect(init.body.result.instructions).toContain("subscription_required");
    const tools = await rpc(token, "tools/list");
    expect(tools.body.result.tools.length).toBeGreaterThan(10);
    const prompts = await rpc(token, "prompts/list");
    expect(prompts.body.result.prompts.map((p: { name: string }) => p.name)).toEqual(["daily_routine", "weekly_review"]);
  });

  it("gets the one standard refusal from every tool, read, write or paid, and nothing else is read", async () => {
    const token = await accessToken();
    for (const [name, args] of [
      ["whoami", {}],
      ["list_reply_inbox", { status: "open" }],
      ["get_subscription", {}],
      ["add_keywords", { keywords: ["seo"] }],
      ["draft_reply", { targetId: "t-a" }],
    ] as const) {
      const called = await rpc(token, "tools/call", { name, arguments: args });
      expect(called.status, name).toBe(200);
      expect(called.body.result.isError, name).toBe(true);
      expect(toolError(called.body), name).toEqual(STANDARD);
    }
  });

  it("gets the same refusal from the REST runner with an API key, as a 402", async () => {
    const key = await createApiKey(asClient(state.db), { userId: USER, name: "k", businessId: SITE_A });
    if (!key.ok) throw new Error(key.error);
    const response = await restPost(
      new Request("https://gettrafficfa.st/api/v1/tools/list_reply_inbox", {
        method: "POST",
        headers: { authorization: `Bearer ${key.key}` },
        body: "{}",
      }) as never,
      { params: Promise.resolve({ name: "list_reply_inbox" }) }
    );
    expect(response.status).toBe(402);
    expect(await response.json()).toEqual({ error: STANDARD });
  });
});

describe.each([
  ["an active plan", plan("active", FUTURE)],
  ["a live trial", plan("trialing", FUTURE)],
  ["an active plan with no period end yet", plan("active", null)],
])("an account with %s", (_label, row) => {
  it("calls tools as usual", async () => {
    state.db.tables.subscriptions = [{ ...row }];
    const token = await accessToken();
    const called = await rpc(token, "tools/call", { name: "whoami", arguments: {} });
    expect(called.body.result.isError).toBeFalsy();
    expect(called.body.result.structuredContent).toMatchObject({ userId: USER });
  });
});

describe("the consent screen", () => {
  const props = {
    action: "/oauth/authorize/decision",
    hidden: [] as Array<[string, string]>,
    clientName: "Claude",
    redirectUri: "https://claude.ai/api/mcp/auth_callback",
    requestedScopes: ["read", "write"] as const,
    defaultScopes: ["read", "write"] as const,
    sites: [{ id: SITE_A, name: "Acme", website_url: "https://acme.test" }],
    defaultSite: SITE_A,
    email: "owner@acme.test",
    notice: null,
  };

  it("says plainly that an account without a plan can connect but its tools are unavailable until it has one", () => {
    const html = renderToStaticMarkup(<ConsentScreen {...props} hasPlan={false} />);
    expect(html).toContain("This account has no active plan.");
    expect(html).toContain('href="/settings/billing"');
    expect(html).toContain('value="allow"');
    expect(html).not.toMatch(/upgrade|\/pricing|\$/i);
  });

  it("says nothing about the plan when there is one", () => {
    expect(renderToStaticMarkup(<ConsentScreen {...props} hasPlan />)).not.toContain("no active plan");
    expect(renderToStaticMarkup(<ConsentScreen {...props} />)).not.toContain("no active plan");
  });
});
