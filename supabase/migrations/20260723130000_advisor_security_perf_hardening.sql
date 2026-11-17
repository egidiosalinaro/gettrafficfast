-- Hardening pass driven by the Supabase database advisors (security + performance).
--
-- 1. SECURITY: the three "set updated_at" trigger functions had a role-mutable
--    search_path (lint 0011_function_search_path_mutable). Pin it to empty so
--    they can't be hijacked by a shadowed object; now()/timezone() still resolve
--    from pg_catalog, which is always implicitly on the path.
--
-- 2. PERFORMANCE: two foreign keys had no covering index
--    (lint 0001_unindexed_foreign_keys): keywords.article_id and
--    publish_attempts.integration_id.
--
-- 3. PERFORMANCE: every per-user RLS policy called auth.uid()/auth.role()
--    directly, so Postgres re-evaluated it once per row
--    (lint 0003_auth_rls_initplan). Wrapping the call in a scalar subquery
--    "(select auth.uid())" lets the planner evaluate it once per statement.
--    Semantics are unchanged. While recreating the subscriptions service-role
--    policy we also scope it to the service_role role instead of public, which
--    additionally clears lint 0006_multiple_permissive_policies.

-- 1. Pin function search_path -------------------------------------------------

create or replace function public.update_updated_at_column()
  returns trigger
  language plpgsql
  set search_path = ''
as $$
begin
  new.updated_at = timezone('utc'::text, now());
  return new;
end;
$$;

create or replace function public.update_keywords_updated_at()
  returns trigger
  language plpgsql
  set search_path = ''
as $$
begin
  new.updated_at = timezone('utc'::text, now());
  return new;
end;
$$;

create or replace function public.update_articles_updated_at()
  returns trigger
  language plpgsql
  set search_path = ''
as $$
begin
  new.updated_at = timezone('utc'::text, now());
  return new;
end;
$$;

-- 2. Covering indexes for foreign keys ---------------------------------------

create index if not exists keywords_article_id_idx
  on public.keywords (article_id);

create index if not exists publish_attempts_integration_id_idx
  on public.publish_attempts (integration_id);

-- 3. RLS policies: evaluate auth.*() once per statement ----------------------

-- articles
drop policy if exists "Users can view their own articles" on public.articles;
create policy "Users can view their own articles"
  on public.articles for select to public
  using ((select auth.uid()) = user_id);

drop policy if exists "Users can insert their own articles" on public.articles;
create policy "Users can insert their own articles"
  on public.articles for insert to public
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users can update their own articles" on public.articles;
create policy "Users can update their own articles"
  on public.articles for update to public
  using ((select auth.uid()) = user_id);

drop policy if exists "Users can delete their own articles" on public.articles;
create policy "Users can delete their own articles"
  on public.articles for delete to public
  using ((select auth.uid()) = user_id);

-- businesses
drop policy if exists "Users can view their own business" on public.businesses;
create policy "Users can view their own business"
  on public.businesses for select to public
  using ((select auth.uid()) = user_id);

drop policy if exists "Users can insert their own business" on public.businesses;
create policy "Users can insert their own business"
  on public.businesses for insert to public
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users can update their own business" on public.businesses;
create policy "Users can update their own business"
  on public.businesses for update to public
  using ((select auth.uid()) = user_id);

-- keywords
drop policy if exists "Users can view their own keywords" on public.keywords;
create policy "Users can view their own keywords"
  on public.keywords for select to public
  using ((select auth.uid()) = user_id);

drop policy if exists "Users can insert their own keywords" on public.keywords;
create policy "Users can insert their own keywords"
  on public.keywords for insert to public
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users can update their own keywords" on public.keywords;
create policy "Users can update their own keywords"
  on public.keywords for update to public
  using ((select auth.uid()) = user_id);

drop policy if exists "Users can delete their own keywords" on public.keywords;
create policy "Users can delete their own keywords"
  on public.keywords for delete to public
  using ((select auth.uid()) = user_id);

-- integrations (authenticated role)
drop policy if exists "Users can view their own integrations" on public.integrations;
create policy "Users can view their own integrations"
  on public.integrations for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "Users can insert their own integrations" on public.integrations;
create policy "Users can insert their own integrations"
  on public.integrations for insert to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users can update their own integrations" on public.integrations;
create policy "Users can update their own integrations"
  on public.integrations for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users can delete their own integrations" on public.integrations;
create policy "Users can delete their own integrations"
  on public.integrations for delete to authenticated
  using ((select auth.uid()) = user_id);

-- publish_attempts (authenticated role)
drop policy if exists "Users can view their own publish attempts" on public.publish_attempts;
create policy "Users can view their own publish attempts"
  on public.publish_attempts for select to authenticated
  using ((select auth.uid()) = user_id);

-- subscriptions
drop policy if exists "Users can view their own subscriptions" on public.subscriptions;
create policy "Users can view their own subscriptions"
  on public.subscriptions for select to public
  using ((select auth.uid()) = user_id);

-- Scope the service-role policy to the service_role role. This removes the
-- auth.role() per-row call and stops it overlapping the user SELECT policy for
-- the anon/authenticated roles (multiple permissive policies warning).
drop policy if exists "Service role can manage all subscriptions" on public.subscriptions;
create policy "Service role can manage all subscriptions"
  on public.subscriptions for all to service_role
  using (true) with check (true);
