-- LLM billing: a durable pause and a once-a-day operator alert.
--
-- On 2026-11-08 both model accounts ran out of credits and nobody was told:
-- billing refusals were kept out of Sentry on purpose, the worker spent every
-- attempt on calls that could not succeed, and the crons kept enqueueing paid
-- work for a model that would refuse it. See docs/AGENT_RUNTIME.md.
--
-- provider_pauses: one row per provider kind ('llm' today). While
-- paused_until is in the future the job tick leaves LLM-bound jobs queued
-- (no attempt spent) and the crons that enqueue LLM work skip it. The row is
-- overwritten each time a refusal is seen again, so a pause that expires is
-- simply tried once and renewed if the account still cannot pay.
--
-- operator_alerts: dedupe for operator alerts, one row per (key, UTC day).
-- An insert that conflicts means today's alert was already sent. It is not
-- notification_log, which is per customer (user_id not null, unique per type
-- forever): an operator alert has no user and repeats daily.
--
-- Both are written only by the service role (cron, worker); RLS blocks
-- everyone else.

create table if not exists public.provider_pauses (
  kind text primary key,
  paused_until timestamptz not null,
  reason text,
  providers text[] not null default '{}',
  updated_at timestamptz not null default timezone('utc', now())
);

alter table public.provider_pauses enable row level security;

create policy "Service role manages provider pauses"
  on public.provider_pauses for all to service_role using (true) with check (true);

create table if not exists public.operator_alerts (
  alert_key text not null,
  day date not null,
  sent_at timestamptz not null default timezone('utc', now()),
  detail text,
  primary key (alert_key, day)
);

alter table public.operator_alerts enable row level security;

create policy "Service role manages operator alerts"
  on public.operator_alerts for all to service_role using (true) with check (true);
