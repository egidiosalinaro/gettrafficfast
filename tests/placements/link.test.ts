import { describe, expect, it } from "vitest";
import {
  linkStyle,
  linkTheName,
  ownLinkIn,
  placeOwnLink,
  replyCarriesUrl,
  siteUrl,
  variantCarriesLink,
  variantNamesBusiness,
} from "@/lib/placements/link";
import { PLACEMENT_VARIANTS } from "@/lib/placements/workflow";

/**
 * A reply names no product and carries no link; the list entry and the
 * article name the project, and there the link is placed by code, on the
 * name. A draft was blocked for "no link" with the link sitting in the link
 * field, and the person could not see what the gate wanted: the URL in the
 * sentence that names the business. Nobody types that by hand.
 */
const SITE = "https://gettrafficfa.st";

describe("linkTheName", () => {
  it("puts a Markdown link on the first mention where Markdown renders, and a bare URL elsewhere", () => {
    const body = "Passages, not pages. I run my blog through GetTrafficFast, so that's my bias. GetTrafficFast is not the point.";
    expect(linkTheName(body, ["GetTrafficFast"], SITE, "reddit")).toBe(
      "Passages, not pages. I run my blog through [GetTrafficFast](https://gettrafficfa.st), so that's my bias. GetTrafficFast is not the point."
    );
    expect(linkTheName(body, ["GetTrafficFast"], SITE, "x")).toBe(
      "Passages, not pages. I run my blog through GetTrafficFast (https://gettrafficfa.st), so that's my bias. GetTrafficFast is not the point."
    );
  });

  it("leaves a text alone when it already carries the link, names nobody, or the mention is already a link", () => {
    const linked = "I run my blog through [GetTrafficFast](https://gettrafficfa.st), so that's my bias.";
    expect(linkTheName(linked, ["GetTrafficFast"], SITE, "reddit")).toBe(linked);
    const nameless = "Passages, not pages: make every section answer its own question first.";
    expect(linkTheName(nameless, ["GetTrafficFast"], SITE, "reddit")).toBe(nameless);
    const elsewhere = "See [GetTrafficFast](https://example.com/review) for a review.";
    expect(linkTheName(elsewhere, ["GetTrafficFast"], SITE, "reddit")).toBe(elsewhere);
    const bare = "GetTrafficFast (https://example.com) is one option.";
    expect(linkTheName(bare, ["GetTrafficFast"], SITE, "x")).toBe(bare);
    expect(linkTheName("anything", [], SITE, "reddit")).toBe("anything");
  });

  it("keeps the casing the person used, prefers the longest name, and never links a word that merely contains the name", () => {
    expect(linkTheName("I use gettrafficfast daily.", ["GetTrafficFast"], SITE, "x")).toBe("I use gettrafficfast (https://gettrafficfa.st) daily.");
    expect(linkTheName("Get Traffic Fast handles it.", ["Get Traffic Fast", "Get"], SITE, "reddit")).toBe(
      "[Get Traffic Fast](https://gettrafficfa.st) handles it."
    );
    expect(linkTheName("GetTrafficFaster is something else.", ["GetTrafficFast"], SITE, "reddit")).toBe("GetTrafficFaster is something else.");
  });
});

describe("ownLinkIn and siteUrl", () => {
  it("finds the site's own link in the text, without trailing punctuation, and ignores other hosts", () => {
    expect(ownLinkIn("Details at https://gettrafficfa.st/blog. Also https://example.com/x", "gettrafficfa.st")).toBe("https://gettrafficfa.st/blog");
    expect(ownLinkIn("Only https://example.com here", "gettrafficfa.st")).toBeNull();
    expect(ownLinkIn("https://gettrafficfa.st", "")).toBeNull();
  });

  it("gives the recorded site a scheme and nothing to a business without one", () => {
    expect(siteUrl("gettrafficfa.st")).toBe("https://gettrafficfa.st");
    expect(siteUrl("https://gettrafficfa.st")).toBe("https://gettrafficfa.st");
    expect(siteUrl("  ")).toBeNull();
    expect(siteUrl(null)).toBeNull();
    expect(linkStyle("reddit")).toBe("markdown");
    expect(linkStyle("hackernews")).toBe("bare");
  });
});

describe("which variants name the business and carry its link", () => {
  it("names the project only in the list entry and the article, never in a reply", () => {
    expect(PLACEMENT_VARIANTS.filter(variantNamesBusiness)).toEqual(["article_draft", "github_pr_proposal"]);
    for (const reply of ["short_comment", "detailed_answer", "github_issue"] as const) {
      expect(variantNamesBusiness(reply), reply).toBe(false);
    }
  });

  it("gives a reply no link on any surface, and the list entry and the article one everywhere but Reddit", () => {
    for (const surface of ["x", "reddit", "linkedin", "quora", "hackernews", "stackexchange", "github", "devto"]) {
      for (const reply of ["short_comment", "detailed_answer", "github_issue"] as const) {
        expect(variantCarriesLink(reply, surface), `${reply} on ${surface}`).toBe(false);
      }
    }
    expect(variantCarriesLink("article_draft", "linkedin")).toBe(true);
    expect(variantCarriesLink("article_draft", "x")).toBe(true);
    expect(variantCarriesLink("github_pr_proposal", "github")).toBe(true);
    expect(variantCarriesLink("article_draft", "reddit")).toBe(false);
    expect(replyCarriesUrl("reddit")).toBe(false);
    expect(replyCarriesUrl("quora")).toBe(true);
  });
});

describe("placeOwnLink", () => {
  const base = { homepage: SITE, names: ["GetTrafficFast"], requested: null };

  it("gives a reply no link and leaves its text alone, a URL in it included", () => {
    const body = "Answer first. https://gettrafficfa.st has more.";
    expect(placeOwnLink({ ...base, body, variant: "short_comment", surface: "x", requested: SITE })).toEqual({ body, linkUrl: null });
  });

  it("puts the stored link on the name in an article that lost it", () => {
    const placed = placeOwnLink({
      ...base,
      body: "I write every week. GetTrafficFast schedules it.",
      variant: "article_draft",
      surface: "linkedin",
      requested: `${SITE}/blog`,
    });
    expect(placed).toEqual({ body: `I write every week. GetTrafficFast (${SITE}/blog) schedules it.`, linkUrl: `${SITE}/blog` });
  });

  it("keeps the site link the text already carries, and falls back to the homepage", () => {
    const linked = `I write every week with [GetTrafficFast](${SITE}/x).`;
    expect(placeOwnLink({ ...base, body: linked, variant: "article_draft", surface: "devto" })).toEqual({ body: linked, linkUrl: `${SITE}/x` });
    expect(placeOwnLink({ ...base, body: "GetTrafficFast, weekly.", variant: "article_draft", surface: "devto" })).toEqual({
      body: `[GetTrafficFast](${SITE}), weekly.`,
      linkUrl: SITE,
    });
  });
});
