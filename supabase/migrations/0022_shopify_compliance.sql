-- Migration 0022: the three things Shopify requires a public app to do
-- when a merchant or a shopper asks for their data back or gone.
--
-- A webhook arrives with no session — Shopify signs it, nobody signs in.
-- So these are security definer and called with the anon key, exactly
-- like abo_shopify_connect, which is what keeps the service-role key off
-- the server entirely. Each one is reachable only by naming a shop
-- domain, and the route will not call any of them until the signature on
-- the body has been verified.

-- ── A shopper asking what we hold ───────────────────────────────
-- Recorded rather than answered on the spot: the answer belongs to the
-- merchant, who has 30 days to give it. Dropping the request silently
-- would be the app deciding on their behalf that nobody asked.
create table if not exists public.shopify_data_requests (
  id                   uuid primary key default gen_random_uuid(),
  store_id             uuid not null references public.stores(id) on delete cascade,
  customer_external_id text,
  payload              jsonb not null,
  received_at          timestamptz not null default now(),
  fulfilled_at         timestamptz
);
create index if not exists idx_data_requests_store
  on public.shopify_data_requests(store_id, received_at desc);

alter table public.shopify_data_requests enable row level security;
drop policy if exists "shopify_data_requests_owner_all" on public.shopify_data_requests;
create policy "shopify_data_requests_owner_all" on public.shopify_data_requests
  for all using (public.abo_store_owned(store_id))
  with check (public.abo_store_owned(store_id));
drop policy if exists "shopify_data_requests_member_read" on public.shopify_data_requests;
create policy "shopify_data_requests_member_read" on public.shopify_data_requests
  for select using (public.abo_store_readable(store_id));

-- The importer stores Shopify's GraphQL id, "gid://shopify/Customer/123".
-- The webhook sends the bare "123". Matching only one of the two forms
-- would mean a redact that reports success and erases nothing.
create or replace function public.abo_shopify_customer_key(p_customer text)
returns text language sql immutable as $$
  select case
    when p_customer like 'gid://%' then p_customer
    else 'gid://shopify/Customer/' || p_customer
  end
$$;

create or replace function public.abo_shopify_data_request(
  p_shop     text,
  p_customer text,
  p_payload  jsonb
) returns boolean
language plpgsql security definer set search_path = public as $$
declare v_store uuid;
begin
  select id into v_store from public.stores where shop_domain = p_shop;
  if v_store is null then
    return false;  -- not a store of ours; nothing is held to hand over
  end if;

  insert into public.shopify_data_requests (store_id, customer_external_id, payload)
  values (v_store, public.abo_shopify_customer_key(p_customer), p_payload);
  return true;
end $$;

-- ── A shopper asking to be erased ───────────────────────────────
-- Only the person is erased. Their orders stay, with customer_id going
-- null through the existing foreign key, because the merchant's books
-- still have to add up after somebody exercises this right.
create or replace function public.abo_shopify_customer_redact(
  p_shop     text,
  p_customer text
) returns integer
language plpgsql security definer set search_path = public as $$
declare v_store uuid; v_deleted integer;
begin
  select id into v_store from public.stores where shop_domain = p_shop;
  if v_store is null then return 0; end if;

  delete from public.customers
   where store_id = v_store
     and external_id = public.abo_shopify_customer_key(p_customer);

  get diagnostics v_deleted = row_count;
  return v_deleted;
end $$;

-- ── A merchant who uninstalled ──────────────────────────────────
-- Deleting the store row takes everything with it: products, variants,
-- stock, customers, orders, line items, refunds, import runs and the
-- access token, all by cascade from 0018.
create or replace function public.abo_shopify_shop_redact(p_shop text)
returns integer
language plpgsql security definer set search_path = public as $$
declare v_deleted integer;
begin
  delete from public.stores where shop_domain = p_shop;
  get diagnostics v_deleted = row_count;
  return v_deleted;
end $$;

revoke all on function public.abo_shopify_data_request(text, text, jsonb) from public;
revoke all on function public.abo_shopify_customer_redact(text, text) from public;
revoke all on function public.abo_shopify_shop_redact(text) from public;
grant execute on function public.abo_shopify_data_request(text, text, jsonb) to anon, authenticated;
grant execute on function public.abo_shopify_customer_redact(text, text) to anon, authenticated;
grant execute on function public.abo_shopify_shop_redact(text) to anon, authenticated;

NOTIFY pgrst, 'reload schema';
