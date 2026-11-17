import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { XApiPost, XIncludedPost } from "@/lib/providers/x/api";
import { isXShortLink, statusIdOf } from "@/lib/providers/x/links";
import type { XPost } from "@/lib/providers/x/oembed";
import { MAX_DRAFT_IMAGES, PostMediaItem, imageUrlOf, mediaFromProvider } from "./media";

/**
 * The post a post quotes, and the post it replies to.
 *
 * On 14 November 2026 Hank Maker (@hank_ships) posted "Naming is the hardest part of shipping",
 * quoting @listing_bot's automated post "Pet Portrait AI is now
 * listed for sale · MRR: $3.1k/mo · Revenue (30d): $3.6k…". The joke (a
 * plastic-surgery AI called "Pet Portrait") is entirely in the quoted post. The
 * product read the post's text and its photos, never the quoted post: the
 * draft missed the point, and the card in Today showed one line with no
 * context. The same holds for a reply: the post it answers is half of what it
 * says.
 *
 * So what a post quotes and what it replies to is stored with it
 * (`placement_targets.referenced_posts`, migration 20261114180000), the
 * drafter, Fix it and the checks read it, and the card shows the quoted post
 * the way X does. Never invented: a quoted post nobody could read is
 * recorded as unread, said to the drafter and on the card.
 *
 *   referenced_posts  null: never asked (rows stored before 14 November
 *                     2026, other surfaces). Otherwise an object with two
 *                     slots, `quoted` and `repliedTo`, each:
 *                       null    not known (the free path cannot tell
 *                               whether a post is a reply);
 *                       "none"  asked: the post quotes / answers no post;
 *                       a post  what it quotes / answers, with `text` null
 *                               when it exists and could not be read.
 *
 * Where it comes from: the X search and a by-id lookup ask X for the
 * referenced posts in the same call (`includes.tweets`, lib/providers/x/
 * api.ts); a post added by hand without the X API is read through X's free
 * oEmbed, and the quoted post through the t.co link the embed carries
 * (x-referenced.ts).
 */

/** Characters of a referenced post kept: X's long posts run to 25,000, the drafter reads the start. */
export const REFERENCED_TEXT_MAX = 4_000;
/** Characters of it the prompt quotes. */
export const REFERENCED_PROMPT_CHARS = 1_000;

export const ReferencedPost = z.object({
  /** The status id; null when the post could not even be identified (a link that did not open). */
  id: z
    .string()
    .regex(/^\d{1,20}$/)
    .nullable(),
  /** Its canonical link on X; null with no id. */
  url: z.string().url().nullable(),
  /** What it says; null when it exists and could not be read. */
  text: z.string().max(REFERENCED_TEXT_MAX).nullable(),
  authorName: z.string().max(200).nullable().default(null),
  /** The account, without "@". */
  handle: z
    .string()
    .regex(/^\w{1,15}$/)
    .nullable()
    .default(null),
  postedAt: z.string().nullable().default(null),
  /** "day" when only the day is known (the embed's date line); null: exact. */
  postedAtPrecision: z.enum(["day"]).nullable().default(null),
  /** Its photos and stills, as X described them. */
  media: z.array(PostMediaItem).max(4).default([]),
  /** True when it has media nobody could read (the free path never can); null: not known. */
  mediaUnread: z.boolean().nullable().default(null),
  /** Why it could not be read, in a few words; null when it was. */
  note: z.string().max(300).nullable().default(null),
});
export type ReferencedPost = z.infer<typeof ReferencedPost>;

export type ReferencedSlot = ReferencedPost | "none" | null;

export const ReferencedSlotSchema = z.union([z.literal("none"), ReferencedPost]).nullable();

export const ReferencedPosts = z.object({
  quoted: ReferencedSlotSchema.default(null),
  repliedTo: ReferencedSlotSchema.default(null),
});
export type ReferencedPosts = z.infer<typeof ReferencedPosts>;

/** Asked, nothing could be told: a row read again would learn nothing more. */
export const NOTHING_KNOWN: ReferencedPosts = { quoted: null, repliedTo: null };

function parseSlot(raw: unknown): ReferencedSlot {
  if (raw === "none") return "none";
  const parsed = ReferencedPost.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/** A stored value as the two slots; null when it is not an object (never asked). A bad slot reads as not known. */
export function parseReferenced(raw: unknown): ReferencedPosts | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  return { quoted: parseSlot(value.quoted), repliedTo: parseSlot(value.repliedTo) };
}

/** A read slot: a post with its text. */
export function isReadPost(slot: ReferencedSlot | undefined): slot is ReferencedPost & { text: string } {
  return Boolean(slot && slot !== "none" && slot.text !== null);
}

/** An unread slot: a post (or a link) that exists and could not be read. */
export function isUnreadPost(slot: ReferencedSlot | undefined): slot is ReferencedPost & { text: null } {
  return Boolean(slot && slot !== "none" && slot.text === null);
}

// ── From what X answered ────────────────────────────────────────────────────

export { statusIdOf };

/** A post's canonical link: by its account when known. */
export function statusUrl(handle: string | null, id: string): string {
  return handle ? `https://x.com/${handle}/status/${id}` : `https://x.com/i/web/status/${id}`;
}

function cleanHandle(raw: string | null | undefined): string | null {
  const handle = (raw ?? "").trim().replace(/^@/, "");
  return /^\w{1,15}$/.test(handle) ? handle : null;
}

function clampChars(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length <= max ? text : `${chars.slice(0, max - 1).join("").trimEnd()}…`;
}

function isoOrNull(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const at = Date.parse(raw);
  return Number.isFinite(at) ? new Date(at).toISOString() : null;
}

/** A post that exists and could not be read: what is known of it, and why. */
export function unreadPost(known: { id: string | null; handle?: string | null; url?: string | null; note: string }): ReferencedPost {
  const handle = cleanHandle(known.handle);
  return {
    id: known.id,
    url: known.url ?? (known.id ? statusUrl(handle, known.id) : null),
    text: null,
    authorName: null,
    handle,
    postedAt: null,
    postedAtPrecision: null,
    media: [],
    mediaUnread: null,
    note: known.note.slice(0, 300),
  };
}

export const X_DID_NOT_INCLUDE = "X did not hand it over (deleted, protected or withheld)";
export const LINK_NOT_OPENED = "the post's link could not be opened";
export const EMBED_NOT_READ = "X did not hand over the quoted post";

/** A post X included beside the answer, as stored. */
export function referencedFromIncluded(post: XIncludedPost): ReferencedPost {
  const media = mediaFromProvider(post.media).slice(0, 4);
  const handle = cleanHandle(post.handle);
  const hasMedia = post.media.length > 0 || post.mediaUndescribed > 0;
  return {
    id: post.id,
    url: statusUrl(handle, post.id),
    text: clampChars(post.text.trim(), REFERENCED_TEXT_MAX),
    authorName: post.authorName?.trim().slice(0, 200) || null,
    handle,
    postedAt: isoOrNull(post.createdAt),
    postedAtPrecision: null,
    media,
    mediaUnread: hasMedia ? post.mediaUndescribed > 0 || media.length < post.media.length : false,
    note: null,
  };
}

/**
 * What a post read through the X API with `references` quotes and answers;
 * null when the call did not ask (unknown). A relation the post does not
 * have is "none"; one X referenced and did not include is unread.
 */
export function referencedFromXApi(post: Pick<XApiPost, "references">): ReferencedPosts | null {
  if (!post.references) return null;
  const slot = (relation: "quoted" | "replied_to"): ReferencedSlot => {
    const ref = post.references?.find((r) => r.relation === relation);
    if (!ref) return "none";
    return ref.post ? referencedFromIncluded(ref.post) : unreadPost({ id: ref.id, note: X_DID_NOT_INCLUDE });
  };
  return { quoted: slot("quoted"), repliedTo: slot("replied_to") };
}

// ── From the embed (the free path) ──────────────────────────────────────────

/** Where the embed says the quoted post is: its link on X, a t.co link to read, or nothing. */
export type QuoteHint = { statusId: string; url: string } | { shortLink: string } | null;

/**
 * The quoted post, as the embed shows it: a post that quotes another carries
 * it as a link in its text, the last one. A link that names a post on X
 * (other than this one) is the quote; otherwise the last t.co link may be,
 * and is read for where it points. No link: the post quotes nothing that the
 * embed shows.
 */
export function quoteHintFromEmbed(post: Pick<XPost, "links">, ownStatusId: string): QuoteHint {
  const links = post.links ?? [];
  for (const link of [...links].reverse()) {
    for (const candidate of [link.href, link.text]) {
      const id = statusIdOf(candidate);
      if (id && id !== ownStatusId) return { statusId: id, url: candidate };
    }
  }
  // A short link the reader sees as a post on X ("twitter.com/listing_bot/stat…",
  // the embed cuts it): the quote, whatever comes after it.
  const shown = [...links].reverse().find((link) => isXShortLink(link.href) && SHOWN_AS_POST.test(link.text));
  if (shown) return { shortLink: shown.href };
  const last = links[links.length - 1];
  return last && isXShortLink(last.href) ? { shortLink: last.href } : null;
}

/** The text a short link shows when it points to a post on X, cut or not. */
const SHOWN_AS_POST = /^(https?:\/\/)?(www\.|mobile\.)?(x|twitter)\.com\/\w{1,15}\/st/i;

/** True when the embed's text opens on a mention: on X, the shape of a reply. */
export function looksLikeReply(post: Pick<XPost, "text">): boolean {
  return /^@\w{1,15}\b/.test(post.text.trim());
}

/** A quoted post read through its embed: text, author, day; its images are never in an embed. */
export function referencedFromEmbed(id: string, embed: XPost, postedAt: { at: string; precision: "day" | null } | null): ReferencedPost {
  const handle = cleanHandle(embed.handle);
  return {
    id,
    url: statusUrl(handle, id),
    text: clampChars(embed.text.trim(), REFERENCED_TEXT_MAX),
    authorName: embed.authorName?.trim().slice(0, 200) || null,
    handle,
    postedAt: postedAt?.at ?? null,
    postedAtPrecision: postedAt?.precision ?? null,
    media: [],
    // The embed shows that there is an image, never the image.
    mediaUnread: embed.hasMedia === true ? true : embed.hasMedia === false ? false : null,
    note: null,
  };
}

// ── What the record carries ─────────────────────────────────────────────────

export interface ReferencedView {
  /** The post this one quotes (text null when it could not be read); null when it quotes none, or not known. */
  quotedPost: ReferencedPost | null;
  /** True when it quotes a post that could not be read; false when read or none; null when not known. */
  quoteUnread: boolean | null;
  /** The post this one replies to, the same way. */
  repliedToPost: ReferencedPost | null;
  repliedToUnread: boolean | null;
}

function slotView(slot: ReferencedSlot): { post: ReferencedPost | null; unread: boolean | null } {
  if (slot === null) return { post: null, unread: null };
  if (slot === "none") return { post: null, unread: false };
  return { post: slot, unread: slot.text === null };
}

/** The two slots as the record's fields. */
export function referencedView(state: ReferencedPosts | null): ReferencedView {
  const quoted = slotView(state?.quoted ?? null);
  const repliedTo = slotView(state?.repliedTo ?? null);
  return { quotedPost: quoted.post, quoteUnread: quoted.unread, repliedToPost: repliedTo.post, repliedToUnread: repliedTo.unread };
}

/** The card's line under a post whose quoted post the draft could not read. */
export const QUOTE_UNREAD_LINE = "Quotes a post the draft could not read";
/** …when not even the link could be opened: it may not be a post. */
export const LINK_UNREAD_LINE = "Ends with a link the draft could not open";
/** …and for a reply whose parent could not be read. */
export const REPLY_UNREAD_LINE = "Replies to a post the draft could not read";

/** The card's quiet line for what could not be read, or null. */
export function referencedUnreadLine(view: Pick<ReferencedView, "quotedPost" | "quoteUnread" | "repliedToUnread">): string | null {
  if (view.quoteUnread === true) return view.quotedPost?.id ? QUOTE_UNREAD_LINE : LINK_UNREAD_LINE;
  if (view.repliedToUnread === true) return REPLY_UNREAD_LINE;
  return null;
}

// ── What the writer and the checks are told ─────────────────────────────────

function who(post: ReferencedPost): string {
  const handle = post.handle ? `@${post.handle}` : null;
  if (handle && post.authorName && post.authorName.toLowerCase() !== post.handle?.toLowerCase()) return `${handle} (${post.authorName})`;
  return handle ?? post.authorName ?? "another account";
}

function quoted(text: string): string {
  return `«${clampChars(text.replace(/\s+/g, " ").trim(), REFERENCED_PROMPT_CHARS) || "(no text)"}»`;
}

/**
 * The prompt's lines about what the post quotes and answers, or null when it
 * references nothing known. Clearly apart from the post: the reply answers
 * the person who posted, in light of what they quoted or answered.
 */
export function referencedPostsRule(state: ReferencedPosts | null, author: string | null): string | null {
  if (!state) return null;
  const poster = author ? `@${author.replace(/^@/, "")}` : "the poster";
  const lines: string[] = [];
  const reply = state.repliedTo;
  if (isReadPost(reply)) {
    lines.push(`The post is a reply. The post it replies to, by ${who(reply)}: ${quoted(reply.text)}`);
    lines.push(`That post is context, not the post you answer: you reply to ${poster}, and read their words as their answer to it.`);
  } else if (isUnreadPost(reply)) {
    lines.push(`The post is a reply to a post that could not be read. Do not guess what it said.`);
  }
  const quote = state.quoted;
  if (isReadPost(quote)) {
    lines.push(`The post quotes ${who(quote)}: ${quoted(quote.text)}`);
    if (quote.mediaUnread) lines.push(`The quoted post has an image you cannot see: do not describe it.`);
    lines.push(
      `That quoted post is not the post you answer: you reply to ${poster}, who posted the words above about it. The point of the post, often its joke, is in how its words and the quoted post go together: read them together before you decide the tone, and answer ${poster} in light of what they quoted. Do not reply to the quoted account, and do not explain the joke.`
    );
  } else if (isUnreadPost(quote)) {
    lines.push(
      quote.id
        ? `The post quotes another post${quote.handle ? ` by @${quote.handle}` : ""} that could not be read. Do not guess what it says, and do not ask the poster about it: reply to the words, or say nothing about the quote.`
        : `The post ends with a link that could not be opened; it may be a post it quotes. Do not guess what is behind it, and do not ask the poster about it.`
    );
  }
  return lines.length > 0 ? lines.join("\n") : null;
}

/**
 * What the post quotes and answers, as plain text beside it: what the checks
 * that compare a reply with the post (the thread's words, a fact that fits,
 * a repeated fact) and the qualifier read, so a reply about the quoted post
 * is on topic. Empty when nothing was read.
 */
export function referencedText(state: ReferencedPosts | null): string {
  if (!state) return "";
  const parts: string[] = [];
  if (isReadPost(state.repliedTo)) parts.push(`Replying to ${who(state.repliedTo)}: ${state.repliedTo.text}`);
  if (isReadPost(state.quoted)) parts.push(`Quoting ${who(state.quoted)}: ${state.quoted.text}`);
  return parts.join("\n");
}

/** The post's text with what it quotes and answers after it, for the checks and the qualifier. */
export function excerptWithReferenced(excerpt: string | null, state: ReferencedPosts | null): string | null {
  const extra = referencedText(state);
  if (!extra) return excerpt;
  return `${excerpt?.trim() ? `${excerpt.trim()}\n\n` : ""}${extra}`;
}

/**
 * The quoted post's images the drafter is handed in the slots the post's own
 * images leave free (MAX_DRAFT_IMAGES in all): a photo, a video's still.
 */
export function quotedImageInputs(
  state: ReferencedPosts | null,
  freeSlots: number
): Array<{ url: string; altText: string | null; from: "quoted" }> {
  const quote = state?.quoted;
  if (!isReadPost(quote) || freeSlots <= 0) return [];
  const out: Array<{ url: string; altText: string | null; from: "quoted" }> = [];
  for (const item of quote.media) {
    const url = imageUrlOf(item);
    if (!url) continue;
    out.push({ url, altText: item.altText, from: "quoted" });
    if (out.length >= Math.min(freeSlots, MAX_DRAFT_IMAGES)) break;
  }
  return out;
}

// ── The column ──────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;

/**
 * What the rows quote and answer, by target id; null when the column cannot
 * be read. Read apart from `TARGET_COLUMNS`, like the media: the column
 * arrives with migration 20261114180000, and a select naming a column the
 * database does not have yet fails whole. Only rows with something recorded.
 */
export async function loadReferenced(
  supabase: SupabaseClient,
  businessId: string,
  ids: readonly string[]
): Promise<Map<string, ReferencedPosts> | null> {
  if (ids.length === 0) return new Map();
  const { data, error } = await supabase
    .from("placement_targets")
    .select("id, referenced_posts")
    .eq("business_id", businessId)
    .in("id", [...ids]);
  if (error) return null;
  const out = new Map<string, ReferencedPosts>();
  for (const row of (data ?? []) as Row[]) {
    const state = parseReferenced(row.referenced_posts);
    if (state) out.set(row.id as string, state);
  }
  return out;
}

/** A target row with what it references on it, as `mapTarget` reads it; unchanged when the column could not be read. */
export function withReferenced(row: Row, referenced: Map<string, ReferencedPosts> | null): Row {
  if (!referenced) return row;
  return { ...row, referenced_posts: referenced.get(row.id as string) ?? null };
}

/**
 * Records what a post quotes and answers on its row. A database without the
 * column yet refuses it, and that is logged and nothing else: the context is
 * a help to the drafter, never a reason to lose the post.
 */
export async function saveTargetReferenced(
  supabase: SupabaseClient,
  where: { businessId: string; id?: string; externalId?: string; surface?: string },
  state: ReferencedPosts
): Promise<boolean> {
  let query = supabase.from("placement_targets").update({ referenced_posts: state }).eq("business_id", where.businessId);
  if (where.id) query = query.eq("id", where.id);
  else if (where.externalId) query = query.eq("external_id", where.externalId).eq("surface", where.surface ?? "x");
  else return false;
  const { error } = await query;
  if (error) {
    console.warn(JSON.stringify({ level: "warn", event: "placement.referenced_not_saved", error: error.message.slice(0, 300) }));
    return false;
  }
  return true;
}
