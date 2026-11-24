-- The X account a site posts from (docs/INTEGRATIONS.md, "X: the account GTF
-- posts from"; the owner's decision of 2026-11-24).
--
-- One row per site: a site connects at most one X account, through X's own
-- consent screen (OAuth 2.0 with PKCE), and two sites may connect the same
-- account or different ones. GTF posts from it only when a person presses
-- Post on a reply X allows (its author mentioned or quoted the account), or
-- confirms a post to their agent (`post_on_x`): never on its own.
--
-- The tokens are the credential: encrypted at rest with the integrations
-- key (AES-256-GCM, lib/integrations/crypto.ts), like every other
-- credential, and never selected by anything a client reads. X rotates the
-- refresh token on every refresh; the service role stores the new pair.
--
-- RLS: the owner reads their own rows, and only for a site they own; the
-- platform (service role) writes them. No client write policy: a person
-- connects through the OAuth round trip and disconnects through the route,
-- both of which write with the service role after checking the session.
--
-- Additive only: one new table, its index and its policies. Nothing dropped.

create table if not exists public.x_posting_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  business_id uuid not null references public.businesses(id) on delete cascade,
  -- X's id of the account: it survives a rename, the username does not.
  x_user_id text not null check (x_user_id ~ '^[0-9]{1,20}$'),
  -- As X spells it, without "@".
  username text not null check (username ~ '^[A-Za-z0-9_]{1,15}$'),
  access_token_encrypted text not null,
  refresh_token_encrypted text,
  -- When the access token expires; null when X did not say.
  expires_at timestamptz,
  scopes text[] not null default '{}',
  -- 'error': X refused the stored token; the person connects again.
  status text not null default 'connected' check (status in ('connected', 'error')),
  last_error text,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  unique (business_id)
);

create index if not exists x_posting_connections_user_idx
  on public.x_posting_connections (user_id);

alter table public.x_posting_connections enable row level security;

create policy "Users can view their own X posting connections"
  on public.x_posting_connections for select to authenticated
  using (
    (select auth.uid()) = user_id
    and exists (
      select 1 from public.businesses b
      where b.id = x_posting_connections.business_id and b.user_id = (select auth.uid())
    )
  );

create policy "Service role manages X posting connections"
  on public.x_posting_connections for all to service_role using (true) with check (true);

comment on table public.x_posting_connections is
  'The X account a site posts from, connected by its owner on X''s consent screen. Tokens encrypted at rest; GTF posts from it only on a person''s press of Post (or their confirmation to their agent).';
