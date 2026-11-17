import { z } from "zod";
import { engineLabel } from "@/lib/domain/operating-loop";

/**
 * The AI Visibility sighting a reply target rests on
 * (`placement_targets.ai_citation`, migration 20261110180000).
 *
 * A run asked an answer engine one of the site's prompts and the answer
 * cited this page. That is one sampled answer on one day: it does not say
 * the engine always reads the page, and the words on the card say "sampled".
 * Engines are kept per prompt and named, never merged into a number.
 */

/** `found_via` of a row a visibility run created, and `qualified_by` of its verdict. */
export const AI_VISIBILITY_SOURCE = "ai_visibility";

/** Prompts kept on the row. The count of all of them is kept beside. */
export const MAX_CITATION_PROMPTS = 5;

export const AiCitationPrompt = z.object({
  /** The prompt's id while it is in the set; null once it was deleted. */
  queryId: z.string().nullable(),
  /** The prompt as it was asked, verbatim. */
  query: z.string().min(1),
  /** The engines whose sampled answer cited the page for this prompt. */
  engines: z.array(z.string().min(1)).min(1),
});

export const AiCitation = z.object({
  runId: z.string().nullable(),
  /** When the run's answers were read. */
  checkedAt: z.string().nullable(),
  /** Every prompt of that run whose answer cited the page; `prompts` holds the first few. */
  promptCount: z.number().int().min(1),
  prompts: z.array(AiCitationPrompt).min(1).max(MAX_CITATION_PROMPTS),
});
export type AiCitation = z.infer<typeof AiCitation>;

/** Tolerant read: a malformed or absent column is "no sighting", never a guess. */
export function parseAiCitation(value: unknown): AiCitation | null {
  if (value === null || value === undefined) return null;
  const parsed = AiCitation.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** "Gemini", "Gemini and Perplexity": the engines by name, in the order given. */
export function engineList(engines: readonly string[]): string {
  const names = engines.map(engineLabel);
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/**
 * The one line the card shows: which prompt, which engine, and that it is a
 * sample. More prompts than the first are counted, not listed.
 */
export function aiCitationLine(citation: AiCitation): string {
  const first = citation.prompts[0];
  const more = citation.promptCount - 1;
  const rest = more > 0 ? `, and ${more} more prompt${more === 1 ? "" : "s"}` : "";
  return `Cited in a sampled AI answer for: “${first.query}” (${engineList(first.engines)})${rest}.`;
}
