# PHASE 2 — Tier 1 para birimi kapanışı (2026-09-13)

Plan §2.1–2.2 · kaynak tarama: [`phase2-currency-scan.md`](phase2-currency-scan.md) (Tier 1 = 6 nokta).
Politika: TRY-only controlled use; `MULTI_CURRENCY_FINANCE_ANALYTICS = NOT_IMPLEMENTED` (kabul edilmiş borç);
TRY-dışı → inceleme, asla sessiz dönüşüm, asla TRY varsayımı.

## Kapanan altı nokta

| # | Yer | Düzeltme | Commit | Kanıt |
|---|---|---|---|---|
| 4 | `radar/rules.ts dayFlags` | `comparable = open.filter(currency='TRY')`; knownSum/large/critical yalnız TRY; `foreignCount` yeni alan; count/cluster para biriminden bağımsız | `5898947` | rules.test 29/29 |
| 5 | `dayFlagsFromAggregate` + `queries.ts` | SQL `flag_known_sum`/`flag_max_amount` `currency='TRY'` süzgeci, `flag_foreign_count`; `toRiskInput` tek dönüşüm | `5898947` | payment-day-flags-verify diferansiyeli güncel |
| 6 | `computeRisk` → `risk_level` (DB'ye yazılıyor) | TRY-dışı/`null` para birimi → gerekçe + seviye `unsupported_currency` (kritik>gecikme>**unsupported_currency**>orta>düşük); migration **0092** CHECK'e altıncı üye | `f4829a2` | rules.test 8 yeni vaka; 0092 fresh DB'de uygulandı (aşağıda) |
| 15 | `0078 anomaly_split_payments` | migration **0093**: sayım/toplam/en büyük ve HAVING yalnız `currency='TRY'`; `foreign_currency_count` | `6076b07` | fonksiyonel senaryo A/B (aşağıda) |
| 17 | `approvals/rules.ts` + `engine.ts` | `approval_rules.currency` SELECT edilir; `thresholdVerdict()`; para birimi eşleşmiyor/bilinmiyor → kural **TETİKLENİR** (fail-closed onay kapısı) | `6076b07` | approvals rules.test 25/25 |
| 60 | `0039 counterparty_exposure(_items)` | **0093**: items `currency` kolonu; tüm tutar toplamları yalnız TRY; limit karşılaştırması yalnız `credit_limit_currency='TRY'`; değilse `over_credit_limit`/`utilization` NULL + `credit_limit_comparable=false` | `6076b07` | fonksiyonel senaryo C (aşağıda) |

UI: `/finance/counterparties` "n kalem TRY-dışı — toplamda yok", "limit TRY değil — aşım hesaplanmadı",
kıyaslanamayan limit bandlamaya girmez; `/system/controls` bölünmüş ödemede "n TRY-dışı toplamda yok";
radar rozeti "TRY-dışı · eşik uygulanmadı".

## Migration doğrulaması — harcanabilir PostgreSQL 16.14 (Docker'sız)

Docker bozuk olduğu için (bkz. BLOCKER) **taşınabilir PostgreSQL 16.14** (EDB binaries, sha256
`98af1417…`) oturum scratchpad'inde `127.0.0.1:54329` üzerinde kuruldu. Gerçek DB'ye hiç bağlanılmadı.

| Yol | Veritabanı | Sonuç |
|---|---|---|
| Birleşik sıra: `local-bootstrap` → 0001–0091 (`pnpm db:migrate`, EMPTY flow) → 0092 → 0093 | `mas_radar_verify_fresh_v2` | **OK** — `counterparty_exposure_items` `c.currency`/`l.currency` kullanıyor (0090 var) |
| Yalnız release: `local-bootstrap` → 0001–0087 (psql, ON_ERROR_STOP) → 0092 → 0093 | `mas_radar_verify_fresh_release` | **OK** — `checks.currency` YOK, items view `'TRY'::text` (yapısal tek para birimi) |

`payment_instances_risk_level_check` = `('none','low','medium','high','critical','unsupported_currency')` doğrulandı.
`counterparty_exposure` kolon sırası korunmuş, iki yeni kolon sonda (`foreign_currency_count`, `credit_limit_comparable`);
`anomaly_split_payments` sonda `foreign_currency_count`.

## Fonksiyonel senaryolar (transaction içinde, ROLLBACK ile — DB temiz kaldı)

```text
A) TRY tedarikçi, aynı gün 2×60.000 TRY + 1×40.000 USD
   anomaly_split_payments → payment_count=2 total=120000 largest=60000 foreign_currency_count=1  ✓ (USD toplama girmedi, sayıldı)
B) USD tedarikçi, aynı gün 3×40.000 USD
   anomaly_split_payments → SATIR YOK  ✓ (eski view: 120.000 ≥ 100.000 TRY → SAHTE alarm üretirdi)
C) USD limitli tedarikçi (limit 100.000 USD), 150.000 TRY açık
   counterparty_exposure → total_exposure=150000 utilization=NULL over_credit_limit=NULL comparable=false  ✓
   (eski view: 150k > 100k → SAHTE "limit aşımı")
   TRY tedarikçi (limit 100.000 TRY) → utilization=1.2 over=true comparable=true  ✓ (gerçek aşım hâlâ görünür)
   USD tedarikçi → total=0 foreign_currency_count=3  ✓
0092) update … set risk_level='unsupported_currency' where currency='USD' → 4 satır kabul edildi ✓
```

## Gerçek veri ölçümü (plan §2.2 madde 1) — 5 Eylül yedeğinin restore edilmiş kopyası

`backups/daily-2026-09-05T00-00-26-552Z.dump` (sha256 `ff66a352…` makbuzla eşleşiyor) harcanabilir
cluster'a `mas_radar_restore_drill_20260913` olarak geri yüklendi (pg_restore 16.14, exit 0, 3,2 sn).
**25 currency kolonunun tamamında `<> 'TRY'` satır sayısı = 0** (payment_instances 0/502, payments 0/19,
cash_accounts 0/6, approvals 0/68, approval_rules 0/5, external_assumptions 0/6, treasury_policies 0/2,
diğer 18 tablo 0/0). Bugünkü toplamlar doğru; risk yalnız gelecek import'taydı ve o artık kodla kapalı.

## Uygulama sırası uyarısı

`0092` kod deploy'undan ÖNCE uygulanmalıdır: ilk TRY-dışı kalemde `refreshRiskFlags` aksi hâlde CHECK ihlali verir.
`0092`/`0093` numaraları 0088–0091 (import-v2 dalı) ardına; birleşmeden önce release dalında tek başına
`pnpm db:migrate` "sırada boşluk" der — bilinçli, birleşme sırasında ele alınacak (Phase 3 gate notu).

## Durum

Tier 1: **6/6 kapalı** (kod + migration + fresh-DB uygulaması + fonksiyonel senaryo).
Tier 2 (28 UI toplamı) ve Tier 3 (9 SQL view — #40 `liquidity_forecast_daily` en kritik) **AÇIK**;
`CROSS_CURRENCY_INVALID_SUMS = 0` kabulü için gerekli. Gerçek veride bugün TRY-dışı satır olmadığı için
bu iki tier'ın kapanması cutover'ı bloke etmez ama plan §2.8 kabulünü tamamlamaz.
