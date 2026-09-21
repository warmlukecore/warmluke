-- Migration 0103: the orders made by hand.
--
-- Not every sale starts in the storefront. A merchant quotes a
-- wholesale customer over WhatsApp, takes an order on the phone,
-- builds a basket for somebody standing in the shop — and in Shopify
-- all of that is a draft order. Sixteen of them sit in the dev store
-- right now and this app could not see one.
--
-- They matter twice. Open ones are money not yet taken, which is the
-- closest thing a merchant has to a pipeline. Completed ones became
-- real orders, so counting both as sales would count the same sale
-- twice — which is why the order it turned into is recorded here and
-- the two can be told apart.
--
-- Under read_draft_orders, which arrived with the grant of 2026-09-21.
--
-- A draft names a person, sometimes by email alone and sometimes
-- before they are a customer at all, so it joins abandoned carts as
-- a table an erasure has to reach. That wiring is the second half of
-- this file and it is not optional: a redaction that clears the
-- customer and leaves their name on a draft order has reported a
-- success it did not perform.
--
-- Callers: src/lib/shopify-import.ts (saveDraftOrders), the
-- draft_orders resource in src/lib/shopify-resources.ts,
-- STORE_TABLES.draft_orders and COUNTED in src/lib/store-read.ts,
-- and the webhook route through abo_shopify_webhook.

create table if not exists public.draft_orders (
  id                   uuid primary key default gen_random_uuid(),
  store_id             uuid not null references public.stores(id) on delete cascade,
  external_id          text not null,
  -- Shopify's own name for it: #D16. Its own series, not the orders'.
  name                 text,
  -- OPEN, INVOICE_SENT or COMPLETED. Uppercase on both roads.
  status               text,
  customer_id          uuid references public.customers(id) on delete set null,
  -- Kept beside the link, because a redaction names a person by
  -- Shopify's id and a draft may have no customer row to join to.
  customer_external_id text,
  name_on_draft        text,
  email                text,
  -- The four parts, same meaning as on an order (0098).
  total                numeric(12,2),
  subtotal             numeric(12,2),
  tax                  numeric(12,2),
  shipping             numeric(12,2),
  currency             text,
  tags                 text[] not null default '{}',
  -- Where the merchant sends the customer to pay. The whole point of
  -- an unpaid draft.
  invoice_url          text,
  -- The order it became, once it did. Null while it is still a draft,
  -- and what stops a completed draft being counted as a second sale.
  order_id             uuid references public.orders(id) on delete set null,
  order_external_id    text,
  drafted_at           timestamptz,
  completed_at         timestamptz,
  updated_at           timestamptz,
  created_at           timestamptz not null default now()
);
create unique index if not exists idx_draft_orders_unique on public.draft_orders(store_id, external_id);
create index if not exists idx_draft_orders_store on public.draft_orders(store_id);
create index if not exists idx_draft_orders_customer on public.draft_orders(customer_id);

comment on column public.draft_orders.order_id is
  'The order this draft became. Null while open — a completed draft and its order are one sale, not two.';

create table if not exists public.draft_order_line_items (
  id             uuid primary key default gen_random_uuid(),
  store_id       uuid not null references public.stores(id) on delete cascade,
  draft_order_id uuid not null references public.draft_orders(id) on delete cascade,
  external_id    text,
  -- Both null for a custom item: a line the merchant typed rather
  -- than picked, which is common on a draft and never on an order
  -- placed through the storefront. #D1 in the dev store is one.
  product_id     uuid references public.products(id) on delete set null,
  variant_id     uuid references public.variants(id) on delete set null,
  title          text,
  sku            text,
  quantity       integer,
  price          numeric(12,2),
  created_at     timestamptz not null default now()
);
create unique index if not exists idx_draft_order_line_items_unique
  on public.draft_order_line_items(draft_order_id, external_id)
  where external_id is not null;
create index if not exists idx_draft_order_line_items_draft on public.draft_order_line_items(draft_order_id);
create index if not exists idx_draft_order_line_items_store on public.draft_order_line_items(store_id);

-- The two policies every commerce table has (0018), and the three
-- that keep a connected assistant from writing at the table (0070).
do $$
declare t text;
begin
  foreach t in array array['draft_orders', 'draft_order_line_items'] loop
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

-- ── Erased stays erased, drafts included ───────────────────────
-- 0101 wrote this guard for carts, and its body never looked at a
-- cart: it reads store_id, customer_external_id and email, which a
-- draft order has too. So it is renamed to what it actually does and
-- both tables use the one function. A second copy would be a second
-- thing to forget.
create or replace function public.abo_row_names_a_redacted_person()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  perform public.abo_customers_lock(new.store_id);

  if exists (
    select 1 from public.shopify_redactions r
     where r.store_id = new.store_id
       and (
         (r.external_id is not null
          and new.customer_external_id is not null
          and r.external_id = new.customer_external_id)
         or (r.external_id is null
             and new.email is not null and btrim(new.email) <> ''
             and lower(btrim(r.email)) = lower(btrim(new.email)))
       )
  ) then
    -- Skipped, not raised: an import of two hundred rows holding one
    -- erased person writes the other hundred and ninety-nine.
    return null;
  end if;
  return new;
end $$;

revoke all on function public.abo_row_names_a_redacted_person() from public;

drop trigger if exists trg_carts_not_redacted on public.abandoned_checkouts;
create trigger trg_carts_not_redacted
  before insert or update on public.abandoned_checkouts
  for each row execute function public.abo_row_names_a_redacted_person();

drop trigger if exists trg_drafts_not_redacted on public.draft_orders;
create trigger trg_drafts_not_redacted
  before insert or update on public.draft_orders
  for each row execute function public.abo_row_names_a_redacted_person();

-- Dropped only once nothing points at it any more.
drop function if exists public.abo_cart_is_redacted();

-- And the erasure itself reaches them. Both functions are restated
-- whole from 0101 with the drafts added, because a redaction that
-- erases a person from one table and not the other is worse than one
-- that fails outright: it reports success.
create or replace function public.abo_shopify_customer_redact(
  p_shop     text,
  p_customer text
) returns integer
language plpgsql security definer set search_path = public as $$
declare v_store uuid; v_ext text; v_deleted integer;
begin
  select id into v_store
    from public.stores
   where lower(shop_domain) = lower(p_shop)
     and provider = 'shopify'
     and status <> 'pending';
  if v_store is null then return 0; end if;

  v_ext := public.abo_shopify_customer_key(p_customer);
  if v_ext is null then return 0; end if;

  perform public.abo_customers_lock(v_store);

  -- By id, and only by id. Recording the email here is what let one
  -- request bury everybody who shared it.
  insert into public.shopify_redactions (store_id, external_id, email)
  values (v_store, v_ext, null);

  -- Their carts and their drafts go first, while the customer row is
  -- still here to join against. Matched by Shopify's id either way,
  -- so a row that was never linked to a customer still goes.
  delete from public.abandoned_checkouts
   where store_id = v_store
     and (customer_external_id = v_ext
          or customer_id in (select id from public.customers
                              where store_id = v_store and external_id = v_ext));

  delete from public.draft_orders
   where store_id = v_store
     and (customer_external_id = v_ext
          or customer_id in (select id from public.customers
                              where store_id = v_store and external_id = v_ext));

  delete from public.customers
   where store_id = v_store and external_id = v_ext;

  get diagnostics v_deleted = row_count;
  return v_deleted;
end $$;

revoke all on function public.abo_shopify_customer_redact(text, text) from public;

create or replace function public.abo_shopify_customer_redact_email(
  p_shop  text,
  p_email text
) returns integer
language plpgsql security definer set search_path = public as $$
declare v_store uuid; v_deleted integer; v_email text;
begin
  v_email := nullif(btrim(coalesce(p_email, '')), '');
  if v_email is null then return 0; end if;

  select id into v_store
    from public.stores
   where lower(shop_domain) = lower(p_shop)
     and provider = 'shopify'
     and status <> 'pending';
  if v_store is null then return 0; end if;

  perform public.abo_customers_lock(v_store);

  insert into public.shopify_redactions (store_id, external_id, email)
  values (v_store, null, v_email);

  -- Everyone in this store at that address: carts, drafts and the
  -- customer. Shopify named no id, so there is nothing narrower to
  -- act on, and leaving a match behind would be refusing the request.
  delete from public.abandoned_checkouts
   where store_id = v_store
     and email is not null
     and btrim(email) <> ''
     and lower(btrim(email)) = lower(v_email);

  delete from public.draft_orders
   where store_id = v_store
     and email is not null
     and btrim(email) <> ''
     and lower(btrim(email)) = lower(v_email);

  delete from public.customers
   where store_id = v_store
     and email is not null
     and btrim(email) <> ''
     and lower(btrim(email)) = lower(v_email);

  get diagnostics v_deleted = row_count;
  return v_deleted;
end $$;

revoke all on function public.abo_shopify_customer_redact_email(text, text) from public;

-- ── What a merchant reads ──────────────────────────────────────
create or replace view public.store_draft_orders with (security_invoker = true) as
select
  d.id,
  d.store_id,
  d.name,
  to_char(d.drafted_at, 'YYYY-MM-DD') as drafted_at,
  -- Said in the merchant's words rather than Shopify's constant. The
  -- distinction that matters on this list is "still owed" against
  -- "already an order", and INVOICE_SENT reads as neither.
  case d.status
    when 'OPEN'         then 'Open'
    when 'INVOICE_SENT' then 'Invoice sent'
    when 'COMPLETED'    then 'Became an order'
    else initcap(coalesce(d.status, 'Open'))
  end as state,
  coalesce(nullif(d.name_on_draft, ''), c.name, nullif(d.email, ''), 'No customer') as customer_name,
  d.email,
  d.total,
  d.subtotal,
  d.tax,
  d.shipping,
  d.currency,
  nullif(array_to_string(d.tags, ', '), '') as tags,
  -- The order it became, by its number rather than its id, because
  -- that is what the merchant can look up.
  o.order_number as became_order,
  d.invoice_url,
  (select count(*) from public.draft_order_line_items li where li.draft_order_id = d.id) as items,
  d.completed_at
from public.draft_orders d
left join public.customers c on c.id = d.customer_id
left join public.orders o on o.id = d.order_id;

grant select on public.store_draft_orders to authenticated;

create or replace view public.store_draft_order_items with (security_invoker = true) as
select
  li.id,
  li.store_id,
  d.name as draft,
  li.title,
  li.sku,
  li.quantity,
  li.price,
  (li.quantity * li.price) as line_total,
  -- A line the merchant typed rather than picked. Worth saying: it
  -- will never match a product, and a report that quietly drops it
  -- is under-counting a real sale.
  (li.product_id is null) as custom_item
from public.draft_order_line_items li
join public.draft_orders d on d.id = li.draft_order_id;

grant select on public.store_draft_order_items to authenticated;

-- The one mapping, two lines longer (0089, 0090, 0092, 0095, 0099, 0100).
create or replace function public.abo_store_view(t text) returns text
language sql immutable as $$
  select case t
    when 'orders'                 then 'store_orders'
    when 'customers'              then 'store_customers'
    when 'products'               then 'store_products'
    when 'inventory_levels'       then 'store_inventory'
    when 'product_sales'          then 'product_sales'
    when 'order_line_items'       then 'store_order_items'
    when 'refunds'                then 'store_refunds'
    when 'variants'               then 'store_variants'
    when 'fulfillments'           then 'store_fulfillments'
    when 'transactions'           then 'store_transactions'
    when 'locations'              then 'store_locations'
    when 'collections'            then 'store_collections'
    when 'carts'                  then 'store_abandoned_checkouts'
    -- Keyed by what STORE_TABLES calls the list, not by the table it
    -- reads: 'carts' names abandoned_checkouts, and check-stats walks
    -- the TypeScript keys through this function.
    when 'drafts'                 then 'store_draft_orders'
    when 'draft_order_items'      then 'store_draft_order_items'
  end;
$$;

-- ── The webhook road ────────────────────────────────────────────
-- REST spells it flat and in snake case, and its status is lower
-- case where GraphQL's is upper. Both roads have to leave the same
-- row behind or a draft changes shape depending on which one last
-- touched it.
create or replace function public.abo_shopify_upsert_draft_order(p_shop text, p_d jsonb)
returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_store uuid;
  v_ext   text;
  v_draft uuid;
  v_line  jsonb;
  v_n     integer := 0;
begin
  select id into v_store
    from public.stores
   where lower(shop_domain) = lower(p_shop)
     and provider = 'shopify'
     and status <> 'pending';
  if v_store is null then return 0; end if;

  v_ext := public.abo_shopify_gid('DraftOrder', p_d->>'id');
  if v_ext is null then return 0; end if;

  insert into public.draft_orders (
    store_id, external_id, name, status,
    customer_id, customer_external_id, name_on_draft, email,
    total, subtotal, tax, shipping, currency, tags, invoice_url,
    order_id, order_external_id, drafted_at, completed_at, updated_at
  ) values (
    v_store, v_ext,
    nullif(p_d->>'name', ''),
    upper(nullif(p_d->>'status', '')),
    (select id from public.customers
      where store_id = v_store
        and external_id = public.abo_shopify_gid('Customer', p_d#>>'{customer,id}')),
    public.abo_shopify_gid('Customer', p_d#>>'{customer,id}'),
    nullif(btrim(concat_ws(' ', p_d#>>'{customer,first_name}', p_d#>>'{customer,last_name}')), ''),
    nullif(p_d->>'email', ''),
    nullif(p_d->>'total_price', '')::numeric,
    nullif(p_d->>'subtotal_price', '')::numeric,
    nullif(p_d->>'total_tax', '')::numeric,
    -- Shipping arrives as one line on this road, not as a total.
    nullif(p_d#>>'{shipping_line,price}', '')::numeric,
    nullif(p_d->>'currency', ''),
    coalesce(
      (select array_agg(btrim(t))
         from unnest(string_to_array(coalesce(p_d->>'tags', ''), ',')) as t
        where btrim(t) <> ''),
      '{}'::text[]
    ),
    nullif(p_d->>'invoice_url', ''),
    (select id from public.orders
      where store_id = v_store
        and external_id = public.abo_shopify_gid('Order', p_d->>'order_id')),
    public.abo_shopify_gid('Order', p_d->>'order_id'),
    (nullif(p_d->>'created_at', ''))::timestamptz,
    (nullif(p_d->>'completed_at', ''))::timestamptz,
    coalesce((nullif(p_d->>'updated_at', ''))::timestamptz, now())
  )
  on conflict (store_id, external_id) do update set
    name                 = coalesce(excluded.name, public.draft_orders.name),
    status               = coalesce(excluded.status, public.draft_orders.status),
    customer_id          = coalesce(excluded.customer_id, public.draft_orders.customer_id),
    customer_external_id = coalesce(excluded.customer_external_id, public.draft_orders.customer_external_id),
    name_on_draft        = coalesce(excluded.name_on_draft, public.draft_orders.name_on_draft),
    email                = coalesce(excluded.email, public.draft_orders.email),
    total                = coalesce(excluded.total, public.draft_orders.total),
    subtotal             = coalesce(excluded.subtotal, public.draft_orders.subtotal),
    tax                  = coalesce(excluded.tax, public.draft_orders.tax),
    shipping             = coalesce(excluded.shipping, public.draft_orders.shipping),
    currency             = coalesce(excluded.currency, public.draft_orders.currency),
    tags                 = excluded.tags,
    invoice_url          = coalesce(excluded.invoice_url, public.draft_orders.invoice_url),
    order_id             = coalesce(excluded.order_id, public.draft_orders.order_id),
    order_external_id    = coalesce(excluded.order_external_id, public.draft_orders.order_external_id),
    completed_at         = coalesce(excluded.completed_at, public.draft_orders.completed_at),
    updated_at           = excluded.updated_at
  returning id into v_draft;

  -- Null when the trigger skipped the row: this draft names somebody
  -- who asked to be erased. Its lines must not be written either.
  if v_draft is null then return 0; end if;

  -- Replaced rather than merged, the same as an order's lines (0098):
  -- a line removed in Shopify has to disappear here too.
  delete from public.draft_order_line_items where draft_order_id = v_draft;

  for v_line in select * from jsonb_array_elements(coalesce(p_d->'line_items', '[]'::jsonb))
  loop
    insert into public.draft_order_line_items (
      store_id, draft_order_id, external_id, product_id, variant_id, title, sku, quantity, price
    ) values (
      v_store, v_draft,
      public.abo_shopify_gid('DraftOrderLineItem', v_line->>'id'),
      (select id from public.products where store_id = v_store
        and external_id = public.abo_shopify_gid('Product', v_line->>'product_id')),
      (select id from public.variants where store_id = v_store
        and external_id = public.abo_shopify_gid('ProductVariant', v_line->>'variant_id')),
      nullif(v_line->>'title', ''),
      nullif(v_line->>'sku', ''),
      nullif(v_line->>'quantity', '')::integer,
      nullif(v_line->>'price', '')::numeric
    );
    v_n := v_n + 1;
  end loop;

  update public.stores set last_synced_at = now() where id = v_store;
  return v_n;
end $$;

revoke all on function public.abo_shopify_upsert_draft_order(text, jsonb) from public;
revoke execute on function public.abo_shopify_upsert_draft_order(text, jsonb) from anon, authenticated;

-- Deleted in Shopify means gone here. A draft is a working document,
-- not a record of something that happened, so unlike a location
-- nothing later points back at one that no longer exists. The lines
-- go with it by cascade.
create or replace function public.abo_shopify_delete_draft_order(p_shop text, p_id text)
returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_store uuid;
  v_n     integer;
begin
  select id into v_store
    from public.stores
   where lower(shop_domain) = lower(p_shop)
     and provider = 'shopify'
     and status <> 'pending';
  if v_store is null or public.abo_shopify_gid('DraftOrder', p_id) is null then return 0; end if;

  delete from public.draft_orders
   where store_id = v_store
     and external_id = public.abo_shopify_gid('DraftOrder', p_id);
  get diagnostics v_n = row_count;
  return v_n;
end $$;

revoke all on function public.abo_shopify_delete_draft_order(text, text) from public;
revoke execute on function public.abo_shopify_delete_draft_order(text, text) from anon, authenticated;

-- The dispatcher (0101), three topics longer.
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
  end if;

  -- Signed, at a real address, and a topic nobody asked for. The
  -- compliance topics land here too, which is correct: they have their
  -- own door and do not arrive at this one.
  return 0;
end $$;

revoke all on function public.abo_shopify_webhook(text, text, text, text) from public;
grant execute on function public.abo_shopify_webhook(text, text, text, text) to anon, authenticated;

NOTIFY pgrst, 'reload schema';
