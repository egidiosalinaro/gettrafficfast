/**
 * The topics a business can speak to, as the qualifier and the drafter are
 * told them: its keywords and the entities of its knowledge graph, each once,
 * with the business's own names removed.
 *
 * The brand is not a topic. For a site whose knowledge graph is its own
 * product, the entity list carries the product name (twice, for
 * GetTrafficFast) beside the things the business actually knows about, and a
 * model handed "GetTrafficFast" under "topics they know about" reads it as
 * permission to write about the product. The one place the product may be
 * named is the disclosure, and the drafter is told that separately.
 */
export const MAX_TOPICS = 40;

export function topicsFor(keywords: string[], entities: string[], brandNames: string[]): string[] {
  const brands = new Set(brandNames.map((name) => name.trim().toLowerCase()).filter(Boolean));
  const seen = new Set<string>();
  const topics: string[] = [];
  for (const raw of [...keywords, ...entities]) {
    const topic = raw.trim();
    const key = topic.toLowerCase();
    if (!topic || brands.has(key) || seen.has(key)) continue;
    seen.add(key);
    topics.push(topic);
    if (topics.length === MAX_TOPICS) break;
  }
  return topics;
}
