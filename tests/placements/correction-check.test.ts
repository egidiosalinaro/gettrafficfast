import { describe, expect, it } from "vitest";
import { auditDraft, withReading, type AuditContext, type DraftForAudit } from "@/lib/placements/audit";
import { ECHO_WORDS, correctionProblems, negatedPhrases } from "@/lib/placements/correction-check";
import { parseReading } from "@/lib/placements/reading";

/**
 * A rewrite follows the correction; it does not answer it.
 *
 * The case, in production on 10 November 2026: an ironic post, a draft that
 * read it as a complaint, the owner's note saying so, and a rewrite that
 * answered the note as if the poster had written it and kept the words the
 * note said were wrong. Pinned: that rewrite is refused, with sentences
 * that say what to change, and a reply that plays along with the joke
 * passes.
 */

/** The post, by @DanaShips on X, word for word. */
const POST =
  "Every time one of my LinkedIn posts gets traction, some 50+ year old CEO turns up to call me a scammer. For sharing my own revenue. Is this the price of posting???";

/** The owner's note on the first draft, word for word, in Italian. */
const NOTE = "Quello non è uno struggle of getting traction è un post ironico sta prendendo in giro i ceo boomer over 50";

/** What the rewrite came back as (agent_version 18), word for word. */
const BAD_REWRITE =
  "that's exactly how i interpret these posts too, daniel. it seems like a common way to poke fun at the struggle of getting traction, especially when sharing numbers. i'm still trying to get my blog articles past position 30-40, so i know the grind.";

/** A reply from someone who got the joke: it plays along, about the post, in lowercase. */
const GOOD_REPLY =
  "the 50+ ceo calling you a scammer for sharing real numbers is basically a rite of passage on linkedin. did he at least ask for a connection after?";

const OWNER_ABOUT =
  "Former agency designer, learned to code at night. Co-founded Postwren, email marketing for Shopify stores: 12 paying stores in October 2026. Since late September an AI pipeline writes and publishes my own blog: 9 impressions a week at the start, 342 in the week of Oct 26, still 0 clicks, articles sit around position 30-40. Left Porto on Oct 27 2026, working from Taipei.";
const OWNER_NOTES =
  "Lowercase, short lines, like a reply typed on a phone. One idea per reply. Lead with a number or a concrete thing I did. Never name a product, never a link. No em dashes, no hashtags, no 'great post', no lists. Disagree when I disagree. Ask one precise question when I have nothing to add.";

const ctx = (over: Partial<AuditContext> = {}): AuditContext => ({
  thread: { surface: "x", kind: "post", title: POST.slice(0, 80), excerpt: POST },
  business: { name: "GetTrafficFast", domains: ["gettrafficfa.st"], brandNames: [] },
  angle: null,
  expertise: ["ai seo", "answer engine optimization"],
  writer: { aboutYou: OWNER_ABOUT, instructions: OWNER_NOTES },
  now: new Date("2026-11-10T09:30:00Z"),
  correction: NOTE,
  ...over,
});
const reply = (body: string): DraftForAudit => ({ variant: "short_comment", body, linkUrl: null, claims: [] });
const correctionCheck = (result: ReturnType<typeof auditDraft>) => result.checks.find((check) => check.id === "follows_your_correction");
const kinds = (body: string, note = NOTE) => correctionProblems(body, note).map((problem) => problem.kind);

describe("negatedPhrases", () => {
  it("reads what the owner's note rules out, in Italian, up to what the post is instead", () => {
    expect(negatedPhrases(NOTE)).toEqual(["struggle of getting traction"]);
  });

  it("reads simple negations in English and Italian", () => {
    expect(negatedPhrases("it's not a complaint about traction, he's joking")).toEqual(["complaint about traction"]);
    expect(negatedPhrases("This isn't a cry for help but a joke")).toEqual(["cry for help"]);
    expect(negatedPhrases("That is not about getting traction. He is mocking them")).toEqual(["getting traction"]);
    expect(negatedPhrases("Not a real question, he is being sarcastic")).toEqual(["real question"]);
    expect(negatedPhrases("non è una richiesta di aiuto, è una battuta")).toEqual(["richiesta di aiuto"]);
    expect(negatedPhrases("Non si tratta di un problema di traction ma di una presa in giro")).toEqual(["problema di traction"]);
    // A phone's apostrophe is the same apostrophe.
    expect(negatedPhrases("it’s not a complaint about traction")).toEqual(["complaint about traction"]);
  });

  it("does not take an instruction, or one word, for a reading ruled out", () => {
    expect(negatedPhrases("do not use numbers here")).toEqual([]);
    expect(negatedPhrases("don't start with It's")).toEqual([]);
    expect(negatedPhrases("non usare numeri")).toEqual([]);
    expect(negatedPhrases("too long, sounds like AI")).toEqual([]);
    expect(negatedPhrases("it's not funny")).toEqual([]);
    expect(negatedPhrases("")).toEqual([]);
  });
});

describe("the rewrite of 10 November 2026", () => {
  it("is refused: it keeps what the note ruled out, and answers the note as if the poster wrote it", () => {
    const problems = correctionProblems(BAD_REWRITE, NOTE);
    expect(problems.map((problem) => [problem.kind, problem.severity])).toEqual([
      ["negated", "fail"],
      ["answers_note", "fail"],
    ]);
    expect(problems[0].detail).toBe(
      'Keeps what your correction ruled out: you said it is not "struggle of getting traction", and the reply still says "struggle of getting". Write it without those words and without that idea.'
    );
    expect(problems[1].detail).toBe(
      'Answers your correction as if the poster had written it ("that\'s exactly how i interpret"). The poster offered no interpretation: start with the reply to the post itself, and never mention how it is read.'
    );
  });

  it("fails the gate on the check for it, and is blocked", () => {
    const result = auditDraft(reply(BAD_REWRITE), ctx());
    const check = correctionCheck(result);
    expect(check).toMatchObject({ status: "fail", label: "Follows your correction, and does not answer it", advisory: false });
    expect(check?.detail).toContain("Keeps what your correction ruled out");
    expect(check?.detail).toContain("Answers your correction as if the poster had written it");
    expect(result.status).toBe("blocked");
  });

  it("passes the gate's fact check, which is why the unrelated blog fact is the prompt's to keep out", () => {
    // "position 30-40" is this site's own fact and the reply says what it
    // counts ("my blog articles"), so code has nothing to refuse it for:
    // that it has no place under this post is a judgement of relevance.
    const result = auditDraft(reply(BAD_REWRITE), ctx());
    expect(result.checks.find((check) => check.id === "verifiable_claims")?.status).toBe("pass");
  });
});

describe("a reply that got the joke", () => {
  it("passes the correction check and the gate", () => {
    expect(correctionProblems(GOOD_REPLY, NOTE)).toEqual([]);
    const result = auditDraft(reply(GOOD_REPLY), ctx());
    expect(correctionCheck(result)).toMatchObject({
      status: "pass",
      detail: "Nothing of your correction's wording is in the reply, and it does not answer it.",
    });
    expect(result.checks.filter((check) => check.status !== "pass" && !check.advisory).map((check) => check.id)).toEqual([]);
    expect(result.status).toBe("passed");
  });

  it("may use a word of the note, as long as it is not the phrase ruled out nor four words in a row", () => {
    expect(kinds("getting traction on linkedin apparently summons a ceo. every single time?")).toEqual([]);
    expect(kinds("the boomer ceo in the comments is how you know the numbers are real.")).toEqual([]);
  });
});

describe("the three ways a rewrite answers the note", () => {
  it("keeps the phrase the note ruled out, even to deny it", () => {
    expect(kinds("this is not the struggle of getting traction, it's the ceos.")).toEqual(["negated"]);
    // A two-word phrase has to come back whole.
    expect(kinds("that sounds like a real question to me.", "Not a real question, he is being sarcastic")).toEqual(["negated"]);
    expect(kinds("a question for you: which ceo was it?", "Not a real question, he is being sarcastic")).toEqual([]);
  });

  it("repeats four words of the note in a row", () => {
    expect(ECHO_WORDS).toBe(4);
    const note = "he is making fun of the boomer ceos, play along";
    const [problem] = correctionProblems("he's clearly making fun of the boomer ceos and i love it.", note);
    expect(problem).toMatchObject({ kind: "echo", severity: "fail", quote: "making fun of the" });
    expect(problem.detail).toContain("The correction was written to the writer, not to the poster");
    // Three in a row is anyone's wording.
    expect(kinds("making fun of them is the only sane answer.", note)).toEqual([]);
  });

  it("opens by weighing an interpretation, in the forms a model reaches for", () => {
    for (const body of [
      "that's exactly how i interpret these posts too, daniel.",
      "That is how I read it too. The CEOs are the joke.",
      "yeah, that's exactly what i took from it as well.",
      "i read it the same way. the ceos are the joke.",
      "that’s my read too: he's laughing at them.",
    ]) {
      expect(correctionProblems(body, NOTE).map((p) => [p.kind, p.severity]), body).toEqual([["answers_note", "fail"]]);
    }
  });

  it("warns on an opening that merely agrees with someone", () => {
    for (const body of ["as you said, the ceos are the ones who look bad here.", "you're right that the ceos look worse than you do.", "Good point. The CEOs look worse."]) {
      expect(correctionProblems(body, NOTE).map((p) => [p.kind, p.severity]), body).toEqual([["answers_note", "warn"]]);
    }
    const result = auditDraft(reply("you're right that the 50+ ceo calling you a scammer for sharing numbers looks worse than you do. did he delete it?"), ctx());
    expect(correctionCheck(result)?.status).toBe("warn");
    expect(result.status).toBe("warning");
    // Not at the start, it is just a sentence.
    expect(kinds("the ceo shows up every time. and as you said, for sharing numbers.")).toEqual([]);
  });
});

describe("when the check runs", () => {
  it("is part of the audit only for a rewrite made from a note", () => {
    const withNote = auditDraft(reply(GOOD_REPLY), ctx());
    const draft = auditDraft(reply(GOOD_REPLY), ctx({ correction: undefined }));
    const blank = auditDraft(reply(GOOD_REPLY), ctx({ correction: "   " }));
    expect(withNote.checks).toHaveLength(13);
    expect(draft.checks).toHaveLength(12);
    expect(blank.checks).toHaveLength(12);
    expect(correctionCheck(draft)).toBeUndefined();
    // The same reply as a first draft answers nobody's note.
    expect(auditDraft(reply(BAD_REWRITE), ctx({ correction: undefined })).checks.some((c) => c.id === "follows_your_correction")).toBe(false);
    expect(correctionProblems(BAD_REWRITE, "")).toEqual([]);
  });
});

describe("the reading kept beside the verdict", () => {
  it("rides with the audit without being part of it", () => {
    const audit = auditDraft(reply(GOOD_REPLY), ctx());
    const reading = { tone: "ironic" as const, means: "He is mocking the CEOs who call him a scammer." };
    expect(withReading(audit, reading)).toEqual({ ...audit, reading });
    expect(withReading(audit, null)).toBe(audit);
    expect("reading" in audit).toBe(false);
  });

  it("takes a reading only when it is one, and never guesses a tone", () => {
    expect(parseReading({ tone: " Ironic ", means: " He is mocking the CEOs. " })).toEqual({ tone: "ironic", means: "He is mocking the CEOs." });
    expect(parseReading({ tone: "sarcastic-ish", means: "x" })).toBeNull();
    expect(parseReading({ tone: "ironic", means: "" })).toBeNull();
    expect(parseReading({ tone: "ironic" })).toBeNull();
    expect(parseReading(null)).toBeNull();
    expect(parseReading("ironic")).toBeNull();
    expect(parseReading({ tone: "rant", means: "x".repeat(400) })?.means.length).toBeLessThanOrEqual(200);
  });
});
