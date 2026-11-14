-- Six Star Mobilidade: campos operacionais, estados e provisionamento seguro de usuários.
-- Executar após as migrações 001, 002 e 003.

alter table public.vertice_rides
  add column if not exists ride_code text,
  add column if not exists pickup_url text,
  add column if not exists destination_url text,
  add column if not exists observations text,
  add column if not exists vehicle_label text;

update public.vertice_rides
set ride_code = 'SS-' || upper(substr(replace(id::text, '-', ''), 1, 8))
where ride_code is null or btrim(ride_code) = '';

alter table public.vertice_rides alter column ride_code set not null;
create unique index if not exists vertice_rides_org_code_unique
  on public.vertice_rides (organization_id, ride_code);

alter table public.vertice_rides drop constraint if exists vertice_rides_status_check;
alter table public.vertice_rides add constraint vertice_rides_status_check
  check (status in ('scheduled', 'confirmed', 'in_progress', 'completed', 'no_show', 'cancelled'));

alter table public.vertice_rides
  add constraint vertice_rides_code_length check (length(btrim(ride_code)) between 1 and 40),
  add constraint vertice_rides_observations_length check (observations is null or length(observations) <= 2000),
  add constraint vertice_rides_origin_url_scheme check (pickup_url is null or pickup_url ~* '^https://'),
  add constraint vertice_rides_destination_url_scheme check (destination_url is null or destination_url ~* '^https://');

-- Administradores criam usuário no Auth por uma Edge Function protegida; esta RPC
-- valida novamente a permissão do solicitante antes de adicionar o perfil à operação.
create or replace function public.vertice_onboard_user(
  target_organization_id uuid,
  target_user_id uuid,
  target_role text,
  display_name text default null,
  vehicle_info text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  actor_role text;
  new_driver_id uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select role into actor_role from public.vertice_members
    where organization_id = target_organization_id and user_id = auth.uid();
  if actor_role is null or actor_role not in ('owner', 'dispatcher') then raise exception 'Dispatcher permission required'; end if;
  if target_role not in ('driver', 'dispatcher') then raise exception 'Role must be driver or dispatcher'; end if;
  if target_role = 'dispatcher' and actor_role <> 'owner' then raise exception 'Only an owner can create administrators'; end if;
  if target_user_id is null or not exists (select 1 from auth.users where id = target_user_id) then
    raise exception 'Auth user must exist before onboarding';
  end if;

  if target_role = 'dispatcher' then
    insert into public.vertice_members (organization_id, user_id, role)
      values (target_organization_id, target_user_id, 'dispatcher')
      on conflict (organization_id, user_id) do update set role = 'dispatcher';
    return target_user_id;
  end if;

  if display_name is null or length(btrim(display_name)) not between 2 and 120 then
    raise exception 'Driver name must contain 2 to 120 characters';
  end if;
  if vehicle_info is not null and length(vehicle_info) > 160 then raise exception 'Vehicle information is too long'; end if;
  if exists (select 1 from public.vertice_members where user_id = target_user_id and organization_id <> target_organization_id) then
    raise exception 'This user already belongs to another operation';
  end if;
  if exists (select 1 from public.vertice_members where organization_id = target_organization_id and user_id = target_user_id and role in ('owner', 'dispatcher')) then
    raise exception 'An administrator cannot be converted to a driver';
  end if;

  insert into public.vertice_members (organization_id, user_id, role)
    values (target_organization_id, target_user_id, 'driver')
    on conflict (organization_id, user_id) do update set role = 'driver';

  select id into new_driver_id from public.vertice_drivers where user_id = target_user_id;
  if new_driver_id is null then
    insert into public.vertice_drivers (organization_id, user_id, display_name, vehicle_description, active)
      values (target_organization_id, target_user_id, btrim(display_name), nullif(btrim(vehicle_info), ''), true)
      returning id into new_driver_id;
  else
    update public.vertice_drivers
      set display_name = btrim(display_name), vehicle_description = nullif(btrim(vehicle_info), ''), active = true
      where id = new_driver_id and organization_id = target_organization_id;
  end if;
  return new_driver_id;
end;
$$;
revoke all on function public.vertice_onboard_user(uuid, uuid, text, text, text) from public, anon;
grant execute on function public.vertice_onboard_user(uuid, uuid, text, text, text) to authenticated;

create or replace function public.vertice_transition_ride(target_ride_id uuid, next_status text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare ride_row public.vertice_rides%rowtype;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if next_status not in ('confirmed', 'in_progress', 'completed', 'no_show', 'cancelled') then raise exception 'Invalid ride status'; end if;
  select * into ride_row from public.vertice_rides where id = target_ride_id for update;
  if not found then raise exception 'Ride not found'; end if;

  if public.vertice_is_dispatcher(ride_row.organization_id) then
    update public.vertice_rides set status = next_status where id = target_ride_id;
  else
    if not exists (
      select 1 from public.vertice_drivers d
      join public.vertice_members m on m.organization_id = d.organization_id and m.user_id = d.user_id
      where d.id = ride_row.driver_id and d.organization_id = ride_row.organization_id
        and d.user_id = auth.uid() and d.active = true and m.role = 'driver'
    ) then raise exception 'This ride is not assigned to the active driver'; end if;
    if not (
      (ride_row.status = 'scheduled' and next_status in ('confirmed', 'in_progress', 'no_show', 'cancelled')) or
      (ride_row.status = 'confirmed' and next_status in ('in_progress', 'no_show', 'cancelled')) or
      (ride_row.status = 'in_progress' and next_status = 'completed')
    ) then raise exception 'Invalid ride state transition'; end if;
    update public.vertice_rides set status = next_status where id = target_ride_id;
  end if;
  return target_ride_id;
end;
$$;
revoke all on function public.vertice_transition_ride(uuid, text) from public, anon;
grant execute on function public.vertice_transition_ride(uuid, text) to authenticated;
