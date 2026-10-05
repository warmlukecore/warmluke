-- What stuck (4c, 5 Oct).
--
-- A section a build made is kept when, a week on, it is still there and
-- in use: a row put in it since (on a store list, a field filled beside
-- one of its rows, which is a record too, 0128), or a rule on it that has
-- run. Counted by the week of the build, and by the designs that worked
-- it was shown (lib/examples.ts: the design reply's "examples", reached by
-- the build's "design"). Builds from before the build said which
-- sections it made ("made", /api/apply) are not counted.
--
-- And the library those examples come from beyond our own seeds: a kept
-- build proposed as an example in words, its shape only (what was asked,
-- what was built), never a store's rows, names or customers. Luke reads
-- one only once an administrator has read it and approved it. Nobody
-- reads or writes the table itself: the functions below are the way in.

create table if not exists public.design_examples (
  id uuid primary key default gen_random_uuid(),
  ask text not null check (char_length(ask) between 10 and 400),
  design text not null check (char_length(design) between 20 and 1500),
  why text not null default '' check (char_length(why) <= 300),
  tags text[] not null default '{}',
  status text not null default 'proposed' check (status in ('proposed', 'active', 'retired')),
  -- The build it came from: never read by Luke, never shown to a merchant.
  from_build uuid unique,
  proposed_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by uuid
);

alter table public.design_examples enable row level security;

-- The wall every table has: no write from a connected client's token.
drop policy if exists design_examples_oauth_no_insert on public.design_examples;
create policy design_examples_oauth_no_insert on public.design_examples
  as restrictive for insert to authenticated
  with check (not public.abo_is_oauth_client());
drop policy if exists design_examples_oauth_no_update on public.design_examples;
create policy design_examples_oauth_no_update on public.design_examples
  as restrictive for update to authenticated
  using (not public.abo_is_oauth_client());
drop policy if exists design_examples_oauth_no_delete on public.design_examples;
create policy design_examples_oauth_no_delete on public.design_examples
  as restrictive for delete to authenticated
  using (not public.abo_is_oauth_client());

-- Luke's read: the approved ones, their shape alone.
create or replace function public.abo_design_examples()
returns table (id uuid, ask text, design text, why text, tags text[])
language sql stable security definer set search_path = public as $$
  select e.id, e.ask, e.design, e.why, e.tags
  from public.design_examples e
  where e.status = 'active'
  order by e.decided_at desc nulls last
  limit 200
$$;
revoke all on function public.abo_design_examples() from public, anon;
grant execute on function public.abo_design_examples() to authenticated;

-- Each build that said what it made, and whether it stuck: its sections
-- all still there, and each with a row added or a rule run since.
create or replace function public.abo_built_and_kept(p_weeks integer)
returns table (build_id uuid, built_at timestamptz, old_enough boolean, kept boolean, examples jsonb, design_id uuid)
language sql stable security definer set search_path = public as $$
  with builds as (
    select
      m.id,
      m.created_at,
      coalesce(
        case when (m.payload ->> 'finished_at') ~ '^\d{4}-' then (m.payload ->> 'finished_at')::timestamptz end,
        m.created_at
      ) as done_at,
      array(select jsonb_array_elements_text(m.payload -> 'made'))::uuid[] as made,
      case when (m.payload ->> 'design') ~ '^[0-9a-f-]{36}$' then (m.payload ->> 'design')::uuid end as design_id
    from public.messages m
    where m.payload ->> 'type' = 'build'
      and m.payload ->> 'status' = 'built'
      and jsonb_typeof(m.payload -> 'made') = 'array'
      and jsonb_array_length(m.payload -> 'made') > 0
      and m.created_at > now() - make_interval(weeks => greatest(1, least(p_weeks, 52)))
  )
  select
    b.id,
    b.created_at,
    b.done_at < now() - interval '7 days',
    (
      select bool_and(
        exists (select 1 from public.modules mo where mo.id = x)
        and (
          exists (select 1 from public.records r where r.module_id = x and r.created_at > b.done_at)
          or exists (
            select 1 from public.automation_runs ar
            join public.automations a on a.id = ar.automation_id
            where a.module_id = x and ar.created_at > b.done_at
          )
        )
      )
      from unnest(b.made) x
    ),
    coalesce(d.payload -> 'examples', '[]'::jsonb),
    b.design_id
  from builds b
  left join public.messages d on d.id = b.design_id
$$;
revoke all on function public.abo_built_and_kept(integer) from public, anon, authenticated;

-- The console's screen: the rate by week, and by the example it was shown.
create or replace function public.abo_admin_what_stuck(p_weeks integer default 8)
returns jsonb
language plpgsql stable security definer set search_path = public, auth as $$
declare
  v jsonb;
begin
  if not public.abo_is_superadmin() then
    raise exception 'Not an administrator.' using errcode = '42501';
  end if;
  with j as (select * from public.abo_built_and_kept(p_weeks))
  select jsonb_build_object(
    'weeks', coalesce((
      select jsonb_agg(w order by w ->> 'week' desc) from (
        select jsonb_build_object(
          'week', date_trunc('week', built_at)::date,
          'built', count(*),
          'judged', count(*) filter (where old_enough),
          'kept', count(*) filter (where old_enough and kept)
        ) as w
        from j group by date_trunc('week', built_at)
      ) t), '[]'::jsonb),
    'examples', coalesce((
      select jsonb_agg(e order by (e ->> 'shown')::int desc) from (
        select jsonb_build_object(
          'example', ex,
          'shown', count(*),
          'judged', count(*) filter (where old_enough),
          'kept', count(*) filter (where old_enough and kept)
        ) as e
        from j, jsonb_array_elements_text(j.examples) ex
        group by ex
      ) t), '[]'::jsonb),
    'library', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', l.id, 'ask', l.ask, 'design', l.design, 'why', l.why, 'tags', l.tags,
        'status', l.status, 'proposed_at', l.proposed_at, 'decided_at', l.decided_at
      ) order by (l.status = 'proposed') desc, l.proposed_at desc)
      from public.design_examples l where l.status <> 'retired'), '[]'::jsonb)
  ) into v;
  return v;
end
$$;
revoke all on function public.abo_admin_what_stuck(integer) from public, anon;
grant execute on function public.abo_admin_what_stuck(integer) to authenticated;

-- Kept builds not yet proposed, with what was asked and what was designed,
-- for the curator to put in words (lib/curator.ts). The owner's words are
-- the last thing they said before the design.
create or replace function public.abo_admin_kept_builds(p_limit integer default 20)
returns table (build_id uuid, asked text, design jsonb)
language plpgsql stable security definer set search_path = public, auth as $$
begin
  if not public.abo_is_superadmin() then
    raise exception 'Not an administrator.' using errcode = '42501';
  end if;
  return query
  select k.build_id,
    (
      select u.content from public.messages u
      where u.conversation_id = d.conversation_id and u.role = 'user' and u.created_at <= d.created_at
      order by u.created_at desc limit 1
    ),
    d.payload
  from public.abo_built_and_kept(26) k
  join public.messages d on d.id = k.design_id
  where k.old_enough and k.kept
    and not exists (select 1 from public.design_examples e where e.from_build = k.build_id)
  order by k.built_at desc
  limit greatest(1, least(p_limit, 50));
end
$$;
revoke all on function public.abo_admin_kept_builds(integer) from public, anon;
grant execute on function public.abo_admin_kept_builds(integer) to authenticated;

-- A kept build proposed as an example, once: Luke does not read it yet.
create or replace function public.abo_admin_propose_example(p_build uuid, p_ask text, p_design text, p_tags text[])
returns void
language plpgsql security definer set search_path = public, auth as $$
begin
  if not public.abo_is_superadmin() then
    raise exception 'Not an administrator.' using errcode = '42501';
  end if;
  insert into public.design_examples (ask, design, tags, from_build)
  values (left(p_ask, 400), left(p_design, 1500), coalesce(p_tags, '{}'), p_build)
  on conflict (from_build) do nothing;
end
$$;
revoke all on function public.abo_admin_propose_example(uuid, text, text, text[]) from public, anon;
grant execute on function public.abo_admin_propose_example(uuid, text, text, text[]) to authenticated;

-- The administrator's word on one, with their edits: active, Luke reads it; retired, never again.
create or replace function public.abo_admin_decide_example(
  p_id uuid, p_status text, p_ask text, p_design text, p_why text, p_tags text[]
)
returns void
language plpgsql security definer set search_path = public, auth as $$
begin
  if not public.abo_is_superadmin() then
    raise exception 'Not an administrator.' using errcode = '42501';
  end if;
  if p_status not in ('active', 'retired') then
    raise exception 'An example is approved (active) or retired.' using errcode = '22023';
  end if;
  update public.design_examples set
    status = p_status,
    ask = coalesce(nullif(trim(p_ask), ''), ask),
    design = coalesce(nullif(trim(p_design), ''), design),
    why = coalesce(p_why, why),
    tags = coalesce(p_tags, tags),
    decided_at = now(),
    decided_by = auth.uid()
  where id = p_id;
end
$$;
revoke all on function public.abo_admin_decide_example(uuid, text, text, text, text, text[]) from public, anon;
grant execute on function public.abo_admin_decide_example(uuid, text, text, text, text, text[]) to authenticated;

NOTIFY pgrst, 'reload schema';
