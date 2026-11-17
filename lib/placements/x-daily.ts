import type { SupabaseClient } from "@supabase/supabase-js";
import { enqueueJob } from "@/lib/jobs/queue";
import { X_DISCOVERY } from "@/lib/jobs/workflows/x-discovery";
import { llmPausedUntil } from "@/lib/llm-billing";
import { isSpendSkip, logOwnerSkip, spendingOwners } from "@/lib/limits/owners";
import { logUnpaidSkip, paidOwners } from "@/lib/paid-access";
import { isXApiEnabled, xApiClientFromEnv, type XApiClient } from "@/lib/providers/x/api";
import { parseVoiceSettings } from "@/lib/voice/settings";
import { refreshXAccountMetrics, type AccountRefreshOutcome } from "./x-account";
import { readXApiStatus } from "./x-budget";
import { refreshXReplyMetrics, type MetricsRefreshOutcome } from "./x-metrics";
import { backfillReferencedPosts, type ReferencedBackfillOutcome } from "./x-referenced";

/**
 * The daily X run (`/api/cron/x-posts`), whole: which sites take part, the
 * numbers of their posted replies (read here, one batched call), the
 * followers of each site's own account (one user lookup a site, read here),
 * and one search job per site (run by the worker: search, rules, qualify,
 * draft).
 *
 * A site takes part when its owner turned "Find posts on X" on and the
 * platform has the X API on. Its owner must pay; the search, which leads to
 * model calls, also needs the owner under their daily AI spend limit and the
 * model accounts able to pay. The monthly cap is checked again before every
 * call to X, so what is decided here is only who is asked, never how much
 * is spent.
 */

/** Sites searched per run. The cap protects the bill; this keeps one run short. */
export const X_MAX_BUSINESSES_PER_RUN = 10;

/** A site searched less than this long ago is not searched again (a retried cron). */
export const X_SEARCH_MIN_INTERVAL_MS = 20 * 60 * 60 * 1000;

const CANDIDATE_BUSINESSES = 500;

export interface XDailyOutcome {
  skipped?: string;
  sites: number;
  metrics: MetricsRefreshOutcome | { skipped: string };
  account: AccountRefreshOutcome | { skipped: string };
  /** The quoted and replied-to posts read for open posts that had none recorded; absent when the run stopped early. */
  referenced?: ReferencedBackfillOutcome | { skipped: string };
  search: { enqueued: number; recent: number; skippedUnpaid: number; skippedSpendCap: number } | { skipped: string };
}

/** The sites whose owner turned "Find posts on X" on. */
export async function sitesFindingOnX(admin: SupabaseClient): Promise<Array<{ id: string; user_id: string }>> {
  const { data, error } = await admin.from("businesses").select("id, user_id, voice_settings").limit(CANDIDATE_BUSINESSES);
  if (error) throw new Error(`businesses: ${error.message}`);
  return ((data ?? []) as Array<{ id: string; user_id: string; voice_settings: unknown }>)
    .filter((b) => parseVoiceSettings(b.voice_settings).findPostsOnX)
    .map((b) => ({ id: b.id, user_id: b.user_id }));
}

/** True when this site's X search is queued, running, or ran in the last 20 hours. */
async function searchedRecently(admin: SupabaseClient, businessId: string, now: Date): Promise<boolean> {
  const since = new Date(now.getTime() - X_SEARCH_MIN_INTERVAL_MS).toISOString();
  const { data } = await admin
    .from("jobs")
    .select("id, status, created_at")
    .eq("business_id", businessId)
    .eq("type", X_DISCOVERY)
    .order("created_at", { ascending: false })
    .limit(1);
  const last = ((data ?? []) as Array<{ status: string; created_at: string }>)[0];
  if (!last) return false;
  return ["pending", "running"].includes(last.status) || last.created_at >= since;
}

export async function runXDaily(params: {
  admin: SupabaseClient;
  now?: Date;
  /** Test seam: the X client; from the env otherwise. */
  client?: XApiClient | null;
}): Promise<XDailyOutcome> {
  const now = params.now ?? new Date();
  const { admin } = params;
  if (!isXApiEnabled() && params.client === undefined) {
    return {
      skipped: "x_api_disabled",
      sites: 0,
      metrics: { skipped: "x_api_disabled" },
      account: { skipped: "x_api_disabled" },
      search: { skipped: "x_api_disabled" },
    };
  }
  const client = params.client === undefined ? xApiClientFromEnv() : params.client;

  const sites = await sitesFindingOnX(admin);
  if (sites.length === 0) {
    const none = { skipped: "no site has Find posts on X on" };
    return { sites: 0, metrics: none, account: none, search: none };
  }

  // The numbers of posted replies and of the site's own account: no model
  // involved, the owner must pay.
  const paid = paidOwners(admin, now);
  const paying: Array<{ id: string; user_id: string }> = [];
  for (const site of sites) {
    const verdict = await paid.verdict(site.user_id);
    if (verdict === true) paying.push(site);
    else logUnpaidSkip("x-posts", { user_id: site.user_id, business_id: site.id, reason: verdict });
  }
  const metrics = await refreshXReplyMetrics({ admin, client, businessIds: paying.map((site) => site.id), now });
  const account = await refreshXAccountMetrics({ admin, client, sites: paying, now });
  // What the open posts of the last 3 days quote and answer, where nothing
  // is recorded (x-referenced.ts): metered for the paying sites taking
  // part, free through the embed for the rest. Never stops the run.
  let referenced: XDailyOutcome["referenced"];
  try {
    referenced = await backfillReferencedPosts({ admin, client, apiBusinessIds: paying.map((site) => site.id), now });
  } catch (err) {
    referenced = { skipped: err instanceof Error ? err.message.slice(0, 200) : String(err) };
  }

  // The search: a job per site, judged and drafted by models.
  let search: XDailyOutcome["search"];
  const status = await readXApiStatus(admin, now);
  const llmPaused = await llmPausedUntil(admin, now);
  if (status.capReached) search = { skipped: "monthly_cap_reached" };
  else if (status.pausedUntil) search = { skipped: `x_api_paused_until ${status.pausedUntil}` };
  else if (llmPaused) search = { skipped: `llm_billing_paused_until ${llmPaused.toISOString()}` };
  else {
    const owners = spendingOwners(admin, now);
    const counts = { enqueued: 0, recent: 0, skippedUnpaid: 0, skippedSpendCap: 0 };
    for (const site of sites) {
      if (counts.enqueued >= X_MAX_BUSINESSES_PER_RUN) break;
      const verdict = await owners.verdict(site.user_id);
      if (verdict !== true) {
        if (isSpendSkip(verdict)) counts.skippedSpendCap += 1;
        else counts.skippedUnpaid += 1;
        logOwnerSkip("x-posts", { user_id: site.user_id, business_id: site.id, reason: verdict });
        continue;
      }
      if (await searchedRecently(admin, site.id, now)) {
        counts.recent += 1;
        continue;
      }
      await enqueueJob({
        supabase: admin,
        userId: site.user_id,
        businessId: site.id,
        type: X_DISCOVERY,
        input: { businessId: site.id },
        maxAttempts: 2,
      });
      counts.enqueued += 1;
    }
    search = counts;
  }

  return { sites: sites.length, metrics, account, referenced, search };
}
