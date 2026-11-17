import { QUESTION_SOURCE } from "./questions";

/**
 * Where a topic of the pool (`keywords.source`) came from, as the Content
 * screen and `get_content` say it.
 *
 *   "question"   asked in a public thread discovery found (lib/keywords/
 *                questions.ts): added by a person from "Questions people
 *                ask", or by Autopilot on its own (docs/AUTOPILOT.md);
 *   "autopilot"  bought by Autopilot's top-up (one model call);
 *   "manual"     added by a person, on the screen or with their API key.
 *
 * Recorded since 14 November 2026. A row from before has `source` null
 * except for questions, and nothing tells a keyword typed by hand from one
 * Autopilot bought: it reads "unknown", said in words, never guessed.
 */

export const AUTOPILOT_SOURCE = "autopilot";
export const MANUAL_SOURCE = "manual";

export const TOPIC_SOURCES = ["question", "autopilot", "manual", "unknown"] as const;
export type TopicSource = (typeof TOPIC_SOURCES)[number];

/** The stored value as one of the four; anything else (null, a value this build does not know) is "unknown". */
export function topicSource(stored: unknown): TopicSource {
  if (stored === QUESTION_SOURCE) return "question";
  if (stored === AUTOPILOT_SOURCE) return "autopilot";
  if (stored === MANUAL_SOURCE) return "manual";
  return "unknown";
}

/** What the screen prints under a topic. A question prints its thread instead (AskedInPublicThread). */
export const TOPIC_SOURCE_LABEL: Record<TopicSource, string> = {
  question: "Asked in a public thread",
  autopilot: "Autopilot",
  manual: "Added by you",
  unknown: "Source not recorded",
};
