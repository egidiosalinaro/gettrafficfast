import { newQueries, normalizeQuery } from "./queries";
import type { ProposedPrompt } from "@/lib/agents/propose-prompts";

/**
 * What the settings screen is allowed to show after the model has spoken.
 *
 * The agent can return keyword-shaped leftovers ("AEO vs SEO") and duplicates
 * of the current set. Those are dropped here, not trusted to the prompt. If
 * the filter leaves fewer than eight, that is what is shown — filling the
 * gap with invented questions would be worse than a short list.
 */

const STOP_DEFINITIONS = [
  /^what is\b/i,
  /^what's\b/i,
  /^define\b/i,
  /^meaning of\b/i,
];

export function looksLikeKeyword(query: string): boolean {
  const words = normalizeQuery(query).split(" ").filter(Boolean);
  if (words.length === 0) return true;
  if (STOP_DEFINITIONS.some((re) => re.test(query))) return true;
  // A short fragment with no question and no "how/best/vs/for" is the shape
  // of an imported keyword, not of a prompt a person would type.
  const hasAsk =
    /\?/.test(query) ||
    /\b(how|best|tool|software|platform|should|can i|do i)\b/i.test(query);
  return words.length < 4 && !hasAsk;
}

export function finalizeSuggestions(
  incoming: ProposedPrompt[],
  existing: string[]
): ProposedPrompt[] {
  const candidates = incoming.filter((item) => !looksLikeKeyword(item.query));
  const { fresh } = newQueries(candidates, existing);
  return fresh;
}
