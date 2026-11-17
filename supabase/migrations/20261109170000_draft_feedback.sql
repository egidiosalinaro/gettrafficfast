-- Corrections on placement drafts: the owner's reason, kept.
--
-- The owner replies on X from /placements every day. When a draft is wrong
-- he says why ("too generic", "sounds like AI", "never start with It's",
-- "use one of my real numbers"), the draft is rewritten once following that
-- note and judged again by the same gate (docs/PLACEMENTS.md, Corrections),
-- and the note stays here so later drafts can be told what he already
-- corrected (`recentFeedback`, lib/placements/feedback.ts).
--
-- One row per correction asked for, written BEFORE the model is called: a
-- rewrite that failed or was refused is still a note the owner gave, and the
-- row is also what the daily correction cap counts. body_after is null until
-- a rewrite was saved, and stays null when none was: "not rewritten", never
-- an empty string standing in for it.
--
-- placement_id is nullable and set null on delete: "Regenerate" replaces a
-- target's placements, and the owner's note outlives the draft it was about.
-- promoted_to_notes marks a reason the owner added to Settings → Voice →
-- notes (businesses.voice_settings.instructions).
--
-- RLS: the owner reads and adds their own rows, and an insert must name a
-- business the user owns and a target of that business (the same ownership
-- check as 20261108180000_rls_business_ownership.sql). There is no user
-- update or delete: body_after and promoted_to_notes are written by the
-- platform through the service role after it checked ownership, and a user
-- cannot delete rows to reset the daily cap.

create table if not exists public.draft_feedback (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  business_id uuid not null references public.businesses(id) on delete cascade,
  target_id uuid not null references public.placement_targets(id) on delete cascade,
  placement_id uuid references public.placements(id) on delete set null,
  reason text not null check (char_length(reason) between 3 and 300),
  body_before text,
  body_after text,
  promoted_to_notes boolean not null default false,
  created_at timestamptz not null default timezone('utc', now())
);

-- The recent notes of one site, newest first (recentFeedback, the list).
create index if not exists draft_feedback_business_created_idx
  on public.draft_feedback (business_id, created_at desc);
-- The daily cap counts one user's corrections across their sites.
create index if not exists draft_feedback_user_created_idx
  on public.draft_feedback (user_id, created_at desc);

alter table public.draft_feedback enable row level security;

drop policy if exists "Users can view their own draft feedback" on public.draft_feedback;
create policy "Users can view their own draft feedback"
  on public.draft_feedback for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "Users can add their own draft feedback" on public.draft_feedback;
create policy "Users can add their own draft feedback"
  on public.draft_feedback for insert to authenticated
  with check (
    (select auth.uid()) = user_id
    and exists (
      select 1 from public.businesses b
      where b.id = draft_feedback.business_id and b.user_id = (select auth.uid())
    )
    and exists (
      select 1 from public.placement_targets t
      where t.id = draft_feedback.target_id
        and t.business_id = draft_feedback.business_id
        and t.user_id = (select auth.uid())
    )
  );

drop policy if exists "Service role manages draft feedback" on public.draft_feedback;
create policy "Service role manages draft feedback"
  on public.draft_feedback for all to service_role using (true) with check (true);

comment on table public.draft_feedback is
  'Corrections the owner gave on a placement draft: the reason, the text before and after the one rewrite, and whether the reason was added to the voice notes.';
