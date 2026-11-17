-- Push page 3 (docs/LIFECYCLE.md, "Push page 3"), 2026-11-15.
--
-- Two additive tables, no drop:
--
-- 1. content_queries: the Search Console queries that brought impressions to
--    each published article over the last 28 settled days. Until now the
--    sync stored per page and per day only (content_metrics), so nothing
--    could say WHICH search an article sits on page 3 for. One row per
--    (article, query), replaced by every daily pull with the newest 28-day
--    window; `period_end` says which window a row belongs to, and readers
--    keep only an article's newest window (a query that stopped appearing
--    keeps its old period_end and is read as gone, not as current).
--
-- 2. article_pushes: one row per push of an article stuck between positions
--    11 and 40: the main query, the 28-day baseline, the links added from
--    the site's best pages, the old and new meta title and description,
--    whether it was applied on the site or proposed to the customer, and the
--    after-values at +14 and +28 days. A skip is stored with its reason; a
--    measurement that cannot be made yet stays null ("not measured yet").

create table if not exists public.content_queries (
  article_id uuid not null references public.articles(id) on delete cascade,
  query text not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  business_id uuid references public.businesses(id) on delete cascade,
  period_start date not null,
  period_end date not null,
  impressions integer not null default 0,
  clicks integer not null default 0,
  -- Impression-weighted average position over the period, as Google reports it.
  position numeric,
  updated_at timestamptz not null default timezone('utc', now()),
  primary key (article_id, query)
);

create index if not exists content_queries_business_idx
  on public.content_queries (business_id, period_end);

create index if not exists content_queries_user_idx
  on public.content_queries (user_id);

alter table public.content_queries enable row level security;

create policy "Users can view their own content queries"
  on public.content_queries for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "Service role manages content queries"
  on public.content_queries for all to service_role using (true) with check (true);

create table if not exists public.article_pushes (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  business_id uuid not null references public.businesses(id) on delete cascade,
  article_id uuid not null references public.articles(id) on delete cascade,
  -- 'sweep' (the weekly cron, behind the site's opt-in) or 'on_demand' (push_article).
  origin text not null check (origin in ('sweep', 'on_demand')),
  -- selected: chosen, the job has not finished. proposed: stored for the
  -- customer to apply. applied: live on the site (by the platform, or marked
  -- by the customer). skipped: not pushed, `skip_reason` says why. failed:
  -- the job failed. dismissed: the customer declined the proposal.
  status text not null default 'selected'
    check (status in ('selected', 'proposed', 'applied', 'skipped', 'failed', 'dismissed')),
  skip_reason text,
  main_query text,
  query_impressions integer,
  query_clicks integer,
  query_position numeric,
  -- The 28-day baseline, ending on the newest settled Search Console day.
  before_start date,
  before_end date,
  before_position numeric,
  before_impressions integer,
  before_clicks integer,
  -- [{fromArticleId, fromUrl, fromTitle, anchor, mode, sentence, status, reason}]
  links jsonb not null default '[]'::jsonb,
  old_title text,
  new_title text,
  old_meta_description text,
  new_meta_description text,
  -- 'platform' (delivered as an update) or 'customer' (marked as applied).
  applied_by text check (applied_by in ('platform', 'customer')),
  applied_at timestamptz,
  -- {start, end, days, position, impressions, clicks, measuredAt}; null until measured.
  after_14 jsonb,
  after_28 jsonb,
  job_id uuid,
  detail jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists article_pushes_article_idx
  on public.article_pushes (article_id, created_at desc);

create index if not exists article_pushes_business_idx
  on public.article_pushes (business_id, created_at desc);

create index if not exists article_pushes_user_idx
  on public.article_pushes (user_id);

-- Owners read; the platform writes (the sweep, the job, and the customer's
-- "Mark as applied" / "Dismiss" through the service role, narrowed by the
-- verified site and user in lib/lifecycle/push-read.ts).
alter table public.article_pushes enable row level security;

create policy "Users can view their own article pushes"
  on public.article_pushes for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "Service role manages article pushes"
  on public.article_pushes for all to service_role using (true) with check (true);
