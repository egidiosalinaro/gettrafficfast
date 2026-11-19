import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { FakeSupabase } from "../support/fake-supabase";
import { OTHER, SITE_A, SITE_B, SITE_C, USER, apiCaller, businesses, uuid } from "../tools/support";

/**
 * Today (2026-11-14): `loadTodayScreen`, the one read behind `GET /api/today`
 * and `get_today`. Pinned: the progress is the count's own rows; the tabs'
 * counts are the inbox's rules; "Also today" holds a held or failed article,
 * a stale fact and a reply whose link GTF stopped looking for, and nothing
 * else (a reply GTF is still looking for, a linked one, an old one, a removed
 * one, a fresh fact, a published article are not there); another site's or
 * account's rows never are; nothing is written; with nothing to say the list
 * is empty.
 */

const mocks = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/subscription", () => ({ hasActiveSubscription: async () => true }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => mocks.db }));

import { runTool } from "@/lib/tools/runner";
import { loadTodayScreen } from "@/lib/today/read";

const NOW = new Date("2026-11-14T15:00:00.000Z");
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();
const STALE = "Co-founded Postwren: 12 paying stores in October 2026.";
const FRESH = "40 orders a week as of November 10, 2026.";

let n = 0;
function target(over: Record<string, unknown>) {
  n += 1;
  return {
    id: uuid("e", n),
    user_id: USER,
    business_id: SITE_A,
    surface: "x",
    kind: "post",
    url: `https://x.com/someone/status/18550000000000000${String(n).padStart(2, "0")}`,
    title: "How do you get cited by ChatGPT?",
    author: "someone",
    community: null,
    status: "qualified",
    found_via: "x_search",
    qualified_by: "agent",
    fresh_until: null,
    snoozed_until: null,
    posted_at: ago(60),
    published_url: null,
    published_at: null,
    published_text: null,
    removed_at: null,
    selected_placement_id: null,
    created_at: ago(90),
    ...over,
  };
}

function article(id: string, status: string, over: Record<string, unknown> = {}) {
  return {
    id,
    user_id: USER,
    business_id: SITE_A,
    status,
    scheduled_date: "2026-11-14",
    keywords: { keyword: "how answer engines pick their sources" },
    last_error: null,
    quality_report: null,
    ...over,
  };
}

function seed() {
  n = 0;
  const posted = (over: Record<string, unknown>) => target({ status: "published_manually", ...over });
  const stoppedId = uuid("e", 90);
  const lookingId = uuid("e", 91);
  const db = new FakeSupabase({
    businesses: businesses({ aboutYou: `${STALE} ${FRESH}` }).map((b) =>
      b.id === SITE_A ? { ...b, voice_settings: { ...b.voice_settings, dailyReplyGoal: 5, findPostsOnX: true } } : b
    ),
    placement_targets: [
      target({}),
      target({ status: "drafted" }),
      target({ status: "dismissed" }),
      target({ status: "rejected" }),
      target({ status: "discovered" }),
      // Posted today: one linked by GTF, one GTF stopped looking for, one still looked for.
      posted({ published_at: ago(120), published_url: "https://x.com/acme/status/1900000000000000001" }),
      posted({ id: stoppedId, published_at: ago(180), published_text: null }),
      posted({ id: lookingId, published_at: ago(5) }),
      // Removed: archived, never a link to paste.
      posted({ published_at: ago(60 * 30), removed_at: ago(60 * 20) }),
      // Posted 9 days ago with no link: past X's search, not in Also today.
      posted({ published_at: ago(60 * 24 * 9) }),
      // Another site of the same account, and another account.
      target({ business_id: SITE_B, status: "published_manually", published_at: ago(30) }),
      target({ business_id: SITE_C, user_id: OTHER, status: "published_manually", published_at: ago(30) }),
    ],
    placement_link_searches: [
      { target_id: stoppedId, user_id: USER, business_id: SITE_A, attempts: 4, last_attempt_at: ago(20), outcome: "ambiguous", posts_seen: 3, found_url: null, found_at: null },
      { target_id: lookingId, user_id: USER, business_id: SITE_A, attempts: 0, last_attempt_at: null, outcome: null, posts_seen: 0, found_url: null, found_at: null },
    ],
    placements: [],
    articles: [
      article(uuid("f", 1), "needs_review", { last_error: "A figure has no source. | The intro repeats the title." }),
      article(uuid("f", 2), "failed", { scheduled_date: "2026-11-12" }),
      article(uuid("f", 3), "published"),
      article(uuid("f", 4), "needs_review", { business_id: SITE_B }),
      article(uuid("f", 5), "failed", { business_id: SITE_C, user_id: OTHER }),
      // Ignored on Today: it stays failed on the Content board, not here.
      article(uuid("f", 6), "failed", { scheduled_date: "2026-11-11", dismissed_at: "2026-11-13T09:00:00Z" }),
    ],
  });
  mocks.db = db;
  return db;
}

let quiet: Array<ReturnType<typeof vi.spyOn>>;
beforeEach(() => {
  quiet = (["info", "warn", "error"] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => {}));
});
afterEach(() => quiet.forEach((spy) => spy.mockRestore()));

describe("loadTodayScreen", () => {
  it("counts today's replies toward the goal, and says where their links stand", async () => {
    const db = seed();
    const screen = await loadTodayScreen(db as unknown as SupabaseClient, SITE_A, { admin: () => db as unknown as SupabaseClient, timeZone: "UTC", now: NOW });
    expect(screen.progress).toMatchObject({ posted: 3, goal: 5, timeZone: "UTC" });
    // The X API is off here, so GTF looks for nothing: the two without a link are to paste.
    expect(screen.progress.links).toMatchObject({ total: 3, linked: 1, looking: 0, toPaste: 2, tone: "todo", line: "2 links to paste" });
  });

  it("counts the three tabs by the inbox's rules, this site only", async () => {
    const db = seed();
    const screen = await loadTodayScreen(db as unknown as SupabaseClient, SITE_A, { admin: () => db as unknown as SupabaseClient, now: NOW });
    // To do: qualified, drafted. Posted: three of today, one 9 days old. Archive: skipped, filtered out, removed.
    expect(screen.counts).toEqual({ todo: 2, posted: 4, archive: 3 });
  });

  it("lists the held and the failed article, the reply whose link GTF stopped looking for, and the stale fact, in that order", async () => {
    const db = seed();
    const screen = await loadTodayScreen(db as unknown as SupabaseClient, SITE_A, { admin: () => db as unknown as SupabaseClient, timeZone: "UTC", now: NOW });
    expect(screen.alsoToday.map((item) => item.kind)).toEqual(["article_held", "article_failed", "reply_link", "fact_stale"]);
    const [held, failed, link, fact] = screen.alsoToday;
    expect(held).toMatchObject({
      articleId: uuid("f", 1),
      title: "how answer engines pick their sources",
      isToday: true,
      reason: "A figure has no source.",
      moreReasons: 1,
      tools: ["resettle_article", "publish_article", "generate_article"],
    });
    expect(failed).toMatchObject({ articleId: uuid("f", 2), isToday: false, reason: null, tools: ["retry_article", "dismiss_failed_articles"] });
    expect(link).toMatchObject({ targetId: uuid("e", 90), outcome: "ambiguous", tools: ["set_reply_link"] });
    expect(link.kind === "reply_link" && link.line).toMatch(/more than one reply of yours/);
    expect(fact).toMatchObject({ sentence: STALE, dateLabel: "October 2026", tools: ["confirm_about_you_fact", "update_voice_settings"] });
    // A read: nothing was written.
    expect(db.calls.filter((call) => !call.startsWith("select:"))).toEqual([]);
  });

  it("is empty when nothing needs a gesture: no section, no placeholder", async () => {
    const db = new FakeSupabase({ businesses: businesses({ aboutYou: FRESH }), placement_targets: [], placements: [], articles: [] });
    const screen = await loadTodayScreen(db as unknown as SupabaseClient, SITE_A, { admin: () => db as unknown as SupabaseClient, now: NOW });
    expect(screen.alsoToday).toEqual([]);
    expect(screen.progress.links).toBeNull();
    expect(screen.progress.goal).toBeNull();
    expect(screen.counts).toEqual({ todo: 0, posted: 0, archive: 0 });
  });
});

describe("get_today", () => {
  it("answers what the screen reads, for the key's site, with the read scope and no spend", async () => {
    // The tool reads the clock itself; the fixture's "today" is NOW's day,
    // so the test stops passing the day after it was written without this.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    onTestFinished(() => {
      vi.useRealTimers();
    });
    const db = seed();
    const run = await runTool(apiCaller(db, { scopes: ["read"] }), "get_today", { timeZone: "UTC" });
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    const output = run.output as { progress: { posted: number }; counts: unknown; alsoToday: Array<{ kind: string; id: string }> };
    expect(output.progress.posted).toBe(3);
    expect(output.counts).toEqual({ todo: 2, posted: 4, archive: 3 });
    expect(output.alsoToday.map((i) => i.kind)).toEqual(["article_held", "article_failed", "reply_link", "fact_stale"]);
    // Nothing of site B or of the other account.
    expect(output.alsoToday.map((i) => i.id)).not.toContain(`article:${uuid("f", 4)}`);
    expect(output.alsoToday.map((i) => i.id)).not.toContain(`article:${uuid("f", 5)}`);
  });

  it("reads site B when the key is for site B", async () => {
    const db = seed();
    const run = await runTool(apiCaller(db, { businessId: SITE_B }), "get_today", {});
    expect(run.ok).toBe(true);
    if (!run.ok) return;
    const output = run.output as { alsoToday: Array<{ id: string }> };
    expect(output.alsoToday.map((i) => i.id)).toContain(`article:${uuid("f", 4)}`);
    expect(output.alsoToday.map((i) => i.id)).not.toContain(`article:${uuid("f", 1)}`);
  });
});
