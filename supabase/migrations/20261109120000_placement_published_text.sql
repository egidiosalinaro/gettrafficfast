-- The words a person actually posted, read back from their reply's link.
--
-- A draft is not what went out: the owner often edits it on X before he
-- posts. The drafting loop learns the voice from the last replies posted
-- (docs/PLACEMENTS.md), so it needs the published words, not the draft.
-- When the link to the reply is saved ("I posted it" with a link, or the
-- link added later), an X status is read through X's public oEmbed, the
-- same free endpoint "Add a post from X" uses, and its text is stored here.
--
-- published_text: the reply as X shows it, without the @handles X puts in
-- front of every reply. Null means not read yet, or X would not hand it
-- over (protected, deleted, no answer, not on X): never an empty string
-- standing in for "unknown". Written by the platform, never typed.
-- published_text_at: when that text was read.
--
-- No rows are rewritten. The 21 replies posted before the link existed have
-- no link and stay without text; replies with a link are read lazily
-- (ensurePublishedText, lib/placements/published-text.ts), a few at a time.
-- Existing RLS policies on placement_targets already cover the columns.

alter table public.placement_targets
  add column if not exists published_text text,
  add column if not exists published_text_at timestamptz;

comment on column public.placement_targets.published_text is
  'The text of the reply as published, read from published_url through X''s public oEmbed (leading reply @handles removed); null when not read yet or not readable.';
comment on column public.placement_targets.published_text_at is
  'When published_text was read from the published reply.';
