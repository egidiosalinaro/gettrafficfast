import type { SupabaseClient } from "@supabase/supabase-js";
import { lookupWorstCaseUsd, type XApiClient } from "@/lib/providers/x/api";
import { statusIdOf } from "@/lib/providers/x/links";
import { readXPost, type XPost } from "@/lib/providers/x/oembed";
import { resolveXShortLink } from "@/lib/providers/x/short-link";
import { xStatusPostedAt } from "@/lib/providers/x/status-time";
import {
  EMBED_NOT_READ,
  LINK_NOT_OPENED,
  NOTHING_KNOWN,
  quoteHintFromEmbed,
  referencedFromEmbed,
  referencedFromXApi,
  saveTargetReferenced,
  unreadPost,
  type QuoteHint,
  type ReferencedPosts,
  type ReferencedSlot,
} from "./referenced";
import { X_REFERENCED_BACKFILL_MAX_IDS, meteredXCall, type MeteredRefusal } from "./x-budget";
import { OPEN_STATUSES } from "./workflow";

/**
 * Reading what a post on X quotes and answers, where the X API did not hand
 * it over with the post (docs/PLACEMENTS.md, "What the post quotes").
 *
 *   - The free path, for a post a person added by hand without the X API
 *     (off, at its cap, paused, failing): the embed carries the quoted post
 *     as a link, usually a t.co short link. One request to t.co reads where
 *     it points (never followed, lib/providers/x/short-link.ts); a post on X
 *     is then read through oEmbed, like the post itself. Free. Its text,
 *     author and day; never its images (an embed has none), and never the
 *     post it replies to (an embed does not say). A link that does not open
 *     is recorded as unread, never as "quotes nothing".
 *   - The backfill: open posts on X of the last 3 days with nothing recorded
 *     (stored before 14 November 2026, or found by the web search) are read
 *     once, on the daily X run: those of sites that take part in Find posts
 *     on X through one metered lookup (≤ 30 ids, at worst $0.45, under the
 *     monthly cap), the others through the free path (≤ 5 a run).
 */

/** Open posts this recent are read again for what they quote. */
export const REFERENCED_BACKFILL_DAYS = 3;
/** Posts read through the free path per run: each is up to three requests to X, done side by side. */
export const REFERENCED_FREE_PER_RUN = 5;

type Row = Record<string, unknown>;

function handleOfStatusUrl(url: string): string | null {
  const match = /^https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/(\w{1,15})\/status/i.exec(url);
  return match && match[1].toLowerCase() !== "i" ? match[1] : null;
}

/** When a post was made: its id says so exactly; failing that, the embed's day. */
function postedAtOf(id: string, embed: XPost, now: Date): { at: string; precision: "day" | null } | null {
  const exact = xStatusPostedAt(id, now);
  if (exact) return { at: exact, precision: null };
  return embed.postedOn ? { at: embed.postedOn, precision: "day" } : null;
}

export interface FreeReaders {
  /** Reads a post through oEmbed; `readXPost` unless a test replaces it. */
  readPost?: (url: string) => Promise<XPost | null>;
  /** Reads where a t.co link points; `resolveXShortLink` unless a test replaces it. */
  resolveShortLink?: (url: string) => Promise<string | null>;
  now?: Date;
}

/**
 * The quoted post the embed shows, read for free: "none" when the embed
 * links no post, unread when the link or the post could not be opened.
 */
export async function readQuoteFromEmbed(hint: QuoteHint, readers: FreeReaders = {}): Promise<ReferencedSlot> {
  if (!hint) return "none";
  const readPost = readers.readPost ?? ((url: string) => readXPost(url));
  const resolve = readers.resolveShortLink ?? ((url: string) => resolveXShortLink(url));
  let id: string;
  let url: string;
  if ("statusId" in hint) {
    id = hint.statusId;
    url = hint.url;
  } else {
    const target = await resolve(hint.shortLink);
    if (!target) return unreadPost({ id: null, note: LINK_NOT_OPENED });
    const found = statusIdOf(target);
    // A link to somewhere else than a post on X: the post quotes nothing.
    if (!found) return "none";
    id = found;
    url = target;
  }
  const clean = url.split(/[?#]/)[0];
  const embed = await readPost(clean);
  if (!embed) return unreadPost({ id, handle: handleOfStatusUrl(clean), note: EMBED_NOT_READ });
  return referencedFromEmbed(id, embed, postedAtOf(id, embed, readers.now ?? new Date()));
}

/** What the free path can tell of a post: what it quotes; whether it answers one, never. */
export async function referencedFromEmbedPost(post: XPost, statusId: string, readers: FreeReaders = {}): Promise<ReferencedPosts> {
  return { quoted: await readQuoteFromEmbed(quoteHintFromEmbed(post, statusId), readers), repliedTo: null };
}

// ── The backfill ────────────────────────────────────────────────────────────

export interface ReferencedBackfillOutcome {
  /** Open posts on X of the last days with nothing recorded, looked at this run. */
  candidates: number;
  /** Through the X API: ids asked, posts X returned, the estimated cost; or why not. */
  api: { asked: number; returned: number; costUsd: number } | { skipped: string };
  /** Read through the free path (oEmbed and t.co). */
  embed: number;
  /** Rows that now say what they quote: one that quotes a post, one that quotes none, or one marked unread. */
  recorded: number;
  /** Of those, posts that quote another (read or not). */
  quoting: number;
}

/**
 * Reads, once, what the open posts on X of the last 3 days quote and answer,
 * where nothing is recorded. Never throws for one post: a post that cannot
 * be read is recorded as nothing known, so it is not asked again.
 */
export async function backfillReferencedPosts(params: {
  /** The service role: every site's rows, and the ledger. */
  admin: SupabaseClient;
  client: XApiClient | null;
  /** Sites whose owner pays (every site takes part in X since 2026-11-24): their posts go through the metered lookup. */
  apiBusinessIds: readonly string[];
  now?: Date;
  capUsd?: number;
  readers?: FreeReaders;
}): Promise<ReferencedBackfillOutcome> {
  const now = params.now ?? new Date();
  const since = new Date(now.getTime() - REFERENCED_BACKFILL_DAYS * 86_400_000).toISOString();
  const { data, error } = await params.admin
    .from("placement_targets")
    .select("id, business_id, external_id, url")
    .eq("surface", "x")
    .is("referenced_posts", null)
    .in("status", OPEN_STATUSES)
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(X_REFERENCED_BACKFILL_MAX_IDS + REFERENCED_FREE_PER_RUN * 4);
  if (error) {
    // The column is not there yet (before migration 20261114180000): nothing to fill.
    return { candidates: 0, api: { skipped: `rows not readable: ${error.message.slice(0, 120)}` }, embed: 0, recorded: 0, quoting: 0 };
  }
  const rows = ((data ?? []) as Row[])
    .map((row) => ({
      id: row.id as string,
      businessId: row.business_id as string,
      statusId: typeof row.external_id === "string" && row.external_id.startsWith("status:") ? row.external_id.slice(7) : null,
      url: (row.url as string | null) ?? null,
    }))
    .filter((row): row is { id: string; businessId: string; statusId: string; url: string | null } => Boolean(row.statusId && /^\d{1,20}$/.test(row.statusId)));

  const outcome: ReferencedBackfillOutcome = { candidates: rows.length, api: { skipped: "no post of a site taking part" }, embed: 0, recorded: 0, quoting: 0 };
  const record = async (row: { id: string; businessId: string }, state: ReferencedPosts) => {
    if (await saveTargetReferenced(params.admin, { businessId: row.businessId, id: row.id }, state)) {
      outcome.recorded += 1;
      if (state.quoted && state.quoted !== "none") outcome.quoting += 1;
    }
  };

  const viaApi = new Set(params.apiBusinessIds);
  const apiRows = rows.filter((row) => viaApi.has(row.businessId)).slice(0, X_REFERENCED_BACKFILL_MAX_IDS);
  const done = new Set<string>();
  if (apiRows.length > 0) {
    const ids = [...new Set(apiRows.map((row) => row.statusId))];
    const called = await meteredXCall({
      supabase: params.admin,
      client: params.client,
      worstCaseUsd: lookupWorstCaseUsd(ids.length, { references: true }),
      capUsd: params.capUsd,
      now,
      run: (x) => x.lookup(ids, undefined, { references: true }),
    });
    if (called.ok) {
      outcome.api = { asked: ids.length, returned: called.result.posts.length, costUsd: called.result.costUsd };
      const byId = new Map(called.result.posts.map((post) => [post.id, post]));
      for (const row of apiRows) {
        const post = byId.get(row.statusId);
        // X did not return the post (deleted, protected): asked, nothing known.
        await record(row, (post && referencedFromXApi(post)) ?? NOTHING_KNOWN);
        done.add(row.id);
      }
    } else {
      outcome.api = { skipped: refusalNote(called.reason, called.message) };
    }
  }

  // The rest, and what the API could not read, for free: a few a run.
  const free = rows.filter((row) => !done.has(row.id) && row.url).slice(0, REFERENCED_FREE_PER_RUN);
  const readPost = params.readers?.readPost ?? ((url: string) => readXPost(url));
  await Promise.all(
    free.map(async (row) => {
      try {
        const post = await readPost(row.url as string);
        await record(row, post ? await referencedFromEmbedPost(post, row.statusId, { ...params.readers, readPost, now }) : NOTHING_KNOWN);
        outcome.embed += 1;
      } catch {
        // Tried again on a later run.
      }
    })
  );

  console.log(JSON.stringify({ ts: now.toISOString(), level: "info", event: "x_referenced_backfill", ...outcome }));
  return outcome;
}

function refusalNote(reason: MeteredRefusal, message: string): string {
  return `${reason}: ${message.slice(0, 160)}`;
}
