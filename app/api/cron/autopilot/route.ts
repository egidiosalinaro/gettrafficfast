import { NextRequest, NextResponse } from "next/server";
import * as Sentry from "@sentry/nextjs";
import { createAdminClient } from "@/lib/supabase/admin";
import { parseAutomationSettings } from "@/lib/automation/settings";
import {
  freshSuggestions,
  keywordScore,
  keywordsToGenerate,
  planSchedule,
  withoutOverlapping,
} from "@/lib/automation/autopilot";
import { addAskedQuestions } from "@/lib/automation/questions";
import { chooseForPool, intentOf, parseTopicIntent, type TopicIntent } from "@/lib/keywords/intent";
import { loadNamedTools, settleSuggestions } from "@/lib/keywords/named-tools";
import { loadSiteTopics } from "@/lib/keywords/overlap";
import { AUTOPILOT_SOURCE } from "@/lib/keywords/source";
import { generateKeywordsFromBusiness } from "@/lib/research/keywords";
import { isCronAuthorized } from "@/lib/cron-auth";
import { recordLlmBillingRefusal, skipWhileLlmPaused } from "@/lib/llm-billing";
import { isSpendSkip, logOwnerSkip, spendingOwners } from "@/lib/limits/owners";
import { autopilotReason, countEmptyDays, type AutopilotRunRecord } from "@/lib/automation/run-status";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Autopilot.
 *
 * Runs before the generation cron, and does the two things a customer would
 * otherwise have to remember: keep the calendar filled, and keep the keyword
 * pool from running dry. Without it, a customer with six keywords gets six
 * days of articles and then silence, and the empty days can never be
 * recovered afterwards.
 *
 * Order matters. Scheduling first means a pool that is still healthy gets used
 * before anything new is generated; generating first would buy keywords the
 * calendar did not need.
 *
 * While the LLM layer is paused for billing (`lib/llm-billing.ts`) only the
 * model work is skipped: keyword generation. Scheduling costs nothing and
 * a day left empty can never be recovered, so the calendar keeps filling
 * from the existing pool; those articles wait as `queued` like every other.
 *
 * Autopilot acts only for owners who pay (`hasPaidAccess`, the paywall's
 * rule read through the service role). Buying keywords is a model call, and
 * every article it schedules is one the generation cron pays to write; a
 * lapsed owner's business is skipped whole, and logged, until the
 * subscription comes back.
 *
 * An owner at the account's daily AI spend limit (lib/limits/spend.ts) is
 * treated like the billing pause: scheduling from the pool goes on (free,
 * and an empty day cannot be recovered; the generation cron checks the
 * limit again before it writes), keyword generation waits for a run under
 * the limit.
 *
 * Autopilot never schedules a keyword whose near-duplicate is already
 * scheduled, being written or published, and never buys one that overlaps a
 * topic the site has (lib/keywords/duplicates.ts): two articles on one topic
 * compete with each other. What it left out is in `notes`.
 *
 * Every site with Autopilot on is swept, oldest first, every one of an
 * owner's sites alike (2026-11-24). At the end of each site's run the sweep
 * stores what it did and, when it did less than the calendar needed, why
 * (`businesses.autopilot_run`, lib/automation/run-status.ts): a pool whose
 * topics all overlap what the site published, a top-up that found nothing
 * new, no plan, today's AI limit, an error. The Content screen, get_content
 * and Settings -> Autopilot say it; before, it reached only this response,
 * and a site could read "Autopilot on" for weeks while nothing happened.
 * The top-up's one suggestion call lists the topics the site already
 * covers, so a site with a long history is not offered them again.
 *
 * Before scheduling, up to 3 "Questions people ask" a day go into the pool
 * on their own (lib/automation/questions.ts): free, read from threads
 * discovery already stored, and checked against the site's topics like
 * every add. They are fuel like any other keyword, so a pool topped up this
 * way buys fewer keywords. Keywords Autopilot buys are stored with
 * `source` "autopilot", for the Content screen to say so.
 *
 * Every topic carries the kind of search it answers (lib/keywords/intent.ts)
 * and each week of the calendar aims for a mix: one or two comparisons, two
 * platform how-tos, two or three problem pieces, the rest core topics, when
 * the pool has them (`planSchedule`). The top-up asks for that mix from the
 * site's own data: the products and platforms its articles, its results
 * pages and AI answers name (lib/keywords/named-tools.ts, three reads), and
 * a comparison naming any other product is not bought. A topic stored
 * before intents were gets the rules' verdict on its first run here.
 */

export const maxDuration = 300;

/** Sites with Autopilot on swept per run. The sweep is daily, not a backlog race. */
const MAX_BUSINESSES = 50;
/** Rows read to find them: every site, Autopilot on or off, oldest first. */
const BUSINESSES_READ = 1000;

/** Stores a site's run record. A failed write is logged, never fatal: the run itself happened. */
async function recordRun(supabase: SupabaseClient, businessId: string, record: AutopilotRunRecord, notes: string[]) {
  const { error } = await supabase.from("businesses").update({ autopilot_run: record }).eq("id", businessId);
  if (error) {
    console.error("Autopilot run record not stored:", error.message);
    notes.push(`${businessId}: run record not stored (${error.message})`);
  }
}

async function run(request: NextRequest) {
  if (!isCronAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const supabase = createAdminClient();
  const today = new Date();

  // Every site, oldest first, and only then the ones with Autopilot on: a
  // bare limit over an unordered read could leave a site out of every run
  // without a word, and the cap counts sites the sweep works on, not rows.
  const { data: rows, error } = await supabase
    .from("businesses")
    .select("id, user_id, name, niche, description, website_url, content_language, automation_settings, created_at")
    .order("created_at", { ascending: true })
    .limit(BUSINESSES_READ);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  const enabledSites = (rows ?? []).filter((row) => parseAutomationSettings(row.automation_settings).enabled);
  const businesses = enabledSites.slice(0, MAX_BUSINESSES);

  let scheduled = 0;
  let generated = 0;
  let active = 0;
  let skippedUnpaid = 0;
  let deferredSpendCap = 0;
  let questionsAdded = 0;
  let stalled = 0;
  const notes: string[] = [];
  if (enabledSites.length > MAX_BUSINESSES) {
    notes.push(`${enabledSites.length - MAX_BUSINESSES} site(s) with Autopilot on left for a later run (cap ${MAX_BUSINESSES})`);
  }
  let llmPausedUntil = await skipWhileLlmPaused(supabase, "autopilot");
  const owners = spendingOwners(supabase, today);

  for (const business of businesses) {
    const settings = parseAutomationSettings(business.automation_settings);
    active += 1;

    const userId = business.user_id as string;
    const businessId = business.id as string;
    // What this run did for this site, and why it did less when it did.
    const record: AutopilotRunRecord = {
      at: today.toISOString(),
      scheduled: 0,
      topicsAdded: 0,
      questionsAdded: 0,
      emptyDays: null,
      bufferDays: settings.bufferDays,
      reasons: [],
    };

    const verdict = await owners.verdict(userId);
    if (verdict !== true && !isSpendSkip(verdict)) {
      skippedUnpaid += 1;
      logOwnerSkip("autopilot", { user_id: userId, business_id: businessId, reason: verdict });
      record.reasons.push(autopilotReason.noPlan());
      stalled += 1;
      await recordRun(supabase, businessId, record, notes);
      continue;
    }

    // What the site's data names: a how-to about one is a platform how-to,
    // and the only products a bought comparison may name. Reads only; an
    // unreadable source is an empty one.
    const names = (
      await loadNamedTools(supabase, businessId, {
        businessName: (business.name as string | null) ?? null,
        websiteUrl: (business.website_url as string | null) ?? null,
      })
    ).map((tool) => tool.name);

    // ── Questions people ask: free fuel, at most 3 a day ────────────────────
    // Its own try: a failure here leaves the rest of the run untouched.
    try {
      const asked = await addAskedQuestions({ supabase, userId, businessId, now: today, names });
      questionsAdded += asked.added.length;
      record.questionsAdded = asked.added.length;
    } catch (err) {
      notes.push(`${business.id}: questions not added (${err instanceof Error ? err.message : String(err)})`);
    }

    try {
      // ── Keep the calendar filled ─────────────────────────────────────────
      const { data: upcoming } = await supabase
        .from("articles")
        .select("scheduled_date, keywords!articles_keyword_id_fkey ( keyword, intent )")
        .eq("business_id", businessId)
        .gte("scheduled_date", today.toISOString().slice(0, 10));

      const { data: freeKeywords } = await supabase
        .from("keywords")
        .select("id, keyword, intent, opportunity, difficulty, search_volume")
        .eq("business_id", businessId)
        .is("article_id", null)
        .eq("status", "available");

      const pool = (freeKeywords ?? []).map((row) => ({
        id: row.id as string,
        score: keywordScore({
          opportunity: row.opportunity as string | null,
          difficulty: row.difficulty as number | null,
          searchVolume: row.search_volume as number | null,
        }),
        intent: intentOf(row.intent, String(row.keyword ?? ""), { names }),
      }));

      // A topic stored before intents were: the rules' verdict is written
      // once, so the Content screen reads what this run schedules by. Free,
      // one update per intent, and a failure only means it is decided again.
      const unclassified = new Map<TopicIntent, string[]>();
      for (const row of freeKeywords ?? []) {
        if (parseTopicIntent(row.intent)) continue;
        const intent = intentOf(null, String(row.keyword ?? ""), { names });
        unclassified.set(intent, [...(unclassified.get(intent) ?? []), row.id as string]);
      }
      for (const [intent, ids] of unclassified) {
        const { error: intentError } = await supabase
          .from("keywords")
          .update({ intent })
          .eq("business_id", businessId)
          .is("intent", null)
          .in("id", ids);
        if (intentError) notes.push(`${business.id}: intents not stored (${intentError.message})`);
      }

      // The site's topics, read once: a keyword that overlaps one already
      // scheduled, being written or published is not schedulable, and is
      // not counted as fuel either. An unreadable graph stops this site's
      // run rather than scheduling blind.
      const topics = await loadSiteTopics(supabase, businessId, { serp: true });
      if (!topics.ok) throw new Error("could not read the site's topics");
      const { schedulable: available, refused: overlapping } = withoutOverlapping(topics, pool);
      if (overlapping.length > 0) {
        notes.push(`${business.id}: ${overlapping.length} keyword(s) not scheduled, overlapping a topic already covered (e.g. ${overlapping[0].reason})`);
      }

      const occupied = new Set((upcoming ?? []).map((a) => a.scheduled_date as string));
      // What each booked day is about, for the week's mix.
      const occupiedIntents = new Map<string, TopicIntent | null>();
      for (const row of upcoming ?? []) {
        const joined = (row as { keywords?: unknown }).keywords as
          | { keyword?: unknown; intent?: unknown }
          | Array<{ keyword?: unknown; intent?: unknown }>
          | null
          | undefined;
        const kw = Array.isArray(joined) ? joined[0] : joined;
        if (!kw) continue;
        occupiedIntents.set(row.scheduled_date as string, intentOf(kw.intent, String(kw.keyword ?? ""), { names }));
      }
      const intentById = new Map<string, TopicIntent>(pool.map((k) => [k.id, k.intent]));
      const scheduledIds = new Set<string>();
      let scheduledHere = 0;
      let boughtHere = 0;

      const applyPlan = async (plan: ReturnType<typeof planSchedule>) => {
        for (const item of plan) {
          const { data: article, error: insertError } = await supabase
            .from("articles")
            .insert({
              user_id: userId,
              business_id: businessId,
              keyword_id: item.keywordId,
              scheduled_date: item.scheduledDate,
              status: "queued",
            })
            .select("id")
            .single();

          // A clash means someone scheduled that day between our read and our
          // write. Skipping is correct: the day is covered either way.
          if (insertError || !article) continue;

          await supabase
            .from("keywords")
            .update({ status: "queued", article_id: article.id })
            .eq("id", item.keywordId)
            .eq("business_id", businessId);
          occupied.add(item.scheduledDate);
          occupiedIntents.set(item.scheduledDate, intentById.get(item.keywordId) ?? null);
          scheduledIds.add(item.keywordId);
          scheduledHere += 1;
          record.scheduled = scheduledHere;
        }
      };

      await applyPlan(
        planSchedule({
          today,
          bufferDays: settings.bufferDays,
          occupiedDates: occupied,
          occupiedIntents,
          available,
          maxPerRun: settings.maxSchedulesPerRun,
        })
      );

      // ── Keep the pool from running dry ───────────────────────────────────
      const remaining = available.length - scheduledHere;
      const wanted = keywordsToGenerate({
        availableCount: remaining,
        floor: settings.keywordFloor,
        maxPerRun: settings.maxKeywordsPerRun,
      });

      if (wanted > 0 && llmPausedUntil) {
        notes.push(`${business.id}: keyword generation deferred (LLM billing pause)`);
        record.reasons.push(autopilotReason.aiPaused());
      } else if (wanted > 0 && verdict !== true) {
        deferredSpendCap += 1;
        notes.push(`${business.id}: keyword generation deferred (daily AI spend limit)`);
        record.reasons.push(autopilotReason.aiLimit());
        logOwnerSkip("autopilot", { user_id: userId, business_id: businessId, reason: verdict, step: "keywords" });
      } else if (wanted > 0) {
        const suggestions = await generateKeywordsFromBusiness(
          (business.niche as string) || undefined,
          (business.description as string) || undefined,
          (business.website_url as string) || undefined,
          (business.content_language as string) || undefined,
          {
            businessName: (business.name as string) || undefined,
            names,
            // What the site already covers: published titles first, then
            // every keyword it has. Bounded in the prompt (AVOID_TOPICS_MAX).
            avoid: [
              ...topics.articles.filter((a) => a.status === "published" && a.title).map((a) => a.title as string),
              ...topics.keywords.map((k) => k.keyword),
            ],
          }
        );

        // Held to the site's data: a comparison naming a product nothing
        // there names is not bought; each gets its intent.
        const { kept, refused } = settleSuggestions(suggestions, {
          names,
          businessName: (business.name as string | null) ?? null,
          profile: [business.niche, business.description].filter(Boolean).join("\n"),
        });
        if (refused.length > 0) {
          notes.push(`${business.id}: ${refused.length} suggestion(s) not bought, naming a product the site's data does not (e.g. ${refused[0].keyword})`);
        }

        // Not a keyword the site has, and not a near-duplicate of one, of a
        // published article, or of another suggestion. Of those, the kinds
        // the pool lacks most first: the call returned more than the floor
        // asks for, and the ones bought are chosen among them, not added to.
        const left: Partial<Record<TopicIntent, number>> = {};
        for (const k of available) {
          if (!scheduledIds.has(k.id)) left[k.intent] = (left[k.intent] ?? 0) + 1;
        }
        const fresh = chooseForPool(freshSuggestions(topics, kept), left, wanted);

        if (fresh.length === 0) {
          // Paid for and nothing bought: the outcome nobody would otherwise
          // see. Said on the site, not only here.
          notes.push(`${business.id}: keyword top-up found no new topic (every suggestion overlaps one the site has)`);
          record.reasons.push(autopilotReason.noNewTopics(wanted));
        } else {
          const { data: inserted, error: insertError } = await supabase
            .from("keywords")
            .insert(
              fresh.map((suggestion) => ({
                user_id: userId,
                business_id: businessId,
                keyword: suggestion.keyword.trim(),
                search_volume: suggestion.searchVolume ?? null,
                competition: suggestion.competition ?? "Medium",
                difficulty: suggestion.difficulty ?? 50,
                cpc: suggestion.cpc ?? null,
                opportunity: suggestion.opportunity ?? "Medium",
                status: "available",
                is_starred: false,
                source: AUTOPILOT_SOURCE,
                intent: suggestion.intent,
              }))
            )
            .select("id, keyword, intent, opportunity, difficulty, search_volume");

          if (insertError) {
            // Paid for and not stored: said on the site, the days already
            // scheduled above stand.
            notes.push(`${business.id}: keywords not stored (${insertError.message})`);
            record.reasons.push(autopilotReason.failed());
          }
          if (!insertError && inserted?.length) {
            generated += inserted.length;
            boughtHere = inserted.length;
            // Keywords just bought fill days the first pass left empty. A new
            // site with Autopilot on and no pool used to wait until tomorrow
            // for a calendar. Generating first is still refused: a healthy
            // pool is scheduled before anything is bought.
            const leftoverCap = settings.maxSchedulesPerRun - scheduledHere;
            if (leftoverCap > 0) {
              const bought = inserted.map((row) => ({
                id: row.id as string,
                score: keywordScore({
                  opportunity: row.opportunity as string | null,
                  difficulty: row.difficulty as number | null,
                  searchVolume: row.search_volume as number | null,
                }),
                intent: intentOf(row.intent, String(row.keyword ?? ""), { names }),
              }));
              for (const k of bought) intentById.set(k.id, k.intent);
              await applyPlan(
                planSchedule({
                  today,
                  bufferDays: settings.bufferDays,
                  occupiedDates: occupied,
                  occupiedIntents,
                  available: bought,
                  maxPerRun: leftoverCap,
                })
              );
            }
          }
        }
      }

      scheduled += scheduledHere;
      record.topicsAdded = boughtHere;

      // ── Say why days stay empty, on the site ─────────────────────────────
      const emptyDays = countEmptyDays(today, settings.bufferDays, occupied);
      record.emptyDays = emptyDays;
      const leftToSchedule = available.length + boughtHere - scheduledHere;
      if (emptyDays > 0 && overlapping.length > 0) {
        record.reasons.push(autopilotReason.poolOverlaps(overlapping.length, overlapping[0].keyword));
      }
      if (emptyDays > 0 && leftToSchedule <= 0) {
        record.reasons.push(autopilotReason.daysEmpty(emptyDays, settings.bufferDays));
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      notes.push(`${business.id}: ${message}`);
      // The accounts cannot pay: pause and alert once, and stop asking for
      // keywords for the rest of this run instead of one refusal per site.
      const refused = await recordLlmBillingRefusal(supabase, err, { source: "cron.autopilot" });
      if (refused) {
        llmPausedUntil = refused.pausedUntil;
        record.reasons.push(autopilotReason.aiPaused());
      } else {
        record.reasons.push(autopilotReason.failed());
        Sentry.captureException(err, {
          tags: { stage: "autopilot" },
          extra: { business_id: business.id },
        });
      }
    }

    if (record.reasons.length > 0) stalled += 1;
    await recordRun(supabase, businessId, record, notes);
  }

  return NextResponse.json({
    businesses: rows?.length ?? 0,
    autopilotOn: active,
    stalled,
    skippedUnpaid,
    ...(deferredSpendCap ? { keywordsDeferredSpendCap: deferredSpendCap } : {}),
    scheduled,
    keywordsGenerated: generated,
    questionsAdded,
    ...(llmPausedUntil ? { llmPausedUntil: llmPausedUntil.toISOString() } : {}),
    notes: notes.slice(0, 10),
  });
}

export async function GET(request: NextRequest) {
  return run(request);
}

export async function POST(request: NextRequest) {
  return run(request);
}
