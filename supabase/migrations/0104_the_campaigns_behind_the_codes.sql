-- Migration 0104: the campaigns behind the codes.
--
-- An order has carried its discount codes since 0092 — the strings
-- the customer typed. What none of them said is what the code WAS:
-- how much it took off, when it ran, how many times anyone used it,
-- whether it is still running. So "did Black Friday work" was a
-- question about a campaign this app could see the shadow of and
-- never the thing itself.
--
-- Under read_discounts, which arrived with the grant of 2026-09-21.
--
-- Shopify keeps eight concrete types under one union — basic, buy-
-- X-get-Y, free shipping and app-driven, each in a code and an
-- automatic flavour. Modelling all eight would be modelling
-- Shopify's rule engine. It is not modelled here. What is kept is
-- what the types share, the two numbers worth adding up, and
-- Shopify's own sentence describing the rest:
--
--   "80% off one-time purchase products • Minimum quantity of 1"
--
-- That sentence is written by Shopify, changes when the rule does,
-- and is already what the merchant reads in their own admin.
--
-- Callers: src/lib/shopify-import.ts (saveDiscounts), the discounts
-- resource in src/lib/shopify-resources.ts, STORE_TABLES.discounts
-- and COUNTED in src/lib/store-read.ts, and the webhook route
-- through abo_shopify_webhook.

create table if not exists public.discounts (
  id                 uuid primary key default gen_random_uuid(),
  store_id           uuid not null references public.stores(id) on delete cascade,
  -- The node's gid. Two shapes, DiscountCodeNode and
  -- DiscountAutomaticNode, which is why the webhook road below
  -- cannot simply build one from a numeric id.
  external_id        text not null,
  title              text,
  -- CODE: the customer types something. AUTOMATIC: it just applies.
  -- The difference decides whether "codes" below means anything.
  method             text,
  -- BASIC, BXGY, FREE_SHIPPING or APP.
  kind               text,
  -- ACTIVE, SCHEDULED or EXPIRED, as Shopify judges it.
  status             text,
  -- Shopify's own sentence. The rules, in words, kept instead of
  -- rebuilt: it stays true when Shopify changes what a type can do.
  summary            text,
  -- Usually one, but a campaign may have many.
  codes              text[] not null default '{}',
  -- Whole percents: Shopify reports 0.8, this holds 80. A column
  -- called percent_off that contains 0.8 is a bug waiting in every
  -- report that formats it.
  percent_off        numeric(6,2),
  amount_off         numeric(12,2),
  currency           text,
  -- Null means no limit, which is not the same as a limit of zero.
  usage_limit        integer,
  times_used         integer,
  once_per_customer  boolean,
  starts_at          timestamptz,
  ends_at            timestamptz,
  made_at            timestamptz,
  updated_at         timestamptz,
  created_at         timestamptz not null default now()
);
create unique index if not exists idx_discounts_unique on public.discounts(store_id, external_id);
create index if not exists idx_discounts_store on public.discounts(store_id);

comment on column public.discounts.percent_off is
  'Whole percents: 80 for 80% off. Shopify reports it as 0.8; the saver multiplies.';
comment on column public.discounts.summary is
  'Shopify''s own description of the rule. Kept rather than rebuilt from the eight discount types.';

-- The two policies every commerce table has (0018), and the three
-- that keep a connected assistant from writing at the table (0070).
alter table public.discounts enable row level security;
drop policy if exists "discounts_owner_all" on public.discounts;
create policy "discounts_owner_all" on public.discounts
  for all using (public.abo_store_owned(store_id)) with check (public.abo_store_owned(store_id));
drop policy if exists "discounts_member_read" on public.discounts;
create policy "discounts_member_read" on public.discounts
  for select using (public.abo_store_readable(store_id));

drop policy if exists "discounts_oauth_no_insert" on public.discounts;
create policy "discounts_oauth_no_insert"
  on public.discounts as restrictive
  for insert to authenticated
  with check (not public.abo_is_oauth_client());

drop policy if exists "discounts_oauth_no_update" on public.discounts;
create policy "discounts_oauth_no_update"
  on public.discounts as restrictive
  for update to authenticated
  using (not public.abo_is_oauth_client());

drop policy if exists "discounts_oauth_no_delete" on public.discounts;
create policy "discounts_oauth_no_delete"
  on public.discounts as restrictive
  for delete to authenticated
  using (not public.abo_is_oauth_client());

create or replace view public.store_discounts with (security_invoker = true) as
select
  d.id,
  d.store_id,
  d.title,
  case d.status
    when 'ACTIVE'    then 'Running'
    when 'SCHEDULED' then 'Not started'
    when 'EXPIRED'   then 'Finished'
    else initcap(coalesce(d.status, ''))
  end as state,
  case d.method when 'CODE' then 'Code' when 'AUTOMATIC' then 'Automatic' else d.method end as method,
  nullif(array_to_string(d.codes, ', '), '') as codes,
  -- One column a merchant can read at a glance, built from whichever
  -- of the two numbers this discount has. Free shipping has neither
  -- and says so; buy-X-get-Y is too shaped to fit here and falls
  -- through to the summary, which describes it properly.
  case
    when d.percent_off is not null then trim(trailing '.' from trim(trailing '0' from to_char(d.percent_off, 'FM990.00'))) || '% off'
    when d.amount_off is not null then concat_ws(' ', coalesce(d.currency, ''), trim(to_char(d.amount_off, 'FM999999990.00'))) || ' off'
    when d.kind = 'FREE_SHIPPING' then 'Free shipping'
    else null
  end as takes_off,
  d.summary,
  d.times_used,
  d.usage_limit,
  -- What is left before it stops working, for a campaign that has a
  -- ceiling. Null when there is none, never zero.
  case when d.usage_limit is not null
       then greatest(d.usage_limit - coalesce(d.times_used, 0), 0)
  end as uses_left,
  d.once_per_customer,
  to_char(d.starts_at, 'YYYY-MM-DD') as starts_at,
  to_char(d.ends_at, 'YYYY-MM-DD') as ends_at,
  d.kind
from public.discounts d;

grant select on public.store_discounts to authenticated;

-- The one mapping, one line longer (0089, 0090, 0092, 0095, 0099,
-- 0100, 0103). Keyed by what STORE_TABLES calls the list.
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
  end;
$$;

-- ── The webhook road ────────────────────────────────────────────
-- Deliberately narrow. A discount's shape lives in eight GraphQL
-- types and the webhook payload is flat, so this road keeps the few
-- fields it can be sure of fresh — the title, whether it is running,
-- when it runs — and coalesces everything else so it can never
-- overwrite the richer row the import wrote with a blank.
--
-- Identity is the awkward part. The import stores the node's gid,
-- which is DiscountCodeNode for one kind and DiscountAutomaticNode
-- for another, so a gid cannot be built from a numeric id the way
-- abo_shopify_gid builds the others. The payload's own
-- admin_graphql_api_id is used when it is there; otherwise an
-- existing row is found by the numeric tail of its gid. When
-- neither identifies it, nothing is written and the next import
-- picks it up — a wrong row is worse than a late one.
create or replace function public.abo_shopify_upsert_discount(p_shop text, p_d jsonb)
returns integer
language plpgsql security definer set search_path = public as $$
declare
  v_store uuid;
  v_ext   text;
  v_num   text;
begin
  select id into v_store
    from public.stores
   where lower(shop_domain) = lower(p_shop)
     and provider = 'shopify'
     and status <> 'pending';
  if v_store is null then return 0; end if;

  v_ext := nullif(p_d->>'admin_graphql_api_id', '');
  if v_ext is null then
    v_num := nullif(p_d->>'id', '');
    if v_num is null then return 0; end if;
    select external_id into v_ext
      from public.discounts
     where store_id = v_store
       and split_part(external_id, '/', 5) = v_num;
  end if;
  if v_ext is null then return 0; end if;

  insert into public.discounts (
    store_id, external_id, title, status, starts_at, ends_at, made_at, updated_at
  ) values (
    v_store, v_ext,
    nullif(p_d->>'title', ''),
    upper(nullif(p_d->>'status', '')),
    (nullif(p_d->>'starts_at', ''))::timestamptz,
    (nullif(p_d->>'ends_at', ''))::timestamptz,
    (nullif(p_d->>'created_at', ''))::timestamptz,
    coalesce((nullif(p_d->>'updated_at', ''))::timestamptz, now())
  )
  on conflict (store_id, external_id) do update set
    title      = coalesce(excluded.title, public.discounts.title),
    status     = coalesce(excluded.status, public.discounts.status),
    starts_at  = coalesce(excluded.starts_at, public.discounts.starts_at),
    -- An end date really can be cleared in Shopify — a campaign made
    -- to run forever — so this one is taken as sent rather than
    -- coalesced, but only when the payload says something about it.
    ends_at    = case when p_d ? 'ends_at' then excluded.ends_at else public.discounts.ends_at end,
    made_at    = coalesce(public.discounts.made_at, excluded.made_at),
    updated_at = excluded.updated_at;

  update public.stores set last_synced_at = now() where id = v_store;
  return 1;
end $$;

revoke all on function public.abo_shopify_upsert_discount(text, jsonb) from public;
revoke execute on function public.abo_shopify_upsert_discount(text, jsonb) from anon, authenticated;

-- Deleted in Shopify means gone here: an order keeps the code it
-- used as a string of its own (0092), so nothing is orphaned by
-- removing the campaign.
create or replace function public.abo_shopify_delete_discount(p_shop text, p_id text)
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
  if v_store is null or nullif(p_id, '') is null then return 0; end if;

  -- By the gid when one was sent, and by the numeric tail otherwise:
  -- the same two shapes the upsert has to handle.
  delete from public.discounts
   where store_id = v_store
     and (external_id = p_id or split_part(external_id, '/', 5) = p_id);
  get diagnostics v_n = row_count;
  return v_n;
end $$;

revoke all on function public.abo_shopify_delete_discount(text, text) from public;
revoke execute on function public.abo_shopify_delete_discount(text, text) from anon, authenticated;

-- The dispatcher (0103), three topics longer.
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
  end if;

  -- Signed, at a real address, and a topic nobody asked for. The
  -- compliance topics land here too, which is correct: they have their
  -- own door and do not arrive at this one.
  return 0;
end $$;

revoke all on function public.abo_shopify_webhook(text, text, text, text) from public;
grant execute on function public.abo_shopify_webhook(text, text, text, text) to anon, authenticated;

NOTIFY pgrst, 'reload schema';
