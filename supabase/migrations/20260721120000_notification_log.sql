-- One row per (user, notification type) so lifecycle emails (welcome,
-- onboarding nudge, ...) are sent at most once per user. Written only by the
-- cron via the service role; RLS blocks everyone else.

create table if not exists public.notification_log (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  type text not null,
  sent_at timestamptz not null default timezone('utc', now()),
  unique (user_id, type)
);

alter table public.notification_log enable row level security;

create policy "Service role manages notification log"
  on public.notification_log for all to service_role using (true) with check (true);
