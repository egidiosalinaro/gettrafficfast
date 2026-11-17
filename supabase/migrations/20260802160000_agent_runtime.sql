-- Agent runtime foundations: durable jobs, per-step checkpoints, agent run log
-- and an explicit article lifecycle history.
--
-- Multi-agent production is ~10 model calls per article: it does not fit one
-- serverless invocation, and a failure at the last step must not discard the
-- work before it. Jobs are claimed, executed step by step, and resumed from the
-- last completed step.

-- ── Durable jobs ────────────────────────────────────────────────────────────
create table if not exists public.jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  type text not null,
  input jsonb not null default '{}'::jsonb,
  status text not null default 'pending'
    check (status in ('pending', 'running', 'completed', 'failed', 'cancelled')),
  -- Name of the next step to execute; null once the workflow is done.
  current_step text,
  priority int not null default 0,
  attempts int not null default 0,
  max_attempts int not null default 3,
  run_after timestamptz not null default timezone('utc', now()),
  locked_by text,
  locked_at timestamptz,
  last_error text,
  result jsonb,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now()),
  finished_at timestamptz
);

-- A job may reference the article it produces, so the UI can show progress.
alter table public.jobs
  add column if not exists article_id uuid references public.articles(id) on delete cascade;

create index if not exists jobs_claimable_idx
  on public.jobs (status, run_after)
  where status in ('pending', 'running');
create index if not exists jobs_user_idx on public.jobs (user_id, created_at desc);
create index if not exists jobs_article_idx on public.jobs (article_id);

alter table public.jobs enable row level security;

create policy "Users can view their own jobs"
  on public.jobs for select to authenticated
  using (auth.uid() = user_id);

create policy "Service role manages jobs"
  on public.jobs for all to service_role using (true) with check (true);

-- ── Step checkpoints ────────────────────────────────────────────────────────
-- One row per (job, step). A completed row is never re-executed: this is what
-- makes a resumed run cheap and idempotent.
create table if not exists public.job_steps (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null references public.jobs(id) on delete cascade,
  step text not null,
  status text not null default 'running'
    check (status in ('running', 'completed', 'failed', 'skipped')),
  output jsonb,
  error text,
  attempt int not null default 1,
  started_at timestamptz not null default timezone('utc', now()),
  finished_at timestamptz,
  unique (job_id, step)
);

create index if not exists job_steps_job_idx on public.job_steps (job_id);

alter table public.job_steps enable row level security;

create policy "Users can view steps of their own jobs"
  on public.job_steps for select to authenticated
  using (exists (select 1 from public.jobs j where j.id = job_id and j.user_id = auth.uid()));

create policy "Service role manages job steps"
  on public.job_steps for all to service_role using (true) with check (true);

-- ── Agent runs ──────────────────────────────────────────────────────────────
-- Every agent invocation: what went in, what came out, what it cost. Audit
-- trail, cost report and debugging surface in one place.
create table if not exists public.agent_runs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  article_id uuid references public.articles(id) on delete cascade,
  job_id uuid references public.jobs(id) on delete set null,
  agent text not null,
  agent_version int not null default 1,
  status text not null check (status in ('completed', 'failed')),
  input jsonb,
  output jsonb,
  model text,
  input_tokens int,
  output_tokens int,
  cost_usd numeric(10, 6),
  latency_ms int,
  error text,
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists agent_runs_article_idx on public.agent_runs (article_id, created_at desc);
create index if not exists agent_runs_user_idx on public.agent_runs (user_id, created_at desc);

alter table public.agent_runs enable row level security;

create policy "Users can view their own agent runs"
  on public.agent_runs for select to authenticated
  using (auth.uid() = user_id);

create policy "Service role manages agent runs"
  on public.agent_runs for all to service_role using (true) with check (true);

-- ── Lifecycle history ───────────────────────────────────────────────────────
-- Every state transition with its cause, so "why is this article stuck" is
-- answerable without reading logs.
create table if not exists public.article_events (
  id uuid primary key default gen_random_uuid(),
  article_id uuid not null references public.articles(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  from_state text,
  to_state text not null,
  cause text,
  actor text not null default 'system',
  metadata jsonb,
  created_at timestamptz not null default timezone('utc', now())
);

create index if not exists article_events_article_idx
  on public.article_events (article_id, created_at desc);

alter table public.article_events enable row level security;

create policy "Users can view their own article events"
  on public.article_events for select to authenticated
  using (auth.uid() = user_id);

create policy "Service role manages article events"
  on public.article_events for all to service_role using (true) with check (true);

-- ── Atomic claim ────────────────────────────────────────────────────────────
-- FOR UPDATE SKIP LOCKED: several workers can tick concurrently without ever
-- picking up the same job. Jobs whose lock has expired (a worker died mid-run)
-- become claimable again.
create or replace function public.claim_jobs(
  p_worker text,
  p_limit int default 3,
  p_lock_seconds int default 300
)
returns setof public.jobs
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  update public.jobs j
  set status = 'running',
      locked_by = p_worker,
      locked_at = timezone('utc', now()),
      attempts = j.attempts + 1,
      updated_at = timezone('utc', now())
  where j.id in (
    select c.id
    from public.jobs c
    where (c.status = 'pending' and c.run_after <= timezone('utc', now()))
       or (c.status = 'running'
           and c.locked_at < timezone('utc', now()) - make_interval(secs => p_lock_seconds))
    order by c.priority desc, c.run_after asc
    limit p_limit
    for update skip locked
  )
  returning j.*;
end;
$$;

revoke all on function public.claim_jobs(text, int, int) from public, anon, authenticated;
