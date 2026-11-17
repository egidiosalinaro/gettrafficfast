-- OAuth 2.1 for the MCP endpoint: how claude.ai and the Claude apps connect.
--
-- A custom connector on claude.ai cannot send a header of its own, so an API
-- key (`Authorization: Bearer gtf_…`) cannot reach /api/mcp from there. This
-- site runs its own authorization server instead (lib/oauth/, docs/API.md
-- "Connect from claude.ai"): Claude registers itself as a client (RFC 7591),
-- sends the person to the consent screen, gets a code bound to a PKCE S256
-- challenge, and exchanges it for an access token and a refresh token. API
-- keys keep working exactly as before.
--
-- Nothing secret is stored: a client secret, a code, an access token and a
-- refresh token are kept as their SHA-256 (hex), never the value.
--
-- oauth_clients: one row per registration. Claude registers a public client
-- (no secret) on every fresh connection; a confidential client keeps the
-- hash of its secret. redirect_uris are compared exactly (the port of a
-- loopback URI aside, RFC 8252), and the table refuses any that is neither
-- https nor http on localhost, 127.0.0.1 or [::1]. registered_from is a hash
-- of the address that registered, for the per-address registration limit.
--
-- oauth_authorization_codes: one row per consent. It names the person, the
-- site they chose (null for every site), the scopes they ticked, the PKCE
-- challenge, the redirect URI and the resource. It lives ten minutes at
-- most and is used once.
--
-- oauth_tokens: one row per access token and the refresh token issued with
-- it. Every row minted from one consent shares family_id (the code's id):
-- the family is the grant Settings lists as one connected app. A refresh
-- spends its row (rotated_at) and mints the next; a spent refresh token
-- presented again revokes the whole family. A trigger keeps what a token
-- grants fixed, a revoked token revoked and a spent one spent.
--
-- business_id cascades on delete rather than setting null, as for API keys:
-- a grant for a deleted site must die with it, never widen into a grant for
-- every site.
--
-- RLS on every table. Only the service role writes. A person reads their
-- own token rows (Settings → API keys → Connected apps); clients and codes
-- have no user policy at all.
--
-- tool_calls gains oauth_client_id: an OAuth caller's audit row names the
-- app (api_key_id stays null), and the per-key limits count on it.
--
-- No statement here removes anything: the migration applies without a
-- confirmation (CLAUDE.md, "Migrations reach production with the commit").

-- Redirect URIs a client may register: one to ten, each https, or http on a
-- loopback address, with no fragment and no user name in it.
create or replace function public.oauth_redirect_uris_ok(uris text[])
returns boolean
language sql
immutable
set search_path = ''
as $$
  select coalesce(cardinality(uris) between 1 and 10, false)
    and coalesce(
      bool_and(
        u ~* '^https://[^/?#@[:space:]]+([/?][^#[:space:]]*)?$'
        or u ~* '^http://(localhost|127\.0\.0\.1|\[::1\])(:[0-9]{1,5})?([/?][^#[:space:]]*)?$'
      ),
      false
    )
  from unnest(uris) as u;
$$;

create table if not exists public.oauth_clients (
  client_id text primary key check (client_id ~ '^gtfci_[A-Za-z0-9_-]{22}$'),
  client_name text not null check (char_length(client_name) between 1 and 100),
  redirect_uris text[] not null check (public.oauth_redirect_uris_ok(redirect_uris)),
  token_endpoint_auth_method text not null default 'none'
    check (token_endpoint_auth_method in ('none', 'client_secret_post', 'client_secret_basic')),
  client_secret_hash text check (client_secret_hash is null or client_secret_hash ~ '^[0-9a-f]{64}$'),
  registered_from text not null check (registered_from ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default timezone('utc', now()),
  last_used_at timestamptz,
  -- A public client has no secret; a confidential one always has one.
  constraint oauth_clients_secret_matches_method
    check ((token_endpoint_auth_method = 'none') = (client_secret_hash is null))
);

-- The registration limit: one address's registrations in the last hour.
create index if not exists oauth_clients_registered_idx on public.oauth_clients (registered_from, created_at desc);

alter table public.oauth_clients enable row level security;

create policy "Service role manages OAuth clients"
  on public.oauth_clients for all to service_role using (true) with check (true);

create table if not exists public.oauth_authorization_codes (
  id uuid primary key default gen_random_uuid(),
  code_hash text not null unique check (code_hash ~ '^[0-9a-f]{64}$'),
  client_id text not null references public.oauth_clients(client_id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  business_id uuid references public.businesses(id) on delete cascade,
  scopes text[] not null
    check (cardinality(scopes) >= 1 and scopes <@ array['read', 'write', 'spend', 'publish']::text[]),
  code_challenge text not null check (code_challenge ~ '^[A-Za-z0-9_-]{43}$'),
  code_challenge_method text not null default 'S256' check (code_challenge_method = 'S256'),
  redirect_uri text not null check (public.oauth_redirect_uris_ok(array[redirect_uri])),
  resource text not null check (char_length(resource) between 1 and 2000),
  expires_at timestamptz not null,
  used_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  constraint oauth_authorization_codes_short_lived check (expires_at <= created_at + interval '10 minutes')
);

-- So deleting a person, an app or a site does not scan the table.
create index if not exists oauth_authorization_codes_user_idx on public.oauth_authorization_codes (user_id);
create index if not exists oauth_authorization_codes_client_idx on public.oauth_authorization_codes (client_id);
create index if not exists oauth_authorization_codes_business_idx on public.oauth_authorization_codes (business_id);

alter table public.oauth_authorization_codes enable row level security;

create policy "Service role manages OAuth authorization codes"
  on public.oauth_authorization_codes for all to service_role using (true) with check (true);

create table if not exists public.oauth_tokens (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null,
  client_id text not null references public.oauth_clients(client_id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  business_id uuid references public.businesses(id) on delete cascade,
  scopes text[] not null
    check (cardinality(scopes) >= 1 and scopes <@ array['read', 'write', 'spend', 'publish']::text[]),
  resource text not null check (char_length(resource) between 1 and 2000),
  access_token_hash text not null unique check (access_token_hash ~ '^[0-9a-f]{64}$'),
  refresh_token_hash text not null unique check (refresh_token_hash ~ '^[0-9a-f]{64}$'),
  access_expires_at timestamptz not null,
  refresh_expires_at timestamptz not null,
  rotated_at timestamptz,
  revoked_at timestamptz,
  last_used_at timestamptz,
  granted_at timestamptz not null default timezone('utc', now()),
  created_at timestamptz not null default timezone('utc', now()),
  constraint oauth_tokens_access_short_lived check (access_expires_at <= created_at + interval '2 hours'),
  constraint oauth_tokens_refresh_bounded check (refresh_expires_at <= created_at + interval '31 days')
);

-- Revoking a grant, and detecting a spent refresh token, act on the family.
create index if not exists oauth_tokens_family_idx on public.oauth_tokens (family_id);
-- Settings → Connected apps, and the live-grant cap: the live head of each family.
create index if not exists oauth_tokens_user_live_idx
  on public.oauth_tokens (user_id, granted_at desc)
  where rotated_at is null and revoked_at is null;
create index if not exists oauth_tokens_client_idx on public.oauth_tokens (client_id);
create index if not exists oauth_tokens_business_idx on public.oauth_tokens (business_id);

alter table public.oauth_tokens enable row level security;

create policy "Users can view their own OAuth grants"
  on public.oauth_tokens for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "Service role manages OAuth tokens"
  on public.oauth_tokens for all to service_role using (true) with check (true);

-- What a token grants cannot be edited, a revoked token stays revoked, and
-- a spent refresh token stays spent. Only rotated_at and revoked_at (once,
-- from null) and last_used_at change after a row is written.
create or replace function public.oauth_tokens_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.family_id is distinct from old.family_id
     or new.client_id is distinct from old.client_id
     or new.user_id is distinct from old.user_id
     or new.business_id is distinct from old.business_id
     or new.scopes is distinct from old.scopes
     or new.resource is distinct from old.resource
     or new.access_token_hash is distinct from old.access_token_hash
     or new.refresh_token_hash is distinct from old.refresh_token_hash
     or new.access_expires_at is distinct from old.access_expires_at
     or new.refresh_expires_at is distinct from old.refresh_expires_at
     or new.granted_at is distinct from old.granted_at
     or new.created_at is distinct from old.created_at then
    raise exception 'What an OAuth token grants cannot change: issue a new one instead.';
  end if;
  if old.revoked_at is not null and new.revoked_at is distinct from old.revoked_at then
    raise exception 'A revoked OAuth token stays revoked.';
  end if;
  if old.rotated_at is not null and new.rotated_at is distinct from old.rotated_at then
    raise exception 'A spent refresh token stays spent.';
  end if;
  return new;
end;
$$;

create or replace trigger oauth_tokens_guard
  before update on public.oauth_tokens
  for each row execute function public.oauth_tokens_guard();

-- The audit log names the app an OAuth caller came through; the per-key
-- limits count an app's calls for one account on it.
alter table public.tool_calls
  add column if not exists oauth_client_id text references public.oauth_clients(client_id) on delete set null;

create index if not exists tool_calls_oauth_client_created_idx
  on public.tool_calls (oauth_client_id, user_id, created_at desc)
  where oauth_client_id is not null;

comment on table public.oauth_clients is
  'OAuth clients of the MCP authorization server, registered dynamically (RFC 7591): name, exact redirect URIs (https or loopback), how the client authenticates, the SHA-256 of its secret when confidential, and a hash of the registering address for the rate limit.';
comment on table public.oauth_authorization_codes is
  'One per consent on the OAuth screen: SHA-256 of the code, the person, the site (null = every site), the ticked scopes, the PKCE S256 challenge, the redirect URI and the resource. Ten minutes at most, used once.';
comment on table public.oauth_tokens is
  'OAuth access and refresh tokens for the MCP endpoint, as SHA-256. One row per pair; rows of one consent share family_id (the grant). A refresh spends its row (rotated_at); a spent refresh token used again revokes the family.';
comment on column public.tool_calls.oauth_client_id is
  'The OAuth app the call came through (null for an API key or a session); the per-key limits count on it with user_id.';
