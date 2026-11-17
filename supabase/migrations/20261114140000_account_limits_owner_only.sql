-- account_limits: the daily AI spend ceiling is the platform owner's to set,
-- no longer the customer's (the owner's decision, 2026-11-13; docs/API.md
-- "Account limits" and "The owner's costs").
--
-- Until now RLS let a signed-in person insert and update their own row, so a
-- customer could raise his own ceiling with a direct write. The ceiling
-- protects the platform's model credits: a customer, a bug or a leaked key
-- must not be able to lift it. From here the only writer is the service role,
-- used by POST /api/owner/spend-limit after the platform-owner check
-- (lib/owner.ts, PLATFORM_OWNER_USER_IDS). The person still reads his own row
-- (the guard counts against it through his client); he never sees it in
-- dollars.
--
-- Additive and confirmation-free: the two write policies are altered to admit
-- nothing (with check false, using false) and renamed to say so. No drop. In
-- production the table held 0 rows when this was written, so no customer-set
-- ceiling is left behind.

alter policy "Users can set their own account limits"
  on public.account_limits
  with check (false);

alter policy "Users can set their own account limits"
  on public.account_limits
  rename to "Customers cannot set account limits";

alter policy "Users can change their own account limits"
  on public.account_limits
  using (false)
  with check (false);

alter policy "Users can change their own account limits"
  on public.account_limits
  rename to "Customers cannot change account limits";

comment on table public.account_limits is
  'Per-account daily AI spend ceiling, set by a platform owner on /settings/costs (service role only). daily_spend_usd: $1 to $100; no row means ACCOUNT_DAILY_SPEND_USD, else $5. Customers read their own row and never write it.';
