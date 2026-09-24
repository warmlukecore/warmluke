-- The database's own helpers are its own.
--
-- Supabase grants EXECUTE on every new function in public to anon and
-- authenticated. For a function that checks who is asking, that is the
-- door it was built with. For one written to be called from inside the
-- database, by a trigger or a cron job, it is a door nobody meant to cut,
-- and six were open to anyone holding the public key:
--
--   abo_run_actions              an automation's actions, run as the
--                                database, so past row-level security:
--                                any project's records could be rewritten.
--   run_scheduled_automations    every project's scheduled automations,
--                                run on demand, as often as asked.
--   abo_shopify_customer_redact_email
--                                a store's customers, drafts and carts
--                                deleted, knowing only its shop address
--                                and an email.
--   abo_shopify_webhook_token    a store's webhook address token, derived
--                                from the app secret. Webhooks still need
--                                Shopify's signature, but a secret's child
--                                is not for handing out.
--   abo_customers_lock           an advisory lock, harmless, still not
--                                the public's.
--   abo_mcp_calls_prune          a log sweep, the same.
--
-- Every function that calls these is itself security definer and runs as
-- the owner, and the cron jobs run as postgres, so closing them to the
-- public key changes nothing that uses them. check-cart-redaction calls
-- the redaction with the service role, which keeps it.
--
-- The store views were readable by anon too. They are security_invoker,
-- so anon saw no rows through them; now it cannot ask either.
--
-- check-definer-grants holds the rule from here on: a security definer
-- function the public key can run either checks its caller or is on the
-- short list of doors guarded some other way (a signature, a ticket).
--
-- Callers: none from the app; see above.

revoke execute on function public.abo_run_actions(uuid, jsonb, uuid, uuid, jsonb, jsonb, jsonb) from public, anon, authenticated;
revoke execute on function public.run_scheduled_automations() from public, anon, authenticated;
revoke execute on function public.abo_shopify_customer_redact_email(text, text) from public, anon, authenticated;
revoke execute on function public.abo_shopify_webhook_token(text) from public, anon, authenticated;
revoke execute on function public.abo_customers_lock(uuid) from public, anon, authenticated;
revoke execute on function public.abo_mcp_calls_prune() from public, anon, authenticated;

grant execute on function public.abo_shopify_customer_redact_email(text, text) to service_role;

do $$
declare v record;
begin
  for v in
    select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'v'
  loop
    execute format('revoke select on public.%I from anon', v.relname);
  end loop;
end $$;

NOTIFY pgrst, 'reload schema';
