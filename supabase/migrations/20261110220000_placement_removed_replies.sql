-- A posted reply the site removed or hid (docs/PLACEMENTS.md, "Removed
-- replies", 2026-11-10).
--
-- Reddit hides every comment of a new account, a moderator removes one, a
-- person deletes their own. The row stays `published_manually`: it was
-- posted, and that stays true. Beside it, when the person said it was
-- removed and, optionally, why. A negative result the measurement needs, so
-- it is recorded and never deleted by the product; only the person's Undo
-- clears it.
--
-- Additive only: two nullable columns, null on every existing row (nothing
-- removed until someone says so). The status check is untouched. The
-- owner's existing update policy on placement_targets covers the writes;
-- the moves are validated in lib/placements/workflow.ts.
alter table public.placement_targets
  add column if not exists removed_at timestamptz,
  add column if not exists removed_reason text
    check (removed_reason is null or char_length(removed_reason) <= 300);
