-- subscriptions.source: where a plan comes from (docs/API.md "The reviewer
-- account").
--
-- Every row so far is Stripe's: the webhook writes it, keyed on
-- stripe_subscription_id. The MCP directory reviewers (Anthropic, OpenAI)
-- need a permanent account with a live plan and no card, so a plan can now
-- also be complimentary: a row the platform owner grants (POST
-- /api/owner/reviewer-account, service role, after the owner check), with no
-- Stripe ids. `hasActiveSubscription` reads it like any other row (status
-- active, no period end); the Billing page reads `source` to say
-- "Complimentary" and not offer a billing portal there is nothing in.
--
-- Additive and confirmation-free: one column with a default (every existing
-- row is 'stripe'), two checks. No drop. RLS is unchanged and stays on: the
-- customer reads his own rows and writes none, so nobody grants himself a
-- comp plan.

alter table public.subscriptions
  add column if not exists source text not null default 'stripe'
    constraint subscriptions_source_check check (source in ('stripe', 'comp'));

-- A complimentary plan is not a Stripe subscription: it carries no Stripe id,
-- so the webhook (which upserts on stripe_subscription_id) can never land on it.
alter table public.subscriptions
  add constraint subscriptions_comp_has_no_stripe_ids
    check (source = 'stripe' or (stripe_subscription_id is null and stripe_customer_id is null));

comment on column public.subscriptions.source is
  'stripe: written by the Stripe webhook. comp: a complimentary plan granted by the platform owner (the directory reviewers'' account), no Stripe ids.';
