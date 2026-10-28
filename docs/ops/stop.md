# RUNBOOK — stop (uygulamayı durdur)

> **Kime:** MAS operatörüne. Yazılım geliştirici olmanız gerekmez.
> **Çalışma dizini (her komut için):** `C:\Users\Trade Bilisim\Mas Saas`

---

## PURPOSE

Uygulamayı **kontrollü** biçimde durdurmak ve gerçekten durduğunu kanıtlamak.

İki farklı "durdurma" vardır ve karıştırılmamalıdır:

| Ne durur | Ne olur | Ne zaman |
|---|---|---|
| **Yalnız uygulama** (`next start`) | Ekranlar kapanır, veritabanı ayakta kalır | Günlük durdurma, yedek öncesi, cutover adım B |
| **Uygulama + PostgreSQL** | Veritabanı da kapanır (veri korunur) | Makineyi kapatırken, bakım |

**Veri hiçbir durumda silinmez.** Veriyi silen tek komut `docker compose down -v`'dir ve bu
runbook'ta yer almaz; asla çalıştırmayın.

---

## PRECONDITIONS

| # | Koşul | Neden |
|---|---|---|
| 1 | Uygulamada devam eden bir içe aktarım / rapor üretimi yok | Yarıda kesilen iş `jobs` kuyruğunda `running` kalır |
| 2 | Durduracağınız sürecin **hangi süreç** olduğunu biliyorsunuz | Bu makinede başka node süreçleri de var |

İkinci koşul ciddidir: bu makinede MAS dışındaki projelere ait node/vite süreçleri de
çalışıyor. **`Stop-Process -Name node` gibi toplu bir komut asla kullanılmaz** — başka birinin
işini öldürür.

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

# 2) DOĞRULAYIN: bu gerçekten MAS'ın Next sunucusu mu?
Get-CimInstance Win32_Process -Filter "ProcessId = $pid3000" |
  Select-Object ProcessId, Name, CommandLine | Format-List
```

Komut satırında **`next` ve `start`** kelimelerini görmelisiniz. Görmüyorsanız **DURUN** — o
süreç başka bir uygulamaya aittir.

```powershell
# 3) Yalnız o süreci durdur
Stop-Process -Id $pid3000
```

### Yol 3 — veritabanını da kapatmak

```powershell
docker compose stop
```

Ya da hazır betikle (Git Bash gerektirir):

```bash
bash scripts/deploy/local-stop.sh
```

---

## EXPECTED

```powershell
# Uygulama gerçekten durdu mu?
curl.exe -s -o NUL -w "%{http_code}`n" http://127.0.0.1:3000/ready
```

- **Beklenen:** bağlantı kurulamıyor (`Failed to connect` / `000`). Yani cevap **yok**.
- `200` dönüyorsa sunucu hâlâ ayakta demektir.

```powershell
# Port serbest mi?
Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue
```

- **Beklenen:** çıktı yok.

Veritabanı tarafında açık bağlantı kalmadığının kanıtı (cutover öncesi zorunlu):

```powershell
docker exec mas-radar-pg psql -U postgres -t -A -c "select count(*) from pg_stat_activity where datname='mas_radar_dev' and pid <> pg_backend_pid();"
```

- **Beklenen:** `0`

Veritabanını da durdurduysanız:

```powershell
docker ps --filter "name=mas-radar-pg" --format "{{.Names}} {{.Status}}"
```

- **Beklenen:** çıktı yok (konteyner listede değil).

---

## FAILURE SIGNALS

| Belirti | Anlamı | Ne yapılır |
|---|---|---|
| Ctrl-C sonrası `/ready` hâlâ 200 | Süreç ölmedi ya da ikinci bir sunucu var | Yol 2 ile PID bulun; **iki** dinleyici varsa ikisini de doğrulayıp ayrı ayrı durdurun |
| `Get-NetTCPConnection` boş ama `/health` cevap veriyor | Farklı bir portta ikinci örnek | `Get-NetTCPConnection -State Listen \| Where-Object {$_.LocalPort -in 3000..3300}` |
| `Stop-Process` "Erişim reddedildi" | Süreç başka bir kullanıcıya ait | PowerShell'i yönetici olarak açın; komut satırını **tekrar doğrulayın** |
| `pg_stat_activity` sayısı 0'a inmiyor | Açık bir oturum/işlem var | Kimin bağlı olduğunu görün (aşağıda) ve o istemciyi kapatın |
| `docker compose stop` takılıyor | Docker meşgul | `docs/ops/docker-restart.md` |

Kimin bağlı olduğunu görmek (yalnız okuma):

```powershell
docker exec mas-radar-pg psql -U postgres -c "select pid, usename, application_name, state from pg_stat_activity where datname='mas_radar_dev';"
```

> Bağlantıyı zorla kesen `pg_terminate_backend` bu runbook'un kapsamında **değildir**. Devam
> eden bir yazma işlemini kesmek veri tutarlılığı riski taşır; o karar `docs/ops/incident.md`
> üzerinden verilir.

---

## STOP CONDITION

1. Durduracağınız sürecin komut satırında `next start` yazmıyorsa → **durdurmayın**.
2. Port 3000'de **birden fazla** dinleyici varsa → bu tek başına bir olaydır; durdurmadan önce
   `docs/ops/incident.md` ile kayda geçirin (iki sunucu aynı `.next` dizinini bozmuş olabilir).
3. Uygulamada bir içe aktarım sürüyorsa → bitmesini bekleyin.

---

## ROLLBACK

Durdurmanın geri alınması yeniden başlatmaktır: `docs/ops/start.md`.

Yarıda kesilen bir arka plan işi kaldıysa, yeniden başlattıktan sonra kontrol edin:

```powershell
$env:DATABASE_URL = ((Select-String -Path .env.local -Pattern '^DATABASE_URL=' |
  Select-Object -First 1).Line -replace '^DATABASE_URL=','')
$env:MIGRATION_DATABASE_URL = ((Select-String -Path .env.local -Pattern '^MIGRATION_DATABASE_URL=' |
  Select-Object -First 1).Line -replace '^MIGRATION_DATABASE_URL=','')
pnpm ops:telemetry
```

`jobs_stuck` satırı `0` olmalıdır. Değilse `docs/ops/incident.md`.

---

## EVIDENCE

```text
tarih/saat            :
durdurma yolu         : Ctrl-C / PID / docker compose stop
durdurulan PID        :
komut satırı doğrulandı mı (next start): EVET/HAYIR
/ready cevabı         : (bağlantı yok bekleniyor)
açık DB bağlantısı    : (0 bekleniyor)
```

---

## SECRET HANDLING

- Bu runbook hiçbir sır okumaz ya da yazmaz.
- `pnpm ops:telemetry` çalıştırırsanız kullanılan atama satırı değeri ekrana **yazmaz**.
- Süreç komut satırını (`CommandLine`) paylaşırken dikkat edin: bir başlatma komutuna elle
  parola eklenmişse orada görünür. Bu projede parola argümanla verilmez; görürseniz bu bir
  bulgudur — `docs/ops/password-rotation.md`.
