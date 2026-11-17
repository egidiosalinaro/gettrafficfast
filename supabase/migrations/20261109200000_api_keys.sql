-- API keys: how a machine (an agent, a script, an MCP client) acts for a user.
--
-- Every GUI action is meant to be doable through the API and, from there,
-- through MCP (docs/API.md). A browser carries the Supabase session cookie;
-- a machine carries `Authorization: Bearer gtf_…` instead, and this table is
-- what that header is checked against (lib/api-keys.ts).
--
-- The raw key is shown once, when it is created, and never stored: key_hash
-- is the SHA-256 of the whole key, hex. prefix is its first 8 characters
-- ("gtf_" and four more), shown in Settings → API keys so a person can tell
-- their keys apart, and the index verification narrows on before it compares
-- hashes in constant time.
--
-- business_id null means the key may act on every site of the account (the
-- site is then named per request, `x-gtf-business`, or is the first one).
-- Set, the key acts on that site only. It cascades on delete rather than
-- setting null: a key for a deleted site must die with it, never widen into
-- a key for every site.
--
-- scopes is what the key may do: `read` lists and reads, `write` changes
-- things, `spend` may start work that costs money (a model call, a job that
-- makes one), `publish` may put something on a site in the owner's name. A
-- tool declares what it needs (lib/tools/). The default is read and write:
-- spending is ticked by the person, never switched on by a default. No tool
-- needs `publish` today, and none ever posts to X or Reddit.
--
-- RLS: the owner reads, creates and revokes (updates) their own keys, and
-- creating one for a site must name a site the owner has. Verification runs
-- through the service role, which also writes last_used_at. A trigger keeps
-- what a key IS fixed once created (owner, site, hash, prefix, scopes) and
-- keeps a revoked key revoked: changing those is a new key, not an edit.

create table if not exists public.api_keys (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  business_id uuid references public.businesses(id) on delete cascade,
  name text not null check (char_length(name) between 1 and 100),
  prefix text not null check (char_length(prefix) = 8),
  key_hash text not null unique check (key_hash ~ '^[0-9a-f]{64}$'),
  scopes text[] not null default '{read,write}'
    check (cardinality(scopes) >= 1 and scopes <@ array['read', 'write', 'spend', 'publish']::text[]),
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default timezone('utc', now())
);

-- Verification narrows on the prefix, then compares hashes in constant time.
create index if not exists api_keys_prefix_idx on public.api_keys (prefix);
-- Settings → API keys lists one user's keys, newest first.
create index if not exists api_keys_user_created_idx on public.api_keys (user_id, created_at desc);

alter table public.api_keys enable row level security;

create policy "Users can view their own API keys"
  on public.api_keys for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "Users can create their own API keys"
  on public.api_keys for insert to authenticated
  with check (
    (select auth.uid()) = user_id
    and revoked_at is null
    and (
      business_id is null
      or exists (
        select 1 from public.businesses b
        where b.id = api_keys.business_id and b.user_id = (select auth.uid())
      )
    )
  );

create policy "Users can revoke their own API keys"
  on public.api_keys for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

create policy "Service role manages API keys"
  on public.api_keys for all to service_role using (true) with check (true);

-- What a key is cannot be edited, and a revoked key stays revoked. Only
-- name, revoked_at (once, from null) and last_used_at change after creation.
create or replace function public.api_keys_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.user_id is distinct from old.user_id
     or new.business_id is distinct from old.business_id
     or new.prefix is distinct from old.prefix
     or new.key_hash is distinct from old.key_hash
     or new.scopes is distinct from old.scopes
     or new.created_at is distinct from old.created_at then
    raise exception 'An API key''s owner, site, secret and scopes cannot change: create a new key instead.';
  end if;
  if old.revoked_at is not null and new.revoked_at is distinct from old.revoked_at then
    raise exception 'A revoked API key stays revoked.';
  end if;
  return new;
end;
$$;

create or replace trigger api_keys_guard
  before update on public.api_keys
  for each row execute function public.api_keys_guard();

comment on table public.api_keys is
  'Keys a machine uses to act for a user through the API and MCP: SHA-256 of the key, its 8-character prefix, the site it is limited to (null = every site of the account), its scopes, and when it was last used or revoked.';
