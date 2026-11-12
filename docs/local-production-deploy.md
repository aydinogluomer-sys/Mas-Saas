# MAS Nakit Radar — Yerel Özel Üretim Kurulum ve İşletim Mimari Rehberi

Tek makine, geri döngü (`loopback`, `127.0.0.1`) odaklı, kapalı devre **CFO & Hazine İş İstasyonu** kurulum rehberi.
MAS Nakit Radar çok-kiracılı genel bir bulut SaaS uygulaması **değildir**; gerçek finansal veriler varsayılan olarak bu makineden dışarı çıkmaz.

---

## 0. Ön Koşullar ve Kanonik Mimari

- **İşletim Sistemi:** Windows 10/11 (PowerShell 5.1+)
- **Veritabanı:** Yerel **PostgreSQL 16** (`C:\MAS\pgsql16\bin`, veri dizini `C:\MAS\pgdata16`, port `127.0.0.1:5432`, Windows hizmeti `MAS-PostgreSQL16` veya `postgresql-x64-16`) — kurulum için bkz. [ops/postgres-service.md](ops/postgres-service.md)
- **Çalışma Zamanı:** Node.js `>= 22.0.0` + `pnpm@11.10.0`
- **Excel Motoru:** Yalnız sunucu tarafı `exceljs` + RFC-4180 CSV (`xlsx` paketi güvenlik zafiyetleri nedeniyle tamamen kaldırılmıştır)
- **Kanonik Şema Sürümü:** Migration **`0113`** (`supabase/migrations/0001..0113`, `113` migration, `106` `public` tablo `%100` RLS etkin, `87` `public` görünüm `%100` `security_invoker = true`)

---

## 1. Ortam Değişkenleri (`.env.local`)

```powershell
Copy-Item .env.example .env.local   # ardından .env.local dosyasını düzenleyin
pnpm exec tsx scripts/deploy/check-env.ts   # varlık ve biçim kontrolü yapar, sırları ekrana basmaz
pnpm db:env:source                          # kabukta gölgeleme olmadığını doğrular
```

Temel ortam değişkenleri:

| Değişken | Zorunlu | Amaç |
|---|---|---|
| `DATABASE_URL` | Evet | Uygulama çalışma zamanı düşük yetkili (`mas_radar_app`) yerel PostgreSQL 16 bağlantısı (`127.0.0.1:5432/mas_radar_dev`) |
| `MIGRATION_DATABASE_URL` | Evet | Yalnız `pnpm db:migrate`, yedekleme ve telemetri araçlarının kullandığı owner (`postgres`) bağlantısı |
| `MAS_PG_BIN_DIR` | Evet | Yerel PostgreSQL 16 ikili dizini (`C:\MAS\pgsql16\bin`) |
| `MAS_LOCAL_PASSWORDLESS` | Evet (`0`) | Üretim kilidi: canlı kullanımda **`0`** olmalıdır. `NODE_ENV=production` iken parolasız giriş donanımsal olarak reddedilir ve geliştirme modunda dahi yalnız loopback `Host` başlığında çalışır |
| `MAS_OFFDEVICE_BACKUP_DIR` | Önerilen | Günlük yedeğin doğrulanmış ikinci kopyasının yazılacağı fiziksel harici disk veya NAS dizini (örn. `E:\mas-yedek` veya `\\nas\mas-yedek`) |
| `AI_FORCE_DETERMINISTIC` | Varsayılan `1` | Kapalı devre kuralı: `1` iken dış LLM çağrısı yapılmaz, tüm brifing ve analizler deterministik motorlarla üretilir |
| `PARASUT_CLIENT_ID` / `PARASUT_CLIENT_SECRET` / `PARASUT_COMPANY_ID` | İsteğe bağlı | Paraşüt API v4 salt-okunur OAuth2 bağlantısı |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | İsteğe bağlı | Sunucu tarafı alarm/hatırlatma teslimatı ve dışarı-doğru (`outbound`) TypeScript Telegram işçisi |
| `MAS_QA_BYPASS_AUTH` | Hayır | Yalnız izole QA koşumu içindir; `NODE_ENV=production` altında yoksayılır |

`.env.local`, `data/`, `logs/` ve `backups/` dizinleri `.gitignore` kapsamındadır — asla git'e eklenmez.

---

## 2. Başlatma, Şema Geçişi ve Arka Plan İşçisi

Ayrıntılı operatör adımları için: [ops/start.md](ops/start.md) ve [ops/stop.md](ops/stop.md).

```powershell
cd "C:\Users\Trade Bilisim\Mas Saas"

# 1) Yerel PostgreSQL 16 hizmetinin hazır olduğunu doğrula
pnpm db:ensure

# 2) Bekleyen migration varsa uygula (ön-yedek otomatik alınır; kanonik sürüm: 0113)
pnpm db:migrate

# 3) İlk yönetici hesabını oluştur (yalnız ilk kurulumda; parola maskeli sorulur)
pnpm exec tsx scripts/db/seed-admin.ts --username admin --display-name "Sistem Yöneticisi" --role admin

# 4) Üretim derlemesini al ve sunucuyu başlat (http://127.0.0.1:3000)
pnpm build
pnpm start
```

Durdurmak için `pnpm start` penceresinde **Ctrl-C** yapın veya [ops/stop.md](ops/stop.md) Yol 2'yi izleyin.

### Windows Görev Zamanlayıcı Otomasyon Görevleri

Sistem hiçbir Python yan sürecine ihtiyaç duymaz; tüm otomasyon TypeScript işçileri ve Windows Görev Zamanlayıcı üzerinden yürür:

1. **`MAS-Background-Worker` (`pnpm ops:worker:schedule`):**
   - `scripts/ops/background-worker.ts` sürecini çalıştırır; asenkron içe aktarma işlerini (`background_jobs`) ve kapalı çevrim günlük finansal otomasyon hattını (`runClosedLoopFinancialPipeline`: Paraşüt v4 → TCMB Kur → TDHP Yönetim Defteri → 13-Hafta Tahmin Dondurma) yürütür.
   - Durum kontrolü: `Get-ScheduledTask -TaskName "MAS-Background-Worker"` veya `pnpm ops:worker:schedule status`.
2. **`MAS-Nakit-Radar-Gunluk-Yedek` (`pnpm ops:backup:schedule`):**
   - Her gece `03:00`'te (`StartWhenAvailable` telafili) `pnpm ops:backup:daily` çalıştırır ([ops/backup-schedule.md](ops/backup-schedule.md)).
3. **`MAS-Nakit-Radar-Telemetri-Gozetim` (`pnpm ops:telemetry:schedule`):**
   - 6 saatte bir 21 sağlık sinyalini, yedek yaşını ve kuyruk sağlığını denetleyip `logs/alerts.jsonl` (ve açıksa Telegram/e-posta) kanalına yazar ([ops/telemetry-alerting.md](ops/telemetry-alerting.md)).
4. **İsteğe Bağlı Telegram Asistan İşçisi (`pnpm ops:telegram:worker`):**
   - Eski Python `bot.py` betiği ve çerezsiz `/api/telegram/assistant` HTTP ucu tamamen emekliye ayrılmıştır. İsteğe bağlı Telegram sorgulama işçisi (`scripts/ops/telegram-assistant-worker.ts`) doğrudan TypeScript ile dışarı-doğru (`outbound long-polling`) çalışır; dış dünyaya açık hiçbir HTTP kapısı açmaz.

---

## 3. Veri İçe Aktarım ve Günlük İşleyiş

- **Standart V2 Excel & Banka Ekstresi İçe Aktarım (`/data/imports/v2`, `/finance/bank`):** Dosya önce önizlenir; formül hataları (`#REF!`, `#DIV/0!`) ve birleştirilmiş hücreler yakalanır, yalnız onaylanan temiz kayıtlar aktarılır. MT940, ISO 20022 `camt.053` ve Paraşüt API v4 banka hareketleri `cross_channel_dedupe_hash` ile tekilleştirilir.
- **Hazine ve Açılış Bakiyesi (`/finance/treasury`):** Aktif kasa/banka hesaplarının gerçek açılış bakiyesi ve açılış tarihi girildiğinde otomatik `100/102 ↔ 500.99` TDHP yönetim defteri açılış fişi kesilir (`FIN-03`).
- **13 Haftalık Tahmin, Raporlar ve Senaryolar (`/cashflow/13-week`, `/reports`, `/scenarios`):** Deterministik nakit projeksiyonu, zamanlama kayması vs. kalıcı varyans şelalesi ve kur/başabaş stres testleri kaynak kayıtları değiştirmeden çalışır.

---

## 4. Sağlık, Yedekleme ve Doğrulama Kapıları

- **Sağlık uçları:** `GET /health`, `GET /ready`, `GET /version` (hiçbir sır veya finansal veri yaymaz).
- **Günlük yedek ve harici yedek doğrulama:**
  ```powershell
  pnpm ops:backup:daily
  pnpm backup:offdevice:verify
  pnpm release:restore-drill
  ```
- **Tam doğrulama kapıları:**
  ```powershell
  pnpm lint && pnpm typecheck && pnpm test
  pnpm db:roles:verify
  pnpm db:roles-rls:verify
  pnpm boundary:verify
  pnpm phase17:verify && pnpm phase18:verify
  pnpm build
  ```

---

## 5. Güvenlik Duruşu (Yerel Özel Üretim)

- **Yalnız Geri Döngü (`127.0.0.1` / `::1`) Veritabanı:** Yerel PostgreSQL 16 dış ağ arayüzlerini dinlemez ve `scram-sha-256` kimlik doğrulaması zorunludur.
- **Sıfır Çerezsiz API Muafiyeti:** `src/middleware.ts` varsayılan-ret (`default-deny`) politikasıyla `/login`, `/health`, `/ready`, `/version` ve statik varlıklar dışındaki her rotayı korur; çerezsiz hiçbir `/api/*` muafiyeti yoktur.
- **`MAS_LOCAL_PASSWORDLESS=0` Üretim Kilidi:** `NODE_ENV === "production"` altında parolasız yerel giriş kesin olarak devre dışıdır; `public.users` üzerinde Argon2id parola özetleri, SHA-256 oturum belirteçleri ve 5 hatalı girişte 15 dakika kilit uygulanır.
- **Çok Katmanlı RBAC + `%100` RLS + `%100` `security_invoker`:**
  - `80/80` dashboard sayfasında `requireRouteAccess`, tüm Server Action ve yazan API rotalarında `requireSession` / rol kapısı + `checkOrigin()` yapısal testlerle (`tests/security/write-gates.test.ts`, `tests/security/route-page-rbac.test.ts`) zorlanır.
  - Veritabanı çekirdeğinde `106/106` `public` tabloda RLS ve `87/87` `public` görünümde `WITH (security_invoker = true)` aktiftir; her bağlantıda `SET LOCAL ROLE`, `statement_timeout = '15s'` ve `lock_timeout = '5s'` uygulanır.
- **Kontrollü Tek-Operatör 4-Göz Yönetişimi ve Arşivden Çıkarma (`0109`):**
  - Çok kullanıcılı modda oluşturucu ve onaylayıcı farklı olmak zorundadır (`approver_id <> requested_by`). Tek-operatör/CFO istasyonu modunda yalnız açık politika anahtarı ve en az 12 karakterlik zorunlu gerekçeyle `decision = 'self_approved_override'` olarak ayrı denetim iziyle kaydedilir.
  - Arşivlenen finansal kayıtlar yalnız işlem-yerel `app.allow_archive_restore = 'true'` GUC kilidi, yetkili rol ve zorunlu gerekçeyle geri alınabilir (`audit_logs` iziyle).
