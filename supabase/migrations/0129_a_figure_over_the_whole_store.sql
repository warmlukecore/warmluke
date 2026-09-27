-- A figure over the whole store.
--
-- Asked "revenue by week for the last six months", Luke had a page of
-- two hundred orders and its own arithmetic: the answer was over the
-- page, and read as the shop's. A total, an average or a breakdown is
-- now counted here, in the database, over every order the store holds:
-- one measure (orders, revenue, units, average order, customers, new
-- customers), by one dimension (a day, week or month in the store's
-- own time; a product, city, state, gateway, status or customer), in a
-- window, under a few filters. Cancelled orders are left out unless
-- asked for. Never free SQL: the measures and dimensions are the two
-- lists below, and the TypeScript registry (STORE_METRICS in
-- src/lib/store-read.ts) names the same ones; check-store-metrics
-- holds the two together.
--
-- Definer, so the joins run without a client's row policies in the
-- way, and abo_can_use decides the door, as abo_section_stats does.
-- Five seconds, two hundred groups: bounded whatever is asked.

create or replace function public.abo_store_metrics(
  p_store   uuid,
  p_measure text,
  p_by      text  default 'none',
  p_from    date  default null,
  p_to      date  default null,
  p_filters jsonb default '{}'::jsonb
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_project  uuid;
  v_tz       text;
  v_currency text;
  v_from     timestamptz;
  v_to       timestamptz;
  v_where    text;
  v_join     text := '';
  v_key      text;
  v_val      text;
  v_order    text;
  v_groups   jsonb;
  v_total    jsonb;
  v_limit    constant int := 200;
  f          record;
begin
  if auth.uid() is null then
    raise exception 'Not signed in.' using errcode = '42501';
  end if;
  select s.project_id, coalesce(s.timezone, 'UTC'), s.currency
    into v_project, v_tz, v_currency
    from public.stores s where s.id = p_store;
  if v_project is null or not public.abo_can_use(v_project) then
    raise exception 'No such store on this account.' using errcode = '42501';
  end if;
  if p_measure not in ('orders', 'revenue', 'units', 'aov', 'customers', 'new_customers') then
    raise exception 'Not a measure: %', p_measure using errcode = '22023';
  end if;
  if p_by not in ('none', 'day', 'week', 'month', 'product', 'city', 'state', 'gateway', 'status', 'fulfilment', 'customer') then
    raise exception 'Not a dimension: %', p_by using errcode = '22023';
  end if;
  perform set_config('statement_timeout', '5000', true);

  -- The window, in the store's own day: from the start of p_from to the end of p_to.
  if p_from is not null then v_from := (p_from::timestamp) at time zone v_tz; end if;
  if p_to   is not null then v_to   := ((p_to + 1)::timestamp) at time zone v_tz; end if;
  if v_from is not null and v_to is not null and v_to <= v_from then
    raise exception 'The window ends before it starts.' using errcode = '22023';
  end if;

  -- The rows: this store's orders, in the window, not cancelled unless asked.
  v_where := format('o.store_id = %L', p_store);
  if v_from is not null then v_where := v_where || format(' and o.placed_at >= %L', v_from); end if;
  if v_to   is not null then v_where := v_where || format(' and o.placed_at < %L', v_to); end if;
  if not coalesce((p_filters->>'include_cancelled')::boolean, false) then
    v_where := v_where || ' and o.cancelled_at is null';
  end if;
  for f in
    select key, value from jsonb_each_text(coalesce(p_filters, '{}'::jsonb))
     where key in ('status', 'gateway', 'fulfilment', 'city', 'state') and btrim(value) <> ''
  loop
    v_where := v_where || format(' and %s = %L',
      case f.key
        when 'status'     then 'o.financial_status'
        when 'gateway'    then 'o.gateway'
        when 'fulfilment' then 'o.fulfilment_status'
        when 'city'       then 'o.ship_city'
        when 'state'      then 'o.ship_state'
      end, f.value);
  end loop;
  if btrim(coalesce(p_filters->>'product', '')) <> '' then
    v_where := v_where || format(
      ' and exists (select 1 from public.order_line_items lf left join public.products pf on pf.id = lf.product_id where lf.order_id = o.id and coalesce(pf.title, lf.title) ilike %L)',
      '%' || (p_filters->>'product') || '%');
  end if;

  -- What each row is grouped under.
  v_key := case p_by
    when 'none'       then '''all'''
    when 'day'        then format('to_char(o.placed_at at time zone %L, ''YYYY-MM-DD'')', v_tz)
    when 'week'       then format('to_char(date_trunc(''week'', o.placed_at at time zone %L), ''YYYY-MM-DD'')', v_tz)
    when 'month'      then format('to_char(o.placed_at at time zone %L, ''YYYY-MM'')', v_tz)
    when 'city'       then 'coalesce(o.ship_city, ''—'')'
    when 'state'      then 'coalesce(o.ship_state, ''—'')'
    when 'gateway'    then 'coalesce(o.gateway, ''—'')'
    when 'status'     then 'case when o.cancelled_at is not null then ''Cancelled'' else coalesce(o.financial_status, ''—'') end'
    when 'fulfilment' then 'coalesce(o.fulfilment_status, ''—'')'
    when 'product'    then 'coalesce(p.title, li.title, ''—'')'
    when 'customer'   then 'coalesce(c.name, c.email, ''no name'')'
  end;

  -- Lines are joined only when the figure is per line (units, or
  -- anything by product): an order spans products, and money summed
  -- over its lines is the only revenue a product can be said to have.
  if p_by = 'product' or p_measure = 'units' then
    v_join := ' join public.order_line_items li on li.order_id = o.id left join public.products p on p.id = li.product_id';
  end if;
  if p_by = 'customer' then
    v_join := v_join || ' left join public.customers c on c.id = o.customer_id';
  end if;

  v_val := case p_measure
    when 'orders'    then 'count(distinct o.id)'
    when 'units'     then 'coalesce(sum(li.quantity), 0)'
    when 'customers' then 'count(distinct o.customer_id)'
    -- A customer is new in the window when this is their first order in the shop.
    when 'new_customers' then 'count(distinct o.customer_id) filter (where o.placed_at = (select min(o2.placed_at) from public.orders o2 where o2.store_id = o.store_id and o2.customer_id = o.customer_id and o2.cancelled_at is null))'
    when 'revenue'   then case when p_by = 'product' then 'coalesce(sum(li.price * li.quantity), 0)' else 'coalesce(sum(o.total), 0)' end
    when 'aov'       then case when p_by = 'product' then 'coalesce(sum(li.price * li.quantity), 0) / greatest(count(distinct o.id), 1)' else 'avg(o.total)' end
  end;
  -- Time reads in order; everything else biggest first.
  v_order := case when p_by in ('day', 'week', 'month') then 'k' else 'v desc nulls last, n desc, k' end;

  execute format(
    'select coalesce(jsonb_agg(jsonb_build_object(''key'', k, ''value'', v, ''orders'', n) order by %s), ''[]''::jsonb)
       from (select %s as k, %s as v, count(distinct o.id) as n
               from public.orders o%s where %s group by 1 order by %s limit %s) g',
    v_order, v_key, v_val, v_join, v_where, v_order, v_limit + 1)
    into v_groups;
  execute format(
    'select jsonb_build_object(''value'', %s, ''orders'', count(distinct o.id)) from public.orders o%s where %s',
    v_val, v_join, v_where)
    into v_total;

  return jsonb_build_object(
    'measure', p_measure, 'by', p_by,
    'from', p_from, 'to', p_to, 'timezone', v_tz, 'currency', v_currency,
    'cancelled_included', coalesce((p_filters->>'include_cancelled')::boolean, false),
    'total', v_total,
    'groups', (select coalesce(jsonb_agg(e), '[]'::jsonb) from (select e from jsonb_array_elements(v_groups) e limit v_limit) x),
    'truncated', jsonb_array_length(v_groups) > v_limit
  );
end $$;

revoke all on function public.abo_store_metrics(uuid, text, text, date, date, jsonb) from public;
grant execute on function public.abo_store_metrics(uuid, text, text, date, date, jsonb) to authenticated;

NOTIFY pgrst, 'reload schema';
