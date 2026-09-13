# PHASE 6 — Disposable Acceptance · PHASE 7.2 — Restore drill (2026-09-13)

Ortam: taşınabilir PostgreSQL 16.14 (Docker bozuk; bkz. BLOCKER), `127.0.0.1:54329`, oturum scratchpad'i.
Gerçek `mas_radar_dev`'e hiç bağlanılmadı; tüm hedef adları disposable işaret taşır.

## 6.1 Empty DB — PASS

`local-bootstrap.sql` → `pnpm db:migrate` (EMPTY flow) 0001–0091 → 0092 → 0093 → `seed.sql`.
Schema verify: `db:roles-rls:verify` 29/29 (mas_radar_app kimliğiyle), `db:security-matrix:verify` 17/17.
Canonical V2 fixture: `v2-import-e2e` 69/69, `v2-concurrency-proof` 18/18, `v2-currency-safety` 9/9, enum parity uyuşmazlık 0.

## 6.2 Real-data clone — PASS (7/7)

`backups/daily-2026-09-05T00-00-26-552Z.dump` (sha256 `ff66a352…` = makbuz) → `pg_restore` 16.14 exit 0 →
`mas_radar_restore_drill_20260913` (ledger 87/0087; users 13, payments 19, payment_instances 502, checks 7, loans 1,
loan_installments 48, cashflow_months 35, cashflow_lines 1968, audit_logs 814 — P24B ölçümleriyle birebir).

`scripts/release/real-clone-v2-rehearsal.ts` (V2 dalı, `aa61115`):

| Kontrol | Sonuç |
|---|---|
| 0088–0093 gerçek şema+veri üzerinde uygulandı (psql, ON_ERROR_STOP) | PASS |
| 6 legacy finansal tablo PRE kolonlarıyla birebir (hash + sayı) | PASS |
| Şema eklemeleri beyaz listede: `loans.currency`, `checks.currency` (+ yeni tablo/view'lar) | PASS |
| V2 fixture gerçek verinin YANINA tek transaction'da yazıldı (54 staged / 36 mapped / 3 inceleme / 12 red) | PASS |
| V2 import eski satırlara dokunmadı (kimlik-sabit hash, 6/6) | PASS |
| Sayılar yalnız eklendi: payments 19→22, checks 7→9, loans 1→2, installments 48→50, instances 502→502, months 35→35 | PASS |
| Yazılan her V2 kaydı kaynak satırına bağlı (orphan 0) | PASS |

Bu prova **iki gerçek hata** yakaladı ve ikisi de düzeltildi (`aa61115`): (1) `machine_assets.name` eşsiz — fixture'ın
"Awea" makinesi gerçek veride vardı, INSERT 23505 → yazıcı artık doğal anahtardan bulur; (2) `resolveCashflowMonth`'un
no-op `on conflict do update`'i var olan ayların `updated_at`'ini ilerletiyordu → SELECT-önce-INSERT. Bilinçli sapma:
migration'lar SQL olarak uygulandı, ledger 87'de kaldı; gerçek cutover `pnpm db:migrate` ile ledger'ı ilerletir.

## 6.3 Negative controls — PASS

| Kontrol | Kanıt |
|---|---|
| mid-transaction error → 0 partial writes | concurrency proof "kısmi güncelleme geri alındı", "yarım workbook yazılmadı"; service.test rollback sırası; canlı operator denemesi tam geri alındı |
| concurrent external_id → one entity | concurrency proof DOMAIN_ROWS=1 LEDGER_ROWS=1 ORPHAN=0 |
| duplicate check → review, no auto merge | phase5-verify (açık duplicate_check inceleme → hariç; resolved → dahil); V2 `duplicate_check` needs_review |
| wrong migration DB → fail closed | `mas_radar_dev` adıyla `v2-import-e2e` ve `real-clone-v2-rehearsal` **bağlanmadan durdu** ("GÜVENLİK DURDURMASI") |
| unsupported currency → staged/review | currency-safety 9/9; parser `unsupported_currency_for_finance_aggregation` high → domain'e yazılmaz, kaynakta durur |
| rejected loan → child rows blocked | parser `blocked_by_parent` (2.4c, `9f1e96b`), önizleme == yazma |

## 6.4 Independent oracle — PASS

`FIXTURE_ORACLE` literal altın değerler (boş=null, 0=0, −45000 çıkış, vade 2026-07-31, anapara 1.500.000, taksit 71.744,12)
e2e'de owner SQL ile okunur; phase4 final kasa −3.064.607,57 literal; phase5 kredi toplamı = kaynak B10 exact.

## 6.5 Manual M1–M8 — KULLANICI

Kod/kanıt hazır; M1–M8 el ile kontrolü kullanıcıya kalır (aşağıdaki "Kullanıcıya kalanlar").

## 7.2 Restore drill — PASS (Docker'sız yol)

```text
off-device kopya   : YOK (D: takılı değil) — yerel yedekle yapıldı; off-device kopyadan tekrar Phase 8 öncesi ZORUNLU
restore disposable : pg_restore 16.14 → mas_radar_restore_drill_20260913, 3,2 sn, exit 0
data fingerprint   : ledger 87/0087; sayılar makbuz/P24B ölçümleriyle birebir (yukarıda)
app start          : V2 üretim derlemesi :3311, prepare-runtime (24 ay) → /health {"status":"ok","db":"up"}
health             : /login 200; korumalı sayfa 307 → /login (kimliksiz)
/version           : commit "unknown" — V2 dalı 7.4 düzeltmesini (release `15147e9`) taşımıyor; birleşme sonrası kapanır
```

## 7.1 / 7.3 — AÇIK (Docker)

Günlük yedek işi ve tazelik alarmı `docker exec mas-radar-pg pg_dump` üzerine kurulu; 6 Eylül'den beri başarısız
(BLOCKER). En son geçerli yedek 5 Eylül → **BACKUP STALE** (>36 saat). Docker onarılınca `pnpm ops:telemetry` ile kapanır.

## Gate'ler

- `DISPOSABLE_ACCEPTANCE`: 6.1–6.4 PASS; **6.5 kullanıcı** → gate kullanıcı onayıyla kapanır.
- `OPERATIONS_READY`: 7.2 PASS (yerel yedekle), 7.4 PASS (release), 7.5 PASS; **7.1/7.3 Docker'a bağlı** → AÇIK.
