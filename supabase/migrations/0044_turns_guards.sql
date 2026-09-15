-- Migration 0044: closing two holes I left in the allowance.
--
-- 1. The refund was free money. abo_refund_turn takes no arguments,
--    is granted to every signed-in role, and decrements the caller's
--    own counter — so a merchant, or the AI client holding their
--    token, could call it through PostgREST in a loop and never run
--    out. The route was the only thing calling it politely.
--
--    A refund now has to answer for a spend: one per spend, and only
--    while that spend is recent. You can undo the turn you just took
--    and nothing else.
--
-- 2. The spend read the count and then wrote it, which is two
--    statements and a gap. Two requests at once both read nine of
--    ten and both passed. One conditional update has no gap.
--
-- Callers: src/app/api/chat/route.ts, src/app/api/mcp/route.ts.

alter table public.account_settings
  add column if not exists last_spend_at  timestamptz,
  add column if not exists last_refund_at timestamptz;

-- Spends one, atomically.
--
-- The condition lives in the UPDATE, so the row is locked while it is
-- decided. Nothing is read first and believed afterwards.
create or replace function public.abo_spend_turn()
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_used integer; v_free integer;
begin
  if auth.uid() is null then
    raise exception 'Not signed in.' using errcode = '42501';
  end if;

  insert into public.account_settings (user_id)
  values (auth.uid())
  on conflict (user_id) do nothing;

  update public.account_settings
     set turns_used = turns_used + 1,
         last_spend_at = now(),
         updated_at = now()
   where user_id = auth.uid()
     and turns_used < free_turns
  returning turns_used, free_turns into v_used, v_free;

  if v_used is null then
    -- Nothing updated: the allowance is gone. Read it to say so.
    select turns_used, free_turns into v_used, v_free
      from public.account_settings where user_id = auth.uid();
    return jsonb_build_object('ok', false, 'used', v_used, 'free', v_free);
  end if;

  return jsonb_build_object('ok', true, 'used', v_used, 'free', v_free);
end $$;

-- It answers with more than a number now, so the old one goes first.
drop function if exists public.abo_refund_turn();

-- Gives one back, once, for a turn just taken.
--
-- Refunding is right when our engine could not finish — that is our
-- failure, not their prompt. It is not a button anybody may press.
create or replace function public.abo_refund_turn()
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_used integer;
begin
  if auth.uid() is null then
    raise exception 'Not signed in.' using errcode = '42501';
  end if;

  update public.account_settings
     set turns_used = greatest(turns_used - 1, 0),
         last_refund_at = now(),
         updated_at = now()
   where user_id = auth.uid()
     and turns_used > 0
     and last_spend_at is not null
     -- One refund per spend…
     and (last_refund_at is null or last_refund_at < last_spend_at)
     -- …and only for a spend that just happened. A turn takes seconds;
     -- anything older is somebody trying their luck.
     and last_spend_at > now() - interval '5 minutes'
  returning turns_used into v_used;

  return jsonb_build_object('refunded', v_used is not null, 'used', v_used);
end $$;

revoke all on function public.abo_spend_turn() from public;
revoke all on function public.abo_refund_turn() from public;
grant execute on function public.abo_spend_turn() to authenticated;
grant execute on function public.abo_refund_turn() to authenticated;

NOTIFY pgrst, 'reload schema';
