-- Knowledge layer (architecture Phase 3): the graph that turns a pile of
-- articles into topical authority — entities, topic clusters, and the internal
-- links built from them.
--
-- Recorded at write time, on every generation: retrofitting entities onto
-- hundreds of published articles later is far more expensive than capturing
-- them while the article is produced.
--
-- Keyed by user_id like the rest of the schema (businesses are one-per-user).

-- ── Entities: the named things articles are about ───────────────────────────
-- canonical_name is the dedup key (lowercased, trimmed); name keeps the
-- best-known display form.
create table if not exists public.entities (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  type text not null check (type in (
    'product', 'brand', 'organization', 'person', 'place',
    'technology', 'concept', 'other'
  )),
  name text not null,
  canonical_name text not null,
  external_ids jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  unique (user_id, type, canonical_name)
);

create index if not exists entities_user_idx on public.entities (user_id);

-- ── What each article is about ──────────────────────────────────────────────
create table if not exists public.article_entities (
  article_id uuid not null references public.articles(id) on delete cascade,
  entity_id uuid not null references public.entities(id) on delete cascade,
  role text not null default 'mentioned' check (role in ('primary', 'mentioned')),
  -- 0-1: how central the entity is to the article.
  salience numeric(4,3) not null default 0.5 check (salience >= 0 and salience <= 1),
  created_at timestamptz not null default timezone('utc', now()),
  primary key (article_id, entity_id)
);

create index if not exists article_entities_entity_idx on public.article_entities (entity_id);

-- ── Topics: the cluster tree ────────────────────────────────────────────────
create table if not exists public.topics (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  slug text not null,
  parent_id uuid references public.topics(id) on delete set null,
  pillar_article_id uuid references public.articles(id) on delete set null,
  created_at timestamptz not null default timezone('utc', now()),
  unique (user_id, slug)
);

create index if not exists topics_user_idx on public.topics (user_id);

create table if not exists public.article_topics (
  article_id uuid not null references public.articles(id) on delete cascade,
  topic_id uuid not null references public.topics(id) on delete cascade,
  is_primary boolean not null default false,
  created_at timestamptz not null default timezone('utc', now()),
  primary key (article_id, topic_id)
);

create index if not exists article_topics_topic_idx on public.article_topics (topic_id);

-- ── Internal links the platform placed (or suggested) ───────────────────────
-- anchor is the exact text span wrapped in the source article. A row exists
-- for every applied link, so cannibalisation and orphan analysis never have to
-- parse HTML.
create table if not exists public.article_links (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  from_article_id uuid not null references public.articles(id) on delete cascade,
  to_article_id uuid not null references public.articles(id) on delete cascade,
  anchor text not null,
  status text not null default 'applied' check (status in ('suggested', 'applied', 'removed')),
  created_at timestamptz not null default timezone('utc', now()),
  unique (from_article_id, to_article_id, anchor)
);

create index if not exists article_links_from_idx on public.article_links (from_article_id);
create index if not exists article_links_to_idx on public.article_links (to_article_id);

-- ── RLS: owners read, the platform writes ───────────────────────────────────
alter table public.entities enable row level security;
alter table public.article_entities enable row level security;
alter table public.topics enable row level security;
alter table public.article_topics enable row level security;
alter table public.article_links enable row level security;

create policy "Users can view their own entities"
  on public.entities for select to authenticated
  using (auth.uid() = user_id);

create policy "Service role manages entities"
  on public.entities for all to service_role using (true) with check (true);

create policy "Users can view their own article entities"
  on public.article_entities for select to authenticated
  using (exists (
    select 1 from public.articles a
    where a.id = article_entities.article_id and a.user_id = auth.uid()
  ));

create policy "Service role manages article entities"
  on public.article_entities for all to service_role using (true) with check (true);

create policy "Users can view their own topics"
  on public.topics for select to authenticated
  using (auth.uid() = user_id);

create policy "Service role manages topics"
  on public.topics for all to service_role using (true) with check (true);

create policy "Users can view their own article topics"
  on public.article_topics for select to authenticated
  using (exists (
    select 1 from public.articles a
    where a.id = article_topics.article_id and a.user_id = auth.uid()
  ));

create policy "Service role manages article topics"
  on public.article_topics for all to service_role using (true) with check (true);

create policy "Users can view their own article links"
  on public.article_links for select to authenticated
  using (auth.uid() = user_id);

create policy "Service role manages article links"
  on public.article_links for all to service_role using (true) with check (true);
