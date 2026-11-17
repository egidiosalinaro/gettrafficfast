import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Article, ArticleStatus } from "@/components/dashboard/article-card";
import {
  articleDateLine,
  calendarList,
  calendarMonths,
  dayHeading,
} from "@/components/dashboard/calendar-model";
import { pluralize } from "@/lib/utils";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

/**
 * What the Articles board draws, as data. The month range follows the work
 * (not a fixed six months from today), empty months collapse instead of
 * drawing blank grids, and the phone list puts what is coming first.
 */

// 9 November 2026, local noon.
const TODAY = new Date(2026, 10, 9, 12);

let sequence = 0;
function article(status: ArticleStatus, scheduledDate: string, keyword = `kw-${scheduledDate}`): Article {
  sequence += 1;
  return { id: `a-${sequence}`, keyword, status, scheduledDate };
}

describe("calendarMonths", () => {
  it("starts at the oldest recent publication, not at this month", () => {
    const blocks = calendarMonths(
      [article("published", "2026-10-20"), article("queued", "2026-11-12")],
      TODAY
    );
    expect(blocks).toEqual([
      { kind: "month", year: 2026, month: 9, count: 1, current: false },
      { kind: "month", year: 2026, month: 10, count: 1, current: true },
    ]);
  });

  it("does not reach back for a publication older than 30 days", () => {
    const blocks = calendarMonths(
      [article("published", "2026-08-01"), article("queued", "2026-11-12")],
      TODAY
    );
    expect(blocks.map((b) => b.kind === "month" && [b.year, b.month])).toEqual([[2026, 10]]);
  });

  it("starts at the oldest unpublished article, however old", () => {
    const blocks = calendarMonths(
      [article("failed", "2026-08-15"), article("needs_review", "2026-11-01")],
      TODAY
    );
    expect(blocks[0]).toMatchObject({ kind: "month", year: 2026, month: 7, count: 1 });
    // September and October had nothing: one collapsed line, not two grids.
    expect(blocks[1]).toEqual({
      kind: "empty",
      from: { year: 2026, month: 8 },
      to: { year: 2026, month: 9 },
    });
    expect(blocks[2]).toMatchObject({ kind: "month", month: 10, current: true });
    expect(blocks).toHaveLength(3);
  });

  it("collapses empty months ahead and ends at the last article", () => {
    const blocks = calendarMonths(
      [article("queued", "2026-11-20"), article("queued", "2027-03-02")],
      TODAY
    );
    expect(blocks).toEqual([
      { kind: "month", year: 2026, month: 10, count: 1, current: true },
      { kind: "empty", from: { year: 2026, month: 11 }, to: { year: 2027, month: 1 } },
      { kind: "month", year: 2027, month: 2, count: 1, current: false },
    ]);
  });

  it("always draws this month, so today is on screen and a card has somewhere to land", () => {
    expect(calendarMonths([], TODAY)).toEqual([
      { kind: "month", year: 2026, month: 10, count: 0, current: true },
    ]);
    const onlyLater = calendarMonths([article("queued", "2027-01-05")], TODAY);
    expect(onlyLater[0]).toMatchObject({ kind: "month", month: 10, count: 0, current: true });
    expect(onlyLater[1]).toMatchObject({ kind: "empty" });
    expect(onlyLater[2]).toMatchObject({ kind: "month", year: 2027, month: 0, count: 1 });
  });
});

describe("calendarList", () => {
  it("lists upcoming work first, oldest day first, then recent publications newest first", () => {
    const later = article("queued", "2026-11-14", "later");
    const sooner = article("generated", "2026-11-10", "sooner");
    const overdue = article("failed", "2026-11-02", "overdue");
    const recent = article("published", "2026-11-05", "recent");
    const older = article("published", "2026-10-15", "older");
    const archived = article("published", "2026-09-01", "archived");

    const { upcoming, published } = calendarList(
      [later, recent, archived, sooner, older, overdue],
      TODAY
    );
    expect(upcoming.map((g) => g.day)).toEqual(["2026-11-02", "2026-11-10", "2026-11-14"]);
    expect(upcoming.flatMap((g) => g.articles.map((a) => a.keyword))).toEqual([
      "overdue",
      "sooner",
      "later",
    ]);
    expect(published.flatMap((g) => g.articles.map((a) => a.keyword))).toEqual(["recent", "older"]);
  });

  it("groups articles that share a day", () => {
    const { upcoming } = calendarList(
      [article("queued", "2026-11-12", "one"), article("queued", "2026-11-12", "two")],
      TODAY
    );
    expect(upcoming).toHaveLength(1);
    expect(upcoming[0].articles.map((a) => a.keyword)).toEqual(["one", "two"]);
  });
});

describe("dates as a person reads them", () => {
  it("says when a published article went out, not when it was scheduled", () => {
    expect(articleDateLine(article("published", "2026-11-02"), TODAY, "en-GB")).toBe("Published 2 Nov");
    expect(articleDateLine(article("published", "2026-11-02"), TODAY, "en-US")).toBe("Published Nov 2");
  });

  it("does not claim a future publication date for an article published early", () => {
    expect(articleDateLine(article("published", "2026-11-20"), TODAY, "en-GB")).toBe(
      "Published early, was scheduled for 20 Nov"
    );
  });

  it("keeps everything else as scheduled, with the year only when it is not this one", () => {
    expect(articleDateLine(article("queued", "2026-11-12"), TODAY, "en-GB")).toBe("Scheduled for 12 Nov");
    expect(articleDateLine(article("queued", "2027-01-04"), TODAY, "en-GB")).toBe("Scheduled for 4 Jan 2027");
    expect(articleDateLine({ status: "queued", scheduledDate: undefined }, TODAY)).toBe("Not scheduled");
  });

  it("heads list days as today, tomorrow, or a weekday and date", () => {
    expect(dayHeading("2026-11-09", TODAY)).toBe("Today");
    expect(dayHeading("2026-11-10", TODAY)).toBe("Tomorrow");
    expect(dayHeading("2026-11-08", TODAY)).toBe("Yesterday");
    expect(dayHeading("2026-11-12", TODAY, "en-GB")).toBe("Thu 12 Nov");
  });

  it("is in English when no locale is given, whatever the device's", () => {
    expect(dayHeading("2026-11-12", TODAY)).toBe("Thu, Nov 12");
    expect(articleDateLine(article("published", "2026-11-02"), TODAY)).toBe("Published Nov 2");
    expect(articleDateLine(article("queued", "2027-01-04"), TODAY)).toBe("Scheduled for Jan 4, 2027");
  });
});

describe("the month heading count", () => {
  it("counts in the singular for one, through the shared pluralize", () => {
    expect(pluralize(1, "article")).toBe("1 article");
    expect(pluralize(0, "article")).toBe("0 articles");
    expect(pluralize(3, "article")).toBe("3 articles");
  });

  it("leaves no hand-rolled plural on the board", () => {
    const calendar = readFileSync(path.join(root, "components/dashboard/calendar.tsx"), "utf8");
    expect(calendar).toContain('pluralize(month.count, "article")');
    expect(calendar).not.toMatch(/\{\w+\} articles/);
  });
});
