# RUNBOOK — incident (olay: kanıt topla, karar ver)

> **Kime:** MAS operatörüne. Yazılım geliştirici olmanız gerekmez.
> **Çalışma dizini (her komut için):** `C:\Users\Trade Bilisim\Mas Saas`
> **Yaşanmış arıza biçimleri ve çıkış yolları:** [incident-recovery-notes.md](incident-recovery-notes.md)

---

## PURPOSE

Bir şeyler ters gittiğinde **önce kanıt toplamak**, sonra karar vermek.

Panikle atılan bir düzeltme adımı (en sık: `git checkout`, veri dizinini silme, veritabanı düşürme) çoğu zaman olayın kendisinden daha büyük zarar verir ve **kanıtı yok eder**.

### Altın kural

```text
1. DUR    — düzeltmeye çalışma
2. TOPLA  — aşağıdaki salt-okunur komutları sırayla çalıştır, çıktıları kaydet
3. KARAR  — beş karardan birini ver
4. UYGULA — ilgili runbook'a git
```

---

## PRECONDITIONS

Yok. Bu runbook her koşulda çalıştırılabilir; komutların tamamı **yalnız okumadır**.

---

## DATA CLASS

```text
TARGET DB NAME  : mas_radar_dev
TARGET DB CLASS : REAL_READ_ONLY
WRITE EXPECTED? : NO
```

---

## COMMANDS

Sırayla çalıştırın. Her komutun çıktısını, çalışmasa bile, kopyalayıp saklayın.

### 1) Zaman ve kod sürümü

```powershell
cd "C:\Users\Trade Bilisim\Mas Saas"
Get-Date -Format "yyyy-MM-dd HH:mm:ss K"
git rev-parse HEAD
git rev-parse --abbrev-ref HEAD
git status --porcelain
```

### 2) Süreçler, Windows hizmetleri ve zamanlanmış görevler

```powershell
Get-NetTCPConnection -LocalPort 3000, 5432 -State Listen -ErrorAction SilentlyContinue |
  Select-Object LocalAddress, LocalPort, OwningProcess

Get-Service MAS-PostgreSQL16, postgresql-x64-16 -ErrorAction SilentlyContinue |
  Select-Object Name, Status, StartType

Get-ScheduledTask -TaskName "MAS-Background-Worker", "MAS-Nakit-Radar-Gunluk-Yedek", "MAS-Nakit-Radar-Telemetri-Gozetim", "MAS-PostgreSQL16-Oturum-Baslat" -ErrorAction SilentlyContinue |
  Select-Object TaskName, State
```

### 3) Uygulama sağlığı

```powershell
curl.exe -s -m 5 http://127.0.0.1:3000/health
curl.exe -s -m 5 http://127.0.0.1:3000/ready
curl.exe -s -m 5 http://127.0.0.1:3000/version
```

### 4) Ortam hijyeni — en sık yanlış teşhis edilen nokta

```powershell
pnpm db:env:source
```

### 5) Yerel PostgreSQL 16 kimliği ve katalog büyüklükleri (yalnız okuma)

```powershell
& C:\MAS\pgsql16\bin\pg_isready.exe -h 127.0.0.1 -p 5432

$u = [Uri]((Select-String -Path .env.local -Pattern '^MIGRATION_DATABASE_URL=' | Select-Object -First 1).Line -replace '^MIGRATION_DATABASE_URL=','').Trim().Trim('"')
$env:PGPASSWORD = [Uri]::UnescapeDataString(($u.UserInfo -split ':',2)[1])
try {
  & C:\MAS\pgsql16\bin\psql.exe -h 127.0.0.1 -p 5432 -U postgres -d mas_radar_dev -t -A -c "SET default_transaction_read_only = on; select current_database(), current_user;" -c "SET default_transaction_read_only = on; select count(*), max(version) from public.schema_migrations;" -c "SET default_transaction_read_only = on; select count(*) from public.payments;" -c "SET default_transaction_read_only = on; select count(*) from public.users;"
  & C:\MAS\pgsql16\bin\psql.exe -h 127.0.0.1 -p 5432 -U postgres -d postgres -c "SET default_transaction_read_only = on; select datname, pg_size_pretty(pg_database_size(datname)) from pg_database where datistemplate = false order by pg_database_size(datname) desc limit 10;"
} finally {
  Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
}
```

### 6) Çalışma zamanı kimliği kapısı

```powershell
$env:DATABASE_URL = ((Select-String -Path .env.local -Pattern '^DATABASE_URL=' |
  Select-Object -First 1).Line -replace '^DATABASE_URL=','')
pnpm db:roles:verify
Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue
```

### 7) Telemetri anlık görüntüsü ve en güncel yedek doğrulaması

```powershell
pnpm ops:telemetry
pnpm backup:offdevice:verify
```

### 8) Disk alanı

```powershell
Get-PSDrive C | Select-Object Used, Free
```

### 9) Kayıt dosyaları ve PostgreSQL olay günlüğü

```powershell
Get-Content logs\alerts.jsonl -Tail 20 -ErrorAction SilentlyContinue
Get-Content logs\telemetry-runs.jsonl -Tail 5 -ErrorAction SilentlyContinue
Get-Content backups\daily-runs.jsonl -Tail 5 -ErrorAction SilentlyContinue
Get-EventLog -LogName Application -Source PostgreSQL -Newest 20 -ErrorAction SilentlyContinue
```

### 10) Migration dizini bütünlüğü

```powershell
(Get-ChildItem supabase\migrations\*.sql).Count
(Get-ChildItem supabase\migrations\ | Where-Object { $_.Name -like "*hidden-for*" }).Count
git status --porcelain supabase/migrations/
```

---

## EXPECTED

Sağlıklı bir sistemde:

```text
/health                       ->  {"status":"ok","app":"up","db":"up",...}
/ready                        ->  {"status":"ready",...}
pnpm db:env:source            ->  ENV SOURCE: gölgeleme yok.
roles:verify ilk satır        ->  Hedef: db=mas_radar_dev user=mas_radar_app
roles:verify son satır        ->  8/8 kontrol geçti.
schema_migrations             ->  113|0113
pnpm ops:telemetry            ->  TELEMETRY: ALL CLEAR
pnpm backup:offdevice:verify  ->  BACKUP_VERIFY_STATUS = PASS
migrations *.sql sayısı       ->  113
*hidden-for* sayısı           ->  0
git status supabase/migrations->  boş
port 3000 dinleyici           ->  tam olarak 1 (uygulama çalışıyorsa)
```

---

## FAILURE SIGNALS

| Belirti | Muhtemel yer | Gidilecek runbook |
|---|---|---|
| `/health` → `"db":"down"` veya `pg_isready.exe` yanıt vermiyor | Yerel PostgreSQL 16 hizmeti kapalı | [postgres-service.md](postgres-service.md) |
| `ENV SOURCE: GÖLGELEME` | Kabukta bayat `DATABASE_URL` / `MIGRATION_DATABASE_URL` | Yeni PowerShell penceresi açın |
| `git status` silinmiş migration gösteriyor (`*hidden-for*`) | Yarıda kesilen `legacy-repair:verify` (`OPS-01`) | [failed-migration.md](failed-migration.md) |
| `permission denied` veya `column does not exist` | Kod/şema eşleşmezliği | [failed-migration.md](failed-migration.md) |
| `no space left on device` | Disk doluluğu | [db-full.md](db-full.md) |
| Port 3000'de **iki** dinleyici | Çift sunucu | [stop.md](stop.md) |
| `backup_age_hours` uyarısı veya `BACKUP_VERIFY_STATUS = FAIL` | Yedek alınmıyor / bozuk | [backup.md](backup.md) |
| `jobs_stuck > 0` veya `MAS-Background-Worker` çalışmıyor | Arka plan işçisi durmuş | `pnpm ops:worker:once` / `pnpm ops:worker:schedule status` |
| `auth_locked_accounts > 0` | Hesap kilitli | [role-change.md](role-change.md) |
| Beklenmedik kullanıcı / yetki olayı | Güvenlik olayı | [role-change.md](role-change.md) + [password-rotation.md](password-rotation.md) |

---

## STOP CONDITION

Aşağıdakilerden biri varsa **hiçbir düzeltme yapmayın**; kanıtı toplayıp durun ve durumu sahibine bildirin (**ESCALATE**):

1. Finansal satır sayıları beklenenden **düşük** ve sebebi bilinmiyor.
2. Kimlik satırı beklenen veritabanını (`mas_radar_dev`) göstermiyor.
3. `system_identifier` beklenen yerel kümeyle eşleşmiyor.
4. Elinizdeki **son iki** yedek de `pg_restore.exe --list` ile okunamıyor.
5. `supabase/migrations/` kirli ve `*hidden-for*` dosyalar var — **commit almayın.**
6. Yetkisiz erişim şüphesi var.

---

## ROLLBACK

Kanıt toplandıktan sonra **beş karardan biri** verilir:

| Karar | Ne zaman | Nereye gidilir |
|---|---|---|
| **STOP** | Veri bütünlüğü şüpheli, sebep bilinmiyor | Hiçbir şey yapma, sahibine bildir |
| **RETRY** | Geçici arıza (kilit, zaman aşımı, kapalı PostgreSQL hizmeti) | [postgres-service.md](postgres-service.md), [start.md](start.md) |
| **CONFIG ROLLBACK** | Şema sağlam, sorun ayar/rol/ortamda | [cutover.md](cutover.md) → `"CONFIG ROLLBACK"` |
| **DB RESTORE** | Şema/veri bütünlüğü gerçekten bozuk | [restore.md](restore.md) + [cutover.md](cutover.md) → `"DB RESTORE"` |
| **ESCALATE** | Yukarıdaki STOP koşullarından biri | Kanıt paketini teslim et |

**Ayar sorunu için veritabanı geri yüklenmez.**

---

## EVIDENCE

Olayı [incident-recovery-notes.md](incident-recovery-notes.md) altına yeni bir başlık olarak ekleyin:

```text
## OLAY <sıra no> — <tek cümlelik belirti>

sınıf (P0/P1/P2)    :
ilk gözlem (tarih)  :
gözlemleyen         :

TOPLANAN KANIT
  git HEAD / branch :
  git status        :
  port 3000 / 5432  :
  Windows hizmetleri: MAS-PostgreSQL16 / MAS-Background-Worker
  /health /ready    :
  db:env:source     :
  kimlik satırı     : Hedef: db=mas_radar_dev user=mas_radar_app
  ledger            : 113|0113
  telemetri         :
  backup:verify     : PASS / FAIL
  disk (C: boş)     :
  migrations sayımı : *.sql=113  hidden-for=0

VERİLEN KARAR       : STOP / RETRY / CONFIG ROLLBACK / DB RESTORE / ESCALATE
```

---

## SECRET HANDLING

- Kanıt paketine **bağlantı dizesi, parola, token yapıştırılmaz.**
- Bir sır kazayla ekrana geldiyse olay **yetki olayına** dönüşür: [password-rotation.md](password-rotation.md).
