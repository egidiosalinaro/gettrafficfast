import { afterEach, describe, expect, it } from "vitest";
import type { z } from "zod";
import { setLlmProvider } from "@/lib/providers/llm/registry";
import type { LLMProvider, LlmOptions, LlmStructuredResult, LlmTextResult, LlmUsage } from "@/lib/providers/llm/types";
import { createBudget, AgentContext } from "@/lib/agents/contract";
import { runAgent } from "@/lib/agents/runner";
import { aeoAgent } from "@/lib/agents/aeo";
import { outlineAgent } from "@/lib/agents/outline";
import { guideCanRank, serpAnalysisAgent } from "@/lib/agents/serp-analysis";
import { revisionAgent, sectionHeading, writingAgent, writingRules } from "@/lib/agents/writing";
import { internalLinksAgent } from "@/lib/agents/internal-links";

/**
 * What the article agents are told, read from the prompt itself: each rule
 * answers something the audit of 2026-11-10 found in published articles.
 */

const usage: LlmUsage = { model: "stub", inputTokens: 100, outputTokens: 200, costUsd: 0.001 };

function stub(responses: { text?: string; structured?: unknown; usage?: LlmUsage }) {
  const seen: { prompt: string; options?: LlmOptions }[] = [];
  const llm: LLMProvider = {
    name: "stub",
    async generateText(prompt, options): Promise<LlmTextResult> {
      seen.push({ prompt, options });
      return { text: responses.text ?? "", usage: responses.usage ?? usage };
    },
    async generateStructured<T>(prompt: string, schema: z.ZodType<T>, options?: LlmOptions): Promise<LlmStructuredResult<T>> {
      seen.push({ prompt, options });
      return { value: schema.parse(responses.structured), usage, raw: "" };
    },
  };
  setLlmProvider(llm);
  return seen;
}

const ctx = (): AgentContext => ({
  userId: "user-1",
  language: "English",
  runId: "run-1",
  budget: createBudget(1),
});

const section = (heading: string) => ({
  heading,
  question: `${heading}?`,
  answer: "A direct answer.",
  points: ["One"],
  subsections: [],
});

const OUTLINE = {
  title: "How to build a content calendar",
  angle: "A calendar a small team keeps",
  intro: "Open with the week nobody knew what to publish.",
  sections: [section("What goes in it"), section("How to fill it"), section("How to keep it")],
  faq: [
    { question: "Is a spreadsheet enough?", answer: "Yes." },
    { question: "How far ahead?", answer: "Four weeks." },
    { question: "Who owns it?", answer: "One person." },
  ],
  entities: ["content calendar"],
};

const business = {
  businessName: "GetTrafficFast",
  businessNiche: "Content platform",
  websiteUrl: "https://gettrafficfa.st",
  firstHandFacts: "We publish for 14 sites and 36 articles went out in October.",
  ownerNotes: "Short sentences. Never say synergy.",
};

const evidence = {
  results: [
    { title: "Free Content Calendar Template", domain: "hubspot.com", snippet: "Download a free template used by 30,000 marketers." },
  ],
  questions: ["What should a content calendar include?", "How do I create a content calendar for free?"],
  relatedSearches: ["content calendar template"],
};

afterEach(() => setLlmProvider(null));

describe("the writer's rules", () => {
  const rules = writingRules({ keyword: "content calendar", language: "English", ...business });

  it("bans the stock openings and closings, with the examples production wrote", () => {
    expect(rules).toContain("In today's competitive digital landscape");
    expect(rules).toContain("is rapidly evolving");
    expect(rules).toContain("no longer a luxury but a strategic necessity");
    expect(rules).toContain("offers an unparalleled solution");
  });

  it("limits the title and makes it a promise", () => {
    expect(rules).toContain("At most 60 characters");
    for (const word of ["Mastering", "Unlock", "Ultimate", "Definitive", "Blueprint", "Unleash"]) {
      expect(rules).toContain(word);
    }
    expect(rules).toContain('"Ranked" means the body ranks');
    expect(rules).toContain('"7 ways" means exactly seven');
  });

  it("allows tables and code, which the old prompt forbade", () => {
    expect(rules).toContain("<table>");
    expect(rules).toContain("<pre><code>");
    expect(rules).toMatch(/Allowed tags:.*<table>.*<pre>, <code>/);
    expect(rules).not.toContain("no backticks, no [text](url). No code fences.\n- Allowed tags: <h1>, <h2>, <h3>, <p>, <ul>, <ol>, <li>, <strong>, <em>, <a>, <blockquote>.");
  });

  it("asks for a comparison table when the keyword compares", () => {
    const comparative = writingRules({ keyword: "postwren vs klaviyo", language: "English" });
    expect(comparative).toContain("This keyword compares options: include one comparison <table>");
    expect(rules).not.toContain("This keyword compares options");
  });

  it("keeps the product to one plain sentence in the closing section", () => {
    expect(rules).toContain("GetTrafficFast is not mentioned in the introduction");
    expect(rules).toContain("at most once, in the closing section, in one plain sentence");
    expect(rules).toContain("No superlatives");
  });

  it("sets the heading, FAQ and length rules", () => {
    expect(rules).toContain("5 to 8 <h2> sections");
    expect(rules).toContain("An <h3> only when its own subsection runs to 150 words or more");
    expect(rules).toContain("FAQ: 3 to 5 real questions");
    expect(rules).toContain("900–1500 words. That is a ceiling");
    expect(rules).toContain("Never exceed 1,800 words");
  });

  it("states the first-hand facts as the only ones, and the real site as the only address", () => {
    expect(rules).toContain("These are the ONLY first-hand facts and numbers you may state");
    expect(rules).toContain("We publish for 14 sites");
    expect(rules).toContain("Never say synergy");
    expect(rules).toContain("must appear in the search evidence");
    expect(rules).toContain("The business's only website is https://gettrafficfa.st");
  });

  it("says there are no first-hand facts when there are none, instead of saying nothing", () => {
    const bare = writingRules({ keyword: "k", language: "English", businessName: "Acme" });
    expect(bare).toContain("No first-hand facts are on record");
    expect(bare).toContain("No website is on record for Acme");
  });
});

describe("the article's anatomy (2026-11-15)", () => {
  const rules = writingRules({ keyword: "content calendar", language: "en", ...business });

  it("asks for the short version first, labelled, 3 to 6 sentences, quotable alone", () => {
    expect(rules).toContain("<p><strong>The short version:</strong> …</p>");
    expect(rules).toContain("3 to 6 sentences and at most 100 words");
    expect(rules).toContain("an answer engine that quotes only it, has the answer");
    expect(rules).toContain("no mention of GetTrafficFast");
  });

  it("labels it in the site's language", () => {
    expect(writingRules({ keyword: "calendario editoriale", language: "it" })).toContain("<p><strong>In breve:</strong> …</p>");
    expect(writingRules({ keyword: "calendario editoriale", language: "it", firstHandFacts: "Between September and November 2026 we tested 400 prompts." })).toContain(
      "<h2>Dai nostri dati</h2>"
    );
  });

  it("asks that at least half the headings be the questions people ask, each answered at once", () => {
    expect(rules).toContain('At least half of the <h2> headings');
    expect(rules).toContain('ending in "?"');
    expect(rules).toContain("answers its question in its first one or two sentences");
  });

  it("offers the data section only with publishable measurements, and never the weak early ones", () => {
    const facts = "Between September and November 2026 we tested 400 prompts across three answer engines.\nWe publish for 14 sites.";
    const withData = writingRules({ keyword: "k", language: "en", firstHandFacts: facts });
    expect(withData).toContain("<h2>From our data</h2>");
    expect(withData).toContain("  - Between September and November 2026 we tested 400 prompts across three answer engines.");
    expect(withData).not.toContain("  - We publish for 14 sites.");
    expect(withData).toContain("none from the search evidence");
    expect(withData).toContain("If none of them bears on the question, there is no such section.");

    // The fixture's only fact is weak early traction: no section.
    expect(rules).toContain('write no "From our data" section');
    expect(writingRules({ keyword: "k", language: "en" })).toContain('write no "From our data" section');
  });

  it("gives the writer the plan's question as the heading when the planned heading is a statement", () => {
    expect(sectionHeading({ heading: "Filling it", question: "How do you fill a content calendar?" })).toBe("How do you fill a content calendar?");
    expect(sectionHeading({ heading: "Who owns it?", question: "Who should own a calendar?" })).toBe("Who owns it?");
    expect(sectionHeading({ heading: "Filling it", question: "Filling it" })).toBe("Filling it");
  });

  it("puts the short version and the question headings into the writer's plan", async () => {
    const seen = stub({ text: "<h1>T</h1><p>Body</p>" });
    await runAgent(
      writingAgent,
      { keyword: "content calendar", language: "en", outline: { ...OUTLINE, shortVersion: "Plan four weeks ahead; one person owns it." }, ...business },
      ctx()
    );
    expect(seen[0].prompt).toContain('The short version (the paragraph right after the <h1>, labelled "The short version:"): Plan four weeks ahead; one person owns it.');
    expect(seen[0].prompt).toContain("1. H2: What goes in it?");
  });

  it("is in the revision's rules too, with how to fix each anatomy problem", async () => {
    const seen = stub({ text: "<h1>T</h1><p>Revised</p>" });
    await runAgent(
      revisionAgent,
      { keyword: "k", language: "en", draftHtml: "<h1>T</h1><p>Draft.</p>", problems: ["The article does not open with the short version."] },
      ctx()
    );
    expect(seen[0].prompt).toContain("No short version, or a long one: write it");
    expect(seen[0].prompt).toContain("Headings that are not questions: rephrase them");
    expect(seen[0].prompt).toContain("<p><strong>The short version:</strong> …</p>");
  });

  it("asks the outline for the short version and question headings", async () => {
    const seen = stub({ structured: { ...OUTLINE, shortVersion: "  Plan four weeks ahead.  " } });
    const outline = await runAgent(outlineAgent, { keyword: "content calendar", language: "en", ...business, evidence }, ctx());
    expect(seen[0].prompt).toContain("shortVersion: the direct answer to the article's question in 3 to 6 sentences");
    expect(seen[0].prompt).toContain('Most section headings are the questions people actually ask, written as questions ending in "?"');
    expect(seen[0].prompt).toContain("at least half of them must be");
    expect(outline.shortVersion).toBe("Plan four weeks ahead.");
  });

  it("asks the internal links for up to eight, aiming for as many as genuinely fit", async () => {
    const seen = stub({ structured: { links: [] } });
    const targets = Array.from({ length: 10 }, (_, i) => ({ articleId: `a${i}`, title: `T${i}`, keyword: `k${i}`, excerpt: "E." }));
    await runAgent(internalLinksAgent, { language: "en", sourceTitle: "S", sourceBodyText: "Body text.", targets, maxLinks: 8 }, ctx());
    expect(seen[0].prompt).toContain("Select AT MOST 8 link(s), and aim for 8 when the targets genuinely fit");
    expect(internalLinksAgent.version).toBe(2);
  });

  it("bumps the versions of the agents whose prompts changed", () => {
    expect(writingAgent.version).toBe(4);
    expect(revisionAgent.version).toBe(4);
    expect(outlineAgent.version).toBe(6);
    expect(aeoAgent.version).toBe(5);
  });
});

describe("writing agent", () => {
  it("is given the search evidence, and asks for the writer role on the quality tier, kept", async () => {
    const seen = stub({ text: "<h1>T</h1><p>Body</p>" });
    await runAgent(writingAgent, { keyword: "content calendar", language: "English", outline: OUTLINE, ...business, evidence }, ctx());

    expect(seen[0].prompt).toContain("Free Content Calendar Template");
    expect(seen[0].prompt).toContain("What should a content calendar include?");
    expect(seen[0].prompt).toContain("Download a free template used by 30,000 marketers.");
    expect(seen[0].options).toMatchObject({ tier: "quality", keepTier: true });
  });

  it("records the model that wrote the article and whether it was a fallback", async () => {
    stub({
      text: "<h1>T</h1><p>Body</p>",
      usage: { ...usage, model: "fast-model", fallback: true, tierDowngraded: true },
    });
    const written = await runAgent(writingAgent, { keyword: "k", language: "English", outline: OUTLINE }, ctx());
    expect(written).toMatchObject({ model: "fast-model", fallback: true, tierDowngraded: true });
  });

  it("says the model was not a fallback when the provider did not flag one", async () => {
    stub({ text: "<h1>T</h1><p>Body</p>" });
    const written = await runAgent(writingAgent, { keyword: "k", language: "English", outline: OUTLINE }, ctx());
    expect(written).toMatchObject({ model: "stub", fallback: false, tierDowngraded: false });
  });
});

describe("revision agent", () => {
  it("names every problem, carries the same rules and the whole draft, on the quality tier", async () => {
    const seen = stub({ text: "<h1>T</h1><p>Revised</p>" });
    const draftHtml = "<h1>Mastering Content</h1><p>Plans start from ~$49/month.</p>";
    const revised = await runAgent(
      revisionAgent,
      {
        keyword: "content calendar",
        language: "English",
        draftHtml,
        problems: ["The title needs rewriting: it leans on \"Mastering\".", "The article states a figure found neither in the facts nor in the research."],
        ...business,
        evidence,
      },
      ctx()
    );

    const { prompt, options } = seen[0];
    expect(prompt).toContain('1. The title needs rewriting: it leans on "Mastering".');
    expect(prompt).toContain("2. The article states a figure");
    expect(prompt).toContain(draftHtml);
    expect(prompt).toContain("At most 60 characters");
    expect(prompt).toContain("These are the ONLY first-hand facts");
    expect(options).toMatchObject({ tier: "quality", keepTier: true });
    expect(revised.html).toBe("<h1>T</h1><p>Revised</p>");
  });
});

describe("outline agent", () => {
  it("is told the title, heading, FAQ and facts rules, and gets the questions people ask", async () => {
    const seen = stub({ structured: OUTLINE });
    await runAgent(outlineAgent, { keyword: "content calendar", language: "English", ...business, evidence }, ctx());

    const { prompt } = seen[0];
    expect(prompt).toContain("At most 60 characters");
    expect(prompt).toContain("Blueprint");
    expect(prompt).toContain("5 to 8 sections");
    expect(prompt).toContain("150 words or more");
    expect(prompt).toContain("FAQ: 3 to 5 real questions, or none");
    expect(prompt).toContain('Prefer the "People also ask" questions');
    expect(prompt).toContain("How do I create a content calendar for free?");
    expect(prompt).toContain("These are the ONLY first-hand facts and numbers you may state");
    expect(prompt).toContain("That is a ceiling for most keywords");
    expect(prompt).toContain("In today's competitive digital landscape");
    expect(prompt).toContain("must not mention the business");
  });

  it("drops an FAQ of one or two questions and caps it at five", async () => {
    stub({ structured: { ...OUTLINE, faq: OUTLINE.faq.slice(0, 1) } });
    expect((await runAgent(outlineAgent, { keyword: "k", language: "English" }, ctx())).faq).toEqual([]);

    stub({ structured: { ...OUTLINE, faq: Array.from({ length: 7 }, (_, i) => ({ question: `Q${i}?`, answer: "A." })) } });
    expect((await runAgent(outlineAgent, { keyword: "k", language: "English" }, ctx())).faq).toHaveLength(5);
  });
});

describe("audit agent", () => {
  const AUDIT = { score: 70, metaTitle: "A content calendar a small team keeps", metaDescription: "What goes in it and how to keep it.", findings: [] };

  it("reads the whole body: the last sentence of a 3,600-word article is in the prompt", async () => {
    const seen = stub({ structured: AUDIT });
    const bodyText = `${Array.from({ length: 3600 }, (_, i) => `word${i}`).join(" ")} THE-LAST-SENTENCE.`;
    expect(bodyText.length).toBeGreaterThan(12000);

    await runAgent(
      aeoAgent,
      { keyword: "content calendar", language: "English", title: "T", headings: [], bodyText },
      ctx()
    );

    expect(seen[0].prompt).toContain("THE-LAST-SENTENCE.");
    expect(seen[0].prompt).toContain("it is not truncated");
  });

  it("keeps the meta title within what a search result shows", async () => {
    stub({ structured: { ...AUDIT, metaTitle: "A very long meta title that goes on and on well past what a search result will ever show" } });
    const audit = await runAgent(aeoAgent, { keyword: "k", language: "English", title: "T", headings: [], bodyText: "Body." }, ctx());
    expect(audit.metaTitle.length).toBeLessThanOrEqual(60);
  });

  it("is told the author's own data, the site and the evidence, and the categories that hold an article (2026-11-12)", async () => {
    const seen = stub({ structured: AUDIT });
    await runAgent(
      aeoAgent,
      {
        keyword: "ai seo content writer",
        language: "English",
        title: "T",
        headings: [],
        bodyText: "Body.",
        businessName: "GetTrafficFast",
        websiteUrl: "https://gettrafficfa.st",
        firstHandFacts: "In my own Search Console, Sep to Nov 2026, 9 to 342 weekly impressions.",
        evidence: { results: [{ title: "AI writers compared", domain: "x.test", snippet: "A snippet." }], questions: [], relatedSearches: [] },
      },
      ctx()
    );
    const prompt = seen[0].prompt;
    expect(prompt).toContain("The author's own verified first-hand data");
    expect(prompt).toContain("9 to 342 weekly impressions");
    expect(prompt).toContain("never an E-E-A-T problem and never critical");
    expect(prompt).toContain("The publisher's only website: https://gettrafficfa.st");
    expect(prompt).toContain("AI writers compared");
    expect(prompt).toContain('"invented_fact"');
    expect(prompt).toContain("Only the first four categories ever hold an article back");
  });

  it("files every finding under a category, and a category it makes up as editorial", async () => {
    stub({
      structured: {
        ...AUDIT,
        findings: [
          { area: "eeat", severity: "critical", message: "A made-up price.", category: "invented_fact" },
          { area: "structure", severity: "critical", message: "Two sections overlap.", category: "vibes" },
          { area: "intent", severity: "warning", message: "No category at all." },
        ],
      },
    });
    const audit = await runAgent(aeoAgent, { keyword: "k", language: "English", title: "T", headings: [], bodyText: "Body." }, ctx());
    expect(audit.findings.map((f) => f.category)).toEqual(["invented_fact", "editorial", "editorial"]);
  });
});

describe("the intent gate", () => {
  it("says an article cannot rank when the results are all tools (content calendar generator: 8 of 8)", () => {
    expect(guideCanRank({ intent: "transactional", articleResults: 0, resultsRead: 8 })).toBe(false);
    expect(guideCanRank({ intent: "navigational", articleResults: 1, resultsRead: 10 })).toBe(false);
  });

  it("lets an article through when articles rank, when the intent is informational, or when the count is unknown", () => {
    expect(guideCanRank({ intent: "transactional", articleResults: 3, resultsRead: 8 })).toBe(true);
    expect(guideCanRank({ intent: "informational", articleResults: 0, resultsRead: 8 })).toBe(true);
    expect(guideCanRank({ intent: "commercial", articleResults: 0, resultsRead: 8 })).toBe(true);
    expect(guideCanRank({ intent: "transactional", articleResults: null, resultsRead: 8 })).toBe(true);
    expect(guideCanRank({ intent: "transactional", articleResults: 0, resultsRead: 3 })).toBe(true);
  });

  it("asks the analysis to count the articles among the results, and bounds the answer", async () => {
    const seen = stub({
      structured: { intent: "transactional", difficulty: 60, angle: "A", questions: [], gaps: [], articleResults: 14 },
    });
    const results = Array.from({ length: 8 }, (_, i) => ({
      position: i + 1,
      title: `Free Content Calendar Generator ${i}`,
      domain: `tool${i}.com`,
      snippet: "Generate a calendar.",
    }));
    const analysis = await runAgent(serpAnalysisAgent, { keyword: "content calendar generator", language: "English", results, peopleAlsoAsk: [], relatedSearches: [] }, ctx());

    expect(seen[0].prompt).toContain("of the 8 results listed, how many are articles");
    expect(analysis.articleResults).toBe(8);
    expect(analysis.resultsRead).toBe(8);
  });

  it("reads a missing count as unknown, never as zero", async () => {
    stub({ structured: { intent: "transactional", difficulty: 60, angle: "A" } });
    const analysis = await runAgent(
      serpAnalysisAgent,
      { keyword: "k", language: "English", results: [{ position: 1, title: "T", domain: "d.com", snippet: "s" }], peopleAlsoAsk: [], relatedSearches: [] },
      ctx()
    );
    expect(analysis.articleResults).toBeNull();
  });
});
