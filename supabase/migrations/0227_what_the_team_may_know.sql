-- Migration 0227: what the team may know (16 Oct, the sprint's Days 3–5)
--
-- What Luke knows about a business has been the owner's alone since 0140:
-- a teammate's turn read none of it, so Luke talking to whoever packs did
-- not know who packs, how long a restock takes, or the returns policy.
-- The sprint separates store-shared operating knowledge from the owner's
-- private preferences: the lines the work stands on (who does what,
-- hours, lead times, thresholds, policies, constraints, what they sell)
-- are read by anyone the project is shared with; goals, preferences and
-- whatever else Luke learned in the owner's chats stay the owner's.
--
-- Read only, through this function: the table's own rule is unchanged,
-- so a teammate still neither lists nor strikes a line.

create or replace function public.abo_shared_facts(p_project uuid)
returns table (note text, kind text, topic text, source text, created_at timestamptz)
language plpgsql stable security definer set search_path = public as $$
begin
  if p_project is null or not public.abo_can_use(p_project) then
    return;
  end if;
  return query
    select n.note, n.kind, n.topic, n.source, n.created_at
      from public.merchant_notes n
     where n.project_id = p_project
       and n.kind in ('team', 'hours', 'lead_time', 'threshold', 'policy', 'constraint', 'product')
     order by n.created_at desc
     limit 60;
end $$;
revoke all on function public.abo_shared_facts(uuid) from public, anon;
grant execute on function public.abo_shared_facts(uuid) to authenticated;

notify pgrst, 'reload schema';
