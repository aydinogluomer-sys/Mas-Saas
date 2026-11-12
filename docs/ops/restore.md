# RUNBOOK — restore (yedekten harcanabilir klona geri yükle)

> **Kime:** MAS operatörüne. Yazılım geliştirici olmanız gerekmez.
> **Çalışma dizini (her komut için):** `C:\Users\Trade Bilisim\Mas Saas`
> **Politika:** `docs/backup-restore-policy.md` · **Yedek alma:** [backup.md](backup.md)

---

## PURPOSE

Bir `.dump` dosyasını yerel PostgreSQL 16 araçlarıyla (`C:\MAS\pgsql16\bin\createdb.exe`, `pg_restore.exe`, `dropdb.exe`) **harcanabilir (disposable) bir hedefe** geri yükleyip verinin gerçekten kurtarılabilir olduğunu kanıtlamak.

Bu runbook'un kapsadığı tek senaryo budur. **Gerçek veritabanının üzerine geri yükleme (`mas_radar_dev`) bu runbook'ta YOKTUR.** O işlem bir felaket kurtarma kararıdır, ayrı bir onay gerektirir ve [cutover.md](cutover.md) → `"DB RESTORE"` kararı ile [incident.md](incident.md) üzerinden yürütülür.

İki kullanım vardır:

| Amaç | Sıklık | Yol |
|---|---|---|
| "Yedeğim geri yükleniyor mu?" tatbikatı | **Ayda bir** | Yol A (`pnpm release:restore-drill`) |
| "Şu eski kayda bakmam lazım" | İhtiyaç oldukça | Yol B (yerel `createdb.exe` + `pg_restore.exe`) |

---

## PRECONDITIONS

| # | Koşul | Nasıl doğrulanır |
|---|---|---|
| 1 | Yerel PostgreSQL 16 ayakta | `& C:\MAS\pgsql16\bin\pg_isready.exe -h 127.0.0.1 -p 5432` |
| 2 | Geri yüklenecek dump dosyası var ve **okunabilir** | `pnpm backup:offdevice:verify` → `PASS` |
| 3 | Hedef adı **harcanabilir** bir ad | aşağıdaki adlandırma kuralı |
| 4 | Diskte yer var | `Get-PSDrive C \| Select-Object Used,Free` |
| 5 | Kabukta bayat bağlantı değişkeni yok | `pnpm db:env:source` |

### Hedef adlandırma kuralı — atlanamaz

Araçlar, hedefin **adında** harcanabilir olduğunu söylemesini şart koşar. Kabul edilen işaretlerden en az biri geçmelidir:

```text
verify  test  tmp  temp  disposable  scratch  sandbox
fixture clone restore snapshot probe drill
```

Şu adlar **korunmuştur ve hiçbir koşulda hedef olarak verilemez:**

```text
mas_radar_dev   postgres   template0   template1
```

Önerilen ad kalıbı:

```text
mas_radar_restore_20261112
```

---

## DATA CLASS

```text
KAYNAK  DB NAME  : mas_radar_dev (yalnız dump dosyası üzerinden)
KAYNAK  DB CLASS : REAL_READ_ONLY
HEDEF   DB NAME  : mas_radar_restore_<tarih>
HEDEF   DB CLASS : DISPOSABLE_CLONE
WRITE EXPECTED?  : YES — YALNIZ harcanabilir hedefe. Gerçek veritabanına HAYIR.
```

---

## COMMANDS

### Yol A — tam tatbikat (yedek → restore → karşılaştırma → uygulama açılışı)

Bu kapı satır sayılarını ve parasal toplamları kaynakla karşılaştırır, sonra uygulamayı geri yüklenen kopyaya karşı izole portta başlatır:

```powershell
cd "C:\Users\Trade Bilisim\Mas Saas"

$env:SOURCE_DATABASE_URL = ((Select-String -Path .env.local -Pattern '^MIGRATION_DATABASE_URL=' |
  Select-Object -First 1).Line -replace '^MIGRATION_DATABASE_URL=','')
$env:RESTORE_DB = "mas_radar_restore_drill"
$env:SMOKE_PORT = "3290"
$env:MAS_NEXT_DIST_DIR = ".next-restore-drill"

pnpm release:restore-drill

Remove-Item Env:SOURCE_DATABASE_URL, Env:RESTORE_DB, Env:SMOKE_PORT, Env:MAS_NEXT_DIST_DIR -ErrorAction SilentlyContinue
```

**Neden `SMOKE_PORT` ve `MAS_NEXT_DIST_DIR` veriliyor:** canlı sunucu port 3000'i ve `.next` dizinini kullanır. Bu iki değişken canlı derlemenin ezilmesini engeller.

### Yol B — tek bir dump'ı yerel `pg_restore.exe` ile harcanabilir klona yükle

```powershell
cd "C:\Users\Trade Bilisim\Mas Saas"
$targetDb = "mas_radar_restore_20261112"
$dumpFile = "backups\<dump-adi>.dump"

if ($targetDb -in @('mas_radar_dev','postgres','template0','template1') -or $targetDb -notmatch 'restore|clone|drill|verify|test|tmp|sandbox') {
  throw "GÜVENLİK DURDURMASI: Hedef ad harcanabilir olmalı ($targetDb)."
}

$u = [Uri]((Select-String -Path .env.local -Pattern '^MIGRATION_DATABASE_URL=' | Select-Object -First 1).Line -replace '^MIGRATION_DATABASE_URL=','').Trim().Trim('"')
$env:PGPASSWORD = [Uri]::UnescapeDataString(($u.UserInfo -split ':',2)[1])
try {
  & C:\MAS\pgsql16\bin\createdb.exe -h 127.0.0.1 -p 5432 -U postgres $targetDb
  & C:\MAS\pgsql16\bin\pg_restore.exe -h 127.0.0.1 -p 5432 -U postgres -d $targetDb --no-owner --exit-on-error $dumpFile
} finally {
  Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
}
```

### Geri yüklenen kopyayı doğrulayın (kaynakla salt-okunur karşılaştırma)

```powershell
$u = [Uri]((Select-String -Path .env.local -Pattern '^MIGRATION_DATABASE_URL=' | Select-Object -First 1).Line -replace '^MIGRATION_DATABASE_URL=','').Trim().Trim('"')
$env:PGPASSWORD = [Uri]::UnescapeDataString(($u.UserInfo -split ':',2)[1])
try {
  Write-Host "--- HEDEF ($targetDb) ---"
  & C:\MAS\pgsql16\bin\psql.exe -h 127.0.0.1 -p 5432 -U postgres -d $targetDb -t -A -c "SET default_transaction_read_only = on; select count(*), max(version) from public.schema_migrations;" -c "select count(*) from public.payments;" -c "select count(*) from public.users;"

  Write-Host "--- KAYNAK (mas_radar_dev) ---"
  & C:\MAS\pgsql16\bin\psql.exe -h 127.0.0.1 -p 5432 -U postgres -d mas_radar_dev -t -A -c "SET default_transaction_read_only = on; select count(*), max(version) from public.schema_migrations;" -c "select count(*) from public.payments;" -c "select count(*) from public.users;"
} finally {
  Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
}
```

### Uygulamayı geri yüklenen kopyaya karşı açmak (isteğe bağlı, canlıyı bozmadan)

```powershell
$env:DATABASE_URL = ((Select-String -Path .env.local -Pattern '^DATABASE_URL=' |
  Select-Object -First 1).Line -replace '^DATABASE_URL=','') -replace 'mas_radar_dev','mas_radar_restore_20261112'
$env:PORT = "3290"
$env:MAS_NEXT_DIST_DIR = ".next-restore-drill"
pnpm start
```

### Tatbikattan sonra temizlik — harcanabilir hedefi düşürün

```powershell
$targetDb = "mas_radar_restore_20261112"
if ($targetDb -eq "mas_radar_dev") { throw "ASLA mas_radar_dev düşürülmez!" }

$u = [Uri]((Select-String -Path .env.local -Pattern '^MIGRATION_DATABASE_URL=' | Select-Object -First 1).Line -replace '^MIGRATION_DATABASE_URL=','').Trim().Trim('"')
$env:PGPASSWORD = [Uri]::UnescapeDataString(($u.UserInfo -split ':',2)[1])
try {
  & C:\MAS\pgsql16\bin\dropdb.exe -h 127.0.0.1 -p 5432 -U postgres $targetDb
  & C:\MAS\pgsql16\bin\psql.exe -h 127.0.0.1 -p 5432 -U postgres -d postgres -t -A -c "select datname from pg_database where datistemplate = false order by datname;"
} finally {
  Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
}
Remove-Item -Recurse -Force .next-restore-drill -ErrorAction SilentlyContinue
```

---

## EXPECTED

```text
pnpm release:restore-drill ->  BACKUP EXISTS / READABLE / RESTORABLE / DATA MATCHES / APP STARTS
                               beşi de YES; exit 0
hedef sayıları             ->  schema_migrations 113|0113 · payments & users kaynakla BİREBİR aynı
/health (3290 portunda)    ->  {"status":"ok","app":"up","db":"up",...}
```

> **Zamanlama tuzağı:** uygulama açılışı `prepare-runtime` üzerinden hedefe **yazar**. Bu yüzden sayı karşılaştırması uygulama başlatılmadan **ÖNCE** yapılır.

---

## FAILURE SIGNALS

| Belirti | Anlamı | Ne yapılır |
|---|---|---|
| `GÜVENLİK DURDURMASI: '<ad>' korunan bir veritabanı` | Hedef olarak gerçek DB verildi | **Doğru davranış.** Harcanabilir bir ad seçin |
| `'<ad>' disposable işaretlerinden hiçbirini taşımıyor` | Ad kuralı sağlanmadı | Adın içine `restore`/`clone`/`drill` ekleyin |
| `database "<ad>" already exists` | Aynı adla eski bir kopya var | Yeni bir tarih/ad seçin |
| `pg_restore: error: could not read from input file` | **Dump bozuk** | Başka bir yedeği deneyin; hepsi bozuksa **P0** |
| Satır sayıları kaynaktan **az** | Restore eksik | **P0** — [incident.md](incident.md) |
| `permission denied for table users` | Roller küme genelindedir | Yeni bir makineye taşıdıysanız önce rolleri oluşturup `pnpm db:migrate` uygulayın — [incident.md](incident.md) |
| `no space left on device` | Disk doldu | [db-full.md](db-full.md) |

---

## STOP CONDITION

1. Hedef adı harcanabilir değilse — araç zaten durur, **zorlamayın**.
2. Elinizdeki **son iki** yedek de geri yüklenemiyorsa → **P0**, hemen [incident.md](incident.md).
3. Geri yüklenen kopyanın satır sayıları kaynaktan **düşükse** → tatbikatı sonlandırın ve olayı kaydedin.
4. `mas_radar_dev` üzerine geri yükleme düşünüyorsanız → **DURUN.** Bu karar yalnız [cutover.md](cutover.md) → `"DB RESTORE"` ve kullanıcı onayıyla verilir.

---

## ROLLBACK

Bu runbook gerçek veritabanına dokunmadığı için "geri alma" yalnız harcanabilir hedefin `dropdb.exe` ile silinmesi ve `.next-restore-drill` klasörünün kaldırılmasıdır.

---

## EVIDENCE

```text
tarih/saat            :
kullanılan dump       :
hedef veritabanı      :  (harcanabilir ad)
BACKUP EXISTS         :
BACKUP READABLE       :
BACKUP RESTORABLE     :
DATA MATCHES          :  kaynak 113/0113 = hedef 113/0113
APP STARTS            :
exit kodu             :
hedef düşürüldü mü    :  EVET/HAYIR
```

Otomatik üretilen kanıt:

- `docs/release-evidence/final-production-readiness/05-real-backup-restore.md`

---

## SECRET HANDLING

- Dump dosyası ve geri yüklenen klon **gerçek finansal veri içerir** — tatbikat bittiğinde klonu mutlaka düşürün.
- Hiçbir komutta bağlantı dizesi veya parola elle yazılmaz; parola yalnız geçici `PGPASSWORD` süreç ortamında tutulur ve `finally` bloğunda silinir.
- `pnpm db:app-role:password` bu runbook'ta **çağrılmaz**: roller küme genelindedir ve canlı uygulamanın parolasını da değiştirir ([password-rotation.md](password-rotation.md)).
