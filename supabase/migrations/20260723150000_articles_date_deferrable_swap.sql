-- move_article() swaps two rows' scheduled_date in one UPDATE, but the
-- (user_id, scheduled_date) unique constraint is checked per row, so the swap
-- hit a transient duplicate and failed. Make the constraint deferrable and
-- defer it for the swap so the check only runs once, at statement/commit end.

alter table public.articles
  drop constraint articles_user_id_scheduled_date_key;

alter table public.articles
  add constraint articles_user_id_scheduled_date_key
    unique (user_id, scheduled_date) deferrable initially immediate;

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
    -- Defer the unique check so the two rows can swap dates in one statement.
    set constraints all deferred;
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
