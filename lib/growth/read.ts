import type { SupabaseClient } from "@supabase/supabase-js";
import { listIndexStatus } from "@/lib/analytics/index-status";
import { FIRST_SYNC_DAYS, SEARCH_CONSOLE } from "@/lib/analytics/search-console";
import { loadSearchConsoleStatus } from "@/lib/lifecycle/load-results";
import { parseAiCitation } from "@/lib/placements/ai-citation";
import { loadReplyStats } from "@/lib/placements/reply-stats-read";
import { OPEN_STATUSES } from "@/lib/placements/workflow";
import { canonicalTarget } from "@/lib/providers/discovery/canonical";
import { domainOf } from "@/lib/providers/citations/types";
import type { CitationSource } from "@/lib/providers/citations/types";
import { isSourceRedirect } from "@/lib/providers/citations/resolve";
import { getCitationProviders } from "@/lib/providers/citations/registry";
import { isCompanySource } from "@/lib/domain/source-matching";
import { activeEngines, countCitedPlaces, listRuns } from "@/lib/visibility/read";
import { businessIdentity, parseAeoSettings } from "@/lib/visibility/settings";
import type { RunRecord } from "@/lib/visibility/summary";
import { markSources, summarizeAsks, type AiAnswer, type AnswerStatus, type Ask, type OpenPlace } from "./ai";
import { coverageStart, summarizeSearchGrowth, type SearchDay } from "./google";
import { periodWindows, utcDay, type GrowthDays } from "./period";
import type { AiAnswersPage, GoogleGrowth, GrowthSummary } from "./schema";

/**
 * Reading Growth (docs/LIFECYCLE.md, "Growth"): the three blocks of
 * `/growth` and the evidence of `/growth/ai`, assembled once for the routes
 * (GET /api/growth, GET /api/growth/answers) and the tools (`get_growth`,
 * `list_ai_answers`), so a screen and an agent cannot read two numbers from
 * the same rows. Stored rows only: no engine, no Google, no X is asked here.
 *
 * Every read goes through the caller's client (RLS, or the owner-scoped
 * service role for a key), and `businessId` scopes it: rows of the site's
 * own published articles, prompts, runs and places, nothing else.
 */

type Row = Record<string, unknown>;

/** The one line under the AI answers: what the counts are. */
export const AI_SAMPLED_NOTE =
  "Sampled: each ask is one question put once to one engine, either an article's keyword (asked weekly, never naming the site) or one of the questions you chose (asked as you wrote it), and we look for your site among the sources it returns. Not every AI answer.";

/** Rows read at most per table for a window; a page of PostgREST is 1,000. */
const PAGE = 1000;
const MAX_PAGES = 10;
const MAX_PROBES = 2000;
const MAX_ARTICLE_CHECKS = 2000;
const MAX_OPEN_PLACES = 500;
const NOT_INDEXED_ROWS = 20;

const str = (value: unknown): string | null => (typeof value === "string" && value ? value : null);

/** The site's published articles: the ones whose measurements Growth reads, as Results did. */
async function publishedArticles(client: SupabaseClient, businessId: string): Promise<Array<{ id: string; keyword: string }>> {
  const { data, error } = await client
    .from("articles")
    .select("id, keywords!articles_keyword_id_fkey ( keyword )")
    .eq("business_id", businessId)
    .eq("status", "published");
  if (error) throw new Error(`articles: ${error.message}`);
  return ((data ?? []) as Row[]).map((row) => {
    const kw = row.keywords as { keyword?: string } | { keyword?: string }[] | null;
    return { id: row.id as string, keyword: (Array.isArray(kw) ? kw[0]?.keyword : kw?.keyword) ?? "" };
  });
}

/** Search Console days of the site's published articles since `since`, every page of them. */
async function searchDays(client: SupabaseClient, articleIds: readonly string[], since: string): Promise<SearchDay[]> {
  if (articleIds.length === 0) return [];
  const out: SearchDay[] = [];
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const { data, error } = await client
      .from("content_metrics")
      .select("article_id, captured_on, position, impressions, clicks")
      .in("article_id", [...articleIds])
      .eq("source", SEARCH_CONSOLE)
      .gte("captured_on", since)
      .order("captured_on", { ascending: true })
      .range(page * PAGE, page * PAGE + PAGE - 1);
    if (error) throw new Error(`content metrics: ${error.message}`);
    const rows = (data ?? []) as Row[];
    for (const row of rows) {
      out.push({
        day: String(row.captured_on).slice(0, 10),
        impressions: Number(row.impressions ?? 0),
        clicks: Number(row.clicks ?? 0),
        position: row.position === null || row.position === undefined ? null : Number(row.position),
      });
    }
    if (rows.length < PAGE) break;
  }
  return out;
}

async function loadGoogle(
  client: SupabaseClient,
  businessId: string,
  articleIds: readonly string[],
  days: GrowthDays,
  now: Date
): Promise<GoogleGrowth> {
  const [connection, { data: connectionRow }] = await Promise.all([
    loadSearchConsoleStatus(client, businessId),
    client
      .from("analytics_connections")
      .select("created_at")
      .eq("business_id", businessId)
      .eq("provider", SEARCH_CONSOLE)
      .maybeSingle(),
  ]);
  // The windows end on the newest day ingested; read two periods back from the watermark.
  const anchor = connection.lastSyncedOn ?? utcDay(now);
  const since = periodWindows(days, anchor).previous.from;
  const points = await searchDays(client, articleIds, since);
  const growth = summarizeSearchGrowth(points, {
    days,
    through: connection.lastSyncedOn,
    coveredFrom: coverageStart((connectionRow as Row | null)?.created_at as string | null, FIRST_SYNC_DAYS),
  });

  let pages: GoogleGrowth["pages"] = null;
  if (connection.status !== "absent" && connection.siteUrl) {
    try {
      const listing = await listIndexStatus(client, businessId, { state: "not_indexed", limit: NOT_INDEXED_ROWS });
      const s = listing.summary;
      pages = {
        total: s.total,
        checked: s.checked,
        indexed: s.indexed,
        notIndexed: s.notIndexed,
        unknown: s.unknown,
        caption: s.caption,
        notIndexedRows: listing.rows.map((row) => ({
          url: row.url,
          coverageState: row.coverageState,
          checkedAt: row.checkedAt,
          inspectionResultLink: row.inspectionResultLink,
        })),
      };
    } catch {
      pages = null;
    }
  }

  return {
    connection: {
      status: connection.status,
      siteUrl: connection.siteUrl,
      lastSyncedOn: connection.lastSyncedOn,
      stale: connection.stale,
      syncing: connection.syncing,
      lastError: connection.lastError,
    },
    settledThrough: growth.settledThrough,
    coveredFrom: growth.coveredFrom,
    current: growth.current,
    previous: growth.previous,
    change: growth.change,
    pages,
  };
}

/** The asks of both families since `since` (a UTC day), for the counts. */
async function loadAsks(
  client: SupabaseClient,
  businessId: string,
  articleIds: readonly string[],
  since: string
): Promise<Ask[]> {
  const [probes, checks] = await Promise.all([
    client
      .from("aeo_probes")
      .select("engine, status, checked_at")
      .eq("business_id", businessId)
      .gte("checked_at", `${since}T00:00:00.000Z`)
      .order("checked_at", { ascending: false })
      .limit(MAX_PROBES),
    articleIds.length === 0
      ? Promise.resolve({ data: [] as Row[], error: null })
      : client
          .from("ai_citations")
          .select("engine, cited, checked_on")
          .in("article_id", [...articleIds])
          .gte("checked_on", since)
          .order("checked_on", { ascending: false })
          .limit(MAX_ARTICLE_CHECKS),
  ]);
  if (probes.error) throw new Error(`aeo probes: ${probes.error.message}`);
  if (checks.error) throw new Error(`ai citations: ${checks.error.message}`);

  const asks: Ask[] = [];
  for (const row of (probes.data ?? []) as Row[]) {
    const status = row.status as string;
    const at = str(row.checked_at);
    if (!at || !["cited", "not_cited", "invalid", "error"].includes(status)) continue;
    asks.push({ engine: row.engine as string, kind: "prompt", askedAt: at, status: status as AnswerStatus });
  }
  for (const row of (checks.data ?? []) as Row[]) {
    asks.push({
      engine: row.engine as string,
      kind: "article",
      askedAt: String(row.checked_on).slice(0, 10),
      status: row.cited ? "cited" : "not_cited",
    });
  }
  return asks;
}

/** The newest ask ever stored, of either family; null when the site was never asked about. */
async function lastAskedAt(client: SupabaseClient, businessId: string, articleIds: readonly string[]): Promise<string | null> {
  const [probe, check] = await Promise.all([
    client
      .from("aeo_probes")
      .select("checked_at")
      .eq("business_id", businessId)
      .in("status", ["cited", "not_cited"])
      .order("checked_at", { ascending: false })
      .limit(1),
    articleIds.length === 0
      ? Promise.resolve({ data: [] as Row[] })
      : client.from("ai_citations").select("checked_on").in("article_id", [...articleIds]).order("checked_on", { ascending: false }).limit(1),
  ]);
  const a = str(((probe.data ?? []) as Row[])[0]?.checked_at);
  const b = str(((check.data ?? []) as Row[])[0]?.checked_on);
  if (!a) return b;
  if (!b) return a;
  return a.slice(0, 10) >= b.slice(0, 10) ? a : b;
}

/** Engines the platform has keys for: the ones a count can show as "not asked". */
function configuredEngines(): string[] {
  return getCitationProviders().map((p) => p.name);
}

export interface GrowthOptions {
  days: GrowthDays;
  /** The platform's X API opt-in, passed in so this module reads no environment for it. */
  xApiEnabled: boolean;
  now?: Date;
  /** The configured engines; the providers' registry unless a test passes them. */
  engines?: readonly string[];
}

/** Growth's three blocks for a site: Replies on X, Google, AI answers. */
export async function loadGrowth(client: SupabaseClient, businessId: string, options: GrowthOptions): Promise<GrowthSummary> {
  const now = options.now ?? new Date();
  const days = options.days;
  const articles = await publishedArticles(client, businessId);
  const articleIds = articles.map((a) => a.id);
  const aiWindows = periodWindows(days, utcDay(now));

  const [replies, google, asks, last, queries, places, { data: business }] = await Promise.all([
    loadReplyStats(client, businessId, { xApiEnabled: options.xApiEnabled, now, days }).catch(() => null),
    loadGoogle(client, businessId, articleIds, days, now),
    loadAsks(client, businessId, articleIds, aiWindows.previous.from),
    lastAskedAt(client, businessId, articleIds),
    client.from("aeo_queries").select("id, enabled").eq("business_id", businessId),
    countCitedPlaces(client, businessId, null),
    client.from("businesses").select("aeo_settings").eq("id", businessId).maybeSingle(),
  ]);
  const prompts = ((queries.data ?? []) as Row[]).map((q) => Boolean(q.enabled));

  return {
    days,
    generatedAt: now.toISOString(),
    replies,
    google,
    ai: {
      window: { current: aiWindows.current, previous: aiWindows.previous },
      engines: summarizeAsks(asks, aiWindows, options.engines ?? configuredEngines()),
      lastAskedAt: last,
      prompts: { total: prompts.length, enabled: prompts.filter(Boolean).length },
      places: places ? { open: places.open } : null,
      placesFromSources: parseAeoSettings((business as Row | null)?.aeo_settings).placesFromSources,
      sampled: true,
      note: AI_SAMPLED_NOTE,
    },
  };
}

// ── The evidence ────────────────────────────────────────────────────────────

/** The identity of a cited page as the inbox stores it, or null when it is not one. */
function placeKey(url: string): string | null {
  const target = canonicalTarget(url);
  return target ? `${target.surface}:${target.externalId}` : null;
}

async function openPlaces(client: SupabaseClient, businessId: string): Promise<OpenPlace[]> {
  const { data, error } = await client
    .from("placement_targets")
    .select("id, surface, external_id, url, ai_citation")
    .eq("business_id", businessId)
    .in("status", OPEN_STATUSES)
    .limit(MAX_OPEN_PLACES);
  if (error) return [];
  return ((data ?? []) as Row[]).flatMap((row) => {
    const surface = str(row.surface);
    const externalId = str(row.external_id);
    const url = str(row.url);
    if (!surface || !externalId) return [];
    const citation = parseAiCitation(row.ai_citation);
    return [
      {
        id: row.id as string,
        key: `${surface}:${externalId}`,
        domain: url ? domainOf(url) : "",
        sighting: citation
          ? { runId: citation.runId, prompts: citation.prompts.map((p) => ({ query: p.query, engines: p.engines })) }
          : null,
      },
    ];
  });
}

export interface AnswersOptions {
  days: GrowthDays;
  engine?: string | null;
  offset?: number;
  limit?: number;
  now?: Date;
}

export const DEFAULT_ANSWERS_LIMIT = 20;
export const MAX_ANSWERS_LIMIT = 100;

/**
 * The period's answers, newest first: what `/growth/ai` lists and
 * `list_ai_answers` pages through. Every prompt ask with an answer (cited,
 * not cited, or unreadable, which is marked as not counted) and every
 * article check, each with what is stored: the question, the engine, the
 * day, the verdict, the site's place among the sources, the excerpt, and
 * every source verbatim, the site's own and the open places in Today marked.
 */
export async function listAiAnswers(client: SupabaseClient, businessId: string, options: AnswersOptions): Promise<AiAnswersPage> {
  const now = options.now ?? new Date();
  const days = options.days;
  const window = periodWindows(days, utcDay(now)).current;
  const limit = Math.max(1, Math.min(Math.floor(options.limit ?? DEFAULT_ANSWERS_LIMIT), MAX_ANSWERS_LIMIT));
  const offset = Math.max(0, Math.floor(options.offset ?? 0));

  const [{ data: business }, articles, places] = await Promise.all([
    client.from("businesses").select("name, website_url, aeo_settings").eq("id", businessId).maybeSingle(),
    publishedArticles(client, businessId),
    openPlaces(client, businessId),
  ]);
  const identity = businessIdentity(
    { name: str((business as Row | null)?.name), website_url: str((business as Row | null)?.website_url) },
    parseAeoSettings((business as Row | null)?.aeo_settings)
  );
  const isOurs = (domain: string) => Boolean(domain) && identity.domains.some((own) => isCompanySource(domain, own));
  const articleIds = articles.map((a) => a.id);

  const [probes, checks] = await Promise.all([
    client
      .from("aeo_probes")
      .select("id, run_id, query_id, query, engine, status, cited, source_url, position, mentioned, answer_excerpt, sources, error, checked_at")
      .eq("business_id", businessId)
      .gte("checked_at", `${window.from}T00:00:00.000Z`)
      .order("checked_at", { ascending: false })
      .limit(MAX_PROBES),
    articleIds.length === 0
      ? Promise.resolve({ data: [] as Row[], error: null })
      : client
          .from("ai_citations")
          .select("id, article_id, engine, query, cited, source_url, snippet, checked_on")
          .in("article_id", articleIds)
          .gte("checked_on", window.from)
          .order("checked_on", { ascending: false })
          .limit(MAX_ARTICLE_CHECKS),
  ]);
  if (probes.error) throw new Error(`aeo probes: ${probes.error.message}`);
  if (checks.error) throw new Error(`ai citations: ${checks.error.message}`);

  const answers: AiAnswer[] = [];
  for (const row of (probes.data ?? []) as Row[]) {
    const status = row.status as string;
    const askedAt = str(row.checked_at);
    if (!askedAt || askedAt.slice(0, 10) > window.to || !["cited", "not_cited", "invalid", "error"].includes(status)) continue;
    const sources = Array.isArray(row.sources) ? (row.sources as CitationSource[]) : [];
    const question = String(row.query ?? "");
    const engine = row.engine as string;
    const marked = markSources(
      { runId: str(row.run_id), question, engine, sources },
      { isOurs, keyOf: placeKey, isRedirect: isSourceRedirect, places }
    );
    answers.push({
      id: `prompt:${row.id as string}`,
      kind: "prompt",
      question,
      engine,
      askedAt,
      status: status as AnswerStatus,
      counted: status === "cited" || status === "not_cited",
      ourPosition: row.position === null || row.position === undefined ? null : Number(row.position),
      citedUrl: str(row.source_url),
      mentioned: (row.mentioned as boolean | null) ?? null,
      excerpt: str(row.answer_excerpt),
      sources: marked.sources,
      sourcesKept: true,
      placesInToday: marked.placesInToday,
      promptId: str(row.query_id),
      articleId: null,
      error: str(row.error),
    });
  }
  for (const row of (checks.data ?? []) as Row[]) {
    const day = String(row.checked_on).slice(0, 10);
    if (day > window.to) continue;
    const cited = Boolean(row.cited);
    answers.push({
      id: `article:${row.id as string}`,
      kind: "article",
      question: String(row.query ?? ""),
      engine: row.engine as string,
      askedAt: day,
      status: cited ? "cited" : "not_cited",
      counted: true,
      ourPosition: null,
      citedUrl: cited ? str(row.source_url) : null,
      mentioned: null,
      excerpt: cited ? str(row.snippet) : null,
      sources: [],
      sourcesKept: false,
      placesInToday: 0,
      promptId: null,
      articleId: str(row.article_id),
      error: null,
    });
  }

  // Newest first; an article check carries only its day, so within a day it follows the timed asks.
  answers.sort((a, b) => b.askedAt.localeCompare(a.askedAt) || a.id.localeCompare(b.id));
  const engines = [...new Set(answers.map((a) => a.engine))].sort();
  const engine = options.engine?.trim() ? options.engine.trim().toLowerCase() : null;
  const kept = engine ? answers.filter((a) => a.engine === engine) : answers;
  const page = kept.slice(offset, offset + limit);

  return {
    days,
    window,
    engine,
    engines,
    total: kept.length,
    offset,
    nextOffset: offset + page.length < kept.length ? offset + page.length : null,
    answers: page,
    sampled: true,
    note: AI_SAMPLED_NOTE,
  };
}

/** What `/growth/ai` needs under the list: the question set, the engines, the latest run. */
export interface AskSetup {
  /** `perRun`: what one run asks, the enabled questions up to the site's per-run cap. */
  prompts: { total: number; enabled: number; perRun: number };
  configuredEngines: string[];
  activeEngines: string[];
  latestRun: Pick<RunRecord, "id" | "status" | "startedAt" | "plannedProbes" | "error"> | null;
}

export async function loadAskSetup(client: SupabaseClient, businessId: string): Promise<AskSetup> {
  const [{ data: business }, { data: queries }, runs] = await Promise.all([
    client.from("businesses").select("aeo_settings").eq("id", businessId).maybeSingle(),
    client.from("aeo_queries").select("id, enabled").eq("business_id", businessId),
    listRuns(client, businessId, 1).catch(() => [] as RunRecord[]),
  ]);
  const enabled = ((queries ?? []) as Row[]).filter((q) => Boolean(q.enabled)).length;
  const configured = configuredEngines();
  const settings = parseAeoSettings((business as Row | null)?.aeo_settings);
  const latest = runs[0] ?? null;
  return {
    prompts: { total: (queries ?? []).length, enabled, perRun: Math.min(enabled, settings.maxQueriesPerRun) },
    configuredEngines: configured,
    activeEngines: activeEngines(configured, settings),
    latestRun: latest
      ? { id: latest.id, status: latest.status, startedAt: latest.startedAt, plannedProbes: latest.plannedProbes, error: latest.error }
      : null,
  };
}
