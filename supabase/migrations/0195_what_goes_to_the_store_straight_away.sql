-- Migration 0195: what goes to the store straight away, and who said so
--
-- Tanish (7 Oct): changing stock on many rows at once, and "auto pushing
-- to Shopify should be optional in settings". Every change to a store has
-- waited for the owner's yes in the bell (0107), and abo_action_approve
-- said unattended changes would get their own switch, turned on by
-- somebody who knows that is what they are doing. This is that switch:
-- one per kind of change and per store, off until the owner turns it on,
-- with the words they read kept beside their yes.
--
--   stores.auto_send        the kinds of change (store-actions.ts keys) the
--                           owner sends straight to that store when they
--                           make them on a list's screen.
--   store_send_consents     every on and every off: who, when, which store,
--                           which change, and the words they read. Only
--                           ever added to.
--   abo_set_auto_send       the one way to flip it: the owner, in
--                           Warmluke, never their own AI.
--   abo_action_send_now     the owner's own change, asked from the screen a
--                           moment ago, of a kind they turned on: approved
--                           as their yes. Nothing else is.
--
-- A teammate who can open the store may now ask for a change too: it
-- waits for the owner's yes like any other, and they can read what they
-- asked for. What Luke or their own AI asks for waits whatever the switch
-- says; it covers the owner's own changes.
--
-- abo_action_propose is 0107's, as the database has it, with a teammate
-- let in and the owner's account switch read for the project rather than
-- the caller's: a teammate's own account was never turned on for a store
-- that is not theirs.

alter table public.stores add column if not exists auto_send text[] not null default '{}';
-- Read column by column on this table, which holds the shop's token: a
-- column not granted fails the whole read, and every store list read as
-- empty (caught walking it, 7 Oct).
grant select (auto_send) on public.stores to authenticated;

create table if not exists public.store_send_consents (
  id         uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  store_id   uuid not null references public.stores(id) on delete cascade,
  user_id    uuid not null references auth.users(id) on delete cascade,
  action     text not null,
  turned_on  boolean not null,
  said       text not null,
  created_at timestamptz not null default now()
);
create index if not exists store_send_consents_store on public.store_send_consents (store_id, created_at desc);

alter table public.store_send_consents enable row level security;
drop policy if exists store_send_consents_owner_read on public.store_send_consents;
create policy store_send_consents_owner_read on public.store_send_consents
  for select to authenticated using (public.abo_owns(project_id));
-- No write of the table itself: abo_set_auto_send is the way in.
drop policy if exists store_send_consents_oauth_no_insert on public.store_send_consents;
create policy store_send_consents_oauth_no_insert on public.store_send_consents
  as restrictive for insert to authenticated with check (not public.abo_is_oauth_client());
drop policy if exists store_send_consents_oauth_no_update on public.store_send_consents;
create policy store_send_consents_oauth_no_update on public.store_send_consents
  as restrictive for update to authenticated using (not public.abo_is_oauth_client());
drop policy if exists store_send_consents_oauth_no_delete on public.store_send_consents;
create policy store_send_consents_oauth_no_delete on public.store_send_consents
  as restrictive for delete to authenticated using (not public.abo_is_oauth_client());

-- A teammate reads what they asked for (the owner reads all, 0107).
drop policy if exists store_actions_asker_read on public.store_actions;
create policy store_actions_asker_read on public.store_actions
  for select to authenticated using (requested_by = auth.uid());

-- Whether changing this project's store is turned on for its owner's
-- account (0107's switch), to anyone who can open the store.
create or replace function public.abo_store_actions_on(p_project uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select public.abo_can_open_store(p_project)
     and coalesce((select a.store_actions_enabled
                     from public.account_settings a
                     join public.projects p on p.owner_id = a.user_id
                    where p.id = p_project), false);
$$;

create or replace function public.abo_action_propose(
  p_project uuid,
  p_store   uuid,
  p_action  text,
  p_targets jsonb,
  p_params  jsonb,
  p_summary text
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_id uuid; v_client text := nullif(auth.jwt() ->> 'client_id', '');
begin
  if auth.uid() is null then
    raise exception 'Not signed in.' using errcode = '42501';
  end if;
  -- The owner, or a teammate who can open the store (0140): a teammate's
  -- waits for the owner's yes, which only the owner gives.
  if not public.abo_can_open_store(p_project) then
    raise exception 'Not your project.' using errcode = '42501';
  end if;
  if not public.abo_store_actions_on(p_project) then
    raise exception 'Changing the store from Warmluke is not turned on for this account.'
      using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.stores s
     where s.id = p_store and s.project_id = p_project and s.status = 'connected'
  ) then
    raise exception 'No connected store of theirs has that id.' using errcode = '22023';
  end if;
  if coalesce(trim(p_summary), '') = '' then
    raise exception 'An action nobody can read is an action nobody can agree to.'
      using errcode = '22023';
  end if;

  insert into public.store_actions
    (project_id, store_id, requested_by, client_id, action, targets, params, summary)
  values
    (p_project, p_store, auth.uid(), v_client, p_action,
     coalesce(p_targets, '[]'::jsonb), coalesce(p_params, '{}'::jsonb), trim(p_summary))
  returning id into v_id;
  return v_id;
end $$;

create or replace function public.abo_set_auto_send(
  p_store  uuid,
  p_action text,
  p_on     boolean,
  p_said   text
) returns text[]
language plpgsql security definer set search_path = public as $$
declare v_project uuid; v_was text[]; v_now text[];
begin
  if auth.uid() is null then
    raise exception 'Not signed in.' using errcode = '42501';
  end if;
  -- In Warmluke, by the owner: never their own AI, which could otherwise
  -- turn on the very thing that lets its changes through.
  if nullif(auth.jwt() ->> 'client_id', '') is not null then
    raise exception 'Only the owner turns this on, in Warmluke.' using errcode = '42501';
  end if;
  select s.project_id, s.auto_send into v_project, v_was from public.stores s where s.id = p_store;
  if v_project is null or not public.abo_owns(v_project) then
    raise exception 'Not your store.' using errcode = '42501';
  end if;
  if coalesce(p_action, '') !~ '^[a-z_]+$' then
    raise exception 'There is no such change.' using errcode = '22023';
  end if;
  if p_on and coalesce(btrim(p_said), '') = '' then
    raise exception 'Turned on with nothing read is not a yes.' using errcode = '22023';
  end if;
  -- Said again as it already is: nothing to write, and nothing to record.
  if (p_action = any (v_was)) = coalesce(p_on, false) then
    return v_was;
  end if;
  v_now := case when p_on then array(select distinct x from unnest(v_was || p_action) x order by 1)
                else array_remove(v_was, p_action) end;
  update public.stores set auto_send = v_now where id = p_store;
  insert into public.store_send_consents (project_id, store_id, user_id, action, turned_on, said)
  values (v_project, p_store, auth.uid(), p_action, coalesce(p_on, false),
          coalesce(nullif(btrim(p_said), ''), 'Turned off.'));
  return v_now;
end $$;

create or replace function public.abo_action_send_now(p_action uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_n integer;
begin
  if auth.uid() is null then
    raise exception 'Not signed in.' using errcode = '42501';
  end if;
  if nullif(auth.jwt() ->> 'client_id', '') is not null then
    return jsonb_build_object('approved', false, 'reason', 'only the merchant sends a change to their store, in Warmluke');
  end if;
  -- Their own, asked a moment ago from the screen, of a kind they turned
  -- on for that store: a card left waiting in the bell is agreed to there.
  update public.store_actions a
     set status      = 'approved',
         approved_at = now(),
         approved_by = auth.uid()
   where a.id = p_action
     and a.status = 'pending'
     and a.requested_by = auth.uid()
     and a.client_id is null
     and a.created_at > now() - interval '2 minutes'
     and public.abo_owns(a.project_id)
     and exists (select 1 from public.stores s
                  where s.id = a.store_id and s.status = 'connected' and a.action = any (s.auto_send));
  get diagnostics v_n = row_count;
  return case when v_n > 0
    then jsonb_build_object('approved', true)
    else jsonb_build_object('approved', false, 'reason', 'it waits for a yes')
  end;
end $$;

revoke all on function public.abo_store_actions_on(uuid) from public, anon;
revoke all on function public.abo_action_propose(uuid, uuid, text, jsonb, jsonb, text) from public, anon;
revoke all on function public.abo_set_auto_send(uuid, text, boolean, text) from public, anon;
revoke all on function public.abo_action_send_now(uuid) from public, anon;
grant execute on function public.abo_store_actions_on(uuid) to authenticated;
grant execute on function public.abo_action_propose(uuid, uuid, text, jsonb, jsonb, text) to authenticated;
grant execute on function public.abo_set_auto_send(uuid, text, boolean, text) to authenticated;
grant execute on function public.abo_action_send_now(uuid) to authenticated;

notify pgrst, 'reload schema';
