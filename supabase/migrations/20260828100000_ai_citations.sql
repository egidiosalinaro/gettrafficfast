-- Citation probing (architecture Phase 5, second slice): the AEO half of the
-- lifecycle loop.
--
-- Rank tells us where an article sits on Google. This table tells us whether
-- an answer engine cites the customer when someone asks the question the
-- article answers — the thing the product claims to optimise for, and until
-- now the only claim with no measurement behind it.
--
-- Honest by construction: no engine exposes "was I cited" as an API, so every
-- row here is a SAMPLE. We ask the question ourselves, on a schedule, and
-- record what came back. A negative probe is stored, never skipped: "we asked
-- and were not cited" is the measurement, while a missing row would read as
-- "we never asked". Same rule as a null position in content_metrics.
--
-- Keyed by user_id like the rest of the schema (businesses are one-per-user).

create table if not exists public.ai_citations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  article_id uuid not null references public.articles(id) on delete cascade,
  -- Engine identity: rates are only comparable within one engine, so every
  -- row carries its own and nothing averages across them.
  engine text not null,
  -- The question actually asked. Kept verbatim: the probe is only meaningful
  -- alongside the wording that produced it.
  query text not null,
  cited boolean not null,
  -- true when the engine cited the article's own URL, false when it cited
  -- another page on the same domain. Both are wins, they are not the same win.
  exact boolean not null default false,
  source_url text,
  -- Excerpt of the engine's answer, kept only when cited, to show the customer
  -- what they were cited for.
  snippet text,
  checked_on date not null default (timezone('utc', now()))::date,
  created_at timestamptz not null default timezone('utc', now()),
  unique (article_id, engine, query, checked_on)
);

create index if not exists ai_citations_article_idx
  on public.ai_citations (article_id, checked_on desc);
create index if not exists ai_citations_user_idx
  on public.ai_citations (user_id, checked_on desc);

-- ── RLS: owners read, the platform writes ───────────────────────────────────
alter table public.ai_citations enable row level security;

create policy "Users can view their own AI citations"
  on public.ai_citations for select to authenticated
  using (auth.uid() = user_id);

create policy "Service role manages AI citations"
  on public.ai_citations for all to service_role using (true) with check (true);
