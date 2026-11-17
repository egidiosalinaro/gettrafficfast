-- The kind of search a topic answers (lib/keywords/intent.ts).
--
--   comparison        choosing between tools: alternatives, vs, review,
--                     pricing, "best <category> tools";
--   platform_howto    a how-to or support question about a platform or tool
--                     the site's own data names;
--   problem           the outcome the reader wants or the problem they have;
--   product_adjacent  the business's own category.
--
-- Decided by rules from the phrase when the topic enters the pool (a model's
-- label is taken only where the rules found nothing, in the suggestion call
-- that already runs). Autopilot schedules a week toward a mix of them
-- (docs/AUTOPILOT.md, "A week's mix"), and a comparison gets the comparison
-- brief (docs/CONTENT_PIPELINE.md).
--
-- Additive and nullable: existing rows keep null, read as the rules' verdict
-- and written by the Autopilot sweep on its next run for a site that has it
-- on. The check accepts null, so nothing stored today violates it. RLS on
-- keywords is unchanged: the column is the row's, like every other.

alter table public.keywords
  add column if not exists intent text
    constraint keywords_intent_check
    check (intent is null or intent in ('comparison', 'platform_howto', 'problem', 'product_adjacent'));

comment on column public.keywords.intent is
  'The kind of search the topic answers: comparison, platform_howto, problem, product_adjacent (lib/keywords/intent.ts). Null: stored before 2026-11-15, read as the rules'' verdict.';
