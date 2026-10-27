-- Access-control tests. Run with: npm run test:db
-- Alice owns a project. Bob is a stranger to it, then a viewer. Every way Bob might reach
-- Alice's data must fail, and the client-side columns that must never change must stay put.
begin;
-- Hosted databases connect the test runner as a temporary login role, so act as postgres explicitly.
set local role postgres;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select plan(34);

insert into auth.users (id, email, aud, role, encrypted_password) values
  ('a0000000-0000-4000-8000-000000000001', 'alice@example.com', 'authenticated', 'authenticated', ''),
  ('b0000000-0000-4000-8000-000000000002', 'bob@example.com',   'authenticated', 'authenticated', '');

create temp table ids (name text primary key, id uuid);
grant select on ids to anon, authenticated;

-- ---------------------------------------------------------------- anonymous visitors
set local role anon;
select throws_ok($$ select public.create_project('Nope') $$, '42501', null, 'anon cannot create projects');
select throws_ok($$ select * from public.projects $$, '42501', null, 'anon cannot read projects');
select throws_ok($$ select * from public.elements $$, '42501', null, 'anon cannot read elements');
set local role postgres;

-- ---------------------------------------------------------------- alice builds a project
set local role authenticated;
set local request.jwt.claims = '{"sub":"a0000000-0000-4000-8000-000000000001","role":"authenticated"}';
select lives_ok($$ select public.create_project('  Alice''s network  ') $$, 'alice creates a project');
select is((select name from public.projects), 'Alice''s network', 'project name is trimmed');
select is((select role::text from public.project_members), 'owner', 'creator becomes owner');
set local role postgres;
insert into ids select 'alice_project', id from public.projects where name = 'Alice''s network';

set local role authenticated;
set local request.jwt.claims = '{"sub":"a0000000-0000-4000-8000-000000000001","role":"authenticated"}';
select lives_ok($$
  insert into public.elements (project_id, label, element_type)
  select id, l, 'person' from ids, unnest(array['Ada', 'Grace']) l where name = 'alice_project'
$$, 'alice adds elements');
set local role postgres;
insert into ids select 'ada', id from public.elements where label = 'Ada';
insert into ids select 'grace', id from public.elements where label = 'Grace';

set local role authenticated;
set local request.jwt.claims = '{"sub":"a0000000-0000-4000-8000-000000000001","role":"authenticated"}';
select lives_ok($$
  insert into public.connections (project_id, from_element_id, to_element_id, connection_type)
  values ((select id from ids where name = 'alice_project'), (select id from ids where name = 'ada'),
          (select id from ids where name = 'grace'), 'mentor')
$$, 'alice connects two elements');
select is((select created_by from public.elements where label = 'Ada'),
  'a0000000-0000-4000-8000-000000000001'::uuid, 'created_by is set by the database');
select throws_ok($$
  insert into public.connections (project_id, from_element_id, to_element_id)
  values ((select id from ids where name = 'alice_project'), (select id from ids where name = 'ada'),
          (select id from ids where name = 'ada'))
$$, '23514', null, 'an element cannot connect to itself');
select throws_ok($$
  insert into public.elements (project_id, label, created_by)
  values ((select id from ids where name = 'alice_project'), 'Spoof', 'b0000000-0000-4000-8000-000000000002')
$$, '42501', null, 'clients cannot set created_by');
select throws_ok($$ update public.projects set created_by = 'b0000000-0000-4000-8000-000000000002' $$,
  '42501', null, 'clients cannot change a project owner column');
select throws_ok($$ insert into public.projects (name, created_by) values ('Direct', auth.uid()) $$,
  '42501', null, 'projects can only be created through create_project()');
set local role postgres;

-- ---------------------------------------------------------------- bob, a stranger
set local role authenticated;
set local request.jwt.claims = '{"sub":"b0000000-0000-4000-8000-000000000002","role":"authenticated"}';
select is((select count(*) from public.projects), 0::bigint, 'bob sees no projects');
select is((select count(*) from public.project_members), 0::bigint, 'bob sees no memberships');
select is((select count(*) from public.elements), 0::bigint, 'bob sees no elements');
select is((select count(*) from public.connections), 0::bigint, 'bob sees no connections');
select throws_ok($$
  insert into public.elements (project_id, label) values ((select id from ids where name = 'alice_project'), 'Intruder')
$$, '42501', null, 'bob cannot add elements to alice''s project');
select throws_ok($$
  insert into public.project_members (project_id, user_id, role)
  values ((select id from ids where name = 'alice_project'), auth.uid(), 'owner')
$$, '42501', null, 'bob cannot add himself to alice''s project');
update public.elements set label = 'Hacked' where id = (select id from ids where name = 'ada');
delete from public.elements where id = (select id from ids where name = 'grace');
delete from public.projects where id = (select id from ids where name = 'alice_project');
update public.projects set name = 'Hacked' where id = (select id from ids where name = 'alice_project');
select lives_ok($$ select public.create_project('Bob''s network') $$, 'bob creates his own project');
set local role postgres;
insert into ids select 'bob_project', id from public.projects where name = 'Bob''s network';

set local role authenticated;
set local request.jwt.claims = '{"sub":"b0000000-0000-4000-8000-000000000002","role":"authenticated"}';
insert into public.elements (project_id, label) select id, 'Bobby' from ids where name = 'bob_project';
select throws_ok($$
  insert into public.connections (project_id, from_element_id, to_element_id)
  values ((select id from ids where name = 'bob_project'),
          (select id from public.elements where label = 'Bobby'), (select id from ids where name = 'ada'))
$$, '23503', null, 'bob cannot connect his element to alice''s element');
select throws_ok($$
  update public.elements set project_id = (select id from ids where name = 'alice_project') where label = 'Bobby'
$$, '42501', null, 'elements cannot be moved to another project');
set local role postgres;

select is((select label from public.elements where id = (select id from ids where name = 'ada')), 'Ada',
  'bob''s update of alice''s element changed nothing');
select is((select count(*) from public.elements where project_id = (select id from ids where name = 'alice_project')),
  2::bigint, 'bob''s delete of alice''s element removed nothing');
select is((select name from public.projects where id = (select id from ids where name = 'alice_project')),
  'Alice''s network', 'bob could not rename or delete alice''s project');

-- ---------------------------------------------------------------- bob as a viewer
insert into public.project_members (project_id, user_id, role)
  select id, 'b0000000-0000-4000-8000-000000000002', 'viewer' from ids where name = 'alice_project';

set local role authenticated;
set local request.jwt.claims = '{"sub":"b0000000-0000-4000-8000-000000000002","role":"authenticated"}';
select is((select count(*) from public.elements where project_id = (select id from ids where name = 'alice_project')),
  2::bigint, 'a viewer can read the project''s elements');
select throws_ok($$
  insert into public.elements (project_id, label) values ((select id from ids where name = 'alice_project'), 'Viewer edit')
$$, '42501', null, 'a viewer cannot add elements');
update public.elements set label = 'Viewer edit' where id = (select id from ids where name = 'ada');
delete from public.connections where project_id = (select id from ids where name = 'alice_project');
select throws_ok($$ update public.project_members set role = 'owner' where user_id = auth.uid() $$,
  '42501', null, 'a viewer cannot promote himself');
set local role postgres;
select is((select label from public.elements where id = (select id from ids where name = 'ada')), 'Ada',
  'a viewer''s update changed nothing');
select is((select count(*) from public.connections where project_id = (select id from ids where name = 'alice_project')),
  1::bigint, 'a viewer''s delete removed nothing');

-- ---------------------------------------------------------------- magic link only
insert into auth.users (id, email, aud, role, encrypted_password)
  values ('c0000000-0000-4000-8000-000000000003', 'carol@example.com', 'authenticated', 'authenticated',
          '$2a$10$abcdefghijklmnopqrstuuJ0vEoGkqKk1NXqHrU1Y5jB3n2uYw6xS');
select is((select encrypted_password from auth.users where email = 'carol@example.com'), '',
  'passwords are stripped when a user is created');
update auth.users set encrypted_password = 'not-a-hash' where email = 'carol@example.com';
select is((select encrypted_password from auth.users where email = 'carol@example.com'), '',
  'passwords are stripped when a user is updated');

-- ---------------------------------------------------------------- deleting a project
set local role authenticated;
set local request.jwt.claims = '{"sub":"a0000000-0000-4000-8000-000000000001","role":"authenticated"}';
delete from public.projects where id = (select id from ids where name = 'alice_project');
set local role postgres;
select is((select count(*) from public.elements where project_id = (select id from ids where name = 'alice_project')),
  0::bigint, 'deleting a project deletes its elements');
select is((select count(*) from public.connections where project_id = (select id from ids where name = 'alice_project')),
  0::bigint, 'and its connections');

select * from finish();
rollback;
