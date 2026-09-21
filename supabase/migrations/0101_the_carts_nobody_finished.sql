-- Migration 0101: the carts nobody finished.
--
-- The shop's near misses. Somebody filled a basket, reached the
-- checkout and left; Shopify keeps it, with a link that takes that
-- person back to their own basket. The copy has never held one, so
-- the most answerable question in retail — who nearly bought, and
-- what was in it — could not be asked here at all.
--
-- No new scope. read_orders covers a checkout that never became an
-- order, so this arrives without anybody reconnecting.
--
-- ── Personal data ──────────────────────────────────────────────
--
-- A cart carries an email and a name, which makes this the second
-- table in the app holding a person. Everything 0063 and 0064 built
-- for customers therefore applies here, and is applied here:
--
--   * a redaction erases the carts as well as the customer, by id
--     and by email alike;
--   * a trigger refuses a redacted person's cart on the way back in,
--     so the next import cannot undo the erasure;
--   * both take the same advisory lock the customer path takes, so a
--     redaction in flight finishes before an import steps over it.
--
-- Getting that wrong would mean an erased customer's address sitting
-- in a table nobody thought to look in, which is the whole failure
-- the tombstone exists to prevent.
--
-- Callers: src/lib/shopify-import.ts (saveCarts), the carts resource
-- in src/lib/shopify-resources.ts, STORE_TABLES.carts and COUNTED in
-- src/lib/store-read.ts, and the webhook route through
-- abo_shopify_webhook.

create table if not exists public.abandoned_checkouts (
  id                   uuid primary key default gen_random_uuid(),
  store_id             uuid not null references public.stores(id) on delete cascade,
  external_id          text not null,
  -- The customer row when we hold one. A cart is often the first
  -- thing a person ever leaves, so this is null more often than not.
  customer_id          uuid references public.customers(id) on delete set null,
  -- Shopify's own id for that person, kept because a redaction names
  -- them by it and the link above may be null.
  customer_external_id text,
  name                 text,
  email                text,
  total                numeric(12,2),
  currency             text,
  -- Shopify's link back to this exact basket. The point of the row.
  recovery_url         text,
  item_count           integer,
  -- What was nearly bought, as words. A basket that never became an
  -- order does not deserve a table of its own.
  items                text,
  started_at           timestamptz,
  updated_at           timestamptz,
  created_at           timestamptz not null default now()
);
create unique index if not exists idx_carts_unique on public.abandoned_checkouts(store_id, external_id);
create index if not exists idx_carts_store on public.abandoned_checkouts(store_id, started_at desc);
create index if not exists idx_carts_email on public.abandoned_checkouts(store_id, email);

-- The two policies every commerce table has (0018), and the three
-- that keep a connected assistant from writing at the table (0070).
alter table public.abandoned_checkouts enable row level security;
drop policy if exists "abandoned_checkouts_owner_all" on public.abandoned_checkouts;
create policy "abandoned_checkouts_owner_all" on public.abandoned_checkouts
  for all using (public.abo_store_owned(store_id)) with check (public.abo_store_owned(store_id));
drop policy if exists "abandoned_checkouts_member_read" on public.abandoned_checkouts;
create policy "abandoned_checkouts_member_read" on public.abandoned_checkouts
  for select using (public.abo_store_readable(store_id));

drop policy if exists "abandoned_checkouts_oauth_no_insert" on public.abandoned_checkouts;
create policy "abandoned_checkouts_oauth_no_insert"
  on public.abandoned_checkouts as restrictive
  for insert to authenticated with check (not public.abo_is_oauth_client());
drop policy if exists "abandoned_checkouts_oauth_no_update" on public.abandoned_checkouts;
create policy "abandoned_checkouts_oauth_no_update"
  on public.abandoned_checkouts as restrictive
  for update to authenticated using (not public.abo_is_oauth_client());
drop policy if exists "abandoned_checkouts_oauth_no_delete" on public.abandoned_checkouts;
create policy "abandoned_checkouts_oauth_no_delete"
  on public.abandoned_checkouts as restrictive
  for delete to authenticated using (not public.abo_is_oauth_client());

-- ── Erased stays erased, here too ──────────────────────────────
-- The same shape as abo_customer_is_redacted (0064), reading the
-- same tombstones. A cart names its person by Shopify's id when it
-- has one and by email otherwise, so both are matched.
create or replace function public.abo_cart_is_redacted()
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
    -- Skipped, not raised: an import of two hundred carts holding one
    -- erased person writes the other hundred and ninety-nine.
    return null;
  end if;
  return new;
end $$;

revoke all on function public.abo_cart_is_redacted() from public;

drop trigger if exists trg_carts_not_redacted on public.abandoned_checkouts;
create trigger trg_carts_not_redacted
  before insert or update on public.abandoned_checkouts
  for each row execute function public.abo_cart_is_redacted();

-- And the redaction itself reaches them. Both functions are restated
-- whole from 0064 with the carts added, because a redaction that
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

  -- Their carts go first, while the customer row is still here to
  -- join against. Matched by Shopify's id either way, so a cart that
  -- was never linked to a customer row still goes.
  delete from public.abandoned_checkouts
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

  -- Everyone in this store at that address, carts included. Shopify
  -- named no id, so there is nothing narrower to act on, and leaving
  -- a match behind would be refusing the request.
  delete from public.abandoned_checkouts
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

create or replace view public.store_abandoned_checkouts with (security_invoker = true) as
select
  c.id,
  c.store_id,
  to_char(c.started_at, 'YYYY-MM-DD') as started_at,
  coalesce(nullif(c.name, ''), 'Not signed in') as customer_name,
  c.email,
  c.total,
  c.currency,
  c.item_count,
  c.items,
  c.recovery_url
from public.abandoned_checkouts c;

grant select on public.store_abandoned_checkouts to authenticated;

-- The one mapping, one line longer (0089, 0090, 0092, 0095, 0099, 0100).
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
    when 'locations'        then 'store_locations'
    when 'collections'      then 'store_collections'
    when 'carts'            then 'store_abandoned_checkouts'
  end;
$$;

-- ── The webhook road ────────────────────────────────────────────
-- REST calls them checkouts. One that has been completed is not
-- abandoned any more, so it is removed rather than written: the list
-- is of baskets still sitting there.
create or replace function public.abo_shopify_upsert_cart(p_shop text, p_c jsonb)
returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_store uuid;
  v_ext   text;
  v_email text;
begin
  select id into v_store
    from public.stores
   where lower(shop_domain) = lower(p_shop)
     and provider = 'shopify'
     and status <> 'pending';
  if v_store is null then return 0; end if;

  v_ext := public.abo_shopify_gid('AbandonedCheckout', p_c->>'id');
  if v_ext is null then return 0; end if;

  -- Finished, so no longer a near miss.
  if nullif(p_c->>'completed_at', '') is not null then
    delete from public.abandoned_checkouts where store_id = v_store and external_id = v_ext;
    return 1;
  end if;

  v_email := nullif(coalesce(p_c->>'email', p_c#>>'{customer,email}'), '');

  insert into public.abandoned_checkouts (
    store_id, external_id, customer_id, customer_external_id, name, email,
    total, currency, recovery_url, item_count, items, started_at, updated_at
  ) values (
    v_store, v_ext,
    (select id from public.customers
      where store_id = v_store
        and external_id = public.abo_shopify_gid('Customer', p_c#>>'{customer,id}')),
    public.abo_shopify_gid('Customer', p_c#>>'{customer,id}'),
    nullif(btrim(concat_ws(' ', p_c#>>'{customer,first_name}', p_c#>>'{customer,last_name}')), ''),
    v_email,
    nullif(p_c->>'total_price', '')::numeric,
    nullif(p_c->>'currency', ''),
    nullif(p_c->>'abandoned_checkout_url', ''),
    (select coalesce(sum((li->>'quantity')::integer), 0)
       from jsonb_array_elements(coalesce(p_c->'line_items', '[]'::jsonb)) as li),
    (select nullif(string_agg(
              case when (li->>'quantity')::integer > 1
                   then (li->>'title') || ' ×' || (li->>'quantity')
                   else li->>'title' end, ', '), '')
       from jsonb_array_elements(coalesce(p_c->'line_items', '[]'::jsonb)) as li),
    (nullif(p_c->>'created_at', ''))::timestamptz,
    coalesce((nullif(p_c->>'updated_at', ''))::timestamptz, now())
  )
  on conflict (store_id, external_id) do update set
    customer_id          = coalesce(excluded.customer_id, public.abandoned_checkouts.customer_id),
    customer_external_id = coalesce(excluded.customer_external_id, public.abandoned_checkouts.customer_external_id),
    name                 = coalesce(excluded.name, public.abandoned_checkouts.name),
    email                = coalesce(excluded.email, public.abandoned_checkouts.email),
    total                = coalesce(excluded.total, public.abandoned_checkouts.total),
    currency             = coalesce(excluded.currency, public.abandoned_checkouts.currency),
    recovery_url         = coalesce(excluded.recovery_url, public.abandoned_checkouts.recovery_url),
    item_count           = excluded.item_count,
    items                = coalesce(excluded.items, public.abandoned_checkouts.items),
    updated_at           = excluded.updated_at;

  update public.stores set last_synced_at = now() where id = v_store;
  return 1;
end $$;

revoke all on function public.abo_shopify_upsert_cart(text, jsonb) from public;
revoke execute on function public.abo_shopify_upsert_cart(text, jsonb) from anon, authenticated;

create or replace function public.abo_shopify_delete_cart(p_shop text, p_id text)
returns integer
language plpgsql security definer set search_path = public as $$
declare v_store uuid; v_n integer;
begin
  select id into v_store
    from public.stores
   where lower(shop_domain) = lower(p_shop)
     and provider = 'shopify'
     and status <> 'pending';
  if v_store is null or public.abo_shopify_gid('AbandonedCheckout', p_id) is null then return 0; end if;

  delete from public.abandoned_checkouts
   where store_id = v_store
     and external_id = public.abo_shopify_gid('AbandonedCheckout', p_id);
  get diagnostics v_n = row_count;
  return v_n;
end $$;

revoke all on function public.abo_shopify_delete_cart(text, text) from public;
revoke execute on function public.abo_shopify_delete_cart(text, text) from anon, authenticated;

-- The dispatcher (0100), three topics longer.
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
  end if;

  -- Signed, at a real address, and a topic nobody asked for. The
  -- compliance topics land here too, which is correct: they have their
  -- own door and do not arrive at this one.
  return 0;
end $$;

revoke all on function public.abo_shopify_webhook(text, text, text, text) from public;
grant execute on function public.abo_shopify_webhook(text, text, text, text) to anon, authenticated;

NOTIFY pgrst, 'reload schema';
