-- Lifecycle layer (architecture Phase 5): the loop that keeps published
-- content competitive instead of leaving it to decay.
--
-- content_metrics is the time series a refresh decision is made from. It is
-- source-tagged from day one: rank comes from our own SERP snapshots today,
-- Search Console lands in the same table tomorrow without a migration.
--
-- article_versions keeps every canonical document we ever published, so a
-- refresh is a new version rather than an overwrite — and a bad refresh can
-- always be compared against what it replaced.

create table if not exists public.content_metrics (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  article_id uuid not null references public.articles(id) on delete cascade,
  keyword_id uuid references public.keywords(id) on delete set null,
  captured_on date not null default (timezone('utc', now()))::date,
  source text not null check (source in ('serp', 'search_console')),
  -- null position means "measured, and not ranking" — a fact, not a gap.
  position numeric(6,2),
  impressions integer,
  clicks integer,
  created_at timestamptz not null default timezone('utc', now()),
  unique (article_id, captured_on, source)
);

create index if not exists content_metrics_article_idx
  on public.content_metrics (article_id, captured_on desc);
create index if not exists content_metrics_user_idx
  on public.content_metrics (user_id, captured_on desc);

create table if not exists public.article_versions (
  id uuid primary key default gen_random_uuid(),
  article_id uuid not null references public.articles(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  version integer not null,
  canonical jsonb not null,
  reason text,
  created_at timestamptz not null default timezone('utc', now()),
  unique (article_id, version)
);

create index if not exists article_versions_article_idx
  on public.article_versions (article_id, version desc);

-- When the article was last rewritten. Drives the refresh cooldown, and is
-- the age a staleness check measures from.
alter table public.articles
  add column if not exists last_refreshed_at timestamptz;

-- ── RLS: owners read, the platform writes ───────────────────────────────────
alter table public.content_metrics enable row level security;
alter table public.article_versions enable row level security;

create policy "Users can view their own content metrics"
  on public.content_metrics for select to authenticated
  using (auth.uid() = user_id);

create policy "Service role manages content metrics"
  on public.content_metrics for all to service_role using (true) with check (true);

create policy "Users can view their own article versions"
  on public.article_versions for select to authenticated
  using (auth.uid() = user_id);

create policy "Service role manages article versions"
  on public.article_versions for all to service_role using (true) with check (true);
