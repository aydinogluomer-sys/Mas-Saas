-- 0121 — Kurumsal Mimari Boşluk Kapatma: Grup İçi Konsolidasyon Eliminasyonu
-- (intercompany_elimination_runs / intercompany_elimination_lines), Self-Servis Parola Sıfırlama
-- (password_reset_tokens), Kurumsal SSO Kimlik Sağlayıcı Kayıtları (sso_identity_providers),
-- Kayıt Bazlı İşbirliği & @mention Yorumları (entity_comments) ve Atölye Kiosk Duruş Kolonları.
--
-- Kurallar:
--   * Üst-seviye işlem komutu ve eşzamanlı indeks kullanılmaz.
--   * Tüm parasal kolonlar tam kesinlikli numeric(18,2) tipindedir.
--   * Tüm yeni tablolar 5-katman RLS/GRANT kalkanı ve eksiksiz FK indeksleri taşır.

-- ── 1) Grup İçi Konsolidasyon Eliminasyon Çalıştırmaları & Satırları (operational sınıfı) ──────
create table if not exists public.intercompany_elimination_runs (
  id uuid primary key default gen_random_uuid(),
  period_start date not null,
  period_end date not null,
  status text not null default 'posted'
    check (status in ('draft', 'posted', 'reversed')),
  eliminated_ar_ap_try numeric(18,2) not null default 0
    check (eliminated_ar_ap_try >= 0),
  eliminated_rev_exp_try numeric(18,2) not null default 0
    check (eliminated_rev_exp_try >= 0),
  matched_pair_count int not null default 0
    check (matched_pair_count >= 0),
  notes text,
  created_by uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  check (period_end >= period_start)
);

create index if not exists idx_ic_elim_runs_created_by
  on public.intercompany_elimination_runs (created_by)
  where created_by is not null;

create index if not exists idx_ic_elim_runs_period
  on public.intercompany_elimination_runs (period_start, period_end, created_at desc);

create or replace function public.intercompany_elimination_runs_status_transition_guard()
returns trigger
language plpgsql
as $$
begin
  if new.status is not distinct from old.status then
    return new;
  end if;

  if (old.status, new.status) not in (
    ('draft', 'posted'),
    ('draft', 'reversed'),
    ('posted', 'reversed')
  ) then
    raise exception 'intercompany_elimination_runs.% status geçişi %→% izinli değil',
      old.id, old.status, new.status
      using errcode = '23514';
  end if;

  return new;
end $$;

drop trigger if exists intercompany_elimination_runs_status_guard on public.intercompany_elimination_runs;
create trigger intercompany_elimination_runs_status_guard
  before update on public.intercompany_elimination_runs
  for each row execute function public.intercompany_elimination_runs_status_transition_guard();

create table if not exists public.intercompany_elimination_lines (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.intercompany_elimination_runs(id) on delete cascade,
  seller_entity_id uuid references public.legal_entities(id) on delete set null,
  buyer_entity_id uuid references public.legal_entities(id) on delete set null,
  elimination_kind text not null
    check (elimination_kind in ('ar_ap_120_320', 'rev_exp_600_7xx')),
  debit_account_code text not null
    check (btrim(debit_account_code) <> ''),
  credit_account_code text not null
    check (btrim(credit_account_code) <> ''),
  amount_try numeric(18,2) not null
    check (amount_try >= 0),
  source_invoice_id uuid references public.invoices(id) on delete set null,
  description text not null
    check (btrim(description) <> ''),
  created_at timestamptz not null default now()
);

create index if not exists idx_ic_elim_lines_run_id
  on public.intercompany_elimination_lines (run_id);

create index if not exists idx_ic_elim_lines_seller_entity
  on public.intercompany_elimination_lines (seller_entity_id)
  where seller_entity_id is not null;

create index if not exists idx_ic_elim_lines_buyer_entity
  on public.intercompany_elimination_lines (buyer_entity_id)
  where buyer_entity_id is not null;

create index if not exists idx_ic_elim_lines_source_invoice
  on public.intercompany_elimination_lines (source_invoice_id)
  where source_invoice_id is not null;

-- ── 2) Parola Sıfırlama Jetonları (password_reset_tokens — auth_users sınıfı + app_runtime) ────
create table if not exists public.password_reset_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  token_sha256 text not null unique
    check (btrim(token_sha256) <> ''),
  expires_at timestamptz not null,
  consumed_at timestamptz,
  requested_ip text,
  created_at timestamptz not null default now()
);

create index if not exists idx_password_reset_tokens_user_id
  on public.password_reset_tokens (user_id, created_at desc);

-- ── 3) Kurumsal SSO & Passkey Kimlik Sağlayıcıları (sso_identity_providers — config sınıfı) ────
create table if not exists public.sso_identity_providers (
  id uuid primary key default gen_random_uuid(),
  provider_key text not null unique
    check (provider_key in ('entra_id', 'google_workspace', 'custom_oidc', 'webauthn_passkey')),
  display_name text not null
    check (btrim(display_name) <> ''),
  issuer_url text,
  client_id text,
  allowed_domains text[] not null default '{}',
  is_enabled boolean not null default false,
  updated_by uuid references public.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_sso_identity_providers_updated_by
  on public.sso_identity_providers (updated_by)
  where updated_by is not null;

drop trigger if exists sso_identity_providers_updated_at on public.sso_identity_providers;
create trigger sso_identity_providers_updated_at
  before update on public.sso_identity_providers
  for each row execute function public.set_updated_at();

insert into public.sso_identity_providers (provider_key, display_name, allowed_domains, is_enabled)
values
  ('entra_id',          'Microsoft Entra ID (Azure AD)', '{}', false),
  ('google_workspace',  'Google Workspace Kurumsal SSO', '{}', false),
  ('custom_oidc',       'Özel OpenID Connect (OIDC)',    '{}', false),
  ('webauthn_passkey',  'FIDO2 / WebAuthn Passkey',      '{}', false)
on conflict (provider_key) do nothing;

-- ── 4) Kayıt Bazlı İşbirliği Yorumları & @mention (entity_comments — personal/owner-scoped) ────
create table if not exists public.entity_comments (
  id uuid primary key default gen_random_uuid(),
  entity_table text not null
    check (btrim(entity_table) <> ''),
  entity_id text not null
    check (btrim(entity_id) <> ''),
  body text not null
    check (char_length(trim(body)) between 1 and 4000),
  mentioned_usernames text[] not null default '{}',
  author_id uuid not null references public.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create index if not exists idx_entity_comments_author_id
  on public.entity_comments (author_id);

create index if not exists idx_entity_comments_target
  on public.entity_comments (entity_table, entity_id, created_at desc);

create index if not exists idx_entity_comments_mentions_gin
  on public.entity_comments using gin (mentioned_usernames);

-- user_display_label (0098) ile simetrik, parola özeti/kilit sızdırmadan yalnız username döndüren yardımcı
create or replace function public.user_username_label(p_user_id uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select case
    when p_user_id is null then null
    when current_user in (
      'mas_radar_viewer',
      'mas_radar_finance_operator',
      'mas_radar_finance_approver',
      'mas_radar_finance_manager',
      'mas_radar_admin',
      'postgres'
    ) then (select u.username from public.users u where u.id = p_user_id)
    else null
  end;
$$;

revoke all on function public.user_username_label(uuid)
  from public, anon, authenticated, mas_radar_app;
grant execute on function public.user_username_label(uuid)
  to mas_radar_viewer, mas_radar_finance_operator, mas_radar_finance_approver,
     mas_radar_finance_manager, mas_radar_admin;

-- ── 5) Atölye Kiosk Duruş & Operatör Kolonları (work_orders genişletmesi) ──────────────────────
alter table public.work_orders
  add column if not exists downtime_reason text,
  add column if not exists last_kiosk_event_at timestamptz,
  add column if not exists operator_note text;

-- ── 6) 5-Katman RLS & GRANT Kalkanı ───────────────────────────────────────────────────────────
do $$
declare
  tbl text;
begin
  -- 6a) operational sınıfı: intercompany_elimination_runs, intercompany_elimination_lines
  foreach tbl in array array['intercompany_elimination_runs', 'intercompany_elimination_lines'] loop
    execute format('alter table public.%I enable row level security', tbl);
    execute format('revoke all on table public.%I from public, anon, authenticated, mas_radar_app', tbl);
    execute format(
      'grant select on table public.%I to mas_radar_viewer, mas_radar_finance_operator, mas_radar_finance_approver, mas_radar_finance_manager, mas_radar_admin',
      tbl
    );
    execute format(
      'grant insert, update on table public.%I to mas_radar_finance_operator, mas_radar_finance_manager, mas_radar_admin',
      tbl
    );
    execute format(
      'grant delete on table public.%I to mas_radar_finance_manager, mas_radar_admin',
      tbl
    );

    execute format('drop policy if exists %I on public.%I', tbl || '_select_all_tiers', tbl);
    execute format(
      'create policy %I on public.%I for select to mas_radar_viewer, mas_radar_finance_operator, mas_radar_finance_approver, mas_radar_finance_manager, mas_radar_admin using (true)',
      tbl || '_select_all_tiers', tbl
    );
    execute format('drop policy if exists %I on public.%I', tbl || '_insert_enter', tbl);
    execute format(
      'create policy %I on public.%I for insert to mas_radar_finance_operator, mas_radar_finance_manager, mas_radar_admin with check (true)',
      tbl || '_insert_enter', tbl
    );
    execute format('drop policy if exists %I on public.%I', tbl || '_update_enter', tbl);
    execute format(
      'create policy %I on public.%I for update to mas_radar_finance_operator, mas_radar_finance_manager, mas_radar_admin using (true) with check (true)',
      tbl || '_update_enter', tbl
    );
    execute format('drop policy if exists %I on public.%I', tbl || '_delete_manage', tbl);
    execute format(
      'create policy %I on public.%I for delete to mas_radar_finance_manager, mas_radar_admin using (true)',
      tbl || '_delete_manage', tbl
    );
  end loop;

  -- 6b) auth_users + app_runtime sınıfı: password_reset_tokens
  -- Katmansız /login sıfırlama akışı (mas_radar_app) sessions gibi doğrudan doğrulama/tüketim yapabilir;
  -- katmanlı oturumlarda her katman yalnız kendi satırını okuyabilir, tam yönetim yalnız mas_radar_admin'dedir.
  alter table public.password_reset_tokens enable row level security;
  revoke all on table public.password_reset_tokens from public, anon, authenticated, mas_radar_app;
  grant select on table public.password_reset_tokens
    to mas_radar_viewer, mas_radar_finance_operator, mas_radar_finance_approver, mas_radar_finance_manager, mas_radar_admin;
  grant insert, update, delete on table public.password_reset_tokens
    to mas_radar_admin;
  grant select, insert, update, delete on table public.password_reset_tokens
    to mas_radar_app;

  drop policy if exists password_reset_tokens_select_all_tiers on public.password_reset_tokens;
  create policy password_reset_tokens_select_all_tiers on public.password_reset_tokens
    for select to mas_radar_viewer, mas_radar_finance_operator, mas_radar_finance_approver, mas_radar_finance_manager, mas_radar_admin
    using (user_id = public.current_app_user() or current_user = 'mas_radar_admin');

  drop policy if exists password_reset_tokens_insert_admin on public.password_reset_tokens;
  create policy password_reset_tokens_insert_admin on public.password_reset_tokens
    for insert to mas_radar_admin
    with check (true);

  drop policy if exists password_reset_tokens_update_admin on public.password_reset_tokens;
  create policy password_reset_tokens_update_admin on public.password_reset_tokens
    for update to mas_radar_admin
    using (true) with check (true);

  drop policy if exists password_reset_tokens_delete_admin on public.password_reset_tokens;
  create policy password_reset_tokens_delete_admin on public.password_reset_tokens
    for delete to mas_radar_admin
    using (true);

  drop policy if exists password_reset_tokens_app_runtime on public.password_reset_tokens;
  create policy password_reset_tokens_app_runtime on public.password_reset_tokens
    for all to mas_radar_app
    using (true) with check (true);

  -- 6c) config sınıfı: sso_identity_providers (/login ekranında aktif sağlayıcıları göstermek için mas_radar_app SELECT dahil)
  alter table public.sso_identity_providers enable row level security;
  revoke all on table public.sso_identity_providers from public, anon, authenticated, mas_radar_app;
  grant select on table public.sso_identity_providers
    to mas_radar_app, mas_radar_viewer, mas_radar_finance_operator, mas_radar_finance_approver, mas_radar_finance_manager, mas_radar_admin;
  grant insert, update, delete on table public.sso_identity_providers
    to mas_radar_admin;

  drop policy if exists sso_identity_providers_select_all_tiers on public.sso_identity_providers;
  create policy sso_identity_providers_select_all_tiers on public.sso_identity_providers
    for select to mas_radar_viewer, mas_radar_finance_operator, mas_radar_finance_approver, mas_radar_finance_manager, mas_radar_admin
    using (true);

  drop policy if exists sso_identity_providers_select_app_runtime on public.sso_identity_providers;
  create policy sso_identity_providers_select_app_runtime on public.sso_identity_providers
    for select to mas_radar_app
    using (true);

  drop policy if exists sso_identity_providers_insert_admin on public.sso_identity_providers;
  create policy sso_identity_providers_insert_admin on public.sso_identity_providers
    for insert to mas_radar_admin
    with check (true);

  drop policy if exists sso_identity_providers_update_admin on public.sso_identity_providers;
  create policy sso_identity_providers_update_admin on public.sso_identity_providers
    for update to mas_radar_admin
    using (true) with check (true);

  drop policy if exists sso_identity_providers_delete_admin on public.sso_identity_providers;
  create policy sso_identity_providers_delete_admin on public.sso_identity_providers
    for delete to mas_radar_admin
    using (true);

  -- 6d) personal (owner-scoped) sınıfı: entity_comments
  alter table public.entity_comments enable row level security;
  revoke all on table public.entity_comments from public, anon, authenticated, mas_radar_app;
  grant select on table public.entity_comments
    to mas_radar_viewer, mas_radar_finance_operator, mas_radar_finance_approver, mas_radar_finance_manager, mas_radar_admin;
  grant insert, update, delete on table public.entity_comments
    to mas_radar_finance_operator, mas_radar_finance_approver, mas_radar_finance_manager, mas_radar_admin;

  drop policy if exists entity_comments_select_all_tiers on public.entity_comments;
  create policy entity_comments_select_all_tiers on public.entity_comments
    for select to mas_radar_viewer, mas_radar_finance_operator, mas_radar_finance_approver, mas_radar_finance_manager, mas_radar_admin
    using (true);

  drop policy if exists entity_comments_insert_own on public.entity_comments;
  create policy entity_comments_insert_own on public.entity_comments
    for insert to mas_radar_finance_operator, mas_radar_finance_approver, mas_radar_finance_manager, mas_radar_admin
    with check (
      author_id is not distinct from public.current_app_user()
      or current_user in ('mas_radar_finance_manager', 'mas_radar_admin')
    );

  drop policy if exists entity_comments_update_own on public.entity_comments;
  create policy entity_comments_update_own on public.entity_comments
    for update to mas_radar_finance_operator, mas_radar_finance_approver
    using (author_id = public.current_app_user())
    with check (author_id = public.current_app_user());

  drop policy if exists entity_comments_update_manage on public.entity_comments;
  create policy entity_comments_update_manage on public.entity_comments
    for update to mas_radar_finance_manager, mas_radar_admin
    using (true) with check (true);

  drop policy if exists entity_comments_delete_own on public.entity_comments;
  create policy entity_comments_delete_own on public.entity_comments
    for delete to mas_radar_finance_operator, mas_radar_finance_approver
    using (author_id = public.current_app_user());

  drop policy if exists entity_comments_delete_manage on public.entity_comments;
  create policy entity_comments_delete_manage on public.entity_comments
    for delete to mas_radar_finance_manager, mas_radar_admin
    using (true);
end $$;
