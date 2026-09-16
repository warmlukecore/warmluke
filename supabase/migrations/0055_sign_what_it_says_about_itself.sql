-- Migration 0055: sign what the webhook says about itself.
--
-- Shopify signs the body. Which shop sent it and what happened travel
-- in headers, and those reached the database as ordinary arguments —
-- on a function the public anon key may call. So a merchant who
-- captured one of their own signed deliveries could post it back with
-- a different shop and have their product written into somebody
-- else's store. Nothing in the signature disagreed, because the
-- signature had never covered that part.
--
-- The route reads the headers and signs topic, shop and body together
-- with the same app secret it already holds. Shopify's own signature
-- is still checked; this is the second half, and it says who is
-- calling rather than what they carried.
--
-- And a resource gets one run per store. import_runs had a plain
-- index, so two tabs importing at once could write two rows for the
-- same resource and step on each other's cursor.
--
-- ponytail: the unique row stops the duplicate, not the race. Two
-- callers can still read the same cursor and both advance it; every
-- write is an upsert so nothing is lost, but work is repeated. Add a
-- claim with a lease when two people really do import at once.
--
-- Callers: src/app/api/shopify/webhooks/route.ts.

-- Whatever duplicates the missing constraint already allowed go
-- first. Creating the index over them would abort this migration —
-- and everything below it, including the webhook gate — on exactly the
-- database that most needs the fix.
-- Both inside one statement, so the lock taken before the delete is
-- still held when the index is built. Apart, an import may insert a
-- fresh duplicate in the gap between them and the index creation
-- fails; or update a row the delete is about to take away.
do $$
begin
  -- Writers wait; readers do not. CREATE INDEX would take SHARE by
  -- itself, but only after the delete had already let go.
  lock table public.import_runs in share row exclusive mode;

  delete from public.import_runs a
   using public.import_runs b
   where a.store_id = b.store_id
     and a.resource = b.resource
     -- What the row says about itself comes first: a resource already
     -- walked beats one mid-walk, which beats one that gave up. Ties
     -- go to the one that got furthest, then to the one still holding
     -- a cursor. The uuid only decides what nothing else could, and
     -- means nothing on its own.
     and (
       case a.status when 'done' then 4 when 'running' then 3 when 'pending' then 2 else 1 end,
       coalesce(a.imported, 0),
       (a.cursor is not null)::int,
       a.id
     ) < (
       case b.status when 'done' then 4 when 'running' then 3 when 'pending' then 2 else 1 end,
       coalesce(b.imported, 0),
       (b.cursor is not null)::int,
       b.id
     );

  execute 'create unique index if not exists idx_import_run_unique
             on public.import_runs(store_id, resource)';
end $$;

drop function if exists public.abo_shopify_webhook(text, text, text, text);

create or replace function public.abo_shopify_webhook(
  p_topic text,
  p_shop  text,
  p_raw   text,
  p_hmac  text,
  p_sig   text
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
  if p_raw is null or p_hmac is null then
    raise exception 'Unsigned.' using errcode = '42501';
  end if;
  if encode(extensions.hmac(p_raw, v_secret, 'sha256'), 'base64') <> p_hmac then
    raise exception 'That did not come from Shopify.' using errcode = '42501';
  end if;

  -- And the topic and shop are signed too.
  --
  -- Shopify signs the body and nothing else; which store it came from
  -- and what happened travel in headers. Those arrived here as plain
  -- arguments, and this function is reachable with the public anon
  -- key — so a merchant who captured one of their own signed
  -- deliveries could send it back naming somebody else's shop, and we
  -- would write their product into another merchant's store.
  --
  -- The route reads the headers and signs all three with the same app
  -- secret. Anyone holding a captured body still cannot say where it
  -- came from.
  if p_sig is null
     or encode(
          extensions.hmac(p_topic || E'\n' || p_shop || E'\n' || p_raw, v_secret, 'sha256'),
          'base64'
        ) <> p_sig then
    raise exception 'Unsigned.' using errcode = '42501';
  end if;

  v_body := p_raw::jsonb;
  -- The compliance topics name the shop in the body; the rest rely on
  -- the header, which the route passes through.
  v_shop := coalesce(nullif(p_shop, ''), v_body->>'shop_domain');

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
  elsif p_topic = 'customers/data_request' then
    return public.abo_shopify_data_request(v_shop, v_body#>>'{customer,id}', v_body);
  elsif p_topic = 'customers/redact' then
    return public.abo_shopify_customer_redact(v_shop, v_body#>>'{customer,id}');
  elsif p_topic = 'shop/redact' then
    return public.abo_shopify_shop_redact(v_shop);
  end if;

  -- Signed, so it really is Shopify — just a topic nobody asked for.
  return 0;
end $$;

revoke all on function public.abo_shopify_webhook(text, text, text, text, text) from public;
grant execute on function public.abo_shopify_webhook(text, text, text, text, text) to anon, authenticated;

NOTIFY pgrst, 'reload schema';
