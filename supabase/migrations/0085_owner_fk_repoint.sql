-- Faz 36 — repoint four ownership foreign keys from `auth.users` to `public.users`.
--
-- ═══ A REAL, SHIPPED BUG, FOUND BY RUNNING THE CODE RATHER THAN READING IT ═══
--
-- `auth.users` is EMPTY in this deployment — it exists because local-bootstrap.sql creates the
-- schema Supabase-style migrations expect, but nothing ever inserts into it. The application's
-- accounts live in `public.users` (Faz 15), and `session.id` is a `public.users` id.
--
-- Four tables nonetheless declared `references auth.users(id)`:
--
--     background_jobs.created_by     (Faz 33)
--     documents.created_by           (Faz 35)
--     attachments.uploaded_by        (Faz 35)
--     document_links.created_by      (Faz 35)
--
-- Every one of those columns is unsatisfiable with a real session id. Measured, not inferred:
--
--     insert into public.documents (title, doc_type, created_by) values ('x','other', <session id>)
--     ERROR: violates foreign key constraint "documents_created_by_fkey"
--
-- So `createDocument()` — the only way to file a document — fails for every logged-in user, and
-- `enqueueJob()` fails whenever a real actor is passed. Both shipped.
--
-- ═══ WHY NEITHER GATE CAUGHT IT ═══
--
-- Worth writing down, because the lesson is bigger than the bug. phase33:verify called
-- `enqueueJob(pool, …, null)` and phase35:verify inserted documents with raw SQL that omitted
-- `created_by`. Both gates exercised the code path with the ONE value that happens to satisfy a
-- broken FK — NULL — and so both reported green on a feature that could not work for any actual
-- user. A fixture that avoids the field under test is not a test of it.
--
-- phase36:verify now asserts, over the whole schema, that no ownership column points at
-- `auth.users` while that table is empty — so the next table to make this mistake fails on the
-- day it is written.
--
-- The correct target is `public.users`, which is what the owner-scoped tables that actually work
-- have always used (`action_items.created_by`, `scenarios.created_by`, migration 0058's `c_owned`).

-- No data migration is needed: every one of these columns is currently NULL everywhere, precisely
-- because a non-null value was impossible. Verified before writing this — if any row DID carry a
-- value it would be an auth.users id with no corresponding public.users row, and the ALTER below
-- would fail loudly rather than silently dropping the reference.

alter table public.background_jobs
  drop constraint if exists background_jobs_created_by_fkey;
alter table public.background_jobs
  add constraint background_jobs_created_by_fkey
  foreign key (created_by) references public.users(id);

alter table public.documents
  drop constraint if exists documents_created_by_fkey;
alter table public.documents
  add constraint documents_created_by_fkey
  foreign key (created_by) references public.users(id);

alter table public.attachments
  drop constraint if exists attachments_uploaded_by_fkey;
alter table public.attachments
  add constraint attachments_uploaded_by_fkey
  foreign key (uploaded_by) references public.users(id);

alter table public.document_links
  drop constraint if exists document_links_created_by_fkey;
alter table public.document_links
  add constraint document_links_created_by_fkey
  foreign key (created_by) references public.users(id);
