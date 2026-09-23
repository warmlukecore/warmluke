-- The overview says what it counted, and guesses nothing.
--
-- 0113 counted a thirty-day window and a fourteen-day chart, and the page
-- wrote "30 days" and "14 days" beside them from its own copy of those
-- numbers — two places that had to agree. It also said the unpaid orders
-- were "cash on delivery mostly", which was the page's guess about this
-- merchant, not a fact about their orders. And the stock worth watching
-- was picked in the page by a list of the stock view's words.
--
-- Now the function takes the windows (defaults 30 and 14, the only place
-- those numbers live) and says back which it used; the page labels from
-- the answer. The unpaid orders come with the payment method most of
-- them are waiting on, from the orders themselves. The stock to watch is
-- chosen here, by the rule behind the stock view's words: a tracked
-- variant with nothing left to sell.
--
-- The rest is 0113's rule, unchanged: collected is what was paid,
-- awaiting is what is still pending, a cancelled order counts towards
-- neither, currencies are never added together, and days are the store's
-- own, in its timezone.
--
-- The one-argument version is dropped rather than overloaded: two
-- functions that both answer a call with one argument make it ambiguous.
--
-- Callers: src/components/Overview.tsx.

drop function if exists public.abo_store_overview(uuid);

create or replace function public.abo_store_overview(
  p_project    uuid,
  p_days       int default 30,
  p_chart_days int default 14
)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_store  public.stores%rowtype;
  v_tz     text;
  v_days   int := coalesce(p_days, 30);
  v_chart  int := coalesce(p_chart_days, 14);
  v_today  date;
  v_from   timestamptz;
  v_orders jsonb;
  v_money  jsonb;
  v_daily  jsonb;
  v_stock  jsonb;
  v_watch  jsonb;
  v_count  int;
  v_open   int;
begin
  if auth.uid() is null then
    raise exception 'Not signed in.' using errcode = '42501';
  end if;
  if p_project is null or not public.abo_can_use(p_project) then
    raise exception 'No such project on this account.' using errcode = '42501';
  end if;
  if v_days < 1 or v_days > 365 or v_chart < 1 or v_chart > 90 then
    raise exception 'The window is 1 to 365 days, the chart 1 to 90.' using errcode = '22023';
  end if;

  -- The connected store if there is one, else the latest there was:
  -- a store taken off Shopify still has its rows until it is erased.
  select * into v_store
    from public.stores
   where project_id = p_project
   order by (status = 'connected') desc, connected_at desc nulls last
   limit 1;
  if not found then
    return jsonb_build_object('store', null, 'days', v_days, 'chart_days', v_chart);
  end if;

  -- A zone Postgres does not know would make every date below an error.
  v_tz := case
            when exists (select 1 from pg_timezone_names where name = v_store.timezone) then v_store.timezone
            else 'UTC'
          end;
  v_today := (now() at time zone v_tz)::date;
  v_from  := ((v_today - (v_days - 1))::timestamp) at time zone v_tz;

  select jsonb_build_object(
           'today',     count(*) filter (where (placed_at at time zone v_tz)::date = v_today),
           'yesterday', count(*) filter (where (placed_at at time zone v_tz)::date = v_today - 1),
           'window',    count(*) filter (where placed_at >= v_from)
         )
    into v_orders
    from public.orders
   where store_id = v_store.id and cancelled_at is null
     and placed_at >= least(v_from, ((v_today - 1)::timestamp) at time zone v_tz);

  select coalesce(jsonb_agg(m order by m->>'currency'), '[]'::jsonb)
    into v_money
    from (
      select jsonb_build_object(
               'currency',       o.currency,
               'collected',      coalesce(sum(o.total) filter (where o.financial_status = 'PAID'), 0),
               'awaiting',       coalesce(sum(o.total) filter (where o.financial_status = 'PENDING'), 0),
               'awaiting_count', count(*) filter (where o.financial_status = 'PENDING'),
               -- What most of the unpaid orders are waiting on, as Shopify
               -- names the payment method; null when none are unpaid.
               'awaiting_by',    (select g.gateway
                                    from public.orders g
                                   where g.store_id = v_store.id and g.currency = o.currency
                                     and g.cancelled_at is null and g.placed_at >= v_from
                                     and g.financial_status = 'PENDING' and g.gateway is not null
                                   group by g.gateway
                                   order by count(*) desc, g.gateway
                                   limit 1),
               'average',        round(avg(o.total_original), 2),
               'orders',         count(*)
             ) as m
        from public.orders o
       where o.store_id = v_store.id and o.placed_at >= v_from and o.cancelled_at is null
         and o.currency is not null
       group by o.currency
    ) x;

  -- Every day of the chart present, even one with nothing ordered, so a
  -- quiet Sunday is a short bar and not a missing one.
  select coalesce(jsonb_agg(jsonb_build_object('day', d.day::date, 'orders', coalesce(c.n, 0)) order by d.day), '[]'::jsonb)
    into v_daily
    from generate_series((v_today - (v_chart - 1))::timestamp, v_today::timestamp, interval '1 day') as d(day)
    left join (
      select (placed_at at time zone v_tz)::date as day, count(*) as n
        from public.orders
       where store_id = v_store.id and cancelled_at is null
         and placed_at >= ((v_today - (v_chart - 1))::timestamp) at time zone v_tz
       group by 1
    ) c on c.day = d.day::date;

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

  -- What to watch: a tracked variant with nothing left to sell, the rule
  -- behind "Out of stock", "All promised" and "Out, more coming" alike.
  -- The emptiest first: nothing on the shelf and nothing coming, then empty
  -- with more on its way, then on the shelf but all of it promised away.
  select count(*) into v_count
    from public.inventory_levels i
    join public.variants v on v.id = i.variant_id
   where i.store_id = v_store.id and v.tracked is not false and coalesce(i.available, 0) <= 0;

  select coalesce(jsonb_agg(x.w order by x.rn), '[]'::jsonb)
    into v_watch
    from (
      select jsonb_build_object(
               'id', i.id, 'product', p.title, 'variant', v.title, 'sku', v.sku,
               'location_name', nullif(i.location_name, ''),
               'available', coalesce(i.available, 0), 'on_hand', coalesce(i.on_hand, 0),
               'incoming', coalesce(i.incoming, 0), 'stock_state', si.stock_state
             ) as w,
             row_number() over (order by coalesce(i.available, 0), coalesce(i.on_hand, 0), coalesce(i.incoming, 0), p.title, i.id) as rn
        from public.inventory_levels i
        join public.variants v on v.id = i.variant_id
        left join public.products p on p.id = v.product_id
        join public.store_inventory si on si.id = i.id
       where i.store_id = v_store.id and v.tracked is not false and coalesce(i.available, 0) <= 0
       order by rn
       limit 20
    ) x;

  return jsonb_build_object(
    'store', jsonb_build_object(
      'shop_domain',    v_store.shop_domain,
      'status',         v_store.status,
      'currency',       v_store.currency,
      'timezone',       v_tz,
      'last_synced_at', v_store.last_synced_at
    ),
    'days',        v_days,
    'chart_days',  v_chart,
    'today',       v_today,
    'orders',      v_orders,
    'money',       v_money,
    'daily',       v_daily,
    'to_fulfil',   v_open,
    'stock',       v_stock,
    'stock_watch', v_watch,
    'watching',    v_count,
    'customers',   (select count(*) from public.customers where store_id = v_store.id),
    'products',    (select count(*) from public.products where store_id = v_store.id)
  );
end $$;

revoke all on function public.abo_store_overview(uuid, int, int) from public, anon;
grant execute on function public.abo_store_overview(uuid, int, int) to authenticated;

NOTIFY pgrst, 'reload schema';
