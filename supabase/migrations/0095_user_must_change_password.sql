-- 0095: must_change_password flag on public.users.
-- Enables forcing password change on first login or after admin reset / rotation.

alter table public.users
  add column if not exists must_change_password boolean not null default false;
