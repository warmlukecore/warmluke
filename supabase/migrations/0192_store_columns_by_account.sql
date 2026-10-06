-- What an account sees of its store's lists (6 Oct). An administrator
-- chooses, per list (orders, customers, stock, products …), which of the
-- store's own columns the account is shown: every column (no row, the
-- default), or the ones ticked. The rows are still read whole; what is
-- left out is not shown in the app, not offered to build on, and not
-- told to Luke or to the account's own AI. It holds for every app the
-- account owns, and for its teammates there.
--
-- A change is written down like every other administrator's act
-- (admin_account_audit, action "set_columns").
--
-- Callers: src/components/AccountDetail.tsx (abo_admin_store_columns,
-- abo_admin_set_store_columns); src/lib/store-columns.ts
-- (abo_store_columns), read by the app, Luke and the MCP route.

create table if not exists public.account_store_columns (
  user_id     uuid not null references auth.users(id) on delete cascade,
  store_table text not null check (store_table ~ '^[a-z_]{1,40}$'),
  shown       text[] not null,
  set_by      uuid references auth.users(id) on delete set null,
  set_at      timestamptz not null default now(),
  primary key (user_id, store_table)
);

alter table public.account_store_columns enable row level security;
drop policy if exists account_store_columns_admin_read on public.account_store_columns;
create policy account_store_columns_admin_read on public.account_store_columns
  for select to authenticated using (public.abo_is_superadmin());
-- No write of the table itself: abo_admin_set_store_columns is the way in.
drop policy if exists account_store_columns_oauth_no_insert on public.account_store_columns;
create policy account_store_columns_oauth_no_insert on public.account_store_columns
  as restrictive for insert to authenticated with check (not public.abo_is_oauth_client());
drop policy if exists account_store_columns_oauth_no_update on public.account_store_columns;
create policy account_store_columns_oauth_no_update on public.account_store_columns
  as restrictive for update to authenticated using (not public.abo_is_oauth_client());
drop policy if exists account_store_columns_oauth_no_delete on public.account_store_columns;
create policy account_store_columns_oauth_no_delete on public.account_store_columns
  as restrictive for delete to authenticated using (not public.abo_is_oauth_client());

alter table public.admin_account_audit drop constraint if exists admin_account_audit_action_allowed;
alter table public.admin_account_audit add constraint admin_account_audit_action_allowed check (
  action in ('set_feature', 'set_turns', 'set_unlimited', 'reset_turns', 'suspend', 'restore', 'delete', 'set_luke',
             'set_tester', 'view_conversation', 'rename', 'set_columns')
);

-- An app's lists as its owner's account is shown them: { "<list>": [fields] }
-- for each list narrowed, nothing for a list shown whole. For anyone who
-- may use the app, their own AI included.
create or replace function public.abo_store_columns(p_project uuid)
returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_object_agg(c.store_table, to_jsonb(c.shown)), '{}'::jsonb)
    from public.projects p
    join public.account_store_columns c on c.user_id = p.owner_id
   where p.id = p_project and public.abo_can_use(p_project)
$$;
revoke all on function public.abo_store_columns(uuid) from public, anon;
grant execute on function public.abo_store_columns(uuid) to authenticated;

-- The same, of any account, for an administrator.
create or replace function public.abo_admin_store_columns(p_user uuid)
returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if not public.abo_is_superadmin() then
    raise exception 'Not an administrator.' using errcode = '42501';
  end if;
  return (select coalesce(jsonb_object_agg(store_table, to_jsonb(shown)), '{}'::jsonb)
            from public.account_store_columns where user_id = p_user);
end $$;
revoke all on function public.abo_admin_store_columns(uuid) from public, anon;
grant execute on function public.abo_admin_store_columns(uuid) to authenticated;

-- An administrator's choice for one list of one account: the fields to
-- show, or null for every column. The app says which fields a list has;
-- here they are only checked to be names, and at least one.
create or replace function public.abo_admin_set_store_columns(p_user uuid, p_table text, p_shown text[] default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_old   text[];
  v_shown text[];
begin
  if not public.abo_is_superadmin() then
    raise exception 'Not an administrator.' using errcode = '42501';
  end if;
  if not exists (select 1 from auth.users where id = p_user) then
    raise exception 'No such account.' using errcode = 'P0002';
  end if;
  if p_table is null or p_table !~ '^[a-z_]{1,40}$' then
    raise exception 'Not a list of the store.' using errcode = '22023';
  end if;
  select array(select distinct f from unnest(coalesce(p_shown, '{}'::text[])) f
                where f ~ '^[a-z_][a-z0-9_]{0,62}$' order by f)
    into v_shown;
  if p_shown is not null and cardinality(v_shown) = 0 then
    raise exception 'Keep at least one column, or choose every column.' using errcode = '22023';
  end if;
  select shown into v_old from public.account_store_columns where user_id = p_user and store_table = p_table;
  if p_shown is null then
    delete from public.account_store_columns where user_id = p_user and store_table = p_table;
  else
    insert into public.account_store_columns (user_id, store_table, shown, set_by)
    values (p_user, p_table, v_shown, auth.uid())
    on conflict (user_id, store_table) do update
      set shown = excluded.shown, set_by = excluded.set_by, set_at = now();
  end if;
  if v_old is distinct from (case when p_shown is null then null else v_shown end) then
    insert into public.admin_account_audit (actor_user_id, target_user_id, action, old_value, new_value)
    values (auth.uid(), p_user, 'set_columns',
            jsonb_build_object('list', p_table, 'shown', to_jsonb(v_old)),
            jsonb_build_object('list', p_table, 'shown',
                               case when p_shown is null then null else to_jsonb(v_shown) end));
  end if;
  return public.abo_admin_store_columns(p_user);
end $$;
revoke all on function public.abo_admin_set_store_columns(uuid, text, text[]) from public, anon;
grant execute on function public.abo_admin_set_store_columns(uuid, text, text[]) to authenticated;

notify pgrst, 'reload schema';
