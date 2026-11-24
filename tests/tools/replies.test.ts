import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeSupabase } from "../support/fake-supabase";
import { OTHER, SITE_A, SITE_B, SITE_C, USER, apiCaller, businesses, customerData, uuid } from "./support";

/**
 * The Replies tools, run as an API-key caller on site A through the
 * owner-scoped service role, the way a real key runs them. What is pinned
 * for each: the happy path calls the inbox's own function and returns its
 * result in the declared shape; an id of site B (same account) or site C
 * (another account) is refused before anything is read or written; the
 * paid ones need the spend scope and a subscription and keep the daily
 * caps; and nothing posts: the X link is handed back for a person to open.
 */

const mocks = vi.hoisted(() => ({
  afterTasks: [] as unknown[],
  subscribed: true,
  readXPost: vi.fn(),
  runJobNow: vi.fn(),
  providers: [] as Array<{ name: string }>,
  correctDraft: vi.fn(),
  db: null as unknown,
}));

vi.mock("next/server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/server")>()),
  after: (task: unknown) => {
    mocks.afterTasks.push(task);
  },
}));
vi.mock("@/lib/subscription", () => ({ hasActiveSubscription: async () => mocks.subscribed }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => mocks.db }));
vi.mock("@/lib/jobs/worker", () => ({ runJobNow: (...args: unknown[]) => mocks.runJobNow(...args) }));
vi.mock("@/lib/providers/x/oembed", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/providers/x/oembed")>()),
  readXPost: (...args: unknown[]) => mocks.readXPost(...args),
}));
vi.mock("@/lib/providers/discovery/registry", () => ({ getDiscoveryProviders: () => mocks.providers }));
vi.mock("@/lib/placements/correct", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/placements/correct")>()),
  correctDraft: (...args: unknown[]) => mocks.correctDraft(...args),
}));

import { runTool } from "@/lib/tools/runner";

const THREAD = "https://x.com/janedoe/status/1855000000000000000";
const MY_REPLY = "https://x.com/owner/status/1855000000000000001";

const T_OPEN = uuid("a", 1);
const T_SKIPPED = uuid("a", 2);
const T_POSTED = uuid("a", 3);
const T_B = uuid("b", 1);
const T_C = uuid("c", 1);
const D_OPEN = uuid("d", 1);
const D_SKIPPED = uuid("d", 2);
const D_B = uuid("d", 3);
const D_C = uuid("d", 4);
const J_A = uuid("e", 1);
const J_C = uuid("e", 2);

const PASSING =
  "ChatGPT cites pages that answer the question in the first sentence. Put the direct answer first, then the detail.";

function target(id: string, userId: string, businessId: string, over: Record<string, unknown> = {}) {
  return {
    id,
    user_id: userId,
    business_id: businessId,
    surface: "x",
    kind: "post",
    url: THREAD,
    title: "How do you get cited by ChatGPT?",
    excerpt: "Our SEO is fine but ChatGPT never mentions us.",
    status: "qualified",
    qualify_score: 80,
    qualify_angle: null,
    published_url: null,
    snoozed_until: null,
    created_at: "2026-11-09T09:00:00.000Z",
    ...over,
  };
}

function draft(id: string, targetId: string, userId: string, businessId: string, over: Record<string, unknown> = {}) {
  return {
    id,
    target_id: targetId,
    user_id: userId,
    business_id: businessId,
    variant: "short_comment",
    body: PASSING,
    link_url: null,
    claims: [],
    audit: { status: "passed", checks: [] },
    audit_status: "passed",
    agent_version: 16,
    created_at: "2026-11-09T09:01:00.000Z",
    updated_at: "2026-11-09T09:01:00.000Z",
    ...over,
  };
}

const DAY = new Date().toISOString().slice(0, 10);
const YESTERDAY = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

function metric(targetId: string, userId: string, businessId: string, day: string, over: Record<string, unknown> = {}) {
  return {
    target_id: targetId,
    user_id: userId,
    business_id: businessId,
    day,
    impressions: null,
    likes: null,
    replies: null,
    reposts: null,
    quotes: null,
    bookmarks: null,
    fetched_at: `${day}T13:20:00.000Z`,
    ...over,
  };
}

function seed(over: { aboutYou?: string } = {}) {
  const db = new FakeSupabase({
    businesses: businesses(over),
    placement_targets: [
      target(T_OPEN, USER, SITE_A),
      target(T_SKIPPED, USER, SITE_A, {
        status: "dismissed",
        surface: "reddit",
        kind: "thread",
        url: "https://www.reddit.com/r/seo/comments/abc/cited/",
        qualify_score: 50,
      }),
      target(T_POSTED, USER, SITE_A, { status: "published_manually", qualify_score: 10 }),
      target(T_B, USER, SITE_B),
      target(T_C, OTHER, SITE_C),
    ],
    placements: [
      draft(D_OPEN, T_OPEN, USER, SITE_A),
      draft(D_SKIPPED, T_SKIPPED, USER, SITE_A),
      draft(D_B, T_B, USER, SITE_B),
      draft(D_C, T_C, OTHER, SITE_C),
    ],
    jobs: [
      {
        id: J_A,
        user_id: USER,
        business_id: SITE_A,
        type: "placement-draft",
        input: { targetId: T_OPEN },
        status: "failed",
        last_error: "Not drafted: the post is a giveaway, not a question.",
        created_at: "2026-11-09T08:00:00.000Z",
      },
      { id: J_C, user_id: OTHER, business_id: SITE_C, type: "placement-draft", input: { targetId: T_C }, status: "completed" },
    ],
    keywords: [],
    entities: [],
    aeo_queries: [],
    draft_feedback: [],
    placement_metrics: [
      metric(T_POSTED, USER, SITE_A, DAY, { impressions: 1234, likes: 8, replies: 2 }),
      metric(T_POSTED, USER, SITE_A, YESTERDAY, { impressions: 300, likes: 1, replies: 0 }),
      metric(T_C, OTHER, SITE_C, DAY, { impressions: 9 }),
    ],
    placement_link_searches: [],
  });
  mocks.db = db;
  return db;
}

const call = (db: FakeSupabase, name: string, input: unknown, scopes?: Array<"read" | "write" | "spend">) =>
  runTool(apiCaller(db, scopes ? { scopes } : {}), name, input);

const row = (db: FakeSupabase, table: string, id: string) => db.tables[table].find((r) => r.id === id)!;

let quiet: Array<ReturnType<typeof vi.spyOn>>;
beforeEach(() => {
  mocks.afterTasks = [];
  mocks.subscribed = true;
  mocks.providers = [];
  mocks.readXPost.mockReset();
  mocks.runJobNow.mockReset();
  mocks.correctDraft.mockReset();
  quiet = (["info", "warn", "error"] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => {}));
});
afterEach(() => quiet.forEach((spy) => spy.mockRestore()));

describe("an id of another site is refused before anything happens", () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["get_reply_target", { targetId: T_B }],
    ["get_reply_target", { targetId: T_C }],
    ["get_reply_intent_url", { targetId: T_OPEN, draftId: D_B }],
    ["draft_reply", { targetId: T_C, waitSeconds: 0 }],
    ["edit_reply_draft", { draftId: D_B, body: "Mine now." }],
    ["edit_reply_draft", { draftId: D_C, body: "Mine now." }],
    ["write_own_reply", { targetId: T_B, body: "Mine now." }],
    ["correct_reply_draft", { draftId: D_C, reason: "too generic" }],
    ["mark_reply_posted", { targetId: T_C }],
    ["find_reply_link", { targetId: T_B }],
    ["find_reply_link", { targetId: T_C }],
    ["mark_reply_posted", { targetId: T_OPEN, draftId: D_B }],
    ["set_reply_link", { targetId: T_B, link: MY_REPLY }],
    ["mark_reply_removed", { targetId: T_C, reason: "Hidden because my account is new" }],
    ["unmark_reply_removed", { targetId: T_B }],
    ["unmark_reply_posted", { targetId: T_B }],
    ["unmark_reply_posted", { targetId: T_C }],
    ["snooze_reply_target", { targetId: T_B }],
    ["dismiss_reply_target", { targetId: T_C }],
    ["reopen_reply_target", { targetId: T_B }],
    ["get_job", { jobId: J_C }],
    ["get_reply_metrics", { targetId: T_C }],
    ["get_reply_metrics", { targetId: T_B }],
  ];

  it.each(cases)("%s %j", async (name, input) => {
    const db = seed();
    const before = customerData(db);
    const run = await call(db, name, input);
    expect(run).toMatchObject({ ok: false, status: 404, error: { code: "not_found" } });
    expect(customerData(db)).toBe(before);
    expect(mocks.runJobNow).not.toHaveBeenCalled();
    expect(mocks.correctDraft).not.toHaveBeenCalled();
  });
});

describe("the numbers of posted replies", () => {
  it("get_reply_metrics returns each posted reply on X with its newest snapshot and the history, and calls nothing", async () => {
    const db = seed();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const before = customerData(db);
    const run = await call(db, "get_reply_metrics", {});
    expect(run).toMatchObject({ ok: true });
    const output = (run as unknown as { output: { measured: boolean; replies: Array<Record<string, unknown>> } }).output;
    expect(output.measured).toBe(true);
    expect(output.replies).toHaveLength(1);
    expect(output.replies[0]).toMatchObject({
      targetId: T_POSTED,
      latest: { day: DAY, impressions: 1234, likes: 8, replies: 2, reposts: null, quotes: null, bookmarks: null },
    });
    expect((output.replies[0].history as unknown[]).length).toBe(2);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(customerData(db)).toBe(before);
    fetchSpy.mockRestore();
  });

  it("get_reply_stats sums this site's week on X, keeps nulls, reads the account, and calls nothing", async () => {
    const db = seed();
    const recent = new Date(Date.now() - 86_400_000).toISOString();
    Object.assign(row(db, "placement_targets", T_POSTED), { published_at: recent, published_url: MY_REPLY, published_text: "Put the answer first." });
    Object.assign(row(db, "placement_targets", T_C), { status: "published_manually", published_at: recent, published_url: MY_REPLY });
    db.tables.x_account_metrics = [
      { business_id: SITE_A, user_id: USER, day: DAY, handle: "owner", followers: 2310, following: 1, posts: 2, listed: 0, fetched_at: `${DAY}T13:20:00Z` },
      { business_id: SITE_C, user_id: OTHER, day: DAY, handle: "them", followers: 99, following: 1, posts: 2, listed: 0, fetched_at: `${DAY}T13:20:00Z` },
    ];
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const before = customerData(db);
    const run = await call(db, "get_reply_stats", {});
    expect(run).toMatchObject({ ok: true });
    const output = (run as unknown as { output: Record<string, unknown> }).output;
    expect(output).toMatchObject({
      measured: true,
      week: { posted: 1, measured: 1, withoutLink: 0, views: 1234, likes: 8, replies: 2, reposts: null },
      previousWeek: { posted: 0, measured: 0, views: null },
      change: { views: null, likes: null, replies: null, reposts: null },
      top: [{ targetId: T_POSTED, text: "Put the answer first.", publishedUrl: MY_REPLY, views: 1234 }],
      followers: { handle: "owner", followers: 2310, change: null },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(customerData(db)).toBe(before);
    fetchSpy.mockRestore();
  });

  it("is refused for a post with no reply posted on X", async () => {
    const run = await call(seed(), "get_reply_metrics", { targetId: T_OPEN });
    expect(run).toMatchObject({ ok: false, status: 404, error: { code: "not_found" } });
  });

  it("list_reply_inbox carries the newest numbers on a posted reply, and none on an open post", async () => {
    const run = await call(seed(), "list_reply_inbox", { status: "published_manually" });
    const targets = (run as unknown as { output: { targets: Array<Record<string, unknown>> } }).output.targets;
    expect(targets.find((t) => t.id === T_POSTED)?.metrics).toMatchObject({ day: DAY, impressions: 1234 });
    const open = await call(seed(), "list_reply_inbox", {});
    expect((open as unknown as { output: { targets: Array<Record<string, unknown>> } }).output.targets.find((t) => t.id === T_OPEN)?.metrics).toBeNull();
  });
});

describe("today's replies", () => {
  const T_TODAY = uuid("f", 1);
  const T_TODAY_READ = uuid("f", 2);
  const T_REMOVED = uuid("f", 3);
  const T_YESTERDAY = uuid("f", 4);
  const T_LATE_UTC = uuid("f", 5);
  const T_OTHER_SITE = uuid("f", 6);

  function seedToday() {
    const db = seed();
    db.tables.businesses.find((b) => b.id === SITE_A)!.voice_settings = { aboutYou: "I run Acme.", instructions: "", dailyReplyGoal: 5 };
    db.tables.placement_targets.push(
      target(T_TODAY, USER, SITE_A, { status: "published_manually", published_at: "2026-11-10T08:00:00Z", selected_placement_id: uuid("d", 9) }),
      target(T_TODAY_READ, USER, SITE_A, {
        status: "published_manually",
        published_at: "2026-11-10T09:00:00Z",
        published_text: "read back from X\nsecond line",
        published_url: MY_REPLY,
        author: "janedoe",
      }),
      target(T_REMOVED, USER, SITE_A, { status: "published_manually", published_at: "2026-11-10T07:00:00Z", removed_at: "2026-11-10T08:30:00Z" }),
      target(T_YESTERDAY, USER, SITE_A, { status: "published_manually", published_at: "2026-11-09T12:00:00Z" }),
      // 23:50 UTC on the 9th: yesterday in UTC, today in Berlin.
      target(T_LATE_UTC, USER, SITE_A, { status: "published_manually", published_at: "2026-11-09T23:50:00Z" }),
      target(T_OTHER_SITE, USER, SITE_B, { status: "published_manually", published_at: "2026-11-10T08:00:00Z" })
    );
    db.tables.placements.push(draft(uuid("d", 9), T_TODAY, USER, SITE_A, { body: "the draft that went out\nmore" }));
    db.tables.placement_metrics.push(metric(T_TODAY_READ, USER, SITE_A, "2026-11-10", { impressions: 40, likes: 2, replies: 0 }));
    return db;
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-10T09:30:00Z"));
  });
  afterEach(() => vi.useRealTimers());

  it("get_today_replies counts and lists the replies posted today, removed ones and other days left out", async () => {
    const db = seedToday();
    const before = customerData(db);
    const run = await call(db, "get_today_replies", { timeZone: "UTC" });
    expect(run).toMatchObject({ ok: true, output: { posted: 2, goal: 5, timeZone: "UTC" } });
    const output = (run as unknown as { output: { replies: Array<Record<string, unknown>> } }).output;
    expect(output.replies.map((r) => [r.id, r.text])).toEqual([
      [T_TODAY_READ, "read back from X"],
      [T_TODAY, "the draft that went out"],
    ]);
    expect(output.replies[0]).toMatchObject({ publishedUrl: MY_REPLY, author: "janedoe", metrics: { impressions: 40, likes: 2 } });
    expect(output.replies[1]).toMatchObject({ publishedUrl: null, metrics: null });
    expect(customerData(db)).toBe(before);
  });

  it("reads today in the zone asked for, and falls back to UTC for an unknown one", async () => {
    const berlin = await call(seedToday(), "get_today_replies", { timeZone: "Europe/Berlin" });
    expect(berlin).toMatchObject({ ok: true, output: { posted: 3, timeZone: "Europe/Berlin" } });
    const unknown = await call(seedToday(), "get_today_replies", { timeZone: "Not/AZone" });
    expect(unknown).toMatchObject({ ok: true, output: { posted: 2, timeZone: "UTC" } });
  });

  it("list_reply_inbox carries the same count and list, whatever the filter", async () => {
    const run = await call(seedToday(), "list_reply_inbox", { timeZone: "UTC" });
    const today = (run as unknown as { output: { today: { posted: number; goal: number | null; replies: Array<{ id: string }> } } }).output.today;
    expect(today).toMatchObject({ posted: 2, goal: 5 });
    expect(today.replies.map((r) => r.id)).toEqual([T_TODAY_READ, T_TODAY]);
  });
});

describe("reading", () => {
  it("list_reply_inbox lists this site's open targets with their drafts, and pages", async () => {
    const db = seed();
    const open = await call(db, "list_reply_inbox", {});
    expect(open.ok).toBe(true);
    if (!open.ok) return;
    expect((open.output.targets as Array<{ id: string }>).map((t) => t.id)).toEqual([T_OPEN]);
    expect(open.output).toMatchObject({ total: 1, nextOffset: null, truncated: false, writerUseRecorded: true });
    expect((open.output.targets as Array<{ drafts: Array<{ id: string }> }>)[0].drafts.map((d) => d.id)).toEqual([D_OPEN]);

    const all = await call(db, "list_reply_inbox", { status: "all", limit: 2 });
    expect(all.ok && (all.output.targets as Array<{ id: string }>).map((t) => t.id)).toEqual([T_OPEN, T_SKIPPED]);
    expect(all.ok && all.output).toMatchObject({ total: 3, nextOffset: 2, counts: { qualified: 1, dismissed: 1, published_manually: 1 } });

    const reddit = await call(db, "list_reply_inbox", { status: "all", platform: "reddit" });
    expect(reddit.ok && (reddit.output.targets as Array<{ id: string }>).map((t) => t.id)).toEqual([T_SKIPPED]);
  });

  it("list_reply_inbox says when each target was found and when discovery last ran and runs next (2026-11-12)", async () => {
    const db = seed();
    db.tables.jobs.push(
      { id: "web-old", user_id: USER, business_id: SITE_A, type: "placement-discovery", status: "completed", finished_at: "2026-11-10T10:09:00.000Z", created_at: "2026-11-10T10:00:00.000Z" },
      {
        id: "web-now",
        user_id: USER,
        business_id: SITE_A,
        type: "placement-discovery",
        status: "running",
        current_step: "qualify",
        result: { progress: { step: "qualify", judged: 20, total: 60 } },
        finished_at: null,
        created_at: "2026-11-12T14:00:00.000Z",
      }
    );
    const open = await call(db, "list_reply_inbox", {});
    expect(open.ok).toBe(true);
    if (!open.ok) return;
    const target = (open.output.targets as Array<{ createdAt: string; foundAt: string }>)[0];
    expect(target.foundAt).toBe(target.createdAt);
    const last = open.output.lastDiscovery as {
      web: { running: boolean; lastCompletedAt: string | null; progress: string | null; nextAt: string | null };
      x: unknown;
    };
    expect(last.web).toMatchObject({ running: true, lastCompletedAt: "2026-11-10T10:09:00.000Z", progress: "Judging 20 of 60…" });
    // Monday, Wednesday or Friday at 10:00 UTC.
    const next = new Date(last.web.nextAt!);
    expect([1, 3, 5]).toContain(next.getUTCDay());
    expect(next.toISOString().slice(11, 16)).toBe("10:00");
    // Find posts on X is off for this site: no X search to report.
    expect(last.x).toBeNull();
  });

  it("get_reply_target returns the target, its drafts and how its last draft job ended", async () => {
    const run = await call(seed(), "get_reply_target", { targetId: T_OPEN });
    expect(run).toMatchObject({
      ok: true,
      output: {
        target: { id: T_OPEN, status: "qualified", drafts: [{ id: D_OPEN, auditStatus: "passed" }] },
        draftJob: { jobId: J_A, status: "failed", failure: { kind: "declined" } },
      },
    });
  });

  it("get_reply_intent_url hands back X's composer link, and posts nothing", async () => {
    const db = seed();
    const before = customerData(db);
    const run = await call(db, "get_reply_intent_url", { targetId: T_OPEN });
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    expect(run.output.url).toBe(`https://x.com/intent/tweet?text=${encodeURIComponent(PASSING)}&in_reply_to=1855000000000000000`);
    expect(run.output).toMatchObject({ reason: null, draftId: D_OPEN, threadUrl: THREAD });
    expect(customerData(db)).toBe(before);

    const reddit = await call(db, "get_reply_intent_url", { targetId: T_SKIPPED });
    expect(reddit.ok && reddit.output).toMatchObject({ url: null, reason: "not_an_x_post" });
  });

  it("get_job reads one of this site's jobs", async () => {
    const run = await call(seed(), "get_job", { jobId: J_A });
    expect(run).toMatchObject({
      ok: true,
      output: { job: { jobId: J_A, type: "placement-draft", status: "failed", failure: { kind: "declined" } } },
    });
  });
});

describe("the manual workflow", () => {
  it("mark_reply_posted records the post, the draft and the link, and reads the reply back later", async () => {
    const db = seed();
    const run = await call(db, "mark_reply_posted", { targetId: T_OPEN, link: MY_REPLY, draftId: D_OPEN });
    expect(run).toMatchObject({ ok: true, output: { target: { id: T_OPEN, status: "published_manually", publishedUrl: MY_REPLY } } });
    expect(row(db, "placement_targets", T_OPEN)).toMatchObject({ selected_placement_id: D_OPEN, published_url: MY_REPLY });
    // The tool's own work kept alive, and the call's audit row (lib/tools/usage.ts).
    expect(mocks.afterTasks).toHaveLength(2);
  });

  it("mark_reply_posted asks for the site's X account the first time it is not known, and no more once it is saved", async () => {
    const env = { ...process.env };
    process.env.X_API_ENABLED = "1";
    process.env.X_API_BEARER_TOKEN = "t";
    try {
      const db = seed();
      const first = await call(db, "mark_reply_posted", { targetId: T_OPEN, draftId: D_OPEN });
      expect(first).toMatchObject({ ok: true, output: { xHandleNeeded: true, xHandleMessage: expect.stringContaining("update_voice_settings (xHandle)") } });

      expect(await call(db, "update_voice_settings", { xHandle: "@Owner" })).toMatchObject({ ok: true, output: { settings: { xHandle: "owner" } } });
      await call(db, "unmark_reply_posted", { targetId: T_OPEN });
      const again = await call(db, "mark_reply_posted", { targetId: T_OPEN, draftId: D_OPEN });
      expect(again).toMatchObject({ ok: true, output: { xHandleNeeded: false, xHandleMessage: null } });

      // With the link given, nothing is asked: the link names the account.
      const linked = seed();
      expect(await call(linked, "mark_reply_posted", { targetId: T_OPEN, link: MY_REPLY })).toMatchObject({ ok: true, output: { xHandleNeeded: false } });

      // Without the platform's X API, nothing is asked either.
      delete process.env.X_API_ENABLED;
      expect(await call(seed(), "mark_reply_posted", { targetId: T_OPEN })).toMatchObject({ ok: true, output: { xHandleNeeded: false } });
    } finally {
      process.env = env;
    }
  });

  it("unmark_reply_posted is the Undo of I posted it: back to the open inbox, drafts kept; refused once a link is saved", async () => {
    const db = seed();
    await call(db, "mark_reply_posted", { targetId: T_OPEN, draftId: D_OPEN });
    const undone = await call(db, "unmark_reply_posted", { targetId: T_OPEN });
    expect(undone).toMatchObject({ ok: true, output: { target: { id: T_OPEN, status: "drafted", publishedAt: null } } });
    expect(db.tables.placements.some((p) => p.id === D_OPEN)).toBe(true);

    await call(db, "set_reply_link", { targetId: T_POSTED, link: MY_REPLY });
    expect(await call(db, "unmark_reply_posted", { targetId: T_POSTED })).toMatchObject({
      ok: false,
      status: 409,
      error: { code: "invalid_state" },
    });
    expect(await call(db, "unmark_reply_posted", { targetId: T_OPEN }, ["read"])).toMatchObject({
      ok: false,
      status: 403,
      error: { code: "forbidden_scope" },
    });
  });

  it("paste_reply_links saves a link only on the one reply whose words match, and asks about the rest", async () => {
    const db = seed();
    const D_POSTED = uuid("d", 9);
    db.tables.placements.push(draft(D_POSTED, T_POSTED, USER, SITE_A));
    row(db, "placement_targets", T_POSTED).selected_placement_id = D_POSTED;
    const UNREADABLE = "https://x.com/owner/status/1855000000000000002";
    mocks.readXPost.mockImplementation(async (link: string) => (link === MY_REPLY ? { text: PASSING } : null));

    const run = await call(db, "paste_reply_links", { links: [MY_REPLY, UNREADABLE, "not a link"] });
    expect(run).toMatchObject({
      ok: true,
      output: {
        saved: [{ link: MY_REPLY, targetId: T_POSTED }],
        refused: [{ link: UNREADABLE }, { link: "not a link" }],
        picks: [],
      },
    });
    expect(row(db, "placement_targets", T_POSTED)).toMatchObject({ published_url: MY_REPLY });

    // Once that reply has its link, nothing on this site is waiting: a second paste saves nothing.
    const again = await call(db, "paste_reply_links", { links: [UNREADABLE] });
    expect(again).toMatchObject({ ok: true, output: { saved: [], picks: [] } });
    expect(await call(db, "paste_reply_links", { links: [] })).toMatchObject({ ok: false, status: 400 });
  });

  it("set_reply_link adds the link to a posted reply only, checked like the card checks it", async () => {
    const db = seed();
    expect(await call(db, "set_reply_link", { targetId: T_POSTED, link: MY_REPLY })).toMatchObject({
      ok: true,
      output: { target: { publishedUrl: MY_REPLY } },
    });
    expect(await call(db, "set_reply_link", { targetId: T_OPEN, link: MY_REPLY })).toMatchObject({
      ok: false,
      status: 409,
      error: { code: "invalid_state" },
    });
    expect(await call(db, "set_reply_link", { targetId: T_POSTED, link: THREAD })).toMatchObject({
      ok: false,
      status: 400,
      error: { code: "invalid_input" },
    });
  });

  it("mark_reply_removed records a removal on a posted reply only, and unmark_reply_removed undoes it", async () => {
    const db = seed();
    const marked = await call(db, "mark_reply_removed", { targetId: T_POSTED, reason: "Hidden because my account is new" });
    expect(marked).toMatchObject({
      ok: true,
      output: { target: { status: "published_manually", removedReason: "Hidden because my account is new" } },
    });
    expect(marked.ok && typeof (marked.output.target as { removedAt: unknown }).removedAt).toBe("string");
    expect(row(db, "placement_targets", T_POSTED)).toMatchObject({
      status: "published_manually",
      removed_reason: "Hidden because my account is new",
    });

    // Not twice, not on an open target, not with a reason over 300 characters.
    expect(await call(db, "mark_reply_removed", { targetId: T_POSTED })).toMatchObject({ ok: false, status: 409, error: { code: "invalid_state" } });
    expect(await call(db, "mark_reply_removed", { targetId: T_OPEN })).toMatchObject({ ok: false, status: 409, error: { code: "invalid_state" } });
    expect(await call(db, "mark_reply_removed", { targetId: T_POSTED, reason: "x".repeat(301) })).toMatchObject({
      ok: false,
      status: 400,
    });

    // The inbox stops asking for its link and counts it per platform.
    const inbox = await call(db, "list_reply_inbox", { status: "published_manually" });
    expect(inbox.ok && inbox.output).toMatchObject({
      missingLinkCount: 0,
      removalBySurface: { x: { posted: 1, removed: 1, removalRate: 1 } },
    });

    expect(await call(db, "unmark_reply_removed", { targetId: T_POSTED })).toMatchObject({
      ok: true,
      output: { target: { status: "published_manually", removedAt: null, removedReason: null } },
    });
    expect(row(db, "placement_targets", T_POSTED)).toMatchObject({ removed_at: null, removed_reason: null });
    expect(await call(db, "unmark_reply_removed", { targetId: T_POSTED })).toMatchObject({ ok: false, status: 409 });
    const after = await call(db, "list_reply_inbox", { status: "published_manually" });
    expect(after.ok && after.output).toMatchObject({ missingLinkCount: 1, removalBySurface: { x: { posted: 1, removed: 0, removalRate: 0 } } });
  });

  it("snooze, skip and bring back make the inbox's moves", async () => {
    const db = seed();
    const snoozed = await call(db, "snooze_reply_target", { targetId: T_OPEN, days: 3 });
    expect(snoozed.ok).toBe(true);
    const until = Date.parse(row(db, "placement_targets", T_OPEN).snoozed_until as string);
    expect(until - Date.now()).toBeGreaterThan(2.9 * 86_400_000);

    expect(await call(db, "dismiss_reply_target", { targetId: T_OPEN, reason: "Off topic" })).toMatchObject({
      ok: true,
      output: { target: { status: "dismissed", dismissedReason: "Off topic" } },
    });
    expect(await call(db, "reopen_reply_target", { targetId: T_SKIPPED })).toMatchObject({
      ok: true,
      output: { target: { status: "qualified" } },
    });
    expect(await call(db, "reopen_reply_target", { targetId: T_SKIPPED })).toMatchObject({
      ok: false,
      status: 409,
      error: { code: "invalid_state" },
    });
  });
});

describe("editing", () => {
  it("edit_reply_draft saves the text and judges it again", async () => {
    const db = seed();
    const run = await call(db, "edit_reply_draft", { draftId: D_OPEN, body: "Check out https://acme.test now!!!" });
    expect(run.ok).toBe(true);
    expect(row(db, "placements", D_OPEN).body).toBe("Check out https://acme.test now!!!");
    expect(row(db, "placements", D_OPEN).audit_status).not.toBe("passed");
  });

  it("write_own_reply stores a person's reply, needs a subscription but not the spend scope", async () => {
    const db = seed();
    const run = await call(db, "write_own_reply", { targetId: T_OPEN, body: PASSING }, ["read", "write"]);
    expect(run).toMatchObject({ ok: true, output: { draft: { agentVersion: 0, body: PASSING } } });
    expect(db.tables.placements.filter((d) => d.target_id === T_OPEN && d.agent_version === 0)).toHaveLength(1);

    mocks.subscribed = false;
    expect(await call(db, "write_own_reply", { targetId: T_OPEN, body: PASSING }, ["read", "write"])).toMatchObject({
      ok: false,
      status: 402,
      error: { code: "subscription_required" },
    });
  });
});

describe("paid tools", () => {
  it("need the spend scope and a subscription", async () => {
    const db = seed();
    expect(await call(db, "draft_reply", { targetId: T_OPEN }, ["read", "write"])).toMatchObject({
      ok: false,
      status: 403,
      error: { code: "forbidden_scope" },
    });
    mocks.subscribed = false;
    expect(await call(db, "correct_reply_draft", { draftId: D_OPEN, reason: "too long" })).toMatchObject({
      ok: false,
      status: 402,
      error: { code: "subscription_required" },
    });
    expect(mocks.runJobNow).not.toHaveBeenCalled();
    expect(mocks.correctDraft).not.toHaveBeenCalled();
  });

  it("draft_reply enqueues the job for this site, runs it, and returns the drafts when it completed", async () => {
    const db = seed();
    mocks.runJobNow.mockImplementation(async (_admin: unknown, jobId: string) => {
      Object.assign(row(db, "jobs", jobId), { status: "completed", result: { audit: { status: "passed", writes: 1, omitted: [] } } });
      return "completed";
    });
    const run = await call(db, "draft_reply", { targetId: T_OPEN, waitSeconds: 5 });
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    const job = db.tables.jobs.find((j) => j.id !== J_A && (j.input as { targetId?: string }).targetId === T_OPEN)!;
    expect(job).toMatchObject({ user_id: USER, business_id: SITE_A, input: { businessId: SITE_A, targetId: T_OPEN } });
    expect(run.output).toMatchObject({
      jobId: job.id,
      status: "completed",
      alreadyRunning: false,
      job: { audit: { status: "passed", writes: 1 } },
      target: { id: T_OPEN, drafts: [{ id: D_OPEN }] },
    });
    expect(mocks.runJobNow).toHaveBeenCalledWith(db, job.id, 105_000);
  });

  it("draft_reply answers with the job's status when the wait is over, and keeps it running", async () => {
    const db = seed();
    mocks.runJobNow.mockImplementation(() => new Promise(() => {}));
    const run = await call(db, "draft_reply", { targetId: T_OPEN, waitSeconds: 0 });
    expect(run).toMatchObject({ ok: true, output: { status: "pending", target: null } });
    // The tool's own work kept alive, and the call's audit row (lib/tools/usage.ts).
    expect(mocks.afterTasks).toHaveLength(2);
  });

  it("draft_reply refuses without About you, and for a skipped target, before anything is enqueued", async () => {
    const empty = seed({ aboutYou: "" });
    expect(await call(empty, "draft_reply", { targetId: T_OPEN })).toMatchObject({
      ok: false,
      status: 409,
      error: { code: "prerequisite_missing", hint: expect.stringContaining("/settings/voice") },
    });
    const db = seed();
    expect(await call(db, "draft_reply", { targetId: T_SKIPPED })).toMatchObject({
      ok: false,
      status: 409,
      error: { code: "invalid_state" },
    });
    expect(db.tables.jobs).toHaveLength(2);
  });

  it("draft_reply keeps the daily draft cap", async () => {
    const db = seed();
    const recent = new Date().toISOString();
    for (let i = 0; i < 60; i++) {
      db.tables.jobs.push({ id: `cap-${i}`, user_id: USER, business_id: SITE_B, type: "placement-draft", status: "completed", created_at: recent });
    }
    expect(await call(db, "draft_reply", { targetId: T_OPEN })).toMatchObject({
      ok: false,
      status: 429,
      error: { code: "cap_reached" },
    });
    expect(mocks.runJobNow).not.toHaveBeenCalled();
  });

  it("correct_reply_draft calls the inbox's correction for this site, under the daily cap", async () => {
    const db = seed();
    mocks.correctDraft.mockResolvedValue({
      ok: true,
      draft: { ...draft(D_OPEN, T_OPEN, USER, SITE_A), agentVersion: 16, auditStatus: "passed", linkUrl: null, updatedAt: "now" },
      audit: { status: "passed", checks: [] },
      targetStatus: "drafted",
      feedbackId: "fb-1",
    });
    const run = await call(db, "correct_reply_draft", { draftId: D_OPEN, reason: "too long" });
    expect(run).toMatchObject({ ok: true, output: { feedbackId: "fb-1", targetStatus: "drafted" } });
    expect(mocks.correctDraft).toHaveBeenCalledWith(
      expect.objectContaining({ userId: USER, businessId: SITE_A, draftId: D_OPEN, reason: "too long", body: null })
    );

    mocks.correctDraft.mockClear();
    const recent = new Date().toISOString();
    for (let i = 0; i < 100; i++) db.tables.draft_feedback.push({ id: `fb-${i}`, user_id: USER, created_at: recent });
    expect(await call(db, "correct_reply_draft", { draftId: D_OPEN, reason: "too long" })).toMatchObject({
      ok: false,
      status: 429,
      error: { code: "cap_reached" },
    });
    expect(mocks.correctDraft).not.toHaveBeenCalled();
  });

  it("correct_reply_draft maps the correction's refusals to the API's codes", async () => {
    mocks.correctDraft.mockResolvedValue({ ok: false, status: 503, error: "The AI provider did not answer.", feedbackId: "fb-2" });
    expect(await call(seed(), "correct_reply_draft", { draftId: D_OPEN, reason: "too long" })).toMatchObject({
      ok: false,
      status: 503,
      error: { code: "unavailable" },
    });
  });

  it("add_x_post adds the post to this site's inbox and starts its draft", async () => {
    const db = seed();
    // The table's default for created_at, which the fake does not apply.
    const from = db.from.bind(db);
    db.from = ((table: string) => {
      const builder = from(table) as { upsert: (values: Record<string, unknown>, options?: unknown) => unknown };
      if (table !== "placement_targets") return builder;
      const upsert = builder.upsert;
      builder.upsert = (values, options) => upsert({ created_at: "2026-11-09T12:00:00.000Z", ...values }, options);
      return builder;
    }) as typeof db.from;
    mocks.readXPost.mockResolvedValue({ text: "Anyone know how to get cited by Perplexity?", authorName: "Jo", handle: "jo", postedOn: null });
    const run = await call(db, "add_x_post", { url: "https://x.com/jo/status/1855000000000000999" });
    expect(run).toMatchObject({ ok: true });
    if (!run.ok) return;
    expect(run.output).toMatchObject({ outcome: "created", textFrom: "x", target: { status: "qualified", surface: "x" }, draft: { started: true } });
    const added = db.tables.placement_targets.find((t) => t.external_id === "status:1855000000000000999")!;
    expect(added).toMatchObject({ user_id: USER, business_id: SITE_A, found_via: "manual" });
    expect(db.tables.jobs.some((j) => (j.input as { targetId?: string }).targetId === added.id)).toBe(true);

    expect(await call(db, "add_x_post", { url: "https://example.com/post" })).toMatchObject({
      ok: false,
      status: 400,
      error: { code: "invalid_input" },
    });
  });

  it("run_reply_discovery starts this site's discovery, or says it is unavailable", async () => {
    const db = seed();
    expect(await call(db, "run_reply_discovery", {})).toMatchObject({ ok: false, status: 503, error: { code: "unavailable" } });

    mocks.providers = [{ name: "web-search" }];
    mocks.runJobNow.mockImplementation(async (_admin: unknown, jobId: string) => {
      Object.assign(row(db, "jobs", jobId), { status: "completed", result: { found: 3 } });
      return "completed";
    });
    const run = await call(db, "run_reply_discovery", { waitSeconds: 1 });
    expect(run).toMatchObject({
      ok: true,
      output: { status: "completed", alreadyRunning: false, providers: ["web-search"], job: { result: { found: 3 } } },
    });
    expect(db.tables.jobs.find((j) => j.type === "placement-discovery")).toMatchObject({ user_id: USER, business_id: SITE_A });
  });
});
