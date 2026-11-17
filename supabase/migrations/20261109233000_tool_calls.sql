-- tool_calls: the audit log of the API and MCP, and what the per-key limits
-- count (docs/API.md "Limits and the audit log", lib/tools/usage.ts).
--
-- The tool runner (lib/tools/runner.ts) writes one row per call it runs,
-- whatever the outcome, through the service role: who (user_id), for which
-- site (business_id, null when the account had none yet), with which key
-- (api_key_id, null for a browser session), which tool, how it ended
-- (status: `ok` or the API error code it answered with), how long it took,
-- and what it cost when the tool measured it. cost_usd null means "not
-- measured", never "free": a job that kept running after the call answered
-- has no cost on its row.
--
-- The same rows hold each API key to its limits: a burst of 60 calls a
-- minute, and a daily cap per paid tool, both counted on
-- (api_key_id, created_at). The runner fails open when this table cannot be
-- read, so the table missing never stops the API.
--
-- RLS: the owner reads their own rows (Settings → API keys shows each key's
-- calls and spend); nobody but the service role writes, so a user cannot
-- erase their own count or forge another's.
--
-- business_id and api_key_id are set null when the site or the key is
-- deleted, so the audit outlives them; deleting the user deletes the rows.

create table if not exists public.tool_calls (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  business_id uuid references public.businesses(id) on delete set null,
  api_key_id uuid references public.api_keys(id) on delete set null,
  tool text not null check (char_length(tool) between 1 and 64),
  status text not null check (status ~ '^[a-z_]{1,40}$'),
  cost_usd numeric(10, 6) check (cost_usd is null or cost_usd >= 0),
  duration_ms integer check (duration_ms is null or duration_ms >= 0),
  created_at timestamptz not null default timezone('utc', now())
);

-- The per-key limits: a key's calls in the last minute, its calls of one
-- tool in the last 24 hours.
create index if not exists tool_calls_key_created_idx on public.tool_calls (api_key_id, created_at desc);
-- One account's calls, newest first (Settings, support).
create index if not exists tool_calls_user_created_idx on public.tool_calls (user_id, created_at desc);
-- So deleting a site does not scan the table to set its rows null.
create index if not exists tool_calls_business_idx on public.tool_calls (business_id);

alter table public.tool_calls enable row level security;

create policy "Users can view their own tool calls"
  on public.tool_calls for select to authenticated
  using ((select auth.uid()) = user_id);

create policy "Service role manages tool calls"
  on public.tool_calls for all to service_role using (true) with check (true);

-- Each key's calls since a moment, and the cost of those that measured one,
-- for Settings → API keys. Security invoker: it reads through the caller's
-- RLS, so a person only ever counts their own rows.
create or replace function public.tool_call_usage(p_since timestamptz)
returns table (api_key_id uuid, calls bigint, measured_calls bigint, cost_usd numeric)
language sql
stable
security invoker
set search_path = ''
as $$
  select t.api_key_id, count(*)::bigint, count(t.cost_usd)::bigint, sum(t.cost_usd)
  from public.tool_calls t
  where t.user_id = (select auth.uid())
    and t.api_key_id is not null
    and t.created_at >= p_since
  group by t.api_key_id;
$$;

grant execute on function public.tool_call_usage(timestamptz) to authenticated;

comment on table public.tool_calls is
  'One row per API or MCP tool call: who, which site, which key (null for a session), which tool, the outcome (ok or the error code), duration, and the measured cost (null when not measured). The per-key limits count it.';
