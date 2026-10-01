-- A store can come through an app of its own.
--
-- Until the public app is approved, Warmluke reaches a merchant's store
-- only through an app made for that store: one the merchant created in
-- their own Dev Dashboard, or one made for them with custom distribution.
-- The administrator enters it here once (its client id, its secret, the
-- stores it serves) and from then on everything about those stores goes
-- through it: the install, the token and its renewal, the webhooks, the
-- erasure requests. No deploy per merchant.
--
--   shopify_apps        the apps, and who each is for
--   shopify_app_shops   which stores come through which app (one app a store)
--   shopify_mode        internal mode: on, a store must have an app set up
--                       here; off, the public app is open to every store
--
-- An app's secret is kept in the vault, encrypted, and never read back
-- to anyone: the database checks a delivery's signature with it, and the
-- app server reads it with a key of its own (shopify_apps_key_sha256 in
-- app_secrets, set up once per database), which can read nothing else.
-- Every signature check that used the one secret now uses the secret of
-- the app the store came through (abo_shopify_secret_for); a store with
-- no app of its own is the main app's, as every store was before.
--
-- Callers: src/lib/shopify-apps.ts, src/app/admin/shopify/page.tsx,
-- src/app/api/shopify/*, src/lib/shopify-import.ts,
-- scripts/check-shopify-apps.mjs.

-- ── The apps, the stores, the switch ─────────────────────────

create table if not exists public.shopify_apps (
  id            uuid primary key default gen_random_uuid(),
  label         text not null check (length(btrim(label)) between 1 and 80),
  client_id     text not null unique check (client_id ~ '^[0-9a-f]{32}$'),
  -- The Warmluke account it is for: its Connect with Shopify goes through it.
  owner_email   text check (owner_email is null or owner_email ~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  -- The app has Shopify's read_all_orders: asked for at install, history past 60 days.
  all_orders    boolean not null default false,
  enabled       boolean not null default true,
  secret_set_at timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table if not exists public.shopify_app_shops (
  shop_domain text primary key check (shop_domain ~ '^[a-z0-9][a-z0-9-]*\.myshopify\.com$'),
  app_id      uuid not null references public.shopify_apps(id) on delete cascade,
  created_at  timestamptz not null default now()
);
create index if not exists shopify_app_shops_app on public.shopify_app_shops (app_id);

create table if not exists public.shopify_mode (
  id         boolean primary key default true check (id),
  internal   boolean not null default true,
  updated_at timestamptz not null default now()
);
insert into public.shopify_mode (id) values (true) on conflict (id) do nothing;

-- Nobody reads or writes these at the table: only the functions below.
do $$
declare t text;
begin
  foreach t in array array['shopify_apps', 'shopify_app_shops', 'shopify_mode'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on table public.%I from anon, authenticated', t);
    execute format('drop policy if exists %I on public.%I', t || '_oauth_no_insert', t);
    execute format('create policy %I on public.%I as restrictive for insert to authenticated with check (not public.abo_is_oauth_client())', t || '_oauth_no_insert', t);
    execute format('drop policy if exists %I on public.%I', t || '_oauth_no_update', t);
    execute format('create policy %I on public.%I as restrictive for update to authenticated using (not public.abo_is_oauth_client())', t || '_oauth_no_update', t);
    execute format('drop policy if exists %I on public.%I', t || '_oauth_no_delete', t);
    execute format('create policy %I on public.%I as restrictive for delete to authenticated using (not public.abo_is_oauth_client())', t || '_oauth_no_delete', t);
  end loop;
end $$;

-- ── Which secret a store's deliveries are signed with ────────

-- The store's own app's, when it has one; the main app's otherwise. A
-- store whose app is switched off has none, so nothing it sends is taken.
create or replace function public.abo_shopify_secret_for(p_shop text) returns text
language sql stable security definer set search_path = public, extensions as $$
  select case
           when a.id is null then (select value from public.app_secrets where name = 'shopify_client_secret')
           when a.enabled then (select ds.decrypted_secret from vault.decrypted_secrets ds
                                 where ds.name = 'shopify_app_secret:' || a.client_id)
           else null
         end
    from (select 1) one
    left join public.shopify_app_shops m on m.shop_domain = lower(btrim(coalesce(p_shop, '')))
    left join public.shopify_apps a on a.id = m.app_id;
$$;
revoke all on function public.abo_shopify_secret_for(text) from public, anon, authenticated;

-- A store's webhook address, under its own app's secret (0058's, per store).
create or replace function public.abo_shopify_webhook_token(p_shop text)
returns text
language sql stable security definer set search_path = public, extensions as $$
  select encode(extensions.hmac(lower(p_shop), public.abo_shopify_secret_for(p_shop), 'sha256'), 'hex')
$$;
revoke all on function public.abo_shopify_webhook_token(text) from public, anon, authenticated;

-- ── What the app server may read, with its own key ───────────

create or replace function public.abo_shopify_server_key_ok(p_key text) returns boolean
language sql stable security definer set search_path = public, extensions as $$
  select coalesce(length(p_key), 0) >= 32
     and exists (select 1 from public.app_secrets
                  where name = 'shopify_apps_key_sha256'
                    and value = encode(extensions.digest(p_key, 'sha256'), 'hex'));
$$;
revoke all on function public.abo_shopify_server_key_ok(text) from public, anon, authenticated;

-- The app a store comes through, when it has one of its own: its
-- secret only while it is switched on, so the server can tell a store
-- whose app is off from a store that has none.
create or replace function public.abo_shopify_app_for(p_shop text, p_key text)
returns table (client_id text, client_secret text, all_orders boolean, enabled boolean)
language sql stable security definer set search_path = public, extensions as $$
  select a.client_id,
         case when a.enabled then
           (select ds.decrypted_secret from vault.decrypted_secrets ds where ds.name = 'shopify_app_secret:' || a.client_id)
         end,
         a.all_orders,
         a.enabled
    from public.shopify_app_shops m
    join public.shopify_apps a on a.id = m.app_id
   where m.shop_domain = lower(btrim(coalesce(p_shop, '')))
     and public.abo_shopify_server_key_ok(p_key);
$$;

-- Every app switched on: a delivery is first checked against all of them,
-- then the database holds it to its own store's (abo_shopify_webhook).
create or replace function public.abo_shopify_app_secrets(p_key text)
returns table (client_id text, client_secret text)
language sql stable security definer set search_path = public, extensions as $$
  select a.client_id, ds.decrypted_secret
    from public.shopify_apps a
    join vault.decrypted_secrets ds on ds.name = 'shopify_app_secret:' || a.client_id
   where a.enabled and public.abo_shopify_server_key_ok(p_key);
$$;
revoke all on function public.abo_shopify_app_for(text, text) from public;
revoke all on function public.abo_shopify_app_secrets(text) from public;
grant execute on function public.abo_shopify_app_for(text, text) to anon, authenticated;
grant execute on function public.abo_shopify_app_secrets(text) to anon, authenticated;

-- ── What a merchant's screen may ask ─────────────────────────

create or replace function public.abo_shopify_internal() returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select internal from public.shopify_mode where id), true);
$$;
revoke all on function public.abo_shopify_internal() from public;
grant execute on function public.abo_shopify_internal() to anon, authenticated;

-- The client id of the app set up for the person asking, if there is one.
create or replace function public.abo_my_shopify_app() returns text
language sql stable security definer set search_path = public, auth as $$
  select a.client_id
    from public.shopify_apps a
   where a.enabled
     and a.owner_email is not null
     and auth.uid() is not null
     and lower(a.owner_email) = lower((select u.email from auth.users u where u.id = auth.uid()))
   order by a.created_at
   limit 1;
$$;
revoke all on function public.abo_my_shopify_app() from public, anon;
grant execute on function public.abo_my_shopify_app() to authenticated;

-- ── The administrator's ──────────────────────────────────────

create or replace function public.abo_admin_shopify_apps() returns jsonb
language plpgsql stable security definer set search_path = public, extensions as $$
begin
  if not public.abo_is_superadmin() then
    raise exception 'Not an administrator.' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'internal', public.abo_shopify_internal(),
    'server_key_set', exists (select 1 from public.app_secrets where name = 'shopify_apps_key_sha256'),
    'apps', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', a.id, 'label', a.label, 'client_id', a.client_id,
               'owner_email', a.owner_email, 'all_orders', a.all_orders, 'enabled', a.enabled,
               'secret_set_at', a.secret_set_at, 'created_at', a.created_at,
               'shops', coalesce((
                 select jsonb_agg(jsonb_build_object(
                          'shop', m.shop_domain,
                          'status', s.status,
                          'connected_at', s.connected_at,
                          'last_synced_at', s.last_synced_at,
                          'webhook_error', s.webhook_error,
                          'scopes', s.granted_scopes,
                          'project', p.name,
                          'owner', (select u.email from auth.users u where u.id = p.owner_id))
                          order by m.shop_domain)
                   from public.shopify_app_shops m
                   left join public.stores s on lower(s.shop_domain) = m.shop_domain and s.provider = 'shopify'
                   left join public.projects p on p.id = s.project_id
                  where m.app_id = a.id), '[]'::jsonb))
             order by a.created_at)
        from public.shopify_apps a), '[]'::jsonb));
end $$;

create or replace function public.abo_admin_shopify_app_save(
  p_id          uuid,
  p_label       text,
  p_client_id   text,
  p_secret      text,
  p_shops       text[],
  p_owner_email text,
  p_all_orders  boolean,
  p_enabled     boolean
) returns uuid
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_id     uuid := p_id;
  v_client text := lower(btrim(coalesce(p_client_id, '')));
  v_secret text := nullif(btrim(coalesce(p_secret, '')), '');
  v_email  text := nullif(lower(btrim(coalesce(p_owner_email, ''))), '');
  v_shops  text[];
  v_bad    text;
  v_taken  record;
  v_vault  uuid;
  v_was    text;
begin
  if not public.abo_is_superadmin() then
    raise exception 'Not an administrator.' using errcode = '42501';
  end if;
  if length(btrim(coalesce(p_label, ''))) = 0 then
    raise exception 'Give it a name, so you know whose it is.' using errcode = '22023';
  end if;
  if v_client !~ '^[0-9a-f]{32}$' then
    raise exception 'That client ID is not one: it is 32 letters and digits, from the app''s Settings in the Dev Dashboard.' using errcode = '22023';
  end if;
  if v_secret is not null and v_secret !~ '^shpss_[A-Za-z0-9]{16,}$' then
    raise exception 'That secret is not one: it starts with shpss_, from the same Settings page.' using errcode = '22023';
  end if;

  -- The stores, as Shopify names them: admin links and https:// taken off.
  select coalesce(array_agg(distinct s), '{}') into v_shops
    from (
      select lower(regexp_replace(regexp_replace(btrim(x), '^https?://', ''), '/.*$', '')) as s
        from unnest(coalesce(p_shops, '{}')) x
       where btrim(x) <> ''
    ) q;
  select s into v_bad from unnest(v_shops) s where s !~ '^[a-z0-9][a-z0-9-]*\.myshopify\.com$' limit 1;
  if v_bad is not null then
    raise exception '"%" is not a store''s Shopify address: it ends in .myshopify.com (Settings, Domains).', v_bad using errcode = '22023';
  end if;
  if cardinality(v_shops) = 0 then
    raise exception 'Name at least one store it is for.' using errcode = '22023';
  end if;
  select m.shop_domain, a.label into v_taken
    from public.shopify_app_shops m join public.shopify_apps a on a.id = m.app_id
   where m.shop_domain = any (v_shops) and (v_id is null or m.app_id <> v_id)
   limit 1;
  if v_taken.shop_domain is not null then
    raise exception '% already comes through "%". A store comes through one app.', v_taken.shop_domain, v_taken.label using errcode = '23505';
  end if;

  if v_id is null then
    if v_secret is null then
      raise exception 'A new app needs its secret.' using errcode = '22023';
    end if;
    if exists (select 1 from public.shopify_apps where client_id = v_client) then
      raise exception 'That app is already here.' using errcode = '23505';
    end if;
    insert into public.shopify_apps (label, client_id, owner_email, all_orders, enabled)
    values (btrim(p_label), v_client, v_email, coalesce(p_all_orders, false), coalesce(p_enabled, true))
    returning id into v_id;
  else
    select client_id into v_was from public.shopify_apps where id = v_id;
    if v_was is null then
      raise exception 'No such app.' using errcode = '22023';
    end if;
    if v_was <> v_client then
      raise exception 'An app keeps its client ID. For a different app, add it as a new one.' using errcode = '22023';
    end if;
    update public.shopify_apps
       set label = btrim(p_label), owner_email = v_email,
           all_orders = coalesce(p_all_orders, all_orders),
           enabled = coalesce(p_enabled, enabled), updated_at = now()
     where id = v_id;
  end if;

  if v_secret is not null then
    select id into v_vault from vault.secrets where name = 'shopify_app_secret:' || v_client;
    if v_vault is null then
      perform vault.create_secret(v_secret, 'shopify_app_secret:' || v_client, 'Shopify app secret: ' || btrim(p_label));
    else
      perform vault.update_secret(v_vault, v_secret);
    end if;
    update public.shopify_apps set secret_set_at = now() where id = v_id;
  end if;

  delete from public.shopify_app_shops where app_id = v_id and not (shop_domain = any (v_shops));
  insert into public.shopify_app_shops (shop_domain, app_id)
  select s, v_id from unnest(v_shops) s
  on conflict (shop_domain) do nothing;
  return v_id;
end $$;

create or replace function public.abo_admin_shopify_app_delete(p_id uuid) returns boolean
language plpgsql security definer set search_path = public, extensions as $$
declare v_client text; v_live text;
begin
  if not public.abo_is_superadmin() then
    raise exception 'Not an administrator.' using errcode = '42501';
  end if;
  select client_id into v_client from public.shopify_apps where id = p_id;
  if v_client is null then
    return false;
  end if;
  -- A store still connected through it would go quiet without a word.
  select s.shop_domain into v_live
    from public.shopify_app_shops m
    join public.stores s on lower(s.shop_domain) = m.shop_domain and s.provider = 'shopify'
   where m.app_id = p_id and s.status = 'connected'
   limit 1;
  if v_live is not null then
    raise exception '% is still connected through it. Switch the app off, or disconnect the store, first.', v_live using errcode = '23503';
  end if;
  delete from vault.secrets where name = 'shopify_app_secret:' || v_client;
  delete from public.shopify_apps where id = p_id;
  return true;
end $$;

create or replace function public.abo_admin_set_shopify_internal(p_on boolean) returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if not public.abo_is_superadmin() then
    raise exception 'Not an administrator.' using errcode = '42501';
  end if;
  update public.shopify_mode set internal = coalesce(p_on, true), updated_at = now() where id;
  return coalesce(p_on, true);
end $$;

revoke all on function public.abo_admin_shopify_apps() from public, anon;
revoke all on function public.abo_admin_shopify_app_save(uuid, text, text, text, text[], text, boolean, boolean) from public, anon;
revoke all on function public.abo_admin_shopify_app_delete(uuid) from public, anon;
revoke all on function public.abo_admin_set_shopify_internal(boolean) from public, anon;
grant execute on function public.abo_admin_shopify_apps() to authenticated;
grant execute on function public.abo_admin_shopify_app_save(uuid, text, text, text, text[], text, boolean, boolean) to authenticated;
grant execute on function public.abo_admin_shopify_app_delete(uuid) to authenticated;
grant execute on function public.abo_admin_set_shopify_internal(boolean) to authenticated;

-- ── The three checks, each with its store's own secret ───────
-- abo_shopify_webhook from 0105, abo_shopify_uninstalled from 0111,
-- abo_shopify_compliance from 0063: copied by a script, the one secret
-- swapped for the store's (abo_shopify_secret_for), nothing else changed.

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

create or replace function public.abo_shopify_uninstalled(
  p_token text,
  p_raw   text,
  p_hmac  text
) returns integer
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_secret text;
  v_store  uuid;
  v_shop   text;
begin
  if p_raw is null or p_hmac is null or p_token is null then
    raise exception 'Unsigned.' using errcode = '42501';
  end if;
  select s.id, s.shop_domain into v_store, v_shop
    from public.stores s
   where s.provider = 'shopify'
     and s.status <> 'pending'
     and public.abo_shopify_webhook_token(s.shop_domain) = p_token;
  if v_store is null then
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

  -- The token is dead the moment Shopify sends this; keeping it would
  -- only let something try it. Nothing is deleted.
  update public.stores
     set status                   = 'uninstalled',
         access_token             = null,
         refresh_token            = null,
         token_expires_at         = null,
         refresh_token_expires_at = null
   where id = v_store;
  -- A worker mid-import has nothing left to import with.
  delete from public.import_leases where store_id = v_store;
  return 1;
end $$;

create or replace function public.abo_shopify_compliance(
  p_topic text,
  p_raw   text,
  p_hmac  text
) returns integer
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_secret   text;
  v_body     jsonb;
  v_shop     text;
  v_customer text;
  v_email    text;
  v_store    uuid;
begin
  if p_raw is null or p_hmac is null or p_topic is null then
    raise exception 'Unsigned.' using errcode = '42501';
  end if;
  -- The shop is named inside the body, and its own app's secret proves
  -- the body (0150); a body naming another shop fails that shop's check.
  v_body := p_raw::jsonb;
  v_shop := v_body->>'shop_domain';
  v_secret := public.abo_shopify_secret_for(coalesce(v_shop, ''));
  if v_secret is null then
    raise exception 'Webhooks are not configured.' using errcode = '42501';
  end if;
  if encode(extensions.hmac(p_raw, v_secret, 'sha256'), 'base64') <> p_hmac then
    raise exception 'That did not come from Shopify.' using errcode = '42501';
  end if;
  -- Blank is missing. Only NULL counted before, so "id": "" skipped
  -- the email fallback and erased nobody.
  v_customer := nullif(btrim(coalesce(v_body#>>'{customer,id}', '')), '');
  v_email    := nullif(btrim(coalesce(v_body#>>'{customer,email}', '')), '');

  if v_shop is null or v_shop = '' then
    raise exception 'Unsigned.' using errcode = '42501';
  end if;

  if p_topic = 'customers/data_request' then
    if jsonb_typeof(v_body->'customer') is distinct from 'object'
       or not (v_body ? 'orders_requested')
       or v_body ? 'orders_to_redact' then
      raise exception 'Unsigned.' using errcode = '42501';
    end if;
    return case when public.abo_shopify_data_request(v_shop, v_customer, v_body) then 1 else 0 end;

  elsif p_topic = 'customers/redact' then
    if jsonb_typeof(v_body->'customer') is distinct from 'object'
       or not (v_body ? 'orders_to_redact')
       or v_body ? 'orders_requested' then
      raise exception 'Unsigned.' using errcode = '42501';
    end if;
    if v_customer is not null then
      return public.abo_shopify_customer_redact(v_shop, v_customer);
    end if;
    if v_email is not null then
      return public.abo_shopify_customer_redact_email(v_shop, v_email);
    end if;
    -- Neither. This used to raise, which the route turned into a 401 —
    -- a permanent refusal of a properly signed request. Shopify retries
    -- a handful of times over a few hours and then stops, so the
    -- request would simply be lost; and 401 belongs to a bad signature
    -- rather than to a body nothing can act on.
    --
    -- So it is written down where somebody can see it, and accepted.
    select id into v_store
      from public.stores
     where lower(shop_domain) = lower(v_shop)
       and provider = 'shopify'
       and status <> 'pending';
    if v_store is not null then
      insert into public.shopify_data_requests (store_id, customer_external_id, payload)
      values (v_store, null, v_body);
    end if;
    return 0;

  elsif p_topic = 'shop/redact' then
    if v_body ? 'customer'
       or v_body ? 'orders_requested'
       or v_body ? 'orders_to_redact' then
      raise exception 'Unsigned.' using errcode = '42501';
    end if;
    return public.abo_shopify_shop_redact(v_shop);
  end if;

  raise exception 'Unsigned.' using errcode = '42501';
end $$;

NOTIFY pgrst, 'reload schema';
