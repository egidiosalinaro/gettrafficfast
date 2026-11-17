import type { SupabaseClient } from "@supabase/supabase-js";
import { getCitationProviders } from "@/lib/providers/citations/registry";
import { parseAiCitation } from "@/lib/placements/ai-citation";
import { OPEN_STATUSES } from "@/lib/placements/workflow";
import { businessIdentity, parseAeoSettings, type AeoSettings, type BusinessIdentity } from "./settings";
import { mapProbe, mapRun, PROBE_COLUMNS, RUN_COLUMNS } from "./store";
import {
  compareRuns,
  queryHistory,
  queryRows,
  recurringCompetitors,
  recurringSources,
  summarizeRun,
  type EngineHistory,
  type ProbeRecord,
  type QueryRow,
  type RecurringDomain,
  type RecurringSource,
  type RunComparison,
  type RunRecord,
  type RunSummary,
} from "./summary";

/**
 * What the AI Visibility screens read, assembled in one place so the
 * dashboard, the query detail and the visibility tools
 * (lib/tools/read-visibility.ts) cannot compute a different number from the
 * same rows.
 *
 * Every read goes through the caller's own Supabase client, so RLS is the
 * access control; `businessId` is a filter on top, never a substitute for it.
 */

export interface AeoQueryRecord {
  id: string;
  query: string;
  cluster: string | null;
  intent: string | null;
  enabled: boolean;
  source: string;
  createdAt: string;
}

export interface VisibilityOverview {
  business: { name: string | null; websiteUrl: string | null };
  identity: BusinessIdentity;
  settings: AeoSettings;
  /** Engines the platform has keys for. What can be asked at all. */
  configuredEngines: string[];
  /** Engines a run will use: the configured ones the business selected. */
  activeEngines: string[];
  queries: { total: number; enabled: number; clusters: string[] };
  latestRun: RunRecord | null;
  /** A run that failed before planning anything, more recent than latestRun. */
  lastError: string | null;
  summary: RunSummary | null;
  comparison: RunComparison | null;
  rows: QueryRow[];
  runs: RunRecord[];
  competitors: RecurringDomain[];
  sources: RecurringSource[];
  /**
   * Open rows of the Replies inbox that a sampled answer cited (`open`), and
   * of those, the ones whose latest sighting is the run shown here
   * (`fromLatestRun`): what the Prompts page's places line counts. Null when
   * it could not be read (unknown, not zero); absent on a payload older than
   * the feature.
   */
  places?: { open: number; fromLatestRun: number } | null;
}

type Row = Record<string, unknown>;

export function mapQuery(row: Row): AeoQueryRecord {
  return {
    id: row.id as string,
    query: row.query as string,
    cluster: (row.cluster as string | null) ?? null,
    intent: (row.intent as string | null) ?? null,
    enabled: Boolean(row.enabled),
    source: (row.source as string) ?? "manual",
    createdAt: row.created_at as string,
  };
}

export const QUERY_COLUMNS = "id, query, cluster, intent, enabled, source, created_at";

export function activeEngines(configured: string[], settings: AeoSettings): string[] {
  return settings.engines.length === 0
    ? configured
    : configured.filter((name) => settings.engines.includes(name));
}

/**
 * The site's prompt set, by cluster then age: what the Prompts list shows
 * (GET /api/visibility/queries) and `list_prompts` answers.
 */
export async function listQueries(
  supabase: SupabaseClient,
  businessId: string
): Promise<{ ok: true; queries: AeoQueryRecord[] } | { ok: false; error: string }> {
  const { data, error } = await supabase
    .from("aeo_queries")
    .select(QUERY_COLUMNS)
    .eq("business_id", businessId)
    .order("cluster", { ascending: true, nullsFirst: false })
    .order("created_at", { ascending: true });
  if (error) return { ok: false, error: error.message };
  return { ok: true, queries: ((data ?? []) as Row[]).map(mapQuery) };
}

/** The most runs a list reads at once. */
export const MAX_RUNS = 50;

/** The site's runs, newest first: the dashboard's "Previous runs", and `list_visibility_runs`. */
export async function listRuns(supabase: SupabaseClient, businessId: string, limit = 12): Promise<RunRecord[]> {
  const { data, error } = await supabase
    .from("aeo_runs")
    .select(RUN_COLUMNS)
    .eq("business_id", businessId)
    .order("started_at", { ascending: false })
    .limit(Math.max(1, Math.min(Math.floor(limit), MAX_RUNS)));
  if (error) throw new Error(`aeo runs: ${error.message}`);
  return ((data ?? []) as Row[]).map(mapRun);
}

export interface VisibilitySettingsView {
  settings: AeoSettings;
  identity: BusinessIdentity;
  /** Engines the platform has keys for: what a run can ask at all. */
  configuredEngines: string[];
  business: { name: unknown; websiteUrl: unknown };
}

/**
 * Settings → AI Visibility as the form reads it (GET
 * /api/visibility/settings) and `get_visibility_settings` answers: what
 * counts as this site, which engines, how often. Null when the user owns no
 * such site.
 */
export async function loadVisibilitySettings(
  supabase: SupabaseClient,
  userId: string,
  businessId: string
): Promise<VisibilitySettingsView | null> {
  const { data: business } = await supabase
    .from("businesses")
    .select("name, website_url, aeo_settings")
    .eq("id", businessId)
    .eq("user_id", userId)
    .maybeSingle();
  if (!business) return null;

  const settings = parseAeoSettings(business.aeo_settings);
  return {
    settings,
    identity: businessIdentity(
      { name: business.name as string | null, website_url: business.website_url as string | null },
      settings
    ),
    configuredEngines: getCitationProviders().map((p) => p.name),
    business: { name: business.name, websiteUrl: business.website_url },
  };
}

async function loadProbes(supabase: SupabaseClient, runId: string): Promise<ProbeRecord[]> {
  const { data, error } = await supabase
    .from("aeo_probes")
    .select(PROBE_COLUMNS)
    .eq("run_id", runId)
    .order("created_at", { ascending: true });
  if (error) throw new Error(`aeo probes: ${error.message}`);
  return ((data ?? []) as Row[]).map(mapProbe);
}

export async function loadOverview(
  supabase: SupabaseClient,
  businessId: string
): Promise<VisibilityOverview> {
  const [{ data: business }, { data: queryRowsRaw }, runs] = await Promise.all([
    supabase
      .from("businesses")
      .select("name, website_url, aeo_settings")
      .eq("id", businessId)
      .maybeSingle(),
    supabase
      .from("aeo_queries")
      .select("id, enabled, cluster")
      .eq("business_id", businessId),
    // An unreadable run list shows as no runs, as it always has here.
    listRuns(supabase, businessId, 12).catch(() => [] as RunRecord[]),
  ]);

  const settings = parseAeoSettings(business?.aeo_settings);
  const identity = businessIdentity(
    {
      name: (business?.name as string | null) ?? null,
      website_url: (business?.website_url as string | null) ?? null,
    },
    settings
  );
  const configured = getCitationProviders().map((p) => p.name);
  const queries = (queryRowsRaw ?? []) as Array<{ id: string; enabled: boolean; cluster: string | null }>;

  // The run shown is the latest one that planned anything. A run that failed
  // before asking a single question (no queries, no engine) is reported as
  // the last error instead of replacing the numbers of the run before it.
  const latest = runs.find((r) => r.status !== "failed" || r.plannedProbes > 0) ?? runs[0] ?? null;
  const lastError = runs[0] && runs[0].status === "failed" && runs[0].id !== latest?.id ? runs[0].error : null;
  const previous = runs.find((r) => r.id !== latest?.id && r.status === "completed") ?? null;
  const places = await countCitedPlaces(supabase, businessId, latest?.id ?? null);

  let summary: RunSummary | null = null;
  let comparison: RunComparison | null = null;
  let rows: QueryRow[] = [];
  let competitors: RecurringDomain[] = [];
  let sources: RecurringSource[] = [];

  if (latest) {
    const [currentProbes, previousProbes] = await Promise.all([
      loadProbes(supabase, latest.id),
      previous ? loadProbes(supabase, previous.id) : Promise.resolve([] as ProbeRecord[]),
    ]);
    summary = summarizeRun(latest, currentProbes);
    comparison = compareRuns(
      { run: latest, summary },
      previous ? { run: previous, summary: summarizeRun(previous, previousProbes) } : null
    );
    rows = queryRows(currentProbes, previousProbes);
    competitors = recurringCompetitors(currentProbes);
    sources = recurringSources(currentProbes);
  }

  return {
    business: {
      name: (business?.name as string | null) ?? null,
      websiteUrl: (business?.website_url as string | null) ?? null,
    },
    identity,
    settings,
    configuredEngines: configured,
    activeEngines: activeEngines(configured, settings),
    queries: {
      total: queries.length,
      enabled: queries.filter((q) => q.enabled).length,
      clusters: [...new Set(queries.map((q) => q.cluster).filter((c): c is string => Boolean(c)))].sort(),
    },
    latestRun: latest,
    lastError,
    summary,
    comparison,
    rows,
    runs,
    competitors,
    sources,
    places,
  };
}

/**
 * How many open reply targets rest on a sampled citation, and how many of
 * them `runId` cited last: a run that cites a page already in the inbox
 * writes its own sighting on the row, so this is every open page that run's
 * answers sent or sent again. A read that fails (the column arrives with
 * migration 20261110180000) is null, never 0.
 */
export async function countCitedPlaces(
  supabase: SupabaseClient,
  businessId: string,
  runId: string | null
): Promise<{ open: number; fromLatestRun: number } | null> {
  const { data, error } = await supabase
    .from("placement_targets")
    .select("id, status, ai_citation")
    .eq("business_id", businessId)
    .in("status", OPEN_STATUSES)
    .not("ai_citation", "is", null)
    .limit(500);
  if (error) return null;
  const citations = ((data ?? []) as Row[]).map((row) => parseAiCitation(row.ai_citation)).filter((c) => c !== null);
  return {
    open: citations.length,
    fromLatestRun: runId ? citations.filter((c) => c.runId === runId).length : 0,
  };
}

export interface RelatedArticle {
  id: string;
  title: string | null;
  keyword: string;
  publishedUrl: string | null;
  status: string;
  /** How it relates: the keyword matches the question, or the engine cited it. */
  via: "keyword" | "cited";
}

export interface RelatedPlacement {
  id: string;
  surface: string;
  title: string;
  url: string;
  status: string;
  publishedUrl: string | null;
  publishedAt: string | null;
}

export interface QueryDetail {
  query: AeoQueryRecord;
  history: EngineHistory[];
  /** Every probe, newest first, for the timeline. */
  probes: ProbeRecord[];
  competitors: RecurringDomain[];
  sources: RecurringSource[];
  articles: RelatedArticle[];
  placements: RelatedPlacement[];
}

export async function loadQueryDetail(
  supabase: SupabaseClient,
  businessId: string,
  queryId: string
): Promise<QueryDetail | null> {
  const { data: queryRow } = await supabase
    .from("aeo_queries")
    .select(QUERY_COLUMNS)
    .eq("id", queryId)
    .eq("business_id", businessId)
    .maybeSingle();
  if (!queryRow) return null;
  const query = mapQuery(queryRow as Row);

  const { data: probeRows } = await supabase
    .from("aeo_probes")
    .select(PROBE_COLUMNS)
    .eq("query_id", queryId)
    .eq("business_id", businessId)
    .order("checked_at", { ascending: false })
    .limit(400);
  const probes = ((probeRows ?? []) as Row[]).map(mapProbe);

  // On-site content that answers this question: the article written for the
  // matching keyword, and any page an engine actually cited for it. Both are
  // facts about this business's own rows; nothing is guessed from titles.
  const citedUrls = [...new Set(probes.map((p) => p.sourceUrl).filter((u): u is string => Boolean(u)))];
  const { data: articleRows } = await supabase
    .from("articles")
    .select(
      `id, status, published_url, title:canonical->>title,
       keywords!articles_keyword_id_fkey ( keyword )`
    )
    .eq("business_id", businessId)
    .in("status", ["published", "generated", "needs_review"])
    .limit(200);

  const normalizeUrl = (url: string) => url.replace(/\/+$/, "").toLowerCase();
  const wanted = new Set(citedUrls.map(normalizeUrl));
  const articles: RelatedArticle[] = [];
  for (const row of (articleRows ?? []) as Row[]) {
    const kw = row.keywords as { keyword?: string } | { keyword?: string }[] | null;
    const keyword = (Array.isArray(kw) ? kw[0]?.keyword : kw?.keyword) ?? "";
    const publishedUrl = (row.published_url as string | null) ?? null;
    const cited = publishedUrl ? wanted.has(normalizeUrl(publishedUrl)) : false;
    const byKeyword = keyword.trim().toLowerCase() === query.query.trim().toLowerCase();
    if (!cited && !byKeyword) continue;
    articles.push({
      id: row.id as string,
      title: (row.title as string | null) ?? null,
      keyword,
      publishedUrl,
      status: row.status as string,
      via: cited ? "cited" : "keyword",
    });
  }

  const { data: placementRows } = await supabase
    .from("placement_targets")
    .select("id, surface, title, url, status, published_url, published_at")
    .eq("business_id", businessId)
    .eq("aeo_query_id", queryId)
    .order("published_at", { ascending: false, nullsFirst: false })
    .limit(50);

  return {
    query,
    history: queryHistory(probes),
    probes,
    competitors: recurringCompetitors(probes),
    sources: recurringSources(probes),
    articles,
    placements: ((placementRows ?? []) as Row[]).map((row) => ({
      id: row.id as string,
      surface: row.surface as string,
      title: row.title as string,
      url: row.url as string,
      status: row.status as string,
      publishedUrl: (row.published_url as string | null) ?? null,
      publishedAt: (row.published_at as string | null) ?? null,
    })),
  };
}
