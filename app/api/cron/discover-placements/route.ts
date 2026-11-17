import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { createAdminClient } from "@/lib/supabase/admin";
import { getDiscoveryProviders } from "@/lib/providers/discovery/registry";
import { startDiscovery } from "@/lib/placements/runs";
import { isCronAuthorized } from "@/lib/cron-auth";
import { skipWhileLlmPaused } from "@/lib/llm-billing";
import { isSpendSkip, logOwnerSkip, spendingOwners } from "@/lib/limits/owners";

/**
 * Off-site discovery: the scheduler, Monday, Wednesday and Friday at 10:00
 * UTC (lib/placements/schedule.ts; weekly until 2026-11-12).
 *
 * It enqueues one `placement-discovery` job per business and does nothing
 * else — searching, the deterministic rules and the agent's judgement all run
 * in the job worker, checkpointed per surface, so a slow provider or a rate
 * limit costs the run a resume rather than the week. Nothing is posted
 * anywhere: the output is rows a person reads in the Placements inbox.
 *
 * Discovery is paid (searches, then a model judging them), so only
 * businesses whose owner pays (`hasPaidAccess`) get a run; the others are
 * logged and do not take one of the run's slots.
 */

export const maxDuration = 60;

/** Businesses enqueued (or found already running) per run. A sweep, not a backlog race. */
const MAX_BUSINESSES = 25;

/** Businesses read per run, so the owners who do not pay cannot fill the slots. */
const CANDIDATE_BUSINESSES = 200;

async function run(request: NextRequest) {
  if (!isCronAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const providers = getDiscoveryProviders();
  if (providers.length === 0) {
    return NextResponse.json({
      enqueued: 0,
      surfaces: "disabled (no discovery provider configured)",
    });
  }

  const supabase = createAdminClient();

  // Discovery pays for searches (Serper) whose only use is the model judging
  // what they found. With the model accounts unable to pay, the searches
  // would be bought for nothing: no job is enqueued until the pause lifts.
  const pausedUntil = await skipWhileLlmPaused(supabase, "discover-placements");
  if (pausedUntil) {
    return NextResponse.json({
      enqueued: 0,
      skipped: "llm_billing_paused",
      pausedUntil: pausedUntil.toISOString(),
    });
  }

  const { data: businesses, error } = await supabase
    .from("businesses")
    .select("id, user_id")
    .limit(CANDIDATE_BUSINESSES);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  let enqueued = 0;
  let skipped = 0;
  let skippedUnpaid = 0;
  let skippedSpendCap = 0;
  const notes: string[] = [];
  const owners = spendingOwners(supabase);

  for (const business of businesses ?? []) {
    if (enqueued + skipped >= MAX_BUSINESSES) break;
    const verdict = await owners.verdict(business.user_id as string);
    if (verdict !== true) {
      if (isSpendSkip(verdict)) skippedSpendCap += 1;
      else skippedUnpaid += 1;
      logOwnerSkip("discover-placements", {
        user_id: business.user_id as string,
        business_id: business.id as string,
        reason: verdict,
      });
      continue;
    }
    try {
      const started = await startDiscovery({
        supabase,
        userId: business.user_id as string,
        businessId: business.id as string,
      });
      if (started.alreadyRunning) skipped += 1;
      else enqueued += 1;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      notes.push(`${business.id}: ${message}`);
      Sentry.captureException(err, {
        tags: { stage: "placement_discovery_schedule" },
        extra: { business_id: business.id },
      });
    }
  }

  return NextResponse.json({
    businesses: businesses?.length ?? 0,
    surfaces: providers.map((p) => p.name),
    enqueued,
    skipped,
    skippedUnpaid,
    skippedSpendCap,
    notes: notes.slice(0, 10),
  });
}

export async function GET(request: NextRequest) {
  return run(request);
}

export async function POST(request: NextRequest) {
  return run(request);
}
