# Security policy

GetTrafficFast holds other people's sites, credentials for their blogs and
Search Console, and API keys that can spend money. A vulnerability report is
taken seriously and answered by a person.

## Reporting a vulnerability

**Do not open a public issue, discussion or pull request for a
vulnerability.** Report it privately, by either:

1. **GitHub private vulnerability reporting**: this repository's
   **Security** tab, then **Report a vulnerability**. This is the preferred
   channel: the report, the discussion and the fix stay in one private
   advisory.
2. **Email** to the contact address of the project, listed at
   <https://gettrafficfa.st/docs#contact> and in the code as `CONTACT_EMAIL`
   in [`lib/site.ts`](lib/site.ts). Put "Security" in the subject.

Please include what you found, where (file, route, MCP tool or URL), how to
reproduce it, and what an attacker could do with it. A proof of concept is
welcome; keep it to your own account and data.

### What happens next

- An acknowledgement within 5 working days.
- An assessment and a plan, or a reasoned "not a vulnerability", as soon as
  the report is understood.
- A fix on `main`, which deploys the hosted service, then a published
  advisory crediting you, unless you prefer not to be named.

Please give us a reasonable time to fix the problem before disclosing it,
and coordinate the date with us.

## Scope

In scope:

- this repository's code: the Next.js app, its API routes (`app/api/`), the
  MCP server (`/api/mcp`) and its OAuth flow, the crons, the job runner, the
  Supabase migrations and their row-level security;
- the hosted service at `gettrafficfa.st`, as far as a flaw comes from this
  code: tenant isolation (reading or changing another account's sites,
  articles, integrations or keys), authentication and authorization,
  stored credentials, webhook signatures, server-side request forgery
  through URLs the app fetches, spending a paid provider call without
  authorization, and secrets in the repository or its history.

Out of scope:

- vulnerabilities in third-party services (Supabase, Vercel, Stripe, model
  and search providers) themselves: report those to the vendor;
- a self-hosted deployment's own configuration (its keys, network and
  hosting): that is its operator's responsibility, though a flaw in the
  code a self-hoster runs is in scope;
- denial of service by volume, spam, and social engineering;
- findings from automated scanners without a demonstrated impact, missing
  headers with no exploit, and best-practice suggestions (an ordinary issue
  is fine for those);
- testing against other people's accounts or data on the hosted service.
  Use your own account, and stop and report as soon as you can see data
  that is not yours.

## Bounty

There is no bug bounty programme. Valid reports are credited in the
advisory if you wish.

## Supported versions

Only `main` is supported. The hosted service runs `main`; a self-hosted
deployment should track it.
