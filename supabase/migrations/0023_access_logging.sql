-- Migration 0023: a read of somebody's personal data leaves a record.
--
-- Row-level security decides who may read a customer. It does not say
-- that anyone did. Those are different questions, and after an incident
-- the second one is the only one that matters: which records were
-- actually reachable, and over what window.
--
-- Done with pgaudit's object auditing rather than application logging
-- because the browser reads these tables through PostgREST directly —
-- there is no server of ours in the path to write a log line from. The
-- audit therefore sits where the read actually happens.
--
-- Scoped to the three tables holding personal data. Auditing everything
-- would bury the reads that matter under product and stock queries.

create extension if not exists pgaudit;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'abo_auditor') then
    create role abo_auditor noinherit nologin;
  end if;
end $$;

-- pgaudit logs an operation when the role it is pointed at would have
-- been allowed it. Granting select here is what selects the tables to
-- watch; abo_auditor is never logged into and owns nothing.
grant select on public.customers to abo_auditor;
grant select on public.orders to abo_auditor;
grant select on public.order_line_items to abo_auditor;

-- The roles PostgREST actually runs queries as.
alter role authenticated set pgaudit.role = 'abo_auditor';
alter role anon set pgaudit.role = 'abo_auditor';

NOTIFY pgrst, 'reload schema';
