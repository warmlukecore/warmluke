-- Migration 0051: changing a rule keeps its history.
--
-- 0050 stopped a replacement from losing the rule. It did not stop the
-- replacement from losing everything the rule had ever done.
--
-- automation_runs references automations(id) ON DELETE CASCADE, so
-- deleting the old row took every success and failure with it — and
-- the Rules screen then showed a rule that had run for weeks as
-- "hasn't run yet". Exactly when a merchant most wants that history:
-- just after changing the rule.
--
-- So stop deleting. A rule of the same name on the same section is
-- that rule with a new definition; update it in place and the id
-- never moves. This also removes 0050's except_id — there is no
-- longer a second row to keep out of the way — and closes the window
-- where two copies briefly existed and both fired.
--
-- Smaller than what it replaces, which is how this should have been
-- written the first time.
--
-- Callers: src/lib/apply.ts.

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
  v_failed integer;
  v_status text;
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
         -- The line 0033 was missing. "Pending" is the word for
         -- nobody having answered yet; a stamp means somebody did.
         and approved_at is not null
    ) then
      raise exception 'Nobody has approved that request.' using errcode = '42501';
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
       and name = p_payload ->> 'name'
       -- except_id: the replacement is already in, and only what it
       -- replaces is meant to go. Without this, re-adding a rule had
       -- to delete first and hope the insert followed.
       and (nullif(p_payload ->> 'except_id', '') is null
            or id <> (p_payload ->> 'except_id')::uuid);
    get diagnostics v_n = row_count;
    return jsonb_build_object('count', v_n);

  elsif p_op = 'automation_insert' then
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
           resolved_at = now()
     where id = p_request
       and project_id = p_project
       and status in ('pending', 'building');
    get diagnostics v_n = row_count;
    return jsonb_build_object('count', v_n, 'status', v_status);
  end if;

  raise exception 'Unknown build step "%".', p_op using errcode = '22023';
end $$;

NOTIFY pgrst, 'reload schema';
