import { z } from "zod";
import type { ApiKeyScope } from "@/lib/api-keys";

/**
 * MCP prompts (docs/API.md "Prompts"): the owner's routine as commands a
 * person picks inside Claude, `daily_routine` (Today, emptied) and
 * `weekly_review` (Growth and Content, on Sunday).
 *
 * A prompt is a text template and nothing else: it calls no tool, reads no
 * row and spends nothing. It tells Claude which tools to call, in which
 * order, and the product's rules while it does, the same rules the screens
 * keep: GTF never posts, a reply names no product and carries no link, a
 * number nobody measured is "not measured", AI answers are sampled and per
 * engine, nothing spends without the person's yes, no dollar amounts.
 *
 * Every tool a prompt names is in `uses`, and the test checks each one is
 * in the registry, so a renamed tool fails a test instead of a routine.
 * Arguments arrive as strings (MCP's `prompts/get`); each prompt validates
 * them with its own schema, and an empty string reads as absent, since some
 * clients send every argument they show.
 */

export interface PromptArgument {
  name: string;
  description: string;
  required: boolean;
}

export interface PromptCaller {
  scopes: readonly ApiKeyScope[];
}

export interface PromptDefinition<A extends z.ZodObject = z.ZodObject> {
  name: string;
  title: string;
  description: string;
  arguments: readonly PromptArgument[];
  /** Validates the string arguments and gives them their types and defaults. */
  args: A;
  /** The tools the text tells Claude to call: each must be in the registry. */
  uses: readonly string[];
  /** The text, for this caller's grant: what it may not do is said, not attempted. */
  render(args: z.output<A>, caller: PromptCaller): string;
}

/** An empty string is an argument not given. */
const optionalString = <T extends z.ZodType>(schema: T) =>
  z.preprocess((value) => (typeof value === "string" && value.trim() === "" ? undefined : value), schema.optional());

const TimeZone = z
  .string()
  .trim()
  .max(64)
  .refine((zone) => {
    try {
      new Intl.DateTimeFormat("en-CA", { timeZone: zone });
      return true;
    } catch {
      return false;
    }
  }, "not an IANA time zone, e.g. Europe/Berlin");

const Days = z.enum(["7", "28"], { message: "7 or 28" });

const Topics = z
  .string()
  .trim()
  .regex(/^\d{1,2}$/, "a whole number from 1 to 20")
  .transform(Number)
  .pipe(z.number().int().min(1, "at least 1").max(20, "at most 20"));

/** The rules every routine keeps, as the screens keep them. */
const RULES = [
  "- GTF never posts on X or anywhere else, and neither do you: you give me the link, I post it myself.",
  "- A reply names no product and carries no link. Never add either.",
  "- Say only what the tools return. A null is \"not measured\", never 0. No guessed numbers, no dollar amounts.",
  "- Nothing that spends (a rewrite, a draft) without my yes first.",
];

function grantLines(caller: PromptCaller): string[] {
  const lines: string[] = [];
  if (!caller.scopes.includes("write")) {
    lines.push(
      "- This connection can only read. Approving, skipping, marking as posted and saving links need the Write permission: say so, and point me to Today (/today) or to reconnecting with Write."
    );
  }
  if (!caller.scopes.includes("spend")) {
    lines.push(
      "- This connection has no Spend permission, so Fix (correct_reply_draft) and new drafts (draft_reply) are refused: offer to change the words with edit_reply_draft instead."
    );
  }
  return lines;
}

const dailyArgs = z.object({ timeZone: optionalString(TimeZone) });

export const DAILY_ROUTINE: PromptDefinition<typeof dailyArgs> = {
  name: "daily_routine",
  title: "Run my day",
  description:
    "Today, emptied with you: progress toward the daily goal, then each reply in To do (approve, fix or skip; you post it on X yourself), then the other things that need a tap today. GTF and Claude never post.",
  arguments: [
    {
      name: "timeZone",
      description: "Your IANA time zone, e.g. Europe/Berlin, so \"today\" is your day. UTC when left empty.",
      required: false,
    },
  ],
  args: dailyArgs,
  uses: [
    "get_today",
    "list_reply_inbox",
    "get_reply_intent_url",
    "mark_reply_posted",
    "correct_reply_draft",
    "edit_reply_draft",
    "dismiss_reply_target",
    "snooze_reply_target",
    "draft_reply",
    "write_own_reply",
    "resettle_article",
    "publish_article",
    "generate_article",
    "retry_article",
    "set_reply_link",
    "paste_reply_links",
    "confirm_about_you_fact",
    "update_voice_settings",
  ],
  render({ timeZone }, caller) {
    const zone = timeZone ?? "UTC";
    return [
      `Run my day in GetTrafficFast (GTF) with me, one step at a time. My time zone: ${zone}.`,
      "",
      "Rules for the whole routine:",
      ...RULES,
      ...grantLines(caller),
      "",
      `1. Call get_today with timeZone "${zone}". In two or three lines: replies posted today against the goal (progress.posted of progress.goal; with no goal, just the count), where their links stand (progress.links.line), and how many wait in To do (counts.todo).`,
      "",
      `2. Call list_reply_inbox with status "open" and timeZone "${zone}". Take the targets one at a time, in the order given. For each, show the platform and the author, the post (title or excerpt, and its url) and the draft (the first in drafts whose auditStatus is passed, else warning, else blocked, as the screen picks it; if it is not passed, say what the gate flagged). Then ask me: approve, fix or skip. Wait for my answer before the next one.`,
      "   - Approve: call get_reply_intent_url with the targetId and the draftId. Give me its url: it opens X with the reply typed in. If url is null, give me body to copy and threadUrl to open. Tell me to post it myself. When I say I posted it, call mark_reply_posted with the targetId and draftId, and my reply's link if I paste one (without it, GTF looks for the link on X by itself).",
      "   - Fix: ask me what is wrong, in my words, then call correct_reply_draft with the draftId and that reason (one rewrite, judged again, capped daily). Show the new draft and ask again. If I would rather change the words myself, use edit_reply_draft.",
      "   - Skip: call dismiss_reply_target, with my reason if I give one. \"Not now\" is snooze_reply_target (7 days unless I say otherwise).",
      "   - No draft yet: say so, and offer draft_reply (it spends one of the day's drafts: ask first) or write_own_reply with my own words.",
      "   Stop when To do is empty or when I say stop.",
      "",
      "3. Also today: for each item of get_today's alsoToday, say what it is in one line and offer the tools in its tools list, the free one first:",
      "   - article_held: say the reason. resettle_article re-checks it for free; publish_article only on my explicit yes (it needs the Publish permission and confirm: true); generate_article rewrites it (it spends: ask first).",
      "   - article_failed: retry_article.",
      "   - reply_link: ask me for the link of my reply and save it with set_reply_link; several links at once go to paste_reply_links.",
      "   - fact_stale: read me the sentence. If I say it is still true, call confirm_about_you_fact with the sentence exactly as quoted. If not, ask me for the new wording and save it with update_voice_settings. Never confirm a fact I did not confirm.",
      "",
      "4. End with one line: posted today against the goal, and what is left.",
    ].join("\n");
  },
};

const weeklyArgs = z.object({
  days: optionalString(Days).transform((value) => (value === "28" ? 28 : 7)),
  topics: optionalString(Topics),
});

export const WEEKLY_REVIEW: PromptDefinition<typeof weeklyArgs> = {
  name: "weekly_review",
  title: "Review my week",
  description:
    "Growth and Content, on Sunday: replies on X, Google and AI answers (per engine, sampled) against the period before, then the next topics to keep or remove.",
  arguments: [
    { name: "days", description: "The period: 7 (default) or 28 days, compared with the same length before.", required: false },
    { name: "topics", description: "How many next topics to go through, 1 to 20 (default 5).", required: false },
  ],
  args: weeklyArgs,
  uses: ["get_growth", "list_ai_answers", "get_content", "delete_keywords"],
  render({ days, topics }, caller) {
    const topicCount = topics ?? 5;
    return [
      `Review my last ${days} days in GetTrafficFast (GTF) with me, against the ${days} days before.`,
      "",
      "Rules for the whole review:",
      ...RULES,
      "- AI answers are sampled: each question asked once per engine per run, not every answer an engine gives. Say so.",
      "- Per engine, always. Never average engines together and never make one score out of them.",
      ...(caller.scopes.includes("write")
        ? []
        : ["- This connection can only read. Removing a topic needs the Write permission: say so, and point me to Content (/content)."]),
      "",
      `1. Call get_growth with days ${days}. Summarize in three short blocks:`,
      "   - X: replies posted this period and the one before; views, likes, replies and reposts over the measured ones, with how many were measured, and their change; followers and their change when read. If replies is null, or its status says X is not read, say that and why.",
      "   - Google: impressions, clicks and average position (lower is better; a positive change moved up the page), and the day the data is settled through. If previous is null, say there is no comparison yet. Pages on Google: indexed of checked, never \"not indexed\" for a page not checked.",
      "   - AI answers: one line per engine, cited of readable answers this period and the period before (e.g. \"perplexity: 2 of 9, before 1 of 8\"). With no readable answer, \"not measured\". Unreadable answers are left out, not \"not cited\".",
      "",
      `2. Call list_ai_answers with days ${days}. Quote at most three answers worth seeing: where the site was cited, or where other pages were cited instead (name them). Give the engine, the question and the day.`,
      "",
      `3. Call get_content with topics ${topicCount}. One line per article of the week, its status in the tool's words (a waiting one says why). Then the next topics, in the order Autopilot picks them, each with its source. For each topic ask me: keep or remove. Remove is delete_keywords with its id, only after my yes (it deletes the topic); keep needs nothing.`,
      "",
      "4. End with three lines: what grew, what did not, one thing for next week. No causes the numbers do not show.",
    ].join("\n");
  },
};

export const PROMPTS: readonly PromptDefinition[] = [
  DAILY_ROUTINE as unknown as PromptDefinition,
  WEEKLY_REVIEW as unknown as PromptDefinition,
];

/** A prompt as MCP's `prompts/list` describes it. */
export function describePrompt(prompt: PromptDefinition) {
  return {
    name: prompt.name,
    title: prompt.title,
    description: prompt.description,
    arguments: prompt.arguments.map((arg) => ({ name: arg.name, description: arg.description, required: arg.required })),
  };
}

export type PromptRender =
  | { ok: true; description: string; text: string }
  | { ok: false; message: string };

/** `prompts/get`: the prompt's text for these arguments, or why the arguments are refused. */
export function renderPrompt(name: string, rawArgs: Record<string, string> | undefined, caller: PromptCaller): PromptRender {
  const prompt = PROMPTS.find((p) => p.name === name);
  if (!prompt) {
    return { ok: false, message: `There is no prompt named ${name}. prompts/list lists them: ${PROMPTS.map((p) => p.name).join(", ")}.` };
  }
  const parsed = prompt.args.safeParse(rawArgs ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.map(String).join(".") || "arguments"}: ${issue.message}`).join("; ");
    return { ok: false, message: `${prompt.name}: ${issues}` };
  }
  return { ok: true, description: prompt.description, text: prompt.render(parsed.data, caller) };
}
