-- Who sees what on a team.
--
-- A seat (0017) opened every section, every row and the whole store to
-- whoever took it. An owner who builds a margin sheet next to the
-- packing screen was showing the packer both, and the customers' phones
-- and addresses with them. Now:
--
--   A section       is the owner's until it is shared: with the whole
--                   team, or with the people picked. What was built
--                   before today stays shared with the team, so nobody
--                   loses a screen they used yesterday. A section under
--                   another is shared as its parent is.
--   The store       its orders, customers and products are read by a
--                   member only when the owner has said so, seat by
--                   seat. Seats taken before today keep it.
--   Luke's notes    about the business, and the traces of its turns,
--                   are the owner's: they come from the owner's
--                   conversations, which a member never could read.
--
-- The database decides all of it, not the screen: a section hidden
-- from the nav but readable through the API would be hidden from
-- nobody who wanted it.
--
-- And the link itself. The owner opening a link they made took a seat
-- in their own app; someone already on the team opening a second link
-- got an error; and a link lay open until somebody used it. Now the
-- owner and the team go straight in and leave the link for whoever it
-- was meant for, and a link lasts seven days unless it is made again.
--
-- Callers: src/components/ProjectSettings.tsx (seats, the store switch,
-- links), src/components/ShareSection.tsx (module_shares,
-- shared_with_team), src/app/join/[token]/page.tsx (abo_join,
-- abo_seat_welcome), src/components/AppShell.tsx (abo_member_seen),
-- src/components/AccountDetail.tsx (abo_admin_account's team),
-- scripts/check-rls.mjs.

-- ── What a seat carries ──────────────────────────────────────

-- Added true so every seat already taken keeps the store it had; every
-- seat made after this starts without it.
alter table public.project_members
  add column if not exists can_see_store boolean not null default true,
  add column if not exists last_seen_at timestamptz,
  add column if not exists expires_at timestamptz default now() + interval '7 days';
alter table public.project_members alter column can_see_store set default false;

comment on column public.project_members.can_see_store is 'Whether this member reads the store: its orders, customers and products. The owner decides.';
comment on column public.project_members.last_seen_at is 'When they last opened the app, to within five minutes (abo_member_seen).';
comment on column public.project_members.expires_at is 'An unclaimed link stops working after this; making it again moves it.';

-- ── Who a section is shared with ─────────────────────────────

-- Added true so every section already built stays with the team it was
-- with; every one built after this starts as the owner's.
alter table public.modules add column if not exists shared_with_team boolean not null default true;
alter table public.modules alter column shared_with_team set default false;
comment on column public.modules.shared_with_team is 'Everyone on the team sees it. Off, only the owner and the seats in module_shares do.';

create table if not exists public.module_shares (
  module_id  uuid not null references public.modules(id) on delete cascade,
  -- The seat, not the person: a link not opened yet can already be
  -- given its sections, and they are there when it is taken.
  member_id  uuid not null references public.project_members(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (module_id, member_id)
);
create index if not exists module_shares_member on public.module_shares (member_id);

alter table public.module_shares enable row level security;

-- The owner shares, and only a section with a seat of the same app.
drop policy if exists module_shares_owner_all on public.module_shares;
create policy module_shares_owner_all on public.module_shares
  for all to authenticated
  using (exists (select 1 from public.modules m where m.id = module_id and public.abo_owns(m.project_id)))
  with check (exists (
    select 1 from public.modules m
      join public.project_members pm on pm.project_id = m.project_id
     where m.id = module_id and pm.id = member_id and public.abo_owns(m.project_id)));

drop policy if exists module_shares_oauth_no_insert on public.module_shares;
create policy module_shares_oauth_no_insert on public.module_shares
  as restrictive for insert to authenticated
  with check (not public.abo_is_oauth_client());
drop policy if exists module_shares_oauth_no_update on public.module_shares;
create policy module_shares_oauth_no_update on public.module_shares
  as restrictive for update to authenticated
  using (not public.abo_is_oauth_client());
drop policy if exists module_shares_oauth_no_delete on public.module_shares;
create policy module_shares_oauth_no_delete on public.module_shares
  as restrictive for delete to authenticated
  using (not public.abo_is_oauth_client());

-- ── The gates ────────────────────────────────────────────────
-- security definer, as abo_can_use is, so they never re-enter the
-- policies of the tables they read.

-- A section: its owner, the team when it is shared with the team, or a
-- seat it was shared with. A section under another answers as its parent.
create or replace function public.abo_can_see_module(p_module uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.modules c
      join public.modules m on m.id = coalesce(c.parent_id, c.id)
     where c.id = p_module
       and (public.abo_owns(m.project_id)
            or (m.shared_with_team and public.abo_can_use(m.project_id))
            or exists (select 1 from public.module_shares s
                         join public.project_members pm on pm.id = s.member_id
                        where s.module_id = m.id and pm.user_id = auth.uid())));
$$;

-- An app's store: its owner, or a seat the owner let read it.
create or replace function public.abo_can_open_store(p uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.abo_owns(p)
      or exists (select 1 from public.project_members
                  where project_id = p and user_id = auth.uid() and can_see_store);
$$;

revoke all on function public.abo_can_see_module(uuid) from public, anon;
revoke all on function public.abo_can_open_store(uuid) from public, anon;
grant execute on function public.abo_can_see_module(uuid) to authenticated;
grant execute on function public.abo_can_open_store(uuid) to authenticated;

-- Every commerce table's read policy asks this (0018), so the store's
-- rows follow the switch without a policy of theirs changing.
create or replace function public.abo_store_readable(s uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.stores st
    where st.id = s and public.abo_can_open_store(st.project_id)
  );
$$;

-- ── The policies ─────────────────────────────────────────────

drop policy if exists "modules_member_read" on public.modules;
create policy "modules_member_read" on public.modules
  for select using (public.abo_can_see_module(id));

drop policy if exists "ui_schemas_member_read" on public.ui_schemas;
create policy "ui_schemas_member_read" on public.ui_schemas
  for select using (public.abo_can_see_module(module_id));

drop policy if exists "records_member_read" on public.records;
create policy "records_member_read" on public.records
  for select using (public.abo_can_see_module(module_id));

drop policy if exists "records_member_insert" on public.records;
create policy "records_member_insert" on public.records
  for insert with check (public.abo_can_see_module(module_id));

drop policy if exists "records_member_update" on public.records;
create policy "records_member_update" on public.records
  for update using (public.abo_can_see_module(module_id))
  with check (public.abo_can_see_module(module_id));

-- The store row itself too: a member without the store is not shown a
-- store they cannot open.
drop policy if exists "stores_member_read" on public.stores;
create policy "stores_member_read" on public.stores
  for select using (public.abo_can_open_store(project_id));

drop policy if exists merchant_notes_member_all on public.merchant_notes;
drop policy if exists merchant_notes_owner_all on public.merchant_notes;
create policy merchant_notes_owner_all on public.merchant_notes
  for all to authenticated
  using (public.abo_owns(project_id))
  with check (public.abo_owns(project_id));

drop policy if exists turn_traces_member_all on public.turn_traces;
drop policy if exists turn_traces_owner_all on public.turn_traces;
create policy turn_traces_owner_all on public.turn_traces
  for all to authenticated
  using (public.abo_owns(project_id))
  with check (public.abo_owns(project_id));

-- ── Taking a seat ────────────────────────────────────────────

create or replace function public.abo_join(p_token text) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_seat public.project_members;
begin
  if auth.uid() is null or public.abo_is_oauth_client() then
    return null;
  end if;
  select * into v_seat from public.project_members where token = p_token for update;
  if not found then
    return null;
  end if;
  -- Their own seat, opened again.
  if v_seat.user_id = auth.uid() then
    return v_seat.project_id;
  end if;
  -- Taken by somebody else.
  if v_seat.user_id is not null then
    return null;
  end if;
  -- The owner, or someone already on the team: in, and the link is left
  -- for whoever it was made for.
  if public.abo_can_use(v_seat.project_id) then
    return v_seat.project_id;
  end if;
  if v_seat.expires_at is not null and v_seat.expires_at <= now() then
    return null;
  end if;
  update public.project_members
     set user_id = auth.uid(), email = auth.jwt()->>'email', joined_at = now()
   where id = v_seat.id;
  return v_seat.project_id;
end $$;

-- What the person who just joined is told: who asked them in, and what
-- they will find. Their own seat only.
create or replace function public.abo_seat_welcome(p_project uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare v_seat public.project_members;
begin
  select * into v_seat from public.project_members
   where project_id = p_project and user_id = auth.uid();
  if not found then
    raise exception 'Not a member of that project.' using errcode = '42501';
  end if;
  return (
    select jsonb_build_object(
             'project', p.name,
             'invited_by', coalesce(nullif(btrim(pr.full_name), ''), split_part(u.email::text, '@', 1)),
             'business', nullif(btrim(pr.business_name), ''),
             'can_see_store', v_seat.can_see_store,
             'sections', (select coalesce(jsonb_agg(m.nav_label order by m.sort_order, m.created_at), '[]'::jsonb)
                            from public.modules m
                           where m.project_id = p.id and m.parent_id is null
                             and public.abo_can_see_module(m.id)))
      from public.projects p
      join auth.users u on u.id = p.owner_id
      left join public.profiles pr on pr.user_id = p.owner_id
     where p.id = p_project);
end $$;

-- That they were here: at most one write in five minutes, however often
-- the app is opened.
create or replace function public.abo_member_seen(p_project uuid) returns void
language sql security definer set search_path = public as $$
  update public.project_members set last_seen_at = now()
   where project_id = p_project and user_id = auth.uid()
     and (last_seen_at is null or last_seen_at < now() - interval '5 minutes');
$$;

revoke all on function public.abo_seat_welcome(uuid) from public, anon;
revoke all on function public.abo_member_seen(uuid) from public, anon;
grant execute on function public.abo_seat_welcome(uuid) to authenticated;
grant execute on function public.abo_member_seen(uuid) to authenticated;

-- ── The figures, behind the same doors ───────────────────────
-- Definer functions read past the policies, so each says its own door.
-- As 0128, 0129 and 0114 wrote them, but for the one line that asks.

create or replace function public.abo_section_stats(
  p_module uuid,
  p_stats  jsonb,
  p_scope  jsonb default '{}'::jsonb
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_project  uuid;
  v_source   text;
  v_store    uuid;
  v_view     text;
  v_ctx      jsonb;
  v_search   text;
  v_fields   jsonb;
  v_cur      jsonb;
  v_out      jsonb := '[]'::jsonb;
  c          jsonb;
  f          record;
  st         jsonb;
  i          int;
  n          int;
  v_op       text;
  v_val      jsonb;
  v_whr      jsonb;
  v_by       text;
  v_lim      int;
  one        jsonb;
begin
  if auth.uid() is null then
    raise exception 'Not signed in.' using errcode = '42501';
  end if;
  select m.project_id, m.source_table into v_project, v_source
    from public.modules m where m.id = p_module;
  -- The section shared with them, and a store section's store open to them (0140).
  if v_project is null or not public.abo_can_see_module(p_module)
     or (v_source is not null and not public.abo_can_open_store(v_project)) then
    raise exception 'No such section on this account.' using errcode = '42501';
  end if;
  if p_stats is null or jsonb_typeof(p_stats) <> 'array' then
    raise exception 'Stats must be a list.' using errcode = '22023';
  end if;
  n := jsonb_array_length(p_stats);
  if n > 12 then
    raise exception 'Too many stats.' using errcode = '22023';
  end if;
  if n = 0 then return v_out; end if;

  create temp table if not exists abo_stat_rows (rec jsonb) on commit drop;
  truncate abo_stat_rows;

  if v_source is null then
    insert into abo_stat_rows select r.data from public.records r where r.module_id = p_module and r.store_row_id is null;
  elsif public.abo_is_store_table(v_source) then
    select s.id into v_store
      from public.stores s
     where s.project_id = v_project and s.status = 'connected'
     limit 1;
    if v_store is not null then
      v_view := public.abo_store_view(v_source);
      -- Each row with the merchant's own fields under it: the store's
      -- value wins a name the two share, as withOwnFields does. Matched
      -- as text, because a list that groups rows has no id to match.
      execute format(
        'insert into abo_stat_rows
           select coalesce(r.data, ''{}''::jsonb) || to_jsonb(v)
             from public.%I v
             left join public.records r
               on r.module_id = $2 and r.store_row_id::text = to_jsonb(v)->>''id''
            where v.store_id = $1', v_view)
        using v_store, p_module;
    end if;
  end if;

  v_ctx := jsonb_build_object('module_id', p_module);

  -- Computed columns, in the order declared: each may read the ones
  -- above it, as withComputed does in the browser.
  for c in select value from jsonb_array_elements(coalesce(p_scope->'computed', '[]'::jsonb)) loop
    -- "where true": the API role refuses an update with no where at all.
    update abo_stat_rows
       set rec = rec || jsonb_build_object(c->>'field', public.abo_eval(c->'expr', rec, '{}'::jsonb, '{}'::jsonb, v_ctx))
     where true;
  end loop;

  -- What the person is looking at: the search box, then each filter.
  v_search := nullif(btrim(coalesce(p_scope->>'search', '')), '');
  if v_search is not null then
    v_search := '%' || replace(replace(replace(v_search, '\', '\\'), '%', '\%'), '_', '\_') || '%';
    v_fields := coalesce(p_scope->'search_fields', '[]'::jsonb);
    if jsonb_typeof(v_fields) = 'array' and jsonb_array_length(v_fields) > 0 then
      delete from abo_stat_rows t
       where not exists (
         select 1 from jsonb_array_elements_text(v_fields) fld
          where coalesce(t.rec->>fld, '') ilike v_search);
    else
      delete from abo_stat_rows t
       where not exists (
         select 1 from jsonb_each_text(t.rec) e where e.value ilike v_search);
    end if;
  end if;
  for f in select key, value from jsonb_each_text(coalesce(p_scope->'filters', '{}'::jsonb)) where btrim(value) <> '' loop
    delete from abo_stat_rows t where not public.abo_stat_matches(t.rec -> f.key, f.value);
  end loop;

  v_cur := coalesce(p_scope->'currency_fields', '[]'::jsonb);
  if jsonb_typeof(v_cur) <> 'array' then v_cur := '[]'::jsonb; end if;

  for i in 0 .. n - 1 loop
    st    := p_stats->i;
    v_op  := coalesce(st->>'op', 'count');
    v_val := coalesce(st->'value', case when st->>'field' is not null then jsonb_build_object('field', st->>'field') else null end);
    v_whr := st->'where';
    v_by  := nullif(btrim(coalesce(st->>'by', '')), '');
    v_lim := least(greatest(coalesce((st->>'limit')::int, 5), 1), 20);

    if v_by is null then
      with m as (
        select public.abo_stat_num(
                 case when v_op = 'count' or v_val is null then '0'::jsonb
                      else public.abo_eval(v_val, rec, '{}'::jsonb, '{}'::jsonb, v_ctx) end) as v,
               rec
          from abo_stat_rows
         where v_whr is null or public.abo_bool(public.abo_eval(v_whr, rec, '{}'::jsonb, '{}'::jsonb, v_ctx))
      )
      select jsonb_build_object(
               'count', count(*),
               'value', case v_op
                          when 'count' then count(*)::numeric
                          when 'sum'   then coalesce(sum(v), 0)
                          when 'avg'   then avg(v)
                          when 'min'   then min(v)
                          when 'max'   then max(v)
                        end,
               'currencies', (select coalesce(jsonb_agg(distinct x), '[]'::jsonb)
                                from (select m2.rec->>cf as x from m m2, jsonb_array_elements_text(v_cur) cf) q
                               where coalesce(x, '') <> ''))
        into one
        from m;
    else
      with m as (
        select public.abo_stat_num(
                 case when v_op = 'count' or v_val is null then '0'::jsonb
                      else public.abo_eval(v_val, rec, '{}'::jsonb, '{}'::jsonb, v_ctx) end) as v,
               rec
          from abo_stat_rows
         where v_whr is null or public.abo_bool(public.abo_eval(v_whr, rec, '{}'::jsonb, '{}'::jsonb, v_ctx))
      ),
      g as (
        select coalesce(rec->>v_by, '') as k,
               count(*) as c,
               case v_op
                 when 'count' then count(*)::numeric
                 when 'sum'   then coalesce(sum(v), 0)
                 when 'avg'   then avg(v)
                 when 'min'   then min(v)
                 when 'max'   then max(v)
               end as agg
          from m
         group by 1
      )
      select jsonb_build_object(
               'count', (select count(*) from m),
               'currencies', (select coalesce(jsonb_agg(distinct x), '[]'::jsonb)
                                from (select m2.rec->>cf as x from m m2, jsonb_array_elements_text(v_cur) cf) q
                               where coalesce(x, '') <> ''),
               'groups', coalesce((select jsonb_agg(jsonb_build_object('key', t.k, 'value', t.agg, 'count', t.c)
                                                    order by t.agg desc nulls last, t.c desc, t.k)
                                     from (select * from g order by agg desc nulls last, c desc, k limit v_lim) t),
                                  '[]'::jsonb))
        into one;
    end if;
    v_out := v_out || jsonb_build_array(one);
  end loop;

  return v_out;
end $$;

create or replace function public.abo_store_metrics(
  p_store   uuid,
  p_measure text,
  p_by      text  default 'none',
  p_from    date  default null,
  p_to      date  default null,
  p_filters jsonb default '{}'::jsonb
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_project  uuid;
  v_tz       text;
  v_currency text;
  v_from     timestamptz;
  v_to       timestamptz;
  v_where    text;
  v_join     text := '';
  v_key      text;
  v_val      text;
  v_order    text;
  v_groups   jsonb;
  v_total    jsonb;
  v_limit    constant int := 200;
  f          record;
begin
  if auth.uid() is null then
    raise exception 'Not signed in.' using errcode = '42501';
  end if;
  select s.project_id, coalesce(s.timezone, 'UTC'), s.currency
    into v_project, v_tz, v_currency
    from public.stores s where s.id = p_store;
  if v_project is null or not public.abo_can_open_store(v_project) then
    raise exception 'No such store on this account.' using errcode = '42501';
  end if;
  if p_measure not in ('orders', 'revenue', 'units', 'aov', 'customers', 'new_customers') then
    raise exception 'Not a measure: %', p_measure using errcode = '22023';
  end if;
  if p_by not in ('none', 'day', 'week', 'month', 'product', 'city', 'state', 'gateway', 'status', 'fulfilment', 'customer') then
    raise exception 'Not a dimension: %', p_by using errcode = '22023';
  end if;
  perform set_config('statement_timeout', '5000', true);

  -- The window, in the store's own day: from the start of p_from to the end of p_to.
  if p_from is not null then v_from := (p_from::timestamp) at time zone v_tz; end if;
  if p_to   is not null then v_to   := ((p_to + 1)::timestamp) at time zone v_tz; end if;
  if v_from is not null and v_to is not null and v_to <= v_from then
    raise exception 'The window ends before it starts.' using errcode = '22023';
  end if;

  -- The rows: this store's orders, in the window, not cancelled unless asked.
  v_where := format('o.store_id = %L', p_store);
  if v_from is not null then v_where := v_where || format(' and o.placed_at >= %L', v_from); end if;
  if v_to   is not null then v_where := v_where || format(' and o.placed_at < %L', v_to); end if;
  if not coalesce((p_filters->>'include_cancelled')::boolean, false) then
    v_where := v_where || ' and o.cancelled_at is null';
  end if;
  for f in
    select key, value from jsonb_each_text(coalesce(p_filters, '{}'::jsonb))
     where key in ('status', 'gateway', 'fulfilment', 'city', 'state') and btrim(value) <> ''
  loop
    v_where := v_where || format(' and %s = %L',
      case f.key
        when 'status'     then 'o.financial_status'
        when 'gateway'    then 'o.gateway'
        when 'fulfilment' then 'o.fulfilment_status'
        when 'city'       then 'o.ship_city'
        when 'state'      then 'o.ship_state'
      end, f.value);
  end loop;
  if btrim(coalesce(p_filters->>'product', '')) <> '' then
    v_where := v_where || format(
      ' and exists (select 1 from public.order_line_items lf left join public.products pf on pf.id = lf.product_id where lf.order_id = o.id and coalesce(pf.title, lf.title) ilike %L)',
      '%' || (p_filters->>'product') || '%');
  end if;

  -- What each row is grouped under.
  v_key := case p_by
    when 'none'       then '''all'''
    when 'day'        then format('to_char(o.placed_at at time zone %L, ''YYYY-MM-DD'')', v_tz)
    when 'week'       then format('to_char(date_trunc(''week'', o.placed_at at time zone %L), ''YYYY-MM-DD'')', v_tz)
    when 'month'      then format('to_char(o.placed_at at time zone %L, ''YYYY-MM'')', v_tz)
    when 'city'       then 'coalesce(o.ship_city, ''—'')'
    when 'state'      then 'coalesce(o.ship_state, ''—'')'
    when 'gateway'    then 'coalesce(o.gateway, ''—'')'
    when 'status'     then 'case when o.cancelled_at is not null then ''Cancelled'' else coalesce(o.financial_status, ''—'') end'
    when 'fulfilment' then 'coalesce(o.fulfilment_status, ''—'')'
    when 'product'    then 'coalesce(p.title, li.title, ''—'')'
    when 'customer'   then 'coalesce(c.name, c.email, ''no name'')'
  end;

  -- Lines are joined only when the figure is per line (units, or
  -- anything by product): an order spans products, and money summed
  -- over its lines is the only revenue a product can be said to have.
  if p_by = 'product' or p_measure = 'units' then
    v_join := ' join public.order_line_items li on li.order_id = o.id left join public.products p on p.id = li.product_id';
  end if;
  if p_by = 'customer' then
    v_join := v_join || ' left join public.customers c on c.id = o.customer_id';
  end if;

  v_val := case p_measure
    when 'orders'    then 'count(distinct o.id)'
    when 'units'     then 'coalesce(sum(li.quantity), 0)'
    when 'customers' then 'count(distinct o.customer_id)'
    -- A customer is new in the window when this is their first order in the shop.
    when 'new_customers' then 'count(distinct o.customer_id) filter (where o.placed_at = (select min(o2.placed_at) from public.orders o2 where o2.store_id = o.store_id and o2.customer_id = o.customer_id and o2.cancelled_at is null))'
    when 'revenue'   then case when p_by = 'product' then 'coalesce(sum(li.price * li.quantity), 0)' else 'coalesce(sum(o.total), 0)' end
    when 'aov'       then case when p_by = 'product' then 'coalesce(sum(li.price * li.quantity), 0) / greatest(count(distinct o.id), 1)' else 'avg(o.total)' end
  end;
  -- Time reads in order; everything else biggest first.
  v_order := case when p_by in ('day', 'week', 'month') then 'k' else 'v desc nulls last, n desc, k' end;

  execute format(
    'select coalesce(jsonb_agg(jsonb_build_object(''key'', k, ''value'', v, ''orders'', n) order by %s), ''[]''::jsonb)
       from (select %s as k, %s as v, count(distinct o.id) as n
               from public.orders o%s where %s group by 1 order by %s limit %s) g',
    v_order, v_key, v_val, v_join, v_where, v_order, v_limit + 1)
    into v_groups;
  execute format(
    'select jsonb_build_object(''value'', %s, ''orders'', count(distinct o.id)) from public.orders o%s where %s',
    v_val, v_join, v_where)
    into v_total;

  return jsonb_build_object(
    'measure', p_measure, 'by', p_by,
    'from', p_from, 'to', p_to, 'timezone', v_tz, 'currency', v_currency,
    'cancelled_included', coalesce((p_filters->>'include_cancelled')::boolean, false),
    'total', v_total,
    'groups', (select coalesce(jsonb_agg(e), '[]'::jsonb) from (select e from jsonb_array_elements(v_groups) e limit v_limit) x),
    'truncated', jsonb_array_length(v_groups) > v_limit
  );
end $$;

create or replace function public.abo_store_overview(
  p_project    uuid,
  p_days       int default 30,
  p_chart_days int default 14
)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_store  public.stores%rowtype;
  v_tz     text;
  v_days   int := coalesce(p_days, 30);
  v_chart  int := coalesce(p_chart_days, 14);
  v_today  date;
  v_from   timestamptz;
  v_orders jsonb;
  v_money  jsonb;
  v_daily  jsonb;
  v_stock  jsonb;
  v_watch  jsonb;
  v_count  int;
  v_open   int;
begin
  if auth.uid() is null then
    raise exception 'Not signed in.' using errcode = '42501';
  end if;
  if p_project is null or not public.abo_can_open_store(p_project) then
    raise exception 'No such project on this account.' using errcode = '42501';
  end if;
  if v_days < 1 or v_days > 365 or v_chart < 1 or v_chart > 90 then
    raise exception 'The window is 1 to 365 days, the chart 1 to 90.' using errcode = '22023';
  end if;

  -- The connected store if there is one, else the latest there was:
  -- a store taken off Shopify still has its rows until it is erased.
  select * into v_store
    from public.stores
   where project_id = p_project
   order by (status = 'connected') desc, connected_at desc nulls last
   limit 1;
  if not found then
    return jsonb_build_object('store', null, 'days', v_days, 'chart_days', v_chart);
  end if;

  -- A zone Postgres does not know would make every date below an error.
  v_tz := case
            when exists (select 1 from pg_timezone_names where name = v_store.timezone) then v_store.timezone
            else 'UTC'
          end;
  v_today := (now() at time zone v_tz)::date;
  v_from  := ((v_today - (v_days - 1))::timestamp) at time zone v_tz;

  select jsonb_build_object(
           'today',     count(*) filter (where (placed_at at time zone v_tz)::date = v_today),
           'yesterday', count(*) filter (where (placed_at at time zone v_tz)::date = v_today - 1),
           'window',    count(*) filter (where placed_at >= v_from)
         )
    into v_orders
    from public.orders
   where store_id = v_store.id and cancelled_at is null
     and placed_at >= least(v_from, ((v_today - 1)::timestamp) at time zone v_tz);

  select coalesce(jsonb_agg(m order by m->>'currency'), '[]'::jsonb)
    into v_money
    from (
      select jsonb_build_object(
               'currency',       o.currency,
               'collected',      coalesce(sum(o.total) filter (where o.financial_status = 'PAID'), 0),
               'awaiting',       coalesce(sum(o.total) filter (where o.financial_status = 'PENDING'), 0),
               'awaiting_count', count(*) filter (where o.financial_status = 'PENDING'),
               -- What most of the unpaid orders are waiting on, as Shopify
               -- names the payment method; null when none are unpaid.
               'awaiting_by',    (select g.gateway
                                    from public.orders g
                                   where g.store_id = v_store.id and g.currency = o.currency
                                     and g.cancelled_at is null and g.placed_at >= v_from
                                     and g.financial_status = 'PENDING' and g.gateway is not null
                                   group by g.gateway
                                   order by count(*) desc, g.gateway
                                   limit 1),
               'average',        round(avg(o.total_original), 2),
               'orders',         count(*)
             ) as m
        from public.orders o
       where o.store_id = v_store.id and o.placed_at >= v_from and o.cancelled_at is null
         and o.currency is not null
       group by o.currency
    ) x;

  -- Every day of the chart present, even one with nothing ordered, so a
  -- quiet Sunday is a short bar and not a missing one.
  select coalesce(jsonb_agg(jsonb_build_object('day', d.day::date, 'orders', coalesce(c.n, 0)) order by d.day), '[]'::jsonb)
    into v_daily
    from generate_series((v_today - (v_chart - 1))::timestamp, v_today::timestamp, interval '1 day') as d(day)
    left join (
      select (placed_at at time zone v_tz)::date as day, count(*) as n
        from public.orders
       where store_id = v_store.id and cancelled_at is null
         and placed_at >= ((v_today - (v_chart - 1))::timestamp) at time zone v_tz
       group by 1
    ) c on c.day = d.day::date;

  -- Work still to do, whenever the order came in.
  select count(*) into v_open
    from public.orders
   where store_id = v_store.id and cancelled_at is null
     and fulfilment_status in ('UNFULFILLED', 'PARTIALLY_FULFILLED', 'IN_PROGRESS', 'ON_HOLD',
                               'SCHEDULED', 'OPEN', 'PENDING_FULFILLMENT');

  -- The stock list's own words for each state (0097), counted.
  select coalesce(jsonb_object_agg(stock_state, n), '{}'::jsonb)
    into v_stock
    from (
      select stock_state, count(*) as n
        from public.store_inventory
       where store_id = v_store.id
       group by stock_state
    ) s;

  -- What to watch: a tracked variant with nothing left to sell, the rule
  -- behind "Out of stock", "All promised" and "Out, more coming" alike.
  -- The emptiest first: nothing on the shelf and nothing coming, then empty
  -- with more on its way, then on the shelf but all of it promised away.
  select count(*) into v_count
    from public.inventory_levels i
    join public.variants v on v.id = i.variant_id
   where i.store_id = v_store.id and v.tracked is not false and coalesce(i.available, 0) <= 0;

  select coalesce(jsonb_agg(x.w order by x.rn), '[]'::jsonb)
    into v_watch
    from (
      select jsonb_build_object(
               'id', i.id, 'product', p.title, 'variant', v.title, 'sku', v.sku,
               'location_name', nullif(i.location_name, ''),
               'available', coalesce(i.available, 0), 'on_hand', coalesce(i.on_hand, 0),
               'incoming', coalesce(i.incoming, 0), 'stock_state', si.stock_state
             ) as w,
             row_number() over (order by coalesce(i.available, 0), coalesce(i.on_hand, 0), coalesce(i.incoming, 0), p.title, i.id) as rn
        from public.inventory_levels i
        join public.variants v on v.id = i.variant_id
        left join public.products p on p.id = v.product_id
        join public.store_inventory si on si.id = i.id
       where i.store_id = v_store.id and v.tracked is not false and coalesce(i.available, 0) <= 0
       order by rn
       limit 20
    ) x;

  return jsonb_build_object(
    'store', jsonb_build_object(
      'shop_domain',    v_store.shop_domain,
      'status',         v_store.status,
      'currency',       v_store.currency,
      'timezone',       v_tz,
      'last_synced_at', v_store.last_synced_at
    ),
    'days',        v_days,
    'chart_days',  v_chart,
    'today',       v_today,
    'orders',      v_orders,
    'money',       v_money,
    'daily',       v_daily,
    'to_fulfil',   v_open,
    'stock',       v_stock,
    'stock_watch', v_watch,
    'watching',    v_count,
    'customers',   (select count(*) from public.customers where store_id = v_store.id),
    'products',    (select count(*) from public.products where store_id = v_store.id)
  );
end $$;


-- ── What an administrator sees of a team ─────────────────────
-- As 0120 wrote it, and each app says who is on its team now, not only how many.

create or replace function public.abo_admin_account(p_user uuid)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_email text;
begin
  if not public.abo_is_superadmin() then
    raise exception 'Not an administrator.' using errcode = '42501';
  end if;
  select lower(email) into v_email from auth.users where id = p_user;
  if v_email is null then
    raise exception 'No such account.' using errcode = 'P0002';
  end if;

  return jsonb_build_object(
    'projects', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'id', p.id,
               'name', p.name,
               'created_at', p.created_at,
               'members', (select count(*) from public.project_members m
                            where m.project_id = p.id and m.user_id is not null),
               'team', (select coalesce(jsonb_agg(jsonb_build_object(
                                 'name', m.full_name,
                                 'email', m.email,
                                 'role', m.team_role,
                                 'joined_at', m.joined_at,
                                 'last_seen_at', m.last_seen_at,
                                 'can_see_store', m.can_see_store,
                                 'sections', (select count(*) from public.modules x
                                               where x.project_id = p.id and x.parent_id is null
                                                 and (x.shared_with_team
                                                      or exists (select 1 from public.module_shares s
                                                                  where s.module_id = x.id and s.member_id = m.id))))
                               order by m.joined_at nulls last, m.created_at), '[]'::jsonb)
                          from public.project_members m
                         where m.project_id = p.id and m.user_id is not null),
               'sections', (select count(*) from public.modules x
                             where x.project_id = p.id and x.parent_id is null),
               'stores', (select coalesce(jsonb_agg(jsonb_build_object(
                                   'domain', s.shop_domain,
                                   'status', s.status,
                                   'connected_at', s.connected_at,
                                   'last_synced_at', s.last_synced_at,
                                   'problem', s.webhook_error)
                                 order by s.created_at), '[]'::jsonb)
                            from public.stores s where s.project_id = p.id))
             order by p.created_at desc), '[]'::jsonb)
        from public.projects p where p.owner_id = p_user),
    'invite', (
      select jsonb_build_object(
               'by', cu.email::text, 'note', i.note,
               'made_at', i.created_at, 'claimed_at', c.claimed_at)
        from public.account_invite_claims c
        join public.account_invites i on i.id = c.invite_id
        left join auth.users cu on cu.id = i.created_by
       where c.user_id = p_user
       order by c.claimed_at
       limit 1),
    'demos', (
      select coalesce(jsonb_agg(jsonb_build_object(
               'id', e.id, 'at', e.created_at,
               'store', e.payload->>'store',
               'note', nullif(e.payload->>'note', ''),
               'stage', coalesce(f.stage, 'new'))
             order by e.created_at desc), '[]'::jsonb)
        from public.landing_events e
        left join public.demo_followups f on f.event_id = e.id
       where e.event = 'demo_booked'
         and lower(btrim(e.payload->>'email')) = v_email),
    'trail', (
      select coalesce(jsonb_agg(t order by t.at desc), '[]'::jsonb)
        from (select a.action, a.old_value, a.new_value, a.created_at as at, au.email::text as by
                from public.admin_account_audit a
                left join auth.users au on au.id = a.actor_user_id
               where a.target_user_id = p_user
               order by a.created_at desc
               limit 50) t)
  );
end $$;

NOTIFY pgrst, 'reload schema';
