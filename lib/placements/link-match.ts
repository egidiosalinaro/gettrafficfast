import { checkPublishedUrl, replyLinkKey, replyLinkSurface } from "./published-url";
import { replyWords } from "./published-text";
import { surfaceLabel } from "./surfaces";

/**
 * Which posted reply a pasted link belongs to.
 *
 * The link to a reply was asked for on the reply's own card, so adding
 * yesterday's five links meant finding five cards. Since 2026-11-10 the
 * links can be pasted in one place, and this decides where each one goes.
 * It never stores a guess:
 *
 * - On X the reply's text can be read back (public oEmbed) and compared with
 *   the draft that was posted. The link is assigned without asking only when
 *   exactly one posted reply still missing its link matches that text
 *   closely. The person often edits a draft on X before posting, and oEmbed
 *   does not say which post a reply answers, so anything less sure (no
 *   text read, no close match, two close matches) is a question: the
 *   candidates are shown and the person picks with one tap.
 * - Anywhere else nothing can be read. The link is assigned only when
 *   exactly one posted reply on that platform has no link; otherwise the
 *   person picks.
 *
 * A link is offered only to replies it could be saved on
 * (`checkPublishedUrl`): the right platform, not the thread's own address.
 */

export interface LinkCandidate {
  id: string;
  surface: string;
  /** The thread the reply was posted under. */
  url: string;
  /** The text that went out as far as it is known: the draft marked as posted. Null when none is on record. */
  replyText: string | null;
}

export type LinkMatch =
  | { kind: "assign"; link: string; targetId: string }
  | { kind: "pick"; link: string; candidateIds: string[]; why: string }
  | { kind: "refused"; link: string; error: string };

/** How alike two texts must be for a link to be assigned without asking. */
export const CLOSE_MATCH = 0.6;

/** Fewer words than this cannot tell one reply from another. */
const MIN_WORDS = 4;

function words(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/https?:\/\/\S+/g, " ")
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .split(" ")
      .filter(Boolean)
  );
}

/**
 * How much of two texts' vocabulary is shared, from 0 to 1 (Dice on the sets
 * of words). 0 when either is too short to tell: a three-word reply matches
 * too many drafts to mean anything.
 */
export function textSimilarity(a: string, b: string): number {
  const left = words(a);
  const right = words(b);
  if (left.size < MIN_WORDS || right.size < MIN_WORDS) return 0;
  let shared = 0;
  for (const word of left) if (right.has(word)) shared += 1;
  return (2 * shared) / (left.size + right.size);
}

/**
 * Where one link goes. `readText` is the reply's text read from X, or null
 * when it was not read (another platform, or X would not hand it over).
 * `taken` holds the keys (`replyLinkKey`) of links already saved on a reply.
 */
export function matchReplyLink(input: {
  link: string;
  readText: string | null;
  candidates: readonly LinkCandidate[];
  taken?: ReadonlySet<string>;
}): LinkMatch {
  const link = input.link.trim();
  const key = replyLinkKey(link);
  if (!key) return { kind: "refused", link, error: "That is not a web address." };
  if (input.taken?.has(key)) return { kind: "refused", link, error: "This link is already saved on a reply." };

  const surface = replyLinkSurface(link);
  const onSurface = input.candidates.filter((c) => (surface ? c.surface === surface : replyLinkSurface(c.url) === null));
  const where = surface ? ` on ${surfaceLabel(surface)}` : "";
  if (onSurface.length === 0) {
    return { kind: "refused", link, error: `No posted reply${where} is waiting for its link.` };
  }
  const checks = onSurface.map((c) => ({ candidate: c, check: checkPublishedUrl(link, c) }));
  const pool = checks.filter((c) => c.check.ok).map((c) => c.candidate);
  if (pool.length === 0) {
    const first = checks[0].check;
    return { kind: "refused", link, error: first.ok ? "This link cannot be saved." : first.error };
  }

  if (surface === "x") {
    const read = input.readText ? replyWords(input.readText) : "";
    if (!read) {
      return { kind: "pick", link, candidateIds: pool.map((c) => c.id), why: "X did not hand this reply's text over, so it cannot be matched. Pick the reply it belongs to." };
    }
    const scored = pool
      .map((c) => ({ id: c.id, score: c.replyText ? textSimilarity(read, c.replyText) : 0 }))
      .sort((a, b) => b.score - a.score);
    const close = scored.filter((s) => s.score >= CLOSE_MATCH);
    if (close.length === 1) return { kind: "assign", link, targetId: close[0].id };
    return {
      kind: "pick",
      link,
      candidateIds: scored.map((s) => s.id),
      why:
        close.length > 1
          ? "More than one posted reply reads like this one. Pick the reply it belongs to."
          : "No posted reply reads closely like this one (it may have been edited on X). Pick the reply it belongs to.",
    };
  }

  if (pool.length === 1) return { kind: "assign", link, targetId: pool[0].id };
  return {
    kind: "pick",
    link,
    candidateIds: pool.map((c) => c.id),
    why: `${pool.length} posted replies${where} have no link, and nothing here can tell which one this is. Pick the reply it belongs to.`,
  };
}

/**
 * Several links, in order. A reply a link was assigned to is no longer a
 * candidate for the next one, and the same link pasted twice is refused the
 * second time.
 */
export function matchReplyLinks(input: {
  links: readonly string[];
  readTexts: Readonly<Record<string, string | null>>;
  candidates: readonly LinkCandidate[];
  taken?: ReadonlySet<string>;
}): LinkMatch[] {
  let candidates = [...input.candidates];
  const taken = new Set(input.taken ?? []);
  return input.links.map((link) => {
    const match = matchReplyLink({ link, readText: input.readTexts[link] ?? null, candidates, taken });
    if (match.kind === "assign") {
      candidates = candidates.filter((c) => c.id !== match.targetId);
      const key = replyLinkKey(link);
      if (key) taken.add(key);
    }
    return match;
  });
}

/**
 * The words the person posted, as far as they are on record: the text read
 * back from X, else the draft marked as posted, else the draft the card
 * would have shown. Null when the row has no text at all.
 */
export function postedReplyText(target: {
  publishedText?: string | null;
  selectedPlacementId: string | null;
  drafts: readonly { id: string; body: string }[];
}): string | null {
  const read = target.publishedText?.trim();
  if (read) return read;
  const selected = target.drafts.find((d) => d.id === target.selectedPlacementId) ?? target.drafts[0];
  return selected?.body.trim() || null;
}
