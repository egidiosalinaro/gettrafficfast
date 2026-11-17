import type { SupabaseClient } from "@supabase/supabase-js";
import { isXApiEnabled, xApiClientFromEnv, type XApiClient } from "@/lib/providers/x/api";
import { hasPaidAccess, logUnpaidSkip, paidOwners } from "@/lib/paid-access";
import { parseVoiceSettings } from "@/lib/voice/settings";
import { applyManualAction } from "./actions";
import { postedReplyText } from "./link-match";
import { xStatusIdOf } from "./published-url";
import { loadRemovals } from "./removed";
import {
  LINK_SEARCHES_TABLE,
  LINK_SEARCH_ATTEMPTS,
  LINK_SEARCH_CALL_WORST_USD,
  LINK_SEARCH_MAX_ATTEMPTS,
  LINK_SEARCH_RESULTS,
  LINK_SEARCH_ROWS_PER_RUN,
  LINK_POSTED_BEFORE_MS,
  X_RECENT_SEARCH_MS,
  dueAttempt,
  linkFinding,
  loadLinkSearches,
  matchOwnReply,
  replyLinkQuery,
  searchWindow,
  type LinkFinding,
  type LinkSearchOutcome,
  type LinkSearchRecord,
} from "./reply-link";
import { ownXHandle } from "./x-handle";
import { meteredXCall, readXApiStatus, xPausedUntil, type MeteredRefusal, type XApiStatus } from "./x-budget";

/**
 * Finding the link of the person's own reply on X (docs/PLACEMENTS.md, "The
 * link of your reply, found on X", 2026-11-13): the sweep every 5 minutes
 * (`/api/cron/x-reply-links`), and one reply on request (`find_reply_link`).
 *
 * Who is searched: a reply marked as posted on X ("I posted it") with no
 * link yet, not marked as removed, posted recently enough for X's 7-day
 * search, on a site whose owner turned "Find posts on X" on (the same switch
 * as the daily X search and the reply numbers), whose owner pays, while the
 * platform has the X API on (`X_API_ENABLED=1` and a token), and whose X
 * account is known from the site's own linked replies (`ownXHandle`). Each
 * reply is searched at most four times on its own (2 min, 15 min, 2 h and
 * 12 h after the tap), at most six with `find_reply_link`, and never again
 * once an answer settles it: a call that returned posts is billed, so a
 * search that was billed and found nothing usable is not repeated.
 *
 * Every call goes through `meteredXCall`: ledgered, under the monthly cap,
 * stopped by the billing pause. What is found is saved through
 * `applyManualAction` (`set_published_url`), the path a pasted link takes,
 * so the link is checked the same way, the reply's text is read back from
 * X, and the daily numbers pick it up; only when the reply still has no link.
 */

/** The cron's name in the logs. */
const CRON = "x-reply-links";

/** Posted replies with no link read per sweep, newest first. */
const CANDIDATES_PER_RUN = 200;

/**
 * The sweep stops starting searches after this long, under the cron's 60 s:
 * one search waits at most 15 s for X (X_API_TIMEOUT_MS).
 */
export const LINK_SWEEP_BUDGET_MS = 40_000;

/** Refusals made before X was asked: the attempt is given back. */
const NOT_ASKED: ReadonlySet<MeteredRefusal> = new Set(["disabled", "paused", "cap", "ledger"]);

function log(level: "info" | "warn", fields: Record<string, unknown>) {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, event: "placements.reply_link_search", ...fields });
  if (level === "warn") console.warn(line);
  else console.log(line);
}

// ── Whether GTF looks for a site's reply links ──────────────────────────────

/**
 * Whether GTF looks for the links of a site's replies, from what the screens
 * already know: the platform's X status (null when the platform has the X
 * API off or the site has Find posts on X off), whether the site's X
 * account is known, and whether its owner pays (the sweep searches only
 * for owners who pay). Off while X is paused for billing, at the cap, or
 * when the ledger cannot be read: the person then pastes, as before, and
 * no card says GTF is looking when it is not.
 */
export function replyLinkFinderOn(
  status: XApiStatus | null,
  site: { findPostsOnX: boolean; handleKnown: boolean; ownerPays: boolean }
): boolean {
  if (!status || !status.enabled || !site.findPostsOnX || !site.handleKnown || !site.ownerPays) return false;
  if (status.pausedUntil || status.spentUsd === null) return false;
  return status.spentUsd + LINK_SEARCH_CALL_WORST_USD <= status.capUsd;
}

/** `replyLinkFinderOn` for one site, read whole: its setting, its account, its owner, the platform. `admin` reads the ledger. */
export async function replyLinkFinderFor(admin: SupabaseClient, supabase: SupabaseClient, businessId: string, now = new Date()): Promise<boolean> {
  if (!isXApiEnabled()) return false;
  const { data } = await supabase.from("businesses").select("user_id, voice_settings").eq("id", businessId).maybeSingle();
  const business = data as { user_id?: string; voice_settings?: unknown } | null;
  if (!business?.user_id || !parseVoiceSettings(business.voice_settings).findPostsOnX) return false;
  const [handle, status, ownerPays] = await Promise.all([
    ownXHandle(admin, businessId),
    readXApiStatus(admin, now),
    ownerPaysFor(supabase, business.user_id, now),
  ]);
  return replyLinkFinderOn(status, { findPostsOnX: true, handleKnown: handle !== null, ownerPays });
}

/** Whether the owner pays, for the screens' "looking" line; unreadable reads as not (nothing is promised). */
export async function ownerPaysFor(supabase: SupabaseClient, userId: string, now = new Date()): Promise<boolean> {
  try {
    return await hasPaidAccess(supabase, userId, now);
  } catch {
    return false;
  }
}

// ── One attempt ─────────────────────────────────────────────────────────────

interface SearchTarget {
  id: string;
  user_id: string;
  business_id: string;
  url: string;
  published_at: string;
}

export type AttemptResult =
  | { kind: "found"; url: string; posts: number; costUsd: number }
  | { kind: Exclude<LinkSearchOutcome, "found" | "searching" | "error">; posts: number; costUsd: number; message?: string }
  /** X failed or refused after being asked: the attempt counts. `stopRun` when every next call would fail the same way. */
  | { kind: "error"; reason: MeteredRefusal; message: string; stopRun: boolean; posts: 0; costUsd: 0 }
  /** Not asked (off, paused, the cap, the ledger): the attempt is given back, and the run stops. */
  | { kind: "refused"; reason: MeteredRefusal; message: string }
  /** Another attempt holds this reply right now. */
  | { kind: "busy" }
  /** Nothing to search: not an X post, an account X does not accept, or past X's 7 days. */
  | { kind: "skipped"; why: string };

/**
 * Takes the attempt before X is asked: one conditional write, so two callers
 * (the sweep and the tool) never search the same reply at once, and an
 * attempt that dies half-way still counts.
 */
async function claim(admin: SupabaseClient, target: SearchTarget, previous: LinkSearchRecord | null, attempts: number, now: Date): Promise<boolean> {
  const at = now.toISOString();
  if (!previous) {
    const { data, error } = await admin
      .from(LINK_SEARCHES_TABLE)
      .upsert(
        {
          target_id: target.id,
          user_id: target.user_id,
          business_id: target.business_id,
          attempts,
          last_attempt_at: at,
          outcome: "searching",
          posts_seen: 0,
          created_at: at,
          updated_at: at,
        },
        { onConflict: "target_id", ignoreDuplicates: true }
      )
      .select("target_id");
    return !error && ((data ?? []) as unknown[]).length > 0;
  }
  const { data, error } = await admin
    .from(LINK_SEARCHES_TABLE)
    .update({ attempts, last_attempt_at: at, outcome: "searching", updated_at: at })
    .eq("target_id", target.id)
    .eq("attempts", previous.attempts)
    .select("target_id");
  return !error && ((data ?? []) as unknown[]).length > 0;
}

async function settle(admin: SupabaseClient, targetId: string, fields: Record<string, unknown>, now: Date): Promise<void> {
  const { error } = await admin
    .from(LINK_SEARCHES_TABLE)
    .update({ ...fields, updated_at: now.toISOString() })
    .eq("target_id", targetId);
  if (error) log("warn", { target_id: targetId, outcome: "settle_failed", error: error.message });
}

/** Whether another reply of the site already carries this status as its link. */
async function linkTakenElsewhere(admin: SupabaseClient, target: SearchTarget, statusId: string): Promise<boolean> {
  const { data } = await admin
    .from("placement_targets")
    .select("id, published_url")
    .eq("business_id", target.business_id)
    .ilike("published_url", `%/status/${statusId}%`)
    .limit(5);
  return ((data ?? []) as Array<{ id: string; published_url: string | null }>).some(
    (row) => row.id !== target.id && row.published_url !== null && xStatusIdOf(row.published_url) === statusId
  );
}

/**
 * One search for one posted reply, and what follows from it: the link saved
 * when it is surely the person's reply, the attempt recorded either way.
 * `attempts` is what the reply will have had after this one. Never throws
 * for anything X did.
 */
export async function attemptReplyLink(params: {
  admin: SupabaseClient;
  /** The client the link is saved through: the person's own for the tool, the service role for the sweep. */
  saveClient: SupabaseClient;
  client: XApiClient | null;
  target: SearchTarget;
  handle: string;
  replyText: string | null;
  previous: LinkSearchRecord | null;
  attempts: number;
  now: Date;
  signal?: AbortSignal;
}): Promise<AttemptResult> {
  const { admin, target, previous, now } = params;
  const threadId = xStatusIdOf(target.url);
  const query = threadId ? replyLinkQuery(threadId, params.handle) : null;
  const window = searchWindow(target.published_at, now);
  if (!threadId || !query) return { kind: "skipped", why: "not_searchable" };
  if (!window) return { kind: "skipped", why: "too_old" };

  if (!(await claim(admin, target, previous, params.attempts, now))) return { kind: "busy" };

  const called = await meteredXCall({
    supabase: admin,
    client: params.client,
    worstCaseUsd: LINK_SEARCH_CALL_WORST_USD,
    now,
    run: (client) =>
      client.searchReplies({ query, maxResults: LINK_SEARCH_RESULTS, startTime: window.start, endTime: window.end, signal: params.signal }),
  });

  const postsBefore = previous?.postsSeen ?? 0;
  if (!called.ok) {
    if (NOT_ASKED.has(called.reason)) {
      // Nothing was asked: the reply keeps its attempt for later.
      await settle(
        admin,
        target.id,
        { attempts: previous?.attempts ?? 0, outcome: previous?.outcome ?? null, last_attempt_at: previous?.lastAttemptAt ?? null },
        now
      );
      log("info", { target_id: target.id, business_id: target.business_id, outcome: "not_asked", reason: called.reason });
      return { kind: "refused", reason: called.reason, message: called.message };
    }
    await settle(admin, target.id, { outcome: "error" }, now);
    log("warn", { target_id: target.id, business_id: target.business_id, attempt: params.attempts, outcome: "error", reason: called.reason, error: called.message.slice(0, 300) });
    return { kind: "error", reason: called.reason, message: called.message, stopRun: called.reason !== "error", posts: 0, costUsd: 0 };
  }

  const billed = called.result.billedPosts;
  const costUsd = called.result.costUsd;
  const postsSeen = postsBefore + billed;
  const input = {
    threadId,
    handle: params.handle,
    markedAt: target.published_at,
    replyText: params.replyText,
    posts: called.result.posts,
  };
  const taken = new Set<string>();
  let match = matchOwnReply(input);
  // A reply already saved as another row's link is not this one's.
  while (match.kind === "found" && (await linkTakenElsewhere(admin, target, match.post.id))) {
    taken.add(match.post.id);
    match = matchOwnReply({ ...input, taken });
  }
  // A settled answer stops the automatic attempts; `find_reply_link` may still ask.
  const stopped = Math.max(params.attempts, LINK_SEARCH_ATTEMPTS);
  const done = (outcome: LinkSearchOutcome, extra: Record<string, unknown> = {}) =>
    log("info", {
      target_id: target.id,
      business_id: target.business_id,
      attempt: params.attempts,
      outcome,
      posts: billed,
      est_cost_usd: costUsd,
      ...extra,
    });

  if (match.kind === "found") {
    const saved = await applyManualAction({
      supabase: params.saveClient,
      businessId: target.business_id,
      targetId: target.id,
      input: { action: "set_published_url", publishedUrl: match.url },
      requireNoLink: true,
      now,
    });
    if (!saved.ok) {
      await settle(admin, target.id, { attempts: stopped, outcome: "not_saved", posts_seen: postsSeen }, now);
      done("not_saved", { why: saved.error.slice(0, 200) });
      return { kind: "not_saved", posts: billed, costUsd, message: saved.error };
    }
    await settle(
      admin,
      target.id,
      { outcome: "found", posts_seen: postsSeen, found_url: match.url, found_at: now.toISOString() },
      now
    );
    done("found", { why: match.why });
    return { kind: "found", url: match.url, posts: billed, costUsd };
  }
  if (match.kind === "ambiguous") {
    await settle(admin, target.id, { attempts: stopped, outcome: "ambiguous", posts_seen: postsSeen }, now);
    done("ambiguous", { candidates: match.candidateIds.length });
    return { kind: "ambiguous", posts: billed, costUsd };
  }
  if (billed > 0) {
    // Billed, and not this reply: asking again would bill the same posts again.
    await settle(admin, target.id, { attempts: stopped, outcome: "other_replies", posts_seen: postsSeen }, now);
    done("other_replies");
    return { kind: "other_replies", posts: billed, costUsd };
  }
  await settle(admin, target.id, { outcome: "not_found", posts_seen: postsSeen }, now);
  done("not_found");
  return { kind: "not_found", posts: 0, costUsd };
}

/** The words on record for each reply (the draft marked as posted), by target id. */
async function replyTexts(
  admin: SupabaseClient,
  rows: ReadonlyArray<{ id: string; selected_placement_id: string | null }>
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  if (rows.length === 0) return out;
  const { data } = await admin
    .from("placements")
    .select("id, target_id, body")
    .in("target_id", rows.map((r) => r.id))
    .order("created_at", { ascending: true });
  const drafts = new Map<string, Array<{ id: string; body: string }>>();
  for (const row of (data ?? []) as Array<{ id: string; target_id: string; body: string | null }>) {
    const list = drafts.get(row.target_id) ?? [];
    list.push({ id: row.id, body: row.body ?? "" });
    drafts.set(row.target_id, list);
  }
  for (const row of rows) {
    out.set(row.id, postedReplyText({ selectedPlacementId: row.selected_placement_id, drafts: drafts.get(row.id) ?? [] }));
  }
  return out;
}

// ── The sweep ───────────────────────────────────────────────────────────────

export interface LinkSweepOutcome {
  skipped?: string;
  /** Posted replies on X with no link, recent enough to search. */
  candidates: number;
  /** Of those, the ones with an attempt due. */
  due: number;
  searched: number;
  found: number;
  notFound: number;
  /** Ambiguous, other replies only, or found but not saved: stopped without a link. */
  stoppedWithoutLink: number;
  errors: number;
  /** Due, but the site is off, its owner does not pay, or its X account is not known. */
  notEligible: number;
  costUsd: number;
  stopped: MeteredRefusal | null;
}

interface CandidateRow {
  id: string;
  user_id: string;
  business_id: string | null;
  url: string;
  published_at: string | null;
  selected_placement_id: string | null;
}

/**
 * The 5-minute sweep: every posted reply on X with no link whose next attempt
 * is due, newest first, at most LINK_SEARCH_ROWS_PER_RUN searches. `admin` is
 * the service role. When nothing is due it costs two small reads and no
 * call to X.
 */
export async function findReplyLinks(params: {
  admin: SupabaseClient;
  now?: Date;
  /** Test seam: the X client; from the env otherwise. */
  client?: XApiClient | null;
  maxRows?: number;
  /** Stop starting searches after this long (LINK_SWEEP_BUDGET_MS). */
  budgetMs?: number;
}): Promise<LinkSweepOutcome> {
  const started = Date.now();
  const budgetMs = params.budgetMs ?? LINK_SWEEP_BUDGET_MS;
  const now = params.now ?? new Date();
  const { admin } = params;
  const outcome: LinkSweepOutcome = {
    candidates: 0,
    due: 0,
    searched: 0,
    found: 0,
    notFound: 0,
    stoppedWithoutLink: 0,
    errors: 0,
    notEligible: 0,
    costUsd: 0,
    stopped: null,
  };
  if (!isXApiEnabled() && params.client === undefined) return { ...outcome, skipped: "x_api_disabled" };
  const client = params.client === undefined ? xApiClientFromEnv() : params.client;
  const maxRows = params.maxRows ?? LINK_SEARCH_ROWS_PER_RUN;

  const oldest = new Date(now.getTime() - X_RECENT_SEARCH_MS + LINK_POSTED_BEFORE_MS).toISOString();
  const { data, error } = await admin
    .from("placement_targets")
    .select("id, user_id, business_id, url, published_at, selected_placement_id")
    .eq("surface", "x")
    .eq("status", "published_manually")
    .is("published_url", null)
    .gte("published_at", oldest)
    .order("published_at", { ascending: false })
    .limit(CANDIDATES_PER_RUN);
  if (error) throw new Error(`posted replies: ${error.message}`);
  const rows = ((data ?? []) as CandidateRow[]).filter((row) => row.business_id && searchWindow(row.published_at, now));
  outcome.candidates = rows.length;
  if (rows.length === 0) return outcome;

  const searches = await loadLinkSearches(admin, rows.map((r) => r.id));
  if (!searches) return { ...outcome, skipped: "searches_unreadable" };
  const due = rows
    .map((row) => ({ row, previous: searches.get(row.id) ?? null }))
    .map((item) => ({ ...item, slot: dueAttempt(item.row.published_at, item.previous?.attempts ?? 0, now) }))
    .filter((item): item is { row: CandidateRow; previous: LinkSearchRecord | null; slot: number } => item.slot !== null);
  outcome.due = due.length;
  if (due.length === 0) return outcome;

  const paused = await xPausedUntil(admin, now);
  if (paused) return { ...outcome, skipped: `x_api_paused_until ${paused.toISOString()}` };

  // The sites: Find posts on X on, the owner paying, the account known.
  const businessIds = [...new Set(due.map((item) => item.row.business_id as string))];
  const { data: businessRows, error: businessError } = await admin
    .from("businesses")
    .select("id, user_id, voice_settings")
    .in("id", businessIds);
  if (businessError) throw new Error(`businesses: ${businessError.message}`);
  const optedIn = new Map(
    ((businessRows ?? []) as Array<{ id: string; user_id: string; voice_settings: unknown }>)
      .filter((b) => parseVoiceSettings(b.voice_settings).findPostsOnX)
      .map((b) => [b.id, b.user_id])
  );
  const paid = paidOwners(admin, now);
  const handles = new Map<string, string | null>();
  const eligible: typeof due = [];
  for (const item of due) {
    const businessId = item.row.business_id as string;
    const owner = optedIn.get(businessId);
    if (!owner) {
      outcome.notEligible += 1;
      continue;
    }
    const verdict = await paid.verdict(owner);
    if (verdict !== true) {
      outcome.notEligible += 1;
      logUnpaidSkip(CRON, { user_id: owner, business_id: businessId, reason: verdict });
      continue;
    }
    if (!handles.has(businessId)) handles.set(businessId, await ownXHandle(admin, businessId));
    if (!handles.get(businessId)) {
      outcome.notEligible += 1;
      continue;
    }
    eligible.push(item);
    if (eligible.length >= maxRows) break;
  }
  if (eligible.length === 0) return outcome;

  // A reply the person marked as removed has no link to find.
  const removals = new Map<string, Set<string>>();
  for (const businessId of new Set(eligible.map((item) => item.row.business_id as string))) {
    const ids = eligible.filter((item) => item.row.business_id === businessId).map((item) => item.row.id);
    const read = await loadRemovals(admin, businessId, ids);
    removals.set(businessId, new Set(read ? [...read.keys()] : ids));
  }
  const texts = await replyTexts(admin, eligible.map((item) => item.row));

  for (const item of eligible) {
    // What is left waits for the next run, five minutes on: its slot is still due.
    if (Date.now() - started > budgetMs) break;
    const businessId = item.row.business_id as string;
    if (removals.get(businessId)?.has(item.row.id)) {
      outcome.notEligible += 1;
      continue;
    }
    const result = await attemptReplyLink({
      admin,
      saveClient: admin,
      client,
      target: {
        id: item.row.id,
        user_id: item.row.user_id,
        business_id: businessId,
        url: item.row.url,
        published_at: item.row.published_at as string,
      },
      handle: handles.get(businessId) as string,
      replyText: texts.get(item.row.id) ?? null,
      previous: item.previous,
      attempts: item.slot + 1,
      now,
    });
    if (result.kind === "busy" || result.kind === "skipped") continue;
    if (result.kind === "refused") {
      outcome.stopped = result.reason;
      break;
    }
    outcome.searched += 1;
    if (result.kind === "error") {
      outcome.errors += 1;
      if (result.stopRun) {
        outcome.stopped = result.reason;
        break;
      }
      continue;
    }
    outcome.costUsd = Math.round((outcome.costUsd + result.costUsd) * 10_000) / 10_000;
    if (result.kind === "found") outcome.found += 1;
    else if (result.kind === "not_found") outcome.notFound += 1;
    else outcome.stoppedWithoutLink += 1;
  }
  return outcome;
}

// ── One reply, now ──────────────────────────────────────────────────────────

export type FindNowRefusal = { ok: false; code: "not_found" | "invalid_state" | "prerequisite_missing" | "unavailable"; error: string };

export type FindNowResult =
  | {
      ok: true;
      outcome: "found" | "not_found" | "other_replies" | "ambiguous" | "not_saved" | "error";
      message: string;
      /** The link saved, when found. */
      url: string | null;
      /** The estimated cost of the search, from X's per-post price. */
      costUsd: number;
      /** What the reply shows now about the search. */
      finding: LinkFinding | null;
    }
  | FindNowRefusal;

/**
 * Searches X now for one reply's link (`find_reply_link`): the same attempt
 * as the sweep, outside its schedule, counted in the same attempts and
 * bounded the same way (at most LINK_SEARCH_MAX_ATTEMPTS in all). `supabase`
 * is the caller's client (the row is read and the link saved through it);
 * `admin` writes the attempt and the ledger. Every refusal is a sentence.
 */
export async function findReplyLinkNow(params: {
  supabase: SupabaseClient;
  admin: SupabaseClient;
  businessId: string;
  targetId: string;
  now?: Date;
  /** Test seam: the X client; from the env otherwise. */
  client?: XApiClient | null;
}): Promise<FindNowResult> {
  const now = params.now ?? new Date();
  const { supabase, admin, businessId, targetId } = params;
  const client = params.client === undefined ? xApiClientFromEnv() : params.client;
  if (!client) return { ok: false, code: "unavailable", error: "Finding reply links on X is not turned on for GetTrafficFast yet. Add the link with set_reply_link." };

  const { data: business } = await supabase.from("businesses").select("voice_settings").eq("id", businessId).maybeSingle();
  if (!parseVoiceSettings((business as { voice_settings?: unknown } | null)?.voice_settings).findPostsOnX) {
    return {
      ok: false,
      code: "invalid_state",
      error: "Find posts on X is off for this site (Settings → Connections, or update_voice_settings findPostsOnX). It also turns on finding your reply links.",
    };
  }

  const { data: row } = await supabase
    .from("placement_targets")
    .select("id, user_id, business_id, surface, status, url, published_url, published_at, selected_placement_id")
    .eq("id", targetId)
    .eq("business_id", businessId)
    .maybeSingle();
  const target = row as
    | (CandidateRow & { surface: string; status: string; published_url: string | null })
    | null;
  if (!target) return { ok: false, code: "not_found", error: "This post is no longer in your inbox." };
  if (target.status !== "published_manually") return { ok: false, code: "invalid_state", error: "Mark the reply as posted first (mark_reply_posted)." };
  if (target.surface !== "x" || !xStatusIdOf(target.url)) {
    return { ok: false, code: "invalid_state", error: "Only a reply on X can be found this way. Add its link with set_reply_link." };
  }
  if ((target.published_url ?? "").trim()) return { ok: false, code: "invalid_state", error: "This reply already has its link." };
  const removals = await loadRemovals(supabase, businessId, [targetId]);
  if (removals?.has(targetId)) return { ok: false, code: "invalid_state", error: "This reply is marked as removed: there is no link to find." };
  if (!searchWindow(target.published_at, now)) {
    return {
      ok: false,
      code: "invalid_state",
      error: "X's search covers the last 7 days, and this reply was marked as posted before that. Add its link with set_reply_link.",
    };
  }

  const searches = await loadLinkSearches(admin, [targetId]);
  if (!searches) return { ok: false, code: "unavailable", error: "Finding reply links is not ready yet. Try again in a few minutes." };
  const previous = searches.get(targetId) ?? null;
  if ((previous?.attempts ?? 0) >= LINK_SEARCH_MAX_ATTEMPTS) {
    return {
      ok: false,
      code: "invalid_state",
      error: `GTF has looked for this reply ${previous?.attempts} times already. Add its link with set_reply_link.`,
    };
  }

  const handle = await ownXHandle(admin, businessId);
  if (!handle) {
    return {
      ok: false,
      code: "prerequisite_missing",
      error: "GTF does not know this site's X account yet. Add the link of one reply with set_reply_link; after that it can find the others.",
    };
  }

  const texts = await replyTexts(admin, [{ id: targetId, selected_placement_id: target.selected_placement_id }]);
  const result = await attemptReplyLink({
    admin,
    saveClient: supabase,
    client,
    target: { id: targetId, user_id: target.user_id, business_id: businessId, url: target.url, published_at: target.published_at as string },
    handle,
    replyText: texts.get(targetId) ?? null,
    previous,
    attempts: (previous?.attempts ?? 0) + 1,
    now,
  });
  if (result.kind === "busy") return { ok: false, code: "invalid_state", error: "GTF is looking for this reply right now. Try again in a minute." };
  if (result.kind === "skipped") return { ok: false, code: "invalid_state", error: "This reply cannot be searched on X." };
  if (result.kind === "refused") return { ok: false, code: "unavailable", error: result.message };

  const after = await loadLinkSearches(admin, [targetId]);
  const finding =
    result.kind === "found"
      ? null
      : linkFinding(
          {
            surface: "x",
            status: "published_manually",
            url: target.url,
            publishedUrl: null,
            publishedAt: target.published_at,
            linkSearch: after ? (after.get(targetId) ?? null) : undefined,
          },
          { finderOn: true, now: now.getTime() }
        );
  return {
    ok: true,
    outcome: result.kind,
    message: findNowMessage(result, finding),
    url: result.kind === "found" ? result.url : null,
    costUsd: result.costUsd,
    finding,
  };
}

function findNowMessage(result: Exclude<AttemptResult, { kind: "busy" | "skipped" | "refused" }>, finding: LinkFinding | null): string {
  switch (result.kind) {
    case "found":
      return "Found your reply on X and saved its link.";
    case "not_found":
      return finding?.state === "looking"
        ? "X has no reply from this site's account in that thread yet. GTF looks again by itself."
        : "X has no reply from this site's account in that thread. Add its link with set_reply_link.";
    case "other_replies":
      return "X returned other replies from this site's account in that thread, none of them this one. Nothing was saved.";
    case "ambiguous":
      return "More than one reply from this site's account there could be this one, so nothing was saved. Add the right link with set_reply_link.";
    case "not_saved":
      return `A reply was found, but its link was not saved: ${result.message ?? "the reply changed in the meantime."}`;
    case "error":
      return `X did not answer the search: ${result.message}`;
  }
}
