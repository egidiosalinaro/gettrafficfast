-- Analytics connections (architecture Phase 5): the per-user OAuth grants that
-- let the platform read a customer's real traffic instead of inferring it.
--
-- Deliberately NOT the integrations table. That one holds publishing
-- destinations, places we write to, and its type check says so. Search Console
-- is a source we read from, with a different lifecycle (a refresh token that
-- can be revoked by Google at any time) and a different failure meaning: a
-- broken publisher stops delivery, a broken analytics connection only stops
-- measurement.
--
-- The refresh token is the credential: it is encrypted at rest with the same
-- AES-256-GCM helper as publishing credentials, and never returned to a client.

create table if not exists public.analytics_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  provider text not null check (provider in ('search_console')),
  refresh_token_encrypted text not null,
  -- The property the customer picked, in Google's own form: either
  -- "sc-domain:example.com" or a URL prefix. Null until they choose one.
  site_url text,
  status text not null default 'connected'
    check (status in ('connected', 'disconnected', 'error')),
  last_error text,
  -- Last day already ingested, so a run resumes instead of refetching history.
  last_synced_on date,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (user_id, provider)
);

create index if not exists analytics_connections_user_idx
  on public.analytics_connections (user_id);

-- ── RLS: owners read, the platform writes ───────────────────────────────────
alter table public.analytics_connections enable row level security;

-- Read only. The refresh token lives in this table, so even the owner reaches
-- it through routes that strip it: no client-side select returns the column
-- by accident, because the API layer never selects it.
create policy "Users can view their own analytics connections"
  on public.analytics_connections for select to authenticated
  using (auth.uid() = user_id);

create policy "Service role manages analytics connections"
  on public.analytics_connections for all to service_role using (true) with check (true);
