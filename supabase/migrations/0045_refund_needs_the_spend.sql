-- Migration 0045: a refund has to name the turn it is undoing.
--
-- 0044 stopped the refund LOOP — one refund per spend — and I called
-- that closed. It was not. One per spend is exactly enough: the turn
-- succeeds, the merchant gets their design, and then they call
-- abo_refund_turn() through PostgREST and the counter goes back where
-- it was. Ten free builds meant unlimited builds.
--
-- The hole was never the loop. It was that the function took no
-- arguments and was granted to everyone signed in, so anybody could
-- claim a refund they had no business claiming.
--
-- Now a spend hands back an id nobody can guess, and a refund is only
-- given for that id. The id never leaves the server: /api/chat and
-- /api/mcp hold it for the length of one request and use it only when
-- our own engine failed. The merchant's browser never sees it.
--
-- Spending directly through PostgREST is still allowed and still
-- pointless — it burns a turn to learn an id that refunds that same
-- turn. Net zero, and no model ran.
--
-- Callers: src/app/api/chat/route.ts, src/app/api/mcp/route.ts.

alter table public.account_settings
  add column if not exists last_spend_id uuid;

comment on column public.account_settings.last_spend_id is
  'The turn a refund may still undo. Server-side only; never sent to a browser.';

-- Spends one, atomically, and says which one.
create or replace function public.abo_spend_turn()
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_used integer; v_free integer; v_id uuid := gen_random_uuid();
begin
  if auth.uid() is null then
    raise exception 'Not signed in.' using errcode = '42501';
  end if;

  insert into public.account_settings (user_id)
  values (auth.uid())
  on conflict (user_id) do nothing;

  -- The condition lives in the UPDATE, so the row is locked while it
  -- is decided. Nothing is read first and believed afterwards.
  update public.account_settings
     set turns_used    = turns_used + 1,
         last_spend_at = now(),
         last_spend_id = v_id,
         -- A new spend is not refunded yet, whatever the last one was.
         last_refund_at = null,
         updated_at    = now()
   where user_id = auth.uid()
     and turns_used < free_turns
  returning turns_used, free_turns into v_used, v_free;

  if v_used is null then
    select turns_used, free_turns into v_used, v_free
      from public.account_settings where user_id = auth.uid();
    return jsonb_build_object('ok', false, 'used', v_used, 'free', v_free);
  end if;

  return jsonb_build_object('ok', true, 'used', v_used, 'free', v_free, 'spend_id', v_id);
end $$;

-- The old one took no arguments. Nothing may keep calling it.
drop function if exists public.abo_refund_turn();

-- Gives back the turn whose id this is, once.
--
-- Refunding is right when our engine could not finish — that is our
-- failure, not their prompt. Knowing the id is what proves the caller
-- is the server that spent it.
create or replace function public.abo_refund_turn(p_spend uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_used integer;
begin
  if auth.uid() is null then
    raise exception 'Not signed in.' using errcode = '42501';
  end if;
  if p_spend is null then
    return jsonb_build_object('refunded', false);
  end if;

  update public.account_settings
     set turns_used     = greatest(turns_used - 1, 0),
         last_refund_at = now(),
         updated_at     = now()
   where user_id = auth.uid()
     and turns_used > 0
     and last_spend_id = p_spend
     -- One refund per spend…
     and last_refund_at is null
     -- …and only for a spend that just happened. A turn takes seconds;
     -- anything older is somebody trying their luck.
     and last_spend_at > now() - interval '5 minutes'
  returning turns_used into v_used;

  return jsonb_build_object('refunded', v_used is not null, 'used', v_used);
end $$;

revoke all on function public.abo_spend_turn() from public;
revoke all on function public.abo_refund_turn(uuid) from public;
grant execute on function public.abo_spend_turn() to authenticated;
grant execute on function public.abo_refund_turn(uuid) to authenticated;

NOTIFY pgrst, 'reload schema';
