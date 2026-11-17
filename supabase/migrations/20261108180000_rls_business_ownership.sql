-- RLS: a row a user writes must name a business that user owns.
--
-- The insert/update policies on integrations, aeo_queries and
-- placement_targets checked only `user_id = auth.uid()`. That proves who owns
-- the row, not which site it is about: an authenticated client could write
-- its own row carrying ANOTHER account's business_id. Readers that select by
-- business_id through the service role (publish, cron, the job worker) would
-- then pick that row up as the other business's destination, query or target.
--
-- Each policy is recreated by name with the same user check plus an
-- ownership check on business_id. `using` is unchanged (a user still sees and
-- updates only rows they own); `with check` is what the row may become.
-- A null business_id fails the check: no client write creates a row that
-- belongs to no site. Service-role policies are untouched.

-- ── integrations ────────────────────────────────────────────────────────────
drop policy if exists "Users can insert their own integrations" on public.integrations;
create policy "Users can insert their own integrations"
  on public.integrations for insert to authenticated
  with check (
    (select auth.uid()) = user_id
    and exists (
      select 1 from public.businesses b
      where b.id = business_id and b.user_id = (select auth.uid())
    )
  );

drop policy if exists "Users can update their own integrations" on public.integrations;
create policy "Users can update their own integrations"
  on public.integrations for update to authenticated
  using ((select auth.uid()) = user_id)
  with check (
    (select auth.uid()) = user_id
    and exists (
      select 1 from public.businesses b
      where b.id = business_id and b.user_id = (select auth.uid())
    )
  );

-- ── aeo_queries ─────────────────────────────────────────────────────────────
drop policy if exists "Users can add their own AEO queries" on public.aeo_queries;
create policy "Users can add their own AEO queries"
  on public.aeo_queries for insert to authenticated
  with check (
    (select auth.uid()) = user_id
    and exists (
      select 1 from public.businesses b
      where b.id = business_id and b.user_id = (select auth.uid())
    )
  );

drop policy if exists "Users can update their own AEO queries" on public.aeo_queries;
create policy "Users can update their own AEO queries"
  on public.aeo_queries for update to authenticated
  using ((select auth.uid()) = user_id)
  with check (
    (select auth.uid()) = user_id
    and exists (
      select 1 from public.businesses b
      where b.id = business_id and b.user_id = (select auth.uid())
    )
  );

-- ── placement_targets ───────────────────────────────────────────────────────
-- Users have no insert policy here (the platform writes targets through the
-- service role); only the owner's update is recreated.
drop policy if exists "Users can update their own placement targets" on public.placement_targets;
create policy "Users can update their own placement targets"
  on public.placement_targets for update to authenticated
  using ((select auth.uid()) = user_id)
  with check (
    (select auth.uid()) = user_id
    and exists (
      select 1 from public.businesses b
      where b.id = business_id and b.user_id = (select auth.uid())
    )
  );
