# Relationship CRM (prototype)

A bare-bones tool for tracking relationships: create a project, add elements (people, organizations, …),
and connect them. Built on Supabase (Postgres + Auth), with access rules enforced in the database.

## Security model

- **Sign-in:** email magic link only. Passwords are erased by a database trigger, and new accounts must
  confirm their email before they get a session.
- **Access:** every table uses row level security. You only see a project, and anything in it, if you're
  a member of it: owner, editor, or viewer.
- **Locked columns:** clients can't set ids, owners or timestamps, move elements between projects,
  or re-point a connection after creating it.
- **Integrity:** a connection can never join elements from two different projects.
- **Limits:** 50 projects per user, 2,000 elements and 10,000 connections per project.

See `supabase/migrations/` for the schema and rules.

## Local development

Requires Docker (Colima works) and Node.

```sh
npm install
npx supabase start      # local Postgres, Auth, Studio and a test inbox (Mailpit)
npm run test:db         # access-control tests (pgTAP)
npm run test:auth       # end-to-end sign-in checks (takes about a minute)
```

- Studio: http://127.0.0.1:54323
- Test inbox for magic links: http://127.0.0.1:54324
