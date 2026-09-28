-- A section's rules run in the order they were made.
--
-- Both loops that run a section's rules (on a row's change, 0130; on the
-- clock, 0134) read them in no order, so two rules writing one field on
-- one change ended as whichever the table happened to hand back last.
-- For months that was the order they were made; a table that had seen
-- enough rules come and go handed them back otherwise, and "stamp
-- packed" beat the newer "status and packed" (check-own-fields, CI).
-- Now the newer rule runs later, and on a shared field it wins.
--
-- The two functions are 0130's and 0134's with an order by, nothing else.

create or replace function public.run_record_automations()
returns trigger as $$
declare
  auto record;
  v_source text;
  v_store  jsonb := '{}'::jsonb;
  rec_data jsonb;
  old_data jsonb;
  ctx jsonb := jsonb_build_object('module_id', new.module_id, 'record_id', new.id);
begin
  if pg_trigger_depth() > 1 then
    return new;
  end if;

  -- Beside a store row: the store's fields under the merchant's, the
  -- store's winning a shared name, as withOwnFields lays them out.
  if new.store_row_id is not null then
    select m.source_table into v_source from public.modules m where m.id = new.module_id;
    v_store := public.abo_store_row(v_source, new.store_row_id);
  end if;
  rec_data := coalesce(new.data, '{}'::jsonb) || v_store || jsonb_build_object('id', new.id);
  old_data := case when TG_OP = 'UPDATE'
                   then coalesce(old.data, '{}'::jsonb) || v_store || jsonb_build_object('id', new.id)
                   else '{}'::jsonb end;

  for auto in
    select * from public.automations a
    where a.enabled and a.module_id = new.module_id
    order by a.created_at, a.id
  loop
    begin
      if (auto.definition->'trigger'->>'type') = 'record_created' then
        -- Fields kept beside a store row are not a row somebody made.
        if TG_OP <> 'INSERT' or new.store_row_id is not null then continue; end if;
      elsif (auto.definition->'trigger'->>'type') = 'record_updated' then
        -- Beside a store row, the first field kept is a change to a row
        -- that was already there: "when packed" fires on the first tick.
        if TG_OP <> 'UPDATE' and new.store_row_id is null then continue; end if;
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
    order by a.created_at, a.id
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

NOTIFY pgrst, 'reload schema';
