import { z } from "zod";
import { liveConfirmations } from "./staleness";

/**
 * How a business sounds when the platform writes in its name.
 *
 * Stored in `businesses.voice_settings`, a jsonb parsed through defaults like
 * `media_settings`, so the shape can grow without a migration and an old row
 * keeps working. Read by the Placements draft agent (`aboutYou`, the notes)
 * and, for `articleFacts` and the notes only, by the article outline, writer,
 * revision and audit (docs/VOICE.md).
 *
 * Two sets of first-hand facts, because a reply and an article are read by
 * different people. `aboutYou` is what a reply may say: candid, building in
 * public, weak early numbers included. `articleFacts` is what a public
 * article may state: true things the owner is happy to see on the blog.
 * Since 12 November 2026 an article never reads `aboutYou` (the owner: an
 * honest "9 to 342 impressions, 0 clicks" is bad publicity on a product's
 * own blog). A draft that says "I've been using this for months" with
 * nothing in the field it reads is an invention, and the gate treats it as
 * one.
 */

export const VOICE_PRESETS = [
  {
    value: "plain",
    label: "Plain",
    description: "Direct and specific. Says the thing, then stops.",
    prompt: "Plain: direct and specific. Say the thing, then stop. No warm-up, no summary.",
  },
  {
    value: "casual",
    label: "Casual",
    description: "Relaxed, like a regular in the thread. Contractions, an aside now and then.",
    prompt: "Casual: relaxed, like a regular in the thread. Contractions, an aside now and then, sentences that trail off where a person's would.",
  },
  {
    value: "technical",
    label: "Technical",
    description: "Precise. The mechanism before the benefit; code or config where it helps.",
    prompt: "Technical: precise. State the mechanism before any benefit; use code or config where it helps; name the trade-off.",
  },
  {
    value: "warm",
    label: "Warm",
    description: "Friendly and patient. Explains without lecturing.",
    prompt: "Warm: friendly and patient. Explain without lecturing; acknowledge what the person already got right.",
  },
] as const;

export type VoicePreset = (typeof VOICE_PRESETS)[number]["value"];

const PRESET_VALUES = VOICE_PRESETS.map((preset) => preset.value) as [VoicePreset, ...VoicePreset[]];

export const VOICE_PERSONS = [
  {
    value: "auto",
    label: "Whatever fits",
    description: "First person when it reads naturally, none when it does not.",
  },
  {
    value: "i",
    label: "I",
    description: "One person speaking for themselves.",
  },
  {
    value: "we",
    label: "We",
    description: "A team speaking for the business.",
  },
] as const;

export type VoicePerson = (typeof VOICE_PERSONS)[number]["value"];

const PERSON_VALUES = VOICE_PERSONS.map((person) => person.value) as [VoicePerson, ...VoicePerson[]];

/**
 * About you holds up to 2,000 characters. It held 400 until 12 November
 * 2026, which left room for one usable fact: the owner's blog numbers, and
 * five of seventeen drafts in a row said "position 30-40" whatever the post
 * was about. Room for several kinds of true facts (numbers, what you are
 * building, what you believe about it, your situation, opinions you hold)
 * is what lets a reply say something else. A jsonb field: no migration.
 */
export const ABOUT_YOU_MAX = 2_000;
/** Facts for articles: the same room as About you. */
export const ARTICLE_FACTS_MAX = ABOUT_YOU_MAX;
export const INSTRUCTIONS_MAX = 600;
export const DAILY_REPLY_GOAL_MAX = 50;
/**
 * At most this many "Still true" confirmations. Only facts About you still
 * has keep one (`withLiveConfirmations`), and 2,000 characters hold far
 * fewer dated sentences than this: the cap is a bound on what an API call
 * can store, never reached by use.
 */
export const CONFIRMED_FACTS_MAX = 200;

/**
 * "Still true" confirmations (Today, since 2026-11-14): the key of a
 * sentence of About you (`factKey`, lib/voice/staleness.ts) to the day,
 * `YYYY-MM-DD` in UTC, the person last said it is still true.
 */
export const ConfirmedOn = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "a day as YYYY-MM-DD");

export const ConfirmedFacts = z
  .record(z.string().min(1).max(ABOUT_YOU_MAX), ConfirmedOn)
  .refine((map) => Object.keys(map).length <= CONFIRMED_FACTS_MAX, `at most ${CONFIRMED_FACTS_MAX} confirmations`);

export const VoiceSettings = z.object({
  preset: z.enum(PRESET_VALUES).default("plain"),
  person: z.enum(PERSON_VALUES).default("auto"),
  /** True facts the writer may say about themselves. Nothing else is ever assumed. */
  aboutYou: z.string().max(ABOUT_YOU_MAX).default(""),
  /**
   * Facts for articles: the true things a public article may state about the
   * writer and the business. The only first-hand facts the article agents
   * read; empty means an article states no first-hand numbers or results.
   */
  articleFacts: z.string().max(ARTICLE_FACTS_MAX).default(""),
  /** The business's own notes on how it writes, and what it never says. */
  instructions: z.string().max(INSTRUCTIONS_MAX).default(""),
  /**
   * How many replies a day the person means to post, shown on the Replies
   * page as "2 of 5 today". Null until they set one: no goal is invented.
   * It lives here because this is the JSON the reply settings already use;
   * no draft reads it.
   */
  dailyReplyGoal: z.number().int().min(1).max(DAILY_REPLY_GOAL_MAX).nullable().default(null),
  /**
   * "Find posts on X": once a day, search X through its official API for
   * fresh posts on this site's topics (they arrive in Replies under Found
   * for you, with a draft) and read the numbers of the replies posted there;
   * since 2026-11-13 also find the link of a reply marked as posted on X
   * (lib/placements/reply-link-search.ts). Off until the owner turns it on, and it does nothing unless the platform
   * has the X API on as well (`X_API_ENABLED`): every post read is billed,
   * under a platform-wide monthly cap (docs/PLACEMENTS.md). Here, like the
   * daily goal, because this is the JSON the reply settings already use; the
   * switch is in Settings → Connections since 2026-11-14.
   */
  findPostsOnX: z.boolean().default(false),
  /**
   * "Still true" on Today (since 2026-11-14): which facts of About you the
   * person confirmed are still true, and on which day. Kept apart from
   * About you so the words stay exactly as written: the drafter reads
   * About you, and a date added to a sentence would reach the drafts. Only
   * the staleness rule reads this (lib/voice/staleness.ts); no draft, no
   * article and no prompt ever does (`voiceForWriter`). Keyed by the
   * sentence's words, so an edit to the sentence drops its confirmation,
   * and every write keeps only the facts About you still has
   * (`withLiveConfirmations`).
   */
  confirmedFacts: ConfirmedFacts.default({}),
});

export type VoiceSettings = z.infer<typeof VoiceSettings>;

/** The settings with the confirmations of facts About you no longer has dropped: what every write stores. */
export function withLiveConfirmations(settings: VoiceSettings): VoiceSettings {
  return { ...settings, confirmedFacts: liveConfirmations(settings.aboutYou, settings.confirmedFacts) };
}

/**
 * The voice as a writer is handed it: the confirmations left out. A
 * confirmation decides which facts are stale, worked out before the
 * prompt; the drafter never reads the map itself.
 */
export function voiceForWriter(settings: VoiceSettings): VoiceSettings {
  return { ...settings, confirmedFacts: {} };
}

/**
 * A partial change (PATCH /api/business/voice-settings): each field
 * optional and without its default, so a field left out is left as stored,
 * never reset. Unknown keys are refused.
 */
export const VoiceSettingsChange = z
  .object(
    Object.fromEntries(
      Object.entries(VoiceSettings.shape).map(([key, schema]) => [key, (schema as z.ZodDefault<z.ZodType>).unwrap().optional()])
    ) as { [K in keyof typeof VoiceSettings.shape]: z.ZodOptional<ReturnType<(typeof VoiceSettings.shape)[K]["unwrap"]>> }
  )
  .strict();

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = VoiceSettings.parse({});

/** Tolerant parse: an unknown or invalid stored value falls back to the defaults. */
export function parseVoiceSettings(raw: unknown): VoiceSettings {
  const result = VoiceSettings.safeParse(raw ?? {});
  return result.success ? result.data : DEFAULT_VOICE_SETTINGS;
}

/**
 * How a note that asks for a fact is read: "when one fits". On 12 November
 * 2026 the owner's notes said "Lead with a number or a concrete thing I
 * did", About you held one usable fact (his blog's rankings), and the reply
 * under @hank_ships's post about being called a grifter said "i'm still trying
 * to get my blog articles past position 30-40". The notes are about how he
 * writes, never a licence to put a fact where it does not belong.
 */
export const FACT_NOTES_YIELD = `A note that asks you to lead with or include a number, a fact or a concrete thing you did means: when one fits this post. It never puts a fact under a post about something else. When none fits, the note yields: open with your reaction, your position or your question instead.`;

const PERSON_PROMPT: Record<VoicePerson, string> = {
  auto: 'Use "I", "we" or no first person at all, whichever reads naturally in this thread.',
  i: 'Write as "I": one person speaking for themselves.',
  we: 'Write as "we": a team speaking for the business.',
};

/**
 * What the writer's own notes ask for that code can check. Only lowercase
 * for now: on 9 November 2026 the owner's notes opened "Lowercase, short
 * lines, like a reply typed on a phone" and the X reply came back in
 * sentence case, and the gate said nothing. A note that says not to write
 * lowercase ("no lowercase", "never lower case") is not the rule.
 */
export interface NoteRules {
  lowercase: boolean;
}

const LOWERCASE_NOTE = /\blower[- ]?case\b/i;
const NOT_LOWERCASE_NOTE = /\b(no|not|never|avoid|don't|do not)\s+(write\s+|use\s+|type\s+)?(in\s+)?(all\s+)?lower[- ]?case\b/i;

export function noteRules(instructions: string | null | undefined): NoteRules {
  const notes = instructions ?? "";
  return { lowercase: LOWERCASE_NOTE.test(notes) && !NOT_LOWERCASE_NOTE.test(notes) };
}

/**
 * The writer's own notes as the rules they are. They are the owner telling
 * the writer how they write, so they bind every variant and win over the
 * preset and the example's style; only the honesty rules (invent nothing, a
 * fact only where it fits the post: lib/voice/fact-rules.ts) and the
 * no-product rules sit above them. Null when there are none.
 */
export function notesAsRules(settings: VoiceSettings): string | null {
  const instructions = settings.instructions.trim();
  if (!instructions) return null;
  return [
    `Your own notes (Settings → Voice), written by the owner. These are hard rules, not background: every variant follows every one of them, and where a note and anything else in this prompt disagree on style (the tone preset, the example's casing and length, the platform's usual register), the note wins. Only the rules on inventing nothing, using a fact only where it fits the post, naming no product and carrying no link stand above them.`,
    FACT_NOTES_YIELD,
    noteRules(instructions).lowercase
      ? `The notes ask for lowercase: start every sentence with a lowercase letter, the way a reply typed on a phone looks. Names can keep their capitals. A reply in sentence case is checked and written again.`
      : null,
    `"""`,
    instructions,
    `"""`,
  ]
    .filter((line): line is string => line !== null)
    .join("\n");
}

/**
 * The voice as lines for a prompt. Deterministic, so a test can read what the
 * model was told. The empty `aboutYou` case is spelled out rather than
 * omitted: silence would leave the model free to invent a history.
 *
 * `notes: "elsewhere"` leaves the owner's notes out because the prompt
 * already carries them, prominently, as rules (`notesAsRules`); the line
 * left here points back at them so the preset never reads as the last word.
 */
export function describeVoice(settings: VoiceSettings, options: { notes?: "inline" | "elsewhere" } = {}): string[] {
  const preset = VOICE_PRESETS.find((p) => p.value === settings.preset) ?? VOICE_PRESETS[0];
  const aboutYou = settings.aboutYou.trim();
  const instructions = settings.instructions.trim();
  const notes = instructions
    ? options.notes === "elsewhere"
      ? ["Your own notes, at the top, are hard rules: where this preset and a note disagree, the note wins."]
      : [`Your own notes, hard rules that win over the preset: ${instructions}`]
    : [];
  return [
    `Voice. ${preset.prompt}`,
    PERSON_PROMPT[settings.person],
    aboutYou
      ? `What is true about the writer, in their own words: the only personal experience the reply may claim, and only where it fits the post. A fact here may be about this business or about something else the writer does: ${aboutYou}`
      : "Nothing is known about the writer's own experience, so the reply claims none: no \"I've been using\", no \"we've seen\", no results, no time spent.",
    ...notes,
  ];
}
