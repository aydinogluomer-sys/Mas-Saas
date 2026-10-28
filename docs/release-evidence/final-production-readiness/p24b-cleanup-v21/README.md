# P24B cleanup v2.1 — hardening

v2.0 (`29d56aa`) passed its own rehearsal and was still not safe to point at `mas_radar_dev`.
Three defects, all the same family: **a check that looks like a gate but does not bind to the
thing it claims to guarantee.**

Gerçek `mas_radar_dev` üzerinde bu turda **DELETE / UPDATE / INSERT / DDL yok**; tur başı ve sonu
parmak izi birebir aynı.

## Kapatılan üç açık

| # | v2.0 | v2.1 |
|---|---|---|
| **D1** backup binding | `existsSync(path)` — **boş bir dosya bu kapıyı geçerdi** | JSON parse → `offDeviceCleanupBlockers()` → hedef dosyanın **execution anında yeniden hash'lenmesi** → `destBytes` → `sourceSha256 == destSha256` → ayrıca **cleanup binding** |
| **D2** TOCTOU | önkoşullar, sayımlar, para ve parmak izi **`begin`/`lock`'tan ÖNCE** ölçülüyordu | `BEGIN` → `SET LOCAL lock_timeout` → `LOCK` (8 tablo) → **sonra** her ölçüm |
| **D3** türev düzeltme | `refreshMetricSnapshots` çağrısı **yoktu**; iki toplam yanlış kalıyordu | **aynı transaction içinde**, ürünün kendi kod yolundan; ayrıca audit INSERT kontratı |

Kanıt: `00-old-implementation-defects.json` (satır numaralarıyla).

## D1 — yedek artık gerçekten bağlanıyor

Kanonik doğrulayıcı yeniden yazılmadı, **kullanıldı**: `scripts/ops/backup-lib.ts` içindeki
`offDeviceCleanupBlockers` ve `sha256OfFile`. `LOCAL_STANDIN` ve `OPERATOR_ATTESTED` hedefler
reddedilir — ikincisi yalnız beyandır, fiziksel kanıt değil.

Makbuz bir dosya hakkında **iddiadır**; dosya iddiadan sonra taşınmış, kırpılmış veya
değiştirilmiş olabilir. Bu yüzden `destPath` çalıştırma anında yeniden hash'lenir.

**Cleanup binding** (`mas-p24b-cleanup-binding-v1`, `scripts/db/p24b-cleanup-binding.ts` ile
**makine tarafından** üretilir) eksik halkayı kurar: bir yedeği, 42 hedef satırın ve tüm
veritabanının **temizlik öncesi parmak izine** bağlar; restore smoke ile o yedeğin gerçekten geri
yüklenebildiğini ve 42 satırı taşıdığını kanıtlar.

Cleanup, `LOCK` altında bu parmak izini yeniden hesaplar. Yedek alındıktan sonra hedef satırlarda
**meşru** bir değişiklik olsa bile: `BACKUP_IS_STALE_FOR_CURRENT_STATE`.

## D2 — TOCTOU iddia değil, ölçüm

`03-toctou-control.json`, iki gerçek oturumla:

| durum | sonuç |
|---|---|
| A kilidi tutarken B `UPDATE` deniyor | **bloke**, `SQLSTATE 55P03` (lock_not_available) |
| kilit yokken aynı `UPDATE` | **geçiyor** |

İkinci satır olmadan ilki kanıt olmazdı — test başka bir sebeple bloke olmuş olabilirdi.
Araç gerçek DB'yi de reddediyor (yazma denediği için, `exit 9`).

## D3 — silme ve düzeltme tek transaction

`refreshMetricSnapshotsWithClient` eklendi (`src/lib/analytics/snapshots.ts`). Mevcut
`writeMetricSnapshots` davranışı **değişmedi**; kendi transaction'ını açan sürüm artık ortak
gövdeye delege ediyor.

Bu, `collectMetricSnapshots`'ın çağıranın **commit edilmemiş silmelerini okumasını** sağlar —
ayrı bir bağlantı eski satırları okuyup yanlış toplamları geri yazardı.

Beş loader (`loadDataQualityCenter`, `loadCashMonths`, `loadLoans`, `loadMaturityItems`,
`loadPartProfitability`, ve transitif `loadCapacityModels`) `Pool | PoolClient` kabul edecek
şekilde gevşetildi. Hiçbiri kendi bağlantısını açmıyor — ölçüldü.

> **Performans notu.** `loadDataQualityCenter` panonun arkasında 14 sorguyu paralel açıyor ve
> panonun 100 ms altı navigasyon bütçesi var. Bunu sıralıya çevirmek, temizliğin bedelini ürünün
> gecikmesiyle ödemek olurdu. `src/lib/pg-concurrency.ts` içindeki `gather()` bağlama göre seçer:
> `Pool`'da paralel, `PoolClient`'ta sıralı. `PoolClient` üzerinde paralel biçim zaten hiçbir şey
> kazandırmıyordu — pg onları sıralıyor, uyarı veriyor ve pg@9'da kaldırıyor.

## Audit kontratı

| | |
|---|---|
| mevcut audit satırları | `DELETE = 0`, `UPDATE = 0`, parmak izleri değişmedi (hash kümesi kontrolü) |
| beklenen INSERT | **tam 2** — `refresh_metric_snapshots` (ürün) + `p24b_fixture_cleanup` (bu onarım) |

Onarım olayı kanonik `audit()` API'siyle yazılıyor; yeni tablo icat edilmedi. İçeriği:
`P0-DRIFT-01`, manifest SHA, 42 satır, tablo dağılımı, 2 semantik düzeltme, yedek SHA.

## Prova sonucu

```
REHEARSAL_DB   mas_radar_p24b_v21_drill   (doğrulanmış dump'tan taze restore)
DELETE_COUNT   42        ORPHANS 0
SNAPSHOT       24 → 24 · semantik 2 (payment_status|unpaid, task_status|open) · teknik-only 22
AUDIT          734 → 736 · mevcut değişmedi · INSERT 2/2
PARA           payments −1.000 · instances −26.000 · checks/loans/cashflow 0
ATILLA         korundu (fingerprint aynı)      LEDGER 0087/87
HEDEF DIŞI     0
OUTCOME        COMMITTED
```

## Negatif kontroller — 24/24

v2.0'ın 12 kontrolü, backup kapısı `existsSync()` olan bir script'e karşı **hepsi geçiyordu**.
Koruduğu kodu düşüremeyen bir kontrol paketi süstür. Yeni paket eksik olan kapılara saldırıyor:
makbuz **içeriği**, makbuz→dosya bağı, yedek→DB durumu bağı, ve düzeltme kontratı.

Her kontrol **iki** şey doğruluyor: koşu başarısız oldu **ve** veritabanı değişmedi. Reddeden ama
satırları silmiş bırakan bir kapı, kapı değildir.

`NC01–NC19` makbuz/binding (exit 9, bağlantı bile açılmadan) · `NC20–NC23` veri düzeyi
(exit 3, transaction içinde rollback) · `NC24` ikinci koşu.

> **NC24:** ikinci koşu `PRECONDITION_NOT_SATISFIED` ile **exit 3**. Sessiz idempotent
> "0 satır, başarılı" kabul edilmedi.

## Dosyalar

`00-old-implementation-defects` · `01-backup-validation` · `02-cleanup-binding` ·
`03-toctou-control` · `04-snapshot-before-image` · `05-rehearsal-receipt` · `06-negative-controls`

## Off-device yedek

Prova, `_DRILL_FIXTURE` alanıyla **açıkça etiketlenmiş** bir makbuz kullandı: `destSha256` ve
`destBytes` gerçekten ölçüldü ve execution-time yeniden doğrulaması gerçekten çalıştı; **yalnız
`targetKind` sentetiktir**, çünkü bu makinede çıkarılabilir/ağ sürücüsü yok. Gerçek off-device
makbuz gibi davranan sahte bir üretim makbuzu üretilmedi.

`P24B_CLEANUP_AUTHORIZED = NO`
