-- Migration 0018: canonical commerce tables
--
-- Sections built by the assistant are deliberately different for every
-- owner — that is the point of them. Shopify's data is the opposite: the
-- same shape for everyone, and it has to be queryable by one dashboard
-- and one set of MCP tools rather than by whatever field names a model
-- happened to invent. So these tables are fixed, and they sit beside the
-- generated ones rather than replacing them.
--
-- Nine tables, not the nineteen a fuller commerce model wants. Order
-- addresses, locations, inventory snapshots and privacy requests are all
-- real, and all absent until something needs them: adding a table later
-- is cheap, starting from a shape that was guessed is not.

-- ── The store ───────────────────────────────────────────────────
-- Timezone is not a display preference here. "How many orders came in
-- yesterday" is a question about the shop's calendar day, and answering
-- it in UTC is quietly wrong for every store outside it — wrong by a few
-- orders, every single day, with nothing to notice.
create table if not exists public.stores (
  id             uuid primary key default gen_random_uuid(),
  project_id     uuid not null references public.projects(id) on delete cascade,
  provider       text not null default 'shopify',
  shop_domain    text not null,
  access_token   text,
  timezone       text not null default 'UTC',
  currency       text not null default 'INR',
  country        text,
  connected_at   timestamptz,
  last_synced_at timestamptz,
  -- How far back the owner chose to import. Analytics has to say "from
  -- March onwards" rather than imply it has everything.
  history_from   date,
  status         text not null default 'connected',
  created_at     timestamptz not null default now()
);
create unique index if not exists idx_stores_shop on public.stores(provider, shop_domain);
create index if not exists idx_stores_project on public.stores(project_id);

-- ── Import progress ─────────────────────────────────────────────
-- A serverless request dies at five minutes; an import of eighty
-- thousand customers does not fit in one. Each run records where it got
-- to, so the next invocation resumes instead of starting over.
create table if not exists public.import_runs (
  id           uuid primary key default gen_random_uuid(),
  store_id     uuid not null references public.stores(id) on delete cascade,
  resource     text not null,
  status       text not null default 'pending',
  cursor       text,
  imported     integer not null default 0,
  started_at   timestamptz not null default now(),
  finished_at  timestamptz,
  error        text
);
create index if not exists idx_import_store on public.import_runs(store_id, resource);

-- ── Catalogue ───────────────────────────────────────────────────
create table if not exists public.products (
  id           uuid primary key default gen_random_uuid(),
  store_id     uuid not null references public.stores(id) on delete cascade,
  external_id  text not null,
  title        text not null,
  handle       text,
  status       text,
  tags         text[] not null default '{}',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz
);
create unique index if not exists idx_products_external on public.products(store_id, external_id);

create table if not exists public.variants (
  id           uuid primary key default gen_random_uuid(),
  store_id     uuid not null references public.stores(id) on delete cascade,
  product_id   uuid references public.products(id) on delete cascade,
  external_id  text not null,
  title        text,
  sku          text,
  barcode      text,
  price        numeric(12,2),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz
);
create unique index if not exists idx_variants_external on public.variants(store_id, external_id);
create index if not exists idx_variants_sku on public.variants(store_id, sku);

create table if not exists public.inventory_levels (
  id            uuid primary key default gen_random_uuid(),
  store_id      uuid not null references public.stores(id) on delete cascade,
  variant_id    uuid references public.variants(id) on delete cascade,
  location_name text,
  available     integer not null default 0,
  updated_at    timestamptz
);
create unique index if not exists idx_inventory_unique
  on public.inventory_levels(store_id, variant_id, coalesce(location_name, ''));

-- ── People ──────────────────────────────────────────────────────
create table if not exists public.customers (
  id           uuid primary key default gen_random_uuid(),
  store_id     uuid not null references public.stores(id) on delete cascade,
  external_id  text not null,
  name         text,
  email        text,
  phone        text,
  city         text,
  postal_code  text,
  tags         text[] not null default '{}',
  orders_count integer not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz
);
create unique index if not exists idx_customers_external on public.customers(store_id, external_id);
create index if not exists idx_customers_phone on public.customers(store_id, phone);

-- ── Orders ──────────────────────────────────────────────────────
-- `source` separates what Shopify told us from what somebody uploaded by
-- hand. Older statuses arrive by CSV when an integration cannot supply
-- them, and an answer built on both should be able to say which is which.
create table if not exists public.orders (
  id                 uuid primary key default gen_random_uuid(),
  store_id           uuid not null references public.stores(id) on delete cascade,
  external_id        text not null,
  order_number       text,
  customer_id        uuid references public.customers(id) on delete set null,
  placed_at          timestamptz,
  total              numeric(12,2),
  currency           text,
  financial_status   text,
  fulfilment_status  text,
  cancelled_at       timestamptz,
  tags               text[] not null default '{}',
  source             text not null default 'shopify',
  created_at         timestamptz not null default now(),
  updated_at         timestamptz
);
create unique index if not exists idx_orders_external on public.orders(store_id, external_id);
create index if not exists idx_orders_placed on public.orders(store_id, placed_at desc);
create index if not exists idx_orders_customer on public.orders(customer_id);

-- Purchase-time title and SKU are copied, not looked up. A product
-- renamed or deleted next year must not silently rewrite what a customer
-- actually bought last month.
create table if not exists public.order_line_items (
  id           uuid primary key default gen_random_uuid(),
  store_id     uuid not null references public.stores(id) on delete cascade,
  order_id     uuid not null references public.orders(id) on delete cascade,
  external_id  text,
  product_id   uuid references public.products(id) on delete set null,
  variant_id   uuid references public.variants(id) on delete set null,
  title        text,
  variant_title text,
  sku          text,
  quantity     integer not null default 0,
  price        numeric(12,2),
  created_at   timestamptz not null default now()
);
create index if not exists idx_line_items_order on public.order_line_items(order_id);
create index if not exists idx_line_items_sku on public.order_line_items(store_id, sku);

-- Without refunds every sales figure is gross, and an owner reading
-- "net sales" would be reading something else entirely.
create table if not exists public.refunds (
  id          uuid primary key default gen_random_uuid(),
  store_id    uuid not null references public.stores(id) on delete cascade,
  order_id    uuid not null references public.orders(id) on delete cascade,
  external_id text,
  amount      numeric(12,2),
  quantity    integer not null default 0,
  refunded_at timestamptz,
  created_at  timestamptz not null default now()
);
create index if not exists idx_refunds_order on public.refunds(order_id);

-- ── Isolation ───────────────────────────────────────────────────
-- Commerce rows hang off a store, and a store hangs off a project, so
-- every policy below is the same question the rest of the schema already
-- asks — reached through one more join. Two helpers rather than that
-- join written out fourteen times: a predicate copied by hand is a
-- predicate that will one day be copied wrong.

create or replace function public.abo_store_owned(s uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.stores st
    where st.id = s and public.abo_owns(st.project_id)
  );
$$;

create or replace function public.abo_store_readable(s uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.stores st
    where st.id = s and public.abo_can_use(st.project_id)
  );
$$;

revoke all on function public.abo_store_owned(uuid) from public;
revoke all on function public.abo_store_readable(uuid) from public;
grant execute on function public.abo_store_owned(uuid) to authenticated;
grant execute on function public.abo_store_readable(uuid) to authenticated;

-- Connecting or disconnecting a store is the owner's decision; staff see
-- that one is connected and read what came out of it.
alter table public.stores enable row level security;
drop policy if exists "stores_owner_all" on public.stores;
create policy "stores_owner_all" on public.stores
  for all using (public.abo_owns(project_id)) with check (public.abo_owns(project_id));
drop policy if exists "stores_member_read" on public.stores;
create policy "stores_member_read" on public.stores
  for select using (public.abo_can_use(project_id));

do $$
declare t text;
begin
  foreach t in array array[
    'import_runs', 'products', 'variants', 'inventory_levels',
    'customers', 'orders', 'order_line_items', 'refunds'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "%s_owner_all" on public.%I', t, t);
    execute format(
      'create policy "%s_owner_all" on public.%I for all
         using (public.abo_store_owned(store_id))
         with check (public.abo_store_owned(store_id))', t, t);
    execute format('drop policy if exists "%s_member_read" on public.%I', t, t);
    execute format(
      'create policy "%s_member_read" on public.%I for select
         using (public.abo_store_readable(store_id))', t, t);
  end loop;
end $$;

NOTIFY pgrst, 'reload schema';
