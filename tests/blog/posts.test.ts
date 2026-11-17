import { describe, expect, it } from "vitest";
import { toPost } from "@/lib/blog/posts";
import { sanitizeBlogHtml, slugFrom, toBlogPostRow, verifySignature, withoutSeoColumns } from "@/lib/blog/receive";
import { createHmac } from "crypto";

/**
 * The blog's two boundaries: what a webhook delivery is allowed to become, and
 * what a stored row renders as.
 *
 * The signature test is the one that matters most. A receiver whose check is
 * subtly wrong looks identical in the happy path and accepts anything from
 * anyone in the unhappy one, which on a public blog means a stranger can
 * publish on the domain.
 */

const SECRET = "shared-secret";
const sign = (body: string) => createHmac("sha256", SECRET).update(body, "utf8").digest("hex");

const payload = {
  event: "article.publish" as const,
  title: "How answer engines pick sources",
  slug: "how-answer-engines-pick-sources",
  html: "<h1>How answer engines pick sources</h1><p>Body.</p>",
  body_html: "<p>Body.</p>",
  keyword: "answer engines",
  scheduled_date: "2026-09-10",
  schema_version: 4,
  article_id: "article-123",
  excerpt: "A short excerpt.",
  seo: { meta_title: "…", meta_description: "A meta description." },
  media: {
    hero: { url: "https://cdn/hero.png", alt: "Hero", caption: null, embedded: false },
    images: [],
    videos: [],
  },
};

describe("verifySignature", () => {
  it("accepts a signature over the exact raw body", () => {
    const body = JSON.stringify(payload);
    expect(verifySignature(body, sign(body), SECRET)).toBe(true);
  });

  it("rejects a body that changed after signing", () => {
    const body = JSON.stringify(payload);
    expect(verifySignature(body + " ", sign(body), SECRET)).toBe(false);
  });

  it("rejects a signature made with another secret", () => {
    const body = JSON.stringify(payload);
    const other = createHmac("sha256", "not-the-secret").update(body).digest("hex");
    expect(verifySignature(body, other, SECRET)).toBe(false);
  });

  it("rejects everything when no secret is configured", () => {
    const body = JSON.stringify(payload);
    expect(verifySignature(body, sign(body), undefined)).toBe(false);
    expect(verifySignature(body, sign(body), "")).toBe(false);
  });

  it("rejects an empty or malformed signature instead of throwing", () => {
    const body = JSON.stringify(payload);
    expect(verifySignature(body, "", SECRET)).toBe(false);
    expect(verifySignature(body, "zzzz", SECRET)).toBe(false);
  });
});

describe("toBlogPostRow", () => {
  it("maps a delivery to a stored post", () => {
    expect(toBlogPostRow(payload)).toEqual({
      gtf_article_id: "article-123",
      slug: "how-answer-engines-pick-sources",
      title: "How answer engines pick sources",
      body_html: "<p>Body.</p>",
      excerpt: "A short excerpt.",
      meta_description: "A meta description.",
      hero: { url: "https://cdn/hero.png", alt: "Hero", caption: null, embedded: false },
      videos: [],
      keyword: "answer engines",
      published_on: "2026-09-10",
      meta_title: "…",
      // A sender older than payload v5 says nothing about the FAQ or a change.
      faq: null,
      modified_at: null,
    });
  });

  it("stores what payload v5 adds: the meta title, the FAQ pairs and when the article changed", () => {
    const row = toBlogPostRow({
      ...payload,
      schema_version: 5,
      seo: { meta_title: "How Answer Engines Pick Sources (2026)", meta_description: "A meta description." },
      faq: [
        { question: " Do answer engines cite blogs? ", answer: "Yes,\n when the page answers the question." },
        { question: "", answer: "An answer with no question." },
        { question: "A question with no answer?" },
        "not a pair" as never,
      ],
      date_modified: "2026-10-02T08:00:00+02:00",
    });
    expect(row).toMatchObject({
      meta_title: "How Answer Engines Pick Sources (2026)",
      faq: [{ question: "Do answer engines cite blogs?", answer: "Yes, when the page answers the question." }],
      modified_at: "2026-10-02T06:00:00.000Z",
    });
  });

  it("does not store the headline as a meta title, an article with no FAQ as unknown, or a date that is not one", () => {
    const row = toBlogPostRow({ ...payload, seo: { meta_title: payload.title }, faq: [], date_modified: "soon" });
    expect(row).toMatchObject({ meta_title: null, faq: [], modified_at: null });
  });

  it("can be stored without the v5 columns, for a database that does not have them yet", () => {
    const row = toBlogPostRow(payload);
    if (!row) throw new Error("expected a row");
    const legacy = withoutSeoColumns(row);
    expect(Object.keys(legacy).sort()).toEqual(
      ["body_html", "excerpt", "gtf_article_id", "hero", "keyword", "meta_description", "published_on", "slug", "title", "videos"].sort()
    );
  });

  it("prefers body_html, so the title is never rendered twice", () => {
    expect(toBlogPostRow(payload)?.body_html).not.toContain("<h1>");
  });

  it("falls back to html when the sender has no body_html", () => {
    const row = toBlogPostRow({ ...payload, body_html: null });
    expect(row?.body_html).toContain("<h1>");
  });

  it("derives a slug and an id when the sender provides neither", () => {
    const row = toBlogPostRow({ ...payload, slug: null, article_id: null });
    expect(row?.slug).toBe("how-answer-engines-pick-sources");
    expect(row?.gtf_article_id).toBe("how-answer-engines-pick-sources");
  });

  it("refuses a payload with no title or no body", () => {
    expect(toBlogPostRow({ ...payload, title: "" })).toBeNull();
    expect(toBlogPostRow({ ...payload, html: "", body_html: "" })).toBeNull();
  });
});

describe("slugFrom", () => {
  it("makes a url-safe slug without leading or trailing dashes", () => {
    expect(slugFrom("  What's next, in 2026?  ")).toBe("what-s-next-in-2026");
  });
});

describe("toPost", () => {
  const row = {
    slug: "a-post",
    title: "A post",
    body_html: "<p>Body.</p>",
    excerpt: "Excerpt.",
    meta_description: "Meta.",
    hero: { url: "https://cdn/hero.png", alt: "Hero", caption: null, embedded: false },
    published_on: "2026-09-10",
    updated_at: "2026-09-12T08:30:00.000Z",
  };

  it("renders the stored row, dated by its publish day", () => {
    expect(toPost(row)).toEqual({
      slug: "a-post",
      title: "A post",
      excerpt: "Excerpt.",
      metaDescription: "Meta.",
      bodyHtml: "<p>Body.</p>",
      hero: { url: "https://cdn/hero.png", alt: "Hero", caption: null, embedded: false },
      date: "2026-09-10",
      metaTitle: null,
      faq: [],
      modified: null,
      dataset: null,
    });
  });

  it("reads the article's own data from its body, for the Dataset; none without the section (2026-11-15)", () => {
    const body =
      '<p>Intro.</p><h2 id="dai-nostri-dati">Dai nostri dati</h2><p>Tra settembre e novembre 2026 abbiamo misurato 1.200 pagine e 48.000 impression nel nostro Search Console.</p>';
    expect(toPost({ ...row, body_html: body }).dataset).toEqual({
      name: "A post: Dai nostri dati",
      description: "Tra settembre e novembre 2026 abbiamo misurato 1.200 pagine e 48.000 impression nel nostro Search Console.",
      temporalCoverage: "2026",
      headingId: "dai-nostri-dati",
    });
    expect(toPost(row).dataset).toBeNull();
  });

  it("reads the meta title, the delivery's FAQ and the day it changed from the v5 columns", () => {
    const post = toPost({
      ...row,
      meta_title: "A post, shorter",
      faq: [{ question: "Why?", answer: "Because." }],
      modified_at: "2026-10-02T06:00:00.000Z",
    });
    expect(post).toMatchObject({ metaTitle: "A post, shorter", faq: [{ question: "Why?", answer: "Because." }], modified: "2026-10-02" });
  });

  it("reads the FAQ from the stored body when the row predates payload v5, and trusts an empty delivered FAQ", () => {
    const body = '<p>Intro.</p><h2 id="faq">FAQ</h2><h3 id="q1">Is it free?</h3><p>No.</p>';
    expect(toPost({ ...row, body_html: body }).faq).toEqual([{ question: "Is it free?", answer: "No." }]);
    expect(toPost({ ...row, body_html: body, faq: null }).faq).toEqual([{ question: "Is it free?", answer: "No." }]);
    expect(toPost({ ...row, body_html: body, faq: [] }).faq).toEqual([]);
  });

  it("says updated only for a change after the publish day, and never from the delivery time", () => {
    // updated_at moves on every delivery, a retry included: it is not a change.
    expect(toPost(row).modified).toBeNull();
    expect(toPost({ ...row, modified_at: "2026-09-10T23:00:00.000Z" }).modified).toBeNull();
    expect(toPost({ ...row, modified_at: "2026-09-01T00:00:00.000Z" }).modified).toBeNull();
    expect(toPost({ ...row, modified_at: "not a date" }).modified).toBeNull();
    expect(toPost({ ...row, modified_at: "2026-09-11T00:00:00.000Z" }).modified).toBe("2026-09-11");
  });

  it("falls back to the update timestamp, trimmed to the day", () => {
    expect(toPost({ ...row, published_on: null }).date).toBe("2026-09-12");
  });

  it("drops a hero with no url rather than rendering a broken image", () => {
    expect(toPost({ ...row, hero: { alt: "no url" } }).hero).toBeNull();
    expect(toPost({ ...row, hero: null }).hero).toBeNull();
  });
});

describe("blog body sanitising", () => {
  it("strips <script> with its content, and every on* handler", () => {
    const html = sanitizeBlogHtml(
      '<p onclick="steal()">Hi</p><script>alert(document.cookie)</script><img src="x.png" alt="x" onerror="steal()">'
    );
    expect(html).not.toMatch(/<script|alert\(|onclick|onerror|steal/i);
    expect(html).toContain("<p>Hi</p>");
    expect(html).toContain('src="x.png"');
  });

  it("drops iframes, styles and javascript: links, however the scheme is spelled", () => {
    const html = sanitizeBlogHtml(
      '<iframe src="https://evil.example"></iframe><style>body{}</style>' +
        '<a href="javascript:alert(1)">a</a><a href="java\tscript:alert(1)">b</a><a href=" JAVASCRIPT:x">c</a>'
    );
    expect(html).not.toMatch(/iframe|<style|javascript|java\s*script/i);
    expect(html).toContain(">a</a>");
  });

  it("keeps the markup the delivery itself writes: the hero figure and its priority", () => {
    const hero =
      '<figure class="gtf-hero"><img src="https://cdn.example/h.png" alt="Hero" loading="eager" fetchpriority="high" /><figcaption>Cap</figcaption></figure><h2 id="intro">Intro</h2>';
    const html = sanitizeBlogHtml(hero);
    expect(html).toContain('class="gtf-hero"');
    expect(html).toContain('fetchpriority="high"');
    expect(html).toContain('<h2 id="intro">');
  });

  it("is applied on receive, before the row is stored", () => {
    const row = toBlogPostRow({ ...payload, body_html: '<p>Ok</p><script>x()</script><b onmouseover="x()">b</b>' });
    expect(row?.body_html).toBe("<p>Ok</p><b>b</b>");
  });

  it("refuses a body that is nothing but unsafe markup", () => {
    expect(toBlogPostRow({ ...payload, body_html: "<script>x()</script>", html: "" })).toBeNull();
  });

  it("is applied again on read, for rows stored before the receiver checked", () => {
    const stored = {
      slug: "old",
      title: "Old",
      body_html: "<p>Old</p><script>x()</script>",
      excerpt: null,
      meta_description: null,
      hero: null,
      published_on: null,
      updated_at: null,
    };
    expect(toPost(stored).bodyHtml).toBe("<p>Old</p>");
  });
});
