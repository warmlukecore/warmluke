-- A row's history names its app, and 0144 took the app from the row.
-- records.project_id may be empty (the app's own writes, rules and
-- builds all set it; a direct insert need not), and record_events.project_id
-- may not, so a row saved without one was refused outright: the history
-- trigger took the save down with it (check-stats, 2026-09-30). The
-- section always knows its app, so the app is read from there when the
-- row does not say. Otherwise 0144's, unchanged.
--
-- Callers: trg_record_history on public.records (0144);
-- scripts/check-stats.mjs, scripts/check-row-history.mjs.

create or replace function public.abo_record_history()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_via text := case
    when pg_trigger_depth() > 1 then 'rule'
    when auth.uid() is null then 'system'
    else 'person'
  end;
begin
  if TG_OP = 'INSERT' then
    insert into public.record_events (record_id, module_id, project_id, actor, via, kind, before, after)
    values (new.id, new.module_id,
            coalesce(new.project_id, (select m.project_id from public.modules m where m.id = new.module_id)),
            auth.uid(), v_via, 'added', null, new.data);
  elsif TG_OP = 'UPDATE' then
    -- A save that changed nothing a person sees is not an event.
    if new.data is distinct from old.data then
      insert into public.record_events (record_id, module_id, project_id, actor, via, kind, before, after)
      values (new.id, new.module_id,
              coalesce(new.project_id, (select m.project_id from public.modules m where m.id = new.module_id)),
              auth.uid(), v_via, 'changed', old.data, new.data);
    end if;
  else
    -- A row going with its section or its app: their history goes with
    -- them (the foreign keys cascade), so nothing is written for it.
    if not exists (select 1 from public.modules m where m.id = old.module_id) then
      return old;
    end if;
    insert into public.record_events (record_id, module_id, project_id, actor, via, kind, before, after)
    values (old.id, old.module_id,
            coalesce(old.project_id, (select m.project_id from public.modules m where m.id = old.module_id)),
            auth.uid(), v_via, 'removed', old.data, null);
    return old;
  end if;
  return new;
end $$;

NOTIFY pgrst, 'reload schema';
