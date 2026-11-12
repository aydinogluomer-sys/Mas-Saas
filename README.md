# MAS Nakit Radar

MAS'ın kendi finans ve operasyon verisini izlediği **özel, tek şirketlik CFO iç kontrol istasyonu** (sıcak-krem editoryal arayüz, yerel Windows mimarisi).
Kamuya açık bir ürün değildir: çok kiracılı yapı, abonelik/faturalama, deneme akışı, müşteri onboarding'i veya pazarlama sayfası yoktur ve eklenmez.

Takip ettiği başlıca modüller:
- Günlük ve haftalık **Ödeme Radarı**, tek seferlik/düzenli ödeme örnekleri, onay kuralları (`4-göz` + tek-operatör gerekçeli yönetişim) ve `pain.001` / EFT ödeme paketleri (`payment_runs`),
- **13 Haftalık Dönen Likidite Projeksiyonu** (`KDV_1`, `KDV_2` tevkifat, muhtasar, SGK, kur/vade sapma şelalesi) ve **36 Aylık Nakit Akışı**,
- **Hazine & Banka Mutabakatı** (`FIN-03` açılış bakiyesi + `500.99` denkleştirme köprüsü, MT940/`camt.053` ekstre içe aktarma, esnek `±90 gün` + manuel fatura/çek/kredi eşleştirme),
- **Çek/Senet Bordrosu**, kredi/limit takibi, DSCR ve kovenant erken uyarı radarı,
- **Paraşüt API v4 Salt-Okunur Entegrasyonu** (`runClosedLoopFinancialPipeline` kapalı çevrim senkronizasyonu),
- **Çift Taraflı TDHP Yönetim Defteri** (`management_ledger_*`, mizan, yönetim bilançosu, gelir tablosu, EBITDA, otomatik storno ve geçici kur değerleme) ve **SMMM Yasal Mizan Mutabakat Köprüsü**,
- **Üretim Kapasite, Maliyet & Kârlılık Analitiği** (TDHP `7xx` fiili gider ↔ tezgâh `TL/dk` canlı başabaş köprüsü), veri kalitesi merkezi ve deterministik sabah brifingi.

**Doğruluk kuralı:** İncelemeden geçmiş içe aktarımdan sonra tek doğruluk kaynağı yerel PostgreSQL 16 veritabanıdır (`mas_radar_dev`, kanonik şema **`0113`**). AI yalnızca deterministik gerçekleri (`DecisionFacts`) açıklayan yorum katmanıdır — hiçbir kaydı ödendi işaretleyemez, silemez, tutar veya vade değiştiremez (`AI_FORCE_DETERMINISTIC=1` kapalı devre varsayılanı).

## Teknoloji yığını ve mimari özet (`Migration 0113`)

Bu bölüm `package.json` ve canlı şema (`0001..0113`) baz alınarak yazılmıştır; eski dokümanlarda geçen bazı araçlar bu projede **kullanılmamaktadır**.

| Katman | Gerçekte kullanılan |
| --- | --- |
| Uygulama | Next.js 15.5.20 (App Router), React 19.1.0, TypeScript strict |
| Veritabanı | Yerel Windows PostgreSQL 16 (`postgresql-x64-16` / `MAS-PostgreSQL16`, yalnız `127.0.0.1`/`::1`) — ham `pg` sürücüsü (8.x), `113` migration (`0001..0113`), `106` `public` tablo (`%100` RLS) + `87` `public` görünüm (`%100` `security_invoker = true`) |
| Kesin Para Aritmetiği | PostgreSQL `numeric(p,s)` + TypeScript `big.js` (`float8` / JS `Number` para hesabı yasak) |
| Doğrulama | Zod 4 (`src/lib/validation/` sınır doğrulaması) |
| Tablolar & Arayüz | TanStack Table 8, Radix primitifleri + sıcak-krem (`warm editorial paper`) CFO bileşen sistemi, Tailwind v4, Geist, `sonner` |
| Excel & Dışa Aktarım | `exceljs` + RFC-4180 CSV / `pain.001` XML (`xlsx` paketi güvenlik nedeniyle tamamen kaldırılmıştır) |
| Parola & Kimlik | `@node-rs/argon2` (`argon2id`), 5 katmanlı DB rolü (`viewer`..`admin`), `MAS_LOCAL_PASSWORDLESS=0` üretim kilidi |
| Arka Plan İşçileri | Saf TypeScript + Windows Görev Zamanlayıcı (`MAS-Background-Worker`, günlük yedek ve telemetri görevleri; Python `bot.py` kullanılmaz) |
| Paket yöneticisi | `pnpm` |

Kullanılmayanlar, karışıklık olmasın diye: **Supabase bulut istemcisi yok** (`supabase/migrations/` klasörü yalnızca sıralı SQL migration dosyalarını tutar, dış bulut bağlantısı kurulmaz), **Docker çalışma zamanı yok** (PostgreSQL 16 doğrudan yerel Windows servisi olarak çalışır), **`xlsx` paketi yok** (`exceljs` kullanılır), **Python yan süreci yok**.

## Yerelde çalıştırma

```powershell
pnpm install
Copy-Item .env.example .env.local   # 127.0.0.1 DB URL'lerini ve MAS_PG_BIN_DIR yolunu doldurun

# PostgreSQL 16 bu makinede yerel Windows hizmeti olarak çalışır; Docker kullanılmaz.
# Kurulum, başlatma/durdurma ve sorun giderme: docs/ops/postgres-service.md
pnpm db:ensure                      # salt-okunur yoklama: küme hazır mı, değilse ne yapılacağı
```

`pnpm db:verify` ve tek kullanımlık veritabanı yaratan doğrulama paketleri yalnızca harcanabilir (`*_verify`, `*_test`, `*_clone`) veritabanlarında koşar; canlı `mas_radar_dev` kümesine test verisi yazılmaz.

Veritabanı rolleri ikiye ayrılmıştır (`mas_radar_owner` şema sahibi ve `mas_radar_app` düşük yetkili uygulama rolü); ilk kurulumda bir kez:

```powershell
# 1) Düşük yetkili uygulama rolüne parola ata (migration 0035 rolü NOLOGIN yaratır).
#    Parolayı MAS_RADAR_APP_DB_PASSWORD'den okur, yoksa maskeli sorar; asla loglamaz.
pnpm db:app-role:password

# 2) Aynı parolayı .env.local içindeki DATABASE_URL'e yazın (mas_radar_app rolüyle).
# 3) Kanonik şemayı (0001..0113) uygulayın ve rol/RLS izolasyonunu doğrulayın:
pnpm db:migrate
pnpm db:roles:verify
```

İlk yönetici hesabı (uygulamada açık self-servis kayıt yoktur):

```powershell
pnpm exec tsx scripts/db/seed-admin.ts --username admin --display-name "Admin"
```

Arka plan işçisi ve yedek doğrulaması:

```powershell
pnpm ops:worker:schedule            # MAS-Background-Worker Windows zamanlanmış görevini kur/güncelle
pnpm ops:backup:daily               # PG16 .dump + doküman kasası günlük yedeği
pnpm backup:offdevice:verify        # Yedek arşivinin pg_restore --list okunabilirlik ve tazelik kontrolü
```

Geliştirme veya yerel üretim sunucusu:

```powershell
pnpm dev                            # geliştirme modu
# veya yerel üretim modu:
pnpm build
pnpm start
```

## Kalite kapısı

Faz sonu kapısının tam komut zinciri `implementation.md` → *"Kalıcı Doğrulama Kapıları"* bölümündedir. Özet:
`pnpm lint`, `pnpm typecheck`, `pnpm phase17:verify`, `pnpm phase18:verify`, `pnpm boundary:verify`, `pnpm test`, `pnpm db:roles-rls:verify`, `pnpm db:constraints:verify`, `pnpm db:transitions:verify`, `pnpm backup:offdevice:verify`, `pnpm build`.

## Dokümanlar

- **`implementation.md`** — Faz 1'den Faz 59'a (`0113`) kadar kanonik mühendislik yol haritası ve kabul kapıları.
- **`docs/database-schema.md`** — `0001..0113` kanonik şema, `106` `public` tablo, `87` `security_invoker` görünüm ve RLS mimarisi.
- **`docs/calculation-rules.md`** — Deterministik finansal hesaplama, 13-hafta likidite, TDHP yönetim defteri ve kovenant kuralları.
- **`docs/local-production-deploy.md`** ve **`docs/ops/*.md`** — Yerel Windows PostgreSQL 16 dağıtım, yedekleme, geri yükleme ve operasyon runbook'ları.
- **`docs/risk-register.md`**, **`docs/MAS_360_SYNTHESIS_REPORT.md`**, **`docs/todo.md`** — Güvenlik/operasyon risk kaydı, 360° denetim kapanış matrisi (`115/115`) ve görev sicili.

## Güvenlik

- Depo **private**'dır ve öyle kalmalıdır: gerçek finansal iş mantığını ve operasyon dokümanlarını taşır.
- Sırlar **yalnızca ortam değişkenlerinde** tutulur. Depoda hiçbir parola, token veya API anahtarı bulunmaz; `.env.local` ve düz metin `.env*.bak*` kopyaları asla tutulamaz (`scripts/check-env.ts` kapısı).
- Üretim ortamında `MAS_LOCAL_PASSWORDLESS=0` zorunludur; `80/80` dashboard sayfası `requireRouteAccess` RBAC kalkanıyla korunur.
- Uygulama veritabanına `mas_radar_app` rolüyle bağlanır (`NOSUPERUSER`, `NOBYPASSRLS`) ve işlem bazında 5 katmanlı RLS rolüne düşer. Şema değiştiren script'ler ayrı owner bağlantısı (`MIGRATION_DATABASE_URL`) kullanır.
- PostgreSQL yalnız `127.0.0.1` / `::1` loopback arayüzünü dinler; dış ağa kapalıdır.
