# The blog on gettrafficfa.st

The product's own blog is not a CMS and has no hand-written posts. It renders
the articles GetTrafficFast generated **for its own business** and delivered to
**its own webhook receiver** — the same integration, the same signed payload
and the same delivery log a customer gets.

Until September 2026 `/blog` was three hardcoded posts signed "GetTrafficFast
Team" and dated December 2024, on a route the middleware did not even make
public. For a product whose pitch is "it writes and publishes for you", that
page was the loudest possible argument against itself.

## Why the webhook and not a shortcut

The first attempt at fixing it added a private `self` destination that read the
`articles` table directly. It was deleted the day it shipped, and the reason is
worth keeping: gettrafficfa.st is a Next.js site, exactly like the customers
who use the Webhooks integration. Publishing to itself through a private path
would have made the delivery code every customer depends on the one piece the
product never runs on itself. A broken webhook would then be discovered by a
customer, not here.

So the product is a customer of itself in the literal sense: it connects a
webhook, it signs a payload, and if the signature check or the payload shape
breaks, this blog stops updating first.

## How it works

```
cron → produce-article → WebhookAdapter → POST /api/gettrafficfast (signed)
                                            → blog_posts (upsert by article id)
app/blog/            the index and the post page (force-dynamic)
app/blog/[slug]/opengraph-image.tsx   the post's social card, drawn in code
lib/blog/receive.ts  signature check + payload → row (pure, tested)
lib/blog/posts.ts    row → post (pure) + the two reads
app/sitemap.ts       blog entries come from the same query, served at /sitemap.xml
app/robots.ts        points crawlers at that sitemap, names the AI crawlers
app/llms.txt/        the public site and the posts as text for models
```

`/sitemap.xml` and `/robots.txt` are public on purpose. Both used to fall
through the sign-up redirect, so Google fetched the registration page and
reported that the sitemap was HTML. `lib/public-paths.ts` is the list the
middleware and `robots.txt` share.

`robots.txt` disallows `/` and allows the home page, the sitemap and the
public sections. Since 2026-11-10 it also allows the files a crawler needs
around them (`CRAWLABLE_ASSETS`): the favicon files, `/og/`, `/_next/static/`
and `/_next/image`. Before, they were covered by the disallow: Google does not
show a favicon it may not crawl (in Search or through its favicon service,
which the app's site switcher uses), X does not show a card image it may not
fetch, and a page is rendered without the CSS and JS it may not load.

### AI crawlers in robots.txt

Since 2026-11-15 `robots.txt` also names the AI crawlers, in two groups after
`*`, each with exactly the same Allow and Disallow lines as `*` (a crawler
that finds its name stops reading `*`, so a group without them would open the
signed-in product to it). The list and the choice live in
`lib/ai-crawlers.ts`, shared with the public docs' WordPress snippet
(`/docs#ai-crawlers`) and the webhook agent prompt:

| Group | User agents | Rule on gettrafficfa.st |
| --- | --- | --- |
| Search and answer | OAI-SearchBot, ChatGPT-User, Claude-SearchBot, Claude-User, PerplexityBot, Perplexity-User | same as `*`, always |
| Training | GPTBot, ClaudeBot, Google-Extended, Applebot-Extended | same as `*` while `ALLOW_AI_TRAINING` is true |

**Training is allowed, on purpose.** The public pages are a marketing site,
docs and a blog written to be read and repeated, and nothing on them is
private; the product stays disallowed for every crawler. To flip it, set
`ALLOW_AI_TRAINING = false` in `lib/ai-crawlers.ts`: the training group then
gets `Disallow: /`, nothing else changes. Note that `Google-Extended` also
covers grounding in Google's Gemini apps, so blocking it is more than a
training opt-out.

Googlebot, Bingbot (which also feeds Copilot) and Applebot are not named:
they follow `*`, as before. The tokens are the vendors' own as listed on
2026-11-15; retired ones (`Claude-Web`, `anthropic-ai`) are left out.

### llms.txt

`/llms.txt` (`app/llms.txt/route.ts`, built by `lib/llms-txt.ts`, pure and
tested) is a plain-text map of the public site in the llmstxt.org format:

- `# GetTrafficFast`, a one-line `>` tagline, and `SITE_SUMMARY`
  (`lib/site.ts`), the same paragraph that opens `/docs`;
- `## Docs`: one link per docs section, from `components/docs/sections.ts`;
- `## Product`: pricing, with no number in the notes;
- `## Blog`: the blog index, then the published posts, newest first, at most
  `LLMS_TXT_POST_CAP` (50), each `- [title](url): meta description`.

The posts are `listPosts`, the rows the blog and the sitemap read.
`blog_posts` holds only what the receiver stored, so a draft (an `articles`
row never delivered) cannot appear; the route never reads `articles`. Titles
have `[` `]` `\` escaped, every field is collapsed to one line (a newline in a
title cannot start a heading), a `(` `)` in a slug is percent-encoded, a
description over 300 characters is cut at a word, and a row without a slug or
a title is skipped. Nothing about GetTrafficFast's own results is stated.

It is built per request (`force-dynamic`, like the sitemap: no database read
at build time, a new post listed the day it lands) and cached on the CDN for
an hour (`s-maxage=3600`); when the posts cannot be read the file is still
served without them, cached five minutes. `/llms.txt` is public in the
middleware and allowed in robots.txt (`LLMS_TXT_PATH`,
`lib/public-paths.ts`). It is not in the sitemap: a sitemap lists pages to
index, and a text file for models is not one. There is no `/llms-full.txt`:
the full bodies are on the post pages, and a file holding every article would
be large for no reader that has asked for it.

The favicon is two files (`app/layout.tsx`): `/icon.svg`, the mark alone,
black, white under `prefers-color-scheme: dark` by a rule inside the file; and
`/favicon.ico`, the white mark on a black tile, for whatever cannot draw the
SVG or does not adapt, declared `32x32` because Chrome takes an `.ico` declared
`any` over the SVG. `/icon.png` (manifest, structured data) and
`/apple-icon.png` (home screen) are the same tile. The earlier set had black
on transparent as the unconditional icon, invisible on a dark tab, and the
home-screen icon was the black mark on black.

The receiver is the endpoint documented in
`docs/NEXTJS_WEBHOOK_RECEIVER.md`, implemented rather than described. Two rules
it exists to respect:

- **The signature is checked over the RAW body.** `request.text()` before any
  parsing: re-encoding the JSON produces different bytes and the comparison
  then silently never matches.
- **Only the timestamped signature, and each delivery once.** Since 16
  November 2026 this receiver requires `X-GTF-Signature: v2=…` with
  `X-GTF-Timestamp` (HMAC over `timestamp.body`,
  `lib/publishing/webhook-signature.ts`) and refuses a timestamp more than 5
  minutes from its clock, either way; the body-only `X-Signature` alone gets
  401. Inside the window, the payload's `delivery_id` (v7) is recorded in
  `blog_webhook_deliveries` before anything is stored, and a second sight of
  it gets 409. A retry is a new request with a new id, so retries still land.
  Rows older than a day are pruned on each delivery. Before that table
  exists (migration `20261116130000`), the timestamp window is the only
  guard and the receiver logs it.
- **Upsert by `article_id`.** The cron retries failed publishes and a refresh
  republishes the same article; a second delivery must update the post, never
  add a twin.
- **The body is sanitised before it is stored.** The post page renders
  `body_html` as markup on the product's own origin, and a valid signature
  proves who sent a payload, not that it is safe. `sanitizeBlogHtml` runs the
  content pipeline's tree allowlist (`lib/content/stages/sanitize.ts`): no
  `<script>`, `<iframe>`, `<style>`, `on*` handler or `javascript:` URL
  (however the scheme is spelled). The only additions are the two attributes
  the delivery writes itself, `figure.gtf-hero` and `img[fetchpriority]`.
  `lib/blog/posts.ts` runs it again on read, so rows stored before the
  receiver sanitised are safe too.

The hero image travels inside `body_html` as `<figure class="gtf-hero">` (and
is still stored on its own for OG / cards). A receiver that only renders the
body still shows the photo; one that also paints `media.hero` as a header
must skip that render when `embedded` is true.

The social card (`og:image`) is not the hero. `opengraph-image.tsx` draws the
post's title on the site's background with `next/og`, 1200×630, with no model
call; Next adds the tags from the file, so the page's metadata must not set
`openGraph.images` (docs/MEDIA.md, "The blog's social card").

Migration: `supabase/migrations/20260914180000_blog_posts.sql`. `slug` is
unique: two posts sharing a URL is worse than a delivery that fails loudly and
can be retried from the dashboard.

## Configuration

| Variable | Meaning |
| --- | --- |
| `BLOG_WEBHOOK_SECRET` | the shared secret the **receiver** checks. Also the secret the **sender** uses when the destination is this site. One value, on Vercel, production. |
| `OWN_BLOG_OWNER_USER_IDS` | comma-separated Supabase user ids allowed to connect `/api/gettrafficfast` and to have deliveries to it signed with `BLOG_WEBHOOK_SECRET`. Unset means nobody, including the operator: the blog stops receiving until it is set. |

Without it every delivery is refused with a 401, which is the correct failure:
a receiver with a missing secret that accepts anything is a stranger publishing
on the domain.

This site is a customer of itself. There is no `GTF_WEBHOOK_SECRET` here —
that name is for *other* Next.js sites following
`docs/NEXTJS_WEBHOOK_RECEIVER.md`. Connecting the gettrafficfa.st business
stores `{ url: https://gettrafficfa.st/api/gettrafficfast }` and signs with
`BLOG_WEBHOOK_SECRET`. Pasting a second copy into the integration row is how
the two sides drift.

Who may do that is the operator alone. The secret is a platform secret, so
the platform decides whose deliveries it signs: the URL being this receiver
AND the row's `user_id` being in `OWN_BLOG_OWNER_USER_IDS`. A flag in the row
cannot decide it, because a user can write their own row. Before this rule any
signed-in account could connect this URL and publish into the public blog.
Rows written earlier carry `secret_from_env: true`; the flag is now ignored
and those rows still resolve, through the URL and the owner.

Setup, once:

1. Add gettrafficfa.st as a site (Settings → Business, "Add a site").
2. Set `BLOG_WEBHOOK_SECRET` and `OWN_BLOG_OWNER_USER_IDS` (your Supabase
   user id) on Vercel (production).
3. Settings → Connections → Webhook, with that site selected: Connect.
   The URL is this site's own receiver; the secret is not typed in.
4. Add keywords and turn on Autopilot (or schedule by hand). Until then the
   blog is empty, which is the honest state. Autopilot for this site is the
   same switch every customer uses: it spends money and publishes, so it is
   never on by default. Once it is on, the 06:00 UTC sweep fills the calendar
   (from tomorrow, never today) and the 08:00 sweep writes and delivers to
   `/api/gettrafficfast`.

## What a search or answer engine reads on a post

An audit on 2026-11-10 found the post page with no JSON-LD at all, a
`<title>` that was the whole headline (up to 118 characters), no canonical
link, no visible sign that an article had been updated, and the byline
"Written by GetTrafficFast" as plain text. `lib/blog/structured-data.ts` is
where that is fixed, pure and tested: a post in, plain objects out.

| What | Rule |
| --- | --- |
| `<title>` | The article's own meta title when the delivery carried one (`blog_posts.meta_title`). Otherwise the headline cut to about 60 characters, never inside a word: at the end of its main clause when the cut falls after one ("How to X: a guide for…" becomes "How to X"), else at the last whole word, with no ellipsis. " - GetTrafficFast" is appended only when the whole still fits in 60. A meta title is never cut: it was written for search. |
| Meta description | `meta_description`, else the excerpt. |
| Canonical | `https://gettrafficfa.st/blog/<slug>`, absolute. The index has one too. |
| Share image | Not set by the page's metadata: `app/blog/[slug]/opengraph-image.tsx` generates the card and Next adds it to `og:image` and `twitter:image`. Naming images in `generateMetadata` would replace that card, so it names none. |
| `Article` JSON-LD | `headline`, `description`, `datePublished`, `dateModified`, `author`, `publisher` (with the logo), `image` (the hero, when the article has one), `mainEntityOfPage`, `url`. |
| `FAQPage` JSON-LD | Only when the article has an FAQ: one `Question` per pair with its `acceptedAnswer`. |
| `Dataset` JSON-LD | Since 2026-11-15, only when the article has a "From our data" section (the owner's own measurements, docs/CONTENT_PIPELINE.md "The article's anatomy"): `name`, `description` (the section's text), `temporalCoverage` when the section names a period, `creator` the `Organization`, `url` the section's anchor, `isPartOf` the article. Read from the stored body (`extractDataset`), so no column is needed. |
| `BreadcrumbList` JSON-LD | Home, Blog, the post. The index carries Home, Blog, and a `Blog` block listing its posts. |
| "Updated <date>" | Shown beside the publish date only when the sender said the article changed (`modified_at`) on a later day than it was published. |
| Byline | "By GetTrafficFast", linked to the home page (`rel="author"`). In JSON-LD the author and the publisher are the `Organization`. |

Every value is something the delivery carried. A field the post does not
have is left out of the JSON-LD, never filled in: no `image` without a hero,
no dates without a publish day. When the article was never modified,
`dateModified` equals `datePublished`, which is what "last modified" means
for a page that has not changed.

**The FAQ pairs** are not parsed out of HTML with a pattern. The sender
extracts them from the article's parsed body (`extractFaq`,
`lib/publishing/seo.ts`): the `<h2>` section labelled as an FAQ, each `<h3>`
a question, the text of the blocks under it the answer; or, with no label, a
section whose every `<h3>` ends in "?". They travel as `faq` in payload v5
and are stored in `blog_posts.faq`. A row delivered before v5 has `faq`
null, and the page runs the same structural read on its stored body; an
empty array is trusted as "this article has no FAQ".

**"Updated" is never the delivery time.** `blog_posts.updated_at` moves on
every delivery, a retry of a failed publish included, so it says nothing
about the article. `modified_at` is the sender's `date_modified`: set when a
refresh rewrote the article or a back-link was added to it
(docs/KNOWLEDGE.md), null otherwise.

Migration: `supabase/migrations/20261110200000_blog_posts_seo.sql` adds
`meta_title`, `faq` and `modified_at`, all nullable. Both sides work before
and after it runs: the page reads `select("*")`, so a missing column is
simply absent, and the receiver stores a post without the three columns when
the database refuses them (`withoutSeoColumns`), instead of failing the
delivery.

The JSON-LD goes into the page as the text of a `<script
type="application/ld+json">` with every `<` escaped (`jsonLdScript`), so a
title holding `</script>` cannot close the element.

Tests: `tests/blog/structured-data.test.ts` (the shapes, the title, the
Dataset), `tests/blog/anatomy.test.ts` (the short version and Read next on
the page),
`tests/blog/posts.test.ts` (the row and the post), `tests/blog/
receiver-route.test.ts` (the receiver with and without the new columns),
`tests/publishing/seo.test.ts` (the FAQ extraction).

## The article's anatomy on a post (2026-11-15)

Every article opens with the short version (a first paragraph that starts
with "The short version:" in bold) and ends with Read next (an `<h2
id="read-next">` and a list of related posts), both inside `body_html`
(docs/CONTENT_PIPELINE.md, docs/KNOWLEDGE.md). The post page shows them
with `decorateArticleBody` (lib/blog/anatomy.ts): after sanitising, on the
parsed tree, it adds `class="gtf-short-version"` to that paragraph (a boxed
answer under the title) and wraps Read next in `<nav
class="gtf-read-next">`. No word changes, and a post without either part is
rendered as it was. The styles are in `app/globals.css`. The line under
every post ("See what it would write for you") stays the post's call to
action.

## Why the pages are `force-dynamic`

A new article must appear without a redeploy, and the pages read at request
time — which is also why the receiver does not call `revalidatePath`. A
customer on a statically generated blog does need it; the note is in the
receiver document where it belongs.

## What is deliberately not here

- **A person's byline.** Posts are written by the product, and the page says
  so: the author is the business, linked to the home page, in the byline and
  in the JSON-LD. Inventing a human author would be the same lie the old
  posts told.
- **Comments, categories, tags.** The blog is a distribution channel for one
  business, not a publishing platform.
- **An editor.** Articles are edited where every other article is edited, in
  the app, and redelivered. The blog only receives and renders.
