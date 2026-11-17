# Lifecycle layer

Phase 5 of `docs/ARCHITECTURE.md` (first slice). This is the loop that turns
the product from "generates content" into "keeps content competitive": it
measures where published articles actually sit, notices the ones losing ground,
and rewrites them — under rules strict enough that a working page is never
replaced by a worse one.

## What exists

```
lib/lifecycle/rank.ts        where an article sits in the SERP (pure + storage)
lib/lifecycle/decay.ts       whether that means anything (pure, conservative)
lib/lifecycle/guard.ts       whether a rewrite may replace the live version (pure)
lib/agents/refresh-plan.ts   should we rewrite, and what exactly changes
lib/agents/refresh-write.ts  applies the plan, returns the whole document
lib/jobs/workflows/refresh-article.ts   assess → plan → rewrite → apply → republish
app/api/cron/refresh-articles/route.ts  weekly sweep: measure, then enqueue
```

Migration: `supabase/migrations/20260815100000_content_lifecycle.sql`.

## Measuring without a new integration

Rank comes from the SERP snapshots Phase 4 already records: `findOwnPosition`
looks for the article's exact URL among the results, then falls back to the
best position its domain reaches. Every measurement lands in `content_metrics`
— including a **null position**, because "we looked and it was not there" is
data, while a gap in the series would read as "we never looked".

The table is source-tagged (`serp` today, `search_console` tomorrow), so
adding Search Console later is an ingestion function, not a migration.

The weekly sweep measures first and decides second: a rank history cannot be
reconstructed after the fact, and it is what makes every later refresh decision
evidence-based rather than a guess.

## Deciding: four ways to say "leave it alone"

`detectDecay` is deliberately hard to convince, because rewriting costs money
AND risks a page that works:

| Signal | Meaning |
| --- | --- |
| **cooldown** | refreshed less than 30 days ago → never touched, whatever the numbers say |
| **lost_ranking** | it ranked, and now does not appear at all |
| **slipping** | fell 5+ positions over a span of at least 14 days, and is now outside the top 3 |
| **stale** | no rank evidence, but nothing has been updated in 120 days |

Movement measured over a couple of days is noise, not a trend. An article that
went from #1 to #3 is still the answer, so it is defended, not rewritten.

## Rewriting: what protects the live article

1. **The plan can refuse.** `refresh-plan` reads the article, the decay
   evidence and what currently outranks it, and returns `leave` when the piece
   is already the better answer and lost ground for reasons a rewrite cannot
   fix. An unrecognised verdict, or a "refresh" with no concrete work attached,
   is normalised to `leave` at the boundary: garbled output must never read as
   permission to rewrite.
2. **The rewrite returns a whole document**, not a diff — the content pipeline
   validates documents, and a patch format would be a second parser to get
   wrong. The brief demands untouched sections come back word for word.
3. **The same gates as a new article.** `needs_review` means the refresh is
   discarded and the live version stays live. `regenerate` throws away the
   rewrite checkpoint so the retry writes again rather than re-validating the
   same broken output.
4. **The guard.** Gates prove the new document is well-formed; they cannot know
   it lost half the article. `assessRefresh` compares it against what it would
   replace and rejects a rewrite that lost more than 30% of the words or more
   than one section.
5. **The slug never moves.** It is the live URL on the customer's site: a
   refresh updates an article, it does not relocate it.
6. **Media survives.** The rewrite only ever sees the body, so the hero and
   videos are carried over from the previous canonical instead of being
   silently dropped.

Only then is the previous document archived in `article_versions` (v1, v2, …)
and the live one replaced. Every outcome — applied, declined, discarded,
rejected — is written to `article_events` with its cause.

## Republishing updates, never duplicates

`PublisherAdapter.deliver` now takes an optional `DeliveryContext` carrying the
destination's own id. The webhook contract already carries `article_id` so
receivers upsert; the WordPress adapter now posts to `/wp/v2/posts/{id}` when
it knows the post id. Without this, every refresh would publish a second copy
of the article on the customer's site.

## Configuration

| Where | What |
| --- | --- |
| `/api/cron/push-articles` | weekly (Wed 09:40 UTC), `CRON_SECRET`; Push page 3 for sites with `pushPage3` on, owners who pay and are under the spend ceiling; at most 3 per site |
| `/api/cron/refresh-articles` | weekly (Mon 09:00 UTC), `CRON_SECRET`; measures and refreshes the articles of owners who pay only (`hasPaidAccess`): 40 picked from a pool of 200 after the others are left out, which are logged as `cron.unpaid_skipped` |
| `SERPER_API_KEY` | enables rank measurement — without it the sweep still runs and falls back to the staleness signal |
| `AGENT_BUDGET_USD` | per-job ceiling, shared with production |

## Citation probing

The AEO half of the loop now exists alongside rank measurement: a weekly sweep
asks each configured answer engine the question an article answers and records
whether the customer's site was cited, in `ai_citations`. It is a sampled
metric with a hard honesty constraint (an unmeasured article reports null, not
zero) — see `docs/CITATIONS.md`.

## Search Console

The loop is now closed on the measurement side: `content_metrics` carries real
impressions and clicks from the customer's own Search Console property, which
is the only counted number in the platform, next to the sampled ones. It
landed exactly as this document predicted, as an ingestion function rather
than a migration, because the table was source-tagged from day one. See
`docs/ANALYTICS.md`.

## Growth: am I growing? (2026-11-14)

The owner found the numbers spread over three screens (Overview, Results,
Prompts) and asked one question of all of them: am I growing? **Growth**
(`/growth`) answers it for a period, the last 7 days (or 28, `?days=28`)
against the same length just before, in three blocks. Results became Growth
(`/results` redirects there, query string kept, `lib/legacy-redirects.ts`), and the AI Visibility
dashboard became its evidence page, **AI answers** (`/growth/ai`,
docs/AI_VISIBILITY.md). The same summary is `get_growth`; the evidence is
`list_ai_answers` (docs/API.md). One read, `lib/growth/read.ts`
(`loadGrowth`, `listAiAnswers`), serves GET /api/growth, GET
/api/growth/answers and both tools; the arithmetic is pure, in
`lib/growth/` (`period.ts`, `google.ts`, `ai.ts`), the shapes in
`lib/growth/schema.ts`. Stored rows only: nothing on Growth asks an engine,
Google or X.

**Replies on X.** `loadReplyStats` with `days` (docs/PLACEMENTS.md, "The
week on X"): replies posted, views, likes and followers, each with its change
against the period before, the coverage ("18 of 24 replies measured") and the
best reply, which opens on X. The 28-day period reads the same way as the
week: each period as of its own last day, and the followers' change over 28
days needs both ends read from the same account.

**Google.** Search Console's numbers for the site's published articles
(`content_metrics`, source `search_console`), summed over the period:

- the period ends on the newest day ingested (the connection's watermark,
  `last_synced_on`), never on today, because Google settles its last days
  over about three: a week ending today would compare a half-counted week
  with a whole one. The block says the days ("Nov 5 to Nov 11");
- inside the ingested range a day with no row is a real zero (Search Console
  omits days with nothing to report); a period that starts before the data
  covers (the connection's day minus the 90 days its first pull reads, or the
  oldest row) has no comparison, "no comparison yet", never growth from 0;
- **average position** is weighted by impressions over the article-days that
  had any, as Search Console computes a property's average, one decimal
  (`roundPosition`), and its change is previous minus current, so up the
  page is positive ("↑ 3.1 places"). With no impression it is not measured;
- **pages on Google** is URL Inspection (`index_status`, docs/ANALYTICS.md):
  indexed of the published URLs inside the property, with the ones not
  checked yet said, never counted as not indexed. The table keeps the latest
  answer per URL and no history, so this tile has no change ("latest check
  only"). The pages Google does not have are listed under it, folded, with
  Google's reason.

Nothing ingested reads "no data yet" (or "not connected", with the way to
connect), never 0.

**AI answers.** One line per engine: "N of M asks cited you" over the
period, a count under 10 asks and a percent with its count from 10
(`formatRate`), the period before beside it, never a number across engines.
What an ask is and why the two families of probes are counted together is
`docs/CITATIONS.md`, "One count of asks". One line says it is sampled from
the articles' keywords and the questions the owner chose (not "without
naming you": a chosen question may name the business); one line says how
many pages the answers cited are
open as places to reply in Today (`PlacesLine`); "See the answers" opens the
evidence.

**By article** follows the blocks: the articles of `loadResults`, the ones
with the most impressions first, then the ones that hold a position, then
the rest (newest first), five before "Show all"; a card per article below
`md`, the table from `md` up (below). The daily clicks and impressions chart
is folded under them. "How we measure" links to the public docs
(`/docs#how-we-measure`).

Overview's numbers live here now: its Measure stage (one citation rate per
engine) is the AI block, its ranking count the Google block, its visibility
strip the AI block and the evidence page.

## Push page 3 (2026-11-15)

**Why.** An article stuck on page 3 (positions 21 to 30 and just below) is
the normal curve, and the usual advice is two moves: add internal links
from the site's best pages, and tighten the title against the query it
actually ranks for. GTF did neither on purpose: new articles link to old
ones (docs/KNOWLEDGE.md), but nothing picked the site's **best** pages to
link **to** a stuck article, and no title was ever revised against the real
Search Console query. Push page 3 does both, for every customer, and
measures what it did.

```
lib/lifecycle/push.ts               the rules, pure: candidates, query, pages, titles, windows, the line
lib/lifecycle/push-store.ts         reads, push rows, the job's enqueue, measurement, the screens' reads
lib/knowledge/push-links.ts         the one link per page, on the parsed tree (pure)
lib/agents/push-page.ts             one fast-tier call: a title, a description, where links fit
lib/jobs/workflows/push-article.ts  prepare, write, apply (or propose)
app/api/cron/push-articles/         weekly, Wednesday 09:40 UTC, behind the site's opt-in
app/api/article-pushes/             GET list, POST push one now; [id] POST: the answer to a proposal
lib/tools/article-pushes.ts         list_article_pushes, push_article, resolve_article_push
```

Migration `20261115110000_article_pushes.sql`: `content_queries` (the
queries per article, docs/ANALYTICS.md "Queries per article") and
`article_pushes`; additive, no drop, RLS on both (the owner selects, the
service role writes).

**Candidates, weekly, rules only** (`selectPushCandidates`). A published,
live article whose Search Console numbers over the 28 days ending on the
newest settled day (the connection's watermark) pass:

| Rule | Value | Why |
| --- | --- | --- |
| average position (impression-weighted) | 11 to 40 | pages 2 to 4; the top 10 is defended, deeper is absent rather than stuck |
| impressions | at least 50 | under that a position is a handful of searches |
| last push (any status, a skip included) | more than 28 days ago | one push is measured before the next |
| last change of its document | more than 14 days ago | a clean baseline: an archived version (refresh, back-link, push), `last_refreshed_at`, or going live; a published-to-published event (a declined refresh) changed nothing and does not count |
| a refresh or push job | none running | the document is about to change |
| per site per week | at most 3 | the most impressions first, then the better position |

Each one left out has its reason (`PUSH_EXCLUSION_TEXT`). Choosing costs
nothing: stored rows only.

**The main query** (`chooseMainQuery`): the query with the most impressions
for that page in its newest stored window, ties broken by clicks. No clear
query is a skip, stored with its reason ("No clear query: …"): no query
rows, a top query under 10 impressions, two queries tied on both, or query
rows more than a week older than the page numbers. A skip takes the
candidate's weekly slot and starts its 28 days, so the same article is not
re-examined every week.

**The pages that link** (`chooseSourcePages`): the site's other live
articles that Google showed in the same 28 days (impressions > 0), related
to the candidate through the knowledge graph (`findRelatedArticles`) or by
words (their keyword and title against the candidate's keyword, title and
main query: Jaccard ≥ 0.15 on the Read next tokens), not already linking to
it anywhere (body or Read next: never two links to one target in a page),
not being refreshed. The most clicks first, then impressions, then
closeness; at most 3. Fewer, or none, is a normal outcome: the title still
goes.

**The link** (`placePushLink`), one per page, verified on the parsed tree:

1. the main query written verbatim by the page, outside its short version
   (`findPhraseAnchor`), wrapped where it stands by `applyInternalLinks`
   (the verifier every internal link goes through). No model;
2. otherwise the agent's suggestion: an exact phrase of the page, or ONE
   short sentence (plain text, at most 30 words and 220 characters, one
   sentence, no address, the anchor once) added at the end of one of the
   page's numbered paragraphs. Never the short version, nothing from the
   Read next heading on. Escaped; the only element written is the `<a>`.

The anchor must be the main query or a natural variant: at least half its
content words (stemmed), 2 to 10 words (`anchorFitsQuery`). After placing,
the page must link to the article exactly once and its short version must
hold no new link. Anything else leaves the page exactly as it was, with
the reason on the push. No "related" block, ever.

**The title** (`checkMetaTitle`, `checkMetaDescription`): the meta title
(`metaTitle`, what search results show) and the meta description change;
the headline (H1) and the slug never do. A title is 20 to 60 characters, a
description 70 to 155; both contain the main query; no exclamation mark or
clickbait word; no figure the article does not state (years aside); not the
same as before. A proposal that fails keeps the old one, with the reason in
`detail`.

**One call** (`push-page` agent, fast tier): the article's text and current
title, and for each chosen page its numbered paragraphs, in one prompt. The
answer is checked as above. What it costs: about 6,000 input and 800
output tokens, roughly $0.01 on the dearest fast model in the price tables
and a fraction of a cent on the cheapest; at most 3 a site a week, so about
3 cents a site a week in the worst case, under `PUSH_BUDGET_USD` ($0.05) per
push, retries included (rebuilt from `agent_runs`). No customer screen
names a price.

**Apply or propose, per destination** (`canUpdate`, `canUpdateMeta`):

| Destination | Links | Title and description |
| --- | --- | --- |
| Webhook (this site's blog included) | updated: archived in `article_versions`, stored, delivered with `article_id` (receivers upsert), `article_links` "applied" | updated: `seo.meta_title`, `seo.meta_description`, `date_modified` |
| WordPress with the post id | updated through `/wp/v2/posts/{id}` | proposed: WordPress makes its `<title>` from the headline, which never changes; the new title waits for the person's SEO plugin |
| WordPress without the post id, or no destination | proposed, nothing changed on our side | proposed |

A delivery the site refuses leaves the change stored (`not_delivered`,
`article_links` "suggested"); the next delivery carries it. A push with
anything proposed is `proposed`: it shows in **Today, Also today**
("Push this article", `article_push`, opening the article's modal at
`/content/articles?article=<id>`) and in **the article modal** (each link:
the page, the words to link or the sentence to add; the new title and
description), with **I added it** (status `applied`, `applied_by`
customer, the measurement starts that day) and **Dismiss**
(`resolve_article_push`). The modal also has **Push this article**, asked
inline first ("This uses AI work…"), the `push_article` tool.

**Who pays, and the opt-in.** The weekly sweep runs only for a site with
`automation_settings.pushPage3` on (off by default; Settings → Autopilot,
docs/AUTOPILOT.md), an owner who pays (`spendingOwners`: subscription and
the account's spend ceiling), and not while the model accounts are paused.
The job is paid and LLM-bound (`lib/jobs/registry.ts`): the worker checks
again before it spends, and re-reads the switch for a sweep's push. On
demand (`push_article`, the modal) is behind the paywall and the spend
ceiling, 10 a key a day, and skips the position band and the minimum
impressions (the person decides); every rule that keeps the measurement
clean still holds.

**Measured honestly** (`measureDuePushes`, after every Search Console
ingest; free). The push row keeps the main query and its numbers, the
28-day baseline (position, impressions, clicks, the window), the links,
and the old and new title and description. At +14 and +28 days from the
day it went live, the `after_14` and `after_28` windows (the 14 or 28 days
after that day) are computed from `content_metrics` once the watermark
covers their last day; before that they are null, "not measured yet". A
window with no impression stores a null position ("no impressions since"),
never 0. Growth, By article, prints the newest push under the keyword:
"Pushed Nov 16: 37 → 29" (whole places, the newest after-value), "no change
yet" (the same whole place), "not measured yet", or "Proposed Nov 16: not
applied yet". A proposal never applied is never measured. Nothing about a
push reaches public content.

**API**: `list_article_pushes`, `push_article`, `resolve_article_push`
(docs/API.md); `get_today` carries `article_push` items; the results read
gains an optional `push` per article (only when the article was pushed).

**What is not verified until the first real run**: how often the agent
finds a phrase versus adds a sentence, how many titles pass the checks,
and whether Google moves the pushed articles. The sweep runs only for a
site whose owner turned the switch on.

## Where it shows up

The measurements are read in one place, `lib/lifecycle/load-results.ts`:
`articleResults` (rank, traffic and citations per article, from two bulk
reads), `loadSearchConsoleStatus` and `loadResults`. Growth's route
(GET /api/growth, "By article"), the Results route (`/api/results`), the
Overview (`lib/home-snapshot.ts`) and the `get_results` tool all call it, so
none of them computes a number the others compute differently
(`tests/lifecycle/load-results.test.ts` pins both routes' answers).

- **Overview** (`lib/domain/operating-loop.ts`): the Measure stage prints one
  citation rate per engine ("Gemini 20% · Perplexity 1 of 4"), pooled per
  engine across articles by `citationRatesByEngine`, never across engines.
  No probe is "not measured yet", not 0%; under 10 probes on an engine it is
  the count, not a percent (`formatRate`, `docs/CITATIONS.md`).
- **Growth → By article** (Results until 2026-11-14): the articles
  (`components/results/article-results.tsx`): a card per article below `md`
  (keyword wrapping, position with its 28-day trend, clicks, citations per
  engine, last checked, and a 44px open-article link), the table from `md`
  up. Same data, same words for what is missing: "not measured yet", "not
  ranking", "never". Each engine's rate sits on its own line, not in a hover
  title. Replies on X, the first block of Growth, is X's numbers on the
  replies posted and the account's followers, not an article measurement,
  so nothing in this layer computes them (docs/PLACEMENTS.md, "The week on
  X, and the account's followers").
- **Positions** leave the lifecycle layer to one decimal: `summarizeRank`
  rounds the current and previous positions with `roundPosition`
  (`lib/format.ts`) and takes the change between the rounded values, and
  `summarizeTotals` rounds the average. The screen, `/api/results` and
  `get_results` all read 51.8 and a change of 15, never 51.75 and
  15.049999999999997. On screen every position and change goes through
  `formatPosition` / `positionChange`: one decimal at most, no trailing
  ".0", and a change that rounds to 0 is drawn as unchanged. The Keywords
  screen's overlapping topics use the same formatter.
- **Where a position comes from** is said once, under the articles
  (`describeRankSources`): "Positions are Google's average from Search
  Console." When rows mix sources, the source most rows share is the
  sentence (a tie goes to Search Console) and only the other rows carry a
  small "SERP snapshot" (or "Search Console") marker. Never the stored
  identifier.
- **Articles board** (Content → All articles, `/content/articles`;
  `components/dashboard/calendar*.tsx`): from `md` up, a
  month grid starting at the earliest of the oldest unpublished article and
  the oldest published in the last 30 days; months with nothing in them
  collapse to one line, the current month is always drawn. Below `md`, a
  list grouped by day, coming up first, then published in the last 30 days;
  drag-to-reschedule exists only in the grid, and nothing on a phone sets
  `touch-action: none`.
- **Regenerate** on a card or in the article modal rewrites the article, and
  on a published one the next delivery replaces the live post, so it asks
  first, inline ("This rewrites the published article. Continue?"), and acts
  on the second tap. Republish and Publish anyway ask the same way, and so
  does Disconnect on the WordPress and webhook cards; the shared control is
  `components/ui/inline-confirm.tsx`. No screen uses `window.confirm`.
- Dates on these screens go through one formatter (`formatDay` in
  `lib/format.ts`): "Published Nov 2", "Thu, Nov 12", always in English
  (`UI_LOCALE`, en-US) whatever the device's locale, never a raw ISO day.
  Counts go through `pluralize` ("1 article", "12,400 clicks").

## Tests

- `tests/dashboard/calendar-model.test.ts`, `tests/dashboard/calendar.test.tsx`
  — the month range, collapsed months, the phone list, no `touch-action` on
  a phone; `tests/dashboard/article-card.test.tsx` — the second tap;
  `tests/format.test.tsx` — dates and counts in English on a simulated
  Italian phone, and no formatter in `app/` or `components/` left without a
  locale.
- `tests/format.test.tsx` ("positions") and `tests/lifecycle/results.test.ts`
  — one decimal, half away from zero, never -0; the change is the
  difference of the rounded positions; a move that rounds to nothing is
  unchanged; the source said once and only the exceptions marked;
  `tests/results/engine-citations.test.tsx` — the owner's 2026-11-13
  screenshot as data: no 51.75 or 15.049999999999997 on screen, "Search
  Console" once, cards below `md`, the table from `md` up, a 44px link.
- `tests/growth/google.test.ts`, `tests/growth/ai.test.ts`,
  `tests/growth/period.test.ts`, `tests/growth/growth-view.test.tsx`,
  `tests/growth/redirects.test.ts`, `tests/tools/read-growth.test.ts`
  (2026-11-14) — Growth: nothing ingested is null, never 0; the window ends
  on the watermark; a day without a row inside the data is a real zero, a
  period before the data is no comparison; the position weighted by
  impressions, its change positive up the page, never -0; asks per engine
  and both families, a negative kept, an unreadable answer not a "not
  cited", a configured engine nobody asked "not asked"; the blocks in order,
  "not measured" for what nobody measured, a count under 10 asks and no
  percent across engines; the evidence marks the site's own source and the
  places in Today and never folds them away; every old address redirects
  with its query; `get_growth` answers what the screen's read answers, site
  B's cited probe never counts.
- `tests/lifecycle/decay.test.ts` — the conservatism contract: cooldown, noise,
  short spans, top-3 defence, staleness fallback; URL-then-domain rank
  matching; the guard's word/section thresholds.
- `tests/agents/refresh-agents.test.ts` — evidence reaches the prompts, and
  every unclear verdict collapses to `leave`.
- Push page 3 (2026-11-15): `tests/lifecycle/push.test.ts` (the band, the
  minimum, cooldown, quiet days, the weekly cap and its order; the main
  query and its skips; source pages; anchors; title and description rules;
  the windows and Growth's line), `tests/knowledge/push-links.test.ts` (the
  query found by code outside the short version, the added sentence, never
  twice, Read next left alone, every refusal leaving the page as it was),
  `tests/agents/push-page.test.ts` (one fast call, only offered pages),
  `tests/jobs/push-article.test.ts` (webhook applied and delivered,
  nothing changed and a proposal without a destination, WordPress: links
  applied and title proposed, a bad title kept out, the switch re-read),
  `tests/lifecycle/push-store.test.ts` (the query report, the sweep's
  records and skips, on-demand refusals, the answer to a proposal, what
  counts as a change, after-values only once covered),
  `tests/today/also-today-push.test.tsx` (the Today card, the By article
  line), `tests/tools/write-business.test.ts` (off by default, spend and
  confirm to turn on).
