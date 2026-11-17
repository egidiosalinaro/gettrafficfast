/**
 * Does a rewrite follow the correction it was given?
 *
 * "Fix it" takes the owner's note on a draft and rewrites the draft once.
 * On 10 November 2026 the post was @DanaShips's jab at the CEOs who
 * call him a scammer for sharing his numbers, the draft read it as a
 * complaint, and the owner's note was, in Italian: "Quello non è uno
 * struggle of getting traction è un post ironico sta prendendo in giro i
 * ceo boomer over 50". The rewrite came back: "that's exactly how i
 * interpret these posts too, daniel. it seems like a common way to poke fun
 * at the struggle of getting traction, especially when sharing numbers. …"
 * It answered the note as if the poster had written it, and it kept the
 * very words the note said were wrong.
 *
 * The note is an instruction to the writer, never content to reply to.
 * Three things code can see, each with the sentence that says what to
 * change:
 *
 * - `negated`: the rewrite keeps a phrase the note rules out ("non è uno
 *   struggle of getting traction" → "struggle of getting traction"). Simple
 *   negations only, English and Italian: "is not / isn't / it's not / not
 *   a…", "non è / non era / non sono / non si tratta di…". An instruction
 *   ("do not use numbers") is not a reading ruled out and is not parsed.
 * - `echo`: the rewrite carries four or more consecutive words of the note.
 * - `answers_note`: the rewrite opens by addressing an interpretation
 *   ("that's exactly how i interpret", "as you said", "you're right that"):
 *   the poster offered none, the note did.
 *
 * Pure and deterministic. A note in another language than the reply rarely
 * shares words with it, so `echo` and `negated` catch the phrase quoted
 * from the draft or the post, which is what a note about wording quotes.
 */

export type CorrectionProblemKind = "negated" | "echo" | "answers_note";

export interface CorrectionProblem {
  kind: CorrectionProblemKind;
  /** The words in the rewrite that tripped it. */
  quote: string;
  /** What to change, in one sentence. */
  detail: string;
  /** A refusal, or a warning the reviewer sees. */
  severity: "fail" | "warn";
}

const words = (text: string): string[] =>
  text
    .toLowerCase()
    .replace(/[‘’ʼ]/g, "'")
    .split(/[^\p{L}\p{N}']+/u)
    .filter(Boolean);

/** Where a negated phrase ends: punctuation, or the word that starts what it is instead. */
const PHRASE_END = /[.,;:!?\n()"“”]|\s(?:è|e'|ma|bensì|invece|sta|sono|but|rather|instead|it's|it is|he's|she's|they're|he is|she is|they are|is|its)(?=\s)/iu;

const ARTICLE = String.raw`(?:(?:a|an|the|about|just|really|only|merely|un|uno|una|il|lo|la|i|gli|le|di|del|dello|della|sul|sullo|sulla|solo|proprio)\s+|(?:un|l|dell|sull)')*`;

const NEGATIONS: RegExp[] = [
  // it's not a…, that is not…, isn't…
  new RegExp(String.raw`(?:\b(?:is|it's|its|that's|this is|was|are|he's|she's|they're)\s+not|\b(?:isn't|wasn't|aren't))\s+${ARTICLE}`, "giu"),
  // "Not a complaint, a joke": at the start of a clause.
  new RegExp(String.raw`(?:^|[.;,!?\n]\s*)not\s+${ARTICLE}`, "giu"),
  // non è uno…, non era…, non si tratta di…
  new RegExp(String.raw`(?<![\p{L}])non\s+(?:è|e'|era|sono|erano|si tratta|parla|si parla)\s+${ARTICLE}`, "giu"),
];

/** A phrase too short to be a reading: one word, or nothing of four letters. */
function isPhrase(phrase: string[]): boolean {
  return phrase.length >= 2 && phrase.some((word) => word.length >= 4);
}

/** The phrases a note rules out: what follows "is not", "non è", up to where it says what it is instead. */
export function negatedPhrases(note: string): string[] {
  const text = note.replace(/[‘’ʼ]/g, "'");
  const phrases: string[] = [];
  for (const pattern of NEGATIONS) {
    for (const match of text.matchAll(pattern)) {
      const tail = text.slice(match.index + match[0].length);
      const end = tail.search(PHRASE_END);
      const phrase = words((end < 0 ? tail : tail.slice(0, end)).slice(0, 80));
      if (isPhrase(phrase) && !phrases.includes(phrase.join(" "))) phrases.push(phrase.join(" "));
    }
  }
  return phrases;
}

/** The first run of `size` consecutive words of `source` that `text` also carries, or null. */
function sharedRun(text: string[], source: string[], size: number): string | null {
  if (source.length < size) return null;
  const joined = ` ${text.join(" ")} `;
  for (let i = 0; i + size <= source.length; i++) {
    const run = source.slice(i, i + size);
    if (!run.some((word) => word.length >= 4)) continue;
    if (joined.includes(` ${run.join(" ")} `)) return run.join(" ");
  }
  return null;
}

/** A reply that opens by weighing someone's interpretation: the note's, since the poster gave none. */
const INTERPRETATION_OPENER =
  /^\W*(?:(?:yes|yeah|yep|right|true|exactly|agreed|totally)\W+)?(?:(?:that's|that is|this is) (?:exactly |precisely |also )?(?:how|what) i (?:interpret|read|understand|understood|took|take|see|saw)|i (?:also )?(?:interpret|read) (?:it|this|that|these|those) (?:the same|that|this) way|(?:that's|that is) (?:exactly |precisely )?my (?:read|reading|interpretation|take) (?:too|as well|of)|same (?:read|reading|interpretation) here)/i;
const AGREEMENT_OPENER = /^\W*(?:as you (?:said|say|put it|point(?:ed)? out|noted)|you(?:'re| are) (?:absolutely |totally |so )?right(?: that|,|\.| about)|good point|fair point|point taken)/i;

/** How many consecutive words of the note make an echo. */
export const ECHO_WORDS = 4;

/**
 * What a rewrite does with the correction that it should not. Empty when
 * there is no note, and when the rewrite neither quotes nor answers it.
 */
export function correctionProblems(body: string, note: string): CorrectionProblem[] {
  const correction = note.trim();
  const reply = body.replace(/[‘’ʼ]/g, "'").trim();
  if (!correction || !reply) return [];
  const replyWords = words(reply);
  const problems: CorrectionProblem[] = [];

  for (const phrase of negatedPhrases(correction)) {
    const source = phrase.split(" ");
    // A short phrase whole; a longer one by any three words of it in a row.
    const kept = sharedRun(replyWords, source, Math.min(source.length, 3));
    if (kept) {
      problems.push({
        kind: "negated",
        quote: kept,
        severity: "fail",
        detail: `Keeps what your correction ruled out: you said it is not "${phrase}", and the reply still says "${kept}". Write it without those words and without that idea.`,
      });
      break;
    }
  }

  if (problems.length === 0) {
    const echoed = sharedRun(replyWords, words(correction), ECHO_WORDS);
    if (echoed) {
      problems.push({
        kind: "echo",
        quote: echoed,
        severity: "fail",
        detail: `Repeats the words of your correction ("${echoed}"). The correction was written to the writer, not to the poster: the reply uses none of its wording.`,
      });
    }
  }

  const interpretation = reply.match(INTERPRETATION_OPENER)?.[0] ?? null;
  const agreement = interpretation ? null : (reply.match(AGREEMENT_OPENER)?.[0] ?? null);
  if (interpretation) {
    problems.push({
      kind: "answers_note",
      quote: interpretation.trim(),
      severity: "fail",
      detail: `Answers your correction as if the poster had written it ("${interpretation.trim()}"). The poster offered no interpretation: start with the reply to the post itself, and never mention how it is read.`,
    });
  } else if (agreement) {
    problems.push({
      kind: "answers_note",
      quote: agreement.trim(),
      severity: "warn",
      detail: `Opens by agreeing with someone ("${agreement.trim()}"), which reads as an answer to your correction, not to the post. Start with the reply to the post itself.`,
    });
  }
  return problems;
}
