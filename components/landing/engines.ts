/**
 * Which answer engines the public pages may name, and how.
 *
 * Both engines are switched on by the operator, per deployment: Gemini by
 * `CITATIONS_GEMINI`, Perplexity by its key. The landing used to name both
 * unconditionally ("Perplexity · when enabled"), which reads like a feature
 * that has not shipped. The server page reads the registry and passes the
 * list down; these helpers only turn that list into words, so a client
 * component can use them without pulling the provider layer into the bundle.
 * The short names are the app's own (`engineLabel`), so the landing and the
 * dashboard cannot spell an engine two ways.
 */

import { engineLabel } from "@/lib/domain/operating-loop";

export const ANSWER_ENGINES = ["gemini", "perplexity"] as const;
export type AnswerEngine = (typeof ANSWER_ENGINES)[number];

const LONG: Record<AnswerEngine, string> = {
  gemini: "Gemini with Google Search",
  perplexity: "Perplexity",
};

/** Keeps only the engines this page knows how to name, in a stable order. */
export function toAnswerEngines(names: readonly string[]): AnswerEngine[] {
  const set = new Set(names);
  return ANSWER_ENGINES.filter((engine) => set.has(engine));
}

export function engineName(engine: AnswerEngine): string {
  return engineLabel(engine);
}

/** "Gemini with Google Search and Perplexity", or "" when none is on. */
export function engineSentence(engines: readonly AnswerEngine[]): string {
  const names = engines.map((engine) => LONG[engine]);
  if (names.length <= 1) return names[0] ?? "";
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}
