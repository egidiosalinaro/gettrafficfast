-- Intelligence layer (architecture Phase 4): what Google actually shows.
--
-- serp_snapshots records the SERP for a keyword at a point in time — the raw
-- provider payload, kept verbatim, plus the platform's analysis of it. Over
-- time this becomes rank tracking for free: the history is already there.
--
-- competitors records domains that keep appearing in the SERPs for this
-- user's keywords. Discovered automatically at production time; the gap
-- analysis of the architecture reads this table.

create table if not exists public.serp_snapshots (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  keyword_id uuid not null references public.keywords(id) on delete cascade,
  provider text not null,
  -- Raw provider payload, verbatim — never reshaped, so nothing is lost.
  results jsonb not null,
  -- The serp-analysis agent's reading of it (intent, difficulty, angle, gaps).
  analysis jsonb,
  captured_at timestamptz not null default timezone('utc', now())
);

create index if not exists serp_snapshots_keyword_idx
  on public.serp_snapshots (keyword_id, captured_at desc);
create index if not exists serp_snapshots_user_idx
  on public.serp_snapshots (user_id, captured_at desc);

create table if not exists public.competitors (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  domain text not null,
  name text not null,
  -- How the row got here: discovered in a SERP, or added by the user later.
  source text not null default 'serp' check (source in ('serp', 'manual')),
  first_seen_at timestamptz not null default timezone('utc', now()),
  last_seen_at timestamptz not null default timezone('utc', now()),
  unique (user_id, domain)
);

create index if not exists competitors_user_idx on public.competitors (user_id);

-- ── RLS: owners read, the platform writes ───────────────────────────────────
alter table public.serp_snapshots enable row level security;
alter table public.competitors enable row level security;

create policy "Users can view their own serp snapshots"
  on public.serp_snapshots for select to authenticated
  using (auth.uid() = user_id);

create policy "Service role manages serp snapshots"
  on public.serp_snapshots for all to service_role using (true) with check (true);

create policy "Users can view their own competitors"
  on public.competitors for select to authenticated
  using (auth.uid() = user_id);

create policy "Service role manages competitors"
  on public.competitors for all to service_role using (true) with check (true);
