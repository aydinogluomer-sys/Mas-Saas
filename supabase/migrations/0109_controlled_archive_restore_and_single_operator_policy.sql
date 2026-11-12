-- 0109 — Kontrollü Arşiv Geri Yükleme Kapısı (A2 / F-14 / F-54) ve
-- Kontrollü Tek-Operatör 4-Göz Politikası Şeması (A1 / F-14 / F-46).
--
-- Kurallar:
--   * Üst-seviye işlem komutu (BEGIN/COMMIT) ve CONCURRENTLY indeks kullanılmaz.
--   * Sıfır kayan nokta; tüm yeni FK kolonları B-tree indeks taşır; 5-katman RLS/GRANT eksiksizdir.

-- ── 1) Kontrollü Arşiv Geri Yükleme (A2): 0024 değişmezlik bekçilerinin işlem-içi GUC ile açılması ─
create or replace function public.payments_archived_immutability_guard() returns trigger
language plpgsql as $$
declare
  locked boolean;
  was_incomplete boolean;
  is_completion boolean;
  is_controlled_restore boolean;
begin
  locked := old.status = 'archived'
    or old.archived_at is not null
    or old.archive_reason is not null
    or old.archived_by_label is not null;

  if not locked then
    return new;
  end if;

  is_controlled_restore :=
    current_setting('app.allow_archive_restore', true) = 'true'
    and new.status = 'active'
    and new.archived_at is null
    and new.archive_reason is null
    and new.archived_by_label is null
    and (to_jsonb(new) - array['archived_at', 'archive_reason', 'archived_by_label', 'status', 'updated_at'])
      = (to_jsonb(old) - array['archived_at', 'archive_reason', 'archived_by_label', 'status', 'updated_at']);

  if is_controlled_restore then
    return new;
  end if;

  was_incomplete := old.archived_at is null or old.archive_reason is null or old.archived_by_label is null;

  is_completion :=
    was_incomplete
    and new.status is not distinct from old.status
    and (old.archived_at is null or new.archived_at is not distinct from old.archived_at)
    and (old.archive_reason is null or new.archive_reason is not distinct from old.archive_reason)
    and (old.archived_by_label is null or new.archived_by_label is not distinct from old.archived_by_label)
    and (to_jsonb(new) - array['archived_at', 'archive_reason', 'archived_by_label', 'updated_at'])
      = (to_jsonb(old) - array['archived_at', 'archive_reason', 'archived_by_label', 'updated_at']);

  if is_completion then
    return new;
  end if;

  raise exception 'payments.% is archived and immutable (only filling missing archive metadata is permitted)', old.id;
end $$;

create or replace function public.archive_metadata_immutability_guard() returns trigger
language plpgsql as $$
declare
  locked boolean;
  was_incomplete boolean;
  is_completion boolean;
  is_controlled_restore boolean;
begin
  locked := old.archived_at is not null
    or old.archive_reason is not null
    or old.archived_by_label is not null;

  if not locked then
    return new;
  end if;

  is_controlled_restore :=
    current_setting('app.allow_archive_restore', true) = 'true'
    and new.archived_at is null
    and new.archive_reason is null
    and new.archived_by_label is null
    and (to_jsonb(new) - array['archived_at', 'archive_reason', 'archived_by_label', 'updated_at'])
      = (to_jsonb(old) - array['archived_at', 'archive_reason', 'archived_by_label', 'updated_at']);

  if is_controlled_restore then
    return new;
  end if;

  was_incomplete := old.archived_at is null or old.archive_reason is null or old.archived_by_label is null;

  is_completion :=
    was_incomplete
    and (old.archived_at is null or new.archived_at is not distinct from old.archived_at)
    and (old.archive_reason is null or new.archive_reason is not distinct from old.archive_reason)
    and (old.archived_by_label is null or new.archived_by_label is not distinct from old.archived_by_label)
    and (to_jsonb(new) - array['archived_at', 'archive_reason', 'archived_by_label', 'updated_at'])
      = (to_jsonb(old) - array['archived_at', 'archive_reason', 'archived_by_label', 'updated_at']);

  if is_completion then
    return new;
  end if;

  raise exception '%.% has archive metadata and is immutable (only filling missing archive metadata is permitted)', TG_TABLE_NAME, old.id;
end $$;

-- ── 2) Kontrollü Tek-Operatör 4-Göz Yönetişim Tablosu (A1): approval_governance_settings ────────
create table if not exists public.approval_governance_settings (
  singleton_id boolean primary key default true
    constraint approval_governance_settings_singleton check (singleton_id = true),
  allow_single_operator_self_approval boolean not null default true,
  min_justification_length integer not null default 10
    constraint approval_governance_settings_min_len_chk check (min_justification_length between 10 and 500),
  updated_by uuid references public.users(id) on delete set null,
  updated_at timestamptz not null default now()
);

create index if not exists idx_approval_governance_settings_updated_by
  on public.approval_governance_settings (updated_by);

drop trigger if exists approval_governance_settings_updated_at on public.approval_governance_settings;
create trigger approval_governance_settings_updated_at
  before update on public.approval_governance_settings
  for each row execute function public.set_updated_at();

insert into public.approval_governance_settings (
  singleton_id,
  allow_single_operator_self_approval,
  min_justification_length
)
values (true, true, 10)
on conflict (singleton_id) do nothing;

-- approval_config sınıfı (SELECT: 5 katman; INSERT/UPDATE/DELETE: yalnız mas_radar_admin)
alter table public.approval_governance_settings enable row level security;
revoke all on table public.approval_governance_settings from public, anon, authenticated, mas_radar_app;

grant select on table public.approval_governance_settings to
  mas_radar_viewer,
  mas_radar_finance_operator,
  mas_radar_finance_approver,
  mas_radar_finance_manager,
  mas_radar_admin;

grant insert, update, delete on table public.approval_governance_settings to mas_radar_admin;

drop policy if exists approval_governance_settings_tier_select on public.approval_governance_settings;
create policy approval_governance_settings_tier_select on public.approval_governance_settings
  for select to
    mas_radar_viewer,
    mas_radar_finance_operator,
    mas_radar_finance_approver,
    mas_radar_finance_manager,
    mas_radar_admin
  using (true);

drop policy if exists approval_governance_settings_tier_insert on public.approval_governance_settings;
create policy approval_governance_settings_tier_insert on public.approval_governance_settings
  for insert to mas_radar_admin
  with check (true);

drop policy if exists approval_governance_settings_tier_update on public.approval_governance_settings;
create policy approval_governance_settings_tier_update on public.approval_governance_settings
  for update to mas_radar_admin
  using (true)
  with check (true);

drop policy if exists approval_governance_settings_tier_delete on public.approval_governance_settings;
create policy approval_governance_settings_tier_delete on public.approval_governance_settings
  for delete to mas_radar_admin
  using (true);

-- ── 3) approvals & payment_runs: self_approved_override + gerekçe kısıtı genişletmesi ───────────
alter table public.approvals
  add column if not exists self_approved_override boolean not null default false,
  add column if not exists self_approval_justification text;

alter table public.approvals
  drop constraint if exists approvals_maker_is_not_checker,
  drop constraint if exists approvals_self_override_justification_chk;

alter table public.approvals
  add constraint approvals_self_override_justification_chk check (
    not self_approved_override
    or length(btrim(coalesce(self_approval_justification, ''))) >= 10
  ),
  add constraint approvals_maker_is_not_checker check (
    decided_by is null
    or requested_by is null
    or decided_by <> requested_by
    or (
      self_approved_override = true
      and length(btrim(coalesce(self_approval_justification, ''))) >= 10
    )
  );

alter table public.payment_runs
  add column if not exists self_approved_override boolean not null default false,
  add column if not exists self_approval_justification text;

alter table public.payment_runs
  drop constraint if exists payment_runs_maker_is_not_checker,
  drop constraint if exists payment_runs_self_override_justification_chk;

alter table public.payment_runs
  add constraint payment_runs_self_override_justification_chk check (
    not self_approved_override
    or length(btrim(coalesce(self_approval_justification, ''))) >= 10
  ),
  add constraint payment_runs_maker_is_not_checker check (
    approved_by is null
    or approved_by <> created_by
    or (
      self_approved_override = true
      and length(btrim(coalesce(self_approval_justification, ''))) >= 10
    )
  );
