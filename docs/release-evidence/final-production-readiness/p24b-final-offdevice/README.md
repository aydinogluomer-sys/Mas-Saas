# P24B — gerçek off-device yedek ve final preflight

Temel: `8fff3166369d48b0dbe6833fdcb58e2b72952c6f`. Gerçek `mas_radar_dev` üzerinde bu turda
**INSERT / UPDATE / DELETE / DDL / DROP yok** — tur başı ve tur sonu tüm-DB parmak izi aynı.

## Hedef gerçekten ayrı bir aygıt

USB classifier düzeltmesinden sonra bağlı harici SSD ölçülebilir hâle geldi:

```
D:\MAS-Backups   DriveType=3  disk=1  BusType=USB  IsBoot=false  IsSystem=false  Online
C:\  (kaynak)    DriveType=3  disk=0  BusType=RAID IsBoot=true   IsSystem=true
samePhysicalDisk=false → USB_PHYSICAL_VOLUME · CLEANUP_GRADE=true
```

Kopyalamadan önce, kopyalamadan sonra ve makbuz yazılırken üç kez ölçüldü; üçünde de aynı.

## Yedek

```
SOURCE  backups\mas_radar_dev-p24b-final-2026-08-31T10-01-14-531Z.dump
        sha256 fe63481887b7937df1def58475589dac844933ea32ca081dd3beba85bfaffe2a · 1.413.949 bayt
DEST    D:\MAS-Backups\p24b-final\…\(aynı ad)
        sha256 AYNI · bayt AYNI · pg_restore --list 1387 TOC girdisi
```

Hedefteki dosya **diskten yeniden okunarak** hash'lendi — hem Node hem PowerShell
`Get-FileHash` ile, iki bağımsız uygulama. `offDeviceCleanupBlockers(makbuz)` → `[]`.
Negatif kontrol: aynı makbuz `OPERATOR_ATTESTED` yapıldığında **reddediliyor**.

## Restore, D:'deki kopyadan

```
mas_radar_p24b_final_usb_restore   ledger 0087/87   base tables 86
hedef  42/42 · missing 0 · parmak izi kaynakla EŞLEŞTİ
TÜM-DB parmak izi kaynakla EŞLEŞTİ  (cb392821…)
```

C:'deki staging dump'tan değil, **USB'deki dosyadan** geri yüklendi. Eşitlik hem 42 hedef
satırda hem 86 tablonun tamamında kanıtlandı — yalnız hedefler eşleşseydi yedek sadık bir
kurtarma kopyası olmazdı.

## Kaynak durumu (salt okunur, motor zorlamalı)

```
DATABASE mas_radar_dev · transaction_read_only=on (sunucunun kendi cevabı)
LEDGER 0087/87 · BASE_TABLE_COUNT 86 · TARGET 42/42 missing 0
TARGET_FP    05e4677004f6e063390e65d203d3acdcd23eacbafd867d7a37ed69c07eaebc50
WHOLE_DB_FP  cb392821aedb1e38efea01da2645144add19086b4a5b87fb24758f74f34f3b29
action_items 10 · approvals 72 · payment_instances 511 · payments 20 · users 19 · settings 8
```

Docker/Postgres kapanıp yeniden açıldığı için eski parmak izine körü körüne güvenilmedi;
yeniden ölçüldü ve **birebir aynı** çıktı. Drift yok.

## Kapılar nasıl değerlendirildi

`--rehearsal` ve `preflight` farklı şeyler ölçer. Preflight modu bilinçli olarak dardır:
ledger ve hedef parmak izini kilit **dışında** okur ve makbuzunda bunu açıkça söyler
("yalnız bilgilendirmedir"). FK, parasal delta, ATILLA ve audit kapıları ise doğaları gereği
**silme sonrası** koşullardır — çalışmaları için silmenin olması gerekir.

Bu yüzden kapılar, **aynı D: yedeğinden** üretilmiş harcanabilir bir klon üzerinde tam yol
koşturularak değerlendirildi. Klonun hedef parmak izi gerçek veritabanınınkiyle aynı
(`05e4677…`), yani ölçülen durum birebir aynı durum.

```
mas_radar_p24b_final_gate_drill      COMMITTED
LOCK 86/86 SHARE ROW EXCLUSIVE · önkoşullar kilitten SONRA
DELETE 4+4+26+1+6+1 = 42 (hepsi beklenen sayıda)
PARA payments −1.000 · instances −26.000 · checks/loans/cashflow 0
ARTIK fixture_payment 0 · orphan_instances 0 · p24b_* 0 · atilla 1 (hash değişmedi)
AUDIT 734 → 736 · mevcut kayıtlar değişmedi · 2 ekleme
SNAPSHOT 24 satır · semantik 2 (payment_status|unpaid, task_status|open) · teknik 22
tableSetEqual true · ledgerPreCommit 0087/87 · illegalChanges []
```

> Sınırı abartmıyorum: bu bir **prova**dır. Gerçek `mas_radar_dev` üzerinde hiçbir kapı
> çalıştırılmadı, çünkü çalıştırmak silmek demekti.

## Gerçek veritabanı

```
tur başı == tur sonu : WHOLE_DB EQUAL · TARGET_FP EQUAL · LEDGER EQUAL · COUNTS EQUAL
INSERT 0 · UPDATE 0 · DELETE 0 · DDL 0 · DROP 0
Postgres container RUNNING · uygulama runtime STOPPED (3000/3110/3210 dinleyici yok)
prepare-runtime / bot / worker / migration ÇALIŞTIRILMADI · beklenmeyen yazıcı 0
```

## Dosyalar

`01-source-state-pre-backup.json` · `02-destination-pg-restore-list.txt` ·
`03-cleanup-binding.json` · `04-source-state-post-backup.json` ·
`05-gate-drill-binding.json` · `06-gate-drill-rehearsal-receipt.json` ·
`07-source-state-final.json`

Korunan artifact'lar: D:'deki yedek + makbuz, `mas_radar_p24b_final_usb_restore`,
`mas_radar_p24b_final_gate_drill`, `mas_radar_p24b_final_gate_restore`.

```
OFF_DEVICE_BACKUP_REAL  = YES
P24B_CLEANUP_AUTHORIZED = NO
```
