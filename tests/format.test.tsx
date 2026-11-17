import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  formatCount,
  formatDay,
  formatPosition,
  formatRate,
  MIN_PROBES_FOR_PERCENT,
  positionChange,
  rateIsPercent,
  roundPosition,
  UI_LOCALE,
} from "@/lib/format";
import { pluralize } from "@/lib/utils";
import { formatWhen } from "@/components/visibility/primitives";
import { articleDateLine, dayHeading } from "@/components/dashboard/calendar-model";
import { QueuedArticleCard } from "@/components/dashboard/article-card";
import { describeSearchConsoleTrafficEmpty } from "@/lib/lifecycle/results";

/**
 * The 2026-11-09 UI audit found Italian weekday and month names ("lun 2
 * nov") in an English interface: the formatters used the phone's own locale.
 * Every date and count on screen is now in `UI_LOCALE`. These tests run the
 * formatters on a simulated Italian device, where any call that forgets the
 * locale prints Italian, and scan the UI for calls that leave it out.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const DEVICE = "it-IT";
const real = {
  DateTimeFormat: Intl.DateTimeFormat,
  NumberFormat: Intl.NumberFormat,
  numberToLocale: Number.prototype.toLocaleString,
  dateToLocale: Date.prototype.toLocaleString,
  dateToLocaleDate: Date.prototype.toLocaleDateString,
};

/** Any formatter called without a locale gets the device's: Italian. */
function becomeAnItalianPhone() {
  const DateTimeFormat = function (locales?: Intl.LocalesArgument, options?: Intl.DateTimeFormatOptions) {
    return new real.DateTimeFormat(locales ?? DEVICE, options);
  } as unknown as typeof Intl.DateTimeFormat;
  const NumberFormat = function (locales?: Intl.LocalesArgument, options?: Intl.NumberFormatOptions) {
    return new real.NumberFormat(locales ?? DEVICE, options);
  } as unknown as typeof Intl.NumberFormat;
  Intl.DateTimeFormat = DateTimeFormat;
  Intl.NumberFormat = NumberFormat;
  Number.prototype.toLocaleString = function (this: number, locales?: Intl.LocalesArgument, options?: Intl.NumberFormatOptions) {
    return real.numberToLocale.call(this, locales ?? DEVICE, options);
  };
  Date.prototype.toLocaleString = function (this: Date, locales?: Intl.LocalesArgument, options?: Intl.DateTimeFormatOptions) {
    return real.dateToLocale.call(this, locales ?? DEVICE, options);
  };
  Date.prototype.toLocaleDateString = function (this: Date, locales?: Intl.LocalesArgument, options?: Intl.DateTimeFormatOptions) {
    return real.dateToLocaleDate.call(this, locales ?? DEVICE, options);
  };
}

function restore() {
  Intl.DateTimeFormat = real.DateTimeFormat;
  Intl.NumberFormat = real.NumberFormat;
  Number.prototype.toLocaleString = real.numberToLocale;
  Date.prototype.toLocaleString = real.dateToLocale;
  Date.prototype.toLocaleDateString = real.dateToLocaleDate;
}

describe("on a phone set to Italian", () => {
  const now = new Date(2026, 10, 9, 12);

  beforeEach(becomeAnItalianPhone);
  afterEach(restore);

  it("really is Italian when the locale is left out", () => {
    expect(new Intl.DateTimeFormat(undefined, { month: "short" }).format(now)).toBe("nov");
    expect((12400).toLocaleString()).toBe("12.400");
  });

  it("formats a known day with English names", () => {
    expect(UI_LOCALE).toBe("en-US");
    expect(formatDay("2026-11-02", { now })).toBe("Nov 2");
    expect(formatDay("2026-11-02", { now, weekday: true })).toBe("Mon, Nov 2");
    expect(formatDay("2025-12-30", { now })).toBe("Dec 30, 2025");
  });

  it("dates the Articles board and the Overview in English", () => {
    expect(dayHeading("2026-11-12", now)).toBe("Thu, Nov 12");
    expect(articleDateLine({ status: "published", scheduledDate: "2026-11-02" }, now)).toBe("Published Nov 2");
  });

  it("dates the visibility screens and the Results panel in English", () => {
    expect(formatWhen("2026-11-02T15:04:00.000Z")).toMatch(/^Nov \d, 2026/);
    const copy = describeSearchConsoleTrafficEmpty(
      {
        status: "connected",
        siteUrl: "sc-domain:example.com",
        lastSyncedOn: "2026-08-26",
        pulledAt: "2026-08-28T07:00:00.000Z",
        stale: false,
        lastError: null,
        syncing: false,
      },
      now
    );
    expect(copy).toContain("Data through Aug 26, pulled Aug 28.");
  });

  it("writes a position with an English decimal point", () => {
    expect(formatPosition(51.75)).toBe("51.8");
    expect(positionChange(-1.9700000000000006)).toEqual({ direction: "down", amount: "2" });
    expect(formatRate(0, 3)).toBe("0 of 3");
    expect(formatRate(1200, 4000)).toBe("30%");
  });

  it("groups thousands the English way", () => {
    expect(formatCount(12400)).toBe("12,400");
    expect(pluralize(12400, "click")).toBe("12,400 clicks");
    const card = renderToStaticMarkup(
      <QueuedArticleCard article={{ id: "a", keyword: "k", status: "queued", searchVolume: 12400 }} />
    );
    expect(card).toContain("12,400 /mo");
  });
});

/**
 * The owner's phone, 2026-11-13: "↑ 15.049999999999997", positions of
 * "51.75", and "0%" over three probes. One formatter for positions and their
 * changes, one for sampled rates, and the threshold below which a rate is a
 * count.
 */
describe("positions", () => {
  it("round to one decimal at most, with no trailing .0", () => {
    expect(formatPosition(10)).toBe("10");
    expect(formatPosition(10.0)).toBe("10");
    expect(formatPosition(51.75)).toBe("51.8");
    expect(formatPosition(37.33)).toBe("37.3");
    expect(formatPosition(60.5)).toBe("60.5");
    expect(formatPosition(9.96)).toBe("10");
    expect(formatPosition(105.25)).toBe("105.3");
  });

  it("round half away from zero, and never to -0", () => {
    expect(roundPosition(15.049999999999997)).toBe(15);
    expect(roundPosition(13.670000000000002)).toBe(13.7);
    expect(roundPosition(1.9700000000000006)).toBe(2);
    expect(roundPosition(0.25)).toBe(0.3);
    expect(roundPosition(-0.25)).toBe(-0.3);
    expect(Object.is(roundPosition(-0.04), -0)).toBe(false);
    expect(roundPosition(-0.04)).toBe(0);
  });

  it("read a change as a direction and an amount, from the same rule", () => {
    expect(positionChange(15.049999999999997)).toEqual({ direction: "up", amount: "15" });
    expect(positionChange(-13.670000000000002)).toEqual({ direction: "down", amount: "13.7" });
    expect(positionChange(-1.9700000000000006)).toEqual({ direction: "down", amount: "2" });
    expect(positionChange(0.5)).toEqual({ direction: "up", amount: "0.5" });
  });

  it("call a change that rounds to 0 unchanged, and no change none", () => {
    expect(positionChange(0)).toEqual({ direction: "unchanged" });
    expect(positionChange(0.04)).toEqual({ direction: "unchanged" });
    expect(positionChange(-0.049)).toEqual({ direction: "unchanged" });
    expect(positionChange(null)).toEqual({ direction: "none" });
    expect(positionChange(undefined)).toEqual({ direction: "none" });
    expect(positionChange(Number.NaN)).toEqual({ direction: "none" });
  });
});

describe("sampled rates", () => {
  it("need 10 probes on an engine before they read as a percent", () => {
    expect(MIN_PROBES_FOR_PERCENT).toBe(10);
    expect(rateIsPercent(9)).toBe(false);
    expect(rateIsPercent(10)).toBe(true);
  });

  it("are a count below the threshold, not a verdict", () => {
    expect(formatRate(0, 3)).toBe("0 of 3");
    expect(formatRate(1, 1)).toBe("1 of 1");
    expect(formatRate(2, 9)).toBe("2 of 9");
    expect(formatRate(0, 3)).not.toContain("%");
  });

  it("are a percent from the threshold up", () => {
    expect(formatRate(0, 10)).toBe("0%");
    expect(formatRate(2, 10)).toBe("20%");
    expect(formatRate(1, 3 * 4)).toBe("8%");
    expect(formatRate(12, 12)).toBe("100%");
  });

  it("never round a citation to 0% or a miss to 100%", () => {
    expect(formatRate(1, 300)).toBe("<1%");
    expect(formatRate(299, 300)).toBe(">99%");
  });

  it("are not measured over nothing: null, never 0", () => {
    expect(formatRate(0, 0)).toBeNull();
  });
});

/** Every .ts/.tsx file under a directory, skipping the API routes. */
function sources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(path.join(root, dir))) {
    const relative = path.join(dir, name);
    if (relative === path.join("app", "api")) continue;
    if (statSync(path.join(root, relative)).isDirectory()) out.push(...sources(relative));
    else if (/\.tsx?$/.test(name)) out.push(relative);
  }
  return out;
}

describe("the interface never formats in the device's locale", () => {
  const files = [...sources("app"), ...sources("components")];

  it("passes a locale to every date and number formatter", () => {
    const offenders: string[] = [];
    for (const file of files) {
      const text = readFileSync(path.join(root, file), "utf8");
      const calls = text.match(/\.toLocale(?:Date|Time)?String\(\s*[^)]*\)?|Intl\.(?:DateTimeFormat|NumberFormat)\(\s*[^,)]*/g) ?? [];
      for (const call of calls) {
        const locale = call.replace(/^[^(]*\(\s*/, "").split(/[,)]/)[0].trim();
        if (locale !== "UI_LOCALE" && locale !== '"en-US"') offenders.push(`${file}: ${call}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
