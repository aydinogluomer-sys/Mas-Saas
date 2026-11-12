# RUNBOOK — backup (yedek al ve doğrula)

> **Kime:** MAS operatörüne. Yazılım geliştirici olmanız gerekmez.
> **Çalışma dizini (her komut için):** `C:\Users\Trade Bilisim\Mas Saas`
> **Politika ve saklama süreleri:** `docs/backup-restore-policy.md` ·
> **Zamanlanmış görev kurulumu:** [backup-schedule.md](backup-schedule.md)

---

## PURPOSE

Gerçek veritabanının (`mas_radar_dev`) ve yerel doküman kasasının **geri yüklenebilir** bir kopyasını yerel PostgreSQL 16 araçlarıyla (`C:\MAS\pgsql16\bin\pg_dump.exe`, `pg_restore.exe`) almak ve doğrulamak.

"Dosya oluştu" bir yedek değildir. Bu runbook her yedek için dört soruyu sorar:

```text
1. dump dosyası oluştu mu ve > 0 bayt mı? (BACKUP EXISTS)
2. arşiv okunabiliyor mu?                 (BACKUP READABLE — pg_restore.exe --list)
3. kopyası ikinci bir aygıtta mı?         (OFF-DEVICE — MAS_OFFDEVICE_BACKUP_DIR)
4. gerçekten geri yüklenebiliyor mu?      (RESTORABLE — docs/ops/restore.md)
```

İlk üçü buradadır ve `pnpm backup:offdevice:verify` komutuyla tek adımda denetlenir. Dördüncüsü ayrı bir runbook'tur ([restore.md](restore.md)) ve **ayda bir** yapılır.

---

## PRECONDITIONS

| # | Koşul | Nasıl doğrulanır |
|---|---|---|
| 1 | Yerel PostgreSQL 16 ayakta | `& C:\MAS\pgsql16\bin\pg_isready.exe -h 127.0.0.1 -p 5432` ve `pnpm db:ensure` |
| 2 | Diskte yer var | `Get-PSDrive C \| Select-Object Used,Free` — **en az 2 GB boş** |
| 3 | Kabukta bayat bağlantı değişkeni yok | `pnpm db:env:source` → `gölgeleme yok` |
| 4 | (off-device için) harici disk/NAS takılı | [backup-schedule.md](backup-schedule.md) §1 |

> Diskte yer darlığı varsa yedek almadan önce [db-full.md](db-full.md) adımlarını izleyin.

---

## DATA CLASS

```text
TARGET DB NAME  : mas_radar_dev
TARGET DB CLASS : REAL_READ_ONLY
WRITE EXPECTED? : NO
```

Yedek alma gerçek veritabanına **tek bir satır yazmaz**. Yapılan iş yerel `pg_dump.exe --format=custom` ve kimlik/sürüm okuma sorgularıdır. Günlük çalışmada uygulamayı durdurmanız gerekmez — ancak cutover öncesi yedekte ([cutover.md](cutover.md) adım A) uygulama **durdurulmuş olmalıdır**.

---

## COMMANDS

### Yol A — günlük tam yedek (önerilen tek komut)

Dump + doküman kasası arşivi + Stage07 makbuzu + off-device kopya + saklama kuru koşusu, tek komutta:

```powershell
cd "C:\Users\Trade Bilisim\Mas Saas"
pnpm ops:backup:daily
```

Bu, Windows Görev Zamanlayıcı'daki `MAS-Nakit-Radar-Gunluk-Yedek` görevinin de çalıştırdığı iştir. Çıkış kodları:

| Kod | Anlamı | Ne yapmalı |
|---|---|---|
| 0 | Yedek + doğrulama + off-device kopya tamam | Bir şey yok |
| 1 | Yedek alınamadı / doğrulama düştü | **P0** — [incident.md](incident.md) |
| 3 | Yedek tamam ama off-device hedef yok/takılı değil | Harici diski takın ve `pnpm ops:backup:offdevice` koşturun |

### Yol B — cutover öncesi katı makbuzlu yedek (git kanıtı + küme kimliği eşleşmesi)

Bu yol, dump'ı **hangi kod sürümüyle ve hangi yerel PostgreSQL 16 kümesinden** aldığınızı kanıtlar. Temiz bir git ağacı ister.

```powershell
cd "C:\Users\Trade Bilisim\Mas Saas"

$u = [Uri]((Select-String -Path .env.local -Pattern '^MIGRATION_DATABASE_URL=' | Select-Object -First 1).Line -replace '^MIGRATION_DATABASE_URL=','').Trim().Trim('"')
$env:PGPASSWORD = [Uri]::UnescapeDataString(($u.UserInfo -split ':',2)[1])
try {
  $sysId = (& C:\MAS\pgsql16\bin\psql.exe -h 127.0.0.1 -p 5432 -U postgres -d mas_radar_dev -t -A -c "SET default_transaction_read_only = on; select system_identifier from pg_control_system();" | Select-Object -Last 1).Trim()
} finally {
  Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
}

$headSha = (git rev-parse HEAD).Trim()
$branch  = (git rev-parse --abbrev-ref HEAD).Trim()

$env:MIGRATION_DATABASE_URL = ((Select-String -Path .env.local -Pattern '^MIGRATION_DATABASE_URL=' |
  Select-Object -First 1).Line -replace '^MIGRATION_DATABASE_URL=','')

pnpm exec tsx scripts/db/backup-receipt.ts `
  --expected-database-name mas_radar_dev `
  --expected-system-identifier $sysId `
  --expected-git-branch $branch `
  --expected-git-head $headSha `
  --label cutover_A `
  --out-dir backups

Remove-Item Env:MIGRATION_DATABASE_URL -ErrorAction SilentlyContinue
```

### Off-device kopya (ayrı komut olarak)

```powershell
pnpm exec tsx scripts/ops/offdevice-copy.ts --dry-run   # önce ne yapacağını görün
pnpm ops:backup:offdevice                               # gerçekten kopyalar
```

Hedef `MAS_OFFDEVICE_BACKUP_DIR` ile tanımlanır (kurulum: [backup-schedule.md](backup-schedule.md) §1). Değişken tanımlı değilse araç **hiçbir şey yapmaz ve exit 2 ile durur**.

### En güncel yedeğin okunabilirliğini kanıtlayın (`pnpm backup:offdevice:verify`)

Dosya boyutuna gözle güvenmeyin. Bu salt-okunur komut hiçbir veritabanı bağlantısı açmadan en güncel `.dump` dosyasının boyutunu (`> 0`), yaşını (`<= 48 saat`), SHA-256 özetini ve yerel `pg_restore.exe --list` ile TOC okunabilirliğini doğrular:

```powershell
# Varsayılan doğrulama (MAS_OFFDEVICE_BACKUP_DIR takılı değilse açık uyarı vererek backups/ dizinini doğrular):
pnpm backup:offdevice:verify

# Yalnız fiziksel harici aygıt bağlıysa geçsin (cutover öncesi katı mod):
pnpm backup:offdevice:verify -- --strict-offdevice
```

Tek bir `.dump` dosyasını doğrudan `pg_restore.exe --list` ile saymak isterseniz:

```powershell
& C:\MAS\pgsql16\bin\pg_restore.exe --list "backups\<dump-adi>.dump" | Measure-Object -Line
```

### Aylık tam kapı (yedek + iki ayrı restore + uygulama açılışı)

```powershell
pnpm release:stage07-backup-gate
```

**Her cutover'dan önce zorunludur.** Kaynağa yalnız okuma uygular; kendi oluşturduğu iki harcanabilir veritabanını koşu sonunda düşürür.

---

## EXPECTED

```text
pnpm ops:backup:daily        ->  exit 0 (ya da off-device disk takılı değilse 3)
pnpm backup:offdevice:verify ->  BACKUP_VERIFY_STATUS = PASS (pg_restore --list > 1500 TOC girdisi)
dump boyutu                  ->  0'dan büyük; mas_radar_dev için tipik olarak 1.4 - 8 MB
makbuz dosyası               ->  <dump>.stage07.json ya da <dump>.receipt.json
koşu kaydı                   ->  backups/daily-runs.jsonl'e yeni satır
```

Yedek sonrası doğrulama (yalnız okuma) — kaynaktaki şema kanonik sürümde mi:

```powershell
$u = [Uri]((Select-String -Path .env.local -Pattern '^MIGRATION_DATABASE_URL=' | Select-Object -First 1).Line -replace '^MIGRATION_DATABASE_URL=','').Trim().Trim('"')
$env:PGPASSWORD = [Uri]::UnescapeDataString(($u.UserInfo -split ':',2)[1])
try {
  & C:\MAS\pgsql16\bin\psql.exe -h 127.0.0.1 -p 5432 -U postgres -d mas_radar_dev -t -A -c "SET default_transaction_read_only = on; select count(*), max(version) from public.schema_migrations;"
} finally {
  Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
}
```

**Beklenen:** `113|0113`.

---

## FAILURE SIGNALS

| Belirti | Anlamı | Ne yapılır |
|---|---|---|
| `pg_restore --list` hata veriyor / 0 girdi | **Dump bozuk** | Yedeği kullanmayın, yeniden alın. İkincisi de bozuksa **P0** |
| dump boyutu 0 bayt veya birkaç KB | Dump yarıda kesilmiş | Diskte yer var mı? [db-full.md](db-full.md) |
| `no space left on device` | Disk doldu | [db-full.md](db-full.md) |
| `ops:backup:daily` exit 3 | Off-device hedef yok veya harici disk takılı değil | Diski takın / `MAS_OFFDEVICE_BACKUP_DIR` güncelleyin |
| `Hedef sınıfı: LOCAL_STANDIN` | Hedef aynı fiziksel diskte | Off-device sayılmaz; ayrı fiziksel USB/NAS bağlayın |
| `system_identifier` eşleşmiyor | Yanlış PostgreSQL kümesi | **DURUN** — [incident.md](incident.md) |
| `pg_isready.exe` / bağlantı hatası | Yerel PostgreSQL 16 kapalı | [postgres-service.md](postgres-service.md) |

---

## STOP CONDITION

1. Aynı kaynaktan alınan **iki** dump da `pg_restore --list` ile okunamıyorsa → **P0**, durun.
2. `system_identifier` beklenen kümeyle eşleşmiyorsa → yanlış makineye/kümeye bakıyorsunuz.
3. Şema sürümü veya temel satır sayıları beklenenden düşükse → önce [incident.md](incident.md).
4. Cutover öncesi yedekte `pnpm release:stage07-backup-gate` düşerse → **cutover başlamaz.**

---

## ROLLBACK

Yedek almanın geri alınacak bir tarafı yoktur — kaynağa yazmaz.

Yanlış/bozuk bir dump ürettiyseniz: dosyayı **silmeyin**, yanına neden geçersiz olduğunu yazan bir not bırakın ve yeni bir yedek alın. Silme kararı yalnız saklama budamasıyla verilir ([db-full.md](db-full.md)). `mas_radar_dev`, `cutover_*` ve `stage*_real` adlarını taşıyan yedekler **IMMUTABLE**'dır ve budama bunlara asla dokunmaz.

---

## EVIDENCE

Her yedek için:

```text
tarih/saat                  :
komut                       : ops:backup:daily / backup-receipt.ts
dump yolu                   :
boyut (bayt)                :
backup:offdevice:verify     : PASS (... TOC girdisi)
off-device                  : OK / UNCONFIGURED / LOCAL_STANDIN
exit kodu                   :
```

Otomatik üretilen kayıtlar:

- `backups/daily-runs.jsonl` — her günlük koşu
- `<dump>.stage07.json` — dokuz alanlı makbuz
- `<dump>-documents.tar.gz` ve `<dump>-documents.manifest.json` — doküman kasası yedeği
- `<dump>.offdevice.json` — hedefte doğrulanmış kopya kaydı
- `docs/release-evidence/final-production-readiness/05-real-backup-restore.md` — aylık kapı çıktısı

---

## SECRET HANDLING

- `pg_dump.exe` çıktısı **gerçek finansal veri içerir**. `backups/` klasörü `.gitignore`'dadır ve asla commit edilmez, e-postayla gönderilmez, bulut sohbetine yüklenmez.
- Off-device hedef şirket dışındaysa (bulut/NAS) şifreleme ve erişim kaydı operatörün sorumluluğundadır.
- Parola hiçbir aracın komut satırı argümanına yazılmaz; yalnız süreç ortamından (`PGPASSWORD`) geçici olarak okunur.
