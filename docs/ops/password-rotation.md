# RUNBOOK — password rotation (parola ve kimlik bilgisi değiştirme)

> **Kime:** MAS operatörüne. Yazılım geliştirici olmanız gerekmez.
> **Çalışma dizini (her komut için):** `C:\Users\Trade Bilisim\Mas Saas`

---

## ⚠ ÖNCE BUNU OKUYUN — PostgreSQL'de roller KÜME GENELİNDEDİR

```text
pnpm db:app-role:password
```

Bu komut `mas_radar_app` rolünün parolasını **bütün veritabanları için aynı anda** değiştirir.
Hangi veritabanını hedeflediğinizin hiçbir önemi yoktur; rol kümenin (cluster) nesnesidir.

**Sonucu:** port 3000'de çalışan canlı uygulamanın `.env.local`'deki parolası o **saniye**
geçersizleşir ve uygulama düşer. "Bir klon üzerinde denerim" diye çalıştırmak canlıyı düşürür.

Bu yüzden:

- Bu komut **yalnız planlı bir bakım penceresinde**, uygulama **durdurulmuşken** çalıştırılır.
- Denemek için harcanabilir bir hedef seçmek **işe yaramaz** — koruma yoktur, çünkü korunacak
  bir hedef kavramı yoktur.
- Doğrulama kapıları ve tatbikatlar bu komutu bilinçli olarak **çağırmaz**; canlı kimliği
  `.env.local`'den alıp yalnız veritabanı adını değiştirirler.

---

## PURPOSE

Dört sınıf kimlik bilgisini, sistemi kırmadan değiştirmek:

| # | Kimlik | Nerede tutulur | Etki alanı |
|---|---|---|---|
| 1 | **DB owner parolası** (`postgres`) | `.env.local` → `MIGRATION_DATABASE_URL` | Küme geneli |
| 2 | **App DB parolası** (`mas_radar_app`) | `.env.local` → `DATABASE_URL` | **Küme geneli** |
| 3 | **Oturumlar** (session) | Veritabanı: `public.sessions` | Uygulama |
| 4 | **Entegrasyon anahtarları** | `.env.local` | İlgili servis |

Her biri için sıra aynıdır: **rotate → restart → smoke → rollback (gerekirse)**.

### 3 numara neden "session secret" değil

Bu üründe imzalı çerez ya da `SESSION_SECRET` ortam değişkeni **yoktur**. Oturumlar
veritabanında tutulur: rastgele bir token üretilir, istemciye o verilir, veritabanında yalnız
token'ın SHA-256 özeti saklanır. Dolayısıyla "session secret rotasyonu"nun bu mimarideki tam
karşılığı **bütün oturumları iptal etmek**tir (herkes yeniden giriş yapar). Döndürülecek bir
sır olmadığı için uydurulmamıştır.

---

## PRECONDITIONS

| # | Koşul | Nasıl doğrulanır |
|---|---|---|
| 1 | **Planlı bakım penceresi** — kullanıcılara haber verildi | — |
| 2 | Güncel ve **geri yüklenebilir** yedek var | `docs/ops/backup.md` |
| 3 | Uygulama durduruldu | `docs/ops/stop.md` — `/ready` cevap vermiyor |
| 4 | Yeni parola hazır (en az 16 karakter, rastgele) | Parola yöneticisinde |
| 5 | `.env.local`'in bir kopyası güvenli bir yerde | Geri dönüş için |
| 6 | Kabukta bayat bağlantı değişkeni yok | `pnpm db:env:source` |

---

## DATA CLASS

```text
TARGET DB NAME  : mas_radar_dev (ve küme genelindeki tüm veritabanları)
TARGET DB CLASS : PRODUCTION_WRITE
WRITE EXPECTED? : YES — rol nesneleri (ALTER ROLE) ve/veya public.sessions güncellenir.
                  Finansal tablolara YAZILMAZ.
```

---

## COMMANDS

### Sınıf 2 — `mas_radar_app` parolası (en sık gereken)

```powershell
cd "C:\Users\Trade Bilisim\Mas Saas"

# 1) UYGULAMAYI DURDURUN — docs/ops/stop.md
#    Kanıt: /ready cevap vermiyor.

# 2) Owner bağlantısını kabuğa alın (değeri EKRANA YAZMAZ)
$env:MIGRATION_DATABASE_URL = ((Select-String -Path .env.local -Pattern '^MIGRATION_DATABASE_URL=' |
  Select-Object -First 1).Line -replace '^MIGRATION_DATABASE_URL=','')

# 3) ROTATE — parolayı MASKELİ olarak sorar
pnpm db:app-role:password
```

Komut parolayı iki kanaldan alır: `MAS_RADAR_APP_DB_PASSWORD` ortam değişkeni ya da maskeli
soru (her karakter için `*`).

> **Parola komut satırı argümanı olarak KABUL EDİLMEZ.** Sebebi tek cümlede: argümanlar kabuk
> geçmişinde (`Get-History`, `PSReadLine` geçmiş dosyası) ve Görev Yöneticisi'nin süreç
> listesinde **açıkça görünür**. Bir sırrı argümanla vermek onu diske yazmaktır.

```powershell
# 4) .env.local içindeki DATABASE_URL satırındaki parolayı YENİSİYLE güncelleyin.
#    Dosyayı bir metin düzenleyicide açıp yalnız o satırı değiştirin.
#    Değeri terminale yazdırmayın, kopyala-yapıştır sırasında ekranı paylaşmayın.

# 5) RESTART
pnpm start            # docs/ops/start.md

# 6) SMOKE — üç kanıt
curl.exe -s http://127.0.0.1:3000/health
$env:DATABASE_URL = ((Select-String -Path .env.local -Pattern '^DATABASE_URL=' |
  Select-Object -First 1).Line -replace '^DATABASE_URL=','')
pnpm db:roles:verify
```

### Sınıf 1 — `postgres` (owner) parolası

Parolayı komuta yazmayın; `psql`'in kendi maskeli komutunu kullanın:

```powershell
docker exec -it mas-radar-pg psql -U postgres
```

Açılan istemde:

```text
\password postgres
```

İki kez sorar, hiçbirini ekrana yazmaz. Sonra `\q` ile çıkın.

Ardından `.env.local` içindeki `MIGRATION_DATABASE_URL` satırındaki parolayı güncelleyin.

> `docker-compose.yml` içindeki `POSTGRES_PASSWORD` yalnız **veritabanı ilk kez
> oluşturulurken** kullanılır; var olan bir kümede parolayı o değiştirmez. Yine de ileride
> sıfırdan bir kurulum yapılırsa tutarlı olsun diye `.env` tarafını da güncelleyin.

### Sınıf 3 — bütün oturumları iptal et (session rotasyonu)

Bir hesabın ele geçirildiğinden şüpheleniliyorsa ya da toplu çıkış gerekiyorsa:

```powershell
$env:MIGRATION_DATABASE_URL = ((Select-String -Path .env.local -Pattern '^MIGRATION_DATABASE_URL=' |
  Select-Object -First 1).Line -replace '^MIGRATION_DATABASE_URL=','')

docker exec mas-radar-pg psql -U postgres -d mas_radar_dev -c "update public.sessions set revoked_at = now() where revoked_at is null;"
```

Herkes yeniden giriş yapar. **Tek bir kullanıcı** için bu gerekmez — o hesabı pasifleştirmek
zaten oturumlarını iptal eder (`docs/ops/role-change.md`).

### Sınıf 4 — entegrasyon anahtarları

`.env.local` içinde:

```text
TELEGRAM_BOT_TOKEN     hatırlatma gönderimi
TELEGRAM_CHAT_ID       hedef sohbet
EMAIL_API_URL / EMAIL_API_KEY / EMAIL_TO   e-posta kanalı
OPENAI_API_KEY         yorum katmanı
```

Sıra: sağlayıcı panelinden **yeni anahtar üret** → `.env.local`'i güncelle → `pnpm start` →
duman testi. Eski anahtarı **yeni anahtar çalıştığı doğrulandıktan sonra** iptal edin.

Bu anahtarların hiçbiri finansal veriye erişmez; unset olduklarında sistem çalışmaya devam
eder ve teslimat "başarısız" olarak **dürüstçe** kaydedilir.

---

## EXPECTED

```text
pnpm db:app-role:password ->  rolün parolası güncellendi, exit 0 (parola EKRANA YAZILMAZ)
/health                   ->  {"status":"ok","app":"up","db":"up",...}
pnpm db:roles:verify      ->  Hedef: db=mas_radar_dev user=mas_radar_app
                              8/8 kontrol geçti.          (exit 0)
uygulamaya giriş          ->  mevcut kullanıcılar giriş yapabiliyor
Sınıf 3 sonrası           ->  herkes yeniden giriş yapmak zorunda (beklenen)
```

Oturum iptalinin kanıtı:

```powershell
docker exec mas-radar-pg psql -U postgres -d mas_radar_dev -t -A -c "select count(*) from public.sessions where revoked_at is null and expires_at > now();"
```

**Beklenen (iptal sonrası, kimse giriş yapmadan önce):** `0`

---

## FAILURE SIGNALS

| Belirti | Anlamı | Ne yapılır |
|---|---|---|
| `password authentication failed for user "mas_radar_app"` | `.env.local` eski parolayı taşıyor | 4. adımı tamamlayın; parolayı doğru satıra yazdığınızdan emin olun |
| Uygulama başlıyor ama `/health` `"db":"down"` | Aynı sebep | Aynı |
| `roles:verify` → `db=` beklenmedik | Kabukta bayat değişken | `pnpm db:env:source`, yeni pencere |
| Başka bir araç aniden bağlanamıyor | **Küme geneli etki** — beklenen | O aracın bağlantı ayarını da güncelleyin |
| Maskeli soru gelmiyor, "TTY gerekli" | Etkileşimli olmayan kabuk | `$env:MAS_RADAR_APP_DB_PASSWORD` tanımlayıp çalıştırın, sonra **silin** |
| `\password` sonrası owner araçları düştü | `MIGRATION_DATABASE_URL` eski | `.env.local`'i güncelleyin |
| Parola terminalde göründü | **Sır sızıntısı** | Pencereyi kapatın, geçmişi temizleyin, parolayı **tekrar** döndürün |

---

## STOP CONDITION

1. Uygulama **çalışırken** `pnpm db:app-role:password` çalıştırmak üzereyseniz → **DURUN.**
   Canlı örnek düşer.
2. Güncel yedek yoksa → önce `docs/ops/backup.md`.
3. `.env.local`'in yedek kopyası yoksa → önce alın; geri dönüş buna bağlıdır.
4. Parola bir komut satırına yazıldıysa (herhangi bir araçta) → o parolayı kullanmayın,
   yenisini üretin.
5. İş saatleri içindeyseniz ve bu planlı bir pencere değilse → erteleyin. Tek istisna:
   kimlik bilgisinin sızdığından şüpheleniliyorsa **hemen** yapılır.

---

## ROLLBACK

### Sınıf 1 ve 2 — parola geri alınmaz, YENİDEN döndürülür

Eski parolayı "geri koymak" diye bir şey yoktur; aynı prosedürü bilinen bir değerle tekrar
çalıştırırsınız:

```powershell
# uygulama durdurulur
pnpm db:app-role:password       # bilinen parolayı girin
# .env.local güncellenir
pnpm start
pnpm db:roles:verify
```

`.env.local`'in yedek kopyasını sakladıysanız 4. adım yalnız o dosyayı geri koymaktır.

### Sınıf 3 — geri alınmaz ve alınmamalıdır

İptal edilen oturum geri getirilmez. Kullanıcılar yeniden giriş yapar. Bu, bir güvenlik
işleminin doğru davranışıdır.

### Sınıf 4 — eskisini geri koyun

Eski anahtarı henüz iptal etmediyseniz `.env.local`'e geri yazıp `pnpm start`. Bu yüzden eski
anahtar, yenisi doğrulanana kadar iptal edilmez.

---

## EVIDENCE

```text
tarih/saat            :
pencere türü          :  planlı bakım / acil (sızıntı şüphesi)
döndürülen sınıf      :  1 / 2 / 3 / 4
uygulama durduruldu mu:  EVET  (kanıt: /ready cevapsız)
rotate komutu         :
.env.local güncellendi:  EVET
restart               :  pnpm start
smoke /health         :
smoke roles:verify    :  Hedef: db=... user=...   n/n kontrol geçti
açık oturum (Sınıf 3) :  0 bekleniyor -> ...
geri dönüş gerekti mi :  HAYIR/EVET (sebep)
```

**Parolanın kendisi hiçbir kanıt dosyasına yazılmaz.** Yalnız "döndürüldü" olgusu ve tarihi
kaydedilir.

---

## SECRET HANDLING

Bu runbook'un tamamı bu bölüm etrafında kuruludur.

- **Parola argüman olarak verilmez.** `scripts/db/set-app-role-password.ts` ve
  `scripts/db/seed-admin.ts` bunu **reddeder**; sebep, argümanların kabuk geçmişinde ve süreç
  listesinde görünmesidir.
- İki meşru kanal vardır: **ortam değişkeni** ya da **maskeli soru**. Ortam değişkeni
  kullandıysanız iş bitince silin:
  ```powershell
  Remove-Item Env:MAS_RADAR_APP_DB_PASSWORD -ErrorAction SilentlyContinue
  Remove-Item Env:SEED_ADMIN_PASSWORD -ErrorAction SilentlyContinue
  ```
- **Bağlantı dizesi hiçbir yere yapıştırılmaz.** Bu belgedeki atama satırları değeri kabuğa
  alır ama ekrana **yazmaz**; kapılar hedefi yalnız `db=<ad> user=<ad>` olarak söyler.
- `.env.local` `.gitignore`'dadır; asla commit edilmez, ekran görüntüsü alınmaz.
- Alarm ve telemetri çıktıları iki katmanlı maskeleme uygular (parolalı bağlantı dizesi,
  `/bot<token>/`, `Bearer ...`), ama bu bir güvence değil son savunmadır — sırrı en baştan
  yazdırmayın.
- Bir sır ekrana geldiyse: parolayı **kullanılmış** kabul edin ve bu runbook'u baştan
  çalıştırın. Ayrıca olayı `docs/ops/incident.md` ile kayda geçirin.
