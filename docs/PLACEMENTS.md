# Off-site placement (Replies)

The platform optimises a site to be citable and measures whether answer
engines cite it. Placement covers the other half: finding public
conversations where the site's owner can give a genuinely useful answer
(Reddit, X, GitHub, LinkedIn, Hacker News, Stack Exchange, Quora, Indie
Hackers, DEV), drafting that answer in the owner's voice, checking it, and
measuring what happened after a person posted it.

This document describes how the system works. It is the reference for the
code under `lib/placements/`, `lib/providers/discovery/`, `lib/providers/x/`,
the agents `placement-qualify` and `placement-draft`, and the inbox
(`/placements`, Today).

## The principle: the product finds and writes, a person publishes

Nothing is posted by the platform on its own, on any surface. The unit of
work is **a placement proposed and ready**: a person reads it, edits it if
needed, opens the original (or X's web intent) and posts it themselves,
then marks it as posted.

One exception since 2026-11-24, on X only (the owner's decision: "X must be
connected because we will also post through GTF"): a site may connect the X
account it posts from, and a reply to a post X allows an app to answer gets
a **Post on X** button. One press posts that reply from that account (see
"Post on X: only where X allows it" below). Never on its own, never on a
schedule, never on any other surface; replies to people who did not mention
the account stay exactly as they were.

Three reasons, all technical or contractual:

- automated posting gets accounts banned, and platform filters remove
  repeated links;
- an unreviewed automatic answer is the low-quality text communities remove;
- several platforms' terms forbid automated posting.

## Shape

Same layering as the rest of the platform:

- **Providers** (`lib/providers/discovery/`): where the conversations are.
  One interface, `search(query) → Discussion[]`, one file per surface
  (`reddit.ts`, `github.ts`, `web-search.ts`), plus the X API client
  (`lib/providers/x/api.ts`). No platform is named above this layer.
  `canonical.ts` reduces any public URL to one identity (surface, kind,
  external id), so the same thread found by two providers is one row.
- **Domain** (`lib/placements/`): the lifecycle (`workflow.ts`), the
  deterministic rules (`rules.ts`), the verdict logic (`qualification.ts`),
  the gate (`audit.ts`), storage of what was found (`discovery.ts`), what the
  inbox reads (`read.ts`, `inbox-view.ts`, `today.ts`).
- **Agents**: `placement-qualify` (is this worth answering, and is there an
  angle?) and `placement-draft` (write the variants). `draft-correct`
  rewrites a draft after a person's note. The audit is **not** an agent: it
  is deterministic code, so the same text always gets the same verdict and
  every check names itself.
- **Jobs** (`lib/jobs/workflows/`): `placement-discovery` (queries → one
  step per provider → dates → rules → qualify), `placement-draft` (draft →
  audit), `x-post-discovery` (daily X search: the site's topics, then its
  close accounts, see below). `x-close-trial` is a retired type kept only
  so stored rows stay known; nothing enqueues it.
  All durable and resumable.
- **Tables**: `placement_targets` (the conversations found and their
  workflow state), `placements` (draft variants with their audit),
  `placement_metrics` (dated snapshots of a posted reply's public numbers),
  `x_account_metrics` (the site's own X account, one row a day),
  `provider_spend` (the monthly ledger of paid provider calls).

**The gate is the product.** A draft is refused if it is promotional, if it
does not answer the post, or if it fails the test *is this answer still
useful with any link deleted?*

## The flow

```
discovery ─▶ canonical identity + dedupe ─▶ dates ─▶ rules ─▶ agent qualification
   ─▶ draft ─▶ audit ─▶ drafted (only a variant that passed)
   ─▶ (a person posts it by hand)
   ─▶ "I posted it" ─▶ published_manually ─▶ the reply's link
        (on X the platform can find it; elsewhere the person pastes it)
```

## Discovery

Three providers, each degrading on its own; the sweep reports itself
disabled only when none is configured.

| Provider | Needs | Finds |
| --- | --- | --- |
| `reddit` | `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET` (only with an app Reddit has approved; self-serve app creation is closed) | threads with score, comments, author, date |
| `github` | `PLACEMENTS_GITHUB=true` (free, no key) or `GITHUB_TOKEN` (raises the rate limit) | open issues asking for what the business does, awesome-lists in its category |
| `web-search` | `SERPER_API_KEY` (the platform's SERP provider) | public pages on `reddit.com`, `github.com`, `linkedin.com/pulse` and `/posts`, `x.com` posts and articles, Hacker News, Stack Exchange, Quora, Indie Hackers and DEV, via `site:` scopes |

Web search is the universal fallback: when Reddit's API is not connected,
Reddit threads still arrive through it, with what a search result knows
(URL, title, snippet, usually a date) and honest nulls for what it does not
(score, comments). No personal LinkedIn, X or Reddit key is ever asked of a
customer.

The Reddit scope asks the engine only for pages dated within the last 180
days (`SearchScope.maxAgeDays`, sent as Google's `tbs` filter): an older
thread is archived and takes no reply.

Queries come from the site's own keywords, entities and niche
(`buildQueries`), most specific first. One checkpointed job step per
provider means a rate-limited surface costs a resume, never a re-paid run: a
429 stops that provider for the run and is reported, and the others carry on.

Question-shaped titles found here also feed the keyword plan ("Questions
people ask", `lib/keywords/questions.ts`, docs/INTELLIGENCE.md). That is a
read of `placement_targets` and writes nothing here.

**A fourth source: what the answer engines cited.** A visibility run stores
the sources each answer returned. Pages cited in answers that did not cite
the site, where a person can take part or ask to be listed, become rows
here (`found_via` = `ai_visibility`) through the same canonical identity.
No search and no model: the probes are read from the table. Such a row is
`qualified` with no angle, and no job drafts it by itself; the first paid
call on it is a person's Draft it. Details in docs/AI_VISIBILITY.md, "From
sources to Replies".

### Dating what a search found

Every row is dated by the cheapest exact method available, in this order,
and an unknown date is never treated as fresh:

1. **The URL** (`lib/placements/date-from-url.ts`, pure, free, exact): X
   status ids and other snowflake-style ids carry their creation time.
   Applied to every discussion before it is stored (`withUrlDate`).
2. **The platform's free API** (`lib/providers/post-dates/`, no key), in the
   `dates` step of the discovery job, before the rules.
3. **The engine's printed date** (`parseEngineDate`,
   `lib/providers/serp/dates.ts`), which reads both a day ("Jun 6, 2025",
   "6 giu 2025") and a distance ("4 months ago", "vor 4 Monaten"). A
   distance is stored as the **latest instant it allows**, with its unit in
   `posted_at_precision` (`day` · `week` · `month` · `year`): every age
   computed from it is a floor, and the card says "at least 4 months old".

An undated row is judged against the per-platform reply windows
(`reply-window.ts`) by an age it cannot prove, never by when it was found.

### Identity and freshness

- `canonicalTarget(url)`: Reddit thread → post id; GitHub → `owner/repo`,
  `owner/repo#issue`, `owner/repo#dN`; LinkedIn → `pulse:<slug>`,
  `posts:<slug>`; X → `status:<id>`; Hacker News → `hn:<id>`; Stack
  Exchange → `<site>:<question id>`; Quora → `q:<slug>` or
  `space:<space>/<slug>`; Indie Hackers → `post:<slug>`; DEV →
  `<user>/<slug>`; anything else → the normalised URL. A profile, tag
  listing or front page is a `page`, and the rules reject a page on every
  surface. The unique key is `(business_id, surface, external_id)`, and
  `ignoreDuplicates` keeps the first sighting (platform APIs run before web
  search, so the richer row wins).
- **Learning a host later.** Rows stored before the canonicaliser knew a
  host are re-read by the `recanonicalize` step
  (`recanonicalizeLegacyTargets`): the row keeps its id and history and
  moves to its real surface, kind and identity.
- `fresh_until` marks when a row stops being answerable; past it the row
  reads as Expired.

### Qualification

Deterministic rules first (`lib/placements/rules.ts`), each rejection
carrying its rule name in `qualified_by` (`rules:archived`, `rules:stale`,
`rules:own_site`, `rules:not_public`, `rules:not_answerable`,
`rules:promotional`, `rules:too_thin`, `rules:no_overlap`). Unknown date or
engagement is a flag, not a rejection, except where the id proves the age
(`rules:archived`).

Then the agent, on what survived, in batches of ten under a dollar budget.
Two rules live in `lib/placements/qualification.ts` rather than in the
prompt, because a model asked to be strict drifts generous over a long
batch: a verdict below the score floor is rejected whatever the model said,
and **a qualified target with no angle is rejected**. A target nobody judged
stays `discovered`: recording a verdict nobody gave would be worse than
waiting. The verdict names a `topic` and an `intent` for the inbox filters.

- **The cap is dealt per surface** (`pickFairShare`): the qualify step draws
  a pool of the most recently seen rows across every surface, runs the
  rules on it (free), then takes one row per surface in turn, so dated rows
  from one platform cannot starve undated rows from the others.
- **Qualify in parallel** (`QUALIFY_CONCURRENCY` = 6,
  `lib/jobs/workflows/placement-discovery.ts`, through `runBounded`,
  `lib/jobs/bounded.ts`). Same batches, same cap (120 a run) and the same
  dollar budget. A batch starts only while the deadline leaves it
  `BATCH_TIME_MS` and the budget covers it beside the batches in flight
  (`qualifyAdmission`, at an assumed `BATCH_COST_ESTIMATE_USD`).
- A manual run (`POST /api/placements/discover`) is started in the request
  and keeps running after the response (`maxDuration` 300), so it does not
  wait for the next job tick.

## The X API (optional, paid)

Connecting X's official API (pay-per-use, app-only Bearer token) enables
five read-only uses: a daily search for fresh posts on the site's topics,
a daily search of the fresh posts of the accounts the site replies to most
("Close accounts"), the public numbers of the replies a person posted, the followers of the
site's own X account, and finding the link of a reply marked as posted.
None of them posts: a reply is a person's tap on X's web intent, or their
press of Post on X (next section), which uses the site's own connected
account, not this app-only token.

**Opt-in, once, by the deployment.** The deployment turns it on
(`X_API_ENABLED=1` and `X_API_BEARER_TOKEN`; the token alone spends
nothing). Since 2026-11-24 there is no per-site switch: with the deployment
setting on, the X features run for every site (the "Find posts on X"
switch, `voice_settings.findPostsOnX`, is gone; a stored value is ignored,
and a `findPostsOnX` sent by an old page or caller is accepted and
dropped). Without the deployment setting Settings → Connections says it is
not available and nothing is searched or read. The site's owner must have
paid access; the search, which leads to model calls, also needs the owner
under the daily AI spend limit.

**What bounds the cost now.** The per-site switch was also how few sites
took part; without it every paying site does, so every use has its own
bound, per site and per run, all under the monthly cap below:

| Use | Per site | Per run |
|---|---|---|
| Daily search (`x-post-discovery`) | at most once in 20 hours, 3 searches of 10 posts | at most 10 sites, the ones searched longest ago first (`rotateSites`), so every site gets its turn |
| Close accounts (the same job's `close` step) | at most once in 20 hours (the same job), 2 searches of 25 posts over the last 12 hours: at most 50 posts a site a day, and the posts they quote or answer; no call for a site with no reply posted on X in 30 days | the same 10 sites (`X_MAX_BUSINESSES_PER_RUN`), so at most 20 searches a run |
| Reply numbers | each reply once a day for 14 days | one batched lookup of at most 100 replies |
| Followers | one user lookup a day | at most 10 sites, read longest ago first |
| Quoted and replied-to posts | | at most 30 posts |
| Reply links | at most 25 new replies a site in 24 hours (`LINK_SEARCH_NEW_REPLIES_PER_SITE_PER_DAY`), each searched at most 4 times by itself, 6 with `find_reply_link` | at most 10 searches every 5 minutes |

**The site's X account** (`voice_settings.xHandle`, since 2026-11-24).
Finding a reply's link and reading the followers need the account the
site's replies are posted from. `ownXHandle` (`lib/placements/x-handle.ts`)
resolves it per site: the handle the person gave first, else the one the
site's own saved reply links name most often, else none (the jobs skip the
site and the screens ask). It is asked the first time a reply on X is
marked as posted on a site where it is not known, while the platform reads
X: on Today, "Your X account" in the link sheet and on the posted reply's
card; over MCP, `mark_reply_posted` answers `xHandleNeeded: true` with a
sentence, and `update_voice_settings` saves `xHandle`; the `daily_routine`
prompt asks the person then. It is shown and edited in Settings →
Connections → X. Validated as X does: 1 to 15 letters, digits or
underscores, a leading @ dropped, stored lowercased. The daily search and
the close-accounts search also leave the saved handle's own posts out.

**Costs, as configuration.** Unit prices are constants in
`lib/providers/x/api.ts` (`X_SEARCH_USD_PER_POST`, `X_LOOKUP_USD_PER_POST`,
`X_USER_LOOKUP_USD_PER_USER`): X bills per post (or user) *returned*.
They are estimates from published pricing summaries, not X's own price
list: check your provider's current pricing and correct the constants if an
invoice disagrees. `monthlyEstimateUsd` (`lib/placements/x-budget.ts`)
computes a month's worst case from the constants and the configured limits
(searches per run, close-accounts searches per run, results per search,
reply lookups, user lookups, link searches).

**The cap: hard, global, per calendar month (UTC).**
`X_API_MONTHLY_CAP_USD` (default 20). The ledger is `provider_spend`
(provider, month, cost_usd, calls, posts; service role only). Every call
goes through `meteredXCall`: it reserves the call's **worst case** (results
asked for × the unit price) in one conditional UPDATE
(`reserve_provider_spend`), which refuses when the month's spend plus that
would cross the cap, then makes the call and settles the row to the
estimate of what X returned (`settle_provider_spend`). Two callers racing
cannot both slip under the cap; a ledger that cannot be written refuses the
call; a new month is a new row.

**At the cap**, every X call is refused before it is made for the rest of
the month. The operator is alerted once a month (`operator_alerts`, key
`x-api:cap:YYYY-MM`). Replies says, without an amount, that searching X is
paused until the first of next month (`xCapReachedLine`). The month's
spend against the cap is on the owner's `/settings/costs` and in the
owner-only `get_platform_costs` tool (docs/API.md, "The owner's costs").

**Errors.** 401/403: configuration, the run stops. 429: rate limit, with
X's reset time; the run stops. 402 or "credits depleted": billing; every X
call pauses for an hour (`provider_pauses`, kind `x-api`), one operator
alert a day. Timeouts (15 s) and other failures are noted and the next
search is tried. One log line per call (`event: "x_api"`) with the
endpoint, posts returned and the estimated cost.

### Fresh posts and reply numbers from the X API

**The search** (`lib/placements/x-search.ts`, job `x-post-discovery`,
`lib/jobs/workflows/x-discovery.ts`), from the daily cron `/api/cron/x-posts`.

- Queries come from what discovery already uses: the site's keywords, its
  knowledge graph's entities without its own names (`topicsFor`), and the
  niche, cut into the short phrases people post. At most 3 searches a run,
  each an OR of topics AND an OR of question phrases in the site's language
  (see "Conversations, not noise"), plus `lang:<language> -is:retweet
  -is:reply -from:<own handle> -is:nullcast` and a few advert words, under
  X's 512 characters, `max_results` 10, posts of the last 12 hours. The
  topics rotate by UTC day.
- Filter: a post already stored is not stored again; an author the site
  replied to in the last 7 days, the site's own posts, and a post with more
  than 50 replies are skipped. A post without its reply count is kept:
  unknown is not "few".
- Storage: `placement_targets`, surface `x`, kind `post`, `status:<id>`,
  `found_via` = `x_search`, `posted_at` from X, engagement as X reported it,
  `fresh_until` = posted + 24 hours.
- The job's own `rules` and `qualify` steps run the same rules and agent
  (up to 30 rows a run), and `draft` starts drafts for the best qualified
  finds, at most 5 a run, through `startDraft` (each asks the daily draft
  cap; nothing is drafted while About you is empty).
- At most 10 sites a run, the ones searched longest ago first; a site
  searched in the last 20 hours is skipped.

**The numbers** (`lib/placements/x-metrics.ts`, same cron). Once a day, the
replies posted on X with a link (`published_url`), posted in the last 14
days: one batched lookup (≤ 100 ids) for `public_metrics`, stored as a dated
snapshot in `placement_metrics` (one row per reply per UTC day). A number X
did not return is null, never 0; a reply X did not hand back at all gets a
row of nulls, because "asked, nothing came back" is the measurement. These
are X's public counters on one day, a snapshot, not a total.
`metricsLine` (`lib/placements/reply-metrics.ts`) renders the newest
snapshot on a posted item; `get_reply_metrics` reads the snapshots.

### Conversations, not noise

A search that is an OR of topics alone matches a word in adverts, jokes and
news, and each match is a paid read and a paid judgement. So:

- each query is the topics AND question phrases in the site's language
  ("how do i", "anyone know", …; `lib/placements/x-conversation.ts`);
- a rules-only X pre-filter rejects, before the qualifier, posts that are
  link shares, announcements or promotions by their shape;
- the qualifier is told to keep only posts where a reply can take part in
  a conversation.

### The week on X, and the account's followers

`summarizeReplyStats` (`lib/placements/reply-stats.ts`, pure) sums, for 7 or
28 days, the replies posted on X, their views, likes, replies and reposts
with the change against the previous period, the coverage (how many replies
have a link and a snapshot), and the best reply. `loadReplyStats`
(`reply-stats-read.ts`) reads the stored rows only. Growth (`/growth`,
docs/LIFECYCLE.md) shows it; `get_reply_stats` and `get_growth` answer it.

The followers of the site's own X account (`lib/placements/x-account.ts`):
the handle is the one the person gave, else the one the links of the site's
posted replies name (`ownXHandle`), looked up once a day (one user lookup a site, at most 10
sites a run) and stored in `x_account_metrics`. `summarizeFollowers` gives
the change only when both days belong to the same handle and the earlier
one is inside the window; otherwise the change is null.

### The link of your reply, found on X

A reply marked as posted on X with no link is searched for by the platform
(`lib/placements/reply-link.ts` for the rules, `reply-link-search.ts` for
the sweep and the `find_reply_link` tool): the posts of the site's own X
account in that thread,

```
(conversation_id:<thread id> OR in_reply_to_tweet_id:<thread id>) from:<handle>
```

from an hour before the tap to six hours after, 10 results. The cron
`/api/cron/x-reply-links` tries 2 minutes, 15 minutes, 2 hours and 12 hours
after "I posted it", at most 10 searches a run, for any site whose owner
pays and whose X account is known, at most 25 new replies a site in 24
hours (a reply over the bound is pasted, as before). A single match is stored as
the link; several candidates are offered for the person to pick
(`link-match.ts`); none leaves the row as it was.

### The post's images

`lib/placements/media.ts`, `lib/placements/x-media.ts`. A post's photos,
videos and GIFs are stored on the target (`placement_targets.media`, a JSON
list of `{type, url, previewUrl, altText, width, height}`; `null` = never
asked, `[]` = asked, none; `media_unread` when a post has media nobody
could read).

- Found by the X search: the call asks for
  `expansions=attachments.media_keys` and the media fields; expanded media
  are assumed to be part of the post read.
- Found any other way: read from X's public embed (oEmbed), free.
- The drafter receives the images (X's own `*.twimg.com` URLs only) and a
  rule: when the post is about an image, the reply answers what the image
  shows rather than asking for it. An image nobody read fails an advisory
  check and shows a line on the card.

### What the post quotes, and the post it answers

`lib/placements/referenced.ts`. `placement_targets.referenced_posts`, JSON:
`null` = never asked; otherwise two slots, `quoted` and `repliedTo`, each
`null` (not known), `"none"` (asked: there is none) or the post (`id`,
`url`, `text`, `authorName`, `handle`, `postedAt`, `media`, `mediaUnread`,
`note`). `text` null means the post exists and could not be read: unread,
never absent.

- From the X search: `includes.tweets`, counted as posts read; a search
  reserves two of them per post at worst.
- Otherwise: the embed's t.co link is resolved and the post read through
  oEmbed (`quoteHintFromEmbed`), free.
- The drafter and Fix it are told "The post quotes @handle (Name): «…»"
  apart from the post itself (`referencedPostsRule`); the card nests the
  quoted post like X does.

### Close accounts

Part of every site's daily X run since 2026-11-24 (the owner's decision),
after a three-day trial on one site (2026-11-14 to 16) that measured what
it returns and costs. The trial's deployment settings
(`X_CLOSE_TRIAL_BUSINESS_IDS`, `X_CLOSE_TRIAL_UNTIL`) and its cron
(`/api/cron/x-close-trial`, every 3 hours) are gone; a stored value of
either is ignored. There is nothing to turn on: with the X API on for the
deployment, every site whose owner pays takes part.

- **The accounts** (`closeAccountsFrom`, `loadCloseAccounts`,
  `lib/placements/x-close.ts`): the authors of the threads the site replied
  to on X in the last 30 days, ranked by the number of replies then by the
  most recent, at most 25, never the site's own account. Fewer than 5 is
  noted in the run (`fewHandles`); none means no call.
- **The search**: the `close` step of `x-post-discovery`, after the topic
  search. At most 2 recent searches (`X_CLOSE_QUERIES_PER_RUN`), `from:` the
  accounts, filtered on X's side to fresh original posts
  (`-is:retweet -is:reply lang:<language>`), `max_results` 25
  (`X_CLOSE_RESULTS_PER_QUERY`), since the step last ran for the site, never
  more than 12 hours back (`closeWindowStart`, `X_CLOSE_WINDOW_HOURS`). Each
  search goes through `meteredXCall` under the monthly cap. Checkpointed: a
  resumed job never pays for it twice.
- **Stored** with `found_via` = `x_close`; the job's `rules`, `qualify` and
  `draft` steps then take both sources together, under one qualifier budget
  (30 rows) and one draft ceiling (5 a run). In Today these posts look like
  any other found on X.
- **Bounded by the daily job**: once in 20 hours a site, at most 10 sites a
  run in rotation (`rotateSites`), the owner paying and under the AI limit,
  the monthly X cap before every call. One log line a run,
  `event: "x_close"` (accounts, calls, posts returned, stored, estimate).

## Post on X: only where X allows it

Since 2026-11-24 (owner's decision). X restricted programmatic replies on
its self-serve access in February 2026: a reply through `POST /2/tweets` is
allowed only when the author of the post being answered @mentioned the
account, or quoted one of its posts (else 403; Enterprise is exempt). A
standalone post, and a reply in one's own threads, are always allowed. So:

- **The connection.** A site connects the X account it posts from in
  Settings → Connections → X, or from the Getting started step "Connect your
  X account" (docs/INTEGRATIONS.md, "X: the account GTF posts from"). Only
  where the deployment has `X_OAUTH_CLIENT_ID` and `X_OAUTH_CLIENT_SECRET`.
  Once connected, its @username becomes the site's X account
  (`voice_settings.xHandle`) if none was saved, so the person is not asked
  to type it.
- **Which posts.** `xReplyAllowance` (`x-reply-allowed.ts`) reads what
  discovery stored, nothing fetched: the post's text names `@username`
  (`mention`; X's text carries a reply's leading mentions too), it quotes a
  post by the account (`quote`, from `referenced_posts`), it answers one
  (`reply_to_you`), or it is the account's own (`own_post`). It is a
  pre-check, not a promise: a mention past the 2,000 stored characters is
  missed (the post keeps Reply on X), and X may still refuse.
- **The button.** On such a post, with a connected account and a short reply
  the checks did not stop, the draft's primary button is **Post on X**
  instead of Reply on X; Reply on X yourself stays in the ⋯ menu. Every
  other post keeps today's flow and labels exactly: the composer opens with
  the text, the person posts, GTF finds the link.
- **One press, one post.** `POST /api/placements/:id/post-on-x` →
  `postReplyOnX` (`x-post.ts`), the function `post_on_x` calls. An edited
  draft is saved and checked first; the stored draft's text goes out. The
  row is claimed as posted before X is called (an update conditional on the
  row still being open), so a double press or two agents make one post; a
  post X refuses gives the claim back. Posted, the reply's real link
  (`https://x.com/<username>/status/<id>`) is saved at once through
  `set_published_url`, so there is no link search and the daily numbers
  pick it up.
- **When X refuses.** `reply_not_allowed` (X's 403) opens X's composer with
  the text in the same press (the intent link, as Reply on X) and the card
  says so; the item then shows I posted it, as after Reply on X. A tab the
  browser refuses to open is offered as a link under the button.
  `rate_limited`, `auth_expired` (the connection is marked and Settings asks
  to connect again), `cap_reached` and others are said under the button.
- **Money.** Every post goes through `meteredXCall`: reserved and settled in
  the platform's X ledger (`provider_spend`, provider `x-api`) at
  `X_POST_USD_PER_POST` (an estimate from third-party summaries of X's
  pay-per-use prices, the upper end, not an invoice), refused over
  `X_API_MONTHLY_CAP_USD` and during X's billing pause. A refused post is
  not billed; one X did not answer is counted as made. Reading the account
  when connecting is one metered user read.
- **A post of the account's own.** `post_on_x` with `text` posts one
  (`postStandaloneOnX`). No screen composes one and nothing schedules one
  yet: what to post, and when, is still to be decided. Nothing is stored
  for it beyond the ledger and the log line.

## Draft and audit

`placement-draft` writes the variants the surface calls for (`variantsFor`):
a short comment and a detailed answer for threads, an issue comment for
GitHub issues, the exact list line plus a PR description for awesome-lists,
a reply and an article draft for LinkedIn and DEV, and only the reply on X.
Answer first.

**A reply names no product and carries no link, on every surface.** Two
variants still name the project once and carry one link, because naming
it is their point: the awesome-list entry and the article the writer
publishes on their own account (`variantNamesBusiness`,
`variantCarriesLink` in `lib/placements/link.ts`). There the link sits in
the clause that names the product, as a Markdown link where Markdown
renders and as the bare URL in parentheses elsewhere, never a second one,
never in the opening; a link to any other domain is dropped before it is
stored. **The link is placed by code** (`linkTheName`), on the first
mention of the name, never typed by the model.

Every variant carries an explicit list of claims, each with a basis
(`business_profile`, `thread`, `general_knowledge`, `unverified`); a claim
the model could not ground is `unverified`, which the gate refuses.

The drafter is also given:

- the writer's voice (docs/VOICE.md): About you, the notes, the preset, and
  examples from the writer's own posted replies (`voice-examples.ts`);
- the post's reading first: the model returns `reading` (`tone`: sincere,
  ironic, joke, rant, question; `means`: what the poster actually means)
  before any variant, and the angle follows the reading (`reading.ts`);
- the facts used in recent replies (below);
- the last correction notes (below).

**The audit** (`auditDraft`, `lib/placements/audit.ts`) runs on every
variant, in code. Checks: `answers_first`, `useful_without_link`,
`not_spam`, `specific_angle`, `human_voice`, `platform_fit`,
`verifiable_claims`, `names_business`, `link`, `business_coherence`,
`follows_your_notes`, `follows_your_correction`, `manual_publish`, plus
`repeats_recent_fact` when the history was read. Each check returns a
status and a sentence a person can act on; some are advisory (they show a
note but never block). A variant that fails a blocking check is stored as
blocked with the reason, and the job rewrites it once with the problems
listed; it never loops.

- **A fact only where it fits** (`factProblems`,
  `lib/placements/fact-fit.ts`): a number or a named fact from About you is
  used only where the post is about that subject; a fact about another
  venture is not used under a post about something else
  (`otherVenture`); a dated fact is not stated as current once it is old
  (`lib/voice/staleness.ts`).
- **Numbers.** A sentence with a number is a claim
  (`lib/placements/numeric-claims.ts`), except a short list of idioms that
  are never claims ("give it 110%", "24/7", "zero chance"). A number is
  declared when the drafter listed it as a claim or every figure in it is
  stated in About you (`declaredByAboutYou`).
- **Invented events.** A first-hand event the text tells ("when someone
  paid for my app") that About you does not record fails the claims check
  (`lib/placements/first-hand-events.ts`).

**Re-check**, the save button a blocked draft shows even when nothing was
edited, runs the gate again (and places a missing link where one belongs).

### Corrections

**Fix it** on a draft takes a short note ("too generic", "sounds like AI")
and does two things: the draft is rewritten once, now, following the note
and judged by the same gate; and the note is stored, so later drafts are
told what was already corrected.

`POST /api/placements/drafts/[id]/correct`, body `{ reason, body? }`:
`reason` is 3 to 300 characters, `body` the text as the person edited it.
The route requires a signed-in user, paid access, the selected business, a
valid note and the daily correction cap; `correctDraft`
(`lib/placements/correct.ts`) reads through the person's client (RLS and
`business_id`), refuses a post that is not open (a posted reply's text is
the record of what went out), calls `draft-correct` once (one call, a small
budget), and stores the result as a new draft with the note.
`recentFeedback(supabase, businessId, { limit = 10 })` gives the drafter the
last notes. `correct_reply_draft` is the same on the API and MCP.

### It's true: add to About you

When a sentence fails the claims check only because About you does not
record its fact, the card offers **It's true: add to About you**
(`components/placements/confirm-fact.tsx`). It appends the sentence to About
you (`appendFact`, `lib/voice/about-you.ts`) or, for a dated sentence
already there, records that it is still true on that date
(`confirmFact`); the gate then runs again. `add_about_you_fact` is the tool.

### A fact used recently is not used again

**The history** (`lib/placements/recent-facts.ts`). The drafting job reads
the business's last ten replies (what was posted, else the chosen draft,
and the drafts of the other open posts). For each, `factsUsed`
(`lib/placements/fact-fit.ts`) says which About you sentences it used: the
same number with what it counts, a distinctive number on its own, a range
("position 30-40"), a name, or two content words side by side. A name or
pair the post itself uses is not counted. No model call.

**The prompts** list, per sentence, in how many recent replies it appears
and how, and tell the drafter not to use it again unless the post asks
about exactly that.

**The check "Repeats a recent fact"** (`repeats_recent_fact`,
`lib/placements/fact-repeats.ts`) fails when a draft uses an About you
sentence already in 2 or more of the last 10 replies. It is **advisory**:
the fact is true and allowed, so it never blocks a draft; the job rewrites
once for it and stops.

## The inbox

The inbox is Today (`/today`, `lib/today/`, `components/today/`) and the
Replies queue (`/placements`, `components/placements/`).

- **Tabs** (`TODAY_VIEWS`): To do, Posted, Archive. To do holds the posts
  the person added ("Yours") and the platform's finds ("Found for you").
- **A progress card**: replies marked as posted today against the daily
  goal, in the person's time zone (`postedToday`, `dayIn`).
- **One open item** (`ReplyItem`): the post (`post-preview.tsx`, with its
  images and quoted post), the draft, **Reply on X** (X's web intent) or
  copy and open the original, **I posted it**, Skip, Snooze, Fix it, Voice.
  A posted reply leaves the list at once, with Undo.
- **Write your own**: with no draft to show, the person's own text is
  stored as their draft (`agent_version` 0) and judged by the gate, no
  model.
- **Add a post from X** (`addXPost`, `lib/placements/add.ts`): a pasted
  status link becomes a target qualified by a person; it is read through
  the free embed, or by id with the X API when enabled.
- **Links later**: a posted reply without a link is listed under "Posted,
  no link"; pasted links are matched to their replies
  (`matchPastedReplyLinks`, `lib/placements/link-paste.ts`).
- **Removed replies**: "It was removed" records a removal, with an
  optional reason, on a posted row.
- **What was posted, read back**: the published text is read from X's
  embed and stored (`published-text.ts`), so the voice learns from what
  went out, not from the draft.
- **Swipe** on "Found for you" rows: right is Skip, left is Draft or Open
  (`rowSwipeActions`), with labelled buttons as the non-gesture path.
- **Rows a visibility run put here** (`found_via` = `ai_visibility`) show
  the answer that cited the page and the question asked.

## Configuration

Discovery sources are **deployment settings**, not a per-site integration.
A customer never connects Serper, GitHub or Reddit; env var names never
appear in the UI. If nothing is on, Run discovery is disabled and the empty
state says discovery is not searching yet.

| Where | What |
| --- | --- |
| `/api/cron/discover-placements` | three times a week (`vercel.json`), `CRON_SECRET`; one job per business whose owner pays (`hasPaidAccess`), up to 25 from the first 200 businesses |
| `POST /api/placements/discover` | the same job for the selected site, from the inbox |
| `POST /api/placements/:id/draft` | draft + audit for one target |
| `POST /api/placements/match-links` | says which posted reply each pasted link belongs to; stores nothing |
| `POST /api/placements/:id/action` | mark_published · unmark_published · set_published_url · mark_removed · unmark_removed · dismiss · snooze · reopen · approve |
| `PATCH /api/placements/drafts/:id` | edit a draft; the gate runs again |
| `POST /api/placements/:id/drafts` | "Write your own" |
| `POST /api/placements/:id/post-on-x` | Post on X: posts the draft from the site's connected X account, only on a post X allows; `{ draftId }` |
| `POST /api/placements/drafts/:id/correct` | Fix it |
| `/api/cron/x-posts` | daily, `CRON_SECRET`; off unless `X_API_ENABLED`: reply numbers, followers, then one `x-post-discovery` job per paying site (at most 10, searched longest ago first): the topic search and the close accounts |
| `/api/cron/x-reply-links` | every 5 minutes, `CRON_SECRET`; off unless `X_API_ENABLED` |
| `GET /api/placements/reply-stats` | the period on X summed and the followers; stored rows only |
| `X_API_ENABLED=1` + `X_API_BEARER_TOKEN` | the official X API; `X_API_MONTHLY_CAP_USD` (default 20) is the hard monthly cap |
| `X_OAUTH_CLIENT_ID` + `X_OAUTH_CLIENT_SECRET` | connecting the X account a site posts from (Post on X, `post_on_x`); without them it is not offered. Posts count under the same monthly cap |
| `SERPER_API_KEY` | web search discovery (paid per query) |
| `PLACEMENTS_GITHUB=true` / `GITHUB_TOKEN` | GitHub discovery (free API; a token raises the rate limit) |
| `REDDIT_CLIENT_ID` / `REDDIT_CLIENT_SECRET` | Reddit's own API, only with an approved app; `SERPER_API_KEY` already finds Reddit threads without it |

The cron schedules live in `vercel.json`; a deployment that is not on
Vercel calls the same routes from any scheduler with
`Authorization: Bearer $CRON_SECRET`.

Every inbox action is also a tool on the API and MCP (docs/API.md):
`run_reply_discovery`, `draft_reply`, `mark_reply_posted`,
`unmark_reply_posted`, `set_reply_link`, `find_reply_link`,
`paste_reply_links`, `mark_reply_removed`, `unmark_reply_removed`,
`dismiss_reply_target`, `snooze_reply_target`, `reopen_reply_target`,
`edit_reply_draft`, `write_own_reply`, `correct_reply_draft`, `add_x_post`,
`add_about_you_fact`, and the reads. The route and the tool call the same
function: `applyManualAction` (`actions.ts`), `editDraft` (`edit.ts`),
`requestDraft` (`generate.ts`), `addXPost` (`add.ts`), `requestDiscovery`
(`runs.ts`), `saveOwnReply`, `correctDraft`, `findReplyLinkNow`,
`postReplyOnX`. None posts on its own: `get_reply_intent_url` hands back X's
composer link for a person to open, and `post_on_x` (publish scope,
`confirm: true`) posts only where X allows it, from the connected account.

## Tests

`tests/placements/` mirrors `lib/placements/`; the agents' prompts are
pinned in `tests/agents/placement-*.test.ts`; the X client in
`tests/providers/x-api.test.ts`; the discovery providers in
`tests/providers/discovery-*.test.ts`. `tests/placements/x-close.test.ts`
pins the close accounts: the `close` step between the topic search and the
shared steps, any site with no list and no end date, at most 2 searches of
25 over 12 hours, the window from the last run, no call without replies or
the X API, the retired trial type doing nothing; `x-budget.test.ts` the
month's worst case with them. Post on X: `x-reply-allowed.test.ts` (which
posts get the button), `x-post.test.ts` (the post recorded with its link, the
fallback, the cap, one post per press, two sites with two accounts),
`post-on-x.test.tsx` (the button only where allowed and connected, the
fallback in the same press, Settings and onboarding), and
`tests/providers/x-post.test.ts`, `tests/integrations/x-*.test.ts`,
`tests/tools/x-posting.test.ts`. Every case uses fictional posts, handles and
sites.
