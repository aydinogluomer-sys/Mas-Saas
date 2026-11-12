# RUNBOOK — db full (disk doldu / veritabanı yer sıkıntısı)

> **Kime:** MAS operatörüne. Yazılım geliştirici olmanız gerekmez.
> **Çalışma dizini (her komut için):** `C:\Users\Trade Bilisim\Mas Saas`
> **Saklama politikası:** `docs/backup-restore-policy.md`

---

## PURPOSE

Disk dolduğunda ya da dolmaya yaklaştığında **veri kaybetmeden** yer açmak.

Yerel PostgreSQL 16 kümesi (`C:\MAS\pgdata16`) ve yedek dizini (`backups/`) doğrudan Windows diski (`C:`) üzerinde yaşar. Darlık çoğu zaman `mas_radar_dev` veritabanının kendisinden değil, **artakalan doğrulama klonlarından, eski budanmamış `.dump` dosyalarından veya geçici `.next-*` derleme klasörlerinden** kaynaklanır. Yer açarken önce artıklara bakılır; gerçek veritabanına en son dokunulur.

---

## PRECONDITIONS

| # | Koşul | Nasıl doğrulanır |
|---|---|---|
| 1 | Sorunun gerçekten disk olduğu ölçüldü | aşağıdaki 1. adım |
| 2 | Neyin silineceği **okundu** (kuru koşu) | `pnpm ops:backup:prune` |
| 3 | En az bir geçerli yedek elde ve okunabilir | `pnpm backup:offdevice:verify` ([backup.md](backup.md)) |

---

## DATA CLASS

```text
TARGET DB NAME  : mas_radar_dev
TARGET DB CLASS : REAL_READ_ONLY
WRITE EXPECTED? : NO — gerçek veritabanına yazılmaz; silinen şeyler yalnız eski .dump dosyaları,
                  geçici .next-* klasörleri ve HARCANABİLİR klon veritabanlarıdır.
```

---

## COMMANDS

### 1) Ölçün — doluluk nereden geliyor

```powershell
cd "C:\Users\Trade Bilisim\Mas Saas"

Get-PSDrive C | Select-Object Used, Free
(Get-ChildItem backups -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum / 1MB
(Get-ChildItem backups -File -ErrorAction SilentlyContinue).Count

$u = [Uri]((Select-String -Path .env.local -Pattern '^MIGRATION_DATABASE_URL=' | Select-Object -First 1).Line -replace '^MIGRATION_DATABASE_URL=','').Trim().Trim('"')
$env:PGPASSWORD = [Uri]::UnescapeDataString(($u.UserInfo -split ':',2)[1])
try {
  & C:\MAS\pgsql16\bin\psql.exe -h 127.0.0.1 -p 5432 -U postgres -d postgres -c "SET default_transaction_read_only = on; select datname, pg_size_pretty(pg_database_size(datname)) from pg_database where datistemplate = false order by pg_database_size(datname) desc;"
} finally {
  Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
}
```

### 2) Yer açma — güvenli sıra

#### Adım A — artık klon veritabanlarını düşürün (en güvenli, en hızlı kazanç)

Doğrulama koşuları zaman zaman harcanabilir klonlar bırakabilir. `mas_radar_dev`, `postgres`, `template0`, `template1` **ASLA düşürülmez**; yalnızca adında `verify`, `clone`, `restore`, `drill`, `probe`, `test`, `sandbox`, `tmp` geçen harcanabilir veritabanları düşürülür.

```powershell
$u = [Uri]((Select-String -Path .env.local -Pattern '^MIGRATION_DATABASE_URL=' | Select-Object -First 1).Line -replace '^MIGRATION_DATABASE_URL=','').Trim().Trim('"')
$env:PGPASSWORD = [Uri]::UnescapeDataString(($u.UserInfo -split ':',2)[1])
try {
  # ÖNCE listeyi okuyun:
  & C:\MAS\pgsql16\bin\psql.exe -h 127.0.0.1 -p 5432 -U postgres -d postgres -c "SET default_transaction_read_only = on; select datname, pg_size_pretty(pg_database_size(datname)) from pg_database where datname not in ('postgres','template0','template1','mas_radar_dev') order by pg_database_size(datname) desc;"

  # Sonra TEK TEK düşürün — adı gözünüzle okuyarak yazın:
  # & C:\MAS\pgsql16\bin\dropdb.exe -h 127.0.0.1 -p 5432 -U postgres mas_radar_perf_verify
} finally {
  Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
}
```

> Her `dropdb.exe` komutunu ayrı ayrı, adı gözünüzle okuyarak çalıştırın. Toplu/otomatik silme yapmayın.

#### Adım B — eski yedekleri politikayla budayın

Önce **ne silineceğini okuyun** — bu adım atlanmaz:

```powershell
pnpm ops:backup:prune
pnpm exec tsx scripts/ops/backup-prune.ts --verbose
```

Politika: **günlük 7 · haftalık 4 · aylık 3**, 24 saatten genç hiçbir dosyaya dokunulmaz.

**IMMUTABLE (hiçbir koşulda silinmez):** adında `mas_radar_dev` geçen dump'lar, `cutover_*`, `stage<N>_real*` ve yanında `<dump>.immutable` işaret dosyası olanlar.

Okuduktan sonra uygulayın:

```powershell
pnpm exec tsx scripts/ops/backup-prune.ts --apply
```

Bir yedeği kalıcı korumak isterseniz:

```powershell
"2026 yil sonu kapanis" | Out-File -Encoding utf8 "backups\<dump-adi>.dump.immutable"
```

#### Adım C — geçici derleme dizinlerini temizleyin

```powershell
Get-ChildItem -Directory -Filter ".next-*" | Select-Object Name, FullName
Remove-Item -Recurse -Force .next-restore-drill -ErrorAction SilentlyContinue
```

> Canlı sunucunun kullandığı `.next` dizinini sunucu açıkken **silmeyin**.

#### Adım D — PostgreSQL tarafında ölü alan analizi (`VACUUM ANALYZE`, yalnız gerekiyorsa)

Bu adım nadiren gerekir ve **uygulama durdurulmuşken** yapılır ([stop.md](stop.md)).

```powershell
$u = [Uri]((Select-String -Path .env.local -Pattern '^MIGRATION_DATABASE_URL=' | Select-Object -First 1).Line -replace '^MIGRATION_DATABASE_URL=','').Trim().Trim('"')
$env:PGPASSWORD = [Uri]::UnescapeDataString(($u.UserInfo -split ':',2)[1])
try {
  & C:\MAS\pgsql16\bin\psql.exe -h 127.0.0.1 -p 5432 -U postgres -d mas_radar_dev -c "vacuum (verbose, analyze);"
} finally {
  Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
}
```

`vacuum full` **bu runbook'ta yoktur**: tabloyu kilitler ve geçici olarak iki katı disk alanı ister.

### 3) Tekrar ölçün ve veri bütünlüğünü doğrulayın

```powershell
Get-PSDrive C | Select-Object Used, Free
pnpm backup:offdevice:verify

$u = [Uri]((Select-String -Path .env.local -Pattern '^MIGRATION_DATABASE_URL=' | Select-Object -First 1).Line -replace '^MIGRATION_DATABASE_URL=','').Trim().Trim('"')
$env:PGPASSWORD = [Uri]::UnescapeDataString(($u.UserInfo -split ':',2)[1])
try {
  & C:\MAS\pgsql16\bin\psql.exe -h 127.0.0.1 -p 5432 -U postgres -d mas_radar_dev -t -A -c "SET default_transaction_read_only = on; select count(*), max(version) from public.schema_migrations;" -c "select count(*) from public.payments;" -c "select count(*) from public.users;"
} finally {
  Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
}
```

---

## EXPECTED

```text
prune kuru koşu       ->  "Budanacak: n (x MB)" + "KURU KOŞU — hiçbir dosya silinmedi."
prune --apply         ->  aynı sayı kadar dosya silindi, IMMUTABLE sayısı DEĞİŞMEDİ
C: boş alan           ->  işlemden sonra ARTMIŞ olmalı
schema_migrations     ->  113|0113 (DEĞİŞMEMİŞ olmalı)
```

---

## FAILURE SIGNALS

| Belirti | Anlamı | Ne yapılır |
|---|---|---|
| `could not extend file ... No space left on device` | PostgreSQL yazamıyor | Uygulamayı durdurun ([stop.md](stop.md)), Adım A + B + C'yi hemen uygulayın |
| `PANIC: could not write to file` | Kritik disk doluluğu | Uygulamayı durdurun, yer açın, ardından [postgres-service.md](postgres-service.md) ile hizmeti başlatın |
| `dropdb: database "..." is being accessed by other users` | Açık bağlantı var | Klonu kullanan doğrulama betiğini durdurun, tekrar deneyin |
| `dropdb` `mas_radar_dev` için denendi | **YANLIŞ HEDEF** | **DURDURUN.** O veritabanı asla düşürülmez |
| `--apply` sonrası IMMUTABLE sayısı değişti | Beklenmedik davranış | **DURUN** — [incident.md](incident.md) |

---

## STOP CONDITION

1. `mas_radar_dev` üzerinde `dropdb` / `truncate` / `delete` düşünüyorsanız → **DURUN.** Bu runbook o işlemleri içermez ve içermeyecektir.
2. Geçerli bir yedeğiniz yokken silme yapacaksanız → önce [backup.md](backup.md).
3. `--apply` sonrası veritabanı satır sayıları değiştiyse → **P0**, [incident.md](incident.md).

---

## ROLLBACK

**Silme geri alınamaz.** Koruma bu yüzden silme öncesine konmuştur:

- Budama varsayılan olarak kuru koşudur; `--apply` olmadan hiçbir dosya silinmez.
- IMMUTABLE sınıfı iki kez kontrol edilir.
- Harcanabilir klonlar tek tek, adı okunarak düşürülür.

Yanlışlıkla bir yedek silindiyse harici yedek dizinine (`MAS_OFFDEVICE_BACKUP_DIR`, [backup-schedule.md](backup-schedule.md)) bakın ve hemen yeni bir yedek alın ([backup.md](backup.md)).

---

## EVIDENCE

```text
tarih/saat            :
tetikleyen belirti    :
C: boş (önce / sonra) :
backups sayısı/boyut  :
uygulanan adımlar     :  A / B / C / D
düşürülen klonlar     :  (adları)
prune --apply         :  silinen n dosya, IMMUTABLE korundu
schema_migrations     :  113|0113
```

---

## SECRET HANDLING

- Dump dosyaları **gerçek finansal veri** içerir; yer açmak için masaüstüne, `Downloads`'a ya da paylaşılan korumasız bir klasöre taşımayın.
- `PGPASSWORD` yalnız geçici `try/finally` bloğunda tutulur ve ekrana basılmaz.
