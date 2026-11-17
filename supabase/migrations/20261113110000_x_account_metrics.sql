-- The public numbers of a site's own X account, read once a day
-- (docs/PLACEMENTS.md, "Followers of the site's own account", 2026-11-13).
--
-- The daily X run (`/api/cron/x-posts`, lib/placements/x-account.ts) looks
-- up the account the site's replies are posted from (the handle its saved
-- reply links carry, lib/placements/x-handle.ts) with
-- `GET /2/users/by/username/:username?user.fields=public_metrics`, under
-- the same opt-in and the same monthly cap as every X call, and stores one
-- dated snapshot per site and UTC day. Results → Replies on X shows the
-- followers now and the change over 7 days when both ends were read.
--
-- A number X did not return is null, never 0. A handle X answered with no
-- account for (renamed, suspended) gets a row of nulls: "asked, and X gave
-- nothing" is the measurement, and a missing row would read as "never
-- asked". Profile visits are not in X's public numbers and are not stored.
--
-- The owner reads their own rows; the platform (service role) writes them.
-- Additive only: one new table, nothing dropped, nothing revoked.

create table if not exists public.x_account_metrics (
  business_id uuid not null references public.businesses(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  day date not null,
  handle text not null check (handle ~ '^[A-Za-z0-9_]{1,15}$'),
  followers integer check (followers is null or followers >= 0),
  following integer check (following is null or following >= 0),
  posts integer check (posts is null or posts >= 0),
  listed integer check (listed is null or listed >= 0),
  fetched_at timestamptz not null default timezone('utc', now()),
  primary key (business_id, day)
);

alter table public.x_account_metrics enable row level security;

create policy "Users can view their own X account metrics"
  on public.x_account_metrics for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "Service role manages X account metrics"
  on public.x_account_metrics for all to service_role using (true) with check (true);

comment on table public.x_account_metrics is
  'Daily snapshot of the public numbers of a site''s own X account (followers, following, posts, listed). Null: X did not return it, never a zero.';
