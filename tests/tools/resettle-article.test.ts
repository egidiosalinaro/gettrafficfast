import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runContentPipeline } from "@/lib/content/pipeline";
import { FakeSupabase } from "../support/fake-supabase";
import { HELD_LAST_ERROR, HELD_QUALITY_REPORT, OWNER_ABOUT_YOU } from "../fixtures/held-article-2026-11-12";
import { SITE_A, SITE_B, USER, apiCaller, businesses, uuid } from "./support";

/**
 * resettle_article: the held article of 2026-11-12 checked again under the
 * current rules, from its stored document and stored audit, with no model
 * call and no publication. Pinned: the E-E-A-T opinion no longer holds it;
 * the About you figures it states still do (owner's decision, 2026-11-12),
 * so it stays in needs_review and needs a Regenerate; with the figures in
 * Facts for articles it becomes generated and is left for the daily run;
 * the stored research is what figures are checked against; only a held
 * article of this site is re-settled.
 */

const mocks = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => mocks.db }));
vi.mock("@/lib/subscription", () => ({ hasActiveSubscription: async () => true }));

import { runTool } from "@/lib/tools/runner";

const HELD = uuid("a", 1);
const GENERATED = uuid("a", 2);
const ON_B = uuid("b", 1);

const words = (n: number) => Array.from({ length: n }, () => "draft").join(" ");
const sections = ["What the writer does", "How a draft is checked", "How it reaches the site", "What to measure", "What to do next"]
  .map((heading) => `<h2>${heading}</h2><p>${words(150)}.</p>`)
  .join("");
const FIGURES = "<p>My own blog went from 9 to 342 weekly impressions, with 0 clicks, at positions 30 to 40.</p>";

function canonical(extra: string) {
  const result = runContentPipeline({
    raw: `<h1>AI SEO Content Writer: A Workflow From Draft to Clicks</h1><p>An AI SEO content writer drafts, checks and publishes.</p>${extra}${sections}`,
    articleId: HELD,
    keyword: "ai seo content writer",
    slug: "ai-seo-content-writer",
    language: "en",
    scheduledDate: "2026-11-12",
  });
  if (!result.article) throw new Error("fixture did not canonicalise");
  return result.article;
}

function seed(voice: Record<string, unknown>, extra = FIGURES, research?: unknown) {
  const sites = businesses();
  sites[0].voice_settings = voice as typeof sites[0]["voice_settings"];
  const row = (id: string, businessId: string, status: string) => ({
    id,
    user_id: USER,
    business_id: businessId,
    keyword_id: `kw-${id}`,
    status,
    canonical: canonical(extra),
    content: "<p>stored</p>",
    quality_report: HELD_QUALITY_REPORT,
    last_error: status === "needs_review" ? HELD_LAST_ERROR : null,
    scheduled_date: "2026-11-12",
  });
  const db = new FakeSupabase({
    businesses: sites,
    articles: [row(HELD, SITE_A, "needs_review"), row(GENERATED, SITE_A, "generated"), row(ON_B, SITE_B, "needs_review")],
    jobs: research
      ? [{ id: "job-1", user_id: USER, business_id: SITE_A, article_id: HELD, type: "produce-article", status: "completed", created_at: "2026-11-12T06:00:00Z" }]
      : [],
    job_steps: research ? [{ job_id: "job-1", step: "research", status: "completed", output: research }] : [],
    article_events: [],
    publish_attempts: [],
    integrations: [],
    agent_runs: [],
    tool_calls: [],
  });
  mocks.db = db;
  return db;
}

const call = (db: FakeSupabase, input: unknown, scopes: Array<"read" | "write" | "spend" | "publish"> = ["read", "write"]) =>
  runTool(apiCaller(db, { scopes }), "resettle_article", input);
const article = (db: FakeSupabase, id = HELD) => db.tables.articles.find((a) => a.id === id) as Record<string, unknown>;

let quiet: Array<ReturnType<typeof vi.spyOn>>;
beforeEach(() => {
  quiet = (["info", "warn", "error", "log"] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => {}));
});
afterEach(() => quiet.forEach((spy) => spy.mockRestore()));

describe("resettle_article", () => {
  it("keeps today's article held: the E-E-A-T opinion is gone, the About you figures are not for the blog", async () => {
    const db = seed({ aboutYou: OWNER_ABOUT_YOU, articleFacts: "", instructions: "" });

    const result = await call(db, { articleId: HELD });

    expect(result).toMatchObject({ ok: true, output: { articleId: HELD, status: "needs_review", previousReasons: [HELD_LAST_ERROR] } });
    const reasons = (result as unknown as { output: { reasons: string[] } }).output.reasons;
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain("figures from About you");
    expect(reasons[0]).not.toContain("Search Console export");
    const row = article(db);
    expect(row.status).toBe("needs_review");
    expect(row.last_error).toBe(reasons[0]);
    const report = row.quality_report as { blocking: { code: string }[]; resettled: { previousReasons: string[] } };
    expect(report.blocking.map((b) => b.code)).toEqual(["PRIVATE_FACT"]);
    expect(report.resettled.previousReasons).toEqual([HELD_LAST_ERROR]);
    // Free: no model was asked.
    expect(db.tables.agent_runs).toEqual([]);
  });

  it("releases it to generated when the figures are the owner's Facts for articles, and publishes nothing", async () => {
    const db = seed({
      aboutYou: OWNER_ABOUT_YOU,
      articleFacts: "In my own Search Console, Sep to Nov 2026, my blog went from 9 to 342 weekly impressions, with 0 clicks, at positions 30 to 40.",
      instructions: "",
    });

    const result = await call(db, { articleId: HELD });

    expect(result).toMatchObject({ ok: true, output: { status: "generated", changed: true, reasons: [] } });
    const row = article(db);
    expect(row.status).toBe("generated");
    expect(row.last_error).toBeNull();
    const report = row.quality_report as { decision: string; blocking: unknown[]; aeo: { findings: { category: string; severity: string }[] } };
    expect(report.decision).toBe("publish");
    expect(report.blocking).toEqual([]);
    expect(report.aeo.findings[0]).toMatchObject({ category: "first_hand", severity: "info" });
    // The daily run publishes it on its date: this call delivered nothing.
    expect(db.tables.publish_attempts).toEqual([]);
    expect(row.published_url).toBeUndefined();
    expect(db.tables.article_events).toEqual([expect.objectContaining({ from_state: "needs_review", to_state: "generated" })]);
  });

  it("checks figures against the research the production job stored", async () => {
    const price = "<p>Most tools start at $49 a month.</p>";
    const research = { evidence: { results: [{ title: "Pricing", domain: "x.test", snippet: "Plans start at $49 a month." }], questions: [], relatedSearches: [] } };
    const withEvidence = seed({ aboutYou: "", articleFacts: "", instructions: "" }, price, research);
    expect(await call(withEvidence, { articleId: HELD })).toMatchObject({ ok: true, output: { status: "generated", evidenceFound: true } });

    const without = seed({ aboutYou: "", articleFacts: "", instructions: "" }, price);
    expect(await call(without, { articleId: HELD })).toMatchObject({ ok: true, output: { status: "needs_review", evidenceFound: false } });
  });

  it("re-settles only a held article of this site, and needs the write scope", async () => {
    const db = seed({ aboutYou: "", articleFacts: "", instructions: "" });
    expect(await call(db, { articleId: GENERATED })).toMatchObject({ ok: false, status: 409, error: { code: "invalid_state" } });
    expect(await call(db, { articleId: ON_B })).toMatchObject({ ok: false, status: 404 });
    expect(await call(db, { articleId: HELD }, ["read"])).toMatchObject({ ok: false, status: 403 });
    expect(article(db, ON_B).status).toBe("needs_review");
  });
});
