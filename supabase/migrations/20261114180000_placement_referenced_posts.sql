-- What a post quotes and what it replies to, so the drafter, the checks
-- and the card see it (docs/PLACEMENTS.md, "What the post quotes",
-- 2026-11-14).
--
-- A post on X said only "Naming is the hardest part of shipping", quoting
-- an automated listing for a product. The joke was
-- all in the quoted post, which the product never read: the draft missed
-- the point and the card showed one line with no context.
--
-- referenced_posts: null when never asked (rows stored before this, other
--   surfaces). Otherwise {"quoted": slot, "repliedTo": slot}, each slot
--   null (not known), "none" (asked: quotes / answers no post), or the post
--   {id, url, text, authorName, handle, postedAt, postedAtPrecision, media,
--   mediaUnread, note}, with text null when it exists and could not be read.
--   A quoted post nobody read is recorded as unread, never as absent.
--
-- Additive only: one nullable column on a table that already has RLS on
-- and its policies (the owner reads and updates their own rows), nothing
-- dropped, no default rewritten, no backfill here (the daily X run reads
-- the open posts of the last 3 days).

alter table public.placement_targets add column if not exists referenced_posts jsonb;

comment on column public.placement_targets.referenced_posts is
  'What the post quotes and replies to: {quoted, repliedTo}, each null (not known), "none", or the post (text null when unread). null: never asked.';
