# Onboarding lifecycle emails

Daily cron (`vercel.json` → `/api/cron/onboarding-emails`, 08:30 UTC,
`CRON_SECRET`-protected) sending at most one email of each type per user,
tracked in `notification_log` (unique on `(user_id, type)`).

| Email | Timing | Audience |
| --- | --- | --- |
| `welcome` | first run after signup (users < 48h old) | everyone with an email |
| `onboarding_nudge` | once, 3+ days after signup | users with **no business** configured (signup < 30 days ago) |

Rationale for the nudge: the funnel data shows most signups never create a
business (which the article pipeline needs for context), and manual keyword
search works without one — see the `dakikareklam` case: 20 keywords, a Stripe
trial, zero businesses, churned same day.

The 30-day cap prevents blasting long-dormant accounts when the feature ships.
To manually (re-)nudge an older user, delete their `notification_log` row and
temporarily widen `NUDGE_MAX_AGE_DAYS`, or just send from Resend directly.

Templates live in `lib/notifications/email.ts` (same layout as failure
notifications: light background, dark CTA button, product tone). The welcome
mail describes the operating loop, not a calendar-first product. Sending uses
`RESEND_API_KEY` / `NOTIFICATIONS_FROM_EMAIL` and is skipped with a log line if
unset.

The article-failed notification (`articleFailedEmail`, sent by the
`produce-article` workflow) is not an onboarding email but shares the
layout. It states the real attempt count and a reason written by us, never
the raw error (which can be a vendor's message). It is not sent at all when
the cause is an AI provider that cannot pay or did not answer: that article
is only delayed and goes back to `queued` (`docs/AGENT_RUNTIME.md`). The
operator alert for a billing refusal (`llmBillingAlertEmail`) goes to
`OPERATOR_EMAIL`, defaulting to `CONTACT_EMAIL`, at most once per UTC day.
