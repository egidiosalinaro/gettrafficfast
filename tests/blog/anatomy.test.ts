import { describe, expect, it } from "vitest";
import { decorateArticleBody } from "@/lib/blog/anatomy";

/**
 * How the blog shows the anatomy: the short version marked for its box, the
 * Read next block inside a <nav>, no word changed, and a body without
 * either part returned as it was.
 */

describe("the blog's article body", () => {
  const body =
    '<figure class="gtf-hero"><img src="https://cdn/hero.png" alt="Hero"></figure>' +
    "<p><strong>The short version:</strong> Feed it daily.</p><p>Intro.</p>" +
    '<h2 id="why">Why?</h2><p>Because.</p>' +
    '<h2 id="read-next">Read next</h2><ul><li><a href="https://gettrafficfa.st/blog/a">A</a></li></ul>';

  it("marks the short version and puts Read next in a nav", () => {
    expect(decorateArticleBody(body)).toBe(
      '<figure class="gtf-hero"><img src="https://cdn/hero.png" alt="Hero"></figure>' +
        '<p class="gtf-short-version"><strong>The short version:</strong> Feed it daily.</p><p>Intro.</p>' +
        '<h2 id="why">Why?</h2><p>Because.</p>' +
        '<nav class="gtf-read-next" aria-labelledby="read-next"><h2 id="read-next">Read next</h2><ul><li><a href="https://gettrafficfa.st/blog/a">A</a></li></ul></nav>'
    );
  });

  it("returns a body without either part as it was", () => {
    const plain = '<p>Intro with <strong>bold</strong>.</p><h2 id="why">Why?</h2><p>Because.</p>';
    expect(decorateArticleBody(plain)).toBe(plain);
  });
});
