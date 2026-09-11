-- Migration 0010: replace the fixed rule vocabulary with an expression engine.
--
-- 0007 could only express the rules we had thought of: conditions were
-- {field, equals}, arithmetic was add|subtract, and each action type was a
-- named shape. "Flag it when stock drops below the reorder level" or
-- "escalate anything untouched for 48 hours" could not be said at all.
--
-- Rules are now expression TREES the assistant composes from operators, so
-- the set of expressible rules is no longer a list we maintain.
--
--   value  := {"const": x} | {"field": f} | {"was": f} | {"target": f}
--           | {"op":"+|-|*|/|concat|today|days_since|round", "args":[...]}
--   test   := {"op":"and|or|not", "args":[...]}
--           | {"op":"=|!=|>|>=|<|<=|contains|starts_with", "args":[v,v]}
--           | {"op":"is_empty|is_set", "args":[v]}
--           | {"op":"changed", "args":[{"field":f}]}
--
-- field  = the row that fired the rule; was = its previous values;
-- target = the row currently being written by a set_fields action.

-- ── Coercion helpers ─────────────────────────────────────────

create or replace function public.abo_txt(v jsonb) returns text as $$
  select case
    when v is null or jsonb_typeof(v) = 'null' then ''
    else v #>> '{}'
  end;
$$ language sql immutable;

create or replace function public.abo_num(v jsonb) returns numeric as $$
declare t text;
begin
  t := public.abo_txt(v);
  if t = '' then return 0; end if;
  return t::numeric;
exception when others then
  return 0;
end;
$$ language plpgsql immutable;

/** Truthiness: real booleans, non-zero numbers, non-empty strings. */
create or replace function public.abo_bool(v jsonb) returns boolean as $$
declare t text;
begin
  if v is null or jsonb_typeof(v) = 'null' then return false; end if;
  if jsonb_typeof(v) = 'boolean' then return (v #>> '{}')::boolean; end if;
  t := public.abo_txt(v);
  if t in ('', 'false', '0', 'no') then return false; end if;
  return true;
end;
$$ language plpgsql immutable;

/** Compares two values as numbers, then as dates, then as text. */
create or replace function public.abo_cmp(a jsonb, b jsonb) returns integer as $$
declare
  ta text := public.abo_txt(a);
  tb text := public.abo_txt(b);
  na numeric; nb numeric;
  da timestamptz; db timestamptz;
begin
  begin
    na := ta::numeric; nb := tb::numeric;
    return case when na < nb then -1 when na > nb then 1 else 0 end;
  exception when others then null;
  end;
  begin
    da := ta::timestamptz; db := tb::timestamptz;
    return case when da < db then -1 when da > db then 1 else 0 end;
  exception when others then null;
  end;
  return case when ta < tb then -1 when ta > tb then 1 else 0 end;
end;
$$ language plpgsql immutable;

-- ── The evaluator ────────────────────────────────────────────

create or replace function public.abo_eval(
  node jsonb,
  rec jsonb,      -- the row that fired the rule
  prev jsonb,     -- its values before the write
  tgt jsonb       -- the row a set_fields action is writing to
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
begin
  if node is null then return 'null'::jsonb; end if;
  -- A bare literal (string/number/bool) is its own value.
  if jsonb_typeof(node) <> 'object' then return node; end if;

  if node ? 'const'  then return node->'const'; end if;
  if node ? 'field'  then return coalesce(rec  -> (node->>'field'),  'null'::jsonb); end if;
  if node ? 'was'    then return coalesce(prev -> (node->>'was'),    'null'::jsonb); end if;
  if node ? 'target' then return coalesce(tgt  -> (node->>'target'), 'null'::jsonb); end if;

  op   := node->>'op';
  args := coalesce(node->'args', '[]'::jsonb);
  n    := jsonb_array_length(args);

  -- Nullary
  if op = 'today' then return to_jsonb(to_char(current_date, 'YYYY-MM-DD')); end if;
  if op = 'now'   then return to_jsonb(to_char(now(), 'YYYY-MM-DD"T"HH24:MI:SSOF')); end if;

  -- Logical
  if op = 'and' then
    for i in 0 .. n - 1 loop
      if not public.abo_bool(public.abo_eval(args->i, rec, prev, tgt)) then
        return to_jsonb(false);
      end if;
    end loop;
    return to_jsonb(true);
  end if;

  if op = 'or' then
    for i in 0 .. n - 1 loop
      if public.abo_bool(public.abo_eval(args->i, rec, prev, tgt)) then
        return to_jsonb(true);
      end if;
    end loop;
    return to_jsonb(false);
  end if;

  if op = 'not' then
    return to_jsonb(not public.abo_bool(public.abo_eval(args->0, rec, prev, tgt)));
  end if;

  -- Unary
  if op = 'changed' then
    a := public.abo_eval(args->0, rec, prev, tgt);
    b := public.abo_eval(jsonb_build_object('was', coalesce(args->0->>'field', '')), rec, prev, tgt);
    return to_jsonb(public.abo_txt(a) is distinct from public.abo_txt(b));
  end if;

  if op in ('is_empty', 'is_set') then
    a := public.abo_eval(args->0, rec, prev, tgt);
    if op = 'is_empty' then return to_jsonb(public.abo_txt(a) = ''); end if;
    return to_jsonb(public.abo_txt(a) <> '');
  end if;

  if op = 'days_since' then
    a := public.abo_eval(args->0, rec, prev, tgt);
    s := public.abo_txt(a);
    if s = '' then return to_jsonb(0); end if;
    begin
      return to_jsonb((current_date - s::date)::numeric);
    exception when others then
      return to_jsonb(0);
    end;
  end if;

  if op = 'round' then
    return to_jsonb(round(public.abo_num(public.abo_eval(args->0, rec, prev, tgt))));
  end if;

  -- Comparison
  if op in ('=', '!=', '>', '>=', '<', '<=') then
    a := public.abo_eval(args->0, rec, prev, tgt);
    b := public.abo_eval(args->1, rec, prev, tgt);
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
    a := public.abo_eval(args->0, rec, prev, tgt);
    b := public.abo_eval(args->1, rec, prev, tgt);
    if op = 'contains' then
      return to_jsonb(position(lower(public.abo_txt(b)) in lower(public.abo_txt(a))) > 0);
    end if;
    return to_jsonb(lower(public.abo_txt(a)) like lower(public.abo_txt(b)) || '%');
  end if;

  -- Arithmetic
  if op in ('+', '-', '*', '/') then
    acc := public.abo_num(public.abo_eval(args->0, rec, prev, tgt));
    for i in 1 .. n - 1 loop
      b := public.abo_eval(args->i, rec, prev, tgt);
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
      s := s || public.abo_txt(public.abo_eval(args->i, rec, prev, tgt));
    end loop;
    return to_jsonb(s);
  end if;

  -- Unknown operator: evaluate to null rather than aborting the write.
  return 'null'::jsonb;
end;
$$ language plpgsql stable;

/** Builds the jsonb patch for a set_fields action against one row. */
create or replace function public.abo_apply_set(
  set_spec jsonb, rec jsonb, prev jsonb, tgt jsonb
) returns jsonb as $$
declare
  patch jsonb := '{}'::jsonb;
  k text;
begin
  for k in select jsonb_object_keys(set_spec) loop
    patch := patch || jsonb_build_object(k, public.abo_eval(set_spec->k, rec, prev, tgt));
  end loop;
  return patch;
end;
$$ language plpgsql stable;

-- ── Action runner, shared by row triggers and the scheduler ──

create or replace function public.abo_run_actions(
  auto_id uuid,
  actions jsonb,
  rec_id uuid,
  project uuid,
  rec jsonb,
  prev jsonb
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
        -- Writing to the row that fired the rule. The trigger is AFTER, so
        -- this is a real update; the guard in the trigger stops recursion.
        patch := public.abo_apply_set(act->'set', rec, prev, rec);
        update public.records r set data = r.data || patch, updated_at = now()
        where r.id = rec_id;
        insert into public.automation_runs(automation_id, record_id, ok, detail)
        values (auto_id, rec_id, true, jsonb_build_object('action', 'set_fields', 'on', 'self'));
      else
        match_val := public.abo_txt(
          public.abo_eval(act->'target'->'match'->'to', rec, prev, '{}'::jsonb)
        );
        touched := 0;
        for tgt in
          select r.id, r.data from public.records r
          where r.module_id = (act->'target'->>'module_id')::uuid
            and coalesce(r.data->>(act->'target'->'match'->>'field'), '') = match_val
        loop
          patch := public.abo_apply_set(act->'set', rec, prev, tgt.data);
          update public.records r set data = r.data || patch, updated_at = now()
          where r.id = tgt.id;
          touched := touched + 1;
        end loop;
        insert into public.automation_runs(automation_id, record_id, ok, detail)
        values (auto_id, rec_id, true,
                jsonb_build_object('action', 'set_fields', 'rows', touched));
      end if;

    elsif act->>'type' = 'create_record' then
      patch := public.abo_apply_set(coalesce(act->'data', '{}'::jsonb), rec, prev, '{}'::jsonb);
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

-- ── Row trigger ──────────────────────────────────────────────

create or replace function public.run_record_automations()
returns trigger as $$
declare
  auto record;
  rec_data jsonb := coalesce(new.data, '{}'::jsonb);
  old_data jsonb := case when TG_OP = 'UPDATE' then coalesce(old.data, '{}'::jsonb)
                         else '{}'::jsonb end;
begin
  -- A set_fields-on-self action updates this same row, which fires this
  -- trigger again. One level of re-entry is all the depth we allow.
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
        continue; -- schedule: handled by the hourly runner
      end if;

      -- One expression decides whether the rule fires at all.
      if auto.definition->'trigger' ? 'when' then
        if not public.abo_bool(
             public.abo_eval(auto.definition->'trigger'->'when', rec_data, old_data, '{}'::jsonb)
           ) then
          continue;
        end if;
      end if;

      perform public.abo_run_actions(
        auto.id, coalesce(auto.definition->'actions', '[]'::jsonb),
        new.id, new.project_id, rec_data, old_data
      );

    exception when others then
      insert into public.automation_runs(automation_id, record_id, ok, detail)
      values (auto.id, new.id, false, jsonb_build_object('error', sqlerrm));
    end;
  end loop;
  return new;
end;
$$ language plpgsql security definer;

drop trigger if exists trg_record_automations on public.records;
create trigger trg_record_automations
after insert or update on public.records
for each row execute function public.run_record_automations();

-- ── Scheduled runner ─────────────────────────────────────────

create or replace function public.run_scheduled_automations()
returns void as $$
declare
  auto record;
  target record;
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
        -- The same "when" expression, evaluated per row.
        if auto.definition->'trigger' ? 'when' then
          if not public.abo_bool(
               public.abo_eval(auto.definition->'trigger'->'when',
                               target.data, '{}'::jsonb, '{}'::jsonb)
             ) then
            continue;
          end if;
        end if;

        perform public.abo_run_actions(
          auto.id, coalesce(auto.definition->'actions', '[]'::jsonb),
          target.id, target.project_id, target.data, '{}'::jsonb
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
