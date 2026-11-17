import { z } from "zod";
import { ABOUT_YOU_MAX } from "./settings";
import { STALE_AFTER_DAYS, quoteShort } from "./staleness";

/**
 * What a writer is told about using the facts in About you, in the words
 * the drafter and the correction share.
 *
 * About you is the list of the only first-hand facts a draft may state.
 * That makes a fact allowed, not apt. On 10 November 2026 the GetTrafficFast
 * site's About you held "Co-founded Postwren, email marketing for Shopify
 * stores: 12 paying stores in October 2026." beside notes that said "Lead
 * with a number", and the reply to a post about a hackathon judged by paying
 * customers opened "12 paying stores for my own thing felt like real
 * validation". The fact was another product's, "stores" meant nothing to
 * the reader, and the number was a month old. Two rules came of it: a fact
 * is used only where it fits the post, and a dated fact past
 * `STALE_AFTER_DAYS` is stated as of its date.
 *
 * On 12 November 2026 the same site's About you held the owner's blog
 * numbers ("… articles sit around position 30-40"), and 5 of the last 17
 * drafts said "position 30-40". Under @hank_ships's post about being called a
 * grifter, about building for the joy of it and not the money, the reply
 * said "i'm still trying to get my blog articles past position 30-40, so i
 * know the grind is real", and passed every check. Two more rules came of
 * it: a fact fits only a post about that same subject (rankings are not
 * motivation), with a feeling, a belief, a position or a question as the
 * reply when none fits, never an invented event; and a fact the recent
 * replies already used is not used again (`recentFactsRule`).
 */

/** A stale About you sentence, as a job hands it to a writer (lib/voice/staleness.ts). */
export const StaleFactForPrompt = z.object({
  sentence: z.string().min(1).max(ABOUT_YOU_MAX),
  /** "October 2026", "Oct 26, 2026". */
  dateLabel: z.string().min(1).max(80),
});
export type StaleFactForPrompt = z.infer<typeof StaleFactForPrompt>;

/**
 * About you is at most 2,000 characters (`ABOUT_YOU_MAX`), and a dated
 * sentence is at least ten ("May 2026. "): it cannot hold more than this.
 */
export const STALE_FACTS_MAX = 200;

/** The recent replies a draft is compared with: the last ten drafts and posted replies, one per post. */
export const RECENT_REPLIES_MAX = 10;
/** The facts the prompt lists, the most used first. */
export const RECENT_FACTS_MAX = 10;
/** How many of a fact's own wordings are kept, each at most `RECENT_QUOTE_MAX` characters. */
export const RECENT_QUOTES_MAX = 3;
export const RECENT_QUOTE_MAX = 120;

/**
 * Which About you sentences the business's recent replies used, and in how
 * many of them (lib/placements/recent-facts.ts computes it, no model). The
 * drafter and the correction are told; the gate's advisory check "Repeats a
 * recent fact" reads it.
 */
export const RecentFacts = z.object({
  /** How many recent replies were read: the "10" of "4 of your last 10 replies". */
  replies: z.number().int().min(0).max(RECENT_REPLIES_MAX),
  facts: z
    .array(
      z.object({
        /** The About you sentence, as written. */
        sentence: z.string().min(1).max(ABOUT_YOU_MAX),
        /** In how many of the recent replies it appears. */
        count: z.number().int().min(1).max(RECENT_REPLIES_MAX),
        /** How the replies wrote it: "position 30-40", "342 impressions". */
        quotes: z.array(z.string().min(1).max(RECENT_QUOTE_MAX)).max(RECENT_QUOTES_MAX),
      })
    )
    .max(RECENT_FACTS_MAX),
});
export type RecentFacts = z.infer<typeof RecentFacts>;

export const NO_RECENT_FACTS: RecentFacts = { replies: 0, facts: [] };

/**
 * A fact is stated only when it fits the post. The site's name and what it
 * is about are given so the writer can tell which facts are this site's;
 * `niche` is the one line recorded for that, and the description stays
 * unread (the writer that reads the brochure writes the brochure). `source`
 * is what the prompt calls About you.
 */
export function factFitRule(site: { name: string; niche: string | null }, source = "About you"): string {
  const what = site.niche?.trim();
  return [
    `Your facts, only where they fit. A fact from ${source} (a number, a thing you did) goes into the text only when both hold: it is about the same subject as this post, and a reader who has never heard of the product behind it understands it as written.`,
    `The same subject means what the post is about, as you read it, not a word the two share: a fact about your blog's search rankings belongs under a post about SEO or rankings, never under one about motivation, money, burnout or being called a grifter, however "the grind" connects them.`,
    `This text is written for ${site.name}${what ? `, which is about: ${what}` : ""}. A fact about a different product or business than ${site.name} (another company you founded, its customers, its numbers) stays out unless the post is about that product or its market.`,
    `When no fact fits, the text carries no number and no fact about you. It can share a feeling or a belief of yours about the post's subject, in first person, with no number and no event ("i build because i like seeing something i made get used"), take a clear position on the post, or ask one sharp question. A feeling or an opinion is yours to give; an event is a fact: "when someone paid for my app", "my first customer", "my revenue" are allowed only when ${source} records them, and never invented to carry a feeling.`,
    `A note about style ("lead with a number") or an earlier correction ("use one of my numbers") never forces an unrelated fact: it means "when one fits", applies when a fact fits and yields when none does.`,
  ].join(" ");
}

/**
 * The facts the recent replies used, and the rule not to use them again.
 * Null when they used none. Each sentence is quoted short, with how it was
 * written, so the writer knows exactly what not to repeat.
 */
export function recentFactsRule(recent: RecentFacts): string | null {
  if (recent.facts.length === 0) return null;
  return [
    `Facts you used in your recent replies:`,
    ...recent.facts.map((fact) => {
      const how = fact.quotes.length ? `, as ${fact.quotes.map((quote) => `"${quote}"`).join(", ")}` : "";
      return `- "${quoteShort(fact.sentence, 100)}" (in ${fact.count} of your last ${recent.replies} replies${how})`;
    }),
    `Do not use them again unless the post asks about exactly that. Another fact that fits this post, a feeling or an opinion of yours, a position on the post or one sharp question: any of them is better than the same fact again.`,
  ].join("\n");
}

/** The stale sentences, each with its date, and how to state them. Null when none is stale. */
export function staleFactsRule(stale: readonly StaleFactForPrompt[], source = "About you"): string | null {
  if (stale.length === 0) return null;
  const one = stale.length === 1;
  return [
    `Dated facts. ${one ? `This sentence of ${source} carries` : `These sentences of ${source} carry`} a date more than ${STALE_AFTER_DAYS} days old. What ${one ? "it says" : "they say"} was true then and may not be now: state it as of its date, in the past tense ("in October I had…"), never as current, or leave it out.`,
    ...stale.map((fact) => `- "${fact.sentence}" (dated ${fact.dateLabel})`),
  ].join("\n");
}
