-- Migration 0002: navigation ordering driven by prompts
alter table public.modules add column if not exists sort_order integer not null default 0;

update public.modules set sort_order = 1 where name = 'orders';
update public.modules set sort_order = 2 where name = 'returns';

NOTIFY pgrst, 'reload schema';
