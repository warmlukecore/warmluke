-- A name the owner gave.
--
-- Luke names a conversation on every reply, from what it is about. A
-- name the owner typed in the list would be written over by the next
-- reply, so the panel could offer renaming only as a thing that undoes
-- itself. The chat route leaves the title of a thread the owner named
-- alone; everything else about the thread is as before.

alter table public.conversations
  add column if not exists named_by_owner boolean not null default false;

NOTIFY pgrst, 'reload schema';
