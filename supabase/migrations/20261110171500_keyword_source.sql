-- Where a keyword came from, when it did not come from keyword research.
--
-- A keyword added from "Questions people ask" (lib/keywords/questions.ts) is
-- a question somebody asked in a public thread discovery found for the site.
-- It has no volume, difficulty, CPC, competition or opportunity, measured or
-- estimated: those columns stay null for it, and these two say why.
--
--   source      'question' for such a keyword; null for every other one
--               (typed, or suggested by the research model).
--   source_url  one thread that asks it (a placement_targets.url of the
--               same site), for "asked in a public thread" to link to.
--
-- Additive and nullable: existing rows keep null, nothing is rewritten.

alter table public.keywords
  add column if not exists source text,
  add column if not exists source_url text;

comment on column public.keywords.source is
  'Where the keyword came from when not from keyword research: ''question'' = asked in a public thread. Null otherwise.';
comment on column public.keywords.source_url is
  'For source = ''question'': one discovered thread that asks it.';
