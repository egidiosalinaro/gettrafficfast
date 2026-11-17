import { z } from "zod";
import { clampText } from "@/lib/content/text";
import { fetchLlmImages } from "@/lib/providers/llm/images";
import { getLlmProvider } from "@/lib/providers/llm/registry";
import { CLAIM_BASES, X_LIMIT, fitXLength } from "@/lib/placements/audit";
import { REASON_MAX, REASON_MIN } from "@/lib/placements/feedback";
import { variantNamesBusiness } from "@/lib/placements/link";
import { DraftImageInput, MAX_DRAFT_IMAGES, postImagesRule } from "@/lib/placements/media";
import { ReferencedPosts, referencedPostsRule } from "@/lib/placements/referenced";
import { POST_TONES, PostReading, describeReading, parseReading } from "@/lib/placements/reading";
import { PLACEMENT_VARIANTS } from "@/lib/placements/workflow";
import { NO_RECENT_FACTS, RecentFacts, STALE_FACTS_MAX, StaleFactForPrompt, factFitRule, recentFactsRule, staleFactsRule } from "@/lib/voice/fact-rules";
import { ABOUT_YOU_MAX, FACT_NOTES_YIELD, INSTRUCTIONS_MAX } from "@/lib/voice/settings";
import { Agent, AgentContext, AgentResult } from "./contract";
import { DraftImageOutcome } from "./placement-draft";

/**
 * Draft correction agent.
 *
 * The owner read a draft, said in one sentence what is wrong with it ("too
 * generic", "sounds like AI", "never start with It's", "use one of my real
 * numbers"), and wants it rewritten that way now. One call: the thread, the
 * draft, the note, and what is true about the writer (About you) and their
 * own notes. The note comes first; the gate's rules are the floor it cannot
 * go through: a reply names no product and carries no link, nothing about
 * the writer beyond About you, the writer's notes are rules, and an X reply
 * fits in 280 characters. The job that persists it runs the same gate
 * (`auditDraft`) on what comes back (lib/placements/correct.ts).
 *
 * Version 2 (10 November 2026): a fact from About you is used only where it
 * fits the post, and "Use one of my numbers" is no exception. That day a
 * reply on the GetTrafficFast account led with "12 paying stores", a figure
 * About you records about another product (Postwren), under a post about a
 * hackathon. The prompt now names the site and what it is about, says a
 * fact about another product stays out unless the post is about it, that a
 * note asking for a number gets none when none fits, and that a sentence of
 * About you dated more than 30 days ago is stated as of its date
 * (lib/voice/fact-rules.ts). The same gate checks it.
 *
 * Version 3 (10 November 2026): the note is an instruction to the writer,
 * never content to reply to. Under @DanaShips's jab at the CEOs who
 * call him a scammer, the owner's note was, in Italian, "Quello non è uno
 * struggle of getting traction è un post ironico sta prendendo in giro i
 * ceo boomer over 50", and version 1 answered it: "that's exactly how i
 * interpret these posts too, daniel. it seems like a common way to poke fun
 * at the struggle of getting traction…". The note now sits in a block that
 * says who it is written to (the writer, in any language), that it is
 * never quoted, answered or mentioned, that it overrules the earlier
 * reading of the post, and that words it says are wrong do not come back.
 * The reply keeps the draft's language whatever the note's. The stored
 * reading of the post is shown as the earlier one, and the call returns
 * the reading the correction leaves standing, which replaces it. The gate
 * checks the rewrite against the note (lib/placements/correction-check.ts).
 *
 * Version 4 (11 November 2026): the rewrite sees the post's images, as the
 * drafter does from its version 21. Under @cass_builds's "is this good for a
 * twelve day old site…" with a screenshot of the numbers, a note like
 * "look at the screenshot" could not be obeyed by a writer that never saw
 * it. Up to two images are fetched and passed as image inputs, the prompt
 * says the post includes them and that what they show is answered, never
 * asked for; one that does not load is left out and said so (`images`).
 *
 * Version 5 (12 November 2026): a fact used recently is not used again, and
 * a fact fits only a post about its subject. 5 of the last 17 drafts said
 * "position 30-40", one under @hank_ships's post about being called a
 * grifter. The rewrite is told which About you sentences the last ten
 * replies used (`recentFacts`, lib/placements/recent-facts.ts), the stronger
 * fit rule (a feeling, a belief, a position or a question when no fact fits,
 * never an invented event), and that a note asking for a number means "when
 * one fits" (`FACT_NOTES_YIELD`). The gate's advisory check "Repeats a
 * recent fact" judges the result.
 *
 * Version 6 (14 November 2026): the rewrite reads what the post quotes and
 * what it replies to, as the drafter does from its version 23 (under
 * @hank_ships's "Naming is the hardest part of shipping", the joke was in the quoted post).
 *
 * It returns the new text and the claims in it. The claims are bookkeeping,
 * not extra prose: the gate reads every sentence with a number against the
 * declared claims, and the old draft's claims describe the old text, so "use
 * one of my real numbers" would otherwise be refused for the number it asked
 * for. The prompt is short on purpose: the drafting prompt already shaped
 * the draft, and this call is about one note.
 */

export const DraftCorrectInput = z.object({
  /** Name and site: what a reply must not name or link, and what an article keeps. */
  business: z.object({
    name: z.string().min(1),
    site: z.string().nullable(),
    /** What the site is about, in one line: how the writer tells this site's facts from another's. */
    niche: z.string().nullable().default(null),
  }),
  thread: z.object({
    surface: z.string().min(1),
    kind: z.string().min(1),
    title: z.string().min(1),
    excerpt: z.string(),
    /** Who posted it, without "@"; null when not known. */
    author: z.string().nullable().default(null),
  }),
  /** What the post quotes and replies to (lib/placements/referenced.ts); null: not known. */
  referenced: ReferencedPosts.nullable().default(null),
  variant: z.enum(PLACEMENT_VARIANTS),
  /** The current text: the stored draft, or what the person edited it to. */
  draft: z.string().trim().min(1).max(20_000),
  /** The owner's note: what is wrong, in their words. */
  reason: z.string().trim().min(REASON_MIN).max(REASON_MAX),
  /** Settings → Voice → About you: the only experience the text may claim. */
  aboutYou: z.string().max(ABOUT_YOU_MAX).default(""),
  /** Settings → Voice → notes: the writer's own rules. */
  notes: z.string().max(INSTRUCTIONS_MAX).default(""),
  /**
   * How the post was read when the draft was written (kept beside its
   * audit). The correction may overrule it. Null: no reading was kept.
   */
  reading: PostReading.nullable().default(null),
  /** About you sentences dated more than 30 days ago, each with its date (lib/voice/staleness.ts). */
  staleFacts: z.array(StaleFactForPrompt).max(STALE_FACTS_MAX).default([]),
  /** Which About you sentences the last ten replies used (lib/placements/recent-facts.ts). */
  recentFacts: RecentFacts.default(NO_RECENT_FACTS),
  /** The post's images the rewrite is handed (lib/placements/media.ts), at most MAX_DRAFT_IMAGES. */
  images: z.array(DraftImageInput).max(MAX_DRAFT_IMAGES).default([]),
  /** Images the post has that the rewrite is not handed: named to the model as unseen. */
  unseenImages: z.number().int().min(0).max(20).default(0),
});
export type DraftCorrectInput = z.infer<typeof DraftCorrectInput>;

export const DraftCorrectOutput = z.object({
  body: z.string().min(1).max(20_000),
  claims: z
    .array(z.object({ text: z.string().min(1).max(300), basis: z.enum(CLAIM_BASES) }))
    .max(20),
  /** The reading of the post the correction leaves standing; null when the model gave none. */
  reading: PostReading.nullable().default(null),
  images: DraftImageOutcome.default({ seen: 0, failed: 0, failures: [] }),
});
export type DraftCorrectOutput = z.infer<typeof DraftCorrectOutput>;

/** What the MODEL is asked for; lengths and bases are settled below. */
const LlmCorrectOutput = z.object({
  reading: z.object({ tone: z.string(), means: z.string() }).nullish(),
  body: z.string().min(1),
  claims: z.array(z.object({ text: z.string(), basis: z.string() })).default([]),
});

/** True for the one variant on X that has to fit a post. */
function isXReply(input: Pick<DraftCorrectInput, "thread" | "variant">): boolean {
  return input.thread.surface === "x" && input.variant === "short_comment";
}

/** The prompt, exported so a test can read what the model is told. `images`: what the call hands over. */
export function buildDraftCorrectPrompt(
  input: DraftCorrectInput,
  images: { seen: ReadonlyArray<Pick<DraftImageInput, "altText" | "from">>; unseen: number } = { seen: input.images, unseen: input.unseenImages }
): string {
  const name = input.business.name;
  const imagesRule = postImagesRule(images.seen, images.unseen);
  const referencedRule = referencedPostsRule(input.referenced, input.thread.author);
  const aboutYou = input.aboutYou.trim();
  const notes = input.notes.trim();

  const naming = variantNamesBusiness(input.variant)
    ? `This is the ${input.variant === "article_draft" ? "article on the writer's own account" : "list entry"}: keep the one clause that names ${name}${input.business.site ? ` with its one link to ${input.business.site}` : ""}, as someone who uses it, never as its maker, and never as "${name} is what I use for that" or "I use ${name} for…". Name no other product and add no other link.`
    : `Name no product and put no link, URL or domain anywhere: not ${name}, not "the tool I use", not "what I use".`;

  const rules = [
    naming,
    `Invent nothing. A number, a result or an experience comes from About you or from the discussion, or it stays out. If the note asks for something you were not given (a number About you does not have), do without it rather than make it up.`,
    `${factFitRule({ name, niche: input.business.niche })} That holds for the owner's note too: if it asks for one of your numbers ("use one of my numbers") and no number in About you fits this post, use none and say the point without it.`,
    staleFactsRule(input.staleFacts),
    recentFactsRule(input.recentFacts),
    notes ? `Every one of the writer's notes holds. ${FACT_NOTES_YIELD}` : null,
    isXReply(input)
      ? `It is a reply on X: at most ${X_LIMIT} characters, spaces included. Count them. One paragraph.`
      : null,
    `The correction is not part of the conversation. Never quote it, never answer it, never agree or disagree with it, never mention that a note or a reading exists: no "that's how I read it too", no "as you said", no "you're right". The reply speaks to the poster, about the post, and to nobody else.`,
    `Words the correction says are wrong do not come back. If it says the post is "not X", neither X nor a paraphrase of X appears in the reply, not even to deny it.`,
    `If the correction says how the post is meant (ironic, a joke, mocking someone), that is how it is meant: write the reply a person who got the joke would write, playing along or adding a sharper example, with no sympathy and no advice for a problem the poster does not have.`,
    `Rewrite as much as the correction needs; keep the draft's point only where the correction does not touch it. Write in the language of the draft, which is the post's, whatever language the correction is written in. Return the text only: no comment on the change, no quotes around it.`,
  ].filter((line): line is string => line !== null);

  return `You are correcting a draft reply. Its owner read it and said what is wrong. They will post the result by hand, under their own name.

The owner's correction, written to you, the writer, not to the poster. It may be in any language. Obey it first. It overrules the draft's reading of the post: where the two disagree, the draft was wrong.
"""
${input.reason}
"""

The discussion (${input.thread.surface} ${input.thread.kind}):
Title: ${input.thread.title}
Text: ${input.thread.excerpt.slice(0, 1500) || "(no body text)"}
${referencedRule ? `\n${referencedRule}\n` : ""}${imagesRule ? `\n${imagesRule}\n` : ""}
The current draft (${input.variant}):
"""
${input.draft}
"""
${input.reading ? `\nHow the post was read when that draft was written (${describeReading(input.reading)}). If the correction reads the post differently, this reading was the mistake.\n` : ""}
About the writer, the only experience the text may claim: ${aboutYou || "nothing is recorded, so claim none: no \"I've been using\", no \"we've seen\", no results, no numbers about yourself."}
${notes ? `\nThe writer's own notes, hard rules:\n"""\n${notes}\n"""\n` : ""}
While you follow the correction:
${rules.map((rule, i) => `${i + 1}. ${rule}`).join("\n")}

Also list "claims": every sentence with a number and every statement about the writer, each with a basis: "business_profile" when it comes from About you, "thread" when it restates the discussion, "general_knowledge" for uncontroversial domain knowledge, "unverified" when unsure (better: leave it out of the text).${isXReply(input) ? " Two at most, often none." : ""}

Return JSON, with "reading" first: { "reading": { "tone": ${POST_TONES.map((tone) => `"${tone}"`).join(" | ")}, "means": one line, what the poster actually means, as the correction has it where it says }, "body": "...", "claims": [ { "text", "basis" } ] }.`;
}

export const draftCorrectAgent: Agent<DraftCorrectInput, DraftCorrectOutput> = {
  name: "draft-correct",
  version: 6,
  inputSchema: DraftCorrectInput,
  outputSchema: DraftCorrectOutput,

  async run(input, ctx: AgentContext): Promise<AgentResult<DraftCorrectOutput>> {
    const llm = getLlmProvider();
    // The images first, the way the drafter fetches them: one that does not
    // load is left out, and the prompt names only what the model receives.
    const fetched = input.images.length ? await fetchLlmImages(input.images.map((image) => image.url), { signal: ctx.signal }) : [];
    const seen = input.images.filter((_, index) => fetched[index]?.ok);
    // What is recorded is about the post's own images; a quoted post's that
    // does not load is only left out of the prompt.
    const failures = fetched.flatMap((result, index) =>
      result.ok || input.images[index]?.from === "quoted" ? [] : [result.detail.slice(0, 200)]
    );
    // A rewrite of one short text against one note: little thinking, the
    // way the X reply is drafted (docs/PLACEMENTS.md, 9 November 2026).
    const prompt = buildDraftCorrectPrompt(input, { seen, unseen: input.unseenImages + failures.length });
    const { value, usage } = await llm.generateStructured(prompt, LlmCorrectOutput, {
      tier: "quality",
      temperature: 0.5,
      thinking: "low",
      signal: ctx.signal,
      images: fetched.flatMap((result) => (result.ok ? [result.image] : [])),
    });

    // Trust the model for prose, never for bookkeeping: an X reply is fitted
    // to the post the way the drafting agent fits it, and a claim basis that
    // is not one of ours is unverified, which the gate refuses.
    let body = value.body.trim().slice(0, 20_000);
    if (isXReply(input)) body = fitXLength(body);
    const claims = value.claims
      .filter((claim) => claim.text.trim())
      .slice(0, 20)
      .map((claim) => ({
        text: clampText(claim.text, 300),
        basis: (CLAIM_BASES as readonly string[]).includes(claim.basis)
          ? (claim.basis as (typeof CLAIM_BASES)[number])
          : ("unverified" as const),
      }));

    return {
      output: {
        body,
        claims,
        reading: parseReading(value.reading),
        images: { seen: seen.filter((image) => image.from !== "quoted").length, failed: failures.length, failures },
      },
      usage: [usage],
    };
  },
};
