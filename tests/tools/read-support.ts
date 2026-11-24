import type { CanonicalArticle } from "@/lib/content/types";
import { FakeSupabase } from "../support/fake-supabase";
import { OTHER, SITE_A, SITE_B, SITE_C, USER, businesses, uuid } from "./support";

/**
 * One account with two sites (A and B) and another account (C), with a row
 * of every table the read tools reach on each: a read tool test runs as an
 * API-key caller on A (tests/tools/support.ts, `apiCaller`) and asserts it
 * sees A's rows only, and that an id of B or C is a 404.
 */

export const A = { user_id: USER, business_id: SITE_A };
export const B = { user_id: USER, business_id: SITE_B };
export const C = { user_id: OTHER, business_id: SITE_C };

export const ART_A1 = uuid("1", 1);
export const ART_A2 = uuid("1", 2);
export const ART_A3 = uuid("1", 3);
export const ART_B = uuid("1", 8);
export const ART_C = uuid("1", 9);
export const KW_A1 = uuid("2", 1);
export const KW_A2 = uuid("2", 2);
export const KW_A3 = uuid("2", 3);
export const KW_A4 = uuid("2", 4);
export const KW_B = uuid("2", 8);
export const Q_A1 = uuid("3", 1);
export const Q_A2 = uuid("3", 2);
export const Q_B = uuid("3", 8);
export const Q_C = uuid("3", 9);
export const RUN_A1 = uuid("4", 1);
export const RUN_A2 = uuid("4", 2);
export const RUN_B = uuid("4", 8);
export const T_A = uuid("5", 1);

export const CANONICAL: CanonicalArticle = {
  schemaVersion: 1,
  articleId: ART_A1,
  title: "AI SEO, plainly",
  bodyHtml: '<h2 id="what">What it is</h2><p>Answers first.</p>',
  headings: [{ level: 2, id: "what", text: "What it is" }],
  excerpt: "Answers first.",
  metaDescription: "Answers first.",
  wordCount: 2,
  slug: "ai-seo",
  keyword: "ai seo",
  language: "en",
  scheduledDate: "2026-11-01",
  media: {
    hero: { url: "https://cdn.gettrafficfa.st/h.png", alt: "A chart", caption: null, slot: null },
    images: [],
    videos: [],
  },
};

export const QUALITY = {
  decision: "needs_review",
  ranAt: "2026-11-01T08:00:00.000Z",
  wordCount: 2,
  issues: [{ code: "ARTICLE_TOO_SHORT", action: "review", stage: "quality", message: "Too short." }],
  stages: [],
};

function probe(id: string, runId: string, queryId: string | null, engine: string, status: string, site = A) {
  return {
    id,
    run_id: runId,
    ...site,
    query_id: queryId,
    query: "best ai seo tool",
    cluster: "tools",
    engine,
    model: null,
    status,
    cited: status === "cited" ? true : status === "not_cited" ? false : null,
    source_url: status === "cited" ? "https://acme.test/ai-seo" : null,
    position: status === "cited" ? 1 : null,
    mentioned: false,
    answer_excerpt: "An answer.",
    sources: [{ url: "https://rival.test/x", domain: "rival.test", title: "Rival" }],
    competitors: [{ domain: "rival.test", name: "Rival", via: "source" }],
    error: null,
    latency_ms: 800,
    cost_usd: 0.002,
    probe_version: 1,
    checked_at: runId === RUN_A2 ? "2026-11-08T10:00:00.000Z" : "2026-11-01T10:00:00.000Z",
    created_at: runId === RUN_A2 ? "2026-11-08T10:00:00.000Z" : "2026-11-01T10:00:00.000Z",
  };
}

function run(id: string, startedAt: string, site = A) {
  return {
    id,
    ...site,
    status: "completed",
    trigger: "schedule",
    engines: ["gemini", "perplexity"],
    query_count: 1,
    query_fingerprint: "fp",
    planned_probes: 2,
    cost_usd: 0.004,
    started_at: startedAt,
    finished_at: startedAt,
    error: null,
  };
}

export function readSeed() {
  return new FakeSupabase({
    businesses: businesses().map((b) =>
      b.id === SITE_A
        ? {
            ...b,
            niche: "SEO tools",
            description: "Acme helps small teams rank.",
            sitemap_url: null,
            blog_url: "https://acme.test/blog",
            is_locked: true,
            automation_settings: { enabled: true, bufferDays: 7 },
            // The old switch is ignored; the style was chosen on this day.
            media_settings: { imagesEnabled: false, styleChosen: true, styleChosenAt: "2026-11-01T09:00:00.000Z" },
            aeo_settings: { brandNames: ["Acme"], engines: ["gemini"], cadence: "weekly" },
            voice_settings: { preset: "casual", person: "we", aboutYou: "We build Acme.", instructions: "Never say leverage." },
            updated_at: "2026-11-01T00:00:00.000Z",
          }
        : b
    ),
    articles: [
      {
        id: ART_A1,
        ...A,
        status: "published",
        scheduled_date: "2026-11-01",
        published_url: "https://acme.test/ai-seo",
        last_error: null,
        keyword_id: KW_A1,
        content: null,
        canonical: CANONICAL,
        quality_report: QUALITY,
        title: "AI SEO, plainly",
        created_at: "2026-11-01T08:00:00.000Z",
        updated_at: "2026-11-01T09:00:00.000Z",
        keywords: { id: KW_A1, keyword: "ai seo", search_volume: 900 },
      },
      {
        id: ART_A2,
        ...A,
        status: "queued",
        scheduled_date: "2026-11-12",
        published_url: null,
        last_error: null,
        keyword_id: KW_A2,
        content: null,
        canonical: null,
        quality_report: null,
        title: null,
        created_at: "2026-11-05T08:00:00.000Z",
        keywords: { id: KW_A2, keyword: "aeo", search_volume: null },
      },
      {
        id: ART_A3,
        ...A,
        status: "published",
        scheduled_date: "2026-10-20",
        published_url: "https://acme.test/legacy",
        last_error: null,
        keyword_id: null,
        content: "<h1>Legacy</h1><p>Old <strong>body</strong>.</p>",
        canonical: null,
        quality_report: null,
        title: null,
        created_at: "2026-10-20T08:00:00.000Z",
        keywords: null,
      },
      { id: ART_B, ...B, status: "published", scheduled_date: "2026-11-02", canonical: CANONICAL, keywords: null, created_at: "2026-11-02T08:00:00.000Z" },
      { id: ART_C, ...C, status: "published", scheduled_date: "2026-11-02", canonical: CANONICAL, keywords: null, created_at: "2026-11-02T08:00:00.000Z" },
    ],
    keywords: [
      { id: KW_A1, ...A, keyword: "ai seo", search_volume: 900, competition: "Medium", difficulty: 40, cpc: 2.5, opportunity: "High", status: "published", is_starred: true, article_id: ART_A1, created_at: "2026-10-01T00:00:00.000Z" },
      { id: KW_A2, ...A, keyword: "aeo", search_volume: null, competition: "Low", difficulty: 20, cpc: null, opportunity: "High", status: "queued", is_starred: false, article_id: ART_A2, created_at: "2026-10-02T00:00:00.000Z" },
      { id: KW_A3, ...A, keyword: "llm seo checklist", search_volume: 300, competition: "Low", difficulty: 35, cpc: 1.1, opportunity: "High", status: "available", is_starred: false, article_id: null, created_at: "2026-10-03T00:00:00.000Z" },
      { id: KW_A4, ...A, keyword: "enterprise seo", search_volume: 5000, competition: "High", difficulty: 85, cpc: 9, opportunity: "High", status: "available", is_starred: true, article_id: null, created_at: "2026-10-04T00:00:00.000Z" },
      { id: KW_B, ...B, keyword: "bravo keyword", search_volume: 100, competition: "Low", difficulty: 10, cpc: 1, opportunity: "High", status: "available", is_starred: false, article_id: null, created_at: "2026-10-05T00:00:00.000Z" },
    ],
    publish_attempts: [
      { id: uuid("6", 1), ...A, article_id: ART_A1, integration_type: "webhook", ok: true, published_url: "https://acme.test/ai-seo", error: null, created_at: "2026-11-01T09:00:00.000Z", payload: { secret: "never" } },
      { id: uuid("6", 2), ...A, article_id: ART_A3, integration_type: "wordpress", ok: false, published_url: null, error: "HTTP 401", created_at: "2026-11-02T09:00:00.000Z" },
      { id: uuid("6", 8), ...B, article_id: ART_B, integration_type: "webhook", ok: true, published_url: "https://bravo.test/x", error: null, created_at: "2026-11-03T09:00:00.000Z" },
    ],
    integrations: [
      {
        id: uuid("7", 1),
        ...A,
        type: "wordpress",
        status: "connected",
        last_error: null,
        last_sync_at: "2026-11-01T09:00:00.000Z",
        created_at: "2026-10-01T00:00:00.000Z",
        config: { site_url: "https://acme.test", username: "editor", application_password_encrypted: "SECRET-WP" },
      },
      {
        id: uuid("7", 2),
        ...A,
        type: "webhook",
        status: "error",
        last_error: "HTTP 500",
        last_sync_at: null,
        created_at: "2026-10-02T00:00:00.000Z",
        config: { url: "https://hooks.acme.test/gtf", secret_encrypted: "SECRET-HOOK" },
      },
      { id: uuid("7", 8), ...B, type: "webhook", status: "connected", config: { url: "https://bravo.test/hook" } },
    ],
    analytics_connections: [
      {
        id: uuid("8", 1),
        ...A,
        provider: "search_console",
        site_url: "sc-domain:acme.test",
        status: "connected",
        last_error: null,
        last_synced_on: "2026-11-06",
        updated_at: "2026-11-09T07:00:00.000Z",
        refresh_token_encrypted: "SECRET-REFRESH",
      },
    ],
    content_metrics: [
      { ...A, article_id: ART_A1, captured_on: "2026-11-05", source: "search_console", position: 6.5, impressions: 200, clicks: 9 },
      { ...A, article_id: ART_A3, captured_on: "2026-11-04", source: "serp", position: null, impressions: null, clicks: null },
      { ...B, article_id: ART_B, captured_on: "2026-11-04", source: "serp", position: 2, impressions: null, clicks: null },
    ],
    ai_citations: [
      { ...A, article_id: ART_A1, checked_on: "2026-11-05", engine: "gemini", cited: true },
      { ...A, article_id: ART_A1, checked_on: "2026-11-05", engine: "perplexity", cited: false },
      { ...A, article_id: ART_A3, checked_on: "2026-11-06", engine: "gemini", cited: false },
    ],
    aeo_queries: [
      { id: Q_A1, ...A, query: "best ai seo tool", cluster: "tools", intent: "commercial", enabled: true, source: "manual", created_at: "2026-10-01T00:00:00.000Z" },
      { id: Q_A2, ...A, query: "what is aeo", cluster: null, intent: null, enabled: false, source: "suggested", created_at: "2026-10-02T00:00:00.000Z" },
      { id: Q_B, ...B, query: "bravo prompt", cluster: null, intent: null, enabled: true, source: "manual", created_at: "2026-10-03T00:00:00.000Z" },
      { id: Q_C, ...C, query: "charlie prompt", cluster: null, intent: null, enabled: true, source: "manual", created_at: "2026-10-03T00:00:00.000Z" },
    ],
    aeo_runs: [run(RUN_A1, "2026-11-01T10:00:00.000Z"), run(RUN_A2, "2026-11-08T10:00:00.000Z"), run(RUN_B, "2026-11-09T10:00:00.000Z", B)],
    aeo_probes: [
      probe(uuid("9", 1), RUN_A1, Q_A1, "gemini", "not_cited"),
      probe(uuid("9", 2), RUN_A1, Q_A1, "perplexity", "not_cited"),
      probe(uuid("9", 3), RUN_A2, Q_A1, "gemini", "cited"),
      probe(uuid("9", 4), RUN_A2, Q_A1, "perplexity", "error"),
      probe(uuid("9", 8), RUN_B, Q_B, "gemini", "cited", B),
    ],
    placement_targets: [
      { id: T_A, ...A, surface: "reddit", title: "Which tool?", url: "https://reddit.com/r/seo/1", status: "drafted", found_via: "manual", published_url: null, published_at: null, aeo_query_id: Q_A1 },
      { id: uuid("5", 8), ...B, surface: "x", title: "B", url: "https://x.com/b/status/1", status: "drafted", found_via: "manual", published_at: null, aeo_query_id: Q_B },
    ],
    draft_feedback: [
      { id: uuid("a", 1), ...A, target_id: T_A, placement_id: null, reason: "too long", body_before: "A long draft.", body_after: "Short.", promoted_to_notes: true, created_at: "2026-11-02T00:00:00.000Z" },
      { id: uuid("a", 2), ...A, target_id: T_A, placement_id: null, reason: "sounds like AI", body_before: "Delve.", body_after: null, promoted_to_notes: false, created_at: "2026-11-03T00:00:00.000Z" },
      { id: uuid("a", 8), ...B, target_id: uuid("5", 8), placement_id: null, reason: "bravo note", body_before: null, body_after: null, promoted_to_notes: false, created_at: "2026-11-04T00:00:00.000Z" },
    ],
    subscriptions: [
      {
        id: uuid("b", 1),
        user_id: USER,
        stripe_customer_id: "cus_1",
        stripe_subscription_id: "sub_1",
        status: "trialing",
        current_period_start: "2026-11-01T00:00:00.000Z",
        // Live whatever day the suite runs: every tool needs a plan (lib/tools/runner.ts).
        current_period_end: "2099-11-15T00:00:00.000Z",
        cancel_at_period_end: false,
        created_at: "2026-11-01T00:00:00.000Z",
        updated_at: "2026-11-01T00:00:00.000Z",
      },
      {
        id: uuid("b", 9),
        user_id: OTHER,
        stripe_customer_id: "cus_9",
        stripe_subscription_id: "sub_9",
        status: "past_due",
        current_period_start: null,
        current_period_end: null,
        cancel_at_period_end: true,
        created_at: "2026-11-01T00:00:00.000Z",
        updated_at: "2026-11-01T00:00:00.000Z",
      },
    ],
    jobs: [],
  });
}
