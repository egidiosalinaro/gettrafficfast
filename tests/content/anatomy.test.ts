import { describe, expect, it } from "vitest";
import {
  READ_NEXT_ID,
  SHORT_VERSION_MAX_WORDS,
  anatomyLabels,
  articleDataFacts,
  enoughQuestionHeadings,
  isQuestion,
  questionHeadings,
  readDataSection,
  readShortVersion,
  temporalCoverage,
  withReadNext,
  withoutReadNext,
} from "@/lib/content/anatomy";

/**
 * The article's anatomy (2026-11-15), the parts code reads: the short
 * version, question headings, the facts a data section may state (and the
 * weak early traction it may not), and the Read next block.
 */

const NOW = new Date("2026-11-15T12:00:00Z");

describe("labels", () => {
  it("follows the site's language, as a code or a name, English otherwise", () => {
    expect(anatomyLabels("en").shortVersion).toBe("The short version");
    expect(anatomyLabels("it")).toEqual({ shortVersion: "In breve", fromOurData: "Dai nostri dati", readNext: "Leggi anche" });
    expect(anatomyLabels("it-IT").shortVersion).toBe("In breve");
    expect(anatomyLabels("Italian").shortVersion).toBe("In breve");
    expect(anatomyLabels("de").readNext).toBe("Weiterlesen");
    expect(anatomyLabels("pt").shortVersion).toBe("The short version");
    expect(anatomyLabels(undefined).readNext).toBe("Read next");
  });
});

describe("the short version", () => {
  it("is the first paragraph, opening with the label in bold, label left out of its text", () => {
    const short = readShortVersion(
      "<p><strong>The short version:</strong> Publish weekly. Answer one question per post. Link the posts.</p><p>Intro.</p><h2>Why?</h2>"
    );
    expect(short).toEqual({ label: "The short version", text: "Publish weekly. Answer one question per post. Link the posts.", words: 10 });
  });

  it("is read in every supported language, after a hero figure, and with the label alone in its paragraph", () => {
    expect(readShortVersion("<p><strong>In breve</strong>: Pubblica ogni settimana.</p>")?.text).toBe("Pubblica ogni settimana.");
    expect(readShortVersion('<figure class="gtf-hero"><img src="x"></figure><p><b>Kurz gesagt:</b> Jede Woche.</p>')?.label).toBe("Kurz gesagt");
    expect(readShortVersion("<p><strong>The short version</strong></p><p>Publish weekly.</p>")?.text).toBe("Publish weekly.");
  });

  it("is absent when the body opens any other way", () => {
    expect(readShortVersion("<p>An intro that does not answer.</p>")).toBeNull();
    expect(readShortVersion("<p><strong>Important:</strong> not the label.</p>")).toBeNull();
    expect(readShortVersion("<p>Intro.</p><p><strong>The short version:</strong> too late.</p>")).toBeNull();
    expect(readShortVersion("<h2>The short version</h2><p>A heading is not the block.</p>")).toBeNull();
  });

  it("counts its words, for the cap", () => {
    const long = Array.from({ length: SHORT_VERSION_MAX_WORDS + 5 }, () => "word").join(" ");
    expect(readShortVersion(`<p><strong>The short version:</strong> ${long}.</p>`)?.words).toBe(SHORT_VERSION_MAX_WORDS + 5);
  });
});

describe("question headings", () => {
  it("counts the section headings, not the FAQ, the data section or Read next", () => {
    const reading = questionHeadings([
      { level: 2, text: "What goes in a calendar?" },
      { level: 2, text: "How do you fill it?" },
      { level: 2, text: "Common mistakes" },
      { level: 2, text: "What to do next" },
      { level: 3, text: "Not counted" },
      { level: 2, text: "FAQ" },
      { level: 2, text: "From our data" },
      { level: 2, id: READ_NEXT_ID, text: "Read next" },
    ]);
    expect(reading).toEqual({ counted: 4, questions: 2, statements: ["Common mistakes", "What to do next"] });
    expect(enoughQuestionHeadings(reading)).toBe(true);
    expect(enoughQuestionHeadings({ counted: 5, questions: 2, statements: [] })).toBe(false);
  });

  it("reads a question by its mark, Spanish included", () => {
    expect(isQuestion("Is it free?")).toBe(true);
    expect(isQuestion("¿Cuánto cuesta")).toBe(true);
    expect(isQuestion("Pricing")).toBe(false);
  });
});

describe("facts a 'From our data' section may state", () => {
  it("keeps measurements and withholds the site's own weak early traction", () => {
    const facts = [
      "We publish for 14 sites.",
      "Postwren has 12 paying stores in October 2026.",
      "MRR is €300.",
      "My blog went from 9 to 342 impressions a week, still 0 clicks.",
      "Between September and November 2026 we tested 400 prompts across three answer engines.",
      "Customer sites earned 1.2 million impressions in October 2026.",
      "I left Porto on Oct 27 2026.",
    ].join("\n");
    const { usable, withheld } = articleDataFacts(facts, NOW);
    expect(usable.map((fact) => fact.sentence)).toEqual([
      "Between September and November 2026 we tested 400 prompts across three answer engines.",
      "Customer sites earned 1.2 million impressions in October 2026.",
    ]);
    expect(withheld.map((fact) => fact.sentence)).toEqual([
      "We publish for 14 sites.",
      "Postwren has 12 paying stores in October 2026.",
      "MRR is €300.",
      "My blog went from 9 to 342 impressions a week, still 0 clicks.",
    ]);
    expect(withheld[0].reason).toContain("early traction");
  });

  it("reads dates and years as dates, not figures: a sentence with only a date carries no measurement", () => {
    expect(articleDataFacts("Founded in 2019. Moved on October 27, 2026.", NOW)).toEqual({ usable: [], withheld: [] });
  });

  it("withholds a traction percentage and keeps a large revenue", () => {
    const { usable, withheld } = articleDataFacts("Conversion grew 40% in a month.\nRevenue passed $250k ARR in 2026.", NOW);
    expect(withheld.map((fact) => fact.sentence)).toEqual(["Conversion grew 40% in a month."]);
    expect(usable.map((fact) => fact.sentence)).toEqual(["Revenue passed $250k ARR in 2026."]);
  });

  it("is empty with no facts", () => {
    expect(articleDataFacts("", NOW)).toEqual({ usable: [], withheld: [] });
    expect(articleDataFacts(undefined, NOW)).toEqual({ usable: [], withheld: [] });
  });
});

describe("the data section and its period", () => {
  it("is read from its heading to the next one", () => {
    const section = readDataSection(
      '<p>Intro.</p><h2 id="from-our-data">From our data</h2><p>We tested 400 prompts.</p><ul><li>Three engines.</li></ul><h2>FAQ</h2><p>No.</p>'
    );
    expect(section).toEqual({ headingId: "from-our-data", heading: "From our data", text: "We tested 400 prompts. Three engines." });
    expect(readDataSection("<p>Intro.</p><h2>How we measured this</h2><p>400 prompts.</p>")?.heading).toBe("How we measured this");
    expect(readDataSection("<p>Intro.</p><h2>Why?</h2><p>400 prompts.</p>")).toBeNull();
  });

  it("states the period the text names, as ISO 8601, and none when it names none", () => {
    expect(temporalCoverage("between September and November 2026", NOW)).toBe("2026-09/2026-11");
    expect(temporalCoverage("from September 2026 to November 2026", NOW)).toBe("2026-09/2026-11");
    expect(temporalCoverage("on October 12, 2026", NOW)).toBe("2026-10-12");
    expect(temporalCoverage("in 2025 and 2026", NOW)).toBe("2025/2026");
    expect(temporalCoverage("tra settembre e novembre 2026", NOW)).toBe("2026");
    expect(temporalCoverage("in October", NOW)).toBeNull();
    expect(temporalCoverage("400 prompts", NOW)).toBeNull();
  });
});

describe("Read next", () => {
  const article = {
    bodyHtml: '<p>Intro.</p><h2 id="why">Why?</h2><p>Because.</p>',
    headings: [{ level: 2 as const, id: "why", text: "Why?" }],
    language: "en",
  };
  const items = [
    { title: "How to plan a calendar", href: "https://crumb.example/blog/plan" },
    { title: 'Tools & "templates" <compared>', href: "https://crumb.example/blog/tools" },
  ];

  it("is appended at the end, in the article's language, and in the headings", () => {
    const linked = withReadNext(article, items);
    expect(linked.bodyHtml).toBe(
      '<p>Intro.</p><h2 id="why">Why?</h2><p>Because.</p>\n<h2 id="read-next">Read next</h2>\n<ul><li><a href="https://crumb.example/blog/plan">How to plan a calendar</a></li><li><a href="https://crumb.example/blog/tools">Tools &amp; &quot;templates&quot; &lt;compared&gt;</a></li></ul>'
    );
    expect(linked.headings.at(-1)).toEqual({ level: 2, id: "read-next", text: "Read next" });
    expect(withReadNext({ ...article, language: "it" }, items).bodyHtml).toContain('<h2 id="read-next">Leggi anche</h2>');
  });

  it("replaces a block already there instead of adding a second, and removes it with no item", () => {
    const once = withReadNext(article, items);
    const twice = withReadNext(once, items.slice(0, 1));
    expect(twice.bodyHtml.match(/read-next/g)).toHaveLength(1);
    expect(twice.headings.filter((h) => h.id === "read-next")).toHaveLength(1);
    expect(twice.bodyHtml).not.toContain("templates");
    const none = withReadNext(once, []);
    expect(none.bodyHtml).toBe(article.bodyHtml);
    expect(none.headings).toEqual(article.headings);
  });

  it("never writes an address that is not http(s)", () => {
    const linked = withReadNext(article, [{ title: "Bad", href: "javascript:alert(1)" }, { title: "Relative", href: "/blog/x" }]);
    expect(linked.bodyHtml).toBe(article.bodyHtml);
  });

  it("is left out of what the editorial checks read", () => {
    expect(withoutReadNext(withReadNext(article, items).bodyHtml).trim()).toBe(article.bodyHtml);
  });
});
