-- Core schema: projects, their members, and the elements and connections inside each project.
--
-- Security model
--   * Every table has row level security. A user can only see a project, and anything in it,
--     if they have a row in project_members for that project.
--   * Roles: owner (everything), editor (edit elements and connections), viewer (read only).
--   * Privileges are granted column by column, so clients can't set ids, owners or timestamps,
--     move an element to another project, or re-point a connection after creating it.
--   * Projects are created only through create_project(), which also makes the caller owner.
--   * Composite foreign keys make it impossible for a connection to join two projects.
--   * Sign-in is magic link only: passwords are stripped from auth.users on write.

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to authenticated;

-- Nothing created in public later is exposed to API roles unless granted explicitly.
alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated;
alter default privileges for role postgres in schema public revoke execute on functions from public, anon, authenticated;

create type public.project_role as enum ('owner', 'editor', 'viewer');
create type public.connection_direction as enum ('directed', 'mutual', 'undirected');

-- ---------------------------------------------------------------- tables

create table public.projects (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (char_length(btrim(name)) between 1 and 120),
  created_by  uuid not null references auth.users (id) on delete cascade,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table public.project_members (
  project_id  uuid not null references public.projects (id) on delete cascade,
  user_id     uuid not null references auth.users (id) on delete cascade,
  role        public.project_role not null,
  created_at  timestamptz not null default now(),
  primary key (project_id, user_id)
);
create index project_members_user_id_idx on public.project_members (user_id);

create table public.elements (
  id            uuid primary key default gen_random_uuid(),
  project_id    uuid not null references public.projects (id) on delete cascade,
  label         text not null check (char_length(btrim(label)) between 1 and 200),
  element_type  text check (char_length(element_type) <= 60),
  description   text check (char_length(description) <= 5000),
  attributes    jsonb not null default '{}'::jsonb
                check (jsonb_typeof(attributes) = 'object' and pg_column_size(attributes) <= 16384),
  created_by    uuid default auth.uid() references auth.users (id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (project_id, id)
);
create index elements_project_id_idx on public.elements (project_id);

create table public.connections (
  id               uuid primary key default gen_random_uuid(),
  project_id       uuid not null references public.projects (id) on delete cascade,
  from_element_id  uuid not null,
  to_element_id    uuid not null,
  connection_type  text check (char_length(connection_type) <= 60),
  direction        public.connection_direction not null default 'directed',
  description      text check (char_length(description) <= 5000),
  created_by       uuid default auth.uid() references auth.users (id) on delete set null,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  foreign key (project_id, from_element_id) references public.elements (project_id, id) on delete cascade,
  foreign key (project_id, to_element_id)   references public.elements (project_id, id) on delete cascade,
  check (from_element_id <> to_element_id)
);
create index connections_project_id_idx on public.connections (project_id);
create index connections_from_idx on public.connections (from_element_id);
create index connections_to_idx on public.connections (to_element_id);

-- ---------------------------------------------------------------- helpers

create function private.has_project_role(p_project uuid, p_roles public.project_role[])
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.project_members m
    where m.project_id = p_project
      and m.user_id = (select auth.uid())
      and m.role = any (p_roles)
  );
$$;
revoke all on function private.has_project_role(uuid, public.project_role[]) from public, anon;
grant execute on function private.has_project_role(uuid, public.project_role[]) to authenticated;

create function private.touch_updated_at()
returns trigger
language plpgsql set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger projects_touch before update on public.projects
  for each row execute function private.touch_updated_at();
create trigger elements_touch before update on public.elements
  for each row execute function private.touch_updated_at();
create trigger connections_touch before update on public.connections
  for each row execute function private.touch_updated_at();

-- Size limits keep one account from filling the database.
create function private.enforce_project_limits()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if tg_table_name = 'elements'
     and (select count(*) from public.elements where project_id = new.project_id) >= 2000 then
    raise exception 'This project has reached its limit of 2,000 elements.' using errcode = 'P0001';
  elsif tg_table_name = 'connections'
     and (select count(*) from public.connections where project_id = new.project_id) >= 10000 then
    raise exception 'This project has reached its limit of 10,000 connections.' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
revoke all on function private.enforce_project_limits() from public, anon, authenticated;

create trigger elements_limit before insert on public.elements
  for each row execute function private.enforce_project_limits();
create trigger connections_limit before insert on public.connections
  for each row execute function private.enforce_project_limits();

-- ---------------------------------------------------------------- create_project()

create function public.create_project(p_name text)
returns public.projects
language plpgsql security definer set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_project public.projects;
begin
  if v_uid is null then
    raise exception 'Sign in to create a project.' using errcode = '42501';
  end if;
  if (select count(*) from public.project_members where user_id = v_uid and role = 'owner') >= 50 then
    raise exception 'You have reached the limit of 50 projects.' using errcode = 'P0001';
  end if;

  insert into public.projects (name, created_by) values (btrim(p_name), v_uid)
  returning * into v_project;
  insert into public.project_members (project_id, user_id, role) values (v_project.id, v_uid, 'owner');
  return v_project;
end;
$$;
revoke all on function public.create_project(text) from public, anon;
grant execute on function public.create_project(text) to authenticated;

-- ---------------------------------------------------------------- privileges

revoke all on public.projects, public.project_members, public.elements, public.connections
  from anon, authenticated;

grant select, delete on public.projects to authenticated;
grant update (name) on public.projects to authenticated;

grant select on public.project_members to authenticated;

grant select, delete on public.elements to authenticated;
grant insert (project_id, label, element_type, description, attributes) on public.elements to authenticated;
grant update (label, element_type, description, attributes) on public.elements to authenticated;

grant select, delete on public.connections to authenticated;
grant insert (project_id, from_element_id, to_element_id, connection_type, direction, description)
  on public.connections to authenticated;
grant update (connection_type, direction, description) on public.connections to authenticated;

-- ---------------------------------------------------------------- row level security

alter table public.projects enable row level security;
alter table public.project_members enable row level security;
alter table public.elements enable row level security;
alter table public.connections enable row level security;

create policy "members read projects" on public.projects for select to authenticated
  using (private.has_project_role(id, '{owner,editor,viewer}'));
create policy "owners and editors rename projects" on public.projects for update to authenticated
  using (private.has_project_role(id, '{owner,editor}'))
  with check (private.has_project_role(id, '{owner,editor}'));
create policy "owners delete projects" on public.projects for delete to authenticated
  using (private.has_project_role(id, '{owner}'));

create policy "members read the member list" on public.project_members for select to authenticated
  using (private.has_project_role(project_id, '{owner,editor,viewer}'));

create policy "members read elements" on public.elements for select to authenticated
  using (private.has_project_role(project_id, '{owner,editor,viewer}'));
create policy "editors add elements" on public.elements for insert to authenticated
  with check (private.has_project_role(project_id, '{owner,editor}'));
create policy "editors change elements" on public.elements for update to authenticated
  using (private.has_project_role(project_id, '{owner,editor}'))
  with check (private.has_project_role(project_id, '{owner,editor}'));
create policy "editors delete elements" on public.elements for delete to authenticated
  using (private.has_project_role(project_id, '{owner,editor}'));

create policy "members read connections" on public.connections for select to authenticated
  using (private.has_project_role(project_id, '{owner,editor,viewer}'));
create policy "editors add connections" on public.connections for insert to authenticated
  with check (private.has_project_role(project_id, '{owner,editor}'));
create policy "editors change connections" on public.connections for update to authenticated
  using (private.has_project_role(project_id, '{owner,editor}'))
  with check (private.has_project_role(project_id, '{owner,editor}'));
create policy "editors delete connections" on public.connections for delete to authenticated
  using (private.has_project_role(project_id, '{owner,editor}'));

-- ---------------------------------------------------------------- magic link only

-- Supabase has no switch to turn off email + password sign-in, so any password set by a sign-up,
-- an admin, or a password change is erased before it is stored. Password sign-in then always fails.
create function private.strip_password()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  new.encrypted_password := '';
  return new;
end;
$$;
revoke all on function private.strip_password() from public, anon, authenticated;

create trigger strip_password before insert or update of encrypted_password on auth.users
  for each row execute function private.strip_password();
