-- Migration 0215: the rest of a store's day, connected (docs/integrations/connectors.md, phases 5 and 7)
--
-- Beside its courier (0204) and its Meta ads (0214), a store connects
-- the other accounts its day runs through, each with the merchant's own
-- credential, kept in the vault, pulled by its ticket:
--
--   google_ads        → ad_spend (0214)      what each campaign spent, by day
--   google_analytics  → web_traffic          visits and sales by day and source
--   mailchimp, brevo  → email_campaigns      each send: opens, clicks, revenue
--   zendesk           → support_tickets      tickets, on the customer they came from
--   hubspot           → crm_contacts         contacts, on the customer they are
--   meta_social       → social_posts         Facebook Page and Instagram posts
--
-- Lists are by kind of data, not by provider. A ticket writes only the
-- lists its connection's provider brings (abo_connector_holding), so a
-- leaked courier ticket writes no spend and an email ticket no tickets.
-- Customers are matched once, on write, by email or the phone's last ten
-- digits, as shipments are matched to orders (0204).

-- ── Who may connect ───────────────────────────────────────────
alter table public.store_connections drop constraint if exists store_connections_provider_check;
alter table public.store_connections add constraint store_connections_provider_check
  check (provider in ('shiprocket', 'goswift', 'meta_ads', 'google_ads', 'google_analytics',
                      'mailchimp', 'brevo', 'zendesk', 'hubspot', 'meta_social'));

-- ── The lists ─────────────────────────────────────────────────
create table if not exists public.web_traffic (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references public.projects(id) on delete cascade,
  store_id      uuid not null references public.stores(id) on delete cascade,
  connection_id uuid not null references public.store_connections(id) on delete cascade,
  provider      text not null,
  day           date not null,
  source        text not null default '',
  medium        text not null default '',
  campaign      text not null default '',
  sessions      bigint,
  users         bigint,
  purchases     numeric,
  revenue       numeric,
  currency      text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (connection_id, day, source, medium, campaign)
);
create index if not exists web_traffic_store_day on public.web_traffic (store_id, day desc);

create table if not exists public.email_campaigns (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references public.projects(id) on delete cascade,
  store_id      uuid not null references public.stores(id) on delete cascade,
  connection_id uuid not null references public.store_connections(id) on delete cascade,
  provider      text not null,
  campaign_ref  text not null,
  name          text,
  subject       text,
  sent_at       timestamptz,
  sent          bigint,
  delivered     bigint,
  opens         bigint,
  clicks        bigint,
  unsubscribes  bigint,
  bounces       bigint,
  orders        numeric,
  revenue       numeric,
  currency      text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (connection_id, campaign_ref)
);
create index if not exists email_campaigns_store_sent on public.email_campaigns (store_id, sent_at desc);

create table if not exists public.support_tickets (
  id              uuid primary key default gen_random_uuid(),
  project_id      uuid not null references public.projects(id) on delete cascade,
  store_id        uuid not null references public.stores(id) on delete cascade,
  connection_id   uuid not null references public.store_connections(id) on delete cascade,
  provider        text not null,
  ticket_ref      text not null,
  subject         text,
  status          text,
  priority        text,
  channel         text,
  requester_name  text,
  requester_email text,
  requester_phone text,
  customer_id     uuid references public.customers(id) on delete set null,
  opened_at       timestamptz,
  changed_at      timestamptz,
  tags            text[] not null default '{}',
  url             text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (connection_id, ticket_ref)
);
create index if not exists support_tickets_store_changed on public.support_tickets (store_id, changed_at desc);
create index if not exists support_tickets_customer on public.support_tickets (customer_id) where customer_id is not null;

create table if not exists public.crm_contacts (
  id              uuid primary key default gen_random_uuid(),
  project_id      uuid not null references public.projects(id) on delete cascade,
  store_id        uuid not null references public.stores(id) on delete cascade,
  connection_id   uuid not null references public.store_connections(id) on delete cascade,
  provider        text not null,
  contact_ref     text not null,
  name            text,
  email           text,
  phone           text,
  lifecycle_stage text,
  lead_status     text,
  customer_id     uuid references public.customers(id) on delete set null,
  added_at        timestamptz,
  changed_at      timestamptz,
  url             text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (connection_id, contact_ref)
);
create index if not exists crm_contacts_store_changed on public.crm_contacts (store_id, changed_at desc);
create index if not exists crm_contacts_customer on public.crm_contacts (customer_id) where customer_id is not null;

create table if not exists public.social_posts (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references public.projects(id) on delete cascade,
  store_id      uuid not null references public.stores(id) on delete cascade,
  connection_id uuid not null references public.store_connections(id) on delete cascade,
  provider      text not null,
  post_ref      text not null,
  network       text not null,
  posted_at     timestamptz,
  text          text,
  kind          text,
  likes         bigint,
  comments      bigint,
  shares        bigint,
  url           text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (connection_id, post_ref)
);
create index if not exists social_posts_store_posted on public.social_posts (store_id, posted_at desc);

-- Matching a customer by email reads this, not a scan.
create index if not exists idx_customers_email_lower on public.customers (store_id, lower(email)) where email is not null;

-- ── Who reads, who writes ────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['web_traffic', 'email_campaigns', 'support_tickets', 'crm_contacts', 'social_posts'] loop
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
/**
 * The connection a live ticket holds, when its provider brings this list
 * and the page is a list of at most 500. Every writer below starts here.
 */
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
      when 'zendesk'          then array['support_tickets']
      when 'hubspot'          then array['crm_contacts']
      when 'meta_social'      then array['social_posts']
      else array[]::text[] end) then
    raise exception 'This connection does not bring %.', p_list using errcode = '42501';
  end if;
  return c;
end $$;

/**
 * The store's customer a ticket or contact is about: by email first,
 * else by the last ten digits of the phone (how Indian numbers are
 * written with and without +91).
 *
 * ponytail: the phone half reads the store's customers row by row; an
 * index on their digits when a store's customers run to six figures.
 */
create or replace function public.abo_connector_customer_for(p_store uuid, p_email text, p_phone text)
returns uuid
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select c.id from public.customers c
      where c.store_id = p_store and nullif(btrim(p_email), '') is not null
        and lower(c.email) = lower(btrim(p_email))
      limit 1),
    (select c.id from public.customers c
      where c.store_id = p_store
        and length(regexp_replace(coalesce(p_phone, ''), '\D', '', 'g')) >= 10
        and right(regexp_replace(coalesce(c.phone, ''), '\D', '', 'g'), 10)
            = right(regexp_replace(p_phone, '\D', '', 'g'), 10)
      limit 1)
  );
$$;

create or replace function public.abo_connector_put_web_traffic(p_rows jsonb)
returns integer
language plpgsql volatile security definer set search_path = public as $$
declare
  c   public.store_connections := public.abo_connector_holding('web_traffic', p_rows);
  r   jsonb;
  v_n integer := 0;
begin
  for r in select * from jsonb_array_elements(p_rows) loop
    if coalesce(r->>'day', '') !~ '^\d{4}-\d{2}-\d{2}$' then continue; end if;
    insert into public.web_traffic (
      project_id, store_id, connection_id, provider, day, source, medium, campaign,
      sessions, users, purchases, revenue, currency, updated_at
    ) values (
      c.project_id, c.store_id, c.id, c.provider, (r->>'day')::date,
      left(coalesce(btrim(r->>'source'), ''), 200),
      left(coalesce(btrim(r->>'medium'), ''), 200),
      left(coalesce(btrim(r->>'campaign'), ''), 300),
      nullif(r->>'sessions', '')::bigint,
      nullif(r->>'users', '')::bigint,
      nullif(r->>'purchases', '')::numeric,
      nullif(r->>'revenue', '')::numeric,
      left(nullif(btrim(r->>'currency'), ''), 3),
      now()
    )
    on conflict (connection_id, day, source, medium, campaign) do update set
      sessions = excluded.sessions, users = excluded.users, purchases = excluded.purchases,
      revenue = excluded.revenue, currency = coalesce(excluded.currency, public.web_traffic.currency),
      updated_at = now();
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;

create or replace function public.abo_connector_put_email_campaigns(p_rows jsonb)
returns integer
language plpgsql volatile security definer set search_path = public as $$
declare
  c   public.store_connections := public.abo_connector_holding('email_campaigns', p_rows);
  r   jsonb;
  v_n integer := 0;
begin
  for r in select * from jsonb_array_elements(p_rows) loop
    if nullif(btrim(r->>'campaign_ref'), '') is null then continue; end if;
    insert into public.email_campaigns (
      project_id, store_id, connection_id, provider, campaign_ref, name, subject, sent_at,
      sent, delivered, opens, clicks, unsubscribes, bounces, orders, revenue, currency, updated_at
    ) values (
      c.project_id, c.store_id, c.id, c.provider,
      left(btrim(r->>'campaign_ref'), 120),
      left(nullif(btrim(r->>'name'), ''), 300),
      left(nullif(btrim(r->>'subject'), ''), 500),
      nullif(r->>'sent_at', '')::timestamptz,
      nullif(r->>'sent', '')::bigint,
      nullif(r->>'delivered', '')::bigint,
      nullif(r->>'opens', '')::bigint,
      nullif(r->>'clicks', '')::bigint,
      nullif(r->>'unsubscribes', '')::bigint,
      nullif(r->>'bounces', '')::bigint,
      nullif(r->>'orders', '')::numeric,
      nullif(r->>'revenue', '')::numeric,
      left(nullif(btrim(r->>'currency'), ''), 3),
      now()
    )
    on conflict (connection_id, campaign_ref) do update set
      name = coalesce(excluded.name, public.email_campaigns.name),
      subject = coalesce(excluded.subject, public.email_campaigns.subject),
      sent_at = coalesce(excluded.sent_at, public.email_campaigns.sent_at),
      sent = excluded.sent, delivered = excluded.delivered, opens = excluded.opens,
      clicks = excluded.clicks, unsubscribes = excluded.unsubscribes, bounces = excluded.bounces,
      orders = excluded.orders, revenue = excluded.revenue,
      currency = coalesce(excluded.currency, public.email_campaigns.currency),
      updated_at = now();
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;

create or replace function public.abo_connector_put_support_tickets(p_rows jsonb)
returns integer
language plpgsql volatile security definer set search_path = public as $$
declare
  c   public.store_connections := public.abo_connector_holding('support_tickets', p_rows);
  r   jsonb;
  v_n integer := 0;
begin
  for r in select * from jsonb_array_elements(p_rows) loop
    if nullif(btrim(r->>'ticket_ref'), '') is null then continue; end if;
    insert into public.support_tickets (
      project_id, store_id, connection_id, provider, ticket_ref, subject, status, priority, channel,
      requester_name, requester_email, requester_phone, customer_id, opened_at, changed_at, tags, url, updated_at
    ) values (
      c.project_id, c.store_id, c.id, c.provider,
      left(btrim(r->>'ticket_ref'), 120),
      left(nullif(btrim(r->>'subject'), ''), 500),
      left(nullif(btrim(r->>'status'), ''), 40),
      left(nullif(btrim(r->>'priority'), ''), 40),
      left(nullif(btrim(r->>'channel'), ''), 60),
      left(nullif(btrim(r->>'requester_name'), ''), 200),
      left(nullif(btrim(r->>'requester_email'), ''), 320),
      left(nullif(btrim(r->>'requester_phone'), ''), 40),
      public.abo_connector_customer_for(c.store_id, r->>'requester_email', r->>'requester_phone'),
      nullif(r->>'opened_at', '')::timestamptz,
      nullif(r->>'changed_at', '')::timestamptz,
      coalesce((select array_agg(left(t, 80)) from jsonb_array_elements_text(
        case when jsonb_typeof(r->'tags') = 'array' then r->'tags' else '[]'::jsonb end) t), '{}'),
      left(nullif(btrim(r->>'url'), ''), 500),
      now()
    )
    on conflict (connection_id, ticket_ref) do update set
      subject = coalesce(excluded.subject, public.support_tickets.subject),
      status = coalesce(excluded.status, public.support_tickets.status),
      priority = excluded.priority,
      channel = coalesce(excluded.channel, public.support_tickets.channel),
      requester_name = coalesce(excluded.requester_name, public.support_tickets.requester_name),
      requester_email = coalesce(excluded.requester_email, public.support_tickets.requester_email),
      requester_phone = coalesce(excluded.requester_phone, public.support_tickets.requester_phone),
      customer_id = coalesce(excluded.customer_id, public.support_tickets.customer_id),
      opened_at = coalesce(excluded.opened_at, public.support_tickets.opened_at),
      changed_at = coalesce(excluded.changed_at, public.support_tickets.changed_at),
      tags = excluded.tags,
      url = coalesce(excluded.url, public.support_tickets.url),
      updated_at = now();
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;

create or replace function public.abo_connector_put_crm_contacts(p_rows jsonb)
returns integer
language plpgsql volatile security definer set search_path = public as $$
declare
  c   public.store_connections := public.abo_connector_holding('crm_contacts', p_rows);
  r   jsonb;
  v_n integer := 0;
begin
  for r in select * from jsonb_array_elements(p_rows) loop
    if nullif(btrim(r->>'contact_ref'), '') is null then continue; end if;
    insert into public.crm_contacts (
      project_id, store_id, connection_id, provider, contact_ref, name, email, phone,
      lifecycle_stage, lead_status, customer_id, added_at, changed_at, url, updated_at
    ) values (
      c.project_id, c.store_id, c.id, c.provider,
      left(btrim(r->>'contact_ref'), 120),
      left(nullif(btrim(r->>'name'), ''), 200),
      left(nullif(btrim(r->>'email'), ''), 320),
      left(nullif(btrim(r->>'phone'), ''), 40),
      left(nullif(btrim(r->>'lifecycle_stage'), ''), 60),
      left(nullif(btrim(r->>'lead_status'), ''), 60),
      public.abo_connector_customer_for(c.store_id, r->>'email', r->>'phone'),
      nullif(r->>'added_at', '')::timestamptz,
      nullif(r->>'changed_at', '')::timestamptz,
      left(nullif(btrim(r->>'url'), ''), 500),
      now()
    )
    on conflict (connection_id, contact_ref) do update set
      name = coalesce(excluded.name, public.crm_contacts.name),
      email = coalesce(excluded.email, public.crm_contacts.email),
      phone = coalesce(excluded.phone, public.crm_contacts.phone),
      lifecycle_stage = excluded.lifecycle_stage,
      lead_status = excluded.lead_status,
      customer_id = coalesce(excluded.customer_id, public.crm_contacts.customer_id),
      added_at = coalesce(excluded.added_at, public.crm_contacts.added_at),
      changed_at = coalesce(excluded.changed_at, public.crm_contacts.changed_at),
      url = coalesce(excluded.url, public.crm_contacts.url),
      updated_at = now();
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;

create or replace function public.abo_connector_put_social_posts(p_rows jsonb)
returns integer
language plpgsql volatile security definer set search_path = public as $$
declare
  c   public.store_connections := public.abo_connector_holding('social_posts', p_rows);
  r   jsonb;
  v_n integer := 0;
begin
  for r in select * from jsonb_array_elements(p_rows) loop
    if nullif(btrim(r->>'post_ref'), '') is null then continue; end if;
    if coalesce(r->>'network', '') not in ('facebook', 'instagram') then continue; end if;
    insert into public.social_posts (
      project_id, store_id, connection_id, provider, post_ref, network, posted_at, text, kind,
      likes, comments, shares, url, updated_at
    ) values (
      c.project_id, c.store_id, c.id, c.provider,
      left(btrim(r->>'post_ref'), 120),
      r->>'network',
      nullif(r->>'posted_at', '')::timestamptz,
      left(nullif(btrim(r->>'text'), ''), 2000),
      left(nullif(btrim(r->>'kind'), ''), 40),
      nullif(r->>'likes', '')::bigint,
      nullif(r->>'comments', '')::bigint,
      nullif(r->>'shares', '')::bigint,
      left(nullif(btrim(r->>'url'), ''), 500),
      now()
    )
    on conflict (connection_id, post_ref) do update set
      posted_at = coalesce(excluded.posted_at, public.social_posts.posted_at),
      text = coalesce(excluded.text, public.social_posts.text),
      kind = coalesce(excluded.kind, public.social_posts.kind),
      likes = excluded.likes, comments = excluded.comments, shares = excluded.shares,
      url = coalesce(excluded.url, public.social_posts.url),
      updated_at = now();
    v_n := v_n + 1;
  end loop;
  return v_n;
end $$;

-- The helpers are the writers' own; the writers are the worker's, by its ticket.
revoke all on function public.abo_connector_holding(text, jsonb) from public, anon, authenticated;
revoke all on function public.abo_connector_customer_for(uuid, text, text) from public, anon, authenticated;
do $$
declare f text;
begin
  foreach f in array array['web_traffic', 'email_campaigns', 'support_tickets', 'crm_contacts', 'social_posts'] loop
    execute format('revoke all on function public.abo_connector_put_%1$s(jsonb) from public, authenticated', f);
    execute format('grant execute on function public.abo_connector_put_%1$s(jsonb) to anon', f);
  end loop;
end $$;

-- ── The lists, as the app shows them ─────────────────────────
create or replace view public.store_web_traffic with (security_invoker = true) as
select w.id, w.store_id, w.provider,
       to_char(w.day, 'YYYY-MM-DD') as day,
       w.source, w.medium, w.campaign,
       w.sessions, w.users, w.purchases, w.revenue, w.currency,
       round(100.0 * w.purchases / nullif(w.sessions, 0), 2) as conversion_rate,
       w.updated_at
  from public.web_traffic w;

create or replace view public.store_email_campaigns with (security_invoker = true) as
select e.id, e.store_id, e.provider,
       to_char((e.sent_at at time zone coalesce(st.timezone, 'UTC')), 'YYYY-MM-DD') as sent_on,
       e.name, e.subject, e.sent, e.delivered, e.opens, e.clicks, e.unsubscribes, e.bounces,
       round(100.0 * e.opens / nullif(coalesce(e.delivered, e.sent), 0), 1) as open_rate,
       round(100.0 * e.clicks / nullif(coalesce(e.delivered, e.sent), 0), 1) as click_rate,
       e.orders, e.revenue, e.currency, e.updated_at
  from public.email_campaigns e
  left join public.stores st on st.id = e.store_id;

create or replace view public.store_support_tickets with (security_invoker = true) as
select t.id, t.store_id, t.provider,
       t.ticket_ref as ticket, t.subject, t.status, t.priority, t.channel,
       coalesce(cu.name, t.requester_name) as customer_name,
       t.requester_email as email,
       cu.external_id as shopify_customer_id,
       cu.orders_count as customer_orders,
       to_char((t.opened_at at time zone coalesce(st.timezone, 'UTC')), 'YYYY-MM-DD') as opened_on,
       to_char((t.changed_at at time zone coalesce(st.timezone, 'UTC')), 'YYYY-MM-DD') as changed_on,
       array_to_string(t.tags, ', ') as tags,
       t.url, t.updated_at
  from public.support_tickets t
  left join public.customers cu on cu.id = t.customer_id
  left join public.stores st on st.id = t.store_id;

create or replace view public.store_crm_contacts with (security_invoker = true) as
select k.id, k.store_id, k.provider,
       k.name, k.email, k.phone, k.lifecycle_stage, k.lead_status,
       case when k.customer_id is null then 'Not a customer' else 'Customer' end as in_store,
       cu.external_id as shopify_customer_id,
       cu.orders_count as customer_orders,
       to_char((k.added_at at time zone coalesce(st.timezone, 'UTC')), 'YYYY-MM-DD') as added_on,
       to_char((k.changed_at at time zone coalesce(st.timezone, 'UTC')), 'YYYY-MM-DD') as changed_on,
       k.url, k.updated_at
  from public.crm_contacts k
  left join public.customers cu on cu.id = k.customer_id
  left join public.stores st on st.id = k.store_id;

create or replace view public.store_social_posts with (security_invoker = true) as
select p.id, p.store_id, p.provider,
       case p.network when 'facebook' then 'Facebook' when 'instagram' then 'Instagram' else p.network end as network,
       to_char((p.posted_at at time zone coalesce(st.timezone, 'UTC')), 'YYYY-MM-DD') as posted_on,
       left(p.text, 280) as text, p.kind, p.likes, p.comments, p.shares,
       coalesce(p.likes, 0) + coalesce(p.comments, 0) + coalesce(p.shares, 0) as engagement,
       p.url, p.updated_at
  from public.social_posts p
  left join public.stores st on st.id = p.store_id;

grant select on public.store_web_traffic, public.store_email_campaigns, public.store_support_tickets,
                public.store_crm_contacts, public.store_social_posts to authenticated;

-- 0214's mapping, five lines longer: the list every reader finds by name.
create or replace function public.abo_store_view(t text) returns text
language sql immutable as $$
  select case t
    when 'orders'            then 'store_orders'
    when 'customers'         then 'store_customers'
    when 'products'          then 'store_products'
    when 'inventory_levels'  then 'store_inventory'
    when 'product_sales'     then 'product_sales'
    when 'order_line_items'  then 'store_order_items'
    when 'refunds'           then 'store_refunds'
    when 'variants'          then 'store_variants'
    when 'fulfillments'      then 'store_fulfillments'
    when 'transactions'      then 'store_transactions'
    when 'locations'         then 'store_locations'
    when 'collections'       then 'store_collections'
    when 'carts'             then 'store_abandoned_checkouts'
    when 'drafts'            then 'store_draft_orders'
    when 'draft_order_items' then 'store_draft_order_items'
    when 'discounts'         then 'store_discounts'
    when 'returns'           then 'store_returns'
    when 'return_reasons'    then 'return_reasons'
    when 'payouts'           then 'store_payouts'
    when 'courier_shipments' then 'store_courier_shipments'
    when 'stock_pools'       then 'store_stock_pools'
    when 'ad_spend'          then 'store_ad_spend'
    when 'web_traffic'       then 'store_web_traffic'
    when 'email_campaigns'   then 'store_email_campaigns'
    when 'support_tickets'   then 'store_support_tickets'
    when 'crm_contacts'      then 'store_crm_contacts'
    when 'social_posts'      then 'store_social_posts'
  end;
$$;

notify pgrst, 'reload schema';
