-- Migration 0046: the Shopify token stops being something you can read.
--
-- stores_member_read (0018) is `for select using (abo_can_use(...))`,
-- and access_token and refresh_token are columns on that same table.
-- RLS decides ROWS. It has never decided columns. So anyone holding a
-- seat on the project could ask PostgREST for the token directly, and
-- 0028 says in its own comment that reads are untouched — which means
-- a connected AI client could ask for it too.
--
-- That token is worse than anything else in the database. With it you
-- talk to Shopify as the merchant, from anywhere, and none of our
-- revoking touches you: kill the client's Supabase session and the
-- Shopify access it copied still works.
--
-- Column privileges are the thing that does decide columns. A
-- table-wide GRANT cannot have a column revoked out of it, so the
-- table grant goes and comes back naming every column but the
-- secrets.
--
-- ponytail: this pins the safe columns as they are today. A column
-- added to stores later will be unreadable until it is added to this
-- grant — a confusing failure, but one that fails closed, which is the
-- right side to fail on for this table.
--
-- Callers: src/app/dashboard/page.tsx, src/app/api/shopify/import/route.ts.

do $$
declare v_cols text;
begin
  select string_agg(quote_ident(column_name), ', ' order by ordinal_position)
    into v_cols
    from information_schema.columns
   where table_schema = 'public'
     and table_name   = 'stores'
     -- oauth_state joins them: it is the secret that completes a
     -- connect, and nothing in the app has ever read it back.
     and column_name not in ('access_token', 'refresh_token', 'oauth_state');

  execute 'revoke select on public.stores from anon, authenticated';
  execute format('grant select (%s) on public.stores to authenticated', v_cols);
  -- anon reads no store at all; it never legitimately did.
end $$;

-- The one caller that genuinely needs the token: the import, running
-- on the server, on behalf of the owner who started it.
--
-- security definer, so it is not subject to the grant above — which is
-- exactly why it has to say no to everyone else itself.
create or replace function public.abo_store_token(p_store uuid)
returns table (
  access_token             text,
  refresh_token            text,
  token_expires_at         timestamptz,
  refresh_token_expires_at timestamptz
)
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then
    raise exception 'Not signed in.' using errcode = '42501';
  end if;
  -- A merchant's own assistant runs an import for them; it does not
  -- get to keep the key to their shop.
  if public.abo_is_oauth_client() then
    raise exception 'A connected client cannot read the store token.' using errcode = '42501';
  end if;

  return query
    select s.access_token, s.refresh_token, s.token_expires_at, s.refresh_token_expires_at
      from public.stores s
     where s.id = p_store
       -- Owner only. Staff import nothing; they read what came out.
       and public.abo_owns(s.project_id);
end $$;

revoke all on function public.abo_store_token(uuid) from public;
grant execute on function public.abo_store_token(uuid) to authenticated;

NOTIFY pgrst, 'reload schema';
