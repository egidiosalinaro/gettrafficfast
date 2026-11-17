import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  afterTasks: [] as unknown[],
  db: null as unknown,
  enabled: true,
  client: null as unknown,
}));

vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (task: unknown) => {
    mocks.afterTasks.push(task);
  },
}));
vi.mock("@sentry/nextjs", () => ({ captureMessage: vi.fn(), captureException: vi.fn() }));
vi.mock("@/lib/notifications/email", () => ({ operatorEmailAddress: () => null, sendNotificationEmail: vi.fn() }));
vi.mock("@/lib/subscription", () => ({ hasActiveSubscription: async () => true }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => mocks.db }));
vi.mock("@/lib/providers/x/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/providers/x/api")>()),
  isXApiEnabled: () => mocks.enabled,
  xApiClientFromEnv: () => (mocks.enabled ? mocks.client : null),
}));

import { runTool } from "@/lib/tools/runner";
import { LedgerFake, xPost } from "../placements/x-fake";
import type { FakeSupabase } from "../support/fake-supabase";
import { SITE_A, USER, apiCaller, businesses, uuid } from "./support";

/**
 * `find_reply_link` and what the Replies tools say about a reply's link, run
 * as an API key on site A. What is pinned: the search is the screens' own
 * (findReplyLinkNow), it needs the spend scope, the found link is saved and
 * named as found on X, and the reads say plainly whether GTF is still
 * looking, with when it stops.
 */

const THREAD = "1855000000000000000";
const T_POSTED = uuid("a", 3);
const T_KNOWN = uuid("a", 4);
const DRAFT = "Put the direct answer in the first sentence, then the detail. That is what ChatGPT quotes.";

function seed() {
  const recent = new Date(Date.now() - 3 * 60_000).toISOString();
  const sites = businesses().map((b) => ({ ...b, voice_settings: { ...b.voice_settings, findPostsOnX: true } }));
  const db = new LedgerFake({
    businesses: sites,
    subscriptions: [{ user_id: USER, status: "active", current_period_end: null }],
    placement_targets: [
      {
        id: T_POSTED,
        user_id: USER,
        business_id: SITE_A,
        surface: "x",
        kind: "post",
        url: `https://x.com/janedoe/status/${THREAD}`,
        title: "How do you get cited by ChatGPT?",
        status: "published_manually",
        published_url: null,
        published_at: recent,
        selected_placement_id: uuid("d", 3),
        created_at: "2026-11-13T09:00:00.000Z",
      },
      {
        id: T_KNOWN,
        user_id: USER,
        business_id: SITE_A,
        surface: "x",
        kind: "post",
        url: "https://x.com/someone/status/1850000000000000000",
        title: "Earlier",
        status: "published_manually",
        published_url: "https://x.com/owner/status/1850000000000000001",
        published_at: "2026-11-12T09:00:00.000Z",
        created_at: "2026-11-12T08:00:00.000Z",
      },
    ],
    placements: [
      {
        id: uuid("d", 3),
        target_id: T_POSTED,
        user_id: USER,
        business_id: SITE_A,
        variant: "short_comment",
        body: DRAFT,
        link_url: null,
        claims: [],
        audit: { status: "passed", checks: [] },
        audit_status: "passed",
        agent_version: 16,
        created_at: "2026-11-13T09:30:00.000Z",
        updated_at: "2026-11-13T09:30:00.000Z",
      },
    ],
    placement_link_searches: [],
    jobs: [],
    aeo_queries: [],
  });
  mocks.db = db;
  return db;
}

function xWith(posts: ReturnType<typeof xPost>[]) {
  const searchReplies = vi.fn(async () => ({ posts, missingIds: [], billedPosts: posts.length, costUsd: posts.length * 0.005 }));
  mocks.client = { searchReplies };
  return searchReplies;
}

const theReply = () =>
  xPost("1855000000000000101", {
    text: `@janedoe ${DRAFT}`,
    handle: "owner",
    createdAt: new Date(Date.now() - 4 * 60_000).toISOString(),
    conversationId: THREAD,
    repliedToId: THREAD,
  });

/** The ledger fake is the in-memory database with X's two ledger functions on it. */
const caller = (db: LedgerFake, options?: Parameters<typeof apiCaller>[1]) => apiCaller(db as unknown as FakeSupabase, options);

let quiet: Array<ReturnType<typeof vi.spyOn>>;
beforeEach(() => {
  mocks.afterTasks = [];
  mocks.enabled = true;
  quiet = (["log", "info", "warn", "error"] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => {}));
});
afterEach(() => quiet.forEach((spy) => spy.mockRestore()));

describe("find_reply_link", () => {
  it("finds the reply, saves its link, and the target says it was found on X", async () => {
    const db = seed();
    const searchReplies = xWith([theReply()]);
    const run = await runTool(caller(db), "find_reply_link", { targetId: T_POSTED });
    expect(run).toMatchObject({
      ok: true,
      output: {
        outcome: "found",
        linkUrl: "https://x.com/owner/status/1855000000000000101",
        target: { publishedUrl: "https://x.com/owner/status/1855000000000000101", linkSource: "found_on_x", linkSearch: { attempts: 1, outcome: "found" } },
      },
    });
    expect(searchReplies).toHaveBeenCalledTimes(1);
    // The reply's words read back from X, as for a pasted link, and the call's audit row (lib/tools/usage.ts).
    expect(mocks.afterTasks).toHaveLength(2);
  });

  it("needs the spend scope: it is a paid call to X", async () => {
    const db = seed();
    const searchReplies = xWith([theReply()]);
    const run = await runTool(caller(db, { scopes: ["read", "write"] }), "find_reply_link", { targetId: T_POSTED });
    expect(run).toMatchObject({ ok: false, status: 403 });
    expect(searchReplies).not.toHaveBeenCalled();
  });

  it("is unavailable, in words, without the platform's X API", async () => {
    const db = seed();
    mocks.enabled = false;
    const run = await runTool(caller(db), "find_reply_link", { targetId: T_POSTED });
    expect(run).toMatchObject({ ok: false, status: 503, error: { code: "unavailable" } });
  });
});

describe("the reads say whether GTF is looking", () => {
  it("list_reply_inbox: looking, with when it stops; a linked reply names who gave its link", async () => {
    const db = seed();
    const run = await runTool(caller(db), "list_reply_inbox", { status: "published_manually" });
    expect(run.ok).toBe(true);
    const targets = (run as unknown as { output: { targets: Array<Record<string, unknown>> } }).output.targets;
    const waiting = targets.find((t) => t.id === T_POSTED)!;
    expect(waiting).toMatchObject({ linkSearch: null, linkFinding: { state: "looking", outcome: null } });
    expect(typeof (waiting.linkFinding as { stopsBy: unknown }).stopsBy).toBe("string");
    const linked = targets.find((t) => t.id === T_KNOWN)!;
    expect(linked).toMatchObject({ linkSource: "person" });
    expect(linked.linkFinding).toBeUndefined();
  });

  it("get_reply_target: off when the platform has no X API", async () => {
    const db = seed();
    mocks.enabled = false;
    const run = await runTool(caller(db), "get_reply_target", { targetId: T_POSTED });
    expect(run).toMatchObject({ ok: true, output: { target: { linkFinding: { state: "off", stopsBy: null } } } });
  });
});
