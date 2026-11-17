import { describe, expect, it } from "vitest";
import { FakeSupabase } from "../support/fake-supabase";
import { mapReplyMetrics, type ReplyMetrics } from "@/lib/placements/reply-metrics";
import {
  REPLY_STATS_NOTE,
  coverageLine,
  offLine,
  signedChange,
  snippet,
  statNumber,
  summarizeFollowers,
  summarizeReplyStats,
  type PostedXReply,
  type XAccountSnapshot,
} from "@/lib/placements/reply-stats";
import { loadReplyStats } from "@/lib/placements/reply-stats-read";

/**
 * The week on X, summed. Pinned: a week nobody measured is null, never 0;
 * partial coverage is counted and said; a number X did not return is left
 * out of its sum; the week before is read as of its own last day, so the
 * change compares each week's replies at the same age; removed replies are
 * not counted; the top three are this week's most viewed; the followers'
 * change needs both ends, from the same account.
 */

const NOW = new Date("2026-11-13T15:00:00.000Z");

function snap(day: string, over: Partial<ReplyMetrics> = {}): ReplyMetrics {
  return mapReplyMetrics({ day, fetched_at: `${day}T13:20:00Z`, impressions: null, likes: null, replies: null, reposts: null, quotes: null, bookmarks: null, ...over });
}

let n = 0;
function reply(publishedAt: string, snapshots: ReplyMetrics[], over: Partial<PostedXReply> = {}): PostedXReply {
  n += 1;
  return {
    id: `r${n}`,
    publishedAt,
    publishedUrl: `https://x.com/samriv/status/18550000000000000${String(n).padStart(2, "0")}`,
    threadUrl: `https://x.com/janedoe/status/17550000000000000${String(n).padStart(2, "0")}`,
    threadAuthor: "janedoe",
    text: `Reply ${n}`,
    removed: false,
    snapshots,
    ...over,
  };
}

const input = (replies: PostedXReply[], over: Partial<Parameters<typeof summarizeReplyStats>[0]> = {}) =>
  summarizeReplyStats({ now: NOW, platformEnabled: true, siteEnabled: true, replies, metricsReadable: true, handle: "samriv", account: [], ...over });

describe("the week's sums", () => {
  it("adds the newest numbers of the measured replies, says who is not measured, and never turns a gap into 0", () => {
    const stats = input([
      reply("2026-11-12T09:00:00Z", [snap("2026-11-13", { impressions: 1200, likes: 8, replies: 2, reposts: 0 }), snap("2026-11-12", { impressions: 300 })]),
      reply("2026-11-10T09:00:00Z", [snap("2026-11-13", { impressions: 50, likes: 1, replies: null, reposts: 1 })]),
      // Posted with no link saved: cannot be measured.
      reply("2026-11-11T09:00:00Z", [], { publishedUrl: null }),
      // Asked, X gave nothing (deleted): not measured, not zero.
      reply("2026-11-09T09:00:00Z", [snap("2026-11-13")]),
    ]);
    expect(stats.week).toMatchObject({ asOfDay: "2026-11-13", posted: 4, measured: 2, withoutLink: 1, views: 1250, likes: 9, replies: 2, reposts: 1 });
    expect(coverageLine(stats.week)).toBe("2 of 4 replies measured · 1 without a link");
    expect(stats.note).toBe(REPLY_STATS_NOTE);
    expect(stats.status).toBe("on");
  });

  it("is null, not 0, when no reply of the week is measured, and when no reply was posted", () => {
    const unmeasured = input([reply("2026-11-12T09:00:00Z", [])]);
    expect(unmeasured.week).toMatchObject({ posted: 1, measured: 0, views: null, likes: null, replies: null, reposts: null });
    expect(unmeasured.top).toEqual([]);
    const empty = input([]);
    expect(empty.week).toMatchObject({ posted: 0, measured: 0, views: null });
    expect(empty.change).toEqual({ views: null, likes: null, replies: null, reposts: null });
    expect(coverageLine(empty.week)).toBe("No replies posted on X in the last 7 days.");
  });

  it("does not count a removed reply, and says nothing was measured when the numbers could not be read", () => {
    const stats = input([reply("2026-11-12T09:00:00Z", [snap("2026-11-13", { impressions: 10 })], { removed: true })]);
    expect(stats.week).toMatchObject({ posted: 0, views: null });
    const unreadable = input([reply("2026-11-12T09:00:00Z", [snap("2026-11-13", { impressions: 10 })])], { metricsReadable: false });
    expect(unreadable).toMatchObject({ measured: false, week: { posted: 1, measured: 0, views: null }, top: [] });
  });

  it("reads the week before as of its own last day, so the change compares replies of the same age", () => {
    const older = reply("2026-11-03T09:00:00Z", [
      // Today the older reply has had 10 days to collect views...
      snap("2026-11-13", { impressions: 5000, likes: 40 }),
      // ...the comparison takes what it had at the end of its own week.
      snap("2026-11-06", { impressions: 900, likes: 10 }),
      snap("2026-11-04", { impressions: 400, likes: 2 }),
    ]);
    const recent = reply("2026-11-12T09:00:00Z", [snap("2026-11-13", { impressions: 1200, likes: 8 })]);
    const stats = input([older, recent]);
    expect(stats.previousWeek).toMatchObject({ asOfDay: "2026-11-06", posted: 1, measured: 1, views: 900, likes: 10 });
    expect(stats.change).toEqual({ views: 300, likes: -2, replies: null, reposts: null });
  });

  it("anchors the day on the newest snapshot: before today's run, yesterday's numbers and the day 8 days back", () => {
    const stats = input([
      reply("2026-11-10T09:00:00Z", [snap("2026-11-12", { impressions: 70 })]),
      reply("2026-11-04T20:00:00Z", [snap("2026-11-06", { impressions: 30 }), snap("2026-11-05", { impressions: 20 })]),
    ]);
    expect(stats.week.asOfDay).toBe("2026-11-12");
    expect(stats.previousWeek).toMatchObject({ asOfDay: "2026-11-05", views: 20 });
  });

  it("has no change when the week before was not measured", () => {
    const stats = input([reply("2026-11-12T09:00:00Z", [snap("2026-11-13", { impressions: 10 })]), reply("2026-11-02T09:00:00Z", [])]);
    expect(stats.previousWeek).toMatchObject({ posted: 1, measured: 0, views: null });
    expect(stats.change.views).toBeNull();
  });

  it("lists this week's three most viewed replies with their text, link and thread", () => {
    const replies = [
      reply("2026-11-12T09:00:00Z", [snap("2026-11-13", { impressions: 40, likes: 1 })]),
      reply("2026-11-11T09:00:00Z", [snap("2026-11-13", { impressions: 900, likes: 3 })], { text: "  The short answer:\n\nput the answer first.  " }),
      reply("2026-11-10T09:00:00Z", [snap("2026-11-13", { impressions: 120 })]),
      reply("2026-11-09T09:00:00Z", [snap("2026-11-13", { impressions: 80 })]),
      // Measured but X sent no view count: not ranked by views.
      reply("2026-11-08T09:00:00Z", [snap("2026-11-13", { likes: 50 })]),
      // Last week's: not in this week's top.
      reply("2026-11-02T09:00:00Z", [snap("2026-11-13", { impressions: 99_000 })]),
    ];
    const top = input(replies).top;
    expect(top.map((t) => t.views)).toEqual([900, 120, 80]);
    expect(top[0]).toMatchObject({
      text: "The short answer: put the answer first.",
      publishedUrl: replies[1].publishedUrl,
      threadUrl: replies[1].threadUrl,
      threadAuthor: "janedoe",
      day: "2026-11-13",
      likes: 3,
      replies: null,
    });
  });

  it("says why nothing is read when the X API is off for the site", () => {
    expect(input([], { platformEnabled: false }).status).toBe("off_platform");
    expect(input([], { siteEnabled: false }).status).toBe("off_site");
    expect(offLine("off_site")).toMatch(/Find posts on X in Settings → Connections/);
    expect(offLine("off_platform")).toMatch(/not available yet/);
    expect(offLine("on")).toBeNull();
  });
});

describe("followers", () => {
  const day = (d: string, followers: number | null, handle = "samriv"): XAccountSnapshot => ({
    day: d,
    handle,
    followers,
    following: 300,
    posts: 5000,
    listed: 4,
    fetchedAt: `${d}T13:20:00Z`,
  });

  it("gives the newest count and the change over 7 days when both ends were read", () => {
    expect(summarizeFollowers([day("2026-11-13", 2310), day("2026-11-07", 2276), day("2026-11-06", 2274)], "samriv")).toMatchObject({
      handle: "samriv",
      day: "2026-11-13",
      followers: 2310,
      change: 36,
      changeSince: "2026-11-06",
    });
    // A missed run: 8 days back still is the other end.
    expect(summarizeFollowers([day("2026-11-13", 2310), day("2026-11-05", 2226)], "samriv")).toMatchObject({ change: 84, changeSince: "2026-11-05" });
  });

  it("has no change with one end missing, too old, unread, or of another account", () => {
    expect(summarizeFollowers([day("2026-11-13", 2310)], "samriv").change).toBeNull();
    expect(summarizeFollowers([day("2026-11-13", 2310), day("2026-11-01", 1000)], "samriv").change).toBeNull();
    expect(summarizeFollowers([day("2026-11-13", 2310), day("2026-11-06", null)], "samriv").change).toBeNull();
    expect(summarizeFollowers([day("2026-11-13", 2310, "Samriv"), day("2026-11-06", 10, "someoneelse")], "samriv").change).toBeNull();
    // Case does not make another account.
    expect(summarizeFollowers([day("2026-11-13", 2310, "Samriv"), day("2026-11-06", 2306)], "samriv").change).toBe(4);
  });

  it("is not measured, never 0, before the first read or when the table cannot be read", () => {
    expect(summarizeFollowers([], "samriv")).toMatchObject({ handle: "samriv", day: null, followers: null, change: null });
    expect(summarizeFollowers(null, null)).toMatchObject({ handle: null, followers: null });
  });
});

describe("how the numbers read", () => {
  it("in full under 10,000, short above, the change signed", () => {
    expect([statNumber(0), statNumber(950), statNumber(9_870), statNumber(12_400), statNumber(3_450_000)]).toEqual(["0", "950", "9,870", "12.4K", "3.5M"]);
    expect([signedChange(2_100), signedChange(-4), signedChange(0), signedChange(15_300)]).toEqual(["+2,100", "−4", "same", "+15.3K"]);
    expect(coverageLine({ posted: 5, measured: 5, withoutLink: 0 })).toBe("5 replies, all measured");
    expect(coverageLine({ posted: 1, measured: 0, withoutLink: 0 })).toBe("0 of 1 reply measured");
    expect(snippet("   ")).toBeNull();
    expect(snippet("a".repeat(400))?.length).toBe(280);
  });

  it("uses no em dash anywhere a person reads", () => {
    for (const line of [REPLY_STATS_NOTE, offLine("off_site"), offLine("off_platform"), coverageLine({ posted: 3, measured: 1, withoutLink: 2 })]) {
      expect(line).not.toContain("—");
    }
  });
});

describe("loadReplyStats", () => {
  const SITE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const OTHER_SITE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const USER = "11111111-1111-4111-8111-111111111111";

  const target = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    user_id: USER,
    business_id: SITE,
    surface: "x",
    status: "published_manually",
    url: `https://x.com/janedoe/status/9${id.length}`,
    author: "janedoe",
    community: null,
    published_url: "https://x.com/samriv/status/1855000000000000001",
    published_at: "2026-11-12T09:00:00Z",
    published_text: null,
    selected_placement_id: null,
    removed_at: null,
    ...over,
  });
  const metric = (targetId: string, day: string, over: Record<string, unknown> = {}) => ({
    target_id: targetId,
    user_id: USER,
    business_id: SITE,
    day,
    impressions: null,
    likes: null,
    replies: null,
    reposts: null,
    quotes: null,
    bookmarks: null,
    fetched_at: `${day}T13:20:00Z`,
    ...over,
  });

  it("reads the site's posted replies on X, their texts, their snapshots and the account, and sums them", async () => {
    const db = new FakeSupabase({
      businesses: [{ id: SITE, user_id: USER, voice_settings: { findPostsOnX: true } }],
      placement_targets: [
        target("a", { published_text: "Put the answer in the first sentence." }),
        target("b", { published_url: "https://x.com/samriv/status/1855000000000000002", selected_placement_id: "d2" }),
        target("c", { status: "drafted" }),
        target("d", { surface: "reddit", published_url: "https://www.reddit.com/r/seo/comments/abc/x/def/" }),
        target("e", { business_id: OTHER_SITE }),
        target("f", { removed_at: "2026-11-12T12:00:00Z" }),
      ],
      placements: [
        { id: "d1", target_id: "b", body: "A first draft.", created_at: "2026-11-12T08:00:00Z" },
        { id: "d2", target_id: "b", body: "The draft that was posted.", created_at: "2026-11-12T08:30:00Z" },
      ],
      placement_metrics: [
        metric("a", "2026-11-13", { impressions: 1200, likes: 8 }),
        metric("b", "2026-11-13", { impressions: 300, likes: 0 }),
        metric("e", "2026-11-13", { impressions: 99_999, business_id: OTHER_SITE }),
        metric("f", "2026-11-13", { impressions: 5_000 }),
      ],
      x_account_metrics: [
        { business_id: SITE, user_id: USER, day: "2026-11-13", handle: "Samriv", followers: 2310, following: 300, posts: 5000, listed: 4, fetched_at: "x" },
        { business_id: SITE, user_id: USER, day: "2026-11-06", handle: "Samriv", followers: 2276, following: 290, posts: 4900, listed: 4, fetched_at: "x" },
      ],
    });
    const stats = await loadReplyStats(db as never, SITE, { xApiEnabled: true, now: NOW });
    expect(stats.status).toBe("on");
    expect(stats.week).toMatchObject({ posted: 2, measured: 2, views: 1500, likes: 8 });
    expect(stats.top.map((t) => t.text)).toEqual(["Put the answer in the first sentence.", "The draft that was posted."]);
    expect(stats.followers).toMatchObject({ handle: "Samriv", followers: 2310, change: 34, changeSince: "2026-11-06" });
  });

  it("says the X API is off for the site, and reads followers as not measured while the table is not there", async () => {
    const db = new FakeSupabase({
      businesses: [{ id: SITE, user_id: USER, voice_settings: { findPostsOnX: false } }],
      placement_targets: [target("a")],
      placement_metrics: [],
    });
    const from = db.from.bind(db);
    (db as unknown as { from: (t: string) => unknown }).from = (table: string) => {
      if (table !== "x_account_metrics") return from(table);
      const chain: Record<string, unknown> = {};
      for (const m of ["select", "eq", "gte", "order", "limit"]) chain[m] = () => chain;
      chain.then = (resolve: (v: unknown) => unknown) => resolve({ data: null, error: { code: "PGRST205", message: "missing" } });
      return chain;
    };
    const stats = await loadReplyStats(db as never, SITE, { xApiEnabled: true, now: NOW });
    expect(stats.status).toBe("off_site");
    expect(stats.followers).toMatchObject({ handle: "samriv", followers: null, day: null, change: null });
    expect(stats.week).toMatchObject({ posted: 1, measured: 0, views: null });
  });
});
