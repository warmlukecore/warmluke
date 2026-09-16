-- Migration 0064: the tombstone from 0063 could bury the wrong people.
--
-- 0063 stopped a redacted customer coming back. The way it recognised
-- them was too loose, and loose in the direction that deletes.
--
-- 1. A redaction by ID wrote the customer's email into the tombstone
--    as well. The trigger matches on EITHER field, so from then on any
--    other customer in that store sharing the address — a household,
--    a shop@ inbox, an address Shopify reissued years later — was
--    silently refused as well. The request named one person; the mark
--    it left named everybody who had ever used their email.
--
--    A tombstone now names a person ONE way. By ID when Shopify gave
--    an ID, by email only when it gave nothing else — which is the
--    whole of what we were told, and so the whole of what we can act
--    on. The constraint enforces exactly one.
--
-- 2. An empty string is not an email. `check (external_id is not null
--    or email is not null)` let '' through, and '' matched every
--    customer whose email was also blank. One redaction could have
--    emptied a column.
--
-- 3. The trigger could lose a write it never meant to stop: a
--    concurrent import that began before the redaction committed could
--    not see the tombstone, so its INSERT passed the check and landed
--    after the DELETE. The customer came back.
--
--    Both sides now take the same per-store advisory lock, so the
--    import waits for the redaction to commit and then sees it.
--
--    ponytail: one lock per store, not per customer. A redaction is
--    rare and an import holds it for its own transaction only; make it
--    per identity if two people ever import one store at once.
--
-- Callers: src/lib/shopify-import.ts (saveCustomers),
-- src/lib/shopify-bulk.ts, src/app/api/shopify/webhooks/compliance/route.ts.

-- Nothing has been redacted yet, so there is nothing to migrate; this
-- is here so the statement is safe on a database where something has.
delete from public.shopify_redactions
 where (external_id is null and (email is null or btrim(email) = ''))
    or (external_id is not null and email is not null);

alter table public.shopify_redactions
  drop constraint if exists shopify_redactions_names_somebody;

alter table public.shopify_redactions
  drop constraint if exists shopify_redactions_names_one_person;

alter table public.shopify_redactions
  add constraint shopify_redactions_names_one_person
  check (
    (external_id is not null and email is null)
    or (external_id is null and email is not null and btrim(email) <> '')
  );

comment on constraint shopify_redactions_names_one_person on public.shopify_redactions is
  'A mark names a person one way. Both fields would match everyone who shares either.';

-- The key both the redaction and the importer wait on.
create or replace function public.abo_customers_lock(p_store uuid)
returns void
language sql security definer set search_path = public as $$
  select pg_advisory_xact_lock(hashtext('shopify_customers:' || p_store::text));
$$;

revoke all on function public.abo_customers_lock(uuid) from public;

create or replace function public.abo_customer_is_redacted()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  -- Held until this transaction ends. A redaction in flight finishes
  -- first, and what follows sees its mark instead of stepping over it.
  perform public.abo_customers_lock(new.store_id);

  if exists (
    select 1 from public.shopify_redactions r
     where r.store_id = new.store_id
       and (
         -- Named by id: only that customer.
         (r.external_id is not null and r.external_id = new.external_id)
         -- Named by email alone: everyone in this store at that
         -- address, because the request gave us nothing narrower.
         or (r.external_id is null
             and new.email is not null and btrim(new.email) <> ''
             and lower(btrim(r.email)) = lower(btrim(new.email)))
       )
  ) then
    -- Skipped, not raised. An import of five hundred customers
    -- containing one erased person writes the other four hundred and
    -- ninety-nine.
    return null;
  end if;
  return new;
end $$;

drop trigger if exists trg_customers_not_redacted on public.customers;
create trigger trg_customers_not_redacted
  before insert or update on public.customers
  for each row execute function public.abo_customer_is_redacted();

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

  -- Everyone in this store at that address. Shopify named no id, so
  -- there is nothing narrower to act on, and leaving a match behind
  -- would be refusing the request.
  delete from public.customers
   where store_id = v_store
     and email is not null
     and btrim(email) <> ''
     and lower(btrim(email)) = lower(v_email);

  get diagnostics v_deleted = row_count;
  return v_deleted;
end $$;

revoke all on function public.abo_shopify_customer_redact_email(text, text) from public;

NOTIFY pgrst, 'reload schema';
