-- An order carries its shipment, and what was given back (6 Oct, Tanish).
-- The orders list said nothing of where an order was: its courier, its
-- tracking number and whether it was delivered lived in the shipments
-- list, seen only by opening the order. And a cancelled or refunded
-- order read ₹0, its current total, with nothing to say what it had been
-- or what was refunded.
--
-- Each order now carries its latest shipment (status, courier, tracking
-- number, shipped and delivered days, and how many shipments it went in)
-- and the sum of its refunds. Columns of the list like any other: the
-- table, filters, cards, Luke and their own AI read them by name, and an
-- administrator can hide them per account (0192). Added at the end of the
-- view, the columns before them unchanged.
--
-- Kept on the order, not looked up as the list is read. Looked up, every
-- count of the list and every card read each order's shipments again:
-- on 20,000 orders a count went from 80 ms to 158 and the cards from
-- 462 ms to 779 (or the count kept and the cards at 1,087, as one lookup
-- a column). Kept, a read costs what it did. They are written when a
-- shipment or a refund is, by whatever writes it (an import, a webhook,
-- a check), one statement at a time, and only where they change; the
-- order is marked seen by it, as any write to it is (0123): Shopify has
-- just said it exists.
--
-- Written from the view as it stands (0173 added customer_email), so no
-- column is lost; the new ones follow it.
--
-- Callers: src/lib/store-read.ts (STORE_TABLES.orders), and through it
-- every reader of the orders list.

alter table public.orders
  add column if not exists shipment_status text,
  add column if not exists shipment_carrier text,
  add column if not exists shipment_tracking text,
  add column if not exists shipment_shipped_at timestamptz,
  add column if not exists shipment_delivered_at timestamptz,
  add column if not exists shipments bigint,
  add column if not exists refunded numeric;

-- These orders' shipment and refunds, from the rows as they are now.
create or replace function public.abo_order_shipments(p_orders uuid[]) returns void
language sql security definer set search_path = public as $$
  update public.orders o
     set shipment_status = x.status,
         shipment_carrier = x.carrier,
         shipment_tracking = x.tracking,
         shipment_shipped_at = x.shipped_at,
         shipment_delivered_at = x.delivered_at,
         shipments = x.shipments,
         refunded = x.refunded
    from (select ids.id, sh.status, sh.carrier, sh.tracking, sh.shipped_at, sh.delivered_at,
                 nullif((select count(*) from public.fulfillments f where f.order_id = ids.id), 0) as shipments,
                 (select sum(r.amount) from public.refunds r where r.order_id = ids.id) as refunded
            from (select distinct unnest(p_orders) as id) ids
            -- Its latest shipment (idx_fulfillments_order).
            left join lateral (
              select coalesce(f.shipment_status, f.status) as status, f.carrier, f.tracking_number as tracking,
                     f.shipped_at, f.delivered_at
                from public.fulfillments f
               where f.order_id = ids.id
               order by f.shipped_at desc nulls last, f.id desc
               limit 1) sh on true) x
   where o.id = x.id
     and (o.shipment_status, o.shipment_carrier, o.shipment_tracking, o.shipment_shipped_at,
          o.shipment_delivered_at, o.shipments, o.refunded)
         is distinct from (x.status, x.carrier, x.tracking, x.shipped_at, x.delivered_at, x.shipments, x.refunded);
$$;
revoke all on function public.abo_order_shipments(uuid[]) from public, anon, authenticated;

-- A shipment or a refund written: its order's figures, once a statement.
create or replace function public.abo_order_shipments_changed() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    perform public.abo_order_shipments(array(select order_id from new_rows));
  elsif tg_op = 'UPDATE' then
    perform public.abo_order_shipments(array(select order_id from new_rows union select order_id from old_rows));
  else
    perform public.abo_order_shipments(array(select order_id from old_rows));
  end if;
  return null;
end $$;
revoke all on function public.abo_order_shipments_changed() from public, anon, authenticated;

do $$
declare t text;
begin
  foreach t in array array['fulfillments', 'refunds'] loop
    execute format('drop trigger if exists %I on public.%I', 'trg_order_shipments_ins_' || t, t);
    execute format('drop trigger if exists %I on public.%I', 'trg_order_shipments_upd_' || t, t);
    execute format('drop trigger if exists %I on public.%I', 'trg_order_shipments_del_' || t, t);
    execute format('create trigger %I after insert on public.%I referencing new table as new_rows
                    for each statement execute function public.abo_order_shipments_changed()',
                   'trg_order_shipments_ins_' || t, t);
    execute format('create trigger %I after update on public.%I referencing old table as old_rows new table as new_rows
                    for each statement execute function public.abo_order_shipments_changed()',
                   'trg_order_shipments_upd_' || t, t);
    execute format('create trigger %I after delete on public.%I referencing old table as old_rows
                    for each statement execute function public.abo_order_shipments_changed()',
                   'trg_order_shipments_del_' || t, t);
  end loop;
end $$;

-- The orders there already. Not a word from Shopify, so not marked seen:
-- a row a check has missed once stays missed (0123).
alter table public.orders disable trigger abo_seen;
select public.abo_order_shipments(array(select order_id from public.fulfillments union select order_id from public.refunds));
alter table public.orders enable trigger abo_seen;

create or replace view public.store_orders with (security_invoker = true) as
SELECT o.id,
    o.store_id,
    o.order_number,
    to_char((o.placed_at AT TIME ZONE COALESCE(zone_st.zone, 'UTC'::text)), 'YYYY-MM-DD'::text) AS placed_at,
    c.name AS customer_name,
    COALESCE(o.ship_phone, o.phone, o.bill_phone, NULLIF(c.phone, ''::text), c.order_phone) AS customer_phone,
    o.total,
    o.total_original,
    o.currency,
        CASE
            WHEN o.cancelled_at IS NOT NULL THEN 'Cancelled'::text
            ELSE o.financial_status
        END AS status,
    o.fulfilment_status,
    o.financial_status,
    o.cancelled_at,
    NULLIF(array_to_string(o.tags, ', '::text), ''::text) AS tags,
    o.gateway,
    NULLIF(array_to_string(o.discount_codes, ', '::text), ''::text) AS discount_codes,
    o.ship_city,
    o.ship_state,
    o.ship_country,
    o.subtotal,
    o.tax,
    o.shipping,
    o.discount,
    o.external_id AS shopify_id,
    o.placed_at AS placed_ts,
    regexp_replace(COALESCE(o.ship_phone, o.phone, o.bill_phone, NULLIF(c.phone, ''::text), c.order_phone, ''::text), '\D'::text, ''::text, 'g'::text) AS phone_digits,
    NULLIF(lower(btrim(c.email)), ''::text) AS customer_email,
    o.shipment_status,
    o.shipment_carrier AS carrier,
    o.shipment_tracking AS tracking_number,
    to_char((o.shipment_shipped_at AT TIME ZONE COALESCE(zone_st.zone, 'UTC'::text)), 'YYYY-MM-DD'::text) AS shipped_at,
    to_char((o.shipment_delivered_at AT TIME ZONE COALESCE(zone_st.zone, 'UTC'::text)), 'YYYY-MM-DD'::text) AS delivered_at,
    o.shipments,
    o.refunded
   FROM orders o
     LEFT JOIN customers c ON c.id = o.customer_id
     LEFT JOIN ( SELECT s.id AS zone_store,
            s.timezone AS zone
           FROM stores s) zone_st ON zone_st.zone_store = o.store_id;

notify pgrst, 'reload schema';
