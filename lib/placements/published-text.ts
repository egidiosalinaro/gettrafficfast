import type { SupabaseClient } from "@supabase/supabase-js";
import { OEMBED_TIMEOUT_MS, readXPost, type XPost } from "@/lib/providers/x/oembed";
import { xStatusIdOf } from "./published-url";

/**
 * The words a person actually posted, read back from the link to their reply.
 *
 * A draft is not what went out: the owner often edits it on X before he
 * posts, and the drafting loop learns the voice from the last replies posted,
 * so it needs the published words. There is no paid X API here. When the
 * link to the reply is an X status, X's public oEmbed (the endpoint every
 * site that embeds a post calls, `lib/providers/x/oembed.ts`) hands back its
 * text, and that text is stored on the target as `published_text`, with the
 * moment it was read as `published_text_at`.
 *
 * Nothing here may cost the person anything: a link that is not an X status
 * is skipped, and a post X will not hand over (protected, deleted, timed
 * out), a link changed in the meantime, or a write that fails is logged and
 * leaves the row as it was. It never throws. A text that is not there stays
 * null ("not read"), never an empty string, and `ensurePublishedText` tries
 * again later.
 */

export type ReadPost = (url: string) => Promise<XPost | null>;

export type CaptureResult =
  | { ok: true; text: string; at: string }
  | {
      ok: false;
      reason:
        /** Not a link to a post on X: nothing to read for free. */
        | "not_x"
        /** The row is gone, no longer posted, or carries another link now. */
        | "link_changed"
        /** X did not hand the post over (protected, deleted, timeout, odd answer). */
        | "unread"
        /** The post is by the account the reply answered: not the person's words. */
        | "not_theirs"
        /** Nothing left once the @handles in front of the reply are removed. */
        | "no_words"
        /** The row could not be read or written. */
        | "store_failed";
    };

export interface CaptureOptions {
  /**
   * The link the row carried before this one was saved. When it differs, the
   * text read from it is cleared first: it is not the text of the new link,
   * and the row says "not read" until the new one is read.
   */
  previousUrl?: string | null;
  /** Reads the post from X; the oEmbed reader unless a test replaces it. */
  readPost?: ReadPost;
  now?: Date;
}

const defaultReadPost: ReadPost = (url) => readXPost(url, { timeoutMs: OEMBED_TIMEOUT_MS });

/** X puts the accounts a reply answers in front of its text: addressing, not words the person typed. */
const LEADING_MENTIONS = /^(?:@\w{1,15}(?:\s+|$))+/;

/** A reply's own words: the leading run of @handles removed, the rest as X shows it. */
export function replyWords(text: string): string {
  return text.trim().replace(LEADING_MENTIONS, "").trim();
}

function sameAccount(a: string | null | undefined, b: string | null | undefined): boolean {
  const norm = (v: string | null | undefined) => (v ?? "").trim().replace(/^@/, "").toLowerCase();
  return norm(a) !== "" && norm(a) === norm(b);
}

/** One structured line per skipped capture: the target and why, never the text. */
function logSkip(targetId: string, reason: string, detail?: string) {
  console.warn(
    JSON.stringify({
      level: "warn",
      event: "placements.published_text_skipped",
      target_id: targetId,
      reason,
      ...(detail ? { detail: detail.slice(0, 300) } : {}),
    })
  );
}

/**
 * Reads the reply at `url` from X and stores its text on target `targetId`.
 *
 * `admin` is the service-role client: the caller has already established
 * that the row is the person's (the action route updated it through their
 * own client first). Every write is narrowed to the row as it was meant:
 * still posted, still carrying this exact link, so a link corrected in the
 * meantime never receives the text of the one it replaced.
 *
 * Never throws; a failure is logged and the row is left as it was.
 */
export async function capturePublishedText(
  admin: SupabaseClient,
  targetId: string,
  url: string,
  options: CaptureOptions = {}
): Promise<CaptureResult> {
  try {
    if (options.previousUrl && options.previousUrl !== url) await clearStaleText(admin, targetId, url);
    if (!xStatusIdOf(url)) return { ok: false, reason: "not_x" };

    const { data: row, error: readError } = await admin
      .from("placement_targets")
      .select("status, published_url, author")
      .eq("id", targetId)
      .maybeSingle();
    if (readError) {
      logSkip(targetId, "store_failed", readError.message);
      return { ok: false, reason: "store_failed" };
    }
    const current = row as { status?: unknown; published_url?: unknown; author?: unknown } | null;
    if (!current || current.status !== "published_manually" || current.published_url !== url) {
      logSkip(targetId, "link_changed");
      return { ok: false, reason: "link_changed" };
    }

    const readPost = options.readPost ?? defaultReadPost;
    const post = await readPost(url).catch(() => null);
    if (!post) {
      logSkip(targetId, "unread");
      return { ok: false, reason: "unread" };
    }
    // A link to the post being answered, or to its author's own follow-up,
    // passes the link check; its text is someone else's voice.
    if (sameAccount(post.handle, typeof current.author === "string" ? current.author : null)) {
      logSkip(targetId, "not_theirs");
      return { ok: false, reason: "not_theirs" };
    }
    const text = replyWords(post.text);
    if (!text) {
      logSkip(targetId, "no_words");
      return { ok: false, reason: "no_words" };
    }

    const at = (options.now ?? new Date()).toISOString();
    const { error } = await admin
      .from("placement_targets")
      .update({ published_text: text, published_text_at: at })
      .eq("id", targetId)
      .eq("status", "published_manually")
      .eq("published_url", url);
    if (error) {
      logSkip(targetId, "store_failed", error.message);
      return { ok: false, reason: "store_failed" };
    }
    return { ok: true, text, at };
  } catch (error) {
    logSkip(targetId, "store_failed", error instanceof Error ? error.message : String(error));
    return { ok: false, reason: "store_failed" };
  }
}

/**
 * Clears a text read from the link the row carried before `url`. Done here,
 * after the person's action, and not in the action's own update, so that
 * update never names a column a database may not have yet.
 */
async function clearStaleText(admin: SupabaseClient, targetId: string, url: string): Promise<void> {
  try {
    const { error } = await admin
      .from("placement_targets")
      .update({ published_text: null, published_text_at: null })
      .eq("id", targetId)
      .eq("published_url", url);
    if (error) logSkip(targetId, "clear_failed", error.message);
  } catch (error) {
    logSkip(targetId, "clear_failed", error instanceof Error ? error.message : String(error));
  }
}

/** The part of a `placement_targets` row `ensurePublishedText` looks at. */
export interface PublishedTextRow {
  id: string;
  /** When given, only `published_manually` rows are read. */
  status?: string | null;
  published_url: string | null;
  published_text: string | null;
}

/**
 * Fills in `published_text` for posted rows that have a link and no text
 * yet, reading at most `max` of them from X, and returns `rows` in the same
 * order with the texts it read filled in (`published_text`,
 * `published_text_at`). Rows with a text, with no link, with a link that is
 * not an X status, or not posted are returned as they are and do not count
 * towards `max`.
 *
 *   const rows = await ensurePublishedText(admin, postedRows, { max: 3 });
 *
 * Meant for whoever loads the last posted replies (the drafting loop's voice
 * examples): pass them newest first, so the newest are read first. Reads run
 * together, each bounded by the oEmbed timeout (6 s), so the call costs at
 * most about one timeout of latency and no money. A row X will not hand
 * over keeps a null text and is tried again on a later call. Never throws.
 */
export async function ensurePublishedText<T extends PublishedTextRow>(
  admin: SupabaseClient,
  rows: readonly T[],
  { max, readPost, now }: { max: number } & CaptureOptions
): Promise<T[]> {
  const limit = Number.isFinite(max) ? Math.max(0, Math.floor(max)) : 0;
  const wanted = rows
    .filter(
      (row) =>
        (row.status === undefined || row.status === null || row.status === "published_manually") &&
        typeof row.published_url === "string" &&
        xStatusIdOf(row.published_url) !== null &&
        !(row.published_text ?? "").trim()
    )
    .slice(0, limit);
  if (!wanted.length) return [...rows];

  const read = new Map<string, { text: string; at: string }>();
  await Promise.all(
    wanted.map(async (row) => {
      const result = await capturePublishedText(admin, row.id, row.published_url as string, { readPost, now });
      if (result.ok) read.set(row.id, { text: result.text, at: result.at });
    })
  );
  return rows.map((row) => {
    const found = read.get(row.id);
    return found ? { ...row, published_text: found.text, published_text_at: found.at } : row;
  });
}
