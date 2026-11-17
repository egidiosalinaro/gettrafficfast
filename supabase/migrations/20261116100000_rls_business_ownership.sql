-- RLS: the last two client write policies that did not check business ownership.
--
-- 20261108180000 (integrations, aeo_queries, placement_targets) and
-- 20261109190000 (keywords, articles) made every owner write to a table with
-- business_id prove that the business belongs to the writer. A read of
-- pg_policies on 2026-11-16 found two update policies still checking only
-- `user_id = auth.uid()`:
--
--   * placements, "Users can edit their own placements": an authenticated
--     client could move its own placement onto ANOTHER account's business_id,
--     and every service-role reader that selects placements by business would
--     then treat it as that business's. business_id is NOT NULL here, so the
--     check requires an owned business.
--   * api_keys, "Users can revoke their own API keys": the api_keys_guard
--     trigger already refuses any change to business_id, so this is defence in
--     depth; the check is written exactly like the insert policy's (a key with
--     no business is an account-wide key, so null stays allowed).
--
-- Each policy is altered in place by its exact name (no drop), so this applies
-- without a confirmation prompt and is safe to run twice. `using` is restated
-- unchanged (a user still sees and updates only rows they own); `with check`
-- is what the row may become, and judges only rows being written. Production
-- on 2026-11-16: 101 placements, 0 of them on a business their owner does not
-- own; 0 API keys. The service-role policies are untouched.

-- ── placements ──────────────────────────────────────────────────────────────
alter policy "Users can edit their own placements" on public.placements
  using ((select auth.uid()) = user_id)
  with check (
    (select auth.uid()) = user_id
    and exists (
      select 1 from public.businesses b
      where b.id = placements.business_id and b.user_id = (select auth.uid())
    )
  );

-- ── api_keys ────────────────────────────────────────────────────────────────
alter policy "Users can revoke their own API keys" on public.api_keys
  using ((select auth.uid()) = user_id)
  with check (
    (select auth.uid()) = user_id
    and (
      business_id is null
      or exists (
        select 1 from public.businesses b
        where b.id = api_keys.business_id and b.user_id = (select auth.uid())
      )
    )
  );
