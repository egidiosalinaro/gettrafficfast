# Webhook receiver for Next.js sites (customer side)

The Webhooks integration (`docs/INTEGRATIONS.md`) is already fully implemented
on the GetTrafficFast side. What each customer with a custom Next.js site needs
is a **receiving endpoint**. This is a complete, copy-paste App Router example.

It is also running: gettrafficfa.st is a Next.js site and takes its own
articles this way, at `app/api/gettrafficfast/route.ts` in this repository
(`docs/BLOG.md`). If this document drifts from what a receiver needs, the
product's own blog stops updating before any customer notices.

## 0. Payload (content schema v2)

Every publish sends the legacy fields (unchanged since v1) **plus** structured
fields. New receivers should use the structured ones:

```jsonc
{
  // v1 — legacy, never changes
  "event": "article.publish",        // or "test"
  "title": "Article title",
  "slug": "article-slug",
  "html": "<h1>...</h1>...",         // full HTML including the <h1>
  "keyword": "target keyword",
  "scheduled_date": "2026-07-20",

  // v2 — structured, additive
  "schema_version": 7,
  "article_id": "8f14e45f-...",      // stable per article, across republishes
  "body_html": "<p>...</p><h2 id=\"first-section\">...</h2>...", // no <h1>
  "excerpt": "First paragraph, plain text…",
  "seo": { "meta_title": "...", "meta_description": "..." }, // see v5 below
  "headings": [{ "level": 2, "id": "first-section", "text": "..." }],

  // v3 — additive: media enrichment (absent pieces are null / empty arrays)
  // v4 — additive: hero.embedded
  "media": {
    "hero":   { "url": "https://…", "alt": "…", "caption": null, "embedded": true },
    "images": [{ "url": "https://…", "alt": "…", "caption": "…", "slot": "first-section" }],
    "videos": [{ "provider": "youtube", "video_id": "…", "url": "https://youtube.com/watch?v=…",
                 "embed_url": "https://www.youtube-nocookie.com/embed/…", "title": "…",
                 "thumbnail_url": "https://…", "slot": "first-section" }]
  },

  // v5 — additive: what you need to render structured data (section 5)
  "faq": [{ "question": "Is there a free plan?", "answer": "No. There is a trial." }],
  "date_modified": "2026-10-02T06:00:00.000Z",  // or null

  // v6 — additive: the article's own data, as a schema.org Dataset (section 5)
  "dataset": {                                   // or null: most articles have none
    "name": "Article title: From our data",
    "description": "Between September and November 2026 we tested 400 prompts…",
    "temporal_coverage": "2026-09/2026-11",      // or null when no period is named
    "heading_id": "from-our-data"
  },

  // v7 — additive: unique per request (the test included); a retry is a new
  // request with a new id. Pair it with the timestamped signature (section 1).
  "delivery_id": "0b6f3c1e-4a8e-4c9b-9f61-2d7f0e5a1c33"
}
```

Key points:

- **Render `title` yourself** (as the page's `<h1>`) and use **`body_html`** as
  the article body — it intentionally contains no `<h1>`, so the title is never
  duplicated, and its `h2`/`h3` carry `id` anchors (usable for a TOC via
  `headings`).
- **Upsert by `article_id`.** GetTrafficFast can republish an article to update
  it; the same `article_id` must update the existing post, never duplicate it.
  Fall back to `slug` only when `article_id` is absent (legacy senders).
- `html` (with the `<h1>`) is kept for backward compatibility and never changes.
- **Media (v3)**: inline `images` are ALSO already embedded in `body_html` as
  `<figure>` elements — render `body_html` and you get them for free. The
  **hero is the first `<figure class="gtf-hero">` in `body_html`** when one
  exists. `media.hero` is still sent so you can use the URL for the OG image
  and the card thumbnail. `videos` are never embedded — embed
  `media.videos[].embed_url` in an iframe at the section with the matching
  `slot` id, or link to `url`. Image URLs are stable (GetTrafficFast's own
  storage), safe to hotlink or mirror.

- **`media.hero.embedded` (v4)** is `true` whenever the hero figure is in the
  body, which is always when a hero exists. If your page also renders
  `media.hero` as a header image, skip that render when `embedded` is true or
  the same picture appears twice. Keep using the URL for metadata either way.

- **v5** adds two fields and gives one its meaning. `faq` is the article's
  FAQ as plain-text question and answer pairs, read from the article's
  structure (`[]` when it has no FAQ section). `date_modified` is when the
  published article last changed (a refresh rewrote it, or a link to a newer
  article was added); it is `null` on a first delivery and on a retry of
  one, so do not read "now" into a missing value. `seo.meta_title` now
  carries the article's own title for search when it has one; it used to be
  the headline, and still is when the article has none. Nothing was removed
  or renamed: a receiver written for v2, v3 or v4 keeps working untouched.
  Republishes of an article that changed arrive with the same `article_id`.

- **v6** adds `dataset`: when the article has a "From our data" section
  (the site owner's own measurements, which GetTrafficFast writes only when
  the owner's Facts for articles hold a figure that may be published), its
  name, its text as the description, the period it names as an ISO 8601
  interval (`null` when it names none) and the section's heading id. `null`
  for every other article. Mark it up as a `Dataset` (section 5) or ignore
  it; the section itself is already in `body_html`.

- **v7** adds `delivery_id`, a UUID unique to each request. It is inside
  the signed body, so it cannot be swapped; remember the ones you have seen
  for ten minutes and refuse a repeat (section 1). It is not the article's
  identity: upsert by `article_id` as before.

- **The article's anatomy** (since 15 November 2026) is all inside
  `body_html`, so a receiver that renders the body shows it: the first
  paragraph opens with a bold label ("The short version:", localised) and
  answers the article's question; most `h2` are questions; and the last
  section can be `<h2 id="read-next">` with a list of links to the
  articles of your site it relates to (only ones already published, at the
  address your receiver answered with). Style them if you like (for
  example `#read-next` and the first paragraph); nothing needs parsing.

## 1. Route handler

`app/api/gettrafficfast/route.ts` on the customer's site:

```ts
import { createHmac, timingSafeEqual } from "crypto";

interface ArticlePayload {
  event: "test" | "article.publish";
  title: string;
  slug: string | null;
  html: string;
  keyword: string | null;
  scheduled_date: string | null;
  schema_version?: number;
  article_id?: string | null;
  body_html?: string | null;
  excerpt?: string | null;
  seo?: { meta_title?: string | null; meta_description?: string | null };
  headings?: { level: 2 | 3; id: string; text: string }[];
  faq?: { question: string; answer: string }[]; // v5
  date_modified?: string | null; // v5
  dataset?: { name: string; description: string; temporal_coverage: string | null; heading_id: string | null } | null; // v6
  delivery_id?: string; // v7
}

/** How far the signed timestamp may be from this server's clock, either way. */
const TOLERANCE_SECONDS = 5 * 60;

function hexEqual(expected: string, candidate: string): boolean {
  if (!/^[0-9a-f]+$/i.test(candidate)) return false;
  const a = Buffer.from(expected, "hex");
  const b = Buffer.from(candidate, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Signature v2: HMAC-SHA256 of `${timestamp}.${rawBody}`, sent as
 * `X-GTF-Signature: v2=<hex>` with `X-GTF-Timestamp: <unix seconds>`.
 * The timestamp is inside the HMAC, so a captured request cannot be
 * re-dated; anything outside the tolerance is refused.
 */
function verifySignature(rawBody: string, header: string | null, timestamp: string | null): boolean {
  const secret = process.env.GTF_WEBHOOK_SECRET;
  if (!secret || !header || !timestamp || !/^\d{1,12}$/.test(timestamp)) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > TOLERANCE_SECONDS) return false;
  const expected = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`, "utf8").digest("hex");
  return header
    .split(",")
    .map((entry) => entry.trim())
    .some((entry) => entry.startsWith("v2=") && hexEqual(expected, entry.slice(3)));
}

export async function POST(request: Request) {
  const rawBody = await request.text();

  if (!verifySignature(rawBody, request.headers.get("x-gtf-signature"), request.headers.get("x-gtf-timestamp"))) {
    return Response.json({ error: "Invalid signature" }, { status: 401 });
  }

  const payload = JSON.parse(rawBody) as ArticlePayload;

  // A replay inside the tolerance window carries a delivery_id already seen.
  // Record it in anything shared across your instances (a table with a
  // unique key, Redis SET NX with a 10-minute expiry): an in-memory Set is
  // per instance and forgets on every deploy.
  //
  //   if (!payload.delivery_id || !(await db.webhookDeliveries.insertIfAbsent(payload.delivery_id))) {
  //     return Response.json({ error: "Delivery already received" }, { status: 409 });
  //   }

  // Connection test from GetTrafficFast: any 2xx is enough.
  if (payload.event === "test") {
    return Response.json({ ok: true });
  }

  const slug = payload.slug ?? payload.title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const body = payload.body_html ?? payload.html; // prefer the h1-less body

  // Store the article wherever the site keeps its content — keyed by the
  // stable article_id so republishes UPDATE instead of duplicating:
  //
  //   await db.posts.upsert({
  //     where: { gtfArticleId: payload.article_id ?? slug },
  //     create: {
  //       gtfArticleId: payload.article_id ?? slug,
  //       slug,
  //       title: payload.title,
  //       html: body,
  //       excerpt: payload.excerpt ?? null,
  //       metaTitle: payload.seo?.meta_title ?? null,
  //       metaDescription: payload.seo?.meta_description ?? null,
  //       faq: payload.faq ?? [],                      // v5
  //       publishedOn: payload.scheduled_date ?? null,
  //       modifiedAt: payload.date_modified ?? null,   // v5
  //       heroUrl: payload.media?.hero?.url ?? null,
  //     },
  //     update: { slug, title: payload.title, html: body /* ... */ },
  //   });

  // The returned URL is stored by GetTrafficFast as the article's live URL.
  return Response.json({ url: `https://your-site.com/blog/${slug}` });
}
```

## 2. Environment

On the customer's site, set `GTF_WEBHOOK_SECRET` to the same shared secret
entered in GetTrafficFast → Settings → Connections → Webhooks.

## 2a. Moving a receiver from `X-Signature` to the timestamped signature

Until 16 November 2026 deliveries were signed only with `X-Signature`, the
hex HMAC-SHA256 of the raw body (signature v1). That proves who sent the
bytes, not when: anyone who captured one request (a proxy log, a debugging
tool) could send it again and it would verify forever.

Every delivery now carries both:

| Header | Value | Status |
| --- | --- | --- |
| `X-Signature` | hex HMAC of `rawBody` | v1, deprecated, still sent |
| `X-GTF-Timestamp` | Unix seconds when the request was signed | v2 |
| `X-GTF-Signature` | `v2=` + hex HMAC of `` `${timestamp}.${rawBody}` `` | v2 |

Nothing changes for a receiver that is not updated: `X-Signature` is
computed exactly as before over the same bytes. To move one:

1. Replace the verification with the one in section 1 (same secret, no
   change in GetTrafficFast).
2. Refuse a timestamp more than 5 minutes from your clock (keep the server
   clock synced; NTP is enough).
3. Record `delivery_id` and answer 409 to a repeat.
4. Send a test from Settings → Connections → Webhooks: a 2xx means it works.

Removing `X-Signature` from the deliveries is a breaking change, so it will
only happen after an announced notice period, never as an edit in place.
`lib/publishing/webhook-signature.ts` is the sender's side of this contract;
GetTrafficFast's own receiver accepts only v2 (`docs/BLOG.md`).

## 3. Typography (do not skip this)

`body_html` is semantic HTML (`h2 h3 p ul ol li strong em a`) with **no
classes**. Tailwind's preflight resets headings and lists to plain inherited
text, so an unstyled container renders the article as a wall of same-size text.
Style the article container with either:

- **Tailwind Typography**: `<article className="prose lg:prose-lg max-w-none dark:prose-invert" dangerouslySetInnerHTML={{ __html: body }} />`, or
- **Scoped CSS** equivalent to GetTrafficFast's preview scale: `h2` ≈ 1.875rem
  bold with generous top margin, `h3` ≈ 1.5rem semibold, `p` ≈ 1.125rem with
  bottom margin, real bullets/numbers and indent on `ul`/`ol`, spacing on `li`,
  `strong` semibold, styled links.

Always verify the rendered post shows a clear visual hierarchy.

## 4. Notes

- **Verify before parsing**: the HMAC is computed on the *raw* request body;
  reading `request.text()` first (not `request.json()`) is what makes the
  comparison possible.
- **Idempotency**: the cron retries failed publishes and users can manually
  republish, so the endpoint may receive the same article multiple times —
  upsert by `article_id` (fallback: slug). Each of those is a new request
  with its own `delivery_id` and timestamp; only the very same request seen
  twice is a replay (409).
- **Timeout**: GetTrafficFast waits max 10 seconds; do the minimum inline and
  defer heavy work (image processing, revalidation of many pages).
- **ISR**: after saving, `revalidatePath("/blog")` (and the post page) makes new
  and updated articles visible immediately on statically generated blogs.
- The delivery history (success/error per attempt) is visible in
  GetTrafficFast → Settings → Connections → Webhooks → *Recent deliveries*.

## 5. Structured data (JSON-LD)

With payload v5 a receiver has everything it needs to give search and answer
engines the same structured data GetTrafficFast's own blog renders
(`lib/blog/structured-data.ts` in this repository). Store `seo.meta_title`,
`seo.meta_description`, `faq`, `scheduled_date`, `date_modified` and
`media.hero.url` with the post, then, on the post page:

```tsx
// app/blog/[slug]/page.tsx on the customer's site
const SITE = "https://your-site.com";
const BUSINESS = { "@type": "Organization", name: "Your Business", url: SITE };

// "<" is escaped so a title containing "</script>" cannot close the element.
const jsonLd = (data: unknown) => JSON.stringify(data).replace(/</g, "\\u003c");

export async function generateMetadata({ params }) {
  const post = await getPost((await params).slug);
  return {
    // The article's own title for search; fall back to the headline.
    title: post.metaTitle ?? post.title,
    description: post.metaDescription ?? post.excerpt,
    alternates: { canonical: `${SITE}/blog/${post.slug}` },
    openGraph: {
      type: "article",
      title: post.metaTitle ?? post.title,
      url: `${SITE}/blog/${post.slug}`,
      ...(post.heroUrl ? { images: [post.heroUrl] } : {}),
    },
  };
}

export default async function PostPage({ params }) {
  const post = await getPost((await params).slug);
  const url = `${SITE}/blog/${post.slug}`;

  const article = {
    "@context": "https://schema.org",
    "@type": "Article",
    headline: post.title,
    description: post.metaDescription ?? post.excerpt,
    datePublished: post.publishedOn,
    // Never modified: the day it was published is the day it last changed.
    dateModified: post.modifiedAt ?? post.publishedOn,
    author: BUSINESS, // or a Person, if a real person signs your posts
    publisher: { ...BUSINESS, logo: { "@type": "ImageObject", url: `${SITE}/logo.png` } },
    ...(post.heroUrl ? { image: [post.heroUrl] } : {}),
    mainEntityOfPage: { "@type": "WebPage", "@id": url },
  };

  // Only when the article has an FAQ: an empty FAQPage is an error to a validator.
  const faq = post.faq.length > 0 && {
    "@context": "https://schema.org",
    "@type": "FAQPage",
    mainEntity: post.faq.map((pair) => ({
      "@type": "Question",
      name: pair.question,
      acceptedAnswer: { "@type": "Answer", text: pair.answer },
    })),
  };

  // v6, only when the article has its own data: the "From our data" section.
  const dataset = post.dataset && {
    "@context": "https://schema.org",
    "@type": "Dataset",
    name: post.dataset.name,
    description: post.dataset.description,
    ...(post.dataset.temporal_coverage ? { temporalCoverage: post.dataset.temporal_coverage } : {}),
    creator: BUSINESS,
    url: post.dataset.heading_id ? `${url}#${post.dataset.heading_id}` : url,
  };

  const breadcrumbs = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: [
      { "@type": "ListItem", position: 1, name: "Home", item: SITE },
      { "@type": "ListItem", position: 2, name: "Blog", item: `${SITE}/blog` },
      { "@type": "ListItem", position: 3, name: post.title, item: url },
    ],
  };

  return (
    <article>
      {[article, faq, dataset, breadcrumbs].filter(Boolean).map((block, i) => (
        <script key={i} type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd(block) }} />
      ))}
      <h1>{post.title}</h1>
      {post.modifiedAt && <p>Updated {new Date(post.modifiedAt).toLocaleDateString()}</p>}
      <div className="prose" dangerouslySetInnerHTML={{ __html: post.html }} />
    </article>
  );
}
```

Three rules worth keeping:

- **The FAQ you mark up must be on the page.** It is: the pairs are the
  questions and answers of the FAQ section already inside `body_html`. Do not
  add pairs of your own to the JSON-LD that a reader cannot see.
- **Leave out what you do not have.** No hero means no `image`; do not point
  it at a logo. `date_modified: null` means the article has not changed.
  `dataset: null` means no Dataset, and a `null` period means no
  `temporalCoverage`.
- **A sender older than v5** sends neither field. Treat a missing `faq` as
  "unknown" rather than "none" if you want to derive the pairs yourself from
  `body_html`; GetTrafficFast's own receiver does exactly that for the posts
  it stored before v5.

## 6. Readable by AI answer engines (robots.txt and llms.txt)

An answer engine can only cite a page its crawler may read. Two additions make
that explicit on the customer's site. Neither makes an engine cite anything,
and GetTrafficFast cannot tell that it did: no engine says why it cited a
page, and citations are sampled (public docs, "How we measure"). Say "helps crawlers find and read the pages", never
more.

The crawler names are the ones `lib/ai-crawlers.ts` keeps in this repository
(the same list gettrafficfa.st serves, the public docs give WordPress
customers, and the in-app agent prompt asks for). Update them there first.

### robots.txt

A crawler that finds its name in a group stops reading `User-agent: *`, so
each named group repeats the site's own rules. `app/robots.ts`:

```ts
import type { MetadataRoute } from "next";

const SITE = "https://your-site.com";

// The site's rules for every crawler. Keep private paths here.
const site = { allow: ["/"], disallow: ["/admin/", "/api/"] };

// Search and answer crawlers: read a page so an engine can find it, or fetch
// it because a person asked. Blocking them keeps the site out of answers.
const ANSWER = ["OAI-SearchBot", "ChatGPT-User", "Claude-SearchBot", "Claude-User", "PerplexityBot", "Perplexity-User"];

// Training: whether pages may be used to train models. Not search. The site
// owner decides; to opt out, give this group { disallow: ["/"] } instead.
const TRAINING = ["GPTBot", "ClaudeBot", "Google-Extended", "Applebot-Extended"];

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      { userAgent: "*", ...site },
      { userAgent: ANSWER, ...site },
      { userAgent: TRAINING, ...site },
    ],
    sitemap: `${SITE}/sitemap.xml`,
  };
}
```

Two notes worth keeping: `Google-Extended` and `Applebot-Extended` are
control tokens, not crawlers (they never show up in the logs), and
`Google-Extended` also covers grounding answers in Google's Gemini apps, so
blocking it is more than a training opt-out. `ChatGPT-User` and
`Perplexity-User` fetch on a person's behalf, and their vendors say robots.txt
may not apply to them.

### llms.txt

`/llms.txt` is a plain-text map of the site for language models, in the format
proposed at llmstxt.org. A proposal, not a standard: no engine promises to read
it. Generate it from the stored articles on request, so a post published today
is listed today. `app/llms.txt/route.ts`:

```ts
const SITE = "https://your-site.com";

// Brackets would close the link, newlines would start a new line (or a fake
// heading): titles and descriptions stay one line.
const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
const linkText = (text: string) => oneLine(text).replace(/[\\[\]]/g, (c) => `\\${c}`);
const segment = (slug: string) => encodeURIComponent(slug).replace(/\(/g, "%28").replace(/\)/g, "%29");

export const dynamic = "force-dynamic";

export async function GET() {
  // Only what is published: the rows the receiver stored, never a draft.
  // Newest first, capped: the file is a map, not an archive.
  const posts = await db.posts.findMany({
    where: { published: true },
    orderBy: { publishedOn: "desc" },
    take: 50,
  });

  const lines = [
    "# Your Business",
    "",
    "> One sentence on what the business does.",
    "",
    "## Blog",
    "",
    ...posts.map((post) => {
      const note = oneLine(post.metaDescription ?? post.excerpt ?? "");
      return `- [${linkText(post.title)}](${SITE}/blog/${segment(post.slug)})${note ? `: ${note}` : ""}`;
    }),
    "",
  ];

  return new Response(lines.join("\n"), {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      // The CDN keeps it an hour; a new post appears within that.
      "Cache-Control": "public, max-age=0, s-maxage=3600, stale-while-revalidate=86400",
    },
  });
}
```

`seo.meta_description` from the payload is the description to store and list;
`excerpt` is the fallback. If the site's middleware sends unknown paths to a
login page, open `/llms.txt` to anonymous requests, and allow it in
`robots.txt` if the site disallows `/`. gettrafficfa.st runs exactly this
(`app/llms.txt/route.ts`, `lib/llms-txt.ts`; docs/BLOG.md "llms.txt").
