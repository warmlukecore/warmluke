-- Migration 0005: purge legacy demo data (users build fresh via prompts)
delete from public.ui_schemas
where module_id in (select id from public.modules where project_id is null);
delete from public.records where project_id is null;
delete from public.modules where project_id is null;
delete from public.projects where name = '__legacy__';

NOTIFY pgrst, 'reload schema';
