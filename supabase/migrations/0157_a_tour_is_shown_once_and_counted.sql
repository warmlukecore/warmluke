-- Migration 0157: the tour is shown once to each person, and counted
--
-- The first look round the app (components/Tour.tsx) is shown once to
-- each person, on whichever device they open the app on first, and
-- opened again whenever they ask. An administrator can switch it off,
-- change what each stop says without a deploy, and see who saw it: who
-- went to the end, who closed it and where, and who took it again.
--
-- The stops themselves stay in the code (lib/tour.ts): each points at a
-- real part of the screen, so a stop changes with the screen it is on.
-- Only their words can be changed here.
--
--   what is offered          tour_settings, abo_admin_set_tour
--   who saw what             tour_views, abo_tour_seen
--   what the admin reads     abo_admin_tour_report, abo_admin_tour_reset

-- ── What is offered ──────────────────────────────────────────
create table if not exists public.tour_settings (
  id         boolean primary key default true check (id),
  enabled    boolean not null default true,
  -- A stop's words, by its key, where they differ from the code's:
  -- {"luke": {"title": "…", "body": "…"}}.
  copy       jsonb not null default '{}'::jsonb check (jsonb_typeof(copy) = 'object'),
  updated_at timestamptz not null default now()
);
insert into public.tour_settings (id) values (true) on conflict (id) do nothing;

alter table public.tour_settings enable row level security;
revoke all on table public.tour_settings from anon, authenticated;
grant select on table public.tour_settings to anon, authenticated;
drop policy if exists tour_settings_read on public.tour_settings;
create policy tour_settings_read on public.tour_settings for select to anon, authenticated using (true);
drop policy if exists tour_settings_oauth_no_insert on public.tour_settings;
create policy tour_settings_oauth_no_insert on public.tour_settings
  as restrictive for insert to authenticated with check (not public.abo_is_oauth_client());
drop policy if exists tour_settings_oauth_no_update on public.tour_settings;
create policy tour_settings_oauth_no_update on public.tour_settings
  as restrictive for update to authenticated using (not public.abo_is_oauth_client());
drop policy if exists tour_settings_oauth_no_delete on public.tour_settings;
create policy tour_settings_oauth_no_delete on public.tour_settings
  as restrictive for delete to authenticated using (not public.abo_is_oauth_client());

-- ── Who saw it ───────────────────────────────────────────────
-- One row a person: the last time they took it, and how often they have.
create table if not exists public.tour_views (
  user_id   uuid primary key references auth.users (id) on delete cascade,
  first_at  timestamptz not null default now(),
  last_at   timestamptz not null default now(),
  times     integer not null default 1 check (times >= 1),
  -- How the last one ended: to the end, or closed early. Null while it is
  -- open, or when the tab went away with it open.
  outcome   text check (outcome in ('finished', 'closed')),
  reached   integer not null default 1 check (reached >= 1),
  stops     integer not null check (stops between 1 and 20),
  closed_on text check (closed_on ~ '^[a-z_]{1,32}$')
);
create index if not exists tour_views_last on public.tour_views (last_at desc);

alter table public.tour_views enable row level security;
revoke all on table public.tour_views from anon, authenticated;
grant select on table public.tour_views to authenticated;
-- Their own row, so the app knows not to show it again; written only below.
drop policy if exists tour_views_own on public.tour_views;
create policy tour_views_own on public.tour_views for select to authenticated using (user_id = auth.uid());
drop policy if exists tour_views_oauth_no_insert on public.tour_views;
create policy tour_views_oauth_no_insert on public.tour_views
  as restrictive for insert to authenticated with check (not public.abo_is_oauth_client());
drop policy if exists tour_views_oauth_no_update on public.tour_views;
create policy tour_views_oauth_no_update on public.tour_views
  as restrictive for update to authenticated using (not public.abo_is_oauth_client());
drop policy if exists tour_views_oauth_no_delete on public.tour_views;
create policy tour_views_oauth_no_delete on public.tour_views
  as restrictive for delete to authenticated using (not public.abo_is_oauth_client());

-- The person taking it: opened (again), gone to the end, or closed at a stop.
create or replace function public.abo_tour_seen(p_event text, p_stop text, p_reached integer, p_stops integer)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'sign in first' using errcode = '42501';
  end if;
  if public.abo_is_oauth_client() then
    raise exception 'Only in Warmluke itself.' using errcode = '42501';
  end if;
  if p_event is null or p_event not in ('open', 'finished', 'closed') then
    raise exception 'No such moment in a tour.' using errcode = '22023';
  end if;
  if p_stops is null or p_stops not between 1 and 20 then
    raise exception 'A tour has between 1 and 20 stops.' using errcode = '22023';
  end if;
  if p_event = 'open' then
    insert into public.tour_views (user_id, stops) values (v_uid, p_stops)
    on conflict (user_id) do update
       set times = public.tour_views.times + 1, last_at = now(), outcome = null,
           reached = 1, stops = excluded.stops, closed_on = null;
  else
    -- The stops counted again at the end: the store can arrive after it opened.
    update public.tour_views
       set outcome = p_event,
           stops = p_stops,
           reached = least(greatest(coalesce(p_reached, 1), 1), p_stops),
           closed_on = case when p_event = 'closed' and p_stop ~ '^[a-z_]{1,32}$' then p_stop end,
           last_at = now()
     where user_id = v_uid;
  end if;
end $$;
revoke all on function public.abo_tour_seen(text, text, integer, integer) from public, anon;
grant execute on function public.abo_tour_seen(text, text, integer, integer) to authenticated;

-- ── The administrator's ──────────────────────────────────────

-- On or off, and what each stop says where it should differ from the code.
create or replace function public.abo_admin_set_tour(p_enabled boolean, p_copy jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_copy  jsonb := '{}'::jsonb;
  v_key   text;
  v_val   jsonb;
  v_title text;
  v_body  text;
  v_row   public.tour_settings;
begin
  if not public.abo_is_superadmin() then
    raise exception 'Not an administrator.' using errcode = '42501';
  end if;
  if public.abo_is_oauth_client() then
    raise exception 'Change this in Warmluke itself.' using errcode = '42501';
  end if;
  if p_copy is not null and jsonb_typeof(p_copy) <> 'object' then
    raise exception 'The words are by stop.' using errcode = '22023';
  end if;
  for v_key, v_val in select key, value from jsonb_each(coalesce(p_copy, '{}'::jsonb)) loop
    if v_key !~ '^[a-z_]{1,32}$' then
      raise exception 'No such stop: %.', v_key using errcode = '22023';
    end if;
    if jsonb_typeof(v_val) <> 'object' then
      raise exception 'A stop''s words are a title and a body.' using errcode = '22023';
    end if;
    -- Blank is the code's own words again.
    v_title := nullif(btrim(coalesce(v_val ->> 'title', '')), '');
    v_body  := nullif(btrim(coalesce(v_val ->> 'body', '')), '');
    if length(v_title) > 80 then
      raise exception 'A title is 80 characters at most.' using errcode = '22023';
    end if;
    if length(v_body) > 400 then
      raise exception 'What a stop says is 400 characters at most.' using errcode = '22023';
    end if;
    if v_title is not null or v_body is not null then
      v_copy := v_copy || jsonb_build_object(v_key, jsonb_strip_nulls(jsonb_build_object('title', v_title, 'body', v_body)));
    end if;
  end loop;
  if (select count(*) from jsonb_object_keys(v_copy)) > 20 then
    raise exception 'Twenty stops at most.' using errcode = '22023';
  end if;
  update public.tour_settings
     set enabled = coalesce(p_enabled, enabled), copy = v_copy, updated_at = now()
   where id
  returning * into v_row;
  return to_jsonb(v_row);
end $$;
revoke all on function public.abo_admin_set_tour(boolean, jsonb) from public, anon;
grant execute on function public.abo_admin_set_tour(boolean, jsonb) to authenticated;

-- Who saw it, and how it went: counted over everyone, and the latest
-- people by name. Counted here, so the page reads a few numbers however
-- many people there are.
create or replace function public.abo_admin_tour_report(p_limit integer default 200)
returns jsonb
language plpgsql stable security definer set search_path = public, auth as $$
begin
  if not public.abo_is_superadmin() then
    raise exception 'Not an administrator.' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'totals', (
      select jsonb_build_object(
               'shown', count(*),
               'finished', count(*) filter (where outcome = 'finished'),
               'closed', count(*) filter (where outcome = 'closed'),
               'open', count(*) filter (where outcome is null),
               'again', count(*) filter (where times > 1))
        from public.tour_views),
    'closed_on', coalesce((
      select jsonb_object_agg(closed_on, n)
        from (select closed_on, count(*) as n from public.tour_views
               where outcome = 'closed' and closed_on is not null group by closed_on) c), '{}'::jsonb),
    'people', coalesce((
      select jsonb_agg(jsonb_build_object(
               'user_id', v.user_id, 'email', u.email, 'first_at', v.first_at, 'last_at', v.last_at,
               'times', v.times, 'outcome', v.outcome, 'reached', v.reached, 'stops', v.stops,
               'closed_on', v.closed_on)
               order by v.last_at desc)
        from (select * from public.tour_views order by last_at desc
               limit least(greatest(coalesce(p_limit, 200), 1), 1000)) v
        left join auth.users u on u.id = v.user_id), '[]'::jsonb));
end $$;
revoke all on function public.abo_admin_tour_report(integer) from public, anon;
grant execute on function public.abo_admin_tour_report(integer) to authenticated;

-- Shown again to one person, the next time they open the app.
create or replace function public.abo_admin_tour_reset(p_user uuid)
returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if not public.abo_is_superadmin() then
    raise exception 'Not an administrator.' using errcode = '42501';
  end if;
  delete from public.tour_views where user_id = p_user;
  return found;
end $$;
revoke all on function public.abo_admin_tour_reset(uuid) from public, anon;
grant execute on function public.abo_admin_tour_reset(uuid) to authenticated;

NOTIFY pgrst, 'reload schema';
