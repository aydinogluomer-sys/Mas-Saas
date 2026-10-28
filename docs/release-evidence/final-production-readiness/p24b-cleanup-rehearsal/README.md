# P24B temizlik provası — kanıt paketi

V6.1'in kanıtladığı **42/42** ayak izinin, gerçek veritabanına dokunulmadan uçtan uca prova
edilmesi. Gerçek `mas_radar_dev` üzerinde **hiçbir DELETE/UPDATE yapılmadı** — yalnız salt-okunur
preflight koştu.

```
REHEARSAL_DB:      mas_radar_p24b_final_drill   (gerçek DB'nin doğrulanmış dump'ından restore)
DELETE_COUNT:      42        ORPHAN_COUNT: 0        UNEXPECTED_DELTA: 0
NEGATIVE_CONTROLS: 12/12     OUTCOME: COMMITTED (yalnız provada)
P24B_CLEANUP_AUTHORIZED: NO
```

## Neden yeni bir script

`scripts/db/fixture-cleanup.ts` **OUTDATED** ve asla çalıştırılmamalı: hâlâ `users=4`,
`payment_instances=3` bekliyor, `settings` ve `approvals`'ı hiç bilmiyor. Ölçülen ayak izi
**42 satır / 6 tablo**.

Yerine: `scripts/db/p24b-fixture-cleanup.ts`. Legacy sayıların tek satırı taşınmadı.

## Kapsamın tek kaynağı

Kapsam elle ikinci kez yazılmadı. `02-row-evidence-manifest.json`'dan okunur ve SHA256'sı
script'te pinlidir (`d60de97b…`). Manifest değişirse script **durur**.

Silme yolunda `like '%p24b%'` **yok**, timestamp aralığı **yok**, sezgisel eşleşme **yok** —
yalnız exact primary identity.

## Üç kilit

| mod | ne gerekir |
|---|---|
| **preflight** (varsayılan) | hiçbir şey — okur, kapıları ölçer, mutasyon yapmaz |
| **`--rehearsal`** | hedef adının harcanabilir olması; ayrı kod yolu |
| **`--execute-p24b-cleanup-42`** | bayrak **+** `MAS_ALLOW_P24B_CLEANUP=42-confirmed` **+** `MAS_P24B_BACKUP_RECEIPT` **+** hedefin ölçülen adının `mas_radar_dev` olması |

Üçünden biri eksikse transaction açılmadan `exit 9`.

## Kapılar (hepsi commit'ten önce)

manifest SHA · UNRESOLVED=0 · tablo dağılımı · DB kimliği (URL **ve** sunucudan ölçülen) ·
ledger 0087/87 · FK sözleşmesi `pg_catalog`'dan yeniden ölçülür · **42/42 satır önkoşulu +
parmak izi** · exact delete count · tablo deltaları · parasal deltalar · kalıntı/orphan ·
`atilla` korunur · hedef dışı parmak izi.

Yazma dondurma: `SHARE ROW EXCLUSIVE` (yazarlar bloke, okuyucular serbest), `lock_timeout=10s` —
kilit alınamazsa bekleme değil **rollback**.

## Prova sonucu

| kapı | sonuç |
|---|---|
| silme | `action_items 4 · approvals 4 · payment_instances 26 · payments 1 · users 6 · settings 1` = **42** |
| parasal delta | `payments −1.000` · `instances −26.000` · `checks/loans/cashflow 0` |
| orphan `payment_instances` | **0** |
| `atilla` korundu | **1** ✓ |
| `audit_logs` DELETE/UPDATE | **0** |
| ledger | **0087/87** |
| hedef dışı tablo değişimi | **0** ✓ |

## Snapshot stratejisi — A önerilir

| | A (kanonik refresh) | B (cerrahi UPDATE) |
|---|---|---|
| semantik değişim | 2 | 2 |
| teknik alan (`source_cutoff`) | 22 | 0 |
| audit olayı | **+1** `refresh_metric_snapshots` | **0** |
| `source_cutoff` anlamı | yeniden hesaplama anına güncellenir — **doğru** | `2026-08-27` kalır — bugün düzeltilen değer için **yanlış provenance** |
| ürün yolu | desteklenen API | ham UPDATE, yazma yolunu atlar |

İkisi de aynı iki düzeltmeyi üretir. B daha az alan değiştirir, ama iki satırın `source_cutoff`'u
değerin 2026-08-27'de hesaplandığını iddia etmeye devam eder — oysa bugün düzeltilmiştir. Bu
yanlış bir provenance iddiasıdır ve B hiçbir audit kaydı bırakmaz (ölçüldü: `audit_logs` +0).

A'nın 22 ek alan değişikliği hasar değil, **dürüst provenance**: o değerler de bugünkü veriden
yeniden türetildi, sadece aynı çıktı.

**`RECOMMENDED_SNAPSHOT_STRATEGY = A`**

## Negatif kontroller — 12/12

Kilitler (yalnız bayrak / yalnız env / makbuz yok), kimlik (rehearsal→gerçek, execute→disposable),
veri (41 satır, bozuk parmak izi, kurcalanmış manifest), ve **ikinci koşu**.

> İkinci koşu `PRECONDITION_NOT_SATISFIED` ile **exit 2** verir. Sessiz idempotent "0 satır,
> başarılı" kabul edilmedi: bu, tamamlanmış bir temizlikle hiç çalışmamış bir temizliği —
> ve yanlış veritabanını hedefleyen bir koşuyu — birbirinden ayırt edilemez kılardı.

## Off-device yedek — BLOCKED

Makinede yalnız `C:` var (`DriveType=3`), çıkarılabilir veya ağ sürücüsü **yok**;
`MAS_OFFDEVICE_BACKUP_DIR` yapılandırılmamış. Aynı diskteki bir klasörü "off-device" saymadım.

Alınan yedek **on-device**: `sha256` `22d8f5d9…`, 1.413.949 bayt, 1387 TOC girdisi,
`pg_restore --list` PASS, restore smoke PASS. Bu prova için yeterli, **gerçek temizlik için
değil**.

## Dosyalar

`00-cleanup-contract` · `01-manifest-sha` · `02-preconditions` · `03-fk-contract` ·
`04-before-fingerprint` · `05-delete-result` · `06-metric-snapshot-before` ·
`07-metric-snapshot-after` · `08-after-fingerprint` · `09-negative-controls` ·
`10-rehearsal-receipt`

`06`, temizlik öncesi 24 snapshot satırının değerlerini ve hash'lerini kalıcı olarak saklar —
hangi strateji seçilirse seçilsin eski değerler kaybolmaz.
