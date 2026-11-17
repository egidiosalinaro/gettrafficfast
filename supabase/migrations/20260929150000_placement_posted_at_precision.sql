-- How precise placement_targets.posted_at is.
--
-- A web search result carries the date the engine shows, and the engine
-- shows either a day ("Jun 6, 2025") or a distance ("4 months ago"). A
-- distance is a bound, not an instant: the row stores the LATEST moment it
-- allows in posted_at, so an age computed from it never overstates, and
-- records here how wide the interval before it is. Null means what it
-- always meant: an exact timestamp from a platform API, or a date stored
-- before this column existed (a calendar day read from a snippet).
--
-- No rows are rewritten: the precision of a date already stored is not
-- known, and guessing it would be inventing a fact.

alter table public.placement_targets
  add column if not exists posted_at_precision text
  check (posted_at_precision in ('day', 'week', 'month', 'year'));

comment on column public.placement_targets.posted_at_precision is
  'Width of the interval ending at posted_at when the source gave a day or a distance rather than an instant; null for an exact timestamp.';
