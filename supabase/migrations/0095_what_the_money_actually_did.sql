-- Migration 0095: what the money actually did.
--
-- Until now "how much did we make" was read off orders.financial_status,
-- which is what the ORDER says about money rather than what money did.
-- On a cash-on-delivery store every order sits at PENDING for days
-- after the customer has paid the courier, and a gateway that merely
-- authorises a card reads PAID before anything has landed. Neither
-- number ever matches a payout, and the merchant is the one who finds
-- that out.
--
-- A transaction is the money itself: what moved, when, through which
-- gateway, and whether it succeeded. This store's four orders each
-- carry one SALE/PENDING against them, which is exactly the case the
-- old answer could not express — charged, not collected.
--
-- Test transactions are kept rather than dropped, so a merchant
-- hunting for the one they made themselves can find it, and excluded
-- from every total by the advice on the list.
--
-- Both roads write them. The import reads them inside the order, paged
-- and in bulk alike (transactions is a plain list, so the export
-- carries it on the parent). The webhook road has its own topic,
-- because money moves without the order changing at all: an order
-- collected on delivery looks identical before and after.
--
-- Callers: src/lib/shopify-import.ts (saveOrders), the orders resource
-- in src/lib/shopify-resources.ts, STORE_TABLES.transactions and
-- COUNTED in src/lib/store-read.ts, and the webhook route through
-- abo_shopify_webhook.

create table if not exists public.order_transactions (
  id           uuid primary key default gen_random_uuid(),
  store_id     uuid not null references public.stores(id) on delete cascade,
  order_id     uuid not null references public.orders(id) on delete cascade,
  external_id  text not null,
  -- SALE, CAPTURE, AUTHORIZATION, REFUND, VOID, CHANGE. Upper case on
  -- both roads: GraphQL shouts them and REST whispers them, and a
  -- stat that filtered on one spelling would silently miss the other.
  kind         text,
  -- SUCCESS, PENDING, FAILURE, ERROR.
  status       text,
  gateway      text,
  amount       numeric(12,2),
  currency     text,
  -- The merchant's own test payments. Money-shaped, not money.
  test         boolean not null default false,
  processed_at timestamptz,
  created_at   timestamptz not null default now()
);
create unique index if not exists idx_order_transactions_unique
  on public.order_transactions(store_id, external_id);
create index if not exists idx_order_transactions_order on public.order_transactions(order_id);
create index if not exists idx_order_transactions_store on public.order_transactions(store_id);

-- The two policies every commerce table has (0018).
alter table public.order_transactions enable row level security;
drop policy if exists "order_transactions_owner_all" on public.order_transactions;
create policy "order_transactions_owner_all" on public.order_transactions
  for all using (public.abo_store_owned(store_id)) with check (public.abo_store_owned(store_id));
drop policy if exists "order_transactions_member_read" on public.order_transactions;
create policy "order_transactions_member_read" on public.order_transactions
  for select using (public.abo_store_readable(store_id));

-- And the three that keep a connected assistant's token from writing
-- at the table (0028, 0070). Money rows are Shopify's to state.
drop policy if exists "order_transactions_oauth_no_insert" on public.order_transactions;
create policy "order_transactions_oauth_no_insert"
  on public.order_transactions as restrictive
  for insert to authenticated
  with check (not public.abo_is_oauth_client());

drop policy if exists "order_transactions_oauth_no_update" on public.order_transactions;
create policy "order_transactions_oauth_no_update"
  on public.order_transactions as restrictive
  for update to authenticated
  using (not public.abo_is_oauth_client());

drop policy if exists "order_transactions_oauth_no_delete" on public.order_transactions;
create policy "order_transactions_oauth_no_delete"
  on public.order_transactions as restrictive
  for delete to authenticated
  using (not public.abo_is_oauth_client());

create or replace view public.store_transactions with (security_invoker = true) as
select
  t.id,
  t.store_id,
  t.order_id,
  o.order_number,
  to_char(coalesce(t.processed_at, t.created_at), 'YYYY-MM-DD') as processed_at,
  c.name as customer_name,
  t.kind,
  t.status,
  t.gateway,
  t.amount,
  -- The transaction's own currency when it has one; a refund issued
  -- in another currency is not the order's currency.
  coalesce(t.currency, o.currency) as currency,
  t.test
from public.order_transactions t
join public.orders o on o.id = t.order_id
left join public.customers c on c.id = o.customer_id;

grant select on public.store_transactions to authenticated;

-- The one mapping, one line longer (0089, 0090, 0092).
create or replace function public.abo_store_view(t text) returns text
language sql immutable as $$
  select case t
    when 'orders'           then 'store_orders'
    when 'customers'        then 'store_customers'
    when 'products'         then 'store_products'
    when 'inventory_levels' then 'store_inventory'
    when 'product_sales'    then 'product_sales'
    when 'order_line_items' then 'store_order_items'
    when 'refunds'          then 'store_refunds'
    when 'variants'         then 'store_variants'
    when 'fulfillments'     then 'store_fulfillments'
    when 'transactions'     then 'store_transactions'
  end;
$$;

-- ── The webhook road ────────────────────────────────────────────
-- order_transactions/create. Its payload is the transaction, with the
-- order it belongs to named by id.
create or replace function public.abo_shopify_upsert_transaction(p_shop text, p_tx jsonb)
returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_store uuid;
  v_order uuid;
begin
  select id into v_store
    from public.stores
   where lower(shop_domain) = lower(p_shop)
     and provider = 'shopify'
     and status <> 'pending';
  if v_store is null then return 0; end if;
  if public.abo_shopify_gid('OrderTransaction', p_tx->>'id') is null then return 0; end if;

  select id into v_order from public.orders
   where store_id = v_store
     and external_id = public.abo_shopify_gid('Order', p_tx->>'order_id');
  -- An order not imported yet is nothing to hang money on. The next
  -- import reads the transaction inside the order anyway.
  if v_order is null then return 0; end if;

  insert into public.order_transactions (
    store_id, order_id, external_id, kind, status, gateway, amount, currency, test, processed_at
  ) values (
    v_store, v_order,
    public.abo_shopify_gid('OrderTransaction', p_tx->>'id'),
    -- Upper on both roads. REST says "sale", GraphQL says "SALE", and
    -- a stat filtering on one spelling would quietly miss half the
    -- money depending on which road wrote the row.
    upper(nullif(p_tx->>'kind', '')),
    upper(nullif(p_tx->>'status', '')),
    nullif(p_tx->>'gateway', ''),
    nullif(p_tx->>'amount', '')::numeric,
    nullif(p_tx->>'currency', ''),
    coalesce((p_tx->>'test')::boolean, false),
    (nullif(coalesce(p_tx->>'processed_at', p_tx->>'created_at'), ''))::timestamptz
  )
  on conflict (store_id, external_id) do update set
    order_id     = excluded.order_id,
    kind         = coalesce(excluded.kind, public.order_transactions.kind),
    status       = coalesce(excluded.status, public.order_transactions.status),
    gateway      = coalesce(excluded.gateway, public.order_transactions.gateway),
    amount       = coalesce(excluded.amount, public.order_transactions.amount),
    currency     = coalesce(excluded.currency, public.order_transactions.currency),
    test         = excluded.test,
    processed_at = coalesce(excluded.processed_at, public.order_transactions.processed_at);

  update public.stores set last_synced_at = now() where id = v_store;
  return 1;
end $$;

revoke all on function public.abo_shopify_upsert_transaction(text, jsonb) from public;
revoke execute on function public.abo_shopify_upsert_transaction(text, jsonb) from anon, authenticated;

-- The dispatcher (0092), one topic longer.
create or replace function public.abo_shopify_webhook(
  p_token text,
  p_topic text,
  p_raw   text,
  p_hmac  text
) returns integer
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_secret text;
  v_body   jsonb;
  v_shop   text;
begin
  select value into v_secret from public.app_secrets where name = 'shopify_client_secret';
  if v_secret is null then
    raise exception 'Webhooks are not configured.' using errcode = '42501';
  end if;
  if p_raw is null or p_hmac is null or p_token is null then
    raise exception 'Unsigned.' using errcode = '42501';
  end if;
  if encode(extensions.hmac(p_raw, v_secret, 'sha256'), 'base64') <> p_hmac then
    raise exception 'That did not come from Shopify.' using errcode = '42501';
  end if;

  select s.shop_domain into v_shop
    from public.stores s
   where s.provider = 'shopify'
     and s.status <> 'pending'
     and encode(extensions.hmac(lower(s.shop_domain), v_secret, 'sha256'), 'hex') = p_token;

  if v_shop is null then
    raise exception 'Unsigned.' using errcode = '42501';
  end if;

  v_body := p_raw::jsonb;

  if p_topic in ('orders/create', 'orders/updated', 'orders/cancelled',
                 'orders/paid', 'orders/fulfilled') then
    return public.abo_shopify_upsert_order(v_shop, v_body);
  elsif p_topic in ('products/create', 'products/update') then
    return public.abo_shopify_upsert_product(v_shop, v_body);
  elsif p_topic = 'products/delete' then
    return public.abo_shopify_delete_product(v_shop, v_body->>'id');
  elsif p_topic in ('customers/create', 'customers/update') then
    return public.abo_shopify_upsert_customer(v_shop, v_body);
  elsif p_topic = 'customers/delete' then
    return public.abo_shopify_delete_customer(v_shop, v_body->>'id');
  elsif p_topic in ('inventory_levels/update', 'inventory_levels/connect') then
    return public.abo_shopify_set_inventory(v_shop, v_body);
  elsif p_topic in ('fulfillments/create', 'fulfillments/update') then
    return public.abo_shopify_upsert_fulfillment(v_shop, v_body);
  elsif p_topic = 'order_transactions/create' then
    return public.abo_shopify_upsert_transaction(v_shop, v_body);
  end if;

  -- Signed, at a real address, and a topic nobody asked for. The
  -- compliance topics land here too, which is correct: they have their
  -- own door and do not arrive at this one.
  return 0;
end $$;

revoke all on function public.abo_shopify_webhook(text, text, text, text) from public;
grant execute on function public.abo_shopify_webhook(text, text, text, text) to anon, authenticated;

NOTIFY pgrst, 'reload schema';
