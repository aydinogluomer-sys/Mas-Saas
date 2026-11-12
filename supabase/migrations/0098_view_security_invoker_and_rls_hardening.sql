-- 0098 — Faz 39 (A1): PostgreSQL görünüm (security_invoker = true) kalkanı, public.sessions
-- yönetici RLS onarımı, sahiplik sahteciliği koruması ve maker-checker / planlama onay kapıları.
--
-- Not: scripts/db/migration-lib.ts kuralları gereği dosya üst-seviye işlem komutu veya
-- eşzamanlı indeks içermez; tüm bloklar idempotent çalışır.

-- ── 1) Varsayılan yetkiler ve mas_radar_app NOINHERIT sertleştirmesi ───────────────────────
-- 0035 tüm yeni tablolarda authenticated rolüne varsayılan INSERT/UPDATE/DELETE vermişti.
-- Gelecekteki tablolarda yazma yetkisi yalnız ilgili katman rollerine açıkça verilir.
alter default privileges in schema public
  revoke insert, update, delete on tables from authenticated;

-- mas_radar_app katmansız (unswitched) kimlik doğrulama havuzunda (getRawPool) yalnız şema
-- erişimi, users/sessions kimlik sorguları ve db:roles:verify / db:roles-rls:verify salt-okunur
-- RLS sondası (payments üzerinde 0 satır dönen SELECT) için doğrudan yetki taşır; hiçbir iş
-- tablosunda INSERT/UPDATE/DELETE miras almaz.
grant usage on schema public to mas_radar_app;
grant select, update on table public.users to mas_radar_app;
grant select, insert, update on table public.sessions to mas_radar_app;
grant select on table public.payments to mas_radar_app;
grant execute on function public.current_app_user() to mas_radar_app;
grant execute on function public.current_app_role() to mas_radar_app;

alter role mas_radar_app noinherit;

-- ── 2) Oturum parola-hazır yüklemi ve güvenli kullanıcı görünen-ad yardımcısı ──────────────
-- session_password_ready(): çağrıyı yapan kullanıcının aktif, kilitsiz ve zorunlu parola
-- değişimi (0095) beklemeyen gerçek bir oturum kimliği (app.user_id) taşıdığını doğrular.
-- users_self_read (0058) üzerinden kendi satırını okuduğu için SECURITY DEFINER gerektirmez.
create or replace function public.session_password_ready()
returns boolean
language sql
stable
as $$
  select exists (
    select 1
      from public.users u
     where u.id = public.current_app_user()
       and u.is_active = true
       and u.must_change_password = false
       and (u.locked_until is null or u.locked_until <= now())
  );
$$;

grant execute on function public.session_password_ready()
  to authenticated, mas_radar_viewer, mas_radar_finance_operator,
     mas_radar_finance_approver, mas_radar_finance_manager, mas_radar_admin;

-- user_display_label(uuid): approval_queue görünümü security_invoker = true olduğunda
-- onaylayıcı/izleyici katmanları public.users tablosunda başka kullanıcıların satırını
-- doğrudan okuyamaz (ve okumamalıdır: password_hash, locked_until, failed_login_count gizlidir).
-- Bu dar fonksiyon sabit search_path altında yalnız görünen adı (display_name) döndürür.
create or replace function public.user_display_label(p_user_id uuid)
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
    ) then (select u.display_name from public.users u where u.id = p_user_id)
    else null
  end;
$$;

revoke all on function public.user_display_label(uuid)
  from public, anon, authenticated, mas_radar_app;
grant execute on function public.user_display_label(uuid)
  to mas_radar_viewer, mas_radar_finance_operator, mas_radar_finance_approver,
     mas_radar_finance_manager, mas_radar_admin;

-- approval_queue (0055:209) görünümünü public.users doğrudan join'i yerine user_display_label()
-- ile ve security_invoker = true olarak yenile (kolon sırası ve tipleri birebir korunur).
create or replace view public.approval_queue
with (security_invoker = true) as
  select
    a.id, a.subject_table, a.subject_id, a.subject_label, a.request_kind, a.rule_code,
    a.round_no, a.status, a.subject_status, a.amount, a.currency,
    a.requested_by, a.requested_at, a.decided_by, a.decided_at, a.decision_note,
    public.user_display_label(a.requested_by) as requested_by_name,
    public.user_display_label(a.decided_by) as decided_by_name,
    (select count(*) from public.approval_steps s where s.approval_id = a.id) as step_count
  from public.approvals a;

-- ── 3) public şemasındaki TÜM görünümlerde security_invoker = true ve yazma iptali ─────────
do $do$
declare
  r record;
begin
  for r in
    select c.relname
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relkind = 'v'
     order by c.relname
  loop
    execute format('alter view public.%I set (security_invoker = true)', r.relname);
    execute format(
      'revoke insert, update, delete, truncate on table public.%I from public, anon, authenticated, '
      'mas_radar_app, mas_radar_viewer, mas_radar_finance_operator, mas_radar_finance_approver, '
      'mas_radar_finance_manager, mas_radar_admin',
      r.relname
    );
    execute format(
      'grant select on table public.%I to mas_radar_viewer, mas_radar_finance_operator, '
      'mas_radar_finance_approver, mas_radar_finance_manager, mas_radar_admin',
      r.relname
    );
  end loop;
end $do$;

-- ── 4) public.sessions yönetici okuma ve iptal RLS politikaları (B2-02) ────────────────────
drop policy if exists sessions_admin_read on public.sessions;
create policy sessions_admin_read on public.sessions
  for select to mas_radar_admin
  using (public.session_password_ready());

drop policy if exists sessions_admin_revoke on public.sessions;
create policy sessions_admin_revoke on public.sessions
  for update to mas_radar_admin
  using (public.session_password_ready() and revoked_at is null)
  with check (public.session_password_ready() and revoked_at is not null);

-- ── 5) Sahiplik sahteciliği (saved_views, assistant_conversations) ve kuyruk koruması ──────
-- `created_by is not distinct from public.current_app_user()` kuralı:
--   * Oturumlu istekte (current_app_user() = UUID_A) başka bir kullanıcı adına (UUID_B) veya
--     NULL olarak kayıt açılmasını 42501 RLS hatasıyla reddeder.
--   * Kimliksiz bağlantıda (current_app_user() = NULL) gerçek bir UUID ile sahte kayıt açılmasını
--     42501 RLS hatasıyla reddeder; created_by kolonu NOT NULL olduğu için NULL satır da 23502
--     kısıtıyla asla yazılamaz (db:roles-rls:verify default-values INSERT sondasıyla tam uyumlu).
drop policy if exists saved_views_insert_own on public.saved_views;
drop policy if exists saved_views_insert_enter on public.saved_views;
create policy saved_views_insert_own on public.saved_views
  for insert to mas_radar_finance_operator, mas_radar_finance_approver,
                mas_radar_finance_manager, mas_radar_admin
  with check (created_by is not distinct from public.current_app_user());

drop policy if exists assistant_conversations_insert_enter on public.assistant_conversations;
create policy assistant_conversations_insert_enter on public.assistant_conversations
  for insert to mas_radar_finance_operator, mas_radar_finance_approver,
                mas_radar_finance_manager, mas_radar_admin
  with check (created_by is not distinct from public.current_app_user());

-- background_jobs: yalnız manager/admin (ve runAsSystem -> finance_manager) tüm işleri
-- güncelleyebilir; finance_operator yalnız kendi kuyruğa aldığı 'queued' işi 'cancelled' yapabilir.
drop policy if exists background_jobs_update_enter on public.background_jobs;
drop policy if exists background_jobs_update_manage on public.background_jobs;
drop policy if exists background_jobs_update_own_cancel on public.background_jobs;

create policy background_jobs_update_manage on public.background_jobs
  for update to mas_radar_finance_manager, mas_radar_admin
  using (true)
  with check (true);

create policy background_jobs_update_own_cancel on public.background_jobs
  for update to mas_radar_finance_operator
  using (created_by = public.current_app_user() and status = 'queued')
  with check (
    created_by = public.current_app_user()
    and status = 'cancelled'
    and finished_at is not null
  );

-- ── 6) Maker-checker legacy geri yazımı (mapping_reviews & external_assumptions — B2-05) ───
grant select, update on table public.mapping_reviews to mas_radar_finance_approver;
grant select, update on table public.external_assumptions to mas_radar_finance_approver;

drop policy if exists mapping_reviews_approver_writeback on public.mapping_reviews;
create policy mapping_reviews_approver_writeback on public.mapping_reviews
  for update to mas_radar_finance_approver
  using (
    public.current_app_user() is not null
    and exists (
      select 1
        from public.approvals a
       where a.subject_table = 'mapping_reviews'
         and a.subject_id = mapping_reviews.id
         and a.requested_by is distinct from public.current_app_user()
    )
  )
  with check (
    reviewed_by = public.current_app_user()
    and exists (
      select 1
        from public.approvals a
       where a.subject_table = 'mapping_reviews'
         and a.subject_id = mapping_reviews.id
         and a.requested_by is distinct from public.current_app_user()
    )
  );

drop policy if exists external_assumptions_approver_writeback on public.external_assumptions;
create policy external_assumptions_approver_writeback on public.external_assumptions
  for update to mas_radar_finance_approver
  using (
    public.current_app_user() is not null
    and exists (
      select 1
        from public.approvals a
       where a.subject_table = 'external_assumptions'
         and a.subject_id = external_assumptions.id
         and a.requested_by is distinct from public.current_app_user()
    )
  )
  with check (
    reviewed_by = public.current_app_user()
    and exists (
      select 1
        from public.approvals a
       where a.subject_table = 'external_assumptions'
         and a.subject_id = external_assumptions.id
         and a.requested_by is distinct from public.current_app_user()
    )
  );

create or replace function public.enforce_approver_legacy_writeback_columns()
returns trigger
language plpgsql
as $$
declare
  v_table text := tg_table_name;
begin
  if current_user <> 'mas_radar_finance_approver' then
    return new;
  end if;

  if v_table = 'mapping_reviews' then
    if (to_jsonb(new) - array['status', 'reviewed_at', 'reviewed_by', 'updated_at'])
       is distinct from
       (to_jsonb(old) - array['status', 'reviewed_at', 'reviewed_by', 'updated_at'])
    then
      raise exception 'Onaylayıcı mapping_reviews üzerinde yalnız inceleme durumunu güncelleyebilir.'
        using errcode = 'insufficient_privilege';
    end if;
    if new.status is not distinct from old.status and new.reviewed_by is not distinct from old.reviewed_by then
      raise exception 'Onaylayıcı mapping_reviews üzerinde geçerli bir karar değişikliği yapmalıdır.'
        using errcode = 'insufficient_privilege';
    end if;
  elsif v_table = 'external_assumptions' then
    if (to_jsonb(new) - array['review_status', 'reviewed_at', 'reviewed_by', 'updated_at'])
       is distinct from
       (to_jsonb(old) - array['review_status', 'reviewed_at', 'reviewed_by', 'updated_at'])
    then
      raise exception 'Onaylayıcı external_assumptions üzerinde yalnız inceleme durumunu güncelleyebilir.'
        using errcode = 'insufficient_privilege';
    end if;
    if new.review_status is not distinct from old.review_status and new.reviewed_by is not distinct from old.reviewed_by then
      raise exception 'Onaylayıcı external_assumptions üzerinde geçerli bir karar değişikliği yapmalıdır.'
        using errcode = 'insufficient_privilege';
    end if;
  end if;

  return new;
end $$;

drop trigger if exists mapping_reviews_approver_column_guard on public.mapping_reviews;
create trigger mapping_reviews_approver_column_guard
  before update on public.mapping_reviews
  for each row execute function public.enforce_approver_legacy_writeback_columns();

drop trigger if exists external_assumptions_approver_column_guard on public.external_assumptions;
create trigger external_assumptions_approver_column_guard
  before update on public.external_assumptions
  for each row execute function public.enforce_approver_legacy_writeback_columns();

-- ── 7) Bütçe ve tahmin satırlarında onay rolü kapısı (budget_lines & forecast_lines — B2-06)
grant select, update on table public.budget_lines to mas_radar_finance_approver;
grant select, update on table public.forecast_lines to mas_radar_finance_approver;

drop policy if exists budget_lines_approve on public.budget_lines;
create policy budget_lines_approve on public.budget_lines
  for update to mas_radar_finance_approver
  using (
    version_status = 'draft'
    and created_by is distinct from public.current_app_user()
  )
  with check (
    version_status = 'approved'
    and approved_by = public.current_app_user()
    and created_by is distinct from public.current_app_user()
  );

drop policy if exists forecast_lines_approve on public.forecast_lines;
create policy forecast_lines_approve on public.forecast_lines
  for update to mas_radar_finance_approver
  using (
    version_status = 'draft'
    and created_by is distinct from public.current_app_user()
  )
  with check (
    version_status = 'approved'
    and approved_by = public.current_app_user()
    and created_by is distinct from public.current_app_user()
  );

create or replace function public.enforce_planning_approval_role()
returns trigger
language plpgsql
as $$
declare
  v_allowed_approvers constant text[] := array[
    'mas_radar_finance_approver',
    'mas_radar_finance_manager',
    'mas_radar_admin',
    'postgres'
  ];
begin
  if new.version_status = 'approved' and not (current_user = any(v_allowed_approvers)) then
    raise exception 'Bütçe/tahmin satırını onaylama yetkisi yalnız onaylayıcı ve üstü katmanlardadır (rol: %).',
      current_user
      using errcode = 'insufficient_privilege';
  end if;

  if tg_op = 'UPDATE' then
    if old.version_status = 'approved'
       and new.amount is distinct from old.amount
       and not (current_user = any(v_allowed_approvers))
    then
      raise exception 'Onaylanmış bütçe/tahmin satırının tutarı operatör tarafından değiştirilemez.'
        using errcode = 'insufficient_privilege';
    end if;

    if current_user = 'mas_radar_finance_approver' then
      if (to_jsonb(new) - array['version_status', 'approved_at', 'approved_by', 'notes', 'updated_at'])
         is distinct from
         (to_jsonb(old) - array['version_status', 'approved_at', 'approved_by', 'notes', 'updated_at'])
      then
        raise exception 'Onaylayıcı bütçe/tahmin satırının tutar veya boyut kolonlarını değiştiremez.'
          using errcode = 'insufficient_privilege';
      end if;
    end if;
  end if;

  return new;
end $$;

drop trigger if exists budget_lines_approval_role_guard on public.budget_lines;
create trigger budget_lines_approval_role_guard
  before insert or update on public.budget_lines
  for each row execute function public.enforce_planning_approval_role();

drop trigger if exists forecast_lines_approval_role_guard on public.forecast_lines;
create trigger forecast_lines_approval_role_guard
  before insert or update on public.forecast_lines
  for each row execute function public.enforce_planning_approval_role();

-- ── 8) Kendi kendini doğrulama (0 istisna) ─────────────────────────────────────────────────
do $verify$
declare
  v_unprotected_views text;
  v_viewer_writes text;
  v_app_inherit boolean;
begin
  select string_agg(c.relname, ', ' order by c.relname)
    into v_unprotected_views
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relkind = 'v'
     and not ('security_invoker=true' = any(coalesce(c.reloptions, array[]::text[])));

  if v_unprotected_views is not null then
    raise exception '0098: security_invoker=true eksik görünümler: %', v_unprotected_views;
  end if;

  select rolinherit into v_app_inherit from pg_roles where rolname = 'mas_radar_app';
  if v_app_inherit is distinct from false then
    raise exception '0098: mas_radar_app NOINHERIT durumunda değil (rolinherit=%)', v_app_inherit;
  end if;

  select string_agg(tablename || '.' || policyname, ', ' order by tablename, policyname)
    into v_viewer_writes
    from pg_policies
   where schemaname = 'public'
     and cmd <> 'SELECT'
     and 'mas_radar_viewer' = any(roles::text[]);

  if v_viewer_writes is distinct from 'audit_logs.audit_logs_insert_own_password_change' then
    raise exception '0098: viewer yazma politikası değişti: %', coalesce(v_viewer_writes, '(yok)');
  end if;
end $verify$;
