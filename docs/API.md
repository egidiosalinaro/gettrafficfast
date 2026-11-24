# API and MCP

The owner's rule: every action a person can take in the product can also be
taken through the API, and from there through MCP, so an agent (Claude Code,
Claude Desktop, ChatGPT, a script) can run the product. This document is the
contract for that surface. The architecture behind it is
`docs/ARCHITECTURE.md` §4.

What exists today: API keys, OAuth for MCP clients (so claude.ai and the
Claude apps connect as a custom connector, "Connect from claude.ai" below),
one tool registry, a REST runner over it, an MCP server over the same
registry, per-key limits and an audit log of every call, the account's own
limits (daily caps on paid actions and a hidden daily ceiling on AI work, counted
across every key, every connected app and the screens), the first domain,
**Replies** (on Today, `/today`, since 2026-11-14 with `get_today`; `docs/PLACEMENTS.md`),
the writes of the other screens: keywords, the calendar, AI Visibility, the
site and its settings, the voice, and integrations ("Write tools" below),
every read the screens make: articles, keywords, visibility, results, the
site, integrations and billing ("Read tools" below), and the calendar's
**Generate now** and **Publish** (`generate_article`, `publish_article`),
two MCP prompts that run the owner's routine from Claude (`daily_routine`,
`weekly_review`: "Prompts" below), and a parity table that a test holds
every screen action to ("Parity" below). Until a screen's actions are
tools, those actions are not on the API.

For people and for the agents they connect, the public docs
(`https://gettrafficfa.st/docs`, since 2026-11-14) summarise this contract,
and since 2026-11-16 the public MCP reference
(`https://gettrafficfa.st/docs/mcp`, `app/docs/mcp/page.tsx`,
`components/docs/mcp-content.tsx`) states all of it for any client: the
server, the plan requirement and the exact refusal, sign-in steps, key
snippets for Claude Code, Cursor, VS Code and generic clients, permissions,
prompts, every registry tool grouped by area with its annotations
(`components/docs/tool-areas.ts`), limits, every error code
(`components/docs/error-codes.ts`, typed over `API_ERROR_CODES`), privacy and
support. MCP registries and directories link there, so the address and its
anchors (`components/docs/mcp-sections.ts`) are stable; it is in the sitemap
and /llms.txt, and `tests/docs/mcp-page.test.tsx` holds it to the registry.
The older summary on /docs:
connecting Claude (`#claude`), the tools grouped by what they may do
(`#tools`, read from `TOOLS.list()` at request time, so a tool added to the
registry is listed on the next deploy), the REST call, the permissions and
the limits (`#api`, `#limits`, read from `TOOL_LIMITS`, `DAILY_DRAFT_CAP`
and `DAILY_CORRECTION_CAP`). The cap hints point there
(`HINTS.keyCaps`, `HINTS.accountCaps`): an outside agent cannot read this
file. Settings → Claude and API (`/settings/api-keys`) carries the same
two connection paths as numbered steps, above the keys.

The product never posts on a social site for you. No tool posts on X, Reddit
or anywhere like them: `get_reply_intent_url` hands back the link a person
opens to post the reply themselves, and `mark_reply_posted` records that they
did. One tool writes to the customer's **own** site: `publish_article`, which
delivers an article to the destination connected to that site (WordPress,
the webhook), as the calendar's Publish button does. It needs the `publish`
scope and `confirm: true`.

---

## Authentication

Three credentials, one answer (`resolveCaller`, `lib/api-auth.ts`):

| Credential | Who sends it | Where | Client the tools get |
| --- | --- | --- | --- |
| Supabase session cookie | the screens (a browser) | REST | the person's own RLS client |
| `Authorization: Bearer gtf_…` (API key) | a machine: Claude Code, a script | REST and MCP | the service role, narrowed to the key's owner (below) |
| `Authorization: Bearer gtfat_…` (OAuth access token) | an app the person connected by signing in: claude.ai, the Claude apps | MCP only | the same narrowed service role, for the grant's owner |

A Bearer header always wins over a cookie, and a Bearer header that does not
verify is a 401, never a fall-back to the cookie. The MCP endpoint takes a
key or an OAuth token, never the cookie; the REST runner takes the cookie or
a key. A Bearer token that does not start with `gtf_` is looked up as an
OAuth access token, and only where the endpoint says which resource it is
(`oauthResource`): a token is valid for the resource it was issued for, the
MCP endpoint, and nowhere else (MCP authorization, audience validation). At
the REST runner one is refused with 401 `invalid_token`.

An OAuth caller resolves to exactly what a key resolves to: the grant's
owner, its one site or every site (the same `chooseBusiness`), its scopes,
the owner-scoped service role, `via: "oauth"`, no key id, and the app
(`caller.oauth`: client id, grant id, whether it is limited to one site). So
the runner, the ownership checks, the scopes, the paywall, the per-key
limits (counted per app) and the account's own limits (the daily AI spend
ceiling and the per-account caps, "Account limits") apply unchanged, and an
app's calls count toward the account's caps with the keys' and the screens'.

### API keys

Created in **Settings → Claude and API** (`/settings/api-keys`), or with
`POST /api/api-keys` from a signed-in browser. Keys are managed with the
session cookie only: a key never mints, lists or revokes keys, so a leaked
key cannot make itself permanent.

- Format: `gtf_` followed by 32 random bytes in base64url (47 characters).
  Shown **once**, at creation. The table (`api_keys`, migration
  `20261109200000_api_keys.sql`) stores its SHA-256 (`key_hash`) and its
  first 8 characters (`prefix`, shown in Settings), never the key.
- Verification (`verifyApiKey`, `lib/api-keys.ts`) runs through the service
  role: it narrows on the prefix, then compares SHA-256 digests in constant
  time, every candidate compared. Unknown and revoked keys are refused;
  an unreadable table is an unknown key (fails closed).
- `last_used_at` is written at most once a minute per key: it answers "is
  this key still in use", not "how many calls".
- Revoking (`DELETE /api/api-keys/:id`) sets `revoked_at`; the row stays so
  Settings can say when a key stopped. A trigger keeps a revoked key
  revoked, and keeps what a key is (owner, site, hash, prefix, scopes) fixed:
  changing those is a new key.
- At most 20 live keys per account.

| Route | Auth | What |
| --- | --- | --- |
| `GET /api/api-keys` | cookie | the account's keys (no hashes) and its sites |
| `POST /api/api-keys` | cookie | `{ name, businessId?, scopes? }` → `201 { key, apiKey }`; `key` is the only copy |
| `DELETE /api/api-keys/:id` | cookie | revoke; revoking twice answers the first revocation |

### Scopes

| Scope | Allows |
| --- | --- |
| `read` | list and read |
| `write` | change the account's own data: edit a draft, mark as posted, skip, snooze, add keywords, schedule, edit settings |
| `spend` | start work that costs money: a model call, or a job that makes one (drafting, corrections, discovery, suggestions, a visibility run, generating an article), or switch on something that will (a visibility cadence, images, autopilot) |
| `publish` | put something public in the owner's name: `publish_article` (onto the site's own connected destination), and turning autopilot on (autopilot writes and publishes articles there); no tool posts on X |

A tool needs its own scope, plus `spend` when it is paid. A few changes need
more than their tool's scope for one value of the input only, and the
handler checks it before anything is written: turning a visibility cadence
or images on needs `spend`, turning autopilot on needs `spend` and `publish`
(403 `forbidden_scope` otherwise). A new key gets `read` and `write` unless
more are ticked: spending and publishing are the person's choice, never a
default (AGENTS.md §12). A session has every scope its owner has.

### The site

Every tool acts on one site, always one of the key owner's own businesses
(`chooseBusiness`):

1. A key limited to one site acts on that site. `x-gtf-business` naming
   another site of the account is **403 `forbidden_business`**.
2. `x-gtf-business: <site id>` naming a site the account does not have is
   **404 `business_not_found`**, never a quiet fall-back: a caller who named
   a site and got another would act on the wrong data.
3. No header: the key's site; for a key or a connected app for every site,
   its saved default site ("The default site" below) while that is still a
   site of the account, else the oldest site. A browser session uses the
   selected site from the cookie, with the screens' fall-back to the oldest
   (`pickBusiness`, `lib/tenancy.ts`).

`whoami` says which site the tools will act on (`business`), the default
(`defaultSite`, and `defaultSource`: `saved`, `oldest`, `only_site` or
`selected`) and which sites the key may name.

### The default site: `set_default_site`

Since 2026-11-23 a key or a connected app for every site can keep a default
site: the site its calls act on when they name none. It is saved on the
credential, `api_keys.default_business_id` or, for an app, on every row of
the grant's family in `oauth_tokens.default_business_id` (a refresh carries
it over to the rows it mints); migration
`20261123120000_credential_default_site.sql`. Null is "none saved": the
oldest site, as before. Deleting the site sets it null; a trigger keeps it
one of the owner's sites, and a one-site credential's own site.

Two ways to change it, one function (`saveDefaultSite`, `lib/tools/site.ts`):

- **`set_default_site`** (`write`, free) `{ site: string | null }`: the
  credential the call comes with. `site` is matched as the `site` argument
  is (`chooseSite`: id, name or domain, among the sites the credential
  covers, the same refusals); `null` goes back to the oldest. Answers
  `defaultSite` and `defaultSource`. A key or a grant limited to one site
  accepts its own site (it acts on it anyway, `only_site`) and refuses
  another with **403 `forbidden_business`**. A browser session has nothing
  to save it on (its default is the site picker) and is refused with **409
  `invalid_state`**. It is what an agent calls when the person says "use
  Bravo by default"; the MCP instructions and both prompts say so.
- **Settings → Claude and API**: each key and connected app for every site
  of an account with several shows its default site ("Oldest site" when
  none is saved) and a picker to change it: `PATCH /api/api-keys/:id` and
  `PATCH /api/connected-apps/:id` with `{ defaultSite: <site id> | null }`,
  session cookie only, both mapped to `set_default_site` in
  `lib/tools/parity.ts`.

Resolution, in order: the `site` argument, then `x-gtf-business`, then the
key's or grant's one site, then the saved default while it is still a site
of the account, then the oldest. The header and `site` never change what is
saved. Resolved per request, so a change applies to the very next call.

### Choosing the site in a call: `site`

Since 2026-11-23 every site-scoped tool (every tool but the few with
`needsBusiness: false`: `whoami`, `list_businesses`, `create_business`,
`analyze_website`, the billing reads, the owner's tools) takes an optional
`site` argument: the id, the name or the domain of one of the sites the
credential covers, case-insensitive (`"Bravo"`, `"bravo.test"`,
`"https://www.bravo.test/blog"` and its id all name the same site). It is for
the clients that cannot send `x-gtf-business` per call, above all claude.ai
and the Claude apps, so a person who connected with "All my sites" can say
"run my day for Bravo" and Claude passes `site: "Bravo"` on every call.

It is added once, not in each tool (`lib/tools/site.ts`):

- `describeTool` (`inputSchemaOf`, `lib/tools/schema.ts`) adds `site` to the
  published input schema of every site-scoped tool, so `tools/list` and
  `GET /api/v1/tools` show it; `defineTool` refuses a tool whose own input
  has a field named `site`.
- The runner takes `site` off the input after the plan and scope checks and
  before anything reads the site (`callerForSite`): the ownership checks
  (`owns`), the caps, the handler and the audit row all use the named site,
  and for a key or a connected app the owner-scoped client is rebuilt
  narrowed to that site, so a write can only land there. A handler never
  sees `site`.
- The match is among the sites the credential covers (`chooseSite`): an id
  first, else a name or a domain, and only when exactly one site matches.
  Several matches are **400 `invalid_input`** (name it by its id or domain);
  a site of the account outside a one-site key or grant is **403
  `forbidden_business`**; anything else is **404 `business_not_found`**.
  Every refusal lists the sites the credential may use, by name, domain and
  id, so the agent can ask the person. A key or a grant limited to one site
  can never reach another through `site`, by any name.
- Without `site`, nothing changes: the header's site, else the key's or the
  grant's, else its saved default, else the oldest. `site` and `x-gtf-business` together: the header
  picks the starting site, `site` the one the call acts on, within the same
  credential's sites.

### Tenancy: why the service role, narrowed

A session carries the user's JWT, and RLS adds `auth.uid() = user_id` to
every statement. An API key carries no JWT. Two ways to give it the same
guarantee were weighed:

- **Mint a short-lived user JWT** signed with a key Supabase trusts, and use
  an ordinary RLS client. Identical to the cookie session, but it needs the
  project's legacy HS256 JWT secret, or a signing key imported into
  Supabase, in the app's environment. Neither is there today (checked on
  2026-11-09: the Vercel project holds the URL, the publishable key and the
  service-role key only), and adding one would put a second all-powerful
  secret in the environment.
- **Explicit scoping, enforced centrally** (chosen). An API-key caller gets
  the service role wrapped by `ownerScopedClient`
  (`lib/supabase/owner-scoped.ts`), which does by hand what RLS does for a
  session: every select, update and delete carries `user_id = <owner>`;
  every insert or upsert must name the owner and the caller's site, and an
  update may not move a row to another owner or site; a table not listed in
  `OWNED_TABLES`, and `rpc`, `storage`, `auth`, are refused outright. On top
  of that, the runner (`lib/tools/runner.ts`) checks every id a tool's input
  names (`owns`) against the caller's user **and** site before the handler
  runs, and hands the handler only that client, user and site.

So a handler written against the cookie session's semantics (RLS checks the
owner, the code filters `business_id`) behaves the same for a key, and a key
for site A cannot reach site B even through a handler that forgot a filter.
Tests: `tests/supabase/owner-scoped.test.ts`, `tests/tools/runner.test.ts`,
`tests/tools/replies.test.ts` (every id-taking tool, with ids of another site
and another account).

`OWNED_TABLES` lists every table the tools reach, each checked to carry
`user_id` (a test reads the migrations): `aeo_probes`, `aeo_queries`,
`aeo_runs`, `ai_citations`, `analytics_connections`, `api_keys`, `articles`,
`businesses`, `competitors`, `content_metrics`, `draft_feedback`, `entities`,
`index_status`, `integrations`, `jobs`, `keywords`, `placement_targets`, `placements`,
`publish_attempts`, `subscriptions`. Two of them hold credentials, and the
tool layer never selects them: `analytics_connections.refresh_token_encrypted`
(the Search Console token is decrypted only inside
`lib/analytics/properties.ts`, through the service role, as the screen's
route does) and `integrations.config.*_encrypted` (dropped by `publicConfig`,
`lib/integrations/read.ts`, before anything sees the config). The ids the
runner can check (`owns`) are those of `placement_targets`, `placements`,
`jobs`, `keywords`, `articles`, `aeo_queries` and `draft_feedback`.

### The paywall and the caps

The same checks as the screens, read through the caller's own client
(`paidAccessDenial`, `lib/paid-access.ts`; `hasActiveSubscription` and
`getUserSubscription` take a client for exactly this):

- **every tool needs an active plan** (owner decision, 2026-11-16), reads
  included: "Without a plan" below. The only exception is the platform
  owner's `get_platform_costs` (`withoutPlan: true`), gated on the owner by
  its handler. A **paid** tool (it costs money) also needs the `spend` scope;
- the daily caps hold whatever the caller: 60 draft jobs and 100 corrections
  per account per rolling 24 hours (`DAILY_DRAFT_CAP`,
  `DAILY_CORRECTION_CAP`), 429 `cap_reached`;
- a paid tool also passes the account's limits ("Account limits" below): the
  daily AI spend ceiling (429 `spend_cap_reached`) and, for the tools that
  have one, the account's daily cap (429 `cap_reached`).

The worker checks again when a paid job runs: a job queued before the
account lapsed is failed with "Subscription inactive: …", not paid for
(`docs/AGENT_RUNTIME.md`, "When the owner stops paying").

A self-hosted deployment can run without billing: with `BILLING_DISABLED=1`
(`lib/billing-mode.ts`, `docs/SELF_HOSTING.md`) `hasActiveSubscription` and
`hasPaidAccess` answer yes for every signed-in account, so no call is refused
as `subscription_required`, and Settings has no Plan group. The daily caps
and the account limits above still hold. Unset, or any value other than `1`,
billing is on, which is the hosted service.

### Without a plan

Owner decision, 2026-11-16, before listing the MCP server in registries: a
caller whose account has no active plan (none yet, a period that ended,
cancelled, past due or unpaid: whatever `hasActiveSubscription` does not
count as live) gets one clear, agent-readable answer, the same everywhere.

| Step | What happens without a plan |
| --- | --- |
| `POST /api/mcp` with no credential | 401 with `WWW-Authenticate: Bearer resource_metadata="…"`, unchanged, never 403 (registry scanners require it). No account is needed to see it |
| Sign-in (`/oauth/authorize`) without an account | sent to `/auth/sign-up?next=…`, which offers sign-up and comes back to the same request |
| Consent screen, signed in, no plan | shown, with a note: "This account has no active plan." and that every tool will answer that its tools are unavailable until it has one, linking Settings → Billing. Allow works: a code, then tokens |
| `initialize`, `tools/list`, `prompts/list`, `prompts/get` | work, so the agent can say what GTF does; the `instructions` tell it what the refusal means and what to say |
| `tools/call`, any tool (read, write, paid) | a tool result with `isError: true` and `{ "error": { code, message, hint } }`, before scopes, site, input or ownership are checked, and nothing else is read |
| `POST /api/v1/tools/:name` (key or session) | the same object, HTTP 402 |

The refusal (`planRefusal`, `lib/tools/runner.ts`; text in
`lib/paid-access.ts`):

- `code`: `subscription_required` (stable; the same code paid tools always
  answered, so existing clients keep working)
- `message` (`PLAN_REQUIRED_MESSAGE`): "This GetTrafficFast account has no
  active plan, so its tools are unavailable. The account owner can manage the
  plan at https://gettrafficfa.st/settings/billing."
- `hint` (`PLAN_REQUIRED_HINT`): "The plan is checked on every call: once the
  account has an active plan, this same connection or key works again, with
  nothing to reconnect. Calling again before then gets the same answer."

Why connect and refuse calls, rather than refuse at consent: the agent gets
the same precise sentence at the moment it tries to work, whatever client it
is; discovery (`tools/list`, prompts) keeps working for the agent to explain
the product and for directory reviewers; and the connection starts working by
itself once the plan is active, with nothing to redo. Refusing at consent
would leave the client with a bare `access_denied` and no reason it can show.

Factual, not promotional, on purpose: the ChatGPT/Codex app directory forbids
a listed app from showing plans, starting subscriptions or promoting upgrades,
and Anthropic's directory reviews copy. So the refusal and the MCP
instructions name no price, no pricing page, and no "upgrade" or "buy"; they
say the account has no active plan and where its owner manages it. The
pricing page is linked only from the public docs (`/docs/mcp#plan`).
`/settings/billing` for a signed-in account without a plan redirects to
/pricing, as every app screen does (`requireAppAccess`).

Tests: `tests/oauth/unpaid.test.tsx` walks every step through the real routes
and the real `hasActiveSubscription`, for no account, no plan, an ended
period, a cancelled plan and a past-due one, and the active, trialing and
no-period-end cases that pass.

### Limits and the audit log

Every call the runner runs, a key's, an app's or a session's, whatever its
outcome, is a row in `tool_calls` (migration `20261109233000_tool_calls.sql`,
`lib/tools/usage.ts`): user, site, key (`api_key_id`, null for a session or
an OAuth app), the app (`oauth_client_id`, null unless the call came over
OAuth; migration `20261110160000_oauth.sql`), tool, `status` (`ok` or the error code it answered with), `duration_ms`, and
`cost_usd` when the tool measured one. Null cost means "not measured", never
"free": `generate_article`, `draft_reply` and `run_reply_discovery` report
the model cost of their job (`agent_runs.cost_usd`) when it finished while
the call waited; a job still running when the call answered has no cost on
its row, and searches and images are not in `agent_runs`. The row is written
without waiting (`after`), and a row that cannot be written is a warning,
never a failed call. Users read their own rows (RLS), every column but
`cost_usd`; only the service role writes.

An API key is held to two limits, read from that table, on top of the
account's caps above and its own limits below. An app connected over OAuth
is held to the same two, counted on its `oauth_client_id` for that account
(the message says "This connected app" instead of "This key"). A session is
not held to these two.

| Limit | Per key | Refusal |
| --- | --- | --- |
| Burst | 60 calls in any 60 seconds, any tool, refused calls included | 429 `rate_limited`, `Retry-After: 60` |
| `run_reply_discovery` | 10 successful calls per rolling 24 hours | 429 `cap_reached` |
| `generate_article` | 10 | 429 `cap_reached` |
| `analyze_website` | 10 | 429 `cap_reached` |
| `run_visibility_check` | 4 | 429 `cap_reached` |
| each `suggest_*` tool | 30 (each tool its own count) | 429 `cap_reached` |
| `draft_reply`, `add_x_post`, `correct_reply_draft` | no per-key cap: the account's draft and correction caps bound them | |
| `find_reply_link` | no per-key cap: six searches per posted reply, ever, under the platform's monthly X cap | 409 `invalid_state` past the six |

The numbers live in one object, `TOOL_LIMITS`. A daily cap counts the key's
**successful** calls of that tool: a refused call started nothing. A new
paid tool needs a cap there or a place in `cappedPerAccount`; a test refuses
one with neither. The counts are not transactional: parallel calls can pass a
cap by the calls in flight. An account holds at most 20 live keys and 20
live OAuth grants (`MAX_LIVE_GRANTS`; the consent screen refuses a 21st),
which is why the same numbers also hold the whole account ("Account limits"
below): twenty keys, or twenty connected apps, no longer mean twenty times
the cap.

If `tool_calls` cannot be read (the migration not applied yet), the limits
let every call through and log `tool.limits_unavailable` at most once a
minute: a missing audit table must not take the API down, and the paywall
and the account caps still hold.

Settings → Claude and API shows each live key's calls in the last 7 days
(`tool_call_counts`, a security-invoker function, so the person's own RLS
applies; no cost), and says when usage cannot be read instead of showing
zeros. The older `tool_call_usage`, which also sums `cost_usd`, is
executable by the service role only.

The screens' own calls of `analyze_website`, `suggest_keywords` and
`suggest_prompts` (Analyse my site, Suggest on Keywords, Suggest prompts on
AI Visibility) are recorded too when they succeed, with no key
(`recordScreenAction`, `lib/limits/actions.ts`): they leave no other trace,
and the account's cap on them must count the screens with the API.

**Retention.** Rows are kept 90 days. A daily cron,
`/api/cron/prune-tool-calls` (03:40 UTC, `CRON_SECRET`), deletes older rows
through the service role, oldest first, in batches of 5,000 (at most 20 a
run; the next day's run takes any rest), on the `tool_calls (created_at)`
index (migration `20261110151000_tool_calls_created_index.sql`,
`lib/tools/retention.ts`). The delete is the route's, at runtime, never a
migration's. The limits read the last 24 hours and Settings the last 7
days, so nothing they count is ever deleted.

### Account limits

The per-key limits hold one key. These hold the **account**, whatever the
caller: every API key, every app connected over OAuth, a session over the
REST runner, the screens' routes,
the job worker and the crons. `lib/limits/`; the routes and the runner ask
one function, `accountCapacityDenial` (`lib/limits/guard.ts`), so the two
doors cannot disagree.

**The daily AI spend ceiling, invisible to the customer.** The model cost
of the account's agent runs (`agent_runs.cost_usd`) over a rolling 24
hours, every site together, held to a ceiling: the account's own ($1 to
$100, stored in `account_limits`, migration
`20261110150000_account_limits.sql`, set by a platform owner on
`/settings/costs`, "The owner's costs" below), else
`ACCOUNT_DAILY_SPEND_USD`, else **$5**. It protects the platform's model
credits from a customer, a bug or a leaked key. Since 2026-11-14 (the
owner's decision of 2026-11-13) a customer never sees it in dollars and
never sets it: a subscriber pays a fixed price. At or above it, every paid
tool and every paid route refuses with **429 `spend_cap_reached`** (the
code keeps its name for compatibility), in the customer's terms: "You've
reached today's limit for AI work. It resets at about 14:05 UTC on Nov 15."
(`spendCapMessage`, `lib/limits/spend.ts`). The routes add
`href: "/settings/billing"` (the plan card, where the quotas are) and
`Retry-After` (when the run that crossed the ceiling leaves the 24 hours).
Paid jobs wait in the queue instead of failing (`docs/AGENT_RUNTIME.md`),
and the per-customer crons leave the owner out of that run.

- **A cost that was not recorded is not $0.** A run that threw before it
  reported its usage records a null cost (`lib/agents/runner.ts`), and the
  ceiling counts each such run at a conservative estimate for its agent,
  cheaper when the row names a Flash or Haiku model, the dearest figure for
  an agent it does not know (`lib/limits/estimates.ts`: two to three times
  the dearest run measured in production by 2026-11-10). The estimated part
  is kept apart and the owner's costs page shows it as an estimate.
- **Model cost only.** Searches (Serper), answer-engine probes, images, and
  the two model calls that do not go through an agent (keyword suggestions
  and site analysis) are not in `agent_runs`, so they are not in this
  figure. The caps below bound them.
- **Setting it** is a platform owner's act, signed in, on `/settings/costs`:
  `POST /api/owner/spend-limit` (`{ userId, dailySpendUsd, confirm? }`)
  answers 404 to anyone who is not an owner, saves a lower ceiling at once,
  and refuses a raise without `confirm: true` (409 `confirmation_required`;
  the screen's second tap). The route reads the session cookie and nothing
  else, so an API key can never raise a ceiling, not even an owner's key.
  The write is the service role's after the owner check: migration
  `20261114140000_account_limits_owner_only.sql` turned the customer's
  insert and update policies into `with check (false)` / `using (false)`
  (renamed "Customers cannot set/change account limits"); the customer
  still reads his own row. The bounds are also a check constraint.
  `POST /api/billing/spend-limit`, the customer's route, is gone.

**What the customer reads instead: quotas in his own units.** Settings →
Billing's plan card and the `get_plan_usage` tool read
`loadPlanUsage` (`lib/limits/quotas.ts`): only limits the code enforces,
each from the number that enforces it, never a dollar amount.

| Quota | Limit | Period | From |
| --- | --- | --- | --- |
| Articles on this month's calendar, one a day | the month's days | calendar month (UTC), the selected site | `unique (business_id, scheduled_date)` on `articles` |
| Reply drafts | 60 | rolling 24 hours | `DAILY_DRAFT_CAP` |
| Draft corrections | 100 | rolling 24 hours | `DAILY_CORRECTION_CAP` |
| Articles generated on demand, Reply discovery runs, AI Visibility runs, Site analyses, Keyword suggestions, Prompt suggestions | 10, 10, 4, 10, 30, 30 | rolling 24 hours | the account caps below (`TOOL_LIMITS`) |

`used` is null ("could not be read") when a count fails, never 0. The
ceiling shows only as `aiWork`: `available`, `reached` (with the sentence
above and `resetsAt`) or `unknown` (it could not be checked, so new AI work
waits). Settings → Claude and API shows each key's calls, no longer the
model cost measured on them.

**Daily caps per account.** The per-key numbers, counted across every key,
every session and the screens, over a rolling 24 hours, 429 `cap_reached`
("This account has started 10 reply discovery runs in the last 24 hours,
its daily limit of 10 across the screens and every API key."):

| Action | Per account | Counted from |
| --- | --- | --- |
| `run_reply_discovery` (Run discovery) | 10 | `jobs` of type `placement-discovery` asked for by a person or an agent (`MANUAL_JOB_PRIORITY`) |
| `generate_article` (Generate now) | 10 | `jobs` of type `produce-article`, the same |
| `run_visibility_check` (Run now) | 4 | `jobs` of type `aeo-run`, the same |
| `analyze_website` (Analyse my site) | 10 | successful calls in `tool_calls`, the screens' included |
| each `suggest_*` tool | 30 each | the same, per tool |
| `draft_reply`, `add_x_post`, `correct_reply_draft` | | the account caps they already had (60 drafts, 100 corrections) |
| `find_reply_link` | | six searches per posted reply (`placement_link_searches.attempts`, written by the platform only), and the platform's monthly X cap |

A job-starting action counts the jobs it started, whoever asked: the route
and the tool enqueue the same job, so nothing is counted twice, and a call
that found a job already running started nothing. The crons' own scheduled
jobs (priority 0) are not actions and are not counted; the spend ceiling
holds them.

**Reading them.** A spend or a count that cannot be read refuses the paid
action with **503 `unavailable`** ("Today's AI work could not be checked,
so nothing was started. Try again in a minute."): fail closed for money.
The worker holds the job for 5 minutes instead; a cron leaves the owner out
of that run. A table that is not there at all (a migration not applied yet)
lets the action through with a throttled warning (`spend.ceiling_unavailable`,
`account_caps.unavailable`), as the per-key limits do: the guard must not
take the product down.

### The owner's costs

What the platform pays is the owner's business, not the customer's. The
owners are listed in `PLATFORM_OWNER_USER_IDS` (comma-separated user ids,
set on Vercel for production and preview; `isPlatformOwner`,
`lib/owner.ts`). Fail closed: unset, empty or blank means nobody is an
owner. Privilege comes from the environment, never from a row a user can
write.

**The owner's sites.** An owner's account may hold sites that are not the
platform's (another product of theirs), and on those the owner wants the
experience any customer has. `PLATFORM_OWNER_BUSINESS_IDS` (optional,
comma-separated site ids, case-insensitive) names the platform's own sites.
When it is set, every owner-only behaviour below applies only when the user
is an owner **and** the site in hand is listed: in the browser the selected
site, over a key or a connected app the site the call resolves to (the
`x-gtf-business` header, else the saved default site, else the oldest).
Unset, empty or blank: no site condition, an owner is an owner on every
site, as before the variable existed. It only narrows; it makes nobody an
owner. The one check is `isPlatformOwnerHere(userId, businessId)`
(`lib/owner.ts`); `isPlatformOwnerSite(businessId)` is its site half.

On a site that is not listed the owner gets the customer's answer: no
Platform group in Settings (list and column), `/settings/costs` the app's
404, `POST /api/owner/spend-limit` and `POST /api/owner/reviewer-account`
404 (they decide by the selected site, as the page does),
`GET /api/articles/provider-comparison` without `avgCostUsd`, and
`get_platform_costs` neither listed nor callable (below). The account's
own rows stay account-wide, because they have no site: the plan (a
complimentary plan included), the daily AI spend ceiling in
`account_limits` and the account caps are the account's on every site, as
for any customer with two sites; only the screens that show or set them
are per site.

- **`/settings/costs`** (`app/(app)/settings/costs/page.tsx`), listed as
  Settings → Platform → Costs for an owner only (the server passes
  `isOwner` to the list and the column). Anyone else gets the app's 404
  before anything is read. It shows, from `readPlatformCosts`
  (`lib/limits/platform-costs.ts`, service role, one query per table):
  this month's ledger per provider (`provider_spend`: the X API against
  `X_API_MONTHLY_CAP_USD` (default 20), with its
  pause; any other provider the ledger holds, "no monthly cap"); and each
  account with a run in the last 24 hours, its own ceiling or a live
  subscription: model cost against its ceiling, counted with `tallyRuns`,
  the function the ceiling itself counts with (a null cost estimated and
  shown apart, never $0), with the ceiling control (bounds and two-step
  raise as above). What could not be read says so; past 10,000 runs the
  totals say they are floors.
- **`get_platform_costs`** (`lib/tools/owner.ts`), read scope, free, the
  same reading. It is **not in `TOOLS`**: the public catalogue
  (`GET /api/v1/tools`), the public docs and a customer's MCP `tools/list`
  never name it. `registryFor(userId, businessId)` adds the owner's tools
  for an owner's session, key or connected app on one of the platform's
  own sites; the runner and the MCP server use it. The owner's tools take
  no `site` argument, so the site that decides is the connection's (the
  header, else the saved default, else the oldest; the selected site for a
  session): `tools/list`, built once per connection, and every call are
  decided by that same site, so what is listed is what answers. To use it
  from a connection whose default is another site, send the header or make
  the platform's site the default (`set_default_site`). For anyone else a
  call is the same 404 `unknown_tool` a made-up name gets ("There is no
  tool named get_platform_costs."); an owner on another site gets the same
  code and status with a message that says where it answers
  (`offSiteOwnerTool`), and the handler checks owner and site again. No tool sets a ceiling: that stays a signed-in
  session's act, so no key can ever raise one.

**What a customer never sees** (owner's decision, 2026-11-14: "Customers
pay GTF and that's it, everything included"). No screen, route, tool
output, tool description, confirmation, job result or error a customer can
read states what the platform pays or prices a unit of work:

- AI visibility runs and probes carry no `costUsd` (`RUN_COLUMNS` and
  `PROBE_COLUMNS` do not read `cost_usd`; the run's finish step sums it into
  `aeo_runs.cost_usd` with `runCostUsd` and leaves it out of its output,
  which is the job's `result`).
- Images: no price per image or per article on Settings → Autopilot →
  Images and video, in `update_media_settings` or its confirmation, which
  counts images (`maxImagesPerArticle`); "included in your plan".
- `compare_article_providers` leaves out each agent's `avgCostUsd`
  (`withoutCosts`); `GET /api/articles/provider-comparison` answers it to a
  platform owner only, on the platform's own site.
- Settings → Claude and API gets each key's calls (`loadKeyUsage`, the
  RPC `tool_call_counts`), never a summed cost; the cost stays on
  `tool_calls.cost_usd`.
- A budget refusal names no amount (`AgentBudgetExceeded`; the amounts are
  in the `agent_budget.exceeded` log line), and the revision a budget
  skipped says so without one.

**Down to the column** (migration
`20261114160000_hide_costs_from_customers.sql`). The screens are not the
only door: a signed-in customer can call PostgREST with his own session JWT
(role `authenticated`), and RLS lets him select his own rows. So the role
itself cannot select what the platform pays:

| Table | Not selectable by `authenticated` |
| --- | --- |
| `agent_runs` | `cost_usd`, `llm_calls` (each call's `costUsd`) |
| `aeo_runs`, `aeo_probes`, `tool_calls` | `cost_usd` |
| `media_assets` | `meta` (holds `cost_usd`; no customer read selects the table) |

Every other column is granted by name; `anon` selects none of them. Only
SELECT moved: the write grants are as they were, and RLS still admits no
customer write. The RPC `tool_call_usage` (it sums `cost_usd`) is the
service role's only; customers get `tool_call_counts`. Three consequences
for code:

- A read of these tables through a session client lists its columns, and
  none of them is a cost: `select("*")` or a bare `select()` fails with
  "permission denied". `RUN_COLUMNS` and `PROBE_COLUMNS` are the lists.
- Whatever needs a cost reads it with the service role after the existing
  ownership check: the spend ceiling (`requireAccountCapacity` takes
  `createAdminClient`, the plan card calls `loadPlanUsage` with the service
  role, both filtered on the signed-in user, and only the verdict leaves),
  the workflows, the owner's page and tool.
- A column added to one of these tables later is not selectable by
  `authenticated` until a migration grants it by name.

Pinned by `tests/tools/no-costs.test.ts`: every tool in a customer's
registry has no cost or USD field in its output schema and no price in its
description, and the owner's registry is the only one with
`get_platform_costs`. What stays: the public pricing page and checkout
(what the customer pays), `read-keywords`' `cpc` (what advertisers pay
Google, a market figure), the ledger, `agent_runs.cost_usd`, the
`cost_usd` columns, the logs, the spend ceiling (invisible) and the
owner's page and tool.

### The reviewer account

The MCP directories (Anthropic's Verified review, OpenAI's app review)
review a server by signing into it: they need a permanent account with a
live plan, signed into with an email and a password, no 2FA, no magic link
(owner, 2026-11-16). Everyone else still signs in with the emailed link or
Google.

**Password sign-in, for a list of addresses only.** `PASSWORD_LOGIN_EMAILS`
(comma-separated, case-insensitive, set on Vercel production; fail closed:
unset means nobody) names them (`lib/password-login.ts`). On the sign-in
form (`components/sign-up-form.tsx`), once a whole address is typed, the
form asks `POST /api/auth/sign-in-method` `{ email }`, which answers
`{ password: true }` for a listed address and `{ password: false }` for
every other one. Only then does a password field appear, and the button
signs in with `signInWithPassword`; for any other address the form sends
the magic link exactly as before. Submitting before the answer arrived asks
first, so a listed address never gets a link by accident. Why it leaks
nothing: the list never reaches the browser; the route reads only the
environment (no account is looked up, so an unlisted address gets the same
"no" whether it has an account or not: no enumeration); and it is
rate-limited per caller (20 lookups in 10 minutes per server instance, then
429, on which the form keeps the link). A correct guess of the address
still needs its password.

After a password sign-in the form goes to `/auth/confirm` with the same
`?next=`, which lands a signed-in person where the link would have: an
OAuth authorization (`/oauth/authorize` → sign-in → back to the consent
screen) works unchanged, so a reviewer connects claude.ai or ChatGPT with
the password.

**Setting it up (owner).** `/settings/costs` → *Directory reviewer
account* lists the addresses on `PASSWORD_LOGIN_EMAILS`, each with one
button (`POST /api/owner/reviewer-account` `{ email }`, owner-only, 404 to
anyone else, session only; `lib/reviewer-account.ts`). Idempotent: it
creates what is missing and keeps what is there.

1. The auth user, confirmed, **without a password**.
2. A **complimentary plan**: a `subscriptions` row with `source = 'comp'`
   (migration `20261116110000_comp_subscriptions.sql`: a `source` column,
   `'stripe'` by default, and a check that a comp row has no Stripe ids),
   status `active`, no period end. `hasActiveSubscription` reads it like
   any live row; the Billing page says "Complimentary · no payment and no
   renewal" and shows no billing-portal button. Customers still write no
   `subscriptions` row (RLS), so nobody grants himself one.
3. The lowest **daily AI spend ceiling**, $1 (`account_limits`), unless the
   owner already set one for the account.
4. One **site**: gettrafficfa.st itself (blog and sitemap), public pages the
   real pipeline can read, nothing invented. Autopilot, Push page 3 and
   Find posts on X stay at their defaults, all off. **No publishing
   destination is connected**, so Publish has nowhere to write: a reviewer
   can grant the Publish scope, and `publish_article` answers
   `prerequisite_missing` (no destination connected). Never connect one on
   this account.
5. A **set-password email** from Supabase (`resetPasswordForEmail`) to the
   address, redirecting through `/auth/confirm?next=/auth/set-password`.
   `/auth/set-password` (public: the link may carry its session in the URL
   fragment) turns the link into a session and posts the new password to
   `POST /api/auth/set-password`, which refuses (404) any account not on
   the list and wants 12 characters at least. The owner chooses the
   password there: no password is ever chosen, returned, logged or stored
   by the app.

Each tap sends a fresh set-password email, which is also how the password
is rotated after a review. The credentials go to a reviewer by email, on
request, never in a listing.

---

## Errors

One shape for the REST runner, `/api/api-keys` and MCP:

```json
{ "error": { "code": "cap_reached", "message": "You have started 60 drafts…", "hint": "Daily caps count a rolling 24 hours…" } }
```

`code` is stable; branch on it. `message` is the sentence the screens show.
`hint`, when present, says what to do next.

| Code | Status | Meaning |
| --- | --- | --- |
| `unauthorized` | 401 | no credential |
| `invalid_api_key` | 401 | not a live GetTrafficFast key |
| `revoked_api_key` | 401 | the key was revoked |
| `invalid_token` | 401 | an OAuth access token that is unknown, expired, revoked, issued for another resource, or sent to the REST runner |
| `business_not_found` | 404 | `x-gtf-business` names a site the account does not have, or `site` names none of the credential's sites |
| `forbidden_business` | 403 | the key, or the connection, is limited to another site |
| `forbidden_scope` | 403 | the key, or the connected app, lacks a scope the tool needs |
| `no_business` | 409 | the account has no site yet |
| `unknown_tool` | 404 | no tool by that name |
| `invalid_input` | 400 | the input does not match the tool's schema, or a value is refused (a link that is not the person's reply) |
| `not_found` | 404 | the id names nothing on this site |
| `invalid_state` | 409 | the thing exists but cannot make that move now |
| `prerequisite_missing` | 409 | fill something in first (Settings → Voice → About you, a prompt before a run, Search Console before a property) |
| `confirmation_required` | 409 | the call would switch spending on and did not say `confirm: true`; nothing changed. The message says what it would start, the hint how to go ahead |
| `subscription_required` | 402 | the account has no active plan: every tool answers it ("Without a plan") |
| `cap_reached` | 429 | a daily cap, the account's or the key's (409 for the key limit) |
| `spend_cap_reached` | 429 | today's limit for AI work is reached (the account's hidden spend ceiling); the message says when it resets, never an amount; queued work waits |
| `rate_limited` | 429 | this key made 60 calls in the last minute; `Retry-After` says when to come back |
| `unavailable` | 503 | the AI provider or discovery is not available, or the account's spend or usage could not be checked; nothing changed |
| `delivery_failed` | 502 | the customer's own site (its publishing destination) refused the article |
| `internal` | 500 | our failure; logged as `tool.call` with the detail, never sent back |

The list lives in `lib/api-errors.ts`.

---

## REST

| Route | What |
| --- | --- |
| `GET /api/v1/tools` | the catalogue, public: each tool's name, title, description, `scopes`, `paid`, `subscription`, and the JSON Schemas of its input and output |
| `POST /api/v1/tools/:name` | runs one tool. Body: the input as JSON (`{}`, or empty, for none). 200 answers with the tool's output as the body |

```sh
curl -X POST https://gettrafficfa.st/api/v1/tools/list_reply_inbox \
  -H "Authorization: Bearer gtf_…" \
  -H "Content-Type: application/json" \
  -d '{"status":"open","limit":10}'
```

The schemas come from the same Zod schemas the runner validates with
(`z.toJSONSchema`, `lib/tools/schema.ts`), so the description cannot drift
from the check. Outputs are validated too: a handler that returns the wrong
shape is a 500, not a malformed answer.

### Add a post from the iPhone's share sheet

`add_x_post` is enough to add a post from the X app without opening the
product: an iOS Shortcut that takes the shared link and sends it. Nothing
new is built for it; it is the REST call above.

1. Settings → Claude and API: create a key for the one site, with **Write** and
   **Spend** ticked (`add_x_post` is a paid write: it starts a draft). Copy
   it once.
2. In the Shortcuts app, a new shortcut named "GetTrafficFast", with "Show
   in Share Sheet" on and "URLs" as the input it receives.
3. One action, **Get Contents of URL**:
   - URL: `https://gettrafficfa.st/api/v1/tools/add_x_post`
   - Method: `POST`
   - Headers: `Authorization` = `Bearer gtf_…` (the key),
     `Content-Type` = `application/json`
   - Request Body: JSON, one field `url` (Text) = the Shortcut Input.
4. In X: Share → GetTrafficFast.

```sh
curl -X POST https://gettrafficfa.st/api/v1/tools/add_x_post \
  -H "Authorization: Bearer gtf_…" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://x.com/name/status/1234567890"}'
```

The input is `{ url, text? }` (`AddXPostBody`, `lib/placements/add.ts`):
`url` is the post's own link, with or without X's `?s=…` tracking; `text`
is only for a post X will not hand over. A 200 answers
`{ outcome, textFrom, target, draft }`: the post is in the inbox under
Yours and its draft is being written (`draft.started`), or is held with the
reason in `draft.error` (the daily draft cap, About you empty). A link that
is not a post on X is a 400 `invalid_input`; a key without Spend is a 403
`forbidden_scope`. A key for every site also needs
`x-gtf-business: <site id>`. The key is stored in the Shortcut on the
phone: revoke it in Settings → Claude and API if the phone is lost.

## MCP

`POST https://gettrafficfa.st/api/mcp`, Streamable HTTP, stateless, JSON
responses (no MCP session id, no server-sent stream; GET and DELETE answer
405). Built on `@modelcontextprotocol/sdk` 1.32.2, pinned, with its
web-standard transport (`WebStandardStreamableHTTPServerTransport`): it takes
the route's `Request` and returns a `Response`, so no adapter is needed.

CORS (since 2026-11-16, `MCP_CORS_HEADERS` in `lib/oauth/config.ts`), for
browser-based MCP clients and registry inspectors: `OPTIONS` answers 204, and
every answer (the 401 and the 405 included) carries
`Access-Control-Allow-Origin: *`, methods `POST, GET, DELETE, OPTIONS`,
allowed headers `Authorization, Content-Type, Accept, Mcp-Session-Id,
Mcp-Protocol-Version, Last-Event-ID, x-gtf-business`, and exposes
`Mcp-Session-Id, WWW-Authenticate` so a browser can read the sign-in
challenge. The credential is a Bearer header, never a cookie, so any origin
grants nothing.

Without a credential, or with one that does not verify, the answer is 401
with `WWW-Authenticate: Bearer realm="gettrafficfast",
resource_metadata="https://gettrafficfa.st/.well-known/oauth-protected-resource/api/mcp"`
(plus `error="invalid_token"` when a credential was sent), and the error
object as the body. That header is what starts Claude's sign-in, and where it
learns which authorization server to use ("Connect from claude.ai").

The server's `instructions` (`MCP_INSTRUCTIONS`, `lib/tools/mcp.ts`) say
that a connection may cover several sites, that `whoami` lists them and the
default one, and that Claude uses the site the person names, asks which one
when they name none, and passes it as `site` on every call of the task
("Choosing the site in a call"); and that every tool needs an active plan, that without one every call answers
`subscription_required`, and that the agent should not retry and should tell
the person the account has no active plan and that its owner manages it at
Settings → Billing.

`tools/list` shows the tools the key may call (a key without `spend` does
not see the paid ones), with the catalogue's JSON Schemas, `readOnlyHint`
on read tools, `destructiveHint` on the five that delete data
(`delete_keywords`, `unschedule_article`, `delete_prompt`,
`disconnect_integration`, `disconnect_search_console`), `openWorldHint` on
`publish_article` (it reaches the customer's live site), and `_meta` naming
the scopes. `tools/call` goes through the
REST runner's path; a refusal comes back as a tool result with `isError`
and the error object above as its text. A success carries
`structuredContent` and the same JSON as text.

The low-level SDK `Server` is used on purpose, not `McpServer`: McpServer
would validate the input with its own copy of each schema and phrase its own
errors, while here the registry is the one source.

### Prompts: the routine as commands

Since 2026-11-14 the server also has the MCP `prompts` capability
(`prompts: { listChanged: false }` in `initialize`; the SDK negotiates
protocol `2025-11-25` and the four versions before it, and prompts are the
same in each). `prompts/list` and `prompts/get` serve `lib/tools/prompts.ts`:
text templates the person picks in Claude, which tell Claude which tools to
call, in which order, under the screens' rules. A prompt calls no tool, reads
no row, spends nothing and writes no audit row; the tools it names do,
through the runner, when Claude calls them.

| Prompt | Arguments (strings, all optional) | What it makes Claude do |
| --- | --- | --- |
| `daily_routine` ("Run my day") | `timeZone` (IANA, UTC when empty), `site` | `get_today`, then a few lines on posted of goal, links and To do; `list_reply_inbox` `status: "open"`, one target at a time, in the order it returns (To do's order on the screen, never re-sorted by score): the post and the draft, then approve, fix or skip. Approve: `get_reply_intent_url` (the link that opens X with the reply typed in; `body` and `threadUrl` when it is null), the person posts it, then `mark_reply_posted`. Fix: the person's reason to `correct_reply_draft` (or their words to `edit_reply_draft`). Skip: `dismiss_reply_target`, not now: `snooze_reply_target`. Then each `alsoToday` item with its tools (`resettle_article`, `publish_article` only on an explicit yes, `generate_article`, `retry_article`, `set_reply_link` / `paste_reply_links`, `confirm_about_you_fact` / `update_voice_settings`) |
| `weekly_review` ("Review my week") | `days` (`7` or `28`, default 7), `topics` (1 to 20, default 5), `site` | `get_growth`: X, Google and AI answers against the period before, AI per engine as "cited of readable", null as "not measured", sampled, never averaged; `list_ai_answers`: at most three answers worth seeing; `get_content`: the week's articles, then the next topics, keep or remove (`delete_keywords` after a yes) |

Both say, in the text Claude reads: GTF and Claude never post on X or
anywhere else (Claude hands over the link, the person posts); a reply names
no product and carries no link; only what the tools return, a null is "not
measured", no dollar amounts; nothing that spends without the person's yes.
The text follows the grant: a read-only connection is told that approving,
skipping and marking need Write, one without Spend that Fix and new drafts
are refused and `edit_reply_draft` is the way, so Claude says so rather than
calling and failing. The text follows the site too: with `site` (a name,
domain or id), Claude is told to pass it on every tool call; without it, a
connection that covers several sites is told to call `whoami` and ask which
site first (a caller whose sites are not known gets the same, as an "if").
The prompt does not check the name itself (it reads no row): the first tool
call refuses one that matches no site, with the list.

An unknown prompt, a time zone the runtime does not know, `days` other than
7 or 28, or `topics` out of range is JSON-RPC error `-32602` (Invalid params)
with the reason; an empty string is an argument not given (some clients send
every argument they show). Every tool a prompt names is in its `uses`, and
`tests/tools/prompts.test.ts` checks each against the registry.

Where a person finds them: Claude Code makes each a slash command,
`/mcp__gettrafficfast__daily_routine Europe/Berlin` (arguments in order, space
separated). On claude.ai and the Claude apps a connector's prompts are
offered from the chat's + menu; that placement has not been checked against
this server (the round trip with claude.ai is not testable from here). The
public docs carry both (`/docs#routine`).

### Connecting Claude Code

Create a key in Settings → Claude and API (tick `spend` if the agent should draft),
then:

```sh
claude mcp add --transport http gettrafficfast https://gettrafficfa.st/api/mcp \
  --header "Authorization: Bearer gtf_…"
```

For a key for every site, add `--header "x-gtf-business: <site id>"` to
pick one, or let Claude pass `site` per call; without either the tools act
on the oldest site. Other clients: the
same URL, transport Streamable HTTP, the same headers. A client that cannot
send a header signs in with OAuth instead ("Connect from claude.ai"); Claude
Code can too (add the URL without a header, then `/mcp` to sign in, on a
loopback redirect), though a key stays the simpler way for it and for
scripts. Only the unit tests have exercised Claude Code's loopback flow
against this server so far.

Checked locally on 2026-11-09 with `curl` against `next dev`: `initialize`,
`tools/list` (12 tools for a key without `spend`, before the article tools)
and `tools/call whoami`, plus a bad key (401 with `WWW-Authenticate`) and a
paid tool without `spend` (403 `forbidden_scope`).

### Connect from claude.ai

A custom connector on claude.ai, Claude Desktop and Claude mobile cannot send
a header of its own, so it cannot carry an API key. It signs in with OAuth
instead, against an authorization server this site runs for its own MCP
endpoint (`lib/oauth/`). No new vendor: Supabase holds the tables, the
session cookie says who the person is.

**The steps, for a person:**

1. In Claude, open **Customize → Connectors** (claude.ai/customize/connectors;
   on a Team or Enterprise plan an Owner adds it in **Organization settings →
   Connectors**, then each member connects) and choose **Add custom
   connector**.
2. URL: `https://gettrafficfa.st/api/mcp`. Leave the OAuth client ID and
   secret empty. If the dialog asks how Claude identifies itself, choose
   **Register automatically** (dynamic client registration): this server
   does not offer Claude's published identity (a Client ID Metadata
   Document) yet.
3. Click **Add**, then **Connect**. A GetTrafficFast page opens; sign in if
   you are not signed in already (you come back to the same page).
4. The consent screen shows the app's name (the one it gave itself), the
   address your answer is sent to (`claude.ai`), what it may do, and which
   site. **Read** and **Write** are ticked; **Spend** and **Publish** are not,
   and are granted only if you tick them, as on a new API key. Choose one site
   or all of them. With "All my sites", Claude picks the site in each request:
   name it in your message ("run my day for Bravo") and Claude passes it as
   the tools' `site` argument ("Choosing the site in a call"); when you name
   none, the tools act on your oldest site. The screen says so, naming your
   second site as the example and the oldest as the default, and that the
   default can be changed later by asking Claude (`set_default_site`, "The
   default site").
5. **Allow**. Claude lists the tools that grant allows (no Spend: no paid
   tools in the list).

**Revoking:** Settings → Claude and API → **Connected apps** lists each grant (the
app, where it receives its codes, the scopes, the site, when it connected and
was last used, and for an app on every site its default site, which can be
changed there) with **Revoke**, which ends every token of that connection on
its next use (`DELETE /api/connected-apps/:id`, session cookie only).
Removing the connector in Claude does not revoke it here by itself; a client
that calls the revocation endpoint does. To change the scopes or the site,
remove the connector in Claude and add it again.

**The flow, for an agent reading this at 1am** (MCP authorization
2025-06-18 and 2025-11-25; Claude's requirements as published at
claude.com/docs/connectors/building/authentication, read on 2026-11-10):

| Step | Endpoint | What |
| --- | --- | --- |
| 1 | `POST /api/mcp` without a token | 401, `WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource/api/mcp"` |
| 2 | `GET /.well-known/oauth-protected-resource/api/mcp` (also at the root path) | RFC 9728: `resource` = `https://gettrafficfa.st/api/mcp` exactly, `authorization_servers` = `["https://gettrafficfa.st"]`, `scopes_supported` = the four scopes |
| 3 | `GET /.well-known/oauth-authorization-server` | RFC 8414: the endpoints below, `response_types_supported: ["code"]`, `code_challenge_methods_supported: ["S256"]`, `grant_types_supported: ["authorization_code", "refresh_token"]`, `token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"]`. No `client_id_metadata_document_supported`, so Claude uses dynamic registration |
| 4 | `POST /oauth/register` | RFC 7591, JSON. Redirect URIs: https, or http on `localhost`, `127.0.0.1` or `[::1]`; no fragment, no user name; at most 10. A public client (the default, and what Claude registers) gets no secret; `client_secret_post` or `client_secret_basic` gets a `gtfcs_…` secret once. 60 registrations per address per hour (Claude registers on every fresh connection, from Anthropic's egress range; the address is read by `lib/client-ip.ts`: Vercel's headers, or `TRUSTED_PROXY_HOPS` when self-hosted) |
| 5 | `GET /oauth/authorize` | The consent page. Code flow only, PKCE `S256` required, `resource` must be the MCP endpoint (`invalid_target` otherwise). An unknown client or a redirect URI it did not register is shown to the person and never redirected to; every other error goes back to the client with its `state` and `iss`. No session: sign-in, then back here |
| 6 | `POST /oauth/authorize/decision` | The form's Allow or Deny, same origin only (CSRF). Allow: a `gtfco_…` code, 5 minutes, single use, bound to the client, the redirect URI, the challenge, the resource, the ticked scopes and the site, sent back as `?code=…&state=…&iss=https://gettrafficfa.st`. Deny: `error=access_denied` |
| 7 | `POST /oauth/token`, `grant_type=authorization_code` | Form-encoded (JSON is read too). Same client, same `redirect_uri`, unexpired, unused, and `code_verifier` whose S256 is the challenge. Answers `{ access_token: "gtfat_…", token_type: "Bearer", expires_in: 3600, refresh_token: "gtfrt_…", scope }`, `Cache-Control: no-store` |
| 8 | `POST /api/mcp` with `Authorization: Bearer gtfat_…` | The tools, as above |
| 9 | `POST /oauth/token`, `grant_type=refresh_token` | Rotation: a new pair every time, the old refresh token spent. The refresh token lives 30 days from its last use. A `scope` may narrow, never widen (`invalid_scope`). A refresh token that no longer works is `invalid_grant`, which tells Claude to sign in again |
| 10 | `POST /oauth/revoke` | RFC 7009: the client's own access or refresh token ends the whole grant; 200 whatever the token |

What is stored (migration `20261110160000_oauth.sql`): `oauth_clients`,
`oauth_authorization_codes`, `oauth_tokens`. Every secret, code and token is
kept as its SHA-256, looked up by digest and compared again in constant time
(PKCE and client secrets too); none is logged. One row of `oauth_tokens` is
one access token and the refresh token issued with it; every row of one
consent shares `family_id` (the code's id), and that family is the grant
Connected apps lists. Using a refresh token marks its row `rotated_at` with a
conditional update, so two refreshes racing on one token cannot both win; a
spent refresh token presented again revokes the whole family (reuse
detection, OAuth 2.1 §4.3.1), and so does a code redeemed twice for the
tokens it produced. A grant for one site dies with the site (cascade), never
widening into every site. A trigger keeps what a token grants fixed, a
revoked token revoked and a spent one spent. RLS is on everywhere: only the
service role writes; a person reads only their own `oauth_tokens` rows.

Security choices worth knowing before changing any of it:

- Redirect URIs match exactly, except that a loopback URI's port is ignored
  (RFC 8252 §7.3; Claude Code listens on a new port each session). The
  database refuses a redirect URI that is neither https nor loopback http
  (`oauth_redirect_uris_ok`).
- The consent page cannot be framed (`X-Frame-Options: DENY`) and keeps its
  referrer on this site (`Referrer-Policy: same-origin`), so the decision
  POST carries an `Origin` the route checks; Deny comes first in the form,
  so Enter declines.
- The consent screen names the redirect host, because the app's name is
  self-asserted, and warns when it is the person's own computer.
- No implicit flow, no plain PKCE, no `client_credentials`, no token in a
  query string.
- An account holds at most 20 live grants (`MAX_LIVE_GRANTS`), like keys.

Checked locally on 2026-11-10 with `curl` against `next dev`: the three
metadata documents (the `.well-known` route handlers are served), the MCP
401 and its header, registration refusing an http redirect URI, the token
endpoint refusing an unknown client, the consent page's error state with
`X-Frame-Options: DENY` and `noindex`, and the decision route refusing a
post from another origin. The whole flow is covered by the unit tests; the
round trip with claude.ai itself can only be checked once this is deployed
and the migration applied.

---

## Tools

`lib/tools/registry.ts` is the list; a tool is `defineTool({ name, title,
description, input, output, scope, paid, requiresSubscription?, owns?,
destructive?, handler })` (`lib/tools/tool.ts`). A handler calls the function
the screen's route calls and maps its result: no business rule lives in a
tool. Where a route held the logic inline, it moved to `lib/` and the route
now calls it too (`lib/placements/`: `actions.ts`, `edit.ts`, `generate.ts`,
`add.ts`, `requestDiscovery` in `runs.ts`; for the write tools below,
`lib/keywords/manage.ts`, `lib/calendar/manage.ts`,
`lib/visibility/manage.ts`, `lib/business/save.ts`,
`lib/business/save-settings.ts`, `lib/research/analyze-site.ts`,
`lib/integrations/manage.ts`, `lib/analytics/search-console-connection.ts`;
for the article tools, `lib/articles/generate-now.ts` for
`/api/generate-now` and `lib/articles/publish-now.ts` for
`/api/publish-now`).

`owns` names the input fields that carry row ids and the table each must be
in (`placement_targets`, `placements`, `jobs`, `keywords`, `articles`,
`aeo_queries`, `draft_feedback`). A field may hold one id or a list
(`delete_keywords`, `schedule_keywords`): every id must be a row of the
caller's user and site, or the call is 404 `not_found` and nothing runs.

| Tool | Scopes | What it does (the screen's action) |
| --- | --- | --- |
| `whoami` | read | who the key acts for, its scopes, the site this call acts on (`business`), the default site (`defaultSite`, `defaultSource`), the sites it may name (with `site` or `x-gtf-business`) |
| `set_default_site` | write | `{ site: id, name or domain, or null }`: saves the default site of the key or the connected app it is called with (Settings → Claude and API, the default site picker); null: the oldest. A browser session is refused (409 `invalid_state`). "The default site" |
| `get_today` | read | Today (`/today`, 2026-11-14), the first screen of the day, read by the function `GET /api/today` reads (`loadTodayScreen`, `lib/today/read.ts`). `{ timeZone? }`. `progress`: `posted` (replies marked as posted today in `timeZone`, removed ones left out), `goal` (null when none), `timeZone`, and `links` (null with no reply today): `total`, `linked`, `foundOnX` (of the linked, found by GTF), `looking` (GTF still searching X), `toPaste`, `line` as the screen says it, `tone` (`done`, `waiting`, `todo`). `counts`: rows in each tab, `todo` (open to reply now), `posted` (posted and still up), `archive` (skipped, filtered out, expired, removed); null when they could not be counted; list them with `list_reply_inbox` `status` `open`, `published_manually` or `archive`. `alsoToday`: what else needs a gesture today, in the screen's order, each with `id`, `kind`, `href` (where the screen does it) and `tools` (the tools that resolve it, the free one first): `article_held` (a gate held it: `articleId`, `title`, `scheduledDate`, `isToday`, `reason`, `moreReasons`; `resettle_article`, `publish_article`, `generate_article`, `dismiss_today_articles`), `article_failed` (`retry_article`, `dismiss_today_articles`; an article ignored there, held or failed, is not listed again until its status changes), `reply_link` (a reply on X of the last 7 days whose link GTF stopped looking for: `targetId`, `text`, `outcome`, `line`; `set_reply_link`), `fact_stale` (a dated About you sentence over 30 days old, counted from its last "Still true" when there is one: `sentence`, `dateLabel`, `confirmedOn`, `age`; `confirm_about_you_fact` or `update_voice_settings`). Empty when there is nothing. Reads only; no model, no paid API |
| `list_reply_inbox` | read | the inbox: `status` (open by default, all, `archive` since 2026-11-14: skipped, filtered out, expired and removed, as Today's Archive tab lists them; or one), `platform`, `topic`, `aiCited` (only pages a sampled AI answer cited), `limit`/`offset`; each target with its drafts and, when a visibility run pointed at it, `aiCitation` (per prompt, the engines whose sampled answer cited the page). A posted target the site removed carries `removedAt` and `removedReason` (`mark_reply_removed`); `removalBySurface` gives, per platform, `posted`, `removed` and `removalRate` (null where nothing was posted, never 0), as people recorded it. A target of `kind` `listicle` takes no draft: `draft_reply` and `write_own_reply` answer 409 `invalid_state`. A posted reply on X carries `metrics`, its newest daily snapshot of X's public numbers (`get_reply_metrics`; null when never read). A target `foundVia` `x_search` was found by the daily X search (fresh for 24 hours). Since 2026-11-12 a target carries `media` (the post's images and videos: `type`, `url` or `previewUrl`, `altText`, size; null when never asked, [] when none) and `mediaUnread` (true when the post has media its drafts were written without), and each draft's `audit.images` says what the drafter saw (`inPost`, `seen`, `note`); `get_reply_target` returns the same. Since 2026-11-14 a target on X carries `quotedPost` and `repliedToPost` (the post it quotes and the post it replies to: `id`, `url`, `text`, `authorName`, `handle`, `postedAt`, `postedAtPrecision`, `media`, `mediaUnread`, `note`; `text` null when the post exists and could not be read; null when it quotes or answers none, or when not known) with `quoteUnread` and `repliedToUnread` (true when its drafts were written without it, false when read or there is none, null when not known: posts stored before 2026-11-14 until the daily X run reads them, a hand-added post read without the X API for `repliedToUnread`); drafts read both beside the post (docs/PLACEMENTS.md, "What the post quotes"); `get_reply_target` returns the same. Since 2026-11-12 it also takes `timeZone` (IANA) and returns `today`, whatever the filter: what `get_today_replies` answers. Since 2026-11-12 too, each target carries `foundAt` (when the product first found it, the same instant as `createdAt`; `lastSeenAt` is when a search last saw it again), and the answer carries `lastDiscovery`: `web` and `x`, each `{ running, lastCompletedAt, progress, nextAt }` (progress while running, e.g. "Judging 23 of 60…"; `nextAt` the next scheduled run, web Monday, Wednesday and Friday 10:00 UTC, X daily 13:20 UTC); `x` is null where the site does not take part in the X search. Found targets are listed newest post first. Since 2026-11-13 each target carries `linkSource` (`found_on_x` when `publishedUrl` is the link GTF found on X by itself, `person` otherwise, null with no link) and `linkSearch` (GTF's search for the link: `attempts`, `lastAttemptAt`, `outcome`, `postsSeen`, `foundUrl`, `foundAt`; null when never searched), and a posted reply with no link carries `linkFinding`: `looking` with `stopsBy` (GTF searches X again by itself: 2 min, 15 min, 2 h and 12 h after I posted it), `stopped` with `outcome`, or `off` (docs/PLACEMENTS.md, "The link of your reply, found on X"); `get_reply_target` returns the same. Reads at most 200 per filter (the newest found, and the person's own posts apart) |
| `get_today_replies` | read | "N of G today" (2026-11-12): `posted` (replies marked as posted today in `timeZone`, removed ones left out), `goal` (the daily goal, null when none; change it with `update_voice_settings` `dailyReplyGoal`), `timeZone` (the one given, or UTC when missing or unknown) and `replies`, newest first: `id`, `surface`, `author`, `community`, `url` (the post answered), `text` (the first line of the reply as posted, null when none on record), `publishedAt`, `publishedUrl` (null until saved), `metrics` (null when not read), and since 2026-11-14 `linkSource` (`found_on_x`, `person`, null with no link; absent when the searches could not be read). `replies` is absent when it could not be read: unknown, not none. A count of what was recorded, never of what is on the other site. Reads only the last 27 hours of rows; no model |
| `get_reply_target` | read | one target, its drafts, how its newest draft job stands |
| `get_reply_metrics` | read | the public numbers of the replies posted on X from this site (views, likes, replies, reposts, quotes, bookmarks), one snapshot per UTC day (`latest`, and `history` over `days`, default 14); `targetId` for one reply. Read once a day by the platform for the 14 days after posting, only for replies whose link was saved and only while Find posts on X is on. A null number is one X did not return, never 0; a reply with no snapshot was not read; `measured` false when the stored numbers could not be read at all. Reads stored rows: no call to X (since 2026-11-11) |
| `get_reply_stats` | read | Results → Replies on X (2026-11-13): the replies posted on X in the last 7 days against the 7 before. Per week (`week`, `previousWeek`): `posted` (removed ones left out), `measured` (link saved and numbers from X by `asOfDay`), `withoutLink`, and over the measured replies the sums `views` (impressions), `likes`, `replies` (received), `reposts`, each null when nothing is measured, never 0; `change` is this week minus the week before, null unless both are measured. They are X's running counters read once a day: a week's sum is the views so far of the replies posted in it, not views that happened during it, and the week before is read as of its own last day (`asOfDay` minus 7) so the change compares replies of the same age. `top`: this week's 3 most viewed measured replies (`text`, `publishedUrl`, `threadUrl`, `threadAuthor`, `day`, the four numbers). `followers`: the site's own X account (`handle`, from its saved reply links; `followers`, `following`, `posts`, `listed` on `day`), read once a day, and `change` over 7 days (`changeSince`) when both ends were read from the same account. `status`: `on`, `off_platform` (no X API on GetTrafficFast) or `off_site` (Find posts on X off). `measured` false when the stored numbers could not be read at all. No profile visits: X's public numbers do not have them. Reads stored rows: no call to X |
| `run_reply_discovery` | write, spend | Run discovery; `{ jobId, status }` after up to `waitSeconds`; the run goes on after the answer for up to 110 s, then the worker tick |
| `add_x_post` | write, spend | Add a post from X by its link (and its text if X will not hand it over); starts the draft |
| `draft_reply` | write, spend | Generate draft (or follow the one already running); `{ jobId, status }` after up to `waitSeconds`, and the target with its drafts once completed. `anyway`: Write it anyway |
| `edit_reply_draft` | write | edit a draft; the gate judges it again |
| `write_own_reply` | write (subscription) | Write your own; the gate judges it, no model |
| `correct_reply_draft` | write, spend | Fix it: a note, one rewrite, judged again; capped daily |
| `get_reply_intent_url` | read | Reply on X: X's composer link with the draft typed in, for a person to open; `null` with a reason off X or when too long |
| `mark_reply_posted` | write | I posted it (optionally the link to the person's own reply, the draft, a note) |
| `unmark_reply_posted` | write | its Undo (2026-11-14; the toast's Undo on Today, `unmark_published`): back to `drafted`, drafts kept, out of today's count; 409 `invalid_state` once the reply has its link or is marked as removed |
| `set_reply_link` | write | add the link to a posted reply, or replace one (a link GTF found included: `linkSource` is then `person`); the reply's text is then read back from X |
| `paste_reply_links` | write | Paste your reply links (2026-11-14): `links`, 1 to 10. Each is matched to the posted reply still missing its link by `matchPastedReplyLinks` (`lib/placements/link-paste.ts`, the function `POST /api/placements/match-links` calls; on X the reply's text read back through X's public oEmbed, free and keyless), and saved only when exactly one reply matches it closely, through `set_reply_link`'s path. `{ saved, picks, refused }`: a pick is a question (`candidateIds`, `why`) the person answers with `set_reply_link`; nothing is guessed |
| `find_reply_link` | write, spend | Find the reply's link on X (2026-11-13): one metered X search, now, for a reply marked as posted on X with no link, the search GTF also makes by itself 2 min, 15 min, 2 h and 12 h after I posted it. Saves the link only when it is surely the person's own reply to that post (by the site's X account, in that thread, made from an hour before I posted it to six hours after; with several, the one whose words match the draft that was posted), through `set_reply_link`'s path. `{ outcome, message, linkUrl, target }`: `found` (saved, `linkSource` `found_on_x`), `not_found` (nothing yet; GTF looks again on its schedule), `other_replies` or `ambiguous` (nothing saved; add it with `set_reply_link`), `not_saved` (a link was saved meanwhile), `error` (X failed). Under the platform's monthly limit on X. Refused, in words: 503 `unavailable` when the platform's X API is off, paused or at its cap; 409 `invalid_state` when Find posts on X is off for the site, the target is not posted on X, has its link, is removed, was marked as posted more than 7 days ago (X's search window), or has had its six searches; 409 `prerequisite_missing` while the site's X account is not known (save one reply's link first). Reads X; never posts |
| `mark_reply_removed` | write | It was removed: a posted reply the site removed or hid, with an optional `reason` (up to 300 characters). The target stays `published_manually` with `removedAt` and `removedReason`; it stops counting in `missingLinkCount` and is never a voice example. 409 `invalid_state` on a target not posted or already marked |
| `unmark_reply_removed` | write | its Undo: clears `removedAt` and `removedReason`; 409 `invalid_state` when the target is not marked as removed |
| `snooze_reply_target` | write | Snooze, `days` 1 to 90 (7) |
| `dismiss_reply_target` | write | Skip, with an optional reason |
| `reopen_reply_target` | write | Bring back |
| `get_job` | read | a drafting, discovery or production job: status, the failure in words (a decline says why), the gate's verdict |
| `generate_article` | write, spend | Generate now / Regenerate on one calendar article: the `produce-article` job the button enqueues (priority 10, 3 attempts), or the one already queued or running; `{ jobId, status, articleStatus }` after up to `waitSeconds`. Publishes nothing itself: the daily run publishes a generated article on its date |
| `publish_article` | publish (subscription) | Publish: delivers a generated (or republishes a published) article to its site's destination; answers the live `url`. `confirm: true` is required; an article in `needs_review` also needs `acknowledgeQualityIssues: true` (400 `invalid_input` naming the issues otherwise), the override the screen's click makes. One that fails the gates is moved to `needs_review` and not published (409). No destination: 409 `prerequisite_missing`; the site refused: 502 `delivery_failed` |
| `resettle_article` | write | Re-checks one article waiting in `needs_review` under the current rules (2026-11-12), free and without a model: the deterministic gates run again on the stored document (Facts for articles, About you and the research the production job stored), the stored audit findings are read again (only an invented fact, a wrong link, a factual error or unsafe content holds; the author's own figures never do), and the hold is decided again. `{ status, changed, reasons, previousReasons, evidenceFound }`. Publishes nothing: one with no reason left becomes `generated` and the daily run publishes it on its date. Not in `needs_review`: 409 `invalid_state` |

### Write tools

Every write the screens make, under the 2026-11-09 parity audit's names, one
file per domain (`lib/tools/write-*.ts`). A settings tool takes only the
fields to change and merges them onto what is stored, then validates the
whole with the route's strict schema: `{ enabled: true }` never resets the
rest to defaults.

| Tool | Scopes | What it does (the screen's action) |
| --- | --- | --- |
| `add_keywords` | write | Add keywords: phrases, suggestion objects as `suggest_keywords` returns them, or questions from `list_question_ideas` as `{ keyword, source: "question", sourceUrl }` (stored with every figure null and the thread that asks it; a `sourceUrl` that is not a thread found for the site is 400 `invalid_input`); ones the site has are skipped and counted. A near-duplicate of a keyword the site has, of a published article or of an earlier phrase of the call is not added: it comes back in `duplicates` (`keyword`, `reason`, `why`, `duplicateOf` with the keyword, its status, article and live link, or `duplicateOfPhrase`). `allowDuplicates: true` adds them anyway (docs/INTELLIGENCE.md, "Overlapping topics"). Each keyword may carry `intent` (one of the four, as `suggest_keywords` returns it or as you choose it); left out, the rules decide it from the phrase, and every keyword returned has one |
| `update_keyword` | write | Star / unstar (`keywordId`, `starred`): the only change the page makes, the rule of `UpdateKeywordInput` |
| `delete_keywords` | write | Delete by `ids` (1 to 200); destructive |
| `suggest_keywords` | write, spend | Suggest: from `seeds`, or `fromBusiness`; one model call, nothing saved; the figures are estimates (`estimated: true`). Ideas that overlap a topic the site has are left out of `suggestions` and listed in `duplicates`. Each idea has its `intent`; `fromBusiness` asks for a mix of comparisons, platform how-tos and problem questions beside the core topics, naming only the products and platforms the site's own data names (its articles, the results pages it competes in, AI answers). A comparison naming any other product is left out and listed in `refused` (`keyword`, `names`, `why`); a comparison, how-to or problem idea carries no `searchVolume` and no `cpc` (docs/INTELLIGENCE.md, "No invented competitor") |
| `schedule_keywords` | write (subscription) | Add to calendar, `keywordIds` up to 200: the site's first free days after today (`lib/calendar/schedule.ts`), in the order given. A keyword whose near-duplicate is already scheduled, being written or published (or was scheduled earlier in the call) is never scheduled: it stays in the pool and is listed in `overlapping` (`keywordId`, `keyword`, `reason`, `duplicateOf`). No override |
| `reschedule_article` | write | Move to `date` (YYYY-MM-DD, today or later); swaps with the article already on that day |
| `unschedule_article` | write | Remove from the calendar; its keyword is available again; destructive |
| `retry_article` | write | Retry a failed article (409 `invalid_state` when it is not failed); the change of status clears an Ignore from Today |
| `dismiss_today_articles` | write | Ignore on Today (2026-11-19): `articleIds` (1 to 100) or none for every failed or held (`needs_review`) article of the site; they keep their state on the Content board (`dismissed_at` set) and leave `get_today`'s `alsoToday`; any later change of status clears the mark (a trigger), so a new failure or hold shows again. `{ dismissed, articleIds }`, articles in other states are left alone. `POST /api/calendar/dismiss` |
| `add_prompts` | write | Add prompts (`queries`, optional `cluster`, `intent`, `source`); wordings already in the set are counted |
| `update_prompt` | write | Edit a prompt: wording, cluster, intent, enabled; fields left out stay |
| `delete_prompt` | write | Delete a prompt; its probes keep their history; destructive |
| `import_prompts_from_keywords` | write | Import from keywords: the oldest 50, verbatim, free |
| `suggest_prompts` | write, spend | Suggest prompts: one bounded model call, nothing saved |
| `update_visibility_settings` | write (spend and confirm to turn a cadence on) | Brand names, domains, engines, cadence, per-run cap, `placesFromSources` (free, on by default since 2026-11-13; `false` stops each run sending its cited pages to Replies); answers with the run plan |
| `run_visibility_check` | write, spend, confirm | Run now: every enabled prompt × engine is one paid probe; `{ runId, jobId, plan, job }` after up to `waitSeconds` |
| `find_places_from_last_run` | write | Free, no input: the latest finished run's cited sources (answers that did not cite the site) become reply targets, at most 10 new per call, most cited first; a page already in the inbox is linked, never duplicated. Every run already does this as its last step unless `placesFromSources` is off; this is the by-hand form (no button on the screen since 2026-11-13), for a run that finished with it off or for the pages past the cap. Answers `{ runId, candidates, created, linked, deferred, dropped, rejected, targets }`; 409 `prerequisite_missing` with no finished run. Sampled; nothing drafted or sent (docs/AI_VISIBILITY.md, "From sources to Replies") |
| `create_business` | write | Add a site, locked from the first save; not with a key limited to one site (403 `forbidden_business`) |
| `update_business` | write | This site's profile; a different name or address on a locked site is 409 `invalid_state` with the reason, never ignored |
| `analyze_website` | write, spend | Analyse my site: one page (public addresses only, `safeFetch`) and one model call; nothing saved |
| `update_automation_settings` | write (spend, publish and confirm to turn it on) | Autopilot: on/off, buffer days, keyword floor, per-run ceilings; and `backLinks` (on by default, independent of Autopilot): the back-link pass of docs/KNOWLEDGE.md; and `pushPage3` (off by default, independent of Autopilot; spend and confirm to turn it on): the weekly Push page 3 of docs/LIFECYCLE.md |
| `update_media_settings` | write (spend and confirm to turn images on, or to allow more per article) | Autopilot → Images and video (`/settings/automation#images`): images on/off, in-article images per article (0 to 3, 0 unless set), style, palette, provider, videos |
| `update_voice_settings` | write | Voice: preset, person, About you (what replies may say), `articleFacts` (Facts for articles, since 2026-11-12: the only first-hand facts an article may state; articles never read About you), notes, the daily goal, and `findPostsOnX` (Find posts on X, the switch in Settings → Connections since 2026-11-14: the daily X search, the numbers of posted replies and, since 2026-11-13, finding the link of a reply marked as posted; default off, and it does nothing unless the platform has the X API on). `confirmedFacts` is written by `confirm_about_you_fact`, best left out; a change to About you drops the confirmations of sentences it no longer has; 409 when the stored value cannot be read and a partial change would replace it with the defaults |
| `promote_feedback_to_notes` | write | Add a correction note's reason to the notes, once |
| `add_about_you_fact` | write | It's true: add to About you (since 2026-11-12). `{ fact, draftId? }`: `fact` (up to 300 characters) is one sentence the person confirmed as true, dated ("As of November 12, 2026: …") so the staleness rule asks about it later. It is appended to About you, the existing text kept as it is; `added` false when it was already there. With `draftId` (a draft of this site, else 404 `not_found` and nothing written) the gate judges that draft's text again, unchanged, and `draft` carries the new audit. 409 `invalid_state` "About you is full; edit it in Settings → Voice." when it would pass 2,000 characters (400 until 2026-11-12). Never send a fact the person did not confirm. A failed `verifiable_claims` check lists the sentences it can take in `confirmable` |
| `remove_about_you_fact` | write | Its Undo: `{ fact, ifAboutYouIs? }` removes that exact sentence and the separator the add put before it; `removed` false when it is not there. With `ifAboutYouIs` (the `aboutYou` the add answered), 409 `invalid_state` when About you has changed since. Judges no draft: `edit_reply_draft` does |
| `confirm_about_you_fact` | write | Still true, on Today (since 2026-11-14). `{ sentence }`: a dated sentence of About you, exactly as `staleFacts` (`get_voice_settings`) or a `fact_stale` item of `get_today` quotes it, that the person confirms is still true. The day is stored apart from the text, in `settings.confirmedFacts` (the fact's key to `YYYY-MM-DD`); About you is not changed, so no draft reads the date. A fact is stale 30 days after the later of its own date and its confirmation, so it is not asked about for 30 days and drafts may state it as current; editing or removing the sentence drops its confirmation. Answers `fact` (the sentence as written, unchanged), `confirmedOn`, `previousConfirmedOn` (null when never) and `changed` (false when already confirmed today). Undo: the same call with `undo: { previousConfirmedOn }` as it answered; that one entry goes back (removed when null) and `confirmedOn` answers null. 409 `invalid_state` when the sentence is no longer in About you as it was, or carries no date. Never confirm a fact the person did not confirm (docs/VOICE.md, "Still true") |
| `disconnect_integration` | write | Disconnect `wordpress`, `webflow`, `shopify` or `webhook`; its credentials are deleted; destructive |
| `get_search_console_connect_url` | read | The link a person opens, signed in, to connect Search Console to this site (`connect?business=<id>` selects that site first), and whether it is connected |
| `select_search_console_property` | write | Pick the property; the first pull starts and is waited for up to 25 s; 409 `prerequisite_missing` when not connected |
| `sync_search_console` | write | The first pull now (2026-11-14), as Growth and Settings → Connections start it (`POST /api/integrations/search-console/sync`, `kickFirstSearchConsoleSync`), waited for up to 25 s; idempotent: `skipped` says `already_synced`, `no_property` or `no_connection`. Free |
| `disconnect_search_console` | write | Drop the grant; the traffic already read stays; destructive |
| `inspect_url` | write | Check now on an article: Google's URL Inspection for one URL of the site's Search Console property (`url`, or a published article's `articleId`), stored in `index_status` and returned (`row`: `state` indexed / not_indexed / unknown, Google's `coverageState` verbatim, `inspectionResultLink`). Free (Google does not charge for the Search Console API), but it uses the property's Google quota, so it is a write: at most 200 inspections per site per UTC day with the daily sweep, and a URL checked in the last 10 minutes answers the stored row (`fresh: false`). A URL outside the property is 400 `invalid_input`; Google's quota spent is 429 `cap_reached`; Google refusing the property (the account is not an owner or full user) is 409 `prerequisite_missing`; nothing is stored on a refusal (docs/ANALYTICS.md, "Indexing status") |
| `push_article` | write, spend | Push page 3 for one published article now (`articleId`; the modal's "Push this article"; `POST /api/article-pushes`): its main Search Console query, up to 3 of the site's best related pages linking to it with that query (or a variant) as anchor, a tighter meta title and description around the query; delivered where the site takes updates, otherwise stored as a proposal. The position band and the minimum impressions do not apply on demand; 409 `invalid_state` without Search Console, for an article pushed in the last 28 days, changed in the last 14, or with a refresh or push running. One fast-tier model call, as a job (`status: "selected"` until it finishes); 10 a key a day, under the account's spend ceiling (docs/LIFECYCLE.md, "Push page 3") |
| `resolve_article_push` | write | Today's "I added it" / "Dismiss" on a push proposal (`pushId`, `action`: `applied` or `dismissed`; `POST /api/article-pushes/:id`): `applied` starts the measurement that day; only a push in status `proposed` (409 `invalid_state` otherwise). Free |

Connecting WordPress or a webhook is not a tool, on purpose: an application
password or a webhook secret must not pass through an AI chat, and the
registry has no way yet to serve a tool over REST while keeping it off MCP.
A person connects them in Settings → Connections. Search Console is
connected by a person on Google's consent screen, from the link above.

An API key moves an article through `move_article_for_owner` (the service
role, naming the key's verified owner): `move_article` reads `auth.uid()`,
which a key does not have (docs/MULTI_BUSINESS.md).

### Confirmation: nothing starts spending unasked

A call that would switch spending on refuses until it says so. Without
`confirm: true` (the default is false) it changes nothing and answers 409
`confirmation_required`: the message says what it would start and how much
of it (probes, images, articles), never a price: the plan includes it
(owner's decision, 2026-11-14); the hint says how to go ahead. The agent
asks the person, then sends the same call again with `confirm: true`. The
scope check comes first: a key that may not do it at all gets 403, not a
question.

| Call | Needs confirm when | Extra scopes | The message says |
| --- | --- | --- | --- |
| `run_visibility_check` | always | (paid: spend) | `This run asks 12 prompts × 2 engines (gemini, perplexity) = 24 probes.` |
| `update_visibility_settings` | the cadence goes from `off` to `weekly` or `monthly` | spend | the probes per run, and about how many a month |
| `update_automation_settings` | `enabled` goes from false to true | spend, publish | the buffer, the keyword floor, the per-run ceilings, and that each article is written and published on its day |
| `update_media_settings` | `imagesEnabled` goes from false to true, or `inlineImagesPerArticle` goes up while images are on | spend | that every article from then on gets a featured image and up to the stated number of in-article images, included in the plan, and the most images one article can get |

Changing a setting that is already on, or turning one off, needs neither.
The planned probe count is the run's own plan (`planVisibilityRun`,
`lib/visibility/manage.ts`): the enabled prompts up to `maxQueriesPerRun`,
times the engines the site chose among the configured ones. A run with no
engine or no prompt says so (503 `unavailable`, 409 `prerequisite_missing`)
before it asks for a confirmation.

### Jobs and waiting

Drafting, discovery and article production are durable jobs (`lib/jobs/`).
A tool that starts one runs it with a budget under the routes' 120 s (105 s
for a draft and for an article, 110 s for discovery since 2026-11-12, 50 s before) and answers when it is
done or after `waitSeconds` (0 to 25, default 25), whichever comes first.
An article takes longer than that: the worker tick finishes what the call's
budget leaves. A job still running then goes on after
the response (`after`, `runJobWithin` in `lib/tools/jobs.ts`), and the
worker tick resumes it if even that is cut. The wait never cuts the job:
aborting a model call at 25 s would pay for it and throw the answer away.
Poll `get_job` every few seconds; read the drafts with `get_reply_target`.
The REST and MCP routes set `maxDuration = 120` for this.

### Read tools

Every read a screen makes is a tool, under the names of the 2026-11-09
parity audit. All of them need only the `read` scope, cost nothing (no
model, no paid provider; listing Search Console properties asks Google,
which is free) and need no subscription. Each handler calls the function
the screen's route calls; where a route or a page held the logic inline it
moved to `lib/` first, and the route (or page) now calls it too:

| Moved to | Called by |
| --- | --- |
| `lib/calendar/read.ts` | `/api/calendar/get` (`?articleId=` for one article: the Content screen's modal), `list_calendar`, `get_article` |
| `lib/calendar/content.ts` (the view), `lib/calendar/content-plan.ts` (the status words, the week, the order Autopilot picks topics in; pure) | `/api/content` (the Content screen, `/content`), `get_content` |
| `lib/content/export.ts` (Copy HTML, Copy Markdown) | the article view (`components/dashboard/article-modal.tsx`), `get_article` |
| `lib/integrations/deliveries.ts` (`listDeliveries`) | Settings → Connections → Recent deliveries, `list_deliveries` |
| `lib/keywords/read.ts` | `/api/keywords/get`, `list_keywords`, `recommend_keywords`; `loadQuestionIdeas`: `/api/keywords/questions`, `list_question_ideas` |
| `lib/keywords/questions.ts` (which threads ask a question, cleaning, near-duplicates, coverage, order; pure) | "Questions people ask" in Content → All topics (`/content/topics`), Autopilot's daily top-up, `list_question_ideas`, `add_keywords` |
| `lib/keywords/duplicates.ts` (the near-duplicate rule; pure), `lib/keywords/overlap.ts` (the site's topics, the refusals, the clusters) | "Overlapping topics" in Content → All topics (`/api/keywords/overlaps`), the Content screen's notice, `list_duplicate_keywords`, `add_keywords`, `suggest_keywords`, `schedule_keywords`, the calendar's add routes, Autopilot |
| `lib/keywords/picks.ts` (best picks, the column sort) | Content → All topics, `list_keywords`, `recommend_keywords` |
| `lib/keywords/intent.ts` (a topic's intent, the no-invented-competitor rule, the weekly mix; pure), `lib/keywords/named-tools.ts` (what the site's data names; the suggestions held to it) | the Content screen's intent tag, `get_content`, `list_keywords`, `recommend_keywords`, `add_keywords`, `suggest_keywords` (`/api/keywords/suggest`), Autopilot |
| `lib/visibility/read.ts` (`listQueries`, `listRuns`, `loadVisibilitySettings`) | `/api/visibility/queries`, `/api/visibility/settings`, the dashboard, the visibility tools |
| `lib/lifecycle/load-results.ts` (the results aggregation, once) | `/api/results`, `/api/growth` (By article), `/api/home`, `get_results`, `list_integrations` |
| `lib/growth/read.ts` (`loadGrowth`, `listAiAnswers`, `loadAskSetup`; the arithmetic pure in `lib/growth/`) | Growth (`GET /api/growth?days=`), Growth → AI answers (`GET /api/growth/answers?days=&engine=&offset=`), `get_growth`, `list_ai_answers` |
| `lib/onboarding-status.ts` (the checklist's counts, once) | `/api/onboarding/status`, `/api/home`, `get_onboarding_status` |
| `lib/home-snapshot.ts` | `/api/home`, `get_home` |
| `lib/articles/provider-comparison.ts` (the read), `lib/content/provider-comparison.ts` (the arithmetic; pure) | `/api/articles/provider-comparison`, `compare_article_providers` |
| `lib/business/read.ts`, `lib/voice/read.ts` | `/api/business/get`, `/api/business/voice-settings`, `get_business`, `get_voice_settings` |
| `lib/business/save-settings.ts` (`updateVoiceSettings`, the partial merge) | `PATCH /api/business/voice-settings` (the Today sheet's goal), `update_voice_settings` |
| `lib/placements/today.ts` (`postedTodayRows`, `todayReplies`, `todayLinks`), `lib/placements/read.ts` (`loadTodayReplies`, `loadToday`) | "3 of 5 replies" and the Today sheet on Today, `list_reply_inbox` `today`, `get_today_replies`, `get_today` |
| `lib/today/read.ts` (`loadTodayScreen`), `lib/today/also-today.ts` (Also today; pure), `lib/placements/inbox-view.ts` (`TODAY_VIEWS`, `archiveReason`) | Today (`GET /api/today`), `get_today` |
| `lib/placements/reply-stats.ts` (the week on X and the followers; pure), `lib/placements/reply-stats-read.ts` (`loadReplyStats`, 7 or 28 days) | Growth → Replies on X (through `/api/growth`), `GET /api/placements/reply-stats`, `get_reply_stats`, `get_growth` |
| `lib/integrations/read.ts`, `lib/analytics/properties.ts` | `/api/integrations/list`, `/api/integrations/search-console/sites`, `list_integrations`, `list_search_console_properties` |
| `lib/lifecycle/push-store.ts` (`listArticlePushes`, `requestArticlePush`, `resolveArticlePush`, `latestPushes`) | `GET`/`POST /api/article-pushes`, `POST /api/article-pushes/:id`, the article modal, Today (`article_push`), Growth → By article (`push`), `list_article_pushes`, `push_article`, `resolve_article_push` |
| `lib/analytics/index-status.ts` (`listIndexStatus`, `inspectUrlNow`) | `GET /api/index-status` (the article modal's line), Growth → Google → Pages on Google (through `/api/growth`), `POST /api/index-status/inspect` (Check now), `list_index_status`, `inspect_url` |

The routes answer exactly what they answered before the move: their
answers were captured as snapshots before it, and the tests compare them
after (`tests/lifecycle/load-results.test.ts`,
`tests/onboarding/load-status.test.ts`, `tests/calendar/read.test.ts`,
`tests/keywords/read.test.ts`, `tests/visibility/read-routes.test.ts`,
`tests/integrations/read.test.ts`, `tests/business/read.test.ts`,
`tests/content/export.test.ts`).

Measurements follow the rules in CLAUDE.md: rates are per engine and never
averaged across engines (`get_results` leaves out the pooled citation rate
the Results screen's payload still carries), a rate with nothing measured is
`null` and 0 means asked and not cited, and every citation answer says it is
sampled (`sampled`/`sampleNote` on the visibility tools,
`citationsSampled`/`citationNote` on `get_results`). Rates stay numbers with
their counts beside them (`cited`, `probes`/`valid`, and `previousCited`/
`previousValid` on a visibility comparison): the screens' "0 of 3" under
10 probes (`MIN_PROBES_FOR_PERCENT`) is a display rule, and an agent reads
the sample size from the counts. Positions and their changes leave the
lifecycle layer to one decimal (`roundPosition`), so `get_results` says
51.8 and 15, never 51.75 and 15.049999999999997. Keyword volumes,
difficulty, CPC, competition and opportunity are labelled as a model's
estimates (`estimatesNote`); a keyword whose `source` is `question` has none
of them (null), because it was asked in a public thread and nothing about it
is measured or estimated (docs/INTELLIGENCE.md, "Questions people ask"). A keyword's `source` says where it came from: `question`, `autopilot` (bought by Autopilot's top-up), `manual` (added by a person or their key); null for one added before 2026-11-14, when it was not recorded, and `get_content` says `unknown` for it rather than guess. A keyword's `intent` says what kind of search it answers: `comparison`, `platform_howto`, `problem`, `product_adjacent` (docs/INTELLIGENCE.md, "Search intent of a topic"); a keyword stored before 2026-11-15 reads the rules' verdict, never null. No answer carries a credential: destinations
are listed by whitelisted fields, and the Search Console token never leaves
`lib/analytics/properties.ts`.

| Tool | Scope | Cost | Input | What it answers |
| --- | --- | --- | --- | --- |
| `get_content` | read | free | `topics` (5, max 50) | the Content screen: `autopilot`, `todayArticle` and the `week` Monday to Sunday (UTC days; each article with `status` in the screen's words, `published`, `scheduled`, `writing`, `written`, `waiting` with its `reasons`, `skipped`; null for an empty day), `nextTopics` in the order Autopilot picks them (a week at a time: what the week lacks of the mix first, then by score; docs/AUTOPILOT.md, "A week's mix"), each with `source` (`question`, `autopilot`, `manual`, `unknown`) and `intent`, and the counts behind the links: `topicsTotal`, `topicsHeldBack` (overlapping one already written), `overlapGroups`, `questionsWaiting` (null while Autopilot adds them itself), `articlesTotal` |
| `list_calendar` | read | free | `from?`, `to?` (YYYY-MM-DD, inclusive), `status?` | the site's articles by day, without bodies: keyword, title once written, status, live link, last error |
| `get_article` | read | free | `articleId`, `format` (`canonical` default, `html`, `markdown`) | one article with its quality report; `canonical`, or `body` as Copy HTML / Copy Markdown give it |
| `list_deliveries` | read | free | `type?` (wordpress, webflow, shopify, webhook), `limit` (20, max 100) | the latest publish attempts, newest first, failures included; never the payloads |
| `list_keywords` | read | free | `search?`, `status?`, `starred?`, `sort` (`created_at`, `opportunity`, `difficulty`, `search_volume`, `cpc`), `direction` (desc), `cursor?`, `limit` (50, max 200) | the keyword pool as Content → All topics sorts it, each with `bestPick`, `source` and `intent`; `nextCursor` pages |
| `recommend_keywords` | read | free | `limit` (10, max 100) | the best picks: not on the calendar, High opportunity, difficulty 60 or less. Reads the pool, asks no model |
| `list_question_ideas` | read | free | `limit` (20, max 50) | "Questions people ask": questions from the titles of the public threads discovery found for the site, near-duplicates folded, the ones a keyword or an article covers left out, ranked by how many threads ask them, then recency. Each has `sourceUrl`, `host`, `threadCount` (a count of found threads, not search volume) and `basis` "Asked in a public thread"; no figure. Reads the site's rows, asks no model, saves nothing |
| `list_duplicate_keywords` | read | free | `limit` (50, max 100) | "Overlapping topics": clusters of the site's keywords that are near-duplicates (the words, or 6 of the top 10 stored results in common), each member with its article and Search Console's counts (`impressions`, `clicks`, `position` weighted by impressions, `days`; null and `days: 0` when not measured, never 0), `reasons`, and the member to keep (`keeperKeywordId`, `keeperBasis`, `recommendation`: most impressions, then best position; null when nothing measured can tell). Reads the site's rows, asks no model. Changes nothing: no keyword or article is deleted, merged or redirected |
| `get_visibility_overview` | read | free | `includeRows` (false) | the AI Visibility dashboard: the latest run per engine, the comparison when comparable, the lead sentences, the domains cited instead, the recent runs; sampled |
| `list_prompts` | read | free | none | the prompt set, by cluster |
| `get_prompt_history` | read | free | `queryId` | one prompt's probes per engine over time, the domains cited, the site's articles and the replies posted for it; sampled |
| `list_visibility_runs` | read | free | `limit` (12, max 50) | the runs, newest first, with their failure (no cost: what a run costs the platform is the owner's) |
| `get_visibility_settings` | read | free | none | what counts as the site, the engines, the cadence, the most prompts per run |
| `get_results` | read | free | none | per article: rank (Search Console else SERP), 28-day traffic, citations per engine; the totals, the per-day traffic, the Search Console state |
| `get_growth` | read | free | `days` (7 or 28, default 7) | Growth, as `/growth` shows it: the period against the same length before, in three blocks. `replies`: `get_reply_stats` for the period (null when the posted replies could not be read). `google`: Search Console `impressions`, `clicks` and the impression-weighted `averagePosition` over the period ending on the newest day ingested (`settledThrough`), `previous` null when the data does not cover it (no comparison, never growth from 0), `change` (position: previous minus current, positive up the page), and `pages` on Google from URL Inspection (latest answer per URL, no history, so no change). `ai`: per engine, `current` and `previous` asks with a readable answer and how many cited the site (`rate` null with no ask, never 0), split by family (`byKind`: the questions you chose, your articles' keywords), `unreadable` apart; never averaged across engines; `sampled: true`; the open places in Today a sampled answer cited. Stored rows only |
| `list_ai_answers` | read | free | `days` (7 or 28), `engine?`, `offset` (0), `limit` (20, max 100) | Growth → AI answers: the period's answers, newest first, each with its question, engine, day, `status` (`counted` false for an answer that could not be read: not "not cited"), the site's place among the sources, the cited page, the stored start of the answer (`excerpt`, not the whole answer) and every source verbatim and numbered, `ours` and `inToday` marked. `kind` `article` (the weekly check of an article's keyword) keeps only the verdict and the cited page (`sourcesKept: false`). `engines` lists the engines with an answer in the period; `nextOffset` pages. Sampled |
| `list_businesses` | read | free | none | the sites the key may name (with `site` or `x-gtf-business`), the one this call acts on (`selectedId`) and the one the tools act on by default (`defaultId`, `defaultSource`; no site needed) |
| `get_business` | read | free | none | the site's settings, with Autopilot and its Images and video |
| `get_home` | read | free | none | the Overview's loop (its screen became Today on 2026-11-14; `get_today` reads Today): the operating loop stage by stage, the replies row, the next action, the next articles, the unused keywords |
| `get_today` | read | free | `timeZone?` | Today, as `/today` shows it: the day's progress and links, the tabs' counts, Also today (above, with the Replies tools) |
| `get_onboarding_status` | read | free | none | the Getting started checklist in order, `next` and `complete` |
| `get_voice_settings` | read | free | none | Settings → Voice, with the tones and persons to choose from |
| `list_draft_feedback` | read | free | `limit` (50, max 100) | the notes given on reply drafts, newest first, before and after the rewrite |
| `list_integrations` | read | free | none | the publishing destinations (status, error, address, user) and the Search Console connection; never a secret |
| `list_search_console_properties` | read | free | none | the properties the site's grant can read and the one selected; 503 `unavailable` when Google refuses |
| `list_index_status` | read | free | `state?` (`indexed`, `not_indexed`, `unknown`), `coverageState?` (Google's exact sentence), `articleId?`, `limit` (200, max 500) | Google's URL Inspection answers stored for the site, the latest per URL, newest first, each with Google's `coverageState` in its words and the report link; and `summary`: `total` (published URLs inside the property), `checked`, `indexed`, `notIndexed`, `unknown`, counts per Google state and `caption` ("12 of 40 checked"). A URL never inspected has no row: not checked, never counted as not indexed. Reads stored rows, asks Google nothing |
| `list_article_pushes` | read | free | `articleId?`, `status?`, `limit` (50, max 200) | Push page 3: the site's pushes, newest first (`GET /api/article-pushes`): `mainQuery` with its numbers, the 28-day `before`, each link (page, anchor, `mode` existing or sentence, the added sentence, `status` applied / proposed / not_delivered / skipped with its reason), the old and new meta title and description, `appliedBy`/`appliedAt`, `after14` and `after28` (null until Search Console covers the window, never invented; a window with no impression has a null position) and Growth's `line` ("Pushed Nov 16: 37 → 29", "no change yet", "not measured yet"). A skip is listed with `skipReason` |
| `get_subscription` | read | free | none | the account's subscription as Billing shows it: status, active, period, `cancelAtPeriodEnd`, the date that matters (no site needed) |
| `get_plan_usage` | read | free | none | the plan card's quotas in units (`loadPlanUsage`, "Account limits"): `quotas` (`id`, `label`, `used` or null when unread, `limit`, `period` day or month, `window`), this month's calendar for the caller's site, and `aiWork` (`available`, `reached` with `message` and `resetsAt`, or `unknown`). Never a dollar amount, never the platform's provider spend. Reads through the service role, every query filtered on the caller's user (no site needed) |
| `compare_article_providers` | read | free | `days` (90, max 365) | the article rotation read back (docs/CONTENT_PIPELINE.md, "The provider rotation"): per provider arm and per agent, `samples` (runs the arm's own provider answered), `fallbackRuns` (runs the other provider answered: counted apart, in no average), duration per run (`avgCostUsd` is left out: only the route answers it, to a platform owner); per arm the articles written and the share revised, in `needs_review`, skipped or failed, the deterministic gate issues before the revision, word count and the audit score; Search Console's impressions, clicks and position over the first 28 days for the articles that have them (`measuredArticles`). Null means not measured; `enoughSamples` is false under 10 articles per arm; `auditJudgedBySameProvider: true` says the audit score is the writing provider's own. Declares no winner. Reads the site's jobs and runs, asks no model |

`compare_article_providers` is also `GET /api/articles/provider-comparison`
(`?days=`, the session's selected site) for the screens. It reads the
site's `produce-article` jobs through the caller's client; the checkpoints
(`job_steps`, which has no owner column) and the agent runs of those jobs
are then read with the service role, by job id only.

An id an input names (`articleId`, `queryId`) is checked by the runner
against the caller's user and site before the handler runs: an article or a
prompt of another site, or of another account, is 404 `not_found`.

The Content screen (`/content`, since 2026-11-14) has no action of its own:
each one is a tool already. Read the screen with `get_content`; add a topic
with `add_keywords` and remove one with `delete_keywords`; open an article
with `get_article`; rewrite it with `generate_article` (paid), re-check a
held one with `resettle_article`, publish it with `publish_article`, move it
with `reschedule_article`, take it off with `unschedule_article`, retry a
skipped one with `retry_article`. Behind it, All articles is `list_calendar`
and All topics is `list_keywords`, `schedule_keywords`, `update_keyword`
(star), `suggest_keywords` (paid), `list_question_ideas` and
`list_duplicate_keywords`; Autopilot on or off is `update_automation_settings`.

---

## Parity: every screen action is a tool, or says why not

`lib/tools/parity.ts` (2026-11-14) lists every route under `app/` that
changes something (POST, PATCH, PUT, DELETE), keyed `METHOD /path`, either
with the tools that do the same thing or as an exception of a decided kind.
`tests/tools/parity.test.ts` reads the routes from the file system, so a new
route that is in neither list fails it, and so does a mapped tool not in the
registry, an entry whose route is gone, or a new exception not named in the
test. The action route's moves are mapped one by one
(`MANUAL_ACTION_PARITY`).

| Screen | Route → tool |
| --- | --- |
| Today, Replies | `[id]/action` → `mark_reply_posted`, `unmark_reply_posted`, `set_reply_link`, `mark_reply_removed`, `unmark_reply_removed`, `dismiss_reply_target`, `snooze_reply_target`, `reopen_reply_target`; `[id]/draft` → `draft_reply`; `[id]/drafts` → `write_own_reply`; `add` → `add_x_post`; `discover` → `run_reply_discovery`; `drafts/[id]/correct` → `correct_reply_draft`; `PATCH drafts/[id]` → `edit_reply_draft`; `feedback/[id]/promote` → `promote_feedback_to_notes`; `match-links` → `paste_reply_links` |
| Content | `article-pushes` → `push_article`; `article-pushes/[id]` → `resolve_article_push`; `calendar/add`, `calendar/add-bulk` → `schedule_keywords`; `remove` → `unschedule_article`; `requeue` → `retry_article`; `reschedule` → `reschedule_article`; `generate-now` → `generate_article`; `publish-now` → `publish_article`; `keywords/save`, `delete`, `suggest`, `update` → `add_keywords`, `delete_keywords`, `suggest_keywords`, `update_keyword` |
| Growth | `visibility/places` → `find_places_from_last_run`; `visibility/queries` POST, PATCH, DELETE → `add_prompts`, `update_prompt`, `delete_prompt`; `queries/import`, `queries/suggest` → `import_prompts_from_keywords`, `suggest_prompts`; `visibility/run` → `run_visibility_check`; `visibility/settings` → `update_visibility_settings`; `index-status/inspect` → `inspect_url` |
| Settings | `business/analyze`, `save`, `automation-settings`, `media-settings` → `analyze_website`, `create_business` / `update_business`, `update_automation_settings`, `update_media_settings`; `voice-settings` POST, PATCH → `update_voice_settings`; `voice-settings/about-you` POST, DELETE, PATCH → `add_about_you_fact`, `remove_about_you_fact`, `confirm_about_you_fact`; `integrations/disconnect` → `disconnect_integration`; `search-console/disconnect`, `select-site`, `sync` → `disconnect_search_console`, `select_search_console_property`, `sync_search_console` |

The gaps the inventory found on 2026-11-14 are now tools: Undo of I posted
it (`unmark_reply_posted`), Paste your reply links (`paste_reply_links`) and
the first Search Console pull (`sync_search_console`). None is paid: the X
read in `paste_reply_links` is the public oEmbed, Google's API is free. The
exceptions, each a decision:

| Kind | Routes | Why |
| --- | --- | --- |
| `api_keys` | `POST /api/api-keys`, `DELETE /api/api-keys/[id]`, `DELETE /api/connected-apps/[id]` | A key can never mint, list or revoke keys, or revoke a connection |
| `spend_ceiling` | `POST /api/owner/spend-limit` | Owner-only; nothing on the API raises a ceiling |
| `billing` | `POST /api/create-checkout-session`, `POST /api/create-billing-portal-session` | A payment or cancellation link must not pass through an AI chat (`get_subscription` reads the plan) |
| `credentials` | `POST /api/integrations/wordpress/connect`, `…/webhook/connect` | A password or a webhook secret must not pass through an AI chat |
| `device` | `POST /api/business/select` | Which site the browser shows; a key or a connection carries its own site, or names one per call with `site` (`list_businesses`, `whoami`) |
| `sign_in` | `POST /oauth/register`, `/oauth/authorize/decision`, `/oauth/token`, `/oauth/revoke` | What gives an agent its credential |
| `machine` | the 14 `/api/cron/*`, `POST /api/jobs/tick`, `POST /api/stripe-webhook`, `POST /api/gettrafficfast` | Called by machines, not a screen |
| `surface` | `POST /api/v1/tools/[name]`, `POST` and `DELETE /api/mcp` | The API surfaces themselves |

The action route's `approve` is excepted as legacy: no screen sends it.
Signing out and the theme are not routes under `app/api` (and not tools:
both are about the device in hand). Nothing is left out for size.

## Distribution: listing the MCP server

`distribution/` holds what is submitted to MCP directories:

- `distribution/mcp/server.json` (namespace `st.gettrafficfa/gettrafficfast`)
  and `server.github.json` (the GitHub namespace, `io.github.<account>/gettrafficfast`): the
  official MCP Registry entry, remote only (`streamable-http`, this
  endpoint), schema `2025-12-11`. `tests/distribution/server-json.test.ts`
  holds them to the registry's limits and to `MCP_SERVER_VERSION`, the
  endpoint URL and icons that exist in `public/brand/`: bump the version in
  all three together.
- `distribution/mcp/listing.md`: the copy every directory asks for (no
  traction numbers, no prices, no upgrade wording).
- `distribution/skills/`: the skills package and Claude plugin (`SKILL.md`,
  `.mcp.json`, plugin and marketplace manifests), MIT licensed. The
  repository root's `.claude-plugin/marketplace.json` points at it
  (`./distribution/skills`), so this repository is the plugin marketplace.

`GET /.well-known/mcp-registry-auth` is the registry's domain proof for the
`st.gettrafficfa` namespace: the `MCP_REGISTRY_AUTH` env var (one line,
`v=MCPv1; k=ed25519; p=<base64 public key>`) as plain text, 404 when it is
unset or not exactly one such line (`lib/distribution/mcp-registry-auth.ts`).
Only the public key is ever in it; the private key stays on the owner's
machine. Public through the middleware's `/.well-known/` prefix.

## Not built yet

- OAuth, the rest of it: Client ID Metadata Documents (Claude's preferred
  way to identify itself; today it falls back to dynamic registration),
  step-up authorization (a 403 with `WWW-Authenticate: Bearer
  error="insufficient_scope"` that asks the person for more scope; today a
  missing scope is a `forbidden_scope` tool result and the person
  reconnects), a sweep that deletes expired codes, spent and expired token
  rows, and clients that never got a token (dynamic registration adds a
  client per connection), and a grace window for a refresh retried after a
  lost response (today that revokes the connection, by reuse detection).
- `connect_wordpress`, `connect_webhook`: kept off the API until the
  registry can serve a tool over REST only (credentials must not pass
  through an AI chat).
- A tool that sets an account's ceiling: off the API on purpose ("Account
  limits"); the owner sets it signed in, on `/settings/costs`.
- Opening the billing portal (Settings → Billing → Manage billing) is not a
  tool, on purpose: its link opens the payment method and cancellation for
  whoever holds it, and must not pass through an AI chat. Signing out and the
  Appearance choice are not tools either: both are about the device in hand,
  not the account's data.
- The internal orchestrator calling tools rather than workflows
  (ARCHITECTURE §4, surface 1).

## Tests

- `tests/password-login.test.ts`: the list fails closed and ignores case,
  the lookup answers a bare yes or no (the same no for every unlisted
  address), the rate limit, the form treats anything but a yes as no.
- `tests/reviewer-account.test.ts`: only a listed address, idempotent, the
  comp plan without Stripe ids, the $1 ceiling, the demo site, the
  set-password email, no password anywhere.
- `tests/auth/password-routes.test.ts`: set-password only for a listed
  account, the owner's route a 404 to anyone else, the comp migration
  applies without a confirmation.
- `tests/api-keys.test.ts`: format, hash only, prefix collisions, revoked
  and unknown keys, last-used once a minute, create/list/revoke, the cap.
- `tests/api-keys-migration.test.ts`: the table, RLS, the guard, no `drop`.
- `tests/oauth/metadata.test.ts`: the protected resource metadata at both
  paths, the authorization server metadata (code flow, S256, no CIMD), the
  401 challenge.
- `tests/oauth/register.test.ts`: https or loopback only, exact matching
  but for a loopback port, public and confidential clients, the secret kept
  as a hash, the per-address limit.
- `tests/oauth/authorize.test.ts`: errors shown or sent back by the RFC's
  order, PKCE required, a session required (and sign-in comes back), Read
  and Write by default, Spend and Publish only when ticked and asked for,
  the site, the live-grant cap, the code stored as a hash, the decision
  route's same-origin check.
- `tests/oauth/consent-screen.test.tsx`: the screen's boxes, site, hidden
  fields, Deny first, the loopback warning, the "All my sites" wording (the
  site named in each request, the oldest by default, changed by asking).
- `tests/oauth/tokens.test.ts`: the exchange with a right and a wrong
  verifier, single use and the revocation of a replayed code's tokens,
  expiry, redirect URI, client and resource checks, refresh rotation and
  reuse detection, narrowing, revoked and expired tokens, the audience,
  Connected apps, the token route (form-encoded, confidential clients by
  body and Basic), revocation.
- `tests/oauth/mcp.test.ts`: `resolveCaller` with a token (scopes, site,
  owner-scoped client, the REST runner refusing it, a key still working),
  the MCP 401 and its header, tools listed by grant, the audit row with the
  app, `forbidden_scope` with a reconnect hint, a one-site grant cannot add
  a site, the burst limit per app and account, the daily AI spend ceiling
  and the account's caps holding an OAuth caller, its calls counted with the
  keys' and the screens'.
- `tests/oauth-migration.test.ts`: the tables, hashes only, the redirect
  rule, RLS, the guard, the additive `tool_calls` column, no `drop`.
- `tests/settings/connected-apps.test.tsx`: Settings → Connected apps.
- `tests/tools/default-site.test.ts`: `set_default_site` by name, domain and
  id, refused outside the grant or for another account's site, a one-site
  grant or key, null back to the oldest, the write scope, a session refused;
  the saved default used when no site is named, kept by a refresh, the
  oldest when the saved site is gone, the header and `site` still winning;
  `whoami` and `list_businesses` reporting it; the Settings routes.
- `tests/credential-default-site-migration.test.ts`: the additive columns,
  set null on delete, the ownership trigger, no `drop`, no policy.
- `tests/api-auth.test.ts`: cookie vs key vs a bad key; 404 and 403 for
  sites; no fall-back from a bad key to the cookie.
- `tests/supabase/owner-scoped.test.ts`: the narrowed service role.
- `tests/tools/registry.test.ts`: definitions refused at load, unique names,
  object schemas, paid means spend, only publish_article has the publish
  scope, every id is owned.
- `tests/tools/runner.test.ts`: every error code, the paywall for API
  callers, a key for site A against site B.
- `tests/tools/site.test.ts`: the `site` argument by id, name and domain,
  case-insensitive; writes and ownership on the named site; an ambiguous
  name, an unknown site and another account's site refused with the list; a
  one-site grant or key never reaching another site; the default unchanged
  without it; `site` published on every site-scoped tool only; `tools/call`
  over MCP; the prompts passing it or asking first.
- `tests/tools/surfaces.test.ts`: the REST runner's shapes, the catalogue,
  MCP `tools/list` and `tools/call` over the SDK client and over the route.
- `tests/tools/replies.test.ts`: each Replies tool's happy path, its
  refusals, and its ownership checks (`unmark_reply_posted` refused once a
  link is saved; `paste_reply_links` saving only the sure match).
- `tests/tools/prompts.test.ts`: the `prompts` capability, `prompts/list`,
  `prompts/get` over the SDK client and over the route, defaults and empty
  arguments, -32602 for an unknown prompt or a bad argument, the text
  following the grant, every named tool registered and declared, no dollar,
  nothing called or recorded.
- `tests/tools/parity.test.ts`: every mutating route under `app/` mapped or
  excepted, no stale entry, mapped tools registered, the exceptions by name,
  every manual action mapped.
- `tests/tools/write-keywords.test.ts`, `write-calendar.test.ts`,
  `write-visibility.test.ts`, `write-business.test.ts`,
  `write-voice-integrations.test.ts`: each write tool's happy path, ids of
  another site and another account (one among several included), and the
  scope, confirmation and paywall refusals; a reschedule by key and by
  session.
- `tests/tools/find-places.test.ts`: `find_places_from_last_run` is a free
  write on the caller's site only, writes targets and nothing else, is
  refused to a read key, and `POST /api/visibility/places` answers the same.
- `tests/tools/write-catalogue.test.ts`: the write tools' names, which are
  paid, destructive or take `confirm`, no tool taking credentials, and the
  `move_article_for_owner` migration (no `drop`).
- `tests/integrations/search-console-connect.test.ts`: the connect link
  selects the named site only when it is the person's.
- `tests/tools/read-*.test.ts`: each read tool's happy path on site A, with
  site B and another account seeded (`tests/tools/read-support.ts`); an
  article or a prompt of either is 404; no credential in any answer; rates
  per engine, null over nothing, labelled as sampled.
  `tests/tools/read-scope.test.ts`: every read tool runs with the `read`
  scope alone and without a subscription, and is refused without it.
- The route snapshots listed under "Read tools".
- `tests/tools/articles-produce.test.ts`: generate and publish: the scopes,
  `confirm` and `acknowledgeQualityIssues`, another site's article, the gates
  parking an article, the job and its cost on the audit row.
- `tests/articles/publish-now-route.test.ts`: `/api/publish-now` answers as
  before its logic moved to `lib/articles/`.
- `tests/tools/usage.test.ts`: the audit row, the burst limit and
  `Retry-After`, the daily caps and what they count, every paid tool capped,
  and the limits failing open without the table.
- `tests/tool-calls-migration.test.ts`: the table, RLS, the indexes, no
  `drop`.
- `tests/limits/spend.test.ts`: the ceiling's sources, the 24-hour sum, a
  null cost estimated and never 0, refused at and above the ceiling, when
  the window frees, fail closed on a read error, fail open on a missing
  table.
- `tests/limits/account-limits.test.ts`: the account caps across two keys,
  a session and the screen's route; jobs counted, crons' jobs not; the
  spend ceiling on every paid tool and route; 503 when a count or the spend
  cannot be read; open when `tool_calls` is missing.
- `tests/limits/settings.test.ts`: the ceiling's validation, a raise
  refused without its confirmation, the owner's route a 404 for a customer,
  the signed out, a Bearer key and everyone when no owner is listed.
- `tests/owner.test.ts`: `isPlatformOwner`, fail closed;
  `isPlatformOwnerHere` on a listed site, another site, no site, and with
  `PLATFORM_OWNER_BUSINESS_IDS` unset; no owner-only feature asks
  `isPlatformOwner` alone.
- `tests/owner/owner-site.test.ts`: with `PLATFORM_OWNER_BUSINESS_IDS` set,
  the owner on another site gets the customer's Settings list, the costs
  page's 404, the owner routes' 404 and the comparison without costs; on
  the platform's site, and on every site with it unset, the owner's.
  `tests/integrations/webhook-connect.test.ts`: the own blog receiver
  connected only from a listed site.
- `tests/limits/quotas.test.ts`, `tests/settings/plan-usage.test.tsx`: the
  quotas are the code's caps and nothing else, counted for the account, null
  when unread; the ceiling still enforced and read only as reached with when
  it resets; no dollar on the plan card.
- `tests/owner/platform-costs.test.tsx`: `/settings/costs` a 404 for
  non-owners before anything is read; the ledger per provider, X against its
  cap; each account counted as the ceiling counts; unread said in words; the
  ceiling control's two taps.
- `tests/tools/owner-tools.test.ts`: `get_platform_costs` absent from the
  catalogue and a customer's `tools/list`, 404 `unknown_tool` for a
  customer, fail closed, listed and working for an owner's key; per site
  with `PLATFORM_OWNER_BUSINESS_IDS` (listed and answering on the
  platform's site, a customer's `tools/list` and a refusal elsewhere, the
  header moving it); no tool sets a ceiling; `get_plan_usage` and `get_subscription` carry no dollars.
- `tests/account-limits-owner-only-migration.test.ts`: the customer's write
  policies closed with `alter policy`, no `drop`.
- `tests/tools/retention.test.ts`: only rows older than 90 days go, in
  batches; the cron answers only its secret and is in `vercel.json`; the
  index migration drops and deletes nothing.
- `tests/account-limits-migration.test.ts`: the table, its bounds, RLS, no
  `drop`.
- `tests/settings/api-keys-manager.test.tsx`: the settings page, each key's
  usage.
