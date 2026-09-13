-- Migration 0020: completing a Shopify connection
--
-- Shopify redirects the merchant's browser back to us, and a redirect
-- carries no Authorization header — so the callback has no session to
-- act as. The state nonce is the proof instead: it exists only because
-- a signed-in owner asked for it minutes earlier, and it is spent here.
--
-- security definer so the callback needs no service-role key on the
-- server. The only row it can reach is the one holding this exact,
-- unexpired state.
create or replace function public.abo_shopify_connect(
  p_state    text,
  p_token    text,
  p_timezone text,
  p_currency text,
  p_country  text
) returns uuid
language plpgsql security definer set search_path = public as $$
declare v_project uuid;
begin
  update public.stores
     set access_token           = p_token,
         timezone               = coalesce(p_timezone, 'UTC'),
         currency               = coalesce(p_currency, 'INR'),
         country                = p_country,
         status                 = 'connected',
         connected_at           = now(),
         -- Spent. A captured callback replayed later finds nothing.
         oauth_state            = null,
         oauth_state_expires_at = null
   where oauth_state = p_state
     and oauth_state_expires_at > now()
   returning project_id into v_project;

  return v_project;  -- null: unknown, already used, or expired
end $$;

revoke all on function public.abo_shopify_connect(text, text, text, text, text) from public;
grant execute on function public.abo_shopify_connect(text, text, text, text, text) to anon, authenticated;

NOTIFY pgrst, 'reload schema';
