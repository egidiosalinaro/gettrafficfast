# Legal pages

`/privacy-policy` (`app/privacy-policy/page.tsx`) and `/terms-and-conditions`
(`app/terms-and-conditions/page.tsx`), framed by
`components/legal/legal-page.tsx` (title, fixed date, anchor list, one
`<section id>` per heading). MCP directories (Anthropic, OpenAI) link to both,
and `/docs/mcp#privacy` links to `/privacy-policy#api-and-mcp`; keep the
anchors stable.

## One source: `lib/legal.ts`

| Constant | What |
| --- | --- |
| `LEGAL_LAST_UPDATED` | ISO date the texts last changed. Fixed, never `new Date()`. Change it with the text, same commit. |
| `LEGAL_OPERATOR` | Egidio Salinaro, sole proprietor (ditta individuale), Via Baccina 87, 00184 Roma, Italy. Controller and provider. |
| `LEGAL_VAT_NUMBER` | Partita IVA of the operator, printed on the privacy policy, the terms and the footer. Leave it empty in a fork: `vatNumberLine()` then returns null and no VAT line is printed. A constant, not an env var, because the footer renders it. |
| `SERVICE_PROVIDERS` | Processors of personal data for the hosted service, each with purpose, data, privacy URL and `evidence` (a file that must still contain a marker). |
| `PUBLIC_SOURCES` | Public platforms read for public data (Reddit, GitHub, Hacker News, Stack Exchange, DEV). |
| `DISABLED_INTEGRATIONS` | In the code, off in production: OpenAI images, Perplexity, Reddit Data API, Resend. The page says so. |
| `PROVIDER_MODULES` | Every file under `lib/providers`, classified `provider`, `source`, `disabled` or `internal`. |

The provider list was checked on 2026-11-16 against the production
environment's variable names (Vercel): set are Gemini, Anthropic
(`LLM_WRITER_PROVIDER`, `LLM_ARTICLE_ROTATION`), `CITATIONS_GEMINI`,
`SERPER_API_KEY`, `YOUTUBE_API_KEY`, `X_API_ENABLED` + token,
`PLACEMENTS_GITHUB`, Google OAuth (Search Console), Stripe, Sentry, Supabase;
not set are `OPENAI_API_KEY`, `PERPLEXITY_API_KEY`, `REDDIT_CLIENT_ID`,
`RESEND_API_KEY`. **Before setting one of the latter in production, move it to
`SERVICE_PROVIDERS` and update the date.**

## What the texts rely on

- Call log retention: `TOOL_CALLS_RETENTION_DAYS` (90, `lib/tools/retention.ts`,
  daily `/api/cron/prune-tool-calls`), imported, not retyped.
- Token lifetimes: `ACCESS_TOKEN_TTL_MS`, `REFRESH_TOKEN_TTL_MS`
  (`lib/oauth/config.ts`). Expired token rows are not swept yet
  (docs/API.md, "Not built yet"); the policy says so.
- Account deletion: no self-service route. On request the owner deletes the
  auth user; every table references `auth.users` or `businesses` with
  `on delete cascade` (or `set null` for cross-links). The policy promises
  30 days.
- Search Console disconnect deletes the `analytics_connections` row (the
  refresh token); imported metrics stay (docs/ANALYTICS.md).
- Database region: Supabase project `gettrafficfast`, eu-west-3 (Paris).
  Sentry DSN: `ingest.de.sentry.io` (EU).
- DataFast loads the default script, which sets first-party cookies
  (docs/DATAFAST.md); there is no consent banner.

## Tests

`tests/legal.test.ts` (fixed date, VAT omitted when empty, every provider
file classified, every listed provider still in the code) and
`tests/legal-pages.test.tsx` (rendered pages: anchors, providers, Limited
Use, no em dash, no prices in the terms).
