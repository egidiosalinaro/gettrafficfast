import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { enqueueJob, hasActiveJob } from "@/lib/jobs/queue";
import { tick } from "@/lib/jobs/worker";
import { PRODUCE_ARTICLE } from "@/lib/jobs/workflows/produce-article";
import { publishReadyArticles } from "@/lib/articles/publish-ready";
import { skipWhileLlmPaused } from "@/lib/llm-billing";
import { isCronAuthorized } from "@/lib/cron-auth";
import { hasPaidAccess } from "@/lib/paid-access";
import { SPEND_CAP_CODE, checkAccountSpend } from "@/lib/limits/spend";
import { isSpendSkip, type OwnerSkipReason } from "@/lib/limits/owners";

/**
 * The daily run, in two independent phases:
 *
 *   1. Generation — enqueues a `produce-article` job per due article, then
 *      drains what fits in this invocation. Production itself (outline →
 *      writing → validation → audit) belongs to the workflow, which is durable
 *      and resumable; anything not finished here is picked up by the worker
 *      tick. Article state, retries and owner notifications are the workflow's
 *      responsibility, so they behave identically however a run was triggered.
 *
 *      While the LLM layer is paused for billing (`lib/llm-billing.ts`) this
 *      phase is skipped: due articles stay `queued`, no job is enqueued and
 *      no attempt is spent. Publishing still runs.
 *
 *      Only articles whose owner has paid access are produced (`hasPaidAccess`,
 *      the paywall's rule read through the service role). A lapsed account's
 *      due articles stay `queued`, untouched, and are logged as skipped; they
 *      are produced if the subscription comes back. The same for an owner at
 *      the account's daily AI spend limit (lib/limits/spend.ts), or whose
 *      spend cannot be read: their due articles wait for a run under it.
 *
 *   2. Publishing — `generated` → `published`. Re-scans every due article,
 *      including ones whose previous delivery failed. `needs_review` is
 *      deliberately excluded: it never publishes on its own. The rules are
 *      `publishReadyArticles` (lib/articles/publish-ready.ts); the worker tick
 *      calls it too, so an article whose job finishes after this phase is
 *      published within minutes rather than at tomorrow's run.
 */

const MAX_ARTICLES_PER_RUN = 5;
const MAX_PUBLISHES_PER_RUN = 10;
const MAX_ATTEMPTS = 3;
const WORK_TIME_BUDGET_MS = 200_000;

/** Due articles read per page while looking for ones whose owner has paid. */
const DUE_PAGE_SIZE = 25;
/**
 * Pages read per run. After the first, a page leaves out every owner already
 * found without a subscription, so a lapsed account's backlog costs one page
 * however many due articles it holds, and its oldest-first rows cannot keep
 * paying accounts out of the run. The cap bounds the reads, and the length of
 * that exclusion list, when many accounts lapse at once.
 */
const MAX_DUE_PAGES = 4;

export const maxDuration = 300;

export async function GET(request: NextRequest) {
  return run(request);
}

export async function POST(request: NextRequest) {
  return run(request);
}

function log(level: "info" | "warn" | "error", jobId: string, fields: Record<string, unknown>) {
  const payload = JSON.stringify({
    level,
    job: "generate-articles",
    job_id: jobId,
    ts: new Date().toISOString(),
    ...fields,
  });
  if (level === "error") console.error(payload);
  else if (level === "warn") console.warn(payload);
  else console.log(payload);
}

type AdminClient = ReturnType<typeof createAdminClient>;

type DueArticle = {
  id: string;
  user_id: string;
  business_id: string | null;
  attempt_count: number;
  scheduled_date: string;
};

type UnpaidReason = OwnerSkipReason;

interface UnpaidSkip {
  user_id: string;
  business_id: string | null;
  reason: UnpaidReason;
  /** Due articles of this business seen in this run's pages, not a total. */
  due_articles_seen: number;
}

/**
 * The due articles to produce this run: oldest first, at most
 * MAX_ARTICLES_PER_RUN, only from owners with paid access and under their
 * daily AI spend limit. Owners are checked once per run. A subscription or a
 * spend that cannot be read counts as not allowed (fail closed: the article
 * waits a day rather than being paid for unverified), with its own reason in
 * the log.
 */
async function pickPaidDueArticles(
  supabase: AdminClient,
  today: string
): Promise<{ picked: DueArticle[]; skipped: UnpaidSkip[]; error: string | null }> {
  const verdicts = new Map<string, true | UnpaidReason>();
  const lapsed: string[] = [];
  const picked: DueArticle[] = [];
  const seen = new Set<string>();
  const skipped = new Map<string, UnpaidSkip>();

  for (let page = 0; page < MAX_DUE_PAGES && picked.length < MAX_ARTICLES_PER_RUN; page++) {
    let query = supabase
      .from("articles")
      .select("id, user_id, business_id, attempt_count, scheduled_date")
      .eq("status", "queued")
      .lte("scheduled_date", today)
      .lt("attempt_count", MAX_ATTEMPTS);
    if (lapsed.length > 0) query = query.not("user_id", "in", `(${lapsed.join(",")})`);
    if (picked.length > 0) query = query.not("id", "in", `(${picked.map((row) => row.id).join(",")})`);

    const { data, error } = await query
      .order("scheduled_date", { ascending: true })
      .limit(DUE_PAGE_SIZE);
    if (error) return { picked, skipped: [...skipped.values()], error: error.message };

    const rows = (data ?? []) as DueArticle[];
    let leftOut = false;
    for (const row of rows) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);

      let verdict = verdicts.get(row.user_id);
      if (verdict === undefined) {
        try {
          verdict = (await hasPaidAccess(supabase, row.user_id)) ? true : "no_active_subscription";
        } catch {
          verdict = "subscription_unreadable";
        }
        if (verdict === true) {
          const spend = await checkAccountSpend(supabase, row.user_id);
          if (!spend.ok) verdict = spend.code === SPEND_CAP_CODE ? SPEND_CAP_CODE : "spend_unreadable";
        }
        verdicts.set(row.user_id, verdict);
        if (verdict !== true) lapsed.push(row.user_id);
      }

      if (verdict === true) {
        if (picked.length < MAX_ARTICLES_PER_RUN) picked.push(row);
        continue;
      }

      leftOut = true;
      const key = `${row.user_id}:${row.business_id ?? ""}`;
      const entry = skipped.get(key) ?? {
        user_id: row.user_id,
        business_id: row.business_id ?? null,
        reason: verdict,
        due_articles_seen: 0,
      };
      entry.due_articles_seen += 1;
      skipped.set(key, entry);
    }

    // Nobody left out on this page: it was the queue in order, so the picks
    // are complete. A short page: the queue is exhausted.
    if (!leftOut || rows.length < DUE_PAGE_SIZE) break;
  }

  return { picked, skipped: [...skipped.values()], error: null };
}

async function run(request: NextRequest) {
  if (!isCronAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const runId = crypto.randomUUID();
  const startedAt = Date.now();
  const supabase = createAdminClient();
  const today = new Date().toISOString().slice(0, 10);
  const emailCache = new Map<string, string | null>();

  // ── Phase 1 — enqueue production ────────────────────────────────────────
  // The model accounts cannot pay: enqueueing would only park jobs behind
  // the pause, so the due articles simply stay queued until it lifts.
  const llmPausedUntil = await skipWhileLlmPaused(supabase, "generate-articles");

  let enqueued = 0;
  let worked: Awaited<ReturnType<typeof tick>> | { skipped: string; paused_until: string } = {
    skipped: "llm_billing_paused",
    paused_until: llmPausedUntil?.toISOString() ?? "",
  };
  // Present only when the owners were actually checked (not while paused).
  let unpaid: { businesses: number; articles_seen: number } | undefined;
  let spendCapped: { businesses: number; articles_seen: number } | undefined;

  if (!llmPausedUntil) {
    const { picked: queued, skipped, error: fetchError } = await pickPaidDueArticles(supabase, today);

    if (fetchError) {
      log("error", runId, { phase: "fetch", error: fetchError });
      return NextResponse.json({ error: "Failed to fetch queued articles" }, { status: 500 });
    }

    // What was left out, one line per business, so a lapsed account's
    // waiting calendar is visible in the logs rather than silently stalled.
    for (const skip of skipped) {
      log(skip.reason === "subscription_unreadable" || skip.reason === "spend_unreadable" ? "warn" : "info", runId, {
        phase: "generation",
        skipped: skip.reason,
        user_id: skip.user_id,
        business_id: skip.business_id,
        due_articles_seen: skip.due_articles_seen,
      });
    }
    const unpaidSkips = skipped.filter((skip) => !isSpendSkip(skip.reason));
    const spendSkips = skipped.filter((skip) => isSpendSkip(skip.reason));
    unpaid = {
      businesses: unpaidSkips.length,
      articles_seen: unpaidSkips.reduce((sum, skip) => sum + skip.due_articles_seen, 0),
    };
    spendCapped = {
      businesses: spendSkips.length,
      articles_seen: spendSkips.reduce((sum, skip) => sum + skip.due_articles_seen, 0),
    };

    for (const row of queued) {
      // A manual "generate now" may already be running for this article.
      if (await hasActiveJob(supabase, row.id, PRODUCE_ARTICLE)) continue;
      await enqueueJob({
        supabase,
        userId: row.user_id,
        businessId: row.business_id ?? null,
        type: PRODUCE_ARTICLE,
        input: { articleId: row.id },
        articleId: row.id,
        maxAttempts: MAX_ATTEMPTS,
      });
      enqueued++;
    }

    worked = await tick(supabase, {
      workerId: `cron-${runId.slice(0, 8)}`,
      maxJobs: MAX_ARTICLES_PER_RUN,
      timeBudgetMs: Math.min(WORK_TIME_BUDGET_MS, WORK_TIME_BUDGET_MS - (Date.now() - startedAt)),
    });
  }

  log("info", runId, {
    phase: "generation",
    enqueued,
    ...(unpaid ? { skipped_unpaid: unpaid } : {}),
    ...(spendCapped ? { skipped_spend_cap: spendCapped } : {}),
    ...worked,
  });

  // ── Phase 2 — publishing ────────────────────────────────────────────────
  // The rules live in lib/articles/publish-ready.ts, shared with the worker
  // tick, which publishes what finishes producing after this phase.
  const { counts: publishing, error: readyError } = await publishReadyArticles(supabase, {
    runId,
    today,
    limit: MAX_PUBLISHES_PER_RUN,
    log: (level, fields) => log(level, runId, fields),
    emailCache,
  });

  if (readyError) {
    log("error", runId, { phase: "publish_fetch", error: readyError });
  }

  log("info", runId, {
    phase: "done",
    enqueued,
    ...publishing,
    duration_ms: Date.now() - startedAt,
  });

  return NextResponse.json({
    run_id: runId,
    generation: {
      enqueued,
      ...(unpaid ? { skipped_unpaid: unpaid } : {}),
      ...(spendCapped ? { skipped_spend_cap: spendCapped } : {}),
      ...worked,
    },
    publishing,
  });
}
