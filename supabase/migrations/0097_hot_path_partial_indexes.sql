-- Faz 9 (Performans ve Bellek Optimizasyonu) — sıcak okuma yolları için kısmi ve bileşik indeksler.
--
-- Salt indeks eklemesi: hiçbir tablo kolonu, kısıt, görünüm, fonksiyon, tetikleyici, GRANT ya da
-- RLS politikası değiştirilmez; hiçbir finansal rakam veya satır görünürlüğü etkilenmez.
-- Koşucu (scripts/db/migrate.ts) her dosyayı kendi transaction bloğunda çalıştırdığı için
-- CREATE INDEX CONCURRENTLY kasıtlı olarak KULLANILMAZ (validateFileSet kuralı).

-- 1) Oturum doğrulama sıcak yolu (src/lib/auth.ts — her kimlikli istekte çalışır):
--    where s.token_hash = $1 and s.revoked_at is null and s.expires_at > now()
--    İptal edilmiş geçmiş oturumları dışarıda tutar; INCLUDE kolonları sayesinde tablo yığınına
--    dokunmadan Index Only Scan yapılmasına olanak tanır.
create index if not exists idx_sessions_active_token_hash
  on public.sessions (token_hash)
  include (user_id, id, expires_at, last_seen_at, created_at)
  where revoked_at is null;

-- 2) Açık ödeme örnekleri sıcak yolu (overview-snapshot.ts ve radar/queries.ts):
--    where status in ('unpaid', 'partial', 'planned', 'late')
--    order by due_date, amount desc nulls last
create index if not exists idx_payment_instances_open_due_date
  on public.payment_instances (due_date, amount desc nulls last)
  include (id, status, currency)
  where status in ('unpaid', 'partial', 'planned', 'late');

-- 3) Açık faturalar sıcak yolu (invoice_open_items ve yön/vade sorguları):
--    where status in ('open', 'partial') ve direction / due_date sıralaması.
create index if not exists idx_invoices_open_direction_due_date
  on public.invoices (direction, due_date)
  include (id, invoice_no, party_id, issue_date, currency, gross_amount, paid_amount, status)
  where status in ('open', 'partial');

-- 4) Banka eşleşmemiş kuyruk sıcak yolu (bank_unmatched_queue -> loadUnmatchedQueue):
--    where status in ('unmatched', 'suggested')
--    order by txn_date desc, abs(amount) desc, id desc limit 50 offset $2
--    0082 ölçümünde 60.000 satırda 650 ms süren kuyruk sıralamasını ön-sıralı indeks yürüyüşüne indirir.
create index if not exists idx_bank_transactions_queue_date
  on public.bank_transactions (txn_date desc, (abs(amount)) desc, id desc)
  where status in ('unmatched', 'suggested');

-- 5) Denetim kayıtları sunucu sayfalaması (/system/audit):
--    order by created_at desc, id desc limit 50 offset $2
--    0002 yalnız (entity_table, entity_id) indekslemişti; zaman sıralı sayfalama tam tablo taraması yapıyordu.
create index if not exists idx_audit_logs_created_id_desc
  on public.audit_logs (created_at desc, id desc);

-- 6) Aktif veri inceleme kuyruğu ve Ana Ekran veri kalitesi sayımı (overview-snapshot.ts + /data/reviews):
--    where status in ('open', 'rejected') üzerinde severity, created_at ve issue_type erişimi.
create index if not exists idx_mapping_reviews_active_sev_created
  on public.mapping_reviews (severity, created_at)
  include (status, issue_type)
  where status in ('open', 'rejected');

-- Kendi kendini doğrulama: altı indeksin tamamı public şemasında kayıtlı olmalı.
do $$
declare
  v_missing text[];
begin
  select array_agg(expected order by expected)
    into v_missing
    from unnest(array[
      'idx_sessions_active_token_hash',
      'idx_payment_instances_open_due_date',
      'idx_invoices_open_direction_due_date',
      'idx_bank_transactions_queue_date',
      'idx_audit_logs_created_id_desc',
      'idx_mapping_reviews_active_sev_created'
    ]) as expected
   where not exists (
     select 1
       from pg_indexes
      where schemaname = 'public'
        and indexname = expected
   );

  if v_missing is not null then
    raise exception '0097 indeks doğrulaması başarısız; eksik indeksler: %', array_to_string(v_missing, ', ');
  end if;
end $$;

