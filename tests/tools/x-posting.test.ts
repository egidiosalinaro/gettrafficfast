import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ db: null as unknown }));

vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: () => undefined,
}));
vi.mock("@sentry/nextjs", () => ({ captureMessage: vi.fn(), captureException: vi.fn() }));
vi.mock("@/lib/notifications/email", () => ({ operatorEmailAddress: () => null, sendNotificationEmail: vi.fn() }));
vi.mock("@/lib/subscription", () => ({ hasActiveSubscription: async () => true }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => mocks.db }));

import { runTool } from "@/lib/tools/runner";
import { X_POSTING_TABLE, saveXConnection } from "@/lib/integrations/x-posting";
import { LedgerFake } from "../placements/x-fake";
import type { FakeSupabase } from "../support/fake-supabase";
import { SITE_A, SITE_B, USER, apiCaller, businesses, uuid } from "./support";

/**
 * Posting on X as tools, run as an API key on site A: post_on_x needs the
 * publish scope and confirm: true (the person's yes), replies only where X
 * allows it, falls back to X's composer when X refuses, and posts a post of
 * the account's own; get_x_posting_account says whether the site has an
 * account and where to connect one; reply targets say xPostAllowed.
 * X is a stubbed fetch. Fictional accounts.
 */

const THREAD = "1850000000000000000";
const T_MENTION = uuid("a", 1);
const T_OTHER = uuid("a", 2);
const D_MENTION = uuid("d", 1);
const D_OTHER = uuid("d", 2);
const DRAFT = "We keep release notes in the repo and paste them in.";

function target(id: string, text: string) {
  return {
    id,
    user_id: USER,
    business_id: SITE_A,
    surface: "x",
    kind: "post",
    url: `https://x.com/postwren/status/${THREAD}`,
    title: text,
    excerpt: text,
    author: "postwren",
    status: "drafted",
    published_url: null,
    published_at: null,
    created_at: "2026-11-24T08:00:00Z",
  };
}

function draft(id: string, targetId: string) {
  return {
    id,
    target_id: targetId,
    user_id: USER,
    business_id: SITE_A,
    variant: "short_comment",
    body: DRAFT,
    link_url: null,
    claims: [],
    audit: { status: "passed", checks: [] },
    audit_status: "passed",
    agent_version: 16,
    created_at: "2026-11-24T08:30:00Z",
    updated_at: "2026-11-24T08:30:00Z",
  };
}

async function seed(connected = true) {
  const db = new LedgerFake({
    businesses: businesses(),
    subscriptions: [{ user_id: USER, status: "active", current_period_end: null }],
    placement_targets: [target(T_MENTION, "@samrivdev which tool do you use for release notes?"), target(T_OTHER, "Which tool do you use for release notes?")],
    placements: [draft(D_MENTION, T_MENTION), draft(D_OTHER, T_OTHER)],
    placement_link_searches: [],
    jobs: [],
    aeo_queries: [],
    [X_POSTING_TABLE]: [],
  });
  if (connected) {
    await saveXConnection({
      admin: db as never,
      userId: USER,
      businessId: SITE_A,
      me: { id: "1001", username: "samrivdev" },
      tokens: { accessToken: "at-a", refreshToken: "rt-a", expiresAt: new Date(Date.now() + 7_200_000), scopes: [] },
    });
  }
  mocks.db = db;
  return db;
}

const caller = (db: LedgerFake, scopes: Array<"read" | "write" | "spend" | "publish"> = ["read", "write", "publish"]) =>
  apiCaller(db as unknown as FakeSupabase, { scopes });

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.stubEnv("INTEGRATIONS_ENCRYPTION_KEY", "ab".repeat(32));
  vi.stubEnv("X_OAUTH_CLIENT_ID", "test-client-id");
  vi.stubEnv("X_OAUTH_CLIENT_SECRET", "test-client-secret");
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ data: { id: "1860000000000000001", text: DRAFT } }), { status: 201 }));
  vi.stubGlobal("fetch", fetchMock);
  for (const level of ["log", "info", "warn", "error"] as const) vi.spyOn(console, level).mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("post_on_x", () => {
  it("needs the publish scope", async () => {
    const db = await seed();
    const run = await runTool(caller(db, ["read", "write", "spend"]), "post_on_x", { targetId: T_MENTION, draftId: D_MENTION, confirm: true });
    expect(run).toMatchObject({ ok: false, status: 403, error: { code: "forbidden_scope" } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("needs confirm: true, the person's yes", async () => {
    const db = await seed();
    for (const input of [{ targetId: T_MENTION, draftId: D_MENTION }, { targetId: T_MENTION, draftId: D_MENTION, confirm: false }]) {
      const run = await runTool(caller(db), "post_on_x", input);
      expect(run).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts the reply to a post that mentions the account, and records it with its link", async () => {
    const db = await seed();
    const run = await runTool(caller(db), "post_on_x", { targetId: T_MENTION, draftId: D_MENTION, confirm: true });
    expect(run).toMatchObject({
      ok: true,
      output: {
        posted: true,
        url: "https://x.com/samrivdev/status/1860000000000000001",
        username: "samrivdev",
        target: { status: "published_manually", publishedUrl: "https://x.com/samrivdev/status/1860000000000000001" },
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not post to anyone else: it hands back X's composer", async () => {
    const db = await seed();
    const run = await runTool(caller(db), "post_on_x", { targetId: T_OTHER, draftId: D_OTHER, confirm: true });
    expect(run).toMatchObject({
      ok: true,
      output: { posted: false, reason: "reply_not_allowed", intentUrl: expect.stringContaining("https://x.com/intent/tweet?text=") },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("falls back to X's composer when X refuses the reply", async () => {
    const db = await seed();
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ detail: "Reply to this conversation is not allowed because you have not been mentioned" }), { status: 403 }));
    const run = await runTool(caller(db), "post_on_x", { targetId: T_MENTION, draftId: D_MENTION, confirm: true });
    expect(run).toMatchObject({ ok: true, output: { posted: false, reason: "reply_not_allowed", intentUrl: expect.stringContaining(`in_reply_to=${THREAD}`) } });
  });

  it("posts a post of the account's own from text", async () => {
    const db = await seed();
    const run = await runTool(caller(db), "post_on_x", { text: "Release notes now live in the repo.", confirm: true });
    expect(run).toMatchObject({ ok: true, output: { posted: true, url: "https://x.com/samrivdev/status/1860000000000000001", target: null } });
  });

  it("refuses without a connected account, and a call that mixes the two forms", async () => {
    const db = await seed(false);
    expect(await runTool(caller(db), "post_on_x", { text: "Hello", confirm: true })).toMatchObject({ ok: false, error: { code: "prerequisite_missing" } });
    const connected = await seed();
    expect(await runTool(caller(connected), "post_on_x", { text: "Hello", targetId: T_MENTION, draftId: D_MENTION, confirm: true })).toMatchObject({
      ok: false,
      error: { code: "invalid_input" },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("get_x_posting_account and xPostAllowed", () => {
  it("says which account the site posts from, and where to connect one", async () => {
    const db = await seed();
    expect(await runTool(caller(db), "get_x_posting_account", {})).toMatchObject({
      ok: true,
      output: { available: true, connected: true, username: "samrivdev", needsReconnect: false, connectUrl: expect.stringContaining(`/api/integrations/x/connect?business=${SITE_A}`) },
    });
    const none = await seed(false);
    expect(await runTool(caller(none), "get_x_posting_account", {})).toMatchObject({ ok: true, output: { connected: false, username: null } });
    const other = await runTool(apiCaller(db as unknown as FakeSupabase, { businessId: SITE_B, scopes: ["read"] }), "get_x_posting_account", {});
    expect(other).toMatchObject({ ok: true, output: { connected: false } });
  });

  it("is not available without the deployment's OAuth client", async () => {
    vi.stubEnv("X_OAUTH_CLIENT_ID", "");
    const db = await seed();
    expect(await runTool(caller(db), "get_x_posting_account", {})).toMatchObject({ ok: true, output: { available: false, connectUrl: null } });
  });

  it("marks only the targets X lets the site reply to", async () => {
    const db = await seed();
    const run = await runTool(caller(db), "list_reply_inbox", { status: "open" });
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    const byId = Object.fromEntries((run.output.targets as Array<{ id: string; xPostAllowed?: boolean }>).map((t) => [t.id, t.xPostAllowed]));
    expect(byId).toEqual({ [T_MENTION]: true, [T_OTHER]: false });
  });
});

describe("disconnect_x_account", () => {
  it("disconnects the site's account", async () => {
    const db = await seed();
    fetchMock.mockImplementation(async () => new Response("{}", { status: 200 }));
    expect(await runTool(caller(db), "disconnect_x_account", {})).toMatchObject({ ok: true, output: { disconnected: true } });
    expect(db.tables[X_POSTING_TABLE]).toEqual([]);
  });
});
