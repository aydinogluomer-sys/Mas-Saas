# RUNBOOK — start (uygulamayı başlat)

> **Kime:** MAS operatörüne. Yazılım geliştirici olmanız gerekmez.
> **Kural:** Bu belgedeki komutlar olduğu gibi kopyalanıp yapıştırılabilir. Belgede olmayan bir
> komutu kendiliğinizden eklemeyin.
> **Çalışma dizini (her komut için):** `C:\Users\Trade Bilisim\Mas Saas`

---

## PURPOSE

Veritabanını ve uygulamayı ayağa kaldırmak, ayakta olduğunu **ölçmek**.

Başlatma iki parçadır ve ikisi ayrı ayrı doğrulanır:

1. **PostgreSQL** — `mas-radar-pg` adlı Docker konteyneri.
2. **Next.js production sunucusu** — `pnpm start`, varsayılan olarak `http://127.0.0.1:3000`.

---

## PRECONDITIONS

| # | Koşul | Nasıl doğrulanır |
|---|---|---|
| 1 | Docker Desktop açık | `docker ps` hata vermeden bir tablo yazdırır |
| 2 | `.env.local` dosyası var | `Test-Path .env.local` → `True` |
| 3 | **Port 3000'de başka bir sunucu YOK** | aşağıdaki "tek sunucu kuralı" kontrolü |
| 4 | Kabukta bayat bağlantı değişkeni yok | `pnpm db:env:source` |

### Tek Next sunucusu kuralı — atlanamaz

Aynı anda **yalnız bir** Next sunucusu çalışabilir. İki süreç aynı `.next` derleme dizinini
paylaşırsa derleme bozulur ve uygulama sebepsiz yavaşlar ya da beyaz ekran verir.

```powershell
Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue |
  Select-Object LocalPort, OwningProcess
```

- Çıktı **boşsa** → port serbest, devam edin.
- Çıktı bir satır veriyorsa → **zaten çalışan bir sunucu var.** BAŞLATMAYIN. Önce
  `docs/ops/stop.md` ile durdurun ya da çalışanı olduğu gibi kullanın.

### Ortam hijyeni — bu adım gözle yapılmaz

```powershell
pnpm db:env:source
```

Görmek istediğiniz son satır: `ENV SOURCE: gölgeleme yok.`

`GÖLGELEME` yazıyorsa **DURUN**: kabuğunuzda kalmış eski bir `DATABASE_URL`, `.env.local`
dosyasını sessizce geçersiz kılıyor demektir. Bu makinede gerçekten yaşandı: dosya düzeltildi,
hata sürdü, çünkü kabuktaki eski değer kazanıyordu — ve doğrulama kapısı **yanlış veritabanına**
karşı "her şey yolunda" dedi. Çözüm: bu pencereyi kapatın, **yeni** bir PowerShell açın.

---

## DATA CLASS

```text
TARGET DB NAME  : mas_radar_dev
TARGET DB CLASS : PRODUCTION_WRITE
WRITE EXPECTED? : YES
```

**Neden YES.** `pnpm start` yalnız sunucuyu açmaz; önce `scripts/prepare-runtime.ts` çalışır ve
gerçek veritabanına **yazar**:

- `system` servis hesabını yoksa oluşturur,
- 24 aylık ödeme penceresini (`payment_instances`) üretir.

Bu yüzden `pnpm start` "zararsız bir okuma" değildir. Bakım/dondurma penceresinde
(bkz. `docs/ops/cutover.md` adım B) uygulama **başlatılmaz**.

---

## COMMANDS

### 1) PostgreSQL

```powershell
cd "C:\Users\Trade Bilisim\Mas Saas"
docker compose up -d
docker exec mas-radar-pg pg_isready -U postgres
```

### 2) Ortam kontrolü (sır yazdırmaz)

```powershell
pnpm exec tsx scripts/deploy/check-env.ts
pnpm db:env:source
```

### 3) Uygulama

Derleme (`.next`) zaten varsa doğrudan:

```powershell
pnpm start
```

Derleme yoksa ya da kod değiştiyse önce:

```powershell
pnpm build
pnpm start
```

> `pnpm start` çalıştığı **terminali işgal eder**. O pencereyi kapatmayın; kapatmak sunucuyu
> durdurur. Sunucuyu durdurmak için `docs/ops/stop.md`.

### 4) Ayakta olduğunun kanıtı — başka bir pencerede

```powershell
curl.exe -s http://127.0.0.1:3000/health
curl.exe -s http://127.0.0.1:3000/ready
curl.exe -s http://127.0.0.1:3000/version
```

Bu üç adres kök seviyededir (`/api/` altında **değildir**).

### 5) Doğru veritabanına bağlandığının kanıtı

```powershell
$env:DATABASE_URL = ((Select-String -Path .env.local -Pattern '^DATABASE_URL=' |
  Select-Object -First 1).Line -replace '^DATABASE_URL=','')
pnpm db:roles:verify
```

Bu atama ekrana **hiçbir şey yazmaz** — parola görünmez. Kapının ilk satırı hedefi söyler.

---

## EXPECTED

```text
docker exec ... pg_isready       ->  /var/run/postgresql:5432 - accepting connections
/health                          ->  {"status":"ok","app":"up","db":"up",...}
/ready                           ->  {"status":"ready","app":"up",...}
/version                         ->  {"name":"mas-nakit-radar",...}
pnpm db:env:source               ->  ENV SOURCE: gölgeleme yok.        (exit 0)
pnpm db:roles:verify ilk satırı  ->  Hedef: db=mas_radar_dev user=mas_radar_app
pnpm db:roles:verify son satırı  ->  8/8 kontrol geçti.                (exit 0)
```

Gerçek veritabanında beklenen büyüklükler (bunlar sağlık göstergesidir, "yaklaşık" değildir):

```text
schema_migrations = 87 satır, en son 0087
users             = 17
payments          = 20
```

---

## FAILURE SIGNALS

| Belirti | Anlamı | Ne yapılır |
|---|---|---|
| `docker ps` hata veriyor | Docker Desktop kapalı | Docker Desktop'ı açın, 1–2 dk bekleyin |
| `pg_isready` cevap vermiyor | Konteyner ayakta değil | `docs/ops/docker-restart.md` |
| `/health` → `"db":"down"` | Uygulama ayakta, veritabanı yok | `docs/ops/docker-restart.md` |
| `/health` bağlantı hatası | Sunucu çalışmıyor | 3. adımı tekrar edin; port çakışmasına bakın |
| `EADDRINUSE :3000` | **Zaten bir sunucu var** | BAŞLATMAYIN — `docs/ops/stop.md` |
| `ENV SOURCE: GÖLGELEME` | Kabukta bayat değişken | Pencereyi kapatın, yeni PowerShell açın |
| `roles:verify` → `db=` beklenenden farklı | **Yanlış veritabanı** | DURUN — hiçbir işlem yapmayın, `docs/ops/incident.md` |
| `roles:verify` → `users ... 17` değil | Yanlış veritabanı ya da veri kaybı | DURUN — `docs/ops/incident.md` |
| `permission denied for table users` | Rol/şema uyumsuz | DURUN — `docs/ops/failed-migration.md` |

---

## STOP CONDITION

Aşağıdakilerden **biri** olursa devam etmeyin, uygulamayı açık bırakmayın ve olayı
`docs/ops/incident.md` ile kayda geçirin:

1. Kimlik satırı beklenen veritabanını göstermiyor.
2. `users` satır sayısı 17 değil (ya da ledger 87/0087 değil) ve bunun bilinen bir sebebi yok.
3. `pnpm db:env:source` gölgeleme bildiriyor ve yeni bir pencerede de sürüyor.
4. Port 3000'de zaten bir sunucu varken ikincisini açmak üzeresiniz.

---

## ROLLBACK

Başlatma geri alınabilir bir işlemdir; şemayı değiştirmez.

```powershell
# 1) Uygulamayı durdur
#    (ayrıntılı ve güvenli yol: docs/ops/stop.md)
# 2) Gerekiyorsa veritabanını da durdur — veri korunur
docker compose stop
```

`prepare-runtime` tarafından üretilen ödeme penceresi satırları **geri alınmaz ve alınmamalıdır**:
bunlar normal operasyonel veridir, hata değildir. Finansal kayıt silme işlemi bu runbook'un
kapsamı dışındadır ve operatör tarafından tek başına yapılmaz.

---

## EVIDENCE

Her başlatmada aşağıdaki dört satırı tarih/saatle birlikte bir yere (operasyon defteri ya da
`docs/release-evidence/` altında ilgili dosya) yazın:

```text
tarih/saat        :
pg_isready        :
/health           :
kimlik satırı     : Hedef: db=... user=...
roles:verify      : n/n kontrol geçti   (exit kodu)
```

Otomatik üretilen kayıtlar:

- `logs/alerts.jsonl` — telemetri/alarm kaydı (`pnpm ops:telemetry`)
- `logs/telemetry-latest.json` — son anlık görüntü

---

## SECRET HANDLING

- **Bağlantı dizesi, parola veya token hiçbir yere yapıştırılmaz** — ekran görüntüsüne, hata
  bildirimine, sohbete, kanıt dosyasına.
- `.env.local` **açılmaz ve içeriği okunmaz**; yukarıdaki atama satırı değeri ekrana yazmadan
  kabuğa aktarır.
- Kapılar hedefi yalnız `db=<ad> user=<ad>` biçiminde söyler; host, port ve parola bilinçli
  olarak yazdırılmaz.
- Bir sır kazayla ekrana geldiyse: pencereyi kapatın ve `docs/ops/password-rotation.md`
  prosedürünü başlatın.
