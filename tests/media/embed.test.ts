import { describe, expect, it } from "vitest";
import { parse } from "node-html-parser";
import { appendVideoParagraphs, embedInlineImages, renderFigure } from "@/lib/media/embed";
import { CanonicalImage, CanonicalVideo } from "@/lib/content/types";

const BODY =
  '<p>Intro paragraph.</p>' +
  '<h2 id="one">Section one</h2><p>Alpha.</p><p>Beta.</p>' +
  '<h2 id="two">Section two</h2><p>Gamma.</p>';

const image = (overrides: Partial<CanonicalImage> = {}): CanonicalImage => ({
  url: "https://storage.example.com/a/inline-0.png",
  alt: "A warehouse conveyor sorting parcels",
  caption: null,
  slot: "one",
  ...overrides,
});

const video = (overrides: Partial<CanonicalVideo> = {}): CanonicalVideo => ({
  provider: "youtube",
  videoId: "abc123",
  url: "https://www.youtube.com/watch?v=abc123",
  embedUrl: "https://www.youtube-nocookie.com/embed/abc123",
  title: "How sorting works",
  thumbnailUrl: "https://i.ytimg.com/vi/abc123/hqdefault.jpg",
  slot: "one",
  ...overrides,
});

describe("embedInlineImages", () => {
  it("places the figure at the END of its section, before the next heading", () => {
    const html = embedInlineImages(BODY, [image()]);
    const figureAt = html.indexOf("<figure>");
    expect(figureAt).toBeGreaterThan(html.indexOf("Beta."));
    expect(figureAt).toBeLessThan(html.indexOf('<h2 id="two"'));
  });

  it("appends at the document end for the last section", () => {
    const html = embedInlineImages(BODY, [image({ slot: "two" })]);
    expect(html.indexOf("<figure>")).toBeGreaterThan(html.indexOf("Gamma."));
  });

  it("never displaces the first paragraph (the excerpt source)", () => {
    const html = embedInlineImages(BODY, [image()]);
    const firstParagraph = parse(html).querySelector("p");
    expect(firstParagraph?.text).toBe("Intro paragraph.");
  });

  it("leaves headings untouched", () => {
    const html = embedInlineImages(BODY, [image(), image({ slot: "two", url: "https://x/2.png" })]);
    const headings = parse(html)
      .querySelectorAll("h2")
      .map((h) => h.getAttribute("id"));
    expect(headings).toEqual(["one", "two"]);
  });

  it("is idempotent: re-embedding the same image adds nothing", () => {
    const once = embedInlineImages(BODY, [image()]);
    const twice = embedInlineImages(once, [image()]);
    expect(twice).toBe(once);
  });

  it("skips images whose slot no longer exists", () => {
    const html = embedInlineImages(BODY, [image({ slot: "vanished" })]);
    expect(html).toBe(BODY);
  });

  it("escapes attribute values", () => {
    const html = renderFigure(image({ alt: 'He said "go" & <left>' }));
    expect(html).toContain("&quot;go&quot; &amp; &lt;left&gt;");
    expect(html).not.toContain('"go" & <left>');
  });

  it("renders the caption only when present", () => {
    expect(renderFigure(image())).not.toContain("figcaption");
    expect(renderFigure(image({ caption: "The sorter" }))).toContain(
      "<figcaption>The sorter</figcaption>"
    );
  });
});

describe("appendVideoParagraphs", () => {
  it("adds a bare watch-URL paragraph at the end of the slot section", () => {
    const html = appendVideoParagraphs(BODY, [video()]);
    const urlAt = html.indexOf("https://www.youtube.com/watch?v=abc123");
    expect(urlAt).toBeGreaterThan(html.indexOf("Beta."));
    expect(urlAt).toBeLessThan(html.indexOf('<h2 id="two"'));
    expect(html).not.toContain("<iframe");
  });

  it("is idempotent", () => {
    const once = appendVideoParagraphs(BODY, [video()]);
    const twice = appendVideoParagraphs(once, [video()]);
    expect(twice).toBe(once);
  });

  it("falls back to the document end when the slot is missing", () => {
    const html = appendVideoParagraphs(BODY, [video({ slot: "vanished" })]);
    expect(html.endsWith("<p>https://www.youtube.com/watch?v=abc123</p>")).toBe(true);
  });
});
