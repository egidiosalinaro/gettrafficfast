-- The free check keeps what the engine actually said.
--
-- Source domains alone read as noise: grounding consults listicles and blog
-- posts, so a fintech's blog legitimately appears under an email marketing
-- question, and without the prose the result looks like a broken tool. The
-- snippet is the engine's own words, which is what makes the result readable.
alter table public.study_checks add column if not exists snippet text;

-- And the sources it consulted, for the same reason: a cache hit that answers
-- with less than a fresh run is a bug wearing a feature's hat.
alter table public.study_checks add column if not exists sources jsonb;
