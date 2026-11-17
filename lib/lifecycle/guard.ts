import { CanonicalArticle } from "@/lib/content/types";

/**
 * The refresh guard.
 *
 * A refresh is asked to EDIT an article, but a language model handed a whole
 * document can quietly return a shorter, thinner one. The quality gates prove
 * the new document is well-formed; they cannot know it lost half the article.
 * This compares it against what it would replace, and a refresh that loses
 * substance is discarded — the live version stays live.
 *
 * Losing a refresh beats replacing a working article with less of it.
 */

/** A refresh may tighten prose, but not gut the piece. */
export const MIN_WORD_RATIO = 0.7;

/** Sections may be merged; wholesale disappearance is a different article. */
export const MAX_SECTIONS_LOST = 1;

export interface RefreshAssessment {
  safe: boolean;
  reason: string;
}

export function assessRefresh(
  previous: CanonicalArticle,
  next: CanonicalArticle
): RefreshAssessment {
  if (previous.wordCount > 0) {
    const ratio = next.wordCount / previous.wordCount;
    if (ratio < MIN_WORD_RATIO) {
      return {
        safe: false,
        reason: `the refresh lost ${Math.round((1 - ratio) * 100)}% of the article (${previous.wordCount} → ${next.wordCount} words)`,
      };
    }
  }

  const before = previous.headings.filter((h) => h.level === 2).length;
  const after = next.headings.filter((h) => h.level === 2).length;
  if (before - after > MAX_SECTIONS_LOST) {
    return {
      safe: false,
      reason: `the refresh dropped ${before - after} sections (${before} → ${after})`,
    };
  }

  return { safe: true, reason: `${previous.wordCount} → ${next.wordCount} words, ${before} → ${after} sections` };
}
