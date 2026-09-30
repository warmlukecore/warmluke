-- A save lands on the row it saw, or says what changed.
--
-- An edit read the row, merged the change in the app and wrote the
-- whole row back. Two people saving the same row at once, even
-- different fields of it, each wrote back the fields they had read, so
-- one of them lost the other's change without a word. And one changing
-- a field somebody else had just changed wrote over it unseen.
--
-- abo_record_patch does it in one step, in the database: the row is
-- locked as it is read, only the fields sent are changed, and when the
-- caller says what it saw (p_expected), a field that has changed since,
-- to something other than what is being saved, refuses the save and
-- says what it is now. Saving what the row already holds is not a
-- clash, so the same save sent twice (a double tap, a resend after the
-- connection dropped) lands once and is answered as landed.
-- ponytail: no retry key; add one when a write stops being the same
-- when repeated (a count moved by an amount, not set to one).
--
-- It runs as the caller: their row policies, the guards (0143), the
-- stamps and the history (0144) all hold as for any other update.
--
-- Callers: src/lib/record-write.ts (update, update_store_row);
-- scripts/check-row-edits.mjs.

create or replace function public.abo_record_patch(
  p_record   uuid,
  p_patch    jsonb,
  p_expected jsonb default null
) returns jsonb
language plpgsql security invoker set search_path = public as $$
declare
  v_before jsonb;
  v_clash  jsonb;
begin
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then
    raise exception 'A change is a set of fields.' using errcode = '22023';
  end if;
  if p_expected is not null and jsonb_typeof(p_expected) <> 'object' then
    raise exception 'What was seen is a set of fields.' using errcode = '22023';
  end if;

  -- Locked as it is read: nobody's save lands between this look and the write.
  select coalesce(data, '{}'::jsonb) into v_before
    from public.records where id = p_record
     for update;
  if not found then
    return jsonb_build_object('status', 'missing');
  end if;

  if p_expected is not null then
    select jsonb_object_agg(e.key, coalesce(v_before -> e.key, 'null'::jsonb)) into v_clash
      from jsonb_each(p_expected) e
     where coalesce(v_before -> e.key, 'null'::jsonb) <> e.value
       and coalesce(v_before -> e.key, 'null'::jsonb) is distinct from (p_patch -> e.key);
    if v_clash is not null then
      return jsonb_build_object('status', 'conflict', 'now', v_clash);
    end if;
  end if;

  update public.records
     set data = v_before || p_patch, updated_at = now()
   where id = p_record;
  return jsonb_build_object('status', 'applied', 'before', v_before);
end $$;

revoke all on function public.abo_record_patch(uuid, jsonb, jsonb) from public, anon;
grant execute on function public.abo_record_patch(uuid, jsonb, jsonb) to authenticated;

NOTIFY pgrst, 'reload schema';
