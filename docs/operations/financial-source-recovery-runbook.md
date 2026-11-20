# MAS Nexus — Finansal Kaynak Kurtarma, Nakit Açılış Mutabakatı ve Fiziksel Yedekleme Operatör El Kitabı (`F-11`, `F-15`, `F-16`, `F-17`)

- **Belge Sahibi:** `Agent 14` (Üretim Veri Operasyonları / Finans ve Fiziksel Yedekleme Sorumlusu)
- **Program & Dal:** V2 Üretim Sertleştirme (`remediation/v2-hardening` · Üst Commit `65f29251ad9a98b4a87d50b25a807c5f00da631a`)
- **Ölçüm Zamanı (UTC):** `2026-11-20T04:48:46.083Z` (`mas_radar_dev` şema defteri: `125/0125`)
- **Veri Güvenliği ve Gizlilik Güvencesi:** Tüm teşhis sorguları `default_transaction_read_only=on` oturum kilidi altında çalıştırılmıştır (`SQLSTATE 25006` negatif yazma kontrolü doğrulandı, `prod_db_writes = 0`). Bu belgede hiçbir gerçek cari/şirket unvanı, kişi adı, tam IBAN, parola veya bağlantı dizesi yer almaz; tüm varlıklar `[COUNTERPARTY_REDACTED_*]`, `[CASH_ACCOUNT_REDACTED_*]` ve 8 karakterlik UUID önekleriyle maskelenmiştir.

---

## Bölüm 1: Ölçülen Operasyonel Temel Durum (Measured Operational Baseline)

### 1.1 Bulgular ve Çıkış Kapısı Durum Özeti

| Bulgu / Kapı | Alan | Ölçülen Canlı Durum (`mas_radar_dev` & Ana Makine) | Durum | Engelleyici Dış Girdi / Donanım Gereksinimi |
| :--- | :--- | :--- | :---: | :--- |
| **`F-11` / `RG-03`** | Fiziksel Aygıt Dışı (Off-Device) Yedekleme & Geri Yükleme | `MAS_OFFDEVICE_BACKUP_DIR=D:\MAS-Backups\mas_radar_dev` tanımlı ancak `D:\` sürücüsü takılı değil (`existsSync = false`). Ana makinede yalnız dahili `C:` diski bağlı (`~2,33 GB` boş alan). `classifyOffDeviceTarget` sonucu `LOCAL_STANDIN` (`offDeviceSatisfied = false`). Yerel izole DR tatbikatı (`backups/latest-restore-drill.json`, `124/0124`) başarılı; `backups/` altında sahte `.offdevice.json` makbuzu üretilmedi (`0` adet). | **`BLOCKED`** | Bağımsız fiziksel harici USB SSD (`BusType=USB`, ayrı fiziksel disk) veya bağımsız NAS/SMB ağ paylaşımı bağlanmalı ve `<dump>.offdevice.json` makbuzu + güncel `125/0125` izole geri yükleme kanıtı üretilmelidir. |
| **`F-15` / `RG-09` / `RG-10`** | Finansal Kaynak Tazeliği, Kasa/Banka Açılış Tamlığı ve 4 Yönlü Mutabakat | `public.valid_workbook_imports` içindeki son geçerli çalışma kitabı (`f7af8764-...`, `[WORKBOOK_REDACTED_1.xlsx]`) `2026-07-17T13:14:28.804Z` tarihli (`125,65` / `126` gün > `45` gün eşiği -> `isStale = true`). Aktif `6/6` TRY `cash_accounts` kaydında `opening_balance IS NULL` (`0` bilinen açılış, `0` `bank_accounts` IBAN profili). `public.bank_transactions = 0` satır. 4 yönlü alt defter mutabakatında yalnız `1/4` sütun uyumlu (`bank_102 = unknown_opening_balance`, `checks_101_103 = divergent`, `loans_300_400 = divergent`). | **`BLOCKED`** | Yetkili finans ekibi tarafından onaylı resmi banka ekstreleri, kasa sayım tutanağı, doğrulanmış dönem başı açılış bakiyeleri ve güncel çalışma kitabı içe aktarılmalıdır (`NULL -> 0` veya sentetik `seed:demo` kesinlikle yasaktır). |
| **`F-16`** | Olası Mükerrer Çek Adaylarının İnsan Triyajı | `public.checks` tablosunda `7` kayıt (`6` aktif, `1` arşivli; aktiflerin `6/6`'sında `serial_no IS NULL`). Aynı `(cari, tutar, vade)` imzasını paylaşan **`2` küme (`5` aktif çek, `public.control_duplicate_checks` içinde `4` çift)** mevcut; açık uyarı alarmı `e28ee09e-...` aktif. Otomatik birleştirme yapılmadı (`autoMergedCount = 0`). | **`BLOCKED`** | Fiziki çek koçanı (`seri_no`), keşide/teminat bordrosu ve banka takas dekontları üzerinden insan finans sorumlusu doğrulaması ve denetim izli karar kaydı gereklidir. |
| **`F-17` / `RG-11`** | Geçmiş Dönem Onay Atlama Kaydının Denetlenebilir Korunması | `public.control_approval_bypass` görünümünde **`1` açık kayıt** (`payment_instance_id = 33ad79cf-...`, vade `2026-06-09`, `120.000,00 TRY >= 100.000 TRY` eşiği, `2026-07-17T13:14:33Z` ilk veri geçişi kapanışı) ve `public.control_alerts` altında **`1` açık kritik alarm** (`759f030b-...`) korunmaktadır. İleriye dönük tek operatör kendi kendine onay kilidi kapalıdır (`allow_single_operator_self_approval = false`, `2` aktif yönetici). | **`BLOCKED`** *(İnsan Komite Kararı Bekliyor)* | Teknik ileriye dönük kapılar aktiftir; geçmiş `33ad79cf-...` kaydının kapatılması yalnız Finans Komitesi / CFO belge incelemesi ve `/system/controls` üzerinden denetim notuyla yapılabilir. |

---

### 1.2 Detaylı Salt-Okunur Teşhis Bulguları (`default_transaction_read_only = on`)

#### A. Çalışma Kitabı Tazeliği ve İçe Aktarım Kalitesi (`F-15`)
- **Toplam `source_workbooks`:** `1` adet (`workbook_id = f7af8764-...`, durum `parsed`, `import_rows = 1.601`, `in_valid_view = true`).
- **Hariç Tutulan Boş / Hatalı İçe Aktarımlar:** `0` boş (`0` satırlı) çalışma kitabı, `0` `failed`/`pending` çalışma kitabı (`viewParityVerified = true`).
- **Son Geçerli İçe Aktarım Yaşı:** `2026-07-17T13:14:28.804Z` -> **`126` gün** (`125,65` tam gün; izin verilen üst sınır `<= 45` gün; aşım `+81` gün; `isStale = true`).
- **Staging & Eşleme İncelemeleri (`import_rows` & `mapping_reviews`):**
  - `1.601` toplam satır: `1.021` `mapped`, `525` `unmapped`, `55` `needs_review`, `0` `rejected`/`error`.
  - `62` toplam `mapping_reviews`: `52` `open` + `1` `rejected` = **`53` engelleyici inceleme**, `2` `accepted`, `7` `resolved`.
- **Şablon ve Ödeme Kalemi Tutar Tamlığı (`BLANK != ZERO`):**
  - `public.payments`: `19` şablon (`18` aktif çıkış + `1` arşivli); aktif şablonların **`12 / 18`'inde** `default_amount IS NULL` (`%33,33` tamlık).
  - `public.payment_instances`: `536` kalem (`511` aktif çıkış + `25` iptal); aktif kalemlerin **`330 / 511`'inde** `amount IS NULL` (`%35,42` tamlık).

#### B. Kasa/Banka Hesapları, Banka Hareketleri ve 4 Yönlü Alt Defter Mutabakatı (`F-15`)
- **Aktif `public.cash_accounts` Dağılımı (`6` aktif / `0` arşivli — tamamı `TRY`):**

| Maskeli Hesap Kodu | UUID Öneki | Hesap Türü (`account_type`) | Para Birimi | `opening_balance` | `opening_journal_entry_id` | `bank_accounts` / IBAN Profili |
| :--- | :--- | :--- | :---: | :---: | :---: | :---: |
| `[CASH_ACCOUNT_REDACTED_1]` | `3796caeb-...` | `cash` | `TRY` | `NULL` *(Bilinmiyor)* | Yok (`false`) | Yok (`false`) |
| `[CASH_ACCOUNT_REDACTED_2]` | `620b9f31-...` | `check_account` | `TRY` | `NULL` *(Bilinmiyor)* | Yok (`false`) | Yok (`false`) |
| `[CASH_ACCOUNT_REDACTED_3]` | `7be95a92-...` | `bank_account` | `TRY` | `NULL` *(Bilinmiyor)* | Yok (`false`) | Yok (`false`) |
| `[CASH_ACCOUNT_REDACTED_4]` | `b2167ee0-...` | `credit_card` | `TRY` | `NULL` *(Bilinmiyor)* | Yok (`false`) | Yok (`false`) |
| `[CASH_ACCOUNT_REDACTED_5]` | `d4c5bdef-...` | `bank_account` | `TRY` | `NULL` *(Bilinmiyor)* | Yok (`false`) | Yok (`false`) |
| `[CASH_ACCOUNT_REDACTED_6]` | `f19bdfa8-...` | `credit_card` | `TRY` | `NULL` *(Bilinmiyor)* | Yok (`false`) | Yok (`false`) |

- **`public.bank_transactions`:** `0` toplam satır (`non_ignored_rows = 0`, en erken hareket tarihi `null`, en geç hareket tarihi `null`).
- **`public.cashflow_months` (Projeksiyon / `FORECAST`):** `35` ay (`2026-05-01` .. `2029-03-01`); `2026-09-01` itibarıyla `31` ayda negatif kapanış projeksiyonu bulunmaktadır. Bu tablo çalışma kitabı tahmini (`FORECAST`) olup gerçekleşen (`ACTUAL`) banka bakiyesi yerine kullanılmaz.
- **4 Yönlü Alt Defter ↔ TDHP Yönetim Defteri Mutabakatı (`loadFourWaySubledgerHealth`):**

| Sütun Anahtarı | TDHP Kodları | Alt Defter (`TRY`) | Yönetim Defteri GL (`TRY`) | Fark (`deltaTry`) | Durum | Açıklama |
| :--- | :---: | :---: | :---: | :---: | :---: | :--- |
| `bank_102` | `100 / 102` | `null` | `-71.744,12` | `null` | **`unknown_opening_balance`** | `FIN-03`: `6` aktif TRY hesapta açılış bakiyesi `NULL`; mutabakat ölçülemez. |
| `ar_ap_120_320` | `120 / 320` | `0,00` | `0,00` | `0,00` | **`aligned`** | `public.invoices = 0` satır; bakiye uyumlu. |
| `checks_101_103` | `101 / 103 / 121 / 321` | `-445.000,00` | `0,00` | `-445.000,00` | **`divergent`** | Çalışma kitabından gelen aktif borç çeklerinin açılış/keşide `103` yönetim fişleri henüz kesilmemiştir. |
| `loans_300_400` | `300 / 400` | `1.965.619,33` | `-15.224,12` | `1.980.843,45` | **`divergent`** | Çalışma kitabından gelen kredinin `300/400` açılış/kullanım anapara fişi eksik; yalnız tek taksit kapaması GL'de mevcuttur. |

#### C. Olası Mükerrer Çek Adayları ve Geçmiş Onay Atlama Kaydı (`F-16` & `F-17`)
- **Olası Mükerrer Aktif Çek Kümeleri (`autoMergedCount = 0`):**
  1. **`[COUNTERPARTY_REDACTED_1]` Kümesi (`check_count = 3`, `3` ikili çift):**
     - Ortak imza: `maturity_date = 2026-08-31`, `amount = 100.000,00 TRY`, `direction = outflow`, cari FK bağlı (`allHavePartyFk = true`).
     - Üyeler: `528f6b52-...` (`row_index = 7`, `status = planned`, `serial_no = NULL`), `4aa4a727-...` (`row_index = 11`, `status = planned`, `serial_no = NULL`), `78db5fe2-...` (`row_index = 18`, `status = planned`, `serial_no = NULL`).
  2. **`[COUNTERPARTY_REDACTED_2]` Kümesi (`check_count = 2`, `1` ikili çift):**
     - Ortak imza: `maturity_date = 2026-07-31`, `amount = 45.000,00 TRY`, `direction = outflow`, metin etiketi bazlı (`allHavePartyFk = false`).
     - Üyeler: `bba2d423-...` (`row_index = 3`, `status = cleared`, `serial_no = NULL`), `0e172cec-...` (`row_index = 17`, `status = planned`, `serial_no = NULL`).
- **Geçmiş Dönem Onay Atlama Kaydı (`public.control_approval_bypass`):**
  - `1` kayıt: `payment_instance_id = 33ad79cf-...`, `due_date = 2026-06-09`, `amount = 120.000,00 TRY` (`threshold_amount = 100.000 TRY`), `instance_status = paid`, `paid_at = 2026-07-17T13:14:33Z`, `approval_status = not_required`, `approval_id = NULL`.
  - İlgili açık kontrol alarmları (`public.control_alerts`): `759f030b-...` (`approval_bypass`, `critical`, `open`, `occurrence_count = 10`) ve `e28ee09e-...` (`duplicate_check`, `warning`, `open`, `occurrence_count = 3`).

#### D. Fiziksel Yedekleme ve İzole Geri Yükleme Durumu (`F-11`)
- **Yerel Yedek ve Geri Yükleme Kanıtı:**
  - En güncel yerel `.dump`: `migrate-mas_radar_dev-2026-11-19T15-11-00-647Z.dump` (`2.077.493` bayt, yaş `13,63` saat `<= 48` saat, SHA-256 `e6d0083dddf4532f...`, `2.358` TOC girdisi okunabilir).
  - En güncel zamanlanmış günlük `.dump`: `daily-2026-11-18T00-00-44-034Z.dump` (`2.073.367` bayt, `.sha256` ve `.stage07.json` yan dosyaları mevcut).
  - Son izole DR tatbikatı (`backups/latest-restore-drill.json`): `2026-11-18T19:29:13.091Z` tarihinde `mas_radar_dr_verify_test` üzerinde `passed = true` (`132/132` RLS tablo, satır ve parasal toplamlar birebir eşleşti, `isolatedDbDropped = true`).
- **Operasyonel Disk ve Günlük Koşu Bulgusu:**
  - `backups/daily-runs.jsonl` (`35` kayıt): `2026-09-13T13:41:00.992Z` tarihinde harici USB SSD takılıyken `1` kez `offDeviceOk = true` kanıtlanmış; izleyen `16` koşuda `D:\` takılı olmadığı için `exitCode = 3` (`ENOENT`) üretilmiş; son koşuda (`2026-11-20T03:53:07.915Z`) ise geçici yerel `pg_dump` bağlantı zaman aşımı (`exitCode = 1`) kaydedilmiştir.
  - **Kritik Ana Makine Disk Uyarısı:** `C:` sürücüsünde toplam `254,95 GB` alanın yalnız **`2,33 GB`'ı (`2.502.455.296` bayt)** boştur. Yeni DR tatbikatı veya büyük veri içe aktarımı öncesinde `C:` üzerinde güvenli boş alan (`>= 10 GB` önerilir) sağlanmalıdır.

---

## Bölüm 2: Fiziksel Aygıt Dışı (Off-Device) Yedekleme ve Geri Yükleme Doğrulama Prosedürü (`F-11` / `RG-03`)

> [!CAUTION]
> **Kesin Güvenlik Kuralları (`F-10` & `F-11`):**
> 1. Dahili sistem diski (`C:\`) üzerindeki ikinci bir klasör **asla** aygıt dışı yedek (`off-device`) sayılmaz; sistem bu hedefleri `LOCAL_STANDIN` (`offDeviceSatisfied: false`) olarak reddeder.
> 2. Hedefte bayt boyutu, diskten yeniden okunan SHA-256 özeti ve `pg_restore --list` TOC bütünlüğü doğrulanmadan `.offdevice.json` makbuzu **yazılmaz** ve asla elle oluşturulmaz.

### Adım 2.1 — Ön Hazırlık ve Ana Makine Disk Kontrolü
1. Ana makinede `C:` boş alanını ve PostgreSQL 16 servis durumunu kontrol edin:
   ```powershell
   Get-CimInstance Win32_LogicalDisk | Select-Object DeviceID, DriveType, Size, FreeSpace
   ```
2. `C:` boş alanı `5 GB` altındaysa geçici derleme/test artıklarını temizleyin (doğrulanmış yedeklere elle dokunmayın; budama yalnız `pnpm ops:backup:prune` ile ve `sole_verified_backup_protected` güvencesi altında çalıştırılır).

### Adım 2.2 — Bağımsız Fiziksel Birimin Bağlanması ve Topoloji Doğrulaması
1. **Seçenek A (Harici Fiziksel USB SSD/HDD):** Yedeklemeye ayrılmış şifreli/kurumsal USB diski (`D:\` veya atanan sürücü harfi) iş istasyonuna bağlayın ve fiziksel olarak ayrı bir disk (`BusType=USB`, `DiskNumber != 0`, `IsBoot=false`, `IsSystem=false`) olduğunu doğrulayın:
   ```powershell
   Get-Disk | Select-Object Number, BusType, IsBoot, IsSystem, OperationalStatus, Size
   Get-Volume | Select-Object DriveLetter, FileSystem, DriveType, HealthStatus, SizeRemaining
   ```
2. **Seçenek B (Bağımsız Kurumsal NAS / SMB Paylaşımı):** Üretim sunucusundan fiziksel olarak ayrı bir NAS birimini bağlayın (`\\<nas-sunucu>\<paylasim>\mas_radar_dev`) ve yazma yetkisini doğrulayın.
3. `MAS_OFFDEVICE_BACKUP_DIR` ortam değişkeninin bağlı birime işaret ettiğini doğrulayın (ör. `D:\MAS-Backups\mas_radar_dev`) ve `--dry-run` ile hedef sınıflandırmasını test edin:
   ```powershell
   pnpm exec tsx scripts/ops/offdevice-copy.ts --dry-run
   ```
   - **Beklenen Çıktı:** `Hedef sınıfı : USB_PHYSICAL_VOLUME` (veya `UNC_NETWORK_SHARE`) ve `OFF_DEVICE PHYSICAL TARGET = OK`.
   - Çıktıda `LOCAL_STANDIN` veya `BLOCKED` görülürse **durun**; hedef aynı fiziksel disktedir veya birim erişilemez durumdadır.

### Adım 2.3 — Tam Günlük Yedek, Aygıt Dışı Kopyalama ve Makbuz Doğrulaması
1. Güncel şema (`125/0125`) üzerinden taze yerel yedek ve eşzamanlı aygıt dışı kopya üretin:
   ```powershell
   pnpm ops:backup:daily
   ```
   *(Yalnız mevcut en güncel doğrulanmış yerel `.dump` dosyasını harici hedefe kopyalamak için: `pnpm ops:backup:offdevice`)*
2. Harici hedefte oluşturulan `<dump>.offdevice.json` makbuzunu ve sıkı mod (`--strict-offdevice`) doğrulayıcısını çalıştırın:
   ```powershell
   pnpm backup:offdevice:verify -- --strict-offdevice --json
   ```
   - **Zorunlu Kabul Kriterleri (`exit 0`):**
     - `"ok": true`, `"mode": "offdevice"`
     - `"offDeviceConfigured": true`, `"offDeviceReachable": true`, `"offDeviceSatisfied": true`
     - `"offDeviceReceiptPresent": true`, `"offDeviceReceiptShaMatch": true`
     - `"restoreListable": true`, `"tocEntryCount" > 0`
     - `"criticalTablesPresent"`: `paymentInstances`, `payments`, `auditLogs`, `schemaMigrations` tamamı `true`.

### Adım 2.4 — Harcanabilir Veritabanında İzole Tam `pg_restore` Tatbikatı (`RG-03`)
1. Yedeğin yalnız TOC listesini değil, tam şema + RLS + parasal toplam geri yüklenebilirliğini kanıtlamak için izole tatbikat betiğini çalıştırın:
   ```powershell
   node --import tsx scripts/ops/verify-restore-drill-fast.ts
   ```
2. `backups/latest-restore-drill.json` dosyasını kontrol edin:
   - `"passed": true`, `"sourceDb": "mas_radar_dev"`, `"isolatedDb": "mas_radar_dr_verify_test"`, `"isolatedDbDropped": true`
   - `"schemaLedger": "125/0125"`, `"rlsTablesVerified"` === `"tablesVerified"`
   - `"countsMatched": true`, `"aggregatesMatched": true`, `"runtimeRoleParityVerified": true`.
3. Üretilen son DR `.dump` dosyasını da `pnpm ops:backup:offdevice` ile harici diske kopyalayıp tekrar `pnpm backup:offdevice:verify -- --strict-offdevice` çalıştırarak `F-11` / `RG-03` kapısını kapatın.

---

## Bölüm 3: Yetkili Finansal Kaynak İçe Aktarımı ve Nakit Açılış Mutabakatı (`F-15` / `RG-09` / `RG-10`)

> [!WARNING]
> **Finansal Veri Bütünlüğü Kırmızı Çizgileri (`FIN-03` & `BLANK != ZERO`):**
> - **Asla `NULL -> 0` Yapmayın:** Açılış bakiyesi veya yükümlülük tutarı resmi kaynak belgede henüz doğrulanmamışsa alanı boş (`NULL`) bırakın. Bilinmeyen bakiyeye `0,00 TRY` yazmak sahte likidite/borç sinyali üretir ve kesinlikle yasaktır. (Bir hesabın bakiyesi banka ekstresinde gerçekten `0,00 TRY` ise yalnızca resmi ekstre kanıtıyla `0,00` girilir.)
> - **Üretimde Sentetik Tohumlama Yasaktır:** `mas_radar_dev` veya üretim veritabanına karşı **asla** `pnpm seed:demo`, test fikstürü veya denetim izsiz manuel `INSERT/UPDATE` çalıştırmayın.
> - **Boş veya Hatalı İçe Aktarım Tazelik Sayacını Sıfırlamaz:** `0` satırlı ya da `failed` durumundaki yüklemeler `public.valid_workbook_imports` görünümüne girmez ve `latestValidImportAgeDays` değerini düşürmez.

### Adım 3.1 — Salt-Okunur Ön Kontrol (Read-Only Preflight)
İçe aktarım penceresini açmadan önce hiçbir veriyi değiştirmeden (`default_transaction_read_only=on`) mevcut şema, dönem kilidi (`public.accounting_periods`), açık `mapping_reviews` ve kasa/banka hesap envanterini doğrulayın:
```powershell
psql "$env:MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 -c "SET default_transaction_read_only = on; SELECT count(*) AS valid_wb, max(imported_at) AS latest_import FROM public.valid_workbook_imports; SELECT count(*) FILTER (WHERE opening_balance IS NULL) AS null_openings, count(*) AS total_active FROM public.cash_accounts WHERE is_active = true AND archived_at IS NULL;"
```
- Kilitli muhasebe dönemi (`status = 'closed'` / `'locked'`) varsa o döneme ait geçmiş tarihli kayıt yazımı sistem tarafından (`isAccountingPeriodLockedWithClient`) reddedilecektir; açılış ve ekstre tarihlerinin açık döneme denk geldiğini kontrol edin.

### Adım 3.2 — Maker-Checker (Hazırlayan–Onaylayan) Kaynak Paketi ve Zorunlu İzlenebilirlik Alanları
Finans Operatörü (**Hazırlayan / Maker**) ve Finans Yöneticisi / CFO (**Onaylayan / Checker**) aşağıdaki resmi kaynak belgeleri hazırlayıp çapraz kontrol eder:
1. Aktif `6` kasa/banka hesabının (`[CASH_ACCOUNT_REDACTED_1..6]`) resmi dönem başı banka ekstreleri / ıslak imzalı kasa sayım tutanağı ve 26 haneli resmi `TR` IBAN bilgileri.
2. Dönem başından bugüne kesintisiz resmi banka hesap hareketleri (`.xlsx`, `.csv`, `MT940` veya `CAMT.053`).
3. Eksik tutarlı ödeme şablonları (`12/18` şablon) ve vade kalemlerini tamamlayan güncel yetkili çalışma kitabı (`.xlsx`).

Her içe aktarılan kaynak ve açılış kaydı için sistemde şu **8 zorunlu izlenebilirlik alanı** oluşmalı ve kontrol listesine işlenmelidir:

| Zorunlu Alan | Sistem Karşılığı (`PostgreSQL` / Uygulama) | Doğrulama Kuralı |
| :--- | :--- | :--- |
| `source_id` | `source_workbooks.id` / `cash_accounts.opening_journal_entry_id` / `documents.id` | Benzersiz UUID; her hareket ve açılış fişi kaynak kayda bağlı olmalıdır. |
| `imported_at` | `source_workbooks.imported_at` / `audit_logs.created_at` | Sunucu UTC zaman damgası (`<= 45` gün tazelik eşiği). |
| `as_of` | `cash_accounts.opening_balance_date` / `bank_transactions.txn_date` / `balance_as_of` | Resmi ekstrenin / kasa sayımının ait olduğu iş günü (`YYYY-MM-DD`). |
| `currency` | `cash_accounts.currency` / `bank_transactions.currency` | ISO 4217 para birimi (`TRY`, `USD`, `EUR` vb.); hesap para birimiyle birebir uyumlu olmalıdır. |
| `row_count` | `import_rows` sayısı (`>= 1`) / `StatementImportResult.inserted` | Geçerli içe aktarım için `row_count >= 1` zorunludur. |
| `approved_by` | `approvals.decided_by` / `audit_logs.actor_id` + Maker-Checker tutanak imzası | Hazırlayan operatörden (`requested_by`) **farklı** yetkili onaylayıcı (`decided_by != requested_by`). |
| `checksum` | `source_workbooks.file_sha256` / `documents.sha256` | Kaynak dosyanın 64 karakterlik SHA-256 özeti (`expectedSha256` önizleme-onay kilidi). |
| `reconciled_at` | `bank_transactions.settled_at` / `bank_reconciliation_summary` / mutabakat zamanı | Ekstre kapanış bakiyesi ile türetilen bakiyenin (`stated_minus_derived = 0,00`) doğrulandığı zaman damgası. |

### Adım 3.3 — Çalışma Kitabı Önizleme -> İnceleme -> SHA-256 Kilitli İçe Aktarım (`/data/imports/v2`)
1. **Önizleme (Salt-Okunur):** Finans Operatörü `/data/imports/v2` ekranından yetkili `.xlsx` çalışma kitabını yükleyip **Önizle** (`previewV2Action`) adımını çalıştırır.
   - Önizleme raporu veritabanına kalıcı satır yazmaz; dosyanın `sha256` özetini, hedef tablo bazında eklenecek/güncellenecek satır sayılarını (`row_count`), uyarıları ve reddedilen satırları üretir.
2. **Maker-Checker Kontrolü:** Finans Yöneticisi önizleme toplamlarını, para birimlerini ve satır sayısını kaynak dosyayla karşılaştırır. `rowsRejected > 0` veya hatalı sütun eşlemesi varsa dosya kaynakta düzeltilir.
3. **SHA-256 Kilitli Onay (`confirmV2Action`):** Önizlemedeki `expectedSha256` ile aynı dosya onaylanarak içe aktarılır.
4. **Eşleme İncelemelerinin Kapatılması (`/data/reviews`):** Açılan `mapping_reviews` kayıtları tek tek incelenerek belgeli biçimde `accepted` veya `rejected` olarak sonuçlandırılır (`blockingMappingReviews = 0` hedeflenir; mükerrer çek incelemelerinde Bölüm 4 kuralları uygulanır).

### Adım 3.4 — Kasa/Banka IBAN Tanımlama ve Doğrulanmış Açılış Bakiyesi Girişi (`/finance/bank` & `/data/approvals`)
1. **Banka Profili ve MOD-97 IBAN Kaydı:**
   - `/finance/bank` ekranından her aktif banka hesabı için banka/şube adını ve resmi 26 haneli `TR` IBAN bilgisini (`TR00 ... [IBAN_REDACTED]`) kaydedin (`upsertBankOrCashAccountAction`).
   - Sistem ISO 13616 MOD-97-10 kontrol basamağını doğrular ve IBAN kaydını `pending_approval` (`verified_at IS NULL`) durumunda `public.ibans` kasasına alır.
2. **4-Göz IBAN Onayı:**
   - İkinci yetkili onaylayıcı `/data/approvals` ekranından yeni IBAN kaydını resmi banka cüzdanı/ekstresiyle karşılaştırarak onaylar (`decideApproval` -> `approval_status = 'approved'`, `verified_at = now()`).
3. **Doğrulanmış Açılış Bakiyesi (`opening_balance` & `500.99` Açılış Fişi):**
   - Resmi dönem başı ekstresi / kasa sayım tutanağı `/data/documents` ekranından yüklenerek `sha256` özetiyle arşivlenir.
   - `/finance/bank` (veya genel bakış FIN-03 çekmecesi `batchSaveOpeningBalancesAction`) üzerinden her hesap için belge üzerindeki kesin `opening_balance` ve `opening_balance_date` (`as_of`) girilir.
   - Sistem otomatik olarak dengeli **TDHP `500.99` Açılış Defteri** yönetim yevmiye fişini (`opening_journal_entry_id`) ve `audit_logs` kaydını üretir. Belgesi henüz temin edilemeyen hesap varsa alanı **boş bırakın** (`NULL` kalır; asla `0` yazmayın).

### Adım 3.5 — Gerçek Banka Ekstresi İçe Aktarımı, Eşleştirme ve Hesap Mutabakatı (`/finance/bank`)
1. Her aktif banka hesabı için `/finance/bank` ekranından resmi hesap ekstresini (`xlsx` / `csv` / `mt940` / `camt053`) yükleyin (`importStatementAction`).
   - Sistem kaynak dosyayı `source_workbooks` tablosuna `file_sha256` ve `imported_at` ile kaydeder, mükerrer hareketleri `dedupeKey` ile engeller.
2. **Aday Eşleştirme (`runMatcherAction`):** `±90` gün penceresinde açık ödeme kalemleri (`payment_instances`), çekler (`checks`), kredi taksitleri (`loan_installments`) ve faturalarla (`invoices`) eşleştirme önerilerini çalıştırın.
3. **Eşik Üstü Ödeme Onay Kapısı (`>= 100.000 TRY`):** `100.000 TRY` ve üzeri çıkışların kapatılmasında önce `/data/approvals` üzerinden farklı bir onaylayıcının maker-checker onayı tamamlanmalıdır; onaysız kapama hem uygulama katmanında hem PostgreSQL tetikleyicisinde (`SQLSTATE 42501: APPROVAL_REQUIRED`) engellenir.
4. **Ekstre Kapanış Mutabakatı:** Ekstre dönem sonu bakiyesi (`stated_balance`) ile sistemin açılış + net hareketten türettiği bakiye (`derived_balance`) karşılaştırılır (`stated_minus_derived = 0,00 TRY`) ve hesap mutabakatı tamamlanır (`reconciled_at`).

### Adım 3.6 — 4 Yönlü Alt Defter, Yönetim Defteri ve Yasal Mizan Mutabakat Doğrulaması
1. `/data/reconciliation` ve `/data/quality` ekranlarını açarak 4 ana mutabakat sütununu kontrol edin:
   - `bank_102` (`100 / 102` Banka & Kasa): `unknownOpeningCount = 0`, `status = "aligned"`, `|deltaTry| <= 1,00 TRY`.
   - `ar_ap_120_320` (`120 / 320` Cari Faturalar): `status = "aligned"`, `|deltaTry| <= 1,00 TRY`.
   - `checks_101_103` (`101 / 103 / 121 / 321` Çek & Senet): Aktif çeklerin keşide/portföy bordro ve yönetim fişleri tamamlandığında `status = "aligned"`, `|deltaTry| <= 1,00 TRY`.
   - `loans_300_400` (`300 / 400` Banka Kredileri): Kredi açılış/kullanım anapara fişi tamamlandığında `status = "aligned"`, `|deltaTry| <= 1,00 TRY`.
2. `/data/trial-balance-bridge` ekranından Mali Müşavir Yasal Mizan (`.xlsx`) karşılaştırmasını çalıştırarak `100`, `101`, `102`, `103`, `120`, `300/400`, `320` gruplarında açıklanamayan fark kalmadığını (`unexplainedBridgeResidualTry = 0,00`) ve `/insights/reports` altında CFO rapor güven derecesinin `VERIFIED_COMPLETE` seviyesine yükseldiğini teyit edin.

---

## Bölüm 4: Olası Mükerrer Çek Adaylarının ve Geçmiş Dönem Onay Atlama Kaydının İnsan Triyajı (`F-16` & `F-17` / `RG-11`)

> [!IMPORTANT]
> **Otomatik Birleştirme ve Kayıt Silme Yasağı:**
> - Türkiye ticari pratiğinde aynı tedarikçiye aynı vade ve aynı yuvarlak tutarda (ör. `3 × 100.000,00 TRY`) birden fazla sıralı fiziksel çek yaprağı keşide edilmesi olağandır. Bu nedenle hiçbir betik veya operatör SQL üzerinden `DELETE` ya da algoritmik otomatik birleştirme (`auto-merge`) **uygulayamaz**.
> - Geçmiş dönem onay atlama bulgusu (`33ad79cf-...`) tarihsel denetim kanıtıdır; silinemez ve geriye dönük yapay onay satırı eklenemez.

### Adım 4.1 — Olası Mükerrer Çek Adaylarının Fiziki Belge Triyajı (`F-16`)

İncelenecek canlı aday kümeleri (`public.control_duplicate_checks` & alarm `e28ee09e-...`):
- **Küme 1 (`[COUNTERPARTY_REDACTED_1]`):** Vade `2026-08-31` · Tutar `100.000,00 TRY` · Yön `outflow` · `check_count = 3` (`528f6b52-...` satır `7`, `4aa4a727-...` satır `11`, `78db5fe2-...` satır `18`).
- **Küme 2 (`[COUNTERPARTY_REDACTED_2]`):** Vade `2026-07-31` · Tutar `45.000,00 TRY` · Yön `outflow` · `check_count = 2` (`bba2d423-...` satır `3` `cleared`, `0e172cec-...` satır `17` `planned`).

**Uygulama Adımları (Hazırlayan Finans Operatörü + Onaylayan Finans Yöneticisi):**
1. **Fiziki Evrak İncelemesi:** Çek koçanı dip koçanlarını, imzalı keşide bordrolarını, varsa banka teminat/tahsil bordrolarını ve banka ödeme/takas dekontlarını çıkarın (özellikle Küme 2'deki `bba2d423-...` `cleared` kaydının banka çıkış dekontu ile `0e172cec-...` `planned` kaydının ayrı bir çek yaprağı olup olmadığını kontrol edin).
2. **Senaryo A — Kayıtların Ayrı Fiziki Çek Yaprakları Olduğu Doğrulanırsa:**
   - Her bir çekin gerçek çek seri/yaprak numarasını (`serial_no`) ve banka bilgisini tamamlayın.
   - Çek koçanı / bordro taramasını `/data/documents` kasasına yükleyip ilgili çek kaydına bağlayın.
   - `/system/controls` ekranında `duplicate_check` (`e28ee09e-...`) uyarısını, doğrulanan çek seri numaralarını ve belge `sha256`/kayıt referanslarını içeren detaylı notla `false_positive` veya `resolved` durumuna geçirin (`setAlertStatusAction`).
3. **Senaryo B — Kayıtlardan Birinin veya Birkaçının İçe Aktarım Kaynaklı Mükerrer Olduğu Doğrulanırsa:**
   - Fiziki karşılığı olan asıl çeki koruyun ve belge/seri numarasını işleyin.
   - Yalnız fiziki yaprağı bulunmayan mükerrer kopya(lar) için `/finance/checks` ekranından **Çek İptali** (`cancelCheckAction`) işlemini çalıştırın; iptal gerekçesine (`cancel_reason`) *"Fiziki çek koçanı kontrolü [Tarih / Tutanak No]: [Asıl UUID öneki] kaydının çalışma kitabı satır tekrarı olduğu doğrulandı"* notunu yazın.
   - İptal edilen kayıt `status = 'cancelled'` ve `audit_logs` iziyle korunur, `public.control_duplicate_checks` görünümünden doğal olarak düşer; son olarak `/system/controls` üzerinden `e28ee09e-...` alarmını tutanak referansıyla `resolved` olarak kapatın.

### Adım 4.2 — Geçmiş Dönem Onay Atlama Kaydının Finans Komitesi Kararıyla Sonuçlandırılması (`F-17`)

İncelenecek tarihsel kayıt (`public.control_approval_bypass` & kritik alarm `759f030b-...`):
- **Kayıt Özeti:** `payment_instance_id = 33ad79cf-...` · Vade `2026-06-09` · Tutar `120.000,00 TRY` (`>= 100.000 TRY` eşiği) · İlk çalışma kitabı geçişi sırasında (`2026-07-17T13:14:33Z`, onay motoru devreye alınmadan önce) `paid` olarak işlenmiştir.

**Uygulama Adımları:**
1. **Belge Doğrulaması:** `2026-06` dönemine ait ilgili kredi kartı ekstresi ve banka ödeme dekontunu inceleyerek `120.000,00 TRY` tutarındaki ödemenin gerçek, yetkili şirket işlemi olduğunu teyit edin ve dekontu `/data/documents` kasasına yükleyin.
2. **Finans Komitesi / CFO Tutanak Kaydı (`Post-Facto` Mutabakat):**
   - `public.payment_instances` üzerindeki `33ad79cf-...` satırına veya `public.approvals` tablosuna geriye dönük manuel müdahale **yapmayın**.
   - CFO / Finans Yöneticisi oturumuyla `/system/controls` ekranını açın ve `approval_bypass` (`759f030b-...`) kritik uyarısı üzerinde `setAlertStatusAction` aracılığıyla durum geçişini (`acknowledged` -> inceleme tamamlandığında `resolved`) uygulayın.
   - Zorunlu açıklama notuna (`note`): *"2026-07-17 ilk veri geçişi (pre-0054/0122) tarihsel ödeme kaydı (`33ad79cf-...`); banka ödeme dekontu [Belge ID] ve Finans Komitesi [Tarih / Karar No] tutanağı ile doğrulandı"* bilgisini kaydedin.
3. **İleriye Dönük Kontrol Doğrulaması:** `/system/security` ve `/data/approvals` ekranlarından `allow_single_operator_self_approval = false` ayarının aktif olduğunu ve en az `2` bağımsız aktif onaylayıcı hesabın tanımlı kaldığını doğrulayın.

---

## Ek: Kapanış Sonrası Salt-Okunur Doğrulama Kontrol Listesi

Operatör adımları tamamlandığında tüm blokajların kalktığını doğrulamak için aşağıdaki salt-okunur kontrollerin tamamı `PASS` vermelidir:
1. `pnpm backup:offdevice:verify -- --strict-offdevice` -> `BACKUP_VERIFY_STATUS = PASS (mode=offdevice, offDeviceSatisfied=true)`.
2. `node --import tsx scripts/ops/verify-restore-drill-fast.ts` -> `backups/latest-restore-drill.json` içinde `"passed": true`, `"schemaLedger": "125/0125"`.
3. `public.valid_workbook_imports` son geçerli içe aktarım yaşı `<= 45` gün (`isStale = false`).
4. Aktif `public.cash_accounts` hesaplarında `opening_balance IS NULL` sayısı `= 0` ve `public.bank_transactions` içinde doğrulanmış dönem ekstre hareketleri mevcut (`> 0`).
5. `/data/reconciliation` 4 yönlü alt defter sağlığı: `alignedCount = 4`, `unknownCount = 0`, `divergentCount = 0`, `failedCount = 0`.
6. `/system/controls` altında `duplicate_check` ve `approval_bypass` bulguları belgeli insan inceleme notlarıyla (`audit_logs` izli) sonuçlandırılmış durumda.
