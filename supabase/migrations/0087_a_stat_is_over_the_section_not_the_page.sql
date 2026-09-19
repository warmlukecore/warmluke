-- Migration 0087: a stat is over the section, not the page.
--
-- Every stat card was computed in the browser over the rows that had
-- loaded — two hundred of them. The header said "of 1,340", the card
-- beside it said "Total revenue" and summed two hundred orders, and
-- nothing said which two hundred. Every merchant past one page has
-- been reading a number that is not theirs.
--
-- So stats move to the server, over every row of the section, with
-- the same expression trees the browser evaluated (abo_eval is the
-- other half of the same engine — parity is checked). Filters and
-- search still narrow them, as they did. And since the server sees
-- the whole section, a stat can now group: "sales by city", "orders
-- per customer" — `by` a field, the top few.
--
-- The store's lists needed one more thing first: the shape the app
-- shows (a cancelled order's status, the customer's name beside the
-- order) was made in TypeScript, row by row, after the page was read.
-- A server-side stat has to see that same shape, so it is now a view
-- per list, and the TypeScript reads the view. One definition.
-- security_invoker: the reader's own rights on the tables decide.
--
-- Callers: src/lib/store-read.ts (readStoreRows, STORE_TABLES),
-- src/components/AppShell.tsx (abo_section_stats), and the checks.

-- ── The store's lists, in the shape the app shows ──────────────

create or replace view public.store_orders with (security_invoker = true) as
select
  o.id,
  o.store_id,
  o.order_number,
  -- The day only: the date column shows a day, and a full timestamp
  -- rendered as a wall of digits.
  to_char(o.placed_at, 'YYYY-MM-DD') as placed_at,
  c.name  as customer_name,
  c.phone as customer_phone,
  o.total,
  o.total_original,
  o.currency,
  -- A cancelled order keeps its last financial status, so showing that
  -- alone would call a cancelled order "paid".
  case when o.cancelled_at is not null then 'Cancelled' else o.financial_status end as status,
  o.fulfilment_status,
  o.financial_status,
  o.cancelled_at,
  nullif(array_to_string(o.tags, ', '), '') as tags
from public.orders o
left join public.customers c on c.id = o.customer_id;

create or replace view public.store_customers with (security_invoker = true) as
select id, store_id, name, phone, email, city, orders_count, total_spent
from public.customers;

create or replace view public.store_products with (security_invoker = true) as
select
  id, store_id, title, product_type, vendor, handle, status,
  nullif(array_to_string(tags, ', '), '') as tags
from public.products;

create or replace view public.store_inventory with (security_invoker = true) as
select
  i.id,
  i.store_id,
  p.title as product,
  v.title as variant,
  v.sku,
  nullif(i.location_name, '') as location_name,
  i.available
from public.inventory_levels i
left join public.variants v on v.id = i.variant_id
left join public.products p on p.id = v.product_id;

grant select on public.store_orders, public.store_customers, public.store_products, public.store_inventory
  to authenticated;

-- ── Helpers ─────────────────────────────────────────────────────

-- A value as the browser counted it: blank and null are 0, a number is
-- itself, text that reads as a number is that number, anything else is
-- left out. Number() in the browser does exactly this.
create or replace function public.abo_stat_num(v jsonb) returns numeric
language plpgsql immutable as $$
declare t text;
begin
  if v is null or jsonb_typeof(v) = 'null' then return 0; end if;
  if jsonb_typeof(v) = 'number' then return (v #>> '{}')::numeric; end if;
  if jsonb_typeof(v) = 'boolean' then return case when (v #>> '{}')::boolean then 1 else 0 end; end if;
  t := btrim(v #>> '{}');
  if t = '' then return 0; end if;
  return t::numeric;
exception when others then
  return null;
end $$;

-- A filter choice matches the way src/lib/filters.ts matches: case and
-- spaces ignored, and a comma-separated cell ("Premium, Snow") matches
-- on any one of its parts.
create or replace function public.abo_stat_matches(v jsonb, chosen text) returns boolean
language plpgsql immutable as $$
declare want text := lower(btrim(chosen)); s text;
begin
  if v is null or jsonb_typeof(v) = 'null' then return want = ''; end if;
  if jsonb_typeof(v) = 'array' then
    return exists (select 1 from jsonb_array_elements_text(v) e where lower(btrim(e)) = want);
  end if;
  s := v #>> '{}';
  if lower(btrim(s)) = want then return true; end if;
  return exists (select 1 from unnest(string_to_array(s, ',')) p where lower(btrim(p)) = want);
end $$;

-- ── The stats ───────────────────────────────────────────────────
--
-- p_stats: the section's features.stats, as designed — label, op,
--   value or field, where, and now by/limit.
-- p_scope: what the person is looking at — { search, search_fields,
--   filters: {field: choice}, computed: [{field, expr}], currency_fields }.
-- Returns one object per stat: { count, value, currencies, groups? }.
-- The browser formats; this counts.
--
-- ponytail: one pass per stat over a temp table of the section's rows,
-- expressions evaluated in plpgsql. Fine to tens of thousands of rows;
-- past that, push the common ops (sum of a field, count where field =
-- x) down to plain SQL before reaching for anything cleverer.
create or replace function public.abo_section_stats(
  p_module uuid,
  p_stats  jsonb,
  p_scope  jsonb default '{}'::jsonb
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_project  uuid;
  v_source   text;
  v_store    uuid;
  v_view     text;
  v_ctx      jsonb;
  v_search   text;
  v_fields   jsonb;
  v_cur      jsonb;
  v_out      jsonb := '[]'::jsonb;
  c          jsonb;
  f          record;
  st         jsonb;
  i          int;
  n          int;
  v_op       text;
  v_val      jsonb;
  v_whr      jsonb;
  v_by       text;
  v_lim      int;
  one        jsonb;
begin
  if auth.uid() is null then
    raise exception 'Not signed in.' using errcode = '42501';
  end if;
  select m.project_id, m.source_table into v_project, v_source
    from public.modules m where m.id = p_module;
  if v_project is null or not public.abo_can_use(v_project) then
    raise exception 'No such section on this account.' using errcode = '42501';
  end if;
  if p_stats is null or jsonb_typeof(p_stats) <> 'array' then
    raise exception 'Stats must be a list.' using errcode = '22023';
  end if;
  n := jsonb_array_length(p_stats);
  if n > 12 then
    raise exception 'Too many stats.' using errcode = '22023';
  end if;
  if n = 0 then return v_out; end if;

  create temp table if not exists abo_stat_rows (rec jsonb) on commit drop;
  truncate abo_stat_rows;

  if v_source is null then
    insert into abo_stat_rows select r.data from public.records r where r.module_id = p_module;
  elsif public.abo_is_store_table(v_source) then
    select s.id into v_store
      from public.stores s
     where s.project_id = v_project and s.status = 'connected'
     limit 1;
    if v_store is not null then
      v_view := case v_source
        when 'orders'           then 'store_orders'
        when 'customers'        then 'store_customers'
        when 'products'         then 'store_products'
        when 'inventory_levels' then 'store_inventory'
        else v_source
      end;
      execute format('insert into abo_stat_rows select to_jsonb(v) from public.%I v where v.store_id = $1', v_view)
        using v_store;
    end if;
  end if;

  v_ctx := jsonb_build_object('module_id', p_module);

  -- Computed columns, in the order declared: each may read the ones
  -- above it, as withComputed does in the browser.
  for c in select value from jsonb_array_elements(coalesce(p_scope->'computed', '[]'::jsonb)) loop
    -- "where true": the API role refuses an update with no where at all.
    update abo_stat_rows
       set rec = rec || jsonb_build_object(c->>'field', public.abo_eval(c->'expr', rec, '{}'::jsonb, '{}'::jsonb, v_ctx))
     where true;
  end loop;

  -- What the person is looking at: the search box, then each filter.
  v_search := nullif(btrim(coalesce(p_scope->>'search', '')), '');
  if v_search is not null then
    v_search := '%' || replace(replace(replace(v_search, '\', '\\'), '%', '\%'), '_', '\_') || '%';
    v_fields := coalesce(p_scope->'search_fields', '[]'::jsonb);
    if jsonb_typeof(v_fields) = 'array' and jsonb_array_length(v_fields) > 0 then
      delete from abo_stat_rows t
       where not exists (
         select 1 from jsonb_array_elements_text(v_fields) fld
          where coalesce(t.rec->>fld, '') ilike v_search);
    else
      delete from abo_stat_rows t
       where not exists (
         select 1 from jsonb_each_text(t.rec) e where e.value ilike v_search);
    end if;
  end if;
  for f in select key, value from jsonb_each_text(coalesce(p_scope->'filters', '{}'::jsonb)) where btrim(value) <> '' loop
    delete from abo_stat_rows t where not public.abo_stat_matches(t.rec -> f.key, f.value);
  end loop;

  v_cur := coalesce(p_scope->'currency_fields', '[]'::jsonb);
  if jsonb_typeof(v_cur) <> 'array' then v_cur := '[]'::jsonb; end if;

  for i in 0 .. n - 1 loop
    st    := p_stats->i;
    v_op  := coalesce(st->>'op', 'count');
    v_val := coalesce(st->'value', case when st->>'field' is not null then jsonb_build_object('field', st->>'field') else null end);
    v_whr := st->'where';
    v_by  := nullif(btrim(coalesce(st->>'by', '')), '');
    v_lim := least(greatest(coalesce((st->>'limit')::int, 5), 1), 20);

    if v_by is null then
      with m as (
        select public.abo_stat_num(
                 case when v_op = 'count' or v_val is null then '0'::jsonb
                      else public.abo_eval(v_val, rec, '{}'::jsonb, '{}'::jsonb, v_ctx) end) as v,
               rec
          from abo_stat_rows
         where v_whr is null or public.abo_bool(public.abo_eval(v_whr, rec, '{}'::jsonb, '{}'::jsonb, v_ctx))
      )
      select jsonb_build_object(
               'count', count(*),
               'value', case v_op
                          when 'count' then count(*)::numeric
                          when 'sum'   then coalesce(sum(v), 0)
                          when 'avg'   then avg(v)
                          when 'min'   then min(v)
                          when 'max'   then max(v)
                        end,
               'currencies', (select coalesce(jsonb_agg(distinct x), '[]'::jsonb)
                                from (select m2.rec->>cf as x from m m2, jsonb_array_elements_text(v_cur) cf) q
                               where coalesce(x, '') <> ''))
        into one
        from m;
    else
      with m as (
        select public.abo_stat_num(
                 case when v_op = 'count' or v_val is null then '0'::jsonb
                      else public.abo_eval(v_val, rec, '{}'::jsonb, '{}'::jsonb, v_ctx) end) as v,
               rec
          from abo_stat_rows
         where v_whr is null or public.abo_bool(public.abo_eval(v_whr, rec, '{}'::jsonb, '{}'::jsonb, v_ctx))
      ),
      g as (
        select coalesce(rec->>v_by, '') as k,
               count(*) as c,
               case v_op
                 when 'count' then count(*)::numeric
                 when 'sum'   then coalesce(sum(v), 0)
                 when 'avg'   then avg(v)
                 when 'min'   then min(v)
                 when 'max'   then max(v)
               end as agg
          from m
         group by 1
      )
      select jsonb_build_object(
               'count', (select count(*) from m),
               'currencies', (select coalesce(jsonb_agg(distinct x), '[]'::jsonb)
                                from (select m2.rec->>cf as x from m m2, jsonb_array_elements_text(v_cur) cf) q
                               where coalesce(x, '') <> ''),
               'groups', coalesce((select jsonb_agg(jsonb_build_object('key', t.k, 'value', t.agg, 'count', t.c)
                                                    order by t.agg desc nulls last, t.c desc, t.k)
                                     from (select * from g order by agg desc nulls last, c desc, k limit v_lim) t),
                                  '[]'::jsonb))
        into one;
    end if;
    v_out := v_out || jsonb_build_array(one);
  end loop;

  return v_out;
end $$;

revoke all on function public.abo_section_stats(uuid, jsonb, jsonb) from public;
grant execute on function public.abo_section_stats(uuid, jsonb, jsonb) to authenticated;
revoke all on function public.abo_stat_num(jsonb) from public;
grant execute on function public.abo_stat_num(jsonb) to authenticated;
revoke all on function public.abo_stat_matches(jsonb, text) from public;
grant execute on function public.abo_stat_matches(jsonb, text) to authenticated;

NOTIFY pgrst, 'reload schema';
