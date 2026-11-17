-- A post's images, so the drafter can see them (docs/PLACEMENTS.md, "The
-- post's images", 2026-11-11).
--
-- A post on X asked "are these numbers normal for a twelve day old site?"
-- about a screenshot of its numbers, and
-- the draft, which never saw an image, asked him what traffic he was seeing.
--
-- media: the post's photos, videos and GIFs as X described them, a JSON
--   list of {type, url, previewUrl, altText, width, height}. null: never
--   asked (rows stored before this, other surfaces, a post whose embed
--   showed no media); []: asked, none.
-- media_unread: true when the post has media that could not be read (the
--   X API off or at its cap, or X not describing a media key); false when
--   what the post has was read; null when not known. An image nobody read
--   is recorded as unread, never as absent.
--
-- Additive only: two nullable columns on a table that already has RLS on
-- and its policies (the owner reads and updates their own rows), nothing
-- dropped, no default rewritten, no backfill.

alter table public.placement_targets add column if not exists media jsonb;
alter table public.placement_targets add column if not exists media_unread boolean;

comment on column public.placement_targets.media is
  'The post''s media as the source described them: [{type, url, previewUrl, altText, width, height}]. null: never asked; []: none.';
comment on column public.placement_targets.media_unread is
  'True when the post has media that could not be read (so the drafter did not see it); false when read; null when not known.';
