-- ═══════════════════════════════════════════════════════════════
-- Adaptive Business OS — database schema (prototype, single-tenant)
-- ═══════════════════════════════════════════════════════════════

-- 1. modules — every "app section" that exists
create table if not exists public.modules (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  nav_label text not null,
  icon text not null default 'table',
  route text not null unique,
  created_at timestamptz not null default now()
);

-- 2. records — generic business data storage
create table if not exists public.records (
  id uuid primary key default gen_random_uuid(),
  module_id uuid not null references public.modules(id) on delete cascade,
  data jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_records_module_id on public.records(module_id);

-- 3. ui_schemas — versioned layout/display config per module (append-only)
create table if not exists public.ui_schemas (
  id uuid primary key default gen_random_uuid(),
  module_id uuid not null references public.modules(id) on delete cascade,
  schema_json jsonb not null,
  version integer not null,
  created_by text not null default 'user' check (created_by in ('ai', 'user')),
  change_description text,
  created_at timestamptz not null default now(),
  unique(module_id, version)
);
create index if not exists idx_ui_schemas_module_version on public.ui_schemas(module_id, version desc);

-- ═══════════════════════════════════════════════════════════════
-- RLS — permissive for this prototype (single-tenant, no auth yet)
-- ═══════════════════════════════════════════════════════════════
alter table public.modules enable row level security;
alter table public.records enable row level security;
alter table public.ui_schemas enable row level security;

drop policy if exists "modules_all" on public.modules;
create policy "modules_all" on public.modules
  for all using (true) with check (true);

drop policy if exists "records_all" on public.records;
create policy "records_all" on public.records
  for all using (true) with check (true);

drop policy if exists "ui_schemas_all" on public.ui_schemas;
create policy "ui_schemas_all" on public.ui_schemas
  for all using (true) with check (true);

-- ═══════════════════════════════════════════════════════════════
-- SEED — Orders module + 15 dummy rows + default ui schema v1
-- ═══════════════════════════════════════════════════════════════
insert into public.modules (name, nav_label, icon, route)
values ('orders', 'Orders', 'shopping-cart', '/modules/orders')
on conflict (name) do nothing;

with m as (
  select id from public.modules where name = 'orders'
)
insert into public.records (module_id, data)
select m.id, v.data
from m, (values
  ('{"order_id":"ORD-1001","customer_name":"Acme Corp","amount":1250.00,"status":"Delivered","order_date":"2026-08-01"}'::jsonb),
  ('{"order_id":"ORD-1002","customer_name":"Bluewave Ltd","amount":89.99,"status":"Shipped","order_date":"2026-08-02"}'),
  ('{"order_id":"ORD-1003","customer_name":"Crestline Media","amount":430.50,"status":"Pending","order_date":"2026-08-03"}'),
  ('{"order_id":"ORD-1004","customer_name":"Dunmore Foods","amount":2210.75,"status":"Delivered","order_date":"2026-08-05"}'),
  ('{"order_id":"ORD-1005","customer_name":"Everly Interiors","amount":640.20,"status":"Shipped","order_date":"2026-08-07"}'),
  ('{"order_id":"ORD-1006","customer_name":"Fairmont Supply","amount":129.00,"status":"Pending","order_date":"2026-08-09"}'),
  ('{"order_id":"ORD-1007","customer_name":"Gale & Porter","amount":3450.00,"status":"Delivered","order_date":"2026-08-11"}'),
  ('{"order_id":"ORD-1008","customer_name":"Harbor Logistics","amount":780.40,"status":"Shipped","order_date":"2026-08-13"}'),
  ('{"order_id":"ORD-1009","customer_name":"Ironwood Timber","amount":156.25,"status":"Pending","order_date":"2026-08-15"}'),
  ('{"order_id":"ORD-1010","customer_name":"Juniper Labs","amount":980.00,"status":"Delivered","order_date":"2026-08-18"}'),
  ('{"order_id":"ORD-1011","customer_name":"Kestrel Sports","amount":45.90,"status":"Shipped","order_date":"2026-08-20"}'),
  ('{"order_id":"ORD-1012","customer_name":"Lumen Analytics","amount":5120.00,"status":"Pending","order_date":"2026-08-23"}'),
  ('{"order_id":"ORD-1013","customer_name":"Meridian Travel","amount":267.30,"status":"Delivered","order_date":"2026-08-26"}'),
  ('{"order_id":"ORD-1014","customer_name":"Northgate Retail","amount":1875.60,"status":"Shipped","order_date":"2026-08-29"}'),
  ('{"order_id":"ORD-1015","customer_name":"Orchid Beauty","amount":320.00,"status":"Pending","order_date":"2026-09-01"}')
) as v(data)
where not exists (
  select 1 from public.records r
  where r.module_id = m.id and r.data->>'order_id' = v.data->>'order_id'
);

with m as (
  select id from public.modules where name = 'orders'
)
insert into public.ui_schemas (module_id, schema_json, version, created_by, change_description)
select m.id,
  '{
    "columns": [
      { "field": "order_id",       "label": "Order ID",  "type": "text" },
      { "field": "customer_name",  "label": "Customer",  "type": "text" },
      { "field": "amount",         "label": "Amount",    "type": "currency" },
      { "field": "status",         "label": "Status",    "type": "badge" },
      { "field": "order_date",     "label": "Order Date","type": "date" }
    ]
  }'::jsonb,
  1, 'user', 'Initial Orders schema'
from m
where not exists (
  select 1 from public.ui_schemas s
  where s.module_id = m.id and s.version = 1
);
