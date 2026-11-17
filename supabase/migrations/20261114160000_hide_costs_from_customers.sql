-- What the platform pays is the owner's, down to the column (the owner's
-- decision, 2026-11-14; docs/API.md "What a customer never sees").
--
-- Commit 36b62c0 took every dollar figure off the screens, the routes and the
-- tools. One door stayed open: RLS lets a signed-in person select his own
-- rows of agent_runs, aeo_runs, aeo_probes, tool_calls and media_assets, so
-- his own session JWT against PostgREST could still read their cost columns,
-- and the RPC tool_call_usage summed tool_calls.cost_usd for him.
--
-- From here the customer's role selects every column except the costs:
--   agent_runs    cost_usd, and llm_calls (each call's costUsd)
--   aeo_runs      cost_usd
--   aeo_probes    cost_usd
--   tool_calls    cost_usd
--   media_assets  meta (holds cost_usd beside the render's model and MIME
--                 type; no customer read selects media_assets at all)
-- The service role keeps reading everything: the owner's /settings/costs and
-- get_platform_costs, the spend ceiling (now read through the service role
-- after the session check, lib/limits/guard.ts), the workflows. anon had a
-- table grant but no policy, so it read nothing; it keeps no select at all.
--
-- Only SELECT moves. INSERT, UPDATE, DELETE, REFERENCES, TRIGGER and TRUNCATE
-- grants stay exactly as they were (RLS still admits no customer write).
-- A column added to these tables later is NOT selectable by authenticated
-- until a migration grants it: name it here if a customer read needs it.
--
-- tool_call_usage keeps its body and its return type (create or replace
-- cannot change it) and becomes the service role's only; Settings -> Claude
-- and API reads tool_call_counts, the same per-key count with no cost.
--
-- No data is moved or deleted, nothing is dropped. The revokes are the
-- owner's explicit approval of 2026-11-14.

-- agent_runs ----------------------------------------------------------------
revoke select on public.agent_runs from authenticated, anon;
grant select (
  id, user_id, business_id, article_id, job_id, agent, agent_version, status,
  input, output, model, input_tokens, output_tokens, latency_ms, error, created_at
) on public.agent_runs to authenticated;

-- aeo_runs ------------------------------------------------------------------
revoke select on public.aeo_runs from authenticated, anon;
grant select (
  id, user_id, business_id, job_id, trigger, status, engines, query_count,
  query_fingerprint, planned_probes, probe_version, error, started_at,
  finished_at, created_at
) on public.aeo_runs to authenticated;

-- aeo_probes ----------------------------------------------------------------
revoke select on public.aeo_probes from authenticated, anon;
grant select (
  id, run_id, user_id, business_id, query_id, query, cluster, engine, model,
  status, cited, source_url, position, mentioned, answer_excerpt, sources,
  competitors, error, attempts, latency_ms, probe_version, checked_at,
  created_at
) on public.aeo_probes to authenticated;

-- tool_calls ----------------------------------------------------------------
revoke select on public.tool_calls from authenticated, anon;
grant select (
  id, user_id, business_id, api_key_id, oauth_client_id, tool, status,
  duration_ms, created_at
) on public.tool_calls to authenticated;

-- media_assets --------------------------------------------------------------
revoke select on public.media_assets from authenticated, anon;
grant select (
  id, user_id, business_id, article_id, kind, provider, prompt, url,
  storage_path, width, height, bytes, created_at
) on public.media_assets to authenticated;

-- Per-key usage without a cost ----------------------------------------------
create or replace function public.tool_call_counts(p_since timestamptz)
returns table (api_key_id uuid, calls bigint)
language sql
stable
security invoker
set search_path = ''
as $$
  select t.api_key_id, count(*)::bigint
  from public.tool_calls t
  where t.user_id = (select auth.uid())
    and t.api_key_id is not null
    and t.created_at >= p_since
  group by t.api_key_id;
$$;

revoke execute on function public.tool_call_counts(timestamptz) from public, anon;
grant execute on function public.tool_call_counts(timestamptz) to authenticated, service_role;

comment on function public.tool_call_counts(timestamptz) is
  'Each of the caller''s API keys and its tool calls since p_since (security invoker: the caller''s own rows). No cost: what a call costs the platform is the owner''s.';

-- The summed cost is the service role's only.
revoke execute on function public.tool_call_usage(timestamptz) from public, anon, authenticated;
grant execute on function public.tool_call_usage(timestamptz) to service_role;

comment on function public.tool_call_usage(timestamptz) is
  'Per-key calls and summed measured cost since p_since. Service role only (20261114160000_hide_costs_from_customers); customers read tool_call_counts.';
