import { FakeSupabase } from "./fake-supabase";

/**
 * One site's AI Visibility data, for the route and tool tests that read it:
 * site biz-1 of user-1 with two prompts (one enabled), two completed runs
 * over the same prompts and engines, a later run that failed before asking
 * anything, a probe whose prompt was deleted, and one run and one prompt of
 * the same user's other site (biz-2) that must never show.
 */

const owned = { user_id: "user-1", business_id: "biz-1" };

export function visibilitySeed() {
  const probe = (id: string, runId: string, queryId: string | null, query: string, engine: string, status: string, over: Record<string, unknown> = {}) => ({
    id,
    run_id: runId,
    ...owned,
    query_id: queryId,
    query,
    cluster: "basics",
    engine,
    model: null,
    status,
    cited: status === "cited" ? true : status === "not_cited" ? false : null,
    source_url: status === "cited" ? "https://acme.test/ai-seo" : null,
    position: status === "cited" ? 2 : null,
    mentioned: false,
    answer_excerpt: "An answer.",
    sources: [{ url: "https://rival.test/a", domain: "rival.test", title: "Rival" }],
    competitors: [{ domain: "rival.test", name: "Rival", via: "source" }],
    error: null,
    latency_ms: 900,
    cost_usd: 0.002,
    probe_version: 1,
    checked_at: runId === "run-2" ? "2026-11-08T10:00:00.000Z" : "2026-11-01T10:00:00.000Z",
    created_at: runId === "run-2" ? "2026-11-08T10:00:00.000Z" : "2026-11-01T10:00:00.000Z",
    ...over,
  });
  const run = (id: string, startedAt: string, over: Record<string, unknown> = {}) => ({
    id,
    ...owned,
    status: "completed",
    trigger: "manual",
    engines: ["gemini", "perplexity"],
    query_count: 2,
    query_fingerprint: "fp-1",
    planned_probes: 4,
    cost_usd: 0.008,
    started_at: startedAt,
    finished_at: startedAt,
    error: null,
    created_at: startedAt,
    ...over,
  });
  return new FakeSupabase({
    businesses: [
      {
        id: "biz-1",
        user_id: "user-1",
        name: "Acme",
        website_url: "https://acme.test",
        aeo_settings: { brandNames: ["Acme"], domains: ["blog.acme.test"], engines: [], cadence: "weekly", maxQueriesPerRun: 20 },
      },
      { id: "biz-2", user_id: "user-1", name: "Bravo", website_url: "https://bravo.test", aeo_settings: {} },
    ],
    aeo_queries: [
      { id: "q-1", ...owned, query: "best ai seo tool", cluster: "basics", intent: "commercial", enabled: true, source: "manual", created_at: "2026-10-01T00:00:00.000Z" },
      { id: "q-2", ...owned, query: "what is aeo", cluster: null, intent: null, enabled: false, source: "suggested", created_at: "2026-10-02T00:00:00.000Z" },
      { id: "q-9", user_id: "user-1", business_id: "biz-2", query: "other site", cluster: null, intent: null, enabled: true, source: "manual", created_at: "2026-10-03T00:00:00.000Z" },
    ],
    aeo_runs: [
      run("run-1", "2026-11-01T10:00:00.000Z"),
      run("run-2", "2026-11-08T10:00:00.000Z"),
      run("run-3", "2026-11-09T09:00:00.000Z", { status: "failed", planned_probes: 0, error: "No prompts enabled." }),
      run("run-9", "2026-11-09T09:30:00.000Z", { business_id: "biz-2" }),
    ],
    aeo_probes: [
      probe("p-1", "run-1", "q-1", "best ai seo tool", "gemini", "not_cited"),
      probe("p-2", "run-1", "q-1", "best ai seo tool", "perplexity", "not_cited"),
      probe("p-3", "run-2", "q-1", "best ai seo tool", "gemini", "cited"),
      probe("p-4", "run-2", "q-1", "best ai seo tool", "perplexity", "error", { error: "timeout", answer_excerpt: null }),
      probe("p-5", "run-2", null, "retired prompt", "gemini", "not_cited"),
    ],
    articles: [
      { id: "art-1", ...owned, status: "published", published_url: "https://acme.test/ai-seo", title: "AI SEO", keywords: { keyword: "ai seo" } },
      { id: "art-2", ...owned, status: "generated", published_url: null, title: "Best AI SEO tool", keywords: { keyword: "Best AI SEO tool" } },
    ],
    placement_targets: [
      { id: "t-1", ...owned, surface: "reddit", title: "Which tool?", url: "https://reddit.com/r/seo/1", status: "published_manually", published_url: "https://reddit.com/r/seo/1/c", published_at: "2026-11-02T00:00:00.000Z", aeo_query_id: "q-1" },
    ],
  });
}
