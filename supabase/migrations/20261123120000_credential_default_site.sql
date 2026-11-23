-- The default site of a connection: which site an API key or a connected app
-- acts on when a call names none.
--
-- A key or a grant for every site acted on the account's oldest site unless a
-- call named another (the `site` argument, or `x-gtf-business`). A person who
-- mostly works on one of their other sites had to name it in every request.
-- They can now save a default on the credential itself: by asking the agent
-- (the `set_default_site` tool) or in Settings → Claude and API. Resolution
-- (lib/api-auth.ts `chooseBusiness`): the header or the `site` argument when
-- a call names one; else this default, while it is still a site of the
-- account; else the oldest site, as before.
--
-- api_keys.default_business_id: the key's default. oauth_tokens.default_business_id:
-- the grant's default, written on every row of the family (one consent) and
-- carried over to each row a refresh mints (lib/oauth/tokens.ts).
--
-- Null means "no default saved": the oldest site. It sets null when the site
-- is deleted, rather than cascading: losing a default must never delete the
-- credential, and the oldest site is the fall-back the code already applies.
-- A credential limited to one site keeps its own business_id, which always
-- wins; the default may only name that same site.
--
-- A trigger keeps the default one of the owner's own sites (the RLS update
-- policy on api_keys lets the owner write the column; this is the check the
-- policy does not make), and, for a one-site credential, that site. The
-- existing guards (api_keys_guard, oauth_tokens_guard) do not list the column,
-- so it may change after creation; nothing else they protect changes.
--
-- Additive only: new nullable columns, partial indexes, a new function and
-- new triggers. No policy changes, nothing dropped.

alter table public.api_keys
  add column if not exists default_business_id uuid references public.businesses(id) on delete set null;

alter table public.oauth_tokens
  add column if not exists default_business_id uuid references public.businesses(id) on delete set null;

-- So deleting a site does not scan either table to set its defaults null.
create index if not exists api_keys_default_business_idx
  on public.api_keys (default_business_id)
  where default_business_id is not null;
create index if not exists oauth_tokens_default_business_idx
  on public.oauth_tokens (default_business_id)
  where default_business_id is not null;

-- The default is a site of the row's owner, and of the credential's one site
-- when it is limited to one.
create or replace function public.credential_default_site_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.default_business_id is null then
    return new;
  end if;
  if not exists (
    select 1 from public.businesses b
    where b.id = new.default_business_id and b.user_id = new.user_id
  ) then
    raise exception 'A default site must be one of the owner''s own sites.';
  end if;
  if new.business_id is not null and new.business_id <> new.default_business_id then
    raise exception 'A credential limited to one site cannot default to another.';
  end if;
  return new;
end;
$$;

create or replace trigger api_keys_default_site_guard
  before insert or update of default_business_id on public.api_keys
  for each row execute function public.credential_default_site_guard();

create or replace trigger oauth_tokens_default_site_guard
  before insert or update of default_business_id on public.oauth_tokens
  for each row execute function public.credential_default_site_guard();

comment on column public.api_keys.default_business_id is
  'The site this key acts on when a call names none (set_default_site, Settings → Claude and API). Null: the oldest site. Set null when the site is deleted.';
comment on column public.oauth_tokens.default_business_id is
  'The site this grant acts on when a call names none, the same on every row of the family (set_default_site, Settings → Claude and API). Null: the oldest site. Set null when the site is deleted.';
