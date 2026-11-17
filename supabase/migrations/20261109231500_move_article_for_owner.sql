-- The calendar move for a caller with no user JWT: an API key.
--
-- move_article(p_article_id, p_target_date) reads the owner from auth.uid().
-- An API-key caller runs on the service role (lib/supabase/owner-scoped.ts,
-- docs/API.md "Why the service role, narrowed"), where auth.uid() is null,
-- so the reschedule_article tool could never find the article. This is the
-- same body with the owner passed in by the server, which takes it from the
-- verified key, never from the request.
--
-- Executable by the service role only. An authenticated user calling it
-- could name another owner; RLS would still stop them (security invoker),
-- but there is no reason to let them try: the screens keep move_article.
--
-- The tool checks that the article is a row of the key owner's site before
-- it calls this (lib/calendar/manage.ts, rescheduleArticle), as the route
-- does before move_article.

create or replace function public.move_article_for_owner(
  p_owner uuid,
  p_article_id uuid,
  p_target_date date
)
returns void
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_business uuid;
  v_current_date date;
  v_occupant uuid;
begin
  if p_owner is null then
    raise exception 'Article not found';
  end if;

  select scheduled_date, business_id into v_current_date, v_business
  from public.articles
  where id = p_article_id and user_id = p_owner;

  if v_current_date is null then
    raise exception 'Article not found';
  end if;

  if v_current_date = p_target_date then
    return;
  end if;

  select id into v_occupant
  from public.articles
  where user_id = p_owner
    and business_id is not distinct from v_business
    and scheduled_date = p_target_date
    and id <> p_article_id;

  if v_occupant is null then
    update public.articles
    set scheduled_date = p_target_date,
        updated_at = timezone('utc', now())
    where id = p_article_id and user_id = p_owner;
  else
    -- Defer the unique check so the two rows can swap dates in one statement.
    set constraints all deferred;
    update public.articles
    set scheduled_date = case
          when id = p_article_id then p_target_date
          when id = v_occupant then v_current_date
        end,
        updated_at = timezone('utc', now())
    where id in (p_article_id, v_occupant) and user_id = p_owner;
  end if;
end;
$$;

revoke all on function public.move_article_for_owner(uuid, uuid, date) from public;
revoke all on function public.move_article_for_owner(uuid, uuid, date) from anon;
revoke all on function public.move_article_for_owner(uuid, uuid, date) from authenticated;
grant execute on function public.move_article_for_owner(uuid, uuid, date) to service_role;
