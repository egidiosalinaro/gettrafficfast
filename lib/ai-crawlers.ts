/**
 * The AI crawlers a robots.txt names on purpose: on gettrafficfa.st
 * (app/robots.ts), in the snippet the public docs give WordPress customers
 * (/docs#ai-crawlers), and in the agent prompt for a webhook receiver
 * (components/integrations/ai-agent-prompt.tsx). One list, so the three
 * cannot drift.
 *
 * Naming them changes nothing a `*` group did not already allow: a crawler
 * obeys the most specific group that names it, and each group here carries
 * the same rules as `*`. It makes the choice explicit for a reader, and it is
 * where a different rule for one kind of crawler goes.
 *
 * The tokens are the vendors' own, as their crawler pages listed them on
 * 2026-11-15 (OpenAI "Overview of OpenAI crawlers", Anthropic support article
 * 8896518, Perplexity "Perplexity crawlers", Google "common crawlers", Apple
 * "About Applebot"). Vendors add and retire tokens: Anthropic's `Claude-Web`
 * and `anthropic-ai` are retired and are not listed.
 *
 * Search engines proper (Googlebot, Bingbot, which also feeds Copilot,
 * Applebot) are not here: they follow the `*` group, as they always have.
 */

/**
 * Crawlers that read a page so an answer engine can find it, or fetch it
 * because a person asked about it. Blocking one keeps the site out of that
 * engine's answers; there is no reason for a public page to do that.
 */
export const AI_ANSWER_CRAWLERS = [
  "OAI-SearchBot", // ChatGPT search
  "ChatGPT-User", // a page fetched because a ChatGPT user asked
  "Claude-SearchBot", // Claude's search index
  "Claude-User", // a page fetched because a Claude user asked
  "PerplexityBot", // Perplexity's index
  "Perplexity-User", // a page fetched because a Perplexity user asked
] as const;

/**
 * Tokens that decide whether a page may be used to train models. Blocking
 * one does not remove a site from that vendor's search (GPTBot is not
 * OAI-SearchBot, ClaudeBot is not Claude-SearchBot). Two are control tokens,
 * not crawlers: Google-Extended (Gemini training, and grounding in the Gemini
 * apps and Vertex AI, by Google's own description) and Applebot-Extended.
 */
export const AI_TRAINING_CRAWLERS = ["GPTBot", "ClaudeBot", "Google-Extended", "Applebot-Extended"] as const;

/**
 * The owner's choice for gettrafficfa.st, decided 2026-11-15: training is
 * allowed on the public pages. They are a marketing site, docs and a blog
 * written to be read and repeated; a model that has read them can describe
 * the product, and nothing on them is private (the product itself stays
 * disallowed for every crawler).
 *
 * To flip it, set this to false: the training group then gets
 * `Disallow: /` and nothing else changes. The answer crawlers are not
 * affected either way.
 */
export const ALLOW_AI_TRAINING = true;

export interface CrawlRules {
  allow: string[];
  disallow: string[];
}

export interface CrawlerGroup extends Partial<CrawlRules> {
  userAgent: string[];
}

/**
 * The two named groups for a site whose `*` group is `site`: the answer
 * crawlers always get the site's own rules, the training crawlers get them
 * when training is allowed and `Disallow: /` otherwise.
 */
export function aiCrawlerGroups(site: CrawlRules, allowTraining: boolean = ALLOW_AI_TRAINING): CrawlerGroup[] {
  return [
    { userAgent: [...AI_ANSWER_CRAWLERS], allow: [...site.allow], disallow: [...site.disallow] },
    allowTraining
      ? { userAgent: [...AI_TRAINING_CRAWLERS], allow: [...site.allow], disallow: [...site.disallow] }
      : { userAgent: [...AI_TRAINING_CRAWLERS], disallow: ["/"] },
  ];
}

/**
 * WordPress's own rule for every crawler: the admin is closed, its AJAX
 * endpoint (which themes call from public pages) open. A crawler named in a
 * group of its own stops reading `*`, so the named groups repeat it.
 */
const WORDPRESS_RULES: CrawlRules = {
  allow: ["/", "/wp-admin/admin-ajax.php"],
  disallow: ["/wp-admin/"],
};

function groupText(group: CrawlerGroup): string {
  return [
    ...group.userAgent.map((agent) => `User-agent: ${agent}`),
    ...(group.allow ?? []).map((path) => `Allow: ${path}`),
    ...(group.disallow ?? []).map((path) => `Disallow: ${path}`),
  ].join("\n");
}

/**
 * The lines a WordPress site adds to its robots.txt, with the training group
 * allowed: the customer decides, and the comment says how to opt out.
 */
export function wordpressRobotsSnippet(): string {
  const [answer, training] = aiCrawlerGroups(WORDPRESS_RULES, true);
  return [
    "# AI search and answer engines",
    groupText(answer),
    "",
    "# AI training. To opt out, replace the Allow and Disallow lines below with: Disallow: /",
    groupText(training),
  ].join("\n");
}
