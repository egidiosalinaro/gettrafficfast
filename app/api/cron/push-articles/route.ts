import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { createAdminClient } from "@/lib/supabase/admin";
import { parseAutomationSettings } from "@/lib/automation/settings";
import { isCronAuthorized } from "@/lib/cron-auth";
import { skipWhileLlmPaused } from "@/lib/llm-billing";
import { logOwnerSkip, skipSummary, spendingOwners, type OwnerSkipReason } from "@/lib/limits/owners";
import { sweepSitePushes } from "@/lib/lifecycle/push-store";

/**
 * Push page 3, the weekly sweep (docs/LIFECYCLE.md, "Push page 3").
 *
 * For every site whose owner switched it on (Settings → Autopilot, "Push
 * articles stuck on pages 2 to 4", `automation_settings.pushPage3`, off by
 * default) and pays, under the account's spend ceiling: up to 3 published
 * articles at an average position of 11 to 40 over 28 days, with at least
 * 50 impressions, are recorded and a `push-article` job is queued for each.
 * Choosing costs nothing (stored Search Console rows); each job makes one
 * fast-tier model call. While the model accounts cannot pay, nothing is
 * queued and the sites are counted as deferred.
 */

export const maxDuration = 300;

/** Sites read per run. */
const MAX_SITES = 200;

async function run(request: NextRequest) {
  if (!isCronAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const supabase = createAdminClient();
  const pausedUntil = await skipWhileLlmPaused(supabase, "push-articles");

  const { data: businesses, error } = await supabase
    .from("businesses")
    .select("id, user_id, automation_settings")
    .eq("automation_settings->>pushPage3", "true")
    .limit(MAX_SITES);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const sites = (businesses ?? []).filter((b) => parseAutomationSettings(b.automation_settings).pushPage3);
  if (pausedUntil) {
    return NextResponse.json({ sites: sites.length, deferred: sites.length, llmPausedUntil: pausedUntil.toISOString() });
  }

  const owners = spendingOwners(supabase);
  const unpaid = new Map<string, { reason: OwnerSkipReason; articles: number }>();
  let selected = 0;
  let skipped = 0;
  let withoutSearchConsole = 0;
  const notes: string[] = [];

  for (const site of sites) {
    const userId = site.user_id as string;
    const verdict = await owners.verdict(userId);
    if (verdict !== true) {
      const entry = unpaid.get(userId) ?? { reason: verdict, articles: 0 };
      entry.articles += 1;
      unpaid.set(userId, entry);
      continue;
    }
    try {
      const result = await sweepSitePushes({ admin: supabase, businessId: site.id as string, userId });
      if (result.status === "no_search_console") {
        withoutSearchConsole += 1;
        continue;
      }
      selected += result.selected;
      skipped += result.skipped;
    } catch (err) {
      notes.push(`${site.id}: ${err instanceof Error ? err.message : String(err)}`);
      Sentry.captureException(err, { tags: { stage: "push_sweep" }, extra: { business_id: site.id } });
    }
  }
  for (const [userId, entry] of unpaid) {
    logOwnerSkip("push-articles", { user_id: userId, reason: entry.reason, articles_seen: entry.articles });
  }

  return NextResponse.json({
    sites: sites.length,
    skippedUnpaid: skipSummary(unpaid, "unpaid"),
    skippedSpendCap: skipSummary(unpaid, "spend"),
    withoutSearchConsole,
    selected,
    skippedNoQuery: skipped,
    notes: notes.slice(0, 10),
  });
}

export async function GET(request: NextRequest) {
  return run(request);
}

export async function POST(request: NextRequest) {
  return run(request);
}
