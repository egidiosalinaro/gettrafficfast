-- AI Visibility (docs/AI_VISIBILITY.md): does an answer engine cite or
-- recommend THIS business when someone asks one of the questions the business
-- has decided to be found for?
--
-- ai_citations already measures one ARTICLE against the keyword it was written
-- for, and the Citation Index measures many companies against one shared
-- question in public. This is the third subject: one business, an explicit
-- set of questions it chose, measured repeatedly and privately. The providers
-- underneath are the same; the unit of configuration (a query set), the unit
-- of execution (a run) and the record kept per probe are not, which is why
-- these are new tables rather than more nullable columns on ai_citations.
--
-- Honest by construction, like every measurement table here: a probe is a
-- SAMPLE of one engine's answer on one day. Negative probes are stored, a run
-- that asked nothing yields a null rate, and a probe whose answer could not be
-- read is recorded as `invalid` or `error`, never silently as "not cited".

-- ── Per-business configuration ──────────────────────────────────────────────
-- Which brand names and domains count as "us", which engines to ask, how
-- often. Same shape as automation_settings: a Zod-parsed jsonb with defaults,
-- so a new knob is a schema change in lib/visibility/settings.ts, not here.
alter table public.businesses
  add column if not exists aeo_settings jsonb not null default '{}'::jsonb;

-- ── The query set ───────────────────────────────────────────────────────────
-- Explicit, editable, grouped. Nothing is probed that is not in this table:
-- the rate is only meaningful alongside the exact questions that produced it.
create table if not exists public.aeo_queries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  business_id uuid not null references public.businesses(id) on delete cascade,
  query text not null,
  -- Editorial grouping: "pricing", "alternatives", "how-to". Free text.
  cluster text,
  -- informational / commercial / comparison / navigational, or null when the
  -- owner has not said. Validated in the application, kept open here.
  intent text,
  -- A disabled query stays in the set (its history is kept) but is not asked.
  enabled boolean not null default true,
  -- Where it came from, so a bulk import can be told apart from a deliberate
  -- choice later.
  source text not null default 'manual'
    check (source in ('manual', 'keyword', 'suggested')),
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

-- One wording per site, case-insensitively: "best AI SEO tool" and "Best AI
-- SEO tool" would be two paid probes measuring one thing.
create unique index if not exists aeo_queries_business_query_key
  on public.aeo_queries (business_id, lower(query));
create index if not exists aeo_queries_business_idx
  on public.aeo_queries (business_id, enabled, created_at);

-- ── Runs ────────────────────────────────────────────────────────────────────
-- One execution of the query set. The set actually measured is frozen on the
-- row (engines, count, fingerprint) because the dashboard compares runs, and
-- two runs over different questions or different engines are not comparable;
-- the fingerprint is what lets the UI say so instead of drawing a trend.
create table if not exists public.aeo_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  business_id uuid not null references public.businesses(id) on delete cascade,
  job_id uuid references public.jobs(id) on delete set null,
  trigger text not null default 'manual' check (trigger in ('manual', 'schedule')),
  status text not null default 'running'
    check (status in ('running', 'completed', 'failed')),
  engines text[] not null default '{}',
  query_count integer not null default 0,
  -- SHA-256 over the sorted, normalised enabled queries at plan time.
  query_fingerprint text,
  planned_probes integer not null default 0,
  probe_version integer not null default 1,
  -- Sum of the per-probe estimates. An estimate, and labelled as such.
  cost_usd numeric(10, 6),
  error text,
  started_at timestamptz not null default timezone('utc', now()),
  finished_at timestamptz,
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists aeo_runs_business_idx
  on public.aeo_runs (business_id, started_at desc);

-- ── Probes ──────────────────────────────────────────────────────────────────
-- One question, one engine, one run. Planned as `pending` when the run starts
-- so the set is frozen and the job can resume; fulfilled one by one.
--
-- `cited` is nullable on purpose: it is null while pending and stays null for
-- `invalid` and `error`, because "the engine did not answer" is not "the
-- engine did not cite us". The rate divides cited by (cited + not_cited);
-- coverage divides those by everything planned.
create table if not exists public.aeo_probes (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.aeo_runs(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  business_id uuid not null references public.businesses(id) on delete cascade,
  -- Set null rather than cascade: deleting a query from the set must not erase
  -- the history of what was measured for it.
  query_id uuid references public.aeo_queries(id) on delete set null,
  -- The question verbatim, and the cluster it sat in at the time.
  query text not null,
  cluster text,
  engine text not null,
  model text,
  status text not null default 'pending'
    check (status in ('pending', 'cited', 'not_cited', 'invalid', 'error')),
  cited boolean,
  -- Our page among the sources: which one, and where in the list.
  source_url text,
  position integer,
  -- The brand was named in the prose. Weaker than a citation, kept apart.
  mentioned boolean,
  -- Bounded excerpt of the answer. The UI shows it as an excerpt, never as
  -- the full response.
  answer_excerpt text,
  -- Every source the engine returned, verbatim, as [{url, domain, title}].
  sources jsonb not null default '[]'::jsonb,
  -- Other domains cited and known competitors named, as
  -- [{domain, name, via: 'source' | 'mention'}].
  competitors jsonb not null default '[]'::jsonb,
  error text,
  attempts integer not null default 0,
  latency_ms integer,
  cost_usd numeric(10, 6),
  probe_version integer not null default 1,
  checked_at timestamptz,
  created_at timestamptz not null default timezone('utc', now()),
  unique (run_id, query, engine)
);

create index if not exists aeo_probes_run_idx on public.aeo_probes (run_id, status);
create index if not exists aeo_probes_query_idx
  on public.aeo_probes (query_id, checked_at desc);
create index if not exists aeo_probes_business_idx
  on public.aeo_probes (business_id, checked_at desc);

-- ── RLS ─────────────────────────────────────────────────────────────────────
-- Owners read everything about their own sites; only the query set is theirs
-- to write, because runs and probes are written by the worker. Same rule as
-- every other measurement table: user_id is the isolation key, business_id is
-- the scope the application filters on.
alter table public.aeo_queries enable row level security;
alter table public.aeo_runs enable row level security;
alter table public.aeo_probes enable row level security;

create policy "Users can view their own AEO queries"
  on public.aeo_queries for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "Users can add their own AEO queries"
  on public.aeo_queries for insert to authenticated
  with check ((select auth.uid()) = user_id);
create policy "Users can update their own AEO queries"
  on public.aeo_queries for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
create policy "Users can delete their own AEO queries"
  on public.aeo_queries for delete to authenticated
  using ((select auth.uid()) = user_id);
create policy "Service role manages AEO queries"
  on public.aeo_queries for all to service_role using (true) with check (true);

create policy "Users can view their own AEO runs"
  on public.aeo_runs for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "Service role manages AEO runs"
  on public.aeo_runs for all to service_role using (true) with check (true);

create policy "Users can view their own AEO probes"
  on public.aeo_probes for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "Service role manages AEO probes"
  on public.aeo_probes for all to service_role using (true) with check (true);
