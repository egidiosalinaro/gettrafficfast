-- Recorded from production on 2026-11-09. This migration was applied to the
-- gettrafficfast project on 2026-11-02 (version 20261102181255) without its
-- file reaching the repository, so a database rebuilt from the repo would
-- lack it. The statements below are the ones production ran, verbatim.
--
-- It widens the placements variant check with 'original_post' (an original
-- Reddit post, submitted by the person) and adds placements.published_at.

alter table public.placements drop constraint if exists placements_variant_check;

alter table public.placements
  add constraint placements_variant_check
  check (variant in (
    'short_comment',
    'detailed_answer',
    'article_draft',
    'github_issue',
    'github_pr_proposal',
    'original_post'
  ));

alter table public.placements
  add column if not exists published_at timestamptz;

comment on column public.placements.published_at is
  'When the person submitted this draft themselves. Used for an original Reddit post so the thread stays open for the reply. Null until they say so.';
