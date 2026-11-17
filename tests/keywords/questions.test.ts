import { describe, expect, it } from "vitest";
import {
  ON_TOPIC_SCORE_FLOOR,
  QUESTION_IDEAS_DEFAULT,
  isCovered,
  isQuestionSource,
  questionFromTitle,
  questionIdeas,
  questionTokens,
  sameQuestion,
  stripSiteDecoration,
  type QuestionThread,
} from "@/lib/keywords/questions";
import { QUALIFY_SCORE_FLOOR } from "@/lib/placements/qualification";

/**
 * "Questions people ask" (lib/keywords/questions.ts): which discovered
 * threads feed it, what counts as a question, how a title is cleaned, when
 * two questions are one, when a keyword or an article already covers one,
 * and the order. Titles are shaped like the ones discovery stores for
 * Reddit, Quora, X, Hacker News, LinkedIn and Stack Exchange.
 */

let n = 0;
function thread(title: string, over: Partial<QuestionThread> = {}): QuestionThread {
  n += 1;
  return {
    url: `https://www.reddit.com/r/SaaS/comments/${n}/x/`,
    title,
    surface: "reddit",
    kind: "thread",
    community: "r/SaaS",
    status: "qualified",
    qualified_by: "agent",
    qualify_score: 80,
    intent: "question",
    posted_at: "2026-11-01T10:00:00.000Z",
    created_at: "2026-11-02T10:00:00.000Z",
    ...over,
  };
}
const ideas = (threads: QuestionThread[], keywords: string[] = [], articleTitles: string[] = [], limit?: number) =>
  questionIdeas({ threads, keywords, articleTitles, limit });
const questions = (...args: Parameters<typeof ideas>) => ideas(...args).map((i) => i.question);

describe("which threads feed the list", () => {
  it("keeps everything not rejected, and a rejection for age alone", () => {
    for (const status of ["discovered", "qualified", "drafted", "needs_review", "approved", "published_manually", "dismissed"]) {
      expect(isQuestionSource({ status })).toBe(true);
    }
    expect(isQuestionSource({ status: "rejected", qualified_by: "rules:stale", qualify_score: 0 })).toBe(true);
    expect(isQuestionSource({ status: "rejected", qualified_by: "rules:archived", qualify_score: 0 })).toBe(true);
  });

  it("leaves out what was rejected as off-topic, own-site or spam", () => {
    for (const rule of ["no_overlap", "own_site", "promotional", "not_public", "not_answerable", "too_thin"]) {
      expect(isQuestionSource({ status: "rejected", qualified_by: `rules:${rule}`, qualify_score: 0 })).toBe(false);
    }
    // The qualifier scoring it below its floor: not this business's question.
    expect(isQuestionSource({ status: "rejected", qualified_by: "agent", qualify_score: 20 })).toBe(false);
    expect(isQuestionSource({ status: "rejected", qualified_by: "agent", qualify_score: null })).toBe(false);
    expect(isQuestionSource({ status: "rejected", qualified_by: null })).toBe(false);
  });

  it("keeps a thread the qualifier found worth answering but refused for the reply", () => {
    // decide() rejects a qualified verdict with no angle, or a pitch for one.
    expect(isQuestionSource({ status: "rejected", qualified_by: "agent", qualify_score: 75 })).toBe(true);
    expect(ON_TOPIC_SCORE_FLOOR).toBe(QUALIFY_SCORE_FLOOR);
  });

  it("applies it: an off-topic question never becomes an idea, a stale one does", () => {
    expect(
      questions([
        thread("How do I get cited by ChatGPT?", { status: "rejected", qualified_by: "rules:stale", qualify_score: 0 }),
        thread("What is the best mattress for back pain?", { status: "rejected", qualified_by: "rules:no_overlap", qualify_score: 0 }),
        thread("Is my own blog post any good?", { status: "rejected", qualified_by: "rules:own_site", qualify_score: 0 }),
      ])
    ).toEqual(["How do I get cited by ChatGPT?"]);
  });

  it("skips finished pieces (articles, repositories, pages) and posts that show or list something", () => {
    expect(
      questions([
        thread("How to Use AI to Write Better Blogs Faster in 2025", { surface: "devto", kind: "article", url: "https://dev.to/a/1" }),
        thread("What is this repository for?", { surface: "github", kind: "repository", url: "https://github.com/a/b" }),
        thread("Which AI SEO tools are worth it?", { kind: "page" }),
        thread("Which of these 10 AI SEO tools did we test?", { intent: "listing" }),
        thread("Can my new tool replace your SEO agency?", { intent: "showcase" }),
      ])
    ).toEqual([]);
  });

  it("skips a thread whose link is not a web address", () => {
    expect(questions([thread("How do AI Overviews impact organic traffic?", { url: "javascript:alert(1)" })])).toEqual([]);
  });
});

describe("what counts as a question", () => {
  it.each([
    ["Can AI Replace Keyword Research Without Replacing SEO?", "Can AI Replace Keyword Research Without Replacing SEO?"],
    ["AI writing blog - sharing experience?", "AI writing blog - sharing experience?"],
    ["Does WooCommerce have abandoned cart recovery?", "Does WooCommerce have abandoned cart recovery?"],
    // Another language: the question mark is enough.
    ["Come si scrive un articolo che ChatGPT cita?", "Come si scrive un articolo che ChatGPT cita?"],
    // No question mark, but it opens like a question and is one plain line.
    ["Best Shopify-like Dashboard plugin", "Best Shopify-like Dashboard plugin"],
    ["How to override email text New Customer Order", "How to override email text New Customer Order"],
    ["which crm should a two person agency pick", "Which crm should a two person agency pick"],
    ["What is the best practice for upselling features.", "What is the best practice for upselling features"],
  ])("%s", (title, expected) => {
    expect(questionFromTitle(title)).toBe(expected);
  });

  it.each([
    "Setting up automated blog posts for SEO",
    "Going to hit 7-figures in revenue in E-commerce.",
    "Show HN: I built an automated SEO Keyword Research tool",
    "Do your own writing",
    // A story and a headline, not somebody asking.
    "How I Built The 3 Most Profitable Email Automations For My Brand",
    "How we grew to 10k MRR with programmatic SEO",
    "How to Build Your First AI Agent: A Practical Guide for Developers",
    "Best AI Blog Writer: Elevating Your Content Creation Game",
    // Cut short by the source: not completed, so not offered.
    "Which AI tools are genuinely useful for content writing, and ...",
    "What are the most practical ways to use AI tools with a …",
    "Is anyone still investing heavily in human content writers, or ...",
    // Nothing to write about.
    "Thoughts?",
    "What do you think?",
    "https://t.co/dyOOVM1VOu",
    "",
  ])("not a question: %s", (title) => {
    expect(questionFromTitle(title)).toBeNull();
  });

  it("takes the question out of a longer post, as X and LinkedIn titles are", () => {
    expect(
      questionFromTitle(
        "Honest numbers might be holding my product back. Kind of sad. Does marketing really need a bit of exaggeration? I'd rather not."
      )
    ).toBe("Does marketing really need a bit of exaggeration?");
    // Cut short after a whole question: the question is still whole.
    expect(questionFromTitle("SEO gets you ranked on Google. But who gets you cited by ChatGPT? GEO ...")).toBe(
      "But who gets you cited by ChatGPT?"
    );
  });

  it("drops a question too long to be a keyword", () => {
    expect(questionFromTitle(`How do I ${"really ".repeat(30)}rank a new site?`)).toBeNull();
  });
});

describe("normalising a title", () => {
  it.each([
    ["What is the best AI workflow for SEO content writing? - Quora", "What is the best AI workflow for SEO content writing?"],
    ["How do AI Overviews impact organic traffic?  -  Quora", "How do AI Overviews impact organic traffic?"],
    ["Is programmatic SEO dead in 2026? : r/SEO", "Is programmatic SEO dead in 2026?"],
    ["Is programmatic SEO dead in 2026? : r/SEO - Reddit", "Is programmatic SEO dead in 2026?"],
    ["Which email tool for a small WooCommerce store? | Reddit", "Which email tool for a small WooCommerce store?"],
    ["r/SaaS on Reddit: How are you getting your first 100 users?", "How are you getting your first 100 users?"],
    ["Reddit - How are you getting your first 100 users?", "How are you getting your first 100 users?"],
    ["Ask HN: How do you measure whether an LLM cites your docs?", "How do you measure whether an LLM cites your docs?"],
    ["Ask HN: How do you measure LLM citations? | Hacker News", "How do you measure LLM citations?"],
    ["[Question] Can I send web push without a service worker?", "Can I send web push without a service worker?"],
    ["How would I go about creating a customizable AI agent? - Stack Overflow", "How would I go about creating a customizable AI agent?"],
    ["Should a voucher code field appear at checkout? - User Experience Stack Exchange", "Should a voucher code field appear at checkout?"],
    ['Maya Chen on X: "Is anyone actually getting traffic from Perplexity?" / X', "Is anyone actually getting traffic from Perplexity?"],
    ["Is anyone actually getting traffic from Perplexity? https://t.co/abc123 #seo #aeo", "Is anyone actually getting traffic from Perplexity?"],
    ["Is cold email dead? | Dana Ruiz | 1,248 comments", "Is cold email dead? | Dana Ruiz"],
    ["   What​ is   GEO,\n exactly?  ", "What is GEO, exactly?"],
  ])("%s", (title, expected) => {
    expect(stripSiteDecoration(title)).toBe(expected);
  });

  it("gives the cleaned question, first letter capitalised, one question mark", () => {
    expect(questionFromTitle("is programmatic SEO dead in 2026??? : r/SEO")).toBe("Is programmatic SEO dead in 2026?");
    // A byline the suffix rule cannot know is cut with the sentence.
    expect(questionFromTitle("Is cold email dead? | Dana Ruiz | 1,248 comments")).toBe("Is cold email dead?");
  });
});

describe("near-duplicates", () => {
  it("compares topic words: stop words, case, plurals and hyphens do not count", () => {
    expect([...questionTokens("What are the BEST e-commerce Email tools?")].sort()).toEqual(["ecommerce", "email", "tool"]);
    expect(sameQuestion(questionTokens("Best email marketing tool for ecommerce?"), questionTokens("What is the best email marketing software for e-commerce?"))).toBe(true);
    expect(sameQuestion(questionTokens("How do I get cited by ChatGPT?"), questionTokens("How do I get more email subscribers?"))).toBe(false);
  });

  it("folds them into one idea that counts its distinct threads and links the most recent", () => {
    const out = ideas([
      thread("What is the best email marketing software for e-commerce? - Quora", {
        url: "https://www.quora.com/What-is-the-best-email-marketing-software-for-e-commerce",
        surface: "quora",
        community: null,
        posted_at: "2026-09-01T00:00:00.000Z",
      }),
      thread("Best email marketing tool for ecommerce?", { url: "https://www.reddit.com/r/ecommerce/comments/a1/", community: "r/ecommerce", posted_at: "2026-11-05T00:00:00.000Z" }),
      // The same thread found twice (two rows, one URL) is one thread.
      thread("Best email marketing tool for ecommerce? : r/ecommerce", { url: "https://www.reddit.com/r/ecommerce/comments/a1/", posted_at: "2026-11-05T00:00:00.000Z" }),
      thread("Best email marketing tools for e-commerce", { url: "https://x.com/someone/status/99", surface: "x", kind: "post", community: null, posted_at: null, created_at: "2026-10-01T00:00:00.000Z" }),
    ]);
    expect(out).toEqual([
      {
        question: "Best email marketing tool for ecommerce?",
        threadCount: 3,
        sourceUrl: "https://www.reddit.com/r/ecommerce/comments/a1/",
        host: "reddit.com",
        surface: "reddit",
        community: "r/ecommerce",
        postedAt: "2026-11-05T00:00:00.000Z",
      },
    ]);
  });
});

describe("questions already covered", () => {
  const asked = [thread("Does WooCommerce have abandoned cart recovery?"), thread("How do I warm up a new domain for email deliverability?")];

  it("drops a question a keyword of the pool already answers", () => {
    expect(questions(asked, ["woocommerce abandoned cart recovery"])).toEqual(["How do I warm up a new domain for email deliverability?"]);
    // The exact question, once added as a keyword, is not offered again.
    expect(questions(asked, ["Does WooCommerce have abandoned cart recovery?", "How do I warm up a new domain for email deliverability?"])).toEqual([]);
  });

  it("drops a question an article's title already answers", () => {
    expect(questions(asked, [], ["How to warm up a new domain for email deliverability in 2026"])).toEqual([
      "Does WooCommerce have abandoned cart recovery?",
    ]);
  });

  it("keeps a question that is narrower than a broad keyword", () => {
    expect(questions(asked, ["email deliverability", "woocommerce"])).toHaveLength(2);
    expect(isCovered(questionTokens("How do I warm up a new domain for email deliverability?"), [questionTokens("email deliverability")])).toBe(false);
  });
});

describe("ranking", () => {
  it("puts the question more threads ask first, then the more recent; an undated thread counts from when it was found", () => {
    const out = questions([
      thread("How do I get cited by ChatGPT?", { posted_at: "2026-11-09T00:00:00.000Z" }),
      thread("Is programmatic SEO dead in 2026?", { posted_at: "2026-08-01T00:00:00.000Z" }),
      thread("Is programmatic SEO dead in 2026? : r/SEO", { posted_at: "2026-07-01T00:00:00.000Z" }),
      thread("Which CRM fits a two person agency?", { posted_at: null, created_at: "2026-11-10T00:00:00.000Z" }),
      thread("Can I send web push without a service worker?", { posted_at: "2026-10-01T00:00:00.000Z" }),
    ]);
    expect(out).toEqual([
      "Is programmatic SEO dead in 2026?",
      "Which CRM fits a two person agency?",
      "How do I get cited by ChatGPT?",
      "Can I send web push without a service worker?",
    ]);
  });

  it("answers the top 20 unless asked, and never invents a date", () => {
    const many = Array.from({ length: 30 }, (_, i) => thread(`How do I fix problem number${i} with widget${i}?`, { posted_at: null }));
    expect(ideas(many)).toHaveLength(QUESTION_IDEAS_DEFAULT);
    expect(ideas(many, [], [], 5)).toHaveLength(5);
    expect(ideas(many)[0].postedAt).toBeNull();
  });

  it("is empty when no thread asks anything", () => {
    expect(ideas([])).toEqual([]);
    expect(ideas([thread("Setting up automated blog posts for SEO")])).toEqual([]);
  });
});
