# Scheduled AI Articles — generation & publishing pipeline

The Vercel cron (`vercel.json` → `/api/cron/generate-articles`, daily at 08:00 UTC)
produces article content and then publishes it **to the customer's
site** (WordPress or custom webhook). The SEO traffic must land on the customer's
domain, not on gettrafficfast.com.

## Status flow

```
queued ──▶ generating ──▶ generated ──▶ published
   ▲            │   │
   │            │   └──▶ needs_review   (a quality gate refused to publish)
   └────────────┤
                ▼
             failed      (generation dead-letter after 3 attempts)
```

The transformation from model output to publishable document is owned by the
content pipeline — see **`docs/CONTENT_PIPELINE.md`**, which is the reference
for the architecture, the Canonical Article and the quality gates.

- **queued** — scheduled, waiting for its date. "Add to calendar" and the bulk
  add (`POST /api/calendar/add`, `/add-bulk`) put keywords on the site's first
  free days after today, one article per site per day; both use
  `nextFreeDays` in `lib/calendar/schedule.ts` (UTC days, the cron's "due").
  Both are paid actions behind `requirePaidAccess`, because every queued
  article is one the cron pays to write: a lapsed account gets the 402.
  Neither schedules a keyword whose near-duplicate is already scheduled,
  being written or published (docs/INTELLIGENCE.md, "Overlapping topics").
- **generating** — a `produce-article` job is running for it right now.
- **generated** — content is stored in `articles.content` but is **not yet on
  the customer's site** (no integration connected, or the publish call failed).
- **published** — live on the customer's site; `articles.published_url` holds the
  real post URL (`external_post_id` the CMS-side id).
- **needs_review** — the article was written and stored, but a quality gate
  refused to publish it (prompt leakage, Markdown residue, missing structure…).
  It is **never** published automatically. The owner is emailed, and from the
  calendar can read the failed checks and either regenerate or publish anyway.
- **failed** — generation dead-letter. Shown in the calendar with a **Re-queue**
  action (`POST /api/calendar/requeue` resets `status='queued'`, `attempt_count=0`).
  On Today it is an "Also today" card, like a needs_review one, until it is
  resolved or ignored there (since 2026-11-19, `POST /api/calendar/dismiss`,
  `dismiss_today_articles`): Ignore sets `dismissed_at` and nothing else, so
  the article keeps its state on the board. A trigger clears the mark on any
  change of status (migration 20261119110000), so a new failure or a new
  hold shows on Today again.
- **Regenerate** — generated, published and needs_review cards (and the article
  modal) re-run production via `POST /api/generate-now`, the same route as
  **Generate now** on a queued card. The lifecycle decides which states may
  start (`canStartProduction` → `generating`). A published article is rewritten
  in place: `published_url` / `external_post_id` stay, so the next deliver
  updates the live post instead of opening a second copy. Already-live pages
  keep the old body until that publish (or **Publish now** / **Republish**).

## Retry semantics

- **Generation** failures are the job's retries: each attempt is recorded in
  `articles.attempt_count`, and after 3 the job fails and the article
  dead-letters to `failed`. An article the pipeline judged unusable discards its
  drafting checkpoints, so a retry genuinely writes a new article.
- **Publishing** failures do **not** consume attempts and never discard the
  generated content: the article stays `generated` and the cron retries the
  publish step on every run (integrations with `status='error'` are still
  retried; a success resets them to `connected`).

## Cron internals (`app/api/cron/generate-articles/route.ts`)

- Protected by `CRON_SECRET` (Bearer token). Never expose the admin client
  (`lib/supabase/admin.ts`, service-role key) in routes without this check.
- Phase 1 (generation): enqueues a `produce-article` job per due article, then
  drains what fits in the invocation. Production itself (outline → writing →
  validation → audit) belongs to the durable workflow — see
  `docs/AGENT_RUNTIME.md` — so article state, retries and owner notifications
  behave identically however a run was triggered.
- Phase 1 produces only for owners with paid access. The cron runs on the
  service role, where the screens' paywall does not reach, so it asks
  `hasPaidAccess(client, userId)` (`lib/paid-access.ts`, the same rule as
  `hasActiveSubscription`: an `active` or `trialing` row whose period has not
  ended) once per owner per run. A lapsed owner's due articles stay `queued`,
  untouched (no attempt spent), and are produced if the subscription comes
  back. Each skipped business is one log line (`skipped:
  "no_active_subscription"`, or `"subscription_unreadable"` as a warning when
  the read failed: fail closed, the article waits a day). The response carries
  `generation.skipped_unpaid` (`businesses`, `articles_seen` in this run's
  pages, not a total).
- Due articles are read oldest first in pages of 25, at most 4 pages, until 5
  from paying owners are found. After the first page, owners already found
  lapsed are left out of the query, so a lapsed account's backlog costs one
  page however long it is, and cannot keep paying accounts out of the run.
- Phase 2 (publishing): up to 10 due `generated` articles → the user's first
  active destination (`lib/publishing/registry.ts`) → `published` + real URL.
  `needs_review` is deliberately excluded: it never publishes on its own.
  Users without an integration keep their articles in `generated`; the dashboard
  shows a "connect an integration" prompt plus Copy HTML / Copy Markdown fallbacks.
- Publishing policy lives in `lib/content/service.ts`, shared by the cron and
  "Publish now"; generation policy lives in the workflow. Neither is duplicated.
- A second cron, `/api/jobs/tick` (every 5 minutes), drains whatever the daily
  run could not finish, then publishes what has just become ready (below).
- The publishing rules are one function, `publishReadyArticles`
  (`lib/articles/publish-ready.ts`), called by the daily run's phase 2 and by
  the tick. The daily run reads every due `generated` article oldest first,
  failed deliveries included (that is the once-a-day publish retry). The tick
  reads at most 10 due `generated` articles updated in the last 24 hours,
  newest first, skips failed deliveries (a broken destination is not called
  every five minutes), and handles at most 3: one indexed read on the
  `status='generated'` partial index when there is nothing to do. It logs only
  when it published, parked or failed something.
- **No double publish.** Before delivering, a run claims the article:
  `update articles set publish_claimed_at = now() where id = … and status =
  'generated' and publish_claimed_at is <the value it read>`; only the run
  whose update changed the row delivers, the others count it as
  `claimed_elsewhere`. The claim is released when the delivery ends (published,
  parked or failed). A claim older than 10 minutes, longer than any function
  lives, belongs to a run that died and is taken over.
- Cron failures are reported to Sentry (see `docs/SENTRY.md`).
- Every publish attempt (success or failure) is logged to `publish_attempts`
  and surfaced on the integration settings page for **that site** as
  "Recent deliveries" (filtered by `business_id`, not the whole account).
- Email notifications (Resend, `lib/notifications/email.ts`): the owner gets an
  email when an article dead-letters to `failed`, and when an integration
  transitions `connected → error` (once per incident — silent retries). Both
  are best-effort: without `RESEND_API_KEY` the cron just logs and moves on.

## 2026-11-10: an article that finished after the publishing phase waited a day

The daily run enqueues and ticks production, then publishes in the same
request, skipping any article whose production job is still live (enrichment
runs after `generated`). On 2026-11-09 the job took 3 minutes and the article
was published. On 2026-11-10 the GetTrafficFast article "AI Blog Writer for
SEO" (scheduled 2026-11-10) was produced from 08:00:39 to 08:08:10, longer since
the revise and settle steps were added; phase 2 found it `still_producing`, and
nothing else publishes on its own, so it stayed `generated` until the next
08:00 run.

Fix: the tick publishes too, with the same rules and the atomic claim above, so
an article is published within about five minutes of its job finishing. The
workflow was not given a final publish step: delivery would then share the
job's retry and paywall semantics, a "generate now" for a future date would
need its own date rule, and the daily run's retry of failed deliveries would
still be a second publisher needing the same claim. One function with two
callers keeps one set of rules.

## Database migrations

Migrations live in `supabase/migrations/` (one file per schema change) and are
applied to the deployment's Supabase project with the Supabase CLI
(`supabase db push`), the Supabase MCP `apply_migration`, or the SQL editor.

| File | What it does | Status on remote |
| --- | --- | --- |
| `20260526120000_idempotency_and_retry.sql` | `processed_stripe_events`; `articles.attempt_count/last_error/failed_at`; queued index | applied |
| `20260531100000_integrations_table_and_publishing.sql` | `integrations` table + RLS; `articles.external_post_id`; service-role policies | applied |
| `20260720100000_generated_status_and_publish_retry.sql` | widens `articles_status_check` to include `generated` and `failed`; partial index on `status='generated'` | applied (2026-07-20) |
| `20260721090000_publish_attempts.sql` | `publish_attempts` delivery log (owner read-only, cron writes); shown as "Recent deliveries" in the integration pages | applied (2026-07-21) |
| `20260721120000_notification_log.sql` | `notification_log` for once-per-user lifecycle emails (see `docs/ONBOARDING_EMAILS.md`) | applied (2026-07-21) |
| `20260721150000_business_content_language.sql` | `businesses.content_language` (en/it/es/fr/de, default en): explicit output language for description, keywords and articles | applied (2026-07-21) |
| `20260802120000_content_pipeline.sql` | `articles.raw_content` / `canonical` / `quality_report`, `needs_review` status, `publish_attempts.payload` / `.response` | applied (2026-08-02) |
| `20260802160000_agent_runtime.sql` | `jobs`, `job_steps`, `agent_runs`, `article_events` + the `claim_jobs()` function | applied (2026-08-02) |
| `20260804100000_media_layer.sql` | `businesses.media_settings`, `media_assets` ledger, public `article-media` storage bucket | applied (2026-08-04) |
| `20260805100000_knowledge_graph.sql` | `entities`, `article_entities`, `topics`, `article_topics`, `article_links` (see `docs/KNOWLEDGE.md`) | applied (2026-08-05) |
| `20260810100000_serp_intelligence.sql` | `serp_snapshots`, `competitors` (see `docs/INTELLIGENCE.md`) | applied (2026-08-10) |
| `20260815100000_content_lifecycle.sql` | `content_metrics`, `article_versions`, `articles.last_refreshed_at` (see `docs/LIFECYCLE.md`) | applied (2026-08-15) |
| `20261109190000_rls_keywords_articles_business.sql` | `keywords` / `articles` insert and update `with check` also require `business_id` to be the user's (see `docs/MULTI_BUSINESS.md`) | applied with the push |
| `20261110233000_article_publish_claim.sql` | `articles.publish_claimed_at`: the delivery claim of automatic publishing (daily run and tick), additive | to apply with the push |

> If you ever recreate the database, run the files above in order.
