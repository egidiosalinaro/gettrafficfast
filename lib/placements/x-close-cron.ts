import type { SupabaseClient } from "@supabase/supabase-js";
import { enqueueJob } from "@/lib/jobs/queue";
import { X_CLOSE_TRIAL } from "@/lib/jobs/workflows/x-close-trial";
import { llmPausedUntil } from "@/lib/llm-billing";
import { logOwnerSkip, spendingOwners } from "@/lib/limits/owners";
import { parseVoiceSettings } from "@/lib/voice/settings";
import { readXApiStatus } from "./x-budget";
import { closeTrialBusinessIds, closeTrialGate } from "./x-close";

/**
 * The close-accounts trial's cron (`/api/cron/x-close-trial`, every three
 * hours from 06:00 to 21:00 UTC; docs/PLACEMENTS.md, "Close accounts
 * trial"): one `x-close-trial` job per listed site that may run now. Does
 * nothing unless the site is in `X_CLOSE_TRIAL_BUSINESS_IDS`, the platform
 * has the X API on, the date is before `X_CLOSE_TRIAL_UNTIL`, the site has
 * Find posts on X on and its owner pays and is under the AI spend limit.
 * The monthly X cap is checked again before every call.
 */

export interface CloseTrialCronOutcome {
  skipped?: string;
  enqueued: string[];
  skippedSites: Array<{ businessId: string; reason: string }>;
}

export async function runXCloseTrial(params: { admin: SupabaseClient; now?: Date; env?: Record<string, string | undefined> }): Promise<CloseTrialCronOutcome> {
  const now = params.now ?? new Date();
  const env = params.env ?? process.env;
  const { admin } = params;
  const ids = closeTrialBusinessIds(env);
  if (ids.length === 0) return { skipped: "no site in X_CLOSE_TRIAL_BUSINESS_IDS", enqueued: [], skippedSites: [] };

  const status = await readXApiStatus(admin, now);
  if (status.capReached) return { skipped: "monthly_cap_reached", enqueued: [], skippedSites: [] };
  if (status.pausedUntil) return { skipped: `x_api_paused_until ${status.pausedUntil}`, enqueued: [], skippedSites: [] };
  const llmPaused = await llmPausedUntil(admin, now);
  if (llmPaused) return { skipped: `llm_billing_paused_until ${llmPaused.toISOString()}`, enqueued: [], skippedSites: [] };

  const owners = spendingOwners(admin, now);
  const out: CloseTrialCronOutcome = { enqueued: [], skippedSites: [] };
  for (const businessId of ids) {
    const gate = closeTrialGate(businessId, now, env);
    if (!gate.ok) {
      out.skippedSites.push({ businessId, reason: gate.reason });
      continue;
    }
    const { data: business } = await admin.from("businesses").select("id, user_id, voice_settings").eq("id", businessId).maybeSingle();
    const site = business as { id: string; user_id: string; voice_settings: unknown } | null;
    if (!site) {
      out.skippedSites.push({ businessId, reason: "business not found" });
      continue;
    }
    if (!parseVoiceSettings(site.voice_settings).findPostsOnX) {
      out.skippedSites.push({ businessId, reason: "Find posts on X is off for this site" });
      continue;
    }
    const verdict = await owners.verdict(site.user_id);
    if (verdict !== true) {
      logOwnerSkip("x-close-trial", { user_id: site.user_id, business_id: site.id, reason: verdict });
      out.skippedSites.push({ businessId, reason: verdict });
      continue;
    }
    const { data: active } = await admin
      .from("jobs")
      .select("id")
      .eq("business_id", site.id)
      .eq("type", X_CLOSE_TRIAL)
      .in("status", ["pending", "running"])
      .limit(1);
    if ((active ?? []).length > 0) {
      out.skippedSites.push({ businessId, reason: "a trial run is already queued or running" });
      continue;
    }
    await enqueueJob({ supabase: admin, userId: site.user_id, businessId: site.id, type: X_CLOSE_TRIAL, input: { businessId: site.id }, maxAttempts: 2 });
    out.enqueued.push(site.id);
  }
  return out;
}
