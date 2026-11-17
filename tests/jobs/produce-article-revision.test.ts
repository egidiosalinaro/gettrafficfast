import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { z } from "zod";
import { StepIncomplete, TerminalStepError, type JobRow } from "@/lib/jobs/types";
import {
  INTENT_SKIP_REASON,
  RESEARCH_HOLD_PREFIX,
  isIntentSkip,
  produceArticleWorkflow,
} from "@/lib/jobs/workflows/produce-article";
import { setLlmProvider } from "@/lib/providers/llm/registry";
import type { LLMProvider, LlmStructuredResult, LlmTextResult } from "@/lib/providers/llm/types";
import { setSerpProvider } from "@/lib/providers/serp/registry";
import type { SerpData } from "@/lib/providers/serp/types";
import { FakeSupabase } from "../support/fake-supabase";

/**
 * The production workflow from research to `revise`, against a stub model
 * and an in-memory database: the revision runs once and only when something
 * was found, an article that is still wrong afterwards waits for a person,
 * the intent gate skips without writing, and failed research holds.
 */

const emails = vi.hoisted(() => ({ sent: [] as Array<{ to: string; subject: string; html: string }> }));
vi.mock("@/lib/notifications/email", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/notifications/email")>()),
  sendNotificationEmail: async (input: { to: string; subject: string; html: string }) => {
    emails.sent.push(input);
    return true;
  },
}));

/** The owner's About you as it was on 12 November 2026: for replies, never for articles. */
const OWNER_ABOUT =
  "Former agency designer, learned to code at night. Co-founded Postwren, email marketing for Shopify stores: 12 paying stores in October 2026. Since late September an AI pipeline writes and publishes my own blog: 9 impressions a week at the start, 342 in the week of Oct 26, still 0 clicks, articles sit around position 30-40. Left Porto on Oct 27 2026, working from Taipei.";

const words = (n: number, word = "calendar") => Array.from({ length: n }, () => word).join(" ");

function draft(options: { title?: string; intro?: string; extra?: string } = {}): string {
  // The anatomy every article has since 2026-11-15: the short version
  // first, section headings that are questions.
  const sections = ["What goes in it?", "How do you fill it?", "How do you keep it?", "Who owns it?", "What to do next"]
    .map((heading) => `<h2>${heading}</h2><p>${words(140)}.</p>`)
    .join("");
  return `<h1>${options.title ?? "How to build a content calendar"}</h1><p><strong>The short version:</strong> A calendar lists what goes out, where and when. One person owns it. It is filled four weeks ahead.</p><p>${
    options.intro ?? "A content calendar says what is published, where and when."
  }</p>${options.extra ?? ""}${sections}`;
}

const CLEAN = draft();
const FLAWED = draft({
  intro: "In today's competitive digital landscape, planning matters.",
  extra: "<p>Competitors offer paid plans starting from ~$49/month.</p>",
});

const OUTLINE = {
  title: "How to build a content calendar",
  angle: "A calendar a small team keeps",
  intro: "Open with the week nobody knew what to publish.",
  sections: ["What goes in it", "How to fill it", "How to keep it"].map((heading) => ({
    heading,
    question: `${heading}?`,
    answer: "A direct answer.",
    points: ["One"],
    subsections: [],
  })),
  faq: [],
  entities: [],
};

type Audit = { score: number; findings: { area: string; severity: string; message: string }[] };
const audit = (score: number, findings: Audit["findings"] = []) => ({
  score,
  metaTitle: "A content calendar a small team keeps",
  metaDescription: "What goes in a content calendar and how to keep it.",
  findings,
});

interface Script {
  drafts: string[];
  audits: ReturnType<typeof audit>[];
  analysis?: Record<string, unknown>;
}

function model(script: Script) {
  const calls = { text: [] as string[], audits: [] as string[], outlines: 0, analyses: 0, structured: [] as string[] };
  const usage = { model: "quality-model", inputTokens: 1000, outputTokens: 1000, costUsd: 0.01 };
  const llm: LLMProvider = {
    name: "stub",
    async generateText(prompt): Promise<LlmTextResult> {
      calls.text.push(prompt);
      const html = script.drafts[calls.text.length - 1];
      if (html === undefined) throw new Error("the writer was called more often than the test expects");
      return { text: html, usage };
    },
    async generateStructured<T>(prompt: string, schema: z.ZodType<T>): Promise<LlmStructuredResult<T>> {
      calls.structured.push(prompt);
      let value: unknown;
      if (prompt.includes("You are auditing an article")) {
        calls.audits.push(prompt);
        value = script.audits[calls.audits.length - 1];
        if (value === undefined) throw new Error("the audit was called more often than the test expects");
      } else if (prompt.includes("analysing the REAL Google results")) {
        calls.analyses += 1;
        value = script.analysis ?? { intent: "informational", difficulty: 40, angle: "A", articleResults: 7 };
      } else {
        calls.outlines += 1;
        value = OUTLINE;
      }
      return { value: schema.parse(value), usage: { ...usage, model: "fast-model" }, raw: "" };
    },
  };
  setLlmProvider(llm);
  return calls;
}

function serp(results: { title: string; domain: string; snippet: string }[]): SerpData {
  return {
    keyword: "content calendar",
    results: results.map((r, i) => ({ ...r, position: i + 1, url: `https://${r.domain}/` })),
    peopleAlsoAsk: ["What should a content calendar include?"],
    relatedSearches: [],
    raw: null,
  };
}

const ARTICLES = serp(
  Array.from({ length: 8 }, (_, i) => ({
    title: `How to plan a content calendar ${i}`,
    domain: `blog${i}.com`,
    snippet: "A guide to planning.",
  }))
);
const TOOLS = serp(
  Array.from({ length: 8 }, (_, i) => ({
    title: `Free Content Calendar Generator ${i}`,
    domain: `tool${i}.com`,
    snippet: "Generate a calendar in one click.",
  }))
);

function job(): JobRow {
  return {
    id: "job-1",
    user_id: "user-1",
    article_id: "article-1",
    type: "produce-article",
    input: { articleId: "article-1" },
    status: "running",
    current_step: null,
    attempts: 1,
    max_attempts: 3,
    last_error: null,
  };
}

describe("produce-article: research, revision and settling", () => {
  let db: FakeSupabase;
  let searches: number;
  const supabase = () => db as unknown as SupabaseClient;
  const row = () => db.tables.articles[0] as Record<string, unknown>;
  const runs = (agent: string) => db.tables.agent_runs.filter((r) => r.agent === agent);

  function seed(article: Record<string, unknown> = {}) {
    db = new FakeSupabase({
      articles: [
        {
          id: "article-1",
          user_id: "user-1",
          business_id: "biz-1",
          keyword_id: "kw-1",
          scheduled_date: "2026-11-12",
          status: "queued",
          attempt_count: 0,
          last_error: null,
          keywords: { keyword: "content calendar" },
          ...article,
        },
      ],
      businesses: [
        {
          id: "biz-1",
          name: "GetTrafficFast",
          niche: "Content platform",
          description: "Plans and writes articles.",
          website_url: "https://gettrafficfa.st",
          content_language: "en",
          media_settings: null,
          // About you is the owner's real one (2026-11-12): true, candid,
          // and not for the blog. Facts for articles is what articles read.
          voice_settings: { aboutYou: OWNER_ABOUT, articleFacts: "We publish for 14 sites.", instructions: "" },
        },
      ],
      article_events: [],
      serp_snapshots: [],
      competitors: [],
    });
    (db.auth.admin as { getUserById: unknown }).getUserById = async () => ({
      data: { user: { email: "owner@example.test" } },
      error: null,
    });
  }

  function search(answer: SerpData | Error) {
    searches = 0;
    setSerpProvider({
      name: "stub-serp",
      async search() {
        searches += 1;
        if (answer instanceof Error) throw answer;
        return answer;
      },
    });
  }

  /** Runs the named steps in order, as the worker does, feeding each the outputs so far. */
  async function run(names: string[], outputs: Record<string, unknown> = {}) {
    for (const name of names) {
      const step = produceArticleWorkflow.steps.find((s) => s.name === name)!;
      outputs[name] = (await step.run({ job: job(), supabase: supabase(), input: job().input, outputs })) ?? null;
    }
    return outputs;
  }

  const ALL = ["research", "outline", "write", "validate", "audit", "revise", "settle"];

  beforeEach(() => {
    emails.sent.length = 0;
    seed();
    search(ARTICLES);
  });

  afterEach(() => {
    setLlmProvider(null);
    setSerpProvider(undefined);
    vi.restoreAllMocks();
  });

  it("has the revision and the settling between the audit and the enrichment", () => {
    expect(produceArticleWorkflow.steps.map((s) => s.name)).toEqual([
      "arm",
      "research",
      "outline",
      "write",
      "validate",
      "audit",
      "revise",
      "settle",
      "enrich",
      "knowledge",
    ]);
  });

  it("does not revise a draft nothing was found in: one write, one audit, generated", async () => {
    const calls = model({ drafts: [CLEAN], audits: [audit(82)] });

    const outputs = await run(ALL);

    expect(calls.text).toHaveLength(1);
    expect(calls.audits).toHaveLength(1);
    expect(runs("article-revision")).toHaveLength(0);
    expect(outputs.settle).toMatchObject({ revised: false, status: "generated", writerModel: "quality-model", writerFallback: false });
    expect(row().status).toBe("generated");
    expect(emails.sent).toHaveLength(0);
  });

  it("keeps the article in generating between validation and the revision, so a draft cannot publish early", async () => {
    model({ drafts: [FLAWED], audits: [] });
    const outputs = await run(["research", "outline", "write", "validate"]);
    expect(row().status).toBe("generating");
    expect(row().canonical).toBeTruthy();
    expect((outputs.validate as { decision: string }).decision).toBe("needs_review");
  });

  it("revises once with the findings named, then re-runs the gates and the audit once", async () => {
    const calls = model({
      drafts: [FLAWED, CLEAN],
      audits: [audit(55, [{ area: "eeat", severity: "warning", message: "The pricing claim has no source." }]), audit(80)],
    });

    const outputs = await run(ALL);

    expect(calls.text).toHaveLength(2);
    expect(calls.audits).toHaveLength(2);
    const rewrite = calls.text[1];
    expect(rewrite).toContain("In today's competitive digital landscape");
    expect(rewrite).toContain("starting from ~$49/month");
    expect(rewrite).toContain("[eeat, warning] The pricing claim has no source.");
    expect(rewrite).toContain("https://gettrafficfa.st");
    expect(rewrite).toContain("We publish for 14 sites.");

    // Both runs are recorded.
    expect(runs("writing")).toHaveLength(1);
    expect(runs("article-revision")).toHaveLength(1);
    expect(runs("aeo-audit")).toHaveLength(2);

    expect(outputs.settle).toMatchObject({ revised: true, status: "generated", model: "quality-model", remaining: 0 });
    expect(row().status).toBe("generated");
    expect(row().raw_content).toBe(CLEAN);
    expect(row().last_error).toBeNull();
    const report = row().quality_report as { revision: { ran: boolean; before: { issues: string[] }; after: { issues: string[]; aeoScore: number } } };
    expect(report.revision.ran).toBe(true);
    expect(report.revision.before.issues).toEqual(expect.arrayContaining(["STOCK_PHRASE", "UNSUPPORTED_NUMBER"]));
    expect(report.revision.after.issues).toEqual([]);
    expect(report.revision.after.aeoScore).toBe(80);
    expect(emails.sent).toHaveLength(0);
  });

  it("puts the audit's title and description on the canonical document", async () => {
    model({ drafts: [CLEAN], audits: [audit(82)] });
    await run(ALL);
    const canonical = row().canonical as { metaTitle?: string; metaDescription: string };
    expect(canonical.metaTitle).toBe("A content calendar a small team keeps");
    expect(canonical.metaDescription).toBe("What goes in a content calendar and how to keep it.");
  });

  it("sends the article to needs_review when the revision still states the invented figure, and never revises twice", async () => {
    const calls = model({ drafts: [FLAWED, FLAWED], audits: [audit(55), audit(55)] });

    const outputs = await run(ALL);

    expect(calls.text).toHaveLength(2);
    // A revision no better on any measure is not kept (2026-11-12).
    expect(outputs.settle).toMatchObject({ revised: false, status: "needs_review" });
    expect((row().quality_report as { revision: { ran: boolean; kept: string } }).revision).toMatchObject({ ran: true, kept: "original" });
    expect(row().status).toBe("needs_review");
    expect(String(row().last_error)).toContain("found neither in the business's own facts nor in the research");
    expect(String(row().last_error)).toContain("$49/month");
    expect(emails.sent).toHaveLength(1);
  });

  it("revises on a critical audit finding alone, and holds the article if it is still critical in a blocking category", async () => {
    const critical = [
      { area: "eeat", severity: "critical", category: "invented_fact", message: "The article says the tool has 3,000 users; nothing supports it." },
    ];
    const calls = model({ drafts: [CLEAN, CLEAN], audits: [audit(48, critical), audit(50, critical)] });

    const outputs = await run(ALL);

    expect(calls.text).toHaveLength(2);
    expect(calls.text[1]).toContain("[eeat, critical] The article says the tool has 3,000 users");
    // The revision scored higher with nothing else changed: it is kept, and still held.
    expect(outputs.settle).toMatchObject({ revised: true, status: "needs_review" });
    expect(String(row().last_error)).toContain("The audit found an invented fact or figure");
    const report = row().quality_report as { blocking: { code: string }[]; aeo: { findings: { category: string }[] } };
    expect(report.blocking.map((b) => b.code)).toEqual(["audit:invented_fact"]);
    expect(report.aeo.findings[0].category).toBe("invented_fact");
  });

  it("revises on an editorial critical but never holds the article for it", async () => {
    const critical = [{ area: "intent", severity: "critical", message: "The title promises a ranking the body does not contain." }];
    const calls = model({ drafts: [CLEAN, CLEAN], audits: [audit(48, critical), audit(50, critical)] });

    const outputs = await run(ALL);

    expect(calls.text).toHaveLength(2);
    expect(calls.text[1]).toContain("[intent, critical] The title promises a ranking");
    expect(outputs.settle).toMatchObject({ status: "generated" });
    expect(row().last_error).toBeNull();
    const report = row().quality_report as { blocking: unknown[]; aeo: { findings: { category: string; severity: string }[] } };
    expect(report.blocking).toEqual([]);
    // Stored as it was found, with its category.
    expect(report.aeo.findings[0]).toMatchObject({ severity: "critical", category: "editorial" });
  });

  it("does not revise on info findings", async () => {
    const calls = model({ drafts: [CLEAN], audits: [audit(75, [{ area: "entities", severity: "info", message: "Could name more tools." }])] });
    await run(ALL);
    expect(calls.text).toHaveLength(1);
    expect(row().status).toBe("generated");
  });

  it("keeps the first draft when the revision is not an article", async () => {
    model({ drafts: [FLAWED, "I cannot do that."], audits: [audit(55)] });
    const outputs = await run(ALL);
    expect(outputs.settle).toMatchObject({ revised: false, status: "needs_review" });
    expect(row().raw_content).toBe(FLAWED);
    const report = row().quality_report as { revision: { ran: boolean; reason: string } };
    expect(report.revision).toMatchObject({ ran: false });
    expect(report.revision.reason).toContain("not a usable article");
  });

  it("does not pay for the rewrite twice when the settling is re-entered", async () => {
    const calls = model({ drafts: [FLAWED, CLEAN], audits: [audit(55), audit(80), audit(80)] });
    const outputs = await run(["research", "outline", "write", "validate", "audit", "revise"]);
    expect((outputs.revise as { revised: boolean; html: string }).html).toBe(CLEAN);

    // The tick ended here; the worker resumes at `settle` with the checkpoint.
    await run(["settle"], outputs);

    expect(calls.text).toHaveLength(2);
    expect(row().status).toBe("generated");
  });

  it("does not start a revision the article's budget cannot carry, and says so", async () => {
    const calls = model({ drafts: [FLAWED], audits: [audit(55)] });
    db.tables.agent_runs.push({ job_id: "job-1", agent: "earlier", cost_usd: 0.42 });

    const outputs = await run(ALL);

    expect(calls.text).toHaveLength(1);
    expect(runs("article-revision")).toHaveLength(0);
    expect(outputs.settle).toMatchObject({ revised: false, status: "needs_review" });
    expect(String((outputs.settle as { reason: string }).reason)).toContain("budget");
  });

  it("settles a validated article when the job stops before the revision", async () => {
    model({ drafts: [FLAWED], audits: [] });
    const outputs = await run(["research", "outline", "write", "validate"]);

    await produceArticleWorkflow.onFailure!({ job: job(), supabase: supabase(), error: "boom", outputs });

    expect(row().status).toBe("needs_review");
    expect(emails.sent).toHaveLength(1);
    expect(emails.sent[0].subject).not.toMatch(/failed/i);
  });

  it("gives the outline and the writer the evidence, the first-hand facts and the real site", async () => {
    const calls = model({ drafts: [CLEAN], audits: [audit(82)] });
    const outputs = await run(ALL);
    expect(calls.text[0]).toContain("How to plan a content calendar 0");
    expect(calls.text[0]).toContain("What should a content calendar include?");
    expect(calls.text[0]).toContain("We publish for 14 sites.");
    expect(calls.text[0]).toContain("The business's only website is https://gettrafficfa.st");
    expect(outputs.write).toMatchObject({ model: "quality-model", fallback: false });
  });

  describe("the intent gate", () => {
    const analysis = { intent: "transactional", difficulty: 70, angle: "A", articleResults: 0 };

    it("skips an article when the results are all tools: nothing written, no attempt, a reason a person can read", async () => {
      search(TOOLS);
      const calls = model({ drafts: [], audits: [], analysis });

      const error = await run(["research"]).catch((err) => err);

      expect(error).toBeInstanceOf(TerminalStepError);
      expect(error.message).toBe(INTENT_SKIP_REASON);
      expect(error.message).toContain("Google shows only tools");
      expect(calls.outlines).toBe(0);
      expect(calls.text).toHaveLength(0);

      await produceArticleWorkflow.onFailure!({ job: job(), supabase: supabase(), error: error.message, outputs: {} });

      expect(row().status).toBe("failed");
      expect(row().last_error).toBe(INTENT_SKIP_REASON);
      expect(row().attempt_count).toBe(0);
      expect(emails.sent).toHaveLength(0);
      expect(isIntentSkip(String(row().last_error))).toBe(true);
    });

    it("writes it when a person starts the skipped article again", async () => {
      seed({ status: "failed", last_error: INTENT_SKIP_REASON });
      search(TOOLS);
      model({ drafts: [CLEAN], audits: [audit(70)], analysis });

      const outputs = await run(ALL);

      expect(outputs.research).toMatchObject({ canRank: false });
      expect(row().status).toBe("generated");
    });

    it("does not skip when articles rank for a transactional search", async () => {
      model({ drafts: [], audits: [], analysis: { ...analysis, articleResults: 4 } });
      const outputs = await run(["research"]);
      expect(outputs.research).toMatchObject({ canRank: true });
    });
  });

  describe("research that fails", () => {
    it("retries once, then holds the article in the queue with a reason instead of writing blind", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      search(new Error("Serper request failed: 503"));
      const calls = model({ drafts: [], audits: [] });

      const error = await run(["research"]).catch((err) => err);

      expect(searches).toBe(2);
      expect(error).toBeInstanceOf(StepIncomplete);
      expect(error.resumeAfterSeconds).toBe(3600);
      expect(calls.outlines).toBe(0);
      expect(row().status).toBe("queued");
      expect(String(row().last_error)).toContain(RESEARCH_HOLD_PREFIX);
      expect(row().attempt_count).toBe(0);
    });

    it("goes on when the retry works, having searched at most twice", async () => {
      let first = true;
      searches = 0;
      setSerpProvider({
        name: "stub-serp",
        async search() {
          searches += 1;
          if (first) {
            first = false;
            throw new Error("Serper request failed: 503");
          }
          return ARTICLES;
        },
      });
      model({ drafts: [], audits: [] });
      const outputs = await run(["research"]);
      expect(searches).toBe(2);
      expect(outputs.research).toMatchObject({ canRank: true });
    });

    it("still writes without research when no search provider is configured", async () => {
      setSerpProvider(null);
      model({ drafts: [CLEAN], audits: [audit(80)] });
      const outputs = await run(ALL);
      expect(outputs.research).toEqual({ skipped: "no SERP provider configured" });
      expect(row().status).toBe("generated");
    });
  });
  describe("Facts for articles, never About you (2026-11-12)", () => {
    const voice = (settings: Record<string, unknown>) => {
      (db.tables.businesses[0] as Record<string, unknown>).voice_settings = settings;
    };
    const WEAK =
      "<p>On my own blog the articles went from 9 to 342 weekly impressions, still 0 clicks, around position 30-40.</p>";

    it("never hands About you to any article agent: outline, writer, audit or revision", async () => {
      const calls = model({ drafts: [FLAWED, CLEAN], audits: [audit(55), audit(80)] });
      await run(ALL);
      const prompts = [...calls.text, ...calls.structured];
      expect(prompts.length).toBeGreaterThanOrEqual(5);
      for (const prompt of prompts) {
        expect(prompt).not.toContain("342 in the week");
        expect(prompt).not.toContain("Taipei");
        expect(prompt).not.toContain("Postwren");
      }
      expect(calls.text[0]).toContain("We publish for 14 sites.");
      expect(calls.text[0]).toContain("attribute it in the same sentence");
    });

    it("with Facts for articles empty, the writer is told to state no first-hand results at all", async () => {
      voice({ aboutYou: OWNER_ABOUT, articleFacts: "", instructions: "" });
      const calls = model({ drafts: [CLEAN], audits: [audit(82)] });
      await run(ALL);
      expect(calls.text[0]).toContain("No first-hand facts are on record for this article");
      expect(calls.text[0]).toContain("Use the first person only for method and opinion");
      expect(calls.text[0]).not.toContain("First-hand facts, in the owner's own words");
      expect(calls.text[0]).not.toContain("342");
    });

    it("holds an article that states a weak About you figure, and asks the revision to take it out", async () => {
      voice({ aboutYou: OWNER_ABOUT, articleFacts: "", instructions: "" });
      const weak = draft({ extra: WEAK });
      const calls = model({ drafts: [weak, weak], audits: [audit(62), audit(62)] });

      const outputs = await run(ALL);

      expect(calls.text).toHaveLength(2);
      expect(calls.text[1]).toContain("from About you");
      expect(outputs.settle).toMatchObject({ status: "needs_review" });
      expect(row().status).toBe("needs_review");
      expect(String(row().last_error)).toContain("figures from About you");
      expect(String(row().last_error)).toContain("342 weekly impressions");
    });

    it("lets the same figures through when the owner put them in Facts for articles, attributed with their period", async () => {
      const attributed =
        "In my own Search Console, between September and November 2026, the blog went from 9 to 342 weekly impressions.";
      voice({ aboutYou: OWNER_ABOUT, articleFacts: attributed, instructions: "" });
      const calls = model({ drafts: [draft({ extra: `<p>${attributed}</p>` })], audits: [audit(80)] });

      await run(ALL);

      expect(calls.text).toHaveLength(1);
      expect(calls.text[0]).toContain(attributed);
      expect(row().status).toBe("generated");
      const report = row().quality_report as { issues: { code: string }[] };
      expect(report.issues.map((i) => i.code)).not.toContain("PRIVATE_FACT");
    });
  });
  describe("the article held on 2026-11-12: AI SEO Content Writer: A Workflow From Draft to Clicks", () => {
    // A synthetic case shaped like a held article's quality_report:
    // first draft score 58, no gate issue, one critical E-E-A-T finding;
    // the revision scored 48 and named the product in two sentences.
    const REAL_FINDING = {
      area: "eeat",
      severity: "critical",
      message:
        "The article's central figures (9 to 342 weekly impressions, 0 clicks, positions 30 to 40) are presented without a Search Console export, date range or source, so readers cannot verify them.",
    };
    const FIGURES = "<p>My own blog went from 9 to 342 weekly impressions, with 0 clicks, at positions 30 to 40.</p>";
    const REAL_FIRST = draft({ title: "AI SEO Content Writer: A Workflow From Draft to Clicks", extra: FIGURES });
    const REAL_REVISED =
      REAL_FIRST +
      "<h2>Where to start</h2><p>GetTrafficFast plans and writes these articles. GetTrafficFast also publishes them to your site.</p>";
    const voice = (settings: Record<string, unknown>) => {
      (db.tables.businesses[0] as Record<string, unknown>).voice_settings = settings;
    };

    beforeEach(() => seed({ keywords: { keyword: "ai seo content writer" } }));

    it("is not held for the author's own figures when they are in Facts for articles: the finding becomes a suggestion", async () => {
      voice({
        aboutYou: OWNER_ABOUT,
        articleFacts:
          "In my own Search Console, from September to November 2026, my blog went from 9 to 342 weekly impressions, with 0 clicks, at positions 30 to 40.",
        instructions: "",
      });
      const calls = model({ drafts: [REAL_FIRST], audits: [audit(58, [REAL_FINDING])] });

      await run(ALL);

      // The audit was told whose figures they are.
      expect(calls.audits[0]).toContain("The author's own verified first-hand data");
      expect(calls.audits[0]).toContain("from 9 to 342 weekly impressions");
      // Cleared in code to an info suggestion: nothing to revise, nothing held.
      expect(calls.text).toHaveLength(1);
      expect(row().status).toBe("generated");
      const finding = (row().quality_report as { aeo: { findings: Record<string, string>[] } }).aeo.findings[0];
      expect(finding).toMatchObject({ severity: "info", category: "first_hand" });
      expect(finding.message).toContain("in my own Search Console, Sep–Nov 2026");
    });

    it("keeps the first draft when the revision is worse, and lists the one reason that still holds it", async () => {
      voice({ aboutYou: OWNER_ABOUT, articleFacts: "", instructions: "" });
      const calls = model({ drafts: [REAL_FIRST, REAL_REVISED], audits: [audit(58, [REAL_FINDING]), audit(48, [REAL_FINDING])] });

      const outputs = await run(ALL);

      expect(calls.text).toHaveLength(2);
      // The rewrite was told not to add the product.
      expect(calls.text[1]).toContain("Do NOT add any mention of GetTrafficFast");
      expect(outputs.settle).toMatchObject({ revised: false, status: "needs_review" });
      expect(row().raw_content).toBe(REAL_FIRST);
      const report = row().quality_report as {
        revision: { ran: boolean; kept: string; reason: string; before: Record<string, unknown>; after: Record<string, unknown> };
        blocking: { code: string; message: string }[];
      };
      expect(report.revision).toMatchObject({ ran: true, kept: "original" });
      expect(report.revision.reason).toContain("more gate issues");
      expect(report.revision.before).toMatchObject({ aeoScore: 58, critical: 1 });
      expect(report.revision.after).toMatchObject({ aeoScore: 48, critical: 1 });
      expect(report.revision.after.issues).toEqual(expect.arrayContaining(["PRODUCT_MENTION"]));
      // What holds it is the About you figures, not the E-E-A-T opinion.
      expect(report.blocking.map((b) => b.code)).toEqual(["PRIVATE_FACT"]);
      expect(String(row().last_error)).toBe(report.blocking[0].message);
      expect(String(row().last_error)).not.toContain("Search Console export");
    });
  });
});
