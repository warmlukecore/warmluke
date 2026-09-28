-- A rule keeps the merchant's own field on a store row.
--
-- "When every line of an order is scanned, mark the order packed" was a
-- rule nobody could write. A rule writing another section found its row
-- by a field inside that section's records (0012); a section over the
-- store keeps its facts in the store's list, not in records, so the
-- order was never found, and the validator refused the rule outright.
--
-- Now a rule writing a section over the store finds the store's row by
-- one of the store's own fields (the order's number), and keeps what it
-- writes beside that row, as a button or a scan already does (0128):
-- made the first time, merged after. The store's own fields are never
-- written, whatever the rule names. Rows of the project's own store only.

create or replace function public.abo_run_actions(
  auto_id uuid,
  actions jsonb,
  rec_id uuid,
  project uuid,
  rec jsonb,
  prev jsonb,
  ctx jsonb default '{}'::jsonb
) returns void as $$
declare
  act jsonb;
  tgt record;
  patch jsonb;
  touched integer;
  match_val text;
  v_target uuid;
  v_source text;
  v_view text;
  v_store_id uuid;
begin
  for act in select * from jsonb_array_elements(actions) loop
    if act->>'type' = 'set_fields' then
      if coalesce((act->'target'->>'self')::boolean, false) then
        patch := public.abo_apply_set(act->'set', rec, prev, rec, ctx);
        update public.records r set data = r.data || patch, updated_at = now()
        where r.id = rec_id;
        insert into public.automation_runs(automation_id, record_id, ok, detail)
        values (auto_id, rec_id, true, jsonb_build_object('action', 'set_fields', 'on', 'self'));
      else
        match_val := public.abo_txt(
          public.abo_eval(act->'target'->'match'->'to', rec, prev, '{}'::jsonb, ctx)
        );
        touched := 0;
        v_target := (act->'target'->>'module_id')::uuid;
        select m.source_table into v_source from public.modules m
        where m.id = v_target and m.project_id = project;
        if v_source is not null then
          -- A section over the store. Its rows are the store's, found by
          -- one of the store's own fields (an order by its number); what
          -- is written is the merchant's, kept beside the row (0128),
          -- made the first time. The store's own fields are never
          -- written: whatever the patch names of theirs is dropped.
          v_view := public.abo_store_view(v_source);
          select s.id into v_store_id from public.stores s
          where s.project_id = project and s.status in ('connected', 'uninstalled')
          limit 1;
          if v_view is not null and v_store_id is not null and match_val <> '' then
            begin
              for tgt in execute format(
                'select v.id as row_id, r.id as rec_id, coalesce(r.data, ''{}''::jsonb) as rec_data,
                        to_jsonb(v) - ''store_id'' as row_data
                   from public.%I v
                   left join public.records r on r.module_id = $2 and r.store_row_id = v.id
                  where v.store_id = $1 and v.%I::text = $3',
                v_view, act->'target'->'match'->>'field')
                using v_store_id, v_target, match_val
              loop
                patch := public.abo_apply_set(act->'set', rec, prev, tgt.row_data || tgt.rec_data, ctx);
                patch := patch - coalesce((select array_agg(k) from jsonb_object_keys(tgt.row_data) k), '{}'::text[]);
                if patch <> '{}'::jsonb then
                  insert into public.records(project_id, module_id, store_row_id, data)
                  values (project, v_target, tgt.row_id, patch)
                  -- The one-record-a-row index is partial (0128), so its predicate is named.
                  on conflict (module_id, store_row_id) where store_row_id is not null
                  do update set data = public.records.data || excluded.data, updated_at = now();
                  touched := touched + 1;
                end if;
              end loop;
            exception when undefined_column or undefined_table then
              -- A match field the store's list does not have: no row to write.
              touched := 0;
            end;
          end if;
        else
          for tgt in
            select r.id, r.data from public.records r
            where r.module_id = v_target
              and coalesce(r.data->>(act->'target'->'match'->>'field'), '') = match_val
          loop
            patch := public.abo_apply_set(act->'set', rec, prev, tgt.data, ctx);
            update public.records r set data = r.data || patch, updated_at = now()
            where r.id = tgt.id;
            touched := touched + 1;
          end loop;
        end if;
        insert into public.automation_runs(automation_id, record_id, ok, detail)
        values (auto_id, rec_id, true,
                jsonb_build_object('action', 'set_fields', 'rows', touched));
      end if;

    elsif act->>'type' = 'create_record' then
      patch := public.abo_apply_set(coalesce(act->'data', '{}'::jsonb), rec, prev, '{}'::jsonb, ctx);
      insert into public.records(project_id, module_id, data)
      values (project, (act->>'module_id')::uuid, patch);
      insert into public.automation_runs(automation_id, record_id, ok, detail)
      values (auto_id, rec_id, true, jsonb_build_object('action', 'create_record'));

    elsif act->>'type' = 'webhook' then
      insert into public.automation_runs(automation_id, record_id, ok, detail)
      values (auto_id, rec_id, true,
              jsonb_build_object('action', 'webhook', 'url', act->>'url', 'queued', true));
    end if;
  end loop;
end;
$$ language plpgsql security definer;


revoke execute on function public.abo_run_actions(uuid, jsonb, uuid, uuid, jsonb, jsonb, jsonb) from public, anon, authenticated;

NOTIFY pgrst, 'reload schema';
