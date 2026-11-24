# Multi-business: one login, several sites

**The tenancy half shipped on 14 September 2026** (migration
`20260914120000_business_tenancy.sql`). The billing half below is still a plan,
deliberately: it only matters to a customer who does not exist yet.

An account used to be a site. `user_id` was the tenancy key on all 21 tables
that had one, no table carried a `business_id`, and twenty call sites read the
business with `.eq("user_id", …).maybeSingle()` — so a second `businesses` row
did not "mostly work", it stopped that account's pipeline.

It changed because one person commonly runs more than one site, and with one
site per account the deployment could not also write for its own blog
(`docs/BLOG.md`) from the operator's account. The blog itself needs nothing special from the platform:
it connects the ordinary Webhooks integration, like any other Next.js site.

## What the tenancy key is now

`user_id` **stays**, and keeps meaning what it means: who owns this, and what
every RLS policy checks. It stopped being what things are *looked up* by. That
is `business_id`, on the 18 site-scoped tables: `articles`, `keywords`,
`entities`, `topics`, `article_links`, `article_versions`, `article_events`,
`competitors`, `content_metrics`, `serp_snapshots`, `media_assets`,
`ai_citations`, `placement_targets`, `integrations`, `analytics_connections`,
`jobs`, `agent_runs`, `publish_attempts`.

`notification_log` and `subscriptions` kept the user as their key on purpose: a
welcome email is sent to a person and a plan is bought by one.

**`business_id` is nullable, and that is not laziness.** The backfill
(`business_id = the user's single business`) covered every article and every
integration, but 20 keywords belong to an account that never configured a site
at all — the churn case in `docs/ONBOARDING_EMAILS.md`. NOT NULL would have
meant inventing a business for those rows or deleting them; both are worse than
a null the app simply never shows. Tightening it is a later migration, after a
human looks at the orphans. Still 20 on 2026-11-09, all `available`, linked to
no article and untouched since 2026-05-23, of one account with no business.

The uniques that used to enforce "one site per account" moved with the key:
`articles (business_id, scheduled_date)` (still deferrable, `move_article()`
swaps two days in one statement), `keywords (business_id, keyword)`,
`integrations (business_id, type)`, `analytics_connections (business_id,
provider)`, `entities (business_id, type, canonical_name)`, `topics
(business_id, slug)`, `competitors (business_id, domain)`, `placement_targets
(business_id, surface, external_id)`.

`businesses.website_url` was globally unique, which said two accounts may never
work on the same domain — wrong for an agency and its client, and wrong for
anyone who deletes and re-adds a site. It is now unique `(user_id,
website_url)`: the same person cannot add the same site twice, and two people
can.

## How a request knows which site it is about

`lib/tenancy.ts`. The selection is a cookie (`gtf-business`), and it is never
trusted on its own: `pickBusiness(businesses, requestedId)` picks from the
user's OWN businesses and falls back to the oldest when the requested id is not
among them. That structure — select FROM what they own, never filter BY what
they sent — is what keeps a forged cookie from being someone else's data, and
`tests/tenancy/pick-business.test.ts` holds it.

- `GET /api/business/list` — the switcher's data (sites + selected id).
- `POST /api/business/select` — verifies ownership, sets the cookie, 404s on a
  site that is not yours.
- `POST /api/business/save` with `createNew: true` — adds a site and selects it.
- UI: a custom menu (not a native `<select>`) in the desktop sidebar and, on
  a phone, in the first row above the page (`MobileSiteBar`; both are in the
  page at once, so each has its own ids), each
  site shown with its favicon, and "Add a site" as the last item *inside* the
  menu → `/settings/business?new=1`. The icon is decoration from the stored
  `website_url`; a site without a URL gets a globe, never a guessed domain.
  The menu is rendered by the one authenticated shell (`app/(app)/layout.tsx`),
  which stays mounted when the left menu changes section, and which passes the
  account's sites in from the server. Section layouts used to each mount their
  own sidebar, so every click unmounted the switcher; it came back only after
  `/api/business/list` returned, which is the flash. The shell's first paint
  already contains the selected site.

An API key, or an app connected over OAuth (claude.ai), does not use the
cookie: it carries its own site, or covers every site and picks one per
request with the `x-gtf-business` header, or per tool call with the tools'
`site` argument (a site's id, name or domain, matched among the sites the
credential covers: `lib/tools/site.ts`). The same structure holds there:
`site` selects FROM the credential's sites, and a key or a grant for one site
never reaches another. docs/API.md "The site" and "Choosing the site in a
call" have the rules.

Such a credential for every site acts, when a request names no site, on its
saved default site (since 2026-11-23: `default_business_id` on the key or
the grant), else on the oldest. The person sets it by telling the agent
("use Bravo by default": the `set_default_site` tool) or in Settings →
Claude and API, on the key or the connected app. Like the cookie, it is a
preference read FROM the account's sites: a saved site that is no longer
one of them is ignored, and the oldest applies. docs/API.md "The default
site".

Sections that only make sense with a site (dashboard, keywords, results, help,
AI Visibility, placements) redirect to `/settings/business` when the account
has none. Settings itself never redirects — it is where a site gets created.
The gate is `requireSite` in `lib/app-access.ts`; settings calls
`requireAppAccess` and stops there. `requireAppAccess` is wrapped in React
`cache()`: the shell, the section layout and a page that all ask for it in one
request share one check, and a later request (a tab switch) checks again.

"Recent deliveries" on the WordPress and Webhook settings pages is site-scoped
the same way: `publish_attempts` is owned by `user_id` (RLS) and listed by
`business_id`. Filtering only by the user mixed one site's deliveries into
another site's webhook page.

## Writes name a site the user owns

Reads were scoped first; writes have two layers of their own.

**RLS.** On every client-writable site table, the insert and update policies'
`with check` requires `business_id` to be one of the user's own businesses, not
only `user_id = auth.uid()`: integrations, `aeo_queries` and
`placement_targets` since `20261108180000_rls_business_ownership.sql`,
`keywords` and `articles` since
`20261109190000_rls_keywords_articles_business.sql`, `placements` and
`api_keys` since `20261116100000_rls_business_ownership.sql` (altered in
place, by name). Without it a client could write its own row carrying another
account's `business_id`, and the service-role readers that select by
`business_id` (the generation cron, autopilot, publishing, the job worker)
would take it for that business's row. A null `business_id` fails the check, so
the 20 orphan keywords above can still be deleted by their owner but no longer
written. The one exception is `api_keys`, where a key with no business is an
account-wide key: null passes there, any other value must be an owned business.
Select and delete policies, and the service role, are unchanged.

The rule, for every new table: if it has `business_id` and the customer can
insert or update it, the policy's `with check` is `(select auth.uid()) =
user_id and exists (select 1 from public.businesses b where b.id =
<table>.business_id and b.user_id = (select auth.uid()))` (with `business_id is
null or …` only where the column is nullable on purpose).
`tests/security/rls-business-ownership-migration.test.ts` replays every
migration's policies in order and fails if one is left with the user check
alone. The database enforces this; the route-level scoping below is the second
layer, not the only one.

**Routes.** Every route that changes a keyword or an article by id scopes it to
the selected site as well as the user: `keywords/update`, `keywords/delete`,
`calendar/remove`, `calendar/requeue`, `calendar/reschedule` (checked before
`move_article()`, which checks only the user) and `generate-now`. An id from
another of the user's sites (a stale tab) answers 404 instead of acting on a
calendar that is not on screen. `keywords/update` writes only what the keywords
page changes, `{ is_starred }`, validated with Zod; any other field is a 400.
It used to write the body's `updates` object as is.

The writes themselves live in `lib/keywords/manage.ts` and
`lib/calendar/manage.ts`, which the routes and the API's tools call alike
(docs/API.md). An API key has no user JWT, so `move_article()` (which reads
`auth.uid()`) cannot run for it: the `reschedule_article` tool, for a key,
calls `move_article_for_owner(owner, id, date)`, the same body with the owner
passed in by the server from the verified key, executable by the service role
only (`20261109231500_move_article_for_owner.sql`). The article is checked
against the key's site and user first, as the route checks it.

## Billing page

Settings → Billing (`app/(app)/settings/billing/page.tsx`) shows only what the
account's `subscriptions` row holds (`summarizeSubscription` in
`lib/subscription.ts`): the plan (there is one, `PLAN_NAME`), the status, and
the trial end or next renewal when `current_period_end` is set. On the current
Stripe API version the webhook leaves the period columns null, and then the
page says the date is in the billing portal instead of showing one.

"Manage billing", and Billing in the account menus, fetch a portal link and
follow it with `window.location.assign` (`lib/billing-portal.ts`,
`components/billing/use-billing-portal.ts`). A `window.open` after an `await`
is blocked on iOS, which made the button look dead on an iPhone. The portal
returns to `/settings/billing`; a failure is shown inline, never in an alert.

### The plan card: quotas in the customer's units

Since 2026-11-14 the page is one card:
the plan and its status (as above), what the plan lets the account do and
how much is used, and the Manage billing button. No dollar amount anywhere:
a subscriber pays a fixed price, and the model and provider costs are the
platform operator's (`/settings/costs`, docs/API.md "The owner's costs"). The old
"AI spend today: $X of $Y" line, the daily spend limit field and the
"X API this month" line are gone.

The quotas come from `loadPlanUsage` (`lib/limits/quotas.ts`,
`components/billing/plan-usage.tsx`), each from the number the code
enforces, each with a bar:

- **This month**: articles on this month's calendar for the selected site,
  against the month's days (one article a day is the database's
  `unique (business_id, scheduled_date)`).
- **Daily limits**, over the last 24 hours, the screens and every API key
  together: Reply drafts 60, Draft corrections 100, Articles generated on
  demand 10, Reply discovery runs 10, AI Visibility runs 4, Site analyses 10,
  Keyword suggestions 30, Prompt suggestions 30. "could not be read" when a
  count fails, never 0.
- **Today's limit for AI work**: the account's daily spend ceiling
  (`lib/limits/spend.ts`), still enforced, never shown as an amount. The card
  says nothing while it is open; when it is reached: "You've reached today's
  limit for AI work. It resets at about 14:05 UTC on Nov 15." and that queued
  work waits; when it cannot be checked, it says so.

The ceiling itself is set by a platform owner, not the customer: the
customer's insert and update policies on `account_limits` admit nothing
since migration `20261114140000` (docs/API.md "Account limits").

The limits are the **account's**, not a site's (the calendar row aside):
two sites share one ceiling and one set of caps, like the draft and
correction caps before them. When billing by quantity arrives (below), a
per-site share of the ceiling is a setting on top of this, not a second
mechanism.

## Billing: quantity on one subscription, not N subscriptions

**Still not built**, and still the right shape when it is.

The paywall for the second site can be built two ways, and the choice is worth
making deliberately because migrating between them later means touching live
subscriptions.

**One subscription per business.** Each site gets its own Stripe subscription.
Simple to reason about, and wrong in practice: separate invoices, separate
renewal dates, a payment method that can fail for one site and not another, and
a discount that has to be a coupon someone maintains.

**One subscription, `quantity` = number of sites.** ✅ Recommended. Adding a
site raises the quantity; Stripe prorates the mid-cycle difference itself.
One invoice, one renewal date, one payment method. And the "small discount on
the second site" is not a coupon at all — it is a **graduated price**: the
first unit at full price, units two and up at the reduced one. Pricing becomes
configuration in Stripe rather than logic in the app, which is where it
belongs.

`subscriptions` has no `quantity` column yet; it needs one, kept in step with
the Stripe object by the webhook that already maintains `status` and the period
dates.

### The webhook today

`app/api/stripe-webhook/route.ts` keeps `subscriptions` in step with Stripe
(tests: `tests/stripe-webhook.test.ts`).

- **Current state, not the payload.** For `customer.subscription.created` and
  `.updated` the subscription is retrieved from Stripe and that is written.
  Events arrive out of order, and a late `updated` written as-is would bring a
  canceled subscription back to active. `checkout.session.completed` already
  retrieved it; `deleted` sets `canceled`, which Stripe never leaves.
- **A user that cannot be found is a failure, not a 200.** The user comes from
  the subscription's `metadata.user_id`, else the checkout session's, else the
  customer's `metadata.supabase_user_id`. With none, the route answers 500 and
  reports to Sentry (fingerprint `stripe-webhook` / `unresolved-user`, with the
  subscription and customer ids), so Stripe retries and the operator sees it.
  Before 2026-11-08 it logged and answered 200, and the payment was lost.
- **Idempotency is recorded on success only.** An event id already in
  `processed_stripe_events` is acknowledged and skipped; the row is written
  after processing succeeded, never before, so a failed delivery is processed
  again on retry. Two concurrent deliveries can both process: every write is
  an upsert of Stripe's current state, so the second changes nothing.
- **A failed signature logs the reason only**, never the signature header or
  the body.

`lib/subscription.ts` reads at most one row per user (`limit(1)` +
`maybeSingle`): `hasActiveSubscription` takes an active or trialing row, the
one whose period runs latest first, and `getUserSubscription` prefers a live
row over the most recently updated one. A user with two rows (a canceled
subscription and its replacement) used to read as "not subscribed".

Known gap, unchanged: on the pinned API version (`2025-11-17.clover`) the
billing period lives on the subscription items, not the subscription, so
`current_period_start` / `current_period_end` are stored null and access
follows `status` alone.

## Enforcing it, which is not a UI problem

A paywall that only exists in the "add a site" screen is not a paywall. Two
places actually decide:

- **Creation.** Creating site N+1 while quantity is N sends the user to Stripe
  to raise the quantity, and the site is created on the way back, not before.
- **Every cron.** `autopilot`, `generate-articles`, `refresh-articles`,
  `probe-citations`, `discover-placements`, `qualify-placements` and
  `ingest-search-console` all fan out over businesses. Each of them must skip
  a business the account is no longer paying for, or a downgrade quietly keeps
  spending money on it forever.

And downgrades need a decision rather than a rule: lowering the quantity
should mark the excess businesses `suspended` and let the customer choose
which ones stay active. Deleting the newest by default destroys work the
customer paid for, on an action they may have taken by accident.

## Autopilot on every site (2026-11-24)

Autopilot is a setting of each site (`businesses.automation_settings`), not
of the account: Settings → Autopilot names the site it sets. The daily sweep
works on every site with it on, oldest first, and asks whether the owner
pays once per owner, so every site of a paying account is swept alike;
nothing in the plan limits Autopilot to one site. Each run stores what it did
for the site and why it did less when it did (`businesses.autopilot_run`,
docs/AUTOPILOT.md "Every site, and every run says what it did"), and the
site's Content screen and `get_content` say it.

## What this changes for Search Console

Nothing about *which Google account* — that is already free (see below) — but
it fixes where the connection lives. `analytics_connections` is keyed by user
today, so one account can hold exactly one Search Console connection. Per
business, it holds one per site, which is what a second SaaS needs: each
property is authorised by whichever Google account actually owns it, and the
two never meet.

## The Google account does not have to match the login

Worth stating plainly because it looks like it should be a problem and is not.

Signing into the product with Google (Supabase Auth) and connecting Search
Console are two separate OAuth flows with two separate consent screens.
`buildConsentUrl` sends no `login_hint` and no `hd` restriction, so Google
shows the account chooser and any account can be picked. The refresh token
that comes back is stored on `analytics_connections` and is the only thing
used afterwards; the login account is never consulted again.

So a customer who signs in as `someone@gmail.com` and authorises Search Console
as `hello@theircompany.com` is a normal, supported case, not a conflict. The
confirmation that they picked the right one is the property list on the
Search Console settings page: the site they expect either appears there or it
does not.

We deliberately do **not** ask for `openid`/`userinfo.email` just to display
which Google account is connected. It would widen the consent screen from "see
your Search Console data" to "see your Search Console data and know who you
are", and the property list already answers the question.
