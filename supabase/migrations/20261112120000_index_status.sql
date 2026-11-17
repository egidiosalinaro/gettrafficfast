-- Indexing status (docs/ANALYTICS.md, "Indexing status"): what Google's URL
-- Inspection said about each URL of a site, the latest answer per URL.
--
-- Search Analytics tells us how a page performed; it says nothing about a page
-- Google never indexed, because such a page has no rows at all. On 2026-11-12
-- Search Console emailed the owner "Page with redirect" and the platform could
-- not say which page or why. This table is that answer, per URL.
--
-- One row per (business, url): the latest inspection. No history table yet.
-- A URL that was never inspected has NO row, which reads as "not checked",
-- never as "not indexed": counts are made from the rows that exist.
--
-- Additive only: a new table, its index and its policies. No drop.

create table if not exists public.index_status (
  business_id uuid not null references public.businesses(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  url text not null,
  -- The published article the URL belongs to, when it is one of ours.
  article_id uuid references public.articles(id) on delete set null,
  checked_at timestamptz not null default timezone('utc', now()),
  -- Google's verdict: PASS, PARTIAL, FAIL, NEUTRAL, VERDICT_UNSPECIFIED.
  verdict text not null,
  -- Google's own sentence, e.g. "Page with redirect", "Submitted and indexed".
  coverage_state text,
  indexing_state text,
  robots_state text,
  fetch_state text,
  google_canonical text,
  user_canonical text,
  last_crawl_at timestamptz,
  -- The whole inspectionResult as Google sent it, for diagnosis.
  raw jsonb,
  primary key (business_id, url)
);

create index if not exists index_status_user_idx
  on public.index_status (user_id);

create index if not exists index_status_business_checked_idx
  on public.index_status (business_id, checked_at);

create index if not exists index_status_article_idx
  on public.index_status (article_id);

-- ── RLS: owners read, the platform writes ───────────────────────────────────
-- Rows are written by the daily sweep and by "Check now" through the service
-- role, narrowed by the verified site and user (lib/analytics/index-status.ts).
-- An owner reads their own rows; no client writes them.
alter table public.index_status enable row level security;

create policy "Users can view their own index status"
  on public.index_status for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "Service role manages index status"
  on public.index_status for all to service_role using (true) with check (true);
