-- Migration 0038: what an assistant asked for, and how often.
--
-- /api/mcp had no ceiling of any kind. The chat route counts its turns
-- because each one costs a model call; the MCP tools cost database
-- reads instead, which is cheaper per call and unbounded per hour — a
-- client stuck in a loop is a bill nobody agreed to.
--
-- The same row answers the other question a merchant will ask: what
-- has my AI been doing. One table, because a rate limiter that
-- forgets and an audit log that counts nothing are the same table
-- written twice.
--
-- Callers: src/app/api/mcp/route.ts.

create table if not exists public.mcp_calls (
  id         bigint generated always as identity primary key,
  user_id    uuid not null references auth.users(id) on delete cascade,
  -- Which assistant, from the token's own claim rather than anything
  -- a caller told us. Null when the app itself is calling.
  client_id  text,
  tool       text not null,
  created_at timestamptz not null default now()
);

-- The rate-limit question is always "this user, this last hour".
create index if not exists idx_mcp_calls_recent
  on public.mcp_calls(user_id, created_at desc);

alter table public.mcp_calls enable row level security;

-- Readable by whoever made them, so the app can show it. Never
-- writable from outside: the row is the record of a call, and one a
-- caller could forge or delete would be no record at all.
drop policy if exists "mcp_calls_own_read" on public.mcp_calls;
create policy "mcp_calls_own_read" on public.mcp_calls
  for select using (user_id = auth.uid());

-- Records a call and says whether it was allowed.
--
-- Counts before inserting, so a refusal does not pay for itself by
-- filling the table it is counting.
create or replace function public.abo_mcp_call(p_tool text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_recent integer;
  v_limit  integer := 300;
begin
  if auth.uid() is null then
    raise exception 'Not signed in.' using errcode = '42501';
  end if;

  select count(*) into v_recent
    from public.mcp_calls
   where user_id = auth.uid()
     and created_at > now() - interval '1 hour';

  if v_recent >= v_limit then
    return jsonb_build_object('ok', false, 'used', v_recent, 'limit', v_limit);
  end if;

  insert into public.mcp_calls (user_id, client_id, tool)
  values (auth.uid(), nullif(auth.jwt() ->> 'client_id', ''), left(coalesce(p_tool, '?'), 60));

  return jsonb_build_object('ok', true, 'used', v_recent + 1, 'limit', v_limit);
end $$;

revoke all on function public.abo_mcp_call(text) from public;
grant execute on function public.abo_mcp_call(text) to authenticated;

-- Old rows answer neither question. Kept long enough to be useful to
-- a merchant looking back at the week, and no longer.
create or replace function public.abo_mcp_calls_prune()
returns integer
language plpgsql security definer set search_path = public as $$
declare v_n integer;
begin
  delete from public.mcp_calls where created_at < now() - interval '30 days';
  get diagnostics v_n = row_count;
  return v_n;
end $$;

NOTIFY pgrst, 'reload schema';
