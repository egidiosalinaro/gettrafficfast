# Maintainers

How the public repository is run: who can merge, how `main` is protected,
how deploys and migrations happen, and the exact GitHub and Vercel
settings behind it. The settings are toggled by the repository owner in
the GitHub and Vercel dashboards; nothing in this repository changes them.

## The flow

| Who | How a change reaches `main` |
|---|---|
| Contributor | Fork, branch, pull request. CI green, an approving review from a code owner, then the maintainer squash-merges |
| Maintainer (repository admin) | Directly on `main`, as before: the branch rule lets admins bypass it. Same checks locally first (`npm run lint`, `npx tsc --noEmit`, `npx vitest run`) |
| Dependabot | Pull requests like a contributor's; reviewed and merged by the maintainer |

Every push to `main` deploys production on Vercel. A merged pull request
that adds a migration is applied to the production Supabase project by the
maintainer right after the merge (the migration rules are in
`CONTRIBUTING.md`); fork pull requests never touch the database.

## GitHub settings

### Settings, General

- **Default branch**: `main`.
- **Pull Requests**: allow **squash merging** only (untick merge commits and
  rebase merging), so `main` stays linear, one commit per change. Default
  commit message: "Pull request title and description".
- **Always suggest updating pull request branches**: on.
- **Automatically delete head branches**: on.

### Settings, Rules, Rulesets: a ruleset for `main`

Create a branch ruleset (New ruleset, New branch ruleset):

- **Name**: `main`. **Enforcement status**: Active.
- **Bypass list**: add **Repository admin** with "Always allow". This is
  what lets the maintainer push directly to `main`; nobody else is on it.
- **Target branches**: Add target, "Include default branch".
- **Rules**:
  - **Restrict deletions**: on.
  - **Block force pushes**: on.
  - **Require linear history**: on.
  - **Require a pull request before merging**: on, with
    - Required approvals: **1**;
    - **Dismiss stale pull request approvals when new commits are pushed**: on;
    - **Require review from Code Owners**: on (`.github/CODEOWNERS` names the maintainer for every path);
    - **Require approval of the most recent reviewable push**: on;
    - **Require conversation resolution before merging**: on;
    - Allowed merge methods: Squash.
  - **Require status checks to pass**: on, with
    - **Require branches to be up to date before merging**: on;
    - required checks (they appear in the picker after CI has run once on a
      pull request): `Lint, types, tests`, `DCO sign-off`, `Secret scan`.

The equivalent with classic branch protection (Settings, Branches, Add
rule for `main`) is: require a pull request, 1 approval, code owner
review, dismiss stale approvals, the three status checks, conversation
resolution, linear history; leave "Do not allow bypassing the above
settings" **unticked** so admins can push.

### Settings, Actions, General

- **Actions permissions**: "Allow all actions and reusable workflows" or,
  stricter, "Allow owner, and select non-owner, actions" with
  `actions/checkout@*, actions/setup-node@*, gitleaks/gitleaks-action@*`.
- **Fork pull request workflows from outside collaborators**: "Require
  approval for first-time contributors" (or "for all outside
  collaborators"). A maintainer clicks "Approve and run" after reading the
  diff.
- **Workflow permissions**: "Read repository contents and packages
  permissions". Do not allow Actions to create or approve pull requests.

The CI workflow uses `pull_request`, never `pull_request_target`, and needs
no secrets, so a fork's code never runs with access to anything.

### Settings, Code security

- **Private vulnerability reporting**: Enable (SECURITY.md points to it).
- **Dependency graph**, **Dependabot alerts**, **Dependabot security
  updates**: Enable. Version updates come from `.github/dependabot.yml`.
- **Secret scanning** and **Push protection**: Enable.
- **Code scanning** (CodeQL default setup): optional, recommended.

### Settings, Collaborators and teams

Only the maintainer has Admin. Anyone given Write later should not be on
the ruleset's bypass list.

### Other

- **Issues** on, with the templates in `.github/ISSUE_TEMPLATE/`.
  **Discussions** optional.
- Add a description, the website (`https://gettrafficfa.st`) and topics
  (`seo`, `aeo`, `mcp`, `nextjs`, `supabase`, `content-marketing`).

## Vercel settings

The Vercel project is connected to this repository; production deploys
from `main`.

### Project, Settings, Git

- **Production Branch**: `main`.
- **Git Fork Protection**: **on** (it is on by default; check it). A pull
  request from a fork then does not deploy until a team member authorizes
  it, and an authorized fork deployment still gets no environment
  variables marked Sensitive.
- **Ignored Build Step**: leave automatic, or skip builds for
  documentation-only changes if build minutes matter.

### Project, Settings, Environment Variables

- Scope every production secret (Supabase service role, provider keys,
  Stripe, `CRON_SECRET`, `INTEGRATIONS_ENCRYPTION_KEY`) to **Production
  only**, not Preview or Development, and mark it **Sensitive**. A preview
  deployment, including one of a fork that someone authorized, then cannot
  read them.
- If previews need a backend, give the Preview environment its own
  Supabase project and test-mode keys, never production's.
- `BILLING_DISABLED` must **not** be set in Production.

### Project, Settings, Deployment Protection

- **Vercel Authentication** on for Preview deployments (Standard
  Protection), so previews are not public.

### Crons

The crons in `vercel.json` run only on the production deployment. They
need the Pro plan (one runs every 5 minutes) and `CRON_SECRET` in
Production.

## Reviewing a pull request

1. CI green, including the DCO and secret-scan jobs.
2. Read the diff against `AGENTS.md`: layers, Zod at boundaries, honest
   measurements, cost opt-in and capped, tenancy, the parity test, docs and
   public docs in the same change.
3. A migration: applies cleanly from zero, RLS on new tables, no
   destructive statement without a reason. Apply it to production right
   after merging, then verify (table exists, RLS on, policies present).
4. Anything that spends money: the switch, the cap, the cost per run.
5. Squash-merge with a title and body in the history's style; the
   `Signed-off-by` lines are kept in the squashed message.

## Releasing

There are no versioned releases: `main` is the release, and the hosted
service runs it. Self-hosters track `main` (`docs/SELF_HOSTING.md`,
"Updating").
