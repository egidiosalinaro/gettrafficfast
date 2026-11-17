-- account_limits: the per-account daily AI spend ceiling a person sets in
-- Settings → Billing (docs/API.md "Account limits", lib/limits/spend.ts).
--
-- One row per account, only when the person changed the ceiling: without a
-- row the account is held to ACCOUNT_DAILY_SPEND_USD, else $5. The ceiling
-- is compared with the model cost the account's agent runs recorded over a
-- rolling 24 hours (agent_runs.cost_usd, a null cost counted at an
-- estimate); at or above it every paid action is refused and paid jobs wait.
--
-- The person writes their own row (RLS), so the bound is enforced here, not
-- only in the form: between $1 and $100, to the cent. The screen asks for a
-- second tap before raising it; a direct write can only move it within the
-- same bounds, and only for the writer's own account.

create table if not exists public.account_limits (
  user_id uuid primary key references auth.users(id) on delete cascade,
  daily_spend_usd numeric(6, 2) not null
    check (daily_spend_usd >= 1 and daily_spend_usd <= 100),
  updated_at timestamptz not null default timezone('utc', now())
);

alter table public.account_limits enable row level security;

create policy "Users can view their own account limits"
  on public.account_limits for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "Users can set their own account limits"
  on public.account_limits for insert to authenticated
  with check ((select auth.uid()) = user_id);

create policy "Users can change their own account limits"
  on public.account_limits for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "Service role manages account limits"
  on public.account_limits for all to service_role using (true) with check (true);

comment on table public.account_limits is
  'Per-account limits set in Settings → Billing. daily_spend_usd: the daily AI spend ceiling, $1 to $100; no row means ACCOUNT_DAILY_SPEND_USD, else $5.';
