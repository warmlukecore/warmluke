-- Migration 0214: what a store's ads cost (docs/integrations/connectors.md, phase 4)
--
-- A store's Meta ad account, connected beside its courier (0204): what
-- each campaign spent and what Meta says it brought in, one row per
-- campaign and day, in the ad account's own days and currency. Kept by
-- kind of data, not by provider, so Google's spend lands in the same
-- list when it comes.
--
-- purchases and purchase_value are the ad platform's own claim, kept
-- apart from the store's orders: "Meta says 40 sales" and "the store
-- took 25 orders from that campaign" are two different numbers, and the
-- list says which is which.
--
-- Written only through the connection's ticket (abo_connector_put_ad_spend),
-- read by anyone who may read the store, as its orders are.

create table if not exists public.ad_spend (
  id             uuid primary key default gen_random_uuid(),
  project_id     uuid not null references public.projects(id) on delete cascade,
  store_id       uuid not null references public.stores(id) on delete cascade,
  connection_id  uuid not null references public.store_connections(id) on delete cascade,
  provider       text not null,
  campaign_id    text not null,
  campaign_name  text,
  -- The ad account's day, as the platform reports it.
  day            date not null,
  spend          numeric not null default 0,
  currency       text,
  impressions    bigint,
  clicks         bigint,
  purchases      numeric,
  purchase_value numeric,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  -- A day is written again while the platform still revises it.
  unique (connection_id, campaign_id, day)
);
create index if not exists ad_spend_store_day on public.ad_spend (store_id, day desc);

alter table public.ad_spend enable row level security;
drop policy if exists ad_spend_member_read on public.ad_spend;
create policy ad_spend_member_read on public.ad_spend
  for select to authenticated using (public.abo_store_readable(store_id));
revoke insert, update, delete on public.ad_spend from anon, authenticated;

-- The wall every table has: no write from a connected client's token.
drop policy if exists ad_spend_oauth_no_insert on public.ad_spend;
create policy ad_spend_oauth_no_insert on public.ad_spend
  as restrictive for insert to authenticated with check (not public.abo_is_oauth_client());
drop policy if exists ad_spend_oauth_no_update on public.ad_spend;
create policy ad_spend_oauth_no_update on public.ad_spend
  as restrictive for update to authenticated using (not public.abo_is_oauth_client());
drop policy if exists ad_spend_oauth_no_delete on public.ad_spend;
create policy ad_spend_oauth_no_delete on public.ad_spend
  as restrictive for delete to authenticated using (not public.abo_is_oauth_client());

-- ── The ticket ───────────────────────────────────────────────
/**
 * A page of days from the connection the live ticket holds, written
 * over what was there: the platform's latest word on a day is its word.
 */
create or replace function public.abo_connector_put_ad_spend(p_rows jsonb)
returns integer
language plpgsql volatile security definer set search_path = public as $$
declare
  v_connection uuid := public.abo_connector_held();
  c            record;
  r            jsonb;
  v_n          integer := 0;
begin
  if v_connection is null then
    raise exception 'No live ticket.' using errcode = '42501';
  end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 500 then
    raise exception 'A page is a list of at most 500.' using errcode = '22023';
  end if;
  select id, project_id, store_id, provider into c from public.store_connections where id = v_connection;
  -- A courier's ticket brings shipments, never spend.
  if c.provider not in ('meta_ads', 'google_ads') then
    raise exception 'This connection does not bring ad spend.' using errcode = '42501';
  end if;
  for r in select * from jsonb_array_elements(p_rows) loop
    if nullif(btrim(r->>'campaign_id'), '') is null then continue; end if;
    if coalesce(r->>'day', '') !~ '^\d{4}-\d{2}-\d{2}$' then continue; end if;
    insert into public.ad_spend (
      project_id, store_id, connection_id, provider, campaign_id, campaign_name, day,
      spend, currency, impressions, clicks, purchases, purchase_value, updated_at
    ) values (
      c.project_id, c.store_id, c.id, c.provider,
      left(btrim(r->>'campaign_id'), 120),
      left(nullif(btrim(r->>'campaign_name'), ''), 300),
      (r->>'day')::date,
      coalesce(nullif(r->>'spend', '')::numeric, 0),
      left(nullif(btrim(r->>'currency'), ''), 3),
      nullif(r->>'impressions', '')::bigint,
      nullif(r->>'clicks', '')::bigint,
      nullif(r->>'purchases', '')::numeric,
      nullif(r->>'purchase_value', '')::numeric,
      now()
    )
    on conflict (connection_id, campaign_id, day) do update set
      campaign_name  = coalesce(excluded.campaign_name, public.ad_spend.campaign_name),
      spend          = excluded.spend,
      currency       = coalesce(excluded.currency, public.ad_spend.currency),
      impressions    = excluded.impressions,
      clicks         = excluded.clicks,
      purchases      = excluded.purchases,
      purchase_value = excluded.purchase_value,
      updated_at     = now();
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;

-- The worker's, by its ticket, as 0204's put_shipments.
revoke all on function public.abo_connector_put_ad_spend(jsonb) from public, authenticated;
grant execute on function public.abo_connector_put_ad_spend(jsonb) to anon;

-- ── The list ─────────────────────────────────────────────────
-- roas and cost_per_purchase are the platform's claim divided by spend,
-- never the store's orders: the two are named apart in the list's words.
create or replace view public.store_ad_spend with (security_invoker = true) as
select a.id,
       a.store_id,
       a.provider,
       to_char(a.day, 'YYYY-MM-DD') as day,
       a.campaign_name,
       a.campaign_id,
       a.spend,
       a.currency,
       a.impressions,
       a.clicks,
       a.purchases,
       a.purchase_value,
       round(a.purchase_value / nullif(a.spend, 0), 2) as roas,
       round(a.spend / nullif(a.purchases, 0), 2) as cost_per_purchase,
       a.updated_at
  from public.ad_spend a;
grant select on public.store_ad_spend to authenticated;

-- 0213's mapping, one line longer: the list every reader finds by name.
create or replace function public.abo_store_view(t text) returns text
language sql immutable as $$
  select case t
    when 'orders'            then 'store_orders'
    when 'customers'         then 'store_customers'
    when 'products'          then 'store_products'
    when 'inventory_levels'  then 'store_inventory'
    when 'product_sales'     then 'product_sales'
    when 'order_line_items'  then 'store_order_items'
    when 'refunds'           then 'store_refunds'
    when 'variants'          then 'store_variants'
    when 'fulfillments'      then 'store_fulfillments'
    when 'transactions'      then 'store_transactions'
    when 'locations'         then 'store_locations'
    when 'collections'       then 'store_collections'
    when 'carts'             then 'store_abandoned_checkouts'
    when 'drafts'            then 'store_draft_orders'
    when 'draft_order_items' then 'store_draft_order_items'
    when 'discounts'         then 'store_discounts'
    when 'returns'           then 'store_returns'
    when 'return_reasons'    then 'return_reasons'
    when 'payouts'           then 'store_payouts'
    when 'courier_shipments' then 'store_courier_shipments'
    when 'stock_pools'       then 'store_stock_pools'
    when 'ad_spend'          then 'store_ad_spend'
  end;
$$;

notify pgrst, 'reload schema';
