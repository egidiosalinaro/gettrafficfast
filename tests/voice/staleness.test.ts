import { describe, expect, it } from "vitest";
import { STALE_AFTER_DAYS, aboutYouFacts, datesIn, factSentences, quoteShort, staleFacts } from "@/lib/voice/staleness";

/**
 * Which facts in About you have gone stale. What is pinned: every form of
 * date the owner's own text uses is read, a date that cannot be read with
 * certainty is not guessed, a sentence with no date is never flagged, and
 * the threshold is "more than 30 days", exactly.
 */

/** The owner's About you on the GetTrafficFast site, 10 November 2026. */
const OWNER_ABOUT =
  "Former agency designer, learned to code at night. Co-founded Postwren, email marketing for Shopify stores: 12 paying stores in October 2026. Since late September an AI pipeline writes and publishes my own blog: 9 impressions a week at the start, 342 in the week of Oct 26, still 0 clicks, articles sit around position 30-40. Left Porto on Oct 27 2026, working from Taipei.";

const NOW = new Date("2026-11-10T09:30:00Z");

const dateOf = (sentence: string, now = NOW) => aboutYouFacts(sentence, now)[0]?.date ?? null;
const iso = (sentence: string, now = NOW) => dateOf(sentence, now)?.iso ?? null;

describe("factSentences", () => {
  it("splits About you into its facts, keeping a colon's two halves together", () => {
    expect(factSentences(OWNER_ABOUT)).toEqual([
      "Former agency designer, learned to code at night.",
      "Co-founded Postwren, email marketing for Shopify stores: 12 paying stores in October 2026.",
      "Since late September an AI pipeline writes and publishes my own blog: 9 impressions a week at the start, 342 in the week of Oct 26, still 0 clicks, articles sit around position 30-40.",
      "Left Porto on Oct 27 2026, working from Taipei.",
    ]);
  });

  it("splits on a line break and a semicolon, and not after an abbreviated month", () => {
    expect(factSentences("I run a bakery\n12 staff; open since 2019")).toEqual(["I run a bakery", "12 staff;", "open since 2019"]);
    expect(factSentences("Launched on Oct. 26 2026. 40 signups since.")).toEqual(["Launched on Oct. 26 2026.", "40 signups since."]);
    expect(factSentences("   ")).toEqual([]);
  });
});

describe("the forms of a date", () => {
  it("reads an ISO date", () => {
    expect(dateOf("Launched 2026-10-27.")).toMatchObject({ iso: "2026-10-27", precision: "day", label: "Oct 27, 2026", yearAssumed: false });
  });

  it("reads month day year, with and without a comma or an ordinal", () => {
    expect(iso("Left Porto on Oct 27 2026, working from Taipei.")).toBe("2026-10-27");
    expect(iso("Left Porto on October 27, 2026.")).toBe("2026-10-27");
    expect(iso("Left Porto on October 27th, 2026.")).toBe("2026-10-27");
    expect(iso("Launched Oct. 26 2026.")).toBe("2026-10-26");
  });

  it("reads day month year", () => {
    expect(iso("Launched on 27 October 2026.")).toBe("2026-10-27");
    expect(iso("Launched on the 27th of Oct 2026.")).toBe("2026-10-27");
  });

  it("reads a month and year as a period dated by its first day", () => {
    expect(dateOf("12 paying stores in October 2026.")).toMatchObject({ iso: "2026-10-01", precision: "month", label: "October 2026", yearAssumed: false });
    expect(iso("12 paying stores in Oct 2026.")).toBe("2026-10-01");
    expect(iso("12 paying stores as of September, 2026.")).toBe("2026-09-01");
  });

  it("reads a part of a month, by its first day", () => {
    expect(dateOf("Since late September 2026 the pipeline runs.")).toMatchObject({ iso: "2026-09-21", precision: "part", label: "late September 2026" });
    expect(iso("Since mid-October 2026.")).toBe("2026-10-11");
    expect(iso("Since early October 2026.")).toBe("2026-10-01");
  });

  it("reads the week of a day", () => {
    expect(dateOf("342 impressions in the week of Oct 26.")).toMatchObject({
      iso: "2026-10-26",
      precision: "week",
      label: "the week of Oct 26, 2026",
      yearAssumed: true,
    });
    expect(dateOf("342 impressions the week of October 26, 2026.")).toMatchObject({ iso: "2026-10-26", yearAssumed: false });
  });

  it("takes a date with no year as its most recent past occurrence", () => {
    // "Oct 26" is the 26th, not the year 2026: a year is four digits.
    expect(dateOf("342 impressions on Oct 26.")).toMatchObject({ iso: "2026-10-26", precision: "day", yearAssumed: true });
    expect(iso("Launched on 26 October.")).toBe("2026-10-26");
    expect(dateOf("Since late September an AI pipeline writes my blog.")).toMatchObject({ iso: "2026-09-21", precision: "part", yearAssumed: true });
    expect(dateOf("12 paying stores in October.")).toMatchObject({ iso: "2026-10-01", precision: "month", yearAssumed: true });
    // Today counts as past; a day later in the year is last year's.
    expect(iso("Shipped on Nov 10.")).toBe("2026-11-10");
    expect(iso("Shipped on Nov 11.")).toBe("2025-11-11");
    expect(iso("12 customers in December.")).toBe("2025-12-01");
    // A leap day goes back to the last year that had one.
    expect(iso("Launched on Feb 29.")).toBe("2024-02-29");
  });

  it("takes the most recent date when a sentence carries several, and lists them in order", () => {
    const sentence = factSentences(OWNER_ABOUT)[2];
    expect(datesIn(sentence, NOW).map((date) => date.iso)).toEqual(["2026-09-21", "2026-10-26"]);
    expect(dateOf(sentence)?.iso).toBe("2026-10-26");
    expect(datesIn("Between 2026-01-05 and March 2026.", NOW).map((date) => date.text)).toEqual(["2026-01-05", "March 2026"]);
  });
});

describe("what is not a date", () => {
  it("does not flag a sentence with no date", () => {
    expect(aboutYouFacts("Former agency designer, learned to code at night.", NOW)).toEqual([
      { sentence: "Former agency designer, learned to code at night.", date: null, confirmedOn: null, ageDays: null, stale: false },
    ]);
    expect(iso("I get 200+ impressions a day on my blog and still zero clicks.")).toBeNull();
    expect(iso("Articles sit around position 30-40.")).toBeNull();
  });

  it("does not guess a date it cannot read with certainty", () => {
    // March 4 or 3 April, depending on who wrote it.
    expect(iso("Launched on 03/04/2026.")).toBeNull();
    expect(iso("Launched on 26/10/2026.")).toBeNull();
    // A day that does not exist.
    expect(iso("Launched on Feb 30 2026.")).toBeNull();
    expect(iso("Launched on 2026-13-01.")).toBeNull();
    // A bare year is a lasting fact, not a reading.
    expect(iso("Running a bakery since 2019.")).toBeNull();
    // Relative to a day nobody recorded.
    expect(iso("40 signups last month.")).toBeNull();
    expect(iso("Launched yesterday.")).toBeNull();
    // The verb, and a month with no word that makes it a date.
    expect(iso("Readers may 5x their traffic.")).toBeNull();
    expect(iso("It may take a while.")).toBeNull();
    expect(iso("The March of Dimes funded 3 studies.")).toBeNull();
    // A goal, not a reading.
    expect(iso("I want 100 customers by December.")).toBeNull();
    // A number that only looks like a day.
    expect(iso("Open rates went from 12 to 30%.")).toBeNull();
  });
});

describe("the threshold", () => {
  const sentence = "12 paying stores on Oct 11 2026.";
  const at = (day: string) => aboutYouFacts(sentence, new Date(`${day}T12:00:00Z`))[0];

  it("is 30 days, and stale means more than that", () => {
    expect(STALE_AFTER_DAYS).toBe(30);
    expect(at("2026-11-09")).toMatchObject({ ageDays: 29, stale: false });
    // Exactly 30 days old is not older than 30 days.
    expect(at("2026-11-10")).toMatchObject({ ageDays: 30, stale: false });
    expect(at("2026-11-11")).toMatchObject({ ageDays: 31, stale: true });
  });

  it("counts whole UTC days, whatever the hour", () => {
    expect(aboutYouFacts(sentence, new Date("2026-11-10T23:59:59Z"))[0]).toMatchObject({ ageDays: 30, stale: false });
    expect(aboutYouFacts(sentence, new Date("2026-11-11T00:00:00Z"))[0]).toMatchObject({ ageDays: 31, stale: true });
  });

  it("takes another threshold when given one", () => {
    expect(aboutYouFacts(sentence, new Date("2026-10-20T00:00:00Z"), { staleAfterDays: 7 })[0]).toMatchObject({ ageDays: 9, stale: true });
    expect(aboutYouFacts(sentence, new Date("2026-10-18T00:00:00Z"), { staleAfterDays: 7 })[0]).toMatchObject({ ageDays: 7, stale: false });
  });

  it("never flags a date still to come", () => {
    expect(aboutYouFacts("Launching on 2026-12-01.", NOW)[0]).toMatchObject({ ageDays: -21, stale: false });
  });

  it("dates a month by its first day, so a month's fact is asked about once the next month starts", () => {
    const month = "12 paying stores in October 2026.";
    expect(aboutYouFacts(month, new Date("2026-10-31T00:00:00Z"))[0]).toMatchObject({ ageDays: 30, stale: false });
    expect(aboutYouFacts(month, new Date("2026-11-01T00:00:00Z"))[0]).toMatchObject({ ageDays: 31, stale: true });
  });
});

describe("staleFacts on the owner's About you, 10 November 2026", () => {
  it("flags the Postwren figure and nothing else", () => {
    expect(staleFacts(OWNER_ABOUT, NOW)).toEqual([
      {
        sentence: "Co-founded Postwren, email marketing for Shopify stores: 12 paying stores in October 2026.",
        date: "2026-10-01",
        dateLabel: "October 2026",
        precision: "month",
        yearAssumed: false,
        confirmedOn: null,
        ageDays: 40,
        age: "last month",
        line: "Dated October 2026 (last month): still true?",
      },
    ]);
    // The blog's numbers are 15 days old and the move 14: not asked about yet.
    expect(aboutYouFacts(OWNER_ABOUT, NOW).map((fact) => [fact.date?.iso ?? null, fact.ageDays, fact.stale])).toEqual([
      [null, null, false],
      ["2026-10-01", 40, true],
      ["2026-10-26", 15, false],
      ["2026-10-27", 14, false],
    ]);
  });

  it("asks about the blog's numbers and the move once they are over 30 days old", () => {
    const later = staleFacts(OWNER_ABOUT, new Date("2026-11-27T00:00:00Z"));
    expect(later.map((fact) => fact.line)).toEqual([
      "Dated October 2026 (last month): still true?",
      "Dated the week of Oct 26, 2026 (32 days ago): still true?",
      "Dated Oct 27, 2026 (31 days ago): still true?",
    ]);
  });

  it("says how long ago in the unit the date was given in", () => {
    expect(staleFacts("12 customers in August 2026.", NOW)[0]).toMatchObject({ age: "3 months ago" });
    expect(staleFacts("12 customers since late September.", NOW)[0]).toMatchObject({ age: "2 months ago", dateLabel: "late September 2026" });
    expect(staleFacts("12 customers on Oct 1 2026.", NOW)[0]).toMatchObject({ age: "40 days ago", line: "Dated Oct 1, 2026 (40 days ago): still true?" });
  });

  it("is empty for an empty or undated About you, and changes nothing in the text", () => {
    expect(staleFacts("", NOW)).toEqual([]);
    expect(staleFacts("I run a two-person bakery.", NOW)).toEqual([]);
    const text = `${OWNER_ABOUT}`;
    staleFacts(text, NOW);
    expect(text).toBe(OWNER_ABOUT);
  });
});

describe("quoteShort", () => {
  it("quotes a sentence short enough for one line of a phone", () => {
    expect(quoteShort("I run a bakery.")).toBe("I run a bakery.");
    const short = quoteShort("Co-founded Postwren, email marketing for Shopify stores: 12 paying stores in October 2026.");
    expect(short.length).toBeLessThanOrEqual(60);
    expect(short).toBe("Co-founded Postwren, email marketing for Shopify stores: 12…");
  });
});
