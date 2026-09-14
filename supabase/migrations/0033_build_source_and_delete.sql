-- Migration 0033: two corrections to the one door.
--
-- First: a section can be built over the store's own rows, so
-- module_insert has to be able to set source_table. The four names are
-- checked here as well as in TypeScript — this function runs as its
-- owner, so it cannot lean on a caller having validated anything.
--
-- Second: removing a section takes the section and every row in it,
-- and it does not come back. In the app the owner types the section's
-- name to confirm. A token handed to an AI has no such moment, so it
-- does not get that operation at all.

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
begin
  if auth.uid() is null then
    raise exception 'Not signed in.' using errcode = '42501';
  end if;
  if not public.abo_owns(p_project) then
    raise exception 'Not your project.' using errcode = '42501';
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
    ) then
      raise exception 'That request is not pending approval here.' using errcode = '42501';
    end if;
  end if;

  if p_op = 'module_insert' then
    v_source := nullif(p_payload ->> 'source_table', '');
    if v_source is not null
       and v_source not in ('orders', 'customers', 'products', 'inventory_levels') then
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

NOTIFY pgrst, 'reload schema';
