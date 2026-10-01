-- Migration 0156: a store's owner sets up their own app
--
-- 0150 let an administrator put a store on an app of its own. Now the
-- merchant can: in onboarding they create the app in Shopify's Dev
-- Dashboard, paste its client ID and secret, and connect through it.
--
-- So a shop can be claimed by more than one app. Anybody may claim any
-- shop, and nothing is taken from anybody by it: a claim only says which
-- app *this* person's connection goes through. The one a shop actually
-- came through — proven by Shopify itself completing the install — is
-- marked verified, one per shop, and that is the app its deliveries and
-- its token renewals use. A connection through someone else's app is
-- refused at the callback: the app has to be the store owner's own, or
-- one an administrator assigned.
--
--   whose connection goes through which app     abo_my_shopify_app_for
--   which app signed what Shopify sent          abo_shopify_apps_for
--   whether that app may connect this store     abo_shopify_claim_ok
--   what a shop came through                    abo_shopify_came_through

-- ── Whose app it is ─────────────────────────────────────────
-- An administrator's app is for an email (0150); a merchant's is theirs.
alter table public.shopify_apps add column if not exists owner_id uuid references auth.users (id) on delete cascade;
create index if not exists shopify_apps_owner on public.shopify_apps (owner_id) where owner_id is not null;

-- A secret goes with its app, however the app goes: deleted here, or with
-- its owner's account.
create or replace function public.abo_shopify_app_gone() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  delete from vault.secrets where name = 'shopify_app_secret:' || old.client_id;
  return old;
end $$;
revoke all on function public.abo_shopify_app_gone() from public, anon, authenticated;
drop trigger if exists shopify_app_gone on public.shopify_apps;
create trigger shopify_app_gone after delete on public.shopify_apps
  for each row execute function public.abo_shopify_app_gone();

-- ── A shop may be claimed by several apps, and came through one ──
alter table public.shopify_app_shops add column if not exists verified_at timestamptz;
alter table public.shopify_app_shops drop constraint if exists shopify_app_shops_pkey;
alter table public.shopify_app_shops add primary key (app_id, shop_domain);
create index if not exists shopify_app_shops_shop on public.shopify_app_shops (shop_domain);
create unique index if not exists shopify_app_shops_one_verified on public.shopify_app_shops (shop_domain)
  where verified_at is not null;
-- A store already connected through its assigned app came through it.
update public.shopify_app_shops m
   set verified_at = coalesce(s.connected_at, now())
  from public.stores s
 where lower(s.shop_domain) = m.shop_domain and s.status = 'connected' and m.verified_at is null;

-- The app a shop's deliveries and renewals belong to: the one it came
-- through, or else one an administrator assigned it; none for the main.
create or replace function public.abo_shopify_app_of(p_shop text) returns uuid
language sql stable security definer set search_path = public as $$
  select m.app_id
    from public.shopify_app_shops m
    join public.shopify_apps a on a.id = m.app_id
   where m.shop_domain = lower(btrim(coalesce(p_shop, '')))
     and (m.verified_at is not null or a.owner_id is null)
   order by (m.verified_at is not null) desc, a.created_at
   limit 1
$$;
revoke all on function public.abo_shopify_app_of(text) from public, anon, authenticated;

-- 0150's two, through the one rule above.
create or replace function public.abo_shopify_secret_for(p_shop text) returns text
language sql stable security definer set search_path = public, extensions as $$
  select case
           when a.id is null then (select value from public.app_secrets where name = 'shopify_client_secret')
           when a.enabled then (select ds.decrypted_secret from vault.decrypted_secrets ds
                                 where ds.name = 'shopify_app_secret:' || a.client_id)
           else null
         end
    from (select 1) one
    left join public.shopify_apps a on a.id = public.abo_shopify_app_of(p_shop);
$$;
revoke all on function public.abo_shopify_secret_for(text) from public, anon, authenticated;

create or replace function public.abo_shopify_app_for(p_shop text, p_key text)
returns table (client_id text, client_secret text, all_orders boolean, enabled boolean)
language sql stable security definer set search_path = public, extensions as $$
  select a.client_id,
         case when a.enabled then
           (select ds.decrypted_secret from vault.decrypted_secrets ds where ds.name = 'shopify_app_secret:' || a.client_id)
         end,
         a.all_orders,
         a.enabled
    from public.shopify_apps a
   where a.id = public.abo_shopify_app_of(p_shop)
     and public.abo_shopify_server_key_ok(p_key);
$$;
revoke all on function public.abo_shopify_app_for(text, text) from public;
grant execute on function public.abo_shopify_app_for(text, text) to anon, authenticated;

-- Every app claiming a shop that is switched on, with its secret: what
-- Shopify sends back about a shop is signed by one of them (or by the
-- main app), and the signature says which.
create or replace function public.abo_shopify_apps_for(p_shop text, p_key text)
returns table (client_id text, client_secret text, all_orders boolean)
language sql stable security definer set search_path = public, extensions as $$
  select a.client_id, ds.decrypted_secret, a.all_orders
    from public.shopify_app_shops m
    join public.shopify_apps a on a.id = m.app_id
    join vault.decrypted_secrets ds on ds.name = 'shopify_app_secret:' || a.client_id
   where m.shop_domain = lower(btrim(coalesce(p_shop, '')))
     and a.enabled
     and public.abo_shopify_server_key_ok(p_key)
   order by (m.verified_at is not null) desc, (a.owner_id is null) desc, a.created_at;
$$;
revoke all on function public.abo_shopify_apps_for(text, text) from public;
grant execute on function public.abo_shopify_apps_for(text, text) to anon, authenticated;

-- Whether the app that signed a callback may connect the store it names:
-- the main app (no client id), an app an administrator assigned the
-- shop, or the store owner's own app claiming it. Someone else's app,
-- though it claims the shop, is refused before any token is taken.
create or replace function public.abo_shopify_claim_ok(p_shop text, p_client_id text, p_state text, p_key text)
returns boolean
language sql stable security definer set search_path = public as $$
  select public.abo_shopify_server_key_ok(p_key) and (
    p_client_id is null
    or exists (
      select 1
        from public.shopify_app_shops m
        join public.shopify_apps a on a.id = m.app_id
       where m.shop_domain = lower(btrim(coalesce(p_shop, '')))
         and a.client_id = lower(btrim(p_client_id))
         and a.enabled
         and (
           a.owner_id is null
           or a.owner_id = (
             select p.owner_id
               from public.stores s
               join public.projects p on p.id = s.project_id
              where s.oauth_state = p_state
                and lower(s.shop_domain) = lower(btrim(coalesce(p_shop, '')))
              limit 1
           )
         )
    )
  );
$$;
revoke all on function public.abo_shopify_claim_ok(text, text, text, text) from public;
grant execute on function public.abo_shopify_claim_ok(text, text, text, text) to anon, authenticated;

-- A shop came through this app (or the main one, no client id): it is
-- the one verified, and no other.
create or replace function public.abo_shopify_came_through(p_shop text, p_client_id text, p_key text)
returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_shop text := lower(btrim(coalesce(p_shop, '')));
  v_app  uuid;
begin
  if not public.abo_shopify_server_key_ok(p_key) then
    return false;
  end if;
  select id into v_app from public.shopify_apps where client_id = lower(btrim(coalesce(p_client_id, '')));
  update public.shopify_app_shops set verified_at = null
   where shop_domain = v_shop and verified_at is not null and app_id is distinct from v_app;
  if v_app is not null then
    update public.shopify_app_shops set verified_at = now() where shop_domain = v_shop and app_id = v_app;
  end if;
  return true;
end $$;
revoke all on function public.abo_shopify_came_through(text, text, text) from public;
grant execute on function public.abo_shopify_came_through(text, text, text) to anon, authenticated;

-- ── What a merchant's screen may ask ─────────────────────────

-- 0150's, with the merchant's own apps beside an administrator's.
create or replace function public.abo_my_shopify_app() returns text
language sql stable security definer set search_path = public, auth as $$
  select a.client_id
    from public.shopify_apps a
   where a.enabled
     and auth.uid() is not null
     and (
       a.owner_id = auth.uid()
       or (a.owner_email is not null
           and lower(a.owner_email) = lower((select u.email from auth.users u where u.id = auth.uid())))
     )
   order by a.created_at
   limit 1;
$$;
revoke all on function public.abo_my_shopify_app() from public, anon;
grant execute on function public.abo_my_shopify_app() to authenticated;

-- The app this person's connection of this shop goes through: their own
-- claim on it, else one an administrator assigned the shop. No secret:
-- the install only needs to name the app.
create or replace function public.abo_my_shopify_app_for(p_shop text)
returns table (client_id text, all_orders boolean, enabled boolean)
language sql stable security definer set search_path = public as $$
  select a.client_id, a.all_orders, a.enabled
    from public.shopify_app_shops m
    join public.shopify_apps a on a.id = m.app_id
   where m.shop_domain = lower(btrim(coalesce(p_shop, '')))
     and auth.uid() is not null
     and (a.owner_id = auth.uid() or a.owner_id is null)
   order by (a.owner_id is not null) desc, (m.verified_at is not null) desc, a.created_at desc
   limit 1
$$;
revoke all on function public.abo_my_shopify_app_for(text) from public, anon;
grant execute on function public.abo_my_shopify_app_for(text) to authenticated;

-- Their apps, and an administrator's set up for them: never a secret.
create or replace function public.abo_my_shopify_apps() returns jsonb
language sql stable security definer set search_path = public, auth as $$
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', a.id, 'client_id', a.client_id, 'all_orders', a.all_orders, 'enabled', a.enabled,
           'secret_set_at', a.secret_set_at, 'mine', a.owner_id = auth.uid(),
           'shops', coalesce((
             select jsonb_agg(jsonb_build_object(
                      'shop', m.shop_domain,
                      'verified', m.verified_at is not null,
                      'connected', exists (select 1 from public.stores s
                                            where lower(s.shop_domain) = m.shop_domain and s.status = 'connected'))
                      order by m.shop_domain)
               from public.shopify_app_shops m where m.app_id = a.id), '[]'::jsonb))
           order by a.created_at), '[]'::jsonb)
    from public.shopify_apps a
   where auth.uid() is not null
     and (
       a.owner_id = auth.uid()
       or (a.owner_email is not null
           and lower(a.owner_email) = lower((select u.email from auth.users u where u.id = auth.uid())))
     );
$$;
revoke all on function public.abo_my_shopify_apps() from public, anon;
grant execute on function public.abo_my_shopify_apps() to authenticated;

-- A merchant saving their own app, and the store it is for. The secret
-- is written to the vault and never read back to anyone's screen.
create or replace function public.abo_my_shopify_app_save(
  p_client_id  text,
  p_secret     text,
  p_shop       text,
  p_all_orders boolean
) returns jsonb
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_uid    uuid := auth.uid();
  v_client text := lower(btrim(coalesce(p_client_id, '')));
  v_secret text := nullif(btrim(coalesce(p_secret, '')), '');
  v_shop   text := lower(regexp_replace(regexp_replace(btrim(coalesce(p_shop, '')), '^https?://', ''), '/.*$', ''));
  v_app    public.shopify_apps;
  v_other  uuid;
  v_vault  uuid;
begin
  if v_uid is null then
    raise exception 'sign in first' using errcode = '42501';
  end if;
  if public.abo_is_oauth_client() then
    raise exception 'Set this up in Warmluke itself.' using errcode = '42501';
  end if;
  if v_shop !~ '^[a-z0-9][a-z0-9-]*\.myshopify\.com$' then
    raise exception '"%" is not a store''s Shopify address: it ends in .myshopify.com (Settings, Domains).', v_shop
      using errcode = '22023';
  end if;
  if v_client !~ '^[0-9a-f]{32}$' then
    raise exception 'That client ID is not one: it is 32 letters and digits, from the app''s Settings in the Dev Dashboard.'
      using errcode = '22023';
  end if;
  if v_secret is not null and v_secret !~ '^shpss_[A-Za-z0-9]{16,}$' then
    raise exception 'That secret is not one: it starts with shpss_, from the same Settings page.' using errcode = '22023';
  end if;
  -- A store connected to somebody else's account is theirs to connect.
  select p.owner_id into v_other
    from public.stores s join public.projects p on p.id = s.project_id
   where lower(s.shop_domain) = v_shop and s.status <> 'pending'
   limit 1;
  if v_other is not null and v_other <> v_uid then
    raise exception 'That store is connected to another Warmluke account.' using errcode = '23505';
  end if;

  select * into v_app from public.shopify_apps where client_id = v_client;
  if found then
    if v_app.owner_id is distinct from v_uid then
      raise exception 'That app is already set up in Warmluke for another account.' using errcode = '23505';
    end if;
    update public.shopify_apps
       set all_orders = coalesce(p_all_orders, all_orders), updated_at = now()
     where id = v_app.id;
  else
    if v_secret is null then
      raise exception 'Paste the app''s client secret too.' using errcode = '22023';
    end if;
    if (select count(*) from public.shopify_apps where owner_id = v_uid) >= 20 then
      raise exception 'Twenty apps at most on one account.' using errcode = '22023';
    end if;
    insert into public.shopify_apps (label, client_id, owner_id, all_orders, enabled)
    values (left(v_shop, 80), v_client, v_uid, coalesce(p_all_orders, false), true)
    returning * into v_app;
  end if;

  if v_secret is not null then
    select id into v_vault from vault.secrets where name = 'shopify_app_secret:' || v_client;
    if v_vault is null then
      perform vault.create_secret(v_secret, 'shopify_app_secret:' || v_client, 'Shopify app secret: ' || v_shop);
    else
      perform vault.update_secret(v_vault, v_secret);
    end if;
    update public.shopify_apps set secret_set_at = now() where id = v_app.id;
  end if;

  insert into public.shopify_app_shops (app_id, shop_domain) values (v_app.id, v_shop)
  on conflict (app_id, shop_domain) do nothing;
  return jsonb_build_object('id', v_app.id, 'client_id', v_client, 'shop', v_shop);
end $$;
revoke all on function public.abo_my_shopify_app_save(text, text, text, boolean) from public, anon;
grant execute on function public.abo_my_shopify_app_save(text, text, text, boolean) to authenticated;

-- A merchant taking their own app away: not while a store is connected
-- through it, which would go quiet without a word.
create or replace function public.abo_my_shopify_app_delete(p_id uuid) returns boolean
language plpgsql security definer set search_path = public as $$
declare v_live text;
begin
  if auth.uid() is null then
    raise exception 'sign in first' using errcode = '42501';
  end if;
  if not exists (select 1 from public.shopify_apps where id = p_id and owner_id = auth.uid()) then
    return false;
  end if;
  select s.shop_domain into v_live
    from public.shopify_app_shops m
    join public.stores s on lower(s.shop_domain) = m.shop_domain and s.provider = 'shopify'
   where m.app_id = p_id and m.verified_at is not null and s.status = 'connected'
   limit 1;
  if v_live is not null then
    raise exception '% is still connected through it. Disconnect the store first.', v_live using errcode = '23503';
  end if;
  delete from public.shopify_apps where id = p_id;
  return true;
end $$;
revoke all on function public.abo_my_shopify_app_delete(uuid) from public, anon;
grant execute on function public.abo_my_shopify_app_delete(uuid) to authenticated;

-- ── The administrator's, knowing a merchant's apps ───────────
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
               'owner_email', coalesce(a.owner_email, (select u.email from auth.users u where u.id = a.owner_id)),
               'self_serve', a.owner_id is not null,
               'all_orders', a.all_orders, 'enabled', a.enabled,
               'secret_set_at', a.secret_set_at, 'created_at', a.created_at,
               'shops', coalesce((
                 select jsonb_agg(jsonb_build_object(
                          'shop', m.shop_domain,
                          'verified', m.verified_at is not null,
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

-- 0150's save, where a shop is "taken" only by another administrator's
-- app or by the app it actually came through: a merchant's claim that
-- never connected takes nothing from anybody.
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
   where m.shop_domain = any (v_shops)
     and (v_id is null or m.app_id <> v_id)
     and (a.owner_id is null or m.verified_at is not null)
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
  on conflict (app_id, shop_domain) do nothing;
  return v_id;
end $$;

-- 0150's delete, holding to what a store came through.
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
  select s.shop_domain into v_live
    from public.shopify_app_shops m
    join public.stores s on lower(s.shop_domain) = m.shop_domain and s.provider = 'shopify'
   where m.app_id = p_id and s.status = 'connected'
     and (m.verified_at is not null or not exists (
           select 1 from public.shopify_app_shops o where o.shop_domain = m.shop_domain and o.verified_at is not null))
   limit 1;
  if v_live is not null then
    raise exception '% is still connected through it. Switch the app off, or disconnect the store, first.', v_live using errcode = '23503';
  end if;
  delete from public.shopify_apps where id = p_id;
  return true;
end $$;

NOTIFY pgrst, 'reload schema';
