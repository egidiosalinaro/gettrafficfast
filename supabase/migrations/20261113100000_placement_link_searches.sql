-- The link of a reply the person posted on X, found by GTF
-- (docs/PLACEMENTS.md, "The link of your reply, found on X", 2026-11-13).
--
-- After "I posted it" GTF searches X (recent search, metered under the
-- monthly X cap) for the person's own reply in that thread, a few times
-- (2 min, 15 min, 2 h, 12 h after the tap; at most six with
-- find_reply_link), and saves its link through the same path a pasted link
-- takes, only when it is surely their reply. This table is the record of
-- that search, one row per posted reply:
--
--   attempts         searches made (the claim is taken before X is asked,
--                    so a search that dies half-way still counts);
--   last_attempt_at  when the last one was made;
--   outcome          how it ended: searching, found, not_found,
--                    other_replies, ambiguous, error, not_saved;
--   posts_seen       posts X returned over every attempt (what was billed);
--   found_url        the link GTF found and saved, kept even when the person
--                    replaces it: the reply's link is "found on X" only while
--                    published_url is this one;
--   found_at         when.
--
-- Apart from placement_targets on purpose: a person may update their own
-- target rows (RLS), and the attempts bound what GTF spends, so they must not
-- be writable by the person. The owner reads their own rows; only the
-- platform writes. A negative result is a row too: "searched, not found"
-- is recorded, never left as a missing row.
--
-- Also one partial index for the 5-minute sweep: posted replies with no link
-- yet, newest first.
--
-- Additive only: one new table, one new index, nothing dropped, nothing
-- revoked.

create table if not exists public.placement_link_searches (
  target_id uuid primary key references public.placement_targets(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  business_id uuid references public.businesses(id) on delete cascade,
  attempts smallint not null default 0 check (attempts >= 0),
  last_attempt_at timestamptz,
  outcome text,
  posts_seen integer not null default 0 check (posts_seen >= 0),
  found_url text,
  found_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists placement_link_searches_business_idx
  on public.placement_link_searches (business_id);

alter table public.placement_link_searches enable row level security;

create policy "Users can view their own reply link searches"
  on public.placement_link_searches for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "Service role manages reply link searches"
  on public.placement_link_searches for all to service_role using (true) with check (true);

comment on table public.placement_link_searches is
  'GTF''s search on X for the link of a posted reply: attempts, the last outcome, posts billed, and the link found. The owner reads; the platform writes.';

create index if not exists placement_targets_posted_without_link_idx
  on public.placement_targets (published_at desc)
  where status = 'published_manually' and published_url is null;
