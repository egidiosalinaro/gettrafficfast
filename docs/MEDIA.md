# Media enrichment

Images and videos are part of article production (the `enrich` step of the
`produce-article` workflow), not an afterthought. This is the operational
reference; the design rationale is in `docs/ARCHITECTURE.md` (Phase 2).

## The flow

```
canonical article (validated, audited)
  → image pause / provider  nothing is paid, the brief included, when a render cannot happen
  → image-brief agent      WHAT each image shows (scene, alt, caption, slot), what KIND
                           of business it is (physical | digital), from the section text
  → scene check            abstract vocabulary and text-bearing surfaces rejected in code,
                           and a scene that shares no concept with the article (2026-11-12);
                           one re-ask; still failing = not rendered, an off-topic hero = the
                           fixed desk scene (lib/media/scene-check.ts)
  → composeImagePrompt     the look, applied deterministically in code, coherent with the subject
  → image provider         renders (Google | OpenAI — lib/providers/images)
  → encodeForWeb           at most 1600 px wide, WebP q80, measured (lib/media/encode.ts)
  → storage                article-media bucket + media_assets ledger (width, height, bytes)
  → embedInlineImages      <figure> at the end of its section (tree op), width/height, lazy
  → renderHeroFigure       <figure class="gtf-hero"> on top, at delivery and in the preview

  → video provider search  YouTube candidates (lib/providers/video)
  → video-select agent     relevance judgement; empty selection = success
  → canonical.media.videos structural only — never embedded in bodyHtml
```

Three concerns, three places: the **scene** and **how many** (under the
business's cap) are inference (agent), the **style** is settings applied by
code, the **render** is a provider call. Videos are retrieval plus judgement —
the platform never generates video.

## What changed on 2026-11-10, and the evidence

An audit of production on 2026-11-10 found:

| Finding | Number |
| --- | --- |
| Images generated | all from one model, all 16:9: 1 hero plus up to 3 in-article per article |
| Stored file | JPEG, 771 KB on average (599–1,045 KB): about 3 MB per article. No resize, no WebP, no stored dimensions, no `width`/`height` on `<img>` |
| Prompts with abstract vocabulary | most of them, e.g. "A futuristic, holographic calendar… projected from a stylized, glowing AI brain" followed by "Realistic professional photograph, natural lighting" |
| Information in the images | none: the brief forbade text, numbers and UI, so every image was decoration |
| Alt text | written from the brief before rendering: it described the intent |
| Articles published with NO image | several, because the image provider answered 402 (credits depleted). Nothing said so |
| Videos | enabled in settings; every run recorded "video skipped: no video provider configured" |
| Blog post social image | none |

What is true since:

- **Hero only by default.** `inlineImagesPerArticle` is 0 unless a business
  sets it (0–3). A business that had images on and never chose a count gets
  the featured image only from its next article; nothing was stored for it to
  keep, because the count was not a setting. A legacy row that still carries
  the old `inlineCount` keeps that choice. Image spend per article goes from
  up to four renders (about $0.16) to one (about $0.04). Through the API and
  MCP, raising the cap on a site with images on needs the spend scope and
  `confirm: true`: spend does not go up by implication. (Turning images on
  needed it too until 2026-11-24; they are on by default since.)
- **Stored images are WebP, at most 1600 px wide**, with their measured
  `width`, `height` and `bytes` on `media_assets` and on the canonical image,
  and `width`/`height` on the `<img>`. **Existing images are left as they
  are: there is no backfill job.** Their rows have null sizes ("not
  measured") and their markup declares no size; an article gets the new
  format when it is regenerated. A regenerated image is stored as `hero.webp`
  beside the old `hero.jpg`, which is not deleted (a published page may still
  point at it).
- **A scene is checked in code before a render is paid for**, and the look
  follows the subject (next section).
- **Alt text is at most 125 characters and written from the accepted scene.**
  Alt that frames ("abstract representation of…") is replaced by the scene's
  first sentence. There is **no vision call after rendering**: alt describes
  the scene that was asked for, not the pixels that came back. That would be
  one more paid model call per image; it was left out deliberately.
- **A skip has a reason, the owner sees it and the operator is told** (below).
- **The blog post has a social card, drawn in code** (`app/blog/[slug]/opengraph-image.tsx`).

## Scene and style: what the check does

`lib/media/scene-check.ts` holds two lists, both about the scene and neither
about a vendor:

- **abstract vocabulary**: glowing, holographic, futuristic, AI brain, neural,
  data streams, digital landscape, abstract, "representation of",
  "symbolising", stylized, floating icons, nodes, energy beams, icons;
- **written surfaces**: screens, monitors, dashboards, apps, interfaces,
  charts, graphs, calendars, planners, signs, posters, whiteboards, text,
  numbers, logos. Image models fill these with letter-shaped noise.

The image-brief agent (version 6) runs every scene through them. If any fails
it asks the model **once** more, naming the slot and the words; a slot that
passes keeps its first scene, a slot that failed takes the rewrite. A scene
that still fails is dropped and reported in `rejected`: nothing is rendered
for it. There is no scene written by code from the title (`fallbackHeroBrief`
is gone): a scene made from a title is the generic picture the check exists
to stop. The one exception, since 2026-11-12, is a hero still off-topic after
the second ask: it gets one fixed scene, not made from anything (below). A
clean plan costs one model call, a rejected one two; never more.

The brief also returns `subject`: `physical` (a shop, a trade, a product, a
place) or `digital` (software, an online service), decided by the agent from
the business's name, niche and description. `resolveImageLook`
(`lib/media/prompt.ts`) uses it: **Photography on a digital business becomes
a clean editorial illustration**, because a "professional photograph" of
software has no subject and the model fills the gap with the stock-AI look.
The other styles, and a style the business wrote itself, are applied as
chosen. The settings screen says so under the style picker.

The agent now reads the opening text of each section (`sectionExcerpts`,
500 characters each), not only the headings.

## Images that fit a software topic (2026-11-12)

The case: the hero of "AI SEO Content Writer: A Workflow From Draft to
Clicks" was a florist arranging tulips in a plant shop. The brief told the
model that a digital business shows "the PEOPLE the article is for, in their
real setting" (its example was a shop owner unlocking the door), and forbade
every screen; GetTrafficFast's customers include small shops, so the model
pictured one, and the check had nothing to say: a florist is a perfectly
concrete scene, just of another article.

What is true since:

- **A digital subject may show a person at a desk with a laptop or a
  monitor**, as long as the screen shows nothing legible.
  `sceneProblems(scene, subject)` lets the `screen` label go for a digital
  subject when the scene says the screen is out of focus or shows only soft
  blurred shapes (those phrases are taken out before the other checks, so
  "soft abstract shapes" is not read as abstract vocabulary). A dashboard,
  an app, a website, a user interface, a chart or a spreadsheet is still
  refused for every subject, blurred or not: that is legible UI. For a
  physical subject a screen is refused as before. The render prompt
  follows: for a digital subject the constraint line says "any laptop or
  monitor screen is out of focus and shows only soft blurred shapes, never
  legible text" instead of "no screens" (`composeImagePrompt`).
- **The scene must belong to the article.** The brief names the title and
  the keyword and says a florist, a café, a garden or any other business is
  not allowed unless the article is about it. In code,
  `relevanceProblems(scene, { title, keyword, heading })`: the scene shares at
  least one concept (content words, stemmed, so "writer" and "writing" and
  "bake" and "baker" match, and "dough" belongs to "sourdough") with the
  title or the keyword (an inline scene also with its section's heading), or
  it is the generic "person at a desk with a laptop or monitor". Otherwise
  the label is `off-topic`, and the agent is asked once more like any other
  problem.
- **The fallback.** A hero still off-topic after the second ask is replaced
  by `FALLBACK_HERO_SCENE`: "A person working at a desk with an open laptop
  seen from the side, a paper notebook and a cup of coffee beside it, soft
  natural window light". Fixed text, no screen in the frame, accepted for
  every subject. The replaced scene is reported in the brief's `fallbacks`
  and in the step's notes, not as a skip: an image was rendered. An inline
  scene still off-topic is dropped like any refused scene. A hero that is on
  topic but still abstract is dropped as before.

Tests: `tests/media/scene-check.test.ts` ("a digital subject's laptop", "the
scene belongs to the article", with the florist production rendered),
`tests/agents/image-brief.test.ts` ("never gives an AI SEO article a
florist"), `tests/media/settings-and-prompt.test.ts`.

## When media cannot be produced

A skip is a record (`lib/media/skips.ts`): `{ media, reason, count, detail }`,
with `reason` one of `billing`, `paused`, `not_configured`, `provider_error`,
`brief_rejected`.

- **Step output**: `skips` on the `enrich` step, with the provider's own
  message in `detail`. For the operator.
- **Owner**: `canonical.media.skipped`, a list of `{ media, reason, count,
  message }` where `message` is a sentence of ours with no vendor text. The
  calendar's article record already loads `canonical`, so the field is there
  for the card and the modal; `readSkipNotes(canonical)` reads it. **No
  calendar component renders it yet.**
- **Operator**: one Sentry event and one email per UTC day per (media,
  reason), for `billing`, `not_configured` and `provider_error`, deduped by
  the `operator_alerts` table the LLM billing alert uses
  (`lib/media/degradation.ts`, keys `media:<media>:<reason>`). A refused scene
  and a held render are outcomes, not faults, and alert nobody.
- **Billing refusal** (a 402, or a depleted balance under another status):
  image generation is held for an hour by a `provider_pauses` row of kind
  `image`. While it holds, the step pays for no brief and makes no call, and
  records `paused`. Only images: the article is written and published, and
  the LLM pause (`kind = llm`) is a different row. When it expires the next
  article tries.
- **Videos with no provider on the platform**: recorded as `not_configured`,
  and Settings → Autopilot → Images and video says "Videos are not available right now"
  with no switch (`videoAvailable` on `GET /api/business/media-settings`).

## Rules that keep this safe

- **On by default since 2026-11-24** (the owner: product features are on;
  images are included in the plan since 2026-11-14). `imagesEnabled` and
  `videosEnabled` default to true (`businesses.media_settings`,
  tolerant-parsed by `lib/media/settings.ts`): one featured image an article,
  in-article ones only when the business raises `inlineImagesPerArticle` (0
  by default), a video only where the platform has a video provider. A
  business turns them off in Settings → Autopilot → Images and video
  (`/settings/automation#images`; `/settings/generation` redirects there); a
  stored `false` is kept. The Getting started checklist has no images step
  any more. Over the API, `imagesEnabled: true` after an opt-out needs the
  spend scope and no confirmation. The image provider runs on the
  deployment's own key (docs/SELF_HOSTING.md).
- **The business decides the look and how many it gets; the product
  decides the rest.** Aspect ratio (articles are a column of text, so images
  are wide) and quality are product decisions. How many images an article
  gets is the business's: one featured image, plus in-article images up to
  `inlineImagesPerArticle` (0 by default, 3 at most). Each one is a paid
  render for the platform (about $0.04 at the model we ship), but the
  customer never sees a price (owner's decision, 2026-11-14: the plan
  includes everything): the settings screen offers counts and says "Images
  are included in your plan", and `update_media_settings` confirms with the
  most images one article can get (`maxImagesPerArticle`), not dollars.
  What each render cost stays in `media_assets.meta.cost_usd`.
- **The hero is always asked for; inline images are a judgement under a
  cap.** `inlineImageAllowance(sections, cap)` is the smaller of the
  business's cap and one image per two sections; the agent decides how many
  of those the article deserves, down to none, and the boundary enforces the
  ceiling and one-image-per-section. Minimums are the model's job, maximums
  are code's — the standing rule. A hero the model leaves out, or whose scene
  the check refuses twice, is not rendered, and the article says why; one
  still off-topic gets the fixed desk scene (2026-11-12, above).
- **Failure degrades, never blocks, and never silently.** A provider error
  means fewer images or no video, and the article publishes anyway; the
  reason is recorded for the owner and the operator (see "When media cannot
  be produced"). Until 2026-11-10 it was a line in the step's notes that no
  screen read, which hid a broken provider for months and then a depleted
  account for 16 articles.
- **Assets live on platform storage.** Provider CDN URLs expire; bytes are
  copied to the public `article-media` bucket and referenced from there.
  Storage paths are deterministic per slot, so a regenerated asset overwrites
  its predecessor instead of accumulating.
- **The hero is not in canonical `bodyHtml`**; destinations decide how it
  appears. WordPress uploads it to the media library and sets
  `featured_media`. The webhook always puts it in `html` and `body_html` as
  `<figure class="gtf-hero">` under the title, and still sends `media.hero`
  (with `embedded: true`) for OG images and card thumbnails. A receiver that
  also renders `media.hero` as a page header must skip the inline picture when
  `embedded` is true, or the same image shows twice.
- **The dashboard preview shows what the site receives.** "View Article" and
  Copy HTML / Copy Markdown put the hero on top of the body with the same
  `renderHeroFigure` (`lib/media/figures.ts`, parser-free so the browser can
  import it) the webhook uses. Before this the preview rendered bare
  `bodyHtml`, so a generated hero was invisible in GetTrafficFast until the
  article was published — which read as "no hero was generated".
- **Excerpt stability.** Figures are inserted at the END of a section, so the
  first paragraph — the excerpt and meta-description source — never moves.
- **Model names are config that rots.** Google removed the `imagen-*:predict`
  endpoint the provider targeted, so every render 404'd and degraded to "media
  skipped" — the feature looked enabled and produced nothing. Images now go
  through `generateContent` on `gemini-*-image` models, behind the same static,
  priced, test-pinned chain the LLM provider uses after GETTRAFFICFAST-1. The
  next model is tried only when the failure says the model is unavailable: an
  auth, quota or safety refusal fails fast instead of paying three times.
- **Boundary validation.** The video-select agent's picks are filtered against
  the real candidate ids and heading ids; a hallucinated selection cannot
  leave the agent. Embedding is idempotent: re-running enrichment never
  duplicates a figure or a URL.

## Style previews

The style picker shows REAL samples: one scene ("a person reading a book")
rendered by each preset style, through the same `composeImagePrompt` + provider
path an article image goes through. A picker that showed drawings would be
advertising a look the generator never promised — and "Photography" in
particular cannot be honestly represented by an illustration.

They are committed under `public/style-previews/` — four assets that never
change per customer belong in the build, not in a bucket. Regenerate them after
changing a style directive:

```bash
GEMINI_API_KEY=... npm run previews
```

Four renders (a few cents), downscaled to 640px JPEG: they are thumbnails, and
shipping the full-size renders would be paid for on every settings page view.

## Configuration

| Where | What |
| --- | --- |
| Settings → Autopilot → Images and video | per business: images on/off, **images per article** (featured only, or up to 1–3 in the article, with no price: included in the plan), **style** (four looks or a custom one written by the business), brand colors, videos on/off when the platform can look for videos |
| `IMAGES_ENABLED` | `1` to let the deployment generate images at all (since 2026-11-24). Unset: every render is skipped as not configured, whatever a site's settings say |
| `IMAGE_PROVIDER` | platform default provider (`imagen` = Google, via `lib/providers/images/google.ts`) |
| `OPENAI_API_KEY` | enables the `openai` provider |
| `YOUTUBE_API_KEY` | enables video enrichment (absent → the settings screen says videos are unavailable, articles record `not_configured`, the operator is alerted once a day while a business has videos on) |
| `IMAGE_MODEL_GEMINI` / `IMAGE_MODEL_GEMINI_HIGH` / `IMAGE_MODEL_OPENAI` | model overrides |

Costs are attributed per render in `media_assets.meta.cost_usd`; the LLM side
of enrichment (brief + selection) is in `agent_runs` like every agent call.
`media_assets.width`, `height` and `bytes` describe the stored file
(migration `20261110190000_media_asset_dimensions.sql`, three nullable
columns); `meta.source_bytes` and `meta.source_mime_type` keep what the
provider sent.

`sharp` does the encoding and is a runtime dependency (it was a
devDependency, used only by the previews script).

## The blog's social card

`app/blog/[slug]/opengraph-image.tsx` draws a 1200×630 PNG with `next/og`:
the post's title on the site's default background, the site name, the host.
No model call, no stored file, nothing per article. Next adds the `og:image`
tags from the file on its own, so `app/blog/[slug]/page.tsx` must not set
`openGraph.images`: that would replace the card. The blog's data carries no
palette, so the colours are the site's defaults. A slug with no post gets a
card with the site's name, never an invented title. This is the product's
own blog only: a customer's site draws its own card from the webhook payload.

## Receiver impact

Webhook payload **v4**: everything in v1/v2/v3 unchanged, plus
`hero.embedded`. (v5 has since added `faq` and `date_modified`, outside
`media`: docs/NEXTJS_WEBHOOK_RECEIVER.md.)

```jsonc
"media": {
  "hero":   { "url", "alt", "caption", "embedded" } | null,
  "images": [{ "url", "alt", "caption", "slot" }],   // also embedded in body_html
  "videos": [{ "provider", "video_id", "url", "embed_url", "title", "thumbnail_url", "slot" }]
}
```

Receivers that render `body_html` get the hero as the first `<figure
class="gtf-hero">`. `media.hero` is for OG images and card thumbnails;
`embedded` is true whenever that figure is in the body, so do not render it a
second time. Videos are never in the HTML — embed `embed_url` in an iframe, or
link. Details in `docs/NEXTJS_WEBHOOK_RECEIVER.md`.
