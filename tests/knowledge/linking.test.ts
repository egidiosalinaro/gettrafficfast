import { describe, expect, it } from "vitest";
import { applyInternalLinks, linkableBodyText } from "@/lib/knowledge/linking";

/**
 * The linking module is the only code allowed to touch an article for a link,
 * and its contract is defensive: a link is applied only when the anchor exists
 * verbatim, exactly once, inside a single linkable text node. Everything else
 * is dropped with a reason — never a corrupted document.
 */

const HREF = "https://blog.example.com/codici-sconto-unici";

const BODY = [
  `<h2 id="come-funzionano">Come funzionano i codici unici</h2>`,
  `<p>I codici sconto monouso proteggono il margine del negozio.</p>`,
  `<p>Conviene impostare la generazione automatica dei codici prima del lancio.</p>`,
].join("");

describe("applyInternalLinks", () => {
  it("wraps a verbatim anchor in a link and leaves the rest untouched", () => {
    const result = applyInternalLinks(BODY, [
      { targetArticleId: "t1", anchor: "generazione automatica dei codici", href: HREF },
    ]);

    expect(result.applied).toHaveLength(1);
    expect(result.skipped).toHaveLength(0);
    expect(result.bodyHtml).toContain(
      `<a href="${HREF}">generazione automatica dei codici</a>`
    );
    // Nothing else moved: removing the inserted tags restores the original.
    expect(
      result.bodyHtml.replace(`<a href="${HREF}">`, "").replace("</a>", "")
    ).toBe(BODY);
  });

  it("drops an anchor that does not exist verbatim", () => {
    const result = applyInternalLinks(BODY, [
      { targetArticleId: "t1", anchor: "frase inventata dal modello", href: HREF },
    ]);
    expect(result.applied).toHaveLength(0);
    expect(result.skipped[0].reason).toContain("not found");
    expect(result.bodyHtml).toBe(BODY);
  });

  it("drops an ambiguous anchor instead of guessing", () => {
    const body = `<p>il margine conta</p><p>il margine conta davvero</p>`;
    const result = applyInternalLinks(body, [
      { targetArticleId: "t1", anchor: "il margine conta", href: HREF },
    ]);
    expect(result.applied).toHaveLength(0);
    expect(result.skipped[0].reason).toContain("ambiguous");
  });

  it("never links inside headings, existing links, code or figures", () => {
    const body = [
      `<h2 id="x">frase solo nel titolo</h2>`,
      `<p><a href="https://a.example">frase già linkata</a></p>`,
      `<pre><code>frase nel codice</code></pre>`,
    ].join("");
    for (const anchor of ["frase solo nel titolo", "frase già linkata", "frase nel codice"]) {
      const result = applyInternalLinks(body, [{ targetArticleId: "t", anchor, href: HREF }]);
      expect(result.applied).toHaveLength(0);
    }
  });

  it("does not match an anchor that spans element boundaries", () => {
    const body = `<p>usa <strong>codici</strong> unici sempre</p>`;
    const result = applyInternalLinks(body, [
      { targetArticleId: "t1", anchor: "usa codici unici", href: HREF },
    ]);
    expect(result.applied).toHaveLength(0);
    expect(result.skipped[0].reason).toContain("not found");
  });

  it("is idempotent: a target already linked in the document is skipped", () => {
    const once = applyInternalLinks(BODY, [
      { targetArticleId: "t1", anchor: "generazione automatica dei codici", href: HREF },
    ]);
    const twice = applyInternalLinks(once.bodyHtml, [
      { targetArticleId: "t1", anchor: "codici sconto monouso", href: HREF },
    ]);
    expect(twice.applied).toHaveLength(0);
    expect(twice.skipped[0].reason).toContain("already linked");
    expect(twice.bodyHtml).toBe(once.bodyHtml);
  });

  it("applies several placements in one pass", () => {
    const result = applyInternalLinks(BODY, [
      { targetArticleId: "t1", anchor: "codici sconto monouso", href: HREF },
      {
        targetArticleId: "t2",
        anchor: "generazione automatica dei codici",
        href: "https://blog.example.com/generazione",
      },
    ]);
    expect(result.applied).toHaveLength(2);
    expect(result.bodyHtml).toContain(`<a href="${HREF}">codici sconto monouso</a>`);
    expect(result.bodyHtml).toContain(
      `<a href="https://blog.example.com/generazione">generazione automatica dei codici</a>`
    );
  });

  it("escapes the href attribute", () => {
    const result = applyInternalLinks(BODY, [
      {
        targetArticleId: "t1",
        anchor: "codici sconto monouso",
        href: `https://a.example/?q="x"&y=1`,
      },
    ]);
    expect(result.applied).toHaveLength(1);
    expect(result.bodyHtml).toContain(`href="https://a.example/?q=&quot;x&quot;&amp;y=1"`);
  });
});

describe("linkableBodyText", () => {
  it("strips tags to spaces and collapses whitespace", () => {
    expect(linkableBodyText(`<p>uno</p>\n<p>due  tre</p>`)).toBe("uno due tre");
  });
});
