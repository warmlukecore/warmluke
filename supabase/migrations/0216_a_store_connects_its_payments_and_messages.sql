-- Migration 0216: payments, messages, and two more of the accounts a store runs on
-- (docs/integrations/connectors.md, phase 8)
--
--   klaviyo    → email_campaigns (0215)   each send, opens, clicks, revenue credited
--   whatsapp   → message_stats            each template's sends, deliveries, reads, clicks, by day
--   razorpay   → gateway_payments         each online payment, on the Shopify order it paid for
--                gateway_settlements      what reached the bank, and when
--   delhivery  → courier_shipments (0204) its shipments, tracked by the AWBs on the store's own fulfilments
--
-- As 0215: each list is written only by a connection whose provider
-- brings it (abo_connector_holding, now knowing these), read by anyone
-- who may read the store. Delhivery has no list of a client's shipments,
-- so its sync is handed the store's own Delhivery AWBs to ask after
-- (abo_connector_carrier_awbs).

alter table public.store_connections drop constraint if exists store_connections_provider_check;
alter table public.store_connections add constraint store_connections_provider_check
  check (provider in ('shiprocket', 'goswift', 'meta_ads', 'google_ads', 'google_analytics',
                      'mailchimp', 'brevo', 'zendesk', 'hubspot', 'meta_social',
                      'klaviyo', 'whatsapp', 'razorpay', 'delhivery'));

-- ── The lists ─────────────────────────────────────────────────
create table if not exists public.message_stats (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references public.projects(id) on delete cascade,
  store_id      uuid not null references public.stores(id) on delete cascade,
  connection_id uuid not null references public.store_connections(id) on delete cascade,
  provider      text not null,
  template_ref  text not null,
  template_name text,
  category      text,
  language      text,
  day           date not null,
  sent          bigint,
  delivered     bigint,
  read          bigint,
  clicked       bigint,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (connection_id, template_ref, day)
);
create index if not exists message_stats_store_day on public.message_stats (store_id, day desc);

create table if not exists public.gateway_payments (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references public.projects(id) on delete cascade,
  store_id      uuid not null references public.stores(id) on delete cascade,
  connection_id uuid not null references public.store_connections(id) on delete cascade,
  provider      text not null,
  payment_ref   text not null,
  order_ref     text,
  order_id      uuid references public.orders(id) on delete set null,
  amount        numeric,
  currency      text,
  status        text,
  method        text,
  fee           numeric,
  tax           numeric,
  refunded      numeric,
  email         text,
  phone         text,
  paid_at       timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (connection_id, payment_ref)
);
create index if not exists gateway_payments_store_paid on public.gateway_payments (store_id, paid_at desc);
create index if not exists gateway_payments_order on public.gateway_payments (order_id) where order_id is not null;

create table if not exists public.gateway_settlements (
  id             uuid primary key default gen_random_uuid(),
  project_id     uuid not null references public.projects(id) on delete cascade,
  store_id       uuid not null references public.stores(id) on delete cascade,
  connection_id  uuid not null references public.store_connections(id) on delete cascade,
  provider       text not null,
  settlement_ref text not null,
  amount         numeric,
  fees           numeric,
  tax            numeric,
  utr            text,
  status         text,
  settled_at     timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  unique (connection_id, settlement_ref)
);
create index if not exists gateway_settlements_store_settled on public.gateway_settlements (store_id, settled_at desc);

do $$
declare t text;
begin
  foreach t in array array['message_stats', 'gateway_payments', 'gateway_settlements'] loop
    execute format('alter table public.%1$s enable row level security', t);
    execute format('drop policy if exists %1$s_member_read on public.%1$s', t);
    execute format('create policy %1$s_member_read on public.%1$s for select to authenticated using (public.abo_store_readable(store_id))', t);
    execute format('revoke insert, update, delete on public.%1$s from anon, authenticated', t);
    -- The wall every table has: no write from a connected client's token.
    execute format('drop policy if exists %1$s_oauth_no_insert on public.%1$s', t);
    execute format('create policy %1$s_oauth_no_insert on public.%1$s as restrictive for insert to authenticated with check (not public.abo_is_oauth_client())', t);
    execute format('drop policy if exists %1$s_oauth_no_update on public.%1$s', t);
    execute format('create policy %1$s_oauth_no_update on public.%1$s as restrictive for update to authenticated using (not public.abo_is_oauth_client())', t);
    execute format('drop policy if exists %1$s_oauth_no_delete on public.%1$s', t);
    execute format('create policy %1$s_oauth_no_delete on public.%1$s as restrictive for delete to authenticated using (not public.abo_is_oauth_client())', t);
  end loop;
end $$;

-- ── The ticket ───────────────────────────────────────────────
-- 0215's, knowing the new providers' lists.
create or replace function public.abo_connector_holding(p_list text, p_rows jsonb)
returns public.store_connections
language plpgsql stable security definer set search_path = public as $$
declare
  v_connection uuid := public.abo_connector_held();
  c            public.store_connections;
begin
  if v_connection is null then
    raise exception 'No live ticket.' using errcode = '42501';
  end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 500 then
    raise exception 'A page is a list of at most 500.' using errcode = '22023';
  end if;
  select * into c from public.store_connections where id = v_connection;
  if p_list <> all (case c.provider
      when 'meta_ads'         then array['ad_spend']
      when 'google_ads'       then array['ad_spend']
      when 'google_analytics' then array['web_traffic']
      when 'mailchimp'        then array['email_campaigns']
      when 'brevo'            then array['email_campaigns']
      when 'klaviyo'          then array['email_campaigns']
      when 'zendesk'          then array['support_tickets']
      when 'hubspot'          then array['crm_contacts']
      when 'meta_social'      then array['social_posts']
      when 'whatsapp'         then array['message_stats']
      when 'razorpay'         then array['gateway_payments', 'gateway_settlements']
      else array[]::text[] end) then
    raise exception 'This connection does not bring %.', p_list using errcode = '42501';
  end if;
  return c;
end $$;

create or replace function public.abo_connector_put_message_stats(p_rows jsonb)
returns integer
language plpgsql volatile security definer set search_path = public as $$
declare
  c   public.store_connections := public.abo_connector_holding('message_stats', p_rows);
  r   jsonb;
  v_n integer := 0;
begin
  for r in select * from jsonb_array_elements(p_rows) loop
    if nullif(btrim(r->>'template_ref'), '') is null then continue; end if;
    if coalesce(r->>'day', '') !~ '^\d{4}-\d{2}-\d{2}$' then continue; end if;
    insert into public.message_stats (
      project_id, store_id, connection_id, provider, template_ref, template_name, category, language,
      day, sent, delivered, read, clicked, updated_at
    ) values (
      c.project_id, c.store_id, c.id, c.provider,
      left(btrim(r->>'template_ref'), 120),
      left(nullif(btrim(r->>'template_name'), ''), 200),
      left(nullif(btrim(r->>'category'), ''), 40),
      left(nullif(btrim(r->>'language'), ''), 20),
      (r->>'day')::date,
      nullif(r->>'sent', '')::bigint,
      nullif(r->>'delivered', '')::bigint,
      nullif(r->>'read', '')::bigint,
      nullif(r->>'clicked', '')::bigint,
      now()
    )
    on conflict (connection_id, template_ref, day) do update set
      template_name = coalesce(excluded.template_name, public.message_stats.template_name),
      category = coalesce(excluded.category, public.message_stats.category),
      language = coalesce(excluded.language, public.message_stats.language),
      sent = excluded.sent, delivered = excluded.delivered, read = excluded.read, clicked = excluded.clicked,
      updated_at = now();
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;

create or replace function public.abo_connector_put_gateway_payments(p_rows jsonb)
returns integer
language plpgsql volatile security definer set search_path = public as $$
declare
  c   public.store_connections := public.abo_connector_holding('gateway_payments', p_rows);
  r   jsonb;
  v_n integer := 0;
begin
  for r in select * from jsonb_array_elements(p_rows) loop
    if nullif(btrim(r->>'payment_ref'), '') is null then continue; end if;
    insert into public.gateway_payments (
      project_id, store_id, connection_id, provider, payment_ref, order_ref, order_id, amount, currency,
      status, method, fee, tax, refunded, email, phone, paid_at, updated_at
    ) values (
      c.project_id, c.store_id, c.id, c.provider,
      left(btrim(r->>'payment_ref'), 120),
      left(nullif(btrim(r->>'order_ref'), ''), 120),
      public.abo_connector_order_for(c.store_id, r->>'order_ref'),
      nullif(r->>'amount', '')::numeric,
      left(nullif(btrim(r->>'currency'), ''), 3),
      left(nullif(btrim(r->>'status'), ''), 40),
      left(nullif(btrim(r->>'method'), ''), 40),
      nullif(r->>'fee', '')::numeric,
      nullif(r->>'tax', '')::numeric,
      nullif(r->>'refunded', '')::numeric,
      left(nullif(btrim(r->>'email'), ''), 320),
      left(nullif(btrim(r->>'phone'), ''), 40),
      nullif(r->>'paid_at', '')::timestamptz,
      now()
    )
    on conflict (connection_id, payment_ref) do update set
      order_ref = coalesce(excluded.order_ref, public.gateway_payments.order_ref),
      order_id = coalesce(excluded.order_id, public.gateway_payments.order_id),
      amount = excluded.amount, currency = coalesce(excluded.currency, public.gateway_payments.currency),
      status = excluded.status, method = coalesce(excluded.method, public.gateway_payments.method),
      fee = excluded.fee, tax = excluded.tax, refunded = excluded.refunded,
      email = coalesce(excluded.email, public.gateway_payments.email),
      phone = coalesce(excluded.phone, public.gateway_payments.phone),
      paid_at = coalesce(excluded.paid_at, public.gateway_payments.paid_at),
      updated_at = now();
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;

create or replace function public.abo_connector_put_gateway_settlements(p_rows jsonb)
returns integer
language plpgsql volatile security definer set search_path = public as $$
declare
  c   public.store_connections := public.abo_connector_holding('gateway_settlements', p_rows);
  r   jsonb;
  v_n integer := 0;
begin
  for r in select * from jsonb_array_elements(p_rows) loop
    if nullif(btrim(r->>'settlement_ref'), '') is null then continue; end if;
    insert into public.gateway_settlements (
      project_id, store_id, connection_id, provider, settlement_ref, amount, fees, tax, utr, status, settled_at, updated_at
    ) values (
      c.project_id, c.store_id, c.id, c.provider,
      left(btrim(r->>'settlement_ref'), 120),
      nullif(r->>'amount', '')::numeric,
      nullif(r->>'fees', '')::numeric,
      nullif(r->>'tax', '')::numeric,
      left(nullif(btrim(r->>'utr'), ''), 80),
      left(nullif(btrim(r->>'status'), ''), 40),
      nullif(r->>'settled_at', '')::timestamptz,
      now()
    )
    on conflict (connection_id, settlement_ref) do update set
      amount = excluded.amount, fees = excluded.fees, tax = excluded.tax,
      utr = coalesce(excluded.utr, public.gateway_settlements.utr),
      status = excluded.status,
      settled_at = coalesce(excluded.settled_at, public.gateway_settlements.settled_at),
      updated_at = now();
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;

/**
 * The AWBs a carrier's sync should ask after (Delhivery has no list of a
 * client's shipments): the ticket's store's fulfilments with that carrier
 * in the last 60 days, not yet delivered or returned as this connection
 * last heard, and not asked after in the last two hours; least lately
 * asked first. Each with the order it belongs to, as Shopify numbers it.
 */
create or replace function public.abo_connector_carrier_awbs(p_carrier text, p_limit integer default 50)
returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('awb', q.awb, 'order_number', q.order_number) order by q.asked), '[]'::jsonb)
    from (
      select d.awb, d.order_number, d.asked
        from (
          select distinct on (f.tracking_number)
                 f.tracking_number as awb, o.order_number, coalesce(s.updated_at, 'epoch'::timestamptz) as asked
            from public.store_connections sc
            join public.fulfillments f on f.store_id = sc.store_id
            join public.orders o on o.id = f.order_id
            left join public.courier_shipments s on s.connection_id = sc.id and s.awb = f.tracking_number
           where sc.id = public.abo_connector_held()
             and nullif(btrim(f.tracking_number), '') is not null
             and f.carrier ilike '%' || coalesce(nullif(btrim(p_carrier), ''), '-') || '%'
             and f.created_at > now() - interval '60 days'
             and (s.id is null or (s.delivered_at is null and not s.rto and s.updated_at < now() - interval '2 hours'))
           order by f.tracking_number, s.updated_at nulls first
        ) d
       order by d.asked
       limit least(greatest(coalesce(p_limit, 50), 1), 200)
    ) q;
$$;

-- The writers are the worker's, by its ticket.
do $$
declare f text;
begin
  foreach f in array array['message_stats', 'gateway_payments', 'gateway_settlements'] loop
    execute format('revoke all on function public.abo_connector_put_%1$s(jsonb) from public, authenticated', f);
    execute format('grant execute on function public.abo_connector_put_%1$s(jsonb) to anon', f);
  end loop;
end $$;
revoke all on function public.abo_connector_holding(text, jsonb) from public, anon, authenticated;
revoke all on function public.abo_connector_carrier_awbs(text, integer) from public, authenticated;
grant execute on function public.abo_connector_carrier_awbs(text, integer) to anon;

-- ── The lists, as the app shows them ─────────────────────────
create or replace view public.store_message_stats with (security_invoker = true) as
select m.id, m.store_id, m.provider,
       to_char(m.day, 'YYYY-MM-DD') as day,
       m.template_name as template, m.category, m.language,
       m.sent, m.delivered, m.read, m.clicked,
       round(100.0 * m.read / nullif(m.delivered, 0), 1) as read_rate,
       round(100.0 * m.clicked / nullif(m.delivered, 0), 1) as click_rate,
       m.updated_at
  from public.message_stats m;

create or replace view public.store_gateway_payments with (security_invoker = true) as
select g.id, g.store_id, g.provider,
       to_char((g.paid_at at time zone coalesce(st.timezone, 'UTC')), 'YYYY-MM-DD') as paid_on,
       g.payment_ref as payment,
       coalesce(o.order_number, g.order_ref) as order_number,
       g.amount, g.currency, g.status, g.method, g.fee, g.tax, g.refunded,
       g.email, g.phone,
       o.external_id as shopify_order_id,
       g.updated_at
  from public.gateway_payments g
  left join public.orders o on o.id = g.order_id
  left join public.stores st on st.id = g.store_id;

create or replace view public.store_gateway_settlements with (security_invoker = true) as
select s.id, s.store_id, s.provider,
       to_char((s.settled_at at time zone coalesce(st.timezone, 'UTC')), 'YYYY-MM-DD') as settled_on,
       s.settlement_ref as settlement, s.amount, s.fees, s.tax,
       s.amount - coalesce(s.fees, 0) - coalesce(s.tax, 0) as net,
       s.utr, s.status, s.updated_at
  from public.gateway_settlements s
  left join public.stores st on st.id = s.store_id;

grant select on public.store_message_stats, public.store_gateway_payments, public.store_gateway_settlements to authenticated;

-- 0215's mapping, three lines longer: the list every reader finds by name.
create or replace function public.abo_store_view(t text) returns text
language sql immutable as $$
  select case t
    when 'orders'              then 'store_orders'
    when 'customers'           then 'store_customers'
    when 'products'            then 'store_products'
    when 'inventory_levels'    then 'store_inventory'
    when 'product_sales'       then 'product_sales'
    when 'order_line_items'    then 'store_order_items'
    when 'refunds'             then 'store_refunds'
    when 'variants'            then 'store_variants'
    when 'fulfillments'        then 'store_fulfillments'
    when 'transactions'        then 'store_transactions'
    when 'locations'           then 'store_locations'
    when 'collections'         then 'store_collections'
    when 'carts'               then 'store_abandoned_checkouts'
    when 'drafts'              then 'store_draft_orders'
    when 'draft_order_items'   then 'store_draft_order_items'
    when 'discounts'           then 'store_discounts'
    when 'returns'             then 'store_returns'
    when 'return_reasons'      then 'return_reasons'
    when 'payouts'             then 'store_payouts'
    when 'courier_shipments'   then 'store_courier_shipments'
    when 'stock_pools'         then 'store_stock_pools'
    when 'ad_spend'            then 'store_ad_spend'
    when 'web_traffic'         then 'store_web_traffic'
    when 'email_campaigns'     then 'store_email_campaigns'
    when 'support_tickets'     then 'store_support_tickets'
    when 'crm_contacts'        then 'store_crm_contacts'
    when 'social_posts'        then 'store_social_posts'
    when 'message_stats'       then 'store_message_stats'
    when 'gateway_payments'    then 'store_gateway_payments'
    when 'gateway_settlements' then 'store_gateway_settlements'
  end;
$$;

notify pgrst, 'reload schema';
