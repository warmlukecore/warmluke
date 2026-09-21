-- Migration 0106: the money that reached the bank.
--
-- Orders say what customers were charged. Transactions say what the
-- gateway captured. Neither says what Shopify actually sent to the
-- merchant's bank, on what day, with what taken out of it — and that
-- is the number the merchant reconciles against their statement and
-- the one they ask about when the two do not agree.
--
-- Under read_shopify_payments_payouts, which arrived with the grant
-- of 2026-09-21.
--
-- Said plainly, because it decides how much of this is proven: the
-- development store this was built against has NO Shopify Payments
-- account, so no payout has ever been seen arriving. The query and
-- every field name in it were validated against the live schema, and
-- Shopify refuses an invented field, so the shape is real. What is
-- not proven is the saver, against rows nobody here can conjure. The
-- first store with Shopify Payments is its real test.
--
-- Three things the schema was asked rather than assumed. `gross` is
-- deprecated in favour of `net`. A payout is a DEPOSIT or a
-- WITHDRAWAL, and summing the two together reports money arriving
-- that actually left. And the status is one of four, not the three
-- a reasonable person would guess.
--
-- No webhook exists for payouts — Shopify publishes none, which was
-- checked against its own topic list. So these go stale between
-- imports, and nothing can be done about that but import again.
--
-- Callers: src/lib/shopify-import.ts (savePayouts), the payouts
-- resource in src/lib/shopify-resources.ts, STORE_TABLES.payouts and
-- COUNTED in src/lib/store-read.ts.

create table if not exists public.payouts (
  id                uuid primary key default gen_random_uuid(),
  store_id          uuid not null references public.stores(id) on delete cascade,
  external_id       text not null,
  -- SCHEDULED, PAID, FAILED or CANCELED. Only a PAID one has really
  -- reached the bank.
  status            text,
  -- DEPOSIT or WITHDRAWAL. A withdrawal is Shopify taking money back
  -- out, and adding the two kinds together reports money arriving
  -- that in fact left.
  kind              text,
  issued_at         timestamptz,
  -- What actually moved. Shopify's own authoritative number, and the
  -- one to compare against a bank statement.
  net               numeric(12,2),
  currency          text,
  -- What it is made of. Every component Shopify reports is kept, so
  -- the parts add up to the whole: a reconciliation that says "and
  -- 40 unaccounted for" is not a reconciliation.
  charges_gross     numeric(12,2),
  charges_fee       numeric(12,2),
  refunds_gross     numeric(12,2),
  refunds_fee       numeric(12,2),
  adjustments_gross numeric(12,2),
  adjustments_fee   numeric(12,2),
  reserved_gross    numeric(12,2),
  reserved_fee      numeric(12,2),
  retried_gross     numeric(12,2),
  retried_fee       numeric(12,2),
  advance_gross     numeric(12,2),
  advance_fee       numeric(12,2),
  created_at        timestamptz not null default now()
);
create unique index if not exists idx_payouts_unique on public.payouts(store_id, external_id);
create index if not exists idx_payouts_store on public.payouts(store_id);

comment on column public.payouts.net is
  'What Shopify actually sent. The authoritative figure; the component columns explain it.';
comment on column public.payouts.kind is
  'DEPOSIT or WITHDRAWAL. Never sum the two together.';

-- The two policies every commerce table has (0018), and the three
-- that keep a connected assistant from writing at the table (0070).
alter table public.payouts enable row level security;
drop policy if exists "payouts_owner_all" on public.payouts;
create policy "payouts_owner_all" on public.payouts
  for all using (public.abo_store_owned(store_id)) with check (public.abo_store_owned(store_id));
drop policy if exists "payouts_member_read" on public.payouts;
create policy "payouts_member_read" on public.payouts
  for select using (public.abo_store_readable(store_id));

drop policy if exists "payouts_oauth_no_insert" on public.payouts;
create policy "payouts_oauth_no_insert"
  on public.payouts as restrictive
  for insert to authenticated
  with check (not public.abo_is_oauth_client());

drop policy if exists "payouts_oauth_no_update" on public.payouts;
create policy "payouts_oauth_no_update"
  on public.payouts as restrictive
  for update to authenticated
  using (not public.abo_is_oauth_client());

drop policy if exists "payouts_oauth_no_delete" on public.payouts;
create policy "payouts_oauth_no_delete"
  on public.payouts as restrictive
  for delete to authenticated
  using (not public.abo_is_oauth_client());

create or replace view public.store_payouts with (security_invoker = true) as
select
  p.id,
  p.store_id,
  to_char(p.issued_at, 'YYYY-MM-DD') as issued_at,
  case p.status
    when 'PAID'      then 'In the bank'
    when 'SCHEDULED' then 'On its way'
    when 'FAILED'    then 'Failed'
    when 'CANCELED'  then 'Cancelled'
    else initcap(coalesce(p.status, ''))
  end as state,
  case p.kind
    when 'DEPOSIT'    then 'Paid out'
    when 'WITHDRAWAL' then 'Taken back'
    else p.kind
  end as kind,
  p.net,
  p.currency,
  p.charges_gross,
  p.refunds_gross,
  -- Everything Shopify kept, in one number, because "what did
  -- Shopify charge me this week" is the question these rows exist
  -- to answer and it is spread over six columns otherwise.
  (coalesce(p.charges_fee, 0) + coalesce(p.refunds_fee, 0) + coalesce(p.adjustments_fee, 0)
   + coalesce(p.reserved_fee, 0) + coalesce(p.retried_fee, 0) + coalesce(p.advance_fee, 0)) as fees,
  p.adjustments_gross
from public.payouts p;

grant select on public.store_payouts to authenticated;

-- The one mapping, one line longer (0089, 0090, 0092, 0095, 0099,
-- 0100, 0103, 0104, 0105). Keyed by what STORE_TABLES calls the list.
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
  end;
$$;

-- No webhook road. Shopify publishes no payout topic — checked
-- against its own WebhookSubscriptionTopic enum, which has
-- DISCOUNTS_*, RETURNS_* and DISPUTES_* and nothing for payouts. The
-- dispatcher is therefore unchanged by this migration, and that
-- absence is the reason, not an oversight.

NOTIFY pgrst, 'reload schema';
