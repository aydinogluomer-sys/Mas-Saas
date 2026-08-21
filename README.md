# MAS Nakit Radar

MAS'ın kendi finans ve operasyon verisini izlediği **özel, tek şirketlik iç kontrol paneli**.
Kamuya açık bir ürün değil: çok kiracılı yapı, abonelik/faturalama, deneme akışı, müşteri
onboarding'i veya pazarlama sayfası yoktur ve eklenmez.

Takip ettiği başlıklar: düzenli ve tek seferlik ödemeler, vade günleri ve aylık ödeme takvimi,
aylık nakit akışı projeksiyonu (devir / gelir / gider / fark / kasa), çekler ve vade riski,
krediler ve finansman maliyeti, üretim kapasitesi ve maliyet modelleri, normal ve mesaili
üretim ekonomisi, veri kalitesi ve kaynak izlenebilirliği, günlük/haftalık/aylık özetler.

**Doğruluk kuralı:** İncelemeden geçmiş içe aktarımdan sonra doğruluk kaynağı veritabanıdır.
AI yalnızca yorum katmanıdır — hiçbir kaydı ödendi işaretleyemez, silemez, tutar veya vade
değiştiremez.

## Teknoloji yığını

Bu bölüm `package.json`'a bakılarak yazılmıştır; eski dokümanlarda geçen bazı araçlar bu
projede **kullanılmıyor**.

| Katman | Gerçekte kullanılan |
| --- | --- |
| Uygulama | Next.js 15.5.20 (App Router), React 19.1.0, TypeScript strict |
| Veritabanı | Yerel Docker PostgreSQL 16 — ham `pg` sürücüsü (8.x) |
| Doğrulama | Zod 4 (sınırlarda) |
| Tablolar | TanStack Table 8 |
| Arayüz | Radix primitifleri + projeye özel bileşenler, Tailwind v4, Geist, sonner |
| Excel | `xlsx` + `exceljs` |
| Parola | `@node-rs/argon2` (argon2id) |
| Paket yöneticisi | pnpm |

Kullanılmayanlar, karışıklık olmasın diye: **Supabase istemcisi yok** (`supabase/migrations/`
klasörü yalnızca SQL migration'larını tutar, bulut bağlantısı kurulmaz), **Recharts yok**,
**shadcn CLI yok** (UI primitifleri shadcn/Radix desenine göre elle yazıldı).

## Yerelde çalıştırma

```bash
pnpm install
cp .env.example .env.local     # sonra .env.local'i doldurun

docker compose up -d           # PostgreSQL 16, yalnız 127.0.0.1'e bağlı

pnpm db:verify                 # tam reset + migration'lar + seed + invariant assertion'ları
```

Veritabanı rolleri Faz 15'te ikiye ayrıldı; ilk kurulumda bir kez:

```bash
# 1) Düşük yetkili uygulama rolüne parola ver (migration 0035 rolü NOLOGIN yaratır).
#    Parolayı MAS_RADAR_APP_DB_PASSWORD'den okur, yoksa maskeli sorar; asla loglamaz.
pnpm db:app-role:password

# 2) Aynı parolayı .env.local içindeki DATABASE_URL'e yazın (mas_radar_app rolüyle).
# 3) Bağlantının gerçekten düşük yetkili olduğunu kanıtlayın:
pnpm db:roles:verify
```

İlk yönetici hesabı (uygulamada açık kayıt yoktur, bilinçli olarak):

```bash
tsx scripts/db/seed-admin.ts --username admin --display-name "Admin"
```

Sonra:

```bash
pnpm dev
```

## Kalite kapısı

Faz sonu kapısının tam komut zinciri `implementation.md` → *"Commit ve Gate Kurali"*
bölümündedir. Özet: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm db:verify`,
`pnpm db:roles:verify`, `pnpm import:real`, faz doğrulama script'leri, `pnpm build`.

## Dokümanlar

- **`implementation.md`** — faz faz yol haritası ve her fazın teslimat/gate tanımı. Bir faza
  başlamadan önce okunacak kaynak budur.
- **`docs/status-notes.md`** — fiilen ne yapıldığının kaydı: tamamlanan fazlar, doğrulama
  çıktıları, veri temizliği işlemleri ve kullanıcı eylemi bekleyen maddeler.
- **`docs/database-schema.md`**, **`docs/data-map.md`**, **`docs/todo.md`** — şema, kaynak
  veri eşlemesi ve açık işler.

## Güvenlik

- Depo **private**'dır ve öyle kalmalıdır: gerçek finansal iş mantığını ve operasyon
  dokümanlarını taşır.
- Sırlar **yalnızca ortam değişkenlerinde** tutulur. Depoda hiçbir parola, token veya API
  anahtarı bulunmaz; `.env.local` asla commit edilmez (`.gitignore` tüm `.env*` dosyalarını
  engeller). `.env.example` yalnızca boş şablondur.
- Uygulama veritabanına `mas_radar_app` rolüyle bağlanır — `NOSUPERUSER`, `NOBYPASSRLS`.
  Şema değiştiren script'ler ayrı bir owner bağlantısı (`MIGRATION_DATABASE_URL`) kullanır.
- PostgreSQL yalnız `127.0.0.1`'e bağlıdır; ağdan erişilebilir değildir.
