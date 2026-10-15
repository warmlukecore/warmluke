-- Migration 0220: what Luke knows has a kind, a topic and a source (lib/memory)
--
-- Every line was free text, the newest twelve read and the oldest gone
-- past forty. So who packs, a supplier's lead time or the return policy
-- fell out as chat went on, a correction sat beside what it corrected,
-- and a guess read like something the owner said (sprint, 15 Oct).
--
--   kind     what the line is about: who does what (team), working hours,
--            a lead time, a threshold, a policy, a goal, a constraint, a
--            product, a preference, or another fact
--   topic    a short stable key ("lead time: blank cases"): a correction
--            on the same topic replaces the line, never sits beside it
--   source   owner (they said or typed it), data (seen in their store),
--            inferred (a guess, read as one)
--
-- The work stands on team, hours, lead times, thresholds, policy, goals
-- and constraints: those never fall out because newer chat came in.

alter table public.merchant_notes
  add column if not exists kind text not null default 'fact'
    check (kind in ('team', 'hours', 'lead_time', 'threshold', 'policy', 'goal', 'constraint', 'product', 'preference', 'fact')),
  add column if not exists topic text check (topic is null or char_length(topic) between 2 and 80),
  add column if not exists source text not null default 'owner' check (source in ('owner', 'data', 'inferred')),
  add column if not exists verified_at timestamptz not null default now();

-- One line a topic: what corrects it replaces it.
create unique index if not exists merchant_notes_one_a_topic
  on public.merchant_notes (project_id, lower(topic)) where topic is not null;

-- Forty of the rest, newest kept; what the work stands on is kept apart,
-- forty of it too, so neither crowds the other out.
create or replace function public.merchant_notes_keep_newest()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  delete from public.merchant_notes n
   where n.project_id = new.project_id
     and n.id in (
       select id from public.merchant_notes
        where project_id = new.project_id
          and (kind in ('team', 'hours', 'lead_time', 'threshold', 'policy', 'goal', 'constraint'))
            = (new.kind in ('team', 'hours', 'lead_time', 'threshold', 'policy', 'goal', 'constraint'))
        order by created_at desc, id desc
       offset 40
     );
  return null;
end $$;
revoke execute on function public.merchant_notes_keep_newest() from public, anon, authenticated;

notify pgrst, 'reload schema';
