-- Migration 0158: the team sees how Luke got there
--
-- Warmluke's own testing team, and its administrators, see under every
-- reply what it cost and how long it took, the conversation's id and
-- running total, and can hand any of it to whoever fixes things. An
-- administrator opens any conversation by its id, or by a turn's, with
-- every turn's trace beside it; each opening is written down, as support
-- access is. Everybody else sees none of it, and can read none of it.
--
--   who is on the team               account_settings.tester, abo_is_tester,
--                                    abo_admin_set_tester
--   what a reply cost, kept private  turn_traces read by the team only;
--                                    a reply's usage kept off the message
--                                    unless its asker is on the team
--   the administrator's reader       abo_admin_conversations, abo_admin_conversation

-- ── Who is on the team ───────────────────────────────────────
alter table public.account_settings add column if not exists tester boolean not null default false;

-- An administrator is on the team without being marked.
create or replace function public.abo_is_tester() returns boolean
language sql stable security definer set search_path = public as $$
  select auth.uid() is not null
     and coalesce((select s.is_superadmin or s.tester from public.account_settings s where s.user_id = auth.uid()), false)
$$;
revoke all on function public.abo_is_tester() from public, anon;
grant execute on function public.abo_is_tester() to authenticated;

alter table public.admin_account_audit drop constraint if exists admin_account_audit_action_allowed;
alter table public.admin_account_audit add constraint admin_account_audit_action_allowed check (
  action in ('set_feature', 'set_turns', 'set_unlimited', 'reset_turns', 'suspend', 'restore', 'delete', 'set_luke',
             'set_tester', 'view_conversation')
);

create or replace function public.abo_admin_set_tester(p_user uuid, p_on boolean) returns boolean
language plpgsql security definer set search_path = public as $$
declare v_was boolean;
begin
  if not public.abo_is_superadmin() then
    raise exception 'Not an administrator.' using errcode = '42501';
  end if;
  if public.abo_is_oauth_client() then
    raise exception 'Change this in Warmluke itself.' using errcode = '42501';
  end if;
  if p_on is null then
    raise exception 'On or off.' using errcode = '22023';
  end if;
  insert into public.account_settings (user_id) values (p_user) on conflict (user_id) do nothing;
  select tester into v_was from public.account_settings where user_id = p_user for update;
  if v_was is distinct from p_on then
    update public.account_settings set tester = p_on, updated_at = now() where user_id = p_user;
    insert into public.admin_account_audit (actor_user_id, target_user_id, action, old_value, new_value)
    values (auth.uid(), p_user, 'set_tester', jsonb_build_object('tester', v_was), jsonb_build_object('tester', p_on));
  end if;
  return p_on;
end $$;
revoke all on function public.abo_admin_set_tester(uuid, boolean) from public, anon;
grant execute on function public.abo_admin_set_tester(uuid, boolean) to authenticated;

-- 0127's reader for the account's dialog, saying whether they are on the team.
create or replace function public.abo_admin_luke(p_user uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_out jsonb;
begin
  if not public.abo_is_superadmin() then
    raise exception 'Not an administrator.' using errcode = '42501';
  end if;
  select jsonb_build_object('models', to_jsonb(luke_models), 'shows', luke_shows, 'tester', tester)
    into v_out
    from public.account_settings
   where user_id = p_user;
  return coalesce(v_out, jsonb_build_object('models', null, 'shows', 'nothing', 'tester', false));
end $$;

-- ── What a reply cost, kept private ──────────────────────────
-- What a reply says under it was "cost" for everybody unless changed. It
-- is nothing now, for a new account and for every account that is not
-- the team's; an administrator can still choose otherwise for one.
alter table public.account_settings alter column luke_shows set default 'nothing';
update public.account_settings
   set luke_shows = 'nothing', updated_at = now()
 where luke_shows <> 'nothing' and not is_superadmin and not tester;

-- A turn's trace holds what it cost: the team reads it, a project's own
-- people do not. Luke still writes it on the owner's own client.
drop policy if exists turn_traces_member_all on public.turn_traces;
-- 0140's, which let the owner read everything back.
drop policy if exists turn_traces_owner_all on public.turn_traces;
drop policy if exists turn_traces_member_write on public.turn_traces;
create policy turn_traces_member_write on public.turn_traces
  for insert to authenticated
  with check (public.abo_can_use(project_id));
drop policy if exists turn_traces_team_read on public.turn_traces;
create policy turn_traces_team_read on public.turn_traces
  for select to authenticated
  using (public.abo_can_use(project_id) and public.abo_is_tester());

-- And off the replies already kept, where the project is not the team's:
-- what a turn cost was written onto every reply until now.
update public.messages m
   set payload = m.payload - 'usage'
  from public.conversations c
  join public.projects p on p.id = c.project_id
  left join public.account_settings s on s.user_id = p.owner_id
 where m.conversation_id = c.id
   and m.payload ? 'usage'
   and not coalesce(s.is_superadmin or s.tester, false);

-- ── The administrator's reader ───────────────────────────────
create index if not exists turn_traces_conversation on public.turn_traces (conversation_id, created_at);
create index if not exists turn_traces_turn on public.turn_traces (turn_id);
create index if not exists conversations_newest on public.conversations (updated_at desc);

-- Conversations across every account: the latest, or those that went
-- wrong, cost most or took longest, over the last days asked for; or the
-- one a pasted id names, whether a conversation's, a message's or a
-- turn's; or those whose title, project, owner or store holds the words.
-- Counted here, so the page reads a page of rows however many there are.
create or replace function public.abo_admin_conversations(
  p_query  text default null,
  p_filter text default 'recent',
  p_days   integer default 30,
  p_limit  integer default 50,
  p_before timestamptz default null
) returns jsonb
language plpgsql stable security definer set search_path = public, auth as $$
declare
  v_q     text := nullif(btrim(coalesce(p_query, '')), '');
  v_since timestamptz := now() - make_interval(days => least(greatest(coalesce(p_days, 30), 1), 365));
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_whole boolean := false;
  v_id    uuid;
  v_out   jsonb;
begin
  if not public.abo_is_superadmin() then
    raise exception 'Not an administrator.' using errcode = '42501';
  end if;
  if p_filter is null or p_filter not in ('recent', 'problems', 'costly', 'slow') then
    raise exception 'No such view.' using errcode = '22023';
  end if;
  -- An id pasted whole: the conversation it is, or the one its message or turn is in.
  if v_q ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    v_whole := true;
    v_id := coalesce(
      (select c.id from public.conversations c where c.id = v_q::uuid),
      (select m.conversation_id from public.messages m where m.id = v_q::uuid),
      (select t.conversation_id from public.turn_traces t where t.turn_id = v_q::uuid limit 1)
    );
  end if;

  with picked as (
    select c.id, c.title, c.project_id, c.created_at, c.updated_at
      from public.conversations c
      join public.projects p on p.id = c.project_id
      left join auth.users u on u.id = p.owner_id
     where case
             when v_whole then c.id = v_id
             else c.updated_at >= v_since
                  and (p_before is null or c.updated_at < p_before)
                  and (v_q is null
                       or c.title ilike '%' || v_q || '%'
                       or p.name ilike '%' || v_q || '%'
                       or u.email ilike '%' || v_q || '%'
                       or exists (select 1 from public.stores s
                                   where s.project_id = p.id and s.shop_domain ilike '%' || v_q || '%'))
           end
  ),
  agg as (
    select t.conversation_id,
           count(*) as turns,
           coalesce(sum((t.usage ->> 'usd')::numeric), 0) as usd,
           coalesce(sum(tok.input), 0) as input,
           coalesce(sum(tok.output), 0) as output,
           coalesce(max(t.took_ms), 0) as slowest,
           count(*) filter (
             where t.repairs > 0
                or (jsonb_typeof(t.repair_errors) = 'array' and jsonb_array_length(t.repair_errors) > 0)
                or (jsonb_typeof(t.unmet) = 'array' and jsonb_array_length(t.unmet) > 0)
                -- The critic sent it back, or found something it left out.
                or (t.critic ->> 'verdict') = 'redo'
                or coalesce((t.critic ->> 'missing')::integer, 0) > 0
           ) as troubled
      from public.turn_traces t
      left join lateral (
        select sum((x ->> 'input')::bigint) as input, sum((x ->> 'output')::bigint) as output
          from jsonb_array_elements(case when jsonb_typeof(t.usage -> 'uses') = 'array' then t.usage -> 'uses' else '[]'::jsonb end) x
      ) tok on true
     where t.conversation_id in (select id from picked)
     group by t.conversation_id
  )
  select coalesce(jsonb_agg(r.j order by r.n), '[]'::jsonb) into v_out
    from (
      select row_number() over (
               order by case when p_filter = 'costly' then a.usd end desc nulls last,
                        case when p_filter = 'slow' then a.slowest end desc nulls last,
                        c.updated_at desc) as n,
             jsonb_build_object(
               'id', c.id, 'title', c.title, 'created_at', c.created_at, 'updated_at', c.updated_at,
               'project', jsonb_build_object('id', p.id, 'name', p.name),
               'owner', u.email,
               'shop', (select s.shop_domain from public.stores s where s.project_id = p.id
                         order by s.connected_at desc nulls last limit 1),
               'turns', coalesce(a.turns, 0), 'usd', coalesce(a.usd, 0),
               'input', coalesce(a.input, 0), 'output', coalesce(a.output, 0),
               'slowest_ms', coalesce(a.slowest, 0), 'troubled', coalesce(a.troubled, 0)) as j
        from picked c
        join public.projects p on p.id = c.project_id
        left join auth.users u on u.id = p.owner_id
        left join agg a on a.conversation_id = c.id
       where p_filter <> 'problems' or coalesce(a.troubled, 0) > 0
       order by n
       limit v_limit
    ) r;
  return v_out;
end $$;
revoke all on function public.abo_admin_conversations(text, text, integer, integer, timestamptz) from public, anon;
grant execute on function public.abo_admin_conversations(text, text, integer, integer, timestamptz) to authenticated;

-- One conversation whole: whose, which project and store, its messages
-- (the latest p_limit, oldest first) and every turn's trace. Opening it
-- is written to the account's trail, as support access is.
create or replace function public.abo_admin_conversation(p_id uuid, p_limit integer default 300)
returns jsonb
language plpgsql security definer set search_path = public, auth as $$
declare
  v_c     public.conversations;
  v_p     public.projects;
  v_limit integer := least(greatest(coalesce(p_limit, 300), 1), 1000);
begin
  if not public.abo_is_superadmin() then
    raise exception 'Not an administrator.' using errcode = '42501';
  end if;
  select * into v_c from public.conversations where id = p_id;
  if not found then
    return null;
  end if;
  select * into v_p from public.projects where id = v_c.project_id;
  insert into public.admin_account_audit (actor_user_id, target_user_id, action, old_value, new_value)
  values (auth.uid(), v_p.owner_id, 'view_conversation', '{}'::jsonb, jsonb_build_object('conversation', p_id));
  return jsonb_build_object(
    'conversation', jsonb_build_object('id', v_c.id, 'title', v_c.title,
                                       'created_at', v_c.created_at, 'updated_at', v_c.updated_at),
    'project', jsonb_build_object('id', v_p.id, 'name', v_p.name),
    'owner', jsonb_build_object('id', v_p.owner_id,
                                'email', (select u.email from auth.users u where u.id = v_p.owner_id)),
    'store', (select jsonb_build_object('shop', s.shop_domain, 'status', s.status)
                from public.stores s where s.project_id = v_p.id
               order by s.connected_at desc nulls last limit 1),
    'messages_total', (select count(*) from public.messages where conversation_id = p_id),
    -- A raw reply can be long: its first 20,000 characters, the parsed reply whole.
    'messages', coalesce((
      select jsonb_agg(jsonb_build_object('id', m.id, 'role', m.role, 'content', left(m.content, 20000),
                                          'payload', m.payload, 'created_at', m.created_at)
                       order by m.created_at)
        from (select * from public.messages where conversation_id = p_id
               order by created_at desc limit v_limit) m), '[]'::jsonb),
    'traces', coalesce((
      select jsonb_agg(to_jsonb(t) - 'project_id' order by t.created_at)
        from public.turn_traces t where t.conversation_id = p_id), '[]'::jsonb));
end $$;
revoke all on function public.abo_admin_conversation(uuid, integer) from public, anon;
grant execute on function public.abo_admin_conversation(uuid, integer) to authenticated;

NOTIFY pgrst, 'reload schema';
