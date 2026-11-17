import { describe, expect, it } from "vitest";
import { resolveRobots } from "next/dist/build/webpack/loaders/metadata/resolve-route-data";
import robots from "@/app/robots";
import { isPublicPath } from "@/lib/public-paths";
import { AI_ANSWER_CRAWLERS, AI_TRAINING_CRAWLERS, ALLOW_AI_TRAINING } from "@/lib/ai-crawlers";

/**
 * A crawler with no session must be able to read the sitemap as XML.
 * Everything else that is not a public page still goes to sign-up.
 */

describe("isPublicPath", () => {
  it("lets a crawler read the sitemap, robots.txt and llms.txt", () => {
    expect(isPublicPath("/sitemap.xml")).toBe(true);
    expect(isPublicPath("/robots.txt")).toBe(true);
    expect(isPublicPath("/llms.txt")).toBe(true);
    expect(isPublicPath("/llms-full.txt")).toBe(false);
  });

  it("keeps the public pages open and the product closed", () => {
    expect(isPublicPath("/")).toBe(true);
    expect(isPublicPath("/blog")).toBe(true);
    expect(isPublicPath("/blog/a-post")).toBe(true);
    expect(isPublicPath("/pricing")).toBe(true);
    expect(isPublicPath("/pricing/success")).toBe(true);
    expect(isPublicPath("/auth/sign-up")).toBe(true);
    expect(isPublicPath("/auth/sign-up-success")).toBe(true);
    expect(isPublicPath("/placements")).toBe(false);
    expect(isPublicPath("/visibility")).toBe(false);
    expect(isPublicPath("/settings/business")).toBe(false);
    expect(isPublicPath("/dashboard")).toBe(false);
  });

  it("opens the OAuth server to machines, and the consent page to its own sign-in check", () => {
    expect(isPublicPath("/.well-known/oauth-protected-resource")).toBe(true);
    expect(isPublicPath("/.well-known/oauth-protected-resource/api/mcp")).toBe(true);
    expect(isPublicPath("/.well-known/oauth-authorization-server")).toBe(true);
    expect(isPublicPath("/oauth/register")).toBe(true);
    expect(isPublicPath("/oauth/token")).toBe(true);
    expect(isPublicPath("/oauth/authorize")).toBe(true);
    expect(isPublicPath("/oauthx")).toBe(false);
    expect(isPublicPath("/settings/api-keys")).toBe(false);
  });
});

describe("robots", () => {
  it("points at the xml sitemap and does not invite crawlers into the app", () => {
    const body = robots();
    expect(body.sitemap).toBe("https://gettrafficfa.st/sitemap.xml");
    const rule = Array.isArray(body.rules) ? body.rules[0] : body.rules;
    expect(rule?.allow).toEqual(expect.arrayContaining(["/$", "/sitemap.xml", "/blog"]));
    expect(rule?.disallow).toEqual(expect.arrayContaining(["/", "/pricing/success", "/pricing/cancel"]));
  });

  it("lets a crawler fetch the favicon, the card images and the pages' own CSS and JS", () => {
    // Disallow "/" covered these: Google shows no favicon it may not crawl,
    // and X no card image it may not fetch.
    const body = robots();
    const rule = Array.isArray(body.rules) ? body.rules[0] : body.rules;
    expect(rule?.allow).toEqual(
      expect.arrayContaining(["/favicon.ico", "/icon.svg", "/icon.png", "/apple-icon.png", "/og/", "/_next/static/", "/_next/image"])
    );
  });
});

describe("robots, AI crawlers", () => {
  const rules = () => {
    const body = robots();
    return Array.isArray(body.rules) ? body.rules : [body.rules];
  };
  const agents = (rule: { userAgent?: string | string[] }) => [rule.userAgent ?? []].flat();

  it("keeps * first, then names the answer crawlers and the training crawlers in groups of their own", () => {
    const [all, answer, training] = rules();
    expect(all.userAgent).toBe("*");
    expect(agents(answer)).toEqual([...AI_ANSWER_CRAWLERS]);
    expect(agents(training)).toEqual([...AI_TRAINING_CRAWLERS]);
    for (const name of ["OAI-SearchBot", "ChatGPT-User", "Claude-SearchBot", "Claude-User", "PerplexityBot", "Perplexity-User"]) {
      expect(agents(answer)).toContain(name);
    }
    for (const name of ["GPTBot", "ClaudeBot", "Google-Extended", "Applebot-Extended"]) {
      expect(agents(training)).toContain(name);
    }
  });

  it("gives every named group the same rules as *, so naming a crawler never opens the product to it", () => {
    const [all, answer, training] = rules();
    expect(answer.allow).toEqual(all.allow);
    expect(answer.disallow).toEqual(all.disallow);
    expect(answer.disallow).toEqual(expect.arrayContaining(["/", "/pricing/success", "/pricing/cancel"]));
    // The owner's choice for this site (lib/ai-crawlers.ts): training allowed on the public pages.
    expect(ALLOW_AI_TRAINING).toBe(true);
    expect(training.allow).toEqual(all.allow);
    expect(training.disallow).toEqual(all.disallow);
  });

  it("allows /llms.txt for every group", () => {
    for (const rule of rules()) expect(rule.allow).toContain("/llms.txt");
  });

  it("serves each group as its own block of the robots.txt file", () => {
    const text = resolveRobots(robots());
    const blocks = text.trim().split("\n\n");
    expect(blocks[0].startsWith("User-Agent: *\n")).toBe(true);
    expect(blocks[1]).toContain("User-Agent: OAI-SearchBot\nUser-Agent: ChatGPT-User\n");
    expect(blocks[2]).toContain("User-Agent: GPTBot\n");
    for (const block of blocks.slice(0, 3)) {
      expect(block).toContain("Allow: /$\n");
      expect(block).toContain("Allow: /blog\n");
      expect(block).toContain("Disallow: /\n");
      expect(block).toContain("Disallow: /pricing/success");
    }
    expect(text).toContain("Sitemap: https://gettrafficfa.st/sitemap.xml");
  });
});
