-- Vértice 002: endurecimento do acesso, onboarding, corridas e posição atual.
-- Aplicar depois de 001_vertice_core.sql pelo Supabase CLI ou SQL Editor.

-- A tabela de localização guarda apenas a posição mais recente por motorista.
-- Remove versões antigas antes de impor a chave natural necessária ao upsert.
with ranked as (
  select id, row_number() over (
    partition by organization_id, driver_id
    order by captured_at desc, received_at desc, id desc
  ) as position_rank
  from public.vertice_driver_locations
)
delete from public.vertice_driver_locations l
using ranked r
where l.id = r.id and r.position_rank > 1;

create unique index if not exists vertice_location_one_current_per_driver
  on public.vertice_driver_locations (organization_id, driver_id);
create index if not exists vertice_location_received_idx
  on public.vertice_driver_locations (organization_id, received_at desc);

alter table public.vertice_driver_locations replica identity full;

-- O cadastro de membros não pode ser alterado diretamente pelo navegador.
drop policy if exists "dispatchers manage memberships" on public.vertice_members;
drop policy if exists "members read own membership or dispatcher roster" on public.vertice_members;
create policy "members read own membership or dispatcher roster"
  on public.vertice_members for select to authenticated
  using (user_id = auth.uid() or public.vertice_is_dispatcher(organization_id));
revoke insert, update, delete on public.vertice_members from authenticated;
grant select on public.vertice_members to authenticated;

-- Motorista só enxerga corridas/localização enquanto estiver ativo e ainda for
-- membro motorista. Revogar o vínculo encerra o acesso sem apagar o histórico.
drop policy if exists "dispatchers and assigned drivers read rides" on public.vertice_rides;
create policy "dispatchers and assigned drivers read rides"
  on public.vertice_rides for select to authenticated using (
    public.vertice_is_dispatcher(organization_id) or exists (
      select 1 from public.vertice_drivers d
      join public.vertice_members m on m.organization_id = d.organization_id and m.user_id = d.user_id
      where d.id = driver_id and d.organization_id = vertice_rides.organization_id
        and d.user_id = auth.uid() and d.active = true and m.role = 'driver'
    )
  );

drop policy if exists "dispatchers or own driver read locations" on public.vertice_driver_locations;
create policy "dispatchers or own driver read locations"
  on public.vertice_driver_locations for select to authenticated using (
    public.vertice_is_dispatcher(organization_id) or exists (
      select 1 from public.vertice_drivers d
      join public.vertice_members m on m.organization_id = d.organization_id and m.user_id = d.user_id
      where d.id = driver_id and d.organization_id = vertice_driver_locations.organization_id
        and d.user_id = auth.uid() and d.active = true and m.role = 'driver'
    )
  );

-- Posição é gravada com UPSERT, validada no banco e limitada em frequência.
drop policy if exists "driver inserts own location" on public.vertice_driver_locations;
create policy "driver inserts own location"
  on public.vertice_driver_locations for insert to authenticated with check (
    exists (
      select 1 from public.vertice_drivers d
      join public.vertice_members m on m.organization_id = d.organization_id and m.user_id = d.user_id
      where d.id = driver_id and d.organization_id = vertice_driver_locations.organization_id
        and d.user_id = auth.uid() and d.active = true and m.role = 'driver'
    )
  );
drop policy if exists "driver updates own current location" on public.vertice_driver_locations;
create policy "driver updates own current location"
  on public.vertice_driver_locations for update to authenticated
  using (
    exists (
      select 1 from public.vertice_drivers d
      join public.vertice_members m on m.organization_id = d.organization_id and m.user_id = d.user_id
      where d.id = driver_id and d.organization_id = vertice_driver_locations.organization_id
        and d.user_id = auth.uid() and d.active = true and m.role = 'driver'
    )
  )
  with check (
    exists (
      select 1 from public.vertice_drivers d
      join public.vertice_members m on m.organization_id = d.organization_id and m.user_id = d.user_id
      where d.id = driver_id and d.organization_id = vertice_driver_locations.organization_id
        and d.user_id = auth.uid() and d.active = true and m.role = 'driver'
    )
  );
grant update on public.vertice_driver_locations to authenticated;

create or replace function public.vertice_guard_location()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.captured_at > now() + interval '2 minutes' then
    raise exception 'captured_at is too far in the future';
  end if;
  if new.accuracy_m is not null and (new.accuracy_m < 0 or new.accuracy_m > 100000) then
    raise exception 'accuracy_m is outside the accepted range';
  end if;
  if new.speed_mps is not null and new.speed_mps < 0 then
    raise exception 'speed_mps cannot be negative';
  end if;
  if new.heading_deg is not null and (new.heading_deg < 0 or new.heading_deg >= 360) then
    raise exception 'heading_deg must be between 0 and 360';
  end if;
  if tg_op = 'UPDATE' then
    if new.organization_id <> old.organization_id or new.driver_id <> old.driver_id then
      raise exception 'location ownership cannot be changed';
    end if;
    if new.captured_at < old.captured_at then
      raise exception 'older location cannot replace a newer location';
    end if;
    if clock_timestamp() - old.received_at < interval '3 seconds' then
      raise exception 'location update rate exceeded';
    end if;
  end if;
  new.received_at := clock_timestamp();
  return new;
end;
$$;
revoke all on function public.vertice_guard_location() from public, anon, authenticated;
drop trigger if exists vertice_location_guard on public.vertice_driver_locations;
create trigger vertice_location_guard
  before insert or update on public.vertice_driver_locations
  for each row execute function public.vertice_guard_location();

-- Provisionamento seguro: o administrador pode vincular somente usuários
-- existentes, sem conceder privilégios de owner/dispatcher por esta rotina.
create or replace function public.vertice_onboard_driver(
  target_organization_id uuid,
  target_user_id uuid,
  driver_name text,
  vehicle_info text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  new_driver_id uuid;
  prior_role text;
  prior_org uuid;
begin
  if auth.uid() is null or not public.vertice_is_dispatcher(target_organization_id) then
    raise exception 'Dispatcher permission required';
  end if;
  if target_user_id is null or not exists (select 1 from auth.users u where u.id = target_user_id) then
    raise exception 'The invited user must exist before driver onboarding';
  end if;
  if driver_name is null or length(trim(driver_name)) not between 2 and 120 then
    raise exception 'Driver name must contain 2 to 120 characters';
  end if;
  if vehicle_info is not null and length(vehicle_info) > 160 then
    raise exception 'Vehicle information is too long';
  end if;

  select role into prior_role from public.vertice_members
    where organization_id = target_organization_id and user_id = target_user_id;
  if prior_role in ('owner', 'dispatcher') then
    raise exception 'An owner or dispatcher cannot be converted to a driver';
  end if;
  select id, organization_id into new_driver_id, prior_org
    from public.vertice_drivers where user_id = target_user_id;
  if prior_org is not null and prior_org <> target_organization_id then
    raise exception 'This user is already linked to another organization';
  end if;

  insert into public.vertice_members (organization_id, user_id, role)
    values (target_organization_id, target_user_id, 'driver')
    on conflict (organization_id, user_id) do update set role = 'driver';

  if new_driver_id is null then
    insert into public.vertice_drivers (organization_id, user_id, display_name, vehicle_description, active)
      values (target_organization_id, target_user_id, trim(driver_name), nullif(trim(vehicle_info), ''), true)
      returning id into new_driver_id;
  else
    update public.vertice_drivers
      set display_name = trim(driver_name), vehicle_description = nullif(trim(vehicle_info), ''), active = true
      where id = new_driver_id and organization_id = target_organization_id;
  end if;
  return new_driver_id;
end;
$$;
revoke all on function public.vertice_onboard_driver(uuid, uuid, text, text) from public, anon;
grant execute on function public.vertice_onboard_driver(uuid, uuid, text, text) to authenticated;

-- Motorista só pode avançar a própria corrida em sequência válida.
create or replace function public.vertice_transition_ride(target_ride_id uuid, next_status text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  ride_row public.vertice_rides%rowtype;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if next_status not in ('confirmed', 'in_progress', 'completed', 'cancelled') then
    raise exception 'Invalid ride status';
  end if;
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
      (ride_row.status = 'scheduled' and next_status in ('confirmed', 'cancelled')) or
      (ride_row.status = 'confirmed' and next_status in ('in_progress', 'cancelled')) or
      (ride_row.status = 'in_progress' and next_status = 'completed')
    ) then raise exception 'Invalid ride state transition'; end if;
    update public.vertice_rides set status = next_status where id = target_ride_id;
  end if;
  return target_ride_id;
end;
$$;
revoke all on function public.vertice_transition_ride(uuid, text) from public, anon;
grant execute on function public.vertice_transition_ride(uuid, text) to authenticated;

-- Uma conta autenticada sem associação pode criar uma única operação inicial.
create or replace function public.vertice_create_organization(organization_name text)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare new_id uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if organization_name is null or length(trim(organization_name)) not between 2 and 120 then
    raise exception 'Organization name must contain 2 to 120 characters';
  end if;
  if exists (select 1 from public.vertice_members where user_id = auth.uid()) then
    raise exception 'This account already belongs to an operation';
  end if;
  insert into public.vertice_organizations (name, created_by)
    values (trim(organization_name), auth.uid()) returning id into new_id;
  insert into public.vertice_members (organization_id, user_id, role)
    values (new_id, auth.uid(), 'owner');
  return new_id;
end;
$$;
revoke all on function public.vertice_create_organization(text) from public, anon;
grant execute on function public.vertice_create_organization(text) to authenticated;

-- Confirmações de segurança e operação:
-- * Publishable/anon key no cliente; service_role permanece somente no servidor.
-- * Location table contém somente a última posição; não armazena trilha histórica.
-- * Realtime recebe INSERT e UPDATE (o cliente assina ambos).
