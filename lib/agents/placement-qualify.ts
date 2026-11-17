import { z } from "zod";
import { clampText } from "@/lib/content/text";
import { getLlmProvider } from "@/lib/providers/llm/registry";
import { ABOUT_YOU_MAX } from "@/lib/voice/settings";
import { Agent, AgentContext, AgentResult } from "./contract";

/**
 * Placement qualification agent.
 *
 * Discovery is deliberately generous: it costs no model call, so it stores
 * every thread that looks vaguely on-topic. This agent is where that pile is
 * cut down, and the whole value of the step is in what it REFUSES. A qualifier
 * that accepts everything is worse than none: it turns the review queue into
 * the same undifferentiated list, only now it has cost money to produce.
 *
 * It judges a batch in one call on purpose. The expensive part of the prompt is
 * the business context, and that context is identical for every thread of the
 * same customer, so paying for it once per batch rather than once per thread is
 * the difference between a sweep that runs weekly and one that cannot.
 *
 * The agent decides nothing about the database: it returns verdicts, and
 * `lib/placements/qualification.ts` applies the floor and the rules. That
 * separation is what keeps a generous model from flooding the queue.
 *
 * The angle is the one field the drafting step builds on, so its definition
 * matters more than it looks. Version 2 asked for "the specific thing they
 * can add" and got briefs to present the product ("explain how X automates
 * the whole workflow…"), and every draft built on such a brief read as an
 * advert however the drafter was told to write. Version 3 defines the angle
 * as knowledge a person would say, sensible with the business's name
 * deleted; a product pitch is no angle, and no angle is a rejection.
 * Version 4 learned from the first re-judgement in production, which wrote
 * the same pitch as "a new category of AI agents automates the entire
 * lifecycle": the category is the description in other words, and a thread
 * asking which tool to use has no honest answer naming the product unless
 * the person answering has a recorded relationship to it (Settings → Voice),
 * so the qualifier is now told who will answer.
 * Version 5 no longer reads the description. Every pitch-shaped angle in
 * production ("a fully automated agent addresses this by centralizing the
 * entire process", "end-to-end solutions, from autonomous keyword research
 * to direct publishing") was the description in other words, whatever the
 * prompt said about it. Domain fit is judged from the niche and the topics
 * the business knows about; a qualifier that has not read the brochure
 * cannot write it. The reply will always name the business once, as
 * something the writer uses (version 6: as a user, never as the maker), so
 * the angle never has to carry the product: it is knowledge or it is null.
 * Version 7 adds the "angle" mode. A person who clicks Generate has
 * decided the thread is worth answering; the first manual draft under the
 * re-judgement rejected the thread they had clicked for "age and
 * engagement unknown", after the batch had scored it 95, and the row
 * vanished from the inbox. In angle mode nothing about the thread's worth
 * is judged, only what to say. Version 8 takes the angles already refused
 * for the thread: a pitch-shaped first answer is asked again with that
 * answer quoted, instead of stopping the draft on the first try.
 * Version 9 names the pitch's second form. Every angle behind the drafts
 * of 29 September was the product's category argued as advice ("the real
 * game-changer for organic traffic is how seamlessly a tool integrates
 * writing with automated publishing"), and the drafter, told to build on
 * it, wrote the advert's argument in a user's voice. The angle is now one
 * concrete thing to do, check or avoid, typed the way the thread is typed,
 * true for someone who will never buy any tool, and in none of the
 * brochure's words.
 * Version 10 follows the drafter: a reply under a thread names no product
 * and links nothing (21 published replies that ended on "I use X for that"
 * read as adverts), and only the article on the writer's own account names
 * it once. So nothing about the business is the reply's job either, and a
 * thread asking which tool to use gets how to choose, full stop.
 * Version 11 judges the angle against the writer, not the business. On 8
 * November 2026, asked in angle mode about a post on illustrating dreams
 * with AI, it answered "rejected, score 0, outside the business's core
 * expertise in AI SEO content": the judge-mode test of domain fit, applied
 * where the owner had already decided to answer. A reply names no product
 * and speaks from the writer (About you, and the writer's own notes), so in
 * angle mode the business's topics are background, a thread outside them is
 * no reason to reject, and a short personal reply or a question back is an
 * angle. Posts a person chose by hand are no longer sent here at all: the
 * draft job lets the drafter pick their angle (placement-draft version 15).
 */

export const QualifyThread = z.object({
  /** Position in the batch. The only thing tying a verdict back to a row. */
  index: z.number().int().min(0),
  surface: z.string().min(1),
  /** thread, issue, repository, article, post… tone and expectations differ. */
  kind: z.string().min(1).default("thread"),
  community: z.string(),
  title: z.string().min(1),
  excerpt: z.string(),
  /**
   * Age in days at judging time, precomputed so the model never does date
   * maths. Null when the provider did not know the date: the model is told,
   * rather than shown a fake zero.
   */
  ageDays: z.number().int().min(0).nullable(),
  score: z.number().int().nullable(),
  commentCount: z.number().int().nullable(),
});
export type QualifyThread = z.infer<typeof QualifyThread>;

export const PLACEMENT_INTENTS = ["question", "recommendation", "comparison", "complaint", "showcase", "listing"] as const;

export const PlacementQualifyInput = z.object({
  /** Name, site and niche. Not the description (see the header). */
  business: z.object({
    name: z.string().min(1),
    niche: z.string().nullable(),
    domain: z.string().nullable(),
  }),
  /** What this customer can genuinely speak to: their keywords and entities. */
  expertise: z.array(z.string()).max(40).default([]),
  /**
   * How the person who will answer uses the business's product, in their
   * own words (Settings → Voice). The reply speaks as that user. Empty means
   * nothing is recorded, and the angle may lean on no experience.
   */
  aboutWriter: z.string().max(ABOUT_YOU_MAX).default(""),
  /**
   * The writer's own notes on how they write and what they never say
   * (Settings → Voice). Angle mode reads them beside `aboutWriter`: what
   * there is to say is judged against the person answering.
   */
  writerNotes: z.string().max(600).optional(),
  /**
   * Which model tier judges. A weekly batch of twenty is judged fast, which
   * is what makes a sweep affordable; one thread judged on the spot before a
   * draft is written gets the quality tier, because the angle it produces is
   * what the draft is built on and a cheap model keeps writing it as the
   * product.
   */
  tier: z.enum(["fast", "quality"]).default("fast"),
  /**
   * "judge": the weekly batch, where most threads should be rejected.
   * "angle": a person has already decided to answer this thread (they
   * clicked Generate), and the only question is what to say. Nothing about
   * the thread's worth is judged; unknown age, unknown engagement and a thin
   * discussion are not the model's concern. The verdict is "rejected" only
   * when nothing but the product can be said, and even then the caller
   * decides what that means for the row.
   */
  mode: z.enum(["judge", "angle"]).default("judge"),
  /**
   * Angle mode only: angles already given for this thread and refused by the
   * domain rule as a description of the product. Quoted back so the second
   * ask is for what remains when the product is deleted, not a paraphrase.
   */
  refusedAngles: z.array(z.string().max(300)).max(3).default([]),
  language: z.string().min(2),
  threads: z.array(QualifyThread).min(1).max(20),
});
export type PlacementQualifyInput = z.infer<typeof PlacementQualifyInput>;

export const PlacementVerdict = z.object({
  index: z.number().int().min(0),
  verdict: z.enum(["qualified", "rejected"]),
  /** 0-100: how worth answering this thread is. Not a probability. */
  score: z.number().min(0).max(100),
  /** Why, in one sentence, readable by the customer in the review queue. */
  reason: z.string().min(1).max(300),
  /**
   * What we can add that the thread does not already have. Null when there is
   * nothing: that is a rejection whatever the score says, enforced in the
   * domain layer rather than trusted to the model.
   */
  angle: z.string().max(300).nullable(),
  /** Two or three words naming the theme, so the inbox can group by it. */
  topic: z.string().max(60).nullable(),
  /** What the thread is doing: asking, asking for recommendations, comparing… */
  intent: z.enum(PLACEMENT_INTENTS).nullable(),
});
export type PlacementVerdict = z.infer<typeof PlacementVerdict>;

export const PlacementQualifyOutput = z.object({
  verdicts: z.array(PlacementVerdict).max(20),
});
export type PlacementQualifyOutput = z.infer<typeof PlacementQualifyOutput>;

/**
 * What the MODEL is asked for: no length caps. Models cannot count characters,
 * so every maximum is clamped deterministically below instead of requested.
 */
const LlmQualifyOutput = z.object({
  verdicts: z.array(
    z.object({
      index: z.number(),
      verdict: z.enum(["qualified", "rejected"]),
      score: z.number(),
      reason: z.string().min(1),
      angle: z.string().nullable(),
      topic: z.string().nullable().optional(),
      intent: z.string().nullable().optional(),
    })
  ),
});

export const placementQualifyAgent: Agent<PlacementQualifyInput, PlacementQualifyOutput> = {
  name: "placement-qualify",
  version: 11,
  inputSchema: PlacementQualifyInput,
  outputSchema: PlacementQualifyOutput,

  async run(input, ctx: AgentContext): Promise<AgentResult<PlacementQualifyOutput>> {
    const business = [
      `Name: ${input.business.name}`,
      input.business.domain ? `Site: ${input.business.domain}` : null,
      input.business.niche ? `Niche: ${input.business.niche}` : null,
      input.expertise.length ? `Topics they know about: ${input.expertise.join(", ")}` : null,
      `Who will answer: someone who uses ${input.business.name} in their own work, never someone who makes it. A reply under the thread names no product and links nothing; it is the answer and nothing else. So the angle never carries the product either.`,
      input.aboutWriter.trim()
        ? `What is true about them, in their own words (the only experience the reply may claim): ${input.aboutWriter.trim()}`
        : "Nothing about them is recorded: the angle may lean on no experience, no results, no time spent.",
      input.mode === "angle" && input.writerNotes?.trim()
        ? `Their own notes on how they write: ${input.writerNotes.trim()}`
        : null,
    ]
      .filter(Boolean)
      .join("\n");

    const threads = input.threads
      .map((t) => {
        const age = t.ageDays === null ? "age unknown" : `${t.ageDays} days old`;
        const score = t.score === null ? "engagement unknown" : `${t.score} points`;
        const comments =
          t.commentCount === null
            ? t.kind === "repository"
              ? "a repository (comments do not apply)"
              : "comment count unknown"
            : `${t.commentCount} comments`;
        return (
          `[${t.index}] ${t.surface} ${t.kind} / ${t.community} — ${age}, ${score}, ${comments}\n` +
          `Title: ${t.title}\n` +
          `Opening: ${t.excerpt.slice(0, 700) || "(no body text)"}`
        );
      })
      .join("\n\n");

    const refused = input.refusedAngles.filter((a) => a.trim());
    const judging =
      input.mode === "angle"
        ? `The owner has already decided to answer the discussion below. Do not judge whether it is worth answering: its age, its engagement, how many replies it has and whether it is still read are not your concern here, and unknown is not a reason for anything. Your only job is the angle, defined below. Return verdict "qualified" with the angle; return verdict "rejected" with angle null only when nothing but the product itself could be said.

The reply speaks as the person described above, not as the business: judge what there is to say against who they are, what is recorded about them, their notes and the thread itself. The business's topics are background, not a fence. A discussion outside them is never a reason to reject: a person answers a post about anything they have a real reaction to. A short personal reply, an honest reaction to what was shared, one detail from their own work, or a question back to the author is an angle. Score how good the angle is, not how close the thread is to the business.` +
          (refused.length
            ? `\n\nAlready refused for this thread, because each describes the product or its kind instead of saying something: ${refused.map((a) => `"${a}"`).join("; ")}. Do not return these or a paraphrase of them. Delete the product and its category from the picture and say what a person who knows the topic would add: a way to choose, a trade-off, a thing that goes wrong, a number they would check.`
            : "")
        : `Judge each page below on four things, and reject unless all four hold:
1. Domain fit — is the question something this business genuinely knows about? Adjacent is not enough. A thread about a topic they merely have an opinion on is a rejection.
2. Still alive — a thread nobody will read again is worthless however good the answer. Age is given in days when known; older threads need much stronger reasons. When the age is unknown, judge from the text alone: unknown is not old, and unknown age or engagement is never by itself a reason to reject.
3. Likely to be read by an answer engine — a real question with real discussion under it, not a poll, a meme, a rant, a job post, a "what do you think" with two replies, or a thread whose answer is a single fact. A GitHub repository counts only if it is a curated list of tools in the business's category with a clear way to be added; a GitHub issue counts only if it asks for something the business actually does.
4. Something to add — can this business say something the thread does not already contain? If the top comments already answer it well, there is nothing to add and it is a rejection.

Reject generously. Most threads should be rejected: a shortlist of three good ones beats a list of forty, because a person has to read every one of them and write a real answer under their own name.

Never qualify a thread where the honest answer would be an advert for the business. The test the answer will later have to pass is: is it still useful with the link deleted? A thread where that is impossible is a rejection now, not a bad draft later.`;

    const prompt = `You are deciding which public discussions a business should spend an expert answer on.

The business:
${business}

${judging}

For each page return:
- index: the number in brackets, exactly as given.
- verdict: "qualified" or "rejected".
- score: 0-100, how worth answering it is.
- reason: one sentence, addressed to the business owner, saying why.
- angle: for a qualified thread, the first sentence the person would type in their reply: the specific thing they know that the thread does not already contain. A piece of knowledge, a method, a trade-off, an observation from doing the work, drawn from what the person answering knows (the topics above, or what is recorded about them), not from what they sell. Two angles in the right shape: "Answer engines retrieve passages, not pages, so a section that answers its own question in its first two sentences gets picked whatever tool wrote it." and "Zero-click numbers count searches, not buyers; the pages that lost clicks and the pages that lost revenue are rarely the same pages, so separate them before changing anything." Never a brief about the product or its kind: "explain how X automates…", "introduce X as…", "consider tools that function as autonomous agents handling the entire workflow…", "a new category of AI agents automates the entire lifecycle…", "a tool that handles everything from A to Z", "a fully automated agent addresses this by centralizing the process", "end-to-end solutions from research to publishing" are the product in other words, and are not angles. The angle must still make sense with the business, its product and its product category deleted; if nothing remains after that, the angle is null and the thread is rejected.
  When the thread asks which tool to use, the angle is how to choose (what to look for, what the trade-offs are), never the product, and the reply will not say which one the writer uses either.
  The pitch has a second form, the product's category as advice: "prioritize tools that integrate publishing and the content calendar, that's where the time goes", "the real game-changer is how seamlessly a tool connects writing to publishing", "automating the calendar is crucial to stay consistent". That is what the product does, argued as a principle, and a reply built on it is an advert in a user's mouth. Not an angle either. Write the angle the way it would be typed in the thread: plain words, one concrete thing to do, check or avoid, true for a person who will never buy any tool — "run three real posts through any tool before paying for a year, and check whether you can edit before it goes live" is an angle; "look for tools that automate the whole flow" is not. None of these words: game-changer, seamless, streamline, crucial, vital, the entire workflow, end-to-end, hands-off, bogged down, the real value, the real bottleneck.
- topic: two or three words naming the theme (e.g. "email deliverability", "AI SEO tooling"). Null if unclear.
- intent: one of "question", "recommendation" (asking what to use), "comparison", "complaint", "showcase", "listing" (a curated list). Null if none fits.

Return one verdict per page, no more.

Write reason and angle in ${input.language}. Write topic in ${input.language} too.

Threads:
${threads}`;

    const llm = getLlmProvider();
    const { value, usage } = await llm.generateStructured(prompt, LlmQualifyOutput, {
      tier: input.tier,
      temperature: 0.1,
      signal: ctx.signal,
    });

    // Trust the model for judgement, never for bookkeeping: a verdict whose
    // index is not in the batch is dropped rather than mapped onto whatever
    // row happens to sit there, and a repeated index keeps its first verdict.
    const known = new Set(input.threads.map((t) => t.index));
    const seen = new Set<number>();
    const verdicts: PlacementVerdict[] = [];

    for (const v of value.verdicts) {
      const index = Math.trunc(v.index);
      if (!known.has(index) || seen.has(index)) continue;
      seen.add(index);
      const intent = (v.intent ?? "").trim().toLowerCase();
      verdicts.push({
        index,
        verdict: v.verdict,
        score: Math.max(0, Math.min(100, v.score)),
        reason: clampText(v.reason, 300),
        angle: v.angle?.trim() ? clampText(v.angle.trim(), 300) : null,
        topic: v.topic?.trim() ? clampText(v.topic.trim(), 60) : null,
        // An intent outside the vocabulary is dropped, not mapped onto the
        // nearest one: the inbox filter must mean what it says.
        intent: (PLACEMENT_INTENTS as readonly string[]).includes(intent)
          ? (intent as (typeof PLACEMENT_INTENTS)[number])
          : null,
      });
    }

    const missing = input.threads.length - verdicts.length;

    return {
      output: { verdicts },
      usage: [usage],
      // Unjudged threads stay `discovered` and come back next sweep. Saying so
      // is what stops that looking like a run that judged everything.
      notes: missing > 0 ? [`${missing} of ${input.threads.length} threads got no verdict`] : [],
    };
  },
};
