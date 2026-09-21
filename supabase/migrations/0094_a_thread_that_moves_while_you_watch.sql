-- Migration 0094: a thread that moves while you watch, and a prompt
-- the merchant can correct.
--
-- Two things the chat panel could not do.
--
-- One: a build approved inside Claude writes its two lines through
-- abo_log_client_build (0079) and they appeared in the app only after
-- a refresh. Realtime publishes modules, ui_schemas, records and
-- build_requests (0034) — so the SECTION appeared at once and the
-- request card appeared at once, and the conversation that explains
-- them sat still. The merchant watched their app change with no word
-- about why. Every writer of a message bumps its conversation's
-- updated_at, so publishing conversations is the whole signal; the
-- browser reloads the thread it names.
--
-- Two: a merchant who mistyped a prompt could not correct it. They
-- could only type it again, leaving the wrong question and its wrong
-- answer standing as if both still meant something. Editing now
-- retires the mistake and everything said in reply to it — kept, not
-- deleted, because a thread that quietly loses what happened is not a
-- record. SECURITY INVOKER on purpose: row-level security decides
-- whose messages these are, and the OAuth write wall (0070) keeps a
-- connected client from retiring anything at all.
--
-- Callers: src/lib/live.ts (watchRows) through src/components/AppShell.tsx,
-- which subscribes to conversations for the open project and calls
-- abo_supersede_from when a prompt is edited in src/components/ChatPanel.tsx.

do $$
begin
  -- alter publication has no "if not exists"; adding a table twice is
  -- an error, so each one is asked about first (0034).
  if not exists (select 1 from pg_publication_tables
                  where pubname = 'supabase_realtime' and tablename = 'conversations') then
    alter publication supabase_realtime add table public.conversations;
  end if;
end $$;

-- Retires a prompt and everything answered after it.
--
-- From the message itself, not from a timestamp the browser supplies:
-- the caller knows which bubble was edited and nothing else, and a
-- clock it sent would be its own.
create or replace function public.abo_supersede_from(p_message uuid)
returns integer
language plpgsql security invoker set search_path = public as $$
declare
  v_thread uuid;
  v_at     timestamptz;
  v_count  integer;
begin
  select conversation_id, created_at into v_thread, v_at
    from public.messages where id = p_message;
  -- Not found, or not theirs to see. Either way there is nothing to
  -- retire, and saying which it was would answer a question the
  -- caller has no business asking.
  if v_thread is null then return 0; end if;

  update public.messages
     set payload = coalesce(payload, '{}'::jsonb) || jsonb_build_object('superseded', true)
   where conversation_id = v_thread
     and created_at >= v_at;

  get diagnostics v_count = row_count;

  -- The thread moved, so anyone watching it reloads — including the
  -- second tab where the merchant is reading the same conversation.
  update public.conversations set updated_at = now() where id = v_thread;
  return v_count;
end $$;

revoke all on function public.abo_supersede_from(uuid) from public;
grant execute on function public.abo_supersede_from(uuid) to authenticated;

NOTIFY pgrst, 'reload schema';
