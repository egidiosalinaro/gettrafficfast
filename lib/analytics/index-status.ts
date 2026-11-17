import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadConnection, normalizeUrl } from "@/lib/analytics/search-console";
import { searchConsolePropertyLabel } from "@/lib/analytics/property-display";
import { indexingAlertEmail, sendNotificationEmail } from "@/lib/notifications/email";
import { refreshAccessToken, SearchConsoleProvider } from "@/lib/providers/analytics/search-console";
import { InspectionError, type InspectionErrorKind, type UrlInspection } from "@/lib/providers/analytics/types";
import { indexStateOf, summarizeIndexing, type IndexingSummary, type IndexState, type IndexStatusView } from "./index-status-display";

/**
 * Indexing status: is each published URL in Google's index, and if not, why,
 * in Google's own words (docs/ANALYTICS.md, "Indexing status").
 *
 * Search Analytics only reports pages that were shown; a page Google never
 * indexed has no rows there at all. URL Inspection is the answer for those.
 * It is free, so nothing here is behind an opt-in, but Google's quota is per
 * property (about 2,000 a day and 600 a minute), so the sweep is bounded
 * (DAILY_INSPECTION_CAP) and rotates: freshly published URLs first, then
 * never-checked ones, then the oldest checks.
 *
 * One row per (site, URL), the latest inspection. A URL without a row was
 * never inspected: "not checked", never "not indexed".
 */

/** Inspections per site per UTC day, sweep and "Check now" together. Google allows about 2,000. */
export const DAILY_INSPECTION_CAP = 200;
/** A URL is inspected again at most this often, unless its article was republished since. */
export const RECHECK_DAYS = 3;
/** URLs published this recently go first: that is when "is it indexed yet" is the question. */
export const FRESH_PUBLISH_DAYS = 3;
/** A published article still not indexed this long after publishing is worth one note. */
export const NOT_INDEXED_ALERT_DAYS = 7;
/** "Check now" on a URL checked this recently answers the stored row instead of asking again. */
export const CHECK_NOW_COOLDOWN_MS = 10 * 60 * 1000;
/** Inspections in flight at once for one site; Google allows 600 a minute. */
const CONCURRENCY = 4;
/** At most this many URLs in one alert email; the rest wait for the next sweep. */
const MAX_ALERTS_PER_EMAIL = 20;

const DAY_MS = 86_400_000;

// ── Pure: which URLs, in what order ────────────────────────────────────────

export interface InspectionCandidate {
  url: string;
  articleId: string | null;
  /** When it first went live; null when we cannot tell. */
  publishedAt: string | null;
  /** When the live page last changed (a republish); null when we cannot tell. */
  changedAt: string | null;
}

export interface StoredCheck {
  url: string;
  checkedAt: string;
  verdict: string;
  coverageState: string | null;
}

const time = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isFinite(t) ? t : null;
};

/** True when `url` is due: never checked, republished since, or checked RECHECK_DAYS ago or more. */
export function isDue(candidate: InspectionCandidate, stored: StoredCheck | undefined, now: Date): boolean {
  if (!stored) return true;
  const checked = time(stored.checkedAt) ?? 0;
  const changed = time(candidate.changedAt);
  if (changed !== null && changed > checked) return true;
  return now.getTime() - checked >= RECHECK_DAYS * DAY_MS;
}

/**
 * The URLs to inspect this run, in order, at most `cap`:
 * 1. published in the last FRESH_PUBLISH_DAYS days;
 * 2. never checked, or republished since the last check;
 * 3. the oldest checks.
 * Within a tier, never-checked before checked, then oldest check first.
 * A URL not due (checked under RECHECK_DAYS ago, unchanged) is left out.
 */
export function planInspections(params: {
  candidates: readonly InspectionCandidate[];
  stored: ReadonlyMap<string, StoredCheck>;
  now: Date;
  cap: number;
}): InspectionCandidate[] {
  const { stored, now } = params;
  const seen = new Set<string>();
  const due: Array<{ candidate: InspectionCandidate; tier: number; checked: number }> = [];
  for (const candidate of params.candidates) {
    if (seen.has(candidate.url)) continue;
    seen.add(candidate.url);
    const previous = stored.get(candidate.url);
    if (!isDue(candidate, previous, now)) continue;
    const published = time(candidate.publishedAt);
    const fresh = published !== null && now.getTime() - published < FRESH_PUBLISH_DAYS * DAY_MS;
    const changed = time(candidate.changedAt);
    const checked = previous ? (time(previous.checkedAt) ?? 0) : -1;
    const tier = fresh ? 0 : !previous || (changed !== null && changed > checked) ? 1 : 2;
    due.push({ candidate, tier, checked });
  }
  due.sort((a, b) => a.tier - b.tier || a.checked - b.checked || a.candidate.url.localeCompare(b.candidate.url));
  return due.slice(0, Math.max(0, params.cap)).map((entry) => entry.candidate);
}

/** Inspections already made today (UTC) for the site, as the stored rows show them. */
export function checksToday(stored: Iterable<StoredCheck>, now: Date): number {
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  let count = 0;
  for (const row of stored) if ((time(row.checkedAt) ?? 0) >= start) count += 1;
  return count;
}

/**
 * Whether Google will inspect `url` under the property `siteUrl`: a domain
 * property (`sc-domain:example.com`) covers the domain and its subdomains
 * over http and https; a URL-prefix property covers what starts with it
 * (scheme and host compared without case). Anything else Google answers 400.
 */
export function urlInProperty(siteUrl: string, url: string): boolean {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return false;
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") return false;
  const host = target.hostname.toLowerCase();
  if (siteUrl.startsWith("sc-domain:")) {
    const domain = siteUrl.slice("sc-domain:".length).trim().toLowerCase().replace(/\.$/, "");
    return Boolean(domain) && (host === domain || host.endsWith(`.${domain}`));
  }
  let prefix: URL;
  try {
    prefix = new URL(siteUrl);
  } catch {
    return false;
  }
  return (
    prefix.protocol === target.protocol &&
    prefix.hostname.toLowerCase() === host &&
    prefix.port === target.port &&
    `${target.pathname}${target.search}`.startsWith(prefix.pathname)
  );
}

// ── Pure: alerts ────────────────────────────────────────────────────────────

export interface IndexAlert {
  url: string;
  articleId: string | null;
  kind: "not_indexed_after_publish" | "dropped_from_index";
  coverageState: string | null;
  inspectionResultLink: string | null;
  /** notification_log.type: once per site, URL and Google state, whatever the kind. */
  key: string;
}

export function alertKey(businessId: string, url: string, coverageState: string | null, verdict: string): string {
  const digest = createHash("sha256")
    .update(`${businessId}|${url}|${coverageState ?? verdict}`)
    .digest("hex")
    .slice(0, 32);
  return `index_status:${digest}`;
}

/**
 * The note a fresh inspection deserves, if any. Only a not-indexed answer
 * can raise one: a page that was indexed and dropped out, or a published
 * article still out NOT_INDEXED_ALERT_DAYS after publishing. An unknown
 * verdict raises nothing. The key makes it once per URL per Google state.
 */
export function alertFor(params: {
  businessId: string;
  candidate: Pick<InspectionCandidate, "url" | "articleId" | "publishedAt">;
  previous: StoredCheck | undefined;
  inspection: Pick<UrlInspection, "verdict" | "coverageState" | "inspectionResultLink">;
  now: Date;
}): IndexAlert | null {
  const { candidate, previous, inspection, now } = params;
  if (indexStateOf(inspection.verdict) !== "not_indexed") return null;
  const base = {
    url: candidate.url,
    articleId: candidate.articleId,
    coverageState: inspection.coverageState,
    inspectionResultLink: inspection.inspectionResultLink,
    key: alertKey(params.businessId, candidate.url, inspection.coverageState, inspection.verdict),
  };
  if (previous && indexStateOf(previous.verdict) === "indexed") return { ...base, kind: "dropped_from_index" };
  const published = time(candidate.publishedAt);
  if (candidate.articleId && published !== null && now.getTime() - published >= NOT_INDEXED_ALERT_DAYS * DAY_MS) {
    return { ...base, kind: "not_indexed_after_publish" };
  }
  return null;
}

// ── Rows ────────────────────────────────────────────────────────────────────

const str = (value: unknown): string | null => (typeof value === "string" && value ? value : null);

/** A stored row as the API and the screens carry it. */
export function viewOf(row: Record<string, unknown>): IndexStatusView {
  const raw = row.raw as { inspectionResult?: { inspectionResultLink?: unknown } } | null;
  const verdict = String(row.verdict ?? "VERDICT_UNSPECIFIED");
  return {
    url: String(row.url),
    articleId: str(row.article_id),
    checkedAt: String(row.checked_at),
    verdict,
    state: indexStateOf(verdict),
    coverageState: str(row.coverage_state),
    indexingState: str(row.indexing_state),
    robotsState: str(row.robots_state),
    fetchState: str(row.fetch_state),
    googleCanonical: str(row.google_canonical),
    userCanonical: str(row.user_canonical),
    lastCrawlAt: str(row.last_crawl_at),
    inspectionResultLink: str(raw?.inspectionResult?.inspectionResultLink),
  };
}

const VIEW_COLUMNS =
  "url, article_id, checked_at, verdict, coverage_state, indexing_state, robots_state, fetch_state, google_canonical, user_canonical, last_crawl_at, raw";

/** The row an inspection becomes. `raw` is Google's payload as received. */
export function rowOf(params: {
  userId: string;
  businessId: string;
  url: string;
  articleId: string | null;
  inspection: UrlInspection;
  checkedAt: Date;
}): Record<string, unknown> {
  const { inspection } = params;
  return {
    business_id: params.businessId,
    user_id: params.userId,
    url: params.url,
    article_id: params.articleId,
    checked_at: params.checkedAt.toISOString(),
    verdict: inspection.verdict,
    coverage_state: inspection.coverageState,
    indexing_state: inspection.indexingState,
    robots_state: inspection.robotsTxtState,
    fetch_state: inspection.pageFetchState,
    google_canonical: inspection.googleCanonical,
    user_canonical: inspection.userCanonical,
    last_crawl_at: inspection.lastCrawlTime,
    raw: inspection.raw ?? null,
  };
}

// ── I/O ─────────────────────────────────────────────────────────────────────

/**
 * The site's URLs to inspect: every published article with a live address.
 * When it went live and when it last changed come from the successful
 * deliveries (`publish_attempts`): the first is the publication, the last a
 * republish. An article with none (published before the log existed) falls
 * back to its calendar day for the publication, and no change time.
 *
 * The site's own sitemap is not read: the platform stores its address but
 * never fetches it, so only article URLs are candidates today.
 */
export async function loadInspectionCandidates(client: SupabaseClient, businessId: string): Promise<InspectionCandidate[]> {
  const { data: articles, error } = await client
    .from("articles")
    .select("id, published_url, scheduled_date")
    .eq("business_id", businessId)
    .eq("status", "published");
  if (error) throw new Error(`index status: articles: ${error.message}`);

  const published = (articles ?? [])
    .map((row) => ({
      id: row.id as string,
      url: ((row.published_url as string | null) ?? "").trim(),
      scheduledDate: (row.scheduled_date as string | null) ?? null,
    }))
    .filter((row) => row.url);
  if (published.length === 0) return [];

  const { data: attempts } = await client
    .from("publish_attempts")
    .select("article_id, created_at, ok")
    .in(
      "article_id",
      published.map((row) => row.id)
    )
    .eq("ok", true);

  const first = new Map<string, string>();
  const last = new Map<string, string>();
  for (const attempt of attempts ?? []) {
    const id = attempt.article_id as string;
    const at = attempt.created_at as string;
    if (!first.has(id) || at < first.get(id)!) first.set(id, at);
    if (!last.has(id) || at > last.get(id)!) last.set(id, at);
  }

  return published.map((row) => ({
    url: row.url,
    articleId: row.id,
    publishedAt: first.get(row.id) ?? (row.scheduledDate ? `${row.scheduledDate}T00:00:00.000Z` : null),
    changedAt: last.get(row.id) ?? null,
  }));
}

/** The site's stored inspections, by URL. */
export async function loadStoredChecks(client: SupabaseClient, businessId: string): Promise<Map<string, StoredCheck>> {
  const { data, error } = await client
    .from("index_status")
    .select("url, checked_at, verdict, coverage_state")
    .eq("business_id", businessId);
  if (error) throw new Error(`index status: ${error.message}`);
  return new Map(
    (data ?? []).map((row) => [
      row.url as string,
      {
        url: row.url as string,
        checkedAt: row.checked_at as string,
        verdict: row.verdict as string,
        coverageState: (row.coverage_state as string | null) ?? null,
      },
    ])
  );
}

async function storeInspection(admin: SupabaseClient, row: Record<string, unknown>): Promise<void> {
  const { error } = await admin.from("index_status").upsert(row, { onConflict: "business_id,url" });
  if (error) throw new Error(`index status upsert failed: ${error.message}`);
}

/** Asks for one URL. Tests pass their own; production asks the provider. */
export type Inspector = (siteUrl: string, url: string) => Promise<UrlInspection>;

async function inspectorFor(refreshToken: string): Promise<Inspector> {
  const accessToken = await refreshAccessToken(refreshToken);
  const provider = new SearchConsoleProvider(accessToken);
  return (siteUrl, url) => provider.inspectUrl(siteUrl, url);
}

export type IndexSweepResult =
  | { status: "skipped"; reason: "no_connection" | "no_property" | "no_published_articles" | "daily_cap_reached" | "nothing_due" }
  | {
      status: "inspected";
      planned: number;
      inspected: number;
      failed: number;
      /** URLs outside the selected property: Google would refuse them. */
      outsideProperty: number;
      /** Why the run stopped early, when it did: a quota, a refused grant, the deadline. */
      stopped: InspectionErrorKind | "deadline" | null;
      alerts: IndexAlert[];
      notified: number;
    };

/**
 * One site's daily inspection: plan, inspect within the cap, store each
 * answer, then send the owner one note for what newly deserves it.
 *
 * A quota or a refused grant stops the site's run at once (asking again
 * only burns the next call); one URL Google cannot inspect is counted and
 * the run goes on. `deadline` (epoch ms) stops starting new inspections, so
 * the cron's time budget is shared fairly between sites.
 */
export async function inspectBusinessIndex(params: {
  admin: SupabaseClient;
  businessId: string;
  now?: Date;
  deadline?: number;
  inspector?: Inspector;
  notify?: boolean;
}): Promise<IndexSweepResult> {
  const { admin, businessId } = params;
  const now = params.now ?? new Date();
  const connection = await loadConnection({ supabase: admin, businessId });
  if (!connection) return { status: "skipped", reason: "no_connection" };
  if (!connection.siteUrl) return { status: "skipped", reason: "no_property" };
  const siteUrl = connection.siteUrl;

  const candidates = await loadInspectionCandidates(admin, businessId);
  if (candidates.length === 0) return { status: "skipped", reason: "no_published_articles" };

  const inside = candidates.filter((candidate) => urlInProperty(siteUrl, candidate.url));
  const stored = await loadStoredChecks(admin, businessId);
  const cap = DAILY_INSPECTION_CAP - checksToday(stored.values(), now);
  if (cap <= 0) return { status: "skipped", reason: "daily_cap_reached" };

  const plan = planInspections({ candidates: inside, stored, now, cap });
  if (plan.length === 0) return { status: "skipped", reason: "nothing_due" };

  const inspect = params.inspector ?? (await inspectorFor(connection.refreshToken));
  const alerts: IndexAlert[] = [];
  let inspected = 0;
  let failed = 0;
  let stopped: InspectionErrorKind | "deadline" | null = null;
  let next = 0;

  const worker = async () => {
    while (next < plan.length && stopped === null) {
      if (params.deadline !== undefined && Date.now() >= params.deadline) {
        stopped = "deadline";
        return;
      }
      const candidate = plan[next++];
      try {
        const inspection = await inspect(siteUrl, candidate.url);
        const checkedAt = params.now ?? new Date();
        await storeInspection(
          admin,
          rowOf({ userId: connection.userId, businessId, url: candidate.url, articleId: candidate.articleId, inspection, checkedAt })
        );
        inspected += 1;
        const alert = alertFor({ businessId, candidate, previous: stored.get(candidate.url), inspection, now });
        if (alert) alerts.push(alert);
      } catch (err) {
        if (err instanceof InspectionError && err.kind !== "invalid" && err.kind !== "unavailable") {
          stopped = err.kind;
          return;
        }
        failed += 1;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, plan.length) }, worker));

  const notified =
    params.notify === false || alerts.length === 0
      ? 0
      : await notifyIndexAlerts({ admin, userId: connection.userId, siteLabel: searchConsolePropertyLabel(siteUrl) ?? siteUrl, alerts });

  return {
    status: "inspected",
    planned: plan.length,
    inspected,
    failed,
    outsideProperty: candidates.length - inside.length,
    stopped,
    alerts,
    notified,
  };
}

/**
 * Sends the owner one email for the alerts not sent before, and records each
 * in notification_log so a URL is noted at most once per Google state. A
 * send that fails records nothing: the next sweep tries again.
 */
export async function notifyIndexAlerts(params: {
  admin: SupabaseClient;
  userId: string;
  siteLabel: string;
  alerts: readonly IndexAlert[];
}): Promise<number> {
  const { admin, userId } = params;
  const unique = [...new Map(params.alerts.map((alert) => [alert.key, alert])).values()];
  if (unique.length === 0) return 0;

  const { data: sent } = await admin
    .from("notification_log")
    .select("type")
    .eq("user_id", userId)
    .in(
      "type",
      unique.map((alert) => alert.key)
    );
  const already = new Set((sent ?? []).map((row) => row.type as string));
  const fresh = unique.filter((alert) => !already.has(alert.key)).slice(0, MAX_ALERTS_PER_EMAIL);
  if (fresh.length === 0) return 0;

  const { data } = await admin.auth.admin.getUserById(userId);
  const email = data?.user?.email;
  if (!email) return 0;

  const ok = await sendNotificationEmail({ to: email, ...indexingAlertEmail(params.siteLabel, fresh) });
  if (!ok) return 0;

  await admin
    .from("notification_log")
    .upsert(
      fresh.map((alert) => ({ user_id: userId, type: alert.key })),
      { onConflict: "user_id,type", ignoreDuplicates: true }
    );
  return fresh.length;
}

// ── Reads ───────────────────────────────────────────────────────────────────

export interface IndexStatusFilter {
  state?: IndexState;
  coverageState?: string;
  articleId?: string;
  limit?: number;
}

export interface IndexStatusListing {
  connected: boolean;
  /** The Search Console property the site is inspected under; null until one is picked. */
  siteUrl: string | null;
  summary: IndexingSummary;
  rows: IndexStatusView[];
}

/**
 * The site's indexing status: the summary over every checked URL, and the
 * rows the filter keeps. Read through the caller's client (RLS, or the
 * owner-scoped service role); shared by GET /api/index-status, the article
 * modal, the Results page and `list_index_status`.
 */
export async function listIndexStatus(
  client: SupabaseClient,
  businessId: string,
  filter: IndexStatusFilter = {}
): Promise<IndexStatusListing> {
  const [{ data: connection }, { data: rows, error }, { data: articles }] = await Promise.all([
    client
      .from("analytics_connections")
      .select("site_url, status")
      .eq("business_id", businessId)
      .eq("provider", "search_console")
      .maybeSingle(),
    client.from("index_status").select(VIEW_COLUMNS).eq("business_id", businessId),
    client.from("articles").select("id, published_url").eq("business_id", businessId).eq("status", "published"),
  ]);
  if (error) throw new Error(`index status: ${error.message}`);

  const connected = Boolean(connection && connection.status !== "disconnected");
  const siteUrl = connected ? ((connection?.site_url as string | null) ?? null) : null;
  const views = (rows ?? []).map((row) => viewOf(row as Record<string, unknown>));

  // The URLs there are to check are the published articles' live addresses;
  // a checked URL outside that set (an article unpublished since) still counts
  // as checked, never pushing "checked" above "total".
  const liveUrls = new Set(
    (articles ?? [])
      .map((row) => ((row.published_url as string | null) ?? "").trim())
      .filter((url) => url && (!siteUrl || urlInProperty(siteUrl, url)))
  );
  const summary = summarizeIndexing(views, liveUrls.size);

  const limit = Math.min(Math.max(filter.limit ?? 200, 1), 500);
  const kept = views
    .filter((row) => !filter.state || row.state === filter.state)
    .filter((row) => !filter.coverageState || row.coverageState === filter.coverageState)
    .filter((row) => !filter.articleId || row.articleId === filter.articleId)
    .sort((a, b) => b.checkedAt.localeCompare(a.checkedAt) || a.url.localeCompare(b.url))
    .slice(0, limit);

  return { connected, siteUrl, summary, rows: kept };
}

// ── One URL, now ────────────────────────────────────────────────────────────

export type InspectNowResult =
  | { ok: true; row: IndexStatusView; fresh: boolean }
  | {
      ok: false;
      status: 400 | 404 | 409 | 429 | 503;
      code: "invalid_input" | "not_found" | "prerequisite_missing" | "cap_reached" | "unavailable";
      error: string;
    };

/**
 * "Check now" and `inspect_url`: inspect one URL of the site, store the
 * answer, and return it. The URL must be inside the site's Search Console
 * property. A URL checked in the last CHECK_NOW_COOLDOWN_MS answers the
 * stored row (`fresh: false`) instead of spending quota on the same answer;
 * the site's DAILY_INSPECTION_CAP counts these with the sweep's.
 *
 * Service role, narrowed by the verified site and user: the table has no
 * client write policy. `businessId` must already be one of `userId`'s own.
 */
export async function inspectUrlNow(params: {
  admin: SupabaseClient;
  userId: string;
  businessId: string;
  url?: string;
  articleId?: string;
  now?: Date;
  inspector?: Inspector;
}): Promise<InspectNowResult> {
  const { admin, userId, businessId } = params;
  const now = params.now ?? new Date();

  const connection = await loadConnection({ supabase: admin, businessId });
  if (!connection || connection.userId !== userId) {
    return { ok: false, status: 409, code: "prerequisite_missing", error: "Search Console is not connected to this site." };
  }
  if (!connection.siteUrl) {
    return { ok: false, status: 409, code: "prerequisite_missing", error: "No Search Console property is selected for this site yet." };
  }
  const siteUrl = connection.siteUrl;

  const candidates = await loadInspectionCandidates(admin, businessId);
  let url = params.url?.trim() ?? "";
  let candidate: InspectionCandidate | undefined;
  if (params.articleId) {
    candidate = candidates.find((c) => c.articleId === params.articleId);
    if (!candidate) {
      return { ok: false, status: 404, code: "not_found", error: "That article is not published on this site." };
    }
    url = candidate.url;
  } else {
    const key = normalizeUrl(url);
    candidate = candidates.find((c) => c.url === url) ?? candidates.find((c) => key && normalizeUrl(c.url) === key);
  }
  if (!url) return { ok: false, status: 400, code: "invalid_input", error: "Give the URL to inspect." };
  if (!urlInProperty(siteUrl, url)) {
    return {
      ok: false,
      status: 400,
      code: "invalid_input",
      error: `${url} is not inside the Search Console property ${searchConsolePropertyLabel(siteUrl)}; Google only inspects URLs of the property.`,
    };
  }

  const stored = await loadStoredChecks(admin, businessId);
  const previous = stored.get(url);
  if (previous && now.getTime() - (time(previous.checkedAt) ?? 0) < CHECK_NOW_COOLDOWN_MS) {
    const { data } = await admin.from("index_status").select(VIEW_COLUMNS).eq("business_id", businessId).eq("url", url).maybeSingle();
    if (data) return { ok: true, row: viewOf(data as Record<string, unknown>), fresh: false };
  }
  if (checksToday(stored.values(), now) >= DAILY_INSPECTION_CAP) {
    return {
      ok: false,
      status: 429,
      code: "cap_reached",
      error: `This site has had ${DAILY_INSPECTION_CAP} URL inspections today, its daily limit. It opens again at midnight UTC.`,
    };
  }

  let inspection: UrlInspection;
  try {
    const inspect = params.inspector ?? (await inspectorFor(connection.refreshToken));
    inspection = await inspect(siteUrl, url);
  } catch (err) {
    return inspectionRefusal(err);
  }

  const articleId = candidate?.articleId ?? null;
  const row = rowOf({ userId, businessId, url, articleId, inspection, checkedAt: now });
  await storeInspection(admin, row);

  const alert = alertFor({
    businessId,
    candidate: { url, articleId, publishedAt: candidate?.publishedAt ?? null },
    previous,
    inspection,
    now,
  });
  if (alert) {
    await notifyIndexAlerts({ admin, userId, siteLabel: searchConsolePropertyLabel(siteUrl) ?? siteUrl, alerts: [alert] }).catch(() => 0);
  }

  return { ok: true, row: viewOf(row), fresh: true };
}

/** A refused inspection as the refusal a person can act on. */
export function inspectionRefusal(err: unknown): Extract<InspectNowResult, { ok: false }> {
  const kind = err instanceof InspectionError ? err.kind : "unavailable";
  switch (kind) {
    case "quota":
      return {
        ok: false,
        status: 429,
        code: "cap_reached",
        error: "Google's URL Inspection quota for this property is used up for now. Try again later; it resets daily.",
      };
    case "forbidden":
      return {
        ok: false,
        status: 409,
        code: "prerequisite_missing",
        error:
          "Google refused to inspect this property: the connected Google account must be an owner or full user of it in Search Console. Reconnect Search Console with an account that is.",
      };
    case "unauthorized":
      return {
        ok: false,
        status: 409,
        code: "prerequisite_missing",
        error: "Google did not accept the Search Console grant. Reconnect Search Console.",
      };
    case "invalid":
      return { ok: false, status: 400, code: "invalid_input", error: "Google would not inspect that URL under this property." };
    default:
      return { ok: false, status: 503, code: "unavailable", error: "Google's URL Inspection did not answer. Nothing was stored; try again in a minute." };
  }
}
