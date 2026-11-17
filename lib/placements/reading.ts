import { z } from "zod";
import { clampText } from "@/lib/content/text";

/**
 * How a post is read before a reply to it is written.
 *
 * The case (fictional names): @DanaShips posted on X: "Every time one of my
 * LinkedIn posts gets traction, some 50+ year old CEO turns up to call me a
 * scammer. For sharing my own revenue. Is this the price of posting???"
 * He was mocking the CEOs. The draft read it as a complaint ("it's
 * frustrating when that happens…") and offered sympathy for a problem he
 * does not have. So the drafter now says how it reads the post before it
 * writes, in the same call: the tone, and one line of what the poster
 * actually means. The reply is written to fit that reading, and the reading
 * is kept beside the draft's audit, so the owner's correction can overrule
 * it and the next rewrite starts from the right one.
 *
 * It is the model's reading, a judgement, not a measurement: it is stored
 * as what the drafter thought, and nothing is computed from it.
 */

export const POST_TONES = ["sincere", "ironic", "joke", "rant", "question"] as const;
export type PostTone = (typeof POST_TONES)[number];

export const READING_MEANS_MAX = 200;

export const PostReading = z.object({
  tone: z.enum(POST_TONES),
  /** One line: what the poster actually means. */
  means: z.string().min(1).max(READING_MEANS_MAX),
});
export type PostReading = z.infer<typeof PostReading>;

/** What a model returned, or what is stored, as a reading; null when it is not one. Never a guess. */
export function parseReading(raw: unknown): PostReading | null {
  if (!raw || typeof raw !== "object") return null;
  const { tone, means } = raw as { tone?: unknown; means?: unknown };
  if (typeof tone !== "string" || typeof means !== "string") return null;
  const parsed = PostReading.safeParse({ tone: tone.trim().toLowerCase(), means: clampText(means.trim(), READING_MEANS_MAX) });
  return parsed.success ? parsed.data : null;
}

/** The step every writer takes first, in the words the drafter and the correction share. */
export const READ_THE_POST = [
  `Read the post before you write. Decide its tone: "sincere" (they mean it as written), "ironic" (they mean the opposite, or are mocking someone), "joke", "rant" (venting, not asking) or "question" (they want an answer). Then say in one line what the poster actually means, which is not always what the words say: "Is this just how it has to be???" after a story about being called a scammer is a jab at the people who said it, not a request for advice.`,
  `Write the reply to fit that reading. An ironic post or a joke gets a reply that plays along or adds a sharper example of the same thing, never sympathy for a problem the poster does not have and never advice they did not ask for. A rant gets agreement or a dry line, not a fix. Only a sincere post or a question gets a straight answer.`,
].join(" ");

/** The reading as one line of a prompt. */
export function describeReading(reading: PostReading): string {
  return `${reading.tone}: ${reading.means}`;
}
