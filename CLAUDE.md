# Working rules for this repository

The engineering contract is **`AGENTS.md`**. Read it before changing
structure. This file is the operational extract an agent has to get right on
the first commit. If the two disagree, `AGENTS.md` wins.

These rules apply to anyone working on GetTrafficFast, human or agent. They
are not style preferences: each one exists because getting it wrong costs
real money, real trust, or a silent regression.

## Branches and review

`main` is the production branch: a merge to `main` deploys the hosted
product.

- **Contributors** work on a branch or a fork and open a pull request. It
  merges only with a maintainer's approval and green CI. Use your own Git
  identity.
- **Maintainers** merge to `main`.
- **Agents working for a maintainer** follow that maintainer's instructions
  (branch, identity, whether to push). Otherwise, follow the contributor
  workflow.

The contributor flow in full (setup, checks, DCO sign-off, the pull request
template) is `CONTRIBUTING.md`; the maintainers' settings and review steps are
`docs/MAINTAINERS.md`.

No AI attribution trailers in commit messages (`Co-Authored-By:`, session
links, tool signatures): the message ends with its last line of content.

## Before every commit

1. `npm run lint` is clean.
2. `npm test` is green. Vitest, tests live in `tests/` mirroring `lib/`.
3. `npx tsc --noEmit` type-checks (the build runs it anyway; catching it here
   is cheaper than a failed deploy).
4. `git add` on explicit paths, never `git add -A`, so unrelated changes don't
   ride along.

## Data in the repository

Tests, fixtures and docs use fictional people, handles, businesses and
numbers. Never copy a production row, a customer's data, a real person's
post or a deployment's ids, domains or accounts into the tree: deployment
values come from the environment and are documented in `.env.example`.

## Migrations

Migrations live in `supabase/migrations/`, timestamp-prefixed, RLS on every
table, append-only (never edit the SQL of a migration that has been
applied). Write them so they apply cleanly and non-destructively:

- a new table needs no `drop policy if exists`: create its policies directly;
- to change an existing policy, use `alter policy … using (…) with check (…)`
  instead of `drop policy` plus `create policy`;
- avoid `drop` of anything unless the change truly needs it, and say so in
  the pull request when it does.

Maintainers apply a migration to production when it reaches `main`, then
verify it with a read query (table exists, RLS on, policies present).

## What the code is, in one paragraph

Not an article generator: a content operating system. A customer connects a
site, and the platform researches, plans, writes, enriches, publishes,
monitors and improves the content that makes that business findable, on search
engines (SEO) and inside AI answer engines (AEO). `docs/ARCHITECTURE.md` is the
reference every architectural decision is checked against; read it before
changing structure.

## The rules that keep the architecture standing

**Orchestration is code, steps are agents.** The graph of what runs, in what
order, and what happens on failure lives in plain TypeScript with tests. Every
agent's input and output is schema-validated with Zod. Nothing decides "what to
do next" by prompting a model.

**Layers depend downward only**, never sideways: UI → Tools → Application →
Agents → Domain → Providers. No vendor name appears above the provider layer,
which is what makes swapping a vendor a setting rather than a rewrite.

**Measurements are honest or they are worthless.** This matters most in the
lifecycle code and any feature built on it:

- A rate with no samples is `null`, never `0`. Zero reads as "never cited";
  null reads as "not measured yet", and confusing the two invents a number.
- Negative results are stored, never skipped. "We asked and were not cited" is
  the measurement; a missing row reads as "we never asked".
- Rates are per engine. Engines disagree, and averaging them produces a number
  that describes nothing.
- Citation data is **sampled**, not ground truth: no answer engine exposes "was
  I cited" as an API. Anything customer-facing has to say so.

**Every probe is a paid call.** Sweeps are bounded and rotate rather than
covering everything each run. Before adding a loop that calls a provider, work
out what it costs per run and cap it. Cost must never switch itself on: a
feature that spends money is opt-in behind an env var, even when the API key
is already present.

**No invented data.** When something is uncertain, record the uncertainty and
say so in the UI. Never fill a gap with a plausible value.

## Layout

```
app/            App Router: pages, /api routes, /api/cron sweeps
lib/providers/  vendor boundaries (llm, serp, citations, analytics, …)
lib/domain/     pure logic, no I/O
lib/lifecycle/  rank, decay, citations: the measurement half
lib/jobs/       durable job runner and workflows
supabase/       migrations, timestamp-prefixed, RLS on every table
tests/          vitest, mirrors lib/
docs/           one document per subsystem; update it with the code
```

`docs/` is the real documentation and it is kept current: a slice that changes
behaviour updates its document in the same commit. The public documentation
at `/docs` (`app/docs`, `components/docs/`) is updated in the same commit
too, for anything a customer or the agent they connect can see. Every screen
action has its MCP tool, held by `tests/tools/parity.test.ts` (AGENTS.md §20).
