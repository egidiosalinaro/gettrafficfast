-- Delivery log for the publish step of the cron: one row per publish attempt
-- (success or failure), so customer-side integration problems can be debugged
-- from the app instead of Vercel logs / Sentry.

create table if not exists public.publish_attempts (
  id uuid primary key default gen_random_uuid(),
  article_id uuid not null references public.articles(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  integration_id uuid references public.integrations(id) on delete set null,
  integration_type text not null,
  ok boolean not null,
  published_url text,
  error text,
  created_at timestamptz not null default timezone('utc', now())
);

alter table public.publish_attempts enable row level security;

-- Read-only for the owner; only the cron (service role) writes.
create policy "Users can view their own publish attempts"
  on public.publish_attempts for select to authenticated
  using (auth.uid() = user_id);

create policy "Service role manages publish attempts"
  on public.publish_attempts for all to service_role using (true) with check (true);

create index if not exists publish_attempts_user_created_idx
  on public.publish_attempts (user_id, created_at desc);

create index if not exists publish_attempts_article_idx
  on public.publish_attempts (article_id, created_at desc);
