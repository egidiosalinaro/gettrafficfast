import type { SupabaseClient } from "@supabase/supabase-js";
import { IntegrationRow } from "@/lib/integrations/types";
import { ensureCanonical, publishArticle } from "@/lib/content/service";
import { enqueueBacklinkPass } from "@/lib/jobs/workflows/backlink-article";
import { hasActiveJob } from "@/lib/jobs/queue";
import { PRODUCE_ARTICLE } from "@/lib/jobs/workflows/produce-article";
import { integrationErrorEmail, sendNotificationEmail } from "@/lib/notifications/email";

/**
 * Automatic publishing: due `generated` articles → the destination connected
 * to their own site → `published`. Two callers, one set of rules:
 *
 *   - the daily run (`/api/cron/generate-articles`, phase 2) scans every due
 *     article oldest first, including ones whose previous delivery failed:
 *     that run is the publish retry, once a day;
 *   - the worker tick (`/api/jobs/tick`, every 5 minutes) passes `freshSince`
 *     and looks only at articles changed since then, newest first, leaving
 *     failed deliveries to the daily run. It exists for the article whose
 *     production finishes after the daily run's publishing phase: on
 *     2026-11-10 a job ran 08:00:39 → 08:08:10, the phase found it still
 *     producing, and without the tick it would have waited a full day.
 *
 * `needs_review` is never read here: it never publishes on its own. An
 * article whose production job is still live is skipped (enrichment runs
 * after `generated`), and so is one with no site or no destination, counted
 * rather than guessed at.
 *
 * Delivery is claimed first, atomically: `articles.publish_claimed_at` is
 * compared-and-set from the value this run read, on a row that is still
 * `generated`, and only the run whose update changed the row delivers. Two
 * runs (the daily one and a tick, or two ticks) can read the same article;
 * one of them publishes it. A claim older than CLAIM_LEASE_MS belongs to a run
 * that died mid-delivery (functions live at most 300 s) and can be taken over.
 */

/** Longer than any function lives (maxDuration 300 s): an older claim is a dead run's. */
export const CLAIM_LEASE_MS = 10 * 60_000;

/** How many rows the tick reads to find its `limit` candidates past failed deliveries. */
const FRESH_SCAN_ROWS = 10;

export interface PublishingCounts {
  published: number;
  retry_pending: number;
  needs_review: number;
  no_destination: number;
  still_producing: number;
  /** Another run holds the article's delivery right now, or delivered it first. */
  claimed_elsewhere: number;
}

export type PublishLog = (level: "info" | "warn" | "error", fields: Record<string, unknown>) => void;

export interface PublishReadyOptions {
  runId: string;
  /** UTC day; articles scheduled on or before it are due. */
  today: string;
  /** Articles handled at most. */
  limit: number;
  /**
   * The tick's window: only articles updated at or after this instant, newest
   * first, and not ones whose last delivery failed (their retry is the daily
   * run's, so a broken destination is not called every five minutes). Absent:
   * every due article, oldest first.
   */
  freshSince?: string;
  log?: PublishLog;
  /** Owner emails already read in this run. */
  emailCache?: Map<string, string | null>;
}

export interface PublishReadyResult {
  counts: PublishingCounts;
  /** The ready-articles read failed; nothing was published. */
  error: string | null;
}

type ReadyRow = {
  id: string;
  keyword_id: string;
  user_id: string;
  business_id: string | null;
  content: string | null;
  canonical: unknown;
  status: string;
  scheduled_date: string;
  last_error: string | null;
  publish_claimed_at: string | null;
  keywords?: unknown;
};

function keywordOf(row: unknown): string {
  const kw = (row as { keywords?: { keyword?: string } | { keyword?: string }[] }).keywords;
  if (Array.isArray(kw)) return kw[0]?.keyword ?? "";
  return kw?.keyword ?? "";
}

/** A previous delivery failed: `publishArticle` writes its reason with this prefix. */
function deliveryFailed(row: ReadyRow): boolean {
  return typeof row.last_error === "string" && row.last_error.startsWith("publish:");
}

export function emptyPublishingCounts(): PublishingCounts {
  return { published: 0, retry_pending: 0, needs_review: 0, no_destination: 0, still_producing: 0, claimed_elsewhere: 0 };
}

/**
 * Takes the article's delivery for this run, or says another run has it.
 * Compare-and-set on the claim value read with the row: of two runs that read
 * the same value, only the first update matches. A claim newer than the lease
 * is a live run's and is left alone without a write.
 */
async function claimDelivery(
  supabase: SupabaseClient,
  row: ReadyRow,
  now: number
): Promise<string | null> {
  const held = row.publish_claimed_at;
  if (held && now - Date.parse(held) < CLAIM_LEASE_MS) return null;

  const claimedAt = new Date(now).toISOString();
  let update = supabase
    .from("articles")
    .update({ publish_claimed_at: claimedAt })
    .eq("id", row.id)
    .eq("status", "generated");
  update = held ? update.eq("publish_claimed_at", held) : update.is("publish_claimed_at", null);
  const { data, error } = await update.select("id");
  if (error || !Array.isArray(data) || data.length !== 1) return null;
  return claimedAt;
}

/** Lets the claim go, only if it is still this run's. */
async function releaseDelivery(supabase: SupabaseClient, articleId: string, claimedAt: string): Promise<void> {
  await supabase
    .from("articles")
    .update({ publish_claimed_at: null })
    .eq("id", articleId)
    .eq("publish_claimed_at", claimedAt);
}

async function getUserEmail(
  supabase: SupabaseClient,
  cache: Map<string, string | null>,
  userId: string
): Promise<string | null> {
  const cached = cache.get(userId);
  if (cached !== undefined) return cached;
  const { data } = await supabase.auth.admin.getUserById(userId);
  const email = data?.user?.email ?? null;
  cache.set(userId, email);
  return email;
}

export async function publishReadyArticles(
  supabase: SupabaseClient,
  options: PublishReadyOptions
): Promise<PublishReadyResult> {
  const { runId, today, limit, freshSince } = options;
  const log: PublishLog = options.log ?? (() => {});
  const emailCache = options.emailCache ?? new Map<string, string | null>();
  const counts = emptyPublishingCounts();

  let query = supabase
    .from("articles")
    .select(
      `id, keyword_id, user_id, business_id, content, canonical, status, scheduled_date, last_error, publish_claimed_at,
       keywords!articles_keyword_id_fkey ( keyword )`
    )
    .eq("status", "generated")
    .lte("scheduled_date", today);
  query = freshSince
    ? query.gte("updated_at", freshSince).order("updated_at", { ascending: false }).limit(FRESH_SCAN_ROWS)
    : query.order("scheduled_date", { ascending: true }).limit(limit);

  const { data, error } = await query;
  if (error) return { counts, error: error.message };

  let rows = (data ?? []) as ReadyRow[];
  if (freshSince) rows = rows.filter((row) => !deliveryFailed(row));
  rows = rows.slice(0, limit);

  const integrationCache = new Map<string, IntegrationRow | null>();

  for (const row of rows) {
    // `generated` is reached at the validate step, but enrichment (media) runs
    // after it. Publishing while the production job is still live would ship
    // the article without the media it is about to get — wait for the job.
    if (await hasActiveJob(supabase, row.id, PRODUCE_ARTICLE)) {
      counts.still_producing++;
      continue;
    }

    // An article with no site cannot be published anywhere: it predates
    // business tenancy and there is no way to know whose website it belongs
    // to. Counted as "no destination" rather than guessed at.
    if (!row.business_id) {
      counts.no_destination++;
      continue;
    }

    // The destination belongs to the article's owner AND site: a business id
    // alone would hand the article to whatever integration that id matches,
    // and this service-role read has no RLS to fall back on.
    const integrationKey = `${row.user_id}:${row.business_id}`;
    let integration = integrationCache.get(integrationKey);
    if (integration === undefined) {
      const { data: found } = await supabase
        .from("integrations")
        .select("id, user_id, business_id, type, config, status, last_error, last_sync_at, created_at, updated_at")
        .eq("business_id", row.business_id)
        .eq("user_id", row.user_id)
        .in("status", ["connected", "error"])
        .order("created_at", { ascending: true })
        .limit(1);
      integration = (found?.[0] ?? null) as IntegrationRow | null;
      integrationCache.set(integrationKey, integration);
    }

    if (!integration) {
      counts.no_destination++;
      continue;
    }

    const claimedAt = await claimDelivery(supabase, row, Date.now());
    if (!claimedAt) {
      counts.claimed_elsewhere++;
      continue;
    }

    try {
      const canonical = await ensureCanonical({
        supabase,
        article: {
          id: row.id,
          keyword_id: row.keyword_id,
          content: row.content,
          canonical: row.canonical,
          scheduled_date: row.scheduled_date,
          status: row.status,
        },
        keyword: keywordOf(row),
      });

      if (!canonical.article || canonical.decision !== "publish") {
        counts.needs_review++;
        await supabase
          .from("articles")
          .update({
            status: "needs_review",
            last_error: canonical.issues
              .filter((i) => i.action !== "warn")
              .map((i) => i.message)
              .join(" | ")
              .slice(0, 2000),
            updated_at: new Date().toISOString(),
          })
          .eq("id", row.id);
        log("warn", {
          phase: "publish",
          article_id: row.id,
          status: "needs_review",
          issues: canonical.issues.map((i) => i.code),
        });
        continue;
      }

      const wasConnected = integration.status === "connected";
      const result = await publishArticle({
        supabase,
        articleId: row.id,
        userId: row.user_id,
        businessId: row.business_id,
        keywordId: row.keyword_id,
        canonical: canonical.article,
        integration,
        jobId: runId,
      });

      if (result.ok) {
        counts.published++;
        integration.status = "connected";
        log("info", { phase: "publish", article_id: row.id, status: "published", url: result.url });
        // Older related articles get a link to this one (docs/KNOWLEDGE.md).
        // Queued, never run here; once per article; it cannot fail the publish.
        await enqueueBacklinkPass({ supabase, userId: row.user_id, businessId: row.business_id, articleId: row.id });
      } else {
        counts.retry_pending++;
        integration.status = "error";
        log("warn", { phase: "publish", article_id: row.id, status: "retry_pending", error: result.error });
        if (wasConnected) {
          const email = await getUserEmail(supabase, emailCache, row.user_id);
          if (email) {
            await sendNotificationEmail({
              to: email,
              ...integrationErrorEmail(integration.type, result.error),
            });
          }
        }
      }
    } finally {
      await releaseDelivery(supabase, row.id, claimedAt);
    }
  }

  return { counts, error: null };
}
