-- Migration 0217: any of the store's lists, counted exactly (docs/reference/limits.md)
--
-- Luke and the owner's own AI could read 200 rows of a list, newest first,
-- and total only orders (abo_store_metrics). Every question past that —
-- what ads cost this month, which campaign pays, how much settled, which
-- template is read — was answered from a page, or not at all.
--
--   abo_store_query(store, list, spec)   one read over any store list:
--     rows    filtered, sorted, a page at a time with the count of all
--     groups  exact totals (count, sum, avg, min, max, distinct) over
--             every matching row, by up to two columns or by day, week,
--             month or year, with the overall totals beside them
--
-- It runs as its caller: the lists are security_invoker views, so the
-- database's own policies decide which rows anyone sees — the owner, a
-- teammate, or their AI's token. Nothing is written. A column is used
-- only if the list has it (named from information_schema, then %I), every
-- value is a quoted literal (%L), and a query has ten seconds.
--
--   store_campaign_results   each ad campaign's day beside the store's own
--                            orders whose last visit named that campaign
--                            (utm_campaign = its name or id): true ROAS.

create or replace function public.abo_store_query(p_store uuid, p_list text, p_spec jsonb default '{}'::jsonb)
returns jsonb
language plpgsql stable security invoker set search_path = public set statement_timeout = '10s' as $$
declare
  v_view    text := public.abo_store_view(p_list);
  v_cols    jsonb;
  v_where   text;
  v_numeric constant text[] := array['numeric', 'integer', 'bigint', 'smallint', 'real', 'double precision'];
  f         jsonb;
  v_field   text;
  v_op      text;
  v_val     text;
  v_sym     text;
  g         jsonb;
  v_by      text;
  v_keys    text[] := '{}';
  v_key_sql text[] := '{}';
  v_key     text;
  m         jsonb;
  v_fn      text;
  v_as      text;
  v_fig     text;
  v_meas    text[] := '{}';
  v_aliases text[] := '{}';
  v_order   text;
  v_desc    boolean;
  v_limit   integer;
  v_offset  integer;
  v_result  jsonb;
  v_count   bigint;
  v_totals  jsonb;
  v_tz      text;
  v_day     text;
begin
  if auth.uid() is null then
    raise exception 'Not signed in.' using errcode = '42501';
  end if;
  if v_view is null then
    raise exception '"%" is not one of the store''s lists.', p_list using errcode = '22023';
  end if;
  if not exists (select 1 from public.stores s where s.id = p_store and public.abo_store_readable(s.id)) then
    raise exception 'Not a store you can read.' using errcode = '42501';
  end if;
  select jsonb_object_agg(c.column_name, c.data_type) into v_cols
    from information_schema.columns c
   where c.table_schema = 'public' and c.table_name = v_view;
  v_where := format('store_id = %L', p_store);
  -- A list's own date is already the store's day; a raw timestamp is made one.
  select coalesce(s.timezone, 'UTC') into v_tz from public.stores s where s.id = p_store;

  -- ── Which rows ──────────────────────────────────────────────
  if jsonb_array_length(coalesce(p_spec->'where', '[]')) > 12 then
    raise exception 'At most 12 conditions.' using errcode = '22023';
  end if;
  for f in select * from jsonb_array_elements(coalesce(p_spec->'where', '[]')) loop
    v_field := f->>'field';
    v_op := coalesce(f->>'op', 'eq');
    v_val := f->'value' #>> '{}';
    if v_field is null or v_cols->>v_field is null or v_field = 'store_id' then
      raise exception 'The list % has no column "%".', p_list, v_field using errcode = '22023';
    end if;
    v_sym := case v_op when 'gt' then '>' when 'gte' then '>=' when 'lt' then '<' when 'lte' then '<=' end;
    v_where := v_where || ' and ' || case
      when v_op = 'eq' then format('%I::text = %L', v_field, v_val)
      when v_op = 'neq' then format('%I::text is distinct from %L', v_field, v_val)
      when v_sym is not null and (v_cols->>v_field) = any (v_numeric) then format('%I %s %L::numeric', v_field, v_sym, v_val)
      when v_sym is not null then format('%I::text %s %L', v_field, v_sym, v_val)
      when v_op = 'contains' then
        format('%I::text ilike %L', v_field, '%' || replace(replace(replace(v_val, '\', '\\'), '%', '\%'), '_', '\_') || '%')
      when v_op = 'starts_with' then
        format('%I::text ilike %L', v_field, replace(replace(replace(v_val, '\', '\\'), '%', '\%'), '_', '\_') || '%')
      when v_op = 'in' and jsonb_typeof(f->'value') = 'array' then
        format('%I::text = any (%L::text[])', v_field, array(select jsonb_array_elements_text(f->'value')))
      when v_op = 'is_empty' then format('(%I is null or %I::text = %L)', v_field, v_field, '')
      when v_op = 'not_empty' then format('(%I is not null and %I::text <> %L)', v_field, v_field, '')
      else null
    end;
    if v_where is null then
      raise exception 'Not a condition: "%" (eq, neq, gt, gte, lt, lte, contains, starts_with, in, is_empty, not_empty).', v_op
        using errcode = '22023';
    end if;
  end loop;
  -- A span of days, on the list's own date column.
  v_field := p_spec->>'date_field';
  if v_field is not null and (p_spec ? 'from' or p_spec ? 'to') then
    if v_cols->>v_field is null then
      raise exception 'The list % has no column "%".', p_list, v_field using errcode = '22023';
    end if;
    v_day := case when v_cols->>v_field = 'timestamp with time zone'
      then format('to_char(%I at time zone %L, %L)', v_field, v_tz, 'YYYY-MM-DD')
      else format('left(%I::text, 10)', v_field) end;
    if p_spec->>'from' is not null then
      v_where := v_where || format(' and %s >= %L', v_day, (p_spec->>'from')::date::text);
    end if;
    if p_spec->>'to' is not null then
      v_where := v_where || format(' and %s <= %L', v_day, (p_spec->>'to')::date::text);
    end if;
  end if;

  -- ── Totals ──────────────────────────────────────────────────
  if jsonb_array_length(coalesce(p_spec->'measures', '[]')) > 0 then
    if jsonb_array_length(p_spec->'measures') > 8 or jsonb_array_length(coalesce(p_spec->'group_by', '[]')) > 2 then
      raise exception 'At most 8 figures, by at most 2 columns.' using errcode = '22023';
    end if;
    for g in select * from jsonb_array_elements(coalesce(p_spec->'group_by', '[]')) loop
      v_field := coalesce(g->>'field', g #>> '{}');
      v_by := g->>'by';
      if v_field is null or v_cols->>v_field is null or v_field = 'store_id' then
        raise exception 'The list % has no column "%".', p_list, v_field using errcode = '22023';
      end if;
      v_day := case when v_cols->>v_field = 'timestamp with time zone'
        then format('to_char(%I at time zone %L, %L)', v_field, v_tz, 'YYYY-MM-DD')
        else format('left(%I::text, 10)', v_field) end;
      v_key := case
        when v_by is null then format('%I', v_field)
        when v_by = 'day' then v_day
        when v_by = 'week' then format('to_char(date_trunc(%L, (%s)::date), %L)', 'week', v_day, 'YYYY-MM-DD')
        when v_by = 'month' then format('left(%s, 7)', v_day)
        when v_by = 'year' then format('left(%s, 4)', v_day)
      end;
      if v_key is null then
        raise exception 'Not a way to group: "%" (day, week, month, year).', v_by using errcode = '22023';
      end if;
      v_key_sql := v_key_sql || v_key;
      v_keys := v_keys || (v_field || coalesce('_' || v_by, ''));
    end loop;
    for m in select * from jsonb_array_elements(p_spec->'measures') loop
      v_fn := coalesce(m->>'fn', 'count');
      v_field := m->>'field';
      if v_field is not null and (v_cols->>v_field is null or v_field = 'store_id') then
        raise exception 'The list % has no column "%".', p_list, v_field using errcode = '22023';
      end if;
      if v_fn in ('sum', 'avg') and not ((v_cols->>v_field) = any (v_numeric)) then
        raise exception '% needs a column of numbers; "%" is not one.', v_fn, v_field using errcode = '22023';
      end if;
      v_fig := case
        when v_fn = 'count' then 'count(*)'
        when v_field is null then null
        when v_fn = 'count_distinct' then format('count(distinct %I)', v_field)
        when v_fn = 'sum' then format('round(sum(%I)::numeric, 2)', v_field)
        when v_fn = 'avg' then format('round(avg(%I)::numeric, 2)', v_field)
        when v_fn = 'min' then format('min(%I)', v_field)
        when v_fn = 'max' then format('max(%I)', v_field)
      end;
      if v_fig is null then
        raise exception 'Not a figure: "%" (count, count_distinct, sum, avg, min, max, with a column but for count).', v_fn
          using errcode = '22023';
      end if;
      v_as := left(coalesce(nullif(m->>'as', ''), v_fn || coalesce('_' || v_field, '')), 60);
      v_aliases := v_aliases || v_as;
      v_meas := v_meas || (v_fig || format(' as %I', v_as));
    end loop;
    v_order := coalesce(p_spec->'order'->>'by', v_aliases[1]);
    v_desc := coalesce((p_spec->'order'->>'desc')::boolean, true);
    if not (v_order = any (v_aliases) or v_order = any (v_keys)) then
      raise exception 'Order by one of the figures or groups, not "%".', v_order using errcode = '22023';
    end if;
    v_limit := least(greatest(coalesce((p_spec->>'limit')::int, 100), 1), 1000);
    -- Every matching row, counted once overall.
    execute format('select to_jsonb(t) from (select %s from %I where %s) t', array_to_string(v_meas, ', '), v_view, v_where)
      into v_totals;
    if coalesce(array_length(v_keys, 1), 0) = 0 then
      return jsonb_build_object('list', p_list, 'totals', v_totals, 'groups', '[]'::jsonb, 'group_count', 0, 'showing', 0);
    end if;
    execute format(
      'select count(*) from (select 1 from %I where %s group by %s) t',
      v_view, v_where, array_to_string(v_key_sql, ', ')
    ) into v_count;
    execute format(
      'select coalesce(jsonb_agg(to_jsonb(t)), %L::jsonb) from (select %s, %s from %I where %s group by %s order by %I %s nulls last limit %s) t',
      '[]',
      (select string_agg(format('%s as %I', k, a), ', ') from unnest(v_key_sql, v_keys) as u(k, a)),
      array_to_string(v_meas, ', '),
      v_view, v_where, array_to_string(v_key_sql, ', '), v_order, case when v_desc then 'desc' else 'asc' end, v_limit
    ) into v_result;
    return jsonb_build_object(
      'list', p_list, 'totals', v_totals, 'groups', v_result, 'group_count', v_count,
      'showing', jsonb_array_length(v_result)
    );
  end if;

  -- ── Rows ────────────────────────────────────────────────────
  v_order := coalesce(p_spec->'order'->>'by', p_spec->>'default_order');
  v_desc := coalesce((p_spec->'order'->>'desc')::boolean, true);
  if v_order is not null and (v_cols->>v_order is null) then
    raise exception 'The list % has no column "%".', p_list, v_order using errcode = '22023';
  end if;
  v_limit := least(greatest(coalesce((p_spec->>'limit')::int, 100), 1), 500);
  v_offset := greatest(coalesce((p_spec->>'offset')::int, 0), 0);
  execute format('select count(*) from %I where %s', v_view, v_where) into v_count;
  execute format(
    'select coalesce(jsonb_agg(to_jsonb(t) - %L), %L::jsonb) from (select * from %I where %s %s limit %s offset %s) t',
    'store_id', '[]', v_view, v_where,
    case when v_order is null then '' else format('order by %I %s nulls last', v_order, case when v_desc then 'desc' else 'asc' end) end,
    v_limit, v_offset
  ) into v_result;
  return jsonb_build_object(
    'list', p_list, 'matched', v_count, 'offset', v_offset, 'showing', jsonb_array_length(v_result), 'rows', v_result
  );
end $$;

revoke all on function public.abo_store_query(uuid, text, jsonb) from public, anon;
grant execute on function public.abo_store_query(uuid, text, jsonb) to authenticated;

-- ── Campaign results: what ads cost beside what the store sold ──
-- ponytail: matched on the order's last visit (utm_campaign naming the
-- campaign's name or id) and its own day; an order that came another way,
-- or a campaign tagged otherwise, is not counted for it.
create or replace view public.store_campaign_results with (security_invoker = true) as
with spend as (
  select a.store_id, a.provider, a.campaign_id, max(a.campaign_name) as campaign_name, a.day,
         sum(a.spend) as spend, max(a.currency) as currency, sum(a.impressions) as impressions,
         sum(a.clicks) as clicks, sum(a.purchases) as platform_purchases,
         sum(a.purchase_value) as platform_value
    from public.ad_spend a
   group by a.store_id, a.provider, a.campaign_id, a.day
)
select md5(s.store_id::text || '/' || s.provider || '/' || s.campaign_id || '/' || s.day::text)::uuid as id,
       s.store_id, s.provider,
       to_char(s.day, 'YYYY-MM-DD') as day,
       s.campaign_name, s.campaign_id,
       s.spend, s.currency, s.impressions, s.clicks,
       s.platform_purchases, s.platform_value,
       coalesce(m.orders, 0) as store_orders,
       coalesce(m.revenue, 0) as store_revenue,
       round(coalesce(m.revenue, 0) / nullif(s.spend, 0), 2) as store_roas,
       round(s.spend / nullif(m.orders, 0), 2) as cost_per_order,
       round(s.platform_value / nullif(s.spend, 0), 2) as platform_roas
  from spend s
  join public.stores st on st.id = s.store_id
  left join lateral (
    select count(*) as orders, sum(o.total) as revenue
      from public.orders o
     where o.store_id = s.store_id
       and o.cancelled_at is null
       and nullif(btrim(o.utm_campaign), '') is not null
       and lower(btrim(o.utm_campaign)) in (lower(btrim(s.campaign_name)), lower(s.campaign_id))
       and (o.placed_at at time zone coalesce(st.timezone, 'UTC'))::date = s.day
  ) m on true;
grant select on public.store_campaign_results to authenticated;

-- 0216's mapping, one line longer: the list every reader finds by name.
create or replace function public.abo_store_view(t text) returns text
language sql immutable as $$
  select case t
    when 'orders'              then 'store_orders'
    when 'customers'           then 'store_customers'
    when 'products'            then 'store_products'
    when 'inventory_levels'    then 'store_inventory'
    when 'product_sales'       then 'product_sales'
    when 'order_line_items'    then 'store_order_items'
    when 'refunds'             then 'store_refunds'
    when 'variants'            then 'store_variants'
    when 'fulfillments'        then 'store_fulfillments'
    when 'transactions'        then 'store_transactions'
    when 'locations'           then 'store_locations'
    when 'collections'         then 'store_collections'
    when 'carts'               then 'store_abandoned_checkouts'
    when 'drafts'              then 'store_draft_orders'
    when 'draft_order_items'   then 'store_draft_order_items'
    when 'discounts'           then 'store_discounts'
    when 'returns'             then 'store_returns'
    when 'return_reasons'      then 'return_reasons'
    when 'payouts'             then 'store_payouts'
    when 'courier_shipments'   then 'store_courier_shipments'
    when 'stock_pools'         then 'store_stock_pools'
    when 'ad_spend'            then 'store_ad_spend'
    when 'web_traffic'         then 'store_web_traffic'
    when 'email_campaigns'     then 'store_email_campaigns'
    when 'support_tickets'     then 'store_support_tickets'
    when 'crm_contacts'        then 'store_crm_contacts'
    when 'social_posts'        then 'store_social_posts'
    when 'message_stats'       then 'store_message_stats'
    when 'gateway_payments'    then 'store_gateway_payments'
    when 'gateway_settlements' then 'store_gateway_settlements'
    when 'campaign_results'    then 'store_campaign_results'
  end;
$$;

notify pgrst, 'reload schema';
