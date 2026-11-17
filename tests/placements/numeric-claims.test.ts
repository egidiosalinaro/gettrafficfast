import { describe, expect, it } from "vitest";
import { auditDraft, type AuditContext, type DraftForAudit } from "@/lib/placements/audit";
import {
  IDIOMATIC_NUMBERS,
  declaredByAboutYou,
  hasNumericClaim,
  legacyNumberSentences,
  undeclaredNumberSentences,
} from "@/lib/placements/numeric-claims";
import { appendFact, factFromSentence } from "@/lib/voice/about-you";

/**
 * Numbers that are claims, and numbers that are figures of speech
 * (docs/PLACEMENTS.md, "It's true", 2026-11-12).
 *
 * The case: the owner's reply said "during the last week i'm going 100% on
 * marketing for both my startups too", and the gate failed it on "1
 * sentence(s) with numbers not declared as claims". The sentence was true
 * and the 100% was emphasis. Pinned: the idioms pass and the claims beside
 * them still fail; a number confirmed into About you is declared, and the
 * same text judged again passes.
 */

const OWNER_DRAFT =
  "i know that feeling of getting so close to an amazing opportunity, it's rough. but that new fire to go ham on your own startups is what matters most. during the last week i'm going 100% on marketing for both my startups too.";
const OWNER_SENTENCE = "during the last week i'm going 100% on marketing for both my startups too.";

/** About you as a test site holds it: no number in it. */
const ABOUT = "Former agency designer. I build GetTrafficFast, an AI SEO tool.";

const NOW = new Date("2026-11-12T10:00:00Z");

/**
 * The post the draft answered was not kept with the report; this is its
 * subject as the reply reads it (a near miss, and starting again), not a
 * quotation. Only the fact check is asserted on.
 */
const POST = "got so close to landing a big opportunity this week and it fell through. back to building my own startups.";

const ctx = (aboutYou = ABOUT): AuditContext => ({
  thread: { surface: "x", kind: "post", title: POST.slice(0, 80), excerpt: POST },
  business: { name: "GetTrafficFast", domains: ["gettrafficfa.st"], brandNames: [] },
  angle: null,
  expertise: ["ai seo"],
  writer: { aboutYou, instructions: "" },
  now: NOW,
});
const reply = (body: string): DraftForAudit => ({ variant: "short_comment", body, linkUrl: null, claims: [] });
const claimsCheck = (body: string, aboutYou?: string) => auditDraft(reply(body), ctx(aboutYou)).checks.find((c) => c.id === "verifiable_claims")!;

describe("figures of speech are not claims", () => {
  it.each([
    "i'm going 100% on marketing this month.",
    "giving 110% to the launch.",
    "give it 110% and see.",
    "100% agree with this.",
    "110% sure it works.",
    "we answer support 24/7.",
    "it's one of the hardest parts.",
    "i've said it a million times.",
    "zero chance that ranks.",
  ])("%s", (sentence) => {
    expect(hasNumericClaim(sentence)).toBe(false);
  });

  it.each([
    "100% of my customers came from reddit.",
    "revenue grew 110%.",
    "a 43% lift in citations.",
    "we have 2,000 customers.",
    "it got 3x the traffic.",
    "going 100% on marketing tripled signups.",
    "uptime is 100% on weekdays.",
  ])("%s is still a claim", (sentence) => {
    expect(hasNumericClaim(sentence)).toBe(true);
  });

  it("lists the idioms the docs name", () => {
    expect(IDIOMATIC_NUMBERS.map((idiom) => idiom.phrase)).toEqual([
      "going 100% on",
      "110%",
      "100% agree",
      "24/7",
      "one of the",
      "a million times",
      "zero chance",
    ]);
  });
});

describe("the reply of 12 November 2026", () => {
  it("was flagged by the gate before idioms: one sentence, the owner's", () => {
    expect(legacyNumberSentences(OWNER_DRAFT, [])).toEqual([OWNER_SENTENCE]);
  });

  it("passes the fact check now: the 100% is emphasis, and 'both my startups' is no number", () => {
    expect(undeclaredNumberSentences(OWNER_DRAFT, [], ABOUT)).toEqual([]);
    const check = claimsCheck(OWNER_DRAFT);
    expect(check.status).toBe("pass");
    expect(check.confirmable).toBeUndefined();
  });

  it("the same sentence with a real share in it still fails, and names the sentence to confirm", () => {
    const body = OWNER_DRAFT.replace("i'm going 100% on marketing", "100% of my time goes to marketing");
    const check = claimsCheck(body);
    expect(check.status).toBe("fail");
    expect(check.detail).toContain("1 sentence(s) with numbers not declared as claims.");
    expect(check.confirmable).toEqual(["during the last week 100% of my time goes to marketing for both my startups too."]);
  });
});

describe("a number confirmed into About you is declared", () => {
  const body = "reddit has been the surprise for me. 40% of my signups come from reddit threads now. what channel works for you?";
  const sentence = "40% of my signups come from reddit threads now.";

  it("fails, is confirmed with It's true, and the same text judged again passes", () => {
    const before = claimsCheck(body);
    expect(before.status).toBe("fail");
    expect(before.confirmable).toEqual([sentence]);

    const fact = factFromSentence(sentence, NOW);
    expect(fact).toBe("As of November 12, 2026: 40% of my signups come from reddit threads now.");
    const added = appendFact(ABOUT, fact);
    if (!added.ok) throw new Error(added.error);

    const after = claimsCheck(body, added.aboutYou);
    expect(after.status).toBe("pass");
    expect(after.confirmable).toBeUndefined();
  });

  it("only the same figure counts: 4% is not 40%, and 140% is not 40%", () => {
    expect(declaredByAboutYou(sentence, "About 40% of signups.")).toBe(true);
    expect(declaredByAboutYou(sentence, "About 4% of signups.")).toBe(false);
    expect(declaredByAboutYou(sentence, "Grew 140% this year.")).toBe(false);
    expect(declaredByAboutYou(sentence, "")).toBe(false);
  });

  it("offers the experience claimed with nothing recorded, too", () => {
    const check = claimsCheck("I've been using question headings for months. they get cited more.", "");
    expect(check.status).toBe("fail");
    expect(check.confirmable).toEqual(["I've been using question headings for months."]);
  });
});
