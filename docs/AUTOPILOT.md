# Autopilot

The product publishes one article a day, but a day only gets an article when
the customer puts a keyword on the calendar by hand. Six keywords meant six
days and then silence, even with more keywords sitting unused in the pool.
Someone who came back after nine days found three empty days, and an empty day
cannot be recovered later.

Autopilot closes that gap: it keeps the calendar filled ahead, and tops up the
keyword pool before it runs dry.

## What exists

```
lib/automation/settings.ts       per-business preferences (on by default since 2026-11-24)
lib/automation/autopilot.ts      the planning, pure and tested
lib/automation/questions.ts      questions people ask into the pool, free
lib/automation/run-status.ts     what the last run did for a site, and why, in words
app/api/cron/autopilot/          the daily sweep
app/api/business/automation-settings/   read and write the settings
app/(app)/settings/automation/   the customer-facing page (Settings → Autopilot)
```

Migrations: `supabase/migrations/20260828120000_automation_settings.sql`;
`20261124100000_businesses_autopilot_run.sql` (the run record, below).

Since 2026-11-14 Settings → Autopilot has two halves: "Topics and schedule"
(these settings) and, under `#images`, "Images and video" (the media
settings, docs/MEDIA.md), which had a page of their own at
`/settings/generation`; that path redirects to the section. Each half saves
on its own, to its own route and tool (`update_automation_settings`,
`update_media_settings`). `/settings/automation#images` links to the
second half; the Getting started checklist has no step to turn Autopilot or
images on since 2026-11-24 (below), and its step "Choose your image style"
links there (docs/MEDIA.md).

## Thresholds, not a quota

The obvious design is "generate N keywords a day". It is wrong: it keeps
producing for someone who is away for a month, and they come back to thirty
articles nobody asked for, each of which cost money to write.

So both halves are threshold-driven:

- **The calendar** is filled up to `bufferDays` ahead (default 14). Days that
  already carry an article are skipped, which is what makes the sweep
  idempotent: running it twice in a day changes nothing.
- **The pool** is topped up only when it falls below `keywordFloor` (default
  10), and only up to that floor, never more than `maxKeywordsPerRun` at once.

Cost stays proportional to the buffer rather than to how long the customer has
been away.

## Order of operations

First, free fuel: up to 3 "Questions people ask" go into the pool (below).
Then scheduling runs before generation, deliberately. A pool that is still healthy
gets used first; generating first would buy keywords the calendar did not need.

If generation did run, the same sweep then fills any days still empty from the
keywords it just bought. A new site with Autopilot on and an empty pool used
to wait until the next morning for a calendar; the first article would land
two days out. The second pass does not buy extra keywords and still refuses
today and the past.

The cron runs at 06:00 UTC, before the 08:00 generation sweep, so the work is
already on the calendar when generation looks for it.

## What it refuses to do

- **Never today or the past.** The generation cron has already run for those
  days, so an article scheduled there would sit unproduced forever.
- **Never a day twice.** A clash between the read and the write is skipped, not
  retried: the day is covered either way.
- **Never past the caps.** `maxSchedulesPerRun` and `maxKeywordsPerRun` exist so
  a misconfigured buffer, or a bug, cannot schedule a year of paid work in one
  run.
- **Never two articles on one topic.** A keyword whose near-duplicate is
  already scheduled, being written or published is not scheduled, and of two
  duplicates in the pool only the better-scored one is
  (`withoutOverlapping`); a suggestion that overlaps a keyword the site has,
  a published article or another suggestion is not bought
  (`freshSuggestions`). Overlapping keywords do not count as fuel either, so
  a pool of duplicates still triggers the top-up. What was left out, and
  why, is in the response's `notes`. The rule and its limits:
  docs/INTELLIGENCE.md, "Overlapping topics". Autopilot never deletes a
  keyword or an article for overlapping.
- **Never for an owner who does not pay.** The sweep runs on the service
  role, where the screens' paywall does not reach, so it asks
  `hasPaidAccess` (`lib/paid-access.ts`, the paywall's own rule) once per
  owner per run (`paidOwners`). A business whose owner has no active
  subscription is skipped whole: no keyword is bought (a model call) and no
  day is scheduled (every scheduled article is one the generation cron pays
  to write). It is logged as `{"event":"cron.unpaid_skipped","cron":
  "autopilot",…}`, and the response counts it in `skippedUnpaid`. A
  subscription that cannot be read counts as not paid (`reason:
  "subscription_unreadable"`, a warning): the calendar waits a day rather
  than being filled unverified. When the subscription comes back, the next
  run picks the business up again; nothing is lost but the days in between.
- **Never without a destination the person connected.** It schedules; the
  generation sweep writes, and an article is delivered only to the
  destination the person connected for the site (WordPress, the webhook).
  With none, written articles wait on the calendar.

## On by default (2026-11-24)

The owner's decision: product features are on, the person does not have to
enable them, and the experience stays simple. `enabled` and `pushPage3`
default to true (`lib/automation/settings.ts`); `backLinks` already did.
Images have no switch at all: they are on for every site once the person
has chosen the image style, and articles go out without images until then
(docs/MEDIA.md). Videos default to on too, and so does the weekly AI
visibility run (docs/AI_VISIBILITY.md).

- **Why Autopilot may be on by default.** Publishing a scheduled article on
  its day was already automatic, through the destination the person
  connected; Autopilot only keeps that calendar filled. Every article sits
  on the calendar `bufferDays` ahead (14 by default) and can be removed
  before it is written. The writing is the platform's cost, inside the
  owner's paid access and AI limit, and every run keeps its ceilings
  (`maxSchedulesPerRun`, `maxKeywordsPerRun`).
- **The switches stay, as opt-outs.** Settings → Autopilot keeps "Keep the
  calendar filled" and "Push articles stuck on pages 2 to 4", ticked unless
  the person unticked them; a stored `false` is kept and no data migration
  rewrites it. The page never asks the person to turn them on.
- **No more asking.** The Getting started checklist lost its "Turn on
  Autopilot" and "Turn on article images" steps (`lib/onboarding.ts`), and
  the Overview's next action with them. The same day it gained "Choose your
  image style", right after About you: what images need from the person is
  their look, not a switch (docs/MEDIA.md). Over the API,
  `update_automation_settings` no longer answers `confirmation_required` for
  `enabled: true` or `pushPage3: true`: setting one back on after the person
  turned it off still needs the scopes a key must hold for it (spend and
  publish; spend), and `confirm` is accepted and not needed.
- **The directory reviewers' demo site** (`lib/reviewer-account.ts`) is
  written opted out of each, because it is not a customer.

## Every site, and every run says what it did (2026-11-24)

An owner with two sites, both with Autopilot on, saw the newer one fill
every day and the older one stay empty for weeks, while its Content screen
read "Autopilot on". Nothing in the product said why. What the sweep had
for that site went into its own JSON `notes`, which no customer reads.

Three changes, all in the same sweep:

- **Every site, oldest first.** The sweep reads the businesses ordered by
  `created_at` and keeps the ones with Autopilot on; the cap of 50 counts
  those, not rows, and a run that leaves sites for later says how many in
  `notes`. Before, a bare `limit(50)` over an unordered read could leave a
  site out of every run without a word. The paid check is still once per
  owner (`spendingOwners`), so two sites of one account get the same answer.
- **The run record.** At the end of every run for a site with Autopilot on,
  the sweep stores `businesses.autopilot_run`: when, how many articles it
  scheduled, topics it bought, questions it added, the days of the buffer
  still empty after it, and the reasons it did less than the calendar
  needed, each as a code and a sentence (`lib/automation/run-status.ts`):

  | code | when |
  |---|---|
  | `no_plan` | the account has no active plan: the site was skipped whole |
  | `ai_limit` | today's AI limit reached: new topics wait, scheduling went on |
  | `ai_paused` | AI work paused for billing: the same |
  | `pool_overlaps` | days stay empty and topics in the pool were held back, each overlapping one already covered |
  | `no_new_topics` | the top-up was paid for and every suggestion overlapped a topic the site has |
  | `days_empty` | days stay empty and no schedulable topic is left |
  | `failed` | the run stopped with an error for this site; tried again next run |

  A run with no reason did what the calendar needed. A site with Autopilot
  off gets no record. The write is the service role's; a failed write is a
  note, never a failed run. The Content screen's top line, `get_content`
  (`autopilotRun`) and Settings → Autopilot say it: "not run yet" (with the
  06:00 UTC time), what the last run did, or, in amber, the reason that
  explains the empty days first. The readers read the column on its own, so
  a database without the migration reads as "no run recorded" rather than
  breaking the screen. Settings → Autopilot also names the site it sets:
  each site has its own setting.
- **The top-up is told what the site covers.** A site with a long history
  (dozens of published articles) got suggestions on its own ground, every one
  refused by `freshSuggestions`, from a call that was paid for, every day.
  The one suggestion call now lists the site's published titles and keywords
  (`avoid`, at most `AVOID_TOPICS_MAX` = 80, `lib/research/keywords.ts`) and
  asks for new ground. Still one call per site per run; code still checks
  every suggestion, and when none survives the run says `no_new_topics`.

## Questions people ask, on their own (2026-11-14)

Discovery stores the public threads that ask about the site's topics
(`placement_targets`, docs/PLACEMENTS.md), and "Questions people ask"
(docs/INTELLIGENCE.md) turns their titles into topics. Until 2026-11-14 a
person had to add each one from the Keywords page. With Autopilot on, the
sweep now adds them itself (`addAskedQuestions`, `lib/automation/
questions.ts`), before it schedules:

- **At most 3 a site a UTC day** (`MAX_QUESTIONS_PER_DAY`). The cap counts
  every question topic created that day, the person's own adds included, so
  a second run on the same day adds nothing.
- **In the ideas' order**: most threads first, then most recent.
- **Never a duplicate.** The ideas already leave out a question a keyword or
  an article covers; `questionsToAdd` then drops one the site has letter for
  letter, or that overlaps a keyword, a published article or an earlier idea
  (`findOverlaps`, the rule every add follows), and `addKeywords` checks
  both again with the thread, which must be one of the site's.
- **Stored as what it is**: `source` "question", the thread in `source_url`,
  every figure null (docs/INTELLIGENCE.md). It scores as any keyword with no
  figures, so it is written after the high-opportunity ones.
- **Behind the opt-in**: only for a site with Autopilot on, only for an
  owner who pays (the sweep skips a lapsed owner's site whole, as before).

What it costs, worked out before switching it on: nothing. The ideas are
rows discovery already stored and paid for; the check reads the site's own
keywords and articles; no model and no provider is called. A topic in the
pool costs nothing until a day is scheduled for it, and Autopilot schedules
one a day whatever the pool holds. It saves money where it does anything:
questions count as fuel, so a pool they keep above `keywordFloor` buys no
keywords (one model call a top-up). A failure here is a note in the
response and leaves the rest of the site's run untouched; the response
counts `questionsAdded`.

Keywords the sweep buys are stored with `source` "autopilot", and a person's
adds with "manual" (`lib/keywords/source.ts`), so the Content screen can say
where each topic came from. Rows from before 2026-11-14 keep `source` null:
nothing tells a typed keyword from a bought one, and the screen says
"Source not recorded" instead of guessing.

## The buffer is also the review window

Scheduling two weeks ahead is not just a supply decision. An article sits
visible on the calendar for those two weeks before anything is generated, so
the customer can delete it first. That is the answer to the obvious objection
that autopilot turns the product into the content mill it positions against:
nothing is written without having been visible and cancellable for days.

## Choosing what to write next

`keywordScore` folds the stored fields into one number: opportunity dominates,
ease of ranking breaks ties within it, search volume breaks ties after that. A
high-opportunity hard keyword still beats a low-opportunity easy one, because
the point is the result, not the ranking.

## A week's mix (2026-11-15)

Score alone wrote one kind of article: the business's own category, over and
over ("AI content writer", "AI content creation tool", "AI SEO content
writing"…). The blogs that grow mix the searches their buyers make on the
way: how-to and support questions about the tools the audience uses ("how to
change X username", "X account locked"), bottom-funnel comparisons
("typefully alternatives", "climbx vs superx", "supabird review", "best X
growth tools") and problem questions ("why do my posts get no views"). The
evidence was climbx.so's sitemap: 145 posts since May 2026, deliberately
mixed. Every topic now carries its intent (`keywords.intent`, docs/
INTELLIGENCE.md, "Search intent of a topic"), and the calendar is filled
toward a mix.

**The rule** (`WEEKLY_MIX` and `takeWeek` in `lib/keywords/intent.ts`,
applied by `planSchedule`):

| Intent | Per 7 days | |
| --- | --- | --- |
| `comparison` | 1 to 2 | at least 1, never a 3rd while anything else is left |
| `platform_howto` | 2 | |
| `problem` | 2 to 3 | |
| `product_adjacent` | the rest | |

- **Weeks are counted back from the buffer's last day** (offsets 8–14 and
  1–7 for the default 14), so the one day a daily run adds is weighed with
  the six booked before it, and what those days already hold counts (the
  intent of each booked article's keyword, read in the same query as the
  dates).
- **In each week, minimums first**: one intent at a time in turn, the one
  furthest below its minimum first (problem, then how-to, then comparison
  on a tie), each time that intent's best-scored topic. Then the rest by
  score, skipping an intent at its maximum; when only those are left, the
  best of them anyway: an empty day is worse than a third comparison.
- **Within a week, best first**: the chosen topics go on its free days in
  score order, the earliest day getting the best.
- **"When available"**: an intent the pool does not hold is not invented
  and not bought on purpose; the day goes to the best topic there is.
- **Nothing else moved**: the overlap guard runs first, exactly as before
  (`withoutOverlapping`); never today, never a day twice, the caps; a pool
  with no intents is scheduled by score alone, the old order exactly
  (pinned in the tests).

**The top-up asks for the mix, and buys toward it.** When the pool falls
below the floor, the one suggestion call it already made is now given the
products and platforms the site's own data names (`loadNamedTools`, three
reads: its knowledge graph, the domains that rank for its keywords, the
domains AI answers cited) and asked for comparisons, platform how-tos and
problem questions beside the core topics, naming nothing else. Code then
holds it to that (`settleSuggestions`): a comparison naming a product the
data never named is not bought (a note says so), each idea gets its intent,
and a comparison, how-to or problem idea is stored with no volume and no
CPC. Of the fresh ideas, the ones bought are the kinds the pool lacks most
(`chooseForPool`): the call returns 15 to 25, the floor asks for a few, and
choosing among them costs nothing. No new paid call, no call per topic,
nothing bought beyond the floor: cost is what it was.

**Topics from before.** A pool row with `intent` null (stored before
2026-11-15) is classified by the rules on the sweep's next run for its site,
and the verdict written (one update per intent, the site's rows only), so the
Content screen reads what the sweep schedules by. A site with Autopilot off
keeps null rows; every reader computes the same rules' verdict for them.

**Next topics** on the Content screen ("Picked next", under the calendar;
`nextTopics`, `lib/calendar/content-plan.ts`) lists the pool in the mix's order from an empty week
(`mixOrder`), each with a small tag beside its source: Comparison, How-to,
Problem, Core topic. The sweep also counts what the calendar already holds,
so the first topic listed is not always the one tomorrow's run picks.

## Tests

`tests/automation/autopilot.test.ts` pins the restraint: no past days, no
double booking, idempotence on a second run, the caps, an empty pool, and the
settings defaulting to on (Autopilot, Push page 3, back-links) with a stored
false kept.
`tests/cron/unpaid-owners.test.ts` pins that a lapsed owner's business gets
neither keywords nor scheduled days, and is logged.
`tests/automation/questions.test.ts` pins the question top-up: the cap of 3
a UTC day across runs and the person's own adds, no overlap, every figure
null, no table but the site's own; `tests/cron/autopilot-questions.test.ts`
that the sweep adds them only with Autopilot on, schedules from them in the
same run, and stores what it buys as `source` "autopilot".
`tests/automation/autopilot.test.ts` ("a week's mix") and
`tests/keywords/intent.test.ts` pin the mix: an empty week's minimums, the
day a daily run adds weighed with the booked six, the maxima, the score
order kept for a pool with no intents, and `chooseForPool`;
`tests/tools/write-business.test.ts` pins that `enabled` and `pushPage3`
default to on, that turning them off is kept, and that turning them back on
needs the scopes and no confirmation. `tests/cron/autopilot-intent.test.ts` that the sweep asks once with the
site's names, buys no comparison of a product the data never named, stores
intents and no volume for the new kinds, and classifies old rows, and
that the call lists what the site already covers.
`tests/cron/autopilot-all-sites.test.ts` pins two sites on one account: both
swept, oldest first; the older one, whose pool all overlaps what it
published and whose top-up finds nothing new, stores why
(`no_new_topics`, `pool_overlaps`, `days_empty`) instead of saying nothing,
and fills once the top-up finds new topics; a site of an account with no
plan stores `no_plan`; a site with Autopilot off gets no record; a covered
calendar has no reason. `tests/automation/run-status.test.ts` pins the
words and the order of the reasons, `tests/research/keywords-avoid.test.ts`
the bounded list, `tests/tools/read-content.test.ts` and
`tests/dashboard/content-screen.test.tsx` what `get_content` and the screen
say.

## Back-links are not Autopilot

`automation_settings.backLinks` lives beside these settings (same column,
same form, same tool) but does not depend on `enabled`: when any article is
published, up to 3 older related articles get one link to it
(docs/KNOWLEDGE.md, "The back-link pass"). On by default, because it costs the platform a
cent or less per published article (the screen and the tool name no price:
"Included in your plan"); Settings → Autopilot, "Link older
articles to new ones", turns it off.

## Push page 3 is not Autopilot either (2026-11-15)

`automation_settings.pushPage3` sits in the same column, form and tool,
independent of `enabled`, and is **on by default since 2026-11-24** (it was
off before): one fast-tier model call per pushed article, paid by the
platform, and its changes reach published pages through the same update
path the back-link pass already used. Settings → Autopilot, "Push articles
stuck on pages 2 to 4", turns it off; through the API,
`update_automation_settings` with `pushPage3: false` stops it, and `true`
needs the `spend` scope (no confirmation). Once a week
(`/api/cron/push-articles`, Wednesday 09:40 UTC), for a site whose owner
pays and is under the spend ceiling, up to 3 articles Google shows at an
average position of 11 to 40 get one link each from up to 3 of the site's
best related pages and a tighter meta title and description around the
search they are shown for. What it picks, how, what it costs and how it is
measured: docs/LIFECYCLE.md, "Push page 3". A push of one article on demand
(`push_article`, the article modal) needs no switch: asking is the consent.

## Not in this slice

- Cadence other than one article a day.
- Pausing autopilot when a publishing integration is broken, so it does not
  pile up articles that cannot be delivered.
