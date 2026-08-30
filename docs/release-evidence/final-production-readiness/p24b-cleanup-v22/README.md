# P24B cleanup v2.2 — restore ve whole-state kapıları

Temel commit: `79fcb1ff739ce68bcdf2b997970a4413b50f8560`. Üç doğrulanmış takip kusuru kapatıldı.
Gerçek `mas_radar_dev` üzerinde bu turda **INSERT / UPDATE / DELETE / DDL / DROP yok**; tur başı
ve sonu parmak izi birebir aynı.

## F1 — restore smoke, doğrulanmamış yıkıcı hedef (P0)

v2.1'in binding üreteci `argv[3]`'ü **hiç kontrol etmeden** `dropdb --if-exists`'e veriyordu.
`mas_radar_dev` geçilseydi, gerçek veritabanı — **onun yedeğinin varlığını kanıtlamakla görevli
aracın içinden** — silinirdi.

Ayrıca ad bir `bash -c` **string'ine** giriyordu:

```
was:  ["exec","-i",C,"bash","-c", `cat > /tmp/${smokeDb}.dump`]
now:  ["cp", destPath, `${C}:/tmp/mas-p24b-smoke-<pid>-<ts>.dump`]
```

Yani yalnız yanlış-hedef riski değil, **kabuk enjeksiyonu** yüzeyiydi: `foo;drop database
mas_radar_dev` geçerli bir argv girdisidir.

Yeni kapı (`scripts/db/p24b-smoke-target.ts`), **ilk yıkıcı subprocess'ten önce**: ad verilmiş mi ·
`^[a-z][a-z0-9_]{0,62}$` (tırnak gerektiren hiçbir ad kabul edilmez) · `PROTECTED_DB_NAMES` ·
`mas_radar_dev` için ayrıca açık hard gate · `isDisposableDatabaseName` · kaynağın kendisi olamaz.
Container yolu artık DB adı taşımıyor ve `finally` içinde siliniyor.

> **Asıl iddia çıkış kodu değil.** Reddeden ama `dropdb`'yi çoktan çalıştırmış bir kapı işe
> yaramaz. `tests/p24b-restore-target.test.ts` (28 test) PATH'e sahte bir `docker` koyup
> **yıkıcı subprocess sayısının 0** olduğunu doğruluyor.

## F2 — whole-DB binding uygulanmıyordu

`preCleanupWholeDbFingerprint` yalnız bir artifact alanıydı; cleanup onu **hiç
karşılaştırmıyordu**. Üstelik fingerprint mantığı iki dosyada **ayrı** uygulanmıştı — iki
uygulama zamanla kayar ve karşılaştırma sessizce anlamsızlaşır.

Tek kanonik uygulama: `scripts/db/p24b-cleanup-fingerprint.ts`. Binding üreteci ve cleanup
**aynı** kodu kullanıyor.

Artık üç yerde zorunlu:

1. **restore smoke** — geri yüklenen kopyanın hem hedef hem tüm-DB parmak izi kaynakla eşleşmeli
2. **binding kontratı** — `targetFingerprintMatchesSource` ve `wholeDbFingerprintMatchesSource` true olmalı
3. **kilit altında** — `BACKUP_IS_STALE_FOR_WHOLE_DATABASE_STATE`

### Neden hedef eşitliği yetmez

Yalnız 42 satırı sabitleyen bir binding şunu söyler: *"sileceğim satırlar yedekten beri
değişmedi."* Bu göründüğünden zayıf bir sözdür. Başka bir tablo değiştiyse yedek artık
temizliğin değiştireceği durumun tam kurtarma kopyası **değildir** — kötü bir temizliği geri
almak için onu geri yüklemek, aradaki meşru işi de silerdi.

`04-wholedb-stale-control.json` bunu ölçüyor:

| adım | ölçülen |
|---|---|
| hedef parmak izi değişmedi | **true** ← yalnız hedefe bakan binding burada geçerdi |
| tüm-DB parmak izi değişti | **true** |
| cleanup | `exit 3`, `BACKUP_IS_STALE_FOR_WHOLE_DATABASE_STATE` |
| silinen satır | **0** |

## F3 — Pool performans gerilemesi

v2.1'in commit mesajı "Pool paralel / PoolClient sıralı" diyordu. Bu `loadDataQualityCenter` için
doğruydu, ama `collectMetricSnapshots`'ın **dış seviyesi koşulsuz sıralı** yapılmıştı — iddia
prose'daydı, testte değil.

Dış seviye artık deponun zaten sağladığı `gather()`'dan geçiyor (ikinci bir helper yazılmadı).

```
Pool       medyan 39.9 ms   (min 34.5 / max 180)
PoolClient medyan 87.4 ms   (min 76.8 / max 98)
hızlanma   2.19×            sonuçlar birebir aynı: true
```

> Sıralama kanıtı `tests/pg-concurrency.test.ts`'te ve **zamanlama eşiği kullanmıyor**: her sahte
> iş başlangıç/bitişini kaydediyor, örtüşme bu olaylardan türetiliyor. Yüklü bir makinede
> kırılgan olmazdı ve zaten eşzamanlılığı kanıtlamazdı. Benchmark yalnız farkın gerçek iş
> olduğunu gösteriyor; deterministik testin yerine geçmiyor.

## Prova

```
FRESH_REHEARSAL_DB   mas_radar_p24b_v22_drill
DELETE_COUNT         42        ORPHANS 0
RESTORE_SMOKE        hedef ✓ · tüm-DB ✓ · 42 satır · ledger 0087/87
SNAPSHOT             24 → 24 · semantik 2 · teknik-only 22
AUDIT                mevcut değişmedi · INSERT 2/2
PARA                 payments −1.000 · instances −26.000 · diğerleri 0
ATILLA               korundu        LEDGER 0087/87
HEDEF DIŞI           0
OUTCOME              COMMITTED
```

## Dosyalar

`00-followup-defects` · `01-restore-target-gate` · `02-canonical-fingerprint` ·
`03-binding-restore-smoke` · `04-wholedb-stale-control` · `05-snapshot-before-image` ·
`06-rehearsal-receipt` · `07-pool-performance`

## Durum

Prova makbuzu yine `_DRILL_FIXTURE` ile açıkça etiketli; hash'ler gerçek, yalnız `targetKind`
sentetik — bu makinede çıkarılabilir/ağ sürücüsü yok.

```
SOFTWARE_BLOCKERS_REMAINING = 0
OFF_DEVICE_BACKUP_REAL      = BLOCKED
P24B_CLEANUP_AUTHORIZED     = NO
```
