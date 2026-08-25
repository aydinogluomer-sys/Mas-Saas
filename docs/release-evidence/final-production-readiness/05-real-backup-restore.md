# 05 — Gerçek kaynaktan yedek / geri yükleme + off-device + zamanlama (AŞAMA 07)

```text
WORKING COMMIT: 1623b3f (1623b3f3657631bcafc3e84c29aaf47c68c75d65)
TARGET DATABASE CLASS: REAL_READ_ONLY (kaynak) → DISPOSABLE_CLONE (iki restore hedefi)
TARGET DATABASE NAME: mas_radar_dev → mas_radar_stage07_restore + mas_radar_stage07_offdevice_restore
REAL DB WRITE USED: NO — kaynağa yalnız pg_dump ve SELECT uygulandı

ORIGINAL PLAN REFERENCE:
- section: Gap Closure Rehberi §12 (AŞAMA 07); orijinal plan §9 Faz 6
- lines: L1102-L1216 (rehber), L977-L1043 (orijinal)
- acceptance criterion: fresh real backup + receipt → ayrı hedefe restore → counts/aggregates/hashes/ACL/app start → off-device kopya → saklanan kopyadan restore → operasyonel zamanlama

CURRENT STATUS: PARTIAL — yalnız off-device FİZİKSEL hedef BLOCKED; diğer bütün kapılar VERIFIED PASS
RUN STARTED: 2026-08-25T15:04:37.431Z
RUN FINISHED: 2026-08-25T15:05:21.905Z
```

## §12 kabul bloğu

```text
BACKUP EXISTS = YES
BACKUP READABLE = YES
BACKUP RESTORABLE = YES
RESTORED DATA MATCHES = YES
APP CAN START ON RESTORE = YES
OFF_DEVICE COPY = TOOLING VERIFIED · PHYSICAL TARGET BLOCKED (bu makinede ayrı aygıt yok)
OPERATIONAL SCHEDULE = INSTALLABLE — NOT REGISTERED (operatör adımı)
```

## Çalışma ortamı — canlı örneğe dokunulmadı

```text
LIVE PRODUCTION INSTANCE: port 3000 — untouched
  kapı öncesi /health: 200 {"status":"ok","app":"up","db":"up","latencyMs":32,"time":"2026-08-25T15:04:37.611Z"}
  kapı sonrası /health: 200 {"status":"ok","app":"up","db":"up","latencyMs":32,"time":"2026-08-25T15:05:21.901Z"}
GATE SERVER PORT: 3270
GATE BUILD OUTPUT: .next-real-clone-gate (hazır derleme yeniden kullanıldı — canlı .next ezilmedi, yeni build koşulmadı)
APP ROLE PASSWORD RESET: NO — kimlik .env.local'den alındı, yalnız DB adı değiştirildi
DISPOSABLE DBs DROPPED: mas_radar_stage07_restore, mas_radar_stage07_offdevice_restore
```

## Bölüm A — gerçek kaynaktan yedek ve makbuz

```yaml
backup_receipt:
  timestamp: "2026-08-25T15:04:38.948Z"
  source_db: "mas_radar_dev"
  system_identifier: "7659286466006216743"
  git_sha: "5ea4945eb60f7597b6e64d68dc2a85f4f325c8eb"
  schema_ledger: "87/0087"
  file_size: 1393193
  sha256: "5df825a31b9d2837f3d063a963e51bdc07f7e673998a05f1abdd91d712fed137"
  pg_version: "PostgreSQL 16.14 (Debian 16.14-1.pgdg13+1) on x86_64-pc-linux-gnu, compiled by gcc (Debian 14.2.0-19) 14.2.0, 64-bit"
  pg_dump_version: "pg_dump (PostgreSQL) 16.14 (Debian 16.14-1.pgdg13+1)"
```

Makbuz dosyası: `backups\stage07_real-2026-08-25T13-47-36-546Z.dump.stage07.json`
Katı makbuz (git + cluster kimliği, temiz ağaç zorunlu): `backups\stage07_real-2026-08-25T13-47-36-546Z.dump.receipt.json`
Dump: `backups\stage07_real-2026-08-25T13-47-36-546Z.dump` — 1387 TOC girdisi

```text
git_sha (DUMP alındığında)  : 5ea4945eb60f7597b6e64d68dc2a85f4f325c8eb  · ağaç temiz: true
makbuzu yazan koşu (bu kapı): 1623b3f3657631bcafc3e84c29aaf47c68c75d65
```

İki SHA'nın farklı olması beklenen bir durumdur ve bilerek ayrı alanlarda durur: yedek
VERİYE aittir, koda değil. `git_sha` dump anını anlatır ve kaynağı katı makbuzdur (o CLI
temiz ağaç olmadan koşmaz); ikinci alan yalnız bu kanıt dosyasını kimin ürettiğini söyler.

| Kontrol | Beklenen | Gerçek | Sonuç |
|---|---|---|---|
| dump dosyası var ve boş değil | > 0 bayt | 1393193 bayt (1.3 MB) | PASS |
| sha256 diskten yeniden hesaplandı | 64 hex | 5df825a31b9d2837f3d063a9… | PASS |
| katı makbuz (git+cluster kimliği) dosyayla eşleşiyor | sha256 ve bayt aynı | eşleşti | PASS |
| katı makbuzun git provenance'ı okunabiliyor ve kayda geçti | 40 hex git HEAD | 5ea4945 (kapı koşusu: 1623b3f, farklı — nota bakın) | PASS |
| kaynak veritabanı beklenen | mas_radar_dev | mas_radar_dev | PASS |
| makbuzun dokuz zorunlu alanı dolu (§12 Bölüm A) | 9/9 | 9/9 | PASS |
| katı makbuz şeması pg_version + pg_dump_version taşıyor (DISPOSABLE_CLONE üzerinde uçtan uca) | her iki alan da makbuz dosyasında | pgVersion="PostgreSQL 16.14 (Debian 16.…" pgDumpVersion="pg_dump (PostgreSQL) 16.14 (Debian 16.14-1.pgdg13+1)" | PASS |

## Bölüm B — ayrı hedefe restore ve tam karşılaştırma

| Kontrol | Beklenen | Gerçek | Sonuç |
|---|---|---|---|
| app rolü parolası SIFIRLANMADI (mevcut runtime kimliği yeniden kullanıldı) | pnpm db:app-role:password çağrılmaz | 'mas_radar_app' kimliği .env.local'den, yalnız DB adı 'mas_radar_stage07_restore' ile değiştirildi | PASS |
| pg_restore --list arşivi ayrıştırabiliyor | > 0 TOC girdisi | 1387 TOC girdisi | PASS |
| arşiv boş bir veritabanına yüklendi | > 0 tablo | 85 tablo | PASS |
| satır sayıları eşleşiyor (oynak tablolar hariç, farkları ölçülerek) | 85 tablodan 84 tanesi birebir | açıklanmamış fark yok · sessions: 26 → 25 (oynak tablo) | PASS |
| parasal toplamlar eşleşiyor | 6 toplam aynı | tümü aynı | PASS |
| satır hash'leri eşleşiyor (her fark açıklandı) | 85 tablo | 83 tablo birebir aynı · açıklanan drift → sessions: oynak tablo (canlı oturum deposu): kaynak 26 satır, arşiv 25 satır | users: yalnız oynak kolonlar farklı (updated_at); kalan 9 kolonun hash'i AYNI | PASS |
| finansal tablolar BİREBİR aynı (sayı + hash, istisnasız) | 11 tablo: payments=20 payment_instances=488 checks=7 loans=1 loan_installments=48 cashflow_months=35 invoices=0 bank_transactions=0 audit_logs=289 parties=16 cash_accounts=6 | tümü birebir | PASS |
| schema ledger eşleşiyor | 87/0087 | 87/0087 | PASS |
| kullanıcı rol dağılımı eşleşiyor | admin=11 finance_approver=1 finance_manager=2 finance_operator=1 viewer=2 | aynı | PASS |
| ACL pozitif kontrolü — kaynakta app rolünün etkin yetkisi VAR | > 0 tablo | DELETE=80 INSERT=84 SELECT=84 UPDATE=80 | PASS |
| ACL geri geldi — 'mas_radar_app' etkin tablo yetkileri kaynakla aynı | DELETE=80 INSERT=84 SELECT=84 UPDATE=80 | DELETE=80 INSERT=84 SELECT=84 UPDATE=80 | PASS |
| RLS politikaları geri geldi | 318 politika | 318 politika | PASS |
| satır güvenliği açık tablolar geri geldi | 85 tablo | 85 tablo | PASS |
| şema USAGE yetkisi geri geldi | kaynak true / restore true | true / true | PASS |
| owner ile login gerekmeyen okuma | 20 | 20 | PASS |
| uygulama restore edilen 'mas_radar_stage07_restore' ile ayağa kalktı (düşük yetkili 'mas_radar_app' rolüyle) | /ready = 200 | 200 | PASS |
| uygulama restore edilen veritabanına GERÇEKTEN bağlanabiliyor (/health db=up) | "db":"up" | 200 {"status":"ok","app":"up","db":"up","latencyMs":2026,"time":"2026-08-25T15:05:20.393Z"} | PASS |

```text
kaynak tablo sayısı        : 85
karşılaştırılan hash sayısı: 85
parasal toplam sayısı      : 6
ledger                     : 87/0087 → 87/0087
mas_radar_app GRANT (kaynak)   : DELETE=80 INSERT=84 SELECT=84 UPDATE=80
mas_radar_app GRANT (restore)  : DELETE=80 INSERT=84 SELECT=84 UPDATE=80
uygulama başlangıcı        : http://127.0.0.1:3270/ready = 200 · /health = 200 {"status":"ok","app":"up","db":"up","latencyMs":2026,"time":"2026-08-25T15:05:20.393Z"} · derleme .next-real-clone-gate (BUILD_ID xxPn1aro_sKp5F-lYy9aB)
```

## Bölüm C — off-device kopya

```text
TARGET DIR   : C:\Users\TRADEB~1\AppData\Local\Temp\claude\C--Users-Trade-Bilisim-Mas-Saas\67bed50a-7000-46d1-9a2a-ca3a3f57fde6\scratchpad\offdevice-standin
TARGET KIND  : LOCAL_STANDIN
EVIDENCE     : Hedef bu makinenin yerel sabit diskinde (DriveType=3, kök c:\). Aynı makinedeki ikinci klasör off-device kopya SAYILMAZ (rehber §30.5).
COPY         : C:\Users\TRADEB~1\AppData\Local\Temp\claude\C--Users-Trade-Bilisim-Mas-Saas\67bed50a-7000-46d1-9a2a-ca3a3f57fde6\scratchpad\offdevice-standin\stage07_real-2026-08-25T13-47-36-546Z.dump

OFF_DEVICE TOOLING         = VERIFIED
OFF_DEVICE PHYSICAL TARGET = BLOCKED — bu makinede ayrı bir aygıt yok (yalnız C:, DriveType 3)
```

| Kontrol | Beklenen | Gerçek | Sonuç |
|---|---|---|---|
| kopya hedefte oluştu | dosya var | stage07_real-2026-08-25T13-47-36-546Z.dump | PASS |
| HEDEFTEKİ dosyanın sha256'sı kaynakla aynı | 5df825a31b9d2837… | 5df825a31b9d2837… | PASS |
| hedefteki boyut kaynakla aynı | 1393193 | 1393193 | PASS |
| hedefteki kopya hâlâ geçerli bir arşiv (pg_restore --list) | > 0 TOC girdisi | 1387 TOC girdisi | PASS |
| makbuz yan dosyaları da kopyalandı | en az 1 yan dosya | stage07_real-2026-08-25T13-47-36-546Z.dump.receipt.json, stage07_real-2026-08-25T13-47-36-546Z.dump.stage07.json | PASS |
| hedef fiziksel olarak ayrı bir aygıt | REMOVABLE / NETWORK / UNC | LOCAL_STANDIN — Hedef bu makinenin yerel sabit diskinde (DriveType=3, kök c:\). Aynı makinedeki ikinci klasör off-device kopya SAYILMAZ (rehber §30.5). | **FAIL** |

## Bölüm E — saklanan kopyanın KENDİSİNDEN restore

| Kontrol | Beklenen | Gerçek | Sonuç |
|---|---|---|---|
| saklanan kopya okunabiliyor | > 0 TOC girdisi | 1387 TOC girdisi | PASS |
| satır sayıları eşleşiyor (oynak tablolar hariç, farkları ölçülerek) | 85 tablodan 84 tanesi birebir | açıklanmamış fark yok · sessions: 26 → 25 (oynak tablo) | PASS |
| parasal toplamlar eşleşiyor | 6 toplam aynı | tümü aynı | PASS |
| satır hash'leri eşleşiyor (her fark açıklandı) | 85 tablo | 83 tablo birebir aynı · açıklanan drift → sessions: oynak tablo (canlı oturum deposu): kaynak 26 satır, arşiv 25 satır | users: yalnız oynak kolonlar farklı (updated_at); kalan 9 kolonun hash'i AYNI | PASS |
| finansal tablolar BİREBİR aynı (sayı + hash, istisnasız) | 11 tablo: payments=20 payment_instances=488 checks=7 loans=1 loan_installments=48 cashflow_months=35 invoices=0 bank_transactions=0 audit_logs=289 parties=16 cash_accounts=6 | tümü birebir | PASS |
| schema ledger eşleşiyor | 87/0087 | 87/0087 | PASS |
| kullanıcı rol dağılımı eşleşiyor | admin=11 finance_approver=1 finance_manager=2 finance_operator=1 viewer=2 | aynı | PASS |
| saklanan kopyadan restore, yerel arşivden restore ile BİREBİR aynı (gürültüsüz kanıt) | 85 tablo, 6 toplam birebir | birebir aynı | PASS |

## Bölüm D — operasyonel zamanlama ve retention

```text
SCHEDULE : NOT REGISTERED · what-if üretildi
RETENTION: 865 dump (668.5 MB) · 8 IMMUTABLE korunuyor · 832 budanabilir (641.7 MB) · uygulanmadı (kuru koşu)
DAILY JOB: 1 koşu · son: 2026-08-25T14:19:08.933Z · dump 1a67e9913d1be565… · ledger 87/0087 · off-device NO
```

| Kontrol | Beklenen | Gerçek | Sonuç |
|---|---|---|---|
| zamanlama durumu sorgulanabiliyor (schtasks) | exit 0 | exit 0 | PASS |
| kurulum what-if modunda komutu üretiyor ve KAYIT YAPMIYOR | what-if çıktısı, kayıt yok | kayıt yapılmadı | PASS |
| what-if sonrası görev hâlâ KAYITLI DEĞİL (kullanıcı makinesine kalıcı değişiklik yok) | NOT REGISTERED | NOT REGISTERED | PASS |
| retention budaması uygulanabilir durumda (kuru koşu) | exit 0 | exit 0 | PASS |
| kuru koşu hiçbir dosya silmedi | KURU KOŞU satırı | var | PASS |
| IMMUTABLE dump'lar budama planında ASLA yok | 0 immutable budanıyor | 0 immutable budanıyor | PASS |
| bu koşunun gerçek yedeği IMMUTABLE sınıfında | immutable | immutable (IMMUTABLE — ad kalıbı /^stage\d+_real/i) | PASS |
| budama SENTETİK fixture üzerinde gerçekten siliyor, IMMUTABLE'a dokunmuyor | immutable 4/4 hayatta, yan dosya dump ile silinir, hata 0 | 364 dump → 348 silindi, 16 kaldı; IMMUTABLE 4/4 hayatta; yan dosya dump ile birlikte silindi; hata 0 | PASS |
| günlük yedek işi (zamanlanmış görevin çalıştıracağı script) gerçekten koştu | backups/daily-runs.jsonl içinde en az bir koşu | 1 koşu · son: 2026-08-25T14:19:08.933Z · dump 1a67e9913d1be565… · ledger 87/0087 · off-device NO | PASS |

### Operatör adımları (bu kapının BİLEREK yapmadıkları)

Zamanlanmış görev **kaydedilmedi**: tekrarlayan bir görev kullanıcının makinesinde kalıcı,
dışa dönük bir değişikliktir ve kararı operatörün olmalıdır. Kapı yalnız kurulabilirliği
kanıtlar (ön koşullar + birebir komut + what-if).

```bash
# 1) off-device hedefi tanımla (harici disk taktıktan / NAS bağladıktan SONRA)
setx MAS_OFFDEVICE_BACKUP_DIR "E:\mas-yedek"        # veya \\nas\mas-yedek

# 2) günlük görevi kaydet
pnpm exec tsx scripts/ops/schedule-windows.ts install --apply
pnpm exec tsx scripts/ops/schedule-windows.ts status

# 3) retention'ı gerçekten uygula (önce kuru koşuyu okuyun)
pnpm exec tsx scripts/ops/backup-prune.ts --verbose
pnpm exec tsx scripts/ops/backup-prune.ts --apply

# geri alma
pnpm exec tsx scripts/ops/schedule-windows.ts uninstall --apply
```

## Komutlar (gerçekten koşanlar)

```text
docker cp backups\stage07_real-2026-08-25T13-47-36-546Z.dump mas-radar-pg:/tmp/mas-stage07-27412-1787670278956.dump
docker exec mas-radar-pg pg_restore --list /tmp/mas-stage07-27412-1787670278956.dump
docker cp backups\stage07_real-2026-08-25T13-47-36-546Z.dump mas-radar-pg:/tmp/mas-stage07-restore-27412-1787670281027.dump
docker exec mas-radar-pg dropdb -U postgres --force --if-exists mas_radar_stage07_restore
docker exec mas-radar-pg createdb -U postgres mas_radar_stage07_restore
docker exec mas-radar-pg pg_restore --no-owner -U postgres -d mas_radar_stage07_restore /tmp/mas-stage07-restore-27412-1787670281027.dump
MAS_OFFDEVICE_BACKUP_DIR=<hedef> pnpm exec tsx scripts/ops/offdevice-copy.ts --dump stage07_real-2026-08-25T13-47-36-546Z.dump
docker cp C:\Users\TRADEB~1\AppData\Local\Temp\claude\C--Users-Trade-Bilisim-Mas-Saas\67bed50a-7000-46d1-9a2a-ca3a3f57fde6\scratchpad\offdevice-standin\stage07_real-2026-08-25T13-47-36-546Z.dump mas-radar-pg:/tmp/mas-stage07-27412-1787670297899.dump
docker exec mas-radar-pg pg_restore --list /tmp/mas-stage07-27412-1787670297899.dump
docker cp C:\Users\TRADEB~1\AppData\Local\Temp\claude\C--Users-Trade-Bilisim-Mas-Saas\67bed50a-7000-46d1-9a2a-ca3a3f57fde6\scratchpad\offdevice-standin\stage07_real-2026-08-25T13-47-36-546Z.dump mas-radar-pg:/tmp/mas-stage07-restore-27412-1787670298982.dump
docker exec mas-radar-pg dropdb -U postgres --force --if-exists mas_radar_stage07_offdevice_restore
docker exec mas-radar-pg createdb -U postgres mas_radar_stage07_offdevice_restore
docker exec mas-radar-pg pg_restore --no-owner -U postgres -d mas_radar_stage07_offdevice_restore /tmp/mas-stage07-restore-27412-1787670298982.dump
node --import tsx scripts/ops/schedule-windows.ts status
node --import tsx scripts/ops/schedule-windows.ts install
node --import tsx scripts/ops/backup-prune.ts
pnpm start (PORT=3270, MAS_NEXT_DIST_DIR=.next-real-clone-gate, DATABASE_URL → mas_radar_stage07_restore)
docker exec mas-radar-pg dropdb -U postgres --force --if-exists mas_radar_stage07_restore
docker exec mas-radar-pg dropdb -U postgres --force --if-exists mas_radar_stage07_offdevice_restore
```

## Exit kodları

```text
schedule-windows.ts status = 0
schedule-windows.ts install (what-if) = 0
backup-prune.ts (kuru koşu) = 0
```

## Assertion sayıları

```text
Bölüm A: 7/7
Bölüm B: 17/17
Bölüm C: 5/6
Bölüm D: 9/9
Bölüm E: 8/8
TOPLAM  : 46/47
```

## Notlar

- Yedek commit 5ea4945'te TEMİZ bir ağaçla alındı; kapı 1623b3f'te koştu (bu iş paketinin dosyaları ağaçta duruyor). Katı makbuzun temiz-ağaç garantisi dump'a aittir ve hash ile bu koşuda yeniden doğrulandı; kapının kendi koşusu o garantiyi taşımaz ve taşıdığını iddia etmez.
- [B] canlı kaynak drift'i — sessions: oynak tablo (canlı oturum deposu): kaynak 26 satır, arşiv 25 satır
- [B] canlı kaynak drift'i — users: yalnız oynak kolonlar farklı (updated_at); kalan 9 kolonun hash'i AYNI
- [E] canlı kaynak drift'i — sessions: oynak tablo (canlı oturum deposu): kaynak 26 satır, arşiv 25 satır
- [E] canlı kaynak drift'i — users: yalnız oynak kolonlar farklı (updated_at); kalan 9 kolonun hash'i AYNI
- backup-prune.ts kuru koşusu 8 IMMUTABLE dosya saydı.
- Uygulama derlemesi YENİDEN ÜRETİLMEDİ: hazır '.next-real-clone-gate' (BUILD_ID xxPn1aro_sKp5F-lYy9aB) yeniden kullanıldı. Düz `pnpm build` canlı `.next`i ezer ve bu makinede port 3000'de bir production örneği çalışıyor. Kanıtlanan şey uygulamanın RESTORE EDİLEN VERİTABANIYLA açılabildiğidir; uygulama kodunun bu commit'te derlenebildiği ayrı bir kapının işidir.

## FAIL / NOT VERIFIED

- [C] hedef fiziksel olarak ayrı bir aygıt — beklenen `REMOVABLE / NETWORK / UNC`, gerçek `LOCAL_STANDIN — Hedef bu makinenin yerel sabit diskinde (DriveType=3, kök c:\). Aynı makinedeki ikinci klasör off-device kopya SAYILMAZ (rehber §30.5).`

## Severity (rehber §31)

```text
P0: OFF_DEVICE PHYSICAL TARGET — bu makinede fiziksel olarak ayrı hiçbir hedef yok (yalnız C:, DriveType 3; çıkarılabilir sürücü yok, bağlı ağ paylaşımı yok). Araç zinciri kurulu ve doğrulandı; eksik olan DONANIM/HEDEF. Diski, makineyi ya da şifreleyen bir yazılımı kaybeden senaryoda yedeğin tek kopyası da kaybedilir.
P1: OPERATIONAL SCHEDULE kurulabilir durumda ama KAYITLI DEĞİL — kayıt bilinçli olarak
    operatöre bırakıldı (kalıcı sistem değişikliği).
P1: retention politikası koda döküldü ama gerçek `backups/` üzerinde HENÜZ UYGULANMADI —
    kuru koşu: 865 dump (668.5 MB) · 8 IMMUTABLE korunuyor · 832 budanabilir (641.7 MB) · uygulanmadı (kuru koşu). Uygulama kararı operatörün.
P2: Golden UI smoke bu restore kopyası üzerinde KOŞULMADI — kapı uygulamanın açıldığını ve
    veritabanına bağlandığını kanıtlar; ekran seviyesi kanıt 03-real-clone-golden-ui.md'de,
    başka bir klon üzerinde durur.
P2: FINDING OPS-01 — yarıda kesilen `pnpm db:legacy-repair:verify` depoyu derlenemez bırakır.
    MEKANİZMA: verify, migration dosyalarını `.hidden-for-legacy-repair-verify-<pid>-<epoch>`
    ekiyle gizler ve koşu sonunda geri alır; süreç arada öldürülürse 58 migration gizli kalır.
    `pnpm db:migrate`, real-clone-gate ve CI düşer; `git status` 58 SİLİNMİŞ dosya gösterir ve
    bu, tam olarak YANLIŞ kurtarmaya (`git checkout`, artık dosya üretir) davet eder.
    KURTARMA: her `*.hidden-for-legacy-repair-verify-*` dosyasından eki sıyırın; migration
    dizinini ASLA `git checkout` etmeyin. Ayrıntı: docs/ops/incident-recovery-notes.md
```

## NOT VERIFIED — açıkça

```text
OFF_DEVICE PHYSICAL TARGET : NOT VERIFIED (BLOCKED) — yerel bir klasör off-device SAYILMAZ (§30.5).
GOLDEN UI ON RESTORE       : NOT VERIFIED — bu kapıda koşulmadı.
SCHEDULED TASK RUNNING     : NOT VERIFIED — görev kaydedilmedi; kaydedildikten sonraki ilk
                             gerçek tetiklenme operatör tarafından doğrulanmalı.
```

## NEXT GATE

```text
AŞAMA 08 — Consolidated Financial Correctness Gate (rehber §13).
Bu kapının bıraktığı operatör işi: off-device hedef + zamanlanmış görev kaydı.
```

## FINAL: PARTIAL — yalnız fiziksel off-device hedef BLOCKED

## Yeniden üretim

```bash
# 1) gerçek kaynaktan yedek + katı makbuz (temiz git ağacı gerektirir)
pnpm exec tsx scripts/db/backup-receipt.ts --expected-database-name mas_radar_dev \
  --expected-system-identifier <sysid> --expected-git-branch <branch> --expected-git-head <sha> \
  --container mas-radar-pg --label stage07_real --out-dir backups

# 2) kapı
MAS_OFFDEVICE_BACKUP_DIR=<hedef> pnpm exec tsx scripts/release/stage07-backup-gate.ts
```
