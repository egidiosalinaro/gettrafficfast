import { campaignMention } from "./audit";

/**
 * The sentences and words the gate refuses, taken out of a draft before it
 * is judged again.
 *
 * The model pastes the voice line ("I publish my own site's blog through
 * X", "X is what I use for that") and a tell ("truly") on every try, the
 * rewrite is told, and it pastes them again. The loop then stops and the
 * inbox shows a draft that cannot be copied. These are mechanical: the
 * sentence that carries the line is deleted, and the tell-words are
 * deleted. Nothing is put in their place. This used to swap the line for
 * "X is what I use for that", which is itself the line all 21 published
 * replies carried; a reply names no product, and an article that loses its
 * only mention here is asked again by the gate for a clause of its own.
 */

const TELL_WORDS = /\b(truly|crucial|vital|pivotal|paramount|indispensable)\b/gi;
const TELL_GENUINELY = /\bgenuinely (?=(?:effective|useful|valuable|powerful|helpful|impactful|transformative|matters?|drives?|helps?)\b)/gi;

function sentencesOf(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function tidy(text: string): string {
  return text
    .replace(TELL_GENUINELY, "")
    .replace(TELL_WORDS, "")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+([.,!?;:])/g, "$1")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * The body with every sentence that carries the refused mention deleted, and
 * the one-word tells removed. `names` are the business's own names, so every
 * form bound to them is caught, not only the pasted ones. Paragraphs stay
 * where they were.
 */
export function repairDraft(body: string, names: string[]): string {
  let text = body;
  for (const sentence of sentencesOf(body)) {
    if (campaignMention(sentence, names) !== null) text = text.replace(sentence, "");
  }
  return tidy(text);
}
