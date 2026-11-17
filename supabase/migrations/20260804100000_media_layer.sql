-- Media layer (architecture Phase 2): per-business media preferences, a
-- record of every generated/selected asset, and the storage bucket assets
-- live in.
--
-- Images and videos are OFF by default: generation has a real per-unit cost,
-- so a business opts in from Settings → Generation.

alter table public.businesses
  add column if not exists media_settings jsonb not null default '{}'::jsonb;

-- One row per asset the platform produced or selected for an article. This is
-- the cost/attribution record and what makes cleanup and reuse possible; the
-- canonical document references assets by URL.
create table if not exists public.media_assets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  article_id uuid references public.articles(id) on delete cascade,
  kind text not null check (kind in ('hero', 'inline', 'video')),
  provider text not null,
  prompt text,
  url text not null,
  storage_path text,
  meta jsonb,
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists media_assets_article_idx on public.media_assets (article_id);
create index if not exists media_assets_user_idx on public.media_assets (user_id, created_at desc);

alter table public.media_assets enable row level security;

create policy "Users can view their own media assets"
  on public.media_assets for select to authenticated
  using (auth.uid() = user_id);

create policy "Service role manages media assets"
  on public.media_assets for all to service_role using (true) with check (true);

-- Public bucket: generated images are published content, served straight from
-- storage by customer sites. Writes go through the service role only.
insert into storage.buckets (id, name, public)
values ('article-media', 'article-media', true)
on conflict (id) do nothing;
