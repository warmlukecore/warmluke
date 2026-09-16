-- Migration 0063: a redaction the next import undid.
--
-- 0062 made customers/redact actually delete. It did not stop the row
-- coming straight back: the importer walks Shopify again and upserts
-- every customer it finds, and Shopify keeps sending the person we
-- were told to forget. So the deletion held until the next sync, which
-- is the same as not holding.
--
-- A deletion therefore leaves a mark, and the mark is checked where
-- every writer passes — a trigger on the table. The importer writes
-- rows directly, the webhook goes through a function, the bulk reader
-- through another; a guard in any one of them would be a guard in one
-- of three.
--
-- Also from the same review:
--
--   * a blank customer id ("" rather than absent) skipped the email
--     fallback, because only NULL was treated as missing;
--   * the email comparison trimmed the incoming address and not the
--     stored one, so a stored " a@b.com " never matched;
--   * and nothing indexed the column that erasure now searches by.
--
-- Callers: src/lib/shopify-import.ts (saveCustomers),
-- src/app/api/shopify/webhooks/compliance/route.ts.

create table if not exists public.shopify_redactions (
  id          uuid primary key default gen_random_uuid(),
  store_id    uuid not null references public.stores(id) on delete cascade,
  external_id text,
  email       text,
  redacted_at timestamptz not null default now(),
  constraint shopify_redactions_names_somebody
    check (external_id is not null or email is not null)
);

comment on table public.shopify_redactions is
  'Customers Shopify asked us to forget. Checked on every write to customers, so a later import cannot bring them back.';

alter table public.shopify_redactions enable row level security;
-- No policy: nothing reaches this table except security-definer
-- functions and the trigger below. It is a list of people who asked to
-- disappear; it is not something a client reads.

create index if not exists idx_redactions_ext
  on public.shopify_redactions(store_id, external_id) where external_id is not null;
create index if not exists idx_redactions_email
  on public.shopify_redactions(store_id, lower(btrim(email))) where email is not null;

-- What erasure now searches by.
create index if not exists idx_customers_email
  on public.customers(store_id, lower(btrim(email))) where email is not null;

create or replace function public.abo_customer_is_redacted()
returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if exists (
    select 1 from public.shopify_redactions r
     where r.store_id = new.store_id
       and (
         (r.external_id is not null and r.external_id = new.external_id)
         or (r.email is not null and new.email is not null
             and lower(btrim(r.email)) = lower(btrim(new.email)))
       )
  ) then
    -- Skipped, not raised. An import that brings back five hundred
    -- customers, one of whom was erased, should write the other four
    -- hundred and ninety-nine rather than fail.
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

  -- The mark goes down first: the other way round, an import landing
  -- between the two would restore the row just removed.
  insert into public.shopify_redactions (store_id, external_id, email)
  select v_store, v_ext, c.email
    from public.customers c
   where c.store_id = v_store and c.external_id = v_ext
  union all
  select v_store, v_ext, null
   where not exists (
     select 1 from public.customers c
      where c.store_id = v_store and c.external_id = v_ext
   );

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
declare v_store uuid; v_deleted integer;
begin
  if p_email is null or btrim(p_email) = '' then return 0; end if;

  select id into v_store
    from public.stores
   where lower(shop_domain) = lower(p_shop)
     and provider = 'shopify'
     and status <> 'pending';
  if v_store is null then return 0; end if;

  insert into public.shopify_redactions (store_id, email)
  values (v_store, btrim(p_email));

  -- Both sides trimmed. Only the incoming address was, so a stored
  -- address with a stray space survived its own erasure.
  delete from public.customers
   where store_id = v_store
     and lower(btrim(email)) = lower(btrim(p_email));

  get diagnostics v_deleted = row_count;
  return v_deleted;
end $$;

revoke all on function public.abo_shopify_customer_redact_email(text, text) from public;

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
  select value into v_secret from public.app_secrets where name = 'shopify_client_secret';
  if v_secret is null then
    raise exception 'Webhooks are not configured.' using errcode = '42501';
  end if;
  if p_raw is null or p_hmac is null or p_topic is null then
    raise exception 'Unsigned.' using errcode = '42501';
  end if;
  if encode(extensions.hmac(p_raw, v_secret, 'sha256'), 'base64') <> p_hmac then
    raise exception 'That did not come from Shopify.' using errcode = '42501';
  end if;

  v_body := p_raw::jsonb;
  v_shop := v_body->>'shop_domain';
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

revoke all on function public.abo_shopify_compliance(text, text, text) from public;
grant execute on function public.abo_shopify_compliance(text, text, text) to anon, authenticated;

NOTIFY pgrst, 'reload schema';
