-- A team that builds.
--
-- Until now a team ran the app and only its owner built it. The owner
-- asked for a switch on each person: this one may build, with Luke and
-- with their own AI, and what they build is theirs. So:
--
--   project_members.can_build   the switch, the owner's to flip
--   abo_can_build(project)      the owner, or a seat with the switch on
--   abo_may_change_module(m)    the owner, or whoever built it while
--                               they may build and can still see it
--
-- A builder changes only what they built: every door that changes how
-- something is built (abo_build, the tables behind the section screens,
-- rules, sharing) asks abo_may_change_module. The owner still sees and
-- changes everything, and a hide from the owner still wins: what the
-- owner hides from its builder, that builder can no longer change.
--
-- Their conversations with Luke and their AI's requests are theirs
-- (created_by, requested_by); the owner reads them all. And a design
-- made by a builder is paid from the owner's included designs, not
-- their own: the owner gave them the switch.
--
-- Callers: src/app/api/chat/route.ts, src/app/api/mcp/route.ts,
-- src/components/AppShell.tsx, src/components/ProjectSettings.tsx,
-- src/components/ShareSection.tsx, src/lib/sharing.ts,
-- scripts/check-rls.mjs.

-- ── The switch ───────────────────────────────────────────────

alter table public.project_members add column if not exists can_build boolean not null default false;
comment on column public.project_members.can_build is 'May build with Luke and their own AI; what they build is theirs (0146).';

create or replace function public.abo_can_build(p uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.abo_owns(p)
      or exists (select 1 from public.project_members
                  where project_id = p and user_id = auth.uid() and can_build);
$$;

-- A section and everything inside it is its top section's: who built
-- the top one, and whether it is hidden from them, decide.
create or replace function public.abo_may_change_module(p_module uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.modules c
      join public.modules m on m.id = coalesce(c.parent_id, c.id)
     where c.id = p_module
       and (public.abo_owns(m.project_id)
            or (m.created_by = auth.uid()
                and public.abo_can_build(m.project_id)
                and public.abo_can_see_module(m.id))));
$$;

-- For policies on tables they cannot read the rows of: a policy on
-- modules that selected from modules would go round in a circle, and
-- a builder reads only their own seat.
create or replace function public.abo_module_project(p_module uuid) returns uuid
language sql stable security definer set search_path = public as $$
  select project_id from public.modules where id = p_module;
$$;
create or replace function public.abo_seat_of_module(p_member uuid, p_module uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.project_members pm
      join public.modules m on m.project_id = pm.project_id
     where pm.id = p_member and m.id = p_module);
$$;

-- The people a builder can share with: the seats, never their tokens.
create or replace function public.abo_teammates(p_project uuid)
returns table (id uuid, user_id uuid, email text, full_name text, team_role text,
               joined_at timestamptz, can_see_store boolean)
language sql stable security definer set search_path = public as $$
  select pm.id, pm.user_id, pm.email, pm.full_name, pm.team_role, pm.joined_at, pm.can_see_store
    from public.project_members pm
   where pm.project_id = p_project and public.abo_can_build(p_project)
   order by pm.created_at;
$$;

revoke all on function public.abo_can_build(uuid) from public, anon;
revoke all on function public.abo_may_change_module(uuid) from public, anon;
revoke all on function public.abo_module_project(uuid) from public, anon;
revoke all on function public.abo_seat_of_module(uuid, uuid) from public, anon;
revoke all on function public.abo_teammates(uuid) from public, anon;
grant execute on function public.abo_can_build(uuid) to authenticated;
grant execute on function public.abo_may_change_module(uuid) to authenticated;
grant execute on function public.abo_module_project(uuid) to authenticated;
grant execute on function public.abo_seat_of_module(uuid, uuid) to authenticated;
grant execute on function public.abo_teammates(uuid) to authenticated;

-- ── What they built, at the tables behind the screens ────────
-- Every policy here is to authenticated: the code worker reads as anon
-- and must never be asked a question it cannot run (0142).

drop policy if exists modules_builder_insert on public.modules;
create policy modules_builder_insert on public.modules
  for insert to authenticated
  with check (created_by = auth.uid()
              and public.abo_can_build(project_id)
              and (parent_id is null
                   or (public.abo_module_project(parent_id) = project_id
                       and public.abo_may_change_module(parent_id)))
              and (source_table is null or public.abo_can_open_store(project_id)));

drop policy if exists modules_builder_update on public.modules;
create policy modules_builder_update on public.modules
  for update to authenticated
  using (public.abo_may_change_module(id))
  with check (created_by = auth.uid()
              and public.abo_can_build(project_id)
              and (parent_id is null
                   or (public.abo_module_project(parent_id) = project_id
                       and public.abo_may_change_module(parent_id)))
              and (source_table is null or public.abo_can_open_store(project_id)));

-- The row they just built, read back in the same statement: the gate
-- the others read by (abo_can_see_module) looks the section up, and a
-- statement does not see a row it is still inserting.
create or replace function public.abo_hidden_from_me(p_module uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.module_hides h
      join public.project_members pm on pm.id = h.member_id
     where h.module_id = p_module and pm.user_id = auth.uid());
$$;
revoke all on function public.abo_hidden_from_me(uuid) from public, anon;
grant execute on function public.abo_hidden_from_me(uuid) to authenticated;

drop policy if exists modules_builder_read on public.modules;
create policy modules_builder_read on public.modules
  for select to authenticated
  using (created_by = auth.uid()
         and public.abo_can_build(project_id)
         and not public.abo_hidden_from_me(coalesce(parent_id, id)));

drop policy if exists modules_builder_delete on public.modules;
create policy modules_builder_delete on public.modules
  for delete to authenticated
  using (public.abo_may_change_module(id));

drop policy if exists ui_schemas_builder_insert on public.ui_schemas;
create policy ui_schemas_builder_insert on public.ui_schemas
  for insert to authenticated
  with check (public.abo_may_change_module(module_id));

drop policy if exists records_builder_delete on public.records;
create policy records_builder_delete on public.records
  for delete to authenticated
  using (public.abo_may_change_module(module_id));

-- A rule on a section they built. A rule over the whole app (no
-- section) stays the owner's.
drop policy if exists automations_builder_all on public.automations;
create policy automations_builder_all on public.automations
  for all to authenticated
  using (module_id is not null and public.abo_may_change_module(module_id))
  with check (module_id is not null
              and public.abo_may_change_module(module_id)
              and public.abo_module_project(module_id) = project_id);

drop policy if exists automation_runs_builder_read on public.automation_runs;
create policy automation_runs_builder_read on public.automation_runs
  for select to authenticated
  using (exists (select 1 from public.automations a
                  where a.id = automation_runs.automation_id
                    and a.module_id is not null
                    and public.abo_may_change_module(a.module_id)));

-- Sharing what they built: with the team, by name, and switching one
-- person off. A hide they did not put there is not theirs to lift, and
-- they cannot hide their own section from themselves.
drop policy if exists module_shares_builder_all on public.module_shares;
create policy module_shares_builder_all on public.module_shares
  for all to authenticated
  using (public.abo_may_change_module(module_id))
  with check (public.abo_may_change_module(module_id) and public.abo_seat_of_module(member_id, module_id));

alter table public.module_hides add column if not exists hidden_by uuid default auth.uid();
comment on column public.module_hides.hidden_by is 'Who hid it (0146); null for the owner''s from before. A builder lifts only their own.';

drop policy if exists module_hides_builder_read on public.module_hides;
create policy module_hides_builder_read on public.module_hides
  for select to authenticated
  using (public.abo_may_change_module(module_id));
drop policy if exists module_hides_builder_insert on public.module_hides;
create policy module_hides_builder_insert on public.module_hides
  for insert to authenticated
  with check (hidden_by = auth.uid()
              and public.abo_may_change_module(module_id)
              and public.abo_seat_of_module(member_id, module_id)
              and not exists (select 1 from public.project_members pm
                               where pm.id = member_id and pm.user_id = auth.uid()));
drop policy if exists module_hides_builder_delete on public.module_hides;
create policy module_hides_builder_delete on public.module_hides
  for delete to authenticated
  using (hidden_by = auth.uid() and public.abo_may_change_module(module_id));

-- ── Their conversations, their AI's requests ─────────────────

alter table public.conversations add column if not exists created_by uuid default auth.uid();
comment on column public.conversations.created_by is 'Who talks in it (0146); the owner reads every one on their app.';
update public.conversations c
   set created_by = p.owner_id
  from public.projects p
 where p.id = c.project_id and c.created_by is null;

drop policy if exists conversations_builder_all on public.conversations;
create policy conversations_builder_all on public.conversations
  for all to authenticated
  using (created_by = auth.uid() and public.abo_can_build(project_id))
  with check (created_by = auth.uid() and public.abo_can_build(project_id));

drop policy if exists messages_builder_all on public.messages;
create policy messages_builder_all on public.messages
  for all to authenticated
  using (exists (select 1 from public.conversations c
                  where c.id = messages.conversation_id
                    and c.created_by = auth.uid() and public.abo_can_build(c.project_id)))
  with check (exists (select 1 from public.conversations c
                       where c.id = messages.conversation_id
                         and c.created_by = auth.uid() and public.abo_can_build(c.project_id)));

drop policy if exists build_requests_builder_read on public.build_requests;
create policy build_requests_builder_read on public.build_requests
  for select to authenticated
  using (requested_by = auth.uid() and public.abo_can_build(project_id));
drop policy if exists build_requests_builder_update on public.build_requests;
create policy build_requests_builder_update on public.build_requests
  for update to authenticated
  using (requested_by = auth.uid() and public.abo_can_build(project_id))
  with check (requested_by = auth.uid() and public.abo_can_build(project_id));

-- ── Paid from the owner's included designs ───────────────────
-- 0074's, with the payer worked out first. Called with no project it
-- is what it was: the caller pays.
-- ponytail: the owner's own Luke switch is not asked here; a builder's
-- turn is gated by their own account's switch (abo_feature).

drop function if exists public.abo_spend_turn();
create or replace function public.abo_spend_turn(p_project uuid default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_used integer;
  v_free integer;
  v_unlimited boolean;
  v_id uuid := gen_random_uuid();
  v_payer uuid := auth.uid();
begin
  if auth.uid() is null then
    raise exception 'Not signed in.' using errcode = '42501';
  end if;
  if p_project is not null and not public.abo_owns(p_project) then
    if not public.abo_can_build(p_project) then
      raise exception 'Only the people the owner lets build can ask Luke here.' using errcode = '42501';
    end if;
    select owner_id into v_payer from public.projects where id = p_project;
  end if;

  insert into public.account_settings (user_id)
  values (v_payer)
  on conflict (user_id) do nothing;

  update public.account_settings
     set turns_used     = turns_used + 1,
         last_spend_at  = now(),
         last_spend_id  = v_id,
         last_refund_at = null,
         updated_at     = now()
   where user_id = v_payer
     and (turns_unlimited or turns_used < free_turns)
  returning turns_used, free_turns, turns_unlimited
       into v_used, v_free, v_unlimited;

  if v_used is null then
    select turns_used, free_turns, turns_unlimited
      into v_used, v_free, v_unlimited
      from public.account_settings
     where user_id = v_payer;
    return jsonb_build_object(
      'ok', false, 'used', v_used, 'free', v_free,
      'unlimited', v_unlimited
    );
  end if;

  return jsonb_build_object(
    'ok', true, 'used', v_used, 'free', v_free,
    'unlimited', v_unlimited, 'spend_id', v_id
  );
end $$;
revoke all on function public.abo_spend_turn(uuid) from public, anon;
grant execute on function public.abo_spend_turn(uuid) to authenticated;

-- 0045's, and a builder gives back a spend they made on the owner's.
create or replace function public.abo_refund_turn(p_spend uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_used integer;
begin
  if auth.uid() is null then
    raise exception 'Not signed in.' using errcode = '42501';
  end if;
  if p_spend is null then
    return jsonb_build_object('refunded', false);
  end if;

  update public.account_settings a
     set turns_used     = greatest(turns_used - 1, 0),
         last_refund_at = now(),
         updated_at     = now()
   where (a.user_id = auth.uid()
          or exists (select 1 from public.project_members pm
                       join public.projects p on p.id = pm.project_id
                      where pm.user_id = auth.uid() and pm.can_build and p.owner_id = a.user_id))
     and turns_used > 0
     and last_spend_id = p_spend
     -- One refund per spend…
     and last_refund_at is null
     -- …and only for a spend that just happened. A turn takes seconds;
     -- anything older is somebody trying their luck.
     and last_spend_at > now() - interval '5 minutes'
  returning turns_used into v_used;

  return jsonb_build_object('refunded', v_used is not null, 'used', v_used);
end $$;

-- ── The doors, rebuilt from their newest versions ────────────
-- abo_build from 0085, abo_approve_request from 0076, abo_client_ask
-- and abo_client_settle from 0139: copied by a script, with the owner
-- gate widened to a builder and each step asking whose it is.

create or replace function public.abo_build(
  p_project uuid,
  p_request uuid,
  p_op      text,
  p_payload jsonb
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_id     uuid;
  v_client text := nullif(auth.jwt() ->> 'client_id', '');
  v_n      integer;
  v_source text;
  v_was_def jsonb;
  v_was_on  boolean;
  v_ids     jsonb;
  v_was     jsonb;
  v_failed integer;
  v_status text;
  v_owner  boolean;
begin
  if auth.uid() is null then
    raise exception 'Not signed in.' using errcode = '42501';
  end if;
  v_owner := public.abo_owns(p_project);
  if not v_owner and not public.abo_can_build(p_project) then
    raise exception 'Not your project.' using errcode = '42501';
  end if;

  -- Someone the owner lets build changes only what they built (0146).
  if not v_owner then
    if p_op in ('module_update', 'module_delete', 'schema_insert', 'records_insert',
                'automation_insert', 'automation_delete')
       and not coalesce(public.abo_may_change_module(nullif(p_payload ->> 'module_id', '')::uuid), false) then
      raise exception 'That section is not yours to change.' using errcode = '42501';
    end if;
    if p_op in ('module_insert', 'module_update')
       and nullif(p_payload ->> 'parent_id', '') is not null
       and not (public.abo_may_change_module((p_payload ->> 'parent_id')::uuid)
                and public.abo_module_project((p_payload ->> 'parent_id')::uuid) = p_project) then
      raise exception 'That section is not yours to change.' using errcode = '42501';
    end if;
    if p_op = 'module_insert' and nullif(p_payload ->> 'source_table', '') is not null
       and not public.abo_can_open_store(p_project) then
      raise exception 'The owner has not let you see the store.' using errcode = '42501';
    end if;
    if p_op like 'request\_%' and not exists (
      select 1 from public.build_requests
       where id = p_request and project_id = p_project and requested_by = auth.uid()
    ) then
      raise exception 'That request is not yours.' using errcode = '42501';
    end if;
  end if;

  if v_client is not null then
    -- Building is allowed against an approved request. Removing a
    -- section is not, with or without one: it is the step nobody can
    -- undo, and the app asks for the section's name typed out.
    if p_op = 'module_delete' then
      raise exception 'Removing a section has to be done in Warmluke.' using errcode = '42501';
    end if;
    if p_request is null then
      raise exception 'This needs an approved request.' using errcode = '42501';
    end if;
    if not exists (
      select 1 from public.build_requests
       where id = p_request
         and project_id = p_project
         and status in ('pending', 'building')
         and client_id is not distinct from v_client
         -- The line 0033 was missing. "Pending" is the word for
         -- nobody having answered yet; a stamp means somebody did.
         and approved_at is not null
         and (v_owner or requested_by = auth.uid())
    ) then
      raise exception 'Nobody has approved that request.' using errcode = '42501';
    end if;
  end if;

  if p_op = 'module_insert' then
    v_source := nullif(p_payload ->> 'source_table', '');
    if v_source is not null and not public.abo_is_store_table(v_source) then
      raise exception 'No store table called "%".', v_source using errcode = '22023';
    end if;
    -- A section over the store with no store behind it would render an
    -- empty list that looks like a sync problem.
    if v_source is not null and not exists (
      select 1 from public.stores
       where project_id = p_project and status = 'connected'
    ) then
      raise exception 'No Shopify store is connected to this app.' using errcode = '22023';
    end if;

    insert into public.modules
      (project_id, name, nav_label, icon, route, sort_order, parent_id, source_table)
    values (
      p_project,
      p_payload ->> 'name',
      p_payload ->> 'nav_label',
      coalesce(nullif(p_payload ->> 'icon', ''), 'table'),
      p_payload ->> 'route',
      coalesce((p_payload ->> 'sort_order')::int, 0),
      nullif(p_payload ->> 'parent_id', '')::uuid,
      v_source
    )
    returning id into v_id;
    return jsonb_build_object('id', v_id);

  elsif p_op = 'module_update' then
    -- What the section said before, read in the same statement as the
    -- change, so an undo can put the name and place back — and can
    -- tell whether somebody moved it again since.
    select jsonb_build_object(
             'nav_label', m.nav_label, 'icon', m.icon,
             'parent_id', m.parent_id, 'sort_order', m.sort_order
           )
      into v_was
      from public.modules m
     where m.id = (p_payload ->> 'module_id')::uuid and m.project_id = p_project;
    update public.modules m
       set nav_label = coalesce(p_payload ->> 'nav_label', m.nav_label),
           icon      = coalesce(p_payload ->> 'icon', m.icon),
           parent_id = case when p_payload ? 'parent_id'
                            then nullif(p_payload ->> 'parent_id', '')::uuid
                            else m.parent_id end,
           sort_order = coalesce((p_payload ->> 'sort_order')::int, m.sort_order)
     where m.id = (p_payload ->> 'module_id')::uuid
       and m.project_id = p_project;
    get diagnostics v_n = row_count;
    return jsonb_build_object('count', v_n, 'was', v_was);

  elsif p_op = 'module_delete' then
    delete from public.modules
     where id = (p_payload ->> 'module_id')::uuid
       and project_id = p_project;
    get diagnostics v_n = row_count;
    return jsonb_build_object('count', v_n);

  elsif p_op = 'schema_insert' then
    if not exists (
      select 1 from public.modules
       where id = (p_payload ->> 'module_id')::uuid and project_id = p_project
    ) then
      raise exception 'No such section in this app.' using errcode = '42501';
    end if;
    insert into public.ui_schemas
      (module_id, schema_json, version, created_by, change_description)
    values (
      (p_payload ->> 'module_id')::uuid,
      p_payload -> 'schema_json',
      (p_payload ->> 'version')::int,
      coalesce(nullif(p_payload ->> 'created_by', ''), 'ai'),
      p_payload ->> 'change_description'
    )
    returning id into v_id;
    return jsonb_build_object('id', v_id);

  elsif p_op = 'records_insert' then
    if not exists (
      select 1 from public.modules
       where id = (p_payload ->> 'module_id')::uuid and project_id = p_project
    ) then
      raise exception 'No such section in this app.' using errcode = '42501';
    end if;
    -- Rows belong to sections the merchant fills in. A section over
    -- the store shows Shopify's rows, and a seeded row there would sit
    -- among them looking just as real.
    if exists (
      select 1 from public.modules
       where id = (p_payload ->> 'module_id')::uuid and source_table is not null
    ) then
      raise exception 'That section shows the store''s own rows; nothing can be added to it.'
        using errcode = '22023';
    end if;
    -- The ids of what went in, not only how many. An undo cannot
    -- delete "the five rows this added" from a count; with the ids it
    -- deletes exactly those and nothing else.
    with made as (
      insert into public.records (project_id, module_id, data)
      select p_project, (p_payload ->> 'module_id')::uuid, r
        from jsonb_array_elements(p_payload -> 'rows') r
      returning id
    )
    select count(*), coalesce(jsonb_agg(id), '[]'::jsonb) into v_n, v_ids from made;
    return jsonb_build_object('count', v_n, 'ids', v_ids);

  elsif p_op = 'automation_delete' then
    delete from public.automations
     where project_id = p_project
       and module_id = (p_payload ->> 'module_id')::uuid
       and name = p_payload ->> 'name'
       -- except_id: the replacement is already in, and only what it
       -- replaces is meant to go. Without this, re-adding a rule had
       -- to delete first and hope the insert followed.
       and (nullif(p_payload ->> 'except_id', '') is null
            or id <> (p_payload ->> 'except_id')::uuid);
    get diagnostics v_n = row_count;
    return jsonb_build_object('count', v_n);

  elsif p_op = 'automation_insert' then
    -- What was there before this write, so it can be put back.
    --
    -- The answer used to be only the id, and that is the same id
    -- whether this created a rule or rewrote one. An undo reading it
    -- could not tell the two apart, so it switched the rule off in
    -- both cases — which is wrong for the second: the merchant had a
    -- working rule, their AI changed it, and taking that back should
    -- give them the rule they had, not no rule at all.
    select a.definition, a.enabled into v_was_def, v_was_on
      from public.automations a
     where a.project_id = p_project
       and a.module_id is not distinct from nullif(p_payload ->> 'module_id', '')::uuid
       and a.name = p_payload ->> 'name';

    -- The same rule, changed — not a new rule and a funeral for the
    -- old one. Its id stays put, so automation_runs keeps pointing at
    -- it and the merchant can still see every time it ran.
    update public.automations
       set definition = p_payload -> 'definition',
           enabled    = true
     where project_id = p_project
       and module_id is not distinct from nullif(p_payload ->> 'module_id', '')::uuid
       and name = p_payload ->> 'name'
    returning id into v_id;

    if v_id is null then
      insert into public.automations (project_id, module_id, name, enabled, definition)
      values (
        p_project,
        nullif(p_payload ->> 'module_id', '')::uuid,
        p_payload ->> 'name',
        true,
        p_payload -> 'definition'
      )
      returning id into v_id;
    end if;

    return jsonb_build_object(
      'id', v_id,
      'created', v_was_def is null,
      'was', case
               when v_was_def is null then null
               else jsonb_build_object('definition', v_was_def, 'enabled', v_was_on)
             end
    );

  elsif p_op = 'automation_disable' then
    update public.automations
       set enabled = false
     where project_id = p_project
       and name = p_payload ->> 'name'
       and (v_owner or public.abo_may_change_module(module_id));
    get diagnostics v_n = row_count;
    return jsonb_build_object('count', v_n);

  elsif p_op = 'automation_restore' then
    -- One rule, by id, back to how it was before a build touched it.
    --
    -- automation_disable matches on name, and a name is unique only
    -- within one section — so putting back a rule called "Flag
    -- overdue" switched off every rule of that name in the app,
    -- including ones on other sections that nobody had asked about.
    -- The build already recorded which row it wrote; this uses it.
    update public.automations
       set enabled    = coalesce((p_payload ->> 'enabled')::boolean, false),
           definition = coalesce(p_payload -> 'definition', definition)
     where id = (p_payload ->> 'id')::uuid
       and project_id = p_project
       and (v_owner or public.abo_may_change_module(module_id));
    get diagnostics v_n = row_count;
    return jsonb_build_object('count', v_n);

  elsif p_op = 'request_claim' then
    update public.build_requests
       set status = 'building'
     where id = p_request and project_id = p_project and status = 'pending';
    get diagnostics v_n = row_count;
    return jsonb_build_object('count', v_n);

  elsif p_op = 'request_release' then
    update public.build_requests
       set status = 'pending'
     where id = p_request and project_id = p_project and status = 'building';
    get diagnostics v_n = row_count;
    return jsonb_build_object('count', v_n);

  elsif p_op = 'request_built' then
    -- An outcome with errors in it is not a finished build, whatever
    -- the caller would rather call it.
    v_failed := coalesce(jsonb_array_length(p_payload -> 'errors'), 0);
    v_status := case when v_failed > 0 then 'partly_built' else 'built' end;

    update public.build_requests
       set status      = v_status,
           -- What applyPlans really did, in the order it did it. An
           -- undo cannot reverse steps nobody wrote down.
           outcome     = case
                           when p_payload ? 'applied' or p_payload ? 'errors'
                           then jsonb_build_object(
                                  'applied', coalesce(p_payload -> 'applied', '[]'::jsonb),
                                  'errors',  coalesce(p_payload -> 'errors',  '[]'::jsonb)
                                )
                           else outcome
                         end,
           built_at    = now(),
           resolved_at = now(),
           -- Whether anyone tapped anything. This used to be a second
           -- write from the route, straight at the table, after this
           -- one — and a connected client is not allowed to write at
           -- the table (build_requests_oauth_no_update), so for every
           -- build a real assistant made it silently did not happen.
           -- The row then read as approved by the merchant, which is
           -- the one thing an automatic build must never claim.
           auto_built  = coalesce((p_payload ->> 'auto_built')::boolean, auto_built)
     where id = p_request
       and project_id = p_project
       and status in ('pending', 'building');
    get diagnostics v_n = row_count;
    return jsonb_build_object('count', v_n, 'status', v_status);

  elsif p_op = 'request_outcome' then
    -- What happened to a request that is NOT finished: an automatic
    -- build that was tried and did not go in stays pending for the
    -- merchant, and the reason has to be on the row for the card to
    -- say it. Same story as auto_built — the route wrote it at the
    -- table, and a client cannot.
    update public.build_requests
       set outcome = jsonb_build_object(
             'applied', coalesce(p_payload -> 'applied', '[]'::jsonb),
             'errors',  coalesce(p_payload -> 'errors',  '[]'::jsonb)
           )
     where id = p_request
       and project_id = p_project
       and status in ('pending', 'building');
    get diagnostics v_n = row_count;
    return jsonb_build_object('count', v_n);
  end if;

  raise exception 'Unknown build step "%".', p_op using errcode = '22023';
end $$;

create or replace function public.abo_approve_request(p_request uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_project uuid;
  v_client  text := nullif(auth.jwt() ->> 'client_id', '');
  v_auto    boolean;
begin
  if auth.uid() is null then
    raise exception 'Not signed in.' using errcode = '42501';
  end if;

  select r.project_id into v_project
    from public.build_requests r
   where r.id = p_request
     and (public.abo_owns(r.project_id)
          or (r.requested_by = auth.uid() and public.abo_can_build(r.project_id)))
     and r.status in ('pending', 'building')
     -- A client stamping a request that is not even its own would be
     -- the same hole through a different door.
     and (v_client is null or r.client_id is not distinct from v_client);

  if v_project is null then
    return jsonb_build_object('approved', false, 'reason', 'no such request waiting here');
  end if;

  if v_client is not null then
    select p.auto_build into v_auto from public.projects p where p.id = v_project;
    -- Auto-build is the owner's yes, given ahead; it is not a builder's.
    if not coalesce(v_auto, false) or not public.abo_owns(v_project) then
      return jsonb_build_object(
        'approved', false,
        'reason', 'the merchant approves this one in Warmluke'
      );
    end if;
  end if;

  update public.build_requests
     set approved_at = coalesce(approved_at, now()),
         approved_by = coalesce(approved_by, auth.uid())
   where id = p_request;

  return jsonb_build_object('approved', true);
end $$;

create or replace function public.abo_client_ask(
  p_project uuid,
  p_request text,
  p_conversation uuid default null
) returns jsonb
language plpgsql security definer set search_path = public, auth as $$
declare
  v_client uuid := nullif(auth.jwt() ->> 'client_id', '')::uuid;
  v_name   text;
  v_said   text := btrim(coalesce(p_request, ''));
  v_thread uuid;
  v_asked  uuid;
  v_answer uuid;
  v_t      timestamptz := clock_timestamp();
  v_again_thread uuid;
  v_again_asked  uuid;
  v_again_answer uuid;
  v_again_at     timestamptz;
begin
  if auth.uid() is null then
    raise exception 'Not signed in.' using errcode = '42501';
  end if;
  if not public.abo_can_build(p_project) then
    raise exception 'Not your project.' using errcode = '42501';
  end if;
  if v_said = '' then
    raise exception 'Say what they want built.' using errcode = '22023';
  end if;
  v_said := left(v_said, 8000);

  select nullif(btrim(c.client_name), '') into v_name from auth.oauth_clients c where c.id = v_client;
  v_name := coalesce(v_name, 'Your AI');

  -- The same words from the same assistant, moments after it asked them,
  -- are a retry, not a new ask: ChatGPT asked for one packing screen
  -- three times in six minutes on 2026-09-29. It is handed the ask it
  -- already made, being answered or answered, rather than a second
  -- design of the same thing. One that failed or was stopped is asked anew.
  select m.conversation_id, m.id, a.id, m.created_at
    into v_again_thread, v_again_asked, v_again_answer, v_again_at
    from public.messages m
    join public.conversations c on c.id = m.conversation_id
    join lateral (
      select x.id, x.payload
        from public.messages x
       where x.conversation_id = m.conversation_id
         and x.role = 'assistant'
         and x.created_at > m.created_at
       order by x.created_at asc
       limit 1
    ) a on true
   where c.project_id = p_project
     and c.created_by = auth.uid()
     and c.asked_by is not null
     and c.asked_client is not distinct from v_client
     and (p_conversation is null or c.id = p_conversation)
     and m.role = 'user'
     and m.payload ->> 'via' = 'client'
     and m.payload ->> 'text' = v_said
     and m.created_at > now() - interval '30 minutes'
     and coalesce(a.payload ->> 'type', '') not in ('unanswered', 'stopped')
   order by m.created_at desc
   limit 1;
  if v_again_thread is not null then
    return jsonb_build_object(
      'conversation_id', v_again_thread,
      'asked_id', v_again_asked,
      'answer_id', v_again_answer,
      'asked_at', v_again_at,
      'by', v_name,
      'new', false,
      'again', true
    );
  end if;

  if p_conversation is not null then
    select c.id into v_thread
      from public.conversations c
     where c.id = p_conversation
       and c.project_id = p_project
       and c.created_by = auth.uid()
       and c.asked_by is not null
       and c.asked_client is not distinct from v_client;
    if v_thread is null then
      raise exception 'That conversation was not started by this assistant in this app.' using errcode = '42501';
    end if;
  else
    insert into public.conversations (project_id, title, asked_by, asked_client, created_by)
    values (p_project, left(v_said, 80), v_name, v_client, auth.uid())
    returning id into v_thread;
  end if;

  -- A millisecond apart, so the question sorts above its answer.
  insert into public.messages (conversation_id, role, content, payload, created_at)
  values (v_thread, 'user', v_said,
          jsonb_build_object('kind', 'user', 'text', v_said, 'via', 'client', 'by', v_name), v_t)
  returning id into v_asked;
  insert into public.messages (conversation_id, role, content, payload, created_at)
  values (v_thread, 'assistant', '',
          jsonb_build_object('type', 'answering', 'started_at', v_t), v_t + interval '1 millisecond')
  returning id into v_answer;
  update public.conversations set updated_at = now() where id = v_thread;

  return jsonb_build_object(
    'conversation_id', v_thread,
    'asked_id', v_asked,
    'answer_id', v_answer,
    'asked_at', v_t,
    'by', v_name,
    'new', p_conversation is null
  );
end $$;

create or replace function public.abo_client_settle(
  p_answer  uuid,
  p_payload jsonb,
  p_content text default ''
) returns boolean
language plpgsql security definer set search_path = public, auth as $$
declare
  v_client uuid := nullif(auth.jwt() ->> 'client_id', '')::uuid;
  v_thread uuid;
begin
  if auth.uid() is null then
    raise exception 'Not signed in.' using errcode = '42501';
  end if;
  if jsonb_typeof(p_payload) <> 'object'
     or coalesce(p_payload ->> 'type', '') not in ('answer', 'clarify', 'unanswered', 'applied') then
    raise exception 'Not an answer this line can hold.' using errcode = '22023';
  end if;

  update public.messages m
     set payload = p_payload, content = coalesce(p_content, '')
    from public.conversations c
   where m.id = p_answer
     and c.id = m.conversation_id
     and m.role = 'assistant'
     and m.payload ->> 'type' = 'answering'
     and c.asked_by is not null
     and c.asked_client is not distinct from v_client
     and c.created_by = auth.uid()
     and public.abo_can_build(c.project_id)
  returning m.conversation_id into v_thread;

  if v_thread is null then
    return false;
  end if;
  update public.conversations set updated_at = now() where id = v_thread;
  return true;
end $$;

NOTIFY pgrst, 'reload schema';
