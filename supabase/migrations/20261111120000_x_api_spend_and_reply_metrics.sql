-- The official X API, pay-per-use, under a hard monthly cap
-- (docs/PLACEMENTS.md, "Fresh posts and reply numbers from the X API",
-- owner's decision of 2026-11-11).
--
-- Two uses: finding fresh posts in the site's niche once a day, and reading
-- the public numbers of the replies the person posted. Nothing here posts:
-- no write endpoint of X is ever called.
--
-- provider_spend: the durable ledger of what a paid provider cost, one row
-- per (provider, calendar month UTC). `month` is the first day of the
-- month. Every call reserves its worst case before it is made
-- (reserve_provider_spend) and is settled to its estimate after
-- (settle_provider_spend), so the cap holds even when two callers race: the
-- reservation is one conditional UPDATE, which Postgres serialises on the
-- row. The figures are estimates from the provider's published unit prices,
-- never an invoice. Written and read only by the service role (cron,
-- worker); RLS blocks everyone else.
--
-- placement_metrics: a dated snapshot of a posted reply's public numbers,
-- one row per (reply, UTC day). A number X did not return is null, never 0:
-- a row of nulls records "asked, and X gave nothing" (a deleted or
-- protected reply), which is itself the measurement. The owner reads their
-- own rows; the platform writes them.
--
-- Additive only: two new tables and two new functions, nothing dropped,
-- nothing revoked. The functions run with the caller's rights (security
-- invoker, the default), so for anyone but the service role RLS leaves
-- provider_spend empty and they change nothing.

create table if not exists public.provider_spend (
  provider text not null,
  month date not null check (extract(day from month) = 1),
  cost_usd numeric(10, 4) not null default 0 check (cost_usd >= 0),
  calls integer not null default 0 check (calls >= 0),
  posts integer not null default 0 check (posts >= 0),
  updated_at timestamptz not null default timezone('utc', now()),
  primary key (provider, month)
);

alter table public.provider_spend enable row level security;

create policy "Service role manages provider spend"
  on public.provider_spend for all to service_role using (true) with check (true);

comment on table public.provider_spend is
  'Estimated spend of a paid provider per calendar month (UTC), from its published unit prices: what the monthly cap is checked against. An estimate, not an invoice.';

-- Adds p_amount to the month's spend only if the total stays within p_cap.
-- Returns the new total, or null when the call would cross the cap.
create or replace function public.reserve_provider_spend(
  p_provider text,
  p_month date,
  p_amount numeric,
  p_cap numeric
) returns numeric
language plpgsql
set search_path = public
as $$
declare
  v_total numeric;
begin
  if p_amount < 0 then
    raise exception 'reserve_provider_spend: amount must not be negative';
  end if;

  insert into public.provider_spend (provider, month)
  values (p_provider, p_month)
  on conflict (provider, month) do nothing;

  update public.provider_spend
  set cost_usd = cost_usd + p_amount,
      updated_at = timezone('utc', now())
  where provider = p_provider
    and month = p_month
    and cost_usd + p_amount <= p_cap
  returning cost_usd into v_total;

  return v_total;
end;
$$;

-- After the call: gives back what the reservation over-estimated (a
-- negative p_adjust; never below zero) and counts the call and the posts.
create or replace function public.settle_provider_spend(
  p_provider text,
  p_month date,
  p_adjust numeric,
  p_calls integer,
  p_posts integer
) returns numeric
language plpgsql
set search_path = public
as $$
declare
  v_total numeric;
begin
  insert into public.provider_spend (provider, month)
  values (p_provider, p_month)
  on conflict (provider, month) do nothing;

  update public.provider_spend
  set cost_usd = greatest(0, cost_usd + p_adjust),
      calls = calls + greatest(0, p_calls),
      posts = posts + greatest(0, p_posts),
      updated_at = timezone('utc', now())
  where provider = p_provider
    and month = p_month
  returning cost_usd into v_total;

  return v_total;
end;
$$;

create table if not exists public.placement_metrics (
  target_id uuid not null references public.placement_targets(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  business_id uuid references public.businesses(id) on delete cascade,
  day date not null,
  impressions integer check (impressions is null or impressions >= 0),
  likes integer check (likes is null or likes >= 0),
  replies integer check (replies is null or replies >= 0),
  reposts integer check (reposts is null or reposts >= 0),
  quotes integer check (quotes is null or quotes >= 0),
  bookmarks integer check (bookmarks is null or bookmarks >= 0),
  fetched_at timestamptz not null default timezone('utc', now()),
  primary key (target_id, day)
);

create index if not exists placement_metrics_business_day_idx
  on public.placement_metrics (business_id, day desc);

alter table public.placement_metrics enable row level security;

create policy "Users can view their own reply metrics"
  on public.placement_metrics for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "Service role manages reply metrics"
  on public.placement_metrics for all to service_role using (true) with check (true);

comment on table public.placement_metrics is
  'Daily snapshot of a posted reply''s public numbers on X (impressions, likes, replies, reposts, quotes, bookmarks). Null: X did not return it, never a zero.';
