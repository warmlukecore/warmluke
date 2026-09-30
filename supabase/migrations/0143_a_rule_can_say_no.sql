-- A rule can say no.
--
-- Every rule so far ran AFTER a row was saved (run_record_automations):
-- it could set fields, add rows, flag a clash — never stop the save. So
-- "two people must never both take the last unit" had no answer here.
-- A rule counting the holds after each save sees the second hold only
-- once it exists; two people saving at once each see the other's not yet
-- there, and both are kept.
--
-- A rule whose trigger is before_save runs BEFORE the row is written,
-- inside the same statement, and its one action is refuse: when its
-- "when" is true the save is refused with the rule's own sentence, and
-- nothing is written. Two saves at once are taken one at a time past each
-- such rule (a transaction lock on the rule), and the one that goes
-- second is judged after the first is committed: in READ COMMITTED each
-- statement this trigger runs takes a fresh snapshot, and abo_eval,
-- being STABLE, reads with the snapshot of the statement that calls it,
-- taken after the lock. So of two people holding the last unit, one is
-- kept and one is refused.
--
-- It holds for every write to the section's rows — the app, a screen, a
-- rule's action, the code worker, a seeded build, the owner's AI —
-- because it is the table's own trigger. It does not hold for anything
-- outside Warmluke: Shopify, a till or another app changing the store's
-- stock is not a save here, and a hold in Warmluke is Warmluke's.
--
-- And two operators it needs, both automation-only like count_matching:
--   sum_matching(value, ...)   the value added up over the OTHER rows of
--                              this section that match, as count_matching
--                              matches them: "units already held of this
--                              item at this place".
--   store_value(list, field, key, value, ...)  one field of one row of
--                              this project's store, found by its keys:
--                              "what the stock says can be sold for this
--                              item at this place". Only the project's own
--                              store, only a list the store has, only a
--                              field and keys named plainly.
--
-- ponytail: one lock per rule, so saves on a guarded section queue behind
-- each other; a lock per key (item and place) if a section's traffic ever
-- needs it.
--
-- Callers: the records table (trg_record_guards); every rule runner
-- (abo_eval); src/lib/ai.ts validates what a design may ask of both.

create or replace function public.abo_eval(node jsonb, rec jsonb, prev jsonb, tgt jsonb, ctx jsonb default '{}'::jsonb)
returns jsonb
language plpgsql stable
as $function$
declare
  op text; args jsonb; n int; a jsonb; b jsonb; acc numeric; i int; s text;
  cnt int; other record; same boolean; fname text; arg jsonb;
  total numeric; first int;
  v_table text; v_field text; v_view text; v_store uuid; v_sql text; v_out jsonb; k text;
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

  if op = 'if' then
    if public.abo_bool(public.abo_eval(args->0, rec, prev, tgt, ctx)) then
      return public.abo_eval(args->1, rec, prev, tgt, ctx);
    end if;
    if n > 2 then return public.abo_eval(args->2, rec, prev, tgt, ctx); end if;
    return 'null'::jsonb;
  end if;

  -- count_matching and sum_matching walk the same siblings: every OTHER
  -- row of this section, kept when it shares this row's value for each
  -- field leaf and passes each operator arg (run against the sibling).
  -- sum_matching's first arg is what is added up, read from the sibling.
  if op in ('count_matching', 'sum_matching') then
    first := case when op = 'sum_matching' then 1 else 0 end;
    if ctx->>'module_id' is null or n <= first then return to_jsonb(0); end if;
    cnt := 0;
    total := 0;
    for other in
      select r.id, r.data from public.records r
      where r.module_id = (ctx->>'module_id')::uuid
        and (ctx->>'record_id' is null or r.id <> (ctx->>'record_id')::uuid)
    loop
      same := true;

      -- Field leaves: the sibling must share this row's value.
      for i in first .. n - 1 loop
        arg := args->i;
        if not (arg ? 'field') then continue; end if;
        fname := arg->>'field';
        if coalesce(rec->>fname, '') = ''
           or coalesce(other.data->>fname, '') is distinct from coalesce(rec->>fname, '') then
          same := false;
          exit;
        end if;
      end loop;

      -- Operator args: a test run against the sibling itself, so
      -- { "field": ... } inside it reads the OTHER row.
      if same then
        for i in first .. n - 1 loop
          arg := args->i;
          if not (arg ? 'op') then continue; end if;
          if not public.abo_bool(public.abo_eval(arg, other.data, '{}'::jsonb, tgt, ctx)) then
            same := false;
            exit;
          end if;
        end loop;
      end if;

      if same then
        cnt := cnt + 1;
        if op = 'sum_matching' then
          total := total + public.abo_num(public.abo_eval(args->0, other.data, '{}'::jsonb, tgt, ctx));
        end if;
      end if;
    end loop;
    if op = 'sum_matching' then return to_jsonb(total); end if;
    return to_jsonb(cnt);
  end if;

  -- One field of one of this project's store rows, found by its keys.
  -- The list, the field and the keys are plain names (the validator
  -- holds a design to the store's own); the values are expressions.
  if op = 'store_value' then
    v_table := args->0->>'const';
    v_field := args->1->>'const';
    if ctx->>'module_id' is null or v_table is null or v_field is null or v_field !~ '^[a-z_]+$' or n < 4 then
      return 'null'::jsonb;
    end if;
    v_view := public.abo_store_view(v_table);
    if v_view is null then return 'null'::jsonb; end if;
    select s.id into v_store
      from public.modules m
      join public.stores s on s.project_id = m.project_id and s.status in ('connected', 'uninstalled')
     where m.id = (ctx->>'module_id')::uuid
     limit 1;
    if v_store is null then return 'null'::jsonb; end if;
    v_sql := format('select to_jsonb(v.%I) from public.%I v where v.store_id = $1', v_field, v_view);
    i := 2;
    while i + 1 < n loop
      k := args->i->>'const';
      if k is null or k !~ '^[a-z_]+$' then return 'null'::jsonb; end if;
      s := public.abo_txt(public.abo_eval(args->(i + 1), rec, prev, tgt, ctx));
      if s = '' then return 'null'::jsonb; end if;
      v_sql := v_sql || format(' and v.%I::text = %L', k, s);
      i := i + 2;
    end loop;
    begin
      execute v_sql || ' limit 1' into v_out using v_store;
    exception when undefined_column or undefined_table then
      return 'null'::jsonb;
    end;
    return coalesce(v_out, 'null'::jsonb);
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
    exception when others then return to_jsonb(0);
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
$function$;

-- ── The rules that say no ────────────────────────────────────

create or replace function public.run_record_guards()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  auto     record;
  v_source text;
  v_store  jsonb := '{}'::jsonb;
  rec_data jsonb;
  old_data jsonb;
  ctx      jsonb := jsonb_build_object('module_id', new.module_id, 'record_id', new.id);
  v_msg    text;
  v_no     boolean;
begin
  for auto in
    select a.id, a.name, a.definition
      from public.automations a
     where a.enabled and a.module_id = new.module_id
       and a.definition->'trigger'->>'type' = 'before_save'
     order by a.created_at, a.id
  loop
    -- One save at a time past this rule, and the second judged after the
    -- first is committed: the statements below take their snapshot now.
    perform pg_advisory_xact_lock(hashtextextended('abo_guard:' || auto.id::text, 0));

    if rec_data is null then
      -- The row as a rule reads it, as run_record_automations lays it out:
      -- beside a store row, the store's fields under the merchant's.
      if new.store_row_id is not null then
        select m.source_table into v_source from public.modules m where m.id = new.module_id;
        v_store := public.abo_store_row(v_source, new.store_row_id);
      end if;
      rec_data := coalesce(new.data, '{}'::jsonb) || v_store || jsonb_build_object('id', new.id);
      old_data := case when TG_OP = 'UPDATE'
                       then coalesce(old.data, '{}'::jsonb) || v_store || jsonb_build_object('id', new.id)
                       else '{}'::jsonb end;
    end if;

    -- A rule that cannot be judged refuses: it exists to stop something,
    -- and letting everything through when it breaks is not stopping it.
    begin
      v_no := public.abo_bool(public.abo_eval(auto.definition->'trigger'->'when', rec_data, old_data, '{}'::jsonb, ctx));
    exception when others then
      raise exception 'The rule "%" could not be checked, so this was not saved.', auto.name
        using errcode = 'P0001', hint = 'abo_refused', detail = sqlerrm;
    end;

    if v_no then
      v_msg := nullif(btrim(coalesce(auto.definition->'actions'->0->>'message', '')), '');
      raise exception '%', coalesce(v_msg, format('The rule "%s" refused this.', auto.name))
        using errcode = 'P0001', hint = 'abo_refused', detail = format('refused by the rule "%s"', auto.name);
    end if;
  end loop;
  return new;
end $$;

-- A trigger's function, never a door: nobody calls it but the table.
revoke all on function public.run_record_guards() from public, anon, authenticated;

drop trigger if exists trg_record_guards on public.records;
create trigger trg_record_guards
  before insert or update on public.records
  for each row execute function public.run_record_guards();

NOTIFY pgrst, 'reload schema';
