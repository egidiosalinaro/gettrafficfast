import { describe, expect, it } from "vitest";
import {
  INBOX_VIEWS,
  TODAY_VIEWS,
  archiveReason,
  inView,
  isTodayViewId,
  leftToast,
  todayViewCounts,
  todayViewList,
  viewCounts,
  viewStatus,
  type ViewRow,
} from "@/lib/placements/inbox-view";
import { archiveIds, viewRowOf } from "@/lib/placements/read";

/**
 * Today's three tabs (2026-11-14): To do, Posted, Archive, in place of the
 * eleven lists of the filter menu. Each tab is one of the API's lists, so its
 * rows and its count come from one rule; the API keeps every list it had.
 */

const NOW = Date.parse("2026-11-14T09:30:00Z");
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

describe("the three tabs", () => {
  it("are To do, Posted and Archive, each one of the API's lists", () => {
    expect(TODAY_VIEWS.map((v) => v.label)).toEqual(["To do", "Posted", "Archive"]);
    expect(TODAY_VIEWS.map((v) => todayViewList(v.id))).toEqual(["to_reply", "posted", "archive"]);
    const ids = INBOX_VIEWS.map((v) => v.id as string);
    for (const view of TODAY_VIEWS) expect(ids).toContain(view.view);
    expect(isTodayViewId("archive")).toBe(true);
    expect(isTodayViewId("snoozed")).toBe(false);
    expect(isTodayViewId(null)).toBe(false);
  });

  it("keeps every list for the API, and asks the route for the Archive by its own status", () => {
    expect(INBOX_VIEWS.map((v) => v.id)).toEqual(
      expect.arrayContaining(["to_reply", "posted_no_link", "posted", "removed", "snoozed", "expired", "ai_cited", "discovered", "rejected", "dismissed", "all"])
    );
    expect(viewStatus("archive")).toBe("archive");
    expect(viewStatus("to_reply")).toBe("open");
    expect(viewStatus("posted")).toBe("published_manually");
  });

  it("puts what is open now in To do, a snooze that ran out included, and never what is not sorted yet", () => {
    expect(inView(row(), "to_reply", NOW)).toBe(true);
    expect(inView(row({ snoozedUntil: hours(-1) }), "to_reply", NOW)).toBe(true);
    expect(inView(row({ snoozedUntil: hours(24) }), "to_reply", NOW)).toBe(false);
    const sorting = row({ status: "discovered" });
    expect(TODAY_VIEWS.some((v) => inView(sorting, v.view, NOW))).toBe(false);
  });

  it("puts a posted reply under Posted, a missing link included, and a removed one in the Archive", () => {
    const noLink = row({ status: "published_manually" });
    const removed = row({ status: "published_manually", removedAt: hours(-2) });
    expect(inView(noLink, "posted", NOW)).toBe(true);
    expect(inView(noLink, "archive", NOW)).toBe(false);
    expect(inView(removed, "posted", NOW)).toBe(false);
    expect(inView(removed, "archive", NOW)).toBe(true);
  });

  it("labels each archived row with why: skipped, filtered out, expired, removed", () => {
    expect(archiveReason(row({ status: "dismissed" }), NOW)).toBe("Skipped");
    expect(archiveReason(row({ status: "rejected" }), NOW)).toBe("Filtered out");
    expect(archiveReason(row({ freshUntil: hours(-48) }), NOW)).toBe("Expired");
    expect(archiveReason(row({ status: "published_manually", removedAt: hours(-1) }), NOW)).toBe("Removed");
    // Open and fresh, posted and up, snoozed, not sorted yet: not archived.
    expect(archiveReason(row(), NOW)).toBeNull();
    expect(archiveReason(row({ status: "published_manually" }), NOW)).toBeNull();
    expect(archiveReason(row({ snoozedUntil: hours(24), freshUntil: hours(-48) }), NOW)).toBeNull();
    expect(archiveReason(row({ status: "discovered" }), NOW)).toBeNull();
    // A post the person chose never expires.
    expect(archiveReason(row({ freshUntil: hours(-48), foundVia: "manual" }), NOW)).toBeNull();
  });

  it("counts each tab by the rule it shows, with no row in two tabs", () => {
    const rows = [
      row(),
      row({ status: "drafted", foundVia: "manual", qualifiedBy: "person" }),
      row({ freshUntil: hours(-48) }),
      row({ snoozedUntil: hours(48) }),
      row({ status: "published_manually" }),
      row({ status: "published_manually", publishedUrl: "https://x.com/me/status/1" }),
      row({ status: "published_manually", removedAt: hours(-1) }),
      row({ status: "dismissed" }),
      row({ status: "rejected" }),
      row({ status: "discovered" }),
    ];
    expect(todayViewCounts(viewCounts(rows, NOW))).toEqual({ todo: 2, posted: 2, archive: 4 });
    for (const r of rows) expect(TODAY_VIEWS.filter((v) => inView(r, v.view, NOW)).length).toBeLessThanOrEqual(1);
    // Unknown counts read as 0 only where a count was given: the mapping invents none.
    expect(todayViewCounts({})).toEqual({ todo: 0, posted: 0, archive: 0 });
  });

  it("says Back in To do when a skipped post comes back", () => {
    expect(leftToast("reopen")).toEqual({ text: "Back in To do." });
  });
});

describe("the Archive's rows", () => {
  const countRow = (id: string, over: Record<string, unknown>) => ({
    id,
    status: "qualified",
    surface: "reddit",
    kind: "thread",
    found_via: "reddit",
    qualified_by: "agent",
    fresh_until: null,
    snoozed_until: null,
    posted_at: null,
    published_url: null,
    created_at: "2026-11-13T00:00:00Z",
    ...over,
  });

  it("are picked from every row by the Archive's rule, newest found first, up to the cap", () => {
    const rows = [
      countRow("open", {}),
      countRow("skipped-old", { status: "dismissed", created_at: "2026-10-01T00:00:00Z" }),
      countRow("filtered", { status: "rejected", created_at: "2026-11-12T00:00:00Z" }),
      countRow("expired", { fresh_until: "2026-11-10T00:00:00Z", created_at: "2026-11-05T00:00:00Z" }),
      countRow("removed", { status: "published_manually", removed_at: "2026-11-13T10:00:00Z", created_at: "2026-11-11T00:00:00Z" }),
      countRow("posted", { status: "published_manually", removed_at: null }),
    ];
    expect(archiveIds(rows, null, NOW, 200)).toEqual(["filtered", "removed", "expired", "skipped-old"]);
    expect(archiveIds(rows, null, NOW, 2)).toEqual(["filtered", "removed"]);
  });

  it("reads a count row the way the counts do, the sighting from the citations read apart", () => {
    const view = viewRowOf(countRow("a", { removed_at: "2026-11-13T10:00:00Z" }), new Map([["a", { prompts: [] } as never]]));
    expect(view).toMatchObject({ status: "qualified", surface: "reddit", removedAt: "2026-11-13T10:00:00Z" });
    expect(view.aiCitation).toBeTruthy();
    expect(viewRowOf(countRow("b", {}), null).aiCitation).toBeNull();
  });
});
