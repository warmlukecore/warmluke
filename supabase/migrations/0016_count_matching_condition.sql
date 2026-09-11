-- Migration 0016: count_matching takes a condition.
--
-- It could only ask "how many other rows share these field values",
-- which cannot express the commonest parent/child question of all:
-- "are any of this order's lines still unverified?" A real warehouse
-- design came back with `count_matching(order_id) is 0` — true only
-- for single-line orders, so the order never moved to Packed.
--
--   { "op": "count_matching", "args": [
--       { "field": "order_id" },                       <- match on
--       { "op": "!=", "args": [ { "field": "verified" },
--                               { "const": "Complete" } ] } ] }
--
-- Field leaves say which rows are siblings; an operator arg is a test
-- run against each sibling. No new syntax: args already carry both.

create or replace function public.abo_eval(
  node jsonb,
  rec jsonb,
  prev jsonb,
  tgt jsonb,
  ctx jsonb default '{}'::jsonb
) returns jsonb as $$
declare
  op text; args jsonb; n int; a jsonb; b jsonb; acc numeric; i int; s text;
  cnt int; other record; same boolean; fname text; arg jsonb;
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

  if op = 'count_matching' then
    if ctx->>'module_id' is null or n = 0 then return to_jsonb(0); end if;
    cnt := 0;
    for other in
      select r.id, r.data from public.records r
      where r.module_id = (ctx->>'module_id')::uuid
        and (ctx->>'record_id' is null or r.id <> (ctx->>'record_id')::uuid)
    loop
      same := true;

      -- Field leaves: the sibling must share this row's value.
      for i in 0 .. n - 1 loop
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
        for i in 0 .. n - 1 loop
          arg := args->i;
          if not (arg ? 'op') then continue; end if;
          if not public.abo_bool(public.abo_eval(arg, other.data, '{}'::jsonb, tgt, ctx)) then
            same := false;
            exit;
          end if;
        end loop;
      end if;

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
$$ language plpgsql stable;

NOTIFY pgrst, 'reload schema';
