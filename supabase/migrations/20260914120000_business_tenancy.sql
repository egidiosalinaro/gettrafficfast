-- Business tenancy: the site-scoped half of the schema stops belonging to a
-- user and starts belonging to a business.
--
-- Why now: one account may run several sites (a product's own site among
-- them), and with the tenancy key on the user it can serve exactly
-- one. The blog on gettrafficfa.st is written by this product for itself, and
-- that is impossible while one account means one site.
--
-- Two decisions shape this migration, and both are deliberate:
--
-- 1. user_id STAYS on every table, and so does every RLS policy. The isolation
--    guarantee that already works is not rewritten while data is live; the new
--    column adds a second, narrower scope that the application filters on. A
--    row therefore always answers both "whose is it" and "which site is it".
--
-- 2. business_id is NULLABLE. Rows exist today that belong to no business at
--    all — a signup that searched keywords and never configured a site is a
--    documented case (docs/ONBOARDING_EMAILS.md). Making the column NOT NULL
--    would mean either inventing a business for those rows or deleting them,
--    and both are worse than an honest null: the app simply never shows a row
--    that belongs to no site. Tightening to NOT NULL is a later migration,
--    after the orphans are looked at by a human.
--
-- Billing is untouched: subscriptions stay per account, because the price is
-- still one plan per customer. Quantity-per-business is a separate decision
-- that belongs with Stripe, not here. notification_log stays per user too: a
-- welcome email is sent to a person, not to a website.

-- ── The tenant itself ───────────────────────────────────────────────────────
-- website_url was globally unique, which is how "one business per account" was
-- really enforced. That rule has to survive per user (the same person must not
-- register the same site twice) while allowing two different people to work on
-- the same domain — an agency and its client is a normal case, not a conflict.
-- The table was created outside migrations, so the constraint name was read
-- from the catalogue rather than assumed: businesses_website_url_key.
alter table public.businesses drop constraint if exists businesses_website_url_key;
drop index if exists public.businesses_website_url_key;

create unique index if not exists businesses_user_website_key
  on public.businesses (user_id, website_url);

create index if not exists businesses_user_created_idx
  on public.businesses (user_id, created_at);

-- ── The site-scoped tables ──────────────────────────────────────────────────
-- Everything that describes a website rather than a person. The backfill is
-- unambiguous today precisely because every account has at most one business:
-- this is the last moment at which it is.
do $$
declare
  t text;
  site_tables text[] := array[
    'articles', 'keywords', 'integrations', 'publish_attempts', 'jobs',
    'agent_runs', 'article_events', 'media_assets', 'entities', 'topics',
    'article_links', 'serp_snapshots', 'competitors', 'content_metrics',
    'article_versions', 'ai_citations', 'analytics_connections',
    'placement_targets'
  ];
begin
  foreach t in array site_tables loop
    -- Skip anything this database does not have: the list is the intent, the
    -- catalogue is the truth.
    if not exists (
      select 1 from information_schema.tables
      where table_schema = 'public' and table_name = t
    ) then
      continue;
    end if;

    execute format(
      'alter table public.%I add column if not exists business_id uuid references public.businesses(id) on delete cascade',
      t
    );

    if exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = t and column_name = 'user_id'
    ) then
      execute format(
        'update public.%I x set business_id = b.id from public.businesses b '
        || 'where b.user_id = x.user_id and x.business_id is null',
        t
      );
    end if;

    execute format(
      'create index if not exists %I on public.%I (business_id)',
      t || '_business_idx', t
    );
  end loop;
end $$;

-- ── The uniques that used to say "one site per account" ─────────────────────
-- Each of these would reject the second business's first row. NULLs are
-- distinct in a unique constraint, so rows that belong to no business simply
-- do not collide.

alter table public.entities drop constraint if exists entities_user_id_type_canonical_name_key;
alter table public.entities drop constraint if exists entities_business_id_type_canonical_name_key;
alter table public.entities
  add constraint entities_business_id_type_canonical_name_key
  unique (business_id, type, canonical_name);

alter table public.topics drop constraint if exists topics_user_id_slug_key;
alter table public.topics drop constraint if exists topics_business_id_slug_key;
alter table public.topics
  add constraint topics_business_id_slug_key unique (business_id, slug);

alter table public.competitors drop constraint if exists competitors_user_id_domain_key;
alter table public.competitors drop constraint if exists competitors_business_id_domain_key;
alter table public.competitors
  add constraint competitors_business_id_domain_key unique (business_id, domain);

alter table public.placement_targets
  drop constraint if exists placement_targets_user_id_surface_external_id_key;
alter table public.placement_targets
  drop constraint if exists placement_targets_business_id_surface_external_id_key;
alter table public.placement_targets
  add constraint placement_targets_business_id_surface_external_id_key
  unique (business_id, surface, external_id);

-- The same keyword can matter to two sites of the same account, and on this
-- account it already does: "ai seo" is as relevant to gettrafficfa.st as to
-- anything else it writes about.
alter table public.keywords drop constraint if exists keywords_user_id_keyword_key;
alter table public.keywords drop constraint if exists keywords_business_id_keyword_key;
alter table public.keywords
  add constraint keywords_business_id_keyword_key unique (business_id, keyword);

alter table public.integrations drop constraint if exists integrations_user_id_type_key;
alter table public.integrations drop constraint if exists integrations_business_id_type_key;
alter table public.integrations
  add constraint integrations_business_id_type_key unique (business_id, type);

alter table public.analytics_connections
  drop constraint if exists analytics_connections_user_id_provider_key;
alter table public.analytics_connections
  drop constraint if exists analytics_connections_business_id_provider_key;
alter table public.analytics_connections
  add constraint analytics_connections_business_id_provider_key
  unique (business_id, provider);

-- One article per DAY per SITE, not per account: two businesses publishing on
-- the same date is the entire point of this migration. Deferrable for the same
-- reason as before — move_article() swaps two rows' dates in one statement.
alter table public.articles drop constraint if exists articles_user_id_scheduled_date_key;
alter table public.articles drop constraint if exists articles_business_id_scheduled_date_key;
alter table public.articles
  add constraint articles_business_id_scheduled_date_key
  unique (business_id, scheduled_date) deferrable initially immediate;

-- ── The calendar swap, per business ─────────────────────────────────────────
-- Same function as before; the occupant of the target day is now looked up
-- within the article's own business. `is not distinct from` keeps it correct
-- for rows that belong to no business: those collide only with each other.
create or replace function public.move_article(
  p_article_id uuid,
  p_target_date date
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_business uuid;
  v_current_date date;
  v_occupant uuid;
begin
  select scheduled_date, business_id into v_current_date, v_business
  from public.articles
  where id = p_article_id and user_id = v_uid;

  if v_current_date is null then
    raise exception 'Article not found';
  end if;

  if v_current_date = p_target_date then
    return;
  end if;

  select id into v_occupant
  from public.articles
  where user_id = v_uid
    and business_id is not distinct from v_business
    and scheduled_date = p_target_date
    and id <> p_article_id;

  if v_occupant is null then
    update public.articles
    set scheduled_date = p_target_date,
        updated_at = timezone('utc', now())
    where id = p_article_id and user_id = v_uid;
  else
    -- Defer the unique check so the two rows can swap dates in one statement.
    set constraints all deferred;
    update public.articles
    set scheduled_date = case
          when id = p_article_id then p_target_date
          when id = v_occupant then v_current_date
        end,
        updated_at = timezone('utc', now())
    where id in (p_article_id, v_occupant) and user_id = v_uid;
  end if;
end;
$$;

-- ── The product as a destination for itself ─────────────────────────────────
-- 'self' publishes to gettrafficfa.st's own blog, which reads straight from
-- the articles table (docs/BLOG.md). It is an integration like any other so
-- that the pipeline has nothing special-cased in it: the same cron, the same
-- publish attempt log, the same failure handling.
alter table public.integrations drop constraint if exists integrations_type_check;
alter table public.integrations
  add constraint integrations_type_check
  check (type in ('wordpress', 'webflow', 'shopify', 'webhook', 'self'));
