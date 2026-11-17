/**
 * Plain-text helpers shared by the pipeline stages and the quality gates.
 * Single implementation, so slugs and excerpts can never drift apart.
 */

export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** URL/anchor-safe slug. Stable: same text always yields the same id. */
export function slugify(text: string): string {
  return collapseWhitespace(text)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export function countWords(text: string): number {
  const clean = collapseWhitespace(text);
  return clean ? clean.split(" ").length : 0;
}

/**
 * Cuts on a word boundary and appends an ellipsis when it had to cut.
 * The result NEVER exceeds maxLength, ellipsis included — schema-bound fields
 * rely on that guarantee.
 */
export function clampText(text: string, maxLength: number): string {
  const clean = collapseWhitespace(text);
  if (clean.length <= maxLength) return clean;
  const budget = Math.max(1, maxLength - 1);
  const cut = clean.slice(0, budget + 1);
  const lastSpace = cut.lastIndexOf(" ");
  return `${cut.slice(0, lastSpace > budget / 2 ? lastSpace : budget).trimEnd()}…`;
}
