-- Split "content is ready" from "content is live on the customer's site".
--
-- New articles.status flow: queued -> generating -> generated -> published.
--   * 'generated'  = content stored in articles.content but not yet on the
--     customer's site (no integration connected, or the publish call failed).
--   * 'failed'     = generation dead-letter after MAX_ATTEMPTS (the cron was
--     already writing this value, but the old CHECK constraint rejected it,
--     so dead-lettered rows silently stayed 'generating'/'queued').
--
-- Publish failures do NOT consume attempt_count: the cron retries them on
-- every run. Only generation failures increment attempt_count.

alter table public.articles
  drop constraint if exists articles_status_check;

alter table public.articles
  add constraint articles_status_check
  check (status in ('queued', 'generating', 'generated', 'published', 'failed'));

-- The publish step re-scans 'generated' rows on every cron run.
create index if not exists articles_status_generated_idx
  on public.articles (status, scheduled_date)
  where status = 'generated';
