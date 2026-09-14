-- Migration 0031: one door for every write the builder makes.
--
-- 0028 walled off writes from any token carrying client_id, which is
-- what makes the consent screen's "cannot change anything" true. But a
-- merchant who approves a design inside Claude is holding exactly such
-- a token, and the build has to happen. The other way out was to give
-- the server a service-role key and let it write past RLS for
-- everyone — one leaked env var from losing the whole security model.
--
-- So: the wall stays, and this is the only door through it. Every
-- write the apply path makes goes through here, app and client alike,
-- so there is one gate to read rather than two paths to keep in step.
-- A caller without client_id needs only to own the project. A caller
-- with one must name a pending request that it asked for and the
-- merchant owns — that is the approval, and it is spent once.
--
-- Validation stays in TypeScript where it already lives. This function
-- decides who may write and to which rows, not whether a column type
-- makes sense.

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
begin
  if auth.uid() is null then
    raise exception 'Not signed in.' using errcode = '42501';
  end if;
  -- The same ownership test RLS would have run, repeated here because
  -- definer context has switched the policies off.
  if not public.abo_owns(p_project) then
    raise exception 'Not your project.' using errcode = '42501';
  end if;

  if v_client is not null then
    -- An AI client writes only what a person approved: a request it
    -- raised itself, on this project, still pending.
    if p_request is null then
      raise exception 'This needs an approved request.' using errcode = '42501';
    end if;
    if not exists (
      select 1 from public.build_requests
       where id = p_request
         and project_id = p_project
         and status in ('pending', 'building')
         and client_id is not distinct from v_client
    ) then
      raise exception 'That request is not pending approval here.' using errcode = '42501';
    end if;
  end if;

  if p_op = 'module_insert' then
    insert into public.modules
      (project_id, name, nav_label, icon, route, sort_order, parent_id)
    values (
      p_project,
      p_payload ->> 'name',
      p_payload ->> 'nav_label',
      coalesce(nullif(p_payload ->> 'icon', ''), 'table'),
      p_payload ->> 'route',
      coalesce((p_payload ->> 'sort_order')::int, 0),
      nullif(p_payload ->> 'parent_id', '')::uuid
    )
    returning id into v_id;
    return jsonb_build_object('id', v_id);

  elsif p_op = 'module_update' then
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
    return jsonb_build_object('count', v_n);

  elsif p_op = 'module_delete' then
    delete from public.modules
     where id = (p_payload ->> 'module_id')::uuid
       and project_id = p_project;
    get diagnostics v_n = row_count;
    return jsonb_build_object('count', v_n);

  elsif p_op = 'schema_insert' then
    -- The module has to be one of this project's, or a caller could
    -- write a schema onto somebody else's section.
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
    insert into public.records (project_id, module_id, data)
    select p_project, (p_payload ->> 'module_id')::uuid, r
      from jsonb_array_elements(p_payload -> 'rows') r;
    get diagnostics v_n = row_count;
    return jsonb_build_object('count', v_n);

  elsif p_op = 'automation_delete' then
    delete from public.automations
     where project_id = p_project
       and module_id = (p_payload ->> 'module_id')::uuid
       and name = p_payload ->> 'name';
    get diagnostics v_n = row_count;
    return jsonb_build_object('count', v_n);

  elsif p_op = 'automation_insert' then
    insert into public.automations (project_id, module_id, name, enabled, definition)
    values (
      p_project,
      nullif(p_payload ->> 'module_id', '')::uuid,
      p_payload ->> 'name',
      true,
      p_payload -> 'definition'
    )
    returning id into v_id;
    return jsonb_build_object('id', v_id);

  elsif p_op = 'automation_disable' then
    update public.automations
       set enabled = false
     where project_id = p_project
       and name = p_payload ->> 'name';
    get diagnostics v_n = row_count;
    return jsonb_build_object('count', v_n);

  elsif p_op = 'request_claim' then
    -- Two approvals arriving at once would otherwise build the same
    -- design twice. Only the update that finds it still pending wins;
    -- the loser is told somebody is already building it.
    update public.build_requests
       set status = 'building'
     where id = p_request and project_id = p_project and status = 'pending';
    get diagnostics v_n = row_count;
    return jsonb_build_object('count', v_n);

  elsif p_op = 'request_release' then
    -- A build that failed leaves the request approvable again rather
    -- than stuck half-claimed forever.
    update public.build_requests
       set status = 'pending'
     where id = p_request and project_id = p_project and status = 'building';
    get diagnostics v_n = row_count;
    return jsonb_build_object('count', v_n);

  elsif p_op = 'request_built' then
    -- Spends the approval. After this the request can no longer let
    -- anything through, so a client that repeats the call builds
    -- nothing the second time.
    update public.build_requests
       set status = 'built', built_at = now(), resolved_at = now()
     where id = p_request
       and project_id = p_project
       and status in ('pending', 'building');
    get diagnostics v_n = row_count;
    return jsonb_build_object('count', v_n);
  end if;

  raise exception 'Unknown build step "%".', p_op using errcode = '22023';
end $$;

revoke all on function public.abo_build(uuid, uuid, text, jsonb) from public;
grant execute on function public.abo_build(uuid, uuid, text, jsonb) to authenticated;

NOTIFY pgrst, 'reload schema';
