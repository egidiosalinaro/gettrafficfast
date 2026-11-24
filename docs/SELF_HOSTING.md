# Self-hosting GetTrafficFast

This guide takes a fork of this repository to a running deployment of your
own: a Supabase project, a Next.js host (Vercel is what the app is built
for), the providers you choose, and the scheduled jobs. The hosted service
at gettrafficfa.st runs the same code from `main`.

Read the license notes first: the code is AGPL-3.0, so if you run a
modified version as a service you must offer its source to its users, and
the GetTrafficFast name and logo are not licensed to forks, so rename yours
([`TRADEMARKS.md`](../TRADEMARKS.md)).

## What you need

| | Required | Notes |
|---|---|---|
| Node.js 22 | yes | `.nvmrc` |
| A Supabase project | yes | Postgres, Auth, Storage. The free tier is enough to try it |
| A Next.js host | yes | Vercel (crons in `vercel.json`) or any Node host plus a scheduler |
| An LLM key | yes | Gemini (`GEMINI_API_KEY`) is the default provider |
| Everything else | no | Each provider below is optional and off until configured |

## 1. The database

1. Create a project at [supabase.com](https://supabase.com). Note its
   project ref, URL, publishable (anon) key and service role key
   (Project Settings, API).
2. Install the Supabase CLI (`npx supabase --version` works without a global
   install), then link and push the migrations:

   ```sh
   npx supabase login
   npx supabase link --project-ref <your-project-ref>
   npx supabase db push
   ```

   `db push` applies every file in `supabase/migrations/` in timestamp
   order. The first migration is the baseline for the core tables
   (businesses, keywords, articles, subscriptions); each later one builds
   on it. Every table has row-level security on.

   To check that the chain applies from zero, run it against a local stack
   with `npx supabase start` and `npx supabase db reset` (needs Docker).

3. **Auth.** In Authentication, URL Configuration, set the Site URL to your
   origin and add `<your-origin>/auth/confirm` (and
   `http://localhost:3000/**` for development) to the redirect URLs. Email sign-in works out of the box;
   for "Continue with Google", enable the Google provider with a Google
   OAuth client of your own.

4. **Storage.** Article images are stored in Supabase Storage when media is
   enabled; the bucket and its policies come with the migrations.

Migrations are never applied automatically by this repository. After you
pull a new version, run `npx supabase db push` again before deploying.

## 2. Environment variables

Copy `.env.example` to `.env.local` for development, and set the same
values in your host's environment for production. `.env.example` is the
reference: every variable is commented there. The groups:

### Required

| Variable | What it is |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Your Supabase project URL |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | The publishable (anon) key |
| `SUPABASE_SERVICE_ROLE_KEY` | Server only: crons, the job runner, webhooks |
| `GEMINI_API_KEY` | The default LLM provider (a billed key for image generation) |
| `CRON_SECRET` | A long random string; every cron route requires `Authorization: Bearer <CRON_SECRET>` and refuses everything when it is unset |
| `INTEGRATIONS_ENCRYPTION_KEY` | 32 random bytes as hex, encrypts stored WordPress and webhook credentials: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |

Also set your public origin. The product's own origin, name and contact
address live in [`lib/site.ts`](../lib/site.ts) (`SITE_URL`, `SITE_NAME`,
`CONTACT_EMAIL`); if your version of `.env.example` lists variables for
them, set those, otherwise change the constants in your fork. They appear
in emails, the MCP server's metadata, OAuth and sitemaps, so a fork must
not keep the originals.

### Optional providers

Each one is off until configured, and **a key alone never spends money**
where the feature is paid: the ones marked "opt-in" also need their switch.

| Feature | Variables | Without it |
|---|---|---|
| Claude as fallback or writer | `LLM_FALLBACK=anthropic` or `LLM_WRITER_PROVIDER=anthropic`, `ANTHROPIC_API_KEY` (opt-in) | Gemini only |
| SERP research | `SERPER_API_KEY` | Research step skipped, web-search discovery off |
| Citation probes (AEO) | `CITATIONS_GEMINI=true` (opt-in, reuses the Gemini key), `PERPLEXITY_API_KEY` | The weekly sweep reports itself disabled and records nothing |
| Search Console | `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, redirect URI `<your-origin>/api/integrations/search-console/callback` | Connect flow unavailable, no rank or click data |
| Fresh posts on X | `X_API_ENABLED=1` (opt-in), `X_API_BEARER_TOKEN`, `X_API_MONTHLY_CAP_USD` | Users add posts by pasting links; web search still finds some |
| Post on X from a site's connected account | `X_OAUTH_CLIENT_ID`, `X_OAUTH_CLIENT_SECRET` (both: the switch); see "Posting on X" below | No Connect in Settings, no onboarding step, every reply opens in X for the person to post |
| Reddit API | `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET` | Reddit threads come from web search (`SERPER_API_KEY`) |
| GitHub discovery | `PLACEMENTS_GITHUB=true` (opt-in), `GITHUB_TOKEN` | Off |
| Images and video | `IMAGES_ENABLED`, `IMAGE_PROVIDER`, `OPENAI_API_KEY`, `YOUTUBE_API_KEY` | No video without `YOUTUBE_API_KEY`. No image without `IMAGES_ENABLED=1`: the default provider uses `GEMINI_API_KEY`, the text models' key, so the key alone never starts spending on images. With it set, every site gets a featured image: on by default per site, turned off in Settings → Autopilot, Images and video |
| Notification email | `RESEND_API_KEY`, `NOTIFICATIONS_FROM_EMAIL` (a verified domain), `OPERATOR_EMAIL` | Notifications skipped |
| Billing | `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID`, `STRIPE_WEBHOOK_SECRET` | See "Running without billing" |
| Error monitoring | Sentry, see below | No error reports |

Replies on Reddit and everywhere else are only ever drafted: a person copies
the draft and posts it. On X, the same, except where the deployment sets up
posting (below) and a site connects its X account: then a reply to a post
that mentions or quotes that account is posted when the person presses
Post on X. Nothing in the code posts on its own.

#### Posting on X

In X's developer portal (developer.x.com), on the app of your project:

1. **User authentication settings → Set up.** App permissions: **Read and
   write**. Type of App: **Web App, Automated App or Bot** (a confidential
   client).
2. **Callback URI / Redirect URL**: `<your-origin>/api/integrations/x/callback`,
   exactly, where `<your-origin>` is your `NEXT_PUBLIC_SITE_URL` (for
   example `https://app.example.com/api/integrations/x/callback`). A preview
   deployment with another origin needs its own entry.
3. **Website URL**: `<your-origin>`.
4. **Keys and tokens → OAuth 2.0 Client ID and Client Secret**: copy them
   into `X_OAUTH_CLIENT_ID` and `X_OAUTH_CLIENT_SECRET`. (The app-only
   Bearer Token is `X_API_BEARER_TOKEN`, for reading; the OAuth 1.0a keys
   are not used.)

Posting is pay-per-use on X's side: every post is reserved and settled in
the same monthly ledger as the reads and refused over
`X_API_MONTHLY_CAP_USD`. `INTEGRATIONS_ENCRYPTION_KEY` must be set (the
tokens are stored encrypted with it).

Variables used only by the hosted service's own blog and marketing
(`BLOG_WEBHOOK_SECRET`, `OWN_BLOG_OWNER_USER_IDS`, `MCP_REGISTRY_AUTH`)
can stay unset. The X close-trial variables (`X_CLOSE_TRIAL_*`) are gone:
the close accounts are part of the daily X run (docs/PLACEMENTS.md).
`PLATFORM_OWNER_USER_IDS` lists the user ids that see the platform's cost
page (Settings, Platform); set it to your own user id if you want it.
`PLATFORM_OWNER_BUSINESS_IDS` (optional, comma-separated site ids) limits
those owner screens and tools to the listed sites, so that on any other
site of yours you see exactly what a customer sees; unset, the owner sees
them on every site (docs/API.md, "The owner's costs").

### Spending ceilings

Self-hosting does not remove the cost controls. `AGENT_BUDGET_USD` caps one
article across every agent and retry; `ACCOUNT_DAILY_SPEND_USD` caps each
account's AI work per day; drafts and corrections have daily caps per
account. Set them to what you are willing to spend.

## 3. Running without billing

The hosted service gates the app on a Stripe subscription. On your own
deployment set:

```sh
BILLING_DISABLED=1
```

With exactly `1` (`lib/billing-mode.ts`):

- every signed-in account counts as subscribed, on the screens, the REST
  API, MCP and the crons, and nothing reads the `subscriptions` table;
- Settings has no Plan group and `/settings/billing` is a 404;
- the Stripe variables can stay empty.

The spending ceilings and daily caps above still apply. Any other value, or
none, keeps billing on, which is what the hosted service runs.

Keep sign-ups in mind: with billing off, anyone who can create an account
on your Supabase project can use your provider keys up to the ceilings. For
a private deployment, disable new sign-ups in Supabase (Authentication,
Sign In / Providers, "Allow new users to sign up") once your accounts exist.

To run **with** billing instead, create a product and a recurring price in
Stripe (test mode is fine), set the three Stripe variables, and point a
Stripe webhook at `<your-origin>/api/stripe-webhook` with the subscription
and checkout events.

## 4. Deploying on Vercel

1. Import your fork as a Vercel project (framework: Next.js; no build
   settings to change).
2. Add the environment variables for Production (and Preview if you use
   previews, with separate non-production keys).
3. Deploy. Every push to the production branch deploys.

### Function region

`vercel.json` sets `"regions": ["cdg1"]` (Paris), next to the hosted
database (Supabase `eu-west-3`). Put your functions in the region of your
own database: a screen like Today makes a dozen database reads one after
another, and each one pays the distance. With functions in Washington and
the database in Paris, that alone was a second or more per load
(2026-11-19).

### Scheduled jobs

`vercel.json` declares the crons. Vercel calls each path with
`Authorization: Bearer <CRON_SECRET>`, which is why `CRON_SECRET` must be
set. Two of them, `/api/jobs/tick` (the durable job runner) and
`/api/cron/x-reply-links`, run **every 5 minutes**, and several others more
than once a day. **Vercel's Hobby plan only allows daily crons**, so:

- on **Vercel Pro**, `vercel.json` works as is;
- on **Hobby** or another host, call the cron URLs from an external
  scheduler (GitHub Actions `schedule`, a cron job on a server, a hosted
  cron service) with the same schedules and header:

  ```sh
  curl -fsS -H "Authorization: Bearer $CRON_SECRET" https://<your-origin>/api/jobs/tick
  ```

  Then remove or trim the `crons` in `vercel.json`, so the deployment does
  not fail on a schedule the plan refuses.

`/api/jobs/tick` is the one that matters most: articles, drafts and probes
are jobs, and nothing runs until it is called. Every 5 minutes is the
design; less often only makes the work slower. The other routes are
sweeps, each opt-in or a no-op when its provider is not configured. The
schedules, in UTC, are in `vercel.json`.

A function needs up to about 5 minutes (`/api/jobs/tick` uses a 240-second
budget), which is within Vercel's limits on Pro with Fluid compute; on
another host, make sure requests are not cut off sooner.

### Other hosts

`npm run build && npm start` runs the app on any Node 22 host. Put it
behind a proxy that terminates TLS, and see the next section.

## 5. Client IP behind a proxy

Rate limits and abuse checks (for example the free check on the home page
and the OAuth endpoints) read the caller's IP from `x-real-ip`, then the
first address in `x-forwarded-for`. On Vercel those headers are set by the
platform and cannot be forged by the caller. On any other host, **your
proxy must overwrite both headers** with the real client address (not
append to a value the client sent), or a caller can choose their own IP and
dodge the limits.

## 6. Sentry (optional)

Error monitoring is wired through `@sentry/nextjs` (`sentry.*.config.ts`,
`instrumentation*.ts`, `next.config.ts`). In a fork, replace the DSN and the
org and project in those files with your own Sentry project, or remove
them, so your errors do not go to the hosted service's Sentry. Set
`SENTRY_AUTH_TOKEN` at build time only if you want readable source maps;
without it the build succeeds. See [`SENTRY.md`](SENTRY.md).

## 7. After the first deploy

1. Sign up on your deployment, create a site in Settings, Business.
2. Fill About you (Settings, Voice and facts): replies are drafted only
   from it.
3. Optionally connect Search Console, a blog destination (WordPress or a
   webhook, [`INTEGRATIONS.md`](INTEGRATIONS.md)), and Claude through MCP
   (Settings, Claude and API).
4. Check that `/api/jobs/tick` is being called: a queued article moves from
   "queued" within minutes.

## Updating

```sh
git pull upstream main
npm ci
npx supabase db push     # new migrations first
```

then deploy. Read the commit history for changes that need a new variable
(`.env.example` is updated in the same commit).
