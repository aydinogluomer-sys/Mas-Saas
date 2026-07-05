# Status Notes

## Phase 0 — DONE
- Next.js 15 + TS strict + Tailwind + ESLint scaffold (pnpm), src-dir, App Router.
- Parser spike (`src/lib/importers/workbook-parser.ts` + `scripts/parse-spike.ts`): signature-guarded safe open; TR-normalized ad tabanlı sınıflandırıcı, DB enum'larıyla birebir.
- Evidence: `docs/phase0-parse-report.md` — orijinal 42 sekme / TEMİZ 43 sekme tam sınıflı, sıfır sessiz atlama; bozuk TEMİZ-4 imza hatasıyla belgeli.
- Docs: import-mapping.md + calculation-rules.md yazıldı; data-map.md v3 kanıt-tabanlı yeniden yazıldı; risk-register ortam riskleri eklendi.
- QA gate: typecheck ✓ · lint ✓ · vitest 23/23 ✓.
- Not: todo.md'deki "source_* migrations" maddesi implementation.md §20'ye göre Faz 1 teslimatıdır; Faz 1'e taşındı (kaynak-of-truth: implementation.md).
- Not: exceljs kuruldu, Faz 2'de formül/stil çıkarımı için ayrılmıştır; spike xlsx ile yeterli.

## Phase 1 — DONE
- Migrations 0001–0007 + seed.sql (Supabase-uyumlu; implementation.md §8-13 DDL birebir + belgelenmiş sertleştirmeler).
- Doğrulama GERÇEK PostgreSQL 16'da: `pnpm db:verify` → tam reset ×2, tümü PASS (payment_due_rule, paid⇒paid_at, null-tutar-null-kalır, idempotency, ay-normalizasyonu, çek işaret tutarlılığı, reminder duplicate önleme, RLS+policy tüm tablolarda, taksit paid⇒paid_at).
- Tipler canlı doğrulanmış şemadan üretildi: src/types/database.ts (22 tablo, Row+Insert).
- **Supabase MCP durumu:** kimlik doğrulandı, erişim ÇALIŞIYOR; hesapta 4 proje var (Mas Technic Site, Y Project, Alışkanlık Uygulaması, yasama-sanati) — hiçbiri bu uygulamaya ait değil. İlgisiz canlı projeye şema yazmamak ve yeni proje maliyet onayı platform gereği kullanıcıdan geçtiği için **bulut uygulaması bilinçli ertelendi**. AÇIK KARAR: hedef proje seçimi (mevcut birini belirt YA DA yeni proje onayı) → seçilince `Supabase:apply_migration` ile 0001-0007+seed tek adımda uygulanır. Durdurma koşulu OLUŞMADI: veritabanı erişimi lokal PG ile gerçek ve tam.
- ESLint scripts/ üzerinde de temiz; pg sadece devDependency (tip üretimi).

## Next — Phase 2 slice plan (mas-implementation-slicer)
Smallest vertical slice: (1) Supabase client util'leri (@supabase/ssr, env şablonu .env.example), (2) /imports upload ekranı → source_workbooks+sheets+cells+import_rows yazan importer (Phase-0 parser'ı üstüne cell-preservation katmanı, exceljs ile formüller), (3) /imports/[id] sheet listesi + tip rozetleri, (4) raw row viewer, (5) mapping_reviews tablosu UI, (6) üç extraction preview (payment matrix / monthly cashflow / checks) — hepsi read-only staging; final tablolara yazım yok. Test: importer birim (cell sayısı korunumu, hash), preview extractors birim; UI vitest+testing-library.

## Phase 2 — DONE
- Staging importer: source_workbooks→sheets→cells→import_rows→mapping_reviews, transactional; hücre korunumu muhasebeli (iterated==inserted). Nihai domain tablolarına SIFIR yazım.
- Gerçek-dosya doğrulaması (`pnpm import:real`): TEMİZ 43 sekme / 9.817 hücre / 1.601 satır / 58 review; bozuk TEMİZ-4 → status=failed + imza hatası, kısmi satır yok; bilinen anomaliler spot-check PASS (TİJEN −60k, AG25 etiketsiz, PRONET günsüz, 4× çek çift-kayıt); TEMİZ'de cashflow kimlik uyuşmazlığı 0.
- **Gerçeklik düzeltmesi:** ÇEKLER'de KİMDEN sütunu fiilen boş; çift-kayıt kuralı KİME+|tutar|+±3gün ve TR-normalize (çağdaş/ÇAĞDAŞ) olarak spec+kod+testte güncellendi. Ham veri DB'ye girince varsayım yerine kanıtla düzeltildi.
- UI: /imports (liste+upload), /imports/[id] (meta+sekme rozetleri+failed yüzeyi), /sheets/[id] (ham görünüm + üç önizleme), /reviews (filtre+aksiyon+audit). shadcn CLI erişilemediği için rozet/panel primitifleri elle vendorlandı. Kök layout Google Fonts'tan arındırıldı (egress yok) → system stack.
- Ortam sertleştirme: PG daemon'ı oturumlar arası öldürülüyor → scripts/db/ensure.sh tüm DB scriptlerine ve dev'e bağlandı.
- Gate: lint ✓ typecheck ✓ vitest 45/45 ✓ db:verify(×2 reset) ✓ import:real ✓ production build ✓ E2E smoke (liste/detay/önizleme 200 + anomali render) ✓.

## Next — Phase 3 slice plan
(1) mapping action: accepted payment kandidayları → payments (kaynak izleriyle), (2) instance generator (idempotent, kısa-ay kuralı; unit-test önce), (3) risk engine (mas-payment-risk-engine kuralları; unit-test önce), (4) /radar dashboard (bugün/yarın/7g/geciken/eksik), (5) ödeme takvimi görünümü, (6) ödendi/kısmi işaretleme + audit. Gate: birim + gerçek-veri instance üretim doğrulaması + smoke.
