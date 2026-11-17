import { READ_NEXT_COUNT, type ReadNextItem } from "@/lib/content/anatomy";
import { keywordTokens, wordSimilarity } from "@/lib/keywords/duplicates";

/**
 * Which published articles the "Read next" block lists (2026-11-15,
 * docs/KNOWLEDGE.md "Read next"). Pure: candidates in, a choice out. The
 * block itself is written by `withReadNext` (lib/content/anatomy.ts).
 *
 * Only articles a reader can reach: every candidate is live (its
 * `published_url` set by a delivery that succeeded), of the same site, and
 * never the article itself. No address is made up: the href is the one the
 * destination answered with.
 */

export interface ReadNextCandidate {
  articleId: string;
  title: string;
  keyword: string;
  /** Where it is live. */
  publishedUrl: string;
}

export interface ReadNextChoice extends ReadNextItem {
  articleId: string;
}

/** Under this word similarity, an article that shares no graph node is not related enough to recommend. */
export const MIN_READ_NEXT_SIMILARITY = 0.15;

/**
 * Up to `count` articles, in this order:
 *
 * 1. related through the knowledge graph (shared entities or topics,
 *    closest first) and not already linked in the body: a new path for the
 *    reader;
 * 2. other live articles of the site whose keyword and title share words
 *    with this one (the near-duplicate rule's tokens,
 *    lib/keywords/duplicates.ts), most similar first, when the graph found
 *    too few;
 * 3. related articles the body already links to.
 *
 * Fewer than `count`, or none, when the site has fewer related articles:
 * an unrelated article is never listed to fill the block.
 */
export function pickReadNext(params: {
  source: { articleId: string; keyword: string; title: string };
  /** From `findRelatedArticles`, closest first. */
  related: readonly ReadNextCandidate[];
  /** Other live articles of the site, for the word-similarity fallback. */
  others?: readonly ReadNextCandidate[];
  /** The hrefs the body already links to. */
  linkedInBody?: Iterable<string>;
  count?: number;
}): ReadNextChoice[] {
  const count = params.count ?? READ_NEXT_COUNT;
  const linked = new Set(params.linkedInBody ?? []);
  const chosen: ReadNextChoice[] = [];
  const seen = new Set<string>([params.source.articleId]);
  const seenHref = new Set<string>();

  const take = (candidate: ReadNextCandidate) => {
    if (chosen.length >= count) return;
    if (seen.has(candidate.articleId) || seenHref.has(candidate.publishedUrl)) return;
    if (!candidate.title.trim() || !candidate.publishedUrl.trim()) return;
    seen.add(candidate.articleId);
    seenHref.add(candidate.publishedUrl);
    chosen.push({ articleId: candidate.articleId, title: candidate.title.trim(), href: candidate.publishedUrl });
  };

  for (const candidate of params.related) if (!linked.has(candidate.publishedUrl)) take(candidate);

  const mine = keywordTokens(`${params.source.keyword} ${params.source.title}`);
  const similar = (params.others ?? [])
    .map((candidate) => ({
      candidate,
      similarity: wordSimilarity(mine, keywordTokens(`${candidate.keyword} ${candidate.title}`)).jaccard,
    }))
    .filter((entry) => entry.similarity >= MIN_READ_NEXT_SIMILARITY)
    .sort((a, b) => b.similarity - a.similarity);
  for (const { candidate } of similar) if (!linked.has(candidate.publishedUrl)) take(candidate);

  for (const candidate of params.related) take(candidate);
  return chosen;
}
