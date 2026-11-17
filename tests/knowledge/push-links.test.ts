import { describe, expect, it } from "vitest";
import { CANONICAL_SCHEMA_VERSION, type CanonicalArticle } from "@/lib/content/types";
import { anchorFitsQuery } from "@/lib/lifecycle/push";
import { checkAddedSentence, linkableParagraphs, linksToCount, placePushLink } from "@/lib/knowledge/push-links";

/**
 * Push page 3's link (docs/LIFECYCLE.md): one contextual link from a best
 * page to the pushed article, on the page's own words or in one short added
 * sentence; never in the short version or Read next, never twice.
 */

const URL = "https://acme.test/blog/subject-lines";
const QUERY = "abandoned cart email subject lines";

const doc = (bodyHtml: string): CanonicalArticle => ({
  schemaVersion: CANONICAL_SCHEMA_VERSION,
  articleId: "src",
  title: "Abandoned cart emails",
  bodyHtml,
  headings: [],
  excerpt: "",
  metaDescription: "",
  wordCount: 100,
  slug: "abandoned-cart-emails",
  keyword: "abandoned cart email",
  language: "en",
  scheduledDate: "2026-10-01",
});

const SHORT = "<p><strong>The short version:</strong> Abandoned cart email subject lines decide whether the email is opened.</p>";
const BODY = `${SHORT}
<h2 id="why">Why do carts get abandoned?</h2>
<p>Shoppers leave for many reasons.</p>
<p>The first email matters most, and good abandoned cart email subject lines get it opened.</p>
<h2 id="read-next">Read next</h2>
<ul><li><a href="https://acme.test/blog/other">Other</a></li></ul>`;

const target = { articleId: "t", url: URL, mainQuery: QUERY };
const anchorOk = (anchor: string) => anchorFitsQuery(anchor, QUERY);

describe("placePushLink", () => {
  it("links the main query where the page already writes it, outside the short version, with no model", () => {
    const outcome = placePushLink({ source: doc(BODY), target, anchorOk });
    expect(outcome).toMatchObject({ linked: true, mode: "existing", via: "query", anchor: QUERY });
    if (!outcome.linked) return;
    expect(outcome.canonical.bodyHtml).toContain(`good <a href="${URL}">${QUERY}</a> get it opened`);
    // The short version is the paragraph an engine quotes alone: untouched.
    expect(outcome.canonical.bodyHtml).toContain(SHORT);
    expect(linksToCount(outcome.canonical.bodyHtml, URL)).toBe(1);
  });

  it("adds one short sentence at the end of the chosen paragraph when no phrase fits", () => {
    const body = `${SHORT}\n<p>Shoppers leave for many reasons.</p>\n<p>Timing is the second lever.</p>`;
    const outcome = placePushLink({
      source: doc(body),
      target,
      suggestion: { mode: "sentence", paragraph: 1, sentence: "Strong subject lines for abandoned cart emails win the open.", anchor: "subject lines for abandoned cart emails" },
      anchorOk,
    });
    expect(outcome).toMatchObject({ linked: true, mode: "sentence", via: "agent" });
    if (!outcome.linked) return;
    expect(outcome.canonical.bodyHtml).toContain(
      `<p>Shoppers leave for many reasons. Strong <a href="${URL}">subject lines for abandoned cart emails</a> win the open.</p>`
    );
    expect(outcome.canonical.bodyHtml).toContain(SHORT);
  });

  it("never links twice: a page that already links to the article (Read next included) is left alone", () => {
    const body = `${BODY.replace("https://acme.test/blog/other", URL)}`;
    expect(placePushLink({ source: doc(body), target, anchorOk })).toEqual({ linked: false, reason: "already links to the article" });
  });

  it("refuses an anchor that is not the query or a variant, an invented span, and a bad sentence", () => {
    const plain = doc(`${SHORT}\n<p>Shoppers leave for many reasons.</p>`);
    expect(placePushLink({ source: plain, target, suggestion: { mode: "existing", anchor: "many reasons" }, anchorOk })).toMatchObject({ linked: false });
    expect(placePushLink({ source: plain, target, suggestion: { mode: "existing", anchor: "abandoned cart email subject lines" }, anchorOk })).toMatchObject({
      linked: false,
      reason: expect.stringContaining("not found"),
    });
    expect(
      placePushLink({ source: plain, target, suggestion: { mode: "sentence", paragraph: 9, sentence: "Read about abandoned cart email subject lines.", anchor: QUERY }, anchorOk })
    ).toEqual({ linked: false, reason: "no such paragraph" });
    expect(
      placePushLink({ source: plain, target, suggestion: { mode: "sentence", paragraph: 1, sentence: "See <b>abandoned cart email subject lines</b>.", anchor: QUERY }, anchorOk })
    ).toMatchObject({ linked: false, reason: "the sentence holds markup" });
  });
});

describe("the paragraphs offered", () => {
  it("leaves out the short version and everything from Read next", () => {
    expect(linkableParagraphs(BODY).map((p) => p.text)).toEqual([
      "Shoppers leave for many reasons.",
      "The first email matters most, and good abandoned cart email subject lines get it opened.",
    ]);
  });

  it("an added sentence is one plain sentence with the anchor once", () => {
    expect(checkAddedSentence("One. Two words here about x growth tools.", "x growth tools")).toMatchObject({ ok: false, reason: "more than one sentence" });
    expect(checkAddedSentence("See https://a.test for x growth tools.", "x growth tools")).toMatchObject({ ok: false });
    expect(checkAddedSentence("x growth tools and x growth tools.", "x growth tools")).toMatchObject({ ok: false });
    expect(checkAddedSentence("Compare the x growth tools that fit.", "x growth tools")).toEqual({ ok: true, sentence: "Compare the x growth tools that fit." });
  });
});
