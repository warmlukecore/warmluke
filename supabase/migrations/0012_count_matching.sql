-- Migration 0012: let a rule see the rest of the section.
--
-- Every operator so far looked only at the row being written, so the
-- commonest business problem of all — "is this a duplicate?" — could
-- not be expressed. A booking system could show a calendar but never
-- tell the owner they had just double-booked, which is the thing they
-- actually asked for.
--
--   { "op": "count_matching", "args": [ { "field": "date" }, { "field": "time" } ] }
--
-- counts OTHER rows in the same section whose listed fields all equal
-- this row's. `> 0` means a clash. It flags, it does not block: the
-- trigger runs after the write, so the row is saved and marked, not
-- refused.

create or replace function public.abo_eval(
  node jsonb,
  rec jsonb,
  prev jsonb,
  tgt jsonb,
  ctx jsonb default '{}'::jsonb   -- { module_id, record_id }
) returns jsonb as $$
declare
  op text;
  args jsonb;
  n int;
  a jsonb;
  b jsonb;
  acc numeric;
  i int;
  s text;
  cnt int;
  other record;
  same boolean;
  fname text;
begin
  if node is null then return 'null'::jsonb; end if;
  if jsonb_typeof(node) <> 'object' then return node; end if;

  if node ? 'const'  then return node->'const'; end if;
  if node ? 'field'  then return coalesce(rec  -> (node->>'field'),  'null'::jsonb); end if;
  if node ? 'was'    then return coalesce(prev -> (node->>'was'),    'null'::jsonb); end if;
  if node ? 'target' then return coalesce(tgt  -> (node->>'target'), 'null'::jsonb); end if;

  op   := node->>'op';
  args := coalesce(node->'args', '[]'::jsonb);
  n    := jsonb_array_length(args);

  if op = 'today' then return to_jsonb(to_char(current_date, 'YYYY-MM-DD')); end if;
  if op = 'now'   then return to_jsonb(to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SSOF')); end if;

  -- How many OTHER rows here share these field values.
  if op = 'count_matching' then
    if ctx->>'module_id' is null or n = 0 then return to_jsonb(0); end if;
    cnt := 0;
    for other in
      select r.id, r.data from public.records r
      where r.module_id = (ctx->>'module_id')::uuid
        and (ctx->>'record_id' is null or r.id <> (ctx->>'record_id')::uuid)
    loop
      same := true;
      for i in 0 .. n - 1 loop
        fname := args->i->>'field';
        if fname is null then same := false; exit; end if;
        -- A blank never counts as matching a blank, or every
        -- half-filled row would look like a duplicate of every other.
        if coalesce(rec->>fname, '') = ''
           or coalesce(other.data->>fname, '') is distinct from coalesce(rec->>fname, '') then
          same := false;
          exit;
        end if;
      end loop;
      if same then cnt := cnt + 1; end if;
    end loop;
    return to_jsonb(cnt);
  end if;

  if op = 'and' then
    for i in 0 .. n - 1 loop
      if not public.abo_bool(public.abo_eval(args->i, rec, prev, tgt, ctx)) then
        return to_jsonb(false);
      end if;
    end loop;
    return to_jsonb(true);
  end if;

  if op = 'or' then
    for i in 0 .. n - 1 loop
      if public.abo_bool(public.abo_eval(args->i, rec, prev, tgt, ctx)) then
        return to_jsonb(true);
      end if;
    end loop;
    return to_jsonb(false);
  end if;

  if op = 'not' then
    return to_jsonb(not public.abo_bool(public.abo_eval(args->0, rec, prev, tgt, ctx)));
  end if;

  if op = 'changed' then
    a := public.abo_eval(args->0, rec, prev, tgt, ctx);
    b := public.abo_eval(jsonb_build_object('was', coalesce(args->0->>'field', '')), rec, prev, tgt, ctx);
    return to_jsonb(public.abo_txt(a) is distinct from public.abo_txt(b));
  end if;

  if op in ('is_empty', 'is_set') then
    a := public.abo_eval(args->0, rec, prev, tgt, ctx);
    if op = 'is_empty' then return to_jsonb(public.abo_txt(a) = ''); end if;
    return to_jsonb(public.abo_txt(a) <> '');
  end if;

  if op = 'days_since' then
    a := public.abo_eval(args->0, rec, prev, tgt, ctx);
    s := public.abo_txt(a);
    if s = '' then return to_jsonb(0); end if;
    begin
      return to_jsonb((current_date - s::date)::numeric);
    exception when others then
      return to_jsonb(0);
    end;
  end if;

  if op = 'round' then
    return to_jsonb(round(public.abo_num(public.abo_eval(args->0, rec, prev, tgt, ctx))));
  end if;

  if op in ('=', '!=', '>', '>=', '<', '<=') then
    a := public.abo_eval(args->0, rec, prev, tgt, ctx);
    b := public.abo_eval(args->1, rec, prev, tgt, ctx);
    return to_jsonb(
      case op
        when '='  then public.abo_cmp(a, b) = 0
        when '!=' then public.abo_cmp(a, b) <> 0
        when '>'  then public.abo_cmp(a, b) > 0
        when '>=' then public.abo_cmp(a, b) >= 0
        when '<'  then public.abo_cmp(a, b) < 0
        else           public.abo_cmp(a, b) <= 0
      end
    );
  end if;

  if op in ('contains', 'starts_with') then
    a := public.abo_eval(args->0, rec, prev, tgt, ctx);
    b := public.abo_eval(args->1, rec, prev, tgt, ctx);
    if op = 'contains' then
      return to_jsonb(position(lower(public.abo_txt(b)) in lower(public.abo_txt(a))) > 0);
    end if;
    return to_jsonb(lower(public.abo_txt(a)) like lower(public.abo_txt(b)) || '%');
  end if;

  if op in ('+', '-', '*', '/') then
    acc := public.abo_num(public.abo_eval(args->0, rec, prev, tgt, ctx));
    for i in 1 .. n - 1 loop
      b := public.abo_eval(args->i, rec, prev, tgt, ctx);
      if op = '+' then acc := acc + public.abo_num(b);
      elsif op = '-' then acc := acc - public.abo_num(b);
      elsif op = '*' then acc := acc * public.abo_num(b);
      else
        if public.abo_num(b) = 0 then return to_jsonb(0); end if;
        acc := acc / public.abo_num(b);
      end if;
    end loop;
    return to_jsonb(acc);
  end if;

  if op = 'concat' then
    s := '';
    for i in 0 .. n - 1 loop
      s := s || public.abo_txt(public.abo_eval(args->i, rec, prev, tgt, ctx));
    end loop;
    return to_jsonb(s);
  end if;

  return 'null'::jsonb;
end;
$$ language plpgsql stable;

-- Context has to reach the evaluator, so both callers pass it through.

create or replace function public.abo_apply_set(
  set_spec jsonb, rec jsonb, prev jsonb, tgt jsonb, ctx jsonb default '{}'::jsonb
) returns jsonb as $$
declare
  patch jsonb := '{}'::jsonb;
  k text;
begin
  for k in select jsonb_object_keys(set_spec) loop
    patch := patch || jsonb_build_object(k, public.abo_eval(set_spec->k, rec, prev, tgt, ctx));
  end loop;
  return patch;
end;
$$ language plpgsql stable;

create or replace function public.run_record_automations()
returns trigger as $$
declare
  auto record;
  rec_data jsonb := coalesce(new.data, '{}'::jsonb);
  old_data jsonb := case when TG_OP = 'UPDATE' then coalesce(old.data, '{}'::jsonb)
                         else '{}'::jsonb end;
  ctx jsonb := jsonb_build_object('module_id', new.module_id, 'record_id', new.id);
begin
  if pg_trigger_depth() > 1 then
    return new;
  end if;

  for auto in
    select * from public.automations a
    where a.enabled and a.module_id = new.module_id
  loop
    begin
      if (auto.definition->'trigger'->>'type') = 'record_created' then
        if TG_OP <> 'INSERT' then continue; end if;
      elsif (auto.definition->'trigger'->>'type') = 'record_updated' then
        if TG_OP <> 'UPDATE' then continue; end if;
      else
        continue;
      end if;

      if auto.definition->'trigger' ? 'when' then
        if not public.abo_bool(
             public.abo_eval(auto.definition->'trigger'->'when', rec_data, old_data, '{}'::jsonb, ctx)
           ) then
          continue;
        end if;
      end if;

      perform public.abo_run_actions(
        auto.id, coalesce(auto.definition->'actions', '[]'::jsonb),
        new.id, new.project_id, rec_data, old_data, ctx
      );

    exception when others then
      insert into public.automation_runs(automation_id, record_id, ok, detail)
      values (auto.id, new.id, false, jsonb_build_object('error', sqlerrm));
    end;
  end loop;
  return new;
end;
$$ language plpgsql security definer;

create or replace function public.abo_run_actions(
  auto_id uuid,
  actions jsonb,
  rec_id uuid,
  project uuid,
  rec jsonb,
  prev jsonb,
  ctx jsonb default '{}'::jsonb
) returns void as $$
declare
  act jsonb;
  tgt record;
  patch jsonb;
  touched integer;
  match_val text;
begin
  for act in select * from jsonb_array_elements(actions) loop
    if act->>'type' = 'set_fields' then
      if coalesce((act->'target'->>'self')::boolean, false) then
        patch := public.abo_apply_set(act->'set', rec, prev, rec, ctx);
        update public.records r set data = r.data || patch, updated_at = now()
        where r.id = rec_id;
        insert into public.automation_runs(automation_id, record_id, ok, detail)
        values (auto_id, rec_id, true, jsonb_build_object('action', 'set_fields', 'on', 'self'));
      else
        match_val := public.abo_txt(
          public.abo_eval(act->'target'->'match'->'to', rec, prev, '{}'::jsonb, ctx)
        );
        touched := 0;
        for tgt in
          select r.id, r.data from public.records r
          where r.module_id = (act->'target'->>'module_id')::uuid
            and coalesce(r.data->>(act->'target'->'match'->>'field'), '') = match_val
        loop
          patch := public.abo_apply_set(act->'set', rec, prev, tgt.data, ctx);
          update public.records r set data = r.data || patch, updated_at = now()
          where r.id = tgt.id;
          touched := touched + 1;
        end loop;
        insert into public.automation_runs(automation_id, record_id, ok, detail)
        values (auto_id, rec_id, true,
                jsonb_build_object('action', 'set_fields', 'rows', touched));
      end if;

    elsif act->>'type' = 'create_record' then
      patch := public.abo_apply_set(coalesce(act->'data', '{}'::jsonb), rec, prev, '{}'::jsonb, ctx);
      insert into public.records(project_id, module_id, data)
      values (project, (act->>'module_id')::uuid, patch);
      insert into public.automation_runs(automation_id, record_id, ok, detail)
      values (auto_id, rec_id, true, jsonb_build_object('action', 'create_record'));

    elsif act->>'type' = 'webhook' then
      insert into public.automation_runs(automation_id, record_id, ok, detail)
      values (auto_id, rec_id, true,
              jsonb_build_object('action', 'webhook', 'url', act->>'url', 'queued', true));
    end if;
  end loop;
end;
$$ language plpgsql security definer;

create or replace function public.run_scheduled_automations()
returns void as $$
declare
  auto record;
  target record;
  ctx jsonb;
begin
  for auto in
    select * from public.automations a
    where a.enabled and (a.definition->'trigger'->>'type') = 'schedule'
  loop
    begin
      for target in
        select r.id, r.project_id, r.data
        from public.records r
        where r.module_id = auto.module_id
      loop
        ctx := jsonb_build_object('module_id', auto.module_id, 'record_id', target.id);
        if auto.definition->'trigger' ? 'when' then
          if not public.abo_bool(
               public.abo_eval(auto.definition->'trigger'->'when',
                               target.data, '{}'::jsonb, '{}'::jsonb, ctx)
             ) then
            continue;
          end if;
        end if;

        perform public.abo_run_actions(
          auto.id, coalesce(auto.definition->'actions', '[]'::jsonb),
          target.id, target.project_id, target.data, '{}'::jsonb, ctx
        );
      end loop;
    exception when others then
      insert into public.automation_runs(automation_id, record_id, ok, detail)
      values (auto.id, null, false, jsonb_build_object('error', sqlerrm));
    end;
  end loop;
end;
$$ language plpgsql security definer;

NOTIFY pgrst, 'reload schema';

-- The pre-0012 four-argument versions still exist alongside the new
-- ones, and a four-argument call is then ambiguous. Drop them: every
-- caller passes ctx, which defaults when omitted.
drop function if exists public.abo_eval(jsonb, jsonb, jsonb, jsonb);
drop function if exists public.abo_apply_set(jsonb, jsonb, jsonb, jsonb);
drop function if exists public.abo_run_actions(uuid, jsonb, uuid, uuid, jsonb, jsonb);

NOTIFY pgrst, 'reload schema';
