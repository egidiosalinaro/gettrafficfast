# Sentry error monitoring

Platform `javascript-nextjs`, SDK `@sentry/nextjs`. Sentry is optional and
per deployment: every value below comes from the environment.

| Variable | Used by | Unset |
| --- | --- | --- |
| `NEXT_PUBLIC_SENTRY_DSN` | the three init files | Sentry stays off |
| `SENTRY_ORG`, `SENTRY_PROJECT` | `withSentryConfig` in `next.config.ts`, for source maps | no source-map upload |
| `SENTRY_AUTH_TOKEN` | the build, to upload source maps | the build still succeeds |

## Wiring

- `sentry.server.config.ts` / `sentry.edge.config.ts` — server & edge init,
  loaded from `instrumentation.ts` (which also exports `onRequestError` so App
  Router server errors are captured automatically).
- `instrumentation-client.ts` — browser init + router transition tracing.
- `app/global-error.tsx` — captures render errors from the App Router root.
- `next.config.ts` — wrapped with `withSentryConfig` (org `SENTRY_ORG`,
  project `SENTRY_PROJECT`). Since SDK v11 it is imported from
  `@sentry/nextjs/config`, and SDK debug logging is stripped with
  `bundleSizeOptimizations.excludeDebugStatements` (v10's `disableLogger`).
  The upgrade from v10 cleared the moderate glob and minimatch advisories in
  the bundler plugin.
- The cron (`/api/cron/generate-articles`) swallows per-article errors by design,
  so it calls `Sentry.captureException` explicitly with tags
  `job=generate-articles`, `phase=generate|publish`.
- The job worker (`lib/jobs/worker.ts`) captures every step failure with
  tags `job_type`, `step`, `exhausted`, except a `TerminalStepError`: that
  is a sentence written for the person ("say how you use the product in
  Settings first", "nothing to say here but the product"), an outcome on
  record in `jobs.last_error`, not something the code did not expect
  (`docs/AGENT_RUNTIME.md`).

The DSN is public by design (it ships in the browser bundle) and is read from
`NEXT_PUBLIC_SENTRY_DSN` by the three `*.config.ts` init files.
`enabled: NODE_ENV === "production"` keeps local dev noise out.

A provider refusal because the account cannot pay (`LlmError` with
`report: false`: Gemini 402 / depleted credits; Claude 402, the tier's
monthly cap or a spend limit) is not captured as an exception. Reporting it
per step made one empty balance a standing issue on every cron, and
silencing it entirely hides an outage where both model accounts are empty.

Instead, when the whole LLM layer refuses (the primary with no fallback, or
the primary and the fallback both), `lib/llm-billing.ts` sends **one
`captureMessage` per provider per UTC day**, level `fatal`, fingerprint
`["llm-billing", <provider>]`, tags `llm_billing`, `source`, `job_type`,
`step`. Alert on `level:fatal` for this fingerprint. The operator also gets
one email per UTC day (`OPERATOR_EMAIL`, default `CONTACT_EMAIL`). The
dedupe lives in `operator_alerts`; LLM-bound jobs are held, not failed,
while `provider_pauses` says so (`docs/AGENT_RUNTIME.md`, "When the model
accounts cannot pay").

With `LLM_FALLBACK=anthropic` a Gemini failure goes to Claude first, and a
rescued call is not an error: it leaves an `llm.fallback` warning in the
function logs and a Claude model on its `agent_runs` row. Only when both fail
does the step fail, with both reasons in one message. That error is captured
when either side was a defect (a refused key, an outage, a bad request) and
not when both accounts simply cannot pay.

## Vercel setup (optional but recommended)

Set `SENTRY_ORG`, `SENTRY_PROJECT` and `SENTRY_AUTH_TOKEN` (an auth token
created in your Sentry organization's settings) in the hosting provider's
environment so builds upload source maps and stack traces are readable.
Without them the build still succeeds.
