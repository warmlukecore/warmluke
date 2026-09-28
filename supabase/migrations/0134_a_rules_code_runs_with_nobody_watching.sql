-- A rule's own code runs with nobody watching.
--
-- A code rule (automation action run_code) ran after the owner's own
-- write in the app and at no other time: "every morning, work out who is
-- overdue" and "when a new order comes in from the store, work out its
-- courier charge" could be written and never ran. Both need the app's
-- server, where the sandbox is, with no owner there to be.
--
-- So this database hands out the authority itself, as it does for the
-- import (0110): work for a project goes on a queue (code_jobs); when
-- there is some, a ticket is minted — random, bound to that one project,
-- minutes long, kept only as its hash — and posted to the worker route
-- with pg_net. The worker presents it as x-code-ticket, and the policies
-- below let it read that project's sections, rules and store rows and
-- write that project's records, and nothing else: no other project, no
-- account, and none of a store's tokens. There is no standing secret on
-- the server; a ticket is useless once it lapses.
--
-- The worker's address is the switch: with no code_worker_url in the
-- vault (the check project, or production turned back) nothing is sent.
--
-- Work comes two ways. A rule on a schedule (every hourly, daily or
-- weekly) is queued when its time has come since it last ran. A rule on
-- a store row being added (store_row_added) is queued when the store
-- brings one in — once its first import is done, so a store connected
-- with ten thousand orders does not wake ten thousand runs.

-- ── The database's own scheduled runner leaves code rules alone ──────

create or replace function public.run_scheduled_automations()
returns void as $$
declare
  auto record;
  target record;
  v_source text;
  v_view   text;
  v_project uuid;
  v_rec_id uuid;
  v_rec_data jsonb;
  ctx jsonb;
  rec_data jsonb;
begin
  for auto in
    select a.*, m.source_table, m.project_id as module_project
    from public.automations a
    join public.modules m on m.id = a.module_id
    where a.enabled and (a.definition->'trigger'->>'type') = 'schedule'
      -- A rule's own code is the app's to run (code_jobs, below): walked
      -- here it would only lay an empty record beside every row it matched.
      and not (coalesce(a.definition->'actions', '[]'::jsonb) @> '[{"type": "run_code"}]'::jsonb)
  loop
    begin
      v_source := auto.source_table;
      v_project := auto.module_project;
      if v_source is null then
        -- A section of their own: its records, as always.
        for target in
          select r.id, r.project_id, r.data
          from public.records r
          where r.module_id = auto.module_id
        loop
          ctx := jsonb_build_object('module_id', auto.module_id, 'record_id', target.id);
          rec_data := coalesce(target.data, '{}'::jsonb) || jsonb_build_object('id', target.id);

          if auto.definition->'trigger' ? 'when' then
            if not public.abo_bool(
                 public.abo_eval(auto.definition->'trigger'->'when', rec_data, '{}'::jsonb, '{}'::jsonb, ctx)
               ) then
              continue;
            end if;
          end if;

          perform public.abo_run_actions(
            auto.id, coalesce(auto.definition->'actions', '[]'::jsonb),
            target.id, target.project_id, rec_data, '{}'::jsonb, ctx
          );
        end loop;
      else
        -- A section over the store: every row of this project's store,
        -- with the merchant's fields where a row has them. A row the
        -- rule acts on gets its record first, so there is something to
        -- write to.
        v_view := public.abo_store_view(v_source);
        if v_view is null then continue; end if;
        for target in execute format(
          'select v.id as row_id, to_jsonb(v) - ''store_id'' as row_data, r.id as rec_id, r.data as rec_data
             from public.%I v
             join public.stores s on s.id = v.store_id
             left join public.records r on r.module_id = $2 and r.store_row_id = v.id
            where s.project_id = $1', v_view) using v_project, auto.module_id
        loop
          rec_data := coalesce(target.rec_data, '{}'::jsonb) || target.row_data
                      || jsonb_build_object('id', coalesce(target.rec_id, target.row_id));
          ctx := jsonb_build_object('module_id', auto.module_id, 'record_id', target.rec_id, 'store_row_id', target.row_id);

          if auto.definition->'trigger' ? 'when' then
            if not public.abo_bool(
                 public.abo_eval(auto.definition->'trigger'->'when', rec_data, '{}'::jsonb, '{}'::jsonb, ctx)
               ) then
              continue;
            end if;
          end if;

          v_rec_id := target.rec_id;
          if v_rec_id is null then
            insert into public.records(project_id, module_id, store_row_id, data)
            values (v_project, auto.module_id, target.row_id, '{}'::jsonb)
            returning id into v_rec_id;
            rec_data := rec_data || jsonb_build_object('id', v_rec_id);
            ctx := ctx || jsonb_build_object('record_id', v_rec_id);
          end if;

          perform public.abo_run_actions(
            auto.id, coalesce(auto.definition->'actions', '[]'::jsonb),
            v_rec_id, v_project, rec_data, '{}'::jsonb, ctx
          );
        end loop;
      end if;
    exception when others then
      insert into public.automation_runs(automation_id, record_id, ok, detail)
      values (auto.id, null, false, jsonb_build_object('error', sqlerrm));
    end;
  end loop;
end;
$$ language plpgsql security definer;

-- ── The queue ────────────────────────────────────────────────────

create table if not exists public.code_jobs (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references public.projects(id) on delete cascade,
  automation_id uuid not null references public.automations(id) on delete cascade,
  kind          text not null check (kind in ('schedule', 'added')),
  -- The rows it is for: the store rows added, for an 'added' job.
  row_ids       uuid[] not null default '{}',
  status        text not null default 'queued' check (status in ('queued', 'running', 'done', 'failed')),
  attempts      integer not null default 0,
  error         text,
  created_at    timestamptz not null default now(),
  -- When a worker took it: a job running long past a function's life had its worker die.
  started_at    timestamptz,
  finished_at   timestamptz
);
-- One open job a rule and a kind: rows added while one waits join it.
create unique index if not exists code_jobs_one_open on public.code_jobs (automation_id, kind) where status = 'queued';
create index if not exists code_jobs_by_project on public.code_jobs (project_id, status);

alter table public.code_jobs enable row level security;
-- The owner reads what ran and what failed; nobody writes but the database and the ticket.
drop policy if exists code_jobs_member_read on public.code_jobs;
create policy code_jobs_member_read on public.code_jobs
  for select to authenticated using (public.abo_can_use(project_id));
drop policy if exists code_jobs_oauth_no_insert on public.code_jobs;
create policy code_jobs_oauth_no_insert on public.code_jobs
  as restrictive for insert to authenticated with check (not public.abo_is_oauth_client());
drop policy if exists code_jobs_oauth_no_update on public.code_jobs;
create policy code_jobs_oauth_no_update on public.code_jobs
  as restrictive for update to authenticated using (not public.abo_is_oauth_client());
drop policy if exists code_jobs_oauth_no_delete on public.code_jobs;
create policy code_jobs_oauth_no_delete on public.code_jobs
  as restrictive for delete to authenticated using (not public.abo_is_oauth_client());

-- One row a project is the whole lock: two workers never walk one project.
create table if not exists public.code_leases (
  project_id  uuid primary key references public.projects(id) on delete cascade,
  ticket_hash bytea not null,
  expires_at  timestamptz not null,
  taken_at    timestamptz not null default now()
);
alter table public.code_leases enable row level security;
revoke all on public.code_leases from anon, authenticated;
drop policy if exists code_leases_oauth_no_insert on public.code_leases;
create policy code_leases_oauth_no_insert on public.code_leases
  as restrictive for insert to authenticated with check (not public.abo_is_oauth_client());
drop policy if exists code_leases_oauth_no_update on public.code_leases;
create policy code_leases_oauth_no_update on public.code_leases
  as restrictive for update to authenticated using (not public.abo_is_oauth_client());
drop policy if exists code_leases_oauth_no_delete on public.code_leases;
create policy code_leases_oauth_no_delete on public.code_leases
  as restrictive for delete to authenticated using (not public.abo_is_oauth_client());

-- ── The ticket ───────────────────────────────────────────────────

/** The hash of the ticket this request carries, or null. */
create or replace function public.abo_code_ticket_hash()
returns bytea
language sql stable set search_path = public as $$
  select sha256(convert_to(h.t, 'UTF8'))
    from (select nullif(current_setting('request.headers', true), '')::json ->> 'x-code-ticket' as t) h
   where h.t is not null and length(h.t) >= 32
$$;

/** Whether this request's ticket is live and bound to project p. */
create or replace function public.abo_code_holds(p uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.code_leases l
     where l.project_id = p and l.expires_at > now() and l.ticket_hash = public.abo_code_ticket_hash()
  )
$$;

/** The same, for a row of a store: whether the ticket holds the project that store belongs to. */
create or replace function public.abo_code_holds_store(s uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.stores st
      join public.code_leases l on l.project_id = st.project_id
     where st.id = s and l.expires_at > now() and l.ticket_hash = public.abo_code_ticket_hash()
  )
$$;

/** The same, for a section's schema, which names its section and not its project. */
create or replace function public.abo_code_holds_module(m uuid)
returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.modules mo
      join public.code_leases l on l.project_id = mo.project_id
     where mo.id = m and l.expires_at > now() and l.ticket_hash = public.abo_code_ticket_hash()
  )
$$;

/** The project this request's ticket is for, while it lives. */
create or replace function public.abo_code_project()
returns uuid
language sql stable security definer set search_path = public as $$
  select l.project_id from public.code_leases l
   where l.expires_at > now() and l.ticket_hash = public.abo_code_ticket_hash()
$$;

/** Gives the ticket back: the project is free for the next dispatch. */
create or replace function public.abo_code_release()
returns void
language sql volatile security definer set search_path = public as $$
  delete from public.code_leases where ticket_hash = public.abo_code_ticket_hash()
$$;

/** A fresh ticket for a project, or null while another lives. Internal. */
create or replace function public.abo_code_mint(p_project uuid, p_seconds integer default 360)
returns text
language plpgsql volatile security definer set search_path = public as $$
declare
  v_ticket text;
  v_got    uuid;
begin
  if not exists (select 1 from public.projects where id = p_project) then
    return null;
  end if;
  v_ticket := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  insert into public.code_leases as l (project_id, ticket_hash, expires_at)
  values (p_project, sha256(convert_to(v_ticket, 'UTF8')), now() + make_interval(secs => p_seconds))
  on conflict (project_id) do update
     set ticket_hash = excluded.ticket_hash, expires_at = excluded.expires_at, taken_at = now()
   where l.expires_at <= now()
  returning l.project_id into v_got;
  return case when v_got is null then null else v_ticket end;
end $$;

/** Sends a project's queued code to the worker: 'sent', 'busy' or 'not_configured'. Internal. */
create or replace function public.abo_code_dispatch(p_project uuid)
returns text
language plpgsql volatile security definer set search_path = public as $$
declare
  v_url    text;
  v_ticket text;
begin
  select ds.decrypted_secret into v_url from vault.decrypted_secrets ds where ds.name = 'code_worker_url' limit 1;
  if v_url is null or v_url = '' then
    return 'not_configured';
  end if;
  v_ticket := public.abo_code_mint(p_project);
  if v_ticket is null then
    return 'busy';
  end if;
  perform net.http_post(
    url                  := v_url,
    body                 := jsonb_build_object('project', p_project, 'ticket', v_ticket),
    headers              := jsonb_build_object('Content-Type', 'application/json'),
    timeout_milliseconds := 15000
  );
  return 'sent';
end $$;

/** Each minute: every project with code waiting and no worker on it is sent one. */
create or replace function public.abo_code_tick()
returns integer
language plpgsql volatile security definer set search_path = public as $$
declare
  v_project uuid;
  v_sent integer := 0;
  j record;
  v_merged boolean;
begin
  -- A job whose worker died (a function lives five minutes; this is three
  -- times that). One at a time: its rows join the rule's open job when
  -- there is one, since two open jobs for a rule cannot be; else it goes
  -- back on the queue, three tries in all.
  for j in
    select id, automation_id, kind, row_ids, attempts from public.code_jobs
     where status = 'running' and coalesce(started_at, created_at) < now() - interval '15 minutes'
     order by coalesce(started_at, created_at)
  loop
    update public.code_jobs q set row_ids = (q.row_ids || j.row_ids)[1:500]
     where q.automation_id = j.automation_id and q.kind = j.kind and q.status = 'queued';
    v_merged := found;
    if v_merged or j.attempts >= 3 then
      update public.code_jobs
         set status = 'failed', finished_at = now(),
             error = case when v_merged then 'The worker stopped before it finished; the next run takes its rows.'
                          else 'The worker stopped before it finished, three times.' end
       where id = j.id;
    else
      update public.code_jobs set status = 'queued' where id = j.id;
    end if;
  end loop;
  if not exists (select 1 from vault.decrypted_secrets where name = 'code_worker_url') then
    return 0;
  end if;
  for v_project in
    select distinct j.project_id from public.code_jobs j
     where j.status = 'queued'
       and not exists (select 1 from public.code_leases l where l.project_id = j.project_id and l.expires_at > now())
     limit 20
  loop
    if public.abo_code_dispatch(v_project) = 'sent' then v_sent := v_sent + 1; end if;
  end loop;
  return v_sent;
end $$;

-- ── What puts work on the queue ──────────────────────────────────

/** Queues every scheduled code rule whose time has come since it last ran. */
create or replace function public.abo_code_schedule()
returns integer
language plpgsql volatile security definer set search_path = public as $$
declare
  a record;
  v_every interval;
  v_queued integer := 0;
begin
  for a in
    select au.id, au.project_id, au.definition->'trigger'->>'every' as every
      from public.automations au
     where au.enabled
       and au.definition->'trigger'->>'type' = 'schedule'
       and coalesce(au.definition->'actions', '[]'::jsonb) @> '[{"type": "run_code"}]'::jsonb
  loop
    v_every := case a.every when 'hourly' then interval '1 hour' when 'weekly' then interval '7 days' else interval '1 day' end;
    if exists (
      select 1 from public.code_jobs j
       where j.automation_id = a.id and j.kind = 'schedule'
         and (j.status in ('queued', 'running') or j.created_at > now() - v_every + interval '5 minutes')
    ) then
      continue;
    end if;
    insert into public.code_jobs (project_id, automation_id, kind) values (a.project_id, a.id, 'schedule')
    on conflict do nothing;
    v_queued := v_queued + 1;
  end loop;
  return v_queued;
end $$;

/** The section's name for a store table: the lists a section can be over, by the table their rows are in. */
create or replace function public.abo_code_source(t text)
returns text
language sql immutable as $$
  select case t
    when 'order_transactions'     then 'transactions'
    when 'abandoned_checkouts'    then 'carts'
    when 'draft_orders'           then 'drafts'
    when 'draft_order_line_items' then 'draft_order_items'
    else t
  end
$$;

/**
 * A row the store brought in, for every code rule waiting on one in a
 * section over that list: joined to the rule's open job, up to 500 rows
 * a job. Not while the store's first import runs.
 */
create or replace function public.abo_code_on_store_row()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_project uuid;
  v_synced  timestamptz;
  a record;
begin
  select s.project_id, s.last_synced_at into v_project, v_synced from public.stores s where s.id = new.store_id;
  if v_project is null or v_synced is null then
    return new;
  end if;
  for a in
    select au.id from public.automations au
      join public.modules m on m.id = au.module_id
     where m.project_id = v_project
       and m.source_table = public.abo_code_source(TG_TABLE_NAME)
       and au.enabled
       and au.definition->'trigger'->>'type' = 'store_row_added'
       and coalesce(au.definition->'actions', '[]'::jsonb) @> '[{"type": "run_code"}]'::jsonb
  loop
    insert into public.code_jobs (project_id, automation_id, kind, row_ids)
    values (v_project, a.id, 'added', array[new.id])
    on conflict (automation_id, kind) where status = 'queued'
    do update set row_ids = case
      when cardinality(public.code_jobs.row_ids) < 500 then public.code_jobs.row_ids || excluded.row_ids
      else public.code_jobs.row_ids
    end;
  end loop;
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array[
    'orders', 'order_line_items', 'customers', 'products', 'variants', 'inventory_levels', 'fulfillments',
    'refunds', 'returns', 'order_transactions', 'locations', 'collections', 'abandoned_checkouts',
    'draft_orders', 'draft_order_line_items', 'discounts'
  ] loop
    if to_regclass('public.' || t) is not null then
      execute format('drop trigger if exists %I on public.%I', t || '_code_added', t);
      execute format(
        'create trigger %I after insert on public.%I for each row execute function public.abo_code_on_store_row()',
        t || '_code_added', t
      );
    end if;
  end loop;
end $$;

-- ── What a ticket may read and write ─────────────────────────────

-- The project's sections, their schemas and their rules: read.
drop policy if exists modules_code_ticket on public.modules;
create policy modules_code_ticket on public.modules for select to anon using (public.abo_code_holds(project_id));
drop policy if exists ui_schemas_code_ticket on public.ui_schemas;
create policy ui_schemas_code_ticket on public.ui_schemas for select to anon using (public.abo_code_holds_module(module_id));
drop policy if exists automations_code_ticket on public.automations;
create policy automations_code_ticket on public.automations for select to anon using (public.abo_code_holds(project_id));
-- Its records: read and written, as the owner's own writes are.
drop policy if exists records_code_ticket on public.records;
create policy records_code_ticket on public.records for all to anon
  using (public.abo_code_holds(project_id)) with check (public.abo_code_holds(project_id));
-- Its jobs: read and marked.
drop policy if exists code_jobs_code_ticket on public.code_jobs;
create policy code_jobs_code_ticket on public.code_jobs for all to anon
  using (public.abo_code_holds(project_id)) with check (public.abo_code_holds(project_id));
-- Its store: which one, never its tokens (the same columns an owner may read, 0046).
do $$
declare v_cols text;
begin
  select string_agg(quote_ident(column_name), ', ' order by ordinal_position) into v_cols
    from information_schema.columns
   where table_schema = 'public' and table_name = 'stores'
     and column_name not in ('access_token', 'refresh_token', 'oauth_state');
  execute format('grant select (%s) on public.stores to anon', v_cols);
end $$;
drop policy if exists stores_code_ticket on public.stores;
create policy stores_code_ticket on public.stores for select to anon using (public.abo_code_holds(project_id));
-- Its store's rows: read, through the store's views as the owner reads them.
do $$
declare t text;
begin
  foreach t in array array[
    'abandoned_checkouts', 'collection_products', 'collections', 'customers', 'discounts',
    'draft_order_line_items', 'draft_orders', 'fulfillments', 'inventory_levels', 'locations',
    'order_line_items', 'order_transactions', 'orders', 'payouts', 'products', 'refunds',
    'return_line_items', 'returns', 'variants'
  ] loop
    if to_regclass('public.' || t) is not null then
      execute format('drop policy if exists %I on public.%I', t || '_code_ticket', t);
      execute format(
        'create policy %I on public.%I for select to anon using (public.abo_code_holds_store(store_id))',
        t || '_code_ticket', t
      );
    end if;
  end loop;
  -- The views are security_invoker: anon sees through them only the rows the policies above allow.
  foreach t in array array[
    'store_orders', 'store_customers', 'store_products', 'store_inventory', 'product_sales', 'store_order_items',
    'store_refunds', 'store_variants', 'store_fulfillments', 'store_transactions', 'store_locations',
    'store_collections', 'store_abandoned_checkouts', 'store_draft_orders', 'store_draft_order_items',
    'store_discounts', 'store_returns', 'return_reasons'
  ] loop
    if to_regclass('public.' || t) is not null then
      execute format('grant select on public.%I to anon', t);
    end if;
  end loop;
end $$;

-- ── Who may call what ────────────────────────────────────────────

revoke all on function public.abo_code_mint(uuid, integer) from public, anon, authenticated;
revoke all on function public.abo_code_dispatch(uuid) from public, anon, authenticated;
revoke all on function public.abo_code_tick() from public, anon, authenticated;
revoke all on function public.abo_code_schedule() from public, anon, authenticated;
revoke all on function public.abo_code_on_store_row() from public, anon, authenticated;
-- The ticket's own doors: each checks the ticket itself.
revoke all on function public.abo_code_holds(uuid) from public;
revoke all on function public.abo_code_holds_store(uuid) from public;
revoke all on function public.abo_code_holds_module(uuid) from public;
revoke all on function public.abo_code_project() from public, authenticated;
revoke all on function public.abo_code_release() from public, authenticated;
grant execute on function public.abo_code_ticket_hash() to anon, authenticated;
grant execute on function public.abo_code_holds(uuid) to anon, authenticated;
grant execute on function public.abo_code_holds_store(uuid) to anon, authenticated;
grant execute on function public.abo_code_holds_module(uuid) to anon, authenticated;
grant execute on function public.abo_code_project() to anon;
grant execute on function public.abo_code_release() to anon;
revoke execute on function public.run_scheduled_automations() from public, anon, authenticated;

-- ── The clock ────────────────────────────────────────────────────
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('abo-code-tick', '* * * * *', 'select public.abo_code_tick()');
    perform cron.schedule('abo-code-schedule', '*/10 * * * *', 'select public.abo_code_schedule()');
  end if;
end $$;

NOTIFY pgrst, 'reload schema';
