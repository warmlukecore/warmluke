-- Migration 0079: the thread a client could never write.
--
-- "Changes from your AI" is the thread a merchant reads to find out
-- what their assistant did while they were not there. It is written by
-- logClientBuild, with the caller's own token, straight into
-- conversations and messages. A connected client's token may not
-- insert into either — conversations_oauth_no_insert and
-- messages_oauth_no_insert are RESTRICTIVE, by design, since 0028.
--
-- So for every build a real assistant made, the write was refused,
-- the try/catch around it said nothing, and the thread stayed empty.
-- The only builds that ever appeared there were the ones the merchant
-- tapped in Warmluke themselves — with the owner's token — which is
-- exactly the case the thread was not for. Every check that passed
-- against it signed in as the owner. check-as-client is the first one
-- that did not, and it went red on its first run.
--
-- The write moves into a function that runs as the definer, the way
-- abo_build already does for the builder's tables. It is scoped to the
-- project's owner and to this one thread; a client still cannot write
-- a message anywhere else.
--
-- Callers: src/lib/apply.ts (logClientBuild).

create or replace function public.abo_log_client_build(
  p_project uuid,
  p_asked   text,
  p_outcome text,
  p_undo    jsonb default null
) returns uuid
language plpgsql security definer set search_path = public as $$
declare
  v_thread uuid;
  v_short  text;
  v_t      timestamptz := clock_timestamp();
begin
  if auth.uid() is null then
    raise exception 'Not signed in.' using errcode = '42501';
  end if;
  if not public.abo_owns(p_project) then
    raise exception 'Not your project.' using errcode = '42501';
  end if;

  -- One thread per project for these, found or made. The title is the
  -- key; the panel looks it up by the same words.
  select c.id into v_thread
    from public.conversations c
   where c.project_id = p_project
     and c.title = 'Changes from your AI'
   order by c.created_at asc
   limit 1;
  if v_thread is null then
    insert into public.conversations (project_id, title)
    values (p_project, 'Changes from your AI')
    returning id into v_thread;
  end if;

  v_short := btrim(coalesce(p_asked, ''));
  if length(v_short) > 160 then
    v_short := left(v_short, 157) || '…';
  end if;

  -- A millisecond apart, so the question sorts above its answer.
  -- Both in one statement would share now(), and the panel once
  -- showed the answer first because of exactly that.
  insert into public.messages (conversation_id, role, content, payload, created_at)
  values (
    v_thread, 'user', v_short,
    jsonb_build_object('kind', 'asked', 'text', v_short, 'via', 'client'),
    v_t
  );
  insert into public.messages (conversation_id, role, content, payload, created_at)
  values (
    v_thread, 'assistant', p_outcome,
    jsonb_build_object('type', 'applied', 'message', p_outcome)
      || case when p_undo is not null and jsonb_typeof(p_undo) = 'array' and jsonb_array_length(p_undo) > 0
              then jsonb_build_object('undo', p_undo)
              else '{}'::jsonb end,
    v_t + interval '1 millisecond'
  );

  update public.conversations set updated_at = now() where id = v_thread;
  return v_thread;
end $$;


-- ── The same shape, one tool over ────────────────────────────────
--
-- reject_change records the no through abo_reject_request and then
-- writes the merchant's reason straight at build_requests.summary.
-- A client cannot write there, so every refusal a real assistant
-- relayed landed in build_history as "dismissed" with no words —
-- while the owner-token check saw the words kept fine. The reason
-- goes in through the same function that records the no.
--
-- Callers: src/app/api/mcp/route.ts (reject_change).

drop function if exists public.abo_reject_request(uuid);

create or replace function public.abo_reject_request(p_request uuid, p_reason text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_client text := nullif(auth.jwt() ->> 'client_id', '');
  v_status text;
  v_n      integer;
begin
  if auth.uid() is null then
    raise exception 'Not signed in.' using errcode = '42501';
  end if;

  select r.status into v_status
    from public.build_requests r
   where r.id = p_request
     and public.abo_owns(r.project_id)
     -- A client refusing somebody else's request would be the approval
     -- hole through a different door.
     and (v_client is null or r.client_id is not distinct from v_client);

  if v_status is null then
    return jsonb_build_object('rejected', false, 'reason', 'no such request on this account');
  end if;

  -- Asking twice is not an error. The answer is the state it is in.
  if v_status = 'dismissed' then
    return jsonb_build_object('rejected', true, 'already', true, 'status', 'dismissed');
  end if;

  if v_status not in ('pending', 'building') then
    return jsonb_build_object(
      'rejected', false,
      'status', v_status,
      'reason', 'that is already finished — there is nothing left to refuse'
    );
  end if;

  update public.build_requests
     set status      = 'dismissed',
         resolved_at = now(),
         -- The merchant's words, when there are any. They are what
         -- makes the decision recognisable a week later.
         summary     = coalesce(nullif(left(btrim(p_reason), 2000), ''), summary)
   where id = p_request
     and status in ('pending', 'building');
  get diagnostics v_n = row_count;

  -- Zero rows means somebody moved it between the read and the write.
  return jsonb_build_object(
    'rejected', v_n > 0,
    'status', case when v_n > 0 then 'dismissed' else v_status end
  );
end $$;

NOTIFY pgrst, 'reload schema';
