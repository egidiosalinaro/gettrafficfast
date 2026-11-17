import { z } from "zod";
import { SHORT_VERSION_MAX_WORDS, anatomyLabels, articleDataFacts } from "@/lib/content/anatomy";
import { TOPIC_INTENTS } from "@/lib/keywords/intent";

/**
 * What the outline and the writer are both told, in the same words.
 *
 * Every rule here answers something production published before 2026-11-10
 * (docs/CONTENT_PIPELINE.md, "What the audit of 2026-11-10 found"). The
 * content gates check the same rules after the fact
 * (lib/content/quality/gates.ts): the prompt asks, the gate verifies, and a
 * draft that fails goes back once with the failure named.
 */

/** The real search results the article is written from, as the research step stored them. */
export const ArticleEvidence = z.object({
  results: z
    .array(z.object({ title: z.string(), domain: z.string(), snippet: z.string() }))
    .default([]),
  /** "People also ask", verbatim. */
  questions: z.array(z.string()).default([]),
  relatedSearches: z.array(z.string()).default([]),
});
export type ArticleEvidence = z.infer<typeof ArticleEvidence>;

/** What the business itself said: the only first-hand material there is. */
export const BusinessFacts = z.object({
  businessName: z.string().optional(),
  businessNiche: z.string().optional(),
  businessDescription: z.string().optional(),
  /** The business's real site. Any link to the business uses this host. */
  websiteUrl: z.string().optional(),
  /**
   * Settings → Voice → Facts for articles (`voice_settings.articleFacts`):
   * the true things a public article may state about the writer and the
   * business, in the owner's words. Never About you: that is what replies
   * read, and since 12 November 2026 an article does not (docs/VOICE.md).
   */
  firstHandFacts: z.string().optional(),
  /** Settings → Voice → notes: how the owner writes and what they never say. */
  ownerNotes: z.string().optional(),
  /**
   * The kind of search the article's topic answers (`keywords.intent`,
   * lib/keywords/intent.ts). Only "comparison" changes the brief
   * (`comparisonBlock`); absent on older jobs, read as no intent.
   */
  topicIntent: z.enum(TOPIC_INTENTS).optional(),
});
export type BusinessFacts = z.infer<typeof BusinessFacts>;

/** True when the article is a comparison page: the business may be one option among the ones compared. */
export function isComparisonBrief(facts: Pick<BusinessFacts, "topicIntent">): boolean {
  return facts.topicIntent === "comparison";
}

/**
 * What a comparison page owes its reader (owner's rule, 2026-11-15): the
 * real options, treated fairly, who should pick a competitor, the business
 * as one option among them described only with its own true facts, and no
 * price nobody gave. Empty for any other intent.
 */
export function comparisonBlock(facts: BusinessFacts): string {
  if (!isComparisonBrief(facts)) return "";
  const name = facts.businessName?.trim() || "the business";
  return `This is a comparison page: the reader is choosing between tools.
- Compare the real options this search is about: products named in the keyword or in the search evidence. Never add a product that appears in neither.
- Treat every option fairly: what each is good at and where it falls short, from the evidence. Say plainly who should choose a competitor over ${name}, and why.
- ${name} may be one of the options, never the first by default and never the winner by default. Describe it only with the business context and the first-hand facts above; a feature, plan or result not stated there is not stated.
- Prices: only a price that appears in the search evidence, attributed to where it appears. When a price is unknown, write "check their pricing page"; never estimate one, never write "from $X" from memory.
- No scores, ratings or "out of 10".`;
}

/** The rule for naming the business in a comparison page: replaces "at most once, in the closing section". */
export function comparisonProductRule(facts: BusinessFacts): string {
  const name = facts.businessName?.trim() || "the business";
  return `${name} is one option of the comparison: it may have its own row in the table and its own short section, like every other option, and is not mentioned in the introduction. No superlatives ("best", "leading", "unparalleled"), no pitch, no claim the business facts above do not make.`;
}

export function businessBlock(facts: BusinessFacts): string {
  const lines = [
    facts.businessName && `Name: ${facts.businessName}`,
    facts.businessNiche && `Niche: ${facts.businessNiche}`,
    facts.businessDescription && `Description: ${facts.businessDescription}`,
    facts.websiteUrl && `Website (the ONLY address of this business): ${facts.websiteUrl}`,
  ].filter(Boolean);
  return lines.length > 0 ? `Business context:\n${lines.join("\n")}` : "";
}

/**
 * The first-hand facts, and the rule that goes with them. The empty case is
 * spelled out: silence would leave the model free to invent a history.
 *
 * The facts are the owner's Facts for articles. A figure from them is stated
 * with its source and period in the same sentence ("in my own Search
 * Console, September to November 2026"), so a reader sees whose number it
 * is: until 12 November 2026 the writer stated the owner's figures bare,
 * and the audit held the article for figures "presented without a source".
 */
export function factsBlock(facts: BusinessFacts): string {
  const own = (facts.firstHandFacts ?? "").trim();
  const notes = (facts.ownerNotes ?? "").trim();
  const lines = [
    own
      ? `First-hand facts, in the owner's own words. These are the ONLY first-hand facts and numbers you may state, and you may leave any of them out:\n"""\n${own}\n"""\nWhen you state a figure from these facts, attribute it in the same sentence: whose it is and when, taken from the owner's wording (for example "in my own Search Console, between September and November 2026"). If the facts give no period, say whose it is ("on my own site") and give no date.`
      : `No first-hand facts are on record for this article, so it states none: no results, no numbers of the writer's own, no customer counts, no time spent, no "we have seen". Write from the search evidence and general expertise. Use the first person only for method and opinion ("the way I check a draft is…", "I think…"), never for results.`,
    `Every other number (a price, a percentage, a rating, "typically N", a count of customers) must appear in the search evidence given to you, or it does not appear at all. When you do not have a figure, describe the thing in words. Never estimate, never round a guess into a number, never rate anything out of 5.`,
    notes ? `The owner's notes on how they write. Follow them:\n"""\n${notes}\n"""` : null,
  ].filter((line): line is string => line !== null);
  return lines.join("\n");
}

export function evidenceBlock(evidence: ArticleEvidence | undefined): string {
  if (!evidence || (evidence.results.length === 0 && evidence.questions.length === 0)) {
    return "No search evidence is available for this keyword: state no statistics, prices or ratings at all.";
  }
  const parts = ["Search evidence (the real results for this keyword today; the only outside source you have):"];
  if (evidence.results.length > 0) {
    parts.push(
      evidence.results
        .slice(0, 8)
        .map((r, i) => `${i + 1}. [${r.domain}] ${r.title}\n   ${r.snippet.slice(0, 240)}`)
        .join("\n")
    );
  }
  if (evidence.questions.length > 0) {
    parts.push(`People also ask:\n${evidence.questions.map((q) => `- ${q}`).join("\n")}`);
  }
  if (evidence.relatedSearches.length > 0) {
    parts.push(`Related searches: ${evidence.relatedSearches.slice(0, 8).join("; ")}`);
  }
  return parts.join("\n");
}

/** A keyword whose reader wants options side by side. */
export function isComparativeKeyword(keyword: string): boolean {
  return /\b(vs\.?|versus|compar\w+|alternatives?|best|top|or|confronto|migliori?|alternative)\b/i.test(keyword);
}

export const TITLE_RULES = `Title rules:
- At most 60 characters, counted. A longer title is cut in search results.
- None of these words: Mastering, Unlock, Ultimate, Definitive, Blueprint, Unleash. No "Guide to Everything", no colon followed by a second title.
- The title is a promise the body keeps to the letter. "Ranked" means the body ranks, in an ordered list or a table, and says by what. "Compared" or "vs" means the body has a comparison table. "7 ways" means exactly seven. If the body will not contain it, the title does not say it.`;

export const STOCK_PHRASE_RULES = `Banned openings and closings. A reader recognises each of these as filler and stops reading:
- "In today's competitive digital landscape…", "In today's fast-paced world…"
- "The landscape of X is rapidly evolving…", "X is no longer a luxury but a strategic necessity"
- "Whether you're a beginner or an expert…", "Let's dive in", "In the realm of…"
- "In conclusion,…", "To sum up,…", "…take your X to the next level", "…offers an unparalleled solution"
Open with the answer to the search, or with the concrete situation the reader is in. Close with the next thing the reader should do. Also never: game-changer, unlock the potential, look no further, delve into, it's important to note.`;

/**
 * The article's anatomy (2026-11-15, docs/CONTENT_PIPELINE.md "The article's
 * anatomy"): the answer first, headings that are the questions people ask,
 * and the data section only when the owner's facts hold publishable data.
 * Told to the writer and the revision in the same words (`writingRules`);
 * checked after the fact by `lib/content/quality/anatomy.ts`.
 */
export function anatomyRules(input: { language: string; businessName?: string; firstHandFacts?: string }): string {
  const labels = anatomyLabels(input.language);
  const name = input.businessName?.trim() || "the business";
  const { usable } = articleDataFacts(input.firstHandFacts);
  const data =
    usable.length > 0
      ? `- These of the owner's facts are measurements that may be published:\n${usable
          .map((fact) => `  - ${fact.sentence}`)
          .join("\n")}\n- If one or more of them bears on this article's question, add ONE short section, <h2>${labels.fromOurData}</h2>, before the FAQ (before the closing section when there is no FAQ): 2 to 4 sentences, or a short list, stating those figures exactly as the owner gives them, what each one measures, and the period it covers when the owner's wording gives one. No other figure goes in it: none from the search evidence, none rounded or derived. If none of them bears on the question, there is no such section.`
      : `- No published measurement of the owner's is on record for this article: write no "${labels.fromOurData}" section, nor anything presented as the site's own data.`;
  return `The answer first:
- Right after the <h1>, before any introduction, write one paragraph that opens with the label in bold: <p><strong>${labels.shortVersion}:</strong> …</p>. It answers the article's question directly, in 3 to 6 sentences and at most ${SHORT_VERSION_MAX_WORDS - 20} words, complete on its own: someone who reads only this paragraph, or an answer engine that quotes only it, has the answer. No teaser, no "in this article", no mention of ${name}. The introduction follows it.
- At least half of the <h2> headings (the FAQ, the data section and the closing section aside) are the questions people actually ask, written as questions and ending in "?": take them from "People also ask" and the plan's questions, in the searchers' words. Each such section answers its question in its first one or two sentences, then gives the detail.

The site's own data:
${data}`;
}
