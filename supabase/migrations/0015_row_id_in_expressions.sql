-- Migration 0015: let a rule refer to the row that fired it.
--
-- A link column stores another row's id, so the obvious rule — "when an
-- order is refused, open a return pointing at this order" — needs the
-- order's own id. Expressions only saw the record's `data`, which has
-- no id in it, so { "field": "id" } silently evaluated to blank and the
-- new row came out unlinked.
--
-- The id is merged into the row an expression sees, under "id".

create or replace function public.run_record_automations()
returns trigger as $$
declare
  auto record;
  rec_data jsonb := coalesce(new.data, '{}'::jsonb) || jsonb_build_object('id', new.id);
  old_data jsonb := case when TG_OP = 'UPDATE'
                         then coalesce(old.data, '{}'::jsonb) || jsonb_build_object('id', new.id)
                         else '{}'::jsonb end;
  ctx jsonb := jsonb_build_object('module_id', new.module_id, 'record_id', new.id);
begin
  if pg_trigger_depth() > 1 then
    return new;
  end if;

  for auto in
    select * from public.automations a
    where a.enabled and a.module_id = new.module_id
  loop
    begin
      if (auto.definition->'trigger'->>'type') = 'record_created' then
        if TG_OP <> 'INSERT' then continue; end if;
      elsif (auto.definition->'trigger'->>'type') = 'record_updated' then
        if TG_OP <> 'UPDATE' then continue; end if;
      else
        continue;
      end if;

      if auto.definition->'trigger' ? 'when' then
        if not public.abo_bool(
             public.abo_eval(auto.definition->'trigger'->'when', rec_data, old_data, '{}'::jsonb, ctx)
           ) then
          continue;
        end if;
      end if;

      perform public.abo_run_actions(
        auto.id, coalesce(auto.definition->'actions', '[]'::jsonb),
        new.id, new.project_id, rec_data, old_data, ctx
      );

    exception when others then
      insert into public.automation_runs(automation_id, record_id, ok, detail)
      values (auto.id, new.id, false, jsonb_build_object('error', sqlerrm));
    end;
  end loop;
  return new;
end;
$$ language plpgsql security definer;

create or replace function public.run_scheduled_automations()
returns void as $$
declare
  auto record;
  target record;
  ctx jsonb;
  rec_data jsonb;
begin
  for auto in
    select * from public.automations a
    where a.enabled and (a.definition->'trigger'->>'type') = 'schedule'
  loop
    begin
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
    exception when others then
      insert into public.automation_runs(automation_id, record_id, ok, detail)
      values (auto.id, null, false, jsonb_build_object('error', sqlerrm));
    end;
  end loop;
end;
$$ language plpgsql security definer;

NOTIFY pgrst, 'reload schema';
