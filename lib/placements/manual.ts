import type { SupabaseClient } from "@supabase/supabase-js";
import { clampText } from "@/lib/content/text";
import { canonicalTarget, contentHash, type CanonicalTarget } from "@/lib/providers/discovery/canonical";
import { readXPost, type XPost } from "@/lib/providers/x/oembed";
import { xStatusPostedAt } from "@/lib/providers/x/status-time";
import { PERSON_VERDICT } from "./qualification";
import {
  DRAFT_COLUMNS,
  TARGET_COLUMNS,
  loadAiCitations,
  mapDraft,
  mapTarget,
  withAiCitation,
  withReplyMetrics,
  type PlacementTargetRecord,
} from "./read";
import { loadReplyMetrics } from "./reply-metrics-read";
import { freshUntil } from "./rules";
import { loadMedia, saveTargetMedia, withMedia } from "./media";
import {
  loadReferenced,
  looksLikeReply,
  quoteHintFromEmbed,
  saveTargetReferenced,
  unreadPost,
  withReferenced,
  LINK_NOT_OPENED,
  type QuoteHint,
  type ReferencedPosts,
  type ReferencedSlot,
} from "./referenced";
import { readXPostContext, type PostContextRead } from "./x-media";
import { readQuoteFromEmbed } from "./x-referenced";
import { loadRemovals, withRemoval } from "./removed";
import { loadLinkSearches, withLinkSearch } from "./reply-link";
import { isTargetStatus, statusWhenAddedByHand, type TargetStatus } from "./workflow";

/**
 * "Add a post from X": a person brings one post into the inbox by its link.
 *
 * Discovery finds X posts through a weekly web search, so what it finds is
 * one to three weeks old, and on X a reply matters in the first hours. The
 * person finds fresh posts themselves (an X List) and pastes the link here.
 *
 * The post becomes the same row discovery would have stored: surface `x`,
 * kind `post`, the canonical status URL and the `status:<id>` identity, so a
 * later sweep that finds it again is the same row. What differs is who
 * judged it: a person chose it, so it is qualified by them
 * (`qualified_by` = PERSON_VERDICT), with no score, and the qualifying model
 * is not asked whether it is worth answering, nor what to say: the drafter
 * takes the angle from the post and the writer. The text comes from X's
 * oEmbed (provider layer); when X will not hand it over (protected, deleted,
 * unreachable), from the text the person pasted; with neither there is
 * nothing to draft from and the person is asked for the text.
 *
 * Media (11 November 2026): the embed shows that a post has a photo or a
 * video but never the image. A post whose embed shows one has its media
 * read by id through the X API, under its cap (x-media.ts); with the API
 * off or capped they are recorded as unread, and the drafter and the card
 * say there is an image nobody could see.
 *
 * What it quotes and answers (14 November 2026): the embed shows a quoted
 * post only as a link. With the X API, the same by-id read (one call, the
 * media too) returns the quoted post and the post it replies to; without it,
 * or when it is refused, the quoted post is read for free through its link
 * and oEmbed (x-referenced.ts). A post whose embed shows no link, no media
 * and no opening mention costs nothing.
 */

/** `found_via` of a row a person added. */
export const MANUAL_SOURCE = "manual";

export const NOT_AN_X_POST =
  "That is not a link to a post on X. Paste the post's own link, like https://x.com/name/status/1234567890.";

/** `qualify_reason` of a row a person added: their verdict, which has no score. */
export const ADDED_REASON = "Added by you from X.";

export const TEXT_NEEDED =
  "X did not let us read this post (it may be protected or deleted, or X did not answer). Paste the post's text in the field below and add it again.";

/** A post's text as a title: one line, short. */
const TITLE_MAX = 200;
/** As an excerpt: the whole post, up to what the drafter reads and some. */
const EXCERPT_MAX = 2_000;

export type XStatusLink = { ok: true; target: CanonicalTarget; statusId: string } | { ok: false; error: string };

/**
 * Whether `raw` is the link of one post on X (x.com, twitter.com,
 * mobile.twitter.com; `/<account>/status/<id>` or `/i/web/status/<id>`),
 * and its identity. The one canonicaliser decides, so a link pasted here and
 * the same post found by discovery are one row. A link without its scheme
 * ("x.com/name/status/1") is read as https.
 */
export function parseXStatusLink(raw: string): XStatusLink {
  const text = raw.trim();
  if (!text) return { ok: false, error: NOT_AN_X_POST };
  const target = canonicalTarget(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  if (!target || target.surface !== "x" || target.kind !== "post" || !target.externalId.startsWith("status:")) {
    return { ok: false, error: NOT_AN_X_POST };
  }
  return { ok: true, target, statusId: target.externalId.slice("status:".length) };
}

/** Pasted text, tidied: Windows line ends, trailing spaces and blank runs. */
export function cleanPastedText(text: string | null | undefined): string {
  return (text ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** The post as an excerpt: line breaks kept, cut on a character, never inside an emoji. */
function excerptOf(text: string): string {
  const chars = Array.from(text);
  return chars.length <= EXCERPT_MAX ? text : `${chars.slice(0, EXCERPT_MAX - 1).join("").trimEnd()}…`;
}

/**
 * When the post was made. Its id says so exactly (a snowflake); failing
 * that, the day the embed prints, as a day. Unknown stays null.
 */
export function postedAtOf(
  statusId: string,
  post: XPost | null,
  now: Date
): { at: string; precision: "day" | null } | null {
  const exact = xStatusPostedAt(statusId, now);
  if (exact) return { at: exact, precision: null };
  if (post?.postedOn) return { at: post.postedOn, precision: "day" };
  return null;
}

export type AddOutcome =
  /** A new row. */
  | "created"
  /** A row discovery found but nobody judged, or one turned down: now qualified by the person. */
  | "reopened"
  /** Already open in the inbox: left as it was, missing facts filled in. */
  | "already_open"
  /** A reply was already published there: left exactly as it was. */
  | "published";

export type AddPostResult =
  | { ok: false; code: "not_x_post" | "text_needed"; error: string }
  | {
      ok: true;
      outcome: AddOutcome;
      target: PlacementTargetRecord;
      /** Where the text came from: X itself, the person's paste, or the row already stored. */
      textFrom: "x" | "pasted" | "stored";
      /** Whether a draft should be started now: the row is qualified and has none. */
      draftable: boolean;
    };

interface ExistingRow {
  id: string;
  status: string;
  author: string | null;
  excerpt: string | null;
  kind: string | null;
  posted_at: string | null;
  posted_at_precision: string | null;
  snoozed_until: string | null;
}

/** One target of the site with its drafts, through the caller's client; null when it is not there. */
export async function loadTarget(
  supabase: SupabaseClient,
  businessId: string,
  id: string
): Promise<PlacementTargetRecord | null> {
  const [{ data: row }, { data: drafts }, citations, removals, metrics, media, referenced, searches] = await Promise.all([
    supabase.from("placement_targets").select(TARGET_COLUMNS).eq("id", id).eq("business_id", businessId).maybeSingle(),
    supabase.from("placements").select(DRAFT_COLUMNS).eq("target_id", id).order("created_at", { ascending: true }),
    // The card keeps its citation line after an action reloads it.
    loadAiCitations(supabase, businessId, [id]),
    loadRemovals(supabase, businessId, [id]),
    loadReplyMetrics(supabase, businessId, [id]),
    loadMedia(supabase, businessId, [id]),
    loadReferenced(supabase, businessId, [id]),
    loadLinkSearches(supabase, [id]),
  ]);
  if (!row) return null;
  return mapTarget(
    withLinkSearch(
      withReferenced(
        withMedia(withReplyMetrics(withRemoval(withAiCitation(row as Record<string, unknown>, citations), removals), metrics), media),
        referenced
      ),
      searches
    ),
    ((drafts ?? []) as Record<string, unknown>[]).map(mapDraft)
  );
}

async function findExisting(
  supabase: SupabaseClient,
  businessId: string,
  externalId: string
): Promise<ExistingRow | null> {
  const { data } = await supabase
    .from("placement_targets")
    .select("id, status, author, excerpt, kind, posted_at, posted_at_precision, snoozed_until")
    .eq("business_id", businessId)
    .eq("surface", "x")
    .eq("external_id", externalId)
    .maybeSingle();
  return (data as ExistingRow | null) ?? null;
}

/**
 * Adds the post at `url` to the business's inbox, or reuses the row it
 * already has there.
 *
 * Access: `supabase` is the person's own client, and every read and update
 * goes through it, so RLS is the access control. The insert is the one
 * write the person's client has no policy for (discovery is the platform's
 * job), so it goes through `admin`, with `user_id` and `business_id` fixed
 * by the caller, who picked the business FROM the user's own
 * (`selectedBusinessId`). Nothing read from the request decides whose row it
 * is.
 */
export async function addPostByHand(params: {
  supabase: SupabaseClient;
  admin: SupabaseClient;
  userId: string;
  businessId: string;
  url: string;
  pastedText?: string | null;
  /** Reads the post from X; the oEmbed reader unless a test replaces it. */
  readPost?: (url: string) => Promise<XPost | null>;
  /**
   * Reads the media of a post, and the posts it quotes and replies to, when
   * its embed gives a reason: the metered X API lookup by id (x-media.ts)
   * unless a test replaces it.
   */
  readContext?: (statusId: string) => Promise<PostContextRead>;
  /**
   * Reads the quoted post the embed links, for free (oEmbed and t.co,
   * x-referenced.ts), when the X API did not: unless a test replaces it.
   */
  readQuote?: (hint: QuoteHint) => Promise<ReferencedSlot>;
  now?: Date;
}): Promise<AddPostResult> {
  const link = parseXStatusLink(params.url);
  if (!link.ok) return { ok: false, code: "not_x_post", error: link.error };
  const now = params.now ?? new Date();
  const readPost = params.readPost ?? ((url: string) => readXPost(url));
  const readContext = params.readContext ?? ((statusId: string) => readXPostContext({ supabase: params.admin, statusId, now }));
  const readQuote = params.readQuote ?? ((hint: QuoteHint) => readQuoteFromEmbed(hint, { now }));
  const pasted = cleanPastedText(params.pastedText);

  let existing = await findExisting(params.supabase, params.businessId, link.target.externalId);

  // A reply already made: nothing to reopen, read or fill in.
  if (existing?.status === "published_manually") {
    const target = await loadTarget(params.supabase, params.businessId, existing.id);
    if (target) return { ok: true, outcome: "published", target, textFrom: "stored", draftable: false };
  }

  // X's own text first; the person's paste only when X will not hand it over.
  // An existing row that already has its text does not need X at all (its
  // media, if nobody recorded them, stay not known).
  const needsRead = !existing || !existing.excerpt || !existing.author;
  const post = needsRead ? await readPost(link.target.url) : null;
  // The post's media, when the embed shows some, and what it quotes and
  // answers, when the row has none recorded: one read by id under the X cap
  // when the embed gives a reason, else (or when refused) the media recorded
  // as unread and the quoted post read for free. Never fails the add.
  const recordContext = async (id: string) => {
    if (!post) return;
    let needMedia = Boolean(post.hasMedia);
    let needReferenced = true;
    if (existing) {
      const [knownMedia, knownReferenced] = await Promise.all([
        loadMedia(params.supabase, params.businessId, [id]),
        loadReferenced(params.supabase, params.businessId, [id]),
      ]);
      // Unreadable columns, or already recorded (the X search's): nothing to do.
      if (!knownMedia || knownMedia.has(id)) needMedia = false;
      if (!knownReferenced || knownReferenced.has(id)) needReferenced = false;
    }
    if (!needMedia && !needReferenced) return;
    const hint = quoteHintFromEmbed(post, link.statusId);
    let read: PostContextRead | null = null;
    // Paid only for a reason: an image to read, a link that may be a quote,
    // or the opening mention of a reply.
    if (needMedia || (needReferenced && (hint !== null || looksLikeReply(post)))) {
      try {
        read = await readContext(link.statusId);
      } catch {
        read = null;
      }
    }
    if (needMedia) {
      await saveTargetMedia(params.supabase, { businessId: params.businessId, id }, read?.ok ? read.media : { media: null, unread: true });
    }
    if (needReferenced) {
      let state: ReferencedPosts;
      if (read?.ok) state = read.referenced;
      else {
        let quoted: ReferencedSlot;
        try {
          quoted = await readQuote(hint);
        } catch {
          quoted = hint === null ? "none" : unreadPost({ id: "statusId" in hint ? hint.statusId : null, note: LINK_NOT_OPENED });
        }
        // The embed never says which post a reply answers: not known.
        state = { quoted, repliedTo: null };
      }
      await saveTargetReferenced(params.supabase, { businessId: params.businessId, id }, state);
    }
  };
  const text = post?.text || pasted;
  const handle = post?.handle ?? link.target.author;
  const posted = postedAtOf(link.statusId, post, now);

  if (!existing) {
    if (!text) return { ok: false, code: "text_needed", error: TEXT_NEEDED };
    // `/i/web/status/<id>` carries no account; the embed names it.
    const url = link.target.author || !handle ? link.target.url : `https://x.com/${handle}/status/${link.statusId}`;
    const title = clampText(text, TITLE_MAX);
    const excerpt = excerptOf(text);
    const row = {
      user_id: params.userId,
      business_id: params.businessId,
      surface: link.target.surface,
      kind: link.target.kind,
      external_id: link.target.externalId,
      url,
      title,
      excerpt,
      community: handle ? `@${handle}` : link.target.community,
      author: handle,
      found_for: null,
      found_via: MANUAL_SOURCE,
      content_hash: contentHash(title, excerpt),
      posted_at: posted?.at ?? null,
      posted_at_precision: posted?.precision ?? null,
      score: null,
      comment_count: null,
      fresh_until: freshUntil(link.target.kind, posted?.at ?? null),
      last_seen_at: now.toISOString(),
      status: "qualified",
      qualify_score: null,
      qualify_reason: ADDED_REASON,
      qualify_angle: null,
      qualified_by: PERSON_VERDICT,
      qualified_at: now.toISOString(),
      updated_at: now.toISOString(),
    };
    const { data, error } = await params.admin
      .from("placement_targets")
      .upsert(row, { onConflict: "business_id,surface,external_id", ignoreDuplicates: true })
      .select("id");
    if (error) throw new Error(`placement target insert failed: ${error.message}`);
    const id = ((data ?? []) as Array<{ id: string }>)[0]?.id;
    if (id) {
      await recordContext(id);
      const target = await loadTarget(params.supabase, params.businessId, id);
      if (!target) throw new Error("placement target not readable after insert");
      return { ok: true, outcome: "created", target, textFrom: post?.text ? "x" : "pasted", draftable: true };
    }
    // Another request stored the same post a moment ago: reuse that row.
    existing = await findExisting(params.supabase, params.businessId, link.target.externalId);
    if (!existing) throw new Error("placement target neither inserted nor found");
  }

  if (!isTargetStatus(existing.status)) throw new Error(`unknown placement status: ${existing.status}`);
  const current: TargetStatus = existing.status;
  const next = statusWhenAddedByHand(current);
  if (next === null) {
    const target = await loadTarget(params.supabase, params.businessId, existing.id);
    if (!target) throw new Error("placement target not readable");
    return { ok: true, outcome: "published", target, textFrom: "stored", draftable: false };
  }

  // Only what the row does not know yet. The rest keeps the first sighting.
  const patch: Record<string, unknown> = { updated_at: now.toISOString(), snoozed_until: null };
  if (!existing.author && handle) patch.author = handle;
  const filledText = !existing.excerpt && Boolean(text);
  if (filledText) patch.excerpt = excerptOf(text);
  // An exact time replaces a missing date or a bound read off a search result.
  if (posted && (!existing.posted_at || (existing.posted_at_precision && posted.precision === null))) {
    patch.posted_at = posted.at;
    patch.posted_at_precision = posted.precision;
    patch.fresh_until = freshUntil(existing.kind || link.target.kind, posted.at);
  }
  const reopened = next !== current;
  if (reopened) {
    // The person's verdict replaces the one before it, which had a score
    // and a reason for turning the post down; theirs has neither a score
    // nor anything to argue with.
    Object.assign(patch, {
      status: next,
      qualify_score: null,
      qualify_reason: ADDED_REASON,
      qualified_by: PERSON_VERDICT,
      qualified_at: now.toISOString(),
      dismissed_reason: null,
    });
  }
  const { error } = await params.supabase
    .from("placement_targets")
    .update(patch)
    .eq("id", existing.id)
    .eq("business_id", params.businessId);
  if (error) throw new Error(`placement target update failed: ${error.message}`);
  await recordContext(existing.id);

  const target = await loadTarget(params.supabase, params.businessId, existing.id);
  if (!target) throw new Error("placement target not readable");
  return {
    ok: true,
    outcome: reopened ? "reopened" : "already_open",
    target,
    textFrom: filledText ? (post?.text ? "x" : "pasted") : "stored",
    draftable: target.status === "qualified" && target.drafts.length === 0,
  };
}
