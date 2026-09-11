-- Migration 0014: sections can sit under another section.
--
-- The sidebar was one flat list, so a business with a few related
-- areas had no way to group them. A module may now name a parent.
--
-- One level only: parent -> child, no deeper. Arbitrary depth makes a
-- sidebar unreadable and every ordering question harder, and nobody
-- has asked for it. The check below enforces that a parent is itself
-- top-level, so the tree cannot grow a third level by accident.

alter table public.modules
  add column if not exists parent_id uuid references public.modules(id) on delete cascade;

create index if not exists idx_modules_parent on public.modules(parent_id);

create or replace function public.abo_check_module_depth()
returns trigger as $$
begin
  if new.parent_id is not null then
    if new.parent_id = new.id then
      raise exception 'A section cannot be its own parent';
    end if;
    if exists (select 1 from public.modules m where m.id = new.parent_id and m.parent_id is not null) then
      raise exception 'Sections can only be nested one level deep';
    end if;
    -- Turning a section that already has children into a child would
    -- create that second level from the other direction.
    if exists (select 1 from public.modules m where m.parent_id = new.id) then
      raise exception 'This section has sections under it, so it cannot be moved under another';
    end if;
  end if;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_module_depth on public.modules;
create trigger trg_module_depth
before insert or update of parent_id on public.modules
for each row execute function public.abo_check_module_depth();

NOTIFY pgrst, 'reload schema';
