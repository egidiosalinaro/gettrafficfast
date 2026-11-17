# AI Visibility

Does an answer engine cite or recommend **this business** when someone asks
one of the questions the business has decided to be found for?

Since 2026-11-14 the answer lives in **Growth** (docs/LIFECYCLE.md,
"Growth"). Its **AI answers** block counts, per engine, how many asks of
the period cited the site (docs/CITATIONS.md, "One count of asks"), and
"See the answers" opens the evidence, `/growth/ai` (below): every answer
with its sources. The prompt set and these settings are under it,
`/growth/ai/settings`. What you do about a question you lost is in Today
(places to reply) and Content (articles). The landing page uses the same
words. Sentiment, an averaged visibility score, and engines this platform
does not ask (ChatGPT, Claude, Copilot, AI Overviews) are not shown.

`docs/CITATIONS.md` measures one article against the keyword it was written
for. This is the other subject and the customer-facing one:
one business, an explicit query set it configured, measured repeatedly and
privately, with every probe kept.

## The honest limit, first

No answer engine exposes "was I cited" as an API. This is **sampling**: on
each run the platform asks each enabled engine each configured question once
and records the answer and the sources it returned. Consequences that are
baked into the design and must survive into every screen:

- **It is a sample of the configured queries, not of the world.** The screen
  says so in one line under the answer (`SAMPLE_LINE`), not as a box above
  it. It never presents the rate as a ranking, a share of AI answers, or
  ground truth.
- **A rate over nothing is `null`, never `0`.** An engine whose probes all
  failed shows "no readable answers", not 0%.
- **Rates are per engine.** Two engines disagree, and averaging them describes
  nothing. The only cross-engine number is a *count* of queries cited by at
  least one engine, and it is labelled as a count. Engines are shown by name
  (`engineLabel`: "Gemini", not `gemini`), and every rate tile on Overview
  and Results comes from the same primitives (`StatTile`,
  `EngineRateTiles`, `NotMeasured` in `components/visibility/primitives.tsx`).
- **Under 10 readable answers, a count, not a percent.** A run over three
  prompts gives each engine three answers, and "0%" or "33%" over three is
  noise that reads like a verdict. Below `MIN_PROBES_FOR_PERCENT` (10,
  `lib/format.ts`, the same threshold as article citations in
  `docs/CITATIONS.md`) a tile shows "1 of 3" with "readable answers cited
  you. Too few for a percent (it takes 10)." under it; from 10 up, the
  percent and "4 of 12 readable answers cited you". The denominator is the
  readable answers, the rate's own. The previous run reads the same way
  ("last run 1 of 3"), and no percentage-point arrow is drawn when either
  run is under the threshold: one answer flipping out of three is +33 pts.
  Growth's AI block, the Overview strip and the question detail all go
  through `formatRate` (`lib/format.ts`).
  The API keeps the numbers: `rate`, `cited`, `valid`, and on the comparison
  `previousCited`/`previousValid` beside `previousRate`.
- **A probe that could not be read is not "not cited".** `invalid` (empty
  answer, no sources) and `error` (the call failed) are their own statuses,
  excluded from the rate and shown as *coverage* instead.
- **Two runs are compared only when they asked the same questions of the same
  engines.** Every run freezes its query-set fingerprint and its engine list.
  The screen leads with whether this run cited the site, per engine, and who
  was cited when it was not (`describeVisibility`). When the prompt list or
  the engines differ, or the previous run did not finish, the previous rate
  is still shown but no arrow is drawn, and a plain note says why. The note
  does not replace the answer.
- **Nothing is invented.** Sources come only from what the engine returned.
  Competitors are the non-ours domains it cited plus known competitors named
  in the prose; an unknown name cannot be recognised without inventing a list,
  so it is not. The excerpt is labelled as an excerpt.

## What exists

```
lib/visibility/settings.ts     per-business config (Zod), identity, isRunDue
lib/visibility/queries.ts      normalising, fingerprinting, API input schemas
lib/visibility/verdict.ts      one answer → one verdict (pure)
lib/visibility/summary.ts      probes → rates, coverage, comparison, recurrences (pure)
lib/visibility/store.ts        row mapping, startRun (one row + one job)
lib/visibility/read.ts         what the screens read, assembled once
lib/visibility/propose.ts      drops keyword-shaped leftovers and duplicates before the screen sees them
lib/visibility/manage.ts       the writes: prompt set, import, suggest, settings, run plan, Run now (routes and tools share them)
lib/visibility/sources-to-targets.ts  cited sources → ranked places for the Replies inbox (pure)
lib/visibility/places.ts       the I/O around it: read the run, read redirects back, write the rows
lib/jobs/workflows/aeo-run.ts  the run as a durable job: plan → probe → finish → places
lib/agents/propose-prompts.ts  founder-style questions from the business profile (shown, not saved)

app/api/visibility/            overview, run, queries (CRUD + import + suggest), settings, query detail, places
app/api/cron/probe-visibility  daily scheduler: starts runs whose cadence is due
app/(app)/growth/ai/           the evidence (page), settings/, queries/[id]/ (a question over time)
lib/legacy-redirects.ts        /visibility, /visibility/settings, /visibility/queries/:id to the above, query string kept
lib/growth/read.ts             the evidence (listAiAnswers) and Growth's count, docs/LIFECYCLE.md
```

Migration: `supabase/migrations/20260921120000_ai_visibility.sql`. The loop
to Replies adds one column on another table,
`placement_targets.ai_citation` (`20261110180000_placement_ai_citation.sql`).

## Data model

| Table | What one row is |
| --- | --- |
| `businesses.aeo_settings` | brand spellings, extra domains, engine selection, cadence, per-run cap, `placesFromSources` |
| `aeo_queries` | one configured question, with cluster, intent, enabled flag, source |
| `aeo_runs` | one execution: engines, query count, **query fingerprint**, planned probes, estimated cost, status |
| `aeo_probes` | one question asked of one engine in one run: status, cited, our source URL and position, mention, bounded excerpt, every source verbatim, competitors, error, attempts, latency, estimated cost, probe version |

Deleting a query sets `aeo_probes.query_id` to null; the wording and the
history stay. `user_id` is the RLS key on all three tables, `business_id` the
scope the application filters on. Owners can write only the query set; runs
and probes are the worker's.

## The verdict

`judgeAnswer` uses the shared matching primitives of
`lib/domain/source-matching.ts`, the same ones Growth and the placements
use, so no two surfaces can disagree about what a citation is:

- **cited** — one of the business's domains (site + extras, subdomains
  included, dot-boundary strict via `isCompanySource`) is among the sources.
  Position in the source list is kept.
- **not cited** — the engine answered and none of our domains is among them.
- **invalid** — no prose and no sources. Excluded from the rate.
- **mentioned** — a brand spelling appears in the prose (`findMention`),
  reported beside the citation, never merged into it. Ambiguous one-word
  brands ("Arc") are not counted.

`PROBE_VERSION` is stored on every probe and bumped when the judgement changes.

## The run

`startRun` writes the run row and enqueues an `aeo-run` job. Both "Run now"
(`POST /api/visibility/run`, executed inline for up to 50 s and then handed
to the worker tick) and the daily scheduler go through it.

- **plan** freezes the set: enabled queries (oldest first, capped by
  `maxQueriesPerRun`) × selected engines, one `pending` probe each, and the
  fingerprint on the run. No engine or no query fails the run with a readable
  reason instead of billing nothing.
- **probe** fulfils pending probes three at a time until the tick's deadline
  (`StepContext.deadline`), then throws `StepIncomplete`: the worker releases
  the job at the same step without counting an attempt, and the next tick only
  sees what is still pending. A transient failure (429, 5xx, timeout) is asked
  again once; a vendor `Retry-After` pauses the whole step for that long.
  Everything else is recorded as `error` with the message.
- **finish** writes totals and the summed cost estimate (`runCostUsd` over
  the probes' `cost_usd`, null when none recorded one) on the run row only:
  the step's output, which is the job's result `get_job` returns, carries
  no cost. A run with errors still completes; the probes carry the errors
  and the dashboard shows coverage.

Cost is an **estimate** from published list prices and reported usage
(`CitationAnswer.costUsd`), stored on the run for the operator. A customer
never reads it (owner's decision, 2026-11-14: the plan includes
everything): `RUN_COLUMNS` and `PROBE_COLUMNS` leave `cost_usd` out, so no
`RunRecord`, `ProbeRecord` or `RunSummary` carries it, and neither do
`GET /api/visibility`, the query detail, `list_visibility_runs`,
`get_visibility_overview` or `get_prompt_history`. The screens and
"Run now" say what a run asks (prompts × engines, "Asks Gemini 30 of your
35 questions once"), never a price, and the copy uses "prompt" where the
code says query. Today's engines: Gemini with Google
Search grounding (`CITATIONS_GEMINI=true`, ≈ $0.035 per grounded prompt) and
Perplexity (`PERPLEXITY_API_KEY`, ≈ $0.005 per request plus tokens).

## From sources to Replies

Measuring which pages the engines cite is half of a loop; the other half is
going where they look. A run already stores, per prompt and per engine, every
source each answer returned (`aeo_probes.sources`). Sources cited in answers
that did **not** cite the site become candidates in the Replies inbox
(`placement_targets`, docs/PLACEMENTS.md), so the person can take part in the
thread the engine read, or ask to be on the list it read.

**Selection** (`lib/visibility/sources-to-targets.ts`, pure, no model):

- Only `not_cited` probes count: the engine answered and the site was not
  among the sources. Cited, invalid and failed probes are not read (a
  `scope: "all"` option exists and nothing uses it yet).
- What a page is comes from its address through the one canonicaliser
  (`lib/providers/discovery/canonical.ts`), the same one discovery uses, so
  the same page is the same identity whoever found it.
- **Kept**: a thread, question, post, article or issue on a platform the
  canonicaliser knows (Reddit, Hacker News, Quora, Stack Exchange, Indie
  Hackers, DEV, X, LinkedIn, GitHub issues and discussions); a GitHub
  repository only when it is an awesome-list; and on the open web only a
  **list article**, recognised by its title or the words of its address
  (best, top N, alternatives, vs, tools for, compared, and "best" in a few
  other languages). A list article is stored as surface `web`, kind
  `listicle`.
- **Left out, and counted**: the site's own domains (`own_site`), any page
  on a known competitor's domain, list-shaped or not (`competitor`), every
  page with nowhere to take part, such as a homepage, a product page, a
  profile, a project's repository or a plain article (`not_a_place`), and a
  source whose page address could not be read (`unread`, below).
- **Ranked** by how many prompts cited the page, then how many engines, then
  how many answers. It is an order, not a rate, and no number is shown for
  it. A page cited for three prompts on two engines comes before one cited
  once.
- The inbox's deterministic rules (`lib/placements/rules.ts`) run on every
  candidate before it is stored: behind a login, an archived Reddit thread
  (by id, since an answer gives no date), a promotional title. The topical
  rule is not asked: the only words known are a title, and the citation for
  the site's own prompt is the evidence of the topic.
- **Capped**: at most `MAX_NEW_TARGETS_PER_RUN` (10) new rows per run. Pages
  past the cap are not stored. They rotate in on their own: a page already
  in the inbox is never created again, so the next run takes the next best.

**One engine does not return the page.** A grounded Gemini source is a
Google redirect with the domain as its title (`lib/providers/citations/gemini.ts`).
The domain is enough to judge "were we cited"; "reddit.com" is not a thread.
So the most promising redirects are read back to the address they point at
(`lib/providers/citations/resolve.ts`): one HTTP request each to the
vendor's own redirector, the `Location` read and the page itself never
fetched, no key, nothing billed, at most `MAX_SOURCE_LOOKUPS_PER_RUN` (40) a
run, platform hosts first. The redirects expire, so an old run may no longer
resolve. Whatever is not read is counted as `unread` and left out; nothing
guesses a page from a domain. This lookup has not been exercised against the
live redirector from this repository's tests (they stub it); if the vendor
changes the redirect's shape the count of `unread` is where it shows.

**What a row is** (`targetRowOf`): `found_via` and `qualified_by` are
`ai_visibility`, status `qualified` with no score and no angle (the verdict
is the citation, not a model's or a person's), `found_for` and `aeo_query_id`
are the first prompt, and `ai_citation` records the sighting: the run, and
per prompt the engines whose answer cited the page. What an answer does not
say stays null: the text, the date, the engagement. The title is the
engine's when it gave one; otherwise it is the words of the address
("best_ai_seo_tools" → "best ai seo tools"), or the address itself.

**When it runs.** By itself, as the last step of every `aeo-run` job
(`places`, after `finish`), whoever started the run: the daily scheduler
calls `startRun`, and Run now and `run_visibility_check` call
`startVisibilityRun`, which calls it too, so all three are the same job.
Only a site whose owner turned `placesFromSources` off
(`/growth/ai/settings`, "Places to reply") skips it. **On by default since
2026-11-13** (the owner: the button "Find places from the last run" was not
understood, and a free step should not wait for a tap). The rule "cost never
switches itself on" holds, and was checked in the code before the default
moved: finding places reads stored probes and asks no engine or model; a row
it creates is `qualified` with `found_via` = `ai_visibility` and no angle,
and nothing drafts or judges such a row by itself. The weekly discovery
judges only `discovered` rows and re-judges only rows whose angle is a
pitch (`loadPitchAngled`; no angle is not a pitch); the daily X job drafts
only its own finds (`found_via` = `x_search`); the X media lookup runs only
for a post a person adds. The draft, the one paid step, starts only from a
person's Draft it (`requestDraft`) or a person adding a post. A stored
`false` is the owner's choice and is kept; only an absent value takes the
new default (no site in production had one stored on 2026-11-13).

The step waits for the next worker tick (`StepIncomplete`) when fewer than
`PLACES_MIN_TIME_MS` (15 s) are left: a run whose probes used up the tick
would otherwise start the lookups with no time for them, and every redirect
not read back would be left out for good, since a completed step does not
run again. The run itself is already `completed` by then; its places follow
within one tick (5 minutes).

By hand, whatever the setting: the `find_places_from_last_run` tool (write,
free), and `POST /api/visibility/places` for a signed-in session, for a
latest run that finished with the setting off or to take the pages a run
left past the cap. No screen has a button for it any more. All of
them call `findPlacesFromRun` (`lib/visibility/places.ts`). No engine is
probed again and no model is called; nothing is drafted and nothing is sent.

**What the screens say.** Growth's AI block says in one line how many
pages the answers cited are open as places to reply ("4 pages the answers
cited are in Today, as places to reply. Open them", the link being the
reply inbox narrowed to cited rows, `?source=ai_visibility`). The count is
every open row that rests on a sampled citation (`countCitedPlaces`,
`lib/visibility/read.ts`, `places.open`), whichever run sent it. No places,
or a count that could not be read, is no line, never "0". With the setting
off the line is "Cited pages are not sent to Today. Turn it on in Configure"
(`PlacesLine`, `components/visibility/places-line.tsx`). On the evidence
page each answer says how many of its pages are places, and marks them. The inbox
card says "Cited in a sampled AI answer for: “<prompt>” (<engine>)".
Sampled, per engine, and never that the engine "reads" the page: one answer
on one day cited it.

## The evidence: Growth → AI answers (2026-11-14)

The owner asked "how do we verify a citation?". `/growth/ai` (the old
dashboard `/visibility` redirects there, query string kept) is the answer:
every answer of the period, newest first, one card each, from
`listAiAnswers` (`lib/growth/read.ts`, also `list_ai_answers` and GET
/api/growth/answers), filterable by engine (`?engine=gemini`) and period
(`?days=28`):

- the engine and the day, the verdict ("Cited you", "Not cited", or, not
  counted, "No readable answer" and "Failed" with the error), and the
  question as it was asked;
- the sources the engine returned, numbered in its order, verbatim: the
  site's own highlighted and marked "you"; a page that is an open place to
  reply marked "in Today". A source is "in Today" when its page is the
  place's page (the canonical identity the inbox stores,
  `lib/providers/discovery/canonical.ts`), or, for the engine that returns a
  redirect naming only the site (Gemini), when this very answer's run,
  prompt and engine sent one place on that domain and the domain is in the
  list once. Two sources on that domain cannot be told apart, so neither is
  marked, and the card's line still says how many places came from the
  answer ("2 of these pages are places to reply in Today"). The first five
  sources are shown and the rest fold behind "All N sources", except the
  site's own and the places, which are never folded away;
- "Read the answer" opens the stored start of the answer (the excerpt, said
  to be one: not the whole response), and "This question over time" the
  question's history (`/growth/ai/queries/[id]`, the old query detail);
- an article check (docs/CITATIONS.md, "One count of asks") is a card too,
  marked "article check": it keeps the verdict and, when cited, the cited
  page, and says so instead of drawing an empty source list.

Under the list: "Questions we ask · N · Edit" (the prompt set, on
`/growth/ai/settings#prompts`), **Run now** (what it asks is said: "Asks
Gemini 30 of your 35 questions once", the per-run cap applied) and
**Configure** (`/growth/ai/settings`, the old `/visibility/settings`). A run
in progress is polled and its answers appear as they come. The old
dashboard's tabs (lead sentence, competitors, recurring sources, previous
runs) are not on a screen any more; their numbers stay on the API
(`get_visibility_overview`, `list_visibility_runs`).

## Configuration

| Where | What |
| --- | --- |
| `/growth/ai/settings` | queries, brand names, extra domains, engines, cadence, cap. Suggest prompts proposes 8–12 founder-style questions from the profile; they enter the set only after the owner picks. |
| `/api/cron/probe-visibility` | daily (05:30 UTC), `CRON_SECRET`; starts runs whose cadence is due, for owners who pay only (`hasPaidAccess`; the others are logged as `cron.unpaid_skipped`, docs/AGENT_RUNTIME.md) |
| cadence | `off` (default), `weekly`, `monthly`; due is measured from the last run's *start* |
| engines | the configured ones the business selected; empty means all configured |
| `MAX_QUERIES_PER_RUN` | 60; the per-business cap defaults to 30 |
| `placesFromSources` | on (default since 2026-11-13): each run ends by sending its cited places to Replies, at most 10 new ones, free (above); off: the run skips it |

Cadence is off by default because every probe is a paid call and a key
existing is not consent to spend. "Run now" always works. "Import from
keywords" seeds the set verbatim, free, with no model rewriting. "Suggest
prompts" is the optional rewrite: one model call from the business profile,
shown for review, not inserted until the owner picks. A query they did not
see is a probe they cannot interpret. The suggestion's agent run is recorded
by the service role (`agent_runs` has no insert policy for users; the route's
own client used to be refused silently).

Over the API (docs/API.md), the two calls that spend say what they will
spend first: `run_visibility_check` answers `confirmation_required` with the
planned probes (enabled prompts up to the per-run cap, times the engines the
site chose among the configured ones: `planVisibilityRun`) until it is sent
with `confirm: true`, and `update_visibility_settings` turning a cadence on
needs the `spend` scope and the same confirmation, with the probes per run
and per month.

## Tests

- `tests/visibility/verdict.test.ts` — invalid ≠ not cited; subdomain yes,
  lookalike no; mention apart from citation; ambiguous brands not counted;
  competitors never invented; cadence due rule; tolerant settings.
- `tests/visibility/summary.test.ts` — null rates over nothing; invalid and
  error excluded from the rate and counted in coverage; per-engine, never
  averaged; comparison refused across different query sets, engines or a
  partial previous run; the lead sentence names the per-engine result and
  who was cited instead, and withholds the arrow without hiding the result;
  gains/losses only between readable answers.
- `tests/visibility/primitives.test.tsx` — a count under 10 readable answers,
  the count behind a percent from 10, and no screen with a bare percent
  helper that skips the threshold; `tests/visibility/read-routes.test.ts`
  and `tests/tools/read-visibility.test.ts` — the comparison carries the
  previous run's counts.
- `tests/visibility/aeo-run.test.ts` — the set is frozen before anything is
  asked; re-planning adds nothing; negatives, invalid and errors stored as
  three things; transient retry then give up; Retry-After yields; deadline
  yields and the next call finishes; totals and cost on the run.
- `tests/visibility/sources-to-targets.test.ts` — only answers that did not
  cite the site are read; own and competitor pages and pages with nowhere to
  take part are left out and counted; a list article is its own kind and
  passes the rule that rejects a plain web page; prompts, then engines,
  decide the order; the cap, and the next run taking the next pages; a
  redirect nobody read back is `unread`, never guessed; the row fills in
  nothing; the words say sampled and name the engine.
- `tests/visibility/places.test.ts` — the same page is never two rows; a row
  discovery stored is reused and keeps its verdict; another site's row is
  untouched; the cap across the write; the setting is on with nothing
  stored and a stored `false` is kept; the run's `places` step does nothing
  with it off, creates rows that start no job, draft or model run with it
  on, and waits for a tick with time to read the sources back; a list
  article is refused a draft; the migration only adds a column.
- `tests/visibility/aeo-run-places.test.ts` — through the real worker, a
  scheduled run and Run now (`startVisibilityRun`, the route's and the
  tool's) both end with their cited pages in Replies and no job but the run;
  a second run adds no duplicate and the overview counts the latest run's
  pages; a site with the setting off gets none and its run still completes.
- `tests/visibility/places-line.test.tsx` — Growth's line: the count with
  its link, the pointer to Configure when off, nothing for 0 or unreadable;
  no screen has a "Find places" button.
- `tests/growth/ai.test.ts`, `tests/growth/growth-view.test.tsx`,
  `tests/tools/read-growth.test.ts` (2026-11-14) — the evidence: a source is
  "you" by the site's domains and "in Today" by the page's identity, a
  redirect only when this answer sent one place on its domain and the
  domain is there once; the site's own and the places never folded away; an
  article check says what it keeps; an unreadable answer is not counted;
  `list_ai_answers` pages and filters by engine, and another site's answer
  never shows.
- `tests/tools/find-places.test.ts` — the tool is a free write on the
  caller's site, refused to a read key, and the route answers the same.
- `tests/visibility/propose.test.ts` — keyword-shaped leftovers and duplicates
  never reach the screen; a short filtered list is kept rather than filled.
- `tests/agents/propose-prompts.test.ts` — the agent returns the schema, drops
  unknown intents, and does not invent competitor brands in the prompt when
  none were listed.

## Not in this slice

- Proposing prompts from the FAQ headings the articles already carry. Suggest
  prompts uses the business profile, keywords and listed competitors instead.
- Widening citation probing to placement URLs (`docs/PLACEMENTS.md`, step 6).
  The query detail already lists placements linked to a query.
- For a list article, a drafted outreach note to its author, and a way to
  record "I asked". Today the card says to ask and offers the page; nothing
  is written. The author's contact is not looked up either.
- The text of a cited thread. An answer gives an address and sometimes a
  title, so a draft asked for on such a row is written from the title alone.
- Sources of answers that did cite the site (`scope: "all"` exists, unused),
  and reading a cited page's real title when the engine gave only a domain.
- A third engine. One file in `lib/providers/citations/` plus an env var.
