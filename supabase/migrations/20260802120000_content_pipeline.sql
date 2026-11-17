-- Content platform: persist every stage of an article's journey and add the
-- state an article lands in when the quality gates refuse to publish it.
--
-- Until now `articles.content` held post-processed HTML and nothing else was
-- kept, so a bad publication could not be diagnosed after the fact: there was
-- no way to tell a model failure from a pipeline failure.

alter table public.articles
  -- Exactly what the model returned, before any transformation.
  add column if not exists raw_content text,
  -- The Canonical Article (title, body, headings, excerpt, metadata).
  add column if not exists canonical jsonb,
  -- Decision + issues from the last pipeline run.
  add column if not exists quality_report jsonb;

-- 'needs_review': content exists and is preserved, but a quality gate refused
-- to publish it automatically. It never reaches a customer's site until a
-- human approves it.
alter table public.articles
  drop constraint if exists articles_status_check;

alter table public.articles
  add constraint articles_status_check
  check (status in ('queued', 'generating', 'generated', 'needs_review', 'published', 'failed'));

create index if not exists articles_status_needs_review_idx
  on public.articles (status, scheduled_date)
  where status = 'needs_review';

-- Delivery log: what was sent to the destination and what it answered.
alter table public.publish_attempts
  add column if not exists payload jsonb,
  add column if not exists response jsonb;
