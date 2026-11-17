-- The stored size of a generated image.
--
-- Until 2026-11-10 the provider's bytes were stored as they came: JPEG,
-- 771 KB on average, with no record of their pixel size, so the <img> in the
-- article could not declare width and height. Images are now resized to at
-- most 1600 px wide and encoded as WebP before storage, and the row says what
-- was stored.
--
-- Nullable on purpose: rows written before this migration were never
-- measured, and a video row has no pixels. Null reads as "not measured",
-- which is what it is.

alter table public.media_assets
  add column if not exists width integer,
  add column if not exists height integer,
  add column if not exists bytes integer;

comment on column public.media_assets.width is 'Pixel width of the stored file; null when not measured (rows before 2026-11-10, videos).';
comment on column public.media_assets.height is 'Pixel height of the stored file; null when not measured.';
comment on column public.media_assets.bytes is 'Size in bytes of the stored file; null when not measured.';
