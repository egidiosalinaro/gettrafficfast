/**
 * Which sentences of a draft carry a number that is a claim, and which of
 * those nobody declared.
 *
 * A figure is a claim: "a 43% lift", "2,000 customers", "3x the traffic".
 * The gate refuses one that is neither declared by the drafter (`claims`)
 * nor stated in About you (Settings → Voice), because a number nobody can
 * check reads as fact (docs/PLACEMENTS.md, "The gate").
 *
 * A figure of speech is not a claim. On 12 November 2026 the owner's reply
 * said "during the last week i'm going 100% on marketing for both my
 * startups too", and the check failed: "1 sentence(s) with numbers not
 * declared as claims". Nobody reads "going 100% on" as a measurement. So a
 * short, tested list of idioms is blanked before the number is looked for.
 * It is conservative on purpose: "100% of my customers" is still a claim,
 * and so is "revenue grew 110%". Only a phrase that is an idiom in every
 * reading is on the list.
 *
 * Pure: no I/O. Imported by the gate (lib/placements/audit.ts) and by the
 * Replies item, which lists the flagged sentences under the check.
 */

export const NUMERIC_CLAIM =
  /(\d+(\.\d+)?\s?%|\b\d+x\b|\b(\d{1,3}(,\d{3})+|\d{4,})\s+(users|customers|companies|clients|sites|downloads|stars|installs)|\b(double|triple|halve)[sd]?\b)/i;

/** The idioms a person means as emphasis, not as a figure. What the docs list, in the order they list them. */
export const IDIOMATIC_NUMBERS: ReadonlyArray<{ phrase: string; pattern: RegExp }> = [
  {
    // "going 100% on marketing", "giving 110% to it", "all in, 100% into it". The percent
    // is the effort, and the word after it ("on", "in", "into", "to") says so. Never "of".
    phrase: "going 100% on",
    pattern:
      /\b(?:go|goes|going|went|gone|give|gives|giving|gave|given|put|puts|putting|all in,?)\s+(?:it\s+|this\s+|everything\s+)?(?:100|110|1000)\s?%\s+(?:on|in|into|to|at|for)\b/gi,
  },
  {
    // "give it 110%", "giving it 100%": the effort, with nothing after it.
    phrase: "110%",
    pattern: /\b(?:give|gives|giving|gave|given)\s+(?:it|this|everything|them)\s+(?:100|110|1000)\s?%/gi,
  },
  {
    // "100% agree", "100% this", "110% sure": agreement or certainty, never a share of something.
    phrase: "100% agree",
    pattern:
      /\b(?:100|110|1000)\s?%\s+(?:agree|agreed|sure|certain|this|that|true|right|with you|behind (?:you|this|it)|committed|serious|honest|on board)\b/gi,
  },
  { phrase: "24/7", pattern: /\b24\/7\b/g },
  { phrase: "one of the", pattern: /\bone of the\b/gi },
  { phrase: "a million times", pattern: /\ba (?:million|thousand|hundred) times\b/gi },
  { phrase: "zero chance", pattern: /\bzero (?:chance|clue|idea|interest|doubt)\b/gi },
];

/** The text with every idiomatic number blanked, same length, so positions still line up. */
export function withoutIdioms(text: string): string {
  let out = text;
  for (const idiom of IDIOMATIC_NUMBERS) {
    out = out.replace(new RegExp(idiom.pattern.source, idiom.pattern.flags), (match) => " ".repeat(match.length));
  }
  return out;
}

/** The sentences of a text, split the way the gate splits them. */
export function claimSentences(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** True when a sentence carries a number that is a claim, once the idioms are set aside. */
export function hasNumericClaim(sentence: string): boolean {
  return NUMERIC_CLAIM.test(withoutIdioms(sentence));
}

/** A figure as two texts write it alike: lower case, one space, "40 %" as "40%". */
function figureKey(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").replace(/(\d)\s+%/g, "$1%").trim();
}

/** The figures that are claims in a sentence, as written: "43%", "2,000 customers", "3x". */
export function numericClaimsIn(sentence: string): string[] {
  const global = new RegExp(NUMERIC_CLAIM.source, "gi");
  return [...withoutIdioms(sentence).matchAll(global)].map((match) => match[0]);
}

/**
 * True when every figure the sentence claims is stated in About you. The
 * person wrote it there, or confirmed it with "It's true" (lib/voice/about-you.ts),
 * so it is declared: the same as a claim the drafter listed. Whether it fits
 * the post is asked separately (lib/placements/fact-fit.ts).
 */
export function declaredByAboutYou(sentence: string, aboutYou: string): boolean {
  const figures = numericClaimsIn(sentence);
  if (figures.length === 0) return true;
  const recorded = figureKey(aboutYou);
  if (!recorded) return false;
  return figures.every((figure) => {
    const key = figureKey(figure).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?<![\\p{L}\\p{N}.,])${key}(?![\\p{L}\\p{N}])`, "u").test(recorded);
  });
}

/**
 * The sentences whose numbers are claims nobody declared: not in a claim
 * the drafter listed, not stated in About you. What the gate counts, and
 * what "It's true: add to About you" is offered for.
 */
export function undeclaredNumberSentences(body: string, claims: readonly string[], aboutYou: string): string[] {
  const claimed = claims.map((c) => c.toLowerCase()).filter((c) => c.length > 0);
  return claimSentences(body)
    .filter(hasNumericClaim)
    .filter((s) => !claimed.some((c) => s.toLowerCase().includes(c) || c.includes(s.toLowerCase().slice(0, 40))))
    .filter((s) => !declaredByAboutYou(s, aboutYou));
}

/**
 * The sentences an audit stored before 12 November 2026 counted as
 * undeclared numbers, read back from the text: every numeric sentence the
 * drafter did not list, idioms included, because that gate had no idioms.
 * The Replies item uses it only for an old audit that names no sentences,
 * so the owner can still confirm the sentence that was flagged.
 */
export function legacyNumberSentences(body: string, claims: readonly string[]): string[] {
  const claimed = claims.map((c) => c.toLowerCase()).filter((c) => c.length > 0);
  return claimSentences(body)
    .filter((s) => NUMERIC_CLAIM.test(s))
    .filter((s) => !claimed.some((c) => s.toLowerCase().includes(c) || c.includes(s.toLowerCase().slice(0, 40))));
}
