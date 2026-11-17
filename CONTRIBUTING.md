# Contributing to GetTrafficFast

Thanks for helping. GetTrafficFast is a production service: every change
merged to `main` is deployed to the hosted service, so the bar is "would
this be safe to ship to paying customers today". This guide says how to get
there without surprises.

The full engineering contract is [`AGENTS.md`](AGENTS.md), and the
architecture every structural change is checked against is
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). Read both before changing
structure. This file is the part a contributor has to get right in a pull
request.

## Setup

Requirements: Node.js 22 (see `.nvmrc`) and npm.

```sh
git clone https://github.com/<your-fork>/gettrafficfast.git
cd gettrafficfast
npm ci
npx vitest run
```

The test suite needs no environment variables, no database and no network:
every provider and Supabase are faked. If a test you write needs a secret,
it is the wrong test: mock the provider.

To run the app against a real database, follow
[`docs/SELF_HOSTING.md`](docs/SELF_HOSTING.md) (a Supabase project, the
migrations, `.env.local`). Set `BILLING_DISABLED=1` locally so you do not
need Stripe.

## The checks

CI runs these on every pull request ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)),
and they must pass before a review starts:

```sh
npm run lint          # ESLint, 0 errors
npx tsc --noEmit      # type-check
npx vitest run        # the whole suite
```

If `tsc` reports errors in `.next/types` after switching branches, remove
the stale generated types (`rm -rf .next/types .next/dev`) and run it again.

A pull request also gets a secret scan (gitleaks). Never commit a key,
token, `.env` file or customer data, even a revoked one.

## The rules a change must follow

These come from `AGENTS.md`. A pull request that breaks one will be asked
to change, however good the feature.

**Orchestration is code, steps are agents.** What runs, in what order and
what happens on failure is plain TypeScript with tests. Nothing decides
"what to do next" by prompting a model.

**Zod at every boundary.** Every agent's input and output, every API body
and every MCP tool's input and output is validated with a Zod schema. An
agent never writes to the database; the job workflow persists what it
returns.

**Layers depend downward only**: UI, then Tools (`lib/tools/`), then
Application (`lib/jobs/`), then Agents (`lib/agents/`), then Domain
(`lib/domain/` and friends, no I/O), then Providers (`lib/providers/`).
Never sideways. **No vendor name appears above `lib/providers/`**:
swapping a model, a SERP or an answer engine is a setting, not a rewrite.

**Measurements are honest.**

- A rate with no samples is `null`, never `0`. Zero means "never cited";
  null means "not measured yet".
- Negative results are stored, never skipped. "We asked and were not cited"
  is the measurement.
- Rates are per engine, never averaged across engines.
- Citation data is sampled, not ground truth, and anything a customer sees
  says so.
- No invented data: when something is unknown, record and show the
  uncertainty. Never fill a gap with a plausible value.

**Cost is opt-in and bounded.** Every model, search or answer-engine call
costs money. A feature that spends is off unless an env var turns it on,
even when the API key is present. A loop that calls a provider has a cap
per run; state the cost per run in the pull request.

**Tenancy.** A site is always picked from the businesses the user owns,
never from a cookie or an id alone. RLS stays on every table.

**Every screen action has its tool.** A new action on a screen ships with
its tool in `lib/tools/registry.ts`, calling the same function the route
calls, so it works over the REST API and MCP too.
[`tests/tools/parity.test.ts`](tests/tools/parity.test.ts) fails otherwise.

**Docs in the same pull request.** A change in behaviour updates its
document in `docs/`. Anything a customer or their agent can see also
updates the public docs (`app/docs/`, `components/docs/`).

**Tests.** Every bug fix adds a regression test; a new capability is tested
at the layer that owns its invariant. Tests live in `tests/`, mirroring
`lib/`.

**No customer-specific code.** A request from one customer is evidence of a
missing generic capability; build that instead of an `if` for their case.

### Migrations

- One file per change in `supabase/migrations/`, named
  `YYYYMMDDHHMMSS_short_description.sql`, later than every existing one.
- Row-level security on every new table, with its policies in the same file.
- Compatible with existing data: audit what is there before adding a
  constraint, and migrate the rows that would violate it first.
- No destructive statements unless the change truly needs them. To change a
  policy use `alter policy … using (…) with check (…)`, not drop and
  recreate. If a `drop` is unavoidable, say so prominently in the pull
  request: the maintainer applies it by hand.
- Migrations are applied to production by the maintainer after the merge.
  Write them so they apply cleanly to an empty project too (`supabase db
  reset` must work).

## Pull requests

1. **Open an issue first** for anything larger than a small fix, so the
   approach can be agreed before you write it.
2. **Fork** the repository and create a branch in your fork.
3. Make one logical change, with tests and docs. Keep unrelated changes
   out; add files by explicit path, not `git add -A`.
4. **Sign off every commit** (DCO, below).
5. **Open a pull request** against `main` and fill in the template.
6. **CI must be green.** A maintainer will not review a red pull request.
7. **Review and approval.** Every pull request needs an approving review
   from a code owner (`.github/CODEOWNERS`) before it can merge. The
   maintainer may ask for changes, or decline a change that does not fit
   the product, with a reason.
8. The maintainer merges (squash), then the change deploys to the hosted
   service, and any migration is applied.

Pull requests from forks never receive production secrets, and their
preview deployments do not run with production configuration. If your
change needs a real provider to verify, describe what you checked locally.

## Developer Certificate of Origin (DCO)

GetTrafficFast uses the [Developer Certificate of Origin](https://developercertificate.org/)
instead of a contributor license agreement. By signing off a commit you
certify that you wrote the change, or otherwise have the right to submit it
under the project's license (AGPL-3.0-only, or MIT for
`distribution/skills/`).

Sign off with `-s`:

```sh
git commit -s -m "Explain what changed and why"
```

which adds a line with your name and email:

```
Signed-off-by: Your Name <you@example.com>
```

Use your real name or a consistent identity. Forgot it? `git commit --amend
-s` for the last commit, or `git rebase --signoff main` for the branch,
then force-push your branch.

## Commit messages

A short title that says what changed, then a body in prose explaining why.
Match the existing history.

## Trademarks

Contributions are licensed under the AGPL, but the GetTrafficFast name and
logo are not. Please do not add the marks to unrelated places, and if you
run your own fork as a service, rename it ([`TRADEMARKS.md`](TRADEMARKS.md)).

## Conduct and security

Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).
Report security problems privately, never in an issue: see
[`SECURITY.md`](SECURITY.md).

## For maintainers

How the branch is protected, how the maintainer pushes, and how Vercel and
GitHub are configured is in [`docs/MAINTAINERS.md`](docs/MAINTAINERS.md).
