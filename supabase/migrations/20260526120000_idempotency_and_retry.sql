-- Idempotency table for Stripe webhook events.
-- RLS is enabled with no policies: only the service role (used by the webhook
-- handler) can read/write. Anon/authenticated clients are denied by default.
create table if not exists public.processed_stripe_events (
  event_id text primary key,
  event_type text not null,
  processed_at timestamptz not null default timezone('utc', now())
);

alter table public.processed_stripe_events enable row level security;

-- Retry / dead-letter columns for the article generation cron.
alter table public.articles
  add column if not exists attempt_count integer not null default 0,
  add column if not exists last_error text,
  add column if not exists failed_at timestamptz;

create index if not exists articles_status_scheduled_idx
  on public.articles (status, scheduled_date)
  where status = 'queued';
