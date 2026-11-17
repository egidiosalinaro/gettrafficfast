-- Off-site placement, step 2 of Phase 7 (docs/PLACEMENTS.md): the verdict.
--
-- Discovery finds conversations cheaply and stores them all. Qualification is
-- the first step that costs a model call, so what it decided has to survive:
-- a target judged once is never judged again, and a rejection that was wrong
-- can be read and argued with instead of silently repeating.
--
-- The angle is the column that matters. A target is only worth answering if we
-- can name what the thread does not already have; a qualified row without an
-- angle is a row nobody knows what to write for.

alter table public.placement_targets
  add column if not exists qualify_score integer,
  add column if not exists qualify_reason text,
  add column if not exists qualify_angle text,
  add column if not exists qualified_at timestamptz;

-- The review queue reads qualified targets best-first; the sweep reads the
-- undecided ones. One index serves both because status leads.
create index if not exists placement_targets_queue_idx
  on public.placement_targets (user_id, status, qualify_score desc nulls last);
