-- Reschedule (drag-and-drop) support for the calendar.
--
-- Moving an article onto a day that already holds one must SWAP the two dates,
-- not just overwrite — otherwise the articles_user_id_scheduled_date_key unique
-- index (one article per user per day) would be violated. A swap done as two
-- separate UPDATEs would also transiently violate that non-deferrable unique
-- index, so we do it in a single UPDATE ... CASE statement, which is only
-- checked once at statement end.
--
-- SECURITY INVOKER + explicit user_id filters mean the caller can only move
-- their own rows, and RLS still applies on top.

create or replace function public.move_article(
  p_article_id uuid,
  p_target_date date
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_current_date date;
  v_occupant uuid;
begin
  select scheduled_date into v_current_date
  from public.articles
  where id = p_article_id and user_id = v_uid;

  if v_current_date is null then
    raise exception 'Article not found';
  end if;

  if v_current_date = p_target_date then
    return;
  end if;

  select id into v_occupant
  from public.articles
  where user_id = v_uid
    and scheduled_date = p_target_date
    and id <> p_article_id;

  if v_occupant is null then
    update public.articles
    set scheduled_date = p_target_date,
        updated_at = timezone('utc', now())
    where id = p_article_id and user_id = v_uid;
  else
    update public.articles
    set scheduled_date = case
          when id = p_article_id then p_target_date
          when id = v_occupant then v_current_date
        end,
        updated_at = timezone('utc', now())
    where id in (p_article_id, v_occupant) and user_id = v_uid;
  end if;
end;
$$;
