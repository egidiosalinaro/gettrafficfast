import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  onboardingNudgeEmail,
  sendNotificationEmail,
  welcomeEmail,
} from "@/lib/notifications/email";
import { isCronAuthorized } from "@/lib/cron-auth";

// Daily lifecycle emails, at most one of each type per user (notification_log):
//   - welcome: sent on the first run after signup (users created < 48h ago).
//   - onboarding_nudge: sent once, 3+ days after signup, to users who still
//     have no business configured. Capped at 30 days so shipping this feature
//     does not blast long-dormant accounts.

const WELCOME_WINDOW_HOURS = 48;
const NUDGE_AFTER_DAYS = 3;
const NUDGE_MAX_AGE_DAYS = 30;
const MAX_SENDS_PER_RUN = 50;

export async function GET(request: NextRequest) {
  return run(request);
}

export async function POST(request: NextRequest) {
  return run(request);
}

async function run(request: NextRequest) {
  if (!isCronAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const jobId = crypto.randomUUID();
  const supabase = createAdminClient();
  const now = Date.now();

  try {
    const { data: usersPage, error: usersError } =
      await supabase.auth.admin.listUsers({ page: 1, perPage: 500 });
    if (usersError) throw usersError;

    const candidates = usersPage.users.filter((u) => {
      if (!u.email) return false;
      const ageMs = now - new Date(u.created_at).getTime();
      return ageMs <= NUDGE_MAX_AGE_DAYS * 24 * 3600 * 1000;
    });

    const candidateIds = candidates.map((u) => u.id);

    const [{ data: logRows }, { data: businessRows }] = await Promise.all([
      supabase
        .from("notification_log")
        .select("user_id, type")
        .in("user_id", candidateIds.length ? candidateIds : ["-"]),
      supabase
        .from("businesses")
        .select("user_id")
        .in("user_id", candidateIds.length ? candidateIds : ["-"]),
    ]);

    const alreadySent = new Set(
      (logRows ?? []).map((r) => `${r.user_id}:${r.type}`)
    );
    const hasBusiness = new Set((businessRows ?? []).map((r) => r.user_id));

    let welcomed = 0;
    let nudged = 0;

    for (const user of candidates) {
      if (welcomed + nudged >= MAX_SENDS_PER_RUN) break;
      const ageHours = (now - new Date(user.created_at).getTime()) / 3600000;
      const email = user.email as string;

      if (
        ageHours <= WELCOME_WINDOW_HOURS &&
        !alreadySent.has(`${user.id}:welcome`)
      ) {
        const ok = await sendNotificationEmail({ to: email, ...welcomeEmail() });
        if (ok) {
          await supabase
            .from("notification_log")
            .upsert(
              { user_id: user.id, type: "welcome" },
              { onConflict: "user_id,type", ignoreDuplicates: true }
            );
          welcomed++;
        }
        continue; // never welcome + nudge in the same run
      }

      if (
        ageHours >= NUDGE_AFTER_DAYS * 24 &&
        !hasBusiness.has(user.id) &&
        !alreadySent.has(`${user.id}:onboarding_nudge`)
      ) {
        const ok = await sendNotificationEmail({
          to: email,
          ...onboardingNudgeEmail(),
        });
        if (ok) {
          await supabase
            .from("notification_log")
            .upsert(
              { user_id: user.id, type: "onboarding_nudge" },
              { onConflict: "user_id,type", ignoreDuplicates: true }
            );
          nudged++;
        }
      }
    }

    console.log(
      JSON.stringify({
        level: "info",
        job: "onboarding-emails",
        job_id: jobId,
        candidates: candidates.length,
        welcomed,
        nudged,
      })
    );
    return NextResponse.json({ job_id: jobId, welcomed, nudged });
  } catch (err) {
    Sentry.captureException(err, { tags: { job: "onboarding-emails" } });
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      JSON.stringify({ level: "error", job: "onboarding-emails", job_id: jobId, error: message })
    );
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
