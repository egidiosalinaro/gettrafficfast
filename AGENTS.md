# AGENTS.md — GetTrafficFast Engineering Rules

## Purpose

GetTrafficFast is a production SaaS: a **content operating system**. A customer
connects a site, and the platform researches, plans, writes, enriches,
publishes, monitors and improves the content that makes that business
findable — on search engines (SEO) and inside AI answer engines (AEO).

It is not an article generator. An article is an output of the strategy, never
the starting point.

This repository is expected to stay a coherent, multi-tenant, extensible
product. The primary engineering objective is NOT simply to make individual
features work. The objective is a system where new capabilities can be added
without repeatedly breaking existing ones.

Treat every change as a potential change to a shared system.

`docs/ARCHITECTURE.md` is the reference every architectural decision is checked
against. Read it before changing structure. `docs/` is the real documentation:
a slice that changes behaviour updates its document in the same commit.

## Repo facts

- Next.js app (App Router), Supabase (Postgres, auth, storage, RLS), Zod,
  Vitest. The hosted product runs on Vercel; a deployment's public origin is
  `NEXT_PUBLIC_SITE_URL` (`lib/site.ts`).
- Every deployment value lives in the environment and is documented in
  `.env.example`: the site origin, the contact inbox, Sentry, analytics,
  owner-only user ids, provider keys. Never hardcode a deployment's ids,
  domains or accounts in code, tests or docs.
- `main` is the production branch: a merge to `main` deploys the hosted
  product. That is why the checks below run before every commit, on every
  branch.
- Before every commit: `npm run lint`, `npm test` (Vitest, tests in `tests/`
  mirroring `lib/`), `npx tsc --noEmit`. Catching type errors here is cheaper
  than a failed deploy.

## Git workflow

- **Contributors** work on a branch (or a fork) and open a pull request
  against `main`. A pull request merges only with a maintainer's approval
  and green CI (lint, type check, tests). Use your own Git identity.
- **Maintainers** merge to `main`, which deploys. One logical change per
  commit or pull request.
- **Agents** (coding assistants) working for a maintainer follow that
  maintainer's instructions for branches, identity and pushing; working for
  a contributor, they follow the contributor workflow above.
- The full contributor flow (setup, checks, DCO sign-off) is
  `CONTRIBUTING.md`; maintainers' settings and review steps are
  `docs/MAINTAINERS.md`.
- Commit messages: a short title, then a prose body explaining what changed
  and why. No AI attribution trailers.
- `git add` on explicit paths, never `git add -A`, so unrelated changes
  don't ride along.
- Tests and fixtures use fictional people, handles, sites and numbers.
  Never copy production rows, real customers' data or real third parties'
  posts into the repository.

---

## 1. Core engineering principle

**Do not patch symptoms. Fix systems.**

Before changing code, understand:

- the current architecture (`docs/ARCHITECTURE.md` and the subsystem doc);
- the existing data model and migrations;
- the existing business logic and source of truth;
- every consumer of the affected functionality;
- API / cron / job boundaries;
- database constraints and RLS;
- existing tests;
- historical/legacy rows;
- integrations (WordPress, webhooks, Search Console, …);
- UI surfaces that read the same data.

If a bug is caused by an architectural weakness, fix the underlying
abstraction instead of adding a conditional that makes the reported example
work.

Avoid:

```ts
if (business === ...)
if (keyword === ...)
if (article === ...)
if (someSpecificCase === ...)
```

unless the condition is genuinely part of the domain model.

Do not create customer-specific behaviour in shared product code. A customer
request is usually evidence of a missing generic capability. GetTrafficFast
writing for its own blog is not a special case: the blog connects the ordinary
Webhooks integration, like any Next.js customer (`docs/BLOG.md`).

## 2. Always investigate before implementing

For non-trivial changes, follow this sequence:

1. Inspect the relevant UI.
2. Trace the complete data flow.
3. Identify the source of truth.
4. Inspect schema and migrations.
5. Inspect jobs, crons, API routes, application services.
6. Inspect all consumers (UI, cron, webhook, email, another job).
7. Inspect existing tests.
8. Check for duplicate implementations.
9. Check for legacy implementations and historical rows.
10. Identify possible regressions.
11. Propose the smallest correct architectural change.
12. Implement.
13. Add regression tests.
14. Run lint, tests and typecheck.
15. Verify affected flows end-to-end.

Do not start by editing the first file that appears related to the bug.

## 3. No random patches

Strongly discouraged:

- adding another conditional to an already complex component;
- duplicating business logic in the UI;
- fixing backend behaviour only from the frontend;
- parsing HTML/Markdown/JSON with regex when a parser or the Canonical
  Article should be used;
- adding a second implementation because the first one is inconvenient;
- creating a special case for a single customer or for gettrafficfa.st;
- copying logic between calendar, keywords, results, publishing and crons;
- adding a new column when the existing canonical model should be extended;
- adding a new API when an existing route or job can be generalised;
- silently changing existing semantics to fix one edge case;
- inventing a number to fill a gap in the UI.

If the existing implementation is structurally wrong, refactor it into a
reusable abstraction.

Prefer:

```text
domain / application / job workflow
        ↓
UI · API · cron · webhook · (later) MCP
```

over four slightly different versions of the same business logic, one per
surface.

## 4. Single source of truth

For every important domain concept, one canonical representation and one
authoritative logic layer. Examples:

- article identity and lifecycle (`lib/domain/lifecycle.ts`);
- Canonical Article (`lib/content/types.ts`);
- quality gates (`lib/content/` gates);
- publisher adapters (`lib/publishing/`);
- selected business (`lib/tenancy.ts` — pick FROM what the user owns);
- citation rate (`lib/lifecycle/citations.ts`);
- rank / decay (`lib/lifecycle/`);
- media settings and embedding (`lib/media/`);
- knowledge graph and verified linking (`lib/knowledge/`);
- job execution (`lib/jobs/`);
- agent contract (`lib/agents/contract.ts`);
- public site facts (`lib/site.ts`: origin, contact inbox).

Before creating new logic, search for existing implementations. If several
already exist and disagree, consolidate them. Do not solve inconsistency by
adding yet another implementation.

## 5. Layers depend downward only

```text
UI  (app/, components/)
 ↓
Tools            capability surface — internal callers + MCP     lib/tools/
 ↓
Application      use cases: orchestration graphs, transactions   lib/jobs/workflows/
 ↓
Agents           one responsibility each, structured I/O         lib/agents/
 ↓
Domain           entities, lifecycle, invariants — no I/O        lib/domain/
 ↓
Providers        every external system behind an interface       lib/providers/
```

No layer reaches sideways. **No vendor name appears above the provider
layer.** Swapping a vendor is a setting, not a rewrite. `lib/providers/llm/`
is the only place a model vendor is named.

**Orchestration is code, steps are agents.** The graph of what runs, in what
order, and what happens on failure lives in plain TypeScript with tests.
Every agent's input and output is schema-validated with Zod. Nothing decides
"what to do next" by prompting a model.

An agent never writes to the database. It receives data and returns data.
Persistence belongs to the application layer (the job workflow). Publishing
is not an agent: it has no inference.

The Tool layer (`lib/tools/`) exists: one registry (`lib/tools/registry.ts`)
served over HTTP (`/api/v1/tools`) and MCP (`/api/mcp`). Do not invent a
parallel registry; add a domain's tools there (§20, `docs/API.md`).

## 6. Shared domain logic

Business rules live in reusable modules, not in page components or a single
route handler. API routes and crons call shared application/domain services
rather than implementing a second version of the same operation.

This is particularly important for:

- picking the current business;
- article state transitions;
- running the content pipeline;
- enqueueing / claiming jobs;
- publishing through the adapter registry;
- citation matching and rates;
- Search Console attribution onto articles;
- Autopilot filling the calendar.

## 7. Backward compatibility is a requirement

Every change must consider existing data and existing users. Do not assume
every row was created by the current version of the application.

Always consider:

- articles in `queued`, `generating`, `generated`, `needs_review`, `failed`,
  `published`;
- keywords with `business_id` null (the onboarding churn case);
- integrations connected before tenancy;
- old webhook payload versions;
- old Canonical Article `schemaVersion`s;
- historical `content_metrics`, `ai_citations`, `serp_snapshots`;
- existing Search Console connections;
- the public blog's stored posts.

If a new model replaces an old one, provide a compatibility path. Do not
break historical data merely because the new system is cleaner.

`business_id` is nullable on purpose on site-scoped tables: tightening it
without looking at the orphan rows would invent businesses or delete
customer data. See `docs/MULTI_BUSINESS.md`.

## 8. Zero regression mindset

Before modifying shared functionality, identify its consumers. Ask: "What
else could break if I change this?"

Changing article production may affect: the daily cron, "Generate now",
Autopilot, refresh, the calendar UI, publish adapters, emails, `agent_runs`,
cost.

Changing citation logic may affect: the weekly probe, AI Visibility,
the Results page, any customer-facing rate.

Changing tenancy may affect: every site-scoped query, the switcher, cron
sweeps, integrations, the blog.

Do not consider a task complete because the reported screen works.

## 9. Database first for data integrity

When a bug involves data integrity, inspect and fix the model when
appropriate. Do not rely exclusively on frontend validation.

Consider: constraints, foreign keys, unique indexes, transactions, RPCs,
RLS, tenant isolation, concurrency, race conditions, idempotency.

If an invariant must ALWAYS be true, enforce it as close to the data layer
as reasonably possible. Do not add constraints blindly: first audit
production data (where you are authorized to read it) and existing
behaviour.

Migrations live in `supabase/`, timestamp-prefixed, **RLS on every table**.

## 10. Multi-tenancy and security

GetTrafficFast is multi-tenant. `user_id` is who owns the row (and what
every RLS policy checks). `business_id` is which site a row is about.

Never assume that `keyword`, `article_id`, `website_url` or an integration
id is globally unique unless the data model says so.

A business id arriving from a cookie is a **request, not a permission**.
Selection always picks FROM the user's own businesses
(`lib/tenancy.ts` / `pickBusiness`). A forged cookie that names someone
else's site simply does not match.

Be especially careful with:

- the service-role client (`lib/supabase/admin.ts`) — it bypasses RLS;
- cron routes (`CRON_SECRET`);
- job workers;
- webhooks (signature on the raw body);
- Search Console OAuth;
- anything that lists integrations or businesses.

If service-role access bypasses RLS, explicit authorization checks must
exist before mutations. Never allow one customer to read or write another
customer's data. Never allow one of a user's sites to see another's
integrations, keywords or articles because a query forgot `business_id`.
A change by id is scoped the same way: id, selected business
(`selectedBusinessId`) and user, so an id from another of the user's sites is
not found. A client body is parsed with Zod into the fields the UI changes,
never written as is.

Four rules that came out of a security audit, each with one home:

- **Paid routes check the subscription server-side.** The UI gate
  (`lib/app-access.ts`) is not a paywall for direct POSTs. Any route that calls
  a paid provider or enqueues a job that will starts with
  `requirePaidAccess(user)` from `lib/paid-access.ts`; new drafts also pass
  `requireDraftCapacity` (a per-user daily cap). Scheduling an article counts:
  the cron pays to write it. Service-role code has no session, so it asks
  `hasPaidAccess(client, userId)`, the same rule: the generation cron
  produces only for owners who pay.
- **A customer URL is fetched only with `safeFetch`**
  (`lib/providers/safe-fetch.ts`): public addresses only, every redirect hop
  re-checked. Plain `fetch` on a URL a user typed is an SSRF.
- **Privilege never comes from a row the user can write.** RLS lets a user
  edit their own rows, so a flag in `config` cannot grant anything (the own
  blog receiver is the operator's by `OWN_BLOG_OWNER_USER_IDS`, not by a flag).
  RLS `with check` on client-writable tables also checks that `business_id`
  belongs to the user, not only `user_id` (keywords and articles included,
  `20261109190000_rls_keywords_articles_business.sql`).
- **HTML rendered on our origin is sanitised** with the content allowlist
  (`lib/content/stages/sanitize.ts`), even when it arrived signed.

## 11. Measurements are honest or they are worthless

This is the GTF equivalent of a sacred invariant. It matters most in
lifecycle code and anything built on it.

- A rate with no samples is `null`, never `0`. Zero reads as "never cited";
  null reads as "not measured yet". Confusing the two invents a number.
- Negative results are stored, never skipped. "We asked and were not cited"
  is the measurement; a missing row reads as "we never asked".
- Rates are **per engine**. Engines disagree, and averaging them produces a
  number that describes nothing.
- Citation data is **sampled**, not ground truth: no answer engine exposes
  "was I cited" as an API. Anything customer-facing has to say so.

Reuse `lib/lifecycle/citations.ts` (and the matching rank helpers). Do not
create a parallel rate for the dashboard, AI Visibility and MCP.

When changing a metric:

1. compare old and new numbers;
2. inspect how empty series, negatives and per-engine rows behave;
3. add a regression test for the invariant (`null` vs `0`, negatives kept);
4. only then cut over.

## 12. Every probe is a paid call

Sweeps are bounded and rotate rather than covering everything each run.
Before adding a loop that calls a provider, work out what it costs per run
and cap it.

**Cost must never switch itself on.** A feature that spends money is opt-in
behind an env var, even when the API key is already present. Search-grounded
Gemini, Perplexity, Serper, image generation, Autopilot: the key existing
is not consent to spend.

Agents honour `AgentContext.budget`. A resumed job must not restart the
budget from zero (`docs/AGENT_RUNTIME.md`).

## 13. No invented data

When something is uncertain, record the uncertainty and say so in the UI.
Never fill a gap with a plausible value: not a fake testimonial, not a
discount that was never a discount, not a citation rate of `0` for an
unmeasured article, not a second contact address that has no mailbox.

Public facts that must be stated out loud live in `lib/site.ts`
(`SITE_URL`, `CONTACT_EMAIL`, both from the environment). One contact
inbox, every surface; do not add a second one beside it.

The public site is part of the product. Fase 0 exists because invented
marketing is a trust leak. Do not put back numbers, quotes or features
that are not true.

## 14. Idempotency

Any operation that can be retried must be safe to retry. Especially:

- job steps (`docs/AGENT_RUNTIME.md`: completed steps never re-run);
- article production and refresh;
- publishing (Canonical Article `articleId` is the upsert identity);
- webhook delivery (signature over the raw body);
- Search Console ingestion;
- citation probes (a duplicate probe is another sample, not a merge of
  two truths);
- Autopilot filling the calendar;
- cron sweeps generally.

Repeated execution of the same logical operation must not duplicate
articles, double-publish, or corrupt state. Consider unique constraints,
upserts, idempotency keys, transactions, `FOR UPDATE SKIP LOCKED`.

## 15. The Canonical Article is a document system

The content pipeline (`docs/CONTENT_PIPELINE.md`) is high-risk shared
machinery. Small changes can create regressions in sanitisation, headings,
gates, publisher payloads, the public blog and refresh.

Treat it as a document system, not a collection of string tweaks. There is
one internal representation. Destinations only ever receive a document that
passed the gates. Losing a publication beats publishing corrupted content.

For pipeline bugs:

1. reproduce with a fixture under `tests/`;
2. identify the canonical state;
3. identify where the state is transformed (extract, normalize, sanitize,
   canonicalize, gates, adapter);
4. fix the canonical transformation;
5. add a regression test.

Publishing has no special case: WordPress, the customer webhook, and this
site's own blog go through the same adapters.

## 16. Structured content must not be manipulated with fragile regex

When dealing with HTML, Markdown, LLM envelopes, rich text or structured
payloads, do not use regex as a substitute for a parser when structural
correctness matters.

Prefer the pipeline stages, `node-html-parser`, Markdown parsers, ASTs,
DOM transformations. Regex may detect; it must not be responsible for
complex structural transformations. Internal links are applied only when
the anchor matches a single text node character-for-character
(`docs/KNOWLEDGE.md`).

## 17. Providers are adapters

Every external system is an adapter around the GTF domain:

```text
External vendor → Provider (lib/providers/) → Canonical model → Shared logic
```

rather than custom business logic per vendor. Adding a vendor is one file;
switching is one setting. Never let Gemini, WordPress, Serper or Perplexity
dictate the internal architecture unless the domain genuinely requires it.

## 18. Jobs, crons and automations

Producers never execute work. They enqueue. Execution happens in
`lib/jobs/` so concurrency, retries and budgets are configured once.

Cron routes are `CRON_SECRET`-protected and listed in `vercel.json`. A new
sweep is a new bounded job, not a loop inside an existing route that
happens to be convenient.

Autopilot spends money and publishes on the customer's site through the
destination the customer connected. Since 2026-11-24 it is **on by default
per site** (the owner's decision: product features are on, the person does
not have to enable them; `enabled: false` is the person's opt-out),
threshold-driven, bounded per run, documented in `docs/AUTOPILOT.md`. The
deployment-level rule below (§12) is unchanged: a provider that spends is
switched on by the platform's env settings, never by a key existing.

Placement work (`docs/PLACEMENTS.md`) finds and writes; a person publishes.
Do not auto-post to Reddit or any surface whose terms or ban risk forbid it.

## 19. API design

APIs are product capabilities, not customer-specific endpoints. Never
create `/api/acme-blog` or `/api/customer-x` when the underlying
capability is generic. This site's blog receiver is the generic webhook
payload, not a private format.

Existing APIs remain backward compatible unless a breaking change is
explicitly required. Webhook payload versions are additive.
Before creating a new endpoint, search for an existing one to extend.

## 20. MCP / agentic architecture

External agents (Claude, ChatGPT, Codex) are meant to orchestrate the
platform **through the Tool layer over MCP**. They drive it from outside;
they do not live inside the production graph.

The MCP tool must not contain an independent implementation of the
business operation. One registry (`lib/tools/registry.ts`) serves HTTP
(`POST /api/v1/tools/:name`) and MCP (`/api/mcp`); a tool's handler calls
the function the screen's route calls. When a route holds its logic inline,
move it to `lib/` first and make the route call it too. Do not scatter
ad-hoc "AI tools" that bypass jobs, Zod schemas, tenancy or budgets.

Every action a person can take in the UI must be doable through the API and
MCP: a new screen action ships with its tool. Tenancy for
API keys is enforced in one place, the runner (`lib/tools/runner.ts`): the
key owner's narrowed client, the site picked from their own businesses, and
every id an input names checked against both (`owns`). Anything that costs
money is `paid` (the `spend` scope and the paywall); nothing posts in the
customer's name. Contract, scopes and error codes: `docs/API.md`.

Two credentials reach MCP: an API key (`gtf_…`, Claude Code and scripts) and
an OAuth access token (`gtfat_…`) from the authorization server this app runs
for its own MCP endpoint (`lib/oauth/`), which is how claude.ai and the
Claude apps connect as a custom connector. An OAuth caller resolves in
`resolveCaller` to the same shape as a key (owner, site, scopes, the
owner-scoped client, `via: "oauth"`), so nothing below the resolver may
treat the two differently except to name the credential in a message; the
per-key limits count per app. A token is accepted only at the resource it
was issued for (the MCP endpoint, never the REST runner). What a person
consents to mirrors a key: Read and Write ticked, Spend and Publish only
when they tick them. Codes and tokens are stored as hashes, refresh tokens
rotate, a reused one revokes the grant. Do not add an OAuth vendor, a grant
type, or a scope without updating `docs/API.md` "Connect from claude.ai".

How the rule is held, for every feature present and future:

- **Parity is a test, not a promise.** Every mutating route under `app/`
  is either mapped to its tool or listed as a justified exception in
  `lib/tools/parity.ts`; `tests/tools/parity.test.ts` fails the build when a
  route is neither, or a mapped tool does not exist. A new screen action,
  route or cron lands with its tool (or its written exception) in the same
  commit. An exception is for security or machinery (sign-in, billing, key
  minting, spend ceilings, credentials, crons, webhooks), never for "later".
- **The routine has prompts.** The MCP prompts (`lib/tools/prompts.ts`:
  `daily_routine`, `weekly_review`) walk an agent through the product's
  daily and weekly use. A feature that changes what a person does each day
  or each week updates the prompt that covers it in the same commit.
- **The public MCP documentation follows the code.** The tool lists on
  `/docs` and on the MCP reference `/docs/mcp` (the stable page registries
  link to) are generated from the registry, and its error table is typed
  over `API_ERROR_CODES`; anything else the public pages say about MCP (how
  to connect, what a plan includes, what an unpaid caller is told, prompts,
  limits) is updated in the same commit as the change.
- **Every tool needs an active plan.** Without one, every tool answers the
  one refusal (`planRefusal`, `subscription_required`, `PLAN_REQUIRED_MESSAGE`):
  connecting, `tools/list` and prompts still work. The text is factual, never
  promotional (no price, no pricing link, no "upgrade" in a tool error or the
  MCP instructions: agent directories forbid it). docs/API.md "Without a plan".

## 21. UI / UX principles

Do not make the UI unnecessarily restrictive. Distinguish invalid data
from optional data that happens to be missing.

Examples that are valid:

- an account with no business yet (send them to Settings → Business,
  do not render an empty calendar as if it were a site);
- a keyword with no article this week;
- a citation rate of `null`;
- Autopilot off;
- media off;
- Webflow / Shopify listed as coming soon — they are not connected.

Do not disable actions simply because an optional field is missing. If
the backend considers an entity valid, the UI should not prevent creating
it. If the backend considers an operation invalid, the UI should say why.
A disabled button is not an explanation.

Empty states tell the truth: "not measured yet" is not "0%".

## 22. Performance

Do not introduce N+1 queries. Before adding data to a list (calendar,
keywords, results, AI answers), ask: "How many database/API requests
will this generate for 100 records?"

Prefer joins, batched queries, RPCs, preload. Do not sacrifice
correctness for premature optimisation, but do not introduce obvious N+1
behaviour into the calendar or a weekly sweep that already costs money
per row.

Sweeps that call providers are bounded. Unbounded "for each article, call
the model" is a production incident.

## 23. Historical data

Reports and historical views describe what happened at the time of the
event. Do not blindly use today's title, URL or business name to
reconstruct yesterday.

`article_versions`, `article_events`, `serp_snapshots`, `ai_citations`,
`content_metrics` and `publish_attempts` exist so history is recorded, not
inferred. If an article was refreshed, the old document is archived, not
overwritten without a trace.

## 24. Observability

Production must be diagnosable. For important workflows record enough to
answer: what happened? when? why? which user? which business? which
article? which job? which step? which provider? which result? what
failed? what did it cost?

`agent_runs`, job steps, `publish_attempts` and Sentry (`docs/SENTRY.md`)
are that trail. Prefer structured logs. Do not log tokens, OAuth refresh
tokens, webhook secrets or article bodies unnecessarily.

When debugging production behaviour, inspect real data when authorized
rather than guessing.

## 25. Testing requirements

Every bug fix adds a regression test. Every new shared capability has
tests at the layer that owns the invariant.

Tests live in `tests/`, mirroring `lib/`. Test the happy path, the
previously broken path, and adjacent behaviour that could regress.

A passing suite is necessary but not sufficient: tests should cover the
actual invariant (`null` vs `0`, tenancy pick-from-owned, webhook
signature over the raw body, gate refusal to publish, leftover contact
inboxes).

## 26. Migrations

Deterministic, reviewable, safe, compatible with existing data,
tenant-safe, RLS on every new table.

Before adding constraints:

1. audit existing production data;
2. identify violations;
3. resolve or migrate them;
4. then add the constraint.

Never assume production data matches the ideal schema. The keywords
without a business are a real example.

Maintainers apply a migration to production when it reaches `main`. Write
it so it applies cleanly and non-destructively: no `drop` a new table does
not need, `alter policy … using (…) with check (…)` instead of drop and
recreate. A migration that truly needs a `drop` says so in its pull
request. Migrations are append-only: never edit the SQL of one that has
been applied.

## 27. Refactoring rule

Refactoring is encouraged when it removes structural duplication or fixes
an architectural problem. Avoid unrelated rewrites.

A good refactor has a clear reason, bounded scope, tests, preserved
behaviour. Do not rewrite an entire subsystem because a small feature
touches it. If the current implementation makes the requested behaviour
inherently fragile, refactor the relevant abstraction instead of layering
another patch.

## 28. When a bug reveals a systemic problem

If a bug is found repeatedly in different places, stop patching individual
occurrences.

If the dashboard, AI Visibility and a cron each compute "cited?"
differently — one matching function.

If WordPress, the webhook and the blog each sanitise HTML differently —
the pipeline already did that; adapters must not redo it.

If two contact addresses appear on the site — one constant in
`lib/site.ts`, not a third copy in the footer.

Repeated bugs are usually evidence of an abstraction problem.

## 29. Customer requests are product signals

Do not implement a request literally without understanding the generic
capability behind it.

"I want GTF to write the GTF blog" → the generic Webhooks integration,
pointed at `/api/gettrafficfast` and signed with `BLOG_WEBHOOK_SECRET`.
Not a private publishing path.

"I want to change my website URL" → a support-handled new business
profile, because the URL is the identity the pipeline writes for. Not a
silent update that rewrites history.

"I want this article on Shopify" → a publisher adapter, when it exists,
behind the same Canonical Article. Not a one-off export.

## 30. Defaults over blocking

When a missing value does not make the entity invalid, use a sensible
default at the domain/application layer:

- content language → the supported default;
- per-site product features → on (Autopilot, images and video, Push page 3,
  the weekly AI visibility run, the X features; since 2026-11-24): the person
  turns one off, never on. What stays opt-in per person: anything that uses
  the customer's own money or credentials, and anything that would publish on
  their live site without a destination they connected;
- citation engines → none configured means the sweep reports disabled,
  it does not invent a rate;
- blog with no deliveries in `blog_posts` → empty, never filled with samples.

Do not remove validation for genuinely invalid states (a document that
failed a quality gate is not published).

## 31. Data flows should be explicit

For complex features, the flow is written down in `docs/` and in the
workflow:

```text
cron/UI → enqueue job → claim → step (checkpoint) → step → …
        → pipeline → gates → adapter → destination
        → measurements (rank, citations, Search Console)
```

Avoid hidden transformations scattered across components. Especially
important for production, refresh, publishing, tenancy and anything that
calls a paid provider.

## 32. AI features

AI is a product layer, not scattered `generateContent` calls:

```text
job / tool → agent (Zod in, Zod out, budget) → provider → application persists
```

The same authorization, tenancy and business rules as a human user.
Never allow an agent or a future MCP tool to bypass `business_id`, RLS
checks, quality gates or budgets.

An agent that returns prose the next step has to interpret is a
liability. An agent that returns a validated structure is a component.

## 33. Implementation report

For meaningful tasks, after implementation provide a concise report:

- **Root cause** — what was actually wrong?
- **Architecture** — what layer was changed and why?
- **Reuse** — what existing logic was reused?
- **Changes** — what was added/modified?
- **Compatibility** — what existing behaviour was preserved?
- **Tests** — what regression tests were added?
- **Verification** — lint, tests, typecheck; UI flows where relevant.
- **Risks / follow-ups** — remaining debt or edge cases, honestly.

Do not claim something is fixed unless it was actually verified.

## 34. Stop conditions

If the requested change requires a significant architectural decision, do
not silently choose a risky approach. Explain what the architecture does,
what is problematic, the options, the recommendation, and why.

For small, obvious fixes, proceed without ceremony. For large changes
(new provider, new tenancy key, new payload version, turning a cost on),
establish the design before implementing.

## 35. Definition of done

A feature is NOT done because the screen looks correct, the reported
example works, or `tsc` passes.

A change is complete when:

- root cause is understood;
- the correct abstraction is updated;
- no unnecessary duplicate logic exists;
- measurements remain honest (`null` vs `0`, negatives stored, per engine);
- paid loops are bounded and opt-in;
- no invented data was introduced;
- database invariants and RLS are preserved;
- authorization and tenancy are preserved;
- historical data and webhook/payload compatibility are considered;
- regression tests exist and pass;
- lint and typecheck pass;
- affected flows have been verified;
- `docs/` for that subsystem is updated in the same commit.

## 36. Documentation is part of every change

`docs/` is kept current. One document per subsystem. The reader is a
future agent or a tired human at 1am, not a conference talk.

- Architecture: `docs/ARCHITECTURE.md`.
- Subsystem docs: pipeline, jobs, media, knowledge, intelligence,
  lifecycle, citations, analytics, autopilot, placements, blog,
  integrations, tenancy, onboarding emails, Sentry.
- Public / merchant-facing copy on the site must stay honest: if the
  product behaviour changed, the landing FAQ, pricing and in-app empty
  states change in the same slice.
- **The public documentation at `/docs` (`app/docs`, `components/docs/`)
  is updated with every change and every new feature a customer or an
  agent can see**: what it does, how to use it from the app and from
  MCP/the API, its limits. It is written for customers and for the agents
  they connect, in plain English, with no numbers about GTF's own traction
  and no claim the code does not back. A feature that ships without its
  public documentation is not done.

A change whose docs are missing, out of date, or only in a commit message
is not done.

---

## Layout

```
app/            App Router: pages, /api routes, /api/cron sweeps
lib/providers/  vendor boundaries (llm, serp, citations, analytics, …)
lib/domain/     pure logic, no I/O
lib/lifecycle/  rank, decay, citations: the measurement half
lib/jobs/       durable job runner and workflows
lib/agents/     contract, runner, one agent per file
lib/content/    Canonical Article, pipeline, gates
lib/publishing/ adapters (WordPress, webhook, …)
lib/tenancy.ts  which site this request is about
lib/site.ts     origin and public contact inbox
supabase/       migrations, timestamp-prefixed, RLS on every table
tests/          vitest, mirrors lib/
docs/           one document per subsystem; update it with the code
```

---

## Final rule

When deciding between:

A) a quick patch that makes today's example work, and
B) a slightly deeper change that makes the underlying system correct and
   reusable,

prefer B. But do not over-engineer simple problems.

The goal is: simple where possible, structured where necessary, reusable
by default, honest in the numbers, and safe in production.

GetTrafficFast should become easier to extend over time, not harder.
Every change should leave the codebase at least as coherent as it was
before — preferably more coherent.
