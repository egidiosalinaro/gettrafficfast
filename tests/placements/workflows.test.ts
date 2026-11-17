import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { z } from "zod";
import type { Discussion, DiscoveryProvider } from "@/lib/providers/discovery/types";
import { DiscoveryProviderError } from "@/lib/providers/discovery/types";
import { setDiscoveryProviders } from "@/lib/providers/discovery/registry";
import { setLlmProvider } from "@/lib/providers/llm/registry";
import type { LLMProvider, LlmStructuredResult, LlmTextResult } from "@/lib/providers/llm/types";
import { TerminalStepError, type StepContext } from "@/lib/jobs/types";
import { discoverWith, placementDiscoveryWorkflow } from "@/lib/jobs/workflows/placement-discovery";
import { MAX_WRITES, NO_ANGLE_MESSAGE, placementDraftWorkflow, problemsOf, removedTellsProblem } from "@/lib/jobs/workflows/placement-draft";
import { DECLINED_PREFIX, draftFailureForCard } from "@/lib/placements/draft-progress";
import { PROBLEM_MAX_CHARS, PlacementDraftInput } from "@/lib/agents/placement-draft";
import { recanonicalizeLegacyTargets, storeTargets } from "@/lib/placements/discovery";
import { FakeSupabase } from "../support/fake-supabase";

/**
 * The placement jobs against fakes: no network, real schemas, real rules,
 * real gate. What is asserted is what keeps the inbox honest — one row per
 * thread whoever found it, a rate limit stops one provider and not the run,
 * rules reject before the model is paid, and a draft that fails the gate is
 * not saved.
 */

const BUSINESS = {
  id: "biz-1",
  user_id: "user-1",
  name: "GetTrafficFast",
  niche: "AI SEO content",
  description: "Writes and measures content for search and AI answer engines.",
  website_url: "https://gettrafficfa.st",
  content_language: "en",
  aeo_settings: {},
  // The good draft says "for us" and "I run my own blog through": experience,
  // which is a claim the business has to have recorded as true. Drafts speak
  // as someone who uses the product, so this is how the writer uses it.
  voice_settings: { aboutYou: "I publish my own blog through GetTrafficFast." },
};

const thread = (over: Partial<Discussion> = {}): Discussion => ({
  externalId: "1abc2d",
  surface: "reddit",
  kind: "thread",
  url: "https://www.reddit.com/r/SEO/comments/1abc2d/x/",
  title: "How do I get my site cited by AI answer engines?",
  excerpt: "Our SEO is fine but ChatGPT never mentions us.",
  community: "r/SEO",
  author: "asker",
  createdAt: "2026-09-10T00:00:00Z",
  score: 30,
  commentCount: 12,
  ...over,
});

function provider(name: string, handler: (q: string) => Discussion[] | Promise<Discussion[]>): DiscoveryProvider {
  return { name, search: async (q) => handler(q.query) };
}

function ctx(db: FakeSupabase, input: Record<string, unknown>, outputs: Record<string, unknown> = {}): StepContext {
  return {
    job: {
      id: "job-1",
      user_id: "user-1",
      article_id: null,
      type: "x",
      input,
      status: "running",
      current_step: null,
      attempts: 1,
      max_attempts: 3,
      last_error: null,
    },
    supabase: db as unknown as SupabaseClient,
    input,
    outputs,
    deadline: Date.now() + 120_000,
  };
}

/** A moment `n` days before the test runs: the rules read the real clock. */
const daysBefore = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();

function step(workflow: { steps: Array<{ name: string; run: (c: StepContext) => Promise<unknown> }> }, name: string) {
  const found = workflow.steps.find((s) => s.name === name);
  if (!found) throw new Error(`no step ${name}`);
  return found;
}

const usage = { model: "stub", inputTokens: 10, outputTokens: 10, costUsd: 0.001 };
function stubLlm(structured: unknown): LLMProvider {
  return {
    name: "stub",
    async generateText(): Promise<LlmTextResult> {
      return { text: "", usage };
    },
    async generateStructured<T>(_prompt: string, schema: z.ZodType<T>): Promise<LlmStructuredResult<T>> {
      return { value: schema.parse(structured), usage, raw: "" };
    },
  };
}

describe("storeTargets", () => {
  let db: FakeSupabase;
  beforeEach(() => {
    db = new FakeSupabase({ placement_targets: [] });
  });

  it("stores one row for a thread found by two providers, keeping the first sighting", async () => {
    const stored = await storeTargets({
      supabase: db as unknown as SupabaseClient,
      userId: "user-1",
      businessId: "biz-1",
      targets: [
        { ...thread(), foundFor: "ai seo", foundVia: "reddit" },
        { ...thread({ score: null, commentCount: null, author: null }), foundFor: "aeo", foundVia: "web-search" },
      ],
    });
    expect(stored).toBe(1);
    expect(db.tables.placement_targets[0]).toMatchObject({ found_via: "reddit", score: 30, kind: "thread", content_hash: expect.any(String) });
    expect(db.tables.placement_targets[0].fresh_until).toBeTruthy();
  });

  it("skips a cross-post with the same question and bumps last_seen_at on the original", async () => {
    const supabase = db as unknown as SupabaseClient;
    await storeTargets({
      supabase,
      userId: "user-1",
      businessId: "biz-1",
      targets: [{ ...thread(), foundFor: "ai seo", foundVia: "reddit" }],
      now: new Date("2026-09-01T00:00:00Z"),
    });
    const stored = await storeTargets({
      supabase,
      userId: "user-1",
      businessId: "biz-1",
      targets: [{ ...thread({ externalId: "zzz999", community: "r/marketing", url: "https://www.reddit.com/r/marketing/comments/zzz999/x/" }), foundFor: "ai seo", foundVia: "reddit" }],
      now: new Date("2026-09-21T00:00:00Z"),
    });
    expect(stored).toBe(0);
    expect(db.tables.placement_targets).toHaveLength(1);
    expect(db.tables.placement_targets[0].last_seen_at).toBe("2026-09-21T00:00:00.000Z");
  });

  it("stores how precise the date is, so a '4 months ago' is never shown as a day", async () => {
    await storeTargets({
      supabase: db as unknown as SupabaseClient,
      userId: "user-1",
      businessId: "biz-1",
      targets: [
        { ...thread({ createdAt: "2026-05-29T12:00:00.000Z", createdAtPrecision: "month" }), foundFor: "q", foundVia: "web-search" },
        { ...thread({ externalId: "1abc2e", url: "https://www.reddit.com/r/SEO/comments/1abc2e/y/", title: "A second, differently worded question about AI citations" }), foundFor: "q", foundVia: "reddit" },
      ],
    });
    expect(db.tables.placement_targets[0]).toMatchObject({ posted_at: "2026-05-29T12:00:00.000Z", posted_at_precision: "month" });
    // The bound is what freshness is computed from: the latest it can be.
    expect(db.tables.placement_targets[0].fresh_until).toBe("2026-11-25T12:00:00.000Z");
    // An API's exact timestamp carries no precision.
    expect(db.tables.placement_targets[1]).toMatchObject({ posted_at: "2026-09-10T00:00:00Z", posted_at_precision: null });
  });

  it("stores a web search result with unknown engagement as unknown, not zero", async () => {
    await storeTargets({
      supabase: db as unknown as SupabaseClient,
      userId: "user-1",
      businessId: "biz-1",
      targets: [{ ...thread({ score: null, commentCount: null, createdAt: null }), foundFor: "q", foundVia: "web-search" }],
    });
    expect(db.tables.placement_targets[0]).toMatchObject({ score: null, comment_count: null, posted_at: null, fresh_until: null });
  });
});

describe("recanonicalizeLegacyTargets", () => {
  const legacy = (id: string, url: string, over: Record<string, unknown> = {}) => ({
    id,
    business_id: "biz-1",
    user_id: "user-1",
    surface: "web",
    kind: "page",
    external_id: `hash-${id}`,
    url,
    title: `Legacy ${id} with a title long enough to hash`,
    excerpt: null,
    community: new URL(url).hostname,
    author: null,
    posted_at: null,
    score: null,
    comment_count: null,
    found_for: "ai seo",
    found_via: "web-search",
    status: "rejected",
    qualified_by: "rules:not_answerable",
    qualify_reason: "A plain web page with no place to reply.",
    qualify_score: 0,
    created_at: "2026-09-15",
    ...over,
  });

  it("moves a stored web page to the identity its host has today and lifts a page-only rejection", async () => {
    const db = new FakeSupabase({
      placement_targets: [
        legacy("hn", "https://news.ycombinator.com/item?id=40296399"),
        legacy("quora", "https://www.quora.com/Will-content-writing-be-automated"),
        legacy("dev", "https://dev.to/kai_writes/i-let-ai-agents-run-my-blog-9x2z", { posted_at: "2026-09-01T00:00:00Z" }),
        legacy("blog", "https://blog.hubspot.com/marketing/is-ai-killing-web-traffic"),
      ],
    });

    const out = await recanonicalizeLegacyTargets({ supabase: db as unknown as SupabaseClient, businessId: "biz-1" });
    expect(out).toEqual({ scanned: 4, moved: 3, reopened: 3, merged: 0 });

    const hn = db.tables.placement_targets.find((t) => t.id === "hn");
    expect(hn).toMatchObject({
      surface: "hackernews",
      kind: "thread",
      external_id: "hn:40296399",
      url: "https://news.ycombinator.com/item?id=40296399",
      community: "Hacker News",
      status: "discovered",
      qualified_by: null,
      qualify_reason: null,
    });
    const dev = db.tables.placement_targets.find((t) => t.id === "dev");
    expect(dev).toMatchObject({ surface: "devto", kind: "article", author: "kai_writes" });
    expect(dev?.fresh_until).toBeTruthy();
    // A blog page is still a page: untouched, still rejected.
    expect(db.tables.placement_targets.find((t) => t.id === "blog")).toMatchObject({ surface: "web", status: "rejected" });
  });

  it("keeps a verdict that was not about the page, and merges into an identity already stored", async () => {
    const db = new FakeSupabase({
      placement_targets: [
        legacy("off-topic", "https://www.quora.com/Best-cast-iron-pan", { qualified_by: "rules:no_overlap", qualify_reason: "Nothing in the thread touches what the business can speak to." }),
        legacy("dup", "https://news.ycombinator.com/item?id=555&p=2"),
        {
          id: "real",
          business_id: "biz-1",
          user_id: "user-1",
          surface: "hackernews",
          kind: "thread",
          external_id: "hn:555",
          url: "https://news.ycombinator.com/item?id=555",
          title: "The real row found after the host was learned",
          status: "qualified",
          created_at: "2026-09-20",
        },
      ],
    });

    const out = await recanonicalizeLegacyTargets({ supabase: db as unknown as SupabaseClient, businessId: "biz-1" });
    expect(out).toEqual({ scanned: 2, moved: 1, reopened: 0, merged: 1 });
    expect(db.tables.placement_targets.find((t) => t.id === "off-topic")).toMatchObject({
      surface: "quora",
      kind: "thread",
      status: "rejected",
      qualified_by: "rules:no_overlap",
    });
    expect(db.tables.placement_targets.find((t) => t.id === "dup")).toBeUndefined();
    expect(db.tables.placement_targets.find((t) => t.id === "real")).toMatchObject({ status: "qualified" });
  });

  it("is a no-op the second time", async () => {
    const db = new FakeSupabase({ placement_targets: [legacy("hn", "https://news.ycombinator.com/item?id=1")] });
    await recanonicalizeLegacyTargets({ supabase: db as unknown as SupabaseClient, businessId: "biz-1" });
    const again = await recanonicalizeLegacyTargets({ supabase: db as unknown as SupabaseClient, businessId: "biz-1" });
    expect(again).toEqual({ scanned: 0, moved: 0, reopened: 0, merged: 0 });
  });

  it("reopens an X article that was stored as a page", async () => {
    const db = new FakeSupabase({
      placement_targets: [
        legacy("article", "https://x.com/i/article/2075198687895224547", { surface: "x", community: "x" }),
        legacy("profile", "https://x.com/SeoWriterBot", { surface: "x", community: "x" }),
      ],
    });
    const out = await recanonicalizeLegacyTargets({ supabase: db as unknown as SupabaseClient, businessId: "biz-1" });
    expect(out).toEqual({ scanned: 2, moved: 1, reopened: 1, merged: 0 });
    expect(db.tables.placement_targets.find((t) => t.id === "article")).toMatchObject({
      surface: "x",
      kind: "article",
      external_id: "article:2075198687895224547",
      status: "discovered",
      qualified_by: null,
    });
    expect(db.tables.placement_targets.find((t) => t.id === "profile")).toMatchObject({ kind: "page", status: "rejected" });
  });
});

describe("discoverWith", () => {
  it("stops a provider on a rate limit and keeps what it found", async () => {
    const db = new FakeSupabase({ placement_targets: [] });
    let calls = 0;
    const flaky = provider("github", () => {
      calls += 1;
      if (calls === 1) return [thread({ surface: "github", kind: "issue", externalId: "o/r#1", url: "https://github.com/o/r/issues/1", community: "o/r" })];
      throw new DiscoveryProviderError("rate limited", "github", undefined, { status: 429, retryAfterSeconds: 30 });
    });
    const result = await discoverWith({
      supabase: db as unknown as SupabaseClient,
      provider: flaky,
      business: BUSINESS,
      queries: ["one", "two", "three"],
    });
    expect(result).toMatchObject({ stored: 1, rateLimited: true });
    expect(calls).toBe(2);
    expect(result.notes[0]).toMatch(/rate limited/);
  });

  it("loses one failing query, not the rest", async () => {
    const db = new FakeSupabase({ placement_targets: [] });
    const flaky = provider("web-search", (q) => {
      if (q === "two") throw new Error("boom");
      return [thread({ externalId: q, url: `https://www.reddit.com/r/SEO/comments/${q}/x/`, title: `How do I ${q} get cited by engines?` })];
    });
    const result = await discoverWith({
      supabase: db as unknown as SupabaseClient,
      provider: flaky,
      business: BUSINESS,
      queries: ["one", "two", "three"],
    });
    expect(result).toMatchObject({ stored: 2, rateLimited: false });
    expect(result.notes).toHaveLength(1);
  });
});

describe("placement-discovery workflow", () => {
  let db: FakeSupabase;

  beforeEach(() => {
    db = new FakeSupabase({
      businesses: [{ ...BUSINESS }],
      keywords: [
        { business_id: "biz-1", keyword: "ai seo", created_at: "2026-09-01" },
        { business_id: "biz-1", keyword: "answer engine optimization", created_at: "2026-09-02" },
      ],
      entities: [{ business_id: "biz-1", name: "citation rate" }],
      placement_targets: [],
      agent_runs: [],
    });
  });

  afterEach(() => {
    setDiscoveryProviders(undefined);
    setLlmProvider(null);
  });

  it("builds queries from the site's own vocabulary", async () => {
    const out = (await step(placementDiscoveryWorkflow, "queries").run(ctx(db, { businessId: "biz-1" }))) as { queries: string[] };
    expect(out.queries).toEqual(["answer engine optimization", "ai seo", "citation rate", "AI SEO content"]);
  });

  it("skips a provider step when that provider is not configured, and runs the others", async () => {
    setDiscoveryProviders([provider("web-search", () => [thread()])]);
    const input = { businessId: "biz-1" };
    const outputs = { queries: { queries: ["ai seo"] } };

    const reddit = await step(placementDiscoveryWorkflow, "discover:reddit").run(ctx(db, input, outputs));
    expect(reddit).toEqual({ skipped: "provider not configured" });

    const web = await step(placementDiscoveryWorkflow, "discover:web-search").run(ctx(db, input, outputs));
    expect(web).toMatchObject({ stored: 1, rateLimited: false });
    expect(db.tables.placement_targets[0]).toMatchObject({ found_via: "web-search", status: "discovered" });
  });

  it("rejects by rule before the model sees anything, then lets the agent judge the rest", async () => {
    db.tables.placement_targets.push(
      { id: "t-fresh", business_id: "biz-1", user_id: "user-1", surface: "reddit", kind: "thread", url: "https://www.reddit.com/r/SEO/comments/a/x/", title: "How do I get cited by AI answer engines?", excerpt: "SEO is fine, AI ignores us.", community: "r/SEO", posted_at: daysBefore(3), score: 10, comment_count: 5, found_for: "ai seo", status: "discovered", created_at: "2026-09-10" },
      { id: "t-stale", business_id: "biz-1", user_id: "user-1", surface: "reddit", kind: "thread", url: "https://www.reddit.com/r/SEO/comments/b/x/", title: "How do I get cited by AI answer engines? (old)", excerpt: "", community: "r/SEO", posted_at: "2025-01-01T00:00:00Z", score: 10, comment_count: 5, found_for: "ai seo", status: "discovered", created_at: "2026-09-10" },
      { id: "t-own", business_id: "biz-1", user_id: "user-1", surface: "web", kind: "article", url: "https://gettrafficfa.st/blog/x", title: "Our own article about ai seo", excerpt: "", community: "gettrafficfa.st", posted_at: "2026-09-10T00:00:00Z", score: null, comment_count: null, found_for: "ai seo", status: "discovered", created_at: "2026-09-10" }
    );

    const rules = await step(placementDiscoveryWorkflow, "rules").run(ctx(db, { businessId: "biz-1" }));
    // A Reddit thread from January 2025 is archived, not merely stale: the
    // reply could not be posted at all, and the rule says so.
    expect(rules).toMatchObject({ considered: 3, rejected: 2, byRule: { archived: 1, own_site: 1 } });
    const stale = db.tables.placement_targets.find((t) => t.id === "t-stale");
    expect(stale).toMatchObject({ status: "rejected", qualified_by: "rules:archived" });
    expect(stale?.qualify_reason).toMatch(/Archived on Reddit: at least \d+ days old/);

    let promptSeen = "";
    setLlmProvider({
      ...stubLlm({
        verdicts: [{ index: 0, verdict: "qualified", score: 82, reason: "Squarely their topic.", angle: "Passage-level structure and how to measure citations.", topic: "AI citations", intent: "question" }],
      }),
      async generateStructured(prompt, schema) {
        promptSeen = prompt;
        return stubLlm({
          verdicts: [{ index: 0, verdict: "qualified", score: 82, reason: "Squarely their topic.", angle: "Passage-level structure and how to measure citations.", topic: "AI citations", intent: "question" }],
        }).generateStructured(prompt, schema);
      },
    });

    const qualify = await step(placementDiscoveryWorkflow, "qualify").run(ctx(db, { businessId: "biz-1" }));
    expect(qualify).toMatchObject({ judged: 1, qualified: 1, rejected: 0 });
    expect(promptSeen).toContain("How do I get cited by AI answer engines?");
    expect(promptSeen).not.toContain("(old)");
    expect(db.tables.placement_targets.find((t) => t.id === "t-fresh")).toMatchObject({
      status: "qualified",
      qualify_score: 82,
      topic: "AI citations",
      intent: "question",
      qualified_by: "agent",
    });
    expect(db.tables.agent_runs).toHaveLength(1);
  });

  it("judges undated web-search threads beside dated API results instead of after all of them", async () => {
    // Twelve dated GitHub issues and twelve undated Reddit threads: judged
    // newest-first, a cap of ten would be GitHub only. The agent sees both.
    const seed = (surface: string, i: number, dated: boolean) => ({
      id: `${surface}-${i}`,
      business_id: "biz-1",
      user_id: "user-1",
      surface,
      kind: surface === "github" ? "issue" : "thread",
      url: surface === "github" ? `https://github.com/acme/tool/issues/${i}` : `https://www.reddit.com/r/SEO/comments/r${i}/x/`,
      title: `How do I get cited by AI answer engines? (${surface} ${i})`,
      excerpt: "Our ai seo is fine, answer engines ignore us.",
      community: surface === "github" ? "acme/tool" : "r/SEO",
      posted_at: dated ? `2026-09-${String(1 + i).padStart(2, "0")}T00:00:00Z` : null,
      score: dated ? 3 : null,
      comment_count: dated ? 4 : null,
      found_for: "ai seo",
      found_via: dated ? "github" : "web-search",
      status: "discovered",
      created_at: "2026-09-15",
      last_seen_at: "2026-09-15T00:00:00Z",
    });
    for (let i = 0; i < 12; i += 1) db.tables.placement_targets.push(seed("github", i, true));
    for (let i = 0; i < 12; i += 1) db.tables.placement_targets.push(seed("reddit", i, false));

    const surfacesSeen: string[][] = [];
    setLlmProvider({
      ...stubLlm({ verdicts: [] }),
      async generateStructured(prompt, schema) {
        const surfaces = [...prompt.matchAll(/^\[\d+\] (\w+) /gm)].map((m) => m[1]);
        surfacesSeen.push(surfaces);
        const verdicts = surfaces.map((_, index) => ({
          index,
          verdict: "rejected",
          score: 10,
          reason: "Not it.",
          angle: null,
          topic: null,
          intent: null,
        }));
        return stubLlm({ verdicts }).generateStructured(prompt, schema);
      },
    });

    const out = (await step(placementDiscoveryWorkflow, "qualify").run(ctx(db, { businessId: "biz-1" }))) as {
      judged: number;
    };
    expect(out.judged).toBe(24);
    const judged = db.tables.placement_targets.filter((t) => t.qualified_by === "agent");
    expect(judged.filter((t) => t.surface === "reddit")).toHaveLength(12);
    expect(judged.filter((t) => t.surface === "github")).toHaveLength(12);
    // The first batch already mixes surfaces: the fair share is dealt, not appended.
    expect(new Set(surfacesSeen[0])).toEqual(new Set(["github", "reddit"]));
  });

  it("keeps the run's cap and budget across a resumed invocation", async () => {
    // A resumed step re-selects. Without progress from agent_runs it would
    // judge a whole new cap per tick and start the dollar budget over.
    db.tables.placement_targets.push({
      id: "t-1",
      business_id: "biz-1",
      user_id: "user-1",
      surface: "reddit",
      kind: "thread",
      url: "https://www.reddit.com/r/SEO/comments/z1/x/",
      title: "How do I get cited by AI answer engines?",
      excerpt: "ai seo",
      community: "r/SEO",
      posted_at: null,
      score: null,
      comment_count: null,
      found_for: "ai seo",
      status: "discovered",
      created_at: "2026-09-15",
      last_seen_at: "2026-09-15T00:00:00Z",
    });
    // Twelve earlier batches on this job: the cap of 120 is spent.
    for (let i = 0; i < 12; i += 1) {
      db.tables.agent_runs.push({ job_id: "job-1", agent: "placement-qualify", cost_usd: 0.01 });
    }
    let called = 0;
    setLlmProvider({
      ...stubLlm({ verdicts: [] }),
      async generateStructured(prompt, schema) {
        called += 1;
        return stubLlm({ verdicts: [] }).generateStructured(prompt, schema);
      },
    });

    const out = await step(placementDiscoveryWorkflow, "qualify").run(ctx(db, { businessId: "biz-1" }));
    expect(out).toMatchObject({ judged: 0, capped: true });
    expect(called).toBe(0);
    expect(db.tables.placement_targets[0].status).toBe("discovered");
  });

  it("takes archived Reddit threads out of the inbox on every run, whatever their status, and names the rule", async () => {
    // 29 September 2026: a draft was written for a thread that turned out to
    // read "Post archived. No new comments or votes" when the person went
    // to post it. Rows a person could still act on are checked against the
    // time-only rules again; nothing else about them is judged again.
    const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
    const row = (id: string, over: Record<string, unknown>) => ({
      id, business_id: "biz-1", user_id: "user-1", surface: "reddit", kind: "thread", url: `https://www.reddit.com/r/SEO/comments/${over.external_id ?? id}/x/`,
      title: "How do I get cited by AI answer engines?", excerpt: "SEO is fine, AI ignores us.", community: "r/SEO", score: 10, comment_count: 5,
      found_for: "ai seo", created_at: "2026-09-10", qualify_angle: "Passage-level structure.", qualified_by: "agent", ...over,
    });
    db.tables.placement_targets.push(
      // Dated, qualified in spring, six months old now.
      row("q-dated-old", { external_id: "1qzzzzz", posted_at: daysAgo(212), status: "qualified" }),
      // Undated, drafted, with an id below a thread known to be six months old.
      row("d-undated-old", { external_id: "1l4x1q0", posted_at: null, status: "drafted" }),
      // Undated, approved, id newer than anything known to be old: left alone.
      row("a-undated-new", { external_id: "1wdgutr", posted_at: null, status: "approved" }),
      // Dated and fresh, approved, off-topic by today's keywords: not re-judged on topic.
      row("a-fresh", { external_id: "1wdguts", posted_at: daysAgo(9), status: "approved", title: "Which cast iron pan should I buy?", excerpt: "" }),
      // Already published: terminal, never touched.
      row("p-old", { external_id: "1abc2d0", posted_at: daysAgo(270), status: "published_manually" }),
      // A dated old thread, stored by discovery, is what bounds the undated ones.
      row("anchor", { business_id: "biz-other", user_id: "user-2", external_id: "1qtonc8", posted_at: daysAgo(221), status: "rejected" })
    );

    const rules = (await step(placementDiscoveryWorkflow, "rules").run(ctx(db, { businessId: "biz-1" }))) as {
      expired: { considered: number; rejected: number; byRule: Record<string, number> };
    };
    expect(rules.expired).toEqual({ considered: 4, rejected: 2, byRule: { archived: 2 } });
    const by = (id: string) => db.tables.placement_targets.find((t) => t.id === id)!;
    expect(by("q-dated-old")).toMatchObject({ status: "rejected", qualified_by: "rules:archived" });
    expect(by("q-dated-old").qualify_reason).toMatch(/Archived on Reddit: at least 212 days old/);
    expect(by("d-undated-old")).toMatchObject({ status: "rejected", qualified_by: "rules:archived" });
    expect(by("d-undated-old").qualify_reason).toMatch(/numbers threads in order/);
    expect(by("a-undated-new").status).toBe("approved");
    expect(by("a-fresh").status).toBe("approved");
    expect(by("p-old").status).toBe("published_manually");
  });

  it("judges again the rows already qualified with a product brief for an angle, behind the new finds", async () => {
    const base = {
      business_id: "biz-1",
      user_id: "user-1",
      surface: "reddit",
      kind: "thread",
      excerpt: "ai seo and answer engines",
      community: "r/SEO",
      posted_at: daysBefore(3),
      score: 12,
      comment_count: 5,
      found_for: "ai seo",
      created_at: "2026-09-15",
      last_seen_at: "2026-09-15T00:00:00Z",
    };
    db.tables.placement_targets.push(
      { ...base, id: "fresh", url: "https://www.reddit.com/r/SEO/comments/f1/x/", title: "How do I get cited by AI answer engines?", status: "discovered" },
      {
        ...base,
        id: "brief",
        url: "https://www.reddit.com/r/SEO/comments/b1/x/",
        title: "Best AI tools for SEO content?",
        status: "qualified",
        qualify_angle: "Explain how GetTrafficFast stands out as a complete AI agent that automates the entire SEO content workflow.",
        qualified_at: "2026-09-16T00:00:00Z",
      },
      {
        ...base,
        id: "knowledge",
        url: "https://www.reddit.com/r/SEO/comments/k1/x/",
        title: "Why does Perplexity never cite my pages?",
        status: "qualified",
        qualify_angle: "Answer engines retrieve passages, not pages; a section that answers its own question first gets picked.",
        qualified_at: "2026-09-16T00:00:00Z",
      }
    );
    const titlesSeen: string[] = [];
    setLlmProvider({
      ...stubLlm({ verdicts: [] }),
      async generateStructured(prompt, schema) {
        const titles = [...prompt.matchAll(/^Title: (.+)$/gm)].map((m) => m[1]);
        titlesSeen.push(...titles);
        const verdicts = titles.map((title, index) => ({
          index,
          verdict: "qualified",
          score: 80,
          reason: "Their topic.",
          angle: title.startsWith("Best AI tools")
            ? "Writing tools score one page; what costs the time is everything around the pages, and that is where to look first."
            : "Passages, not pages.",
          topic: "ai seo",
          intent: "question",
        }));
        return stubLlm({ verdicts }).generateStructured(prompt, schema);
      },
    });

    const out = await step(placementDiscoveryWorkflow, "qualify").run(ctx(db, { businessId: "biz-1" }));
    expect(out).toMatchObject({ judged: 2, rejudged: 1 });
    // The new find first, the brief behind it; the knowledge angle is not touched.
    expect(titlesSeen).toEqual(["How do I get cited by AI answer engines?", "Best AI tools for SEO content?"]);
    const brief = db.tables.placement_targets.find((t) => t.id === "brief")!;
    expect(brief.status).toBe("qualified");
    expect(brief.qualify_angle).toMatch(/everything around the pages/);
    expect(db.tables.placement_targets.find((t) => t.id === "knowledge")!.qualify_angle).toMatch(/^Answer engines retrieve/);
  });
});

describe("placement-draft workflow", () => {
  let db: FakeSupabase;

  const target = {
    id: "t-1",
    business_id: "biz-1",
    user_id: "user-1",
    surface: "reddit",
    kind: "thread",
    community: "r/SEO",
    title: "How do I get my site cited by AI answer engines like ChatGPT and Perplexity?",
    excerpt: "Our SEO is decent but AI answers never mention us. What actually moves the needle?",
    author: "asker",
    status: "qualified",
    qualify_angle: "Answer engines retrieve passages, not pages: every section has to answer its own question in the first two sentences.",
  };

  // Answers first, names no product, carries no link, closes on the
  // question: what every reply is now asked for, on every surface.
  const LEAD =
    "Answer engines retrieve passages, not pages, so the thing that moved the needle for us was restructuring every section to answer its own question in the first two sentences. Question-shaped headings help too: they match how people actually ask.";
  const REST =
    "Then check whether the engines cite you at all — ask ChatGPT and Perplexity a handful of the questions your pages answer and record whether your domain shows up in the sources. It is a sampled measurement, not ground truth, but the trend over a few weeks tells you if the restructuring is working. If you want, I can share the checklist we use for the section structure.";
  const GOOD = `${LEAD} ${REST}`;
  /** The good reply with one more sentence where the mention used to sit. */
  const withLine = (line: string) => `${LEAD} ${line} ${REST}`;

  beforeEach(() => {
    db = new FakeSupabase({
      businesses: [{ ...BUSINESS }],
      keywords: [{ business_id: "biz-1", keyword: "answer engine optimization" }],
      entities: [{ business_id: "biz-1", name: "citation rate" }],
      placement_targets: [{ ...target }],
      placements: [],
      agent_runs: [],
    });
  });

  afterEach(() => setLlmProvider(null));

  // The job reads the day: a dated fact in About you goes stale 30 days on
  // (lib/voice/staleness.ts). The owner's settings below are dated, so the
  // day is the one they were read on, not the day the suite runs.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-11-10T09:30:00Z") });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("clamps a long checklist line before handing it to the rewrite, so a thorough gate never fails the agent's input", () => {
    // The gate quotes what tripped it: the brochure's statements, the words
    // behind each tell. Four quoted statements already ran past the input
    // schema's limit, and a rewrite that fails validation ends the job.
    const detail = `Describes the product in 6 statements (${Array.from({ length: 6 }, (_, i) => `"statement number ${i} about what the product does for the writer, quoted in full for the rewrite to drop"`).join(", ")}); a person mentions the one or two that fit.`;
    expect(detail.length).toBeGreaterThan(PROBLEM_MAX_CHARS);
    const problems = problemsOf({
      status: "blocked",
      checks: [
        { id: "human_voice", label: "", status: "fail", detail },
        { id: "link", label: "", status: "pass", detail: "One link." },
      ],
    });
    expect(problems).toHaveLength(1);
    expect(problems[0].length).toBeLessThanOrEqual(PROBLEM_MAX_CHARS);
    expect(problems[0]).toMatch(/…$/);
    expect(() =>
      PlacementDraftInput.parse({
        business: { name: "GetTrafficFast", domain: "https://gettrafficfa.st", niche: null },
        thread: { surface: "reddit", kind: "thread", community: "", title: "t", excerpt: "", author: null },
        angle: "a",
        language: "en",
        variants: ["short_comment"],
        revisions: [{ variant: "short_comment", problems }],
      })
    ).not.toThrow();
  });

  it("writes the variants, audits each, and moves a passing target to drafted", async () => {
    // A reply carries no link: one the model declared, to the site or to
    // anyone else, is dropped. Neither variant stores a URL.
    setLlmProvider(
      stubLlm({
        variants: [
          { variant: "short_comment", body: GOOD, linkUrl: "https://gettrafficfa.st", claims: [{ text: "Answer engines retrieve passages, not pages", basis: "general_knowledge" }] },
          { variant: "detailed_answer", body: GOOD, linkUrl: "https://competitor.test/x", claims: [] },
          { variant: "article_draft", body: "not requested", linkUrl: null, claims: [] },
        ],
      })
    );
    const input = { businessId: "biz-1", targetId: "t-1" };
    const drafted = (await step(placementDraftWorkflow, "draft").run(ctx(db, input))) as {
      variants: Array<{ variant: string; body: string; linkUrl: string | null }>;
    };
    expect(drafted.variants.map((v) => v.variant)).toEqual(["short_comment", "detailed_answer"]);
    expect(drafted.variants.map((v) => v.linkUrl)).toEqual([null, null]);
    expect(drafted.variants.every((variant) => variant.body === GOOD)).toBe(true);

    const audited = await step(placementDraftWorkflow, "audit").run(ctx(db, input, { draft: drafted }));
    expect(audited).toMatchObject({ status: "drafted" });
    expect(db.tables.placements).toHaveLength(2);
    expect(db.tables.placements.every((p) => p.audit_status === "passed")).toBe(true);
    expect(db.tables.placement_targets[0].status).toBe("drafted");
  });

  it("tells the drafter about an image nobody could read, and saves the draft with the advisory check failed (11 November 2026)", async () => {
    // Added by hand with the X API off: the embed showed a picture, the
    // media were recorded as unread. No image is fetched; the model is told
    // there is one it cannot see, and the draft says it did not see it.
    Object.assign(db.tables.placement_targets[0], { media: null, media_unread: true });
    const prompts: string[] = [];
    const options: Array<unknown> = [];
    setLlmProvider({
      ...stubLlm({ variants: [] }),
      async generateStructured<T>(prompt: string, schema: z.ZodType<T>, opts?: { images?: unknown }): Promise<LlmStructuredResult<T>> {
        prompts.push(prompt);
        options.push(opts?.images);
        return {
          value: schema.parse({ variants: [{ variant: "short_comment", body: GOOD, linkUrl: null, claims: [] }, { variant: "detailed_answer", body: GOOD, linkUrl: null, claims: [] }] }),
          usage,
          raw: "",
        };
      },
    });
    const input = { businessId: "biz-1", targetId: "t-1" };
    const drafted = (await step(placementDraftWorkflow, "draft").run(ctx(db, input))) as { images: unknown };
    expect(prompts[0]).toContain("The post has an image you cannot see.");
    expect(options[0]).toEqual([]);
    expect(drafted.images).toEqual({ inPost: null, seen: 0, note: "X did not hand over the post's images" });

    await step(placementDraftWorkflow, "audit").run(ctx(db, input, { draft: drafted }));
    const saved = db.tables.placements[0] as { audit_status: string; audit: { checks: Array<{ id: string; status: string; advisory?: boolean; detail: string }>; images?: unknown } };
    expect(saved.audit_status).toBe("passed");
    expect(saved.audit.checks.find((c) => c.id === "image_not_read")).toMatchObject({
      status: "fail",
      advisory: true,
      detail: expect.stringContaining("This post has an image the draft could not see. Look at it before you post."),
    });
    expect(saved.audit.images).toEqual({ inPost: null, seen: 0, note: "X did not hand over the post's images" });
  });

  it("saves a variant that passed and leaves out one that did not", async () => {
    const generic =
      "Marketing is about consistency and knowing your audience. Post regularly, measure what works, and iterate. Consistency beats intensity every single time, and the brands that win are the ones that keep showing up week after week with something worth reading.";
    const drafted = {
      variants: [
        { variant: "short_comment", body: generic, linkUrl: null, claims: [] },
        { variant: "detailed_answer", body: GOOD, linkUrl: null, claims: [] },
      ],
      expertise: ["answer engine optimization"],
      writes: 3,
    };
    const audited = (await step(placementDraftWorkflow, "audit").run(
      ctx(db, { businessId: "biz-1", targetId: "t-1" }, { draft: drafted })
    )) as { omitted: string[]; status: string };
    expect(audited.status).toBe("drafted");
    expect(audited.omitted).toEqual(["short_comment"]);
    expect(db.tables.placements.map((row) => row.variant)).toEqual(["detailed_answer"]);
    expect(db.tables.placements.every((row) => row.audit_status === "passed")).toBe(true);
  });

  it("saves nothing when every variant is still short of a pass, and says which check stopped it", async () => {
    db.tables.placements.push({
      id: "old",
      target_id: "t-1",
      business_id: "biz-1",
      variant: "short_comment",
      body: "an earlier draft that did not pass",
    });
    db.tables.placement_targets[0].status = "drafted";
    const generic =
      "Marketing is about consistency and knowing your audience. Post regularly, measure what works, and iterate week after week with something worth reading, whatever channel they choose.";
    const drafted = {
      variants: [
        { variant: "short_comment", body: generic, linkUrl: null, claims: [] },
        { variant: "detailed_answer", body: generic, linkUrl: null, claims: [] },
      ],
      expertise: ["answer engine optimization"],
      writes: 3,
    };
    const error = await step(placementDraftWorkflow, "audit")
      .run(ctx(db, { businessId: "biz-1", targetId: "t-1" }, { draft: drafted }))
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(TerminalStepError);
    expect((error as Error).message).toContain("No draft was saved");
    expect((error as Error).message).toContain("thread's own words");
    expect(db.tables.placements).toHaveLength(0);
    expect(db.tables.placement_targets[0].status).toBe("qualified");
  });

  it("writes a blocked variant again with the failing checks named, and keeps the rewrite the gate prefers", async () => {
    const prompts: string[] = [];
    setLlmProvider({
      ...stubLlm({ variants: [] }),
      async generateStructured(prompt, schema) {
        prompts.push(prompt);
        const body = prompt.includes("A previous draft of some variants failed")
          ? GOOD
          : "Check out GetTrafficFast, it does exactly this.";
        return stubLlm({
          variants: [
            { variant: "short_comment", body, linkUrl: null, claims: [] },
            { variant: "detailed_answer", body, linkUrl: null, claims: [] },
          ],
        }).generateStructured(prompt, schema);
      },
    });
    const input = { businessId: "biz-1", targetId: "t-1" };
    const drafted = (await step(placementDraftWorkflow, "draft").run(ctx(db, input))) as {
      variants: Array<{ body: string }>;
      writes: number;
    };
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("Pitches the brand by name");
    expect(drafted.writes).toBe(2);
    expect(drafted.variants.every((variant) => variant.body === GOOD)).toBe(true);

    const audited = await step(placementDraftWorkflow, "audit").run(ctx(db, input, { draft: drafted }));
    expect(audited).toMatchObject({ status: "drafted", writes: 2 });
    expect(db.tables.placements.every((p) => p.audit_status === "passed")).toBe(true);
  });

  it("deletes a sentence the voice check refuses, so that variant is not asked for again", async () => {
    const prompts: string[] = [];
    // "robust" is one brochure word. The sentence is deleted before the
    // judgement, so the variant passes and is not written again.
    const stray = `${GOOD} The structure is robust to redesigns.`;
    setLlmProvider({
      ...stubLlm({ variants: [] }),
      async generateStructured(prompt, schema) {
        prompts.push(prompt);
        const rewrite = prompt.includes("A previous draft of some variants failed");
        return stubLlm({
          variants: rewrite
            ? [{ variant: "detailed_answer", body: GOOD, linkUrl: null, claims: [] }]
            : [
                { variant: "short_comment", body: GOOD, linkUrl: null, claims: [] },
                { variant: "detailed_answer", body: stray, linkUrl: null, claims: [] },
              ],
        }).generateStructured(prompt, schema);
      },
    });
    const drafted = (await step(placementDraftWorkflow, "draft").run(ctx(db, { businessId: "biz-1", targetId: "t-1" }))) as {
      variants: Array<{ variant: string; body: string }>;
      writes: number;
    };
    expect(prompts).toHaveLength(1);
    expect(drafted.writes).toBe(1);
    expect(drafted.variants.map((variant) => variant.variant)).toEqual(["short_comment", "detailed_answer"]);
    expect(drafted.variants.every((variant) => variant.body === GOOD)).toBe(true);
  });

  it("writes a reply again when it names the business, and tells the rewrite to take the name out", async () => {
    const prompts: string[] = [];
    setLlmProvider({
      ...stubLlm({ variants: [] }),
      async generateStructured(prompt, schema) {
        prompts.push(prompt);
        const body = prompt.includes("A previous draft of some variants failed")
          ? GOOD
          : withLine("My own blog runs on GetTrafficFast, so that's my bias.");
        return stubLlm({
          variants: [
            { variant: "short_comment", body, linkUrl: null, claims: [] },
            { variant: "detailed_answer", body, linkUrl: null, claims: [] },
          ],
        }).generateStructured(prompt, schema);
      },
    });
    const drafted = (await step(placementDraftWorkflow, "draft").run(ctx(db, { businessId: "biz-1", targetId: "t-1" }))) as {
      variants: Array<{ body: string }>;
    };
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("Names GetTrafficFast.");
    expect(prompts[1]).toContain("Delete the clause that names it and put nothing in its place.");
    expect(prompts[1]).not.toContain("Never names GetTrafficFast");
    expect(drafted.variants.every((variant) => variant.body === GOOD)).toBe(true);
  });

  it("deletes the published 'I use X for that' line before judging and puts nothing in its place", async () => {
    // Each of the lines the 21 published replies carried. The sentence goes;
    // the answer around it passes in one write and no mention is put back.
    for (const line of [
      "GetTrafficFast (https://gettrafficfa.st/) is what I use for that.",
      "I use [GetTrafficFast](https://gettrafficfa.st/) for my own site's blog publishing.",
      "That's the part I have GetTrafficFast doing for my own site.",
      "I manage my own site's blog publishing with GetTrafficFast.",
    ]) {
      let calls = 0;
      setLlmProvider({
        ...stubLlm({ variants: [] }),
        async generateStructured(prompt, schema) {
          calls += 1;
          return stubLlm({
            variants: [
              { variant: "short_comment", body: withLine(line), linkUrl: null, claims: [] },
              { variant: "detailed_answer", body: withLine(line), linkUrl: null, claims: [] },
            ],
          }).generateStructured(prompt, schema);
        },
      });
      const drafted = (await step(placementDraftWorkflow, "draft").run(ctx(db, { businessId: "biz-1", targetId: "t-1" }))) as {
        variants: Array<{ body: string }>;
        writes: number;
      };
      expect(calls, line).toBe(1);
      expect(drafted.writes, line).toBe(1);
      expect(drafted.variants.map((variant) => variant.body), line).toEqual([GOOD, GOOD]);
    }
  });

  it("stops at MAX_WRITES and keeps the best text when no rewrite scores better", async () => {
    // A URL in a reply is not stripped: the gate refuses it. The kept text is the first draft.
    const pitched =
      "Check out [GetTrafficFast](https://gettrafficfa.st), it does exactly this: answer engines retrieve passages rather than whole pages, so each section has to answer its own question first.";
    const kept = pitched;
    let calls = 0;
    setLlmProvider({
      ...stubLlm({ variants: [] }),
      async generateStructured(prompt, schema) {
        calls += 1;
        // Every rewrite adds a claim the first did not make, so the gate
        // cannot prefer it. An equal score would also keep the first.
        const body = calls === 1 ? pitched : `${pitched} Studies show it is guaranteed to be the best.`;
        return stubLlm({
          variants: [
            { variant: "short_comment", body, linkUrl: null, claims: [] },
            { variant: "detailed_answer", body, linkUrl: null, claims: [] },
          ],
        }).generateStructured(prompt, schema);
      },
    });
    const drafted = (await step(placementDraftWorkflow, "draft").run(ctx(db, { businessId: "biz-1", targetId: "t-1" }))) as {
      variants: Array<{ body: string }>;
      writes: number;
    };
    expect(calls).toBe(MAX_WRITES);
    expect(drafted.writes).toBe(MAX_WRITES);
    expect(drafted.variants.every((variant) => variant.body === kept)).toBe(true);
  });

  it("does not start a rewrite the job's deadline cannot fit", async () => {
    let calls = 0;
    setLlmProvider({
      ...stubLlm({ variants: [] }),
      async generateStructured(prompt, schema) {
        calls += 1;
        return stubLlm({
          variants: [{ variant: "short_comment", body: "Check out GetTrafficFast.", linkUrl: null, claims: [] }],
        }).generateStructured(prompt, schema);
      },
    });
    // Two seconds left: less than the margin a second call needs.
    const drafted = (await step(placementDraftWorkflow, "draft").run({
      ...ctx(db, { businessId: "biz-1", targetId: "t-1" }),
      deadline: Date.now() + 2_000,
    })) as { writes: number };
    expect(calls).toBe(1);
    expect(drafted.writes).toBe(1);
  });

  it("does not pay for a rewrite when the first draft already passes", async () => {
    let calls = 0;
    setLlmProvider({
      ...stubLlm({ variants: [] }),
      async generateStructured(prompt, schema) {
        calls += 1;
        return stubLlm({
          variants: [{ variant: "short_comment", body: GOOD, linkUrl: null, claims: [] }],
        }).generateStructured(prompt, schema);
      },
    });
    await step(placementDraftWorkflow, "draft").run(ctx(db, { businessId: "biz-1", targetId: "t-1" }));
    expect(calls).toBe(1);
  });

  it("does not save a draft the gate refused, and names the check that stopped it", async () => {
    setLlmProvider(
      stubLlm({
        variants: [
          { variant: "short_comment", body: "Check out GetTrafficFast, it does exactly this: https://gettrafficfa.st/", linkUrl: "https://gettrafficfa.st/", claims: [] },
          { variant: "detailed_answer", body: `Check out GetTrafficFast! ${GOOD}`, linkUrl: null, claims: [] },
        ],
      })
    );
    const input = { businessId: "biz-1", targetId: "t-1" };
    const drafted = await step(placementDraftWorkflow, "draft").run(ctx(db, input));
    const error = await step(placementDraftWorkflow, "audit")
      .run(ctx(db, input, { draft: drafted }))
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(TerminalStepError);
    expect((error as Error).message).toContain("No draft was saved");
    expect((error as Error).message).toContain("opening names the business");
    expect(db.tables.placements).toHaveLength(0);
    expect(db.tables.placement_targets[0].status).toBe("qualified");
  });

  it("writes in the business's voice and in the approach dealt for this job, and records the approach", async () => {
    db.tables.businesses[0].voice_settings = { preset: "casual", person: "i", aboutYou: "I run my own blog through GetTrafficFast." };
    let prompt = "";
    setLlmProvider({
      ...stubLlm({ variants: [] }),
      async generateStructured(p, schema) {
        prompt = p;
        return stubLlm({ variants: [{ variant: "short_comment", body: GOOD, linkUrl: null, claims: [] }] }).generateStructured(p, schema);
      },
    });
    const drafted = (await step(placementDraftWorkflow, "draft").run(ctx(db, { businessId: "biz-1", targetId: "t-1" }))) as { approach: string };
    expect(prompt).toContain("Casual:");
    expect(prompt).toContain("I run my own blog through GetTrafficFast.");
    expect(prompt).toContain(`The approach for this reply: ${drafted.approach}`);
    expect(drafted.approach.length).toBeGreaterThan(10);
  });

  it("refuses to write, before the model is paid, when nothing records how the writer uses the product", async () => {
    // The reply speaks as a user of the product. With Settings → Voice empty
    // there is nothing honest to say, and no retry changes a setting.
    db.tables.businesses[0].voice_settings = null;
    let calls = 0;
    setLlmProvider({
      ...stubLlm({ variants: [] }),
      async generateStructured(p, schema) {
        calls += 1;
        return stubLlm({ variants: [{ variant: "short_comment", body: GOOD, linkUrl: null, claims: [] }] }).generateStructured(p, schema);
      },
    });
    const attempt = step(placementDraftWorkflow, "draft").run(ctx(db, { businessId: "biz-1", targetId: "t-1" }));
    await expect(attempt).rejects.toBeInstanceOf(TerminalStepError);
    await expect(attempt).rejects.toThrow(/Settings → Voice → About you/);
    await expect(attempt).rejects.toThrow(/someone who uses GetTrafficFast/);
    expect(calls).toBe(0);
  });

  const BRIEF = "Explain how GetTrafficFast stands out as a complete AI agent that automates the entire SEO content workflow.";
  const KNOWLEDGE = "Writing tools score one page; what costs the time is everything around the pages, and that is where to look first.";

  it("asks for an angle, judging nothing else, when the stored one is a product brief, and drafts from the new angle", async () => {
    db.tables.placement_targets[0].qualify_angle = BRIEF;
    const prompts: string[] = [];
    setLlmProvider({
      ...stubLlm({ variants: [] }),
      async generateStructured(prompt, schema) {
        prompts.push(prompt);
        const structured = prompt.startsWith("You are deciding which public discussions")
          ? { verdicts: [{ index: 0, verdict: "qualified", score: 85, reason: "Their topic.", angle: KNOWLEDGE, topic: "ai seo", intent: "recommendation" }] }
          : { variants: [{ variant: "short_comment", body: GOOD, linkUrl: null, claims: [] }] };
        return stubLlm(structured).generateStructured(prompt, schema);
      },
    });
    const input = { businessId: "biz-1", targetId: "t-1" };
    const drafted = (await step(placementDraftWorkflow, "draft").run(ctx(db, input))) as { requalified: string | null };
    expect(drafted.requalified).toBe("qualified");
    expect(prompts).toHaveLength(2);
    // The person clicked: the thread's worth is not on the table.
    expect(prompts[0]).toContain("The owner has already decided to answer the discussion below.");
    expect(prompts[0]).toContain("unknown is not a reason for anything");
    expect(prompts[0]).not.toContain("Reject generously");
    expect(prompts[1]).toContain(KNOWLEDGE);
    expect(prompts[1]).not.toContain(BRIEF);
    expect(db.tables.placement_targets[0].qualify_angle).toBe(KNOWLEDGE);
    expect(db.tables.placement_targets[0].status).toBe("qualified");
    // Judged once: the same angle is not a brief any more, so the next draft does not pay again.
    setLlmProvider(stubLlm({ variants: [{ variant: "short_comment", body: GOOD, linkUrl: null, claims: [] }] }));
    const again = (await step(placementDraftWorkflow, "draft").run(ctx(db, input))) as { requalified: string | null };
    expect(again.requalified).toBeNull();
  });

  it("asks again with the refused angle quoted when the first answer is the product, and drafts from the second", async () => {
    // 29 September: the first angle-mode answer read as a pitch to the
    // domain rule and the job stopped, telling the person to reject a
    // thread the batch had scored 90. A heuristic's first opinion is not
    // where a click ends.
    db.tables.placement_targets[0].qualify_angle = BRIEF;
    const PITCH = "Introduce GetTrafficFast as the AI agent that automates all of this.";
    const prompts: string[] = [];
    setLlmProvider({
      ...stubLlm({ variants: [] }),
      async generateStructured(prompt, schema) {
        prompts.push(prompt);
        const asks = prompts.filter((p) => p.startsWith("You are deciding which public discussions")).length;
        const structured = prompt.startsWith("You are deciding which public discussions")
          ? { verdicts: [{ index: 0, verdict: "qualified", score: 85, reason: "Their topic.", angle: asks === 1 ? PITCH : KNOWLEDGE, topic: null, intent: null }] }
          : { variants: [{ variant: "short_comment", body: GOOD, linkUrl: null, claims: [] }] };
        return stubLlm(structured).generateStructured(prompt, schema);
      },
    });
    const drafted = (await step(placementDraftWorkflow, "draft").run(ctx(db, { businessId: "biz-1", targetId: "t-1" }))) as { requalified: string | null };
    expect(drafted.requalified).toBe("qualified");
    const asks = prompts.filter((p) => p.startsWith("You are deciding which public discussions"));
    expect(asks).toHaveLength(2);
    expect(asks[0]).not.toContain("Already refused for this thread");
    expect(asks[1]).toContain(`Already refused for this thread, because each describes the product or its kind instead of saying something: "${PITCH}"`);
    expect(db.tables.placement_targets[0].qualify_angle).toBe(KNOWLEDGE);
  });

  it("stops and says so, leaving the row as it was, when the only angle found twice is the product", async () => {
    // The first manual draft under the old re-judgement rejected the thread
    // the person had just clicked, and it vanished from the inbox.
    db.tables.placement_targets[0].qualify_angle = BRIEF;
    db.tables.placement_targets[0].status = "drafted";
    db.tables.placements.push({ id: "old", target_id: "t-1", business_id: "biz-1", body: "an earlier draft", audit_status: "blocked" });
    let drafts = 0;
    let asks = 0;
    setLlmProvider({
      ...stubLlm({ variants: [] }),
      async generateStructured(prompt, schema) {
        if (!prompt.startsWith("You are deciding which public discussions")) drafts += 1;
        else asks += 1;
        return stubLlm({
          verdicts: [{ index: 0, verdict: "qualified", score: 85, reason: "Their topic.", angle: "Introduce GetTrafficFast as the AI agent that automates all of this.", topic: null, intent: null }],
        }).generateStructured(prompt, schema);
      },
    });
    const attempt = step(placementDraftWorkflow, "draft").run(ctx(db, { businessId: "biz-1", targetId: "t-1" }));
    await expect(attempt).rejects.toBeInstanceOf(TerminalStepError);
    await expect(attempt).rejects.toThrow(NO_ANGLE_MESSAGE);
    expect(asks).toBe(2);
    expect(drafts).toBe(0);
    expect(db.tables.placement_targets[0].status).toBe("drafted");
    expect(db.tables.placement_targets[0].qualify_angle).toBe(BRIEF);
    expect(db.tables.placements).toHaveLength(1);
  });

  it("never rejects the row on a manual draft, whatever the model's verdict says", async () => {
    db.tables.placement_targets[0].qualify_angle = BRIEF;
    setLlmProvider(
      stubLlm({
        verdicts: [{ index: 0, verdict: "rejected", score: 15, reason: "Age and engagement unknown.", angle: null, topic: null, intent: null }],
      })
    );
    await expect(step(placementDraftWorkflow, "draft").run(ctx(db, { businessId: "biz-1", targetId: "t-1" }))).rejects.toThrow(DECLINED_PREFIX);
    expect(db.tables.placement_targets[0].status).toBe("qualified");
    expect(db.tables.placement_targets[0].qualify_score).toBeUndefined();
  });

  it("says the model's true reason when it declines a discovered thread, and offers the way out", async () => {
    // 8 November 2026: the card said "nothing to say here that isn't the
    // product itself" when the model's reason was "outside the business's
    // core expertise". The decline names the reason it had.
    db.tables.placement_targets[0].qualify_angle = null;
    setLlmProvider(
      stubLlm({
        verdicts: [{ index: 0, verdict: "rejected", score: 0, reason: "Outside the business's core expertise in AI SEO content.", angle: null, topic: null, intent: null }],
      })
    );
    const error = (await step(placementDraftWorkflow, "draft")
      .run(ctx(db, { businessId: "biz-1", targetId: "t-1" }))
      .catch((err: unknown) => err)) as Error;
    expect(error).toBeInstanceOf(TerminalStepError);
    expect(error.message).toBe(
      'Not drafted: the AI found nothing worth saying in this thread ("Outside the business\'s core expertise in AI SEO content"). Your call: write it anyway, open it, or reject it.'
    );
    expect(error.message).not.toContain("advert");
    expect(draftFailureForCard(error.message)).toEqual({ kind: "declined", text: error.message });
    expect(NO_ANGLE_MESSAGE.startsWith(DECLINED_PREFIX)).toBe(true);
    expect(db.tables.placement_targets[0].status).toBe("qualified");
  });

  it("writes it anyway when the person asks after a decline: no qualifier, and the drafter is told the person decided", async () => {
    db.tables.placement_targets[0].qualify_angle = BRIEF;
    const prompts: string[] = [];
    setLlmProvider({
      ...stubLlm({ variants: [] }),
      async generateStructured(prompt, schema) {
        prompts.push(prompt);
        const structured = prompt.startsWith("You are deciding which public discussions")
          ? { verdicts: [{ index: 0, verdict: "rejected", score: 0, reason: "Off-topic.", angle: null, topic: null, intent: null }] }
          : { variants: [{ variant: "short_comment", body: GOOD, linkUrl: null, claims: [] }] };
        return stubLlm(structured).generateStructured(prompt, schema);
      },
    });
    const input = { businessId: "biz-1", targetId: "t-1", anyway: true };
    const drafted = (await step(placementDraftWorkflow, "draft").run(ctx(db, input))) as { requalified: string | null };
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).not.toMatch(/^You are deciding which public discussions/);
    expect(prompts[0]).toContain("The owner chose this post themselves and wants to reply to it. Declining is not an option");
    // The brief is no place to start; the drafter finds the angle.
    expect(prompts[0]).not.toContain(BRIEF);
    expect(drafted.requalified).toBeNull();
    expect(db.tables.placement_targets[0].qualify_angle).toBe(BRIEF);
  });

  it("replaces an approved target's brief with a knowledge angle and keeps it approved", async () => {
    db.tables.placement_targets[0].qualify_angle = BRIEF;
    db.tables.placement_targets[0].status = "approved";
    setLlmProvider({
      ...stubLlm({ variants: [] }),
      async generateStructured(prompt, schema) {
        const structured = prompt.startsWith("You are deciding which public discussions")
          ? { verdicts: [{ index: 0, verdict: "qualified", score: 85, reason: "Their topic.", angle: KNOWLEDGE, topic: null, intent: null }] }
          : { variants: [{ variant: "short_comment", body: GOOD, linkUrl: null, claims: [] }] };
        return stubLlm(structured).generateStructured(prompt, schema);
      },
    });
    const drafted = (await step(placementDraftWorkflow, "draft").run(ctx(db, { businessId: "biz-1", targetId: "t-1" }))) as { requalified: string | null };
    expect(drafted.requalified).toBe("qualified");
    expect(db.tables.placement_targets[0].qualify_angle).toBe(KNOWLEDGE);
    expect(db.tables.placement_targets[0].status).toBe("approved");
  });

  it("drafts a target with no angle by asking for one first: a reopened row is not a dead end", async () => {
    db.tables.placement_targets[0].qualify_angle = null;
    const prompts: string[] = [];
    setLlmProvider({
      ...stubLlm({ variants: [] }),
      async generateStructured(prompt, schema) {
        prompts.push(prompt);
        const structured = prompt.startsWith("You are deciding which public discussions")
          ? { verdicts: [{ index: 0, verdict: "qualified", score: 70, reason: "Their topic.", angle: KNOWLEDGE, topic: null, intent: null }] }
          : { variants: [{ variant: "short_comment", body: GOOD, linkUrl: null, claims: [] }] };
        return stubLlm(structured).generateStructured(prompt, schema);
      },
    });
    const drafted = (await step(placementDraftWorkflow, "draft").run(ctx(db, { businessId: "biz-1", targetId: "t-1" }))) as {
      requalified: string | null;
      variants: unknown[];
    };
    expect(prompts).toHaveLength(2);
    expect(drafted.requalified).toBe("qualified");
    expect(drafted.variants).toHaveLength(1);
    expect(db.tables.placement_targets[0].qualify_angle).toBe(KNOWLEDGE);
  });

  it("drafts a post a person chose even when it is off the business's topics: no model vetoes it (8 November 2026)", async () => {
    // The production case: the owner pasted a inkwell_ivy post about
    // turning his sketches into watercolors with AI. The qualifier, asked for an angle,
    // answered "rejected, score 0, outside the business's core expertise in
    // AI SEO content", and the card said there was nothing to say but the
    // product. A person chose the post: it is drafted, from the writer.
    const POST = "I turn my morning sketches into watercolors with AI. Here's today's, a lighthouse I doodled on the train";
    Object.assign(db.tables.placement_targets[0], {
      surface: "x",
      kind: "post",
      community: "@inkwell_ivy",
      author: "inkwell_ivy",
      url: "https://x.com/inkwell_ivy/status/1990000000000000777",
      title: POST,
      excerpt: POST,
      qualify_angle: null,
      qualify_score: null,
      qualify_reason: "Added by you from X.",
      qualified_by: "person",
      qualified_at: "2026-11-08T09:00:00.000Z",
    });
    db.tables.businesses[0].voice_settings = {
      aboutYou: "Former agency designer, co-founded an email-marketing SaaS, working remotely from Taipei.",
    };
    const REPLY =
      "Turning sketches into watercolors with AI is a great habit. Do you scan the page first, or describe the sketch in the prompt? Mine never survive the scan.";
    const prompts: string[] = [];
    setLlmProvider({
      ...stubLlm({ variants: [] }),
      async generateStructured(prompt, schema) {
        prompts.push(prompt);
        const structured = prompt.startsWith("You are deciding which public discussions")
          ? { verdicts: [{ index: 0, verdict: "rejected", score: 0, reason: "Outside the business's core expertise in AI SEO content.", angle: null, topic: null, intent: null }] }
          : { variants: [{ variant: "short_comment", body: REPLY, linkUrl: null, claims: [] }] };
        return stubLlm(structured).generateStructured(prompt, schema);
      },
    });
    const input = { businessId: "biz-1", targetId: "t-1" };
    const drafted = (await step(placementDraftWorkflow, "draft").run(ctx(db, input))) as {
      requalified: string | null;
      variants: Array<{ variant: string; body: string }>;
    };
    // Nobody was asked whether to answer: one call, the drafter's.
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).not.toMatch(/^You are deciding which public discussions/);
    expect(prompts[0]).toContain("The owner chose this post themselves and wants to reply to it. Declining is not an option: write the reply.");
    expect(prompts[0]).toContain("judged against the writer");
    expect(prompts[0]).toContain("Former agency designer");
    expect(drafted.requalified).toBeNull();
    expect(drafted.variants.map((v) => v.body)).toEqual([REPLY]);

    // The gate passes it, though it touches none of the business's topics:
    // that is a note, never a block.
    const audited = await step(placementDraftWorkflow, "audit").run(ctx(db, input, { draft: drafted }));
    expect(audited).toMatchObject({ status: "drafted" });
    expect(db.tables.placements).toHaveLength(1);
    expect(db.tables.placements[0].audit_status).toBe("passed");
    expect(db.tables.placement_targets[0]).toMatchObject({
      status: "drafted",
      qualify_angle: null,
      qualify_score: null,
      qualified_by: "person",
      qualified_at: "2026-11-08T09:00:00.000Z",
    });
  });

  it("drafts only the reply for a hand-added X post, in one call when it passes (9 November 2026)", async () => {
    // The production case: the owner's first hand-added X post took 63 s,
    // because the job asked for a reply and an X Article; the article failed
    // the gate and a second call rewrote it. Only the reply is asked for now,
    // and an article the model returns anyway is dropped, never judged, and
    // never pays for a rewrite.
    const POST = "Is it naive to expect clicks from a new blog in the first months? Getting impressions on Google but nobody clicks.";
    Object.assign(db.tables.placement_targets[0], {
      surface: "x",
      kind: "post",
      community: "@founder",
      author: "founder",
      url: "https://x.com/founder/status/2119419832097812761",
      title: POST,
      excerpt: POST,
      qualify_angle: null,
      qualified_by: "person",
      qualified_at: "2026-11-09T09:00:00.000Z",
    });
    const REPLY = "Not naive at all. My blog had impressions on Google for weeks before anyone clicked. Which queries show you?";
    const prompts: string[] = [];
    setLlmProvider({
      ...stubLlm({ variants: [] }),
      async generateStructured(prompt, schema) {
        prompts.push(prompt);
        return stubLlm({
          variants: [
            { variant: "short_comment", body: REPLY, linkUrl: null, claims: [] },
            { variant: "article_draft", body: "An article nobody asked for.", linkUrl: null, claims: [] },
          ],
        }).generateStructured(prompt, schema);
      },
    });
    const input = { businessId: "biz-1", targetId: "t-1" };
    const drafted = (await step(placementDraftWorkflow, "draft").run(ctx(db, input))) as {
      writes: number;
      variants: Array<{ variant: string; body: string }>;
    };
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("- short_comment: one or two sentences that fit in 280 characters");
    expect(prompts[0]).not.toContain("- article_draft");
    expect(drafted.writes).toBe(1);
    expect(drafted.variants.map((v) => v.variant)).toEqual(["short_comment"]);

    const audited = await step(placementDraftWorkflow, "audit").run(ctx(db, input, { draft: drafted }));
    expect(audited).toMatchObject({ status: "drafted", omitted: [] });
    expect(db.tables.placements.map((row) => row.variant)).toEqual(["short_comment"]);
    expect(db.tables.placements[0].audit_status).toBe("passed");
  });

  it("still drafts the reply and the article on LinkedIn", async () => {
    Object.assign(db.tables.placement_targets[0], { surface: "linkedin", kind: "post", community: "" });
    const prompts: string[] = [];
    setLlmProvider({
      ...stubLlm({ variants: [] }),
      async generateStructured(prompt, schema) {
        prompts.push(prompt);
        return stubLlm({ variants: [{ variant: "short_comment", body: GOOD, linkUrl: null, claims: [] }] }).generateStructured(prompt, schema);
      },
    });
    await step(placementDraftWorkflow, "draft").run(ctx(db, { businessId: "biz-1", targetId: "t-1" }));
    expect(prompts[0]).toContain("- short_comment:");
    expect(prompts[0]).toContain("- article_draft:");
  });

  /**
   * 9 November 2026, the owner's settings and the @abel_codes post as
   * they were. The drafter (version 16) wrote the reply below; it passed,
   * and he read it as AI. The job now deletes its sentences as tells, names
   * them to the rewrite, and holds the reply to his lowercase note.
   */
  const OWNER_VOICE = {
    preset: "warm",
    person: "auto",
    aboutYou:
      "Former agency designer, learned to code at night. Co-founded Postwren, email marketing for Shopify stores: 12 paying stores in October 2026. Since late September an AI pipeline writes and publishes my own blog: 9 impressions a week at the start, 342 in the week of Oct 26, still 0 clicks, articles sit around position 30-40. Left Porto on Oct 27 2026, working from Taipei.",
    instructions:
      "Lowercase, short lines, like a reply typed on a phone. One idea per reply. Lead with a number or a concrete thing I did. Never name a product, never a link. No em dashes, no hashtags, no 'great post', no lists. Disagree when I disagree. Ask one precise question when I have nothing to add.",
  };
  const ALEX_POST =
    'i saw review on X about one tool to find customers and i was like "WTF?? boolshit! does it even work???" so i decided to run the experiment 1) i registered on <link> 2) i found communities w my target audience 3) i set up the campaigns to run on autopilot rn...';
  const ALEX_DRAFT =
    "It's tough to tell if these tools work without knowing if the audience is actually ready to buy. Finding them is one thing, but are they actively looking for a solution? That's the real test.";
  const DANIEL_REPLY =
    "Not naive at all. I'm getting 200+ impressions on my blog now, still zero clicks. Honest numbers take time to compound. What kind of numbers are you seeing?";
  const LOWER_REPLY =
    "i ran the same kind of experiment on my blog, 342 impressions a week and still 0 clicks. did any of those communities turn into customers yet?";

  const xTarget = (excerpt: string) =>
    Object.assign(db.tables.placement_targets[0], {
      surface: "x",
      kind: "post",
      community: "@abel_codes",
      author: "abel_codes",
      url: "https://x.com/abel_codes/status/2119419832097812799",
      title: excerpt.slice(0, 80),
      excerpt,
      qualify_angle: null,
      qualified_by: "person",
    });

  /** An LLM that answers each call with the next body, and records every prompt. */
  const scripted = (bodies: string[], prompts: string[]) => ({
    ...stubLlm({ variants: [] }),
    async generateStructured<T>(prompt: string, schema: z.ZodType<T>) {
      prompts.push(prompt);
      const body = bodies[Math.min(prompts.length, bodies.length) - 1];
      return stubLlm({ variants: [{ variant: "short_comment", body, linkUrl: null, claims: [] }] }).generateStructured(prompt, schema);
    },
  });

  it("writes the X reply of 9 November again, naming the tells it deleted, and keeps the lowercase rewrite", async () => {
    xTarget(ALEX_POST);
    db.tables.businesses[0].voice_settings = OWNER_VOICE;
    const prompts: string[] = [];
    setLlmProvider(scripted([ALEX_DRAFT, LOWER_REPLY], prompts));
    const input = { businessId: "biz-1", targetId: "t-1" };
    const drafted = (await step(placementDraftWorkflow, "draft").run(ctx(db, input))) as {
      writes: number;
      variants: Array<{ body: string }>;
    };
    // The first prompt carries the owner's notes as hard rules.
    expect(prompts[0]).toContain("These are hard rules, not background");
    expect(prompts[0]).toContain("On X, speak from yourself");
    // Every sentence of the first draft was a tell and was deleted; the
    // rewrite is told which, not only that what is left is too short.
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("Deleted before judging, as sentences a model writes and a person does not:");
    expect(prompts[1]).toContain(`it's hard to tell if ("It's tough to tell if")`);
    expect(prompts[1]).toContain(`X is one thing, but Y ("is one thing, but")`);
    expect(prompts[1]).toContain(`that's the real test ("That's the real test")`);
    expect(drafted.writes).toBe(2);
    expect(drafted.variants.map((v) => v.body)).toEqual([LOWER_REPLY]);

    const audited = await step(placementDraftWorkflow, "audit").run(ctx(db, input, { draft: drafted }));
    expect(audited).toMatchObject({ status: "drafted" });
    const saved = db.tables.placements[0] as { audit_status: string; agent_version: number; audit: { checks: Array<{ id: string; status: string }> } };
    expect(saved.audit_status).toBe("passed");
    expect(saved.agent_version).toBe(23);
    expect(saved.audit.checks.find((c) => c.id === "follows_your_notes")?.status).toBe("pass");
  });

  /**
   * 10 November 2026, the same settings. Under a post about a hackathon
   * judged by paying customers the drafter (version 18) led with a figure
   * About you records about another product, and the gate passed it. The
   * post's exact wording was not kept; this is its subject.
   */
  const HACKATHON_POST = "we ran a hackathon where the judges were our paying customers. they picked what ships.";
  const STORES_DRAFT = "12 paying stores for my own thing felt like real validation. letting customers decide is a smart way to run a hackathon.";
  const NO_NUMBER_REPLY = "letting customers decide is a smart way to run a hackathon. did they agree with each other, or split on what ships?";

  it("writes the reply of 10 November again without the other product's number, and tells the drafter which fact is dated", async () => {
    xTarget(HACKATHON_POST);
    db.tables.businesses[0].voice_settings = OWNER_VOICE;
    const prompts: string[] = [];
    setLlmProvider(scripted([STORES_DRAFT, NO_NUMBER_REPLY], prompts));
    const input = { businessId: "biz-1", targetId: "t-1" };
    const drafted = (await step(placementDraftWorkflow, "draft").run(ctx(db, input))) as {
      writes: number;
      variants: Array<{ body: string }>;
    };
    // The first prompt names the site, says a fact is used only where it
    // fits, and hands over the one sentence that is over 30 days old.
    expect(prompts[0]).toContain("This text is written for GetTrafficFast, which is about: AI SEO content.");
    expect(prompts[0]).toContain("When no fact fits, the text carries no number and no fact about you");
    expect(prompts[0]).toContain(
      '- "Co-founded Postwren, email marketing for Shopify stores: 12 paying stores in October 2026." (dated October 2026)'
    );
    expect(prompts[0]).not.toContain("(dated the week of Oct 26, 2026)");
    // The gate refused the draft, and the rewrite is told why.
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('Uses a fact about another product: "12 paying stores" is about Postwren in About you');
    expect(drafted.writes).toBe(2);
    expect(drafted.variants.map((v) => v.body)).toEqual([NO_NUMBER_REPLY]);

    const audited = await step(placementDraftWorkflow, "audit").run(ctx(db, input, { draft: drafted }));
    expect(audited).toMatchObject({ status: "drafted" });
    expect((db.tables.placements[0] as { audit_status: string }).audit_status).toBe("passed");
  });

  it("keeps how the drafter read the post beside the saved draft's verdict", async () => {
    const post =
      "Every time one of my LinkedIn posts gets traction, some 50+ year old CEO turns up to call me a scammer. For sharing my own revenue. Is this the price of posting???";
    const body = "the 50+ ceo calling you a scammer for sharing real numbers is basically a rite of passage on linkedin. did he at least ask for a connection after?";
    xTarget(post);
    db.tables.businesses[0].voice_settings = OWNER_VOICE;
    const prompts: string[] = [];
    setLlmProvider({
      ...stubLlm({ variants: [] }),
      async generateStructured<T>(prompt: string, schema: z.ZodType<T>) {
        prompts.push(prompt);
        return stubLlm({
          reading: { tone: "ironic", means: "He is mocking the CEOs who call him a scammer." },
          variants: [{ variant: "short_comment", body, linkUrl: null, claims: [] }],
        }).generateStructured(prompt, schema);
      },
    });
    const input = { businessId: "biz-1", targetId: "t-1" };
    const drafted = (await step(placementDraftWorkflow, "draft").run(ctx(db, input))) as { writes: number; reading: unknown };
    // One call: the reading comes back with the reply, not from a call of its own.
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("Read the post before you write.");
    expect(drafted.reading).toEqual({ tone: "ironic", means: "He is mocking the CEOs who call him a scammer." });

    await step(placementDraftWorkflow, "audit").run(ctx(db, input, { draft: drafted }));
    const saved = db.tables.placements[0] as { audit_status: string; audit: { status: string; reading?: unknown; checks: unknown[] } };
    expect(saved.audit_status).toBe("passed");
    expect(saved.audit.reading).toEqual({ tone: "ironic", means: "He is mocking the CEOs who call him a scammer." });
    // A first draft answers nobody's note: that check is not in its audit.
    // "Repeats a recent fact" is (since 12 November 2026), with nothing to compare.
    expect(saved.audit.checks).toHaveLength(13);
  });

  it("tells the drafter the facts the last replies used, and rewrites a repeat once, never more (12 November 2026)", async () => {
    // @hank_ships on being called a grifter; four of the business's last
    // replies said "position 30-40", and so does every write here.
    const post =
      "Every few weeks someone calls me a grifter for charging money, as if I'm trying to milk my followers. It stings every time, because I mostly build for the fun of it.";
    const bad =
      "i get that feeling, it's hard when people misinterpret your intentions, especially during a gold rush. i'm still trying to get my blog articles past position 30-40, so i know the grind is real.";
    xTarget(post);
    db.tables.businesses[0].voice_settings = OWNER_VOICE;
    db.tables.placements.push(
      ...["stuck around position 30-40 for weeks.", "position 30-40 on every article so far.", "my articles sit at position 30-40.", "position 30-40, zero clicks."].map(
        (body, index) => ({ id: `old-${index}`, target_id: `old-${index}`, business_id: "biz-1", variant: "short_comment", body, created_at: `2026-11-0${index + 1}T10:00:00Z` })
      )
    );
    const prompts: string[] = [];
    setLlmProvider({
      ...stubLlm({ variants: [] }),
      async generateStructured<T>(prompt: string, schema: z.ZodType<T>) {
        prompts.push(prompt);
        return stubLlm({ variants: [{ variant: "short_comment", body: bad, linkUrl: null, claims: [] }] }).generateStructured(prompt, schema);
      },
    });
    const input = { businessId: "biz-1", targetId: "t-1" };
    const drafted = (await step(placementDraftWorkflow, "draft").run(ctx(db, input))) as { writes: number };
    // One rewrite for the repeat, and no third write: the check is advisory.
    expect(drafted.writes).toBe(2);
    expect(prompts[0]).toContain("Facts you used in your recent replies:");
    expect(prompts[0]).toContain('(in 4 of your last 4 replies, as "position 30-40")');
    expect(prompts[1]).toContain('"position 30-40" is in 4 of your last 4 replies. Say something else, or nothing about yourself.');

    // Saved with the note showing, not refused.
    await step(placementDraftWorkflow, "audit").run(ctx(db, input, { draft: drafted }));
    const saved = db.tables.placements.find((row) => row.target_id === "t-1") as { audit_status: string; audit: { checks: Array<{ id: string; status: string; advisory?: boolean }> } };
    expect(saved.audit_status).toBe("passed");
    expect(saved.audit.checks.find((check) => check.id === "repeats_recent_fact")).toMatchObject({ status: "fail", advisory: true });
  });

  it("saves nothing when every write leads with the other product's number, and says why", async () => {
    xTarget(HACKATHON_POST);
    db.tables.businesses[0].voice_settings = OWNER_VOICE;
    const prompts: string[] = [];
    setLlmProvider(scripted([STORES_DRAFT], prompts));
    const input = { businessId: "biz-1", targetId: "t-1" };
    const drafted = await step(placementDraftWorkflow, "draft").run(ctx(db, input));
    expect(prompts).toHaveLength(MAX_WRITES);
    await expect(step(placementDraftWorkflow, "audit").run(ctx(db, input, { draft: drafted }))).rejects.toThrow(
      /No draft was saved, because none passed the check\. short comment — Uses a fact about another product: "12 paying stores"/
    );
    expect(db.tables.placements).toHaveLength(0);
  });

  it("asks a sentence-case reply again when the notes ask for lowercase, and keeps the lowercase rewrite", async () => {
    xTarget("Honest numbers might be holding my product back. Kind of sad, but it seems true. I make enough to live on.");
    db.tables.businesses[0].voice_settings = OWNER_VOICE;
    const prompts: string[] = [];
    const lower = "not naive at all. 342 impressions a week on my blog, still zero clicks. honest numbers take time. what are you seeing?";
    setLlmProvider(scripted([DANIEL_REPLY, lower], prompts));
    const drafted = (await step(placementDraftWorkflow, "draft").run(ctx(db, { businessId: "biz-1", targetId: "t-1" }))) as {
      writes: number;
      variants: Array<{ body: string }>;
    };
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("Your notes ask for lowercase, and 3 of 3 sentences start with a capital");
    expect(drafted.writes).toBe(2);
    expect(drafted.variants.map((v) => v.body)).toEqual([lower]);
  });

  it("saves the best reply with the lowercase note showing when no rewrite fixes it: a style rule never loses a draft", async () => {
    xTarget("Honest numbers might be holding my product back. Kind of sad, but it seems true. I make enough to live on.");
    db.tables.businesses[0].voice_settings = OWNER_VOICE;
    const prompts: string[] = [];
    setLlmProvider(scripted([DANIEL_REPLY], prompts));
    const input = { businessId: "biz-1", targetId: "t-1" };
    const drafted = (await step(placementDraftWorkflow, "draft").run(ctx(db, input))) as { writes: number };
    expect(prompts).toHaveLength(MAX_WRITES);
    expect(drafted.writes).toBe(MAX_WRITES);

    const audited = await step(placementDraftWorkflow, "audit").run(ctx(db, input, { draft: drafted }));
    expect(audited).toMatchObject({ status: "drafted", omitted: [] });
    const saved = db.tables.placements[0] as { body: string; audit_status: string; audit: { checks: Array<{ id: string; status: string; advisory: boolean }> } };
    expect(saved.body).toBe(DANIEL_REPLY);
    expect(saved.audit_status).toBe("passed");
    expect(saved.audit.checks.find((c) => c.id === "follows_your_notes")).toMatchObject({ status: "warn", advisory: false });
  });

  it("shows a short reply the replies the owner posted, five at most, and records how many", async () => {
    xTarget(ALEX_POST);
    db.tables.businesses[0].voice_settings = OWNER_VOICE;
    for (let i = 0; i < 7; i++) {
      db.tables.placement_targets.push({
        id: `posted-${i}`,
        business_id: "biz-1",
        user_id: "user-1",
        surface: "x",
        status: "published_manually",
        title: `posted thread ${i}`,
        excerpt: `posted thread ${i}`,
        published_at: `2026-11-0${i + 1}T10:00:00.000Z`,
        selected_placement_id: `posted-draft-${i}`,
      });
      db.tables.placements.push({
        id: `posted-draft-${i}`,
        business_id: "biz-1",
        target_id: `posted-${i}`,
        variant: "short_comment",
        body: `reply ${i}, typed on my phone in taipei`,
      });
    }
    const prompts: string[] = [];
    setLlmProvider(scripted([LOWER_REPLY], prompts));
    const drafted = (await step(placementDraftWorkflow, "draft").run(ctx(db, { businessId: "biz-1", targetId: "t-1" }))) as {
      voiceExamples: number;
    };
    expect(drafted.voiceExamples).toBe(5);
    expect(prompts[0]).toContain("Replies you posted, in your own words: match this voice");
    expect(prompts[0].match(/\n {3}You: "/g)).toHaveLength(5);
    // The most recent first: the 7th, 6th, … 3rd.
    expect(prompts[0]).toContain('1. Thread: "posted thread 6"\n   You: "reply 6, typed on my phone in taipei"');
    expect(prompts[0]).not.toContain("reply 1, typed");
    expect(prompts[0].indexOf("Replies you posted")).toBeLessThan(prompts[0].indexOf("The discussion ("));
  });

  it("leaves the section out when nothing was posted", async () => {
    const prompts: string[] = [];
    setLlmProvider(scripted([GOOD], prompts));
    const drafted = (await step(placementDraftWorkflow, "draft").run(ctx(db, { businessId: "biz-1", targetId: "t-1" }))) as {
      voiceExamples: number;
    };
    expect(drafted.voiceExamples).toBe(0);
    expect(prompts[0]).not.toContain("Replies you posted");
  });

  it("tells the drafter the notes the owner gave on earlier drafts, newest first, eight at most, and records how many", async () => {
    xTarget(ALEX_POST);
    db.tables.businesses[0].voice_settings = OWNER_VOICE;
    const note = (id: string, reason: string, at: string, business = "biz-1") => ({
      id,
      user_id: "user-1",
      business_id: business,
      target_id: "t-old",
      reason,
      created_at: at,
    });
    db.tables.draft_feedback = [
      note("f-1", "sounds like AI", "2026-11-09T10:00:00.000Z"),
      note("f-2", "Sounds like AI", "2026-11-09T11:00:00.000Z"),
      note("f-3", "never start with It's", "2026-11-09T12:00:00.000Z"),
      ...Array.from({ length: 8 }, (_, i) => note(`old-${i}`, `older note ${i}`, `2026-11-0${i + 1}T09:00:00.000Z`)),
      // Another business's note is not this writer's.
      note("f-other", "write in French", "2026-11-09T13:00:00.000Z", "biz-2"),
    ];
    const prompts: string[] = [];
    setLlmProvider(scripted([LOWER_REPLY], prompts));
    const drafted = (await step(placementDraftWorkflow, "draft").run(ctx(db, { businessId: "biz-1", targetId: "t-1" }))) as {
      corrections: number;
    };
    expect(drafted.corrections).toBe(8);
    expect(prompts[0]).toContain(
      "Corrections you gave on earlier drafts, avoid repeating these mistakes:\n- never start with It's\n- Sounds like AI\n- older note 7\n"
    );
    // Said once whatever its case, the newest copy kept; the oldest past the eighth left out.
    expect(prompts[0].match(/^- sounds like AI$/gim) ?? []).toHaveLength(1);
    expect(prompts[0]).toContain("- older note 2\n");
    expect(prompts[0]).not.toContain("older note 1");
    expect(prompts[0]).not.toContain("write in French");
    expect(prompts[0].indexOf("Corrections you gave")).toBeLessThan(prompts[0].indexOf("The discussion ("));
  });

  it("drafts without the block when there are no notes, or the notes table cannot be read", async () => {
    const prompts: string[] = [];
    setLlmProvider(scripted([GOOD], prompts));
    const drafted = (await step(placementDraftWorkflow, "draft").run(ctx(db, { businessId: "biz-1", targetId: "t-1" }))) as {
      corrections: number;
    };
    expect(drafted.corrections).toBe(0);
    expect(prompts[0]).not.toContain("Corrections you gave");

    // The migration not applied yet: the read fails, the draft does not.
    const missing = {
      from(table: string) {
        if (table !== "draft_feedback") return db.from(table);
        const chain = {
          select: () => chain,
          eq: () => chain,
          order: () => chain,
          limit: () => Promise.resolve({ data: null, error: { message: 'relation "public.draft_feedback" does not exist' } }),
        };
        return chain;
      },
    };
    const before = prompts.length;
    const again = (await step(placementDraftWorkflow, "draft").run({
      ...ctx(db, { businessId: "biz-1", targetId: "t-1" }),
      supabase: missing as unknown as SupabaseClient,
    })) as { corrections: number; variants: Array<{ body: string }> };
    expect(again.corrections).toBe(0);
    expect(again.variants.map((v) => v.body)).toEqual([GOOD]);
    expect(prompts.length).toBeGreaterThan(before);
    expect(prompts[before]).not.toContain("Corrections you gave");
  });

  it("hands the rewrite the deleted tells first, a style rule's warning, and never an advisory note", () => {
    const removed = removedTellsProblem([`that's the real test ("That's the real test")`]);
    expect(removedTellsProblem([])).toBeNull();
    const problems = problemsOf(
      {
        status: "passed",
        checks: [
          { id: "business_coherence", label: "", status: "warn", detail: "Does not touch any of the business's keywords.", advisory: true },
          { id: "follows_your_notes", label: "", status: "warn", detail: "Your notes ask for lowercase.", advisory: false },
          { id: "human_voice", label: "", status: "pass", detail: "Fine." },
        ],
      },
      removed
    );
    expect(problems).toEqual([removed, "Your notes ask for lowercase."]);
  });

  it("never demotes an approved target on a redraft, and keeps the draft it already has", async () => {
    db.tables.placement_targets[0].status = "approved";
    db.tables.placements.push({
      id: "kept",
      target_id: "t-1",
      business_id: "biz-1",
      variant: "short_comment",
      body: GOOD,
      audit_status: "passed",
    });
    setLlmProvider(stubLlm({ variants: [{ variant: "short_comment", body: "Check out GetTrafficFast.", linkUrl: null, claims: [] }] }));
    const input = { businessId: "biz-1", targetId: "t-1" };
    const drafted = await step(placementDraftWorkflow, "draft").run(ctx(db, input));
    const error = await step(placementDraftWorkflow, "audit")
      .run(ctx(db, input, { draft: drafted }))
      .catch((err: unknown) => err);
    expect(error).toBeInstanceOf(TerminalStepError);
    expect(db.tables.placement_targets[0].status).toBe("approved");
    expect(db.tables.placements.map((row) => row.id)).toEqual(["kept"]);
  });
});
