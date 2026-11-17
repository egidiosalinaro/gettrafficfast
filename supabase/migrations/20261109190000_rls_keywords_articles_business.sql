-- RLS: a keyword or an article a user writes must name a business that user owns.
--
-- 20261108180000_rls_business_ownership.sql closed this for integrations,
-- aeo_queries and placement_targets. keywords and articles were left with the
-- insert/update checks of 20260723130000_advisor_security_perf_hardening.sql,
-- which prove only `user_id = auth.uid()`: who owns the row, not which site it
-- is about. An authenticated client could insert or update its own keyword or
-- article carrying ANOTHER account's business_id, and every reader that selects
-- by business_id through the service role (the generation cron, autopilot,
-- publishing, the job worker) would then treat it as that business's row.
--
-- Each policy is altered in place by its exact name (no drop, no recreate), so
-- this applies without a confirmation prompt and is safe to run twice.
-- `using` is restated unchanged on the update policies (a user still sees and
-- updates only rows they own); `with check` is what the row may become.
--
-- A null business_id fails the check: no client write creates or leaves a row
-- that belongs to no site. `with check` judges only rows being written, so the
-- rows that exist are untouched. Production on 2026-11-09: 0 articles and 0
-- keywords name a business their owner does not own; 0 articles and 20
-- keywords have no business at all, every one of them `available`, linked to
-- no article and never updated since 2026-05-23, all of one account that has
-- no business (docs/MULTI_BUSINESS.md). No app path writes those rows: every
-- client write to keywords and articles is scoped to the selected business.
-- Delete policies and the service-role policies are untouched.

-- ── keywords ────────────────────────────────────────────────────────────────
alter policy "Users can insert their own keywords" on public.keywords
  with check (
    (select auth.uid()) = user_id
    and exists (
      select 1 from public.businesses b
      where b.id = keywords.business_id and b.user_id = (select auth.uid())
    )
  );

alter policy "Users can update their own keywords" on public.keywords
  using ((select auth.uid()) = user_id)
  with check (
    (select auth.uid()) = user_id
    and exists (
      select 1 from public.businesses b
      where b.id = keywords.business_id and b.user_id = (select auth.uid())
    )
  );

-- ── articles ────────────────────────────────────────────────────────────────
alter policy "Users can insert their own articles" on public.articles
  with check (
    (select auth.uid()) = user_id
    and exists (
      select 1 from public.businesses b
      where b.id = articles.business_id and b.user_id = (select auth.uid())
    )
  );

alter policy "Users can update their own articles" on public.articles
  using ((select auth.uid()) = user_id)
  with check (
    (select auth.uid()) = user_id
    and exists (
      select 1 from public.businesses b
      where b.id = articles.business_id and b.user_id = (select auth.uid())
    )
  );
