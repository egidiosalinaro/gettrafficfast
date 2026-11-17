import { z } from "zod";
import { clampText } from "@/lib/content/text";
import { domainOf } from "@/lib/providers/serp/types";
import { isCompanySource } from "@/lib/domain/source-matching";
import { fetchLlmImages } from "@/lib/providers/llm/images";
import { getLlmProvider } from "@/lib/providers/llm/registry";
import { CLAIM_BASES, fitXLength } from "@/lib/placements/audit";
import { DraftImageInput, MAX_DRAFT_IMAGES, postImagesRule } from "@/lib/placements/media";
import { ReferencedPosts, referencedPostsRule } from "@/lib/placements/referenced";
import { PROMPT_REASON_MAX } from "@/lib/placements/feedback";
import { linkStyle, linkTheName, ownLinkIn, replyCarriesUrl, siteUrl, variantCarriesLink, variantNamesBusiness } from "@/lib/placements/link";
import { VOICE_EXAMPLE_LIMIT, VOICE_EXAMPLE_REPLY_CHARS, VOICE_EXAMPLE_THREAD_CHARS } from "@/lib/placements/voice-examples";
import { POST_TONES, PostReading, READ_THE_POST, parseReading } from "@/lib/placements/reading";
import { PLACEMENT_VARIANTS, type PlacementVariant } from "@/lib/placements/workflow";
import { NO_RECENT_FACTS, RecentFacts, STALE_FACTS_MAX, StaleFactForPrompt, factFitRule, recentFactsRule, staleFactsRule } from "@/lib/voice/fact-rules";
import { DEFAULT_VOICE_SETTINGS, VoiceSettings, describeVoice, notesAsRules } from "@/lib/voice/settings";
import { Agent, AgentContext, AgentResult } from "./contract";

/**
 * Placement drafting agent.
 *
 * Writes the reply a qualified thread deserves, in the shapes the surface
 * calls for. The prompt is built around two tests. The gate's: is this still
 * useful with the link deleted? And the reader's: could a person in this
 * discussion plausibly have written it? The first version passed the gate
 * and failed the reader — acknowledge the competitors, pivot, list the
 * benefits, close on the product — so version 3 names the structures and
 * words it must not use, takes the business's own voice (lib/voice/settings)
 * and the approach the job picked for this reply, and states what the writer
 * can truthfully say about themselves so that nothing else gets invented.
 * Version 4 came from reading version 3's first production draft: the model
 * paraphrased the business description (which onboarding writes as marketing
 * copy) into a walk through the whole workflow and closed on "services like
 * X". So the description was labelled as copy to learn from and never
 * reuse, the product got at most two statements, and experience the voice
 * did not record became a claim, not colour.
 *
 * Version 7 stops handing the model the description at all. Three versions
 * told it not to reuse the copy and every production draft reused it:
 * "keyword research, content calendar, daily articles, publish directly"
 * was the brochure paragraph of every blocked reply. A writer that has never
 * read the brochure cannot paraphrase it. The reply must name the business
 * once (the gate refuses a reply that never does: a comment with no name in
 * it is not a placement) and may say nothing about what the product does
 * beyond that clause.
 *
 * Version 8 fixes who is speaking. Version 7 had the writer disclose as
 * the maker ("I work on X, so weigh this accordingly"), and the owner's
 * verdict was immediate: it must always read as written by someone who
 * uses the product, never by someone who builds it. So the writer is a
 * user of the business's product; the one clause that names it is about
 * their own use, and what that use is comes from Settings → Voice
 * (`aboutYou`) and nowhere else. With nothing recorded there, nothing
 * about using the product can be said honestly, and the job refuses to
 * write before the model is paid (docs/PLACEMENTS.md). Maker phrasing is
 * a refusal in the gate whatever else the reply does right.
 *
 * Version 10 links the product in every reply. The owner's call: the clause
 * that names the business carries one link to its site, as a Markdown link
 * on the name where Markdown renders and as the bare URL in parentheses
 * elsewhere. One link, beside the name, never in the opening; the gate
 * requires it, and the reply must still stand with the link and the
 * mention deleted.
 *
 * Version 11 is about the register. Every draft of 29 September passed the
 * gate and read as written by a model: a framing sentence ("it's easy to
 * get caught up in content quality"), the pivot to "where the real
 * bottleneck lies", abstract nouns doing the work ("the automation of
 * publishing makes a significant impact"), the mention, and a last sentence
 * telling the reader how to think ("Considering the path from idea to post
 * can change how you weigh a tool"). And the argument underneath was the
 * advert's: the reply's thesis was that the thing the writer uses the
 * product for is what matters most. So the angle is now a place to start,
 * never the thesis; the first sentence is the answer; sentences are short
 * and use the thread's own nouns; the last sentence is a concrete detail or
 * a question, never a summary; and the prompt shows one reply in that shape,
 * about something unrelated, because "sound human" is not an instruction a
 * model can follow and a shape is.
 *
 * Version 14 takes the product out of the reply. The 21 replies published
 * between 28 September and 8 October 2026 (X, Reddit, LinkedIn, Quora) all
 * had one shape: generic advice, then one sentence naming the product with
 * its link ("GetTrafficFast (https://gettrafficfa.st/) is what I use for
 * that"). Each read as a disguised advert and none brought anything. So a
 * reply, on every surface, names no product and carries no link: it is the
 * answer, in the owner's voice, and a reader finds the business through the
 * profile. Only the awesome-list entry and the article on the writer's own
 * account still name the project once, with the link; the article's clause
 * may not take the "I use X for that" shape either, which the gate refuses
 * everywhere. A link the model declares on a reply is dropped as
 * bookkeeping; a URL it writes into one is left for the gate to refuse, so
 * the rewrite is told why. The shape example names no tool.
 *
 * Version 15 lets the drafter pick the angle, and judges relevance against
 * the writer. On 8 November 2026 a post the owner chose by hand (inkwell_ivy
 * turning his sketches into watercolors with AI) never reached this agent: the qualifier,
 * asked for an angle, rejected it as "outside the business's core expertise
 * in AI SEO content", and the job declined with a sentence about adverts. A
 * reply names no product, so whether there is something to say is a
 * question about the writer (About you, their notes) and the thread, not
 * the business's keywords. When a person chose the post, or asked for the
 * draft anyway, the job passes no angle (`angle` null, `chosenByPerson`):
 * the prompt says the person decided, that declining is not an option, and
 * that a light personal reply or a question back is a reply.
 *
 * Version 16 makes the X reply fast. On 9 November 2026 the owner's first
 * hand-added X post took 63 s: one call that thought for most of 25 s and
 * wrote a good reply plus a 400-word article nobody asked for, then a
 * second call of 31 s to rewrite the article the gate refused. X now gets
 * only the reply (`variantsFor`); a call that asks for nothing but an X
 * reply asks the provider for little thinking (`thinking: "low"`) and for
 * two claims at most, because a 280-character reply has no more to declare.
 *
 * Version 17 writes as the owner, not as a model. The X reply of 9 November
 * 2026 ("It's tough to tell if these tools work without knowing if the
 * audience is actually ready to buy. Finding them is one thing, but are they
 * actively looking for a solution? That's the real test.") passed the gate,
 * and the owner read it at once as AI: the hedge, the one-thing pivot, the
 * verdict after a rhetorical question, sentence case under notes that open
 * "Lowercase, short lines, like a reply typed on a phone", and nothing of
 * him though About you records his numbers and his work. So his notes are
 * now hard rules near the top of the prompt (`notesAsRules`), not a line at
 * the bottom; an X reply is told to speak from one concrete fact About you
 * records, or an honest reaction, or one short question, casually, and that
 * admitting a limit is fine; and a short reply is shown the replies he
 * actually posted (`voiceExamples`, lib/placements/voice-examples.ts), with
 * the sentences the gate refuses left out, as the voice to match. The gate
 * learned the new tells and checks lowercase against the notes.
 *
 * Version 18 is told what the owner already corrected. Since 9 November 2026
 * a draft can be fixed on its card with a note ("sounds like AI", "too long",
 * "use one of my numbers"), and the note is kept (`draft_feedback`). Fixing
 * one draft did not teach the next one, so the job reads the business's last
 * distinct notes (`recentFeedback`, CORRECTIONS_LIMIT at most, each already
 * clamped to 200 characters) and the prompt carries them as one short block
 * beside the owner's notes: "Corrections you gave on earlier drafts, avoid
 * repeating these mistakes". They rank with the notes, under inventing
 * nothing, naming no product and carrying no link. No notes, no block.
 *
 * Version 19 uses a fact only where it fits. On 10 November 2026, on the
 * GetTrafficFast site, About you held "Co-founded Postwren, email marketing
 * for Shopify stores: 12 paying stores in October 2026." and the notes said
 * "Lead with a number". Under a post about a hackathon judged by paying
 * customers, version 18 wrote "12 paying stores for my own thing felt like
 * real validation. letting customers decide is a smart way to run a
 * hackathon." and the gate passed it. The fact was true to the list and
 * wrong for the post: another product's, on this site's account; "stores"
 * means nothing to a reader who does not know that product; and a month old.
 * So rule 5 now says a fact is stated only when it is about the post's
 * subject and a stranger understands it, names the site the reply is
 * written for and what it is about (`business.niche`, the one line that says
 * so) so the model can tell which facts are this site's, and says that
 * with no fitting fact the reply carries no number: a note about style
 * never forces one (`factFitRule`, lib/voice/fact-rules.ts). And each About
 * you sentence dated more than 30 days ago is handed over with its date
 * (`staleFacts`, read by the job, lib/voice/staleness.ts), to be stated as
 * of that date or left out. The gate checks both (lib/placements/fact-fit.ts).
 *
 * Version 20 reads the post before it writes. On 10 November 2026
 * @DanaShips posted "Every time one of my LinkedIn posts gets traction,
 * some 50+ year old CEO turns up to call me a scammer. For sharing my own
 * revenue. Is this the price of posting???", mocking the CEOs, and version
 * 18 wrote "it's frustrating when that happens, especially after putting
 * your own numbers out there…": sympathy for a problem he does not have. In
 * the same call the model now returns `reading` first, the post's tone
 * (sincere, ironic, joke, rant, question) and one line of what the poster
 * actually means, and writes the reply to fit it: an ironic post gets a
 * reply that plays along, never sympathy or advice (`READ_THE_POST`,
 * lib/placements/reading.ts). The reading is returned with the variants and
 * kept beside the draft's audit; it is the model's judgement, and nothing
 * is computed from it. A reading the model garbles is null, never guessed.
 *
 * Version 21 sees the post's images. On 11 November 2026 @cass_builds posted
 * "hi guys, are these numbers normal for a twelve day old project with a brand new
 * domain? asking for a friend" with a screenshot of the numbers, and
 * version 20, which never saw an image, answered blind and asked "what kind
 * of traffic are you seeing so far?", which the screenshot showed. The job
 * now hands up to two of the post's images (a photo, or a video's still;
 * lib/placements/media.ts) and the agent fetches them before the call and
 * passes them to the model as image inputs (`LlmOptions.images`). The
 * prompt says the post includes them, gives the poster's alt text, and
 * says: answer what they show, never ask for what the image already shows.
 * An image that cannot be fetched (403, timeout) is left out, the draft is
 * written without it, and the output says so (`images`), so the job records
 * it and the gate's advisory check "Image not read" tells the person. An
 * image the post has and nobody could read is named to the model as one it
 * cannot see: it neither guesses at it nor asks for it.
 *
 * Version 22 says something new, or nothing about the writer. On 12
 * November 2026 About you held one usable fact, the owner's blog numbers,
 * and 5 of the last 17 drafts said "position 30-40"; under @hank_ships's post
 * about being called a grifter, about building for the joy of it and not
 * the money, version 21 wrote "i'm still trying to get my blog articles
 * past position 30-40, so i know the grind is real". So the job now hands
 * over which About you sentences the last ten replies used (`recentFacts`,
 * lib/placements/recent-facts.ts), and the prompt says not to use them
 * again unless the post asks about exactly that. Rule 5 says the same
 * subject is what the post is about as read, not a shared word (rankings
 * are not motivation); that with no fitting fact the reply may give a
 * feeling or a belief in first person, with no number and no event, take a
 * position or ask one sharp question; and that an event ("when someone paid
 * for my app") is a fact, never invented to carry a feeling. The reading's
 * "what the poster means" decides the angle, and a note like "Lead with a
 * number or a concrete thing I did" reads as "when one fits"
 * (`FACT_NOTES_YIELD`, lib/voice/settings.ts). About you now holds 2,000
 * characters, room for more than one kind of fact.
 *
 * Version 23 reads what the post quotes and what it replies to. On 14
 * November 2026 @hank_ships posted "Naming is the hardest part of shipping", quoting an
 * automated listing for "Pet Portrait AI": the joke was all in
 * the quoted post, which the drafter never saw. The job now hands over the
 * quoted post and the post being answered (`referenced`,
 * lib/placements/referenced.ts), quoted in the prompt apart from the post
 * ("The post quotes @listing_bot: «…»"), with the quoted post's photos in the
 * image slots the post's own leave free; the reading, returned first, sees
 * them. A quoted post nobody could read is named as unread, never guessed.
 *
 * Every factual claim is still listed with what it rests on; a claim the
 * model cannot ground is marked unverified, which the gate refuses. The agent
 * writes; it never posts (docs/PLACEMENTS.md).
 */

/**
 * The longest a problem handed to a rewrite may be. The gate quotes what
 * tripped each check (the brochure's statements, the words behind each
 * tell), and the job clamps to this before asking, so a thorough checklist
 * never fails the input schema and ends the job.
 */
export const PROBLEM_MAX_CHARS = 600;

/**
 * The owner's corrections a draft is told about: the newest distinct notes,
 * each at most PROMPT_REASON_MAX (200) characters. At worst the block is
 * about 1,800 characters (~580 input tokens at ~3.1 characters a token);
 * four short notes like the presets are about 250 (~80 tokens).
 */
export const CORRECTIONS_LIMIT = 8;

export const PlacementDraftInput = z.object({
  /**
   * Name, site and niche. Not the description: the writer that reads the
   * brochure writes the brochure, three prompt versions proved it.
   */
  business: z.object({
    name: z.string().min(1),
    domain: z.string().nullable(),
    niche: z.string().nullable(),
  }),
  /** What this customer can genuinely speak to: their keywords and entities. */
  expertise: z.array(z.string()).max(40).default([]),
  thread: z.object({
    surface: z.string().min(1),
    kind: z.string().min(1),
    community: z.string(),
    title: z.string().min(1),
    excerpt: z.string(),
    author: z.string().nullable(),
  }),
  /**
   * What the qualifier said this business can add. The draft starts from it.
   * Null when a person chose the post (or asked for the draft anyway): the
   * drafter finds the angle in the thread and in what is true about the
   * writer.
   */
  angle: z.string().min(1).nullable().default(null),
  /**
   * True when a person decided this post gets a reply: added by hand, or
   * "Write it anyway" after a decline. The prompt then says so, and that
   * the reply is written whatever the thread's distance from the business.
   */
  chosenByPerson: z.boolean().default(false),
  /** How this business sounds, and what it can truthfully say about itself. */
  voice: VoiceSettings.default(DEFAULT_VOICE_SETTINGS),
  /**
   * Replies the owner posted, in his own words, loaded by the job
   * (lib/placements/voice-examples.ts) for a short reply. Shown as the voice
   * to match, never as content. Empty: the section is left out.
   */
  voiceExamples: z
    .array(
      z.object({
        thread: z.string().max(VOICE_EXAMPLE_THREAD_CHARS),
        reply: z.string().min(1).max(VOICE_EXAMPLE_REPLY_CHARS),
      })
    )
    .max(VOICE_EXAMPLE_LIMIT)
    .default([]),
  /**
   * The notes the owner gave when correcting earlier drafts (`draft_feedback`,
   * lib/placements/feedback.ts `recentFeedback`), newest first. Shown as
   * mistakes not to repeat, beside the owner's notes. Empty: no block.
   */
  corrections: z.array(z.string().min(1).max(PROMPT_REASON_MAX)).max(CORRECTIONS_LIMIT).default([]),
  /**
   * The About you sentences dated more than 30 days ago, each with its date,
   * read by the job (lib/voice/staleness.ts). The prompt says to state them
   * as of that date, never as current. Empty: no block.
   */
  staleFacts: z.array(StaleFactForPrompt).max(STALE_FACTS_MAX).default([]),
  /**
   * Which About you sentences the last ten replies of this business used
   * (lib/placements/recent-facts.ts), the most used first. The prompt says
   * not to use them again unless the post asks about exactly that. Empty:
   * no block.
   */
  recentFacts: RecentFacts.default(NO_RECENT_FACTS),
  /**
   * The post's images the call is handed (lib/placements/media.ts,
   * `draftImagePlan`): at most MAX_DRAFT_IMAGES, each an image URL and the
   * poster's alt text. The agent fetches them; an image that does not load
   * is left out and said so in the output. Empty: a text-only call. The
   * quoted post's images (`from: "quoted"`) come after the post's own, in
   * the slots they leave free.
   */
  images: z.array(DraftImageInput).max(MAX_DRAFT_IMAGES).default([]),
  /** Images the post has that the call is not handed (never read, past the cap): named to the model as unseen. */
  unseenImages: z.number().int().min(0).max(20).default(0),
  /**
   * What the post quotes and what it replies to (lib/placements/referenced.ts),
   * read or recorded as unread. Null: not known, nothing is said.
   */
  referenced: ReferencedPosts.nullable().default(null),
  /** The shape this reply takes, dealt by the job so replies do not all look alike. */
  approach: z.string().max(300).default(""),
  language: z.string().min(2),
  variants: z.array(z.enum(PLACEMENT_VARIANTS)).min(1).max(3),
  /**
   * Set only on a rewrite. The job already audited the first draft and these
   * are the checks it failed. The model is told the problems, not shown the
   * old text: the old text is the advert it would otherwise trim and keep.
   */
  revisions: z
    .array(
      z.object({
        variant: z.enum(PLACEMENT_VARIANTS),
        problems: z.array(z.string().max(PROBLEM_MAX_CHARS)).max(8),
      })
    )
    .max(3)
    .default([]),
});
export type PlacementDraftInput = z.infer<typeof PlacementDraftInput>;

export const DraftVariant = z.object({
  variant: z.enum(PLACEMENT_VARIANTS),
  body: z.string().min(1).max(20_000),
  /** One link, only to the business's own domain, only when it adds value. */
  linkUrl: z.string().url().nullable(),
  claims: z
    .array(z.object({ text: z.string().min(1).max(300), basis: z.enum(CLAIM_BASES) }))
    .max(20),
});
export type DraftVariant = z.infer<typeof DraftVariant>;

/** What the model was handed of the images it was given to look at, and why not the rest. */
export const DraftImageOutcome = z.object({
  /** Images the model received with the prompt. */
  seen: z.number().int().min(0),
  /** Images the call was given that did not load, so the model did not receive them. */
  failed: z.number().int().min(0),
  /** One short reason per failed image ("the image answered 403"). */
  failures: z.array(z.string().max(200)).max(MAX_DRAFT_IMAGES),
});
export type DraftImageOutcome = z.infer<typeof DraftImageOutcome>;

export const PlacementDraftOutput = z.object({
  variants: z.array(DraftVariant).min(1).max(3),
  /** How the model read the post before writing; null when it gave none it could be held to. */
  reading: PostReading.nullable().default(null),
  images: DraftImageOutcome.default({ seen: 0, failed: 0, failures: [] }),
});
export type PlacementDraftOutput = z.infer<typeof PlacementDraftOutput>;

/** What the MODEL is asked for: no length caps, they are clamped below. */
const LlmDraftOutput = z.object({
  reading: z.object({ tone: z.string(), means: z.string() }).nullish(),
  variants: z.array(
    z.object({
      variant: z.string(),
      body: z.string().min(1),
      linkUrl: z.string().nullable(),
      claims: z.array(z.object({ text: z.string(), basis: z.string() })).default([]),
    })
  ),
});

const VARIANT_BRIEF: Record<(typeof PLACEMENT_VARIANTS)[number], string> = {
  short_comment:
    "short_comment: a reply of 2–6 sentences, the length a regular in that community actually types. Plain, specific, no headings.",
  detailed_answer:
    "detailed_answer: a fuller reply of 100–300 words that walks through the how, with concrete steps or trade-offs. Short paragraphs; a list only when the content is a list.",
  article_draft:
    "article_draft: a 400–800 word first-person article for the business owner's own account (LinkedIn or X long form), answering the question the thread raises. A title on the first line.",
  github_issue:
    "github_issue: a comment on the issue, technical and concise, addressing the maintainers: what the problem is and how it can be solved. No product named, no link.",
  github_pr_proposal:
    "github_pr_proposal: the exact line(s) to add to the list, in the list's existing format, followed by a two-sentence PR description. Nothing promotional.",
};

/**
 * The shape of one variant, for this surface.
 *
 * The generic short comment is a few sentences. On X that instruction loses
 * to the 280-character limit every time, and the draft comes back at twice
 * the length the gate will then refuse. The limit belongs on the variant,
 * as a count, not as a footnote under "the platform".
 */
export function variantBrief(variant: (typeof PLACEMENT_VARIANTS)[number], surface: string): string {
  if (variant === "short_comment" && surface === "x") {
    return "short_comment: one or two sentences that fit in 280 characters, spaces included. No link. Count the characters before you return it. No second paragraph.";
  }
  return VARIANT_BRIEF[variant];
}

/**
 * How the one link to the business's site is written, per surface, in the
 * variants that carry one (the list entry and the article; a reply carries
 * none).
 *
 * Where Markdown renders, the name is the link; elsewhere the bare URL
 * follows the name in parentheses, because a Markdown link on X or Hacker
 * News is printed as its brackets. Reddit gets no URL: its filter removes a
 * comment that contains one.
 */
export function linkInstruction(name: string, site: string | null, surface: string): string {
  if (!site) {
    return "The business has no site recorded, so there is no link: set linkUrl to null and put no URL in the text.";
  }
  if (!replyCarriesUrl(surface)) {
    return `On Reddit, name ${name} in plain text and put no URL anywhere in the reply: no Markdown link, no bare URL. Reddit removes a comment that contains a link. Set linkUrl to null.`;
  }
  const form =
    linkStyle(surface) === "markdown"
      ? `write the name as a Markdown link, [${name}](${site})`
      : `write the name followed by the bare URL in parentheses, ${name} (${site})`;
  return `One link, always, and only this one: ${site}. It goes in the clause that names ${name}: ${form}. Nowhere else, never a second link, never a call to visit it, never in the opening sentences. Set linkUrl to exactly ${site}.`;
}

/**
 * The shapes an AI marketer falls into and a participant does not. Named in
 * the prompt because "sound human" is not an instruction a model can follow;
 * "never open by acknowledging the competitors and pivoting" is.
 */
export const FORBIDDEN_STRUCTURES: readonly string[] = [
  '"When looking for X, tools like A and B are..."',
  '"However, a different approach..."',
  '"The real power comes from..."',
  '"Instead of just X, imagine..."',
  '"This hands-off approach..."',
  '"It\'s not just X, it\'s Y" (as two sentences too: "This isn\'t just X. It\'s Y")',
  '"It\'s less about X and more about Y"',
  '"If you\'re looking for..., you might want to..."',
  '"the game-changer is..."',
  '"from X to Y to Z"',
  "opening by acknowledging the competitors and then pivoting to the business",
  "problem → however → our solution → benefits → call to action",
  "a closing paragraph that sums up the benefits",
  'three sentences in a row that start with "This"',
  '"When evaluating X, it\'s easy to get caught up in..." (a framing sentence before the answer)',
  '"A and B are great for X, but the real Y is..." (the setup and the pivot)',
  '"...is often where the real bottleneck lies"',
  '"This is where X comes in / happens / breaks down"',
  '"from idea to published post", "from generation to live" (the pipeline metaphor)',
  '"Considering X can change how you weigh Y" (a last sentence that tells the reader how to think)',
  '"Ultimately, ..." / "At the end of the day, ..." (a summing-up)',
  "three questions in a row",
  "a sentence of forty words",
  '"It\'s tough to tell if..." / "It\'s hard to say whether..." (a hedge before the answer)',
  '"X is one thing, but Y" / "X is one thing; Y is another"',
  'a rhetorical question answered by a verdict ("...are they actually looking? That\'s the real test.")',
  '"Here\'s the thing"',
  '"The key is..."',
];

/** Words a person in a thread does not use about a tool. */
export const FORBIDDEN_WORDS: readonly string[] = [
  "game-changer",
  "revolutionize",
  "seamless",
  "unlock",
  "empower",
  "leverage",
  "streamline",
  "transform",
  "robust",
  "cutting-edge",
  "end-to-end",
  "on autopilot",
  "strong contender",
  '"a new class/category of tools"',
  '"the entire workflow/lifecycle"',
  '"the real power/value/time-saver comes from"',
  '"a different/more comprehensive approach"',
  '"beyond just"',
  '"think about it"',
  '"eliminates the need for"',
  '"without manual effort"',
  '"services like X" / "tools like X"',
  '"you might want to check out"',
  '"worth looking into"',
  '"I\'d recommend"',
  '"definitely worth trying"',
  '"learn more"',
  '"check out"',
  "crucial",
  "vital",
  "truly",
  '"makes a significant impact/difference"',
  '"significantly"',
  '"Consider..." as an instruction',
  '"before diving into"',
  '"it\'s worth noting"',
  '"it sounds like you"',
  '"great question"',
  '"heavy lifting"',
  '"bogged down"',
  '"the mechanics/logistics of"',
  '"pain points"',
];

const TONE: Record<string, string> = {
  reddit: "Reddit: conversational, first person, no marketing language, no headings, no emoji. Redditors punish anything that smells of a pitch.",
  github: "GitHub: technical, precise, respectful of maintainers' time. Code or list formatting where it belongs.",
  linkedin: "LinkedIn: professional first person, concrete experience, no buzzwords.",
  x: "X: tight. A short_comment must fit in 280 characters.",
  hackernews: "Hacker News: terse, technical, sceptical readers. State the mechanism, not the benefit. No marketing words, no emoji, no headings.",
  stackexchange: "Stack Exchange: answer the question as asked, precisely, with steps or code where they help. Anything promotional is deleted by the community.",
  quora: "Quora: a direct answer in the first sentence, then the reasoning, first person, plain paragraphs.",
  indiehackers: "Indie Hackers: founder to founder, candid about what worked and what did not. Numbers only when you actually have them.",
  devto: "DEV Community: developer to developer, practical, code or config where it helps, no hype.",
  web: "A community forum: helpful, direct, no self-promotion.",
};

/**
 * One reply in the shape every draft is asked for, about something the
 * threads here are never about, so nothing in it can be borrowed but the
 * shape: the answer in the first sentence, short sentences with the thread's
 * own nouns, one flat opinion, no tool named and no link, and a last
 * sentence that is a concrete point, not a moral. Until version 14 it had
 * an invented tool in it, "the bit I have [Tallyhold](…) sending for me",
 * and that is the shape every published reply copied.
 */
export const SHAPE_EXAMPLE = `One reply in the right shape, from a different thread ("Clients keep paying invoices 30+ days late, what do you do?"), so you can borrow the shape and nothing else:

"Charge a deposit and shorten the terms. Net 30 is a habit, not a law. Ask for half up front and net 14 on the next contract and see who pushes back; the ones who do are usually the ones who pay late. Put the due date in the email subject, not just in the PDF. Send the first reminder on day 15 whether or not you're annoyed yet. And if someone's 45 days late twice, that's your answer about the client, not about the invoice."

Notice what it does not do: no sentence about invoicing in general before the answer, no "the real issue is", no "this is where automation comes in", no tool named, no link, nothing about what the writer uses, and it ends on the last concrete point.`;

/** Variant names as a sentence lists them: "short_comment and detailed_answer". */
function listOf(variants: readonly PlacementVariant[]): string {
  return variants.length <= 1 ? (variants[0] ?? "") : `${variants.slice(0, -1).join(", ")} and ${variants[variants.length - 1]}`;
}

/**
 * What the reply starts from. A qualifier's angle when there is one; when a
 * person chose the post, the person's decision, and where to look instead.
 * Either way a reply is judged against the writer, not the business's
 * keywords: it names no product and speaks from who the writer is.
 */
function angleSection(input: PlacementDraftInput): string {
  const fromWriter = `Whether there is something to say is judged against the writer (the voice section below: what is true about them and their own notes) and the thread, not against the business's topics, which are background only. A reply outside those topics is still a reply from this person.`;
  const decided = input.chosenByPerson
    ? `The owner chose this post themselves and wants to reply to it. Declining is not an option: write the reply.`
    : null;
  if (input.angle) {
    return [
      `What this business can add that the thread does not already have:`,
      input.angle,
      `(If that reads as a brief to present the product, take from it only the knowledge or experience it points at. The reply is about the person's question, not about the product.)`,
      decided,
      fromWriter,
    ]
      .filter(Boolean)
      .join("\n");
  }
  return [
    decided ?? `No angle was chosen for this thread.`,
    `Find the angle yourself, from the thread and from the writer: what this person, as the voice section describes them, would naturally say here. It can be small. A light, personal reply, an honest reaction to what was shared, one concrete detail from their own work, or a question back to the author are all replies. It never has to be about the business, and never mentions it.`,
    fromWriter,
  ].join("\n");
}

/**
 * The replies the owner posted, as the voice a short reply matches. Only
 * when a short reply is asked for and there is at least one. Kept in the
 * order the job loaded them (deterministic) and placed with the owner's
 * notes, before the thread, so the part of the prompt that belongs to the
 * business stays one block ahead of the part that changes per thread.
 */
export function voiceExamplesSection(input: Pick<PlacementDraftInput, "voiceExamples" | "variants">): string | null {
  if (input.voiceExamples.length === 0 || !input.variants.includes("short_comment")) return null;
  const others = input.variants.some((variant) => variant !== "short_comment");
  return [
    `Replies you posted, in your own words: match this voice${others ? " in short_comment" : ""} (how you open, how long you go, the register, what you admit), never their content or facts, which belong to those threads. Where your notes say otherwise, casing included, the notes win. Sentences the check refuses as a model's were left out of them.`,
    ...input.voiceExamples.map((example, index) => `${index + 1}. Thread: "${example.thread}"\n   You: "${example.reply}"`),
  ].join("\n");
}

/**
 * What the owner already corrected on earlier drafts, as mistakes not to
 * make again. Null when there is nothing, so the prompt carries no empty
 * heading. Placed right after the owner's notes: they are the same kind of
 * instruction, given one draft at a time, and they rank with the notes,
 * under the rules on inventing nothing, naming no product and carrying no
 * link (a note asking for "one of my numbers" never licenses a number the
 * voice section does not record; that it licenses none that does not fit
 * the post either is said once, in rule 5, so this block stays its size).
 */
export function correctionsSection(input: Pick<PlacementDraftInput, "corrections">): string | null {
  const lines = input.corrections.map((correction) => correction.trim()).filter(Boolean);
  if (lines.length === 0) return null;
  return [
    `Corrections you gave on earlier drafts, avoid repeating these mistakes:`,
    ...lines.map((line) => `- ${line}`),
    `(Like your notes, they never override inventing nothing, naming no product and carrying no link.)`,
  ].join("\n");
}

/**
 * How an X reply speaks: from the writer, casually, with one fact of theirs
 * or an honest reaction or a question. The reply of 9 November 2026 talked
 * about the topic from above while About you held the owner's own numbers.
 */
export function xVoice(input: Pick<PlacementDraftInput, "thread" | "variants">): string | null {
  if (input.thread.surface !== "x" || !input.variants.includes("short_comment")) return null;
  return `On X, speak from yourself, not about the topic from above. If what is true about you (the voice section) holds one concrete fact that fits this post as rule 5 defines it (the same subject, about this site, clear to a reader who knows nothing of you), a number, a thing you did, where you work from, use that one fact, in your own words, and no other. If nothing there fits, use none: give an honest personal reaction, a feeling or a belief of yours about what the post is about (no number, no event), a clear position, or one short question. Casual, the way you'd type a reply on your phone. Admitting a limit is fine ("haven't tested that myself", "just thinking out loud"). Never claim an experience the voice section does not record.`;
}

/**
 * True when the call asks for nothing but a reply on X: two sentences under
 * 280 characters, whose quality comes from the thread and the voice, not
 * from long reasoning. Such a call asks for little thinking and few claims.
 */
export function isXReplyOnly(input: Pick<PlacementDraftInput, "variants" | "thread">): boolean {
  return input.thread.surface === "x" && input.variants.every((variant) => variant === "short_comment");
}

/**
 * The prompt, exported so a test can read what the model is told. `images`
 * is what the call actually hands over (the agent leaves out an image that
 * did not load); by default, every image of the input.
 */
export function buildPlacementDraftPrompt(
  input: PlacementDraftInput,
  images: { seen: ReadonlyArray<Pick<DraftImageInput, "altText" | "from">>; unseen: number } = { seen: input.images, unseen: input.unseenImages }
): string {
  const name = input.business.name;
  // A reply names nothing and links nothing; the list entry and the article
  // name the project once, with its link (lib/placements/link.ts).
  const replies = input.variants.filter((variant) => !variantNamesBusiness(variant));
  const naming = input.variants.filter((variant) => variantNamesBusiness(variant));
  const article = input.variants.includes("article_draft");
  const listEntry = input.variants.includes("github_pr_proposal");
  const business = [
    `Name: ${name}`,
    input.business.domain ? `Site: ${input.business.domain}` : null,
    input.business.niche ? `Niche: ${input.business.niche}` : null,
    input.expertise.length
      ? `Topics they know about (background, not a list to cover): ${input.expertise.slice(0, 15).join(", ")}`
      : null,
    `The writer uses ${name} in their own work. What they can truthfully say about that use is in the voice section below, and nothing else. They are not the people who make ${name} and never speak as them: no "I work on", "I built", "we built", "I'm behind", "we designed", "our product", "our users", "which is why I care", no founder, no team, no disclosure of any kind. You have not been given a description of what ${name} does, and you do not need one: do not invent one, do not describe its features, its workflow or its benefits, named or unnamed.`,
  ]
    .filter(Boolean)
    .join("\n");

  const plannedReply = replies.length
    ? `Then settle two things: what is the person actually asking or saying, and what reply fits it. A reply is the answer and nothing else. What the poster means decides the angle: the reply answers that meaning, and a fact of yours comes in only if it speaks to it. Do not start from a fact you have and look for a way to bring it in.`
    : null;
  const plannedNaming = article
    ? `In article_draft, also settle where the one clause about what you use sits without being the point: the article has to be worth reading by someone who skips that clause.`
    : null;

  const naming6 = [
    replies.length
      ? `In ${listOf(replies)}: name no product and link nothing. Not ${name}, not "what I use", not "the tool I use", and never the sentence recorded in the voice section. Twenty-one replies that each ended on one sentence naming ${name} ("${name} is what I use for that", "I use ${name} for…", "that's the part I have ${name} doing", "I publish my own site's blog through ${name}") read as the same disguised advert, and none brought anything. The reply is the answer, in the owner's voice; a reader who wants to know who wrote it opens the profile. You may draw on what the writer does, from the voice section, never on what they do it with. No unnamed stand-in either: no "a system that handles…", no "an agent that automates…", no "new category of tools", no "services like X", no "tools like X". When the thread asks which tool to use, answer how to choose (what to look for, what the trade-offs are) and leave out which one you use. No call to action, and no closing line about what the approach achieves.`
      : null,
    article
      ? `In article_draft: name ${name} exactly once, as someone who uses it, in one short clause written for this article. Never in the shape every published reply had: not "${name} is what I use for that", not "I use ${name} for…", not "I have ${name} doing…" or "the part I have ${name} doing", not "I handle / manage / run / publish … with ${name}"; those are refused. Never paste the recorded sentence from the voice section. Put it in the middle, never in the opening sentences, never as the point, never in the last sentence. That clause is all the product gets: nothing about what it does beyond your own recorded use, no feature list, no workflow, no "services like X", no "tools like X", and no unnamed "system that handles…", "agent that automates…" or "new category of tools" standing in for it. No call to action, and no closing line about what the approach achieves.`
      : null,
    listEntry
      ? `In github_pr_proposal: the line names ${name}, because the entry is the project, in the list's own format; the two-sentence PR description says what the entry adds, plainly.`
      : null,
  ].filter((line): line is string => line !== null);

  const site = siteUrl(input.business.domain);
  const links7 = [
    replies.length ? `In ${listOf(replies)}: no link of any kind, no URL, no Markdown link, no bare domain. Set linkUrl to null.` : null,
    naming.length ? `In ${listOf(naming)}: ${linkInstruction(name, site, input.thread.surface)}` : null,
  ].filter((line): line is string => line !== null);

  const stands8 = [
    replies.length ? `${listOf(replies)}: ${replies.length > 1 ? "each " : ""}useful on its own, with nothing in it to delete.` : null,
    article ? "article_draft: still useful with the link and the mention deleted." : null,
    listEntry ? "github_pr_proposal: the description still says what the entry adds with the list line deleted." : null,
  ].filter((line): line is string => line !== null);

  const asList = (lines: string[]) => (lines.length === 1 ? ` ${lines[0]}` : lines.map((line) => `\n   - ${line}`).join(""));

  // What belongs to the business, the owner's notes, the corrections he
  // gave and the replies he posted, sits together before the thread:
  // prominent, and one block for every draft of this business.
  const owner = [notesAsRules(input.voice), correctionsSection(input), voiceExamplesSection(input)].filter(
    (part): part is string => part !== null
  );
  const fromWriter = xVoice(input);
  const imagesRule = postImagesRule(images.seen, images.unseen);
  const referencedRule = referencedPostsRule(input.referenced, input.thread.author);
  const staleRule = staleFactsRule(input.staleFacts, "the voice section");
  const recentRule = recentFactsRule(input.recentFacts);

  return `You are writing a reply to a public discussion in the name of a business owner. The owner will read it, edit it and paste it by hand under their own name. Nothing you write is posted automatically.

The business:
${business}
${owner.map((part) => `\n${part}\n`).join("")}
The discussion (${input.thread.surface} ${input.thread.kind}, ${input.thread.community}${input.thread.author ? `, by ${input.thread.author}` : ""}):
Title: ${input.thread.title}
Opening: ${input.thread.excerpt.slice(0, 1500) || "(no body text)"}
${referencedRule ? `\n${referencedRule}\n` : ""}${imagesRule ? `\n${imagesRule}\n` : ""}
${angleSection(input)}

${READ_THE_POST}
${[plannedReply, plannedNaming].filter(Boolean).length ? `${[plannedReply, plannedNaming].filter(Boolean).join(" ")}\n` : ""}
Write like a knowledgeable person who happens to be in this thread, not like a company that hired someone to write an advert. The test, before you return anything: could this plausibly be a genuine comment from a participant in this discussion? If it reads like an ad, a landing page, a PR line, an essay or an AI pitch, rewrite it.

${SHAPE_EXAMPLE}

Rules, in order of importance:
1. Answer first. The first sentence is the answer: the thing to do, the thing to check, or your opinion on the question, in plain words. Not a sentence about the topic, about how people approach it, or about what is easy to get caught up in. The first two sentences help the person and name no business, product or link. Do not open by rating the tools the person named.
2. ${
    input.angle
      ? `The angle above is where you start, not what the reply is about. Take one concrete point from it and answer the question the person asked: a specific method, a concrete example, a trade-off they have not considered. Generic advice is worthless here. If the angle says that what ${name} does is what matters most, do not argue that: it is the advert's argument in a user's mouth.`
      : `Answer what the author actually said or asked, as the writer described in the voice section. If they asked something, a specific method, a concrete example or a trade-off. If they shared something, a real reaction to it, one detail, or a question back. Generic praise and generic advice are worthless here.`
  }${fromWriter ? `\n   ${fromWriter}` : ""}
3. Write the way people type in a thread. Sentences mostly under fifteen words, none over thirty. The thread's own nouns: the tools, steps and numbers the person named, not abstract ones ("the automation of publishing" is "publishing it yourself"). Verbs, not nominalisations. Contractions. One opinion, stated flat. Nothing that describes the topic from above: no "the key thing is", no "the real X is", no "this is where X comes in", no framing clause before the answer, no "when evaluating tools".
4. The last sentence is a concrete detail, a caveat, or a question back to the person. Never a summary, never a moral, never a sentence about how the reader should think or weigh things.
5. Invent nothing. No numbers, results, customers, rankings, experiments, testimonials, studies or sources you were not given. No experience you were not given either: "I've seen", "I've found", "for us", "in my experience", "I've been using" are claims, allowed only as far as the voice section below records them. What the voice section records about the writer is the one experience you may draw on; say no more than is recorded, no duration, no results. If a point needs a fact you do not have, leave the point out.
   ${factFitRule({ name, niche: input.business.niche }, "the voice section")}${staleRule ? `\n   ${staleRule.split("\n").join("\n   ")}` : ""}${recentRule ? `\n   ${recentRule.split("\n").join("\n   ")}` : ""}
6. Who is named.${asList(naming6)}
7. Links.${asList(links7)}
8. What stands on its own.${asList(stands8)}
9. The approach for this reply: ${input.approach || "whatever a regular in this community would do."}
10. Vary the rhythm: short sentences among longer ones, contractions, concrete words, an informal aside if it fits, some things left unexplained. Paragraphs of different shapes. Length is what the point needs: ${input.thread.surface === "x" ? "on X a short comment stops at 280 characters, which is well under 70 words. Stop when the point is made, and never past that count." : "if 70 words do it, write 70; do not pad to cover the product."}
11. Never use these structures: ${FORBIDDEN_STRUCTURES.join("; ")}.
12. Never use these words or phrases: ${FORBIDDEN_WORDS.join(", ")}. No chains of em dashes.
13. The platform. ${TONE[input.thread.surface] ?? TONE.web} A limit named on a variant is a hard limit. A reply over it is unusable, not almost right.
14. ${describeVoice(input.voice, { notes: "elsewhere" }).join("\n    ")}
15. Write in ${input.language}.
${
  input.revisions.length
    ? `
A previous draft of some variants failed. Write those variants again from scratch so none of the problems below remain. Do not keep the old wording and shorten it. A phrase quoted in a problem must not appear in any form. Where a problem quotes words that read as promotion or as an essay, drop the sentence they sit in and say the point plainly, in the shape of the example above, or leave it out. Where a problem lists the thread's own words, use at least two of them for what the thread is actually about. Where a problem says a reply names the business or carries a link, delete the clause that does and put nothing in its place: the reply is the answer. Where a problem says the product is described, cut every statement about it${article ? " (in the article, all but the one clause about your own use)" : ""}. Where a problem says the article or the list entry never names the business, add that one clause and nothing else. Where a problem says the text speaks as the maker, drop that${article ? `; in the article, write the clause as someone who uses ${name}, from what the voice section records` : ""}. Where a problem says your notes ask for lowercase, start every sentence lowercase. Where a problem says a fact is about another product, or that the reader cannot place a number, leave that fact out and put no other number in its place: the reply does without one. Where a problem says a dated fact is stated as current, say when it was true ("in October I had…") or leave it out. Where a problem says a fact repeats one from your recent replies, leave that fact out and say something else: another fact that fits this post, a feeling or an opinion of yours, a position or a question, or nothing about yourself. Where a problem says sentences were deleted as a model's, write none of them again: say the point another way, plainly, or leave it out.
${input.revisions.map((revision) => `- ${revision.variant}: ${revision.problems.join(" ")}`).join("\n")}
`
    : ""
}
Produce these variants:
${input.variants.map((v) => `- ${variantBrief(v, input.thread.surface)}`).join("\n")}

For every variant also list "claims": each factual statement the text makes that a reader could dispute (about the business, about the tool, about the writer, about how something works), with a basis${
    isXReplyOnly(input)
      ? ". A reply this short makes two claims at most, often none: list only those, and every sentence with a number in it is one of them"
      : ""
  }:
- "business_profile" when it is about the business, the writer's use of it, or the writer (a fact the voice section records)${naming.length ? ` (in ${listOf(naming)}, the one clause naming ${name} is one such claim, and should be the only one)` : ""};
- "thread" when it restates something from the discussion;
- "general_knowledge" when it is uncontroversial domain knowledge;
- "unverified" when you are not sure. Prefer removing such a statement from the text over marking it unverified.

Return JSON, with "reading" first, before any variant: { "reading": { "tone": ${POST_TONES.map((tone) => `"${tone}"`).join(" | ")}, "means": one line, what the poster actually means }, "variants": [ { "variant", "body", "linkUrl", "claims": [ { "text", "basis" } ] } ] }.`;
}

export const placementDraftAgent: Agent<PlacementDraftInput, PlacementDraftOutput> = {
  name: "placement-draft",
  version: 23,
  inputSchema: PlacementDraftInput,
  outputSchema: PlacementDraftOutput,

  async run(input, ctx: AgentContext): Promise<AgentResult<PlacementDraftOutput>> {
    // The images first: one that does not load is left out before anything
    // is paid, and the prompt is told only about what the model receives.
    const fetched = input.images.length ? await fetchLlmImages(input.images.map((image) => image.url), { signal: ctx.signal }) : [];
    const seenImages = input.images.filter((_, index) => fetched[index]?.ok);
    // What the draft records is about the post's own images: a quoted
    // post's image that does not load is only left out of the prompt.
    const failures = fetched.flatMap((result, index) =>
      result.ok || input.images[index]?.from === "quoted" ? [] : [result.detail.slice(0, 200)]
    );
    const prompt = buildPlacementDraftPrompt(input, { seen: seenImages, unseen: input.unseenImages + failures.length });

    const llm = getLlmProvider();
    // Warmer than the qualifier: prose that varies is the point here. The
    // claims are still bookkeeping the gate checks, not something the
    // temperature is trusted with.
    // An X reply asks for little thinking: on 9 November 2026 the default
    // thinking was most of a 25 s call. Everything else keeps the default.
    const { value, usage } = await llm.generateStructured(prompt, LlmDraftOutput, {
      tier: "quality",
      temperature: 0.7,
      thinking: isXReplyOnly(input) ? "low" : "default",
      signal: ctx.signal,
      images: fetched.flatMap((result) => (result.ok ? [result.image] : [])),
    });

    // Trust the model for prose, never for bookkeeping: only the variants that
    // were asked for, one each; a link that is not the business's own domain
    // is dropped rather than published; unknown claim bases become unverified,
    // which the gate refuses.
    const wanted = new Set<string>(input.variants);
    const seen = new Set<string>();
    const variants: DraftVariant[] = [];
    const site = siteUrl(input.business.domain);
    const ownDomain = site ? domainOf(site) : "";

    for (const v of value.variants) {
      const variant = v.variant.trim() as (typeof PLACEMENT_VARIANTS)[number];
      if (!wanted.has(variant) || seen.has(variant)) continue;
      seen.add(variant);

      let body = v.body.trim().slice(0, 20_000);
      let linkUrl: string | null = v.linkUrl?.trim() || null;
      if (!variantCarriesLink(variant, input.thread.surface)) {
        // A reply carries no link. A declared one is bookkeeping and is
        // dropped; a URL the model wrote into the text stays, so the gate
        // refuses it and the rewrite is told why. Nothing is placed on a name.
        linkUrl = null;
      } else {
        if (linkUrl && !/^https?:\/\//i.test(linkUrl)) linkUrl = null;
        if (linkUrl && !(ownDomain && isCompanySource(domainOf(linkUrl), ownDomain))) linkUrl = null;
        // The link the text carries is the one that counts: a model that put
        // the site in the clause and left linkUrl null still wrote one link.
        if (!linkUrl && ownDomain) linkUrl = ownLinkIn(body, ownDomain);
        // A model that named the business and forgot the link gets it placed
        // on the name by code, the way the person's own edits do. Only when
        // the name is in the text: the gate, not this, says when it is not.
        if (site && !ownLinkIn(body, ownDomain)) {
          const linked = linkTheName(body, [input.business.name], site, input.thread.surface);
          if (linked !== body) {
            body = linked;
            linkUrl = site;
          }
        }
      }
      if (input.thread.surface === "x" && variant === "short_comment") body = fitXLength(body);

      variants.push({
        variant,
        body,
        linkUrl,
        claims: v.claims.slice(0, 20).map((c) => ({
          text: clampText(c.text, 300),
          basis: (CLAIM_BASES as readonly string[]).includes(c.basis)
            ? (c.basis as (typeof CLAIM_BASES)[number])
            : "unverified",
        })),
      });
    }

    if (variants.length === 0) {
      throw new Error("The model returned none of the requested variants");
    }

    const missing = input.variants.filter((v) => !seen.has(v));
    return {
      output: {
        variants,
        reading: parseReading(value.reading),
        images: { seen: seenImages.filter((image) => image.from !== "quoted").length, failed: failures.length, failures },
      },
      usage: [usage],
      notes: missing.length ? [`variants not produced: ${missing.join(", ")}`] : [],
    };
  },
};
