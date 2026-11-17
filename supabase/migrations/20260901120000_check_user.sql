-- The free check moves from an IP quota to an account quota: the Citation
-- Index page is public, running a check requires a free account, and three
-- checks a day are counted per user instead of per address.
alter table study_checks add column if not exists user_id uuid;
create index if not exists study_checks_user_day on study_checks (user_id, checked_on);
