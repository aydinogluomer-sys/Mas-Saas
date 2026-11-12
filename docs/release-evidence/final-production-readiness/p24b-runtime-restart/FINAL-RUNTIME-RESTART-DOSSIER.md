# P24B — kontrollü gerçek runtime yeniden başlatma

**Sonuç: BLOKE. Gerçek runtime BAŞLATILMADI.**

Engel §5'te: off-device rollback yedeğinin bulunduğu USB birimi (`D:`) makineye bağlı değil.
§5 sözleşmesi net — *"Mismatch varsa: runtime başlatma."* — ve bu incelemenin baştan beri
uyguladığı fail-closed doktrini gereği **ölçülemeyen bir koşul geçiş değil, rettir**.

Gerçek `mas_radar_dev` üzerinde bu turda INSERT / UPDATE / DELETE / DDL **yok**.

## Engelin tam ölçümü

```
BEKLENEN  D:\MAS-Backups\p24b-final\mas_radar_dev-p24b-final-2026-08-31T10-01-14-531Z.dump
          sha256 fe63481887b7937df1def58475589dac844933ea32ca081dd3beba85bfaffe2a · 1.413.949 bayt
          USB_PHYSICAL_VOLUME · cleanupGrade=true
ÖLÇÜLEN   dosya YOK · D: birimi YOK · sistemde tek fiziksel disk: 0 (RAID, boot, system)
          2026-08-31'de ölçülen disk 1 ('Min Yi U YZWY_TECH', BusType USB) artık enumere edilmiyor
```

Bu bir sürücü harfi değişikliği değil. `Get-Disk` tek disk döndürüyor, `Get-Volume` tek harf
(`C:`) gösteriyor — cihaz fiziksel olarak çıkarılmış.

### Sınıflandırıcı doğru davrandı

```
TARGET_KIND          LOCAL_STANDIN
DRIVE_TYPE / DISK / BUS / IS_BOOT / IS_SYSTEM / STATUS   hepsi ÖLÇÜLEMEDİ
OFF_DEVICE_SATISFIED false        CLEANUP_GRADE false        PROBE_MUTATIONS 0
```

USB sertleştirmesi turunda yazılan kural burada tam olarak amaçlandığı gibi işledi:
*physical disk topology ölçülemezse cleanup-grade FALSE.* Reddedilen şey kod değil, cihazın yokluğu.

## Yedeğin içeriği kaybolmadı — ama bu yeterli değil

```
C: staging  C:\Users\Trade Bilisim\Mas Saas\backups\mas_radar_dev-p24b-final-2026-08-31T10-01-14-531Z.dump
            sha256 fe63481887b7937d… EŞLEŞTİ · 1.413.949 bayt EŞLEŞTİ
```

> İçerik sağlam olduğu için bunu "yeterli" saymıyorum. `C:`, kaynak veritabanının da üzerinde
> durduğu disk 0'dır (RAID, boot, system). Aynı fiziksel diskteki kopya rollback yedeği sayılmaz:
> diski kaybeden olay veritabanını ve kopyayı aynı anda götürür. Projenin kendi sınıflandırıcısı
> bunu zaten `LOCAL_STANDIN` diye işaretliyor. Yedek silinmedi, değiştirilmedi — sadece
> erişilemiyor.

## Engelden önce geçen kapılar (hepsi ölçüldü, hepsi PASS)

```
§1 REMOTE SHA        origin/release/production-readiness-hardening = c71366a…  EŞLEŞTİ
§2 CLEAN RC          C:\Users\Trade Bilisim\Mas-Saas-RC-c71366a
                     HEAD c71366a… · detached · git status BOŞ · tracked mod 0 · untracked app code 0
§3 ENVIRONMENT       DATABASE_URL → postgres://…@127.0.0.1:5432/mas_radar_dev
                     klon değil · production değil · localhost/konteyner sözleşmesi beklenen
                     .env.local gitignored (.gitignore:34) · tracked .env* mutasyonu YOK
                     RC git status env kopyasından SONRA da BOŞ · secret değeri basılmadı
§4 INSTALL/BUILD     pnpm install --frozen-lockfile exit 0
                     typecheck PASS · lint PASS · vitest 66 dosya / 1428 test PASS · build PASS
§6 PRE-START DB      ledger 0087/87 · 86 base tablo · P24B kalıntı 0/42
                     action_items 6 · approvals 68 · payment_instances 485
                     payments 19 · users 13 · settings 7
                     task_status.open 4 · payment_status.unpaid 13.595.000 TRY
                     audit_logs 736 · atilla 1 (md5 3dfbb36eecd822aad1aefbf34a736b21)
                     WHOLE_DB_FP a8f90e3476ba6bc918564a4aeb631ccfa93ba7ba4e9f9ab22c3403d5d8821b51
                     TARGET_FP   5e84634660528f2076f7bbef2a7e7e8f05047c13353679c53f0097798e37882d
§8 DELTA WATCH       86 tablonun tamamı için parmak izi anlık görüntüsü alındı
§9 QUIESCENCE        3000/3001/3110/3210/3310 dinleyici YOK
                     mas_radar_dev'e bağlı tek istemci: ölçümün kendi psql'i
                     prepare-runtime / bot / worker / scheduler YOK · UNEXPECTED_WRITERS 0
```

Yani engel dışında **her şey hazır**. USB takıldığı an bu tur baştan koşturulabilir.

## Gerçek DB bu tur boyunca yazılmadı — motorun kendi sayacıyla

Kendi ölçümüme güvenmek yerine PostgreSQL'in kendi sayacına baktım:

```
pg_stat_database · mas_radar_dev · stats_reset = never
pencere: 2026-08-31T09:58:30Z (konteyner açılışı) → şimdi
tup_inserted 2 · tup_updated 24 · tup_deleted 42
```

Bu üç sayı P24B cleanup makbuzuyla **birebir** örtüşüyor: 42 satır silindi, 24 metrik
snapshot güncellendi, 2 audit satırı eklendi. Üç günlük pencerede başka DML yok. Bu turda
koşan typecheck / lint / vitest / next build sonrasında sayaçlar **değişmedi** ve tüm-DB
parmak izi `a8f90e34…` aynı kaldı — derleme veritabanına dokunmadı.

## Test sayısı farkı — varsayılmadı, ölçüldü

Cleanup sonrası inceleme 69 dosya / 1438 test demişti; RC 66 / 1428 veriyor. Tracked test
dosyaları **54 = 54, birebir aynı**. Fark, ana worktree'deki commit edilmemiş kullanıcı
çalışmasıdır: `src/middleware.test.ts`, `src/lib/telegram/assistant.test.ts`,
`src/app/api/telegram/assistant/route.test.ts`. RC pinlenmiş kod için sonuç eksiksiz.

## Bu turda yapılmayanlar

```
gerçek runtime başlatma     HAYIR  (§5 FAIL)
yedeği silme/değiştirme     HAYIR
gerçek DB'ye yazma          HAYIR  (INSERT/UPDATE/DELETE/DDL = 0)
yeni cleanup                HAYIR
manuel SQL düzeltme         HAYIR
P1 audit yaması             HAYIR  (§21 gereği bilinçli olarak açık bırakıldı)
görsel baseline güncelleme  HAYIR  (§22)
ana worktree'ye müdahale    HAYIR  (19 kirli girdi aynen duruyor)
```

## Üretilmeyen kanıt dosyaları

`03-startup-log-sanitized.txt`, `04-post-prepare-runtime-delta.json`, `05-whole-db-delta.json`,
`06-health-and-core-smoke.json`, `07-rbac-smoke.json`, `08-post-start-p24b-check.json`,
`09-final-runtime-state.json` **üretilmedi** — hepsi runtime'ın açılmış olmasını gerektiriyor.
Boş ya da tahmini sürümlerini yazmak kanıt zincirini kirletirdi.

## Dosyalar

`00-clean-rc.json` · `01-pre-start-source.json` · `02-expected-writer-contract.json` ·
`03-BLOCKED-offdevice-backup-gate.json` · `_pre-start-table-fingerprints.json`

## Çözüm

USB SSD'yi geri takın, `D:` göründüğünü doğrulayın, aynı promptu tekrar çalıştırın.

```
RUNTIME_CODE_SHA        c71366a775be079e61d9f842a8659cbc2caa9499
REAL_RUNTIME_RESTARTED  NO
REAL_DB_WRITES          0
BLOCKER                 OFF_DEVICE_ROLLBACK_BACKUP_UNAVAILABLE (D: bağlı değil)
```
