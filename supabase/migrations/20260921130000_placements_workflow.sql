-- Off-site placement, steps 3 and 4 of Phase 7 (docs/PLACEMENTS.md): the
-- draft, the gate, and the inbox a person works from.
--
-- Discovery and qualification already exist. What is added is everything a
-- reviewer needs to act on an opportunity — where it came from and why it
-- qualified, a proposed answer that passed an audit, and the manual workflow
-- around it (approve, mark published, dismiss, snooze) — plus the identity
-- rules that keep one thread from becoming three rows when three providers
-- find it.
--
-- Nothing here publishes. There is no column for a platform token and no
-- state a machine moves into "published": `published_manually` is set by a
-- person after they pasted the answer themselves.

-- ── Targets: provenance, identity, freshness, workflow ──────────────────────
alter table public.placement_targets
  -- thread / issue / discussion / repository / article / post / page.
  add column if not exists kind text not null default 'thread',
  add column if not exists author text,
  -- Which provider found it (reddit, github, web-search). `surface` says where
  -- the page lives; this says how we learned of it, so a Reddit thread found
  -- through web search is still a Reddit thread.
  add column if not exists found_via text,
  -- Same question, different URL: a cross-post to three subreddits is one
  -- opportunity. Coarse title hash; see lib/providers/discovery/canonical.ts.
  add column if not exists content_hash text,
  -- Theme and intent as judged by the qualifier; the inbox filters on them.
  add column if not exists topic text,
  add column if not exists intent text,
  -- 'rules' when a deterministic rule decided, 'agent' when the model did.
  add column if not exists qualified_by text,
  -- Rediscovery keeps this current; the rest of the row keeps the first sighting.
  add column if not exists last_seen_at timestamptz not null default timezone('utc', now()),
  -- Past this, the thread is not proposed without an explicit reason.
  add column if not exists fresh_until timestamptz,
  add column if not exists snoozed_until timestamptz,
  add column if not exists review_note text,
  add column if not exists dismissed_reason text,
  -- Filled by the person who published, never by the system.
  add column if not exists published_url text,
  add column if not exists published_at timestamptz,
  add column if not exists published_note text,
  -- The AI Visibility query this placement is meant to move, so the query
  -- detail can show it. Set null if the query is removed.
  add column if not exists aeo_query_id uuid references public.aeo_queries(id) on delete set null,
  add column if not exists updated_at timestamptz not null default timezone('utc', now());

-- The full lifecycle. Historical rows are all discovered / qualified /
-- rejected, so widening the check touches no data.
alter table public.placement_targets drop constraint if exists placement_targets_status_check;
alter table public.placement_targets
  add constraint placement_targets_status_check
  check (status in (
    'discovered', 'rejected', 'qualified', 'drafted', 'needs_review',
    'approved', 'published_manually', 'dismissed'
  ));

create index if not exists placement_targets_content_hash_idx
  on public.placement_targets (business_id, content_hash);
create index if not exists placement_targets_inbox_idx
  on public.placement_targets (business_id, status, qualify_score desc nulls last);
create index if not exists placement_targets_aeo_query_idx
  on public.placement_targets (aeo_query_id);

-- Owners act on their own targets (approve, dismiss, snooze, mark published);
-- the transitions themselves are validated in lib/placements/workflow.ts
-- before the API issues the update. Reads and the platform's writes were
-- already covered.
drop policy if exists "Users can update their own placement targets" on public.placement_targets;
create policy "Users can update their own placement targets"
  on public.placement_targets for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- ── Placements: our proposed answers ────────────────────────────────────────
-- One row per draft variant of a target. The audit travels with the text it
-- judged: a body edited by the reviewer is re-audited and the row updated,
-- so `audit` always describes `body`.
create table if not exists public.placements (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  business_id uuid not null references public.businesses(id) on delete cascade,
  target_id uuid not null references public.placement_targets(id) on delete cascade,
  -- Which shape of answer this is, because the same thread can deserve a
  -- two-line comment and a full reply and the reviewer picks.
  variant text not null check (variant in (
    'short_comment', 'detailed_answer', 'article_draft', 'github_issue', 'github_pr_proposal'
  )),
  body text not null,
  -- The one link, when a link genuinely adds something. Null is the common case.
  link_url text,
  -- Every factual claim the draft makes and what it rests on, as
  -- [{text, basis: 'business_profile' | 'thread' | 'general_knowledge' | 'unverified'}].
  claims jsonb not null default '[]'::jsonb,
  -- The gate's checklist: {status, checks: [{id, label, status, detail}]}.
  audit jsonb not null default '{}'::jsonb,
  audit_status text not null default 'blocked'
    check (audit_status in ('passed', 'warning', 'blocked')),
  agent_version integer not null default 1,
  created_at timestamptz not null default timezone('utc', now()),
  updated_at timestamptz not null default timezone('utc', now())
);

create index if not exists placements_target_idx on public.placements (target_id, created_at desc);
create index if not exists placements_business_idx on public.placements (business_id, created_at desc);

-- The variant the reviewer chose, once they have. Added after the table
-- exists because it points at it.
alter table public.placement_targets
  add column if not exists selected_placement_id uuid references public.placements(id) on delete set null;

alter table public.placements enable row level security;

create policy "Users can view their own placements"
  on public.placements for select to authenticated
  using ((select auth.uid()) = user_id);
create policy "Users can edit their own placements"
  on public.placements for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);
create policy "Service role manages placements"
  on public.placements for all to service_role using (true) with check (true);
