-- Migration 0201: Luke remembers what hurts, and asks whether it helped
--
-- What Luke knows (0131) is facts about a business: the courier, who
-- packs. What the owner says HURTS (COD calls eat two hours a day, wrong
-- sizes go out) is another thing: the reason they came, and the measure
-- of whether anything built helped. Kept here, in their words, with what
-- it costs them when they said it (9 Oct, task 72).
--
-- - merchant_problems: one row a problem, written after a turn by the
--   same small model that writes the facts (lib/memory), on the owner's
--   own client. Open until the owner says how it went; struck ("dropped")
--   by them from the list. The newest twenty kept a business.
-- - A problem is taken as answered by a build when one is made later in
--   the same conversation. A week after that build, the bell asks once:
--   better, the same, or worse (abo_problem_check_ins, abo_answer_problem).
--   The answer is the owner's alone, in Warmluke, never their AI's.
-- - Every later turn reads what still hurts and how what was built went,
--   so Luke builds on it instead of offering the same thing again.
-- - The console's learning page for a store reads them too.
--
-- ponytail: a fix made in another conversation is not linked to the
-- problem; link by the build's own words if owners solve one problem in
-- several threads.

create table if not exists public.merchant_problems (
  id              uuid primary key default gen_random_uuid(),
  project_id      uuid not null references public.projects(id) on delete cascade,
  conversation_id uuid references public.conversations(id) on delete set null,
  problem         text not null check (char_length(problem) between 3 and 200),
  -- What it costs them, as they said it: "two hours a day", "₹15,000 a month".
  cost            text check (cost is null or char_length(cost) <= 120),
  status          text not null default 'open' check (status in ('open', 'better', 'same', 'worse', 'dropped')),
  answered_at     timestamptz,
  created_at      timestamptz not null default now(),
  -- Said twice is one problem.
  unique (project_id, problem)
);
create index if not exists merchant_problems_project_newest on public.merchant_problems (project_id, created_at desc);

alter table public.merchant_problems enable row level security;

-- Whoever may use the project reads and strikes them; the writer is the
-- server on the owner's own client, so the same policy covers it.
drop policy if exists merchant_problems_member_all on public.merchant_problems;
create policy merchant_problems_member_all on public.merchant_problems
  for all to authenticated
  using (public.abo_can_use(project_id))
  with check (public.abo_can_use(project_id));

-- The wall every table has: no write from a connected client's token.
drop policy if exists merchant_problems_oauth_no_insert on public.merchant_problems;
create policy merchant_problems_oauth_no_insert on public.merchant_problems
  as restrictive for insert to authenticated
  with check (not public.abo_is_oauth_client());
drop policy if exists merchant_problems_oauth_no_update on public.merchant_problems;
create policy merchant_problems_oauth_no_update on public.merchant_problems
  as restrictive for update to authenticated
  using (not public.abo_is_oauth_client());
drop policy if exists merchant_problems_oauth_no_delete on public.merchant_problems;
create policy merchant_problems_oauth_no_delete on public.merchant_problems
  as restrictive for delete to authenticated
  using (not public.abo_is_oauth_client());

-- Twenty a business: the oldest go as new ones come.
create or replace function public.merchant_problems_keep_newest()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  delete from public.merchant_problems n
   where n.project_id = new.project_id
     and n.id in (
       select id from public.merchant_problems
        where project_id = new.project_id
        order by created_at desc, id desc
       offset 20
     );
  return null;
end $$;
revoke execute on function public.merchant_problems_keep_newest() from public, anon, authenticated;
drop trigger if exists merchant_problems_keep_newest on public.merchant_problems;
create trigger merchant_problems_keep_newest
  after insert on public.merchant_problems
  for each row execute function public.merchant_problems_keep_newest();

-- ── A week after a fix: did it help? ─────────────────────────
-- The open problems of the caller's own conversations whose first build
-- after them, with a section still there, was made a week ago or more
-- (and within sixty days): asked once each, the newest three.
create or replace function public.abo_problem_check_ins(p_project uuid)
returns jsonb
language sql stable security definer set search_path = public as $$
  with fixed as (
    select pr.id, pr.problem, pr.cost, pr.conversation_id, b.done_at, b.made
      from public.merchant_problems pr
      join public.conversations c on c.id = pr.conversation_id
      join public.projects p on p.id = c.project_id
      join lateral (
        select m.created_at,
               coalesce(case when (m.payload ->> 'finished_at') ~ '^\d{4}-'
                             then (m.payload ->> 'finished_at')::timestamptz end, m.created_at) as done_at,
               array(select jsonb_array_elements_text(m.payload -> 'made'))::uuid[] as made
          from public.messages m
         where m.conversation_id = pr.conversation_id
           and m.payload ->> 'type' = 'build' and m.payload ->> 'status' = 'built'
           and jsonb_typeof(m.payload -> 'made') = 'array' and jsonb_array_length(m.payload -> 'made') > 0
           and m.created_at > pr.created_at
         order by m.created_at asc
         limit 1
      ) b on true
     where pr.project_id = p_project
       and pr.status = 'open'
       and public.abo_can_use(p_project)
       and coalesce(c.created_by, p.owner_id) = auth.uid()
       and b.done_at between now() - interval '60 days' and now() - interval '7 days'
       and exists (select 1 from public.modules mo where mo.id = any(b.made))
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'problem_id', f.id,
           'problem', f.problem,
           'cost', f.cost,
           'built_at', f.done_at,
           'conversation_id', f.conversation_id,
           'sections', (select coalesce(jsonb_agg(mo.nav_label order by mo.sort_order), '[]'::jsonb)
                          from public.modules mo where mo.id = any(f.made)))
         order by f.done_at desc), '[]'::jsonb)
    from (select * from fixed order by done_at desc limit 3) f
$$;
revoke all on function public.abo_problem_check_ins(uuid) from public, anon;
grant execute on function public.abo_problem_check_ins(uuid) to authenticated;

-- The owner's answer, once: better, the same, or worse. Theirs to give,
-- in Warmluke: a connected assistant cannot say how their day went.
create or replace function public.abo_answer_problem(p_problem uuid, p_answer text)
returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_project uuid;
begin
  if p_answer is null or p_answer not in ('better', 'same', 'worse') then
    raise exception 'An answer is better, same or worse.' using errcode = '22023';
  end if;
  if public.abo_is_oauth_client() then
    raise exception 'The owner answers this in Warmluke.' using errcode = '42501';
  end if;
  select project_id into v_project from public.merchant_problems where id = p_problem;
  if v_project is null or not public.abo_can_use(v_project) then
    raise exception 'Not a problem of yours.' using errcode = '42501';
  end if;
  update public.merchant_problems
     set status = p_answer, answered_at = now()
   where id = p_problem and status = 'open';
  return found;
end $$;
revoke all on function public.abo_answer_problem(uuid, text) from public, anon;
grant execute on function public.abo_answer_problem(uuid, text) to authenticated;

-- ── The console's learning page, with what hurts and what is known ──
-- 0176's body, with 'problems' and 'notes' after it.
create or replace function public.abo_admin_learning_project(p_project uuid, p_days integer default 90) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_since timestamptz := now() - make_interval(days => least(greatest(coalesce(p_days, 90), 1), 365));
begin
  if not public.abo_is_superadmin() then
    raise exception 'This page is for administrators.' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'project', (select jsonb_build_object('id', p.id, 'name', p.name) from public.projects p where p.id = p_project),
    -- ponytail: the newest 500, all statuses; thirty are active, the rest
    -- retired or struck, and a page of retirees past that says nothing new.
    'skills', coalesce((
      select jsonb_agg(to_jsonb(s) order by s.updated_at desc)
        from (select * from public.luke_skills where project_id = p_project
               order by updated_at desc limit 500) s), '[]'::jsonb),
    -- A patch's version is counted, not trusted to the writer's detail:
    -- each patch is the next one.
    'events', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.at desc)
        from (select e.at, e.event, e.skill_id, s.title, s.kind, e.detail, e.conversation_id,
                     case when e.event = 'patched' and e.skill_id is not null then
                       1 + (select count(*) from public.luke_learning_events p
                             where p.skill_id = e.skill_id and p.event = 'patched' and p.at <= e.at)
                     end as version
                from public.luke_learning_events e
                left join public.luke_skills s on s.id = e.skill_id
               where e.project_id = p_project and e.at > v_since
               order by e.at desc
               limit 300) x), '[]'::jsonb),
    'feedback', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.at desc)
        from (select f.created_at as at, f.verdict, f.note, f.message_id, m.conversation_id
                from public.reply_feedback f
                left join public.messages m on m.id = f.message_id
               where f.project_id = p_project and f.created_at > v_since
               order by f.created_at desc
               limit 100) x), '[]'::jsonb),
    -- What hurts them, and how what was built went (0201).
    'problems', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.created_at desc)
        from (select pr.id, pr.problem, pr.cost, pr.status, pr.answered_at, pr.created_at, pr.conversation_id
                from public.merchant_problems pr
               where pr.project_id = p_project
               order by pr.created_at desc
               limit 20) x), '[]'::jsonb),
    -- What Luke knows about the business (0131).
    'notes', coalesce((
      select jsonb_agg(to_jsonb(x) order by x.created_at desc)
        from (select n.note, n.created_at from public.merchant_notes n
               where n.project_id = p_project
               order by n.created_at desc
               limit 40) x), '[]'::jsonb));
end $$;
revoke all on function public.abo_admin_learning_project(uuid, integer) from public, anon;
grant execute on function public.abo_admin_learning_project(uuid, integer) to authenticated;

NOTIFY pgrst, 'reload schema';
