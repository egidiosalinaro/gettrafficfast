import { describe, expect, it } from "vitest";
import {
  dedupeAgainstKnown,
  freshSuggestions,
  keywordScore,
  keywordsToGenerate,
  planSchedule,
  withoutOverlapping,
} from "@/lib/automation/autopilot";
import type { TopicIntent } from "@/lib/keywords/intent";
import type { SiteTopics } from "@/lib/keywords/overlap";
import { parseAutomationSettings } from "@/lib/automation/settings";

/**
 * Autopilot spends money and publishes on a customer's own site without anyone
 * watching. Its contract is therefore about restraint: never the past, never a
 * day twice, never more than the caps, and never on unless someone said so.
 */

const TODAY = new Date("2026-08-28T09:00:00Z");
const kw = (id: string, score: number) => ({ id, score });

describe("planSchedule", () => {
  it("fills the empty days from tomorrow, best keyword first", () => {
    const plan = planSchedule({
      today: TODAY,
      bufferDays: 3,
      occupiedDates: [],
      available: [kw("low", 1), kw("high", 9), kw("mid", 5)],
      maxPerRun: 10,
    });

    expect(plan).toEqual([
      { keywordId: "high", scheduledDate: "2026-08-29" },
      { keywordId: "mid", scheduledDate: "2026-08-30" },
      { keywordId: "low", scheduledDate: "2026-08-31" },
    ]);
  });

  it("never schedules today or the past", () => {
    // The generation cron has already run for today: an article placed there
    // would sit unproduced forever.
    const plan = planSchedule({
      today: TODAY,
      bufferDays: 2,
      occupiedDates: [],
      available: [kw("a", 1), kw("b", 1)],
      maxPerRun: 10,
    });
    expect(plan.every((p) => p.scheduledDate > "2026-08-28")).toBe(true);
  });

  it("is idempotent: a second run the same day schedules nothing new", () => {
    const first = planSchedule({
      today: TODAY,
      bufferDays: 3,
      occupiedDates: [],
      available: [kw("a", 3), kw("b", 2), kw("c", 1)],
      maxPerRun: 10,
    });
    const second = planSchedule({
      today: TODAY,
      bufferDays: 3,
      occupiedDates: first.map((p) => p.scheduledDate),
      available: [kw("d", 3)],
      maxPerRun: 10,
    });
    expect(second).toEqual([]);
  });

  it("works around days that already have an article", () => {
    const plan = planSchedule({
      today: TODAY,
      bufferDays: 3,
      occupiedDates: ["2026-08-30"],
      available: [kw("a", 2), kw("b", 1)],
      maxPerRun: 10,
    });
    expect(plan.map((p) => p.scheduledDate)).toEqual(["2026-08-29", "2026-08-31"]);
  });

  it("stops at the cap even with a long buffer and plenty of keywords", () => {
    const plan = planSchedule({
      today: TODAY,
      bufferDays: 60,
      occupiedDates: [],
      available: Array.from({ length: 40 }, (_, i) => kw(`k${i}`, i)),
      maxPerRun: 5,
    });
    expect(plan).toHaveLength(5);
  });

  it("schedules nothing when there are no keywords left", () => {
    expect(
      planSchedule({
        today: TODAY,
        bufferDays: 14,
        occupiedDates: [],
        available: [],
        maxPerRun: 10,
      })
    ).toEqual([]);
  });

  it("a second pass with newly bought keywords fills days the first pass left empty", () => {
    // The cron schedules, then (only if the pool is below the floor) generates,
    // then calls planSchedule again. An empty pool used to wait until tomorrow.
    const first = planSchedule({
      today: TODAY,
      bufferDays: 3,
      occupiedDates: [],
      available: [],
      maxPerRun: 10,
    });
    expect(first).toEqual([]);
    const second = planSchedule({
      today: TODAY,
      bufferDays: 3,
      occupiedDates: first.map((p) => p.scheduledDate),
      available: [kw("a", 1), kw("b", 1), kw("c", 1)],
      maxPerRun: 10,
    });
    expect(second.map((p) => p.scheduledDate)).toEqual([
      "2026-08-29",
      "2026-08-30",
      "2026-08-31",
    ]);
  });
});

describe("keywordScore", () => {
  it("puts opportunity above ease, and ease above volume", () => {
    const highOpportunityHardKeyword = keywordScore({ opportunity: "High", difficulty: 90 });
    const lowOpportunityEasyKeyword = keywordScore({ opportunity: "Low", difficulty: 10 });
    expect(highOpportunityHardKeyword).toBeGreaterThan(lowOpportunityEasyKeyword);

    const easy = keywordScore({ opportunity: "Medium", difficulty: 20 });
    const hard = keywordScore({ opportunity: "Medium", difficulty: 80 });
    expect(easy).toBeGreaterThan(hard);
  });

  it("survives rows with nothing filled in", () => {
    expect(Number.isFinite(keywordScore({}))).toBe(true);
  });
});

describe("keywordsToGenerate", () => {
  it("generates nothing while the pool is healthy", () => {
    expect(keywordsToGenerate({ availableCount: 12, floor: 10, maxPerRun: 10 })).toBe(0);
  });

  it("tops up to the floor and no further", () => {
    // Not "one per day forever": someone away for a month must not come back
    // to thirty keywords nobody asked for.
    expect(keywordsToGenerate({ availableCount: 4, floor: 10, maxPerRun: 10 })).toBe(6);
  });

  it("never exceeds the per-run cap", () => {
    expect(keywordsToGenerate({ availableCount: 0, floor: 100, maxPerRun: 10 })).toBe(10);
  });
});

describe("dedupeAgainstKnown", () => {
  it("drops what the customer already has, ignoring case and spacing", () => {
    const fresh = dedupeAgainstKnown(
      [{ keyword: "  Cast Iron Care " }, { keyword: "seasoning oil" }],
      ["cast iron care"]
    );
    expect(fresh).toEqual([{ keyword: "seasoning oil" }]);
  });

  it("drops duplicates inside the same batch", () => {
    const fresh = dedupeAgainstKnown([{ keyword: "a" }, { keyword: "A" }], []);
    expect(fresh).toHaveLength(1);
  });
});

describe("Autopilot and near-duplicate topics", () => {
  const topics: SiteTopics = {
    keywords: [
      { id: "k-live", keyword: "abandoned cart email", status: "published", articleId: "a-live", serpUrls: null },
      { id: "k-dup", keyword: "abandoned cart emails", status: "available", articleId: null, serpUrls: null },
      { id: "k-push", keyword: "web push notifications for online store", status: "available", articleId: null, serpUrls: null },
      { id: "k-push2", keyword: "web push notifications for online stores", status: "available", articleId: null, serpUrls: null },
      { id: "k-new", keyword: "sms marketing for ecommerce", status: "available", articleId: null, serpUrls: null },
    ],
    articles: [{ id: "a-live", keywordId: "k-live", status: "published", title: "Abandoned Cart Email Guide", publishedUrl: "https://acme.test/cart", scheduledDate: "2026-08-01" }],
  };

  it("never schedules a keyword whose near-duplicate is published, and says why", () => {
    const { schedulable, refused } = withoutOverlapping(topics, [kw("k-dup", 30), kw("k-new", 5)]);
    expect(schedulable.map((k) => k.id)).toEqual(["k-new"]);
    expect(refused).toMatchObject([{ keywordId: "k-dup", duplicateOf: { keywordId: "k-live" }, reason: expect.stringContaining("already published") }]);
  });

  it("keeps the better of two duplicates in the pool, whatever order they came in", () => {
    const { schedulable, refused } = withoutOverlapping(topics, [kw("k-push", 3), kw("k-push2", 9)]);
    expect(schedulable.map((k) => k.id)).toEqual(["k-push2"]);
    expect(refused.map((r) => r.keywordId)).toEqual(["k-push"]);
  });

  it("buys no suggestion the site has, in any form, and no two forms of one", () => {
    const fresh = freshSuggestions(topics, [
      { keyword: "Abandoned Cart Email" },
      { keyword: "abandoned cart email examples" },
      { keyword: "loyalty program ideas" },
      { keyword: "ideas for loyalty programs" },
      { keyword: "sms marketing for e-commerce" },
    ]);
    expect(fresh).toEqual([{ keyword: "loyalty program ideas" }]);
  });
});

describe("parseAutomationSettings", () => {
  it("is off by default, and off for a malformed column", () => {
    expect(parseAutomationSettings(undefined).enabled).toBe(false);
    expect(parseAutomationSettings({ enabled: "yes" }).enabled).toBe(false);
    expect(parseAutomationSettings(null).bufferDays).toBe(14);
  });

  it("keeps what a valid column says", () => {
    const settings = parseAutomationSettings({ enabled: true, bufferDays: 7 });
    expect(settings.enabled).toBe(true);
    expect(settings.bufferDays).toBe(7);
  });
});

describe("planSchedule: a week's mix", () => {
  const typed = (id: string, score: number, intent: TopicIntent) => ({ id, score, intent });
  const pool = [
    typed("core-1", 22, "product_adjacent"),
    typed("core-2", 21, "product_adjacent"),
    typed("core-3", 20, "product_adjacent"),
    typed("core-4", 19, "product_adjacent"),
    typed("core-5", 18, "product_adjacent"),
    typed("core-6", 17, "product_adjacent"),
    typed("core-7", 16, "product_adjacent"),
    typed("cmp-1", 3, "comparison"),
    typed("how-1", 4, "platform_howto"),
    typed("how-2", 3.5, "platform_howto"),
    typed("prob-1", 5, "problem"),
    typed("prob-2", 4.5, "problem"),
  ];
  const intentOfPlan = (plan: Array<{ keywordId: string }>) =>
    plan.map((p) => pool.find((k) => k.id === p.keywordId)?.intent ?? "unknown");

  it("puts one comparison, two how-tos and two problem pieces in an empty week, the best core topics around them", () => {
    const plan = planSchedule({ today: TODAY, bufferDays: 7, occupiedDates: [], available: pool, maxPerRun: 14 });
    const kinds = intentOfPlan(plan);
    expect(kinds.filter((k) => k === "comparison")).toHaveLength(1);
    expect(kinds.filter((k) => k === "platform_howto")).toHaveLength(2);
    expect(kinds.filter((k) => k === "problem")).toHaveLength(2);
    expect(plan.map((p) => p.keywordId).slice(0, 2)).toEqual(["core-1", "core-2"]);
    // A pure score order would have been seven core topics.
    expect(plan).toHaveLength(7);
  });

  it("weighs the day a daily run adds with the six booked before it", () => {
    // Days 8 to 13 are booked with two problems, two how-tos, one comparison and one core topic.
    const booked = ["2026-09-05", "2026-09-06", "2026-09-07", "2026-09-08", "2026-09-09", "2026-09-10"];
    const occupiedIntents = new Map<string, TopicIntent>([
      ["2026-09-05", "problem"],
      ["2026-09-06", "problem"],
      ["2026-09-07", "platform_howto"],
      ["2026-09-08", "platform_howto"],
      ["2026-09-09", "comparison"],
      ["2026-09-10", "product_adjacent"],
    ]);
    const firstWeek = Array.from({ length: 7 }, (_, i) => `2026-08-${String(29 + i).padStart(2, "0")}`).map((d) =>
      d > "2026-08-31" ? `2026-09-0${Number(d.slice(8)) - 31}` : d
    );
    const plan = planSchedule({
      today: TODAY,
      bufferDays: 14,
      occupiedDates: [...firstWeek, ...booked],
      occupiedIntents,
      available: pool,
      maxPerRun: 14,
    });
    // The week holds its minimums: the 14th day takes the best topic.
    expect(plan).toEqual([{ keywordId: "core-1", scheduledDate: "2026-09-11" }]);
  });

  it("never schedules a day twice and keeps the caps with a mix", () => {
    const plan = planSchedule({ today: TODAY, bufferDays: 14, occupiedDates: ["2026-08-30"], available: pool, maxPerRun: 4 });
    expect(plan).toHaveLength(4);
    expect(new Set(plan.map((p) => p.scheduledDate)).size).toBe(4);
    expect(plan.map((p) => p.scheduledDate)).not.toContain("2026-08-30");
    // Four free days of the first week: its minimums come first.
    expect(intentOfPlan(plan).sort()).toEqual(["comparison", "platform_howto", "problem", "problem"].sort());
  });
});
