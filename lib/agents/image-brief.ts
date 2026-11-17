import { z } from "zod";
import { clampText } from "@/lib/content/text";
import {
  ALT_MAX_LENGTH,
  FALLBACK_HERO_SCENE,
  OFF_TOPIC,
  altIsFraming,
  relevanceProblems,
  sceneProblems,
} from "@/lib/media/scene-check";
import { MAX_INLINE_IMAGES } from "@/lib/media/settings";
import { getLlmProvider } from "@/lib/providers/llm/registry";
import { Agent, AgentContext, AgentResult } from "./contract";

/**
 * Image-brief agent — decides WHAT each image shows, and HOW MANY in-article
 * pictures this article is worth.
 *
 * The hero is a product decision: when images are on, every article is asked
 * for one. Inline count is a judgement about the article under a ceiling the
 * business set: code hands the agent that ceiling and enforces it, and the
 * agent may return no inline images.
 *
 * It also says what KIND of business this is to picture (`subject`): one with
 * something physical a camera can be pointed at, or a digital one. Code uses
 * that to keep the look coherent with the scene (lib/media/prompt.ts): a
 * "professional photograph" of software has no subject.
 *
 * Every scene is checked in code before it leaves (lib/media/scene-check.ts):
 * abstract vocabulary and text-bearing surfaces are rejected, the model is
 * asked ONCE more with the reasons, and a scene that still fails is dropped
 * and reported in `rejected`. Nothing is rendered from it, the hero included:
 * a missing image the owner is told about is better than a paid stock-AI
 * picture.
 *
 * Since 12 November 2026 the scene must also belong to the article: it
 * shares at least one concept with the title or the keyword (or, inline,
 * the section's heading), or it is the generic "person at a desk with a
 * laptop" (lib/media/scene-check.ts, `relevanceProblems`). That day an
 * article about AI SEO content writers got a florist arranging tulips. A
 * hero still off-topic after the second ask is replaced by one fixed scene,
 * `FALLBACK_HERO_SCENE`, recorded in `fallbacks`; it is not made from the
 * title. For a digital subject a laptop or monitor is allowed when its
 * screen shows only blurred shapes.
 *
 * It renders nothing and knows nothing about providers or brand styling: the
 * scene is inference, the look is settings, the rendering is a provider call —
 * three concerns, three places.
 */

export const ImageBriefInput = z.object({
  keyword: z.string().min(1),
  language: z.string().min(2),
  title: z.string().min(1),
  excerpt: z.string(),
  headings: z.array(z.object({ id: z.string(), level: z.number(), text: z.string() })),
  /**
   * The opening text of each section, by heading id ({} when the caller has
   * no body). With it the inline scenes are about what the section says, not
   * what its heading suggests.
   */
  sections: z.record(z.string(), z.string()),
  /** What the business is and does: what decides `subject`. */
  businessName: z.string().optional(),
  businessNiche: z.string().optional(),
  businessDescription: z.string().optional(),
  /** Ceiling for in-article images: the business's cap and the article's shape. */
  maxInline: z.number().int().min(0).max(MAX_INLINE_IMAGES),
});
export type ImageBriefInput = z.infer<typeof ImageBriefInput>;

const Brief = z.object({
  /** Scene description only — no style words, those are applied downstream. */
  scene: z.string().min(10).max(600),
  /** Accessibility text: what the scene literally contains, in the article's language. */
  alt: z.string().min(5).max(ALT_MAX_LENGTH),
  caption: z.string().max(200).nullable().default(null),
});
export type ImageBrief = z.infer<typeof Brief>;

const Subject = z.enum(["physical", "digital"]);

export const ImageBriefOutput = z.object({
  /** Whether the business has something physical to picture. */
  subject: Subject,
  /** Null when no acceptable hero scene came back after the second ask. */
  hero: Brief.nullable(),
  inline: z
    .array(Brief.extend({ headingId: z.string().min(1) }))
    .max(MAX_INLINE_IMAGES)
    .default([]),
  /** Scenes dropped by the check, with why. `slot` is "hero" or a heading id. */
  rejected: z
    .array(z.object({ slot: z.string(), scene: z.string(), problems: z.array(z.string()) }))
    .default([]),
  /** Off-topic scenes replaced by the fixed desk scene (the hero only), with the scene that was replaced. */
  fallbacks: z
    .array(z.object({ slot: z.string(), scene: z.string(), problems: z.array(z.string()) }))
    .default([]),
});
export type ImageBriefOutput = z.infer<typeof ImageBriefOutput>;

/**
 * What the MODEL is asked for: minimums only. Models cannot count characters
 * or items, so every maximum of the output contract is enforced by
 * deterministic clamping at the boundary, never by asking.
 */
const LlmBrief = z.object({
  scene: z.string().min(10),
  alt: z.string().min(5),
  caption: z.string().nullable().default(null),
});
const LlmImageBriefOutput = z.object({
  subject: Subject.default("physical"),
  hero: LlmBrief.nullable().default(null),
  inline: z.array(LlmBrief.extend({ headingId: z.string().min(1) })).default([]),
});

type LlmBriefValue = z.infer<typeof LlmBrief>;
type LlmPlan = z.infer<typeof LlmImageBriefOutput>;

/** The first sentence of a scene, as alt text of last resort. */
function altFromScene(scene: string): string {
  const first = scene.split(/(?<=[.!?])\s/)[0] ?? scene;
  return clampText(first.replace(/[.!?]+$/, ""), ALT_MAX_LENGTH);
}

/**
 * Clamps a brief to the contract. Alt text that frames instead of describing
 * ("an abstract representation of…") is replaced by the scene's own first
 * sentence: the scene has passed the check, so it says what is in the frame.
 */
function clampBrief(brief: LlmBriefValue): ImageBrief {
  const alt = altIsFraming(brief.alt) ? altFromScene(brief.scene) : clampText(brief.alt, ALT_MAX_LENGTH);
  return {
    scene: clampText(brief.scene, 600),
    alt,
    caption: brief.caption ? clampText(brief.caption, 200) : null,
  };
}

interface Candidate {
  /** "hero" or the heading id. */
  slot: string;
  brief: LlmBriefValue | null;
  problems: string[];
}

/**
 * The plan as slots, after boundary validation: a brief slotted against a
 * heading that does not exist — or a second brief for a section that already
 * has one — would trigger a paid render for an image the body can never
 * embed. Neither leaves the agent.
 */
function candidatesOf(plan: LlmPlan, input: ImageBriefInput): Candidate[] {
  const headingIds = new Set(input.headings.map((h) => h.id));
  const subject = plan.subject;
  const article = { title: input.title, keyword: input.keyword };
  const problemsOf = (scene: string, heading?: string) => [
    ...sceneProblems(scene, subject),
    ...relevanceProblems(scene, { ...article, heading }),
  ];
  const used = new Set<string>();
  const inline = plan.inline
    .filter((item) => {
      if (!headingIds.has(item.headingId) || used.has(item.headingId)) return false;
      used.add(item.headingId);
      return true;
    })
    .slice(0, input.maxInline);

  return [
    {
      slot: "hero",
      brief: plan.hero,
      problems: plan.hero ? problemsOf(plan.hero.scene) : ["no hero scene was returned"],
    },
    ...inline.map((item) => ({
      slot: item.headingId,
      brief: item as LlmBriefValue,
      problems: problemsOf(item.scene, input.headings.find((h) => h.id === item.headingId)?.text),
    })),
  ];
}

function buildPrompt(input: ImageBriefInput, feedback: Candidate[]): string {
  const outline = input.headings
    .map((h) => {
      const text = input.sections[h.id];
      return `- [${h.id}] ${"#".repeat(h.level)} ${h.text}${text ? `\n  ${text}` : ""}`;
    })
    .join("\n");

  const business = [
    input.businessName ? `Name: ${input.businessName}` : "",
    input.businessNiche ? `Niche: ${input.businessNiche}` : "",
    input.businessDescription ? `What it does: ${input.businessDescription}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const retry =
    feedback.length === 0
      ? ""
      : `

YOUR PREVIOUS PLAN WAS REJECTED. These scenes cannot be rendered:
${feedback
  .map(
    (item) =>
      `- [${item.slot}] ${item.brief ? `"${item.brief.scene}"` : "(missing)"} — problem: ${item.problems.join(", ")}`
  )
  .join("\n")}
Write the whole plan again. For each rejected slot describe a DIFFERENT scene: real people, places and objects only, none of the things named as problems, and do not mention those things even to say they are absent. An off-topic scene is replaced by one about this article's subject, or by a person working at a desk with a laptop.`;

  return `You are an art director planning images for a blog article.

The business this article is published by:
${business || "(not described)"}

Article title: ${input.title}
Target keyword: ${input.keyword}
Excerpt: ${input.excerpt}

Sections (each is [headingId] level heading, then how the section begins):
${outline}

First decide "subject":
- "physical" when the business makes, sells or does something that exists in front of a camera: a shop, a restaurant, a clinic, a trade, a product you can hold, a place people go.
- "digital" when it is software, an online service, an API, a marketplace or advice with nothing physical of its own.

Plan:
- ALWAYS one hero image that captures the article's core idea. The hero is required; never omit it and never return null for it.
- ${
    input.maxInline === 0
      ? "NO in-article images. Return an empty inline list."
      : `Up to ${input.maxInline} in-article image(s) — YOU decide how many this article genuinely deserves, including none. Add one only where a picture makes a section easier to grasp: concrete, visual, physical sections earn images; abstract or purely procedural ones do not. Base each on what the section's text says, not on its heading alone. Never illustrate two sections that would get near-identical pictures, and never put more than one image in the same section. Use the exact headingId from the list.`
  }

Rules for every scene (write scenes in English):
- A scene is something that could be in front of a camera: real people, places, tools, materials, objects, with a setting, a composition and a mood.
- The scene is about THIS article's subject, "${input.title}" (keyword: ${input.keyword}): it shows something the title or the keyword names. A florist, a café, a garden, a shop or any other business is NOT allowed unless the article is about that business, even when such businesses are among the publisher's customers.
- For a "physical" business: show the business's own world as the article describes it: its workplace, its products, its customers, the work being done.
- For a "digital" business: show the person the article is about doing that work. A person working at a desk with a laptop or a monitor is fine: describe the screen as out of focus, showing only soft blurred shapes. Two colleagues reviewing a printed draft at a desk, a writer with a notebook beside a laptop: the situation of the article, not the software.
- NEVER anything abstract or invented: nothing glowing, holographic, futuristic or floating, no brains, robots, networks, nodes, data streams, digital landscapes, icons or symbols, and no scene that "represents" or "symbolises" an idea. If the idea cannot be photographed, show a person or an object from the situation the article describes instead.
- NEVER anything that carries legible writing: no dashboards, apps, websites, user interfaces, charts, graphs, spreadsheets, calendars, planners, signs, posters, whiteboards, logos, text, words or numbers. A screen or monitor only for a "digital" business and only out of focus, with soft blurred shapes on it; a closed laptop or one seen from the side or behind is fine for anyone.
- Describe only what IS in the frame. Do not list what is absent.
- No style directives (no "photograph of", "illustration of", camera or art-style words) — style is applied elsewhere.
- The scene must make sense to a reader of THIS article; generic stock scenes ("business people shaking hands") are failures.
- alt: in ${input.language}, at most ${ALT_MAX_LENGTH} characters, naming only what the scene literally contains (who, what, where). Never "image of", never "representation of", never what the picture means.
- caption: only when it adds context beyond the alt; otherwise null.${retry}`;
}

export const imageBriefAgent: Agent<ImageBriefInput, ImageBriefOutput> = {
  name: "image-brief",
  version: 6,
  inputSchema: ImageBriefInput,
  outputSchema: ImageBriefOutput,

  async run(input, ctx: AgentContext): Promise<AgentResult<ImageBriefOutput>> {
    const llm = getLlmProvider(undefined, ctx.llmArm);
    const ask = (feedback: Candidate[]) =>
      llm.generateStructured(buildPrompt(input, feedback), LlmImageBriefOutput, {
        tier: "fast",
        temperature: 0.6,
        signal: ctx.signal,
      });

    const first = await ask([]);
    const usage = [first.usage];
    let subject = first.value.subject;
    let candidates = candidatesOf(first.value, input);

    // One more ask, and only when something failed: the second call is paid
    // for too, so a clean plan costs exactly one.
    const failed = candidates.filter((c) => c.problems.length > 0);
    if (failed.length > 0) {
      const second = await ask(failed);
      usage.push(second.usage);
      subject = second.value.subject;
      const retried = new Map(candidatesOf(second.value, input).map((c) => [c.slot, c]));
      // Slot by slot: a scene that was fine the first time is kept as it was;
      // a rejected one is replaced by its rewrite, acceptable or not.
      candidates = candidates.map((c) =>
        c.problems.length === 0 ? c : (retried.get(c.slot) ?? c)
      );
    }

    // A hero that is still about something else gets the one fixed desk
    // scene: a picture that fits a software article, never a florist.
    const fallbacks: ImageBriefOutput["fallbacks"] = [];
    candidates = candidates.map((c) => {
      if (c.slot !== "hero" || !c.brief || !c.problems.includes(OFF_TOPIC)) return c;
      fallbacks.push({ slot: c.slot, scene: clampText(c.brief.scene, 600), problems: c.problems });
      return { slot: c.slot, brief: { ...FALLBACK_HERO_SCENE }, problems: [] };
    });

    const accepted = candidates.filter((c) => c.brief && c.problems.length === 0);
    const hero = accepted.find((c) => c.slot === "hero");
    const inline = accepted
      .filter((c) => c.slot !== "hero")
      .map((c) => ({ ...clampBrief(c.brief as LlmBriefValue), headingId: c.slot }));
    const rejected = candidates
      .filter((c) => c.problems.length > 0)
      .map((c) => ({
        slot: c.slot,
        scene: c.brief ? clampText(c.brief.scene, 600) : "",
        problems: c.problems,
      }));

    return {
      output: {
        subject,
        hero: hero?.brief ? clampBrief(hero.brief) : null,
        inline,
        rejected,
        fallbacks,
      },
      usage,
    };
  },
};
