-- Who answered each model call of an agent run.
--
-- agent_runs.model keeps the first call's model and nothing says which
-- provider gave the answer or whether it was the fallback. From 2026-11-10
-- the article agents alternate between providers day by day
-- (LLM_ARTICLE_ROTATION), and comparing them needs exactly that, per run: a
-- run the fallback answered measures the other provider and must not be
-- averaged into the arm it ran under.
--
-- One entry per call: { provider, model, fallback, tierDowngraded,
-- inputTokens, outputTokens, costUsd }.
--
-- Nullable on purpose: rows written before this migration, and runs that
-- failed before any call answered, have no record. Null reads as "not
-- recorded", which is what it is.
--
-- The arm of the day is not here: it is the output of the job's `arm` step
-- (job_steps), stored once per job.

alter table public.agent_runs
  add column if not exists llm_calls jsonb;

comment on column public.agent_runs.llm_calls is
  'One entry per model call: provider, model, fallback, tierDowngraded, tokens, cost. Null when not recorded (rows before 2026-11-10, failed runs).';
