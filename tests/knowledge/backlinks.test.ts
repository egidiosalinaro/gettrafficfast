import { describe, expect, it, vi } from "vitest";
import { CANONICAL_SCHEMA_VERSION, type CanonicalArticle } from "@/lib/content/types";
import { MAX_BACKLINKS, placeBacklink, planBacklinks, type BacklinkTarget } from "@/lib/knowledge/backlinks";
import { findPhraseAnchor, linksTo } from "@/lib/knowledge/linking";
import { canonicalDateModified } from "@/lib/publishing/seo";

/**
 * The back-link pass, the pure part: which older articles get a link to a
 * newly published one, and the link itself. Pinned: an anchor is applied
 * only when it matches one text node character for character (the existing
 * verifier), at most three older articles change, an article never links
 * to itself, and one that already links to the new article is left alone.
 */

const target: BacklinkTarget = {
  articleId: "new",
  title: "Abandoned Cart Email: 9 Examples",
  keyword: "abandoned cart email",
  url: "https://acme.test/blog/abandoned-cart-email",
};

const doc = (id: string, bodyHtml: string): CanonicalArticle => ({
  schemaVersion: CANONICAL_SCHEMA_VERSION,
  articleId: id,
  title: `Article ${id}`,
  bodyHtml,
  headings: [],
  excerpt: "",
  metaDescription: "",
  wordCount: 10,
  slug: id,
  keyword: id,
  language: "en",
  scheduledDate: "2026-10-01",
});

const WITH_KEYWORD = '<h2 id="s">Recovering sales</h2><p>Stores recover sales with an Abandoned Cart Email sent within an hour.</p><p>Timing matters.</p>';
const WITHOUT_KEYWORD = '<h2 id="s">Recovering sales</h2><p>Stores win back shoppers who left items behind with a timely reminder.</p>';

describe("planBacklinks", () => {
  const candidates = ["a", "b", "c", "d", "e"].map((id) => ({ articleId: id, canonical: doc(id, WITHOUT_KEYWORD) }));

  it(`changes at most ${MAX_BACKLINKS} older articles, closest first`, () => {
    expect(planBacklinks({ target, candidates }).map((c) => c.articleId)).toEqual(["a", "b", "c"]);
    // A caller cannot raise the cap.
    expect(planBacklinks({ target, candidates, max: 10 })).toHaveLength(MAX_BACKLINKS);
    expect(planBacklinks({ target, candidates, max: 1 }).map((c) => c.articleId)).toEqual(["a"]);
  });

  it("never picks the new article itself", () => {
    const withSelf = [{ articleId: "new", canonical: doc("new", WITHOUT_KEYWORD) }, ...candidates];
    expect(planBacklinks({ target, candidates: withSelf }).map((c) => c.articleId)).toEqual(["a", "b", "c"]);
  });

  it("never picks an article twice, or one that already links to it, on record or in its body", () => {
    const linkedInBody = { articleId: "b", canonical: doc("b", `<p>See <a href="${target.url}">this guide</a>.</p>`) };
    const picked = planBacklinks({
      target,
      candidates: [candidates[0], candidates[0], linkedInBody, candidates[2], candidates[3], candidates[4]],
      alreadyLinkedFrom: ["c"],
    });
    expect(picked.map((c) => c.articleId)).toEqual(["a", "d", "e"]);
  });

  it("picks nothing when there is nothing to pick", () => {
    expect(planBacklinks({ target, candidates: [] })).toEqual([]);
  });
});

describe("findPhraseAnchor", () => {
  it("returns the span exactly as the body writes it, whatever the case of the phrase", () => {
    expect(findPhraseAnchor(WITH_KEYWORD, "abandoned cart email")).toBe("Abandoned Cart Email");
  });

  it("matches whole words only, and nothing inside a heading, a link or a figure", () => {
    expect(findPhraseAnchor("<p>We tested abandoned cart emails for a year.</p>", "abandoned cart email")).toBeNull();
    expect(findPhraseAnchor('<h2 id="x">Abandoned cart email</h2><p>Text.</p>', "abandoned cart email")).toBeNull();
    expect(findPhraseAnchor('<p><a href="https://x.test">abandoned cart email</a></p>', "abandoned cart email")).toBeNull();
    expect(findPhraseAnchor("<figure><figcaption>abandoned cart email</figcaption></figure>", "abandoned cart email")).toBeNull();
  });

  it("returns nothing for a phrase written twice the same way, and the unique spelling when there is one", () => {
    expect(findPhraseAnchor("<p>An abandoned cart email works.</p><p>Send the abandoned cart email early.</p>", "abandoned cart email")).toBeNull();
    expect(findPhraseAnchor("<p>Abandoned cart email works.</p><p>Send the abandoned cart email early.</p>", "abandoned cart email")).toBe("Abandoned cart email");
  });

  it("does not span two text nodes, and refuses a phrase too short to be a topic", () => {
    expect(findPhraseAnchor("<p>An abandoned <strong>cart</strong> email works.</p>", "abandoned cart email")).toBeNull();
    expect(findPhraseAnchor("<p>Good seo takes time.</p>", "seo")).toBeNull();
  });
});

describe("placeBacklink", () => {
  const NOW = new Date("2026-11-10T09:00:00Z");

  it("links the new article's keyword where the older article already writes it, without asking a model", async () => {
    const suggestAnchor = vi.fn();
    const outcome = await placeBacklink({ target, older: doc("old", WITH_KEYWORD), suggestAnchor, now: NOW });
    if (!outcome.linked) throw new Error(outcome.reason);
    expect(outcome).toMatchObject({ anchor: "Abandoned Cart Email", via: "keyword" });
    expect(outcome.canonical.bodyHtml).toBe(WITH_KEYWORD.replace("Abandoned Cart Email", `<a href="${target.url}">Abandoned Cart Email</a>`));
    // The change is recorded on the document, for the destination's dateModified.
    expect(canonicalDateModified(outcome.canonical)).toBe("2026-11-10T09:00:00.000Z");
    expect(suggestAnchor).not.toHaveBeenCalled();
  });

  it("asks for an anchor only when the keyword is not there, and applies the one that verifies", async () => {
    const suggestAnchor = vi.fn(async () => "shoppers who left items behind");
    const outcome = await placeBacklink({ target, older: doc("old", WITHOUT_KEYWORD), suggestAnchor, now: NOW });
    expect(outcome).toMatchObject({ linked: true, anchor: "shoppers who left items behind", via: "agent" });
    expect(suggestAnchor).toHaveBeenCalledTimes(1);
    if (outcome.linked) expect(linksTo(outcome.canonical.bodyHtml, target.url)).toBe(true);
  });

  it.each([
    ["an anchor the model invented", "cart recovery emails that convert", "not found"],
    ["an anchor that only exists in the heading", "Recovering sales", "not found"],
    ["an anchor in another letter case", "Shoppers Who Left Items Behind", "not found"],
  ])("drops %s and leaves the article untouched", async (_name, anchor, reason) => {
    const older = doc("old", WITHOUT_KEYWORD);
    const outcome = await placeBacklink({ target, older, suggestAnchor: async () => anchor });
    expect(outcome).toMatchObject({ linked: false, reason: expect.stringContaining(reason) });
    expect(older.bodyHtml).toBe(WITHOUT_KEYWORD);
  });

  it("drops an ambiguous anchor rather than choosing an occurrence", async () => {
    const older = doc("old", "<p>a timely reminder helps.</p><p>Send a timely reminder twice.</p>");
    expect(await placeBacklink({ target, older, suggestAnchor: async () => "a timely reminder" })).toMatchObject({
      linked: false,
      reason: expect.stringContaining("ambiguous"),
    });
  });

  it("adds no link when no anchor is offered, or none can be asked for", async () => {
    expect(await placeBacklink({ target, older: doc("old", WITHOUT_KEYWORD), suggestAnchor: async () => null })).toMatchObject({ linked: false });
    expect(await placeBacklink({ target, older: doc("old", WITHOUT_KEYWORD) })).toMatchObject({ linked: false });
  });

  it("never links an article to itself", async () => {
    const suggestAnchor = vi.fn();
    expect(await placeBacklink({ target, older: doc("new", WITH_KEYWORD), suggestAnchor })).toMatchObject({ linked: false, reason: expect.stringContaining("itself") });
    expect(suggestAnchor).not.toHaveBeenCalled();
  });

  it("never adds a second link to an article that already has one, so a second pass changes nothing", async () => {
    const first = await placeBacklink({ target, older: doc("old", WITH_KEYWORD) });
    if (!first.linked) throw new Error(first.reason);
    const suggestAnchor = vi.fn(async () => "Timing matters");
    const second = await placeBacklink({ target, older: first.canonical, suggestAnchor });
    expect(second).toMatchObject({ linked: false, reason: expect.stringContaining("already links") });
    expect(suggestAnchor).not.toHaveBeenCalled();
  });

  it("adds exactly one link", async () => {
    const outcome = await placeBacklink({ target, older: doc("old", WITH_KEYWORD) });
    if (!outcome.linked) throw new Error(outcome.reason);
    expect(outcome.canonical.bodyHtml.match(/<a /g)).toHaveLength(1);
  });
});
