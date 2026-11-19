import { holdReasons, REASON_NOT_RECORDED } from "@/lib/content/hold-reasons";
import { CONTENT_PATHS } from "@/lib/content-paths";
import { linkFinding, stoppedLine, type LinkSearchOutcome } from "@/lib/placements/reply-link";
import type { TodayReply } from "@/lib/placements/today";
import { quoteShort, type StaleFact } from "@/lib/voice/staleness";

/**
 * "Also today" on the Today screen (2026-11-14): what needs a person's
 * gesture today besides the replies, each with the action that resolves it.
 * Pure: the reads are in ./read.ts, the cards in components/today/.
 *
 * Three kinds, and nothing else:
 *
 * - **An article held or failed**: in `needs_review` (a gate held it; the
 *   first reason is said, from `holdReasons`, the calendar's own words) or
 *   `failed`. Resolved where the article lives (Content: today's on its screen, others on the board): re-check
 *   it free (`resettle_article`), publish it anyway, regenerate it, or for a
 *   failed one try again (`retry_article`) or ignore it on Today
 *   (`dismiss_failed_articles`; it stays on the Content board). Nothing here starts a paid run.
 * - **A fact of About you old enough to ask about** (`staleFacts`,
 *   lib/voice/staleness.ts): "Still true" (`confirm_about_you_fact`) or
 *   "Update it" in Settings → Voice.
 * - **A posted reply whose link GTF stopped looking for** on X
 *   (`linkFinding` "stopped"): paste its link (`set_reply_link`). Only the
 *   last 7 days, X's own search window: older replies are under Posted,
 *   marked "No link", like every reply GTF never looked for.
 *
 * - **A push to apply** (Push page 3, docs/LIFECYCLE.md): a proposal the
 *   site could not take as an update, links to add and a new title.
 *   Opens the article, where the proposal is spelled out; "I added it" or
 *   "Dismiss" (`resolve_article_push`).
 *
 * When there is none, the list is empty and the screen shows no section.
 */

export type AlsoTodayItem =
  | {
      kind: "article_held" | "article_failed";
      /** Stable per item: "article:<id>". */
      id: string;
      articleId: string;
      /** The keyword the article was written for. */
      title: string;
      /** The day it is scheduled for, `YYYY-MM-DD`. */
      scheduledDate: string;
      /** Today's article, in the zone the day was read in. */
      isToday: boolean;
      /** Held: why, the first reason as the calendar says it. Failed: null. */
      reason: string | null;
      /** How many reasons beyond the first. */
      moreReasons: number;
      /** Where the screen resolves it. */
      href: string;
      /** The tools that resolve it, the free one first. */
      tools: string[];
    }
  | {
      kind: "fact_stale";
      id: string;
      /** The sentence of About you, exactly: what `confirm_about_you_fact` takes. */
      sentence: string;
      /** The sentence short enough for one line on a phone. */
      quote: string;
      dateLabel: string;
      /** The day it was last confirmed as still true (`confirmedFacts`); null when never. */
      confirmedOn: string | null;
      /** "34 days ago", "last month": since the later of its date and `confirmedOn`. */
      age: string;
      href: string;
      tools: string[];
    }
  | {
      kind: "reply_link";
      id: string;
      targetId: string;
      surface: string;
      /** The post that was answered. */
      url: string;
      author: string | null;
      community: string | null;
      /** The first line of the reply, when one is on record. */
      text: string | null;
      publishedAt: string;
      /** How GTF's last search ended. */
      outcome: LinkSearchOutcome | null;
      /** Why GTF stopped, in a sentence (`stoppedLine`). */
      line: string;
      href: string;
      tools: string[];
    }
  | {
      kind: "article_push";
      id: string;
      pushId: string;
      articleId: string;
      /** The article's headline. */
      title: string;
      mainQuery: string;
      /** Links proposed for the person to add. */
      links: number;
      /** Whether a new meta title or description is proposed. */
      newTitle: boolean;
      href: string;
      tools: string[];
    };

export type AlsoTodayKind = AlsoTodayItem["kind"];

/** A proposal of Push page 3, as read for Today. */
export interface PushProposal {
  id: string;
  articleId: string;
  title: string;
  mainQuery: string;
  proposedLinks: number;
  newTitle: boolean;
}

/** The article board, with this article's modal open. */
export function articleModalHref(articleId: string): string {
  return `${CONTENT_PATHS.articles}?article=${encodeURIComponent(articleId)}`;
}

export function pushItems(proposals: readonly PushProposal[]): AlsoTodayItem[] {
  return proposals
    .filter((p) => p.proposedLinks > 0 || p.newTitle)
    .map((p) => ({
      kind: "article_push" as const,
      id: `push:${p.id}`,
      pushId: p.id,
      articleId: p.articleId,
      title: p.title.trim() || "Untitled",
      mainQuery: p.mainQuery,
      links: p.proposedLinks,
      newTitle: p.newTitle,
      href: articleModalHref(p.articleId),
      tools: ["resolve_article_push"],
    }));
}

/** Where an article's actions live: today's on the Content screen, any other on the board of every article. */
export function articleHref(isToday: boolean): string {
  return isToday ? CONTENT_PATHS.home : CONTENT_PATHS.articles;
}
/** Where About you is edited. */
export const VOICE_HREF = "/settings/voice";
/** Where a posted reply's link is pasted. */
export const POSTED_HREF = "/today?view=posted";

/** What is read of a held or failed article. */
export interface HeldArticle {
  id: string;
  status: string;
  scheduledDate: string;
  keyword: string;
  lastError?: unknown;
  qualityReport?: unknown;
}

/** A short, stable id for a sentence (djb2), so a card keeps its key across reloads. */
function sentenceKey(sentence: string): string {
  let hash = 5381;
  for (let i = 0; i < sentence.length; i += 1) hash = ((hash << 5) + hash + sentence.charCodeAt(i)) | 0;
  return (hash >>> 0).toString(36);
}

export function articleItems(articles: readonly HeldArticle[], today: string | null): AlsoTodayItem[] {
  return articles
    .filter((a) => a.status === "needs_review" || a.status === "failed")
    .sort((a, b) => b.scheduledDate.localeCompare(a.scheduledDate))
    .map((a) => {
      const held = a.status === "needs_review";
      const reasons = held ? holdReasons({ qualityReport: a.qualityReport, lastError: a.lastError }) : [];
      const isToday = today !== null && a.scheduledDate === today;
      return {
        kind: held ? ("article_held" as const) : ("article_failed" as const),
        id: `article:${a.id}`,
        articleId: a.id,
        title: a.keyword.trim() || "Untitled",
        scheduledDate: a.scheduledDate,
        isToday,
        reason: held ? (reasons[0] ?? REASON_NOT_RECORDED) : null,
        moreReasons: Math.max(0, reasons.length - 1),
        href: articleHref(isToday),
        tools: held ? ["resettle_article", "publish_article", "generate_article"] : ["retry_article", "dismiss_failed_articles"],
      };
    });
}

export function factItems(stale: readonly StaleFact[]): AlsoTodayItem[] {
  return stale.map((fact) => ({
    kind: "fact_stale" as const,
    id: `fact:${sentenceKey(fact.sentence)}`,
    sentence: fact.sentence,
    quote: quoteShort(fact.sentence),
    dateLabel: fact.dateLabel,
    confirmedOn: fact.confirmedOn,
    age: fact.age,
    href: VOICE_HREF,
    tools: ["confirm_about_you_fact", "update_voice_settings"],
  }));
}

/**
 * Posted replies whose link GTF looked for on X and stopped: the rows are
 * read with their searches (`loadTodayReplies`), and only "stopped" is
 * kept. A reply GTF is still looking for, or never looks for, is not here.
 */
export function replyLinkItems(replies: readonly TodayReply[], now: number): AlsoTodayItem[] {
  const out: AlsoTodayItem[] = [];
  for (const reply of replies) {
    if ((reply.publishedUrl ?? "").trim() || !("linkSearch" in reply)) continue;
    const finding = linkFinding(
      {
        surface: reply.surface,
        status: "published_manually",
        url: reply.url,
        publishedUrl: reply.publishedUrl,
        publishedAt: reply.publishedAt,
        removedAt: null,
        linkSearch: reply.linkSearch,
      },
      // "stopped" does not depend on the switch: it is read before it.
      { finderOn: false, now }
    );
    if (finding?.state !== "stopped") continue;
    out.push({
      kind: "reply_link",
      id: `reply:${reply.id}`,
      targetId: reply.id,
      surface: reply.surface,
      url: reply.url,
      author: reply.author,
      community: reply.community,
      text: reply.text,
      publishedAt: reply.publishedAt,
      outcome: finding.outcome,
      line: stoppedLine(finding.outcome),
      href: POSTED_HREF,
      tools: ["set_reply_link"],
    });
  }
  return out;
}

/** The section, in the order the screen shows it: articles, pushes to apply, then links to paste, then facts. */
export function alsoTodayItems(input: {
  articles: readonly HeldArticle[];
  today: string | null;
  replies: readonly TodayReply[];
  staleFacts: readonly StaleFact[];
  now: number;
  pushes?: readonly PushProposal[];
}): AlsoTodayItem[] {
  return [
    ...articleItems(input.articles, input.today),
    ...pushItems(input.pushes ?? []),
    ...replyLinkItems(input.replies, input.now),
    ...factItems(input.staleFacts),
  ];
}
