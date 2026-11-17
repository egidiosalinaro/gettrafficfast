import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  axisTickIndexes,
  MIN_TICK_SPACING,
  TrafficChart,
} from "@/components/results/traffic-chart";
import { formatDay } from "@/components/visibility/primitives";
import type { DailyTrafficPoint } from "@/lib/lifecycle/results";

/**
 * Server-rendered structure of the chart. Not pixels: the contract. Two
 * panels instead of a dual axis, values reachable without a pointer, and a
 * clean disappearance when there is nothing to draw.
 */

const days: DailyTrafficPoint[] = [
  { day: "2026-08-24", clicks: 2, impressions: 40 },
  { day: "2026-08-25", clicks: 5, impressions: 90 },
  { day: "2026-08-26", clicks: 0, impressions: 31 },
  { day: "2026-08-27", clicks: 3, impressions: 64 },
  { day: "2026-08-28", clicks: 8, impressions: 120 },
];

describe("TrafficChart", () => {
  it("renders one panel per measure, never a second y axis", () => {
    const html = renderToStaticMarkup(<TrafficChart days={days} />);
    expect(html.match(/<svg/g)).toHaveLength(2);
    expect(html).toContain("Clicks");
    expect(html).toContain("Impressions");
  });

  it("keeps every daily value reachable without hovering", () => {
    const html = renderToStaticMarkup(<TrafficChart days={days} />);
    expect(html).toContain("<table");
    // Full values in the table, not only the compacted axis labels.
    expect(html).toContain("120");
    // Days as a person reads them, through the shared formatter, not ISO.
    expect(html).toContain(formatDay("2026-08-24"));
    expect(html).not.toContain("2026-08-24");
  });

  it("labels the end of each line with its latest value", () => {
    const html = renderToStaticMarkup(<TrafficChart days={days} />);
    expect(html).toContain(">8<");
  });

  it("renders nothing for an empty series", () => {
    expect(renderToStaticMarkup(<TrafficChart days={[]} />)).toBe("");
  });

  it("survives a single-day series without dividing by zero", () => {
    const html = renderToStaticMarkup(<TrafficChart days={[days[0]]} />);
    expect(html.match(/<svg/g)).toHaveLength(2);
    expect(html).not.toContain("NaN");
  });
});

describe("axisTickIndexes", () => {
  // The plot's inner width at 390px (page and card padding off), and at 640px.
  const PHONE = 218;
  const DESKTOP = 532;

  function spacing(ticks: number[], count: number, width: number): number[] {
    const perDay = width / (count - 1);
    return ticks.slice(1).map((tick, i) => (tick - ticks[i]) * perDay);
  }

  it("spaces labels by width, so 28 days do not collide on a phone", () => {
    const ticks = axisTickIndexes(28, PHONE);
    expect(ticks[0]).toBe(0);
    expect(ticks[ticks.length - 1]).toBe(27);
    for (const gap of spacing(ticks, 28, PHONE)) expect(gap).toBeGreaterThanOrEqual(MIN_TICK_SPACING);
    expect(ticks.length).toBeLessThanOrEqual(Math.floor(PHONE / MIN_TICK_SPACING) + 1);
  });

  it("uses the room a wider panel has", () => {
    const phone = axisTickIndexes(28, PHONE);
    const desktop = axisTickIndexes(28, DESKTOP);
    expect(desktop.length).toBeGreaterThan(phone.length);
    for (const gap of spacing(desktop, 28, DESKTOP)) expect(gap).toBeGreaterThanOrEqual(MIN_TICK_SPACING);
  });

  it("labels every day of a short series when they fit, and never divides by zero", () => {
    expect(axisTickIndexes(5, DESKTOP)).toEqual([0, 1, 2, 3, 4]);
    expect(axisTickIndexes(1, PHONE)).toEqual([0]);
    expect(axisTickIndexes(0, PHONE)).toEqual([]);
    expect(axisTickIndexes(2, 40)).toEqual([1]);
  });
});
