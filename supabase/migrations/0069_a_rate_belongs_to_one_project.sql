-- Migration 0069: a rate anybody could set, for everybody.
--
-- 0068 cached one rate per currency pair for the whole database and
-- granted the writing function to every signed-in user — because the
-- service role key is deliberately not deployed, so the server holds
-- exactly the rights a browser does. Anything the route can write, a
-- client can write.
--
-- The check refused a negative rate and a zero. It had nothing to say
-- about 1.0, which is a perfectly ordinary number, and which would have
-- made every merchant's orders read ninety-six times cheaper — in every
-- project on the database, not only the one doing it.
--
-- So the cache stops being shared. A rate belongs to a project, and the
-- policy only lets somebody touch their own. A merchant who puts a
-- silly number in now fools nobody but themselves, which is the most
-- that can be arranged while the server has no rights a client lacks.
--
-- ponytail: one fetch per project rather than one per pair. Move the
-- refresh to a scheduled job writing a shared table if the call volume
-- ever matters — that needs a privileged writer, which this deployment
-- deliberately does not have.
--
-- Callers: src/app/api/fx/route.ts, src/components/AppShell.tsx.

drop function if exists public.abo_fx_put(text, text, numeric, date);
drop table if exists public.fx_rates;

create table public.fx_rates (
  project_id uuid not null references public.projects(id) on delete cascade,
  base       text not null,
  quote      text not null,
  rate       numeric not null,
  -- The day the rate is from, as the source reported it.
  as_of      date not null,
  fetched_at timestamptz not null default now(),

  primary key (project_id, base, quote),
  constraint fx_rates_codes_look_like_codes
    check (base ~ '^[A-Z]{3}$' and quote ~ '^[A-Z]{3}$'),
  constraint fx_rates_rate_is_positive check (rate > 0)
);

comment on table public.fx_rates is
  'One cached rate per project and currency pair. A project only ever reads or writes its own.';

alter table public.fx_rates enable row level security;

-- The same shape every other project-owned table uses: the owner, or
-- somebody they gave a seat to.
drop policy if exists fx_rates_own_project on public.fx_rates;
create policy fx_rates_own_project
  on public.fx_rates for select
  to authenticated
  using (
    exists (
      select 1 from public.projects p
       where p.id = fx_rates.project_id
         and (
           p.owner_id = auth.uid()
           or exists (
             select 1 from public.project_members m
              where m.project_id = p.id and m.user_id = auth.uid()
           )
         )
    )
  );

revoke all on public.fx_rates from anon, authenticated;
grant select on public.fx_rates to authenticated;

-- Records a rate the server just fetched, for one project.
--
-- Security definer so the row can be written without granting the
-- table; the project check inside is what stops it being written into
-- somebody else's.
create or replace function public.abo_fx_put(
  p_project uuid,
  p_base    text,
  p_quote   text,
  p_rate    numeric,
  p_as_of   date
) returns void
language plpgsql security definer set search_path = public as $$
begin
  if p_base !~ '^[A-Z]{3}$' or p_quote !~ '^[A-Z]{3}$' then
    raise exception 'Not a currency code.' using errcode = '22023';
  end if;
  if p_rate is null or p_rate <= 0 then
    raise exception 'Not a rate.' using errcode = '22023';
  end if;

  -- Their own project, or nothing. Definer would otherwise let anyone
  -- write a rate into anyone's.
  if not exists (
    select 1 from public.projects p
     where p.id = p_project
       and (
         p.owner_id = auth.uid()
         or exists (
           select 1 from public.project_members m
            where m.project_id = p.id and m.user_id = auth.uid()
         )
       )
  ) then
    raise exception 'Not your project.' using errcode = '42501';
  end if;

  insert into public.fx_rates (project_id, base, quote, rate, as_of, fetched_at)
  values (p_project, p_base, p_quote, p_rate, coalesce(p_as_of, current_date), now())
  on conflict (project_id, base, quote) do update
    set rate = excluded.rate,
        as_of = excluded.as_of,
        fetched_at = now();
end $$;

revoke all on function public.abo_fx_put(uuid, text, text, numeric, date) from public;
grant execute on function public.abo_fx_put(uuid, text, text, numeric, date) to authenticated;

NOTIFY pgrst, 'reload schema';
