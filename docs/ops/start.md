# RUNBOOK — start (uygulamayı ve arka plan işçisini başlat)

> **Kime:** MAS operatörüne. Yazılım geliştirici olmanız gerekmez.
> **Kural:** Bu belgedeki komutlar olduğu gibi kopyalanıp yapıştırılabilir. Belgede olmayan bir
> komutu kendiliğinizden eklemeyin.
> **Çalışma dizini (her komut için):** `C:\Users\Trade Bilisim\Mas Saas`

---

## PURPOSE

Yerel PostgreSQL 16 veritabanını, Next.js üretim sunucusunu ve arka plan otomasyon işçisini ayağa kaldırmak; üçünün de sağlıklı çalıştığını **ölçmek**.

Başlatma üç parçadır ve her biri ayrı ayrı doğrulanır:

1. **PostgreSQL 16 (Windows Yerel Küme)** — `MAS-PostgreSQL16` (veya standart EDB kurulumlarında `postgresql-x64-16`), `127.0.0.1:5432`, ikililer `C:\MAS\pgsql16\bin`.
2. **Next.js Üretim Sunucusu** — `pnpm start`, varsayılan olarak `http://127.0.0.1:3000`.
3. **Zamanlanmış Arka Plan İşçisi & Gözetim** — Windows Görev Zamanlayıcı görevleri (`MAS-Background-Worker`, `MAS-Nakit-Radar-Gunluk-Yedek`, `MAS-Nakit-Radar-Telemetri-Gozetim`).

---

## PRECONDITIONS

| # | Koşul | Nasıl doğrulanır |
|---|---|---|
| 1 | Yerel PostgreSQL 16 ayakta | `pnpm db:ensure` → `PostgreSQL hazır (native, 127.0.0.1:5432).` |
| 2 | `.env.local` dosyası var ve üretim kilitli | `Test-Path .env.local` → `True` (`MAS_LOCAL_PASSWORDLESS=0`) |
| 3 | **Port 3000'de başka bir sunucu YOK** | aşağıdaki "tek sunucu kuralı" kontrolü (`runtime-port-guard` da zorlar) |
| 4 | Kabukta bayat bağlantı değişkeni yok | `pnpm db:env:source` |

### Tek Next sunucusu kuralı — atlanamaz

Aynı anda **yalnız bir** Next sunucusu çalışabilir. İki süreç aynı `.next` derleme dizinini paylaşırsa derleme bozulur. `pnpm start` zincirinin ilk halkası (`scripts/ops/runtime-port-guard.ts --start`) port 3000 meşgulse süreci başlatmayı reddeder.

```powershell
Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue |
  Select-Object LocalPort, OwningProcess
```

- Çıktı **boşsa** → port serbest, devam edin.
- Çıktı bir satır veriyorsa → **zaten çalışan bir sunucu var.** BAŞLATMAYIN. Önce
  [stop.md](stop.md) ile durdurun ya da çalışanı olduğu gibi kullanın.

### Ortam hijyeni — bu adım gözle yapılmaz

```powershell
pnpm db:env:source
```

Görmek istediğiniz son satır: `ENV SOURCE: gölgeleme yok.`

`GÖLGELEME` yazıyorsa **DURUN**: kabuğunuzda kalmış eski bir `DATABASE_URL`, `.env.local` dosyasını sessizce geçersiz kılıyor demektir. Çözüm: bu pencereyi kapatın, **yeni** bir PowerShell açın.

---

## DATA CLASS

```text
TARGET DB NAME  : mas_radar_dev
TARGET DB CLASS : PRODUCTION_WRITE
WRITE EXPECTED? : YES
```

**Neden YES.** `pnpm start` yalnız sunucuyu açmaz; önce `scripts/prepare-runtime.ts` çalışır ve gerçek veritabanına **yazar**:

- `system` servis hesabını yoksa oluşturur,
- 24 aylık ödeme penceresini (`payment_instances`) üretir.

Bu yüzden `pnpm start` "zararsız bir okuma" değildir. Bakım/dondurma penceresinde (bkz. [cutover.md](cutover.md) adım B) uygulama **başlatılmaz**.

---

## COMMANDS

### 1) PostgreSQL 16 (Windows Yerel Hizmet)

```powershell
cd "C:\Users\Trade Bilisim\Mas Saas"
Get-Service MAS-PostgreSQL16, postgresql-x64-16 -ErrorAction SilentlyContinue
& C:\MAS\pgsql16\bin\pg_isready.exe -h 127.0.0.1 -p 5432
pnpm db:ensure
```

Veritabanı kapalıysa [postgres-service.md](postgres-service.md) uyarınca yönetici PowerShell'de `Start-Service MAS-PostgreSQL16` (veya oturum görevi modundaysa `Start-ScheduledTask -TaskName MAS-PostgreSQL16-Oturum-Baslat`) çalıştırın.

### 2) Ortam ve Şema Kontrolü (sır yazdırmaz)

```powershell
pnpm exec tsx scripts/deploy/check-env.ts
pnpm db:env:source
```

Yeni bir sürüm sonrası bekleyen migration varsa (uygulama kapalıyken):

```powershell
pnpm db:migrate
```

### 3) Arka Plan İşçisi ve Zamanlanmış Görev Kontrolü

```powershell
Get-ScheduledTask -TaskName "MAS-Background-Worker", "MAS-Nakit-Radar-Gunluk-Yedek", "MAS-Nakit-Radar-Telemetri-Gozetim" -ErrorAction SilentlyContinue |
  Select-Object TaskName, State
```

`MAS-Background-Worker` kayıtlı değilse kaydetmek için:

```powershell
pnpm ops:worker:schedule install --apply
```

### 4) Uygulama Sunucusu

Derleme (`.next`) zaten varsa doğrudan:

```powershell
pnpm start
```

Derleme yoksa ya da kod değiştiyse önce:

```powershell
pnpm build
pnpm start
```

> `pnpm start` çalıştığı **terminali işgal eder**. O pencereyi kapatmayın; kapatmak sunucuyu durdurur. Sunucuyu durdurmak için [stop.md](stop.md).

### 5) Ayakta olduğunun kanıtı — başka bir pencerede

```powershell
curl.exe -s http://127.0.0.1:3000/health
curl.exe -s http://127.0.0.1:3000/ready
curl.exe -s http://127.0.0.1:3000/version
```

Bu üç adres kök seviyededir (`/api/` altında **değildir**).

### 6) Doğru veritabanına ve şemaya bağlandığının kanıtı

```powershell
$env:DATABASE_URL = ((Select-String -Path .env.local -Pattern '^DATABASE_URL=' |
  Select-Object -First 1).Line -replace '^DATABASE_URL=','')
pnpm db:roles:verify
Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue
```

---

## EXPECTED

```text
pg_isready.exe                   ->  127.0.0.1:5432 - accepting connections
pnpm db:ensure                   ->  PostgreSQL hazır (native, 127.0.0.1:5432).
/health                          ->  {"status":"ok","app":"up","db":"up",...}
/ready                           ->  {"status":"ready","app":"up",...}
/version                         ->  {"name":"mas-nakit-radar",...}
pnpm db:env:source               ->  ENV SOURCE: gölgeleme yok.        (exit 0)
pnpm db:roles:verify ilk satırı  ->  Hedef: db=mas_radar_dev user=mas_radar_app
pnpm db:roles:verify son satırı  ->  8/8 kontrol geçti.                (exit 0)
schema_migrations                ->  113 satır, en son 0113
```

---

## FAILURE SIGNALS

| Belirti | Anlamı | Ne yapılır |
|---|---|---|
| `pg_isready.exe` cevap vermiyor | Yerel PostgreSQL 16 hizmeti kapalı | [postgres-service.md](postgres-service.md) (`Start-Service MAS-PostgreSQL16`) |
| `/health` → `"db":"down"` | Uygulama ayakta, veritabanı yok | [postgres-service.md](postgres-service.md) |
| `/health` bağlantı hatası | Sunucu çalışmıyor | 4. adımı tekrar edin; port çakışmasına bakın |
| `EADDRINUSE :3000` veya `runtime-port-guard` durdurması | **Zaten bir sunucu var** | BAŞLATMAYIN — [stop.md](stop.md) |
| `MAS_LOCAL_PASSWORDLESS` hatası | Üretim modunda parolasız giriş açık bırakılmış | `.env.local` içinde `MAS_LOCAL_PASSWORDLESS=0` yapın |
| `ENV SOURCE: GÖLGELEME` | Kabukta bayat değişken | Pencereyi kapatın, yeni PowerShell açın |
| `roles:verify` → `db=` beklenenden farklı | **Yanlış veritabanı** | DURUN — [incident.md](incident.md) |
| `permission denied for table users` | Rol/şema uyumsuz | DURUN — [failed-migration.md](failed-migration.md) |

---

## STOP CONDITION

Aşağıdakilerden **biri** olursa devam etmeyin, uygulamayı açık bırakmayın ve olayı [incident.md](incident.md) ile kayda geçirin:

1. Kimlik satırı beklenen veritabanını (`mas_radar_dev`) göstermiyor.
2. `schema_migrations` beklenen kanonik sürümde (`113` / `0113`) değil ve bunun bilinen bir sebebi yok.
3. `pnpm db:env:source` gölgeleme bildiriyor ve yeni bir pencerede de sürüyor.
4. Port 3000'de zaten bir sunucu varken ikincisini açmak üzeresiniz.

---

## ROLLBACK

Başlatma geri alınabilir bir işlemdir; şemayı değiştirmez.

```powershell
# 1) Uygulamayı durdur: docs/ops/stop.md
# 2) Gerekiyorsa PostgreSQL hizmetini de durdur (yönetici PowerShell) — veri korunur:
Stop-Service MAS-PostgreSQL16
```

`prepare-runtime` tarafından üretilen ödeme penceresi satırları **geri alınmaz ve alınmamalıdır**: bunlar normal operasyonel veridir, hata değildir.

---

## EVIDENCE

Her başlatmada aşağıdaki satırları tarih/saatle birlikte operasyon defterine yazın:

```text
tarih/saat             :
pg_isready.exe         :
/health                :
kimlik satırı          : Hedef: db=mas_radar_dev user=mas_radar_app
roles:verify           : 8/8 kontrol geçti (exit 0)
MAS-Background-Worker  : Ready / Running
```

Otomatik üretilen kayıtlar:

- `logs/alerts.jsonl` — telemetri/alarm kaydı (`pnpm ops:telemetry`)
- `logs/telemetry-latest.json` — son anlık görüntü

---

## SECRET HANDLING

- **Bağlantı dizesi, parola veya token hiçbir yere yapıştırılmaz** — ekran görüntüsüne, hata bildirimine, sohbete, kanıt dosyasına.
- `.env.local` **açılmaz ve içeriği ekrana basılmaz**; yukarıdaki atama satırı değeri ekrana yazmadan kabuğa aktarır.
- Bir sır kazayla ekrana geldiyse: pencereyi kapatın ve [password-rotation.md](password-rotation.md) prosedürünü başlatın.
