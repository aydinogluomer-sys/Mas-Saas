-- 0108 — Faz 57 (SA-4): background_jobs ayrı `result jsonb` kolonu, geriye dönük `payload.result`
-- taşıması (backfill) ve zarf değişmezlik bekçisi (`enforce_background_jobs_immutable_envelope`).
--
-- Gerekçe (docs/risk-register.md satır 61 & docs/database-schema.md satır 2126-2128):
--   1. İş sonucu (`result`) işin giriş zarfı (`payload`) ile aynı kolon içinde tutulduğunda,
--      `completeJob` çalışırken `payload` güncellenmek zorunda kalıyor ve zarf kolonunu kilitlemek
--      imkânsızlaşıyordu. `result jsonb` ayrı kolona ayrıldı.
--   2. Mevcut satırlarda `payload->'result'` altında saklanmış sonuçlar tetikleyici kurulmadan ÖNCE
--      `result` kolonuna taşınır ve `payload` içinden `'result'` anahtarı temizlenir.
--   3. `enforce_background_jobs_immutable_envelope()` tetikleyicisi (çağıranın kendi katmanında /
--      invoker olarak çalışır) `UPDATE` sırasında `id`, `job_type`, `created_by`, `payload`,
--      `dedupe_key` ve `created_at` alanlarının değiştirilmesini `ERRCODE = '23514'` ile reddeder.
--   4. `background_job_queue_health` (0081) ve `integration_health` (0086) görünümleri `SELECT *`
--      kullanmadığından kolon eklemesi mevcut `WITH (security_invoker = true)` ve `REVOKE`
--      kalkanlarını (0098) bozmaz; aşağıdaki doğrulama bloğu bunu teyit eder.
--
-- Kurallar:
--   * Üst-seviye işlem komutu ve eşzamanlı indeks kullanılmaz (scripts/db/migration-lib.ts).

-- ── 1) Ayrı `result` kolonu ───────────────────────────────────────────────────────────────────
alter table public.background_jobs
  add column if not exists result jsonb;

-- ── 2) Geriye dönük taşıma (tetikleyiciden ÖNCE ve idempotent) ────────────────────────────────
drop trigger if exists enforce_background_jobs_immutable_envelope on public.background_jobs;

update public.background_jobs
   set result = payload -> 'result',
       payload = payload - 'result'
 where result is null
   and jsonb_typeof(payload) = 'object'
   and payload ? 'result';

-- ── 3) Zarf değişmezlik bekçisi (invoker, ERRCODE 23514) ──────────────────────────────────────
create or replace function public.enforce_background_jobs_immutable_envelope()
returns trigger
language plpgsql
as $$
begin
  if new.id is distinct from old.id
     or new.job_type is distinct from old.job_type
     or new.created_by is distinct from old.created_by
     or new.payload is distinct from old.payload
     or new.dedupe_key is distinct from old.dedupe_key
     or new.created_at is distinct from old.created_at
  then
    raise exception 'background_jobs_envelope_immutable'
      using errcode = '23514';
  end if;

  return new;
end;
$$;

create trigger enforce_background_jobs_immutable_envelope
  before update on public.background_jobs
  for each row
  execute function public.enforce_background_jobs_immutable_envelope();

-- ── 4) Kendi kendini doğrulama ────────────────────────────────────────────────────────────────
do $verify$
declare
  v_has_result_col boolean;
  v_leftover_payload_results bigint;
  v_trigger_secdef boolean;
  v_health_invoker boolean;
begin
  select exists (
    select 1
      from information_schema.columns
     where table_schema = 'public'
       and table_name = 'background_jobs'
       and column_name = 'result'
       and data_type = 'jsonb'
  ) into v_has_result_col;

  if not v_has_result_col then
    raise exception '0108: public.background_jobs.result (jsonb) kolonu bulunamadı';
  end if;

  select count(*)
    into v_leftover_payload_results
    from public.background_jobs
   where result is null
     and jsonb_typeof(payload) = 'object'
     and payload ? 'result';

  if v_leftover_payload_results <> 0 then
    raise exception '0108: taşınmamış payload.result satırı kaldı (%)', v_leftover_payload_results;
  end if;

  select p.prosecdef
    into v_trigger_secdef
    from pg_trigger t
    join pg_proc p on p.oid = t.tgfoid
   where t.tgrelid = 'public.background_jobs'::regclass
     and not t.tgisinternal
     and t.tgname = 'enforce_background_jobs_immutable_envelope';

  if v_trigger_secdef is distinct from false then
    raise exception '0108: enforce_background_jobs_immutable_envelope beklenen invoker durumunda değil (prosecdef=%)',
      v_trigger_secdef;
  end if;

  select coalesce('security_invoker=true' = any(c.reloptions), false)
    into v_health_invoker
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relname = 'background_job_queue_health'
     and c.relkind = 'v';

  if v_health_invoker is distinct from true then
    raise exception '0108: background_job_queue_health security_invoker=true kalkanı eksik';
  end if;
end $verify$;
