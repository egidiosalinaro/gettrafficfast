import { afterEach, describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  CORRECTIONS_LIMIT,
  FORBIDDEN_STRUCTURES,
  FORBIDDEN_WORDS,
  PlacementDraftInput,
  SHAPE_EXAMPLE,
  buildPlacementDraftPrompt,
  correctionsSection,
  isXReplyOnly,
  placementDraftAgent,
  variantBrief,
} from "@/lib/agents/placement-draft";
import { PROMPT_REASON_MAX } from "@/lib/placements/feedback";
import { createBudget } from "@/lib/agents/contract";
import { campaignMention } from "@/lib/placements/audit";
import { setLlmProvider } from "@/lib/providers/llm/registry";
import type { LLMProvider, LlmOptions, LlmStructuredResult, LlmTextResult } from "@/lib/providers/llm/types";
import { DEFAULT_VOICE_SETTINGS } from "@/lib/voice/settings";

/**
 * What the model is told. The prompt is the fix for drafts that read as
 * adverts, so the words of that fix are asserted: the reader's test, the
 * structures and phrases that are out, the voice, the approach dealt by the
 * job, and "claim nothing about yourself" when nothing is known.
 */

const base = {
  business: { name: "GetTrafficFast", domain: "https://gettrafficfa.st", niche: "AI SEO" },
  expertise: ["answer engine optimization"],
  thread: {
    surface: "reddit",
    kind: "thread",
    community: "r/SEO",
    title: "Best AI tools to write better SEO content?",
    excerpt: "Jasper is great for long-form.",
    author: "asker",
  },
  angle: "The workflow around the pieces is where the time goes.",
  language: "en",
  variants: ["short_comment", "detailed_answer"] as const,
};

describe("placement-draft prompt", () => {
  it("defaults the voice and the approach when the caller gives none", () => {
    const parsed = PlacementDraftInput.parse(base);
    expect(parsed.voice).toEqual(DEFAULT_VOICE_SETTINGS);
    expect(parsed.approach).toBe("");
  });

  it("asks the reader's question and names every structure and phrase that is out", () => {
    const prompt = buildPlacementDraftPrompt(PlacementDraftInput.parse(base));
    expect(prompt).toContain("could this plausibly be a genuine comment from a participant");
    expect(prompt).toContain("not like a company that hired someone to write an advert");
    for (const structure of FORBIDDEN_STRUCTURES) expect(prompt).toContain(structure);
    for (const word of FORBIDDEN_WORDS) expect(prompt).toContain(word);
    expect(prompt).toContain("No call to action");
    expect(prompt).toContain("if 70 words do it, write 70");
  });

  it("tells the model to claim no experience when nothing is known about the writer", () => {
    const prompt = buildPlacementDraftPrompt(PlacementDraftInput.parse(base));
    expect(prompt).toMatch(/claims none/);
    expect(prompt).toContain('"I\'ve seen", "I\'ve found", "for us", "in my experience", "I\'ve been using" are claims');
  });

  it("never shows the model the description, and asks a reply to name no product and carry no link", () => {
    // Three versions told the model not to reuse the marketing copy and every
    // production draft reused it. The writer no longer reads it.
    const prompt = buildPlacementDraftPrompt(
      PlacementDraftInput.parse({ ...base, business: { ...base.business, description: "An AI agent that automates the entire content lifecycle." } })
    );
    expect(prompt).not.toContain("automates the entire content lifecycle");
    expect(prompt).not.toContain("What they do");
    expect(prompt).toContain("The writer uses GetTrafficFast in their own work. What they can truthfully say about that use is in the voice section below, and nothing else.");
    expect(prompt).toContain("You have not been given a description of what GetTrafficFast does, and you do not need one");
    // The 21 published replies all ended on one sentence naming the product.
    expect(prompt).toContain("In short_comment and detailed_answer: name no product and link nothing.");
    expect(prompt).toContain("Twenty-one replies that each ended on one sentence naming GetTrafficFast");
    expect(prompt).toContain('"GetTrafficFast is what I use for that"');
    expect(prompt).toContain("a reader who wants to know who wrote it opens the profile");
    expect(prompt).toContain("You may draw on what the writer does, from the voice section, never on what they do it with.");
    expect(prompt).toContain("answer how to choose (what to look for, what the trade-offs are) and leave out which one you use");
    expect(prompt).toContain('no "services like X", no "tools like X"');
    expect(prompt).toContain("Do not open by rating the tools the person named");
    expect(prompt).toContain("Topics they know about (background, not a list to cover)");
    expect(prompt).toContain("No call to action");
    // Nothing on a reply-only prompt asks for a mention, a clause about use, or a link.
    expect(prompt).not.toContain("Name GetTrafficFast exactly once");
    expect(prompt).not.toContain("name GetTrafficFast exactly once");
    expect(prompt).not.toContain("where in the reply the one clause about what you use sits");
    expect(prompt).not.toContain("Set linkUrl to exactly");
    expect(prompt).not.toContain("with the link and the mention deleted");
    expect(prompt).not.toContain("Where a problem says the business is never named");
  });

  it("still asks the article for one clause about the writer's use, never in the published shape, and the list entry for its line", () => {
    const x = buildPlacementDraftPrompt(
      PlacementDraftInput.parse({ ...base, thread: { ...base.thread, surface: "x", kind: "post", community: "" }, variants: ["short_comment", "article_draft"] })
    );
    expect(x).toContain("In short_comment: name no product and link nothing.");
    expect(x).toContain("In article_draft: name GetTrafficFast exactly once, as someone who uses it, in one short clause written for this article.");
    expect(x).toContain('not "GetTrafficFast is what I use for that", not "I use GetTrafficFast for…", not "I have GetTrafficFast doing…"');
    expect(x).toContain("Put it in the middle, never in the opening sentences, never as the point, never in the last sentence.");
    expect(x).toContain("In article_draft, also settle where the one clause about what you use sits without being the point");
    expect(x).toContain("article_draft: still useful with the link and the mention deleted.");

    const list = buildPlacementDraftPrompt(
      PlacementDraftInput.parse({ ...base, thread: { ...base.thread, surface: "github", kind: "repository", community: "" }, variants: ["github_pr_proposal"] })
    );
    expect(list).toContain("In github_pr_proposal: the line names GetTrafficFast, because the entry is the project");
    expect(list).toContain("write the name as a Markdown link, [GetTrafficFast](https://gettrafficfa.st)");
    expect(list).not.toContain("name no product");
  });

  it("forbids the maker's voice: the writer uses the product and never speaks as the people who make it", () => {
    const prompt = buildPlacementDraftPrompt(PlacementDraftInput.parse(base));
    expect(prompt).toContain("They are not the people who make GetTrafficFast and never speak as them");
    for (const phrase of ['"I work on"', '"I built"', '"we built"', '"I\'m behind"', '"we designed"', '"our product"', '"our users"', '"which is why I care"']) {
      expect(prompt).toContain(phrase);
    }
    expect(prompt).toContain("no founder, no team, no disclosure of any kind");
    // The first drafts in user voice pasted the recorded sentence whole,
    // "it's the part I publish my own site's blog through X".
    expect(prompt).toContain("never the sentence recorded in the voice section");
    expect(prompt).not.toContain("so weigh this accordingly");
    expect(prompt).not.toContain("person behind GetTrafficFast");
    expect(prompt).toContain("What the voice section records about the writer is the one experience you may draw on; say no more than is recorded, no duration, no results.");
  });

  it("carries the business's voice and the approach the job dealt", () => {
    const prompt = buildPlacementDraftPrompt(
      PlacementDraftInput.parse({
        ...base,
        voice: { preset: "technical", person: "i", aboutYou: "I run my own blog through the tool.", instructions: "Never say 'AI agent'." },
        approach: "Push back, mildly, on part of the premise, then answer.",
      })
    );
    expect(prompt).toContain("Technical: precise.");
    expect(prompt).toContain('Write as "I"');
    expect(prompt).toContain("What is true about the writer, in their own words: the only personal experience the reply may claim, and only where it fits the post.");
    expect(prompt).toContain("I run my own blog through the tool.");
    expect(prompt).toContain("Never say 'AI agent'.");
    expect(prompt).toContain("The approach for this reply: Push back, mildly, on part of the premise, then answer.");
    expect(prompt).not.toMatch(/claims none/);
  });

  it("keeps the answer-first rule, and the article's mention in passing, never as the close", () => {
    const prompt = buildPlacementDraftPrompt(PlacementDraftInput.parse(base));
    expect(prompt).toContain("The first two sentences help the person and name no business, product or link.");
    expect(prompt).toContain("Never a summary, never a moral, never a sentence about how the reader should think or weigh things.");
    const article = buildPlacementDraftPrompt(
      PlacementDraftInput.parse({ ...base, thread: { ...base.thread, surface: "linkedin", kind: "post" }, variants: ["short_comment", "article_draft"] })
    );
    expect(article).toContain("never in the opening sentences, never as the point, never in the last sentence");
  });

  it("asks a reply for no link on every surface, and the article for one link on the name, in the form the surface renders", () => {
    for (const surface of ["reddit", "x", "linkedin", "quora", "hackernews", "stackexchange"]) {
      const reply = buildPlacementDraftPrompt(PlacementDraftInput.parse({ ...base, thread: { ...base.thread, surface } }));
      expect(reply, surface).toContain("no link of any kind, no URL, no Markdown link, no bare domain. Set linkUrl to null.");
      expect(reply, surface).not.toContain("Set linkUrl to exactly");
      expect(reply, surface).not.toContain("write the name as a Markdown link");
      expect(reply, surface).not.toContain("followed by the bare URL");
    }
    const issue = buildPlacementDraftPrompt(
      PlacementDraftInput.parse({ ...base, thread: { ...base.thread, surface: "github", kind: "issue" }, variants: ["github_issue"] })
    );
    expect(issue).toContain("In github_issue: no link of any kind");
    expect(variantBrief("github_issue", "github")).toContain("No product named, no link.");
    expect(variantBrief("github_issue", "github")).not.toMatch(/business's tool|truly/);

    // X and Hacker News print Markdown as its brackets: the article's bare URL follows the name.
    const x = buildPlacementDraftPrompt(
      PlacementDraftInput.parse({ ...base, thread: { ...base.thread, surface: "x", kind: "post", community: "" }, variants: ["short_comment", "article_draft"] })
    );
    expect(x).toContain("In short_comment: no link of any kind");
    expect(x).toContain("In article_draft: One link, always, and only this one: https://gettrafficfa.st.");
    expect(x).toContain("write the name followed by the bare URL in parentheses, GetTrafficFast (https://gettrafficfa.st)");
    expect(x).toContain("fit in 280 characters, spaces included. No link.");
    expect(x).not.toContain("the link included");

    // A domain without a scheme gets one; a business with no site gets no link.
    const devto = (domain: string | null) =>
      buildPlacementDraftPrompt(
        PlacementDraftInput.parse({ ...base, business: { ...base.business, domain }, thread: { ...base.thread, surface: "devto" }, variants: ["article_draft"] })
      );
    expect(devto("gettrafficfa.st")).toContain("[GetTrafficFast](https://gettrafficfa.st)");
    expect(devto(null)).toContain("The business has no site recorded, so there is no link: set linkUrl to null and put no URL in the text.");
  });

  it("asks an X short comment for 280 characters, not for several sentences", () => {
    const prompt = buildPlacementDraftPrompt(
      PlacementDraftInput.parse({
        ...base,
        thread: { ...base.thread, surface: "x", kind: "post", community: "" },
        variants: ["short_comment", "article_draft"],
      })
    );
    expect(prompt).toContain("one or two sentences that fit in 280 characters, spaces included");
    expect(prompt).toContain("Count the characters before you return it");
    expect(prompt).not.toContain("a reply of 2–6 sentences");
    expect(prompt).toContain("on X a short comment stops at 280 characters");
  });

  it("names the checks a previous draft failed, without being shown that draft", () => {
    const prompt = buildPlacementDraftPrompt(
      PlacementDraftInput.parse({
        ...base,
        revisions: [
          {
            variant: "short_comment",
            problems: ["682 characters is too long for x (at most 280).", "Describes the product in 4 statements."],
          },
        ],
      })
    );
    expect(prompt).toContain("A previous draft of some variants failed");
    expect(prompt).toContain("short_comment: 682 characters is too long for x (at most 280).");
    expect(prompt).toContain("A phrase quoted in a problem must not appear in any form.");
    expect(prompt).toContain("Where a problem says a reply names the business or carries a link, delete the clause that does and put nothing in its place: the reply is the answer.");
    expect(prompt).toContain("Where a problem says the product is described, cut every statement about it.");
    expect(prompt).toContain("Where a problem says the text speaks as the maker, drop that.");
    // A reply-only rewrite is never told to add a clause about what the writer uses.
    expect(prompt).not.toContain("write the clause as someone who uses GetTrafficFast");
    const article = buildPlacementDraftPrompt(
      PlacementDraftInput.parse({
        ...base,
        thread: { ...base.thread, surface: "linkedin", kind: "post" },
        variants: ["short_comment", "article_draft"],
        revisions: [{ variant: "article_draft", problems: ["Never names GetTrafficFast."] }],
      })
    );
    expect(article).toContain("Where a problem says the article or the list entry never names the business, add that one clause and nothing else.");
    expect(article).toContain("in the article, all but the one clause about your own use");
    expect(article).toContain("in the article, write the clause as someone who uses GetTrafficFast");
  });

  it("asks for the shape of a person's reply, shows one, and refuses the essay register and the angle as thesis", () => {
    // The drafts of 29 September passed the gate and read as essays: a
    // framing opener, "where the real bottleneck lies", a closer that told
    // the reader how to think, and the product's argument underneath.
    const prompt = buildPlacementDraftPrompt(PlacementDraftInput.parse(base));
    expect(prompt).toContain("The first sentence is the answer: the thing to do, the thing to check, or your opinion on the question, in plain words.");
    expect(prompt).toContain("The angle above is where you start, not what the reply is about.");
    expect(prompt).toContain("If the angle says that what GetTrafficFast does is what matters most, do not argue that: it is the advert's argument in a user's mouth.");
    expect(prompt).toContain("Sentences mostly under fifteen words, none over thirty.");
    expect(prompt).toContain('("the automation of publishing" is "publishing it yourself")');
    expect(prompt).toContain("The last sentence is a concrete detail, a caveat, or a question back to the person. Never a summary, never a moral");
    // One reply in the right shape, about something the threads are never
    // about, so only the shape can be borrowed.
    expect(prompt).toContain(SHAPE_EXAMPLE);
    expect(SHAPE_EXAMPLE).toContain("Charge a deposit and shorten the terms.");
    // The example used to carry "the bit I have [Tallyhold](…) sending for me":
    // the shape every published reply copied. It names no tool and links nothing now.
    expect(SHAPE_EXAMPLE).not.toMatch(/Tallyhold|https?:\/\//);
    expect(campaignMention(SHAPE_EXAMPLE, ["Tallyhold"])).toBeNull();
    expect(SHAPE_EXAMPLE).toContain("no tool named, no link, nothing about what the writer uses");
    expect(SHAPE_EXAMPLE).not.toMatch(/seo|traffic|content calendar/i);
    for (const structure of [
      '"...is often where the real bottleneck lies"',
      '"Considering X can change how you weigh Y" (a last sentence that tells the reader how to think)',
      "three questions in a row",
      "a sentence of forty words",
    ]) {
      expect(FORBIDDEN_STRUCTURES).toContain(structure);
    }
    for (const word of ["crucial", "truly", '"significantly"', '"before diving into"', '"great question"', '"bogged down"']) expect(FORBIDDEN_WORDS).toContain(word);
    // A rewrite is told what to do with quoted essay words.
    const revised = buildPlacementDraftPrompt(
      PlacementDraftInput.parse({ ...base, revisions: [{ variant: "short_comment", problems: ['Reads as written to promote, not to answer: the framing opener ("it\'s easy to get caught up").'] }] })
    );
    expect(revised).toContain("Where a problem quotes words that read as promotion or as an essay, drop the sentence they sit in and say the point plainly");
  });

  it("tells the model what to do with an angle that was written as a product brief", () => {
    // Rows qualified before the qualifier learned what an angle is still carry
    // briefs like this one; the drafter must not build an advert on them.
    const prompt = buildPlacementDraftPrompt(
      PlacementDraftInput.parse({ ...base, angle: "Explain how GetTrafficFast stands out as a complete AI agent that automates the entire SEO content workflow." })
    );
    expect(prompt).toContain("If that reads as a brief to present the product, take from it only the knowledge or experience it points at.");
  });
});

/**
 * Version 17: the X reply of 9 November 2026 read as a model's. The owner's
 * notes asked for lowercase and a concrete thing he did; About you held his
 * numbers. What the model is told now, in the owner's own settings.
 */
const OWNER_VOICE = {
  preset: "warm" as const,
  person: "auto" as const,
  aboutYou:
    "Former agency designer, learned to code at night. Co-founded Postwren, email marketing for Shopify stores: 12 paying stores in October 2026. Since late September an AI pipeline writes and publishes my own blog: 9 impressions a week at the start, 342 in the week of Oct 26, still 0 clicks, articles sit around position 30-40. Left Porto on Oct 27 2026, working from Taipei.",
  instructions:
    "Lowercase, short lines, like a reply typed on a phone. One idea per reply. Lead with a number or a concrete thing I did. Never name a product, never a link. No em dashes, no hashtags, no 'great post', no lists. Disagree when I disagree. Ask one precise question when I have nothing to add.",
};

const X_THREAD = {
  surface: "x",
  kind: "post",
  community: "@abel_codes",
  title: "i saw review on X about one tool to find customers",
  excerpt:
    'i saw review on X about one tool to find customers and i was like "WTF?? boolshit! does it even work???" so i decided to run the experiment 1) i registered on <link> 2) i found communities w my target audience 3) i set up the campaigns to run on autopilot rn...',
  author: "abel_codes",
};

describe("placement-draft prompt: the writer's notes, his posted replies, his own voice (version 17)", () => {
  const xInput = (over: Record<string, unknown> = {}) =>
    PlacementDraftInput.parse({ ...base, angle: null, chosenByPerson: true, thread: X_THREAD, variants: ["short_comment"], voice: OWNER_VOICE, ...over });

  it("puts the owner's notes near the top as hard rules, before the thread, and does not repeat them at the bottom", () => {
    const prompt = buildPlacementDraftPrompt(xInput());
    expect(prompt).toContain("Your own notes (Settings → Voice), written by the owner. These are hard rules, not background");
    expect(prompt).toContain("the note wins");
    expect(prompt).toContain("The notes ask for lowercase: start every sentence with a lowercase letter");
    expect(prompt).toContain(OWNER_VOICE.instructions);
    expect(prompt.split(OWNER_VOICE.instructions)).toHaveLength(2);
    expect(prompt.indexOf("These are hard rules")).toBeLessThan(prompt.indexOf("The discussion ("));
    expect(prompt.indexOf("The business:")).toBeLessThan(prompt.indexOf("These are hard rules"));
    expect(prompt).toContain("Your own notes, at the top, are hard rules: where this preset and a note disagree, the note wins.");

    // No notes, no section, and no pointer to one.
    const plain = buildPlacementDraftPrompt(xInput({ voice: { ...OWNER_VOICE, instructions: "" } }));
    expect(plain).not.toContain("hard rules");
    // Notes that ask nothing about case get no lowercase line.
    const other = buildPlacementDraftPrompt(xInput({ voice: { ...OWNER_VOICE, instructions: "Never say 'AI agent'." } }));
    expect(other).toContain("These are hard rules");
    expect(other).not.toContain("The notes ask for lowercase");
  });

  it("tells an X reply to speak from one fact the writer recorded, casually, and that admitting a limit is fine", () => {
    const prompt = buildPlacementDraftPrompt(xInput());
    expect(prompt).toContain("On X, speak from yourself, not about the topic from above.");
    expect(prompt).toContain("use that one fact, in your own words, and no other");
    expect(prompt).toContain("give an honest personal reaction, a feeling or a belief of yours about what the post is about (no number, no event), a clear position, or one short question");
    expect(prompt).toContain("Casual, the way you'd type a reply on your phone.");
    expect(prompt).toContain('Admitting a limit is fine ("haven\'t tested that myself", "just thinking out loud").');
    expect(prompt).toContain("Never claim an experience the voice section does not record.");
    // The verifiable-claims rules stay, and a recorded fact is declared as one.
    expect(prompt).toContain("Invent nothing.");
    expect(prompt).toContain('"business_profile" when it is about the business, the writer\'s use of it, or the writer (a fact the voice section records)');
    // Not on Reddit.
    expect(buildPlacementDraftPrompt(PlacementDraftInput.parse(base))).not.toContain("On X, speak from yourself");
  });

  it("shows a short reply the replies the owner posted, before the thread, and leaves the section out when there are none", () => {
    const voiceExamples = [
      {
        thread: "Honest numbers might be holding my product back. Kind of sad, but it seems true.",
        reply: "Not naive at all. I'm getting 200+ impressions on my blog now, still zero clicks. Honest numbers take time to compound. What kind of numbers are you seeing?",
      },
      { thread: X_THREAD.excerpt.slice(0, 200), reply: "I’m not good at doing the test I’m just thinking out loud ahahah" },
    ];
    const prompt = buildPlacementDraftPrompt(xInput({ voiceExamples }));
    expect(prompt).toContain("Replies you posted, in your own words: match this voice (how you open, how long you go, the register, what you admit), never their content or facts");
    expect(prompt).toContain("Where your notes say otherwise, casing included, the notes win.");
    expect(prompt).toContain(`1. Thread: "${voiceExamples[0].thread}"\n   You: "${voiceExamples[0].reply}"`);
    expect(prompt).toContain(`2. Thread: "${voiceExamples[1].thread}"\n   You: "${voiceExamples[1].reply}"`);
    // With the notes, ahead of the thread: the business's block, then the thread's.
    expect(prompt.indexOf("These are hard rules")).toBeLessThan(prompt.indexOf("Replies you posted"));
    expect(prompt.indexOf("Replies you posted")).toBeLessThan(prompt.indexOf("The discussion ("));
    // Deterministic: the same input is the same prompt.
    expect(buildPlacementDraftPrompt(xInput({ voiceExamples }))).toBe(prompt);

    expect(buildPlacementDraftPrompt(xInput())).not.toContain("Replies you posted");
    // A call that writes no short reply gets none.
    const issue = buildPlacementDraftPrompt(
      PlacementDraftInput.parse({ ...base, thread: { ...base.thread, surface: "github", kind: "issue" }, variants: ["github_issue"], voiceExamples })
    );
    expect(issue).not.toContain("Replies you posted");
    // Beside a detailed answer, the voice is the short reply's.
    const both = buildPlacementDraftPrompt(PlacementDraftInput.parse({ ...base, voiceExamples }));
    expect(both).toContain("match this voice in short_comment");
  });

  it("caps the examples the agent accepts: five at most, the reply at 280 characters, the thread at 200", () => {
    const one = { thread: "t", reply: "r" };
    expect(() => xInput({ voiceExamples: Array.from({ length: 5 }, () => one) })).not.toThrow();
    expect(() => xInput({ voiceExamples: Array.from({ length: 6 }, () => one) })).toThrow();
    expect(() => xInput({ voiceExamples: [{ thread: "t", reply: "x".repeat(281) }] })).toThrow();
    expect(() => xInput({ voiceExamples: [{ thread: "x".repeat(201), reply: "r" }] })).toThrow();
    expect(PlacementDraftInput.parse(base).voiceExamples).toEqual([]);
  });

  it("names the new structures, and tells a rewrite what to do with the lowercase note and deleted tells", () => {
    for (const structure of [
      '"It\'s tough to tell if..." / "It\'s hard to say whether..." (a hedge before the answer)',
      '"X is one thing, but Y" / "X is one thing; Y is another"',
      'a rhetorical question answered by a verdict ("...are they actually looking? That\'s the real test.")',
      '"Here\'s the thing"',
      '"The key is..."',
    ]) {
      expect(FORBIDDEN_STRUCTURES).toContain(structure);
    }
    const revised = buildPlacementDraftPrompt(
      xInput({ revisions: [{ variant: "short_comment", problems: ["Your notes ask for lowercase, and 3 of 3 sentences start with a capital."] }] })
    );
    expect(revised).toContain("Where a problem says your notes ask for lowercase, start every sentence lowercase.");
    expect(revised).toContain("Where a problem says sentences were deleted as a model's, write none of them again");
  });
});

describe("placement-draft prompt: the corrections the owner gave (version 18)", () => {
  const xInput = (over: Record<string, unknown> = {}) =>
    PlacementDraftInput.parse({ ...base, angle: null, chosenByPerson: true, thread: X_THREAD, variants: ["short_comment"], voice: OWNER_VOICE, ...over });
  const corrections = ["sounds like AI", "never start with It's", "use one of my real numbers"];

  it("carries the notes from earlier corrections as one short block beside the owner's notes, before the thread", () => {
    const voiceExamples = [{ thread: "Honest numbers might be holding my product back.", reply: "not naive at all. still zero clicks here." }];
    const prompt = buildPlacementDraftPrompt(xInput({ corrections, voiceExamples }));
    expect(prompt).toContain(
      "Corrections you gave on earlier drafts, avoid repeating these mistakes:\n- sounds like AI\n- never start with It's\n- use one of my real numbers\n"
    );
    // Under the floor, like the notes: a note asking for a number licenses none.
    expect(prompt).toContain("(Like your notes, they never override inventing nothing, naming no product and carrying no link.)");
    // Said once, right after the owner's notes, ahead of his posted replies and the thread.
    expect(prompt.split("Corrections you gave on earlier drafts")).toHaveLength(2);
    expect(prompt.indexOf("These are hard rules")).toBeLessThan(prompt.indexOf("Corrections you gave"));
    expect(prompt.indexOf("Corrections you gave")).toBeLessThan(prompt.indexOf("Replies you posted"));
    expect(prompt.indexOf("Corrections you gave")).toBeLessThan(prompt.indexOf("The discussion ("));
    // Deterministic, and for every variant, not only the short reply.
    expect(buildPlacementDraftPrompt(xInput({ corrections, voiceExamples }))).toBe(prompt);
    expect(buildPlacementDraftPrompt(PlacementDraftInput.parse({ ...base, corrections }))).toContain("- never start with It's");
    // Without notes of his own the block still stands, after the business.
    const bare = buildPlacementDraftPrompt(xInput({ corrections, voice: { ...OWNER_VOICE, instructions: "" } }));
    expect(bare).not.toContain("hard rules");
    expect(bare.indexOf("The business:")).toBeLessThan(bare.indexOf("Corrections you gave"));
  });

  it("leaves the block out when there are no corrections", () => {
    expect(PlacementDraftInput.parse(base).corrections).toEqual([]);
    expect(buildPlacementDraftPrompt(xInput())).not.toContain("Corrections you gave");
    expect(buildPlacementDraftPrompt(PlacementDraftInput.parse(base))).not.toContain("Corrections you gave");
    expect(correctionsSection({ corrections: [] })).toBeNull();
    expect(correctionsSection({ corrections: ["  "] })).toBeNull();
  });

  it("keeps the block small: eight notes at most, each at most 200 characters", () => {
    expect(CORRECTIONS_LIMIT).toBe(8);
    expect(PROMPT_REASON_MAX).toBe(200);
    const eight = Array.from({ length: CORRECTIONS_LIMIT }, (_, i) => `note ${i} `.padEnd(PROMPT_REASON_MAX, "x"));
    expect(() => xInput({ corrections: eight })).not.toThrow();
    expect(() => xInput({ corrections: [...eight, "one more"] })).toThrow();
    expect(() => xInput({ corrections: ["x".repeat(PROMPT_REASON_MAX + 1)] })).toThrow();
    // At its largest the block is about 1,800 characters: ~580 input tokens.
    expect((correctionsSection({ corrections: eight }) ?? "").length).toBeLessThan(1_800);
  });
});

const usage = { model: "stub", inputTokens: 100, outputTokens: 50, costUsd: 0.001 };

function stubLlm(structured: unknown): LLMProvider {
  return {
    name: "stub",
    async generateText(): Promise<LlmTextResult> {
      return { text: "", usage };
    },
    async generateStructured<T>(_prompt: string, schema: z.ZodType<T>): Promise<LlmStructuredResult<T>> {
      return { value: schema.parse(structured), usage, raw: "" };
    },
  };
}

describe("placement-draft output", () => {
  afterEach(() => setLlmProvider(null));

  it("drops a link the model declared on a reply and places none on a name, while the article still gets its link", async () => {
    // On X the drafter writes a reply and an article in one call. The reply
    // names the product with no URL in the text: before version 14 code put
    // the link on that name. Now the text is left for the gate to refuse.
    const reply = "Make every section answer its own question first. I use GetTrafficFast for the rest.";
    const articleBody = "Why answers skip you\n\nMake every section answer its own question first. My own blog runs on GetTrafficFast, for what it's worth. Then measure.";
    setLlmProvider(
      stubLlm({
        variants: [
          { variant: "short_comment", body: reply, linkUrl: "https://gettrafficfa.st", claims: [] },
          { variant: "article_draft", body: articleBody, linkUrl: null, claims: [] },
        ],
      })
    );
    const result = await placementDraftAgent.run(
      PlacementDraftInput.parse({ ...base, thread: { ...base.thread, surface: "x", kind: "post", community: "" }, variants: ["short_comment", "article_draft"] }),
      { userId: "user-1", businessId: "biz-1", jobId: "job-1", language: "en", runId: "run-1", budget: createBudget(1) }
    );
    const [comment, article] = result.output.variants;
    expect(comment).toMatchObject({ variant: "short_comment", body: reply, linkUrl: null });
    expect(article.variant).toBe("article_draft");
    expect(article.body).toContain("GetTrafficFast (https://gettrafficfa.st)");
    expect(article.linkUrl).toBe("https://gettrafficfa.st");
    expect(placementDraftAgent.version).toBe(23);
  });

  it("leaves a URL the model wrote into a reply where it is, so the gate refuses it and the rewrite is told why", async () => {
    const reply = "Make every section answer its own question first. The checklist is at https://gettrafficfa.st/blog/aeo.";
    setLlmProvider(stubLlm({ variants: [{ variant: "short_comment", body: reply, linkUrl: null, claims: [] }] }));
    const result = await placementDraftAgent.run(
      PlacementDraftInput.parse({ ...base, variants: ["short_comment"] }),
      { userId: "user-1", businessId: "biz-1", jobId: "job-1", language: "en", runId: "run-1", budget: createBudget(1) }
    );
    expect(result.output.variants[0]).toMatchObject({ body: reply, linkUrl: null });
  });

  it("asks for little thinking and two claims at most only when the call is an X reply (9 November 2026)", async () => {
    const seen: Array<{ prompt: string; thinking: string | undefined }> = [];
    setLlmProvider({
      ...stubLlm({ variants: [] }),
      async generateStructured<T>(prompt: string, schema: z.ZodType<T>, options?: LlmOptions): Promise<LlmStructuredResult<T>> {
        seen.push({ prompt, thinking: options?.thinking });
        return {
          value: schema.parse({ variants: [{ variant: "short_comment", body: "Not naive at all, it takes weeks.", linkUrl: null, claims: [] }] }),
          usage,
          raw: "",
        };
      },
    });
    const agentCtx = { userId: "user-1", businessId: "biz-1", jobId: "job-1", language: "en", runId: "run-1", budget: createBudget(1) };
    const x = { ...base.thread, surface: "x", kind: "post", community: "" };
    await placementDraftAgent.run(PlacementDraftInput.parse({ ...base, thread: x, variants: ["short_comment"] }), agentCtx);
    await placementDraftAgent.run(PlacementDraftInput.parse({ ...base, thread: x, variants: ["short_comment", "article_draft"] }), agentCtx);
    await placementDraftAgent.run(PlacementDraftInput.parse({ ...base, variants: ["short_comment"] }), agentCtx);

    expect(seen.map((call) => call.thinking)).toEqual(["low", "default", "default"]);
    expect(seen[0].prompt).toContain("two claims at most");
    expect(seen[1].prompt).not.toContain("two claims at most");
    expect(seen[2].prompt).not.toContain("two claims at most");
    expect(isXReplyOnly({ thread: x, variants: ["short_comment"] })).toBe(true);
    expect(isXReplyOnly({ thread: base.thread, variants: ["short_comment"] })).toBe(false);
  });
});
