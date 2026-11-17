-- Automatic publishing claims an article before delivering it.
--
-- Two runs publish due `generated` articles: the daily run
-- (/api/cron/generate-articles) and, since 2026-11-10, the worker tick every
-- five minutes, for the article whose production finished after the daily
-- run's publishing phase. Both can read the same article; only one may deliver
-- it. `publishReadyArticles` (lib/articles/publish-ready.ts) compares-and-sets
-- this column from the value it read, on a row still `generated`, and only the
-- run whose update changed the row delivers. It clears its own claim when the
-- delivery ends; a claim older than ten minutes belongs to a run that died and
-- can be taken over.
--
-- Additive: one nullable column, no index (the claim is a write by primary key).

alter table public.articles
  add column if not exists publish_claimed_at timestamptz;

comment on column public.articles.publish_claimed_at is
  'When an automatic publishing run claimed this article''s delivery; null when nobody holds it. See lib/articles/publish-ready.ts.';
