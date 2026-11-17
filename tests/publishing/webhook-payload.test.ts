import { describe, expect, it } from "vitest";
import {
  WEBHOOK_PAYLOAD_SCHEMA_VERSION,
  buildWebhookPayload,
  deliveryBody,
  signPayload,
} from "@/lib/publishing/adapters/webhook";
import { CANONICAL_SCHEMA_VERSION, CanonicalArticle } from "@/lib/content/types";

/**
 * Contract test for the receiver-facing payload.
 *
 * Live receivers (Postwren and every customer site following
 * docs/NEXTJS_WEBHOOK_RECEIVER.md) depend on these exact keys. Changing them is
 * a breaking change: this test must fail loudly if one moves.
 */

const article: CanonicalArticle = {
  schemaVersion: CANONICAL_SCHEMA_VERSION,
  articleId: "8f14e45f-0000-1111-2222-333344445555",
  title: "How to Boost Conversions",
  bodyHtml: '<p>Intro.</p><h2 id="first-section">First section</h2><p>More.</p>',
  headings: [{ level: 2, id: "first-section", text: "First section" }],
  excerpt: "Intro.",
  metaDescription: "Intro.",
  wordCount: 900,
  slug: "how-to-boost-conversions",
  keyword: "boost conversions",
  language: "en",
  scheduledDate: "2026-08-02",
};

describe("webhook payload contract", () => {
  const payload = buildWebhookPayload(article);

  it("exposes exactly the documented keys", () => {
    expect(Object.keys(payload).sort()).toEqual(
      [
        "article_id",
        "body_html",
        "dataset",
        "date_modified",
        "event",
        "faq",
        "excerpt",
        "headings",
        "html",
        "keyword",
        "media",
        "scheduled_date",
        "schema_version",
        "seo",
        "slug",
        "title",
      ].sort()
    );
  });

  it("keeps the frozen v1 fields", () => {
    expect(payload.event).toBe("article.publish");
    expect(payload.title).toBe("How to Boost Conversions");
    expect(payload.slug).toBe("how-to-boost-conversions");
    expect(payload.keyword).toBe("boost conversions");
    expect(payload.scheduled_date).toBe("2026-08-02");
  });

  it("sends html WITH the h1 and body_html WITHOUT it", () => {
    expect(payload.html).toContain("<h1>How to Boost Conversions</h1>");
    expect(payload.body_html).not.toContain("<h1");
    expect(payload.body_html).toBe(article.bodyHtml);
  });

  it("carries an empty media object when the article has none", () => {
    expect(payload.media).toEqual({ hero: null, images: [], videos: [] });
  });

  it("maps media into snake_case receiver fields (v3)", () => {
    expect(WEBHOOK_PAYLOAD_SCHEMA_VERSION).toBe(7);
    const withMedia = buildWebhookPayload({
      ...article,
      media: {
        hero: { url: "https://storage/x/hero.png", alt: "Hero alt", caption: null, slot: null },
        images: [
          {
            url: "https://storage/x/inline-0.png",
            alt: "Inline alt",
            caption: "Cap",
            slot: "first-section",
          },
        ],
        videos: [
          {
            provider: "youtube",
            videoId: "abc123",
            url: "https://www.youtube.com/watch?v=abc123",
            embedUrl: "https://www.youtube-nocookie.com/embed/abc123",
            title: "Demo",
            thumbnailUrl: "https://i.ytimg.com/vi/abc123/hqdefault.jpg",
            slot: "first-section",
          },
        ],
      },
    });
    expect(withMedia.media).toEqual({
      hero: {
        url: "https://storage/x/hero.png",
        alt: "Hero alt",
        caption: null,
        embedded: true,
      },
      images: [
        {
          url: "https://storage/x/inline-0.png",
          alt: "Inline alt",
          caption: "Cap",
          slot: "first-section",
        },
      ],
      videos: [
        {
          provider: "youtube",
          video_id: "abc123",
          url: "https://www.youtube.com/watch?v=abc123",
          embed_url: "https://www.youtube-nocookie.com/embed/abc123",
          title: "Demo",
          thumbnail_url: "https://i.ytimg.com/vi/abc123/hqdefault.jpg",
          slot: "first-section",
        },
      ],
    });
  });

  it("carries the v2 structured fields", () => {
    expect(payload.schema_version).toBe(WEBHOOK_PAYLOAD_SCHEMA_VERSION);
    expect(payload.article_id).toBe(article.articleId);
    expect(payload.excerpt).toBe("Intro.");
    expect(payload.seo).toEqual({
      meta_title: "How to Boost Conversions",
      meta_description: "Intro.",
    });
    expect(payload.headings).toEqual([
      { level: 2, id: "first-section", text: "First section" },
    ]);
  });

  it("escapes the title when embedding it in html", () => {
    const risky = buildWebhookPayload({ ...article, title: 'A & B <script>' });
    expect(risky.html).toContain("A &amp; B &lt;script&gt;");
    // The plain-text field stays unescaped for the receiver to render itself.
    expect(risky.title).toBe("A & B <script>");
  });

  const withHero: CanonicalArticle = {
    ...article,
    media: {
      hero: { url: "https://storage/x/hero.png", alt: "Hero alt", caption: null, slot: null },
      images: [],
      videos: [],
    },
  };

  describe("hero in the body", () => {
    it("puts the hero under the h1 in html and first in body_html", () => {
      const payload = buildWebhookPayload(withHero);
      const html = payload.html as string;
      // Order is the contract: a receiver treating html as one blob must still
      // find the title before anything else.
      expect(html.indexOf("<h1>")).toBeLessThan(html.indexOf("<figure"));
      expect(html.indexOf("<figure")).toBeLessThan(html.indexOf("<p>Intro."));
      expect(payload.body_html).toBe(
        `<figure class="gtf-hero"><img src="https://storage/x/hero.png" alt="Hero alt" loading="eager" fetchpriority="high" /></figure>${article.bodyHtml}`
      );
    });

    it("still sends media.hero, flagged so nobody renders it twice", () => {
      const payload = buildWebhookPayload(withHero);
      expect(payload.media).toMatchObject({
        hero: { url: "https://storage/x/hero.png", embedded: true },
      });
    });

    it("does nothing when the article has no hero to embed", () => {
      const payload = buildWebhookPayload(article);
      expect(payload.body_html).toBe(article.bodyHtml);
      expect((payload.media as { hero: unknown }).hero).toBeNull();
    });
  });

  it("signs the exact bytes that are sent", () => {
    const body = JSON.stringify(payload);
    expect(signPayload("shhh", body)).toBe(signPayload("shhh", body));
    expect(signPayload("shhh", body)).toHaveLength(64);
    expect(signPayload("shhh", body)).not.toBe(signPayload("other", body));
  });

  it("v7: every request carries its own delivery_id, the payload unchanged around it", () => {
    const first = JSON.parse(deliveryBody(payload));
    const second = JSON.parse(deliveryBody(payload));
    expect(first.delivery_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(second.delivery_id).not.toBe(first.delivery_id);
    const { delivery_id: _id, ...rest } = first;
    void _id;
    expect(rest).toEqual(JSON.parse(JSON.stringify(payload)));
    expect(payload).not.toHaveProperty("delivery_id");
  });

  describe("v5: meta title, FAQ and date_modified", () => {
    const faqBody =
      '<p>Intro.</p><h2 id="first-section">First section</h2><p>More.</p>' +
      '<h2 id="faq">FAQ</h2><h3 id="q1">Does it work on <em>Shopify</em>?</h3><p>Yes.</p><p>Since 2025.</p>' +
      '<h3 id="q2">Is there a free plan?</h3><ul><li>No.</li><li>There is a trial.</li></ul>';

    it("adds only keys: every earlier field keeps its value", () => {
      const v5 = buildWebhookPayload(article);
      expect(v5.schema_version).toBe(7);
      expect(v5.faq).toEqual([]);
      expect(v5.date_modified).toBeNull();
      // A document with no meta title of its own still sends the headline, as v2 always did.
      expect(v5.seo).toEqual({ meta_title: "How to Boost Conversions", meta_description: "Intro." });
    });

    it("sends the document's meta title when it has one, nested or flat", () => {
      const nested = buildWebhookPayload({ ...article, seo: { metaTitle: "Boost Conversions: 7 Fixes", metaDescription: "Seven fixes." } } as CanonicalArticle);
      expect(nested.seo).toEqual({ meta_title: "Boost Conversions: 7 Fixes", meta_description: "Seven fixes." });
      const flat = buildWebhookPayload({ ...article, metaTitle: "Boost Conversions Fast" } as CanonicalArticle);
      expect(flat.seo).toEqual({ meta_title: "Boost Conversions Fast", meta_description: "Intro." });
    });

    it("sends the FAQ as plain question and answer pairs, read from the body", () => {
      expect(buildWebhookPayload({ ...article, bodyHtml: faqBody }).faq).toEqual([
        { question: "Does it work on Shopify?", answer: "Yes. Since 2025." },
        { question: "Is there a free plan?", answer: "No. There is a trial." },
      ]);
    });

    it("sends date_modified only when the document records a change", () => {
      const changed = buildWebhookPayload({ ...article, dateModified: "2026-09-01T10:00:00.000Z" } as CanonicalArticle);
      expect(changed.date_modified).toBe("2026-09-01T10:00:00.000Z");
      expect(buildWebhookPayload({ ...article, dateModified: "yesterday" } as CanonicalArticle).date_modified).toBeNull();
    });
  });

  describe("v6: the article's own data as a Dataset (2026-11-15)", () => {
    const dataBody =
      '<p>Intro.</p><h2 id="what-is-it">What is it?</h2><p>More.</p>' +
      '<h2 id="from-our-data">From our data</h2><p>In my own Search Console, between September and November 2026, 1,200 article pages earned 48,000 impressions.</p>' +
      '<h2 id="faq">FAQ</h2><h3 id="q1">Is it free?</h3><p>No.</p>';

    it("is null for an article with no data section, which is most of them", () => {
      expect(buildWebhookPayload(article).dataset).toBeNull();
    });

    it("names the section, with the period it states, when the article has one", () => {
      expect(buildWebhookPayload({ ...article, bodyHtml: dataBody }).dataset).toEqual({
        name: "How to Boost Conversions: From our data",
        description:
          "In my own Search Console, between September and November 2026, 1,200 article pages earned 48,000 impressions.",
        temporal_coverage: "2026-09/2026-11",
        heading_id: "from-our-data",
      });
    });

    it("carries the Read next block in both bodies, like any other part of the document", () => {
      const withBlock = buildWebhookPayload({
        ...article,
        bodyHtml: `${article.bodyHtml}\n<h2 id="read-next">Read next</h2>\n<ul><li><a href="https://example.com/blog/a">A</a></li></ul>`,
      });
      expect(withBlock.body_html).toContain('<h2 id="read-next">Read next</h2>');
      expect(withBlock.html).toContain('<a href="https://example.com/blog/a">A</a>');
    });
  });
});
