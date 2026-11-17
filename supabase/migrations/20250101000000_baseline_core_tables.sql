-- Baseline: the four core tables that existed before the first migration.
--
-- articles, businesses, keywords and subscriptions were created by hand in the
-- Supabase dashboard when the product started, so no migration created them,
-- their row level security or their triggers, and the first migration already
-- `alter`s public.articles. A database built from supabase/migrations/ alone
-- failed at that first statement. This file closes the gap: it runs before
-- every other migration and creates what those migrations assume is already
-- there. With it, the whole schema is in migrations.
--
-- It creates each table in the shape it had BEFORE the first migration, not
-- the shape production has today. The later migrations add the remaining
-- columns (attempt_count, business_id, content_language, the settings jsonb
-- columns, keyword source and intent, ...), swap the per-user uniques for
-- per-business ones, and replace the status check; replayed in order on an
-- empty database, the result matches production column for column. Three
-- details exist only because a later migration relies on them:
--
--   * articles_user_id_scheduled_date_key: 20260723150000 drops it by name
--     (without `if exists`) to recreate it deferrable, and 20260914120000
--     replaces it with the per-business key;
--   * businesses_website_url_key and keywords_user_id_keyword_key: replaced by
--     their per-business forms in 20260914120000;
--   * no articles_status_check: the original value list was never recorded,
--     and 20260720100000 (then 20260802120000) defines the check that holds.
--
-- On production every object below already exists, so this file is a no-op
-- there: tables and indexes use `if not exists`; the extension, functions,
-- foreign key, triggers and policies are each created inside a DO block only
-- when the catalogue does not have them. Nothing is dropped or replaced.
--
-- Not here, on purpose: the service-role policies "Service role manages
-- articles", "Service role reads businesses" and "Service role manages
-- keywords" (20260531100000 creates them without a guard, so creating them
-- here would make that migration fail), and the platform's own extensions
-- (pgcrypto, uuid-ossp, pg_stat_statements, supabase_vault) and table grants,
-- which every Supabase project ships with.

-- ── Extension ───────────────────────────────────────────────────────────────
-- keywords_keyword_idx is a trigram index. Production has pg_trgm in public.
do $$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_trgm') then
    create extension pg_trgm with schema public;
  end if;
end $$;

-- ── updated_at trigger functions ────────────────────────────────────────────
-- 20260531100000 attaches update_updated_at_column() to integrations, and
-- 20260723130000 pins the search_path of all three with `create or replace`.
-- Created here with the definitions production has today.
do $$
begin
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'update_updated_at_column'
  ) then
    create function public.update_updated_at_column()
      returns trigger
      language plpgsql
      set search_path = ''
    as $fn$
    begin
      new.updated_at = timezone('utc'::text, now());
      return new;
    end;
    $fn$;
  end if;

  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'update_articles_updated_at'
  ) then
    create function public.update_articles_updated_at()
      returns trigger
      language plpgsql
      set search_path = ''
    as $fn$
    begin
      new.updated_at = timezone('utc'::text, now());
      return new;
    end;
    $fn$;
  end if;

  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'update_keywords_updated_at'
  ) then
    create function public.update_keywords_updated_at()
      returns trigger
      language plpgsql
      set search_path = ''
    as $fn$
    begin
      new.updated_at = timezone('utc'::text, now());
      return new;
    end;
    $fn$;
  end if;
end $$;

-- ── businesses ──────────────────────────────────────────────────────────────
create table if not exists public.businesses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  website_url text not null,
  niche text,
  description text,
  sitemap_url text,
  blog_url text,
  is_locked boolean default false,
  created_at timestamptz not null default timezone('utc'::text, now()),
  updated_at timestamptz not null default timezone('utc'::text, now()),
  constraint businesses_website_url_key unique (website_url)
);

create index if not exists businesses_user_id_idx on public.businesses (user_id);
create index if not exists businesses_website_url_idx on public.businesses (website_url);

alter table public.businesses enable row level security;

-- ── keywords ────────────────────────────────────────────────────────────────
-- article_id references articles, which references keywords: the foreign key
-- is added below, once both tables exist.
create table if not exists public.keywords (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  keyword text not null,
  search_volume integer,
  competition text,
  difficulty integer,
  cpc numeric(10, 2),
  opportunity text,
  status text default 'available'::text,
  is_starred boolean default false,
  article_id uuid,
  created_at timestamptz not null default timezone('utc'::text, now()),
  updated_at timestamptz not null default timezone('utc'::text, now()),
  constraint keywords_user_id_keyword_key unique (user_id, keyword)
);

create index if not exists keywords_user_id_idx on public.keywords (user_id);
create index if not exists keywords_status_idx on public.keywords (status);
create index if not exists keywords_is_starred_idx on public.keywords (is_starred);
create index if not exists keywords_keyword_idx on public.keywords using gin (keyword gin_trgm_ops);

alter table public.keywords enable row level security;

-- ── articles ────────────────────────────────────────────────────────────────
create table if not exists public.articles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  keyword_id uuid not null unique references public.keywords(id) on delete cascade,
  scheduled_date date not null,
  status text not null default 'queued'::text,
  content text,
  published_url text,
  created_at timestamptz not null default timezone('utc'::text, now()),
  updated_at timestamptz not null default timezone('utc'::text, now()),
  constraint articles_user_id_scheduled_date_key unique (user_id, scheduled_date)
);

create index if not exists articles_user_id_idx on public.articles (user_id);
create index if not exists articles_keyword_id_idx on public.articles (keyword_id);
create index if not exists articles_status_idx on public.articles (status);
create index if not exists articles_scheduled_date_idx on public.articles (user_id, scheduled_date);

alter table public.articles enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.keywords'::regclass and conname = 'keywords_article_id_fkey'
  ) then
    alter table public.keywords
      add constraint keywords_article_id_fkey
      foreign key (article_id) references public.articles(id) on delete set null;
  end if;
end $$;

-- ── subscriptions ───────────────────────────────────────────────────────────
-- One row per paying account, written only by the Stripe webhook (service
-- role). Billing stays per account, not per business.
create table if not exists public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  stripe_customer_id text unique,
  stripe_subscription_id text unique,
  status text not null,
  current_period_start timestamptz,
  current_period_end timestamptz,
  cancel_at_period_end boolean default false,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

create index if not exists subscriptions_user_id_idx on public.subscriptions (user_id);
create index if not exists subscriptions_stripe_customer_id_idx on public.subscriptions (stripe_customer_id);
create index if not exists subscriptions_stripe_subscription_id_idx on public.subscriptions (stripe_subscription_id);

alter table public.subscriptions enable row level security;

-- ── updated_at triggers ─────────────────────────────────────────────────────
do $$
begin
  if not exists (
    select 1 from pg_trigger
    where tgrelid = 'public.businesses'::regclass and tgname = 'update_businesses_updated_at'
  ) then
    create trigger update_businesses_updated_at
      before update on public.businesses
      for each row execute function public.update_updated_at_column();
  end if;

  if not exists (
    select 1 from pg_trigger
    where tgrelid = 'public.keywords'::regclass and tgname = 'update_keywords_updated_at'
  ) then
    create trigger update_keywords_updated_at
      before update on public.keywords
      for each row execute function public.update_keywords_updated_at();
  end if;

  if not exists (
    select 1 from pg_trigger
    where tgrelid = 'public.articles'::regclass and tgname = 'update_articles_updated_at'
  ) then
    create trigger update_articles_updated_at
      before update on public.articles
      for each row execute function public.update_articles_updated_at();
  end if;

  if not exists (
    select 1 from pg_trigger
    where tgrelid = 'public.subscriptions'::regclass and tgname = 'update_subscriptions_updated_at'
  ) then
    create trigger update_subscriptions_updated_at
      before update on public.subscriptions
      for each row execute function public.update_updated_at_column();
  end if;
end $$;

-- ── Row level security policies ─────────────────────────────────────────────
-- Each user reads and writes only their own rows; subscriptions are read-only
-- to the user and written by the service role. A policy is created only when
-- no policy of that name exists on the table, so production keeps its own.
-- On an empty database the later migrations then bring them to production's
-- form: 20260723130000 recreates them with `(select auth.uid())`, and
-- 20261109190000 adds the business ownership check to the keyword and article
-- writes once business_id exists (it does not, yet, at this point).
do $$
declare
  p record;
begin
  for p in
    select * from (values
      ('businesses', 'Users can view their own business',
       'for select to public using ((select auth.uid()) = user_id)'),
      ('businesses', 'Users can insert their own business',
       'for insert to public with check ((select auth.uid()) = user_id)'),
      ('businesses', 'Users can update their own business',
       'for update to public using ((select auth.uid()) = user_id)'),
      ('keywords', 'Users can view their own keywords',
       'for select to public using ((select auth.uid()) = user_id)'),
      ('keywords', 'Users can insert their own keywords',
       'for insert to public with check ((select auth.uid()) = user_id)'),
      ('keywords', 'Users can update their own keywords',
       'for update to public using ((select auth.uid()) = user_id)'),
      ('keywords', 'Users can delete their own keywords',
       'for delete to public using ((select auth.uid()) = user_id)'),
      ('articles', 'Users can view their own articles',
       'for select to public using ((select auth.uid()) = user_id)'),
      ('articles', 'Users can insert their own articles',
       'for insert to public with check ((select auth.uid()) = user_id)'),
      ('articles', 'Users can update their own articles',
       'for update to public using ((select auth.uid()) = user_id)'),
      ('articles', 'Users can delete their own articles',
       'for delete to public using ((select auth.uid()) = user_id)'),
      ('subscriptions', 'Users can view their own subscriptions',
       'for select to public using ((select auth.uid()) = user_id)'),
      ('subscriptions', 'Service role can manage all subscriptions',
       'for all to service_role using (true) with check (true)')
    ) as v(tbl, name, body)
  loop
    if not exists (
      select 1 from pg_policies
      where schemaname = 'public' and tablename = p.tbl and policyname = p.name
    ) then
      execute format('create policy %I on public.%I %s', p.name, p.tbl, p.body);
    end if;
  end loop;
end $$;
