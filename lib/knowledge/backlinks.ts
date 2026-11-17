import type { CanonicalArticle } from "@/lib/content/types";
import { withDateModified } from "@/lib/publishing/seo";
import { applyInternalLinks, findPhraseAnchor, linksTo } from "./linking";

/**
 * The back-link pass: when an article is published, the older published
 * articles of the same site that share its topics each get ONE link to it.
 *
 * Internal links used to point only backwards (a new article links to older
 * ones, docs/KNOWLEDGE.md), so the newest article, the one with no history,
 * was also the one nothing on the site linked to.
 *
 * This file is the pure part: which older articles, and the link itself.
 * Reading the graph, asking the model, storing and delivering belong to the
 * workflow (lib/jobs/workflows/backlink-article.ts). The verified-anchor
 * rule is the existing one (`applyInternalLinks`): an anchor that does not
 * match a single text node character for character is dropped, and the
 * older article is left exactly as it was.
 */

/** At most this many older articles are changed for one new article. */
export const MAX_BACKLINKS = 3;

/** The newly published article every link points to. */
export interface BacklinkTarget {
  articleId: string;
  title: string;
  keyword: string;
  /** Where it is live: the link's href. */
  url: string;
}

export interface BacklinkCandidate {
  articleId: string;
  canonical: CanonicalArticle;
}

/**
 * The older articles to change, from candidates ranked closest first: never
 * the new article itself, never one twice, never one that already links to
 * it (in the graph's record or in its body), and never more than
 * `MAX_BACKLINKS`.
 */
export function planBacklinks<T extends BacklinkCandidate>(params: {
  target: BacklinkTarget;
  /** Related published articles, closest first. */
  candidates: readonly T[];
  /** Articles `article_links` already records a link from, to the target. */
  alreadyLinkedFrom?: Iterable<string>;
  max?: number;
}): T[] {
  const { target } = params;
  const linked = new Set(params.alreadyLinkedFrom ?? []);
  const cap = Math.min(params.max ?? MAX_BACKLINKS, MAX_BACKLINKS);
  const seen = new Set<string>();
  const chosen: T[] = [];
  for (const candidate of params.candidates) {
    if (chosen.length >= cap) break;
    if (candidate.articleId === target.articleId) continue;
    if (seen.has(candidate.articleId)) continue;
    seen.add(candidate.articleId);
    if (linked.has(candidate.articleId)) continue;
    if (linksTo(candidate.canonical.bodyHtml, target.url)) continue;
    chosen.push(candidate);
  }
  return chosen;
}

export type BacklinkOutcome =
  | {
      linked: true;
      /** The older article with the link in its body, stamped as modified. */
      canonical: CanonicalArticle;
      anchor: string;
      /** "keyword": the older article already wrote the new one's keyword (no model). "agent": the model picked the span. */
      via: "keyword" | "agent";
    }
  | { linked: false; reason: string };

/**
 * Adds ONE link to `target` in an older article, or leaves it untouched.
 *
 * First without a model: if the older article writes the new one's keyword
 * verbatim, that span is the anchor. Otherwise `suggestAnchor` (the
 * internal-links agent, on the fast tier) is asked for a span; whatever it
 * answers is verified against the body like any other anchor, so a span it
 * invented changes nothing. `suggestAnchor` is not called at all when the
 * keyword was enough.
 */
export async function placeBacklink(params: {
  target: BacklinkTarget;
  older: CanonicalArticle;
  suggestAnchor?: (older: CanonicalArticle) => Promise<string | null>;
  now?: Date;
}): Promise<BacklinkOutcome> {
  const { target, older } = params;
  if (older.articleId === target.articleId) return { linked: false, reason: "an article never links to itself" };
  if (linksTo(older.bodyHtml, target.url)) return { linked: false, reason: "already links to the new article" };

  const attempt = (anchor: string, via: "keyword" | "agent"): BacklinkOutcome => {
    const result = applyInternalLinks(older.bodyHtml, [{ targetArticleId: target.articleId, anchor, href: target.url }]);
    if (result.applied.length !== 1) {
      return { linked: false, reason: result.skipped[0]?.reason ?? "anchor not applied" };
    }
    return {
      linked: true,
      canonical: withDateModified({ ...older, bodyHtml: result.bodyHtml }, params.now),
      anchor,
      via,
    };
  };

  const fromKeyword = findPhraseAnchor(older.bodyHtml, target.keyword);
  if (fromKeyword) {
    const outcome = attempt(fromKeyword, "keyword");
    if (outcome.linked) return outcome;
  }

  if (!params.suggestAnchor) return { linked: false, reason: "the article does not write the new one's keyword" };
  const suggested = (await params.suggestAnchor(older))?.trim();
  if (!suggested) return { linked: false, reason: "no natural anchor in this article" };
  return attempt(suggested, "agent");
}
