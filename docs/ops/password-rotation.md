# RUNBOOK — password rotation (parola ve kimlik bilgisi değiştirme)

> **Kime:** MAS operatörüne. Yazılım geliştirici olmanız gerekmez.
> **Çalışma dizini (her komut için):** `C:\Users\Trade Bilisim\Mas Saas`

---

## ÖNCE BUNU OKUYUN — PostgreSQL'de roller KÜME GENELİNDEDİR

```text
pnpm db:app-role:password
```

Bu komut yerel PostgreSQL 16 kümesindeki `mas_radar_app` rolünün parolasını **bütün veritabanları için aynı anda** değiştirir.

**Sonucu:** port 3000'de çalışan canlı uygulamanın `.env.local`'deki parolası o **saniye** geçersizleşir ve uygulama düşer.

Bu yüzden:

- Bu komut **yalnız planlı bir bakım penceresinde**, uygulama **durdurulmuşken** ([stop.md](stop.md)) çalıştırılır.
- Doğrulama kapıları ve tatbikatlar bu komutu bilinçli olarak **çağırmaz**.

---

## PURPOSE

Dört sınıf kimlik bilgisini, sistemi kırmadan değiştirmek:

| # | Kimlik | Nerede tutulur | Etki alanı |
|---|---|---|---|
| 1 | **DB owner parolası** (`postgres`) | `.env.local` → `MIGRATION_DATABASE_URL` | Yerel PostgreSQL 16 kümesi geneli |
| 2 | **App DB parolası** (`mas_radar_app`) | `.env.local` → `DATABASE_URL` | **Yerel PostgreSQL 16 kümesi geneli** |
| 3 | **Kullanıcı oturumları** (session) | Veritabanı: `public.sessions` | Uygulama genelinde tüm aktif oturumlar |
| 4 | **Entegrasyon & bildirim anahtarları** | `.env.local` | Paraşüt API v4 OAuth, Telegram, E-posta, OpenAI |

Her biri için sıra aynıdır: **rotate → restart → smoke → rollback (gerekirse)**.

---

## PRECONDITIONS

| # | Koşul | Nasıl doğrulanır |
|---|---|---|
| 1 | **Planlı bakım penceresi** — kullanıcılara haber verildi | — |
| 2 | Güncel ve **geri yüklenebilir** yedek var | `pnpm backup:offdevice:verify` ([backup.md](backup.md)) |
| 3 | Uygulama durduruldu ve `MAS-Background-Worker` duraklatıldı | [stop.md](stop.md) — `/ready` cevap vermiyor |
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

# 2) Owner bağlantısını kabuğa alın (değeri EKRANA YAZMAZ)
$env:MIGRATION_DATABASE_URL = ((Select-String -Path .env.local -Pattern '^MIGRATION_DATABASE_URL=' |
  Select-Object -First 1).Line -replace '^MIGRATION_DATABASE_URL=','')

# 3) ROTATE — parolayı MASKELİ olarak sorar
pnpm db:app-role:password
Remove-Item Env:MIGRATION_DATABASE_URL -ErrorAction SilentlyContinue
```

> **Parola komut satırı argümanı olarak KABUL EDİLMEZ.** Argümanlar kabuk geçmişinde ve Görev Yöneticisi süreç listesinde görünür.

```powershell
# 4) .env.local içindeki DATABASE_URL satırındaki parolayı YENİSİYLE güncelleyin (ve MAS_LOCAL_PASSWORDLESS=0 olduğundan emin olun).

# 5) RESTART
pnpm start            # docs/ops/start.md

# 6) SMOKE — üç kanıt (başka bir pencerede)
curl.exe -s http://127.0.0.1:3000/health
$env:DATABASE_URL = ((Select-String -Path .env.local -Pattern '^DATABASE_URL=' |
  Select-Object -First 1).Line -replace '^DATABASE_URL=','')
pnpm db:roles:verify
Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue
```

### Sınıf 1 — `postgres` (owner) parolası

Parolayı komuta yazmayın; yerel `psql.exe`'nin kendi maskeli `\password` komutunu kullanın:

```powershell
$u = [Uri]((Select-String -Path .env.local -Pattern '^MIGRATION_DATABASE_URL=' | Select-Object -First 1).Line -replace '^MIGRATION_DATABASE_URL=','').Trim().Trim('"')
$env:PGPASSWORD = [Uri]::UnescapeDataString(($u.UserInfo -split ':',2)[1])
try {
  & C:\MAS\pgsql16\bin\psql.exe -h 127.0.0.1 -p 5432 -U postgres -d postgres
} finally {
  Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
}
```

Açılan `postgres=#` isteminde:

```text
\password postgres
```

İki kez sorar, hiçbirini ekrana yazmaz (`scram-sha-256` özeti üretir). Sonra `\q` ile çıkın ve `.env.local` içindeki `MIGRATION_DATABASE_URL` satırındaki parolayı güncelleyin.

### Sınıf 3 — bütün oturumları iptal et (session rotasyonu)

Bir hesabın ele geçirildiğinden şüpheleniliyorsa ya da toplu çıkış gerekiyorsa:

```powershell
$u = [Uri]((Select-String -Path .env.local -Pattern '^MIGRATION_DATABASE_URL=' | Select-Object -First 1).Line -replace '^MIGRATION_DATABASE_URL=','').Trim().Trim('"')
$env:PGPASSWORD = [Uri]::UnescapeDataString(($u.UserInfo -split ':',2)[1])
try {
  & C:\MAS\pgsql16\bin\psql.exe -h 127.0.0.1 -p 5432 -U postgres -d mas_radar_dev -c "update public.sessions set revoked_at = now() where revoked_at is null;"
} finally {
  Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
}
```

Herkes yeniden giriş yapar. **Tek bir kullanıcı** için bu gerekmez — o hesabı `/system/security` üzerinden pasifleştirmek veya parolasını sıfırlamak zaten oturumlarını iptal eder ([role-change.md](role-change.md)).

### Sınıf 4 — entegrasyon ve bildirim anahtarları

`.env.local` içinde:

```text
PARASUT_CLIENT_ID / PARASUT_CLIENT_SECRET / PARASUT_COMPANY_ID   Paraşüt API v4 salt-okunur OAuth2 kimlikleri
TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID                            Telegram alarm & bildirim kanalı
EMAIL_API_URL / EMAIL_API_KEY / EMAIL_TO                         E-posta alarm & hatırlatma kanalı
OPENAI_API_KEY                                                   İsteğe bağlı AI yorum katmanı (varsayılan kapalı devre: AI_FORCE_DETERMINISTIC=1)
```

Sıra: sağlayıcı panelinden **yeni anahtar üret** → `.env.local`'i güncelle → `pnpm start` (ve gerekirse `MAS-Background-Worker` görevini yeniden çalıştır: `pnpm ops:worker:once`) → duman testi. Eski anahtarı **yeni anahtar çalıştığı doğrulandıktan sonra** iptal edin.

---

## EXPECTED

```text
pnpm db:app-role:password ->  rolün parolası güncellendi, exit 0 (parola EKRANA YAZILMAZ)
/health                   ->  {"status":"ok","app":"up","db":"up",...}
pnpm db:roles:verify      ->  Hedef: db=mas_radar_dev user=mas_radar_app
                              8/8 kontrol geçti.          (exit 0)
uygulamaya giriş          ->  mevcut kullanıcılar giriş yapabiliyor
```

Oturum iptalinin kanıtı (yalnız okuma):

```powershell
$u = [Uri]((Select-String -Path .env.local -Pattern '^MIGRATION_DATABASE_URL=' | Select-Object -First 1).Line -replace '^MIGRATION_DATABASE_URL=','').Trim().Trim('"')
$env:PGPASSWORD = [Uri]::UnescapeDataString(($u.UserInfo -split ':',2)[1])
try {
  & C:\MAS\pgsql16\bin\psql.exe -h 127.0.0.1 -p 5432 -U postgres -d mas_radar_dev -t -A -c "SET default_transaction_read_only = on; select count(*) from public.sessions where revoked_at is null and expires_at > now();"
} finally {
  Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
}
```

**Beklenen (iptal sonrası, kimse giriş yapmadan önce):** `0`.

---

## FAILURE SIGNALS

| Belirti | Anlamı | Ne yapılır |
|---|---|---|
| `password authentication failed for user "mas_radar_app"` | `.env.local` eski parolayı taşıyor | `DATABASE_URL` satırını güncelleyin |
| Uygulama başlıyor ama `/health` `"db":"down"` | Aynı sebep | `DATABASE_URL` satırını kontrol edin |
| `roles:verify` → `db=` beklenmedik | Kabukta bayat değişken | `pnpm db:env:source`, yeni pencere açın |
| `\password` sonrası yedek/telemetri görevleri düştü | `MIGRATION_DATABASE_URL` eski | `.env.local` içinde `MIGRATION_DATABASE_URL` satırını güncelleyin |
| Parola terminalde göründü | **Sır sızıntısı** | Pencereyi kapatın, geçmişi temizleyin, parolayı **tekrar** döndürün |

---

## STOP CONDITION

1. Uygulama **çalışırken** `pnpm db:app-role:password` çalıştırmak üzereyseniz → **DURUN.**
2. Güncel yedek yoksa → önce [backup.md](backup.md).
3. `.env.local`'in yedek kopyası yoksa → önce alın.
4. Parola bir komut satırı argümanına yazıldıysa → o parolayı kullanmayın, yenisini üretin.

---

## ROLLBACK

- **Sınıf 1 ve 2:** Eski parolayı geri koymak yerine bilinen parolayla aynı prosedürü yeniden çalıştırıp `.env.local` dosyasını eşleştirin.
- **Sınıf 3:** İptal edilen oturum geri getirilmez; kullanıcılar yeniden giriş yapar.
- **Sınıf 4:** Eski anahtar henüz iptal edilmediyse `.env.local` içine geri yazıp `pnpm start` çalıştırın.

---

## EVIDENCE

```text
tarih/saat            :
pencere türü          :  planlı bakım / acil (sızıntı şüphesi)
döndürülen sınıf      :  1 / 2 / 3 / 4
uygulama durduruldu mu:  EVET  (kanıt: /ready cevapsız)
.env.local güncellendi:  EVET
smoke /health         :
smoke roles:verify    :  Hedef: db=mas_radar_dev user=mas_radar_app · 8/8 kontrol geçti
```

---

## SECRET HANDLING

- **Parola argüman olarak verilmez.** İki meşru kanal vardır: süreç ortam değişkeni ya da maskeli soru. Ortam değişkeni kullandıysanız hemen temizleyin:
  ```powershell
  Remove-Item Env:MAS_RADAR_APP_DB_PASSWORD -ErrorAction SilentlyContinue
  Remove-Item Env:SEED_ADMIN_PASSWORD -ErrorAction SilentlyContinue
  Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
  ```
- `.env.local` `.gitignore`'dadır; asla commit edilmez, ekran görüntüsü alınmaz.
