# Analytics: real traffic from Search Console

Phase 5 of `docs/ARCHITECTURE.md`, third slice, and the one that closes the
loop. Rank measurement samples the SERP; citation probing samples answer
engines. Both are estimates by construction. Search Console is the first
number in the platform that is **counted**, by the search engine itself, which
is why it is worth a per-user OAuth flow.

Until this existed, a customer asking "how much traffic did you actually bring
me" had no answer, in a product called GetTrafficFast.

## What exists

```
lib/providers/analytics/types.ts           the boundary: a site and a range in, rows out
lib/providers/analytics/search-console.ts  OAuth helpers + the API client (pure parser)
lib/analytics/search-console.ts            connection storage, attribution, ingestion
lib/analytics/property-display.ts          host / kind / label from Google's siteUrl
lib/analytics/runs.ts                      first-connect kick (enqueue, optional wait)
lib/jobs/workflows/search-console-ingest.ts  the job the kick enqueues
app/api/integrations/search-console/*      connect, callback, sites, select-site, sync, disconnect
app/api/cron/ingest-search-console/        daily overlapping tail
app/(app)/settings/integrations/search-console/  the customer-facing connect page
```

Migration: `supabase/migrations/20260828110000_analytics_connections.sql`.

## Why its own table

`analytics_connections`, not `integrations`. That table holds publishing
destinations, places the platform writes to, and its type check says so.
Search Console is a source we read from, with a different lifecycle (a refresh
token Google can revoke at any moment) and a different failure meaning: a
broken publisher stops delivery, a broken analytics connection only stops
measurement. Collapsing the two would make "status = error" mean two things.

The refresh token is encrypted at rest with the same AES-256-GCM helper as
publishing credentials, and no route ever selects the column for a client.

## The OAuth flow, and its two traps

1. `connect` mints a random state, stores it in an httpOnly cookie and sends
   the customer to Google. **Without that state**, anyone could hand a signed-in
   customer a crafted callback URL and attach their own property to that
   account.
2. `callback` verifies the state, exchanges the code, and **refuses a grant
   that came back without a refresh token**. Google only returns one on first
   consent unless it is forced, and a connection without it works for an hour
   and then fails silently, which is worse than not connecting at all. That is
   why the consent URL sets both `access_type=offline` and `prompt=consent`.
3. The scope is `webmasters.readonly`. The platform never writes to a
   customer's property, and the connect page says so.

The grant attaches to the site selected in the person's browser when Google
sends them back. `connect?business=<site id>` (the link the
`get_search_console_connect_url` tool hands an agent, docs/API.md) selects
that site first, after checking it is one of the signed-in person's own, so a
link for site B never lands on site A; a site they do not have goes back to
Settings with `error=site_not_found`. The screens' own button sends no
`business` and keeps the current selection.

The writes after the flow (pick the property, disconnect) live in
`lib/analytics/search-console-connection.ts`, which the routes and the
Search Console tools share; they go through the service role, narrowed by the
verified site and user, because the table's RLS lets an owner read the row
and never write it.

If the grant can read more than one property the customer picks it. Changing
the property clears the sync watermark, because the stored history belongs to
the old one and resuming would leave a silent gap.

The picker shows the host a person recognises, a favicon, and whether Google
will count the entire domain or only a URL prefix. The raw `siteUrl`
(`sc-domain:example.com` or `https://www.example.com/`) stays the identity we
store and POST; it is the `title` on the row, never the visible label. A
"This site" badge marks the property that covers the selected business's
`website_url` — a sibling domain on the same Google account is listed, not
badged. `/results` uses the same label for the traffic caption.

## Attribution

Search Console reports per page and per day; the platform stores per article.
`groupRowsByArticle` maps one to the other:

- URLs are compared in normalised form (no scheme case, no `www.`, no trailing
  slash, no query), so the same page reported three ways folds into one article.
- Metrics for those variants are **summed**, and position is averaged
  **weighted by impressions**: a position seen by three people and one seen by
  three thousand are not worth the same, and a plain average would flatter the
  result.
- A row that cannot be attributed is **dropped**, never guessed. A click
  credited to the wrong article is worse than a missing click.

## The sync window

Search Console keeps revising the last few days, so a run re-reads the tail
instead of resuming exactly from its watermark, and never asks for days Google
has not settled. A first sync reaches back 90 days: the history is already
there, and a rank series cannot be reconstructed after the fact.

The sweep runs daily rather than weekly for the same reason: a daily pull with
an overlapping tail converges on the truth, while a weekly one freezes numbers
that were still moving.

The first pull does not wait for that sweep. Selecting a property (or landing
on Results with a connected property and no watermark, or a watermark behind
the newest settled day) enqueues `search-console-ingest` and, when the
customer is waiting, runs it inline for up to 45 seconds. The OAuth callback
only enqueues: it must not hold the redirect. A watermark already equal to
that settled day is left alone, so revisiting Results the same day does not
re-spend Google quota on the same window. The date in the caption is that
day (`data through 2026-10-06`), and beside it the moment the pull finished
(`pulled today`). It is not "last synced": on 8 October the newest settled
day is the 6th, two days back, even when the pull ran that morning. No
published article with a
live URL is a skip, **not** a watermark: marking `last_synced_on` without
fetching would shrink the next window to three days and lose the 90-day first
pull.

One customer's revoked grant must never stop the others, so failures are caught
per connection, recorded on the row, and shown on the settings page.

## Where it shows up

On `/settings/integrations`, the Search Console card is Connected / Manage when
`analytics_connections` has a connected row for the selected site. The catalog
does **not** read this from `integrations` — stuffing the grant into the
publisher table would collapse two meanings of error. The mapping lives in
`lib/integrations/catalog.ts`.

On `/results`, immediately:

- Clicks and impressions over 28 days, per article and in total.
- The daily series as two stacked panels sharing one x axis (clicks above,
  impressions below), with one crosshair and one tooltip across both, and the
  same numbers in a table for anyone not hovering. Two panels rather than one
  dual-axis chart on purpose: impressions run orders of magnitude above
  clicks, and a second y scale makes the reader work out which scale a line
  belongs to before they can read it. X-axis labels are spaced by the
  panel's width (`axisTickIndexes`, at least 64px apart), so 28 days do not
  collide on a phone; first and last day are always labelled.
- The days the page draws (axis, tooltip, daily table, the caption's "data
  through" day, the empty-panel "Data through …" sentence, an older "pulled"
  day, "last checked") go through the shared `formatDay` (`lib/format.ts`),
  always in English ("Aug 26"), whatever the device's locale; never an ISO
  day. Counts are grouped the same way ("12,400").
- The series is zero-filled only inside the ingested range: a day Google
  omitted is a real zero, a day it has not settled yet is simply absent, and
  the caption says which day the data is settled through. Extending the line
  to today would draw a traffic collapse that is merely lateness.
- The connection's three states are spelled out instead of inferred from
  missing numbers: never connected is an invitation to connect, connected
  without a completed pull shows "syncing…" while the first job runs, and
  once a pull has landed the caption says which day the data runs through
  and when the pull finished, and a broken grant shows its error
  while still charting what was ingested before it broke. The empty panel
  never tells a connected customer to wait until 07:00 UTC.
- The position switches to Search Console's average when it is available
  and falls back to our SERP snapshot otherwise. The source is said once,
  under the articles ("Positions are Google's average from Search
  Console."), and only rows from the other source carry a marker, named in
  words, never the `gsc` identifier (`describeRankSources`,
  `docs/LIFECYCLE.md`). Positions read to one decimal (51.8, 10). The
  two series are never interleaved: a scraped position on one day and an
  average Google served over a day are different measurements.
- Absent data reads "not connected" only when that is true, "no data yet"
  once a connection exists, and never 0.

## Configuration

| Where | What |
| --- | --- |
| `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET` | the platform's Google Cloud app; without them the flow is unavailable |
| Redirect URI | `<origin>/api/integrations/search-console/callback`, registered per deployment |
| `/api/cron/ingest-search-console` | daily 07:00 UTC, overlapping tail; `CRON_SECRET` |
| `/api/integrations/search-console/sync` | first pull when `last_synced_on` is null; the `sync_search_console` tool since 2026-11-14 |
| `/api/cron/inspect-index` | daily 02:10 UTC, URL Inspection, at most 200 per site; `CRON_SECRET`; free, so no opt-in |
| `INTEGRATIONS_ENCRYPTION_KEY` | already required; encrypts the refresh token |

## Tests

`tests/lifecycle/push-store.test.ts` ("the query report") covers the
query rows: the parser and the folding onto articles.
`tests/analytics/search-console.test.ts` covers the two things that must not go
wrong: attribution (variants folded, impression-weighted position, unattributed
rows dropped) and the sync window (overlap on resume, never asking for
unsettled days). `tests/analytics/search-console-ingest.test.ts` pins the
first-connect contract: a skip does not write a watermark, a set watermark does
not enqueue, and `search-console-ingest` is registered. `tests/analytics/property-display.test.ts`
pins the label contract: a domain property reads as the host, and a sibling
grant is not "this site". `tests/integrations/catalog.test.ts` covers the
catalog Connected badge reading `analytics_connections` rather than
`integrations`. The Results empty copy is asserted never to mention 07:00 UTC
(`tests/lifecycle/results.test.ts`).

## Queries per article (2026-11-15)

Push page 3 (docs/LIFECYCLE.md) needs to know which search an article sits
on page 3 for; `content_metrics` had only pages and days. Every ingest now
makes one more Search Analytics request, dimensions `["page", "query"]`
over the 28 settled days ending on the window's last day
(`ingestSearchConsoleQueries`, `SearchConsoleProvider.queries`, the pure
parser `parseSearchQueryResponse`), folded onto articles like the daily
rows (`groupQueriesByArticle`: URL variants summed, position weighted by
impressions, unattributed rows dropped; the query lowercased) and upserted
into `content_queries` (migration `20261115110000_article_pushes.sql`): one
row per `(article_id, query)` with `period_start`/`period_end`, replaced on
every pull. Readers keep an article's newest `period_end` only, so a query
that stopped appearing reads as gone. One page of at most 25,000 rows, the
largest first: on a very large site the rare tail is what is left out.
Google omits anonymised rare queries, so an article's query rows can add
up to fewer impressions than its page rows. Free (the Search Console API
costs nothing) and best-effort: a failure is logged
(`search_console.queries_failed`) and never stops the page numbers. RLS:
the owner selects, the service role writes; reachable through an API
caller's client (`OWNED_TABLES`).

After each ingest, the daily cron and the first-connect job also measure
the pushes whose +14 or +28 window the new days cover
(`measureDuePushes`): stored rows only, nothing asked of Google.

## Indexing status (2026-11-12)

### Why it exists: the redirect email

On 2026-11-12 Search Console emailed the owner "Page with redirect" for
gettrafficfa.st, and the app could not say which page or why. Search
Analytics only reports pages Google showed; a page it never indexed has no
rows at all, so nothing above could see it. The page turned out to be
the only one of the 46 sitemap URLs that did not answer 200 (a redirect);
commit `dcce5e4` took it out of the sitemap and made the redirect
permanent. Indexing status is the general
answer: for every published URL, Google's own verdict, in Google's words.

### What it reads

Google's URL Inspection API,
`POST https://searchconsole.googleapis.com/v1/urlInspection/index:inspect`
with `{ inspectionUrl, siteUrl, languageCode: "en-US" }`
(`SearchConsoleProvider.inspectUrl`, `lib/providers/analytics/search-console.ts`;
the pure parser `parseUrlInspectionResponse` maps Google's
`inspectionResult.indexStatusResult` onto `verdict`, `coverageState`,
`indexingState`, `robotsTxtState`, `pageFetchState`, `googleCanonical`,
`userCanonical`, `lastCrawlTime`, `sitemap[]`, `referringUrls[]` and
`inspectionResultLink`). The language is fixed so `coverageState` is always
English ("Crawled - currently not indexed").

- **Scope.** The method accepts `webmasters` or `webmasters.readonly`
  (Google's method reference, `developers.google.com/webmaster-tools/v1/urlInspection.index/inspect`,
  and the API's discovery document). The app already asks for
  `webmasters.readonly`, so every existing connection can inspect; nobody has
  to reconnect and the scope is unchanged.
- **Cost and quota.** The Search Console API is free: Google charges nothing
  per call. Google's usage limits page (`developers.google.com/webmaster-tools/limits`)
  gives URL Inspection a quota of 2,000 queries a day and 600 a minute per
  property, and 10,000,000 a day and 15,000 a minute per Cloud project. Being
  free, it is not behind an opt-in env var (CLAUDE.md "cost must never switch
  itself on" is about spending money); being quota-bound, it is capped.
- **Errors** (`InspectionError.kind`): 403 is `forbidden` (the Google account
  is not an owner or full user of the property, or the grant lacks the
  scope), 429 is `quota`, 400 is `invalid` (the URL is not inside the
  property), 401 `unauthorized`, anything else `unavailable`.

### Storage

`index_status` (migration `20261112120000_index_status.sql`): one row per
`(business_id, url)`, the latest answer, with `user_id`, `article_id`
(nullable), `checked_at`, `verdict`, `coverage_state`, `indexing_state`,
`robots_state`, `fetch_state`, `google_canonical`, `user_canonical`,
`last_crawl_at` and `raw` (Google's payload, which also carries the report
link). No history table yet. RLS: the owner selects their rows; only the
service role writes (the sweep and "Check now" narrow by the verified site
and user). Additive, no `drop`.

**Unchecked is not "not indexed".** A URL nobody inspected has no row and
reads "not checked". Indexed means verdict `PASS` (or `PARTIAL`, a value
Google reserves and no longer sends); `FAIL` and `NEUTRAL` are not indexed;
anything else is unknown and counted apart.

### What gets inspected, and when

`lib/analytics/index-status.ts`, daily cron `/api/cron/inspect-index` at
02:10 UTC (`CRON_SECRET`), for every site with a connected property:

- Candidates: every published article's live URL inside the property. The
  site's own sitemap is **not** read: the platform stores `sitemap_url` but
  never fetches it, so non-article pages (like `/pricing`) are not swept yet.
  `inspect_url` can still check any URL of the property by hand.
- At most **200 inspections per site per UTC day**, sweep and "Check now"
  together (`DAILY_INSPECTION_CAP`), a tenth of Google's per-property quota.
  Four in flight at a time, well under 600 a minute.
- Order: published in the last 3 days first, then never checked or
  republished since the last check, then the oldest `checked_at`.
- A URL is re-checked at most every 3 days (`RECHECK_DAYS`), unless its
  article was republished after the last check (a successful
  `publish_attempts` row newer than `checked_at`). Publication time is the
  first successful delivery, else the calendar day.
- A 429 or 403 stops that site's run at once (asking again only burns the
  next call); one URL Google will not inspect is counted and the run goes
  on. One site's failure never stops the others; sites start in a rotating
  order each day, inside a 270-second budget.

### Where it shows

- **Article modal** (published articles, Search Console connected): one
  quiet line, "On Google · checked Nov 12" or "Not on Google: Crawled -
  currently not indexed · checked Nov 12", a link to Google's report, and
  **Check now** (`POST /api/index-status/inspect`). Never inspected reads
  "Not checked on Google yet". `components/dashboard/index-status-line.tsx`,
  the wording in `lib/analytics/index-status-display.ts`.
- **Growth → Google → Pages on Google** (2026-11-14; until then Results →
  Indexing, `components/results/indexing-section.tsx`, from
  `GET /api/index-status`): counts per Google state from checked URLs only,
  captioned "N of M checked", and the URLs not indexed with Google's reason
  and report. Hidden until a property is selected.
- **Alert**: one email to the owner (`indexingAlertEmail`) when a published
  article is still not indexed 7 days after publishing, or a URL that was
  indexed is not any more. Deduped in `notification_log` on a key of site,
  URL and Google state, so each URL is noted at most once per state; a send
  that fails records nothing and the next sweep tries again. At most 20 URLs
  per email.
- **API and MCP**: `list_index_status` (read) and `inspect_url` (write, free)
  (docs/API.md).

### Tests

`tests/providers/url-inspection.test.ts` (fixtures for indexed, redirect,
crawled-not-indexed, noindex, 404 in `tests/fixtures/url-inspection.ts`; the
request body; 403 vs 429), `tests/analytics/index-status.test.ts` (rotation,
cap, re-check interval, quota and 403 stopping a run, null vs not indexed,
the alert dedupe), `tests/tools/index-status.test.ts` (tenancy, scopes,
refusals), `tests/analytics/index-status-ui.test.tsx` (the line, the
Results section, the migration).

## Not in this slice

- Reading the site's own sitemap for indexing candidates (only article URLs
  are swept today), and a history of inspections per URL.
- Query-level history. Since 2026-11-15 the ingest also stores which
  searches showed each article (below), but only the newest 28-day window,
  not a series per day.
- GA4 and Bing, which the same provider interface is shaped to accept.
