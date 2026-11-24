-- What Autopilot's last run did for a site, and why it did less than the
-- calendar needed when it did (lib/automation/run-status.ts,
-- docs/AUTOPILOT.md "Every run says what it did").
--
-- Until now every reason the daily sweep had for leaving a site's calendar
-- empty (topics that all overlap what the site already published, a top-up
-- that found nothing new, no active plan, today's AI limit, an error) went
-- only into the cron's own response or a log line: a site could read
-- "Autopilot on" for weeks while nothing happened. The sweep writes this
-- record, through the service role, at the end of every run for a site with
-- Autopilot on; the Content screen, get_content and Settings -> Autopilot
-- read it.
--
-- Additive and nullable: null means no run recorded yet, which the screens
-- say in words. No backfill, no constraint, nothing dropped. RLS on
-- businesses is unchanged: the column is the row's, read by its owner like
-- every other column of it.

alter table public.businesses
  add column if not exists autopilot_run jsonb;

comment on column public.businesses.autopilot_run is
  'Autopilot''s last run for this site: {at, scheduled, topicsAdded, questionsAdded, emptyDays, bufferDays, reasons[{code, message}]} (lib/automation/run-status.ts). Null: no run recorded yet.';
