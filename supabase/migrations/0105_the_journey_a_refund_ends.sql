-- Migration 0105: the journey a refund is the end of.
--
-- Refunds have been here since 0091: the money going back. What was
-- never here is everything before that — the customer asking, the
-- merchant agreeing, the goods coming back, and why. A refund says
-- 1,299 went out. A return says a phone case came back because it
-- was the wrong size, and that it was asked for nine days ago and
-- nobody has closed it.
--
-- Two questions a merchant cannot answer without this: what is open
-- right now, and what is coming back most often. The second one is
-- the useful one — a product returned again and again is a listing
-- problem, not a customer problem.
--
-- Under read_returns, which arrived with the grant of 2026-09-21.
--
-- A return belongs to an order, the way a refund does, and is
-- reached through it: Shopify has no top-level returns list, which
-- was checked against the schema rather than assumed. Unlike
-- refunds, a bulk export of them IS accepted — refunds are a list
-- field on Order and returns are a connection, and Shopify's
-- restriction is on connections inside lists.
--
-- Callers: src/lib/shopify-import.ts (saveReturns), the returns
-- resource in src/lib/shopify-resources.ts, STORE_TABLES.returns
-- and COUNTED in src/lib/store-read.ts, and the webhook route
-- through abo_shopify_webhook.

create table if not exists public.returns (
  id             uuid primary key default gen_random_uuid(),
  store_id       uuid not null references public.stores(id) on delete cascade,
  order_id       uuid not null references public.orders(id) on delete cascade,
  external_id    text not null,
  -- Shopify's own name for it, its own series: #1004-R1.
  name           text,
  -- REQUESTED, OPEN, CLOSED, DECLINED or CANCELED. Uppercase on both
  -- roads, the way every other status here is.
  status         text,
  -- How many units the whole return covers, as Shopify counts it.
  quantity       integer,
  -- When the customer asked, from Return.createdAt. What "open for
  -- nine days" counts from.
  requested_at   timestamptz,
  closed_at      timestamptz,
  updated_at     timestamptz,
  created_at     timestamptz not null default now()
);
create unique index if not exists idx_returns_unique on public.returns(store_id, external_id);
create index if not exists idx_returns_store on public.returns(store_id);
create index if not exists idx_returns_order on public.returns(order_id);

create table if not exists public.return_line_items (
  id                uuid primary key default gen_random_uuid(),
  store_id          uuid not null references public.stores(id) on delete cascade,
  return_id         uuid not null references public.returns(id) on delete cascade,
  external_id       text,
  product_id        uuid references public.products(id) on delete set null,
  variant_id        uuid references public.variants(id) on delete set null,
  title             text,
  sku               text,
  quantity          integer,
  -- Of that quantity, how much has actually been paid back. The gap
  -- between the two is a return agreed and not yet settled, which is
  -- the thing a merchant loses track of.
  refunded_quantity integer,
  -- The merchant-facing label Shopify shows for the reason, and
  -- whatever the customer typed alongside it. Taken from
  -- returnReasonDefinition rather than the returnReason enum, which
  -- Shopify has deprecated and says it will remove. Already in
  -- words, so nothing here reformats it.
  reason            text,
  reason_note       text,
  created_at        timestamptz not null default now()
);
create unique index if not exists idx_return_line_items_unique
  on public.return_line_items(return_id, external_id)
  where external_id is not null;
create index if not exists idx_return_line_items_return on public.return_line_items(return_id);
create index if not exists idx_return_line_items_store on public.return_line_items(store_id);
create index if not exists idx_return_line_items_product on public.return_line_items(product_id);

-- The two policies every commerce table has (0018), and the three
-- that keep a connected assistant from writing at the table (0070).
do $$
declare t text;
begin
  foreach t in array array['returns', 'return_line_items'] loop
    execute format('alter table public.%I enable row level security', t);

    execute format('drop policy if exists "%s_owner_all" on public.%I', t, t);
    execute format(
      'create policy "%s_owner_all" on public.%I for all
         using (public.abo_store_owned(store_id))
         with check (public.abo_store_owned(store_id))', t, t);

    execute format('drop policy if exists "%s_member_read" on public.%I', t, t);
    execute format(
      'create policy "%s_member_read" on public.%I for select
         using (public.abo_store_readable(store_id))', t, t);

    execute format('drop policy if exists "%s_oauth_no_insert" on public.%I', t, t);
    execute format(
      'create policy "%s_oauth_no_insert" on public.%I as restrictive
         for insert to authenticated
         with check (not public.abo_is_oauth_client())', t, t);

    execute format('drop policy if exists "%s_oauth_no_update" on public.%I', t, t);
    execute format(
      'create policy "%s_oauth_no_update" on public.%I as restrictive
         for update to authenticated
         using (not public.abo_is_oauth_client())', t, t);

    execute format('drop policy if exists "%s_oauth_no_delete" on public.%I', t, t);
    execute format(
      'create policy "%s_oauth_no_delete" on public.%I as restrictive
         for delete to authenticated
         using (not public.abo_is_oauth_client())', t, t);
  end loop;
end $$;

create or replace view public.store_returns with (security_invoker = true) as
select
  r.id,
  r.store_id,
  r.name,
  o.order_number,
  c.name as customer_name,
  case r.status
    when 'REQUESTED' then 'Asked for'
    when 'OPEN'      then 'Agreed, not back yet'
    when 'CLOSED'    then 'Done'
    when 'DECLINED'  then 'Refused'
    when 'CANCELED'  then 'Cancelled'
    else initcap(coalesce(r.status, ''))
  end as state,
  r.quantity,
  -- Of what is coming back, how much has been paid for. A return
  -- agreed and not yet settled is money the merchant still owes and
  -- the commonest thing to lose track of.
  (select coalesce(sum(li.refunded_quantity), 0) from public.return_line_items li where li.return_id = r.id) as refunded_quantity,
  -- The reasons, once each, in one readable string. Quoted exactly
  -- as Shopify labels them: a merchant reading a reason here and in
  -- their own admin should see the same words.
  (select nullif(string_agg(distinct li.reason, ', '), '')
     from public.return_line_items li where li.return_id = r.id) as reasons,
  (select nullif(string_agg(li.title, ', ' order by li.title), '')
     from public.return_line_items li where li.return_id = r.id) as items,
  to_char(r.requested_at, 'YYYY-MM-DD') as requested_at,
  -- How long it has been open, which is what makes a list of these
  -- worth opening at all. Null once it is finished.
  case when r.status in ('REQUESTED', 'OPEN') and r.requested_at is not null
       then (current_date - r.requested_at::date)
  end as days_open,
  to_char(r.closed_at, 'YYYY-MM-DD') as closed_at
from public.returns r
join public.orders o on o.id = r.order_id
left join public.customers c on c.id = o.customer_id;

grant select on public.store_returns to authenticated;

-- What comes back, and why. The question behind the list: a product
-- returned again and again is a listing problem, and no per-return
-- row makes that visible.
create or replace view public.return_reasons with (security_invoker = true) as
select
  li.store_id,
  coalesce(li.title, 'Unknown') as title,
  li.sku,
  coalesce(li.reason, 'Not given') as reason,
  sum(li.quantity) as units_returned,
  count(distinct li.return_id) as returns
from public.return_line_items li
group by li.store_id, coalesce(li.title, 'Unknown'), li.sku, coalesce(li.reason, 'Not given');

grant select on public.return_reasons to authenticated;

-- The one mapping, two lines longer (0089, 0090, 0092, 0095, 0099,
-- 0100, 0103, 0104). Keyed by what STORE_TABLES calls the list.
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
  end;
$$;

-- ── The webhook road ────────────────────────────────────────────
-- Narrow on purpose, and the reason is worth writing down: there is
-- no return in the development store this was built against, so the
-- REST payload's shape is known from Shopify's documentation and not
-- from anything seen arriving. So this road touches only the fields
-- a return webhook certainly carries — which return, on which order,
-- and what state it is in — coalesces the rest, and does not go near
-- the line items. Whatever it cannot say, the next import says.
--
-- Eight topics land here: requested, approved, declined, cancelled,
-- closed, reopened, processed, updated. All eight are the same
-- event to this function — the state of a return changed — and the
-- payload carries the new state, so one handler serves them.
create or replace function public.abo_shopify_upsert_return(p_shop text, p_r jsonb)
returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_store uuid;
  v_ext   text;
  v_order uuid;
begin
  select id into v_store
    from public.stores
   where lower(shop_domain) = lower(p_shop)
     and provider = 'shopify'
     and status <> 'pending';
  if v_store is null then return 0; end if;

  v_ext := coalesce(
    nullif(p_r->>'admin_graphql_api_id', ''),
    public.abo_shopify_gid('Return', p_r->>'id')
  );
  if v_ext is null then return 0; end if;

  -- A return without its order is a row that can never be read: the
  -- list joins through the order for its number and its customer.
  select id into v_order
    from public.orders
   where store_id = v_store
     and external_id = coalesce(
       nullif(p_r#>>'{order,admin_graphql_api_id}', ''),
       public.abo_shopify_gid('Order', coalesce(p_r->>'order_id', p_r#>>'{order,id}'))
     );
  if v_order is null then
    -- Not an error. The order has not been imported yet, and the
    -- import will bring the return across with it.
    return 0;
  end if;

  insert into public.returns (
    store_id, order_id, external_id, name, status, quantity, requested_at, closed_at, updated_at
  ) values (
    v_store, v_order, v_ext,
    nullif(p_r->>'name', ''),
    upper(nullif(p_r->>'status', '')),
    nullif(p_r->>'total_quantity', '')::integer,
    (nullif(p_r->>'created_at', ''))::timestamptz,
    (nullif(p_r->>'closed_at', ''))::timestamptz,
    coalesce((nullif(p_r->>'updated_at', ''))::timestamptz, now())
  )
  on conflict (store_id, external_id) do update set
    order_id     = coalesce(excluded.order_id, public.returns.order_id),
    name         = coalesce(excluded.name, public.returns.name),
    status       = coalesce(excluded.status, public.returns.status),
    quantity     = coalesce(excluded.quantity, public.returns.quantity),
    requested_at = coalesce(public.returns.requested_at, excluded.requested_at),
    closed_at    = coalesce(excluded.closed_at, public.returns.closed_at),
    updated_at   = excluded.updated_at;

  update public.stores set last_synced_at = now() where id = v_store;
  return 1;
end $$;

revoke all on function public.abo_shopify_upsert_return(text, jsonb) from public;
revoke execute on function public.abo_shopify_upsert_return(text, jsonb) from anon, authenticated;

-- The dispatcher (0104), eight topics longer.
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
  elsif p_topic in ('locations/create', 'locations/update',
                    'locations/activate', 'locations/deactivate') then
    return public.abo_shopify_upsert_location(v_shop, v_body);
  elsif p_topic = 'locations/delete' then
    return public.abo_shopify_delete_location(v_shop, v_body->>'id');
  elsif p_topic in ('collections/create', 'collections/update') then
    return public.abo_shopify_upsert_collection(v_shop, v_body);
  elsif p_topic = 'collections/delete' then
    return public.abo_shopify_delete_collection(v_shop, v_body->>'id');
  elsif p_topic in ('checkouts/create', 'checkouts/update') then
    return public.abo_shopify_upsert_cart(v_shop, v_body);
  elsif p_topic = 'checkouts/delete' then
    return public.abo_shopify_delete_cart(v_shop, v_body->>'id');
  elsif p_topic in ('draft_orders/create', 'draft_orders/update') then
    return public.abo_shopify_upsert_draft_order(v_shop, v_body);
  elsif p_topic = 'draft_orders/delete' then
    return public.abo_shopify_delete_draft_order(v_shop, v_body->>'id');
  elsif p_topic in ('discounts/create', 'discounts/update') then
    return public.abo_shopify_upsert_discount(v_shop, v_body);
  elsif p_topic = 'discounts/delete' then
    return public.abo_shopify_delete_discount(v_shop, coalesce(v_body->>'admin_graphql_api_id', v_body->>'id'));
  elsif p_topic in ('returns/request', 'returns/approve', 'returns/decline',
                    'returns/cancel', 'returns/close', 'returns/reopen',
                    'returns/process', 'returns/update') then
    return public.abo_shopify_upsert_return(v_shop, v_body);
  end if;

  -- Signed, at a real address, and a topic nobody asked for. The
  -- compliance topics land here too, which is correct: they have their
  -- own door and do not arrive at this one.
  return 0;
end $$;

revoke all on function public.abo_shopify_webhook(text, text, text, text) from public;
grant execute on function public.abo_shopify_webhook(text, text, text, text) to anon, authenticated;

NOTIFY pgrst, 'reload schema';
