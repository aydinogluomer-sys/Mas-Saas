# P24B — gerçek cleanup, `mas_radar_dev`

Açık kullanıcı yetkisiyle, `83dc89a40b586710cb144fbb3d305b0d57ed8306` üzerinde çalıştırıldı.
**Sonuç: COMMITTED — 42/42 fixture satırı silindi.**

Yetkinin sınırı, P24B V6/V6.1 manifestinde kanıtlanmış tam 42 satırdı. Manuel SQL yazılmadı,
manifest dışı hiçbir id'ye dokunulmadı, `LIKE 'p24b%'` gibi hiçbir toplu tahmin kullanılmadı.
Tek yol kanonik `p24b-fixture-cleanup.ts --execute-p24b-cleanup-42` oldu; hiçbir guard
devre dışı bırakılmadı, hiçbir bypass yazılmadı.

## Execution öncesi kapılar

```
HEAD == ORIGIN_HEAD == 83dc89a…   ahead 0 / behind 0
cleanup'a katılan 9 tracked dosya : HEAD ile BİREBİR (drift yok)
kullanıcı/Telegram dirty dosyaları: dokunulmadı
```

D: yedeği execution anında **yeniden ölçüldü** — sınıf da dosya da:

```
USB_PHYSICAL_VOLUME · disk 1 · BusType USB · IsBoot false · IsSystem false · Online
samePhysicalDisk false (kaynak disk 0, RAID, boot+system)
sha256 fe63481887b7937d… · 1.413.949 bayt · makbuz ve binding ile birebir
```

Quiescence: Postgres RUNNING, uygulama runtime STOPPED (3000/3110/3210 dinleyici yok),
prepare-runtime / bot / worker / scheduler / migration yok, beklenmeyen yazıcı **0**.

## Kilit altında ölçülen önkoşullar

TOCTOU sırası korundu: `BEGIN` → `lock_timeout=10s` → **86 base table'ın tamamı**
`SHARE ROW EXCLUSIVE` → *sonra* bütün ölçümler.

```
BASE_TABLE_COUNT 86 · LOCKED 86 · UNLOCKED_FINGERPRINT_TABLES []
LOCKED_TARGET_FINGERPRINT   05e4677004f6e063…  == yetki değeri
LOCKED_WHOLE_DB_FINGERPRINT cb392821aedb1e38…  == yetki değeri
stateBinding: target PASS · wholeDb PASS      ledger 0087/87
FK kataloğu: 43 kısıt ölçüldü (payment_instances.payment_id → SET NULL)
```

## Silme

```
action_items       4    approvals   4    payment_instances  26
payments           1    users       6    settings            1     toplam 42
```

## Türev düzeltme — aynı transaction, aynı client

```
24 metrik yeniden hesaplandı · semantik 2 · teknik-only 22
task_status.open        8            → 4
payment_status.unpaid   13.621.000   → 13.595.000 TRY
```

Sebebi silip etkisini bırakmak, veritabanını "commit edilmiş ve yanlış" halde bırakırdı.

## Parasal etki

```
payments          541.000,00 → 540.000,00      −1.000
payment_instances 14.576.000,00 → 14.550.000,00 −26.000
checks · loans · cashflow                        0 / 0 / 0
```

## Postconditions

```
fixture_payment 0 · orphan_instances 0 · p24b_users/action_items/settings 0
ATILLA korundu — satır hash'i pre/post AYNI
AUDIT 734 → 736 · mevcut kayıtlarda UPDATE 0 / DELETE 0 · beklenen 2 INSERT
COMMIT öncesi: base table set BAŞLANGIÇLA AYNI · ledger 0087/87
illegalChanges [] → UNEXPECTED_DELTA = 0
```

Değişen tablolar yalnız şunlar: altı manifest tablosu + `metric_snapshots` (türev düzeltme)
+ `audit_logs` (2 ekleme). Başka hiçbir tablo kımıldamadı.

## COMMIT sonrası bağımsız okuma

Yeni, salt-okunur bir bağlantıyla (motor zorlamalı) yeniden ölçüldü:

```
TARGET 0/42 kaldı (missing 42)          LEDGER 0087/87      BASE_TABLE_COUNT 86
action_items 10→6 · approvals 72→68 · payment_instances 511→485
payments 20→19 · users 19→13 · settings 8→7                     (toplam −42)
fixture payment 7b300bfe-…  ABSENT      orphans 0              atilla PRESENT
task_status.open 4          payment_status.unpaid 13.595.000 TRY
TARGET_FP   5e84634660528f20…   (silme sonrası — beklenen değişim)
WHOLE_DB_FP a8f90e3476ba6bc9…   (silme sonrası — beklenen değişim)
```

## Korunanlar

D:'deki yedek, makbuz ve binding **silinmedi**. `mas_radar_p24b_final_usb_restore`,
`mas_radar_p24b_final_gate_drill`, `mas_radar_p24b_final_gate_restore` duruyor.
Next.js runtime bu turda **açılmadı**.

## Dosyalar

`00-execution-environment` · `01-execution-preconditions` · `02-lock-and-binding` ·
`03-delete-result` · `04-snapshot-correction` · `05-postconditions` ·
`06-independent-post-read` · `07-no-unexpected-delta` · `08-full-execution-receipt`

```
P24B_REAL_CLEANUP = COMMITTED (42/42)
RUNTIME_RESTARTED = NO
```
