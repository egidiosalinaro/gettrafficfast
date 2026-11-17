import { describe, expect, it } from "vitest";
import { DraftCorrectInput, buildDraftCorrectPrompt, draftCorrectAgent } from "@/lib/agents/draft-correct";
import { PlacementDraftInput, buildPlacementDraftPrompt, placementDraftAgent, xVoice } from "@/lib/agents/placement-draft";
import { STALE_FACTS_MAX, factFitRule, staleFactsRule } from "@/lib/voice/fact-rules";
import { staleFacts } from "@/lib/voice/staleness";

/**
 * What the drafter and the correction are told about the facts in About you
 * (since drafter version 19 and correction version 2). The case: on 10 November 2026
 * a reply on the GetTrafficFast account led with "12 paying stores", a figure
 * About you records about another product, because the notes said "Lead
 * with a number". Pinned: a fact is stated only where it fits the post, the
 * site is named so the model can tell whose fact it is, no fitting fact
 * means no number whatever the notes say, and a stale fact is handed over
 * with its date.
 */

const OWNER_VOICE = {
  preset: "warm" as const,
  person: "auto" as const,
  aboutYou:
    "Former agency designer, learned to code at night. Co-founded Postwren, email marketing for Shopify stores: 12 paying stores in October 2026. Since late September an AI pipeline writes and publishes my own blog: 9 impressions a week at the start, 342 in the week of Oct 26, still 0 clicks, articles sit around position 30-40. Left Porto on Oct 27 2026, working from Taipei.",
  instructions:
    "Lowercase, short lines, like a reply typed on a phone. One idea per reply. Lead with a number or a concrete thing I did. Never name a product, never a link. No em dashes, no hashtags, no 'great post', no lists. Disagree when I disagree. Ask one precise question when I have nothing to add.",
};

/** The post by its subject; its exact wording was not kept with the report. */
const HACKATHON = {
  surface: "x",
  kind: "post",
  community: "@founder",
  title: "we ran a hackathon where the judges were our paying customers",
  excerpt: "we ran a hackathon where the judges were our paying customers. they picked what ships.",
  author: "founder",
};

const STALE = staleFacts(OWNER_VOICE.aboutYou, new Date("2026-11-10T09:30:00Z")).map(({ sentence, dateLabel }) => ({ sentence, dateLabel }));

const draftInput = (over: Record<string, unknown> = {}) =>
  PlacementDraftInput.parse({
    business: { name: "GetTrafficFast", domain: "https://gettrafficfa.st", niche: "AI SEO content for small sites" },
    expertise: ["answer engine optimization"],
    thread: HACKATHON,
    angle: null,
    chosenByPerson: true,
    voice: OWNER_VOICE,
    language: "en",
    variants: ["short_comment"],
    ...over,
  });

describe("factFitRule", () => {
  it("says when a fact may be stated, for which site, and that a style note never forces one", () => {
    const rule = factFitRule({ name: "GetTrafficFast", niche: "AI SEO content for small sites" });
    expect(rule).toContain("only when both hold: it is about the same subject as this post, and a reader who has never heard of the product behind it understands it as written.");
    expect(rule).toContain("This text is written for GetTrafficFast, which is about: AI SEO content for small sites.");
    expect(rule).toContain(
      "A fact about a different product or business than GetTrafficFast (another company you founded, its customers, its numbers) stays out unless the post is about that product or its market."
    );
    expect(rule).toContain("When no fact fits, the text carries no number and no fact about you");
    expect(rule).toContain('A note about style ("lead with a number") or an earlier correction ("use one of my numbers") never forces an unrelated fact');
  });

  it("names the site alone when nothing says what it is about", () => {
    const rule = factFitRule({ name: "Acme", niche: null });
    expect(rule).toContain("This text is written for Acme. A fact about a different product");
    expect(rule).not.toContain("which is about");
    expect(factFitRule({ name: "Acme", niche: "  " })).not.toContain("which is about");
  });
});

describe("staleFactsRule", () => {
  it("hands each stale sentence over with its date, to be stated as of it", () => {
    expect(STALE).toEqual([
      { sentence: "Co-founded Postwren, email marketing for Shopify stores: 12 paying stores in October 2026.", dateLabel: "October 2026" },
    ]);
    const rule = staleFactsRule(STALE) ?? "";
    expect(rule).toContain("This sentence of About you carries a date more than 30 days old.");
    expect(rule).toContain('state it as of its date, in the past tense ("in October I had…"), never as current, or leave it out.');
    expect(rule).toContain('- "Co-founded Postwren, email marketing for Shopify stores: 12 paying stores in October 2026." (dated October 2026)');
  });

  it("is plural for several, and nothing for none", () => {
    expect(staleFactsRule([...STALE, { sentence: "Left Porto on Oct 1 2026.", dateLabel: "Oct 1, 2026" }])).toContain("These sentences of About you carry");
    expect(staleFactsRule([])).toBeNull();
  });
});

describe("placement-draft prompt, since version 19", () => {
  it("is at least version 19", () => {
    expect(placementDraftAgent.version).toBeGreaterThanOrEqual(19);
  });

  it("carries the fit rule inside the honesty rule, above who is named", () => {
    const prompt = buildPlacementDraftPrompt(draftInput());
    expect(prompt).toContain("Your facts, only where they fit. A fact from the voice section (a number, a thing you did)");
    expect(prompt).toContain("This text is written for GetTrafficFast, which is about: AI SEO content for small sites.");
    expect(prompt).toContain("stays out unless the post is about that product or its market");
    expect(prompt).toContain("When no fact fits, the text carries no number and no fact about you");
    expect(prompt.indexOf("5. Invent nothing.")).toBeLessThan(prompt.indexOf("Your facts, only where they fit."));
    expect(prompt.indexOf("Your facts, only where they fit.")).toBeLessThan(prompt.indexOf("6. Who is named."));
    // Said once.
    expect(prompt.split("Your facts, only where they fit.")).toHaveLength(2);
  });

  it("puts the fit rule above the owner's notes, by name, where the notes are given", () => {
    const prompt = buildPlacementDraftPrompt(draftInput());
    expect(prompt).toContain("Lead with a number or a concrete thing I did.");
    expect(prompt).toContain(
      "Only the rules on inventing nothing, using a fact only where it fits the post, naming no product and carrying no link stand above them."
    );
  });

  it("tells an X reply to use a fact only when it fits, and none when none does", () => {
    const voice = xVoice({ thread: HACKATHON, variants: ["short_comment"] }) ?? "";
    expect(voice).toContain("holds one concrete fact that fits this post as rule 5 defines it (the same subject, about this site, clear to a reader who knows nothing of you)");
    expect(voice).toContain("If nothing there fits, use none: give an honest personal reaction, a feeling or a belief of yours about what the post is about (no number, no event), a clear position, or one short question.");
    expect(voice).not.toContain("bears on this post");
  });

  it("says About you may hold facts about something other than this business", () => {
    const prompt = buildPlacementDraftPrompt(draftInput());
    expect(prompt).toContain("A fact here may be about this business or about something else the writer does:");
    expect(prompt).not.toContain("How the writer uses the product, in their own words");
  });

  it("passes each stale sentence with its date, and no block when none is stale", () => {
    const prompt = buildPlacementDraftPrompt(draftInput({ staleFacts: STALE }));
    expect(prompt).toContain("Dated facts. This sentence of the voice section carries a date more than 30 days old.");
    expect(prompt).toContain('- "Co-founded Postwren, email marketing for Shopify stores: 12 paying stores in October 2026." (dated October 2026)');
    expect(prompt.indexOf("Dated facts.")).toBeLessThan(prompt.indexOf("6. Who is named."));
    expect(buildPlacementDraftPrompt(draftInput())).not.toContain("Dated facts.");
    expect(draftInput().staleFacts).toEqual([]);
  });

  it("tells a rewrite what to do with each of the gate's fact problems", () => {
    const prompt = buildPlacementDraftPrompt(
      draftInput({
        revisions: [
          {
            variant: "short_comment",
            problems: ['Uses a fact about another product: "12 paying stores" is about Postwren in About you, this reply is written for GetTrafficFast, and the post is not about Postwren.'],
          },
        ],
      })
    );
    expect(prompt).toContain(
      "Where a problem says a fact is about another product, or that the reader cannot place a number, leave that fact out and put no other number in its place: the reply does without one."
    );
    expect(prompt).toContain('Where a problem says a dated fact is stated as current, say when it was true ("in October I had…") or leave it out.');
    expect(prompt).toContain('- short_comment: Uses a fact about another product: "12 paying stores"');
  });

  it("is deterministic, and bounds the stale block by the schema", () => {
    expect(buildPlacementDraftPrompt(draftInput({ staleFacts: STALE }))).toBe(buildPlacementDraftPrompt(draftInput({ staleFacts: STALE })));
    const many = Array.from({ length: STALE_FACTS_MAX + 1 }, (_, i) => ({ sentence: `Fact ${i}.`, dateLabel: "October 2026" }));
    expect(() => draftInput({ staleFacts: many })).toThrow();
    expect(() => draftInput({ staleFacts: many.slice(0, STALE_FACTS_MAX) })).not.toThrow();
  });
});

describe("draft-correct prompt, since version 2", () => {
  const input = (over: Record<string, unknown> = {}) =>
    DraftCorrectInput.parse({
      business: { name: "GetTrafficFast", site: "https://gettrafficfa.st", niche: "AI SEO content for small sites" },
      thread: { surface: "x", kind: "post", title: HACKATHON.title, excerpt: HACKATHON.excerpt },
      variant: "short_comment",
      draft: "letting customers decide is a smart way to run a hackathon.",
      reason: "Use one of my numbers",
      aboutYou: OWNER_VOICE.aboutYou,
      notes: OWNER_VOICE.instructions,
      ...over,
    });

  it("is at least version 2", () => {
    expect(draftCorrectAgent.version).toBeGreaterThanOrEqual(2);
  });

  it("holds the fit rule even when the note asks for a number", () => {
    const prompt = buildDraftCorrectPrompt(input());
    expect(prompt).toContain("Use one of my numbers");
    expect(prompt).toContain("Your facts, only where they fit. A fact from About you (a number, a thing you did)");
    expect(prompt).toContain("This text is written for GetTrafficFast, which is about: AI SEO content for small sites.");
    expect(prompt).toContain(
      `That holds for the owner's note too: if it asks for one of your numbers ("use one of my numbers") and no number in About you fits this post, use none and say the point without it.`
    );
    // Among the numbered rules the note cannot go through.
    expect(prompt.indexOf("While you follow the correction:")).toBeLessThan(prompt.indexOf("Your facts, only where they fit."));
  });

  it("passes the stale sentence with its date, and no block when none is stale", () => {
    const prompt = buildDraftCorrectPrompt(input({ staleFacts: STALE }));
    expect(prompt).toContain("Dated facts. This sentence of About you carries a date more than 30 days old.");
    expect(prompt).toContain("(dated October 2026)");
    expect(buildDraftCorrectPrompt(input())).not.toContain("Dated facts.");
  });

  it("still parses an input with no niche and no stale facts", () => {
    const bare = DraftCorrectInput.parse({
      business: { name: "Acme", site: null },
      thread: { surface: "x", kind: "post", title: "A post", excerpt: "" },
      variant: "short_comment",
      draft: "A draft.",
      reason: "too long",
    });
    expect(bare.business.niche).toBeNull();
    expect(bare.staleFacts).toEqual([]);
    expect(buildDraftCorrectPrompt(bare)).toContain("This text is written for Acme. A fact about a different product");
  });
});
