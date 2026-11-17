import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { DayCount } from "@/components/placements/queue";
import { TodaySheet, answeredLine, postedTime, type TodaySheetProps } from "@/components/placements/today-sheet";
import {
  postedToday,
  postedTodayRows,
  stepGoal,
  todayCountLine,
  todayReplies,
  todayWindowStart,
  type TodayReply,
  type TodayReplyDetail,
} from "@/lib/placements/today";
import { DAILY_REPLY_GOAL_MAX, VoiceSettingsChange } from "@/lib/voice/settings";

/**
 * "Today", behind "4 of 5 today" (2026-11-12): the replies posted today and
 * the goal, changed in place. Pinned: the list is the count's own rows
 * (removed and other days out, the zone respected), the sheet shows them or
 * says the day is empty, and the goal steps from 1 to the maximum or is
 * cleared.
 */

const NOW = new Date("2026-11-10T09:30:00Z");

const posted = (id: string, at: string, over: Record<string, unknown> = {}) => ({
  id,
  status: "published_manually",
  published_at: at,
  removed_at: null as string | null,
  ...over,
});

const detail = (over: Partial<TodayReplyDetail> = {}): TodayReplyDetail => ({
  surface: "x",
  author: "janedoe",
  community: "@janedoe",
  url: "https://x.com/janedoe/status/1855000000000000000",
  publishedAt: "2026-11-10T08:00:00Z",
  publishedUrl: null,
  publishedText: null,
  selectedPlacementId: null,
  ...over,
});

describe("today's list follows the count's rule", () => {
  const rows = [
    posted("a", "2026-11-10T08:00:00Z"),
    posted("b", "2026-11-10T07:00:00Z", { removed_at: "2026-11-10T08:00:00Z" }),
    posted("c", "2026-11-09T12:00:00Z"),
    posted("d", "2026-11-09T23:50:00Z"),
    { id: "e", status: "drafted", published_at: "2026-11-10T08:30:00Z", removed_at: null },
  ];

  it("keeps what is posted today, leaves out removed replies, other days and other statuses", () => {
    expect(postedTodayRows(rows, NOW, "UTC").map((r) => r.id)).toEqual(["a"]);
    expect(postedTodayRows(rows, NOW, "UTC")).toHaveLength(postedToday(rows, NOW, "UTC"));
  });

  it("reads today in the zone it is given", () => {
    // 23:50 UTC on the 9th is already the 10th in Berlin.
    expect(postedTodayRows(rows, NOW, "Europe/Berlin").map((r) => r.id)).toEqual(["a", "d"]);
    // At 01:30 in Los Angeles, 08:00 UTC is midnight today, and 23:50 UTC on the 9th was that afternoon.
    expect(postedTodayRows(rows, NOW, "America/Los_Angeles").map((r) => r.id)).toEqual(["a"]);
  });

  it("narrows a read to the last 27 hours, which holds today in every zone", () => {
    expect(todayWindowStart(NOW)).toBe("2026-11-09T06:30:00.000Z");
  });

  it("shows the reply's first line: read back from X, else the posted draft, else the first", () => {
    const details = new Map<string, TodayReplyDetail>([
      ["a", detail({ publishedText: "\nread back from X\nsecond line", publishedAt: "2026-11-10T08:00:00Z" })],
      ["b", detail({ selectedPlacementId: "d2", publishedAt: "2026-11-10T09:00:00Z" })],
      ["c", detail({ publishedAt: "2026-11-10T07:00:00Z" })],
      ["d", detail({ publishedAt: "2026-11-10T06:00:00Z" })],
    ]);
    const drafts = new Map([
      ["b", [{ id: "d1", body: "first draft" }, { id: "d2", body: "the one posted\nmore" }]],
      ["c", [{ id: "d3", body: "only draft" }]],
    ]);
    const metrics = new Map([
      ["a", { day: "2026-11-10", impressions: 40, likes: 2, replies: 0, reposts: null, quotes: null, bookmarks: null, fetchedAt: "x" }],
    ]);
    const list = todayReplies([{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }, { id: "missing" }], details, drafts, metrics);
    // Newest first; a row whose details were not read is left out, never invented.
    expect(list.map((r) => [r.id, r.text])).toEqual([
      ["b", "the one posted"],
      ["a", "read back from X"],
      ["c", "only draft"],
      ["d", null],
    ]);
    expect(list.find((r) => r.id === "a")?.metrics?.impressions).toBe(40);
    expect(list.find((r) => r.id === "b")?.metrics).toBeNull();
  });
});

describe("the goal", () => {
  it("steps from 1 to the maximum and never past either end; from no goal a step starts at 1", () => {
    expect(stepGoal(5, 1, DAILY_REPLY_GOAL_MAX)).toBe(6);
    expect(stepGoal(5, -1, DAILY_REPLY_GOAL_MAX)).toBe(4);
    expect(stepGoal(1, -1, DAILY_REPLY_GOAL_MAX)).toBe(1);
    expect(stepGoal(DAILY_REPLY_GOAL_MAX, 1, DAILY_REPLY_GOAL_MAX)).toBe(DAILY_REPLY_GOAL_MAX);
    expect(stepGoal(null, 1, DAILY_REPLY_GOAL_MAX)).toBe(1);
    expect(stepGoal(null, -1, DAILY_REPLY_GOAL_MAX)).toBe(1);
  });

  it("is sent as a partial change: the goal alone, or null for none, and nothing else is defaulted", () => {
    expect(VoiceSettingsChange.parse({ dailyReplyGoal: 6 })).toEqual({ dailyReplyGoal: 6 });
    expect(VoiceSettingsChange.parse({ dailyReplyGoal: null })).toEqual({ dailyReplyGoal: null });
    expect(VoiceSettingsChange.safeParse({ dailyReplyGoal: 0 }).success).toBe(false);
    expect(VoiceSettingsChange.safeParse({ dailyReplyGoal: DAILY_REPLY_GOAL_MAX + 1 }).success).toBe(false);
    expect(VoiceSettingsChange.safeParse({ somethingElse: 1 }).success).toBe(false);
  });

  it("says the count in the popup's words", () => {
    expect(todayCountLine({ posted: 4, goal: 5 })).toBe("4 of 5 replies posted");
    expect(todayCountLine({ posted: 1, goal: null })).toBe("1 reply posted");
    expect(todayCountLine({ posted: 0, goal: null })).toBe("0 replies posted");
    expect(todayCountLine({ posted: 0, goal: 1 })).toBe("0 of 1 reply posted");
  });
});

describe("the day count opens the Today sheet", () => {
  it("is a 44px button named Today's replies: N of G", () => {
    const html = renderToStaticMarkup(
      <DayCount today={{ posted: 4, goal: 5, timeZone: "Europe/Berlin" }} browserZone="Europe/Berlin" onOpen={() => {}} />
    );
    expect(html).toContain("<button");
    expect(html).toContain('aria-label="Today&#x27;s replies: 4 of 5"');
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain("min-h-11");
    expect(renderToStaticMarkup(<DayCount today={{ posted: 2, goal: null, timeZone: "UTC" }} browserZone="UTC" onOpen={() => {}} />)).toContain(
      'aria-label="Today&#x27;s replies: 2"'
    );
  });
});

const reply = (over: Partial<TodayReply> = {}): TodayReply => ({
  id: "r1",
  surface: "x",
  author: "janedoe",
  community: "@janedoe",
  url: "https://x.com/janedoe/status/1855000000000000000",
  text: "the part nobody measures is the follow-up",
  publishedAt: "2026-11-10T08:05:00Z",
  publishedUrl: null,
  metrics: null,
  ...over,
});

function sheet(over: Partial<TodaySheetProps> = {}) {
  return renderToStaticMarkup(
    <TodaySheet
      today={{ posted: 0, goal: 5, timeZone: "UTC", replies: [] }}
      utcFallback={false}
      now={NOW.getTime()}
      busyIds={new Set()}
      onClose={() => {}}
      onOpenReply={() => {}}
      onSaveLink={async () => null}
      onGoalChange={() => {}}
      saveGoal={async () => null}
      {...over}
    />
  );
}

describe("the Today sheet", () => {
  it("lists today's replies: who was answered, the first line, the time, the numbers, the link or Paste link", () => {
    const html = sheet({
      today: {
        posted: 2,
        goal: 5,
        timeZone: "Europe/Berlin",
        replies: [
          reply({
            id: "r1",
            publishedUrl: "https://x.com/owner/status/1855000000000000001",
            metrics: { day: "2026-11-10", impressions: 1234, likes: 8, replies: 2, reposts: null, quotes: null, bookmarks: null, fetchedAt: "x" },
          }),
          reply({ id: "r2", author: "maya_builds", community: "@maya_builds", text: "second one", publishedAt: "2026-11-10T07:00:00Z" }),
        ],
      },
    });
    expect(html).toContain('role="dialog"');
    expect(html).toContain(">Today<");
    expect(html).toContain("2 of 5 replies posted");
    expect(html).toContain("X · @janedoe · 9:05 AM");
    expect(html).toContain("“the part nobody measures is the follow-up”");
    expect(html).toContain("1.2k views · 8 likes · 2 replies · as of today");
    expect(html).toContain("Your reply ↗");
    expect(html).toContain('href="https://x.com/owner/status/1855000000000000001"');
    expect(html).toContain("@maya_builds");
    expect(html).toContain("Paste link");
    expect(html.match(/data-today-reply=/g)).toHaveLength(2);
    expect(html).not.toContain("Nothing posted yet today.");
  });

  it("says the day is empty, and says UTC when that is the zone used", () => {
    const html = sheet({ today: { posted: 0, goal: null, timeZone: "UTC", replies: [] }, utcFallback: true });
    expect(html).toContain("Nothing posted yet today.");
    expect(html).toContain("0 replies posted (UTC)");
  });

  it("does not call a day empty when its list could not be read", () => {
    const html = sheet({ today: { posted: 3, goal: null, timeZone: "UTC" } });
    expect(html).not.toContain("Nothing posted yet today.");
    expect(html).toContain("could not be read");
  });

  it("has a stepper held from 1 to the maximum, and No goal", () => {
    const at = (goal: number | null) => sheet({ today: { posted: 0, goal, timeZone: "UTC", replies: [] } });
    const disabled = (html: string, label: string) => {
      const tag = html.match(new RegExp(`<button[^>]*aria-label="${label}"[^>]*>`))?.[0] ?? "";
      expect(tag).not.toBe("");
      return tag.includes('disabled=""');
    };
    expect(disabled(at(1), "Lower the goal")).toBe(true);
    expect(disabled(at(1), "Raise the goal")).toBe(false);
    expect(disabled(at(DAILY_REPLY_GOAL_MAX), "Raise the goal")).toBe(true);
    expect(disabled(at(5), "Lower the goal")).toBe(false);
    const none = at(null);
    expect(disabled(none, "Lower the goal")).toBe(true);
    expect(none).toContain('aria-pressed="true"');
    expect(none).toContain("No goal");
    expect(at(5)).toContain('aria-pressed="false"');
    expect(none.match(/h-11 w-11/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("names the platform and the author as stored", () => {
    expect(answeredLine({ surface: "reddit", author: "u/throwaway", community: "r/seo" })).toBe("Reddit · u/throwaway");
    expect(answeredLine({ surface: "x", author: null, community: null })).toBe("X");
    expect(postedTime("2026-11-10T08:05:00Z", "America/Los_Angeles")).toBe("12:05 AM");
  });
});
