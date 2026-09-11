-- Migration 0008: persistent assistant conversations.
-- The assistant used to be one-shot and stateless, so it had to guess
-- the owner's process from a single sentence. Storing the thread lets it
-- ask clarifying questions, propose a blueprint, and only then emit plans.

create table if not exists public.conversations (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null references public.projects(id) on delete cascade,
  title text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  -- Raw text exchanged with the model: the owner's words, or the
  -- assistant's raw JSON reply. Replayed verbatim as chat history.
  content text not null,
  -- Parsed reply (clarify / blueprint / plans) for the UI to re-render.
  payload jsonb,
  created_at timestamptz not null default now()
);

alter table public.conversations enable row level security;
alter table public.messages enable row level security;

drop policy if exists "conversations_owner_all" on public.conversations;
drop policy if exists "messages_owner_all" on public.messages;

create policy "conversations_owner_all" on public.conversations
  for all using (
    exists (
      select 1 from public.projects p
      where p.id = conversations.project_id and p.owner_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.projects p
      where p.id = conversations.project_id and p.owner_id = auth.uid()
    )
  );

create policy "messages_owner_all" on public.messages
  for all using (
    exists (
      select 1 from public.conversations c
      join public.projects p on p.id = c.project_id
      where c.id = messages.conversation_id and p.owner_id = auth.uid()
    )
  )
  with check (
    exists (
      select 1 from public.conversations c
      join public.projects p on p.id = c.project_id
      where c.id = messages.conversation_id and p.owner_id = auth.uid()
    )
  );

create index if not exists idx_conversations_project on public.conversations(project_id);
create index if not exists idx_messages_conversation on public.messages(conversation_id, created_at);

NOTIFY pgrst, 'reload schema';
