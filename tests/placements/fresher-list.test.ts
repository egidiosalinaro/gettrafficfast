import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import {
  REPLY_WINDOW_DAYS,
  floorAge,
  inView,
  isExpired,
  orderInbox,
  replyWindowDays,
  type ViewRow,
} from "@/lib/placements/inbox-view";
import {
  agoLabel,
  discoveryProgressText,
  lastSearchText,
  nextSearchLabel,
  qualifyProgressOf,
  withXSearchOff,
} from "@/lib/placements/discovery-progress";
import { WEB_DISCOVERY_SCHEDULE, X_SEARCH_SCHEDULE, nextScheduledRun } from "@/lib/placements/schedule";
import { foundDay, foundLabel, postedPhrase, rowMeta } from "@/components/placements/reply-logic";
import type { PlacementTargetRecord } from "@/lib/placements/read";

/**
 * 2026-11-12: the owner had not opened the inbox for weeks and asked whether
 * what he saw was new. Of 322 found rows still inside their stored window,
 * 49 were under 7 days old, 52 7 to 30, 189 30 to 90 and 32 over 90. Found
 * rows now leave "To reply" past a window per platform, the list is newest
 * first, each row says when it was posted and when it was found, and the
 * heading says when discovery last searched.
 */

const NOW = Date.parse("2026-11-12T12:00:00Z");
const DAY = 86_400_000;
const ago = (days: number) => new Date(NOW - days * DAY).toISOString();

const found = (over: Partial<ViewRow> = {}): ViewRow => ({
  status: "qualified",
  foundVia: "web-search",
  qualifiedBy: "agent",
  freshUntil: new Date(NOW + 300 * DAY).toISOString(),
  snoozedUntil: null,
  surface: "reddit",
  kind: "thread",
  postedAt: ago(1),
  createdAt: ago(1),
  ...over,
});

describe("the To reply window per platform", () => {
  const cases: Array<[string, string, number]> = [
    ["x", "post", 2],
    ["linkedin", "post", 14],
    ["reddit", "thread", 30],
    ["quora", "thread", 60],
    ["hackernews", "thread", 60],
    ["indiehackers", "thread", 60],
    ["devto", "thread", 60],
    ["stackexchange", "thread", 60],
    ["github", "issue", 90],
  ];

  it.each(cases)("%s %s: in To reply up to %i days, Expired a moment after", (surface, kind, days) => {
    expect(replyWindowDays(surface, kind)).toBe(days);
    const inside = found({ surface, kind, postedAt: ago(days) });
    const past = found({ surface, kind, postedAt: new Date(NOW - days * DAY - 60_000).toISOString() });
    expect(isExpired(inside, NOW)).toBe(false);
    expect(inView(inside, "to_reply", NOW)).toBe(true);
    expect(isExpired(past, NOW)).toBe(true);
    // Still reachable: the Expired list holds it, its status untouched.
    expect(inView(past, "expired", NOW)).toBe(true);
    expect(past.status).toBe("qualified");
  });

  it("names the windows as constants", () => {
    expect(REPLY_WINDOW_DAYS).toEqual({ xPost: 2, linkedinPost: 14, redditThread: 30, questionSite: 60, githubIssue: 90 });
  });

  it("leaves list articles, repositories and pages to their stored window", () => {
    for (const [surface, kind] of [["web", "listicle"], ["github", "repository"], ["linkedin", "article"], ["x", "article"], ["web", "page"]]) {
      expect(replyWindowDays(surface, kind)).toBeNull();
      expect(isExpired(found({ surface, kind, postedAt: ago(200) }), NOW)).toBe(false);
    }
    // The stored window still applies to them.
    expect(isExpired(found({ surface: "web", kind: "listicle", postedAt: ago(200), freshUntil: ago(1) }), NOW)).toBe(true);
  });

  it("never expires a post the person added or drafted by hand", () => {
    const old = { surface: "x", kind: "post", postedAt: ago(40) };
    expect(isExpired(found({ ...old, foundVia: "manual", qualifiedBy: "person" }), NOW)).toBe(false);
    expect(isExpired(found({ ...old, qualifiedBy: "person" }), NOW)).toBe(false);
    expect(inView(found({ ...old, foundVia: "manual" }), "to_reply", NOW)).toBe(true);
  });

  it("reads when it was found as a floor, but never ages an undated row by it for the window", () => {
    expect(floorAge({ postedAt: null, createdAt: ago(31) }, NOW)).toEqual({ ms: 31 * DAY, from: "found" });
    expect(floorAge({ postedAt: ago(3), createdAt: ago(1) }, NOW)).toEqual({ ms: 3 * DAY, from: "posted" });
    expect(floorAge({ postedAt: null, createdAt: null }, NOW)).toBeNull();
    // Since 2026-11-13 an undated row leaves To reply a week after it was
    // found, whatever its platform's window (tests/placements/post-dates.test.ts).
    expect(isExpired(found({ postedAt: null, createdAt: ago(31) }), NOW)).toBe(true);
    expect(isExpired(found({ postedAt: null, createdAt: ago(8) }), NOW)).toBe(true);
    expect(isExpired(found({ postedAt: null, createdAt: ago(6) }), NOW)).toBe(false);
  });

  it("reads a dated row with a precision as the floor the source allows", () => {
    // "2 months ago" is stored as the latest instant it allows: 61 days is at least 61 days.
    expect(isExpired(found({ surface: "quora", postedAt: ago(61) }), NOW)).toBe(true);
  });
});

describe("Found for you, newest first", () => {
  it("puts the newest post first, the score only breaking ties, and undated rows after every dated one", () => {
    const rows = [
      { id: "old-high", ...found({ postedAt: ago(20) }), qualifyScore: 95 },
      { id: "new-low", ...found({ postedAt: ago(0.1) }), qualifyScore: 40 },
      { id: "undated-found-yesterday", ...found({ postedAt: null, createdAt: ago(1) }), qualifyScore: 80 },
      { id: "mid", ...found({ postedAt: ago(3) }), qualifyScore: 70 },
      { id: "tie-high", ...found({ postedAt: ago(5) }), qualifyScore: 90 },
      { id: "tie-low", ...found({ postedAt: ago(5) }), qualifyScore: 10 },
    ];
    expect(orderInbox(rows).map((r) => r.id)).toEqual(["new-low", "mid", "tie-high", "tie-low", "old-high", "undated-found-yesterday"]);
  });
});

describe("the schedule", () => {
  const crons = (JSON.parse(readFileSync(join(process.cwd(), "vercel.json"), "utf8")) as { crons: Array<{ path: string; schedule: string }> }).crons;
  const scheduleOf = (path: string) => crons.find((c) => c.path === path)?.schedule;

  it("runs web discovery Monday, Wednesday and Friday at 10:00 UTC, as the menu says", () => {
    expect(scheduleOf("/api/cron/discover-placements")).toBe("0 10 * * 1,3,5");
    expect(WEB_DISCOVERY_SCHEDULE.cron).toBe(scheduleOf("/api/cron/discover-placements"));
    expect(X_SEARCH_SCHEDULE.cron).toBe(scheduleOf("/api/cron/x-posts"));
  });

  it("finds the next run strictly after now", () => {
    // Thursday 2026-11-12 12:00 UTC: next is Friday 10:00.
    expect(nextScheduledRun(WEB_DISCOVERY_SCHEDULE, new Date(NOW)).toISOString()).toBe("2026-11-13T10:00:00.000Z");
    // Friday 10:00 exactly: the next is Monday.
    expect(nextScheduledRun(WEB_DISCOVERY_SCHEDULE, new Date("2026-11-13T10:00:00Z")).toISOString()).toBe("2026-11-16T10:00:00.000Z");
    // Monday 09:59: the same day.
    expect(nextScheduledRun(WEB_DISCOVERY_SCHEDULE, new Date("2026-11-16T09:59:00Z")).toISOString()).toBe("2026-11-16T10:00:00.000Z");
    expect(nextScheduledRun(X_SEARCH_SCHEDULE, new Date(NOW)).toISOString()).toBe("2026-11-12T13:20:00.000Z");
    expect(nextScheduledRun(X_SEARCH_SCHEDULE, new Date("2026-11-12T13:20:00Z")).toISOString()).toBe("2026-11-13T13:20:00.000Z");
  });

  it("says the next run in the person's time zone", () => {
    const state = { running: false, nextAt: "2026-11-16T10:00:00.000Z", x: null };
    expect(nextSearchLabel(state, "Europe/Berlin")).toBe("Next search Mon 11:00");
    expect(nextSearchLabel(state, "America/New_York")).toBe("Next search Mon 05:00");
    expect(
      nextSearchLabel({ ...state, x: { running: false, progress: null, lastCompletedAt: null, nextAt: "2026-11-12T13:20:00.000Z" } }, "Europe/Berlin")
    ).toBe("Next search: web Mon 11:00 · X Thu 14:20");
    expect(nextSearchLabel(state, "Not/AZone")).toBe("Next search Mon 10:00 UTC");
    expect(nextSearchLabel(null, "Europe/Berlin")).toBeNull();
  });
});

describe("progress while it runs", () => {
  const job = (currentStep: string | null, result: unknown = null, status = "running") => ({ status, currentStep, result });

  it("says what the run is doing, from the job's checkpoints", () => {
    expect(discoveryProgressText(job(null, null, "pending"))).toBe("Starting…");
    expect(discoveryProgressText(job("queries"))).toBe("Searching…");
    expect(discoveryProgressText(job("discover:web-search"))).toBe("Searching…");
    expect(discoveryProgressText(job("rules"))).toBe("Searching…");
    expect(discoveryProgressText(job("qualify"))).toBe("Judging…");
    expect(discoveryProgressText(job("qualify", { progress: { step: "qualify", judged: 23, total: 60 } }))).toBe("Judging 23 of 60…");
    // A job handed back to the queue between ticks still says where it is.
    expect(discoveryProgressText(job("qualify", { progress: { judged: 40, total: 60 } }, "pending"))).toBe("Judging 40 of 60…");
    expect(discoveryProgressText(job("qualify", null, "completed"))).toBeNull();
    expect(discoveryProgressText(null)).toBeNull();
  });

  it("reads only a sane progress", () => {
    expect(qualifyProgressOf({ progress: { judged: 70, total: 60 } })).toEqual({ judged: 60, total: 60 });
    expect(qualifyProgressOf({ progress: { judged: 1, total: 0 } })).toBeNull();
    expect(qualifyProgressOf({ progress: "x" })).toBeNull();
    expect(qualifyProgressOf({ queries: {} })).toBeNull();
  });
});

describe("the heading: when discovery last searched", () => {
  const at = (hours: number) => new Date(NOW - hours * 3_600_000).toISOString();

  it("says the last web search alone, both when the site also has the X search, and progress while running", () => {
    expect(lastSearchText({ running: false, lastCompletedAt: at(2), x: null }, NOW)).toBe("last search 2h ago");
    expect(lastSearchText({ running: false, lastCompletedAt: null, x: null }, NOW)).toBe("no search yet");
    expect(
      lastSearchText({ running: false, lastCompletedAt: at(2), x: { running: false, progress: null, lastCompletedAt: at(5), nextAt: null } }, NOW)
    ).toBe("web 2h ago · X 5h ago");
    expect(
      lastSearchText({ running: false, lastCompletedAt: null, x: { running: false, progress: null, lastCompletedAt: at(5), nextAt: null } }, NOW)
    ).toBe("web not yet · X 5h ago");
    expect(lastSearchText({ running: true, progress: "Judging 23 of 60…", lastCompletedAt: at(2), x: null }, NOW)).toBe("Judging 23 of 60…");
    expect(
      lastSearchText({ running: false, lastCompletedAt: at(2), x: { running: true, progress: "Searching X…", lastCompletedAt: null, nextAt: null } }, NOW)
    ).toBe("Searching X…");
    expect(lastSearchText(undefined, NOW)).toBeNull();
  });

  it("words the time compactly", () => {
    expect(agoLabel(new Date(NOW - 20_000).toISOString(), NOW)).toBe("just now");
    expect(agoLabel(at(0.5), NOW)).toBe("30m ago");
    expect(agoLabel(at(50), NOW)).toBe("2d ago");
    expect(agoLabel(null, NOW)).toBeNull();
  });

  it("drops the X search where the platform has no X API", () => {
    const state = { running: false, x: { running: false, progress: null, lastCompletedAt: null, nextAt: null } };
    expect(withXSearchOff(state, false).x).toBeNull();
    expect(withXSearchOff(state, true).x).not.toBeNull();
  });
});

describe("two times on every found row", () => {
  const target = (over: Partial<PlacementTargetRecord> = {}) =>
    ({
      surface: "reddit",
      kind: "thread",
      community: "r/SEO",
      author: null,
      postedAt: ago(0.125),
      postedAtPrecision: null,
      commentCount: null,
      status: "qualified",
      snoozedUntil: null,
      freshUntil: null,
      foundVia: "web-search",
      qualifiedBy: "agent",
      publishedAt: null,
      createdAt: ago(3),
      foundAt: ago(3),
      ...over,
    }) as PlacementTargetRecord;

  it("says the post's age and when it was found, and 'date unknown' rather than nothing", () => {
    expect(rowMeta(target(), NOW)).toBe("Reddit · r/SEO · 3h · found 3d ago");
    expect(rowMeta(target({ postedAt: null }), NOW)).toBe("Reddit · r/SEO · date unknown · found 3d ago");
    expect(rowMeta(target({ foundAt: ago(10), createdAt: ago(10) }), NOW)).toBe("Reddit · r/SEO · 3h · found Nov 2");
    // A post the person added: their own moment, no "found".
    expect(rowMeta(target({ foundVia: "manual", qualifiedBy: "person" }), NOW)).toBe("Reddit · r/SEO · 3h");
  });

  it("says both in full on the open item", () => {
    expect(rowMeta(target({ surface: "github", kind: "issue", community: "acme/tool", postedAt: ago(61), postedAtPrecision: "month", foundAt: "2026-11-10T09:00:00Z" }), NOW, { full: true })).toBe(
      "GitHub · acme/tool · posted at least 2 months ago · found Nov 10"
    );
    expect(postedPhrase(null, null, NOW)).toBe("date unknown");
    expect(postedPhrase(ago(0.125), null, NOW)).toBe("posted 3h ago");
    expect(postedPhrase(ago(0.2), "day", NOW)).toBe("posted today");
    expect(postedPhrase(ago(10), null, NOW)).toBe("posted Nov 2");
    expect(foundLabel(ago(0.01), NOW)).toBe("found 14m ago");
    expect(foundDay("2026-11-10T09:00:00Z")).toBe("found Nov 10");
    expect(foundDay(null)).toBe("");
  });
});
