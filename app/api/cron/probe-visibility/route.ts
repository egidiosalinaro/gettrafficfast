import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCitationProviders } from "@/lib/providers/citations/registry";
import { isRunDue, parseAeoSettings } from "@/lib/visibility/settings";
import { hasActiveRun, startRun } from "@/lib/visibility/store";
import { importPromptsFromKeywords } from "@/lib/visibility/manage";
import { isCronAuthorized } from "@/lib/cron-auth";
import { isSpendSkip, logOwnerSkip, spendingOwners } from "@/lib/limits/owners";

/**
 * The AI Visibility scheduler.
 *
 * Runs daily and starts a run for every business whose cadence says one is
 * due. It starts runs, it does not execute them: the probes are paid calls
 * done by the job worker, a few at a time, resumable. The cadence is weekly
 * by default since 2026-11-24; a business that chose `off` is never touched
 * (it can still run by hand). Nothing runs without an engine the deployment
 * configured.
 *
 * Bounded: the businesses are read oldest first (at most 500), and at most
 * MAX_STARTS runs are started a day, each asking at most the site's
 * `maxQueriesPerRun` prompts (30 by default) of each engine. A site past the
 * day's starts is due again tomorrow.
 *
 * A due site that has never had a prompt or a run gets its prompt set from
 * its own keywords first (`importPromptsFromKeywords`: free, no model, the
 * oldest 50, the same as the screen's Import), so the weekly run has
 * something to ask without anyone setting it up. A site that emptied its set
 * after a run is left empty.
 *
 * A due business whose owner does not pay (`hasPaidAccess`) is skipped and
 * logged: its schedule waits for the subscription to come back.
 */

export const maxDuration = 60;

/** Businesses read per day, oldest first. */
const MAX_BUSINESSES = 500;
/** Runs started per day at most. A scheduler, not a backlog race. */
const MAX_STARTS = 50;

async function run(request: NextRequest) {
  if (!isCronAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (getCitationProviders().length === 0) {
    return NextResponse.json({ started: 0, engines: "disabled (no citation provider configured)" });
  }

  const supabase = createAdminClient();
  const { data: businesses, error } = await supabase
    .from("businesses")
    .select("id, user_id, aeo_settings")
    .order("created_at", { ascending: true })
    .limit(MAX_BUSINESSES);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const now = new Date();
  let started = 0;
  let due = 0;
  let skippedUnpaid = 0;
  let skippedSpendCap = 0;
  const notes: string[] = [];
  const owners = spendingOwners(supabase, now);

  let seeded = 0;
  for (const business of businesses ?? []) {
    if (started >= MAX_STARTS) {
      notes.push(`stopped at ${MAX_STARTS} runs started; the rest are due tomorrow`);
      break;
    }
    const settings = parseAeoSettings(business.aeo_settings);
    if (settings.cadence === "off") continue;
    const businessId = business.id as string;

    try {
      const { data: last } = await supabase
        .from("aeo_runs")
        .select("started_at")
        .eq("business_id", businessId)
        .order("started_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (!isRunDue(settings.cadence, (last?.started_at as string | null) ?? null, now)) continue;
      due += 1;

      const verdict = await owners.verdict(business.user_id as string);
      if (verdict !== true) {
        if (isSpendSkip(verdict)) skippedSpendCap += 1;
        else skippedUnpaid += 1;
        logOwnerSkip("probe-visibility", { user_id: business.user_id as string, business_id: businessId, reason: verdict });
        continue;
      }

      if (await hasActiveRun(supabase, businessId)) continue;

      // Nothing to ask means nothing to bill: a due schedule over an empty
      // set is skipped, not failed.
      let { count } = await supabase
        .from("aeo_queries")
        .select("id", { count: "exact", head: true })
        .eq("business_id", businessId)
        .eq("enabled", true);
      if ((count ?? 0) === 0 && !last) {
        const { count: stored } = await supabase
          .from("aeo_queries")
          .select("id", { count: "exact", head: true })
          .eq("business_id", businessId);
        if ((stored ?? 0) === 0) {
          const imported = await importPromptsFromKeywords({ supabase, userId: business.user_id as string, businessId });
          if (imported.ok && imported.added > 0) {
            seeded += 1;
            count = imported.added;
          }
        }
      }
      if ((count ?? 0) === 0) continue;

      await startRun({
        supabase,
        userId: business.user_id as string,
        businessId,
        trigger: "schedule",
      });
      started += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      notes.push(`${businessId}: ${message}`);
      Sentry.captureException(err, {
        tags: { stage: "visibility_schedule" },
        extra: { business_id: businessId },
      });
    }
  }

  return NextResponse.json({
    businesses: businesses?.length ?? 0,
    due,
    skippedUnpaid,
    skippedSpendCap,
    started,
    seeded,
    notes: notes.slice(0, 10),
  });
}

export async function GET(request: NextRequest) {
  return run(request);
}

export async function POST(request: NextRequest) {
  return run(request);
}
