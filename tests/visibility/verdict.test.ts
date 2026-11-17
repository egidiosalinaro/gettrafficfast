import { describe, expect, it } from "vitest";
import type { CitationSource } from "@/lib/providers/citations/types";
import { businessIdentity, isRunDue, parseAeoSettings } from "@/lib/visibility/settings";
import { competitorsIn, excerptOf, EXCERPT_LENGTH, judgeAnswer } from "@/lib/visibility/verdict";

/**
 * The verdict is what the dashboard's rate is made of, so every case where a
 * probe must NOT count as "not cited" is pinned here: an empty answer, a
 * subdomain, an ambiguous brand name.
 */

const source = (url: string, title = ""): CitationSource => ({
  url,
  domain: new URL(url).hostname.replace(/^www\./, ""),
  title,
});

const identity = businessIdentity(
  { name: "GetTrafficFast", website_url: "https://gettrafficfa.st/" },
  parseAeoSettings({ brandNames: ["Get Traffic Fast"], domains: ["blog.gettrafficfa.st"] })
);

describe("businessIdentity", () => {
  it("always includes the site's own domain, normalised", () => {
    expect(identity.domains[0]).toBe("gettrafficfa.st");
  });

  it("normalises extra domains through the same rule as sources", () => {
    const id = businessIdentity(
      { name: "X", website_url: "https://x.test" },
      parseAeoSettings({ domains: ["https://WWW.Other.test/path", "other.test"] })
    );
    expect(id.domains).toEqual(["x.test", "other.test"]);
  });

  it("puts the business name first among brand spellings", () => {
    expect(identity.brandNames).toEqual(["GetTrafficFast", "Get Traffic Fast"]);
  });
});

describe("judgeAnswer", () => {
  it("records an empty answer as invalid with a null verdict, never as not cited", () => {
    const verdict = judgeAnswer({ answer: "   ", sources: [] }, identity);
    expect(verdict.status).toBe("invalid");
    expect(verdict.cited).toBeNull();
    expect(verdict.mentioned).toBeNull();
  });

  it("cites us when our domain is among the sources, with its position", () => {
    const verdict = judgeAnswer(
      {
        answer: "Several tools exist.",
        sources: [source("https://competitor.test/a"), source("https://gettrafficfa.st/blog/x")],
      },
      identity
    );
    expect(verdict.status).toBe("cited");
    expect(verdict.cited).toBe(true);
    expect(verdict.position).toBe(2);
    expect(verdict.sourceUrl).toBe("https://gettrafficfa.st/blog/x");
  });

  it("counts a subdomain of ours, but not a lookalike", () => {
    expect(
      judgeAnswer({ answer: "x", sources: [source("https://docs.gettrafficfa.st/y")] }, identity).cited
    ).toBe(true);
    expect(
      judgeAnswer({ answer: "x", sources: [source("https://notgettrafficfa.st/y")] }, identity).cited
    ).toBe(false);
  });

  it("keeps a prose mention apart from a citation", () => {
    const verdict = judgeAnswer(
      { answer: "Get Traffic Fast is one option.", sources: [source("https://other.test/a")] },
      identity
    );
    expect(verdict.status).toBe("not_cited");
    expect(verdict.cited).toBe(false);
    expect(verdict.mentioned).toBe(true);
  });

  it("does not count an ambiguous brand word as a mention", () => {
    const arc = businessIdentity({ name: "Arc", website_url: "https://arc.test" }, parseAeoSettings({}));
    const verdict = judgeAnswer(
      { answer: "The arc of the story bends.", sources: [source("https://other.test/a")] },
      arc
    );
    expect(verdict.mentioned).toBe(false);
  });

  it("stores a bounded excerpt, not the whole answer", () => {
    const verdict = judgeAnswer(
      { answer: "word ".repeat(400), sources: [source("https://other.test/a")] },
      identity
    );
    expect(verdict.excerpt?.length).toBeLessThanOrEqual(EXCERPT_LENGTH);
    expect(verdict.excerpt?.endsWith("…")).toBe(true);
  });
});

describe("competitorsIn", () => {
  const known = [
    { domain: "rival.test", name: "Rival" },
    { domain: "namedonly.test", name: "NamedOnly" },
  ];

  it("lists every non-ours cited domain once, naming the ones it knows", () => {
    const list = competitorsIn(
      [
        source("https://rival.test/a"),
        source("https://blog.rival.test/b"),
        source("https://stranger.test/c"),
        source("https://gettrafficfa.st/d"),
      ],
      "",
      identity,
      known
    );
    expect(list.map((c) => c.domain).sort()).toEqual(["blog.rival.test", "rival.test", "stranger.test"]);
    expect(list.find((c) => c.domain === "rival.test")?.name).toBe("Rival");
    expect(list.find((c) => c.domain === "stranger.test")?.name).toBeNull();
    expect(list.every((c) => c.via === "source")).toBe(true);
  });

  it("finds a known competitor named in the prose without a link", () => {
    const list = competitorsIn([], "Most people pick NamedOnly for this.", identity, known);
    expect(list).toEqual([{ domain: "namedonly.test", name: "NamedOnly", via: "mention" }]);
  });

  it("never invents a competitor it has no list for", () => {
    expect(competitorsIn([], "Everyone uses Unknownia.", identity, known)).toEqual([]);
  });
});

describe("excerptOf", () => {
  it("returns null for an empty answer instead of an empty string", () => {
    expect(excerptOf("  \n ")).toBeNull();
  });
});

describe("isRunDue", () => {
  const now = new Date("2026-09-21T06:00:00Z");

  it("is never due when the cadence is off, even with no run ever", () => {
    expect(isRunDue("off", null, now)).toBe(false);
  });

  it("is due when nothing has run yet", () => {
    expect(isRunDue("weekly", null, now)).toBe(true);
  });

  it("waits out the interval, with a day of slack for cron drift", () => {
    expect(isRunDue("weekly", "2026-09-16T05:30:00Z", now)).toBe(false);
    expect(isRunDue("weekly", "2026-09-15T05:30:00Z", now)).toBe(true);
    expect(isRunDue("monthly", "2026-09-01T05:30:00Z", now)).toBe(false);
    expect(isRunDue("monthly", "2026-08-20T05:30:00Z", now)).toBe(true);
  });
});

describe("parseAeoSettings", () => {
  it("defaults to off and to every configured engine", () => {
    const settings = parseAeoSettings(null);
    expect(settings.cadence).toBe("off");
    expect(settings.engines).toEqual([]);
  });

  it("falls back to defaults on a malformed column rather than failing a page", () => {
    expect(parseAeoSettings({ cadence: "hourly" })).toEqual(parseAeoSettings(null));
  });
});
