-- Migration 0207: stock is counted whole
--
-- On hand and committed froze at the last import (Tanish's Stock, 12 Oct:
-- 64 available, 1 committed, 108 on hand; some rows below zero). Shopify's
-- inventory_levels/update carries `available` alone, which is all 0060
-- writes, and a sale, a cancel, a fulfilment or a restock moves on_hand and
-- committed as well. A fulfilment moves them without touching available,
-- so no stock webhook comes for it at all.
--
-- - stock_refresh_due   the variants a webhook said may have moved. Any
--                       webhook that can move stock marks them
--                       (abo_stock_mark): stock levels, every orders topic
--                       (a refund's restock arrives as orders/updated) and
--                       fulfillments.
-- - the import worker   reads each due variant's whole count from Shopify,
--                       a page at a time, on its own ticket, token handling
--                       and clock (lib/shopify-import refreshStock), and
--                       writes all four numbers as the import does.
--                       Settled only if not marked again since it was read.
-- - abo_import_tick     also sends a store with stock due.
-- - abo_import_sweep    each night marks due the variants a store counted
--                       longest ago, a capped share a night, so what no
--                       webhook says (a transfer's incoming, a delivery
--                       Shopify never made) is counted again within days,
--                       at a cost a large store's API budget can carry.
-- - updated_at          on a stock row is now when its numbers were last
--                       read whole: the stock webhook moves available alone
--                       and no longer claims the row fresh.
--
-- And once, now, where there is a worker (production): every store's stock
-- pass is run again, which heals the drift already there. The check project
-- has no worker, and its seeded shops are not real, so it is left alone.

create table if not exists public.stock_refresh_due (
  store_id   uuid not null references public.stores(id) on delete cascade,
  variant_id uuid not null references public.variants(id) on delete cascade,
  due_at     timestamptz not null default now(),
  primary key (store_id, variant_id)
);
create index if not exists stock_refresh_due_when on public.stock_refresh_due (store_id, due_at);
-- The stock webhook finds its variant by inventory item.
create index if not exists idx_variants_inventory_item on public.variants (store_id, inventory_item_id);

alter table public.stock_refresh_due enable row level security;
-- Nobody signed in reads or writes it; the worker reaches its own store's
-- rows by its ticket, as it reaches the store's other rows (0110).
revoke all on public.stock_refresh_due from authenticated;
drop policy if exists stock_refresh_due_import_ticket on public.stock_refresh_due;
create policy stock_refresh_due_import_ticket on public.stock_refresh_due for all to anon
  using (public.abo_import_holds(store_id)) with check (public.abo_import_holds(store_id));
drop policy if exists stock_refresh_due_oauth_no_insert on public.stock_refresh_due;
create policy stock_refresh_due_oauth_no_insert on public.stock_refresh_due
  as restrictive for insert to authenticated with check (not public.abo_is_oauth_client());
drop policy if exists stock_refresh_due_oauth_no_update on public.stock_refresh_due;
create policy stock_refresh_due_oauth_no_update on public.stock_refresh_due
  as restrictive for update to authenticated using (not public.abo_is_oauth_client());
drop policy if exists stock_refresh_due_oauth_no_delete on public.stock_refresh_due;
create policy stock_refresh_due_oauth_no_delete on public.stock_refresh_due
  as restrictive for delete to authenticated using (not public.abo_is_oauth_client());

/**
 * The variants a webhook's payload says may have moved, marked due. Its
 * shapes as Shopify sends them: a stock level names an inventory item; an
 * order or a fulfilment lists its line items, each with its variant.
 */
create or replace function public.abo_stock_mark(p_shop text, p_topic text, p_body jsonb)
returns integer
language plpgsql volatile security definer set search_path = public as $$
declare
  v_store uuid;
  v_lines jsonb;
  v_n     integer;
begin
  select id into v_store
    from public.stores
   where lower(shop_domain) = lower(p_shop)
     and provider = 'shopify'
     and status <> 'pending';
  if v_store is null or jsonb_typeof(p_body) <> 'object' then
    return 0;
  end if;
  v_lines := case when jsonb_typeof(p_body->'line_items') = 'array' then p_body->'line_items' else '[]'::jsonb end;
  insert into public.stock_refresh_due as d (store_id, variant_id, due_at)
  select v_store, v.id, now()
    from public.variants v
   where v.store_id = v_store
     and (
       (p_topic in ('inventory_levels/update', 'inventory_levels/connect')
        and v.inventory_item_id = public.abo_shopify_gid('InventoryItem', p_body->>'inventory_item_id'))
       or ((p_topic like 'orders/%' or p_topic like 'fulfillments/%')
           and v.external_id in (
             select public.abo_shopify_gid('ProductVariant', li->>'variant_id')
               from jsonb_array_elements(v_lines) li
              where nullif(li->>'variant_id', '') is not null))
     )
  on conflict (store_id, variant_id) do update set due_at = excluded.due_at;
  get diagnostics v_n = row_count;
  return v_n;
end $$;
revoke all on function public.abo_stock_mark(text, text, jsonb) from public, anon, authenticated;

-- 0150's, marking what may have moved before handing the body on.
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
  if p_raw is null or p_hmac is null or p_token is null then
    raise exception 'Unsigned.' using errcode = '42501';
  end if;
  select s.shop_domain into v_shop
    from public.stores s
   where s.provider = 'shopify'
     and s.status <> 'pending'
     and public.abo_shopify_webhook_token(s.shop_domain) = p_token;

  if v_shop is null then
    raise exception 'Unsigned.' using errcode = '42501';
  end if;
  -- Its own app's secret, which proves the body (0150).
  v_secret := public.abo_shopify_secret_for(v_shop);
  if v_secret is null then
    raise exception 'Webhooks are not configured.' using errcode = '42501';
  end if;
  if encode(extensions.hmac(p_raw, v_secret, 'sha256'), 'base64') <> p_hmac then
    raise exception 'That did not come from Shopify.' using errcode = '42501';
  end if;

  v_body := p_raw::jsonb;

  -- Its variants' whole stock is counted again (0207): the payload holds
  -- available at most, and a sale or a fulfilment moves on hand too.
  perform public.abo_stock_mark(v_shop, p_topic, v_body);

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

-- 0154's, sending a store with stock due as well.
create or replace function public.abo_import_tick()
returns integer
language plpgsql volatile security definer set search_path = public as $$
declare
  v_store uuid;
  v_sent  integer := 0;
begin
  if not exists (select 1 from vault.decrypted_secrets where name = 'import_worker_url') then
    return 0;
  end if;
  for v_store in
    select s.id
      from public.stores s
     where s.status = 'connected'
       and not (
         s.history_set_at is null and s.connected_at > now() - interval '15 minutes'
         and coalesce((select h.enabled from public.history_settings h where h.id), true)
       )
       and not exists (
         select 1 from public.import_leases l where l.store_id = s.id and l.expires_at > now()
       )
       and (
         not exists (select 1 from public.import_runs r where r.store_id = s.id)
         or exists (
           select 1 from public.import_runs r
            where r.store_id = s.id
              and (
                r.status in ('pending', 'running')
                or (r.status = 'failed' and r.retry_at is not null and r.retry_at <= now())
              )
         )
         or exists (
           select 1 from public.stock_refresh_due d where d.store_id = s.id and d.due_at <= now()
         )
       )
     order by s.connected_at nulls first
     limit 200
  loop
    if public.abo_import_dispatch(v_store) = 'sent' then
      v_sent := v_sent + 1;
    end if;
  end loop;
  return v_sent;
end $$;

-- 0060's, with available moved alone: updated_at stays when the row was
-- last counted whole, which the recount below orders by.
create or replace function public.abo_shopify_set_inventory(p_shop text, p_level jsonb)
returns integer
language plpgsql security definer set search_path = public as $$
declare v_store uuid; v_variant uuid; v_loc text;
begin
  select id into v_store
    from public.stores
   where lower(shop_domain) = lower(p_shop)
     and provider = 'shopify'
     and status <> 'pending';
  if v_store is null then return 0; end if;

  select id into v_variant from public.variants
   where store_id = v_store
     and inventory_item_id = public.abo_shopify_gid('InventoryItem', p_level->>'inventory_item_id');

  -- Raised, not ignored: a level for a variant not here yet means the
  -- product is seconds behind, and a 500 has Shopify send it again (0052).
  if v_variant is null then
    raise exception 'inventory arrived before its product (item %)',
      coalesce(p_level->>'inventory_item_id', '?')
      using errcode = '55006';
  end if;

  v_loc := public.abo_shopify_gid('Location', p_level->>'location_id');

  insert into public.inventory_levels (
    store_id, variant_id, location_id, location_name, available, updated_at
  ) values (
    v_store, v_variant, v_loc,
    coalesce(
      (select location_name from public.inventory_levels
        where store_id = v_store and location_id = v_loc limit 1),
      ''
    ),
    coalesce(nullif(p_level->>'available', '')::integer, 0),
    coalesce((nullif(p_level->>'updated_at', ''))::timestamptz, now())
  )
  on conflict (store_id, variant_id, location_id)
  do update set available = excluded.available;

  return 1;
end $$;

/** A night's share of a store's stock to count again: the variants counted longest ago. */
create or replace function public.abo_stock_recount(p_store uuid, p_most integer default 2000)
returns integer
language sql volatile security definer set search_path = public as $$
  with stalest as (
    select l.variant_id
      from public.inventory_levels l
     where l.store_id = p_store and l.variant_id is not null
     group by l.variant_id
     order by min(l.updated_at) nulls first
     limit greatest(p_most, 0)
  ), marked as (
    insert into public.stock_refresh_due (store_id, variant_id, due_at)
    select p_store, s.variant_id, now() from stalest s
    on conflict (store_id, variant_id) do nothing
    returning 1
  )
  select count(*)::integer from marked
$$;
revoke all on function public.abo_stock_recount(uuid, integer) from public, anon, authenticated;

-- 0110's, with a night's share of each store's stock marked to count again.
-- ponytail: 2,000 variants a night, so a 50k-variant store is recounted
-- every 25 nights; raise it, or recount by bulk export, if drift shows.
create or replace function public.abo_import_sweep()
returns integer
language plpgsql volatile security definer set search_path = public as $$
declare
  v_store uuid;
  v_sent  integer := 0;
begin
  if not exists (select 1 from vault.decrypted_secrets where name = 'import_worker_url') then
    return 0;
  end if;
  for v_store in
    select s.id
      from public.stores s
     where s.status = 'connected'
       and not exists (
         select 1 from public.import_leases l where l.store_id = s.id and l.expires_at > now()
       )
     limit 1000
  loop
    perform public.abo_stock_recount(v_store);
    if public.abo_import_dispatch(v_store) = 'sent' then
      v_sent := v_sent + 1;
    end if;
  end loop;
  return v_sent;
end $$;

-- The drift already there, healed once by the next tick: the stock pass
-- runs again (bulk for a big store), by the worker already deployed.
do $$
begin
  if exists (select 1 from vault.decrypted_secrets where name = 'import_worker_url') then
    update public.import_runs
       set status = 'pending', cursor = null, imported = 0, started_at = now(),
           finished_at = null, error = null, attempts = 0, retry_at = null
     where resource = 'inventory' and status = 'done';
  end if;
end $$;

notify pgrst, 'reload schema';
