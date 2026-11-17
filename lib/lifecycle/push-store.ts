import type { SupabaseClient } from "@supabase/supabase-js";
import { SEARCH_CONSOLE } from "@/lib/analytics/search-console";
import { enqueueJob } from "@/lib/jobs/queue";
import {
  afterWindow,
  baselineWindow,
  chooseMainQuery,
  dayOf,
  measurementDue,
  PUSH_COOLDOWN_DAYS,
  PUSH_EXCLUSION_TEXT,
  PUSH_MEASURE_DAYS,
  PUSH_QUIET_DAYS,
  pushEligibility,
  pushLine,
  selectPushCandidates,
  windowStats,
  type MetricDay,
  type PushCandidateInput,
  type QueryRow,
  type WindowStats,
} from "./push";

/**
 * Push page 3, the I/O half (docs/LIFECYCLE.md, "Push page 3"): reading
 * what the pure rules in ./push.ts decide from, writing `article_pushes`,
 * enqueueing the `push-article` job, measuring after-values, and the reads
 * the screens and the tools share.
 *
 * Every read is narrowed by site; writes go through the service role with
 * the verified user and site, because `article_pushes` has no client write
 * policy.
 */

/** The job type; the workflow lives in lib/jobs/workflows/push-article.ts. */
export const PUSH_ARTICLE = "push-article";
const REFRESH_ARTICLE = "refresh-article";

const DAY_MS = 86_400_000;

export interface PushLink {
  fromArticleId: string;
  fromUrl: string;
  fromTitle: string;
  anchor: string | null;
  mode: "existing" | "sentence" | null;
  sentence: string | null;
  /** applied: live on the site; proposed: for the customer to add; not_delivered: stored, the site refused the update; skipped: nothing fitted. */
  status: "applied" | "proposed" | "not_delivered" | "skipped";
  reason: string | null;
}

export interface PushAfter {
  start: string;
  end: string;
  days: number;
  position: number | null;
  impressions: number;
  clicks: number;
  measuredAt: string;
}

export interface ArticlePushView {
  id: string;
  articleId: string;
  origin: "sweep" | "on_demand";
  status: "selected" | "proposed" | "applied" | "skipped" | "failed" | "dismissed";
  skipReason: string | null;
  mainQuery: string | null;
  query: { impressions: number | null; clicks: number | null; position: number | null };
  before: { start: string | null; end: string | null; position: number | null; impressions: number | null; clicks: number | null };
  links: PushLink[];
  title: { old: string | null; new: string | null };
  metaDescription: { old: string | null; new: string | null };
  appliedBy: "platform" | "customer" | null;
  appliedAt: string | null;
  after14: PushAfter | null;
  after28: PushAfter | null;
  /** "Pushed Nov 16: 37 → 29", or null for a push that changed nothing. */
  line: string | null;
  createdAt: string;
}

type Row = Record<string, unknown>;
const num = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));
const str = (value: unknown): string | null => (typeof value === "string" ? value : null);

export const PUSH_COLUMNS =
  "id, article_id, origin, status, skip_reason, main_query, query_impressions, query_clicks, query_position, before_start, before_end, before_position, before_impressions, before_clicks, links, old_title, new_title, old_meta_description, new_meta_description, applied_by, applied_at, after_14, after_28, created_at";

export function toPushView(row: Row, now: Date = new Date()): ArticlePushView {
  const after14 = (row.after_14 as PushAfter | null) ?? null;
  const after28 = (row.after_28 as PushAfter | null) ?? null;
  const view: ArticlePushView = {
    id: String(row.id),
    articleId: String(row.article_id),
    origin: row.origin === "on_demand" ? "on_demand" : "sweep",
    status: String(row.status) as ArticlePushView["status"],
    skipReason: str(row.skip_reason),
    mainQuery: str(row.main_query),
    query: { impressions: num(row.query_impressions), clicks: num(row.query_clicks), position: num(row.query_position) },
    before: {
      start: str(row.before_start),
      end: str(row.before_end),
      position: num(row.before_position),
      impressions: num(row.before_impressions),
      clicks: num(row.before_clicks),
    },
    links: Array.isArray(row.links) ? (row.links as PushLink[]) : [],
    title: { old: str(row.old_title), new: str(row.new_title) },
    metaDescription: { old: str(row.old_meta_description), new: str(row.new_meta_description) },
    appliedBy: row.applied_by === "platform" || row.applied_by === "customer" ? row.applied_by : null,
    appliedAt: str(row.applied_at),
    after14,
    after28,
    line: null,
    createdAt: String(row.created_at),
  };
  view.line = pushLine(
    {
      status: view.status,
      createdAt: view.createdAt,
      appliedAt: view.appliedAt,
      beforePosition: view.before.position,
      after14: after14 ? { position: after14.position } : null,
      after28: after28 ? { position: after28.position } : null,
    },
    now
  );
  return view;
}

// ── What selection reads ───────────────────────────────────────────────────

/** The newest day Search Console data is settled through for this site; null when nothing was ingested. */
export async function loadWatermark(supabase: SupabaseClient, businessId: string): Promise<string | null> {
  const { data } = await supabase
    .from("analytics_connections")
    .select("last_synced_on, status, site_url")
    .eq("business_id", businessId)
    .eq("provider", SEARCH_CONSOLE)
    .maybeSingle();
  if (!data || data.status === "disconnected" || !data.site_url) return null;
  return (data.last_synced_on as string | null) ?? null;
}

/** Search Console days per article of the site since `since`, every page of them. */
export async function loadSiteMetrics(supabase: SupabaseClient, businessId: string, since: string): Promise<Map<string, MetricDay[]>> {
  const byArticle = new Map<string, MetricDay[]>();
  for (let from = 0; ; from += 1000) {
    const { data, error } = await supabase
      .from("content_metrics")
      .select("article_id, captured_on, impressions, clicks, position")
      .eq("business_id", businessId)
      .eq("source", SEARCH_CONSOLE)
      .gte("captured_on", since)
      .order("captured_on", { ascending: true })
      .range(from, from + 999);
    if (error) throw new Error(`content_metrics: ${error.message}`);
    for (const row of (data ?? []) as Row[]) {
      const id = String(row.article_id);
      const list = byArticle.get(id) ?? [];
      list.push({
        capturedOn: String(row.captured_on),
        impressions: Number(row.impressions ?? 0),
        clicks: Number(row.clicks ?? 0),
        position: num(row.position),
      });
      byArticle.set(id, list);
    }
    if ((data ?? []).length < 1000) break;
  }
  return byArticle;
}

/** An article's queries from its newest stored window. */
export async function loadMainQueryRows(supabase: SupabaseClient, articleId: string): Promise<{ periodEnd: string | null; rows: QueryRow[] }> {
  const { data } = await supabase
    .from("content_queries")
    .select("query, impressions, clicks, position, period_end")
    .eq("article_id", articleId)
    .order("period_end", { ascending: false })
    .order("impressions", { ascending: false })
    .limit(200);
  const rows = (data ?? []) as Row[];
  const periodEnd = rows[0] ? String(rows[0].period_end) : null;
  return {
    periodEnd,
    rows: rows
      .filter((row) => String(row.period_end) === periodEnd)
      .map((row) => ({ query: String(row.query), impressions: Number(row.impressions ?? 0), clicks: Number(row.clicks ?? 0), position: num(row.position) })),
  };
}

export interface SiteArticle {
  id: string;
  userId: string;
  publishedUrl: string | null;
  title: string;
  keyword: string;
}

/** What `pushEligibility` needs for the site's published articles, in a fixed number of reads. */
export async function loadPushInputs(
  supabase: SupabaseClient,
  businessId: string,
  watermark: string,
  now: Date,
  onlyArticleId?: string
): Promise<{ articles: SiteArticle[]; inputs: PushCandidateInput[]; metrics: Map<string, MetricDay[]> }> {
  let query = supabase
    .from("articles")
    .select("id, user_id, published_url, last_refreshed_at, title:canonical->>title, keyword:canonical->>keyword")
    .eq("business_id", businessId)
    .eq("status", "published");
  if (onlyArticleId) query = query.eq("id", onlyArticleId);
  const { data: rows, error } = await query.limit(500);
  if (error) throw new Error(`articles: ${error.message}`);
  const articles: SiteArticle[] = ((rows ?? []) as Row[]).map((row) => ({
    id: String(row.id),
    userId: String(row.user_id),
    publishedUrl: str(row.published_url)?.trim() || null,
    title: str(row.title) ?? "",
    keyword: str(row.keyword) ?? "",
  }));
  const ids = articles.map((a) => a.id);
  if (ids.length === 0) return { articles, inputs: [], metrics: new Map() };

  const quietSince = new Date(now.getTime() - PUSH_QUIET_DAYS * DAY_MS).toISOString();
  const pushSince = new Date(now.getTime() - PUSH_COOLDOWN_DAYS * DAY_MS).toISOString();
  const [metrics, versions, published, pushes, jobs] = await Promise.all([
    loadSiteMetrics(supabase, businessId, baselineWindow(watermark).start),
    supabase.from("article_versions").select("article_id, created_at").eq("business_id", businessId).gte("created_at", quietSince),
    // Going live counts as a change; a published → published event (a refresh
    // that was declined or discarded) changed nothing and does not.
    supabase
      .from("article_events")
      .select("article_id, created_at")
      .in("article_id", ids)
      .eq("to_state", "published")
      .neq("from_state", "published")
      .gte("created_at", quietSince),
    supabase.from("article_pushes").select("article_id, created_at").eq("business_id", businessId).gte("created_at", pushSince),
    supabase.from("jobs").select("article_id").in("article_id", ids).in("type", [REFRESH_ARTICLE, PUSH_ARTICLE]).in("status", ["pending", "running"]),
  ]);

  const latest = (rows: Row[] | null | undefined) => {
    const out = new Map<string, string>();
    for (const row of rows ?? []) {
      const id = String(row.article_id);
      const at = String(row.created_at);
      if (!out.has(id) || at > (out.get(id) as string)) out.set(id, at);
    }
    return out;
  };
  const edited = latest([...((versions.data ?? []) as Row[]), ...((published.data ?? []) as Row[])]);
  const pushed = latest((pushes.data ?? []) as Row[]);
  const busy = new Set(((jobs.data ?? []) as Row[]).map((row) => String(row.article_id)));
  const refreshed = new Map(((rows ?? []) as Row[]).map((row) => [String(row.id), str(row.last_refreshed_at)]));

  const inputs = articles.map((article) => {
    const candidates = [edited.get(article.id) ?? null, refreshed.get(article.id) ?? null].filter((v): v is string => Boolean(v));
    return {
      articleId: article.id,
      publishedUrl: article.publishedUrl,
      metrics: metrics.get(article.id) ?? [],
      lastPushAt: pushed.get(article.id) ?? null,
      lastEditedAt: candidates.sort().at(-1) ?? null,
      busy: busy.has(article.id),
    };
  });
  return { articles, inputs, metrics };
}

// ── Recording a push and starting it ───────────────────────────────────────

interface RecordParams {
  admin: SupabaseClient;
  userId: string;
  businessId: string;
  articleId: string;
  origin: "sweep" | "on_demand";
  before: WindowStats;
  now?: Date;
}

/**
 * Chooses the main query and writes the push row: `skipped` with its reason
 * when there is no clear query, else `selected` with the job enqueued.
 */
export async function recordAndStartPush(params: RecordParams & { watermark: string }): Promise<ArticlePushView> {
  const { admin, userId, businessId, articleId, origin, before } = params;
  const { periodEnd, rows } = await loadMainQueryRows(admin, articleId);
  let main = chooseMainQuery(rows);
  // Queries from a window more than a week older than the page numbers are not this article's current searches.
  if (main.ok && periodEnd && periodEnd < dayOf(new Date(new Date(`${params.watermark}T00:00:00Z`).getTime() - 7 * DAY_MS).toISOString())) {
    main = { ok: false, reason: "the stored queries are older than the page's numbers" };
  }
  const base = {
    user_id: userId,
    business_id: businessId,
    article_id: articleId,
    origin,
    before_start: before.start,
    before_end: before.end,
    before_position: before.position,
    before_impressions: before.impressions,
    before_clicks: before.clicks,
    created_at: (params.now ?? new Date()).toISOString(),
  };
  const insert: Record<string, unknown> = main.ok
    ? { ...base, status: "selected", main_query: main.query, query_impressions: main.impressions, query_clicks: main.clicks, query_position: main.position }
    : { ...base, status: "skipped", skip_reason: `No clear query: ${main.reason}.` };
  const { data, error } = await admin.from("article_pushes").insert(insert).select(PUSH_COLUMNS).single();
  if (error || !data) throw new Error(`article_pushes insert failed: ${error?.message ?? "no row"}`);

  if (main.ok) {
    const jobId = await enqueueJob({
      supabase: admin,
      userId,
      businessId,
      type: PUSH_ARTICLE,
      articleId,
      input: { pushId: data.id, articleId },
      maxAttempts: 2,
    });
    await admin.from("article_pushes").update({ job_id: jobId }).eq("id", data.id);
  }
  return toPushView(data as Row);
}

/**
 * The weekly sweep for one site (whose owner opted in and pays: the cron
 * checks): at most `PUSHES_PER_SITE_PER_WEEK` candidates, each recorded.
 */
export async function sweepSitePushes(params: {
  admin: SupabaseClient;
  businessId: string;
  userId: string;
  now?: Date;
}): Promise<{ status: "no_search_console" } | { status: "swept"; selected: number; skipped: number; excluded: number }> {
  const now = params.now ?? new Date();
  const watermark = await loadWatermark(params.admin, params.businessId);
  if (!watermark) return { status: "no_search_console" };
  const { inputs } = await loadPushInputs(params.admin, params.businessId, watermark, now);
  const { candidates, excluded } = selectPushCandidates({ articles: inputs, watermark, now });
  let selected = 0;
  let skipped = 0;
  for (const candidate of candidates) {
    const push = await recordAndStartPush({
      admin: params.admin,
      userId: params.userId,
      businessId: params.businessId,
      articleId: candidate.articleId,
      origin: "sweep",
      before: candidate.before,
      watermark,
      now,
    });
    if (push.status === "skipped") skipped += 1;
    else selected += 1;
  }
  return { status: "swept", selected, skipped, excluded: excluded.length };
}

export type PushRequestResult =
  | { ok: true; push: ArticlePushView }
  | { ok: false; status: 404 | 409; code: "not_found" | "not_eligible" | "conflict"; error: string };

/**
 * `push_article` and the modal's "Push this article": one article, now. The
 * position band and the minimum impressions do not apply (the person
 * decides); everything that keeps the measurement honest does. The paywall
 * and the spend ceiling are the caller's (route or tool runner), and the
 * worker checks them again before the job spends.
 */
export async function requestArticlePush(params: {
  admin: SupabaseClient;
  userId: string;
  businessId: string;
  articleId: string;
  now?: Date;
}): Promise<PushRequestResult> {
  const now = params.now ?? new Date();
  const { data: article } = await params.admin
    .from("articles")
    .select("id, status")
    .eq("id", params.articleId)
    .eq("business_id", params.businessId)
    .eq("user_id", params.userId)
    .maybeSingle();
  if (!article) return { ok: false, status: 404, code: "not_found", error: "No such article on this site." };
  if (article.status !== "published") return { ok: false, status: 409, code: "not_eligible", error: "Only a published article can be pushed." };
  const watermark = await loadWatermark(params.admin, params.businessId);
  if (!watermark) {
    return { ok: false, status: 409, code: "not_eligible", error: "Connect Search Console first: a push is chosen and measured from its numbers." };
  }
  const { inputs } = await loadPushInputs(params.admin, params.businessId, watermark, now, params.articleId);
  const input = inputs[0];
  if (!input) return { ok: false, status: 404, code: "not_found", error: "No such article on this site." };
  const verdict = pushEligibility(input, { watermark, now, ignoreBand: true });
  if (!verdict.ok) {
    return { ok: false, status: 409, code: verdict.reason === "busy" ? "conflict" : "not_eligible", error: `This article cannot be pushed now: ${PUSH_EXCLUSION_TEXT[verdict.reason]}.` };
  }
  const push = await recordAndStartPush({
    admin: params.admin,
    userId: params.userId,
    businessId: params.businessId,
    articleId: params.articleId,
    origin: "on_demand",
    before: verdict.before,
    watermark,
    now,
  });
  return { ok: true, push };
}

// ── Measuring ──────────────────────────────────────────────────────────────

/**
 * After-values for the site's applied pushes whose +14 or +28 window Search
 * Console now covers. Free: stored rows only. Called after every ingest, so
 * a window is measured the day its data settles. A window with no
 * impression stores a null position ("no impressions since"), never 0.
 */
export async function measureDuePushes(supabase: SupabaseClient, businessId: string, now: Date = new Date()): Promise<{ measured: number }> {
  const watermark = await loadWatermark(supabase, businessId);
  if (!watermark) return { measured: 0 };
  const { data } = await supabase
    .from("article_pushes")
    .select("id, article_id, applied_at, after_14, after_28")
    .eq("business_id", businessId)
    .eq("status", "applied")
    .not("applied_at", "is", null)
    .is("after_28", null)
    .limit(200);
  const due = ((data ?? []) as Row[]).filter((row) =>
    PUSH_MEASURE_DAYS.some((days) => row[`after_${days}`] == null && measurementDue(str(row.applied_at), days, watermark))
  );
  if (due.length === 0) return { measured: 0 };
  const earliest = due.map((row) => afterWindow(String(row.applied_at), 1).start).sort()[0];
  const metrics = await loadSiteMetrics(supabase, businessId, earliest);
  let measured = 0;
  for (const row of due) {
    const update: Record<string, unknown> = {};
    for (const days of PUSH_MEASURE_DAYS) {
      if (row[`after_${days}`] != null || !measurementDue(str(row.applied_at), days, watermark)) continue;
      const window = afterWindow(String(row.applied_at), days);
      const stats = windowStats(metrics.get(String(row.article_id)) ?? [], window.start, window.end);
      update[`after_${days}`] = { ...stats, measuredAt: now.toISOString() } satisfies PushAfter;
    }
    if (Object.keys(update).length === 0) continue;
    update.updated_at = now.toISOString();
    const { error } = await supabase.from("article_pushes").update(update).eq("id", row.id).eq("business_id", businessId);
    if (!error) measured += 1;
  }
  return { measured };
}

// ── Reads ──────────────────────────────────────────────────────────────────

/** The site's pushes, newest first; `articleId` narrows to one article. */
export async function listArticlePushes(
  client: SupabaseClient,
  businessId: string,
  options: { articleId?: string; status?: ArticlePushView["status"]; limit?: number; now?: Date } = {}
): Promise<ArticlePushView[]> {
  let query = client.from("article_pushes").select(PUSH_COLUMNS).eq("business_id", businessId);
  if (options.articleId) query = query.eq("article_id", options.articleId);
  if (options.status) query = query.eq("status", options.status);
  const { data, error } = await query.order("created_at", { ascending: false }).limit(options.limit ?? 50);
  if (error) throw new Error(`article_pushes: ${error.message}`);
  return ((data ?? []) as Row[]).map((row) => toPushView(row, options.now));
}

/**
 * The newest push that changed something (applied or proposed) per article:
 * what Growth's By article prints. One read for every article.
 */
export async function latestPushes(client: SupabaseClient, articleIds: readonly string[], now: Date = new Date()): Promise<Map<string, ArticlePushView>> {
  const out = new Map<string, ArticlePushView>();
  if (articleIds.length === 0) return out;
  const { data, error } = await client
    .from("article_pushes")
    .select(PUSH_COLUMNS)
    .in("article_id", [...articleIds])
    .in("status", ["applied", "proposed"])
    .order("created_at", { ascending: false });
  if (error) return out;
  for (const row of (data ?? []) as Row[]) {
    const id = String(row.article_id);
    if (!out.has(id)) out.set(id, toPushView(row, now));
  }
  return out;
}

export type PushResolution = "applied" | "dismissed";

/**
 * The customer's answer to a proposal: "I applied it" (the measurement
 * starts that day) or "Dismiss". Only a proposal of this site and user.
 */
export async function resolveArticlePush(params: {
  admin: SupabaseClient;
  userId: string;
  businessId: string;
  pushId: string;
  action: PushResolution;
  now?: Date;
}): Promise<{ ok: true; push: ArticlePushView } | { ok: false; status: 404 | 409; code: "not_found" | "conflict"; error: string }> {
  const now = params.now ?? new Date();
  const { data: row } = await params.admin
    .from("article_pushes")
    .select("id, status")
    .eq("id", params.pushId)
    .eq("business_id", params.businessId)
    .eq("user_id", params.userId)
    .maybeSingle();
  if (!row) return { ok: false, status: 404, code: "not_found", error: "No such push on this site." };
  if (row.status !== "proposed") return { ok: false, status: 409, code: "conflict", error: `This push is ${row.status}, not waiting for you.` };
  const update =
    params.action === "applied"
      ? { status: "applied", applied_by: "customer", applied_at: now.toISOString(), updated_at: now.toISOString() }
      : { status: "dismissed", updated_at: now.toISOString() };
  const { data, error } = await params.admin
    .from("article_pushes")
    .update(update)
    .eq("id", params.pushId)
    .eq("business_id", params.businessId)
    .eq("status", "proposed")
    .select(PUSH_COLUMNS)
    .single();
  if (error || !data) return { ok: false, status: 409, code: "conflict", error: "The push changed meanwhile; reload." };
  return { ok: true, push: toPushView(data as Row, now) };
}
