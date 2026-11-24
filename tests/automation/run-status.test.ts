import { describe, expect, it } from "vitest";
import {
  autopilotReason,
  countEmptyDays,
  describeAutopilotRun,
  parseAutopilotRun,
  type AutopilotRunRecord,
} from "@/lib/automation/run-status";

/**
 * What a site's Autopilot says about its last run: off says nothing more
 * than "off", on with no run says when it runs, a run that did less than
 * the calendar needed says why first, and a column that cannot be read is
 * "no run recorded", never a run that went well.
 */

const run = (over: Partial<AutopilotRunRecord> = {}): AutopilotRunRecord => ({
  at: "2026-11-24T06:00:00.000Z",
  scheduled: 0,
  topicsAdded: 0,
  questionsAdded: 0,
  emptyDays: 0,
  bufferDays: 14,
  reasons: [],
  ...over,
});

describe("describeAutopilotRun", () => {
  it("is null while Autopilot is off, whatever was recorded", () => {
    expect(describeAutopilotRun({ enabled: false, run: run() })).toBeNull();
  });

  it("says when it runs before the first run", () => {
    expect(describeAutopilotRun({ enabled: true, run: null })).toMatchObject({ state: "not_run_yet", lastRun: null });
  });

  it("says what a run that did its job did", () => {
    expect(describeAutopilotRun({ enabled: true, run: run({ scheduled: 2, topicsAdded: 1, questionsAdded: 3 }) })?.message).toBe(
      "Last run scheduled 2 articles, added 1 topic, added 3 questions people ask."
    );
    expect(describeAutopilotRun({ enabled: true, run: run() })?.message).toBe("Last run: the next 14 days were already covered.");
  });

  it("puts the reason that explains the empty days first", () => {
    const view = describeAutopilotRun({
      enabled: true,
      run: run({ emptyDays: 4, reasons: [autopilotReason.aiLimit(), autopilotReason.poolOverlaps(2, "x"), autopilotReason.daysEmpty(4, 14)] }),
    });
    expect(view).toMatchObject({ state: "stalled", message: "4 days of the next 14 have no article: no topic was left to schedule." });
  });

  it("says a site skipped for no plan was skipped", () => {
    expect(describeAutopilotRun({ enabled: true, run: run({ emptyDays: null, reasons: [autopilotReason.noPlan()] }) })?.state).toBe("skipped");
  });
});

describe("parseAutopilotRun", () => {
  it("reads a stored record and refuses anything malformed", () => {
    expect(parseAutopilotRun(run({ reasons: [autopilotReason.failed()] }))?.reasons[0].code).toBe("failed");
    expect(parseAutopilotRun(null)).toBeNull();
    expect(parseAutopilotRun({ at: "x" })).toBeNull();
    expect(parseAutopilotRun({ ...run(), reasons: [{ code: "invented", message: "?" }] })).toBeNull();
  });
});

describe("countEmptyDays", () => {
  it("counts tomorrow to the buffer's last day, never today", () => {
    const today = new Date("2026-11-24T06:00:00.000Z");
    expect(countEmptyDays(today, 3, new Set(["2026-11-24", "2026-11-26"]))).toBe(2);
    expect(countEmptyDays(today, 0, new Set())).toBe(0);
  });
});

describe("the reasons in words", () => {
  it("say one and many correctly", () => {
    expect(autopilotReason.poolOverlaps(1, null).message).toMatch(/^1 topic in the pool was not scheduled: it overlaps/);
    expect(autopilotReason.daysEmpty(1, 14).message).toBe("1 day of the next 14 has no article: no topic was left to schedule.");
    expect(autopilotReason.noNewTopics(10).message).toContain("looked for 10 new topics and found none");
  });
});
