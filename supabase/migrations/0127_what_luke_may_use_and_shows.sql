-- What Luke may use, and what it shows, for each account.
--
-- Luke answers on one model, the one the server is set to, and nobody
-- sees what a reply cost. Now the owner can pick a model in the panel,
-- and under each reply see which model answered, the tokens it took,
-- and what that came to in dollars and rupees. Both are the
-- administrator's to decide per account, as the other switches are:
--
--   luke_models  the models they may pick; null is every model on
--                offer. Enforced by the chat route, not only the
--                panel: a model not on the list is never used, even
--                when a request names it.
--   luke_shows   what each reply says under it: nothing, the model,
--                the model and its tokens, or all that and the cost.
--
-- Both are written only by abo_admin_set_luke, and read by the owner
-- through account_settings_own_read, as the other switches are.

alter table public.account_settings
  add column if not exists luke_models text[],
  add column if not exists luke_shows text not null default 'cost';

alter table public.account_settings drop constraint if exists account_settings_luke_shows_known;
alter table public.account_settings add constraint account_settings_luke_shows_known
  check (luke_shows in ('nothing', 'model', 'tokens', 'cost'));

-- A list with nothing on it would leave the account no model at all;
-- that is chat_enabled's job, said by its own switch.
alter table public.account_settings drop constraint if exists account_settings_luke_models_shape;
alter table public.account_settings add constraint account_settings_luke_models_shape
  check (luke_models is null or (cardinality(luke_models) between 1 and 50 and array_position(luke_models, null) is null));

alter table public.admin_account_audit drop constraint if exists admin_account_audit_action_allowed;
alter table public.admin_account_audit add constraint admin_account_audit_action_allowed check (
  action in ('set_feature', 'set_turns', 'set_unlimited', 'reset_turns', 'suspend', 'restore', 'delete', 'set_luke')
);

-- ── Set ───────────────────────────────────────────────────────────
create or replace function public.abo_admin_set_luke(
  p_user   uuid,
  p_models text[],
  p_shows  text
) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_before jsonb;
  v_after  jsonb := jsonb_build_object('models', to_jsonb(p_models), 'shows', p_shows);
begin
  if not public.abo_is_superadmin() then
    raise exception 'Not an administrator.' using errcode = '42501';
  end if;
  if p_shows is null or p_shows not in ('nothing', 'model', 'tokens', 'cost') then
    raise exception 'Unknown choice of what Luke shows.' using errcode = '22023';
  end if;
  if p_models is not null and (
    cardinality(p_models) not between 1 and 50
    or exists (select 1 from unnest(p_models) m where m is null or m !~ '^[A-Za-z0-9._:-]{1,100}$')
  ) then
    raise exception 'A list of models is one to fifty model names.' using errcode = '22023';
  end if;

  insert into public.account_settings (user_id)
  values (p_user)
  on conflict (user_id) do nothing;

  select jsonb_build_object('models', to_jsonb(luke_models), 'shows', luke_shows)
    into v_before
    from public.account_settings
   where user_id = p_user
   for update;

  update public.account_settings
     set luke_models = p_models,
         luke_shows  = p_shows,
         updated_at  = now()
   where user_id = p_user;

  if v_before is distinct from v_after then
    insert into public.admin_account_audit (
      actor_user_id, target_user_id, action, old_value, new_value
    ) values (auth.uid(), p_user, 'set_luke', v_before, v_after);
  end if;
end $$;

-- ── Read, for the account's dialog ────────────────────────────────
-- An account with no settings row yet has the defaults: every model,
-- and everything shown.
create or replace function public.abo_admin_luke(p_user uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_out jsonb;
begin
  if not public.abo_is_superadmin() then
    raise exception 'Not an administrator.' using errcode = '42501';
  end if;
  select jsonb_build_object('models', to_jsonb(luke_models), 'shows', luke_shows)
    into v_out
    from public.account_settings
   where user_id = p_user;
  return coalesce(v_out, jsonb_build_object('models', null, 'shows', 'cost'));
end $$;

revoke all on function public.abo_admin_set_luke(uuid, text[], text) from public, anon;
revoke all on function public.abo_admin_luke(uuid) from public, anon;
grant execute on function public.abo_admin_set_luke(uuid, text[], text) to authenticated;
grant execute on function public.abo_admin_luke(uuid) to authenticated;

NOTIFY pgrst, 'reload schema';
