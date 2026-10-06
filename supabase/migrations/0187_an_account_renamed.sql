-- An account renamed from the console (6 Oct): the person's name and
-- their business as onboarding took them (profiles, 0112), and the
-- names of the apps they own (projects). An administrator fixes a typo
-- or a business that changed its name without asking the owner to.
--
-- What changed is written down like every other administrator's act
-- (admin_account_audit, action "rename"), the names before and after,
-- and nothing is written when nothing changed. Blank leaves a name as it
-- is; an app that is not theirs is passed over.
--
-- Callers: src/components/AccountDetail.tsx.

alter table public.admin_account_audit drop constraint if exists admin_account_audit_action_allowed;
alter table public.admin_account_audit add constraint admin_account_audit_action_allowed check (
  action in ('set_feature', 'set_turns', 'set_unlimited', 'reset_turns', 'suspend', 'restore', 'delete', 'set_luke',
             'set_tester', 'view_conversation', 'rename')
);

create or replace function public.abo_admin_rename(
  p_user uuid,
  p_full_name text default null,
  p_business text default null,
  p_apps jsonb default '[]'::jsonb
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_name     text := nullif(btrim(coalesce(p_full_name, '')), '');
  v_business text := nullif(btrim(coalesce(p_business, '')), '');
  v_old      jsonb := '{}'::jsonb;
  v_new      jsonb := '{}'::jsonb;
  v_was      record;
  v_app      record;
begin
  perform public.abo_admin_may_manage(p_user);
  if length(v_name) > 120 then
    raise exception 'A name is at most 120 characters.' using errcode = '22023';
  end if;
  if length(v_business) > 160 then
    raise exception 'A business name is at most 160 characters.' using errcode = '22023';
  end if;
  if jsonb_typeof(coalesce(p_apps, '[]'::jsonb)) <> 'array' then
    raise exception 'Apps come as a list of {id, name}.' using errcode = '22023';
  end if;

  select full_name, business_name into v_was from public.profiles where user_id = p_user for update;
  if found then
    if v_name is not null and v_name is distinct from v_was.full_name then
      v_old := v_old || jsonb_build_object('full_name', v_was.full_name);
      v_new := v_new || jsonb_build_object('full_name', v_name);
    end if;
    if v_business is not null and v_business is distinct from v_was.business_name then
      v_old := v_old || jsonb_build_object('business_name', v_was.business_name);
      v_new := v_new || jsonb_build_object('business_name', v_business);
    end if;
    update public.profiles
       set full_name = coalesce(v_name, full_name),
           business_name = coalesce(v_business, business_name)
     where user_id = p_user;
  end if;

  -- Each app they own whose name is given and different.
  for v_app in
    select p.id, p.name as was, nullif(btrim(a->>'name'), '') as want
      from jsonb_array_elements(coalesce(p_apps, '[]'::jsonb)) a
      join public.projects p
        on p.id::text = a->>'id' and p.owner_id = p_user
  loop
    continue when v_app.want is null or v_app.want = v_app.was;
    if length(v_app.want) > 120 then
      raise exception 'An app name is at most 120 characters.' using errcode = '22023';
    end if;
    update public.projects set name = v_app.want where id = v_app.id;
    v_old := jsonb_set(v_old, '{apps}', coalesce(v_old->'apps', '{}'::jsonb) || jsonb_build_object(v_app.id::text, v_app.was));
    v_new := jsonb_set(v_new, '{apps}', coalesce(v_new->'apps', '{}'::jsonb) || jsonb_build_object(v_app.id::text, v_app.want));
  end loop;

  if v_new <> '{}'::jsonb then
    insert into public.admin_account_audit (actor_user_id, target_user_id, action, old_value, new_value)
    values (auth.uid(), p_user, 'rename', v_old, v_new);
  end if;
  return v_new;
end $$;
revoke all on function public.abo_admin_rename(uuid, text, text, jsonb) from public, anon;
grant execute on function public.abo_admin_rename(uuid, text, text, jsonb) to authenticated;

NOTIFY pgrst, 'reload schema';
