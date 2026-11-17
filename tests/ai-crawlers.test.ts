import { describe, expect, it } from "vitest";
import { aiCrawlerGroups, AI_ANSWER_CRAWLERS, AI_TRAINING_CRAWLERS, wordpressRobotsSnippet } from "@/lib/ai-crawlers";

/**
 * The AI crawler groups: the answer crawlers always get the site's rules,
 * the training crawlers get them or `Disallow: /`, and the snippet the docs
 * give WordPress customers names every crawler and keeps WordPress's own rule.
 */

const site = { allow: ["/$", "/blog"], disallow: ["/", "/private"] };

describe("aiCrawlerGroups", () => {
  it("gives both groups the site's rules when training is allowed", () => {
    const [answer, training] = aiCrawlerGroups(site, true);
    expect(answer).toEqual({ userAgent: [...AI_ANSWER_CRAWLERS], ...site });
    expect(training).toEqual({ userAgent: [...AI_TRAINING_CRAWLERS], ...site });
  });

  it("closes only the training group when training is not allowed", () => {
    const [answer, training] = aiCrawlerGroups(site, false);
    expect(answer).toEqual({ userAgent: [...AI_ANSWER_CRAWLERS], ...site });
    expect(training).toEqual({ userAgent: [...AI_TRAINING_CRAWLERS], disallow: ["/"] });
  });

  it("does not share arrays with the caller", () => {
    const [answer] = aiCrawlerGroups(site, true);
    answer.disallow!.push("/changed");
    expect(site.disallow).toEqual(["/", "/private"]);
  });

  it("keeps the two lists apart and leaves retired tokens out", () => {
    const answer: readonly string[] = AI_ANSWER_CRAWLERS;
    for (const name of AI_TRAINING_CRAWLERS) expect(answer).not.toContain(name);
    const all: readonly string[] = [...AI_ANSWER_CRAWLERS, ...AI_TRAINING_CRAWLERS];
    for (const retired of ["Claude-Web", "anthropic-ai"]) expect(all).not.toContain(retired);
  });
});

describe("wordpressRobotsSnippet", () => {
  it("names every crawler, once, with WordPress's admin rule repeated in each group", () => {
    const snippet = wordpressRobotsSnippet();
    for (const name of [...AI_ANSWER_CRAWLERS, ...AI_TRAINING_CRAWLERS]) {
      expect(snippet.match(new RegExp(`^User-agent: ${name}$`, "gm"))).toHaveLength(1);
    }
    expect(snippet.match(/^Allow: \/$/gm)).toHaveLength(2);
    expect(snippet.match(/^Disallow: \/wp-admin\/$/gm)).toHaveLength(2);
    expect(snippet.match(/^Allow: \/wp-admin\/admin-ajax\.php$/gm)).toHaveLength(2);
    expect(snippet).not.toMatch(/^Disallow: \/$/m);
    expect(snippet).toContain("To opt out");
  });
});
