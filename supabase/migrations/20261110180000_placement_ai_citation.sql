-- Closing the loop from AI Visibility to Replies (docs/AI_VISIBILITY.md,
-- docs/PLACEMENTS.md): a page an answer engine cited for one of the site's
-- prompts, in an answer that did not cite the site, becomes a row of the
-- Replies inbox.
--
-- ai_citation records the sighting the row rests on, so the card can say
-- which prompt and which engine without joining the probes:
--
--   { "runId": "<aeo_runs.id>", "checkedAt": "<iso>", "promptCount": 3,
--     "prompts": [ { "queryId": "<aeo_queries.id or null>",
--                    "query": "<the prompt, verbatim>",
--                    "engines": ["gemini", "perplexity"] } ] }
--
-- Engines are listed per prompt, never merged into one number. It is what
-- one sampled run returned, not a claim that the engine always reads the
-- page. Null on every row no run has pointed at: discovery's and the ones a
-- person added keep null, which reads as "no sampled answer cited this",
-- not as zero citations.
--
-- A new `kind` value comes with it, 'listicle' (a "best X tools" article on
-- the open web, where the move is asking the author to be listed). `kind` is
-- free text with no check constraint, so it needs no statement here.
--
-- No rows are rewritten and nothing is dropped. The existing RLS policies on
-- placement_targets cover the column.

alter table public.placement_targets
  add column if not exists ai_citation jsonb;

comment on column public.placement_targets.ai_citation is
  'The sampled AI Visibility sighting this row rests on: {runId, checkedAt, promptCount, prompts: [{queryId, query, engines}]}. Null when no sampled answer cited the page.';
