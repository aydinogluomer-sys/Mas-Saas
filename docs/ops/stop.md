# RUNBOOK — stop (uygulamayı ve isteğe bağlı veritabanı hizmetini durdur)

> **Kime:** MAS operatörüne. Yazılım geliştirici olmanız gerekmez.
> **Çalışma dizini (her komut için):** `C:\Users\Trade Bilisim\Mas Saas`

---

## PURPOSE

Uygulamayı **kontrollü** biçimde durdurmak ve gerçekten durduğunu kanıtlamak.

İki farklı "durdurma" vardır ve karıştırılmamalıdır:

| Ne durur | Ne olur | Ne zaman |
|---|---|---|
| **Yalnız uygulama** (`pnpm start` / `start-standalone.ts`) | Ekranlar kapanır, PostgreSQL 16 ayakta kalır | Günlük durdurma, migration veya cutover adım B öncesi |
| **Uygulama + Arka Plan İşçisi + PostgreSQL 16** | Zamanlanmış işçi askıya alınır, veritabanı hizmeti kapanır (veri `C:\MAS\pgdata16` içinde korunur) | Makine bakımı, tam sistem kapatma |

**Veri hiçbir durumda silinmez.** `C:\MAS\pgdata16` dizinine asla elle dokunulmaz ([postgres-service.md](postgres-service.md)).

---

## PRECONDITIONS

| # | Koşul | Neden |
|---|---|---|
| 1 | Uygulamada devam eden bir içe aktarım / rapor / Paraşüt eşitlemesi yok | Yarıda kesilen iş `jobs` kuyruğunda `running` kalır |
| 2 | Durduracağınız sürecin **hangi süreç** olduğunu biliyorsunuz | Bu makinede başka Node süreçleri de çalışabilir |

**`Stop-Process -Name node` gibi toplu bir komut asla kullanılmaz** — başka bir süreci veya devam eden bir yedekleme betiğini öldürebilir.

---

## DATA CLASS

```text
TARGET DB NAME  : mas_radar_dev
TARGET DB CLASS : REAL_READ_ONLY
WRITE EXPECTED? : NO
```

Durdurma veritabanına yazmaz. Yalnız açık bağlantılar kapanır.

---

## COMMANDS

### Yol 1 — sunucu kendi penceresindeyse (tercih edilen)

`pnpm start` komutunu çalıştırdığınız terminale gidin ve **Ctrl-C** yapın.

### Yol 2 — pencere kayıpsa: süreci kimliğiyle bulun ve yalnız onu durdurun

```powershell
cd "C:\Users\Trade Bilisim\Mas Saas"

# 1) Port 3000'i dinleyen sürecin numarası
$pid3000 = (Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue |
  Select-Object -First 1).OwningProcess
$pid3000

# 2) DOĞRULAYIN: bu gerçekten MAS Nakit Radar sunucusu mu?
Get-CimInstance Win32_Process -Filter "ProcessId = $pid3000" |
  Select-Object ProcessId, Name, CommandLine | Format-List
```

Komut satırında **`Mas Saas`** ile **`start-standalone.ts`** veya **`next`** kelimelerini görmelisiniz. Görmüyorsanız **DURUN** — o süreç başka bir uygulamaya aittir.

```powershell
# 3) Yalnız o süreci durdur
Stop-Process -Id $pid3000
```

### Yol 3 — bakım penceresinde arka plan işçisini ve PostgreSQL 16 hizmetini de durdurmak

Cutover veya şema bakımı sırasında arka plan işçisinin yeni bağlantı açmaması için önce görevi geçici olarak devre dışı bırakabilir, ardından gerekirse PostgreSQL hizmetini durdurabilirsiniz (yönetici PowerShell):

```powershell
# 1) Arka plan işçisini bakım süresince duraklat (isteğe bağlı, cutover adım B için önerilir)
Disable-ScheduledTask -TaskName "MAS-Background-Worker" -ErrorAction SilentlyContinue

# 2) PostgreSQL 16 hizmetini durdur (yalnız tam makine bakımı için; migration yapacaksanız açık bırakın!)
Stop-Service MAS-PostgreSQL16 -ErrorAction SilentlyContinue
# Standart EDB hizmet adı kullanılıyorsa:
# Stop-Service postgresql-x64-16 -ErrorAction SilentlyContinue
```

> Bakım bittiğinde `Enable-ScheduledTask -TaskName "MAS-Background-Worker"` ile işçiyi yeniden etkinleştirmeyi unutmayın.

---

## EXPECTED

```powershell
# Uygulama gerçekten durdu mu?
curl.exe -s -o NUL -w "%{http_code}`n" http://127.0.0.1:3000/ready
```

- **Beklenen:** bağlantı kurulamıyor (`000`). Yani cevap **yok**.
- `200` dönüyorsa sunucu hâlâ ayakta demektir.

```powershell
# Port serbest mi?
Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
```

- **Beklenen:** çıktı yok.

Veritabanı tarafında açık bağlantı kalmadığının kanıtı (cutover / şema geçişi öncesi zorunlu, yalnız okuma):

```powershell
$u = [Uri]((Select-String -Path .env.local -Pattern '^MIGRATION_DATABASE_URL=' | Select-Object -First 1).Line -replace '^MIGRATION_DATABASE_URL=','').Trim().Trim('"')
$env:PGPASSWORD = [Uri]::UnescapeDataString(($u.UserInfo -split ':',2)[1])
try {
  & C:\MAS\pgsql16\bin\psql.exe -h 127.0.0.1 -p 5432 -U postgres -d mas_radar_dev -t -A -c "SET default_transaction_read_only = on; select count(*) from pg_stat_activity where datname='mas_radar_dev' and pid <> pg_backend_pid();"
} finally {
  Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
}
```

- **Beklenen:** `0` (son satır).

PostgreSQL 16 hizmetini de durdurduysanız:

```powershell
Get-Service MAS-PostgreSQL16, postgresql-x64-16 -ErrorAction SilentlyContinue | Select-Object Name, Status
```

- **Beklenen:** `Stopped`.

---

## FAILURE SIGNALS

| Belirti | Anlamı | Ne yapılır |
|---|---|---|
| Ctrl-C sonrası `/ready` hâlâ 200 | Süreç ölmedi ya da ikinci bir sunucu var | Yol 2 ile PID bulun; dinleyiciyi doğrulayıp durdurun |
| `Get-NetTCPConnection` boş ama `/health` cevap veriyor | Farklı bir portta ikinci örnek | `Get-NetTCPConnection -State Listen \| Where-Object {$_.LocalPort -in 3000..3300}` |
| `Stop-Process` "Erişim reddedildi" | Süreç yönetici hesabıyla başlatılmış | PowerShell'i yönetici olarak açın; komut satırını **tekrar doğrulayın** |
| `pg_stat_activity` sayısı 0'a inmiyor | Açık bir oturum ya da çalışan `MAS-Background-Worker` var | Kimin bağlı olduğunu görün (aşağıda) ve istemciyi kapatın |
| `Stop-Service MAS-PostgreSQL16` takılıyor | Uzun süren bir sorgu açık | [postgres-service.md](postgres-service.md) |

Kimin bağlı olduğunu görmek (yalnız okuma):

```powershell
$u = [Uri]((Select-String -Path .env.local -Pattern '^MIGRATION_DATABASE_URL=' | Select-Object -First 1).Line -replace '^MIGRATION_DATABASE_URL=','').Trim().Trim('"')
$env:PGPASSWORD = [Uri]::UnescapeDataString(($u.UserInfo -split ':',2)[1])
try {
  & C:\MAS\pgsql16\bin\psql.exe -h 127.0.0.1 -p 5432 -U postgres -d mas_radar_dev -c "SET default_transaction_read_only = on; select pid, usename, application_name, state from pg_stat_activity where datname='mas_radar_dev' and pid <> pg_backend_pid();"
} finally {
  Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
}
```

> Bağlantıyı zorla kesen `pg_terminate_backend` bu runbook'un kapsamında **değildir**. Devam eden bir yazma işlemini kesmek veri tutarlılığı riski taşır; o karar [incident.md](incident.md) üzerinden verilir.

---

## STOP CONDITION

1. Durduracağınız sürecin komut satırında `start-standalone.ts` veya `next` yazmıyorsa → **durdurmayın**.
2. Port 3000'de **birden fazla** dinleyici varsa → durdurmadan önce [incident.md](incident.md) ile kayda geçirin.
3. Uygulamada bir içe aktarım veya ödeme paketi ihracı sürüyorsa → bitmesini bekleyin.

---

## ROLLBACK

Durdurmanın geri alınması yeniden başlatmaktır: [start.md](start.md) (ve devre dışı bırakıldıysa `Enable-ScheduledTask -TaskName "MAS-Background-Worker"`).

Yarıda kesilen bir arka plan işi kaldıysa, yeniden başlattıktan sonra kontrol edin:

```powershell
pnpm ops:telemetry
```

`jobs_stuck` satırı `0` olmalıdır. Değilse `pnpm ops:worker:once` çalıştırın veya [incident.md](incident.md) adımlarını izleyin.

---

## EVIDENCE

```text
tarih/saat            :
durdurma yolu         : Ctrl-C / PID / Stop-Service MAS-PostgreSQL16
durdurulan PID        :
komut satırı doğrulandı mı : EVET/HAYIR
/ready cevabı         : 000 (bağlantı yok bekleniyor)
açık DB bağlantısı    : 0
```

---

## SECRET HANDLING

- Bu runbook hiçbir sırrı ekrana veya günlüğe yazmaz.
- `PGPASSWORD` yalnız geçici `try/finally` bloğunda tutulur ve anında temizlenir.
- Süreç komut satırında (`CommandLine`) parola görürseniz bu bir güvenlik bulgusudur — [password-rotation.md](password-rotation.md).
