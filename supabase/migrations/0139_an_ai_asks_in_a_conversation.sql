-- Migration 0139: what the merchant's own AI asks for is a conversation
-- in Luke's panel, and runs as Luke's turn does.
--
-- propose_change designed inside one request and kept only a finished
-- design. Past its wait the rest ran on after the answer, where a
-- question back, a failure or a five-minute timeout was dropped with a
-- log line: no request, no build, nothing in the app, and the assistant
-- told to look in pending_changes for something that would never be
-- there. On 2026-09-29 three packing-screen asks from ChatGPT ended so.
--
-- Now each ask opens (or carries on) a thread in the project, marked
-- with the assistant that asked, and runs as a durable Luke turn. Its
-- answer's line holds whatever it ended in: a design (built or waiting),
-- a question for the merchant, or why it failed; and the assistant's own
-- answer beside it, for when it comes back.
--
-- A connected client's token may not write conversations or messages
-- (0028, restrictive). These two write for it, as the definer, scoped
-- to the caller's own project and to threads that client started. The
-- line can be filled only once, and only as an answer, a question, a
-- failure or a build: never as a design card, so nothing a client sends
-- here can put a plan in front of the merchant's Build button.
--
-- Callers: src/app/api/mcp/route.ts (propose_change), src/lib/turn-run.ts.

alter table public.conversations
  add column if not exists asked_by text,
  add column if not exists asked_client uuid;

comment on column public.conversations.asked_by is
  'The assistant that started this thread over MCP (its registered name), or null for the owner''s own.';

-- The question kept, and the line its answer fills. A new thread, or the
-- one this client started before (its questions answered in it).
create or replace function public.abo_client_ask(
  p_project uuid,
  p_request text,
  p_conversation uuid default null
) returns jsonb
language plpgsql security definer set search_path = public, auth as $$
declare
  v_client uuid := nullif(auth.jwt() ->> 'client_id', '')::uuid;
  v_name   text;
  v_said   text := btrim(coalesce(p_request, ''));
  v_thread uuid;
  v_asked  uuid;
  v_answer uuid;
  v_t      timestamptz := clock_timestamp();
  v_again_thread uuid;
  v_again_asked  uuid;
  v_again_answer uuid;
  v_again_at     timestamptz;
begin
  if auth.uid() is null then
    raise exception 'Not signed in.' using errcode = '42501';
  end if;
  if not public.abo_owns(p_project) then
    raise exception 'Not your project.' using errcode = '42501';
  end if;
  if v_said = '' then
    raise exception 'Say what they want built.' using errcode = '22023';
  end if;
  v_said := left(v_said, 8000);

  select nullif(btrim(c.client_name), '') into v_name from auth.oauth_clients c where c.id = v_client;
  v_name := coalesce(v_name, 'Your AI');

  -- The same words from the same assistant, moments after it asked them,
  -- are a retry, not a new ask: ChatGPT asked for one packing screen
  -- three times in six minutes on 2026-09-29. It is handed the ask it
  -- already made, being answered or answered, rather than a second
  -- design of the same thing. One that failed or was stopped is asked anew.
  select m.conversation_id, m.id, a.id, m.created_at
    into v_again_thread, v_again_asked, v_again_answer, v_again_at
    from public.messages m
    join public.conversations c on c.id = m.conversation_id
    join lateral (
      select x.id, x.payload
        from public.messages x
       where x.conversation_id = m.conversation_id
         and x.role = 'assistant'
         and x.created_at > m.created_at
       order by x.created_at asc
       limit 1
    ) a on true
   where c.project_id = p_project
     and c.asked_by is not null
     and c.asked_client is not distinct from v_client
     and (p_conversation is null or c.id = p_conversation)
     and m.role = 'user'
     and m.payload ->> 'via' = 'client'
     and m.payload ->> 'text' = v_said
     and m.created_at > now() - interval '30 minutes'
     and coalesce(a.payload ->> 'type', '') not in ('unanswered', 'stopped')
   order by m.created_at desc
   limit 1;
  if v_again_thread is not null then
    return jsonb_build_object(
      'conversation_id', v_again_thread,
      'asked_id', v_again_asked,
      'answer_id', v_again_answer,
      'asked_at', v_again_at,
      'by', v_name,
      'new', false,
      'again', true
    );
  end if;

  if p_conversation is not null then
    select c.id into v_thread
      from public.conversations c
     where c.id = p_conversation
       and c.project_id = p_project
       and c.asked_by is not null
       and c.asked_client is not distinct from v_client;
    if v_thread is null then
      raise exception 'That conversation was not started by this assistant in this app.' using errcode = '42501';
    end if;
  else
    insert into public.conversations (project_id, title, asked_by, asked_client)
    values (p_project, left(v_said, 80), v_name, v_client)
    returning id into v_thread;
  end if;

  -- A millisecond apart, so the question sorts above its answer.
  insert into public.messages (conversation_id, role, content, payload, created_at)
  values (v_thread, 'user', v_said,
          jsonb_build_object('kind', 'user', 'text', v_said, 'via', 'client', 'by', v_name), v_t)
  returning id into v_asked;
  insert into public.messages (conversation_id, role, content, payload, created_at)
  values (v_thread, 'assistant', '',
          jsonb_build_object('type', 'answering', 'started_at', v_t), v_t + interval '1 millisecond')
  returning id into v_answer;
  update public.conversations set updated_at = now() where id = v_thread;

  return jsonb_build_object(
    'conversation_id', v_thread,
    'asked_id', v_asked,
    'answer_id', v_answer,
    'asked_at', v_t,
    'by', v_name,
    'new', p_conversation is null
  );
end $$;

-- The answer's line filled, once. False when it was stopped or already
-- filled, so the caller knows its answer was not kept.
create or replace function public.abo_client_settle(
  p_answer  uuid,
  p_payload jsonb,
  p_content text default ''
) returns boolean
language plpgsql security definer set search_path = public, auth as $$
declare
  v_client uuid := nullif(auth.jwt() ->> 'client_id', '')::uuid;
  v_thread uuid;
begin
  if auth.uid() is null then
    raise exception 'Not signed in.' using errcode = '42501';
  end if;
  if jsonb_typeof(p_payload) <> 'object'
     or coalesce(p_payload ->> 'type', '') not in ('answer', 'clarify', 'unanswered', 'applied') then
    raise exception 'Not an answer this line can hold.' using errcode = '22023';
  end if;

  update public.messages m
     set payload = p_payload, content = coalesce(p_content, '')
    from public.conversations c
   where m.id = p_answer
     and c.id = m.conversation_id
     and m.role = 'assistant'
     and m.payload ->> 'type' = 'answering'
     and c.asked_by is not null
     and c.asked_client is not distinct from v_client
     and public.abo_owns(c.project_id)
  returning m.conversation_id into v_thread;

  if v_thread is null then
    return false;
  end if;
  update public.conversations set updated_at = now() where id = v_thread;
  return true;
end $$;

revoke all on function public.abo_client_ask(uuid, text, uuid) from public, anon;
revoke all on function public.abo_client_settle(uuid, jsonb, text) from public, anon;
grant execute on function public.abo_client_ask(uuid, text, uuid) to authenticated;
grant execute on function public.abo_client_settle(uuid, jsonb, text) to authenticated;

NOTIFY pgrst, 'reload schema';
