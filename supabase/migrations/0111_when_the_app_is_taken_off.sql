-- When the app is taken off a store.
--
-- Nothing listened for it. A merchant who removed Warmluke in Shopify
-- left a store here marked connected, holding a token Shopify had
-- already revoked: every import failed, every page said "connected",
-- and nothing anywhere said why. app/uninstalled now marks the store
-- for what it is and lets go of the dead token. The rows stay — the
-- merchant may simply be reinstalling — until Shopify's shop/redact,
-- forty-eight hours later, says to erase them.
--
-- And that erasure had its own hole. Shopify documents when shop/redact
-- is sent — forty-eight hours after an uninstall — and not whether a
-- reinstall inside those hours cancels it. A merchant who removed the
-- app and put it straight back would, if it is not cancelled, have
-- their freshly connected store erased two days later by a message
-- about the old one. So the erasure spares a store connected within
-- that window: it cannot be the store the message is about.

/**
 * Shopify says the app was removed from this store. Verified the way
 * every webhook is — the body's signature, and the per-store address
 * it arrived at — because the anon key is public and so is PostgREST.
 */
create or replace function public.abo_shopify_uninstalled(
  p_token text,
  p_raw   text,
  p_hmac  text
) returns integer
language plpgsql security definer set search_path = public, extensions as $$
declare
  v_secret text;
  v_store  uuid;
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

  select s.id into v_store
    from public.stores s
   where s.provider = 'shopify'
     and s.status <> 'pending'
     and encode(extensions.hmac(lower(s.shop_domain), v_secret, 'sha256'), 'hex') = p_token;
  if v_store is null then
    raise exception 'Unsigned.' using errcode = '42501';
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

revoke all on function public.abo_shopify_uninstalled(text, text, text) from public;
grant execute on function public.abo_shopify_uninstalled(text, text, text) to anon, authenticated;

/**
 * Erasing a shop's data, as shop/redact asks — except a store that was
 * connected inside the last forty-eight hours, which was connected
 * after the uninstall the message is about and is not what it means.
 */
create or replace function public.abo_shopify_shop_redact(p_shop text)
returns integer
language plpgsql security definer set search_path = public as $$
declare v_deleted integer;
begin
  delete from public.stores
   where lower(shop_domain) = lower(p_shop)
     and provider = 'shopify'
     and status <> 'pending'
     and not (status = 'connected' and connected_at > now() - interval '48 hours');
  get diagnostics v_deleted = row_count;
  return v_deleted;
end $$;

-- As 0037 left it: reached only through the compliance dispatcher.
revoke all on function public.abo_shopify_shop_redact(text) from public, anon, authenticated;

NOTIFY pgrst, 'reload schema';
