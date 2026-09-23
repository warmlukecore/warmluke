-- How the store is doing, in one call: the numbers the Overview page
-- opens on.
--
-- Counted here rather than in the browser, because the browser only
-- ever holds a page of rows and a store has thousands of orders; a sum
-- over the page it happens to hold is a wrong number that looks right.
--
-- The money follows the rule the rest of the app already states
-- (store-read.ts, orders.advice): collected is what was paid, awaiting
-- is what is still pending — cash on delivery, mostly — and a cancelled
-- order counts towards neither. Each currency is summed on its own and
-- never added to another. Days are the store's days, in the store's
-- timezone, so "today" on a Kolkata store ends at midnight in Kolkata.
--
-- Not the MCP tool of the same idea (store_overview in /api/mcp): that
-- one says how many rows each list holds; this says how trade is going.
--
-- Callers: src/components/Overview.tsx.

create or replace function public.abo_store_overview(p_project uuid)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_store  public.stores%rowtype;
  v_tz     text;
  v_today  date;
  v_since  timestamptz;
  v_orders jsonb;
  v_money  jsonb;
  v_daily  jsonb;
  v_stock  jsonb;
  v_open   int;
begin
  if auth.uid() is null then
    raise exception 'Not signed in.' using errcode = '42501';
  end if;
  if p_project is null or not public.abo_can_use(p_project) then
    raise exception 'No such project on this account.' using errcode = '42501';
  end if;

  -- The connected store if there is one, else the latest there was:
  -- a store taken off Shopify still has its rows until it is erased.
  select * into v_store
    from public.stores
   where project_id = p_project
   order by (status = 'connected') desc, connected_at desc nulls last
   limit 1;
  if not found then
    return jsonb_build_object('store', null);
  end if;

  -- A zone Postgres does not know would make every date below an error.
  v_tz := case
            when exists (select 1 from pg_timezone_names where name = v_store.timezone) then v_store.timezone
            else 'UTC'
          end;
  v_today := (now() at time zone v_tz)::date;
  v_since := ((v_today - 29)::timestamp) at time zone v_tz;

  select jsonb_build_object(
           'today',   count(*) filter (where (placed_at at time zone v_tz)::date = v_today),
           'last_7',  count(*) filter (where (placed_at at time zone v_tz)::date > v_today - 7),
           'last_30', count(*)
         )
    into v_orders
    from public.orders
   where store_id = v_store.id and placed_at >= v_since and cancelled_at is null;

  select coalesce(jsonb_agg(m order by m->>'currency'), '[]'::jsonb)
    into v_money
    from (
      select jsonb_build_object(
               'currency',       currency,
               'collected',      coalesce(sum(total) filter (where financial_status = 'PAID'), 0),
               'awaiting',       coalesce(sum(total) filter (where financial_status = 'PENDING'), 0),
               'awaiting_count', count(*) filter (where financial_status = 'PENDING'),
               'average',        round(avg(total_original), 2),
               'orders',         count(*)
             ) as m
        from public.orders
       where store_id = v_store.id and placed_at >= v_since and cancelled_at is null
         and currency is not null
       group by currency
    ) x;

  -- Fourteen days, every day present even when nothing was ordered,
  -- so a quiet Sunday is a short bar and not a missing one.
  select coalesce(jsonb_agg(jsonb_build_object('day', d.day::date, 'orders', coalesce(o.n, 0)) order by d.day), '[]'::jsonb)
    into v_daily
    from generate_series((v_today - 13)::timestamp, v_today::timestamp, interval '1 day') as d(day)
    left join (
      select (placed_at at time zone v_tz)::date as day, count(*) as n
        from public.orders
       where store_id = v_store.id and cancelled_at is null
         and placed_at >= ((v_today - 13)::timestamp) at time zone v_tz
       group by 1
    ) o on o.day = d.day::date;

  -- Work still to do, whenever the order came in.
  select count(*) into v_open
    from public.orders
   where store_id = v_store.id and cancelled_at is null
     and fulfilment_status in ('UNFULFILLED', 'PARTIALLY_FULFILLED', 'IN_PROGRESS', 'ON_HOLD',
                               'SCHEDULED', 'OPEN', 'PENDING_FULFILLMENT');

  -- The stock list's own words for each state (0097), counted.
  select coalesce(jsonb_object_agg(stock_state, n), '{}'::jsonb)
    into v_stock
    from (
      select stock_state, count(*) as n
        from public.store_inventory
       where store_id = v_store.id
       group by stock_state
    ) s;

  return jsonb_build_object(
    'store', jsonb_build_object(
      'shop_domain',    v_store.shop_domain,
      'status',         v_store.status,
      'currency',       v_store.currency,
      'timezone',       v_tz,
      'last_synced_at', v_store.last_synced_at
    ),
    'today',     v_today,
    'orders',    v_orders,
    'money',     v_money,
    'daily',     v_daily,
    'to_fulfil', v_open,
    'stock',     v_stock,
    'customers', (select count(*) from public.customers where store_id = v_store.id),
    'products',  (select count(*) from public.products where store_id = v_store.id)
  );
end $$;

revoke all on function public.abo_store_overview(uuid) from public, anon;
grant execute on function public.abo_store_overview(uuid) to authenticated;

NOTIFY pgrst, 'reload schema';
