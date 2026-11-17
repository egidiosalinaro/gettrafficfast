import { describe, expect, it } from "vitest";
import {
  INBOX_VIEWS,
  addedToast,
  groupOf,
  inView,
  isExpired,
  isMine,
  isSnoozed,
  leftToast,
  nextOpenId,
  orderInbox,
  stepOpenId,
  viewCounts,
  viewLabel,
  viewStatus,
  type ViewRow,
} from "@/lib/placements/inbox-view";
import { dayIn, postedToday, safeTimeZone, todayDots, todayLabel } from "@/lib/placements/today";
import { VoiceSettings, parseVoiceSettings } from "@/lib/voice/settings";

/**
 * The lists of the Replies page (2026-11-10): one control narrows the
 * inbox, each list is a status the server filters on plus a rule, and the
 * same rule counts it. A reply marked as posted leaves "To reply" at once.
 */

const NOW = Date.parse("2026-11-10T09:30:00Z");
const hours = (h: number) => new Date(NOW + h * 3600_000).toISOString();

const row = (over: Partial<ViewRow> = {}): ViewRow => ({
  status: "qualified",
  foundVia: "reddit",
  qualifiedBy: "agent",
  freshUntil: null,
  snoozedUntil: null,
  publishedUrl: null,
  removedAt: null,
  ...over,
});

describe("the lists", () => {
  it("names every list in the person's words, and none is called Approved or by a raw status", () => {
    const labels = INBOX_VIEWS.map((view) => view.label);
    expect(labels).toEqual([
      "To reply",
      "Posted, no link",
      "Posted",
      "Removed",
      "Snoozed",
      "Expired",
      "Cited by AI (sampled)",
      "Not sorted yet",
      "Filtered out",
      "Skipped",
      "Archive",
      "All",
    ]);
    expect(labels.join(" ")).not.toMatch(/Approved|To review|Ready to draft|needs_review|Found, not judged/);
    expect(viewLabel("posted_no_link")).toBe("Posted, no link");
  });

  it("asks the server for a status it always took: no new status, no new parameter value", () => {
    expect(viewStatus("to_reply")).toBe("open");
    expect(viewStatus("snoozed")).toBe("open");
    expect(viewStatus("expired")).toBe("open");
    expect(viewStatus("ai_cited")).toBe("open");
    expect(viewStatus("posted_no_link")).toBe("published_manually");
    expect(viewStatus("removed")).toBe("published_manually");
    expect(viewStatus("dismissed")).toBe("dismissed");
    expect(viewStatus("all")).toBe("all");
  });

  it("keeps To reply to what can be answered now: open, not snoozed, not expired", () => {
    expect(inView(row(), "to_reply", NOW)).toBe(true);
    expect(inView(row({ status: "drafted" }), "to_reply", NOW)).toBe(true);
    expect(inView(row({ status: "approved" }), "to_reply", NOW)).toBe(true);
    expect(inView(row({ snoozedUntil: hours(24) }), "to_reply", NOW)).toBe(false);
    expect(inView(row({ freshUntil: hours(-1) }), "to_reply", NOW)).toBe(false);
    expect(inView(row({ status: "published_manually" }), "to_reply", NOW)).toBe(false);
    expect(inView(row({ status: "dismissed" }), "to_reply", NOW)).toBe(false);
  });

  it("splits the posted replies: no link, all that are up, removed", () => {
    const noLink = row({ status: "published_manually" });
    const linked = row({ status: "published_manually", publishedUrl: "https://x.com/me/status/1" });
    const removed = row({ status: "published_manually", removedAt: hours(-5) });
    expect([noLink, linked, removed].map((r) => inView(r, "posted_no_link", NOW))).toEqual([true, false, false]);
    expect([noLink, linked, removed].map((r) => inView(r, "posted", NOW))).toEqual([true, true, false]);
    expect([noLink, linked, removed].map((r) => inView(r, "removed", NOW))).toEqual([false, false, true]);
  });

  it("reads a plain status list as itself, All as everything, and Cited by AI off the sighting", () => {
    expect(inView(row({ status: "rejected" }), "rejected", NOW)).toBe(true);
    expect(inView(row({ status: "rejected" }), "dismissed", NOW)).toBe(false);
    expect(inView(row({ status: "discovered" }), "discovered", NOW)).toBe(true);
    expect(inView(row({ status: "rejected" }), "all", NOW)).toBe(true);
    expect(inView(row({ aiCitation: { promptCount: 1 } }), "ai_cited", NOW)).toBe(true);
    expect(inView(row(), "ai_cited", NOW)).toBe(false);
    expect(inView(row({ status: "dismissed", aiCitation: {} }), "ai_cited", NOW)).toBe(false);
  });

  it("counts each list by the rule the page shows it with, and zero is a count", () => {
    const counts = viewCounts(
      [
        row(),
        row({ status: "drafted", foundVia: "manual", qualifiedBy: "person" }),
        row({ freshUntil: hours(-48) }),
        row({ snoozedUntil: hours(48) }),
        row({ status: "published_manually" }),
        row({ status: "published_manually", publishedUrl: "https://x.com/me/status/1" }),
        row({ status: "published_manually", removedAt: hours(-1) }),
        row({ status: "dismissed" }),
      ],
      NOW
    );
    expect(counts).toMatchObject({
      to_reply: 2,
      expired: 1,
      snoozed: 1,
      posted_no_link: 1,
      posted: 2,
      removed: 1,
      dismissed: 1,
      rejected: 0,
      discovered: 0,
      all: 8,
    });
  });
});

describe("expiry of found threads", () => {
  it("is a display rule: a found thread past its freshness window leaves To reply for Expired, its status untouched", () => {
    const stale = row({ status: "drafted", freshUntil: hours(-1) });
    expect(isExpired(stale, NOW)).toBe(true);
    expect(inView(stale, "expired", NOW)).toBe(true);
    expect(stale.status).toBe("drafted");
    expect(isExpired(row({ freshUntil: hours(1) }), NOW)).toBe(false);
    expect(isExpired(row({ freshUntil: null }), NOW)).toBe(false);
    expect(isExpired(row({ freshUntil: "not a date" }), NOW)).toBe(false);
  });

  it("never expires a post the person chose, a closed row, or a snoozed one", () => {
    expect(isExpired(row({ foundVia: "manual", freshUntil: hours(-99) }), NOW)).toBe(false);
    expect(isExpired(row({ qualifiedBy: "person", freshUntil: hours(-99) }), NOW)).toBe(false);
    expect(isExpired(row({ status: "published_manually", freshUntil: hours(-99) }), NOW)).toBe(false);
    expect(isExpired(row({ status: "dismissed", freshUntil: hours(-99) }), NOW)).toBe(false);
    const both = row({ freshUntil: hours(-99), snoozedUntil: hours(24) });
    expect(isExpired(both, NOW)).toBe(false);
    expect(isSnoozed(both, NOW)).toBe(true);
    expect(isSnoozed(row({ snoozedUntil: hours(-1) }), NOW)).toBe(false);
  });
});

describe("Yours and Found for you", () => {
  it("calls a post yours when it was pasted by hand, or judged by the person", () => {
    expect(isMine({ foundVia: "manual", qualifiedBy: "person" })).toBe(true);
    expect(isMine({ foundVia: "reddit", qualifiedBy: "person" })).toBe(true);
    expect(isMine({ foundVia: "reddit", qualifiedBy: "agent" })).toBe(false);
    expect(isMine({ foundVia: "ai_visibility", qualifiedBy: "ai_visibility" })).toBe(false);
    expect(groupOf({ foundVia: "manual", qualifiedBy: null })).toBe("yours");
    expect(groupOf({ foundVia: null, qualifiedBy: null })).toBe("found");
  });

  it("orders the inbox on the server: yours first and newest first, then found newest first, score within the same instant", () => {
    const rows = [
      { id: "found-low", ...row(), qualifyScore: 60, postedAt: hours(-1) },
      { id: "mine-old", ...row({ foundVia: "manual", qualifiedBy: "person" }), qualifiedAt: hours(-9), qualifyScore: null },
      { id: "found-high-old", ...row(), qualifyScore: 90, postedAt: hours(-50) },
      { id: "mine-new", ...row({ foundVia: "manual", qualifiedBy: "person" }), qualifiedAt: hours(-1), qualifyScore: null },
      { id: "found-high-new", ...row(), qualifyScore: 90, postedAt: hours(-2) },
      { id: "found-unscored", ...row({ foundVia: "ai_visibility" }), qualifyScore: null, postedAt: hours(-1) },
    ];
    // Since 2026-11-12 "Found for you" is newest post first: the post from an
    // hour ago is above the 50-hour-old one, whatever their scores.
    expect(orderInbox(rows).map((r) => r.id)).toEqual(["mine-new", "mine-old", "found-low", "found-unscored", "found-high-new", "found-high-old"]);
    // The same rows in another order come out the same: a reload keeps the list.
    expect(orderInbox([...rows].reverse()).map((r) => r.id)).toEqual(orderInbox(rows).map((r) => r.id));
  });

  it("orders posted replies by when they were posted, newest first", () => {
    const rows = [
      { id: "a", ...row({ status: "published_manually" }), publishedAt: hours(-30) },
      { id: "b", ...row({ status: "published_manually", foundVia: "manual" }), publishedAt: hours(-2) },
      { id: "c", ...row({ status: "published_manually" }), publishedAt: null },
    ];
    expect(orderInbox(rows).map((r) => r.id)).toEqual(["b", "a", "c"]);
  });
});

describe("one open item", () => {
  it("opens the next one when the open item leaves, the one before at the end, nothing when it was the last", () => {
    expect(nextOpenId(["a", "b", "c"], "a")).toBe("b");
    expect(nextOpenId(["a", "b", "c"], "b")).toBe("c");
    expect(nextOpenId(["a", "b", "c"], "c")).toBe("b");
    expect(nextOpenId(["a"], "a")).toBeNull();
    expect(nextOpenId(["a", "b"], "gone")).toBe("a");
    expect(nextOpenId([], "gone")).toBeNull();
  });

  it("steps with J and K and stays at the ends", () => {
    expect(stepOpenId(["a", "b", "c"], "a", 1)).toBe("b");
    expect(stepOpenId(["a", "b", "c"], "c", 1)).toBe("c");
    expect(stepOpenId(["a", "b", "c"], "a", -1)).toBe("a");
    expect(stepOpenId(["a", "b", "c"], null, 1)).toBe("a");
    expect(stepOpenId([], "a", 1)).toBeNull();
  });

  it("says in a toast what happened to an item that left, with Undo where there is a way back", () => {
    expect(leftToast("mark_published")).toEqual({ text: "Posted.", action: { label: "Undo" } });
    expect(leftToast("dismiss")).toEqual({ text: "Skipped.", action: { label: "Undo" } });
    expect(leftToast("snooze")).toEqual({ text: "Snoozed for a week." });
    expect(leftToast("set_published_url")).toEqual({ text: "Link saved." });
    expect(addedToast("created", "x", true).text).toBe("Post added. Writing the reply.");
    expect(addedToast("published", "stored", false).text).toContain("already posted");
    expect(addedToast("created", "pasted", false).text).toContain("the text you pasted");
  });
});

describe("the daily count", () => {
  const posted = (at: string, over: Record<string, unknown> = {}) => ({ status: "published_manually", published_at: at, ...over });

  it("counts the replies marked as posted today in the caller's zone, removed ones aside", () => {
    const now = new Date("2026-11-10T09:30:00Z");
    const rows = [
      posted("2026-11-10T08:00:00Z"),
      posted("2026-11-10T00:10:00Z"),
      posted("2026-11-09T23:50:00Z"),
      posted("2026-11-10T07:00:00Z", { removed_at: "2026-11-10T08:00:00Z" }),
      { status: "drafted", published_at: null },
    ];
    expect(postedToday(rows, now, "UTC")).toBe(2);
    // 23:50 UTC on the 9th is already the 10th in Berlin.
    expect(postedToday(rows, now, "Europe/Berlin")).toBe(3);
    // In Los Angeles it is still the 10th at 01:30, and 00:10 UTC was the 9th there.
    expect(postedToday(rows, new Date("2026-11-10T09:30:00Z"), "America/Los_Angeles")).toBe(1);
    expect(postedToday([], now, "UTC")).toBe(0);
  });

  it("uses the zone it is given when the runtime knows it, else UTC, and says the day in that zone", () => {
    expect(safeTimeZone("Europe/Berlin")).toBe("Europe/Berlin");
    expect(safeTimeZone("Not/AZone")).toBe("UTC");
    expect(safeTimeZone("")).toBe("UTC");
    expect(safeTimeZone(null)).toBe("UTC");
    expect(dayIn("2026-11-09T23:50:00Z", "Europe/Berlin")).toBe("2026-11-10");
    expect(dayIn("2026-11-09T23:50:00Z", "UTC")).toBe("2026-11-09");
    expect(dayIn(null, "UTC")).toBeNull();
  });

  it("shows N of G with dots only when a goal is stored, and a plain N today otherwise", () => {
    expect(todayLabel({ posted: 2, goal: 5 })).toBe("2 of 5 today");
    expect(todayDots({ posted: 2, goal: 5 })).toEqual([true, true, false, false, false]);
    expect(todayLabel({ posted: 2, goal: null })).toBe("2 today");
    expect(todayDots({ posted: 2, goal: null })).toEqual([]);
    expect(todayLabel({ posted: 0, goal: null })).toBe("0 today");
    // Past the goal the count keeps counting; the dots stay full.
    expect(todayLabel({ posted: 7, goal: 5 })).toBe("7 of 5 today");
    expect(todayDots({ posted: 7, goal: 5 })).toEqual([true, true, true, true, true]);
    expect(todayDots({ posted: 3, goal: 30 })).toEqual([]);
  });

  it("stores the goal with the reply settings, unset by default and never invented", () => {
    expect(parseVoiceSettings({}).dailyReplyGoal).toBeNull();
    expect(parseVoiceSettings({ preset: "plain" }).dailyReplyGoal).toBeNull();
    expect(parseVoiceSettings({ dailyReplyGoal: 5 }).dailyReplyGoal).toBe(5);
    expect(VoiceSettings.safeParse({ dailyReplyGoal: 0 }).success).toBe(false);
    expect(VoiceSettings.safeParse({ dailyReplyGoal: 2.5 }).success).toBe(false);
    expect(VoiceSettings.safeParse({ dailyReplyGoal: 500 }).success).toBe(false);
    expect(VoiceSettings.safeParse({ dailyReplyGoal: null }).success).toBe(true);
  });
});
