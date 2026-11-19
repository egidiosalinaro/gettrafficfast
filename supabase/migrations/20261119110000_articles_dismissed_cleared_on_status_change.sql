-- Today's Ignore (2026-11-19) covers held articles too, and an article can
-- change state from many places (the generation run, a re-check, publish,
-- retry). Rather than each writer remembering to clear dismissed_at, the
-- database does it: whenever an article's status changes, the Ignore is
-- forgotten, so a new failure or a new hold shows on Today again.
-- Additive: a new function and a new trigger.
create or replace function public.articles_clear_dismissed_on_status_change()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.status is distinct from old.status then
    new.dismissed_at := null;
  end if;
  return new;
end;
$$;

create trigger articles_clear_dismissed_on_status_change
  before update of status on public.articles
  for each row
  execute function public.articles_clear_dismissed_on_status_change();
