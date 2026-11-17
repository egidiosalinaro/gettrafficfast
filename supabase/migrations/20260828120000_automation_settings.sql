-- Autopilot settings, per business.
--
-- The gap this closes: a keyword only reaches the calendar when the customer
-- puts it there by hand, and the calendar holds one article per day. Six
-- keywords means six days and then silence, even with more keywords sitting
-- unused. Someone who comes back after nine days finds three empty days that
-- can never be recovered.
--
-- Stored as jsonb next to media_settings and parsed through defaults, so the
-- shape can grow without a migration and old rows keep working.
--
-- OFF by default, deliberately. Autopilot spends money and publishes on the
-- customer's own site: it is not something that may switch itself on.

alter table public.businesses
  add column if not exists automation_settings jsonb not null default '{}'::jsonb;
