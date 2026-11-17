create table if not exists public.integrations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  type text not null check (type in ('wordpress','webflow','shopify','webhook')),
  config jsonb not null default '{}'::jsonb,
  status text not null default 'connected' check (status in ('connected','disconnected','error')),
  last_error text,
  last_sync_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (user_id, type)
);

alter table public.integrations enable row level security;

create policy "Users can view their own integrations"
  on public.integrations for select to authenticated
  using (auth.uid() = user_id);

create policy "Users can insert their own integrations"
  on public.integrations for insert to authenticated
  with check (auth.uid() = user_id);

create policy "Users can update their own integrations"
  on public.integrations for update to authenticated
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

create policy "Users can delete their own integrations"
  on public.integrations for delete to authenticated
  using (auth.uid() = user_id);

create trigger trg_integrations_updated_at
  before update on public.integrations
  for each row execute function public.update_updated_at_column();

create index if not exists integrations_user_id_idx on public.integrations(user_id);

alter table public.articles
  add column if not exists external_post_id text;

-- The cron runs as a system job (Bearer-token authed, no user session).
-- Without these service_role policies, RLS would block it from seeing rows.
create policy "Service role manages articles"
  on public.articles for all to service_role using (true) with check (true);

create policy "Service role reads businesses"
  on public.businesses for select to service_role using (true);

create policy "Service role manages keywords"
  on public.keywords for all to service_role using (true) with check (true);

create policy "Service role reads integrations"
  on public.integrations for select to service_role using (true);
