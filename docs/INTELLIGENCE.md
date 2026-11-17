# Intelligence layer

Phase 4 of `docs/ARCHITECTURE.md` (first slice). The platform stops planning
articles from the model's priors and starts planning from evidence: the real
search results for the keyword, fetched at production time, interpreted by an
agent, and fed into the outline.

## What exists

```
lib/providers/serp/            SERP boundary: types, Serper.dev, registry
lib/intelligence/serp.ts       snapshots, reuse, competitor discovery (code)
lib/agents/serp-analysis.ts    what the SERP MEANS: intent, difficulty, angle, gaps
```

Migration: `supabase/migrations/20260810100000_serp_intelligence.sql`.

## Configuration

One optional environment variable:

| variable | effect |
|---|---|
| `SERPER_API_KEY` | enables SERP research via [Serper.dev](https://serper.dev). Without it the `research` step reports `skipped` and production behaves exactly as before |

Vendors stay behind `lib/providers/serp/registry.ts` — nothing above the
provider layer names one. Locale follows the business `content_language`
(en→us, it→it, es/fr/de likewise).

## The research step

`produce-article` OPENS with a `research` step. Until 10 November 2026 it
was best-effort; it now decides two things before anything is written (see
"What research decides" below):

1. **Snapshot** — `ensureSerpSnapshot` returns the SERP for the keyword,
   reusing a snapshot younger than 7 days: SERPs move on the scale of weeks
   and every fetch is a paid call. A fresh fetch stores the parsed shape (the
   provider payload kept verbatim inside it) in `serp_snapshots`. Because
   `validate` only deletes the `outline`/`write` checkpoints on regeneration,
   a regenerated article reuses its research for free.
2. **Competitors** — extracted by code, not judgement: every ranking domain
   that is neither the business's own site nor a generic platform
   (Wikipedia, YouTube, Reddit, …) is upserted into `competitors`
   (unique per `user_id, domain`, `last_seen_at` refreshed). Over time this
   table is the input for gap analysis.
3. **Analysis** — the serp-analysis agent reads the results, the
   "people also ask" questions and the related searches, and judges: dominant
   **intent** (informational/commercial/transactional/navigational/mixed),
   realistic **difficulty** 0–100, the **angle** that would beat what ranks,
   the **questions** the article must answer, and the **gaps** today's results
   leave open. Since agent v2 it also counts how many of the results are
   **articles** (`articleResults` out of `resultsRead`): a tool, a generator,
   a product page or a homepage is not one. The judgement is stored on the
   snapshot (`analysis`).
4. **Outline and writer** — both receive the evidence: the intent, the
   angle, the questions, the gaps, the titles currently ranking (`serp`),
   and the results themselves with their snippets and the "people also ask"
   questions (`evidence`). The outline prefers those questions for the FAQ;
   the writer may state a figure only if it is in this evidence or in the
   business's own facts, and the numbers gate checks exactly that.

### What research decides

- **No provider configured** (`SERPER_API_KEY` unset) or no keyword row: the
  step reports `skipped` and the article is written without evidence, as
  before. That is a setting, not a failure. Without evidence the writer is
  told to state no figures, and the numbers gate holds it to that.
- **Research fails** (the search API errors, the analysis agent errors): it
  is tried once more at once (the snapshot is reused, so the search is paid
  at most once), and if it fails again the article is **held**, not
  written: the job is released with `StepIncomplete` and comes back to this
  step in an hour, no attempt is counted, the article stays `queued` and
  its card reads "Waiting for research: …". Until 10 November 2026 the
  outline planned from the model's priors instead; 13 production runs did.
  An account that cannot pay is still the worker's to hold (the LLM pause).
- **The intent gate.** When the intent is transactional or navigational and
  at most one result in seven is an article (`guideCanRank`,
  `lib/agents/serp-analysis.ts`; code decides, from what the agent
  counted), no article is written. The job ends on that attempt
  (`TerminalStepError`, nothing retried, nothing sent to Sentry), the
  article moves to `failed` with `last_error` "Skipped: Google shows only
  tools and product pages for this search; an article is unlikely to rank.
  Generate it again to write it anyway.", `attempt_count` is left alone and
  no failure email is sent. The evidence was "content calendar generator":
  8 of 8 results were free tools, research labelled it transactional, and a
  2,442-word guide was published anyway. The gate applies only to an
  article still `queued`: one a person starts again after reading the
  reason, or regenerates from an existing draft, is written. An unknown
  count (older analyses, a model that did not answer it) never skips.

## Boundary rules (the standing ones)

The serp-analysis model-facing schema has no maximums and no closed enums
with consequences: an off-list intent degrades to `mixed`, difficulty is
clamped, question/gap counts are capped by code. Minimums are quality
requirements for the model; maximums are code's job.

## Data model

| table | what a row is |
|---|---|
| `serp_snapshots` | the SERP for a keyword at a point in time — provider name, parsed results (raw payload preserved inside), the agent's `analysis`; indexed by `(keyword_id, captured_at desc)`, which makes rank tracking a query away |
| `competitors` | a domain that ranks for this user's keywords — unique `(user_id, domain)`, `source` `serp`/`manual`, `first_seen_at`/`last_seen_at` |

RLS as everywhere: owners `select`, only the service role writes.

## Questions people ask

Keywords used to come from one place: the research model
(`lib/research/keywords.ts`), from the site's profile or from seeds, with its
estimates of volume, difficulty and CPC. Meanwhile discovery was already
storing what people actually ask, in public, about the site's topics
(`placement_targets`, docs/PLACEMENTS.md), and none of it reached the keyword
plan. It does now, as suggestions a person adds.

`lib/keywords/questions.ts` is pure: rows in, ideas out, no model, no fetch.

| Step | Rule |
| --- | --- |
| Which threads | Everything not rejected. A rejection keeps the thread only when it says nothing against the topic: `rules:stale`, `rules:archived` (too old to answer; the question stands), or the qualifier scoring it at or above its floor (60) and refusing it for the reply. Every other rejection (`no_overlap`, `own_site`, `promotional`, `not_public`, `not_answerable`, `too_thin`, the qualifier below its floor) is left out. Articles, repositories and pages are finished pieces, not somebody asking; so are posts the qualifier read as `showcase` or `listing`. |
| What is a question | A sentence ending in "?" (any language), taken out of a longer post when the title is one (X, LinkedIn). Without a "?", a single plain line that opens with how, what, why, which, who, where, when, is, are, can, could, should, does or best (English only). "How I…" is a story and "How to X: a guide" is a headline: neither counts. A title the source cut short ("…") is dropped, not completed. 12 to 150 characters, at least two topic words. |
| Cleaning | Site suffixes and prefixes go (`- Quora`, `: r/SEO`, `| Reddit`, `Ask HN:`, `[Question]`, `Name on X: "…" / X`, `| 1,248 comments`), with links and trailing hashtags; whitespace is collapsed. |
| Near-duplicates | Topic words (lower case, stop words out, hyphens closed, a plural stem) compared by Jaccard overlap; 0.6 or more is one question. The idea keeps its most recent thread's wording and link, and counts distinct thread URLs. |
| Already covered | Dropped when 0.75 or more of the question's topic words are in one `keywords.keyword` or one article title. Not the other way round: the keyword "email deliverability" does not cover a question about warming up a domain. |
| Order | Most threads first, then most recent (`posted_at`, or when discovery found it for an undated row). Top 20. |

`loadQuestionIdeas` (`lib/keywords/read.ts`) reads the site's 1,000 most
recently found threads, its keywords and its articles' titles: three reads of
the site's own rows. Free, and nothing switches on: no provider is called.

**No number is attached, and none is invented.** A question from a thread has
no measured volume, and asking a model to estimate one would put a guess next
to the only thing here that is real, the thread. So a keyword added from a
question is stored with `search_volume`, `difficulty`, `cpc`, `competition`
and `opportunity` null (not zero, not the Medium / 50 defaults a suggestion
gets, and not a figure sent along with it), with `source = 'question'` and
`source_url` = one thread that asks it (migration
`20261110171500_keyword_source.sql`, two nullable columns, additive). The
Keywords table shows "Asked in a public thread · host", linked, across the
four estimate columns. `threadCount` is how many of the threads *we found*
ask it: a count of rows, never shown as demand.

`addKeywords` (`lib/keywords/manage.ts`) checks the claim: `source_url` must
be the URL of one of the site's `placement_targets`, or the add is refused
(400) and nothing is saved. Since 2026-11-14 every other add is stored with
`source` "manual", and Autopilot's bought keywords with "autopilot"
(`lib/keywords/source.ts`), so the Content screen says where a topic came
from; a row from before keeps null, shown as "Source not recorded".

What follows from null: a question keyword is never a best pick
(`lib/keywords/picks.ts` needs a High opportunity and a difficulty), sorts
last on every column, and autopilot's `keywordScore` reads it as it reads any
keyword with unknown fields (docs/AUTOPILOT.md). With Autopilot on, up to 3
questions a site a day go into the pool on their own, free, checked against
the site's topics like any add (docs/AUTOPILOT.md, "Questions people ask, on
their own"); with it off, a person adds them.

Surfaces: the "Questions people ask" section of Content → All topics
(`/content/topics#questions-people-ask`; `components/keywords/question-ideas.tsx`,
a list with 44px targets, Add and Add selected), reached from the Content
screen's "Questions people ask · N" while Autopilot is off,
`GET /api/keywords/questions`, and the tools
`list_question_ideas` (read, free) and `add_keywords` with
`{ keyword, source: "question", sourceUrl }` (docs/API.md).

Limits, said plainly: the starter-word rule is English; a stale thread was
found by a search for the site's topics but was never judged for fit, so an
off-topic question can appear until a person ignores it; and the list is only
as wide as discovery, which rotates and is bounded.

Tests: `tests/keywords/questions.test.ts` (the rules, on titles shaped like
Reddit, Quora, X, Hacker News, LinkedIn and Stack Exchange ones),
`tests/keywords/question-ideas.test.tsx` (the route, null metrics stored, the
rendering, the migration text), `tests/tools/read-keywords.test.ts` and
`tests/tools/write-keywords.test.ts` (the tools).

## Search intent of a topic (2026-11-15)

The research model planned one kind of article: the business's own
category. A growing blog in the same market (climbx.so, 145 posts since May
2026) mixes three more, and each answers a search the category never will:
platform how-to and support questions about the tools its audience uses,
bottom-funnel comparisons that list the product honestly among the options,
and problem/outcome questions. Every topic now says which it is:
`keywords.intent`, one of four (migration
`20261115100000_keyword_intent.sql`, one nullable column with a check, RLS
unchanged).

| Intent | What it is | Recognised by |
| --- | --- | --- |
| `comparison` | choosing between tools | the phrase's shape: "alternative(s)", "vs", "versus", "compare(d)", a trailing "review", "pricing" or "competitors", "best/top … tools/software/apps/platforms/…", "which … tools" (a few it/es/fr/de forms) |
| `problem` | the outcome wanted, or the problem had | "why …"; "how to get/increase/fix/rank/…"; "get more"; failure phrases ("no views", "not ranking", "not indexed"); a question or an outcome verb (reduce, eliminate, drive…) with an outcome word (traffic, impressions, rank, cited, costs, customers…) |
| `platform_howto` | a how-to or support question about a platform | a platform the site's data names (below) in the phrase, with how-to or support wording (how, set up, cancel, connect, limits, locked, api, username, best time/day to post…) |
| `product_adjacent` | the business's own category | everything else |

**Rules first** (`classifyTopicIntent`, `lib/keywords/intent.ts`, pure), in
that order: a comparison, then a problem, then a platform how-to. A model's
label is taken only in the suggestion call that already runs, and only where
the rules found nothing and it can invent nothing (`settleIntent`): its
"problem" is kept, its "comparison" without a comparison's shape is not, and
its "platform_howto" naming no platform the data holds is not. No call is made
to classify anything.

**When it is decided.** Once, when the topic enters the pool: `addKeywords`
stores the intent a suggestion carries or a caller chose (one of the four), or
the rules' verdict; Autopilot's top-up stores the settled intent. A row from
before keeps null until the Autopilot sweep writes the rules' verdict on it
(docs/AUTOPILOT.md, "A week's mix"); every reader (`intentOf`) computes that
same verdict for a null row, so nothing reads "unknown". Without the site's
names (a person's add on the screen) a how-to is not recognised as a platform
how-to: the rules never guess that a word is a platform. A single-word name
that is also a word ("Make", "Writer", "Medium") counts only written with a
capital after the first word.

### What the site's data names

`lib/keywords/named-tools.ts` reads three things the platform already stored
and paid for (three reads of the site's own rows, no model, no provider):

| Source | What it gives |
| --- | --- |
| `entities` (product, organization, brand) with `article_entities(count)` | the names the site's own articles use, and in how many |
| `competitors` | the domains that rank for the site's keywords (`serp`), and the ones a person added (`manual`, with the name they gave) |
| `aeo_probes.competitors` (the 300 most recent probes) | the domains AI answers cited for the site's queries, counted by query |

A name qualifies when two sources agree (an article names "Jasper" and
jasper.ai ranks or is cited: the domain's brand label, `domainLabel`, matched
to the name with or without "AI"/"SEO"), when two or more of the site's
articles name it ("WordPress", "ChatGPT"), or when a person added it as a
competitor. A domain alone is never made into a name (coursera.org ranking
says nothing about what to call a competitor), one passing mention is not
enough, and the business itself is never on the list. At most 20, the site's
own articles weighing most. A source that cannot be read counts as empty: the
list is shorter, never invented.

What the list cannot say is which names compete with the business and which
are platforms its audience works in: Surfer and Zapier look the same to a
rule. The suggestion call decides (`intentMixBlock`, `lib/research/
keywords.ts`): it is given the list as the ONLY products and platforms it may
name, asked for roughly a quarter of each kind, "<tool> alternatives",
"<business> vs <tool>", "<tool> review" and "best <category> tools" for
comparisons, how-to and support questions for platforms, and told to set no
volume and no CPC for those three kinds. With no list it is told to name none:
only "best <category> …" comparisons and problem questions.

### No invented competitor

A prompt is a request, so code checks after it (`settleSuggestions`,
`unknownComparedNames`). For an idea a model proposed that has a
comparison's shape, each product it names ("X" of "X alternatives",
"alternatives to X", "X vs Y", "X review", "X pricing", "X competitors") must
be a name on the list, the business itself, a word of the business's own
profile (niche, description), or a plain category ("AI writer vs human
writer"). Otherwise the idea is refused, with the names, in `refused` of
`suggest_keywords` and `/api/keywords/suggest`, and in the sweep's `notes`.
A person's own add is never refused: they may compare anything they like.
The price of the rule, said plainly: a real comparison whose products the
data has not met yet ("butter alternatives" for a bakery whose profile never
says butter) is refused too, until the data names them.

**No invented volume.** A comparison, platform how-to or problem idea from a
model is stored with `search_volume` and `cpc` null: nothing measured them,
and a model's monthly figure for a long-tail question is a guess. A core
topic keeps the estimates every suggestion carries, labelled as estimates as
before. A question from a thread keeps every figure null, as before.

Surfaces: the intent tag beside each topic's source under Next topics on the
Content screen (`components/content/content-parts.tsx`: Comparison, How-to,
Problem, Core topic), `intent` in `list_keywords`, `recommend_keywords`,
`add_keywords` (input and output), `suggest_keywords` and `get_content`
(docs/API.md), the weekly mix (docs/AUTOPILOT.md), and the comparison brief
(docs/CONTENT_PIPELINE.md, "Comparison pages").

Limits: the shapes and starter words are mostly English; a platform how-to
needs the platform in the site's data, so a new site with no articles gets
none until its first articles are written and their entities extracted;
"how to quote tweet" names no platform and reads as a core topic.

Tests: `tests/keywords/intent.test.ts` (the rules on climbx.so's and the
owner's phrases, `settleIntent`, the no-invented-competitor rule, the mix),
`tests/keywords/named-tools.test.ts` (what qualifies as a name, the reads
scoped to the site, refusals, volumes nulled, the call told the list).

## Overlapping topics (near-duplicate keywords)

The same article could be written several times: "AI content publishing
platform" and "AI content publishing tool", "web push notifications for
online store" and "…online stores". Nothing checked a keyword against the ones the site already had,
so every phrasing a model suggested became its own article, and the articles
competed with each other (cannibalisation).

`lib/keywords/duplicates.ts` is the rule, pure: phrases in, verdicts out, no
model, no fetch. Two signals, and a verdict always says which one spoke.

| Signal | Rule |
| --- | --- |
| The words | Each phrase becomes a set of content tokens: lower case, accents and punctuation gone, stop words out (English, plus the articles and prepositions of it/es/pt/fr/de; "ai" is kept), plural folded, a few endings folded (`-ing`, `-ed`, `-ation`, `-ization`, a final `e`) down to a stem of three letters at least, and the category nouns a searcher uses interchangeably merged (tool, platform, software, app, solution). Word order therefore never matters. Two sets are one topic at **Jaccard ≥ 0.6**, or when one holds every token of the other, the shorter has two tokens or more, and **Jaccard ≥ 0.5** ("rfm analysis" and "rfm analysis for ecommerce"). |
| The results page | When both keywords have a stored snapshot (`serp_snapshots`, the newest per keyword): **6 or more of the top 10 URLs in common** (host without `www.`, path without a trailing slash) is the same intent. This is the only signal that can join two phrasings with few words in common. |
| A published title | A new phrase of three tokens or more whose every token is in a published article's title is covered by that article (`title_covers`). Titles are never compared with each other. |

What the words do not catch, said plainly, and pinned in
`tests/keywords/duplicates.test.ts` on the audited phrases:

- "AI agent for daily article writing" against "AI agent for content writing"
  shares three tokens of six: not joined by words. Joined when both have a
  snapshot and the results pages agree.
- "how to get cited by ChatGPT", "ChatGPT citation optimization", "get traffic
  from ChatGPT" share two tokens of four at best: not joined by words. Only
  the results pages can say they are one intent.

The threshold sits above one half on purpose: "email marketing for Shopify"
and "email marketing for restaurants" share two tokens of three and are two
articles. A rule loosened until every audited pair matched would merge those.
A new keyword has no snapshot (one is taken when its article is produced), so
the results-page signal mostly speaks between keywords already written: in
the clusters report, and when a keyword that was produced once is scheduled
again.

`lib/keywords/overlap.ts` reads the site's keywords, articles and newest
snapshots (two or three reads, never one per row, all filtered by
`business_id`) and applies the rule in four places:

| Where | What happens |
| --- | --- |
| Adding (`addKeywords`: `POST /api/keywords/save`, `add_keywords`) | A phrase that overlaps a keyword the site has, a published article, or an earlier phrase of the same call is **not added**. It comes back in `duplicates` with `duplicateOf` (the keyword, its status, its article and live link), `reason` and `why`. `allowDuplicates: true` is the explicit override. A phrase the site has letter for letter is still the unique index's case ("already in your list"), as before. |
| Suggesting (`suggestKeywords`: `POST /api/keywords/suggest`, `suggest_keywords`) | Overlapping ideas are left out of `suggestions` and listed in `duplicates`. The modal says how many were left out and why. |
| Scheduling (`scheduleKeywords`, `scheduleOverlap`: `/api/calendar/add-bulk`, `/api/calendar/add`, `schedule_keywords`) | A keyword whose near-duplicate is **already scheduled, being written or published** (any keyword with an article row, or a published title) is never scheduled. It stays in the pool and is reported in `overlapping` with the sentence the screen shows; the single add answers 409 `overlapping_topic`. Of two duplicates in one call the first, in the order given, is scheduled. A near-duplicate that only sits in the pool blocks nothing. There is no override here. |
| Autopilot (`withoutOverlapping`, `freshSuggestions` in `lib/automation/autopilot.ts`) | The same refusal, best score first, so the better of two duplicates is the one kept; and no suggestion that overlaps a topic of the site is bought. What was left out is in the sweep's `notes`. |

**The clusters that already exist** are reported, and only reported:
`loadOverlappingTopics` groups the site's keywords (A~B and B~C puts A, B and
C together), and gives each member its article and what Search Console
counted for it from `content_metrics` (`source = 'search_console'`):
impressions and clicks summed over the stored days, the average position
weighted by impressions, and `days`. A member nobody measured reads `null`
with `days: 0`, never 0 impressions. The cluster names the member to keep:

| `keeperBasis` | When |
| --- | --- |
| `most_impressions` | several published and measured: the most impressions |
| `best_position` | impressions tie: the lower average position |
| `only_published` | one member is published: that one |
| `not_measured` | several published, none measured: nobody is named |
| `nothing_published` | none published: write one of them, not all |

Surfaces: the "Overlapping topics" section of Content → All topics
(`/content/topics#overlapping-topics`; `components/keywords/overlapping-topics.tsx`,
shown only when a cluster exists), reached from the Content screen's "N groups
of topics overlap" (`countOverlapClusters`), `GET /api/keywords/overlaps`, and
the tool `list_duplicate_keywords`
(read, free). **Nothing is deleted, merged or redirected**, by the screen, the
tool or Autopilot: the section has no destructive action, and what to do with
the articles that are not kept is the owner's call.

Cost: none. No model and no provider is called; the rule reads rows the site
already has. `serp_snapshots` joined `OWNED_TABLES`
(`lib/supabase/owner-scoped.ts`) so an API-key caller reads its own.

Known debt: "Questions people ask" folds near-duplicate questions with its
own token rule (`lib/keywords/questions.ts`), written before this one. The
two agree on the threshold (0.6) and differ in stemming; they should become
one.

Tests: `tests/keywords/duplicates.test.ts` (the rule, on the audited
clusters), `tests/keywords/overlap.test.ts` (adding, suggesting, the clusters
and the keeper), `tests/calendar/overlap.test.ts` (scheduling),
`tests/automation/autopilot.test.ts`, and the tools in
`tests/tools/{read-keywords,write-keywords,write-calendar}.test.ts`.

## What this unlocks next

- **Keyword suggestion scoring from real data** — the suggest flow still uses
  LLM estimates; snapshots make honest difficulty/opportunity computable.
- **Gap analysis** (architecture §7): entities competitors cover that we
  don't — joins `competitors` with the knowledge graph.
- **Rank tracking** — repeated snapshots of the same keyword already form the
  time series; a UI over `serp_snapshots` is all that's missing.

## Tests

- `tests/intelligence/serp.test.ts` — Serper payload parsing (SERP-order
  position fallback, domain extraction, incomplete rows dropped) and
  competitor discovery (own domain + subdomains excluded, generic platforms
  excluded, dedupe by best position).
- `tests/agents/intelligence-agents.test.ts` — serp-analysis boundary
  normalisation, and proof that SERP evidence reaches the outline prompt (and
  stays out of it when absent).
