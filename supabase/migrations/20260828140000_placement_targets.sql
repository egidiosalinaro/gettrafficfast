-- Off-site placement, step 1 of Phase 7 (docs/PLACEMENTS.md): the public
-- conversations where a customer could be the answer.
--
-- The product optimises a customer's own site to be citable and measures
-- whether answer engines cite it, but plants nothing where those engines
-- actually read. This table is the first half of closing that gap: what we
-- found. What we say about it comes in a later slice.
--
-- Discovery only. Nothing here posts anything: publishing on a third party's
-- thread stays a human action.

create table if not exists public.placement_targets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  -- Which platform: reddit today, more later. Kept as text rather than an enum
  -- so a new surface is a provider file, not a migration.
  surface text not null,
  -- The platform's own id. Together with the surface it is what stops the same
  -- thread being stored again every time the sweep runs.
  external_id text not null,
  url text not null,
  title text not null,
  excerpt text,
  -- Where inside the surface: a subreddit, a tag, a repository.
  community text,
  -- The query that found it, so a useless query can be recognised later.
  found_for text,
  posted_at timestamptz,
  score integer,
  comment_count integer,
  -- discovered: found, not yet judged. The later slices add qualified,
  -- rejected and drafted; the check grows with them.
  status text not null default 'discovered'
    check (status in ('discovered', 'qualified', 'rejected')),
  created_at timestamptz not null default timezone('utc', now()),
  unique (user_id, surface, external_id)
);

create index if not exists placement_targets_user_idx
  on public.placement_targets (user_id, status, posted_at desc);

-- RLS: owners read, the platform writes
alter table public.placement_targets enable row level security;

create policy "Users can view their own placement targets"
  on public.placement_targets for select to authenticated
  using (auth.uid() = user_id);

create policy "Service role manages placement targets"
  on public.placement_targets for all to service_role using (true) with check (true);
