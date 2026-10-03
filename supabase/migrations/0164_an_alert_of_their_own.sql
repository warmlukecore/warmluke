-- Migration 0164: an alert of their own
--
-- What Luke watches on its own (0163) is four things. What a merchant
-- wants to be told is theirs: "tell me when a COD order over ₹5,000
-- comes in", "when a customer returns a third time", "when a product
-- has not sold in ten days". Luke writes each as a rule, and a rule can
-- now say so: the action { "type": "alert", "title": "…", "show": [fields],
-- "severity": "attention" | "critical" } raises an alert in the same
-- bell and on the same Overview.
--
--   added, changed       a row of theirs added or changed: told once a
--                        row, there until it is put away
--   store_row_added      a row the store brings in (a new order), told the
--                        moment it arrives; never during the first import
--   schedule             looked at every hour or day: open while the row
--                        matches, closed once it no longer does
--
-- A rule's alert is seen by whoever sees its section, and its store rows
-- where it sits over the store; deleting the rule takes its alerts with
-- it, turning it off hides them. At most 50 open a rule.

-- ── A kind raised by a rule, not found by a check ───────────
alter table public.alert_kinds alter column check_fn drop not null;
insert into public.alert_kinds (kind, area, needs, check_fn, defaults, sort_order)
values ('rule', 'Your alerts', '{}', null, '{}', 100)
on conflict (kind) do update set area = excluded.area, needs = excluded.needs, check_fn = null, defaults = excluded.defaults;

alter table public.alerts alter column store_id drop not null;
alter table public.alerts add column if not exists automation_id uuid references public.automations (id) on delete cascade;
-- When a rule last raised it: what a schedule did not raise again has gone.
alter table public.alerts add column if not exists raised_at timestamptz not null default now();
create unique index if not exists alerts_rule_subject on public.alerts (automation_id, subject) where automation_id is not null;

-- Who sees an alert: the store's people for what Luke found; for a
-- rule's, whoever sees the rule's section (0145), and the store too
-- where the section sits over it.
create or replace function public.abo_can_see_alert(p_project uuid, p_automation uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select case
    when p_automation is null then public.abo_can_open_store(p_project)
    else exists (
      select 1 from public.automations au
        join public.modules m on m.id = au.module_id
       where au.id = p_automation and m.project_id = p_project
         and public.abo_can_see_module(m.id)
         and (m.source_table is null or public.abo_can_open_store(p_project)))
  end
$$;
revoke all on function public.abo_can_see_alert(uuid, uuid) from public, anon;
grant execute on function public.abo_can_see_alert(uuid, uuid) to authenticated;

drop policy if exists alerts_read on public.alerts;
create policy alerts_read on public.alerts for select to authenticated
  using (public.abo_can_see_alert(project_id, automation_id));

-- ── Raising one ─────────────────────────────────────────────
-- The rule's title, and up to four of the row's fields as they read on
-- it. Raised again while open, its numbers move and the bell stays
-- quiet; raised again after it closed, it opens fresh.
create or replace function public.abo_rule_alert(p_auto uuid, p_project uuid, p_subject text, p_row jsonb, p_act jsonb)
returns void
language plpgsql security definer set search_path = public as $$
declare
  v_title  text := left(nullif(btrim(coalesce(p_act->>'title', '')), ''), 120);
  v_sev    text := case when p_act->>'severity' = 'critical' then 'critical' else 'attention' end;
  v_values jsonb;
  v_name   text;
begin
  if v_title is null or p_subject is null then
    return;
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('field', x.f, 'value', left(p_row->>x.f, 120)) order by x.o), '[]'::jsonb)
    into v_values
    from jsonb_array_elements_text(case when jsonb_typeof(p_act->'show') = 'array' then p_act->'show' else '[]'::jsonb end)
         with ordinality as x(f, o)
   where x.o <= 4 and coalesce(p_row->>x.f, '') <> '';
  -- ponytail: 50 open a rule; a rule that matches every row says so 50
  -- times, not 5,000. A digest ("and 120 more") when one needs more.
  if not exists (select 1 from public.alerts where automation_id = p_auto and subject = p_subject)
     and (select count(*) from public.alerts where automation_id = p_auto and status = 'open') >= 50 then
    return;
  end if;
  -- The rule's own project: a row of theirs does not always carry one.
  select name, coalesce(p_project, project_id) into v_name, p_project from public.automations where id = p_auto;
  insert into public.alerts (project_id, store_id, kind, subject, severity, facts, automation_id, raised_at)
  values (p_project, null, 'rule', left(p_subject, 200), v_sev,
          jsonb_build_object('title', v_title, 'rule', v_name, 'values', v_values), p_auto, now())
  on conflict (automation_id, subject) where automation_id is not null do update
    set severity        = excluded.severity,
        facts           = excluded.facts,
        raised_at       = now(),
        status          = 'open',
        resolved_at     = null,
        opened_at       = case when alerts.status = 'resolved' then now() else alerts.opened_at end,
        changed_at      = case when alerts.status = 'resolved'
                                 or (alerts.severity = 'attention' and excluded.severity = 'critical')
                               then now() else alerts.changed_at end,
        conversation_id = case when alerts.status = 'resolved' then null else alerts.conversation_id end;
end $$;
revoke all on function public.abo_rule_alert(uuid, uuid, text, jsonb, jsonb) from public, anon, authenticated;

-- ── The rules' runner, with the new action ──────────────────
-- 0133's, and "alert": the row it is about is the store's row where
-- there is one (the order), else the row of theirs.
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
                  on conflict (module_id, store_row_id) where store_row_id is not null
                  do update set data = public.records.data || excluded.data, updated_at = now();
                  touched := touched + 1;
                end if;
              end loop;
            exception when undefined_column or undefined_table then
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

    elsif act->>'type' = 'alert' then
      perform public.abo_rule_alert(auto_id, project, coalesce(ctx->>'store_row_id', rec_id::text), rec, act);
      insert into public.automation_runs(automation_id, record_id, ok, detail)
      values (auto_id, rec_id, true, jsonb_build_object('action', 'alert'));

    elsif act->>'type' = 'webhook' then
      insert into public.automation_runs(automation_id, record_id, ok, detail)
      values (auto_id, rec_id, true,
              jsonb_build_object('action', 'webhook', 'url', act->>'url', 'queued', true));
    end if;
  end loop;
end;
$$ language plpgsql security definer;
revoke execute on function public.abo_run_actions(uuid, jsonb, uuid, uuid, jsonb, jsonb, jsonb) from public, anon, authenticated;

-- ── A schedule's alerts close when their rows stop matching ─
-- 0162's runner, with two changes for a rule that only tells: it lays no
-- empty record beside each store row it matches, and once it has looked
-- at every row, what it did not raise again is closed.
CREATE OR REPLACE FUNCTION public.run_scheduled_automations()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
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
  v_tells boolean;
  v_only_tells boolean;
begin
  for auto in
    select a.*, m.source_table, m.project_id as module_project
    from public.automations a
    join public.modules m on m.id = a.module_id
    where a.enabled and (a.definition->'trigger'->>'type') = 'schedule'
      and not (coalesce(a.definition->'actions', '[]'::jsonb) @> '[{"type": "run_code"}]'::jsonb)
    order by a.created_at, a.id
  loop
    if not public.abo_schedule_due(
         auto.definition->'trigger', public.abo_rule_tz(auto.module_project), auto.scheduled_at, auto.created_at
       ) then
      continue;
    end if;
    update public.automations set scheduled_at = now() where id = auto.id;
    v_tells := coalesce(auto.definition->'actions', '[]'::jsonb) @> '[{"type": "alert"}]'::jsonb;
    v_only_tells := v_tells and not exists (
      select 1 from jsonb_array_elements(coalesce(auto.definition->'actions', '[]'::jsonb)) x where x->>'type' <> 'alert');
    begin
      v_source := auto.source_table;
      v_project := auto.module_project;
      perform set_config('abo.today', public.abo_shop_today(v_project), true);
      if v_source is null then
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
          -- A rule that only tells writes nothing, so it needs no record to write to.
          if v_rec_id is null and not v_only_tells then
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
      -- Raised again by this look stay; the rest no longer match.
      if v_tells then
        update public.alerts set status = 'resolved', resolved_at = now(), changed_at = now()
         where automation_id = auto.id and status = 'open' and raised_at < now();
      end if;
    exception when others then
      insert into public.automation_runs(automation_id, record_id, ok, detail)
      values (auto.id, null, false, jsonb_build_object('error', sqlerrm));
    end;
  end loop;
end;
$function$;

-- ── A row the store brings in, told the moment it arrives ───
-- 0134's trigger, which queued a rule's code for each new store row;
-- now a rule that tells is judged here and then, by the database. Not
-- while the store's first import runs: a shop's history is not news.
-- ponytail: judged on the row as it stands when it is written (an
-- order before its lines); a rule needing the lines runs on a schedule.
create or replace function public.abo_code_on_store_row()
returns trigger
language plpgsql security definer set search_path = public as $$
declare
  v_project uuid;
  v_synced  timestamptz;
  a record;
  v_row jsonb;
  v_ctx jsonb;
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

  for a in
    select au.id, au.module_id, au.definition, m.source_table from public.automations au
      join public.modules m on m.id = au.module_id
     where m.project_id = v_project
       and m.source_table = public.abo_code_source(TG_TABLE_NAME)
       and au.enabled
       and au.definition->'trigger'->>'type' = 'store_row_added'
       and coalesce(au.definition->'actions', '[]'::jsonb) @> '[{"type": "alert"}]'::jsonb
     order by au.created_at, au.id
  loop
    -- A rule that cannot be judged is written down, and the store's row is still saved.
    begin
      perform set_config('abo.today', public.abo_shop_today(v_project), true);
      v_row := public.abo_store_row(a.source_table, new.id) || jsonb_build_object('id', new.id);
      v_ctx := jsonb_build_object('module_id', a.module_id, 'store_row_id', new.id);
      if a.definition->'trigger' ? 'when'
         and not public.abo_bool(public.abo_eval(a.definition->'trigger'->'when', v_row, '{}'::jsonb, '{}'::jsonb, v_ctx)) then
        continue;
      end if;
      perform public.abo_run_actions(
        a.id,
        (select coalesce(jsonb_agg(x), '[]'::jsonb) from jsonb_array_elements(a.definition->'actions') x where x->>'type' = 'alert'),
        null, v_project, v_row, '{}'::jsonb, v_ctx);
    exception when others then
      insert into public.automation_runs(automation_id, record_id, ok, detail)
      values (a.id, null, false, jsonb_build_object('error', sqlerrm));
    end;
  end loop;
  return new;
end $$;

-- ── 0163's functions, with rules' alerts in them ────────────
-- The runner looks only at kinds a check finds.
create or replace function public.abo_alerts_run(p_store uuid default null) returns integer
language plpgsql security definer set search_path = public as $$
declare
  st      record;
  k       record;
  r       record;
  v_found text[];
  n       integer := 0;
begin
  for st in
    select s.id, s.project_id from public.stores s
     where s.status = 'connected' and (p_store is null or s.id = p_store)
  loop
    if not pg_try_advisory_xact_lock(hashtextextended('abo_alerts:' || st.id::text, 0)) then
      continue;
    end if;
    for k in
      select ak.kind, ak.needs, ak.check_fn,
             coalesce(se.enabled, true) as enabled,
             ak.defaults || coalesce(se.settings, '{}'::jsonb) as settings
        from public.alert_kinds ak
        left join public.alert_settings se on se.project_id = st.project_id and se.kind = ak.kind
       where ak.check_fn is not null
       order by ak.sort_order
    loop
      if not k.enabled then
        update public.alerts set status = 'resolved', resolved_at = now(), changed_at = now()
         where store_id = st.id and kind = k.kind and status = 'open';
        continue;
      end if;
      if not public.abo_alert_ready(st.id, k.needs) then
        continue;
      end if;
      v_found := '{}';
      begin
        for r in execute format('select subject, severity, facts from public.%I($1, $2)', k.check_fn)
          using st.id, k.settings
        loop
          insert into public.alerts (project_id, store_id, kind, subject, severity, facts)
          values (st.project_id, st.id, k.kind, r.subject, r.severity, r.facts)
          on conflict (store_id, kind, subject) do update
            set severity        = excluded.severity,
                facts           = excluded.facts,
                status          = 'open',
                resolved_at     = null,
                opened_at       = case when alerts.status = 'resolved' then now() else alerts.opened_at end,
                changed_at      = case when alerts.status = 'resolved'
                                         or (alerts.severity = 'attention' and excluded.severity = 'critical')
                                       then now() else alerts.changed_at end,
                conversation_id = case when alerts.status = 'resolved' then null else alerts.conversation_id end
          where (alerts.status, alerts.severity, alerts.facts)
                is distinct from ('open'::text, excluded.severity, excluded.facts);
          v_found := v_found || r.subject;
          n := n + 1;
        end loop;
        update public.alerts set status = 'resolved', resolved_at = now(), changed_at = now()
         where store_id = st.id and kind = k.kind and status = 'open' and not (subject = any (v_found));
      exception when others then
        raise warning 'alert % on store %: %', k.kind, st.id, sqlerrm;
      end;
    end loop;
    delete from public.alert_dirty where store_id = st.id;
  end loop;
  return n;
end $$;
revoke all on function public.abo_alerts_run(uuid) from public, anon, authenticated;

-- What is open for this person: Luke's where the store is open to them,
-- a rule's where its section is, and not one of a rule turned off.
create or replace function public.abo_alerts(p_project uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
begin
  if p_project is null or not public.abo_can_use(p_project) then
    raise exception 'No such project on this account.' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', a.id, 'kind', a.kind, 'subject', a.subject, 'severity', a.severity, 'facts', a.facts,
             'opened_at', a.opened_at, 'changed_at', a.changed_at, 'conversation_id', a.conversation_id,
             'rule_id', a.automation_id,
             'read', coalesce(ar.read_at >= a.changed_at, false))
           order by (a.severity = 'critical') desc, a.changed_at desc)
      from public.alerts a
      left join public.stores s on s.id = a.store_id
      left join public.automations au on au.id = a.automation_id
      left join public.alert_reads ar on ar.alert_id = a.id and ar.user_id = auth.uid()
     where a.project_id = p_project and a.status = 'open'
       -- A store taken off Shopify is looked at no more: what it had open is not today's.
       and (a.store_id is null or s.status = 'connected')
       and (a.automation_id is null or au.enabled)
       and public.abo_can_see_alert(a.project_id, a.automation_id)
       and not coalesce(ar.dismissed_at >= a.changed_at, false)), '[]'::jsonb);
end $$;
revoke all on function public.abo_alerts(uuid) from public, anon;
grant execute on function public.abo_alerts(uuid) to authenticated;

create or replace function public.abo_alerts_seen(p_alerts uuid[], p_dismiss boolean default false) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null or public.abo_is_oauth_client() then
    raise exception 'Not from here.' using errcode = '42501';
  end if;
  insert into public.alert_reads (alert_id, user_id, read_at, dismissed_at)
  select a.id, auth.uid(), now(), case when p_dismiss then now() end
    from public.alerts a
   where a.id = any (p_alerts) and public.abo_can_see_alert(a.project_id, a.automation_id)
  on conflict (alert_id, user_id) do update
    set read_at = now(),
        dismissed_at = case when p_dismiss then now() else alert_reads.dismissed_at end;
end $$;
revoke all on function public.abo_alerts_seen(uuid[], boolean) from public, anon;
grant execute on function public.abo_alerts_seen(uuid[], boolean) to authenticated;

create or replace function public.abo_alert_link(p_alert uuid, p_conversation uuid) returns boolean
language plpgsql security definer set search_path = public as $$
declare
  v_project uuid;
  v_rule    uuid;
begin
  select a.project_id, a.automation_id into v_project, v_rule from public.alerts a where a.id = p_alert;
  if v_project is null or not public.abo_can_see_alert(v_project, v_rule) or public.abo_is_oauth_client() then
    raise exception 'No such alert.' using errcode = '42501';
  end if;
  if not exists (select 1 from public.conversations c where c.id = p_conversation and c.project_id = v_project) then
    raise exception 'That conversation is not this project''s.' using errcode = '22023';
  end if;
  update public.alerts set conversation_id = p_conversation
   where id = p_alert and conversation_id is null;
  return found;
end $$;
revoke all on function public.abo_alert_link(uuid, uuid) from public, anon;
grant execute on function public.abo_alert_link(uuid, uuid) to authenticated;

-- What Luke watches, with whether the project has chosen yet: a rule's
-- alerts are switched with their rule, so they are not listed.
create or replace function public.abo_alert_settings(p_project uuid) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_store uuid;
begin
  if p_project is null or not public.abo_can_open_store(p_project) then
    raise exception 'No such project on this account.' using errcode = '42501';
  end if;
  select s.id into v_store from public.stores s where s.project_id = p_project and s.status = 'connected';
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'kind', ak.kind, 'area', ak.area, 'needs', to_jsonb(ak.needs),
             'enabled', coalesce(se.enabled, true), 'defaults', ak.defaults,
             'settings', ak.defaults || coalesce(se.settings, '{}'::jsonb),
             'ready', v_store is not null and public.abo_alert_ready(v_store, ak.needs),
             'chosen', se.project_id is not null)
           order by ak.sort_order)
      from public.alert_kinds ak
      left join public.alert_settings se on se.project_id = p_project and se.kind = ak.kind
     where ak.check_fn is not null), '[]'::jsonb);
end $$;
revoke all on function public.abo_alert_settings(uuid) from public, anon;
grant execute on function public.abo_alert_settings(uuid) to authenticated;

create or replace function public.abo_set_alert_setting(p_project uuid, p_kind text, p_enabled boolean, p_settings jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_defaults jsonb;
  k          text;
  v          jsonb;
  v_store    uuid;
begin
  if p_project is null or not public.abo_can_build(p_project) or public.abo_is_oauth_client() then
    raise exception 'Only someone who builds here can change what Luke watches.' using errcode = '42501';
  end if;
  select defaults into v_defaults from public.alert_kinds where kind = p_kind and check_fn is not null;
  if v_defaults is null then
    raise exception 'No such kind of alert.' using errcode = '22023';
  end if;
  if p_enabled is null or p_settings is null or jsonb_typeof(p_settings) <> 'object' then
    raise exception 'Say whether it is on, and its settings.' using errcode = '22023';
  end if;
  for k, v in select key, value from jsonb_each(p_settings) loop
    if not v_defaults ? k then
      raise exception '"%" is not a setting of this alert.', k using errcode = '22023';
    end if;
    if jsonb_typeof(v) <> 'number' or (v #>> '{}')::numeric not between 0 and 10000 then
      raise exception '"%" is a number from 0 to 10000.', k using errcode = '22023';
    end if;
  end loop;
  insert into public.alert_settings (project_id, kind, enabled, settings, updated_at, updated_by)
  values (p_project, p_kind, p_enabled, p_settings, now(), auth.uid())
  on conflict (project_id, kind) do update
    set enabled = excluded.enabled, settings = excluded.settings, updated_at = now(), updated_by = auth.uid();
  select s.id into v_store from public.stores s where s.project_id = p_project and s.status = 'connected';
  if v_store is not null then
    perform public.abo_alerts_run(v_store);
  end if;
  return public.abo_alert_settings(p_project);
end $$;
revoke all on function public.abo_set_alert_setting(uuid, text, boolean, jsonb) from public, anon;
grant execute on function public.abo_set_alert_setting(uuid, text, boolean, jsonb) to authenticated;

NOTIFY pgrst, 'reload schema';
