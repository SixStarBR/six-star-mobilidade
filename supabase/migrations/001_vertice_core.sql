-- Vértice: estrutura inicial para organizações, agenda e monitoramento GPS.
-- Execute no SQL Editor do projeto Supabase. Todas as tabelas usam RLS.

create table if not exists public.vertice_organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) between 2 and 120),
  created_by uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.vertice_members (
  organization_id uuid not null references public.vertice_organizations(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('owner', 'dispatcher', 'driver')),
  created_at timestamptz not null default now(),
  primary key (organization_id, user_id)
);

create table if not exists public.vertice_drivers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.vertice_organizations(id) on delete cascade,
  user_id uuid unique references auth.users(id) on delete set null,
  display_name text not null,
  vehicle_description text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (id, organization_id)
);

create table if not exists public.vertice_rides (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.vertice_organizations(id) on delete cascade,
  driver_id uuid,
  passenger_name text not null,
  pickup text not null,
  destination text not null,
  scheduled_at timestamptz not null,
  vehicle_category text not null default 'executiva',
  status text not null default 'scheduled' check (status in ('scheduled', 'confirmed', 'in_progress', 'completed', 'cancelled')),
  created_by uuid not null default auth.uid() references auth.users(id),
  created_at timestamptz not null default now(),
  foreign key (driver_id, organization_id) references public.vertice_drivers(id, organization_id)
);

create table if not exists public.vertice_driver_locations (
  id bigint generated always as identity primary key,
  organization_id uuid not null references public.vertice_organizations(id) on delete cascade,
  driver_id uuid not null,
  latitude double precision not null check (latitude between -90 and 90),
  longitude double precision not null check (longitude between -180 and 180),
  accuracy_m double precision,
  heading_deg double precision,
  speed_mps double precision,
  captured_at timestamptz not null default now(),
  received_at timestamptz not null default now(),
  foreign key (driver_id, organization_id) references public.vertice_drivers(id, organization_id) on delete cascade
);

create index if not exists vertice_locations_latest_idx on public.vertice_driver_locations (organization_id, driver_id, captured_at desc);
create index if not exists vertice_rides_schedule_idx on public.vertice_rides (organization_id, scheduled_at);

create or replace function public.vertice_is_member(target_org uuid)
returns boolean language sql stable security definer set search_path = public
as $$ select exists (select 1 from public.vertice_members m where m.organization_id = target_org and m.user_id = auth.uid()) $$;

create or replace function public.vertice_is_dispatcher(target_org uuid)
returns boolean language sql stable security definer set search_path = public
as $$ select exists (select 1 from public.vertice_members m where m.organization_id = target_org and m.user_id = auth.uid() and m.role in ('owner', 'dispatcher')) $$;

create or replace function public.vertice_create_organization(organization_name text)
returns uuid language plpgsql security definer set search_path = public
as $$
declare new_id uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if organization_name is null or length(trim(organization_name)) < 2 then raise exception 'Organization name is required'; end if;
  insert into public.vertice_organizations (name, created_by) values (trim(organization_name), auth.uid()) returning id into new_id;
  insert into public.vertice_members (organization_id, user_id, role) values (new_id, auth.uid(), 'owner');
  return new_id;
end;
$$;

revoke all on function public.vertice_is_member(uuid) from public;
revoke all on function public.vertice_is_dispatcher(uuid) from public;
revoke all on function public.vertice_create_organization(text) from public;
grant execute on function public.vertice_is_member(uuid) to authenticated;
grant execute on function public.vertice_is_dispatcher(uuid) to authenticated;
grant execute on function public.vertice_create_organization(text) to authenticated;

alter table public.vertice_organizations enable row level security;
alter table public.vertice_members enable row level security;
alter table public.vertice_drivers enable row level security;
alter table public.vertice_rides enable row level security;
alter table public.vertice_driver_locations enable row level security;

grant select, update, delete on public.vertice_organizations to authenticated;
grant select, insert, update, delete on public.vertice_members to authenticated;
grant select, insert, update, delete on public.vertice_drivers to authenticated;
grant select, insert, update, delete on public.vertice_rides to authenticated;
grant select, insert on public.vertice_driver_locations to authenticated;

create policy "organization members read organization" on public.vertice_organizations for select to authenticated using (public.vertice_is_member(id));
create policy "dispatchers update organization" on public.vertice_organizations for update to authenticated using (public.vertice_is_dispatcher(id)) with check (public.vertice_is_dispatcher(id));
create policy "owners delete organization" on public.vertice_organizations for delete to authenticated using (created_by = auth.uid());

create policy "members read own membership or dispatcher roster" on public.vertice_members for select to authenticated using (user_id = auth.uid() or public.vertice_is_dispatcher(organization_id));
create policy "dispatchers manage memberships" on public.vertice_members for all to authenticated using (public.vertice_is_dispatcher(organization_id)) with check (public.vertice_is_dispatcher(organization_id));

create policy "members read drivers" on public.vertice_drivers for select to authenticated using (public.vertice_is_member(organization_id));
create policy "dispatchers manage drivers" on public.vertice_drivers for all to authenticated using (public.vertice_is_dispatcher(organization_id)) with check (public.vertice_is_dispatcher(organization_id));

create policy "dispatchers and assigned drivers read rides" on public.vertice_rides for select to authenticated using (
  public.vertice_is_dispatcher(organization_id) or exists (
    select 1 from public.vertice_drivers d where d.id = driver_id and d.organization_id = organization_id and d.user_id = auth.uid()
  )
);
create policy "dispatchers create rides" on public.vertice_rides for insert to authenticated with check (public.vertice_is_dispatcher(organization_id) and created_by = auth.uid());
create policy "dispatchers update rides" on public.vertice_rides for update to authenticated using (public.vertice_is_dispatcher(organization_id)) with check (public.vertice_is_dispatcher(organization_id));
create policy "dispatchers delete rides" on public.vertice_rides for delete to authenticated using (public.vertice_is_dispatcher(organization_id));

create policy "dispatchers or own driver read locations" on public.vertice_driver_locations for select to authenticated using (
  public.vertice_is_dispatcher(organization_id) or exists (
    select 1 from public.vertice_drivers d where d.id = driver_id and d.organization_id = organization_id and d.user_id = auth.uid()
  )
);
create policy "driver inserts own location" on public.vertice_driver_locations for insert to authenticated with check (
  exists (select 1 from public.vertice_drivers d where d.id = driver_id and d.organization_id = organization_id and d.user_id = auth.uid() and d.active = true)
  and exists (select 1 from public.vertice_members m where m.organization_id = organization_id and m.user_id = auth.uid() and m.role = 'driver')
);

-- A publicação Realtime permite que a central receba novos pontos sem polling contínuo.
do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'vertice_driver_locations') then
    alter publication supabase_realtime add table public.vertice_driver_locations;
  end if;
exception when undefined_object then null;
end $$;
