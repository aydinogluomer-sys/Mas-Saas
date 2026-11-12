# MAS Nakit Radar — Nihai Kanonik Uygulama Yol Haritası (v5)

> **Tek Gerçek Kaynak (`Single Source of Truth`):** Bu belge; `v2`, `v3`, `v4 (Faz 15–38)` ve `§17A (Dalga 0–5)` planlarının tüm çelişkilerini ortadan kaldıran, 2026-10-28 yönetici kararlarını, Wave 0 sağlamlaştırmasını, Performans Faz 1–10 kazanımlarını ve `docs/MAS_360_SYNTHESIS_REPORT.md` içindeki 115 kanıtlı denetim bulgusunu tek bir atomik, bağımlılık-sıralı mühendislik yol haritasında birleştiren **bağlayıcı uygulama rehberidir**.  
> **Derin Kanıt Referansı:** Tüm bulguların `dosya:satır` kanıtları, Paraşüt API v4 şema eşleştirmesi, Çift Taraflı Yönetim Defteri + Tekdüzen Hesap Planı (TDHP) mutabakat tasarımı ve 27 rakip incelemesi için bkz. `docs/MAS_360_SYNTHESIS_REPORT.md`.

---

## 0. Ürün Sınırı (`Product Boundary`), Yönetici Kararları ve Değişmez Yasalar

### 0.1 Ürün Tanımı

**MAS Nakit Radar**; MAS'ın gerçek operasyonel çalışma düzenini ve Excel/ön-muhasebe veri soykütüğünü kaybetmeden; günlük ödeme radarı, 13 haftalık ve 36 aylık nakit akış projeksiyonu, çek/senet bordrosu, kredi/limit/kovenant takibi, Paraşüt API v4 salt-okunur veri entegrasyonu, çift taraflı yönetim defteri (mizan, yönetim bilançosu, gelir tablosu, EBITDA), mali müşavir yasal mizan mutabakat köprüsü, üretim maliyet/kapasite analitiği ve deterministik CFO karar desteğine dönüştüren **kapalı devre, tek şirketli özel finans-operasyon kontrol panelidir**.

### 0.2 Ürün Kesinlikle Ne Değildir?

1. **Çok kiracılı (`multi-tenant`) genel SaaS ürünü değildir:** Abonelik, fiyatlandırma sayfası, Stripe/iyzico ödeme duvarı, dış müşteri self-servis kayıt akışı, pazarlama açılış sayfası veya pazaryeri inşa edilmez.
2. **Genel amaçlı tam ERP veya stok/MRP/bordro yazılımı değildir:** Ön-muhasebe ve e-Fatura/e-Arşiv verisinin birincil operasyonel giriş kaynağı **Paraşüt**'tür; MAS Paraşüt API v4 (ve yedek Excel/MT940/`camt.053` hattı) üzerinden veriyi **salt-okunur çeker**, Paraşüt'ün yerine fatura kesmez.
3. **Yasal defter / e-Defter / GİB beyanname yazılımı değildir:** Resmi yevmiye, kebir, e-Defter beratı ve vergi beyannameleri mali müşavirin sisteminde kalır. MAS içinde kurulan **Çift Taraflı Yönetim Defteri (Faz 52)** yönetim raporlaması (EBITDA, yönetim bilançosu, nakit-tahakkuk köprüsü) ve mali müşavirin yasal mizanıyla **otomatik fark tespiti (Faz 53)** içindir.
4. **AI muhasebeci veya kara-kutu ML tahmincisi değildir:** Yapay zekâ hiçbir zaman parasal tutar hesaplamaz, vade/tahsilat tarihi uydurmaz ve hiçbir finansal tabloya yazmaz. Tüm hesaplar deterministik TypeScript (`big.js`) ve PostgreSQL (`numeric`) üzerinde çalışır; AI yalnızca hesaplanmış deterministik gerçekleri (`DecisionFacts`) açıklar ve kapalı devre varsayılanında (`AI_FORCE_DETERMINISTIC=1`) tamamen yerel şablonla çalışır.
5. **Çok dilli yan süreç yığını değildir:** Uygulama ve tüm arka plan işçileri **yalnızca TypeScript + PostgreSQL 16 SQL** üzerinde çalışır (`bot.py` Python yan süreci ve `xlsx@0.18.5` paketi tamamen emekli edilir).

### 0.3 Değişmez Finansal, Güvenlik ve Mühendislik Yasaları

1. **`BLANK ≠ ZERO` (Bilinmeyen Asla Sıfır Sayılmaz):** `NULL` tutar, `NULL` açılış bakiyesi (`FIN-03`), `NULL` KDV kırılımı ve `NULL` döviz kuru **"bilinmiyor"** demektir; hiçbir SQL görünümünde veya TS motorunda `COALESCE(x, 0)` ya da `moneyOrNull(x) ?? 0` ile sessizce `0` veya kur `1.0` kabul edilemez. Bilinmeyen kalemler açıkça sayılır (`unknown_count`) ve toplamlarda eksik veri uyarısıyla görünür tutulur.
2. **`TRY-only` Ana Raporlama + Açık Döviz Kovaları (`USD`, `EUR`, `GBP`):** Farklı para birimleri kur çevrimi olmadan hiçbir tabloda, görünümde veya grafikte `SUM(amount)` ile toplanamaz. Birincil raporlama `TRY` bazındadır; yabancı para kalemler kendi döviz kovalarında (`native_currency`) ve varsa resmi TCMB kuru üzerinden açık kur tarihiyle (`rate_date`, `provisional_fx`) ayrı `TRY` karşılığıyla gösterilir.
3. **Sıfır Kayıplı Kuruş Aritmetiği (`numeric` + `big.js`):** Veritabanında tüm parasal kolonlar `numeric(p,s)` tipindedir (`float8`, `double precision`, `real` yasaktır). Uygulama kodunda SQL `::float8` dönüşümü ve parasal JS `Number` kayan nokta toplaması yasaktır (`pnpm phase17:verify` kalıcı kapısı).
4. **Bayrakla, Asla Sessiz Düzeltme (`Flag, Never Mutate`):** Süreklilik kopukluğu (`continuity_break`), vade/tutar uyuşmazlığı veya yönetim defteri ↔ mali müşavir mizan farkı tespit edildiğinde sistem rakamı sessizce ezmez; deterministik kök-neden koduyla bayraklar ve inceleme/aksiyon kuyruğuna düşürür.
5. **Tam Kaynak Soykütüğü (`End-to-End Source Lineage`):** Excel'den gelen her kayıt `source_workbooks → source_sheets → source_cells / import_rows` izine; Paraşüt API v4'ten gelen her kayıt `integration_sync_runs → integration_raw_payloads (SHA-256) → integration_entity_links` izine; yönetim defterindeki her fiş kaynak domain kaydına geri izlenebilir olmalıdır.
6. **5 Katmanlı Veritabanı RLS + `security_invoker` Görünüm Kalkanı:** Uygulama veritabanına yalnız düşük yetkili `mas_radar_app` rolüyle (`NOBYPASSRLS`, `NOSUPERUSER`) bağlanır ve her işlemde `SET LOCAL ROLE` ile 5 katmandan birine (`mas_radar_viewer`, `mas_radar_finance_operator`, `mas_radar_finance_approver`, `mas_radar_finance_manager`, `mas_radar_admin`) geçer. **Her SQL görünümü (`view`) istisnasız `WITH (security_invoker = true)` taşımak ve görünüm üzerinde `INSERT, UPDATE, DELETE` yetkisi kapalı olmak zorundadır.**
7. **Tek Denetim Yazıcısı (`src/lib/audit.ts`) ve Tek Doğrulama Sınırı (`src/lib/validation/index.ts`):** `public.audit_logs` (`0022` append-only) tablosuna `src/` içinde yalnız `audit()` fonksiyonu yazar; ancak her `UPDATE`/`DELETE` sonrasında `audit()` çağrılmadan önce **etkilenen satır sayısının (`rowCount === 1`) doğrulanması zorunludur** (RLS'in `0` satır etkilediği işlem için sahte denetim kaydı yazılamaz).
8. **Canlı Kanonik Veritabanı (`mas_radar_dev`) Dokunulmazlığı:** `127.0.0.1:5432 / mas_radar_dev` (`C:\MAS\pgdata16`) gerçek şirket verisidir. Hiçbir doğrulama betiği (`phase*-verify.ts`, `db:*:verify`, Playwright, `perf:*`) `mas_radar_dev` üzerinde çalıştırılamaz; tüm kapılar `isDisposableDatabaseName()` kontrolüyle yalnız tek kullanımlık (`*_verify`, `*_test`, `*_clone`) veritabanlarında koşar.

---

## 1. Tamamlanan Tarihsel Faz Sicili (Salt-Okunur Özet)

Aşağıdaki fazlar ve dalgalar bu yol haritasından önce tamamlanmış olup kod tabanının mevcut temelini oluşturur:

| Dönem / Grup | Kapsam | Kanıt / Durum |
| --- | --- | --- |
| **Faz 1 – Faz 14 + P0-A** | Ham Excel koruma katmanı (`0001..0021`), Ödeme Radarı, 35 Aylık Nakit Akışı, Çek/Kredi Radarı, Raporlar/Telegram Hatırlatmaları, Üretim Kapasite/Maliyet/Tezgâh ROI (`9A–9D`), Salt-Okunur Senaryo v1/v2, `DecisionFacts`, AI Yorum Sınırı (`12A`), Veri Kalitesi Merkezi (`14A–14E`) ve Çok Kullanıcılı Kimlik Doğrulama (`P0-A`). | `DONE` (`phase3:verify` .. `phase14e:verify`) |
| **Faz 15 – Faz 38** | `mas_radar_app` düşük yetkili çalışma zamanı rolü (`0035`), Migration defteri (`0020`), `big.js` para motoru (`Faz 17`), Tekil `audit.ts` + Zod sınırı (`Faz 18`), Karşı Taraf/IBAN/Boyutlar (`Faz 19`), Banka Ekstresi (`Faz 20`), Faturalar (`Faz 21`), Tahsis/Cari (`Faz 22–23`), Onay Tabloları (`Faz 24A`), 5 Katmanlı Tablo RLS (`Faz 24B`, `0056–0058`), Tahsilat Sözleri (`Faz 25`), Hazine Görünümleri (`Faz 26`), Kredi Limit/FX Şeması (`Faz 27`), Bütçe/13-Hafta Şeması (`Faz 28`), Optimizasyon/Maliyet/Kontrol/Brifing/Arka Plan Kuyruk/Analitik/Arama/UX/Entegrasyon İskeleti/Asistan (`Faz 29–38`, `0068–0094`). | Şema kuruldu (`0001..0094`), ancak kör denetimde saptanan görünüm/iş-döngüsü/matematik açıkları **Faz 39–56** ile kapatılacaktır. |
| **Wave 0 (`2026-10-28/29`)** | Native PostgreSQL 16.14 (`C:\MAS`) kurulumu ve 87/87 tablo kanonik geri yüklemesi (`0001..0096`); incelenmemiş `46541d8` katmanının seçici karantinası; girişsiz yazma kapılarının, sahte kokpit rakamlarının ve rol-kör önbelleğin kaldırılması; zorunlu parola değişimi (`0095–0096`). | `DONE` (`docs/release-evidence/wave0/00..02`) |
| **Performans Faz 1–10 (`2026-11-01`)** | `/` ana ekranında `GET` yazmalarının kaldırılması (`overview-snapshot.ts` + `0097_hot_path_partial_indexes.sql`), 60 rota önyüklemesinin iptali, `recharts` ve çekmecelerin tembel yüklenmesi, `/payments` + `/finance/checks` + `/finance/bank` sunucu sayfalaması, Windows symlink uyumlu `minimal-next-server.mjs` (`~205 MB` RAM, `/` First Load JS `108 kB`). | `DONE` (`tests/perf/phase01..phase10` 17/17 paket, 111/111 test `PASS`) |

---

## 2. Kalıcı Doğrulama Kapıları (`Standing Gates`) ve Migrasyon Yazım Kuralları

**Faz 39'dan Faz 59'a kadar HER FAZ**, kendi özel kabul testlerine ek olarak aşağıdaki kalıcı kapıları kırmadan geçmek zorundadır:

1. **`pnpm typecheck` ve `pnpm lint`:** Sıfır TypeScript hatası, sıfır ESLint hatası ve sıfır uyarı.
2. **`pnpm phase17:verify` (`scripts/phase17-verify.ts`):** `src/` altında sıfır `::float8` SQL dönüşümü; `supabase/migrations/*.sql` altında sıfır `float8` / `double precision` / `float4` / `real` kolon; `scripts/` altında yeni `::float8` eklenmesi yasak.
3. **`pnpm phase18:verify` (`scripts/phase18-verify.ts`):** `src/` altında `src/lib/audit.ts` dışında sıfır `INSERT INTO public.audit_logs`; yerel `audit()` kopyası tanımlamak yasak; ham `ZodError.message` sızıntısı yasak; **eklenen her yeni SQL migration numarası (`0098`..`0113`) aynı faz içinde `docs/database-schema.md` dosyasına işlenmek zorundadır** (aksi halde `phase18:verify:258-271` anında kırmızı verir!).
4. **`pnpm boundary:verify` (`scripts/boundary-verify.ts`):** `src/` altında dış ağ `fetch()` çağrısı yalnız 4 izinli sınır dosyasında (`lib/ai/engine.ts`, `lib/fx/provider.ts`, `lib/integrations/types.ts`, `lib/reminders/transport.ts`); `process.env` erişimi sınır modüllerinde yalnız `lib/env.ts` ve `lib/integrations/types.ts` içinde; `lib/ai/engine.ts` ve `lib/reminders/transport.ts` içinde `@/lib/env` yalnız tembel `await import("@/lib/env")` ile okunur; AI/asistan/arama alt ağacında finansal tablo mutasyonu yasak.
5. **Migration Dosya Kuralları (`scripts/db/migration-lib.ts:96-149` — `validateFileSet`):**
   - Dosya adı deseni: `^\d{4}_[a-z0-9_]+\.sql$` ve kesintisiz ardışık numara (`0098`, `0099`, `0100`, ...).
   - SQL gövdesinde satır başında `BEGIN`, `COMMIT`, `ROLLBACK`, `START TRANSACTION` **kesinlikle yasaktır** (migrasyon koşucusu kendi işlemini yönetir).
   - SQL gövdesinde `CREATE INDEX CONCURRENTLY` **kesinlikle yasaktır**.
6. **`tests/package-script-references.test.ts`:** `package.json` `"scripts"` alanına eklenen her `scripts/...` veya `supabase/...` dosya yolu git indeksinde izleniyor (`git add`) olmak zorundadır.
7. **`tests/interaction/manifest.ts`:** Arayüze eklenen veya etiketi değiştirilen her etkileşimli kontrol (`button`, `a`, `summary`, form gönderimi) aynı fazda `tests/interaction/manifest.ts` içinde uygun sınıfla (`mutation`, `navigation`, `ui-state`, `export`, `expected-disabled`, `external-not-live`) eşleştirilmelidir.

---

## 3. Nihai Atomik Uygulama Fazları ve Bağımlılık Sırası (`Faz 39` – `Faz 56`)

```text
[KÜME A: Güvenlik & RLS]
  Faz 39 (A1: 81 View security_invoker + sessions RLS + Migration 0098)
    └──► Faz 40 (A2: 32 actions.ts / 11 route.ts Kapıları + Open Redirect + Rol-Farkında AI + Kapalı Devre)
           │
[KÜME B: Tek Dil TS+SQL, Tek ExcelJS & Dayanıklı Ops]
           ├──► Faz 41 (B1: xlsx@0.18.5 Emekliliği [21 Dosya] + ExcelJS/CSV + V1/V2/#REF!/100x Onarımı)
           ├──► Faz 42 (B2: bot.py Silinmesi + TS Telegram İşçisi + Birleşik Arka Plan İşçisi mas-worker)
           └──► Faz 43 (B3: Yedek + Doküman Kasası + Dürüst Alarm + 8GB Servis + CI & Harcanabilir-DB Kapıları)
                  │
[KÜME C: Çekirdek Finans Matematiği, 0094 Görünümleri & Dönem Kilidi]
                  ├──► Faz 44 (C1: 0094 Kredi/Döviz Görünüm Onarımı + FIN-03 Açılış Bakiyesi + Kısıt/İndeks [0099])
                  ├──► Faz 45 (C2: DB Seviyesinde Dönem Kilidi Tetikleyicisi + Kapanış Kontrol Kapısı [0100])
                  └──► Faz 46 (C3: Davranışsal Tahsilat V2 + Çözücü + Canlı TCMB + Hazine + Banka + TR Vergi Takvimi)
                         │
[KÜME D: Bilgi Mimarisi & Kapanmayan İş Döngülerinin Kapatılması]
                         ├──► Faz 47 (D1: IA Konsolidasyonu + 11 Eski Klasör Silimi + Tekil Metrik + Ctrl+K/Form Onarımı)
                         ├──► Faz 48 (D2: Canlı Maker-Checker + Ödeme Paketi payment_runs/pain.001 + Banka→Kapanış [0101])
                         ├──► Faz 49 (D3: Türkiye Çek/Senet Bordrosu: Ciro, Tahsil, Teminat, Rücu Riski [0102])
                         └──► Faz 50 (D4: Bütçe Onayı, Kredi Limit/Kovenant, IBAN, Kârlılık, Söz, Doküman, Üretim [0103])
                                │
[KÜME E: Paraşüt API v4 & Çift Taraflı Yönetim Defteri + Mizan Köprüsü]
                                ├──► Faz 51 (E1: Entegrasyon Soykütüğü + Paraşüt API v4 + Hibrid Banka Hattı [0104])
                                └──► Faz 52 (E2: Çift Taraflı Yönetim Defteri: TDHP, Fiş Motoru, Mizan, Bilanço, EBITDA [0105])
                                       └──► Faz 53 (E3: Mali Müşavir Yasal Mizan Aktarımı + 12 Kök Nedenli Fark Köprüsü [0106])
                                              │
[KÜME F: Küresel CFO Zekası & Canlıya Geçiş Kabul Kapısı]
                                              ├──► Faz 54 (F1: Otomatik 13-Hafta Tahmin + Zamanlama vs Kalıcı Varyans Şelalesi [0107])
                                              └──► Faz 55 (F2: Gece Nakit Deltası Sabah Brifingi + DSCR/Kovenant + Çift Pist + Başabaş)
                                                     └──► Faz 56 (F3: Birleşik Altın Finans Testi + Tam Manifesto + Sert SLO + Klon Cutover)
```

---

## 4. KÜME A — GÜVENLİK, YETKİLENDİRME (RLS / GÖRÜNÜM) VE KAPALI DEVRE SINIRLARI

---

### Faz 39 (`A1`) — PostgreSQL Görünüm (`security_invoker`) Kalkanı, Oturum (`sessions`) Admin RLS Onarımı ve Sahiplik / Maker-Checker Politikaları (`Migration 0098`)

#### `A1`) — PostgreSQL Görünüm (`security_invoker`) Kalkanı, Oturum (`sessions`) Admin RLS Onarımı ve Sahiplik / Maker-Checker Politikaları (`Migration 0098`.. Fazın Amacı & Çözdüğü Rapor Bulguları / Rakip Mekanikleri

- **Amaç:** PostgreSQL katmanında 81 SQL görünümünün süper kullanıcı (`BYPASSRLS`) yetkisiyle çalışıp otomatik güncellenebilir görünümler üzerinden RLS'i delmesini engellemek, `public.sessions` tablosunda kırık olan yönetici oturum iptalini (`sessions_revoked = 0`) onarmak ve `saved_views`, `assistant_conversations`, `background_jobs`, `budget_lines`, `forecast_lines`, `mapping_reviews`, `external_assumptions` üzerindeki RLS yetki açıklarını kapatmak.
- **Kapatılan Rapor Bulguları:** `B2-01` (`0/81` view `security_invoker`, `0035:30,72` varsayılan yazma yetkileri, 4 auto-updatable view RLS baypası, `approval_queue` PII sızıntısı), `B2-02` (`public.sessions` admin `SELECT`/`UPDATE` eksikliği), `B2-05` (`finance_approver` maker-checker geri yazım RLS engeli), `B2-06` (`saved_views` / `assistant_conversations` `created_by` sahteciliği, `background_jobs` çapraz kullanıcı müdahalesi, `budget_lines` / `forecast_lines` kendi kendine onaylama).

#### `A1`) — PostgreSQL Görünüm (`security_invoker`) Kalkanı, Oturum (`sessions`) Admin RLS Onarımı ve Sahiplik / Maker-Checker Politikaları (`Migration 0098`.. Değişecek Mevcut Dosyalar & Oluşturulacak Yeni Dosyalar

- **Oluşturulacak Yeni Dosyalar:**
  1. `supabase/migrations/0098_view_security_invoker_and_rls_hardening.sql` — Tüm görünümleri `security_invoker = true` yapan, görünüm yazma yetkilerini iptal eden ve eksik/hatalı RLS politikalarını düzelten ileri migration.
  2. `tests/security/view-security-invoker.test.ts` — `supabase/migrations/*.sql` içindeki her `CREATE [OR REPLACE] VIEW` tanımının `0098` sonrası `security_invoker = true` güvencesi altında olduğunu statik olarak denetleyen birim testi.
- **Değişecek Mevcut Dosyalar:**
  1. `src/lib/authz/matrix.ts` (`TABLE_CLASS`, `CLASS_MATRIX`, `OWNER_SCOPED_TABLES` — satır `45-190`): `budget_lines` ve `forecast_lines` üzerinde onay durumu (`version_status = 'approved'`) geçiş yetkisini `approver+` katmanına bağlayan matris kurallarını güncelle.
  2. `src/lib/approvals/engine.ts` (`decideApproval` — satır `198-230`): `LEGACY_WRITEBACK` sorgularında dönen `rowCount` değerini zorunlu olarak kontrol et (`if (wb.rowCount !== 1) throw new DomainError("CONFLICT", "Hedef kayıt onay durumu güncellenemedi.")`).
  3. `src/lib/users/engine.ts` (`listUsersWithActivity`, `resetPassword`, `setUserRole`, `deactivateUser` — satır `75-90`, `180-188`, `236-245`, `270-278`): Admin oturum iptali ve aktif oturum sayımı sorgularının `mas_radar_admin` rolü altında gerçek satır döndürdüğünü doğrula.
  4. `scripts/db/roles-rls-verify.ts` (satır `480-625`): Kapıya 4 yeni zorunlu kontrol ekle:
     - `public` şemasındaki **tüm görünümlerde (`pg_views`)** `reloptions` içinde `security_invoker=true` bulunduğunun doğrulanması (`0` istisna).
     - `mas_radar_viewer` ve `mas_radar_finance_operator` rollerinin tek tablolu görünümler (`costing_invoice_facts`, `profitability_by_department`, `control_unmatched_bank_aged`, `anomaly_unusual_record_hour`) üzerinden `UPDATE` / `DELETE` denemesinin `42501 insufficient_privilege` ile reddedilmesi.
     - `mas_radar_admin` rolünün başka bir kullanıcının aktif `public.sessions` kaydını iptal ettiğinde `rowCount === 1` dönmesi.
     - `mas_radar_finance_approver` rolünün `decideApproval` akışında `mapping_reviews` ve `external_assumptions` durumunu güncelleyebilmesi, buna karşılık `mas_radar_finance_operator` rolünün `budget_lines.version_status = 'approved'` yazmasının reddedilmesi.
  5. `docs/database-schema.md`: `0098_view_security_invoker_and_rls_hardening.sql` kaydını ve görünüm güvenlik modelini ekle (`pnpm phase18:verify` zorunluluğu).

#### `A1`) — PostgreSQL Görünüm (`security_invoker`) Kalkanı, Oturum (`sessions`) Admin RLS Onarımı ve Sahiplik / Maker-Checker Politikaları (`Migration 0098`.. Veritabanı / SQL Migration (`0098`) Spesifikasyonu

- **Dosya:** `supabase/migrations/0098_view_security_invoker_and_rls_hardening.sql` (`BEGIN`/`COMMIT` ve `CONCURRENTLY` içermez):
  1. **Varsayılan Yetki ve `authenticated` Miras Temizliği:**

     ```sql
     alter default privileges in schema public revoke insert, update, delete on tables from authenticated;
     alter role mas_radar_app noinherit;
     ```

     *Not:* `src/lib/db.ts` içinde kimlik doğrulama önyüklemesi (`getRawPool` / `runAsAuthBootstrap`) yalnızca `sessions_app_runtime` ve `users_app_runtime` (`TO mas_radar_app`) politikalarını kullandığından `mas_radar_app` rolünün `NOINHERIT` yapılması `SET LOCAL ROLE mas_radar_viewer..admin` geçişlerini korurken `SET ROLE` unutulan ham bağlantının `authenticated` yetkisi kazanmasını kesin olarak kapatır.
  2. **Tüm `public` Görünümlerinde `security_invoker = true` ve Yazma Yetkisi İptali:**
     - PL/pgSQL `DO $do$ ... $do$` bloğu içinde `pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'v'` üzerinden tüm 81 görünüm için dinamik olarak:
       - `EXECUTE format('ALTER VIEW public.%I SET (security_invoker = true)', r.relname);`
       - `EXECUTE format('REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.%I FROM PUBLIC, authenticated, anon, mas_radar_app, mas_radar_viewer, mas_radar_finance_operator, mas_radar_finance_approver, mas_radar_finance_manager, mas_radar_admin', r.relname);`
     - `public.approval_queue` görünümünün (`0055:209-221`) `public.users` tablosuna yaptığı join nedeniyle `viewer` katmanında `42501` veya `0` satır hatası vermemesi için `users` üzerinde yalnız `(id, username, display_name, role, is_active)` okumasına değil, `approval_queue` içinde `users` yerine `approvals.requested_by_label` veya güvenli `public.user_display_label(uuid)` (`SECURITY DEFINER`, `SET search_path = public`, yalnız `display_name` döndüren, parola özeti/kilit alanı asla okumayan dar fonksiyon) kullanımına geçilmesi.
  3. **`public.sessions` Admin RLS Politikaları:**

     ```sql
     create policy sessions_admin_read on public.sessions
       for select to mas_radar_admin
       using (public.session_password_ready());

     create policy sessions_admin_revoke on public.sessions
       for update to mas_radar_admin
       using (public.session_password_ready())
       with check (public.session_password_ready() and revoked_at is not null);
     ```

  4. **Sahiplik Sahteciliği (`Ownership Spoofing`) ve Kuyruk Koruması:**
     - `saved_views_insert_enter` (`0084:107`) ve `assistant_conversations_insert_enter` (`0087:117`) politikalarını `DROP` + `CREATE` ederek `WITH CHECK (created_by = nullif(current_setting('app.user_id', true), '')::uuid)` zorunluluğu getir.
     - `background_jobs_update_enter` (`0081:196`) politikasını yalnız `mas_radar_finance_manager, mas_radar_admin` ve kendi kuyruğa aldığı `queued` işi iptal eden `created_by = current_setting('app.user_id', true)::uuid` ile sınırla.
  5. **Maker-Checker ve Bütçe/Tahmin Versiyon Koruması:**
     - `mapping_reviews` ve `external_assumptions` tablolarında `mas_radar_finance_approver` için yalnız inceleme durumu (`status` / `review_status`, `reviewed_by`, `reviewed_at`) güncellemesine izin veren `UPDATE` politikası + kolon-koruma `BEFORE UPDATE` tetikleyicisi ekle.
     - `budget_lines` ve `forecast_lines` tablolarında `BEFORE INSERT OR UPDATE` tetikleyicisi `enforce_planning_approval_role()` ile `NEW.version_status = 'approved'` yazımını ve zaten `'approved'` olan satırın tutar değişimini yalnız `current_user IN ('mas_radar_finance_approver', 'mas_radar_finance_manager', 'mas_radar_admin', 'postgres')` rollerine aç (`mas_radar_finance_operator` yalnızca `'draft'` ekleyip düzenleyebilir).

#### `A1`) — PostgreSQL Görünüm (`security_invoker`) Kalkanı, Oturum (`sessions`) Admin RLS Onarımı ve Sahiplik / Maker-Checker Politikaları (`Migration 0098`.. Adım Adım Uygulama Talimatları

1. `0098_view_security_invoker_and_rls_hardening.sql` dosyasını oluşturmadan önce `src/lib/db.ts` içindeki `runAsAuthBootstrap` sorgularının (`public.sessions`, `public.users`, `public.audit_logs`) `mas_radar_app` adına doğrudan `GRANT` ve RLS politikasına (`0058:248-278`, `0096`) sahip olduğunu doğrula; eksik tablo yetkisi varsa `0098` içinde açık `GRANT` ver.
2. `src/lib/approvals/engine.ts:198-230` içinde `decideApproval` geri yazımında `rowCount !== 1` durumunda işlemi `ROLLBACK` ettirecek `DomainError("CONFLICT", ...)` fırlat; böylece sahte `audit()` satırı yazılması imkânsız hale gelsin.
3. Yeni oluşturulan her gelecek görünümün (`0099+`) de `WITH (security_invoker = true)` ile başlamasını `tests/security/view-security-invoker.test.ts` içinde zorunlu kural yap.
4. `docs/database-schema.md` sonuna `0098` bölümünü ekle.

#### `A1`) — PostgreSQL Görünüm (`security_invoker`) Kalkanı, Oturum (`sessions`) Admin RLS Onarımı ve Sahiplik / Maker-Checker Politikaları (`Migration 0098`.. Zorunlu Doğrulama & Kabul Kapısı (Yalnız Tek Kullanımlık DB!)

- `pnpm exec vitest run tests/security/view-security-invoker.test.ts tests/security/write-gates.test.ts` → **PASS**
- Tek kullanımlık `mas_radar_roles_verify` veritabanında:
  - `MIGRATION_DATABASE_URL="postgresql://postgres:<pw>@127.0.0.1:5432/mas_radar_roles_verify" pnpm db:migrate` → `0098` temiz uygulanır.
  - `MIGRATION_DATABASE_URL="postgresql://postgres:<pw>@127.0.0.1:5432/mas_radar_roles_verify" DATABASE_URL="postgresql://mas_radar_app:<pw>@127.0.0.1:5432/mas_radar_roles_verify" pnpm db:roles-rls:verify` → **81/81 görünüm `security_invoker=true` PASS**, görünüm üzerinden `UPDATE/DELETE` reddi **PASS**, admin oturum iptali (`rowCount = 1`) **PASS**, `finance_operator` kendi kendine bütçe onayı reddi **PASS**.
- Kalıcı kapılar: `pnpm typecheck && pnpm lint && pnpm phase17:verify && pnpm phase18:verify && pnpm boundary:verify` → **ALL PASS**.

---

### Faz 40 (`A2`) — Server Action & API Yazma Kapıları, Açık Yönlendirme Kalkanı, Rol-Farkında AI/Asistan ve Kapalı Devre Sınır Sertleştirmesi

#### `A2`.. Fazın Amacı & Çözdüğü Rapor Bulguları / Rakip Mekanikleri

- **Amaç:** Uygulama katmanındaki tüm 32 `actions.ts` ve 11 `route.ts` dosyasını tam rol/rota/parola-değişimi/satır-sayısı kontrolüne kavuşturmak; tüm açık yönlendirme (`open redirect`), sahte `X-Forwarded-For` hız-sınırı baypası, CSV formül enjeksiyonu, asistan rol filtresi sızıntısı ve kapalı devre ağ sızıntısı açıklarını kapatmak.
- **Kapatılan Rapor Bulguları:** `B2-03`, `B2-04`, `B2-07`, `B2-08`, `B2-09` (rate-limit), `B2-10`..`B2-18`, `docs/todo.md` Dalga 1 backlog `#1`, `#2`, `#10`.

#### `A2`.. Değişecek Mevcut Dosyalar & Oluşturulacak Yeni Dosyalar

- **Oluşturulacak Yeni Dosyalar:**
  1. `src/lib/security/redirect.ts` — Tek kanonik `safeRedirectPath(raw: unknown, fallback?: string): string` yardımcısı (`https://`, `//`, `/\`, kontrol karakterleri `\x00-\x1f`, `/login` ve `/change-password` döngülerini reddeden saf modül).
  2. `tests/security/redirect-and-rate-limit.test.ts` — Açık yönlendirme vektörleri (`//evil.com`, `/\evil.com`, `https://evil.com`, `\t//evil.com`, `/login?next=/login`), CSV formül enjeksiyonu (`=CMD|...`, `+1`, `-1`, `@SUM`) ve `rate-limit.ts` LRU + `MAS_TRUST_PROXY` testleri.
  3. `tests/security/action-role-gates.test.ts` — Tüm `src/app/**/actions.ts` dosyalarındaki her dışa aktarılan Server Action fonksiyonunun `requireSession` / `requireRole` / `requirePermission` kapısından geçtiğini doğrulayan statik + davranışsal test paketi.
- **Değişecek Mevcut Dosyalar:**
  1. `src/lib/auth.ts` (`loadSessionByToken`, `requireSession`, `requireApiSession`, `safeRedirectPath` — satır `48-60`, `210-285`):
     - `loadSessionByToken` SQL sorgusuna `AND (u.locked_until IS NULL OR u.locked_until <= now())` şartını ekle (kilitlenen hesabın mevcut oturumu anında düşsün).
     - `requireSession(options?: { allowPasswordChangePending?: boolean; requiredPermission?: PermissionCheck; routePrefix?: string })` ve `requireApiSession` içinde `session.user.mustChangePassword === true` ise (`allowPasswordChangePending` yalnız `change-password/actions.ts` için `true`) `/change-password` yönlendirmesi veya `403 PASSWORD_CHANGE_REQUIRED` döndür.
     - Yeni yardımcı `requireActionPermission(table: TableName, op: CrudOp, routePrefix?: string): Promise<AuthSession>` dışa aktar: hem `canAccessRoute(session.user.role, routePrefix)` hem `can(session.user.role, table, op)` kontrolünü tek satırda çalıştırıp yetkisiz katmanda PG `42501` 500 çökmesi yerine temiz Türkçe `DomainError("FORBIDDEN", "Bu işlem için yetkiniz yok.")` döndürsün.
  2. **25 `actions.ts` Dosyasının Tamamı (Rol & Rota Kapısı Eklenecek):**
     - `src/app/(dashboard)/system/controls/actions.ts:22,39` (`routePrefix: "/system/controls"`, `finance_manager+`)
     - `src/app/(dashboard)/system/jobs/actions.ts:14,23` (`routePrefix: "/system/jobs"`, `admin`)
     - `src/app/(dashboard)/system/archive/actions.ts:8,9,16` (`routePrefix: "/system/archive"`, `finance_manager+` + `safeRedirectPath`)
     - `src/app/(dashboard)/system/actions.ts:3` (`routePrefix: "/system"`, `finance_manager+`)
     - `src/app/(dashboard)/radar/actions.ts:13-19` (`can(..., "payment_instances", "update")` + `safeRedirectPath(backTo, "/payments")`)
     - `src/app/(dashboard)/data-quality/actions.ts:24-27,49` (`can(..., "action_items", "update")` + `safeRedirectPath` hem `backTo` hem DB `source_href` üzerinde!)
     - `src/app/(dashboard)/imports/actions.ts:11,40` (`can(..., "source_workbooks", "insert")` / `can(..., "mapping_reviews", "update")`)
     - `src/app/(dashboard)/assumptions/actions.ts:16` (`can(..., "external_assumptions", "insert")`)
     - `src/app/(dashboard)/ask/actions.ts:8` (`can(..., "ai_response_snapshots", "insert")`)
     - `src/app/(dashboard)/reports/actions.ts:11,26` (`can(..., "reports", "insert")`), `insights/briefing/actions.ts:16` (`can(..., "reports", "insert")`), `reminders/actions.ts` (`can(..., "reminders", "insert")` / `can(..., "reminder_deliveries", "insert")`), `production/actions.ts:15` (`can(..., "part_profitability_runs", "insert")`)
     - `src/app/(dashboard)/scenarios/actions.ts`, `cashflow/actions.ts`, `cashflow/13-week/actions.ts`, `cashflow/scenarios/actions.ts`, `cashflow/optimization/actions.ts`
     - `src/app/(dashboard)/finance/actions.ts:5,10-13` (`installmentCount` için Zod `.int().min(1).max(360)` sınırı + `safeRedirectPath`), `finance/bank/actions.ts`, `finance/invoices/actions.ts`, `finance/receivables/actions.ts`, `finance/promises/actions.ts`, `finance/counterparties/actions.ts`, `finance/fx/actions.ts`.
  3. **Sıfır-Satır (`rowCount === 0`) Sahte Denetim Kaydı Düzeltmeleri:**
     - `src/lib/scenarios/engine.ts:467-476` (`deleteScenarioRun`): `DELETE ... RETURNING id` `rowCount === 0` ise `throw new DomainError("FORBIDDEN", "Bu senaryo silinemedi veya yetkiniz yok.")` — `audit()` çağrılmaz!
     - `src/lib/external-assumptions/engine.ts:194-207`, `src/lib/data-quality/engine.ts:536-556`, `src/app/(dashboard)/imports/actions.ts:40-56`: `rowCount === 0` durumunda `DomainError("NOT_FOUND" | "FORBIDDEN", ...)` fırlat.
  4. `src/lib/assistant/engine.ts` (satır `134-156`, `205`) ve `src/lib/ai/engine.ts` (satır `52-115`):
     - `answerQuestion(client, { question, actor, preScopedFacts: scoped.visible }, intent)` imzasını destekle; `scoped.withheld` listesindeki kısıtlı metriklerin ne `answerMd` metnine ne de LLM JSON yüküne girmemesini sağla.
  5. `src/lib/rate-limit.ts` (satır `50-105`):
     - Yalnız `env.MAS_TRUST_PROXY === true` olduğunda `x-forwarded-for` oku; kapalı devre yerel modda (`MAS_TRUST_PROXY=false` varsayılan) sahte IP başlığını yok say.
     - `buckets` `Map` boyutunu `MAX_BUCKETS = 4096` ile sınırla; dolduğunda süresi geçmiş girdileri süpür ve en eski anahtarı düşür (8 GB RAM OOM koruması).
  6. `src/lib/env.ts`, `.env.example`, `scripts/check-env.ts`:
     - `AI_FORCE_DETERMINISTIC` varsayılanını kapalı devre kararına uygun olarak `"1"` (`true`) yap; `.env.example:23,54` içindeki `CHANGE_ME` örneklerini doğrulayıcının reddedeceği açık yer tutucu kurallarıyla belgele; `check-env.ts` içinde `DATABASE_URL` kullanıcı adının `"mas_radar_app"` olduğunu zorunlu kıl ve kök dizinde `.env.local.bak*` düz metin yedek dosyası varsa güvenlik uyarısı verip başlamayı reddet (operatör yedeği şifreli kasaya taşıyana veya silene kadar).
     - `EMAIL_API_URL` için HTTPS ve izinli domain (`MAS_ALLOWED_EMAIL_HOSTS`) doğrulaması ekle.
  7. `src/lib/integrations/types.ts:160-195` & `src/lib/integrations/engine.ts:196-215` & `src/lib/fx/provider.ts:77`:
     - `realHttpClient` ve TCMB `fetch` çağrılarına `AbortSignal.timeout(15_000)` ekle; `endpointUrl` için yalnızca `https://` ve izinli entegrasyon host beyaz listesi (`api.parasut.com`, `www.tcmb.gov.tr` ve `MAS_ALLOWED_INTEGRATION_HOSTS` ortam değişkeninde açıkça tanımlanan harici HTTPS alan adları — RFC1918/loopback/`169.254.169.254` SSRF engeli!) kabul et; `readCredential` için yalnız `MAS_INTEGRATION_*` veya `PARASUT_*` önekli ortam değişkeni adlarına izin ver.
     - `integrations/engine.ts:196-211` içinde konnektör çağrısını `SAVEPOINT connector_exec` içine al; konnektör SQL hatası fırlattığında `ROLLBACK TO SAVEPOINT connector_exec` çalıştır ki `25P02` yüzünden başarısızlık kaydı ve `audit()` düşmesin.
  8. `src/app/api/perf-probe/route.ts:35-52`, `src/app/health/route.ts:24`, `src/lib/users/password-policy.ts:22-24`, `src/lib/analytics/export.ts:173-180`, `src/lib/reminders/transport.ts:89`, `src/lib/reminders/engine.ts:166`, `src/middleware.ts:98`:
     - `/api/perf-probe`: `NODE_ENV === "production"` iken `404` döndür + `requireApiSession()` zorla.
     - `/health`: Ham PG hata metnini istemciye sızdırma (`db: "down"` döndür).
     - `password-policy.ts`: Parola uzunluğuna `.max(256)` ekle.
     - `analytics/export.ts:173-180`: CSV hücrelerinde `^[=+\-@\t\r]` ile başlayan metinlerin başına `'` koyarak Excel formül enjeksiyonunu engelle.
     - `reminders/transport.ts:89`: Hata mesajlarında `bot<TOKEN>` dizgesini `bot[REDACTED]` ile maskele; `reminders/engine.ts:166` `channel === "email"` iken e-posta transportunu çağır (yapılandırılmamışsa `skipped_unconfigured` kaydet, Telegram'a sızdırma!).
     - `middleware.ts:98`: Rota önek eşleşmesini `pathname === prefix || pathname.startsWith(prefix + "/")` segment sınırına çek.

#### `A2`.. Veritabanı / SQL Migration / Arka Plan İşçisi Spesifikasyonu

- Bu faz yeni SQL tablosu gerektirmez (Faz 39 `0098` politikaları üzerine oturur); tüm güvenlik sınırları uygulama, HTTP, doğrulama ve sınır katmanında uygulanır.

#### `A2`.. Adım Adım Uygulama Talimatları

1. Önce `src/lib/security/redirect.ts` modülünü yaz ve `src/lib/auth.ts` içindeki eski `safeRedirectPath` fonksiyonunu buradan yeniden dışa aktar; tüm `redirect(backTo)` çağrılarını bu fonksiyona geçir.
2. `src/lib/auth.ts` içinde `requireActionPermission` yardımcısını oluştur ve 25 `actions.ts` dosyasının tamamına uygula.
3. `src/lib/assistant/engine.ts` içinde `viewer` rolüyle sorulan maaş/kredi/yönetici-özel soruların `scoped.visible` dışında kaldığını ve yanıt metninde sızmadığını birim testiyle kanıtla.
4. Kök dizindeki izlenmeyen `.env.local.bak-20261029-092503` dosyasının varlığını `check-env.ts` ile yakalayıp güvenli temizlik uyarısını doğrula (`.gitignore` içinde `.env*.bak*` deseninin bulunduğundan emin ol).

#### `A2`.. Zorunlu Doğrulama & Kabul Kapısı

- `pnpm exec vitest run tests/security/redirect-and-rate-limit.test.ts tests/security/action-role-gates.test.ts tests/security/write-gates.test.ts src/lib/assistant` → **PASS**
- Negatif güvenlik kontrolleri:
  - `viewer` ve `finance_operator` oturumuyla `system/controls/actions.ts`, `system/jobs/actions.ts`, `system/archive/actions.ts` çağrıldığında `FORBIDDEN` döner (`0` DB mutasyonu).
  - `backTo="https://evil.com"`, `backTo="//evil.com"`, `backTo="/\\evil.com"` girdilerinin tamamı güvenli varsayılan rotaya (`/payments` veya `/`) düşer.
  - `NODE_ENV=production` altında `/api/perf-probe` `404` döner.
- Kalıcı kapılar: `pnpm typecheck && pnpm lint && pnpm phase17:verify && pnpm phase18:verify && pnpm boundary:verify` → **ALL PASS**.

---

## 5. KÜME B — TEK DİL (`TS+SQL`), TEK EXCEL (`ExcelJS`), DAYANIKLI OPERASYON, ARKA PLAN İŞÇİSİ VE CI/QA KAPILARI

---

### Faz 41 (`B1`) — `xlsx@0.18.5` Emekliliği (21 Dosya), Tek `ExcelJS` + Deterministik CSV Hattı ve V1/V2/Veri-Kalitesi (`100x`) Aktarım Doğruluğu

#### `B1`) — `xlsx@0.18.5` Emekliliği (21 Dosya), Tek `ExcelJS` + Deterministik CSV Hattı ve V1/V2/Veri-Kalitesi (`100x`.. Fazın Amacı & Çözdüğü Rapor Bulguları / Rakip Mekanikleri

- **Amaç:** Yamasız `xlsx@0.18.5` (CVE-2023-30533 Prototype Pollution & CVE-2024-22363 ReDoS) paketini hem sunucudan hem tarayıcı istemci paketinden tamamen kaldırmak; tüm Excel okuma/yazma akışlarını tembel yüklenen tek `exceljs@4.4.0` + deterministik Türkçe CSV ayrıştırıcısına indirmek; ZIP bombası korumasını, V1 `#REF!` (`23,00 TL` / `1900-01-22`) formül hatası ayrımını, Veri Kalitesi `100x` ondalık nokta hatasını ve V2 yeniden aktarımda `paid_amount = 0` ezilme hatalarını düzeltmek.
- **Kapatılan Rapor Bulguları:** `B1-02` (`xlsx@0.18.5` sunucu + istemci sızıntısı), `B2-09` (`.xlsx` ZIP bombası açılmış boyut tavanı ve `bank/engine.ts:208` hücre başına tekil `INSERT` döngüsü), `B3-04` (V1 `#REF!`, `data-quality/engine.ts:183` `100x` nokta hatası, V2 `paid_amount` ezilmesi, aynı gün banka masrafı çakışması, 3 ondalıklı KDV `invoices_gross_check`, `"01.05.2026"` ay ayrıştırması, `Math.round` tarih kayması).

#### `B1`) — `xlsx@0.18.5` Emekliliği (21 Dosya), Tek `ExcelJS` + Deterministik CSV Hattı ve V1/V2/Veri-Kalitesi (`100x`.. Değişecek Mevcut Dosyalar & Oluşturulacak Yeni Dosyalar

- **Oluşturulacak Yeni Dosyalar:**
  1. `src/lib/importers/zip-guard.ts` — `.xlsx` (OOXML ZIP) merkezi güvenlik bekçisi: ZIP yerel dosya başlıklarından sıkıştırılmamış toplam boyutu (`MAX_UNCOMPRESSED_BYTES = 100 * 1024 * 1024` — 100 MB) ve giriş sayısını (`MAX_ZIP_ENTRIES = 512`) `ExcelJS` belleğe açmadan önce denetler; eski ikili `.xls` (`CFB_MAGIC = 0xd0cf11e0`) dosyasını `"Eski .xls biçimi güvenlik nedeniyle desteklenmiyor; lütfen dosyayı Excel'de .xlsx olarak kaydedip yükleyin."` mesajıyla reddeder.
  2. `src/lib/importers/csv-parser.ts` — Deterministik RFC-4180 uyumlu, UTF-8 BOM ve Türkçe `windows-1254` kodlama destekli, tırnak içi kuruş virgülünü (`"1.234,56"`) bozmayan `;` / `,` / `\t` banka ekstresi CSV ayrıştırıcısı.
  3. `tests/importers/exceljs-unification-and-formulas.test.ts` — `#REF!`, `#DIV/0!`, `#VALUE!`, `#N/A`, ZIP bombası, `.xls` reddi, `data-quality` ondalık mutabakatı (`123456.78`), V2 yeniden aktarımda `paid_amount` korunumu ve Türkçe CSV birim testleri.
- **Değişecek Mevcut Dosyalar (21 Dosyalık Tam `xlsx` Emeklilik + 4 Aktarım Motoru Envanteri):**
  1. `package.json:150` — `"xlsx": "^0.18.5"` satırını sil (`pnpm remove xlsx`).
  2. `next.config.ts:65` — `serverExternalPackages` dizisini `["pg", "exceljs"]` olarak güncelle.
  3. `src/lib/importers/workbook-parser.ts` (satır `5`, `10-14`, `19`, `28-33`, `73`, `83`, `95`, `108`, `117-146`) — `safeParseWorkbook` ve `safeParseWorkbookBuffer` fonksiyonlarını `async` yap; `inspectZipSafety(buffer)` çağır; fonksiyon gövdesinde tembel `const ExcelJS = (await import("exceljs")).default` kullan (**DİKKAT:** `tests/perf/phase07-lazy-modules.test.tsx:66-123` gereği modül üst seviyesinde statik `import ExcelJS from "exceljs"` yasaktır; yalnız `import type ExcelJS from "exceljs"` kullanılabilir!). Toplam hücre sayısını `MAX_WORKBOOK_CELLS = 200_000` ile sınırla.
  4. `src/lib/importers/row-utils.ts` (satır `5`, `55-70`, `126-128`) — `sheetCells(ws: ExcelJS.Worksheet)` olarak yeniden yaz; formül hatası nesnelerinde (`{ error: "#REF!" }` veya `FormulaValue.result` hata nesnesi) `inferredType: "error"`, `normalizedValue: null` üret ve `asNumber()` içinde `inferredType === "error"` için kesin `null` döndür (asla `23` veya `1900-01-22` üretme!).
  5. `src/lib/importers/extractors.ts` (satır `63-67`, `374`, `497`) — Tarih ve para çıkarıcılarında `inferredType === "error"` hücreleri `mapping_reviews` incelemesine (`issue_type: "formula_error"`) düşür.
  6. `src/lib/importers/statement-parser.ts` (satır `15-26`, `72-124`) — `parseStatementBuffer` fonksiyonunu `async` yap; `.xlsx` için `zip-guard` + tembel `exceljs`, `.csv` için `csv-parser.ts` kullan; açık `0,00` tutarlı satırları `null` yapma (`bank/rules.ts:366-384` ile uyumlu).
  7. `src/lib/analytics/export.ts` (satır `20-27`, `189-229`) — `export async function toXlsxBuffer(...)` içinde `require("xlsx")` yerine tembel `await import("exceljs")` ve `Buffer.from(await workbook.xlsx.writeBuffer())` kullan.
  8. `src/components/charts/analytics-chart.tsx` (satır `120-133`) — Tarayıcıda `await import("xlsx")` çağrısını sil; mevcut `/api/analytics/export` ucuna `POST` / `GET` isteği atarak sunucuda üretilen `.xlsx` dosyasını indir (**DİKKAT:** `scripts/phase36-verify.ts:407-415` gereği `/api/export` adında ikinci bir uç oluşturulmaz!).
  9. `src/components/ui/primitives/data-table.tsx` (satır `163-175`) — Tarayıcıda `await import("xlsx")` çağrısını sil; `/api/analytics/export` üzerinden `.xlsx` indir.
  10. `src/app/api/analytics/export/route.ts:183` — `await toXlsxBuffer(...)` olarak güncelle.
  11. `src/lib/importers/workbook-importer.ts:154,174,201-202` — `await safeParseWorkbookBuffer(...)` olarak güncelle.
  12. `src/lib/bank/engine.ts:18,24,153,188-216` — `await parseStatementBuffer(...)` yap ve `:208-216` satırlarındaki hücre başına tekil `INSERT INTO public.source_cells` döngüsünü `500` satırlık parametrik çoklu-satır (`UNNEST`) toplu eklemeye çevir.
  13. `src/components/imports/upload-form.tsx:18` ve `src/app/(dashboard)/finance/bank/page.tsx:152` — `accept` özniteliklerini `.xlsx,.csv` olarak güncelle.
  14. `src/lib/data-quality/engine.ts` (satır `173-189`) — `source_cells.normalized_value` sayısal ayrıştırmasını düzelt: değer standart JS ondalık biçimindeyse (`^-?\d+(\.\d+)?$`) noktayı silmeden doğrudan `::numeric` çevir; yalnızca Türkçe biçimdeyse (`^-?\d{1,3}(\.\d{3})*(,\d+)?$`) binlik noktaları silip virgülü noktaya çevir; aksi halde `NULL` döndür (`22P02` çökmesi ve `100x` hatası sıfırlanır).
  15. `src/lib/importers/v2/mapper.ts` (satır `608-613`, `669`, `683-686`, `716`) ve `src/lib/importers/v2/values.ts` (satır `288`, `380-382`) —
      - `ON CONFLICT DO UPDATE` içinde mevcut satırda `paid_amount > 0` veya `status IN ('paid','partial','matched','reconciled')` ise kullanıcının ödeme/eşleştirme durumunu koru (`paid_amount` ve `status` alanlarını sıfırlama!).
      - Banka ekstresi `dedupe_hash` hesabına aynı ekstre içindeki özdeş satır sıra numarasını (`occurrenceOrdinal`) dahil et ki aynı gün aynı tutarlı iki EFT masrafı yutulmasın.
      - Fatura `gross_amount` kontrolünde `Big(net).plus(tax).round(2)` kuruş yuvarlamasını `invoices_gross_check` ile birebir hizala.
      - `values.ts:288` Excel tarih seri numarasında `Math.round` yerine `Math.floor(serial) + Math.round((serial % 1) * 86400) / 86400` gün tabanı kullan; `values.ts:380-382` `parseMonth` içinde `"01.05.2026"` (`GG.AA.YYYY`, gün `01`) biçimini `"2026-05-01"` olarak kabul et.
  16. **Betik ve Test Güncellemeleri (8 Dosya):** `scripts/parse-spike.ts:37`, `scripts/phase20-verify.ts:345-361`, `scripts/phase34-verify.ts:406,416`, `scripts/phase36-verify.ts:414` (`/export (?:async )?function toXlsxBuffer/`), `src/lib/importers/extractors.test.ts:2,26-30`, `src/lib/importers/workbook-parser.test.ts:5,63-108`, `tests/perf/phase07-lazy-modules.test.tsx:5,32-60`, `tests/perf/phase10-standalone-runtime.test.ts:28`.

#### `B1`) — `xlsx@0.18.5` Emekliliği (21 Dosya), Tek `ExcelJS` + Deterministik CSV Hattı ve V1/V2/Veri-Kalitesi (`100x`.. Veritabanı / SQL Migration / Arka Plan İşçisi Spesifikasyonu

- Bu faz şema değişikliği gerektirmez; `zip-guard.ts` aynı kuralları hem senkron yüklemelerde hem `scripts/ops/process-import-jobs.ts` V2 asenkron önizleme işçisinde zorunlu kılar.

#### `B1`) — `xlsx@0.18.5` Emekliliği (21 Dosya), Tek `ExcelJS` + Deterministik CSV Hattı ve V1/V2/Veri-Kalitesi (`100x`.. Adım Adım Uygulama Talimatları

1. `zip-guard.ts` ve `csv-parser.ts` modüllerini sıfır dış bağımlılıkla (Node `Buffer` / `zlib` başlık okuma ve `TextDecoder`) yaz.
2. `workbook-parser.ts`, `row-utils.ts`, `statement-parser.ts` ve `analytics/export.ts` dosyalarını `ExcelJS` üzerine geçir; hiçbir dosyada üst-seviye `import ExcelJS from "exceljs"` kullanma.
3. İstemci bileşenlerindeki (`analytics-chart.tsx`, `data-table.tsx`) `xlsx` çağrılarını `/api/analytics/export` indirme yardımcı fonksiyonuna bağla ve `pnpm remove xlsx` çalıştır.
4. `data-quality/engine.ts` ve `importers/v2/{mapper,values}.ts` düzeltmelerini uygula.

#### `B1`) — `xlsx@0.18.5` Emekliliği (21 Dosya), Tek `ExcelJS` + Deterministik CSV Hattı ve V1/V2/Veri-Kalitesi (`100x`.. Zorunlu Doğrulama & Kabul Kapısı

- `pnpm exec vitest run tests/importers/exceljs-unification-and-formulas.test.ts src/lib/importers tests/perf/phase07-lazy-modules.test.tsx tests/perf/phase10-standalone-runtime.test.ts` → **PASS**
- `git grep -n "from \"xlsx\"" src/ scripts/ tests/` ve `git grep -n "import(\"xlsx\")" src/ scripts/ tests/` → **0 eşleşme**.
- Kalıcı kapılar: `pnpm typecheck && pnpm lint && pnpm phase17:verify && pnpm phase18:verify && pnpm boundary:verify` → **ALL PASS**.

---

### Faz 42 (`B2`) — `bot.py` & Python Yan Süreçlerinin Kaldırılması, TypeScript Telegram İşçisi ve Birleşik Arka Plan İşçisi (`mas-worker`)

#### `B2`) — `bot.py` & Python Yan Süreçlerinin Kaldırılması, TypeScript Telegram İşçisi ve Birleşik Arka Plan İşçisi (`mas-worker`.. Fazın Amacı & Çözdüğü Rapor Bulguları / Rakip Mekanikleri

- **Amaç:** `bot.py` ve `scripts/qa/browser_crawl.py` Python yan parçalarını tamamen silerek projeyi **%100 tek dil (`TypeScript + PostgreSQL SQL`)** standardına oturtmak; yetkisiz mesajlara yanıt vermeyen, mesaj kaybetmeyen (`update_id` kalıcı ofsetli) salt-okunur TypeScript Telegram işçisini ve `import_jobs` + `background_jobs` + günlük finansal bakım işlerini yürüten birleşik TypeScript arka plan işçisini (`scripts/ops/background-worker.ts`) devreye almak.
- **Kapatılan Rapor Bulguları:** `B1-03` (`import_jobs` ve `background_jobs` için çalışan işçi olmaması, `dispatcher.ts:170` `resultPayload` kaybı, `requeueDueFailures`/`reapStuckJobs` çağrılmaması), `Bölüm 2.3` (`bot.py` yabancıya yanıt/429 DoS, `drop_pending_updates=True` mesaj kaybı, 4096 karakter sınırı, `/api/telegram/assistant` çerezsiz middleware istisnası, `browser_crawl.py`), `docs/todo.md` Dalga 1 backlog `#6` (`/hareket` fatura yönü), `#7` (geçici hata alan önizleme işi), `#8` (`resultPayload`).

#### `B2`) — `bot.py` & Python Yan Süreçlerinin Kaldırılması, TypeScript Telegram İşçisi ve Birleşik Arka Plan İşçisi (`mas-worker`.. Değişecek Mevcut Dosyalar & Oluşturulacak Yeni Dosyalar

- **Silinecek Dosyalar (3 Python Dosyası):**
  1. `bot.py`
  2. `bot.requirements.txt`
  3. `scripts/qa/browser_crawl.py`
  *(Ayrıca HTTP köprüsü artık gerekmediği için `src/app/api/telegram/assistant/route.ts` silinir ve `src/middleware.ts:40,68` içindeki son çerezsiz API istisnası kaldırılır!)*
- **Oluşturulacak Yeni Dosyalar:**
  1. `scripts/ops/telegram-assistant-worker.ts` — Tek-örnek kilitli (`.runtime/telegram-worker.lock`), atomik ofset kalıcılıklı (`.runtime/telegram-offset.json`), yetkisiz `chat_id` mesajlarını **sıfır dış HTTP yanıtıyla** düşürüp hız-sınırlı denetim kaydı yazan, doğrudan `runAsReadOnlySystem` (`SET LOCAL ROLE mas_radar_viewer`) üzerinden `src/lib/telegram/assistant.ts` çağıran TypeScript uzun-yoklama işçisi.
  2. `scripts/ops/background-worker.ts` — Tek süreçte (~55 MB RAM) periyodik döngüyle çalışan birleşik arka plan işçisi (`--once` tek tur modu CI/test için, sürekli daemon modu üretim için):
     - Her `5 sn`: bekleyen `import_jobs` (`processPendingImportJobs`) + `background_jobs` (`dispatchNextBatch`) + `requeueDueFailures` + `reapStuckJobs`.
     - Günlük / saatlik idempotent bakım görevleri (`settings` / `background_jobs` son çalışma zamanıyla kilitli): aylık `generateInstances`, vadesi geçen `payment_instances` ve `loan_installments` için `unpaid/planned → late` geçişi, kırılan `promise_to_pay` (`open → broken`) taraması, finansal kontrol/anomali taraması, yapılandırılmışsa TCMB günlük kur çekimi ve günlük rapor/sabah brifingi anlık görüntüsü üretimi.
  3. `scripts/ops/mas-background-worker.cmd` — Windows Görev Zamanlayıcı / servis sarmalayıcısı.
  4. `tests/ops/telegram-and-background-worker.test.ts` — Yetkisiz `chat_id` sessiz düşürme, 4096-karakter güvenli bölme, ofset kaldığı yerden devam etme, `dispatcher.ts` `resultPayload` yazımı ve takılı iş kurtarma birim/entegrasyon testleri.
- **Değişecek Mevcut Dosyalar:**
  1. `src/lib/reminders/transport.ts` (satır `40-115`) — `scripts/boundary-verify.ts:26-31` izin listesinde zaten bulunan bu dosyaya `pollTelegramUpdates(offset: number, timeoutSec: number, signal?: AbortSignal)` ve `splitTelegramMessage(text: string, maxLen = 4000): string[]` fonksiyonlarını ekle (`@/lib/env` erişimi zorunlu olarak tembel `await import("@/lib/env")` kalır!).
  2. `src/lib/telegram/assistant.ts` (satır `130-155`) — `/hareket` çıktısında fatura yönüne (`direction === 'sale'` → alacak/tahsilat, `'purchase'` → borç/ödeme) göre doğru Türkçe etiket üret (`docs/todo.md` backlog `#6`). **DİKKAT:** `tests/security/write-gates.test.ts:406-433` gereği bu dosyanın import listesine yeni modül eklenmez!
  3. `src/lib/jobs/queue.ts` (satır `190-265`) ve `src/lib/jobs/dispatcher.ts` (satır `19-45`, `165-180`) — `completeJob(client, job.id, outcome.resultPayload)` ile `result_payload` JSONB kolonunu kaydet; yerleşik deterministik işleyicileri (`report.generate`, `reminders.dispatch`, `controls.evaluate`, `fx.tcmb_daily`, `maintenance.daily_rollover`) kaydet.
  4. `scripts/ops/process-import-jobs.ts` (satır `20-90`) — Geçici veritabanı/G-Ç hatası alan `failed` önizleme işlerinin yeniden denenebilmesini sağla (`docs/todo.md` backlog `#7`) ve `reapStuckJobs` entegrasyonunu ekle; `background-worker.ts` içinden çağrılabilir fonksiyon olarak dışa aktar.
  5. `src/middleware.ts` (satır `38-44`, `65-72`) — `/api/telegram/assistant` çerezsiz istisnasını sil; artık `/health` ve `/ready` dışında **sıfır çerezsiz uç** kalır.
  6. `tests/security/write-gates.test.ts` (satır `345-395`) — `read("bot.py")` referansını `read("scripts/ops/telegram-assistant-worker.ts")` olarak güncelle; `bot.py` dosyasının repoda var olmadığını ve TS işçisinin yalnız `mas_radar_viewer` salt-okunur bağlantı kullandığını doğrula.
  7. `package.json` ve `.gitignore` — `"ops:worker": "tsx scripts/ops/background-worker.ts"`, `"ops:worker:once": "tsx scripts/ops/background-worker.ts --once"`, `"ops:telegram:worker": "tsx scripts/ops/telegram-assistant-worker.ts"` komutlarını ekle (**eklenen tüm script dosyalarını `git add` ile izlemeye al** ki `tests/package-script-references.test.ts` yeşil geçsin!); `.gitignore` içine `.venv/`, `.ruff_cache/`, `.runtime/` ekle.

#### `B2`) — `bot.py` & Python Yan Süreçlerinin Kaldırılması, TypeScript Telegram İşçisi ve Birleşik Arka Plan İşçisi (`mas-worker`.. Veritabanı / SQL Migration / Arka Plan İşçisi Spesifikasyonu

- Arka plan işçisi (`background-worker.ts`) `PGAPPNAME=mas_background_worker` ile bağlanır; sistem bakım görevlerini `runAsSystem` altında `src/lib/audit.ts` (`actor: "system:background-worker"`) kaydıyla yürütür; Telegram işçisi ise **yalnızca** `runAsReadOnlySystem` (`SET LOCAL ROLE mas_radar_viewer`, `SET LOCAL transaction_read_only = on`) kullanır ve hiçbir tabloya (`audit_logs` yetkisiz deneme sayacı hariç dar yardımcı dışında) yazamaz.

#### `B2`) — `bot.py` & Python Yan Süreçlerinin Kaldırılması, TypeScript Telegram İşçisi ve Birleşik Arka Plan İşçisi (`mas-worker`.. Adım Adım Uygulama Talimatları

1. `src/lib/reminders/transport.ts` içine `pollTelegramUpdates` ve `splitTelegramMessage` fonksiyonlarını ekle; hemen `pnpm boundary:verify` çalıştırarak tembel `env` ve sınır kurallarının `8/8` geçtiğini doğrula.
2. `scripts/ops/telegram-assistant-worker.ts` ve `scripts/ops/background-worker.ts` dosyalarını oluştur; `SIGINT`/`SIGTERM` sinyallerinde `AbortController` ile temiz kapanış ve `.runtime/*.lock` temizliği uygula.
3. `bot.py`, `bot.requirements.txt`, `scripts/qa/browser_crawl.py` ve `src/app/api/telegram/assistant/route.ts` dosyalarını sil; `middleware.ts` ve `tests/security/write-gates.test.ts` dosyalarını güncelle.

#### `B2`) — `bot.py` & Python Yan Süreçlerinin Kaldırılması, TypeScript Telegram İşçisi ve Birleşik Arka Plan İşçisi (`mas-worker`.. Zorunlu Doğrulama & Kabul Kapısı

- `pnpm exec vitest run tests/ops/telegram-and-background-worker.test.ts tests/security/write-gates.test.ts tests/package-script-references.test.ts` → **PASS**
- Repo taraması: `git ls-files "*.py"` → **0 dosya**.
- Kalıcı kapılar: `pnpm typecheck && pnpm lint && pnpm phase17:verify && pnpm phase18:verify && pnpm boundary:verify` → **ALL PASS**.

---

### Faz 43 (`B3`) — Yedekleme + Doküman Kasası Arşivi, Dürüst Telemetri Alarm Borusu, 8 GB RAM Windows Servis Gözetimi ve CI / Harcanabilir-DB Kapıları

#### `B3`.. Fazın Amacı & Çözdüğü Rapor Bulguları / Rakip Mekanikleri

- **Amaç:** Gece yedeklemesinin `.env.local` değişkenlerini düşürmesini, doküman kasasını yedeksiz bırakmasını ve harici disk kopyası başarısız olduğunda telemetrinin sahte `ALL CLEAR` vermesini düzeltmek; Windows zamanlanmış görevlerini oturum açmadan (`S4U` / Servis) çalışır hale getirmek; 8 GB RAM kısıtlı makinede `start-production.cmd` / `stop-production.cmd` / `runtime-port-guard.ts` süreç yönetimini sağlamlaştırmak; kırık GitHub Actions CI kurulumunu (`pnpm` sürüm çatışması), 18 betikteki ölü `docker exec` çağrılarını ve 35 `phase*-verify.ts` betiğindeki harcanabilir-DB korumasız `TRUNCATE` tehlikesini tamamen ortadan kaldırmak.
- **Kapatılan Rapor Bulguları:** `B1-01` (CI `pnpm` çatışması + 4x mükerrer build + `continue-on-error`), `B1-04` (`pg`/`tsx` `dependencies` taşıması + ölü `date-fns`/`jest-dom` silimi), `B1-05` (`start/stop-production.cmd`, `MAS_NEXT_CPUS=1`, `vitest maxWorkers`, `runtime-port-guard.ts`), `B1-06` (18 `docker exec` betiği + 35 korumasız `phase*-verify.ts` + `import-real.ts` + `phase16-verify.ts`), `B1-07` (`tsconfig.json`, `engines`), `B4-06` (5 yedekleme/telemetri/servis kırılma noktası), `docs/todo.md` backlog `#3, #11..#16`.

#### `B3`.. Değişecek Mevcut Dosyalar & Oluşturulacak Yeni Dosyalar

- **Oluşturulacak Yeni Dosyalar:**
  1. `scripts/db/disposable-guard.ts` — Tek satırlık `assertDisposableTargetDb(envVarNames?: string[]): { dbName: string; url: string }` koruyucusu (`mas_radar_dev` veya `DISPOSABLE_MARKERS` taşımayan herhangi bir hedef görüldüğünde sıfır bağlantı açmadan anında `GÜVENLİK DURDURMASI` hatasıyla çıkar).
  2. `tests/ops/backup-telemetry-and-guards.test.ts` — `.env.local` `MAS_OFFDEVICE_BACKUP_DIR` okuma, doküman kasası SHA-256 arşivleme, `exit 3` harici yedek hatasında telemetrinin `WARN`/`FAIL` üretmesi ve 40 `phase*-verify.ts` betiğinin tamamında `assertDisposableTargetDb` bulunduğunu denetleyen statik + davranışsal test.
- **Değişecek Mevcut Dosyalar:**
  1. **Yedekleme ve Telemetri Zinciri (6 Dosya):**
     - `scripts/ops/backup-daily.ts` (satır `60-95`, `180-245`): `.env.local` içinden `MAS_OFFDEVICE_BACKUP_DIR`, `MAS_BACKUP_DIR`, `MAS_BACKUP_PRUNE_APPLY`, `MAS_DOCUMENT_STORAGE_DIR` değişkenlerini oku; `pg_dump` doğrulandıktan sonra `MAS_DOCUMENT_STORAGE_DIR` (doküman kasası) mevcutsa `daily-<ts>-documents.tar.gz` + dosya bazlı SHA-256 manifesti üretip makbuza (`receipt.json`) bağla ve harici diske birlikte kopyala; `*.dump.unverified` artıklarını ve harici diskteki eski yedekleri saklama politikasına göre buda (`ENOSPC` önlemi).
     - `scripts/ops/backup-prune.ts` ve `scripts/ops/offdevice-copy.ts`: Doküman arşiv çiftini ve harici hedef budamasını destekle.
     - `scripts/ops/telemetry-snapshot.ts` (satır `255-295`): `readBackupFreshness` içinde yalnız yerel `.dump` yaşına değil, `daily-runs.jsonl` son kaydının `exitCode` (`exit 3` → `offdevice_backup_missing` `WARN/CRITICAL`) ve son makbuzun `offDeviceSatisfied` durumuna bak; asla sahte `ALL CLEAR` verme.
     - `scripts/ops/telemetry-watch.ts` (satır `85-115`): `PASSTHROUGH_FROM_ENV_LOCAL` listesine `MAS_APP_BASE_URL`, `MAS_BACKUP_DIR`, `MAS_OFFDEVICE_BACKUP_DIR`, `EMAIL_API_URL`, `EMAIL_API_KEY`, `EMAIL_FROM`, `EMAIL_TO` ekle ki web uygulaması çöktüğünde `/ready` yoklaması gerçekten alarm üretsin.
     - `scripts/ops/schedule-windows.ts` (satır `79-185`): Görevleri `InteractiveToken` yerine masaüstü oturumu gerektirmeyen `S4U` (veya yönetici modunda `SYSTEM`/`ServiceAccount`) ile kaydet ve `MAS-Background-Worker` görevini ekle.
     - `scripts/ops/install-postgres-service.ps1` (satır `320-340`, `390-445`, `485-495`): `sc.exe failure` dizisini üçüncü hatadan sonra da `restart/60000` olarak kalıcı kıl (`reset= 86400 actions= restart/5000/restart/15000/restart/60000`); yarım kalan kurulumu idempotent tamamla; `try/finally` ile Ctrl+C durumunda mevcut oturum görevini koru ve `pg_hba.conf` loopback kuralını doğrula.
  2. **8 GB RAM Çalışma Zamanı, Paketler ve Derleyici (8 Dosya):**
     - `package.json`: `pg` ve `tsx` paketlerini `dependencies` altına taşı; kullanılmayan `date-fns` ve `@testing-library/jest-dom` paketlerini kaldır; `"engines": { "node": ">=22.0.0 <25.0.0" }` ekle; `"build"` komutunda `MAS_NEXT_CPUS=1` varsayılanını (`scripts/build-safe.ts` veya çapraz-platform env ile) uygula.
     - `tsconfig.json:26-34`: `"include"` içine `"tests/**/*.tsx"` ve `"compilerOptions"` içine `"forceConsistentCasingInFileNames": true` ekle.
     - `vitest.config.ts`: 8 GB RAM makinede OOM önlemek için `maxWorkers: process.env.CI ? 4 : 2` sınırı koy.
     - `scripts/ops/runtime-port-guard.ts:1-34`: `@next/env` (`loadEnvConfig`) yükle ve sabit `[3000, 3001]` yerine **yalnızca istenen `PORT` (`requestedPort`)** değerini denetle (böylece `3000` üzerinde üretim açıkken `3210` üzerinde izole test sunucusu çalışabilsin).
     - `scripts/ops/start-standalone.ts:130-165`: Ön kontroller bittikten sonra Windows dışı ortamlarda veya doğrudan `node minimal-next-server.mjs` devrinde gereksiz üst `tsx` sürecini bellekte tutmayacak hafif başlatıcı düzenine geç.
     - `start-production.cmd` ve `stop-production.cmd`: `findstr /R /C:":3000 "` (sonunda boşlukla tam port eşleşmesi!) kullan; tarayıcıyı açmadan önce `http://127.0.0.1:3000/ready` `200` dönene kadar bekle ve `http://127.0.0.1:3000` aç; katılımsız kabuklar için `--no-pause` bayrağı destekle.
  3. **CI İş Akışı (2 Dosya):**
     - `.github/actions/setup/action.yml:18-20`: `with: version: 10` satırını kaldır (`pnpm/action-setup@v4` sürümü doğrudan `package.json#packageManager` içinden okusun).
     - `.github/workflows/ci.yml`: Tek `build` işi çıktısını (`artifact`) downstream E2E/görsel/etkileşim işlerinde yeniden kullanarak 4x mükerrer derlemeyi kaldır; `:541` satırındaki `continue-on-error: true` baypasını kaldır; `static` işine `pnpm audit --prod --audit-level=high` ekle.
  4. **18 `docker exec` Betiğinin Native `pg-native.ts` / `pg` İstemcisine Göçü ve 35+1 Betiğe Harcanabilir-DB Kilidi:**
     - Native `pg-native.ts` / `pg` istemcisine geçirilecek 18 betik (veya eski `.sh` sarmalayıcılarının `tsx` karşılıklarına yönlendirilmesi): `scripts/db/ensure.sh`, `scripts/db/verify.sh`, `scripts/db/dev-reset.sh`, `scripts/db/constraints-verify.ts`, `scripts/db/migrate-verify.ts`, `scripts/db/reconciliation-verify.ts`, `scripts/db/transitions-verify.ts`, `scripts/db/legacy-repair-verify.ts`, `scripts/db/p24b-cleanup-binding.ts`, `scripts/db/create-testsprite-db.ts`, `scripts/start-testsprite.ts`, `scripts/qa/p24b-readonly-1-2.sh`, `scripts/qa/p24b-readonly-3-4-5.sh`, `scripts/qa/p24b-negative-controls.ts`, `scripts/qa/p24b-wholedb-control.ts`, `scripts/release/golden-fingerprint.ts`, `scripts/release/real-clone-gate.ts`, `scripts/release/real-clone-v2-rehearsal.ts` (CLI parola argümanı yerine `PGPASSWORD` süreç ortamı kullan, `restore-drill.ts:188` içinde `%TEMP%` yerine izinleri kısıtlı `.runtime/drill-tmp` kullan).
     - `assertDisposableTargetDb()` eklenecek 36 betik: `scripts/import-real.ts` ve şu an korumasız olan 35 `scripts/phase*-verify.ts` betiğinin tamamı (`phase3`, `phase4`, `phase5`, `phase6`, `phase6b`, `phase7`, `phase8`, `phase9a`, `phase9b`, `phase9c`, `phase9d`, `phase11`, `phase12a`, `phase13a`, `phase13b`, `phase14a`, `phase14b`, `phase14c`, `phase14d`, `phase14e`, `phase15`, `phase16` [+ `next start` yerine `start-standalone.ts`], `phase19`, `phase20`, `phase21`, `phase22`, `phase23`, `phase24a`, `phase25`, `phase26`, `phase27`, `phase28`, `phase29`, `phase30`, `phase32`, `phase34`, `phase38`).

#### `B3`.. Veritabanı / SQL Migration / Arka Plan İşçisi Spesifikasyonu

- Bu faz şema migration'ı gerektirmez; operasyonel yedekleme, telemetri, servis ve doğrulama altyapısını sertleştirir. `mas_radar_dev` veritabanına bağlanmayı deneyen herhangi bir yıkıcı doğrulama betiği `assertDisposableTargetDb()` tarafından ilk satırda durdurulur.

#### `B3`.. Adım Adım Uygulama Talimatları

1. Önce `scripts/db/disposable-guard.ts` modülünü yaz ve tüm `phase*-verify.ts` + `db:*:verify` + `import-real.ts` betiklerinin en başına bağla; `DATABASE_URL="postgresql://mas_radar_app:x@127.0.0.1:5432/mas_radar_dev"` sahte dizesiyle hiçbir soket açılmadan reddedildiğini birim testiyle kanıtla.
2. 18 Docker-bağımlı betiği `scripts/db/pg-native.ts` (`resolvePgTool("psql" | "pg_dump" | "pg_restore")`) ve `pg.Pool` üzerine taşı.
3. Yedekleme (`backup-daily.ts`), telemetri (`telemetry-snapshot.ts`, `telemetry-watch.ts`), görev zamanlayıcı (`schedule-windows.ts`) ve `start-production.cmd` / CI düzeltmelerini uygula.

#### `B3`.. Zorunlu Doğrulama & Kabul Kapısı

- `pnpm exec vitest run tests/ops/backup-telemetry-and-guards.test.ts tests/package-script-references.test.ts` → **PASS**
- `git grep -n "docker exec" scripts/` → **0 aktif çağrı** (yalnız CI Linux kapsayıcı ortam değişkeni bağdaştırıcısı hariç sabit `mas-radar-pg` referansı `0`).
- `pnpm ops:telemetry:alerting:verify` (tek kullanımlık DB üzerinde) → `exit 3` harici kopya eksikliği enjekte edildiğinde `ALL CLEAR` değil `WARN/FAIL` alarmı üretildiği kanıtlanır.
- Kalıcı kapılar: `pnpm typecheck && pnpm lint && pnpm phase17:verify && pnpm phase18:verify && pnpm boundary:verify` → **ALL PASS**.

---

## 6. KÜME C — FİNANSAL MATEMATİK, GÖRÜNÜM (`0094`) DOĞRULUĞU, VERGİ TAKVİMİ VE DÖNEM KİLİDİ

---

### Faz 44 (`C1`) — Veritabanı Görünüm (`0094`/`0070`/`0078`/`0050`) Onarımı, `FIN-03` Bilinmeyen Açılış Bakiyesi, Kısıt Doğrulama ve FK İndeksleri (`Migration 0099`)

#### `C1`) — Veritabanı Görünüm (`0094`/`0070`/`0078`/`0050`) Onarımı, `FIN-03` Bilinmeyen Açılış Bakiyesi, Kısıt Doğrulama ve FK İndeksleri (`Migration 0099`.. Fazın Amacı & Çözdüğü Rapor Bulguları / Rakip Mekanikleri

- **Amaç:** Gerçek kredi taksitlerinin %100'ünü gizleyen (`'planned'` / `'late'` statü düşürme) ve dövizli çek/kredilere sahte `'TRY'` damgası vuran `0094` / `0080` görünüm hatalarını düzeltmek; `FIN-03` bilinmeyen açılış bakiyesi (`opening_balance IS NULL`) kuralını ve `treasury_cashflow_reconciliation` sahte P0 mutabakat alarmını kapatmak; `current_account_ledger`, `invoice_allocations`, `control_large_payments`, `control_approval_bypass`, `cash_forecast_13w`, `optimization_run_summary`, `budget_vs_actual`, `payment_priority_queue` hatalarını onarmak; `0083` doküman silme tetikleyici çatışmasını, `0034` durum makinesi çıkmazlarını, 8 doğrulanmamış (`NOT VALID`) kısıtı, 16 serbest `currency` kolonunu, eksik sıcak FK indekslerini ve $O(N^2)$ `control_dashboard` görünümünü temizlemek.
- **Kapatılan Rapor Bulguları:** `B4-01`, `B4-02` (`FIN-03` + `treasury_cashflow_reconciliation`), `B4-03`, `B4-05`.

#### `C1`) — Veritabanı Görünüm (`0094`/`0070`/`0078`/`0050`) Onarımı, `FIN-03` Bilinmeyen Açılış Bakiyesi, Kısıt Doğrulama ve FK İndeksleri (`Migration 0099`.. Değişecek Mevcut Dosyalar & Oluşturulacak Yeni Dosyalar

- **Oluşturulacak Yeni Dosyalar:**
  1. `supabase/migrations/0099_view_math_fin03_constraints_and_indexes.sql` — Görünüm matematiği, `FIN-03`, çapraz-döviz tahsis kilidi, durum makinesi düzeltmeleri, kısıt doğrulamaları ve FK indeksleri migration'ı (**her `CREATE OR REPLACE VIEW` tanımında `WITH (security_invoker = true)` zorunlu!**).
  2. `tests/financial/view-math-and-fin03.test.ts` — `'planned'`/`'late'` kredi taksitleri, `USD` çek/kredi ayrımı, `opening_balance IS NULL` (`FIN-03`) `NULL` yayılımı, yıllık bütçe 12-ay dağılımı ve çapraz-döviz fatura tahsisi reddi testleri.
- **Değişecek Mevcut Dosyalar:**
  1. `src/lib/treasury/engine.ts` (`loadPositionSummary`, `loadLiquidityHorizons` — satır `85-185`) ve `src/app/(dashboard)/finance/treasury/page.tsx`: `unknown_opening_count > 0` olduğunda `available_now` ve `gap` alanlarını uydurma kesin sayı yerine `null` (`"— (açılış bakiyesi eksik: N hesap)"`) olarak işle ve hareket bazlı net değişimi (`movement_delta`) ayrı yardımcı satırda göster.
  2. `src/lib/receivables/engine.ts` (`allocateCollection` — satır `218-245`): Uygulama katmanında da kaynak banka hareketi / makbuz döviz cinsi ile hedef fatura döviz cinsi eşleşmiyorsa `DomainError("VALIDATION", "Farklı para birimleri arasında kur çevrimsiz doğrudan tahsis yapılamaz.")` fırlat.
  3. `scripts/db/constraints-verify.ts` ve `scripts/db/transitions-verify.ts`: Yeni çapraz-döviz tahsis tetikleyicisini, `VALIDATE` edilen 8 kısıtı ve `payment_instances` (`unpaid → late`) / `checks` (`bounced → cleared`) geçişlerini doğrula.
  4. `docs/database-schema.md` ve `docs/calculation-rules.md`: `0099` şema ve hesaplama kurallarını belgele (`pnpm phase18:verify` zorunluluğu).

#### `C1`) — Veritabanı Görünüm (`0094`/`0070`/`0078`/`0050`) Onarımı, `FIN-03` Bilinmeyen Açılış Bakiyesi, Kısıt Doğrulama ve FK İndeksleri (`Migration 0099`.. Veritabanı / SQL Migration (`0099`) Spesifikasyonu

- **Dosya:** `supabase/migrations/0099_view_math_fin03_constraints_and_indexes.sql` (`BEGIN`/`COMMIT` ve `CONCURRENTLY` içermez; sıfır `float8`):
  1. **Kredi Taksiti, Ödeme ve Çek Statü / Döviz / Kalan Tutar Onarımı (`WITH (security_invoker = true)`):**
     - `public.debt_maturity_ladder`: `li.status IN ('planned', 'unpaid', 'partial', 'late')` filtresi kullan; sabit `'TRY'` yerine `l.currency` kolonuna göre grupla; kısmi ödenmiş varsa kalan anapara/taksit tutarını baz al.
     - `public.liquidity_forecast_daily` ve `public.financial_calendar`:
       - `loan_installments`: `li.status IN ('planned', 'unpaid', 'partial', 'late')`, para birimi `l.currency`.
       - `payment_instances`: `pi.status IN ('planned', 'unpaid', 'partial', 'late')`, `pi.currency IS NOT NULL` (`coalesce(pi.currency, 'TRY')` kaldırılır; `currency IS NULL` olanlar `unknown_currency_count` olarak ayrı sayılır!), tutar `CASE WHEN pi.status = 'partial' THEN pi.amount - coalesce(pi.paid_amount, 0) ELSE pi.amount END`.
       - `checks`: `c.status IN ('planned', 'in_portfolio', 'in_bank_collection', 'issued_to_vendor')`, para birimi `c.currency` (sabit `'TRY'` kaldırılır!).
       - **Çift Sayım Engeli:** Bir fatura (`invoices`) halihazırda bir `payment_instances` veya `checks` kaydına bağlıysa (`settled_by_check_id` / `linked_invoice_id`) aynı nakit çıkışını hem fatura hem çek/ödeme dalında iki kez toplama.
  2. **`FIN-03` Bilinmeyen Açılış Bakiyesi ve Hazine Mutabakatı:**
     - `public.bank_cash_position`: `ca.opening_balance IS NULL` ise `opening_known = false`, `movement_net = sum(...)`, `derived_balance = NULL` (`ca.opening_balance + movement_net` doğal SQL `NULL` yayılımı!).
     - `public.treasury_position_summary`: Para birimi bazında `unknown_opening_count = count(*) FILTER (WHERE ca.is_active AND ca.opening_balance IS NULL)`; `unknown_opening_count > 0` ise `available_now = NULL`, `movements_only_total = sum(movement_net)`.
     - `public.treasury_liquidity_gap`: `available_now IS NULL` olduğunda `projected_closing = NULL`, `liquidity_gap = NULL`, `floor_breached = NULL` (`status = 'unknown_opening_balance'`).
     - `public.treasury_cashflow_reconciliation`: Aktif `TRY` hesaplarının hepsinin `opening_balance` değeri biliniyorsa `sum(ca.opening_balance) + net_movements` ile `cashflow_months.closing_balance` karşılaştırılır; `unknown_opening_count > 0` ise sahte `'divergent'` yerine `'incomplete_opening_balance'` döndürür.
  3. **Diğer 7 Görünüm ve Çapraz-Döviz Kısıtı:**
     - `public.current_account_ledger`: `(party_id, currency)` bazında grupla; satış faturası (`sale`) `+borç (alacak artışı)`, tahsilat `-alacak`; alış faturası (`purchase`) `-alacak (borç artışı)`, ödeme `+borç` olarak muhasebe işaretini düzelt.
     - `enforce_invoice_allocation_currency()` (`BEFORE INSERT OR UPDATE ON public.invoice_allocations`): Fatura `currency` değeri ile kaynak `bank_transactions` / `unallocated_receipts` `currency` değeri eşit değilse `RAISE EXCEPTION 'cross_currency_allocation_forbidden' USING ERRCODE = '23514'`.
     - `public.control_large_payments` ve `public.control_approval_bypass`: Yabancı para ödemelerde `fx_rate_snapshots` üzerinden en güncel `<= due_date` TCMB kuruyla `try_equivalent` hesaplayarak `100000` TL eşiğiyle kıyasla (kur yoksa `needs_fx_review = true` olarak ayrıca bayrakla).
     - `public.cash_forecast_13w` ve `public.optimization_run_summary`: `currency` kolonunu `GROUP BY` anahtarına ekle.
     - `public.budget_vs_actual`: Yıllık (`period_granularity = 'annual'`) bütçe satırlarını ilgili bütçe yılının 12 ayına eşit/dönemsel dağıt veya yıllık toplam gerçeklerle kıyasla; kategori birleştirmesini `actuals` alt sorgusunda önceden toplayarak $N$-kat çarpılma (`fan-out`) hatasını sıfırla.
     - `public.payment_priority_queue`: `WHERE p.status = 'active' AND pi.direction = 'outflow'` filtrelerini zorla.
     - `public.control_dashboard`: Korelasyonlu alt sorguları tek taramalı CTE `UNION ALL` toplamına dönüştür.
  4. **Şema Tutarlılığı, Durum Makinesi ve Sıcak FK İndeksleri:**
     - `0083` çatışması: `public.attachments` üzerindeki `document_id` FK kuralını `ON DELETE RESTRICT` yap (ek silinmezlik tetikleyicisiyle %100 uyumlu).
     - `0034` geçiş bekçisi güncellemesi: `payment_instances` için `unpaid → late` ve `planned → late`; `checks` için `bounced → cleared` ve `bounced → cancelled` geçişlerine izin ver.
     - `0023` ve `0025` içindeki 8 `NOT VALID` kısıt için `ALTER TABLE ... VALIDATE CONSTRAINT ...` çalıştır; serbest `currency` kolonu taşıyan tablolarda `CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$')` kuralını uygula; sıcak FK kolonlarına (`invoices(party_id)`, `payment_instances(payment_id, status, due_date)`, `bank_transactions(bank_account_id, status, tx_date)`, `invoice_allocations(invoice_id)`, `loan_installments(loan_id, status, due_date)`, `checks(status, maturity_date)`, `approvals(entity_table, entity_id, status)`) eksik B-tree indekslerini ekle.

#### `C1`) — Veritabanı Görünüm (`0094`/`0070`/`0078`/`0050`) Onarımı, `FIN-03` Bilinmeyen Açılış Bakiyesi, Kısıt Doğrulama ve FK İndeksleri (`Migration 0099`.. Adım Adım Uygulama Talimatları

1. `0099` içinde yeniden tanımlanan her görünümün `CREATE OR REPLACE VIEW public.<name> WITH (security_invoker = true) AS ...` ile başladığını ve `REVOKE INSERT, UPDATE, DELETE` kuralını koruduğunu doğrula.
2. Görünüm kolon imzası değişen yerlerde (`DROP VIEW` gerekiyorsa bağımlılık sırasıyla yeniden oluşturup `0057` `SELECT` yetkilerini geri ver) tüm bağımlı görünümlerin eksiksiz ayağa kalktığını `db:migrate` üzerinde test et.
3. `src/lib/treasury/engine.ts` ve `receivables/engine.ts` güncellemelerini yap; `docs/database-schema.md` içine `0099` kaydını ekle.

#### `C1`) — Veritabanı Görünüm (`0094`/`0070`/`0078`/`0050`) Onarımı, `FIN-03` Bilinmeyen Açılış Bakiyesi, Kısıt Doğrulama ve FK İndeksleri (`Migration 0099`.. Zorunlu Doğrulama & Kabul Kapısı (Yalnız Tek Kullanımlık DB!)

- Tek kullanımlık `mas_radar_c1_verify` veritabanında:
  - `pnpm db:migrate` → `0099` sıfır hatayla uygulanır.
  - `pnpm exec vitest run tests/financial/view-math-and-fin03.test.ts tests/security/view-security-invoker.test.ts` → **PASS** (48 `'planned'` kredi taksiti görünür, `100.000 USD` çek `TRY` likidite açığına karışmaz, `opening_balance IS NULL` iken `available_now` `NULL` döner, `USD → TRY` tahsis `23514` ile reddedilir).
  - `pnpm db:constraints:verify && pnpm db:transitions:verify && pnpm db:roles-rls:verify` → **ALL PASS**.
- Kalıcı kapılar: `pnpm typecheck && pnpm lint && pnpm phase17:verify && pnpm phase18:verify && pnpm boundary:verify` → **ALL PASS**.

---

### Faz 45 (`C2`) — Veritabanı Seviyesinde Dönem Kilidi (`Hard Period Lock`) ve Kapanış Kontrol Kapısı (`Migration 0100`)

#### `C2`) — Veritabanı Seviyesinde Dönem Kilidi (`Hard Period Lock`) ve Kapanış Kontrol Kapısı (`Migration 0100`.. Fazın Amacı & Çözdüğü Rapor Bulguları / Rakip Mekanikleri

- **Amaç:** Kapanmış (`status = 'locked'`) bir finansal aya geçmişe dönük fatura, ödeme, nakit satırı, çek, kredi taksiti veya banka hareketi eklenmesini/değiştirilmesini/silinmesini uygulama koduna güvenmeden **doğrudan PostgreSQL `BEFORE` tetikleyicisiyle** engellemek; dönem kilitleme ve yeniden açma (`reopen`) yetkisini zorunlu gerekçe ve denetim iziyle yalnız `finance_manager` / `admin` katmanına bağlamak.
- **Kapatılan Rapor Bulguları:** `B4-04` (sıfır DB dönem kilidi, `finance_operator` kilit açma açığı, `cm.updated_at` ile silinen kapalı dönem mutasyon kanıtı).

#### `C2`) — Veritabanı Seviyesinde Dönem Kilidi (`Hard Period Lock`) ve Kapanış Kontrol Kapısı (`Migration 0100`.. Değişecek Mevcut Dosyalar & Oluşturulacak Yeni Dosyalar

- **Oluşturulacak Yeni Dosyalar:**
  1. `supabase/migrations/0100_hard_period_lock_enforcement.sql` — `cashflow_months` kilit metadata kolonları, rol-korumalı durum geçişi ve 7 finansal tabloda `enforce_closed_period_lock()` tetikleyicisi.
  2. `src/lib/cashflow/period-lock.ts` — Kapanış öncesi ön-kontrol (`evaluatePeriodCloseReadiness`: eşleşmemiş banka hareketi sayısı, taslak/onaysız fatura sayısı, eksik tutarlı ödeme sayısı, süreklilik kopukluğu), dönem kilitleme (`lockCashflowPeriod`) ve gerekçeli yeniden açma (`reopenCashflowPeriod`) servis fonksiyonları.
  3. `tests/financial/period-lock.test.ts` — Kilitli aya `INSERT`/`UPDATE`/`DELETE` denemelerinin tüm 7 tabloda `P0001` / `period_locked` ile reddedildiğini, `finance_operator` kilit açma denemesinin reddedildiğini ve yönetici `reopen` akışının `audit_logs` kaydı ürettiğini doğrulayan test.
- **Değişecek Mevcut Dosyalar:**
  1. `src/app/(dashboard)/cashflow/[monthId]/page.tsx` ve `src/app/(dashboard)/cashflow/actions.ts`: Ay detay ekranına **"Dönem Kapanış Kontrol Listesi"** kartı, **"Dönemi Kilitle"** (`finance_manager+`) ve zorunlu gerekçeli **"Kilidi Yeniden Aç"** çekmecesi ekle.
  2. `tests/interaction/manifest.ts`: `/cashflow/[monthId]` dönem kilitleme ve yeniden açma kontrollerini `mutation` sınıfıyla kaydet.
  3. `docs/database-schema.md`: `0100_hard_period_lock_enforcement.sql` kaydını ekle (`pnpm phase18:verify` zorunluluğu).

#### `C2`) — Veritabanı Seviyesinde Dönem Kilidi (`Hard Period Lock`) ve Kapanış Kontrol Kapısı (`Migration 0100`.. Veritabanı / SQL Migration (`0100`) Spesifikasyonu

- **Dosya:** `supabase/migrations/0100_hard_period_lock_enforcement.sql`:
  1. `public.cashflow_months` tablosuna `locked_at timestamptz`, `locked_by uuid REFERENCES public.users(id)`, `reopened_at timestamptz`, `reopened_by uuid REFERENCES public.users(id)`, `reopen_reason text`, `lock_fingerprint text` kolonlarını ekle.
  2. `enforce_cashflow_month_lock_transition()` (`BEFORE UPDATE ON public.cashflow_months`):
     - `NEW.status = 'locked'` veya `OLD.status = 'locked'` geçişlerinde `current_user NOT IN ('mas_radar_finance_manager', 'mas_radar_admin', 'postgres')` ise `RAISE EXCEPTION 'period_lock_requires_manager' USING ERRCODE = '42501'`.
     - `OLD.status = 'locked' AND NEW.status <> 'locked'` (yeniden açma) ise `NEW.status` yalnız `'reviewed'` olabilir ve `coalesce(length(trim(NEW.reopen_reason)), 0) < 10` ise `RAISE EXCEPTION 'period_reopen_reason_required' USING ERRCODE = '23514'`.
     - Kilitli durumdayken (`OLD.status = 'locked' AND NEW.status = 'locked'`) `opening_balance`, `projected_income`, `projected_expense`, `monthly_delta`, `closing_balance` kolonlarının değiştirilmesini engelle.
  3. `enforce_closed_period_lock()` (`BEFORE INSERT OR UPDATE OR DELETE`):
     - İşlemin etkilediği tarih(ler) (`OLD` ve `NEW` üzerindeki ilgili tarih kolonu: `payment_instances.due_date` ve `paid_at::date`, `cashflow_lines` bağlı `cashflow_month_id`, `invoices.issue_date` ve `due_date`, `invoice_allocations.allocated_at::date`, `checks.maturity_date`, `loan_installments.due_date` ve `paid_at::date`, `bank_transactions.tx_date`) için `date_trunc('month', target_date)::date` ayı `public.cashflow_months` tablosunda `status = 'locked'` ise `RAISE EXCEPTION 'period_locked: % ayı kilitlidir, kayıt değiştirilemez.', to_char(target_month, 'YYYY-MM') USING ERRCODE = 'P0001'`.
  4. `public.control_closed_period_mutations` (`WITH (security_invoker = true)`): `cm.updated_at` yerine değiştirilemez `cm.locked_at` zaman damgasını baz alacak şekilde güncelle.

#### `C2`) — Veritabanı Seviyesinde Dönem Kilidi (`Hard Period Lock`) ve Kapanış Kontrol Kapısı (`Migration 0100`.. Adım Adım Uygulama Talimatları

1. `0100` migration'ını yazarken hem eski tarihten açık aya kayıt taşınmasını (`OLD.due_date` kilitli ayda!) hem de açık aydan kilitli aya tarih kaydırılmasını (`NEW.due_date` kilitli ayda!) ikili olarak kontrol et.
2. `src/lib/cashflow/period-lock.ts` içinde PostgreSQL `period_locked` hatasını yakalayıp kullanıcıya anlaşılır Türkçe `DomainError("CONFLICT", "Seçili dönem kilitli olduğu için işlem yapılamaz. Düzeltme için Finans Yöneticisi dönem kilidini gerekçeli olarak açmalıdır.")` mesajına çevir.

#### `C2`) — Veritabanı Seviyesinde Dönem Kilidi (`Hard Period Lock`) ve Kapanış Kontrol Kapısı (`Migration 0100`.. Zorunlu Doğrulama & Kabul Kapısı (Yalnız Tek Kullanımlık DB!)

- Tek kullanımlık `mas_radar_c2_verify` veritabanında `pnpm db:migrate` ve `pnpm exec vitest run tests/financial/period-lock.test.ts` → **PASS** (7 tablonun tamamında kilitli aya yazma/silme reddedilir; açık aya yazma normal çalışır; yönetici gerekçeli kilit açma + yeniden kilitleme tam `audit_logs` izi bırakır).
- Kalıcı kapılar: `pnpm typecheck && pnpm lint && pnpm phase17:verify && pnpm phase18:verify && pnpm boundary:verify` → **ALL PASS**.

---

### Faz 46 (`C3`) — Çekirdek Finans Motorları Onarımı (Davranışsal Tahsilat V2, Likidite Çözücü, Canlı TCMB Kur, Hazine Tabanı, Banka Eşleştirici, Kredi Vadesi ve TR Resmi Vergi/SGK Takvimi)

#### `C3`) — Çekirdek Finans Motorları Onarımı (Davranışsal Tahsilat V2, Likidite Çözücü, Canlı TCMB Kur, Hazine Tabanı, Banka Eşleştirici, Kredi Vadesi ve TR Resmi Vergi/SGK Takvimi.. Fazın Amacı & Çözdüğü Rapor Bulguları / Rakip Mekanikleri

- **Amaç:** `src/lib/*` altındaki tüm finansal hesaplama hatalarını tek fazda sıfırlamak: Tesorio/HighRadius tarzı **5 Katmanlı Deterministik Davranışsal Tahsilat Tarihi (`expectedCollectionDateV2`)** ile "Today Cliff" hatasını kaldırmak ve `null` kalan alacak yoğunlaşmasını onarmak; likidite optimizasyon çözücüsünü çek/kredi/açık fatura/döviz/amaç fonksiyonuna kavuşturup sabit `"Cagdas"/"Hpt"` kodunu temizlemek; canlı TCMB XML ayrıştırıcısını gerçek TCMB formatıyla çalıştırmak; hazine ufuk-içi temerrüt tespitini ve 90 takvim günü taban bölenini düzeltmek; banka eşleştiricisinde işaret/döviz kontrolünü sağlamak; kredi taksitlerinde Şubat-28 vade kaymasını düzeltmek ve Türkiye resmi tatil/hafta sonu kaydırmalı (**VUK Md. 18**) **Türkiye Resmi Vergi/SGK Takvim Motorunu** kurmak (2024'te kalkan BA/BS olmadan, 7566 Sayılı Kanun 4. Dönem Geçici Vergi dahil!).
- **Kapatılan Rapor Bulguları:** `B3-01`, `B3-02`, `B3-03`, `B3-05`, `B3-06`, `docs/todo.md` backlog `#4`, `#5`, `Çapraz Hakemlik §9.2` (BA/BS çürütmesi + Geçici Vergi).

#### `C3`) — Çekirdek Finans Motorları Onarımı (Davranışsal Tahsilat V2, Likidite Çözücü, Canlı TCMB Kur, Hazine Tabanı, Banka Eşleştirici, Kredi Vadesi ve TR Resmi Vergi/SGK Takvimi.. Değişecek Mevcut Dosyalar & Oluşturulacak Yeni Dosyalar

- **Oluşturulacak Yeni Dosyalar:**
  1. `src/lib/calendar/tr-holidays.ts` — Türkiye resmi tatilleri (1 Ocak, 23 Nisan, 1 Mayıs, 19 Mayıs, 15 Temmuz, 30 Ağustos, 29 Ekim + 2026–2030 Ramazan ve Kurban Bayramı arife/bayram günleri tablosu) ve `nextTurkishBusinessDay(isoDate: string): { effectiveDate: string; shiftedFrom: string | null; reason: string | null }` (**VUK Md. 18** hafta sonu + resmi tatil kaydırma fonksiyonu).
  2. `src/lib/calendar/tr-tax-calendar.ts` — Deterministik Türkiye vergi/SGK yükümlülük takvim üreteci:
     - **KDV-2 (Sorumlu Sıfatıyla Tevkifat KDV):** Takip eden ayın **25'i** (beyan ve ödeme)
     - **Muhtasar ve Prim Hizmet Beyannamesi (MPHB — Stopaj/Damga):** Takip eden ayın **26'sı**
     - **KDV-1 (Katma Değer Vergisi):** Takip eden ayın **28'i**
     - **SGK 4/a İşveren ve İşçi Sigorta Primleri:** Takip eden ayın **son günü**
     - **Kurumlar Geçici Vergi (4 Dönem — 7566 Sayılı Kanun uyumlu):** Q1 **17 Mayıs**, Q2 **17 Ağustos**, Q3 **17 Kasım**, Q4 **17 Şubat**
     - **Kurumlar Vergisi Yıllık Beyan ve Ödeme:** **30 Nisan**
     - **Motorlu Taşıtlar Vergisi (MTV 1. ve 2. Taksit):** **31 Ocak** ve **31 Temmuz**
     *(Yürürlükten kaldırılan BA/BS formları kesinlikle üretilmez; tüm tarihler `nextTurkishBusinessDay` ile ilk iş gününe kaydırılır.)*
  3. `tests/financial/core-engines-c3.test.ts` — Davranışsal tahsilat V2, canlı TCMB gerçek XML örneği, Ocak-31 başlangıçlı 36 ay kredi vade koruma, ufuk-içi Gün-3 temerrüt tespiti, VUK Md. 18 tatil kaydırması ve 4 dönem Geçici Vergi dahil kapsamlı birim test paketi.
- **Değişecek Mevcut Dosyalar:**
  1. `src/lib/collections/rules.ts` (satır `60-115`) ve `src/lib/collections/engine.ts` (satır `150-210`):
     - `expectedCollectionDateV2`:
       1. `badDebtFlagged === true` → `projectedDate: null, bucket: "doubtful_excluded"` (asla 7 günlük likidite girişine eklenmez!).
       2. Aktif ve kırılmamış (`status = 'open' AND promised_date >= todayISO`) `promise_to_pay` varsa → `promised_date` (`bucket: "promised"`).
       3. Müşterinin geçmiş kapanmış faturalarından (`invoice_allocations`) en az 3 örneklem varsa medyan `DBT` (`days_beyond_terms`, `P75` ihtiyatlı mod seçeneğiyle): `dueDate + medianDbt >= todayISO` ise o tarih (`bucket: "behavioral_dbt"`).
       4. Henüz vadesi gelmemiş fatura (`dueDate >= todayISO`) → `dueDate + defaultLag` (`bucket: "scheduled"`).
       5. Vadesi geçmiş ve beklenen tarihi `todayISO` öncesinde kalan açık fatura → **asla `todayISO` üzerine yığılmaz**, `projectedDate: null, bucket: "overdue_unscheduled"` olarak ayrı **"Takvime Bağlanmamış Gecikmiş Alacak"** kovasında gösterilir!
     - `loadReceivableRisk`: `SELECT` listesine `currency` kolonunu ekle; `TRY` alacaklar için `concentrationRatio` hesabını canlandır ve dövizli alacak yoğunlaşmasını para birimi bazında ayrı döndür.
  2. `src/lib/optimization/engine.ts` (satır `50-175`) ve `src/lib/optimization/rules.ts` (satır `170-365`):
     - Günlük yüklemelere `checks` (`outflow`/`inflow`), `loan_installments` (`planned`/`unpaid`/`partial`/`late`) ve şablonsuz açık `payables_open` faturalarını dahil et; tüm sorgularda `currency = $1` filtresi uygula.
     - `FIN-03` uyarınca `openingCash === null` ise çözücüyü uydurma `0` kasa ile koşturma; `"Açılış bakiyesi bilinmeyen aktif hesap bulunduğu için optimizasyon simülasyonu durduruldu"` uyarısı döndür.
     - `credit_facilities` tablosundan gerçek `drawn_amount` değerini oku ve `input.objective` (`"min_cost" | "max_buffer" | "min_deferrals"`) sıralama/amaç fonksiyonunu gerçekten uygula.
  3. `src/lib/scenarios/engine.ts` (satır `150-190`) ve `src/lib/scenarios/rules.ts` (satır `75-120`):
     - Sabit `"Cagdas"` ve `"Hpt"` dizgelerini kaldır; gerçek en büyük açık tedarikçi/müşteri satırlarından dinamik aday türet.
  4. `src/lib/fx/provider.ts` (satır `70-125`) ve `src/lib/fx/rules.test.ts` (satır `110-140`):
     - `parseTcmbXml` içinde gerçek TCMB kök etiketi `<Tarih_Date[^>]*\bTarih="(\d{2})\.(\d{2})\.(\d{4})"` üzerinden bülten tarihini ayrıştır (yedek olarak `Date="(\d{2})\/(\d{2})\/(\d{4})"` Amerikan formatını `YYYY-MM-DD` çevir); kaydedilen kur satırında `bulletin_date` (TCMB bülten tarihi) ile `queried_date` ayrımını koru. `rules.test.ts` içine gerçek TCMB XML başlığı koy.
  5. `src/lib/treasury/rules.ts` (satır `80-120`) ve `src/lib/treasury/engine.ts` (satır `240-295`):
     - Likidite açığı ve taban ihlali hesabında yalnızca ufuk sonu (`day N`) kapanışına değil, `[todayISO .. todayISO + N]` aralığındaki **en düşük kümülatif günlük bakiyeye (`minIntraHorizonBalance`, `worstDayISO`)** bak!
     - Dinamik nakit tabanı (`resolveFloor`) hesabında son 90 gündeki toplam çıkışı aktif çıkış gün sayısına değil, sabit **`90` takvim gününe** (`Big(total90dOutflow).div(90)`) böl.
  6. `src/lib/bank/rules.ts` (satır `95-115`, `365-390`) ve `src/lib/bank/engine.ts` (satır `340-390`):
     - Eşleştirme adaylarında işaret yönü (`tx.amount > 0` ↔ `inflow/sale`, `tx.amount < 0` ↔ `outflow/purchase`) ve `tx.currency === candidate.currency` eşitliğini zorunlu kıl (`Math.abs` ile ters yönlü eşleştirmeyi kaldır); açık `0,00` tutarları `0` olarak koru.
  7. `src/lib/briefing/engine.ts` (satır `55-75`, `125-165`), `src/lib/briefing/rules.ts` (satır `98-115`), `src/lib/analytics/engine.ts` (satır `150-230`), `src/lib/analytics/analyses.ts` (satır `255-340`), `src/lib/reports/rules.ts` (satır `150-305`), `src/lib/reports/engine.ts` (satır `35-195`), `src/lib/facts/engine.ts` (satır `100-125`):
     - `briefing`: `TRY` satırı yoksa yabancı döviz satırına `" TL"` damgası vurma; `gap7 === null` iken `"kritik kalem görünmüyor"` yerine `"7 günlük likidite açığı hesaplanamadı (açılış bakiyesi eksik)"` yaz.
     - `analytics`: `runAgeingDistribution` içine `currency` parametresi (`varsayılan 'TRY'`) ekle; `runRollingTrend` içinde `asOf` tarihini uygula, `NULL` tutarlı günleri `0` saymadan işaretle, 7 takvim günü penceresi ve `Big` aritmetiği kullan; `analyses.ts:260` nakit köprüsünde bilinmeyen gelir/gider varken mutabakat hükmünü `"incomplete_unknown_lines"` yap.
     - `reports` & `facts`: `watchRatio` eşik dalını düzelt (`criticalRatio` vs `watchRatio` vs `"healthy"`), ayın 1'i çift sayımını (`< nextMonthStart` yarı-açık aralık) ve `inflow` çeklerin borç servisine eklenmesini düzelt; `facts` nakit pistini (`runway`) geçmiş aylardan değil `todayMonthStart` ve sonrasındaki ileri projeksiyon aylarından hesapla.
  8. `src/lib/financing/rules.ts` (satır `230-260`) ve `src/lib/financing/engine.ts` (satır `238-255`, `380-395`):
     - `addMonthsPreservingAnchorDay(firstPaymentDateISO: string, monthOffset: number)` kullanarak `2026-01-31` başlangıçlı kredide Şubat taksitinin `2026-02-28`, Mart taksitinin ise tekrar **`2026-03-31`**, Nisan'ın **`2026-04-30`** olmasını sağla (28'e kalıcı kilitlenme biter!).
     - `schedule[inst.no - 1]` dizin erişimini `Map<number, Installment>` ile değiştir; `(kkdf ?? 0) + (bsmv ?? 0) || null` ifadesini `kkdf === null && bsmv === null ? null : Big(kkdf ?? 0).plus(bsmv ?? 0).toNumber()` olarak düzelt.

#### `C3`) — Çekirdek Finans Motorları Onarımı (Davranışsal Tahsilat V2, Likidite Çözücü, Canlı TCMB Kur, Hazine Tabanı, Banka Eşleştirici, Kredi Vadesi ve TR Resmi Vergi/SGK Takvimi.. Veritabanı / SQL Migration / Arka Plan İşçisi Spesifikasyonu

- Bu faz Faz 44 (`0099`) görünümleri üzerine oturur; `tr-tax-calendar.ts` çıktısı birleşik finansal takvim servisinde (`/cashflow/calendar`) ve Faz 54'teki 13 haftalık doğrudan nakit tahmininde deterministik yasal yükümlülük katmanı olarak kullanılır.

#### `C3`) — Çekirdek Finans Motorları Onarımı (Davranışsal Tahsilat V2, Likidite Çözücü, Canlı TCMB Kur, Hazine Tabanı, Banka Eşleştirici, Kredi Vadesi ve TR Resmi Vergi/SGK Takvimi.. Adım Adım Uygulama Talimatları

1. Tüm parasal hesaplamalarda `src/lib/money.ts` (`Big`) yardımcılarını kullan; hiçbir dosyada `::float8` veya JS kayan noktalı para toplaması yazma.
2. `expectedCollectionDateV2` geçişinde mevcut `phase23` ve `phase25` testlerinin beklentilerini kontrol et: vadesi geçmiş tahsilatların artık sahte `todayISO` girişi yerine `overdue_unscheduled` kovasında raporlandığını hem pozitif hem negatif vakalarla doğrula.
3. `docs/calculation-rules.md` dosyasını yeni `expectedCollectionDateV2`, `minIntraHorizonBalance`, `90-gün` taban böleni, çapası korunan kredi vadeleri ve Türkiye vergi takvimi kurallarıyla güncelle.

#### `C3`) — Çekirdek Finans Motorları Onarımı (Davranışsal Tahsilat V2, Likidite Çözücü, Canlı TCMB Kur, Hazine Tabanı, Banka Eşleştirici, Kredi Vadesi ve TR Resmi Vergi/SGK Takvimi.. Zorunlu Doğrulama & Kabul Kapısı

- `pnpm exec vitest run tests/financial/core-engines-c3.test.ts tests/financial src/lib/collections src/lib/optimization src/lib/fx src/lib/treasury src/lib/bank src/lib/financing src/lib/analytics src/lib/reports src/lib/briefing` → **ALL PASS**
- Kalıcı kapılar: `pnpm typecheck && pnpm lint && pnpm phase17:verify && pnpm phase18:verify && pnpm boundary:verify` → **ALL PASS**.

---

## 7. KÜME D — BİLGİ MİMARİSİ SADELEŞTİRMESİ, KAPANMAYAN İŞ DÖNGÜLERİNİN KAPATILMASI VE CFO İŞ AKIŞLARI

---

### Faz 47 (`D1`) — Bilgi Mimarisi Konsolidasyonu, 11 Eski Yönlendirme Klasörünün Temizliği, Tekil Metrik Sözleşmesi ve Çift `Ctrl+K` / Ödeme Düzenleme Formu Onarımı

#### `D1`.. Fazın Amacı & Çözdüğü Rapor Bulguları / Rakip Mekanikleri

- **Amaç:** `next.config.ts` `308` yönlendirmeleri arkasında kalan 11 eski gölge rota klasörünü (`1.028` satır ölü sayfa kodu + tersine dönmüş `actions.ts` bağımlılıkları) ve kopya `/overview` ekranını temizlemek; `/finance` altındaki 17 taşan düz sekmeyi 1366px/1440px ekranlarda hiç kaybolmayacak gruplu alt-navigasyona dönüştürmek (`/system/diagnostics` sekmesini eklemek); aynı anda iki pencere açan Çift `Ctrl+K` / `⌘K` çakışmasını ve `/payments/[paymentId]/edit` formundaki zorunlu `archive_reason` kilidini düzeltmek; ekranlar arası 4 metrik çelişkisini (`partial` kalan tutar, 4 farklı `"Açık alacak"`, 2028 `"Mevcut nakit"`, döviz satırlarında sabit `" TL"`) ve ASCII Türkçe/İngilizce enum sızıntılarını sıfırlamak.
- **Kapatılan Rapor Bulguları:** `Bölüm 6.1 #5` (`payment-form.tsx:128` `archive_reason` kilidi), `Bölüm 6.2` (4 metrik çelişkisi, çift `Ctrl+K`, 17 taşan `/finance` sekmesi, eksik `/system/diagnostics` sekmesi, 11 eski klasör + `/overview`, ASCII Türkçe).

#### `D1`.. Değişecek Mevcut Dosyalar & Oluşturulacak Yeni Dosyalar

- **Silinecek Eski Gölge Sayfa Klasörleri (12 Klasör — `next.config.ts` `308` kalıcı yönlendirmeleri korunur!):**
  1. `src/app/(dashboard)/overview/` (`/` kanonik CFO Masasıdır; `next.config.ts` içinde `/overview → /` `308` yönlendirmesi eklenir)
  2. `src/app/(dashboard)/admin/`
  3. `src/app/(dashboard)/ask/`
  4. `src/app/(dashboard)/assumptions/`
  5. `src/app/(dashboard)/calendar/`
  6. `src/app/(dashboard)/data-quality/`
  7. `src/app/(dashboard)/financing/`
  8. `src/app/(dashboard)/imports/`
  9. `src/app/(dashboard)/phases/`
  10. `src/app/(dashboard)/radar/`
  11. `src/app/(dashboard)/reminders/`
  12. `src/app/(dashboard)/reports/`
  *(Silmeden önce kanonik rotaların eski klasörlerden yeniden dışa aktardığı tüm Server Action fonksiyonları doğrudan kanonik `src/app/(dashboard)/{payments,cashflow,finance,data,insights,system}/**/actions.ts` dosyalarına taşınır!)*
- **Oluşturulacak Yeni Dosyalar:**
  1. `src/lib/money-format.ts` — Döviz-duyarlı tekil para biçimlendirici: `formatMoney(amount: number | string | null, currency?: string | null): string` (`null` → `"—"`, `'TRY'` → `"12.345,67 TL"`, `'USD'` → `"12.345,67 USD"`, `'EUR'` → `"12.345,67 EUR"`, `currency == null` → `"12.345,67 (PB?)"` — asla yabancı paraya `" TL"` basmaz!).
  2. `src/lib/metrics/canonical-kpis.ts` — Tüm kokpit ve modül başlıklarının tek kaynaktan okuduğu kanonik metrik yükleyicisi (7 günlük kalan çıkış, `TRY` açık alacak + döviz kovaları, hazine `available_now` + `unknown_opening_count`).
  3. `tests/ui/ia-and-metric-consistency.test.tsx` — Tekil `Ctrl+K` dinleyicisi, `payment-form.tsx` düzenleme vs. arşivleme formu ayrımı, `formatMoney` döviz etiketleri ve eski 12 klasörün kaldırıldığının doğrulama testi.
- **Değişecek Mevcut Dosyalar:**
  1. `src/components/radar/payment-form.tsx` (satır `60-145`): Ana düzenleme `<form action={updatePaymentAction}>` içinden arşivleme alt kutusunu çıkarıp **ayrı kardeş `<form action={archivePaymentAction}>`** olarak aşağıya yerleştir; böylece `required name="archive_reason"` yalnızca **"Arşivle"** düğmesine basıldığında sorulsun ve **"Kaydet"** düğmesi engelsiz çalışsın!
  2. `src/components/ui/nav.tsx` (satır `48-65`), `src/components/search/command-palette.tsx` (satır `33-55`) ve `src/components/search/command-palette-trigger.tsx`: `AppSidebar` içindeki ikinci `Ctrl+K` / `⌘K` modalını kaldır; klavye kısayolunu ve kenar çubuğundaki `"Hızlı erişim ⌘K"` düğmesini tek kanonik `CommandPalette` bileşenine bağla (`CommandPalette` içinde hem tam metin varlık araması `/api/search` hem de sayfa/komut geçişi birleşik çalışsın).
  3. `src/app/(dashboard)/finance/layout.tsx`, `src/app/(dashboard)/system/layout.tsx` ve `src/components/ui/module-tabs.tsx`:
     - `/finance` sekmelerini taşmayan 4 mantıksal grup başlığı altında (`Hazine & Banka`, `Alacak & Tahsilat`, `Borç, Çek & Kredi`, `Defter & Kârlılık`) sarılabilir (`flex-wrap`) veya grup seçicili yapıda düzenle; 1366px genişlikte **sıfır gizli sekme** garantisi ver.
     - `/system/layout.tsx` sekmelerine eksik olan `/system/diagnostics` (`Tanılama`) sekmesini ekle.
  4. `src/lib/radar/rules.ts` (satır `135-162`), `src/app/(dashboard)/payments/page.tsx`, `src/app/(dashboard)/finance/invoices/page.tsx`, `src/app/(dashboard)/finance/collections/page.tsx` (satır `48-65`), `src/app/(dashboard)/finance/receivables/page.tsx`, `src/app/(dashboard)/finance/profitability/page.tsx`, `src/app/(dashboard)/finance/checks/page.tsx`, `src/app/(dashboard)/finance/loans/page.tsx`, `src/app/(dashboard)/finance/facilities/page.tsx`, `src/app/(dashboard)/finance/promises/page.tsx`:
     - `partial` ödemelerde kalan tutarı (`amount - paid_amount`) standartlaştır.
     - `"Açık alacak"` kartlarını `canonical-kpis.ts` üzerinden sayfalanmamış tam DB toplamına (`TRY` ana kart + varsa `+ USD / EUR` rozetleri) bağla; `/finance/profitability` üzerindeki brüt ciro kartının adını dürüstçe `"Faturalanan Satış Hacmi"` yap.
     - `/finance/collections/page.tsx:50` üzerindeki `overview.series[last].closing` (2028 kasası!) hatasını gerçek `treasury_position_summary` (`TRY` `available_now`) değerine bağla.
     - Dövizli tablolardaki tüm `fmtTL(row.amount)` çağrılarını `formatMoney(row.amount, row.currency)` ile değiştir.
  5. `src/lib/home/overview-snapshot.ts` ve Türkçe etiket taraması: `Dis varsayim` → `Dış varsayım`, `Donem` → `Dönem` başta olmak üzere tüm ASCII Türkçe kaçaklarını ve ham İngilizce enum değerlerini (`MISSING REQUIRED FIELD`, `FORMULA ERROR`, `MERGED CELL`, `UNMAPPED`, `NEEDS REVIEW`, `DIVERGENT`) temiz Türkçe etiketlere çevir.
  6. `next.config.ts` ve `tests/interaction/manifest.ts`: `/overview → /` `308` yönlendirmesini ekle; manifestodaki rota ve kontrol kurallarını yeni birleşik yapıya göre güncelle.

#### `D1`.. Veritabanı / SQL Migration / Arka Plan İşçisi Spesifikasyonu

- Bu faz şema migration'ı gerektirmez; okuma katmanını, rota ağacını ve UI kabuğunu temizler.

#### `D1`.. Adım Adım Uygulama Talimatları

1. Her eski klasörü silmeden önce `git grep` ile o klasördeki `actions.ts` veya yardımcı bileşenlere dışarıdan yapılan tüm importları kanonik hedef klasöre taşı; hiçbir kırık import bırakma.
2. `payment-form.tsx` içinde iç içe `<form>` (HTML standardında geçersizdir!) kesinlikle kurma; iki ayrı kardeş `<form>` elemanı kullan.
3. 1366×768 ve 1440×900 görünüm genişliklerinde `/finance` altındaki tüm sekmelerin yatay kırpılma olmadan erişilebilir olduğunu doğrula.

#### `D1`.. Zorunlu Doğrulama & Kabul Kapısı

- `pnpm exec vitest run tests/ui/ia-and-metric-consistency.test.tsx tests/perf` → **PASS**
- Kalıcı kapılar: `pnpm typecheck && pnpm lint && pnpm phase17:verify && pnpm phase18:verify && pnpm boundary:verify` → **ALL PASS**.

---

### Faz 48 (`D2`) — Canlı Maker-Checker Onay Döngüsü, Ödeme Çalıştırma Paketi (`payment_runs` + ISO 20022 `pain.001` / 4 Büyük Türk Bankası EFT İhracı) ve Banka Eşleştirme → Otomatik Kapanış (`Migration 0101`)

#### `D2`) — Canlı Maker-Checker Onay Döngüsü, Ödeme Çalıştırma Paketi (`payment_runs` + ISO 20022 `pain.001` / 4 Büyük Türk Bankası EFT İhracı) ve Banka Eşleştirme → Otomatik Kapanış (`Migration 0101`.. Fazın Amacı & Çözdüğü Rapor Bulguları / Rakip Mekanikleri

- **Amaç:** MAS Nakit Radar'ın en kritik operasyonel uçtan uca nakit çıkış/giriş döngüsünü (**Fatura / Ödeme → Maker-Checker Onayı + IBAN BEC Kalkanı → 14 Günlük Kasa Tabanı Simülasyonlu Ödeme Çalıştırma Paketi (`payment_runs`) → Banka EFT / `pain.001` Talimat Dosyası → Banka Hareketi Eşleştirme → Otomatik Ödeme/Fatura/Çek/Taksit Kapanışı**) kesintisiz kapatmak.
- **Kapatılan Rapor Bulguları & Rakip Mekanikleri:** `Bölüm 6.1 #3` (`approvals` 0 canlı çağrıcı), `Bölüm 6.1 #4` (`/finance/bank` eşleşmenin kaydı kapatmaması, aday detayının gizli olması, yetim `reconcileAction`), `Bölüm 6.1 #6` (`/finance/collections` ödeme paketi ve EFT ihracı olmaması) + **Tipalti / Kyriba / Finekra** Payment Run & Liquidity Guardrail mekaniği.

#### `D2`) — Canlı Maker-Checker Onay Döngüsü, Ödeme Çalıştırma Paketi (`payment_runs` + ISO 20022 `pain.001` / 4 Büyük Türk Bankası EFT İhracı) ve Banka Eşleştirme → Otomatik Kapanış (`Migration 0101`.. Değişecek Mevcut Dosyalar & Oluşturulacak Yeni Dosyalar

- **Oluşturulacak Yeni Dosyalar:**
  1. `supabase/migrations/0101_payment_runs_and_bank_settlement_links.sql` — `payment_runs`, `payment_run_items` tabloları, `bank_transactions` kapanış bağlantı kolonları, 5-katmanlı RLS ve geçiş bekçileri.
  2. `src/lib/payments/payment-runs.ts` — Ödeme paketi oluşturma, **14 günlük kasa alt limiti (`minimum cash buffer`) delinme simülasyonu**, onaya gönderme (`requestApproval`), onay sonrası talimat kilitleme ve iptal servisleri.
  3. `src/lib/payments/bank-export.ts` — Onaylanmış (`status = 'approved'`) ödeme paketinden deterministik banka ödeme talimatı üreticisi:
     - **ISO 20022 `pain.001.001.03` XML** (kurumsal internet bankacılığı evrensel standardı, XML varlık kaçışı ve TR IBAN `MOD-97` doğrulamalı)
     - **Garanti BBVA, Türkiye İş Bankası, Yapı Kredi ve Akbank Toplu EFT/Havale CSV & `.xlsx` (`ExcelJS`) Şablonları** (CSV formül enjeksiyonu korumalı).
  4. `src/app/api/payments/runs/[runId]/export/route.ts` — `requireApiSession` + `can(role, "payment_runs", "select")` korumalı, yalnız `status IN ('approved', 'exported', 'settled')` paketler için banka talimat dosyası indirme ucu (`audit()` izli).
  5. `tests/financial/payment-runs-approvals-and-bank-settlement.test.ts` — Fatura → onay → ödeme paketi → `pain.001` XML ihracı → banka hareketi eşleşmesi → fatura/ödeme kapanışı uçtan uca entegrasyon testi.
- **Değişecek Mevcut Dosyalar:**
  1. `src/lib/approvals/engine.ts` ve canlı mutasyon noktaları (`src/lib/invoices/engine.ts`, `src/lib/payments/engine.ts`, `src/lib/counterparties/engine.ts`, `src/lib/budget/engine.ts`):
     - Eşik üstü ödeme/fatura (`>= approval_rules.threshold_amount`), **yeni veya değişmiş tedarikçi IBAN'ı (`iban_change_events` BEC dolandırıcılık kilidi!)** ve ödeme paketi (`payment_runs`) işlemlerinde `evaluateRules` pozitif döndüğünde doğrudan yürütme/onaylı yazma yerine otomatik `requestApproval` oluştur (`approval_status = 'pending_approval'`).
     - `finance_approver` / `finance_manager` `/data/approvals` üzerinden onayladığında (`decideApproval`) hedef kaydın `approval_status = 'approved'` durumuna geçtiğini atomik olarak işle.
  2. `src/lib/bank/engine.ts` (`acceptMatch`, `reconcileBankAccount` — satır `260-395`) ve `src/app/(dashboard)/finance/bank/page.tsx` + `actions.ts`:
     - Eşleşme adayı kartlarında karşı taraf adını, fatura/ödeme/çek numarasını, açık kalan tutarı, para birimini ve vade tarihini açıkça göster.
     - `acceptMatch` içinde kullanıcı eşleşmeyi onayladığında **aynı PostgreSQL transaction içinde**:
       - Hedef `payment_instances` ise: `paid_amount` değerini artır, tam kapandıysa `status = 'paid'`, kısmi ise `status = 'partial'`, `paid_at = tx.tx_date` güncelle.
       - Hedef `invoices` ise: `public.invoice_allocations` satırı ekle (mevcut `0048` tetikleyicisi faturanın `paid_amount` ve `status` alanlarını otomatik günceller!).
       - Hedef `checks` ise: `checks.status = 'cleared'` güncelle ve `check_events` tablosuna `'cleared'` olayı düş.
       - Hedef `loan_installments` ise: `loan_installments.status = 'paid'`, `paid_at = tx.tx_date` güncelle.
       - Hedef bir `payment_run_items` kalemiyle ilişkiliyse kalemi `'settled'` yap; paketteki tüm kalemler kapandıysa `payment_runs.status = 'settled'` yap.
     - Yetim duran `reconcileAction` mutabakat düğmesini `/finance/bank` hesap özeti başlığına bağla.
  3. `src/app/(dashboard)/finance/collections/page.tsx` ve `actions.ts`: Seçili borç/ödeme kalemlerinden **"Ödeme Paketi Oluştur & 14 Gün Kasa Etkisini Simüle Et"** çalışma masasını ve onaylı paketler için **"Banka Talimat Dosyası İndir (`pain.001` / Banka Excel)"** akışını ekle.
  4. `src/lib/authz/matrix.ts`, `tests/interaction/manifest.ts` ve `docs/database-schema.md`: `payment_runs` ve `payment_run_items` tablolarını RLS matrisine, etkileşim manifestosuna ve şema belgesine (`0101`) işle.

#### `D2`) — Canlı Maker-Checker Onay Döngüsü, Ödeme Çalıştırma Paketi (`payment_runs` + ISO 20022 `pain.001` / 4 Büyük Türk Bankası EFT İhracı) ve Banka Eşleştirme → Otomatik Kapanış (`Migration 0101`.. Veritabanı / SQL Migration (`0101`) Spesifikasyonu

- **Dosya:** `supabase/migrations/0101_payment_runs_and_bank_settlement_links.sql`:
  - `public.payment_runs`: `id uuid PK`, `run_code text UNIQUE NOT NULL`, `planned_execution_date date NOT NULL`, `source_bank_account_id uuid NOT NULL REFERENCES public.bank_accounts(id)`, `currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$')`, `total_amount numeric(14,2) NOT NULL CHECK (total_amount > 0)`, `item_count int NOT NULL CHECK (item_count > 0)`, `pre_run_cash numeric(14,2)`, `projected_14d_min_cash numeric(14,2)`, `breaches_cash_floor boolean NOT NULL DEFAULT false`, `status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','pending_approval','approved','exported','settled','cancelled'))`, `approval_id uuid REFERENCES public.approvals(id)`, `created_by uuid NOT NULL REFERENCES public.users(id)`, `approved_by uuid REFERENCES public.users(id)`, `approved_at timestamptz`, `exported_at timestamptz`, `notes text`, `created_at timestamptz`, `updated_at timestamptz`.
  - `public.payment_run_items`: `id uuid PK`, `run_id uuid NOT NULL REFERENCES public.payment_runs(id) ON DELETE CASCADE`, `target_type text NOT NULL CHECK (target_type IN ('invoice','payment_instance','check','loan_installment'))`, `target_id uuid NOT NULL`, `party_id uuid REFERENCES public.parties(id)`, `beneficiary_name text NOT NULL`, `beneficiary_iban text NOT NULL`, `amount numeric(14,2) NOT NULL CHECK (amount > 0)`, `currency text NOT NULL`, `description text NOT NULL`, `iban_verified boolean NOT NULL DEFAULT false`, `settled_bank_tx_id uuid REFERENCES public.bank_transactions(id)`, `status text NOT NULL DEFAULT 'included' CHECK (status IN ('included','settled','excluded'))`.
  - Açık bir hedef kalemin aynı anda iki aktif (`draft`/`pending_approval`/`approved`/`exported`) ödeme paketine eklenmesini önleyen kısmi benzersiz indeks (`CREATE UNIQUE INDEX payment_run_items_active_target_uq ON public.payment_run_items (target_type, target_id) WHERE status = 'included'`).
  - 5-katmanlı RLS: `viewer` yalnız `SELECT`; `finance_operator` `draft` oluşturup onaya sunabilir (`pending_approval`); yalnız `finance_approver`, `finance_manager`, `admin` `status = 'approved'` yapabilir (yapıcı = onaylayıcı olamaz: `approved_by <> created_by` maker-checker kısıtı — tek yönetici acil durum bayrağı `audit_logs` gerekçeli istisnası hariç).

#### `D2`) — Canlı Maker-Checker Onay Döngüsü, Ödeme Çalıştırma Paketi (`payment_runs` + ISO 20022 `pain.001` / 4 Büyük Türk Bankası EFT İhracı) ve Banka Eşleştirme → Otomatik Kapanış (`Migration 0101`.. Adım Adım Uygulama Talimatları

1. TR IBAN doğrulamasını (`TR` + 24 rakam, ISO 7064 `MOD-97 == 1`) `bank-export.ts` içinde zorunlu kıl; geçersiz veya Faz 19'da onaylanmamış yeni IBAN içeren paketin `pain.001` ihracını blokla.
2. `acceptMatch` kapama işleminde `SELECT ... FOR UPDATE` satır kilidi kullanarak aynı banka hareketinin eşzamanlı iki tıklamayla faturayı iki kez kapatmasını (yarış durumunu) önle.

#### `D2`) — Canlı Maker-Checker Onay Döngüsü, Ödeme Çalıştırma Paketi (`payment_runs` + ISO 20022 `pain.001` / 4 Büyük Türk Bankası EFT İhracı) ve Banka Eşleştirme → Otomatik Kapanış (`Migration 0101`.. Zorunlu Doğrulama & Kabul Kapısı (Yalnız Tek Kullanımlık DB!)

- Tek kullanımlık `mas_radar_d2_verify` veritabanında `pnpm db:migrate` ve `pnpm exec vitest run tests/financial/payment-runs-approvals-and-bank-settlement.test.ts` → **PASS** (**Dalga 2 ana kabul ölçütü:** *fatura → onay → ödeme paketi → `pain.001` talimatı → banka hareketi → eşleşme → otomatik kapanış* zincirinin tamamı tek uçtan uca testte kanıtlanır!).
- `pnpm db:roles-rls:verify && pnpm db:constraints:verify && pnpm db:transitions:verify` → **ALL PASS**.
- Kalıcı kapılar: `pnpm typecheck && pnpm lint && pnpm phase17:verify && pnpm phase18:verify && pnpm boundary:verify` → **ALL PASS**.

---

### Faz 49 (`D3`) — Türkiye Çek/Senet Bordrosu Yaşam Döngüsü (Portföy, Ciro, Banka Tahsil, Banka Teminat ve Karşılıksız Rücu Riski) (`Migration 0102`)

#### `D3`) — Türkiye Çek/Senet Bordrosu Yaşam Döngüsü (Portföy, Ciro, Banka Tahsil, Banka Teminat ve Karşılıksız Rücu Riski) (`Migration 0102`.. Fazın Amacı & Çözdüğü Rapor Bulguları / Rakip Mekanikleri

- **Amaç:** Türkiye ticari finansmanının belkemiği olan müşteri çeki/senedi cirosu, bankaya tahsile verme, kredi karşılığı bankaya teminata verme ve vadesinde karşılıksız (`bounced`) çıkma durumunda rücu riskini (`contingent recourse liability`) Logo / Mikro / Dia hassasiyetiyle modellemek. (Paraşüt API v4 içinde `/checks` ucu bulunmadığından MAS Çek/Senet Bordrosu birincil gerçek kaynağıdır!)
- **Kapatılan Rapor Bulguları & Rakip Mekanikleri:** `Bölüm 7.2` (Paraşüt `/checks` boşluğu), `Bölüm 8.1` (Logo/Mikro Çek Bordrosu + ciro edilen çekin hem banka nakdine eklenmemesi hem de vadesi geçene kadar rücu riski olarak izlenmesi).

#### `D3`) — Türkiye Çek/Senet Bordrosu Yaşam Döngüsü (Portföy, Ciro, Banka Tahsil, Banka Teminat ve Karşılıksız Rücu Riski) (`Migration 0102`.. Değişecek Mevcut Dosyalar & Oluşturulacak Yeni Dosyalar

- **Oluşturulacak Yeni Dosyalar:**
  1. `supabase/migrations/0102_turkish_check_bordro_lifecycle.sql` — `check_bordros` tablosu, `checks` genişletilmiş bordro durumları/ilişkileri, `check_events` bordro geçmişi ve rücu risk görünümü (`check_portfolio_and_recourse_summary`, `WITH (security_invoker = true)`).
  2. `src/lib/financing/check-bordro.ts` — Bordro işlem motoru (`executeCheckBordroTransition`):
     - **Müşteri Çeki (`direction = 'inflow'`):** `in_portfolio` → `endorsed_to_vendor` (seçilen tedarikçi faturasını `invoice_allocations` üzerinden kapatır, ancak çekin vadesi gelip `cleared` olana kadar şirket bilançosu dışında **`endorsedCheckRiskAmount` şarta bağlı rücu riski** olarak izler!) | `in_bank_collection` (bankada tahsilde) | `in_bank_collateral` (seçilen `credit_facilities` kredi limitine LTV teminatı olarak bağlanır!) → `cleared` | `bounced` (karşılıksız çıkarsa tedarikçiye ciro edilmişse rücu borcu uyarısı ve `control_alerts` P0 kaydı üretir) | `returned`.
     - **Kendi Keşide Çekimiz (`direction = 'outflow'`):** `issued_to_vendor` → `cleared` | `bounced` | `cancelled`.
  3. `tests/financial/turkish-check-bordro.test.ts` — Portföyden tedarikçiye ciro, ciro edilen çekin banka nakit tahminini şişirmeden tedarikçi borcunu kapatması, rücu riski hesabı, teminat LTV bağlantısı ve karşılıksız (`bounced`) rücu dönüşü testleri.
- **Değişecek Mevcut Dosyalar:**
  1. `src/app/(dashboard)/finance/checks/page.tsx` ve `src/app/(dashboard)/finance/actions.ts`: Çek ekranına **Bordro Özeti Kartları** (`Portföydeki Çekler`, `Tahsildeki Çekler`, `Teminattaki Çekler`, `Ciro Edilen Çek & Rücu Riski`, `Keşide Borç Çeklerimiz`) ve tekli/çoklu çek seçimiyle çalışan **"Bordro İşlemi (Ciro / Tahsile Ver / Teminata Ver / Tahsil-Ödeme Kapat / Karşılıksız)"** çekmecesi ekle.
  2. `src/lib/authz/matrix.ts`, `scripts/db/transitions-verify.ts`, `tests/interaction/manifest.ts` ve `docs/database-schema.md`: `check_bordros` tablosunu, genişletilmiş `checks.status` geçiş matrisini, bordro UI kontrollerini ve `0102` şema kaydını işle.

#### `D3`) — Türkiye Çek/Senet Bordrosu Yaşam Döngüsü (Portföy, Ciro, Banka Tahsil, Banka Teminat ve Karşılıksız Rücu Riski) (`Migration 0102`.. Veritabanı / SQL Migration (`0102`) Spesifikasyonu

- **Dosya:** `supabase/migrations/0102_turkish_check_bordro_lifecycle.sql`:
  - `public.check_bordros`: `id uuid PK`, `bordro_no text UNIQUE NOT NULL`, `bordro_type text NOT NULL CHECK (bordro_type IN ('customer_receipt','vendor_endorsement','bank_collection','bank_collateral','own_issue','settlement','bounce_return'))`, `bordro_date date NOT NULL`, `target_party_id uuid REFERENCES public.parties(id)`, `target_bank_account_id uuid REFERENCES public.bank_accounts(id)`, `target_facility_id uuid REFERENCES public.credit_facilities(id)`, `currency text NOT NULL`, `total_amount numeric(14,2) NOT NULL`, `notes text`, `created_by uuid REFERENCES public.users(id)`, `created_at timestamptz`.
  - `public.checks` ek kolonları: `instrument_type text NOT NULL DEFAULT 'check' CHECK (instrument_type IN ('check','promissory_note'))`, `endorsed_to_party_id uuid REFERENCES public.parties(id)`, `collection_bank_account_id uuid REFERENCES public.bank_accounts(id)`, `collateral_facility_id uuid REFERENCES public.credit_facilities(id)`, `settled_invoice_id uuid REFERENCES public.invoices(id)`, `last_bordro_id uuid REFERENCES public.check_bordros(id)`; mevcut `'planned'` müşteri çekleri `direction = 'inflow'` için `'in_portfolio'`, `direction = 'outflow'` için `'issued_to_vendor'` ile geriye uyumlu eşlenir.
  - **Likidite Çift Sayım Kalkanı:** `endorsed_to_vendor` durumundaki müşteri çeki **nakit giriş tahmininden (`liquidity_forecast_daily`) düşer** (çünkü nakit kasaya girmeyecek, tedarikçiye gitmiştir) ve aynı anda kapattığı tedarikçi faturası da açık borçtan düştüğü için likidite denklemi kuruşu kuruşuna tutar; buna karşılık `check_portfolio_and_recourse_summary` görünümü çek `cleared` olana dek `contingent_recourse_amount` alanında riski raporlar.

#### `D3`) — Türkiye Çek/Senet Bordrosu Yaşam Döngüsü (Portföy, Ciro, Banka Tahsil, Banka Teminat ve Karşılıksız Rücu Riski) (`Migration 0102`.. Adım Adım Uygulama Talimatları

1. Mevcut `phase5-verify.ts` regresyonunu kırmamak için eski `'planned'` durumunun okuma/geçiş uyumluluğunu koru veya yeni durumlarla deterministik eşle.
2. Ciro bordrosunda çek para birimi ile kapatılan tedarikçi faturası para biriminin aynı olmasını (`c.currency = inv.currency`) zorunlu kıl.

#### `D3`) — Türkiye Çek/Senet Bordrosu Yaşam Döngüsü (Portföy, Ciro, Banka Tahsil, Banka Teminat ve Karşılıksız Rücu Riski) (`Migration 0102`.. Zorunlu Doğrulama & Kabul Kapısı (Yalnız Tek Kullanımlık DB!)

- Tek kullanımlık `mas_radar_d3_verify` veritabanında `pnpm db:migrate`, `pnpm exec vitest run tests/financial/turkish-check-bordro.test.ts` ve `pnpm db:transitions:verify && pnpm db:roles-rls:verify` → **ALL PASS**.
- Kalıcı kapılar: `pnpm typecheck && pnpm lint && pnpm phase17:verify && pnpm phase18:verify && pnpm boundary:verify` → **ALL PASS**.

---

### Faz 50 (`D4`) — Kalan Tüm "Ekran Var Veri Yolu Yok" Modüllerinin Kapatılması (Bütçe Onayı, Kredi Limit/Teminat/Kovenant, Karşı Taraf IBAN/Boyut, Kârlılık Dağıtımı, Tahsilat Sözü, Doküman Kasası, Mutabakat İmzalama ve Üretim Formları) (`Migration 0103`)

#### `D4`) — Kalan Tüm "Ekran Var Veri Yolu Yok" Modüllerinin Kapatılması (Bütçe Onayı, Kredi Limit/Teminat/Kovenant, Karşı Taraf IBAN/Boyut, Kârlılık Dağıtımı, Tahsilat Sözü, Doküman Kasası, Mutabakat İmzalama ve Üretim Formları) (`Migration 0103`.. Fazın Amacı & Çözdüğü Rapor Bulguları / Rakip Mekanikleri

- **Amaç:** Rapor Bölüm 6.1'de tespit edilen ve arayüzü çizilmiş olduğu halde kullanıcıya hiçbir yazma/onay/aktarım yolu sunmayan kalan tüm ekranları (`/cashflow/budget`, `/finance/facilities`, `/finance/counterparties`, `/finance/profitability`, `/finance/promises`, `/finance/receivables`, `/data/documents`, `/data/reconciliation`, `/cashflow/controls`, `/production/*`) eksiksiz veri girişine, maker-checker onayına ve V2 Excel şablonu desteğine kavuşturmak; zombi tabloları ya canlı akışa bağlamak ya da temizlemek.
- **Kapatılan Rapor Bulguları:** `Bölüm 6.1 #1, #2, #7, #8, #9, #10, #11, #12, #13`, `B4-05` (zombi şema yapıları).

#### `D4`) — Kalan Tüm "Ekran Var Veri Yolu Yok" Modüllerinin Kapatılması (Bütçe Onayı, Kredi Limit/Teminat/Kovenant, Karşı Taraf IBAN/Boyut, Kârlılık Dağıtımı, Tahsilat Sözü, Doküman Kasası, Mutabakat İmzalama ve Üretim Formları) (`Migration 0103`.. Değişecek Mevcut Dosyalar & Oluşturulacak Yeni Dosyalar

- **Oluşturulacak Yeni Dosyalar:**
  1. `supabase/migrations/0103_close_operational_loops_and_reconciliation_signoffs.sql` — `facility_movements` (rotatif kredi kullanım/geri ödeme), `reconciliation_signoffs` (dönem mutabakat imzalama) tabloları, `promise_to_pay` fatura/döviz genişletmesi, `cost_models` / `machine_roi_snapshots` V2 tam alan kalıcılığı ve zombi `working_capital_trend_reference` temizliği/görünüme dönüşümü.
  2. `src/app/(dashboard)/cashflow/budget/actions.ts` — `createBudgetAction`, `addBudgetLineAction`, `submitBudgetForApprovalAction`, `approveBudgetVersionAction` (`approver+`), `createForecastLineAction` Server Action'ları.
  3. `src/app/(dashboard)/finance/facilities/actions.ts` — `createFacilityAction`, `recordFacilityMovementAction` (`drawdown` / `repayment` — `drawn_amount` değerini atomik günceller!), `addCollateralAction`, `upsertCovenantAction` Server Action'ları.
  4. `src/app/(dashboard)/data/documents/actions.ts` ve `src/app/api/documents/[documentId]/download/route.ts` — Yerel `MAS_DOCUMENT_STORAGE_DIR` kasasına SHA-256 sağlama toplamlı, MIME beyaz listeli (`application/pdf`, `image/png`, `image/jpeg`, `.xlsx`), yol-geçişi (`path traversal`) korumalı dosya yükleme, fatura/ödeme/çek/bordro kaydına ekleme (`attachToEntity`) ve yetkili indirme ucu.
  5. `src/app/(dashboard)/data/reconciliation/actions.ts` — Mutabakat farkından tek tıkla `action_items` görev üretme ve dönem mutabakat imzalama (`signOffReconciliationAction`) aksiyonları.
  6. `tests/financial/closed-loops-d4.test.ts` — Bütçe satırı ekleme → onaylama → `budget_vs_actual` görünümünde varyansın belirmesi; kredi limiti + kullanım → `optimization` çözücüsünde gerçek `drawnAmount` okunması; doküman yükleme + SHA-256 doğrulama; IBAN eklemede `iban_change_events` üretimi testleri.
- **Değişecek Mevcut Dosyalar:**
  1. **Bütçe (`/cashflow/budget/page.tsx` + `src/lib/budget/engine.ts`):** Bütçe oluşturma, satır ekleme ve **"Onaya Gönder / Versiyonu Onayla (`draft → approved`)"** kontrollerini bağla; onaylandığı anda `/cashflow/budget`, `/insights/analysis` varyans şelalesi ve `/insights/briefing` bütçe kutusu gerçek veriyle canlansın!
  2. **Kredi Limitleri, Teminat ve Kovenant (`/finance/facilities/page.tsx` + `src/lib/financing/facilities.ts` + `src/lib/importers/v2/{domain-map,template,mapper}.ts`):** CRUD çekmecelerini ekle ve V2 standart Excel şablonuna `17_KREDI_LIMITLERI` sekmesini ekle.
  3. **Karşı Taraflar, IBAN ve Boyutlar (`/finance/counterparties/page.tsx`):** Yetim `addIbanAction`, `deactivateIbanAction` ve `createDimensionAction` (`project`, `cost_center`, `department`) aksiyonlarını arayüz çekmecelerine bağla (`departments` tablosu zombi olmaktan çıkar!); yeni oluşturulan sıfır hareketli carileri gizleyen `itemCount > 0` filtresini kaldır (`Tümü / Aktif Hareketliler` sekmesi yap); müşteri çeklerinde `payer` / `payee` rolünü `direction` yönüne göre doğru ata.
  4. **Kârlılık ve Boyut Seçicileri (`/finance/profitability/page.tsx`, `/finance/invoices/page.tsx`, `/payments/new/page.tsx`):** Yetim `updateAllocationRule` (`costing/engine.ts:59`) formunu `/finance/profitability` ekranına bağla; fatura ve ödeme formlarına `Proje / Masraf Merkezi / Departman` seçicilerini ekle.
  5. **Tahsilat Sözleri ve Alacak Tahsisi (`/finance/promises/page.tsx`, `/finance/receivables/page.tsx`, `/finance/invoices/page.tsx`):** `promises` formuna açık fatura seçicisi (`invoice_id`), para birimi (`currency`) ve `'company'` tipindeki carileri ekle; `receivables` tahsis formunda `unallocated_receipts` tablosundan gerçek banka tahsilatı seçilmesini ve yetim `reverseAllocationAction` geri alma düğmesini aktif et; alış faturalarındaki yanlış `"tahsil"` etiketini `"ödeme"` yap.
  6. **Üretim Ekonomisi (`/production/page.tsx`, `/production/costs/page.tsx`, `/production/roi/page.tsx` + `src/lib/importers/v2/{domain-map,mapper}.ts`):** V2 aktarıcıda `not_persisted` bırakılan `14_KAPASITE`, `15_MALIYET` ve `16_MAKINE_ROI` kolonlarını veritabanına kalıcı olarak yaz ve 3 ekrana da manuel parametre güncelleme çekmecesi ekle.
  7. `src/lib/authz/matrix.ts`, `tests/interaction/manifest.ts` ve `docs/database-schema.md`: Yeni tabloları (`facility_movements`, `reconciliation_signoffs`), tüm yeni form/çekmece düğmelerini ve `0103` şema kaydını işle.

#### `D4`) — Kalan Tüm "Ekran Var Veri Yolu Yok" Modüllerinin Kapatılması (Bütçe Onayı, Kredi Limit/Teminat/Kovenant, Karşı Taraf IBAN/Boyut, Kârlılık Dağıtımı, Tahsilat Sözü, Doküman Kasası, Mutabakat İmzalama ve Üretim Formları) (`Migration 0103`.. Veritabanı / SQL Migration (`0103`) Spesifikasyonu

- **Dosya:** `supabase/migrations/0103_close_operational_loops_and_reconciliation_signoffs.sql`:
  - `public.facility_movements`: `id uuid PK`, `facility_id uuid NOT NULL REFERENCES public.credit_facilities(id) ON DELETE CASCADE`, `movement_type text NOT NULL CHECK (movement_type IN ('drawdown','repayment','limit_revision'))`, `movement_date date NOT NULL`, `amount numeric(14,2) NOT NULL CHECK (amount > 0)`, `currency text NOT NULL`, `bank_tx_id uuid REFERENCES public.bank_transactions(id)`, `notes text`, `created_by uuid REFERENCES public.users(id)`, `created_at timestamptz`; `AFTER INSERT` tetikleyicisi `credit_facilities.drawn_amount` değerini negatif ve limit aşımı korumalı günceller.
  - `public.reconciliation_signoffs`: `id uuid PK`, `period_month date NOT NULL`, `scope text NOT NULL CHECK (scope IN ('bank_cash','ar_ap','workbook_source','trial_balance'))`, `status text NOT NULL CHECK (status IN ('signed_clean','signed_with_exceptions'))`, `open_exception_count int NOT NULL DEFAULT 0`, `notes text`, `signed_by uuid NOT NULL REFERENCES public.users(id)`, `signed_at timestamptz NOT NULL DEFAULT now()`.
  - `public.promise_to_pay`: `invoice_id uuid REFERENCES public.invoices(id)` ve `currency text NOT NULL DEFAULT 'TRY' CHECK (currency ~ '^[A-Z]{3}$')` kolonlarını (mevcutsa kısıt doğrulamasıyla) kesinleştir.
  - Hiçbir yerde yazılmayan boş `working_capital_trend_reference` tablosunu gerçek aylık AR/AP/nakit görünümünden beslenen `working_capital_monthly_v` (`WITH (security_invoker = true)`) okuma modeliyle değiştir.

#### `D4`) — Kalan Tüm "Ekran Var Veri Yolu Yok" Modüllerinin Kapatılması (Bütçe Onayı, Kredi Limit/Teminat/Kovenant, Karşı Taraf IBAN/Boyut, Kârlılık Dağıtımı, Tahsilat Sözü, Doküman Kasası, Mutabakat İmzalama ve Üretim Formları) (`Migration 0103`.. Adım Adım Uygulama Talimatları

1. Doküman yüklemede dosya adını asla kullanıcının gönderdiği ham `file.name` ile diske yazma; `<sha256.slice(0,2)>/<sha256>.<safeExt>` adreslemesiyle içerik-adresli (`content-addressed`) sakla ve orijinal dosya adını yalnız `public.documents.original_filename` kolonunda tut.
2. Tüm yeni formlarda `src/lib/validation/index.ts` (`parseOrThrow`) ve `src/lib/audit.ts` (`audit`) kullan.

#### `D4`) — Kalan Tüm "Ekran Var Veri Yolu Yok" Modüllerinin Kapatılması (Bütçe Onayı, Kredi Limit/Teminat/Kovenant, Karşı Taraf IBAN/Boyut, Kârlılık Dağıtımı, Tahsilat Sözü, Doküman Kasası, Mutabakat İmzalama ve Üretim Formları) (`Migration 0103`.. Zorunlu Doğrulama & Kabul Kapısı (Yalnız Tek Kullanımlık DB!)

- Tek kullanımlık `mas_radar_d4_verify` veritabanında `pnpm db:migrate`, `pnpm exec vitest run tests/financial/closed-loops-d4.test.ts` ve `pnpm db:roles-rls:verify && pnpm db:constraints:verify` → **ALL PASS**.
- Kalıcı kapılar: `pnpm typecheck && pnpm lint && pnpm phase17:verify && pnpm phase18:verify && pnpm boundary:verify` → **ALL PASS**.

---

## 8. KÜME E — PARAŞÜT API v4 ENTEGRASYONU VE ÇİFT TARAFLI YÖNETİM DEFTERİ + TEKDÜZEN HESAP PLANI (TDHP) YASAL MİZAN MUTABAKATI

---

### Faz 51 (`E1`) — Entegrasyon Omurgası, Kaynak Soykütüğü, Paraşüt API v4 Salt-Okunur Konnektörü (10 Saplama Onarımı) ve Hibrid Banka Hattı (`Migration 0104`)

#### `E1`) — Entegrasyon Omurgası, Kaynak Soykütüğü, Paraşüt API v4 Salt-Okunur Konnektörü (10 Saplama Onarımı) ve Hibrid Banka Hattı (`Migration 0104`.. Fazın Amacı & Çözdüğü Rapor Bulguları / Rakip Mekanikleri

- **Amaç:** 2026-10-28 Yönetici Kararları #3, #4 ve #5 doğrultusunda **Paraşüt API v4** (`https://api.parasut.com/v4/{company_id}/...`) üzerinden carileri, kasa/banka hesaplarını, banka hareketlerini, satış/e-Fatura (`sales_invoices`), alış/gider (`purchase_bills`), banka masrafı, vergi ve yönetici-korumalı bordro toplamlarını **%100 salt-okunur (`GET`), idempotent, kuruş-hassas (`BLANK ≠ ZERO`) ve ham JSON SHA-256 soykütüğüyle** çekmek; mevcut saplamadaki 10 kusuru (`S-1..S-10`) kapatmak ve Paraşüt'te henüz eşleştirilmemiş banka hareketlerinin API'ye düşmeme sürprizini **Paraşüt Banka Excel + Doğrudan Banka MT940 / ISO 20022 `camt.053` Hibrid Tekilleştirme Hattı** ile çözmek.
- **Kapatılan Rapor Bulguları:** `Bölüm 7.1 (S-1..S-10)`, `Bölüm 7.2` (Hibrid Banka sürprizi), `Bölüm 6.1 #14` (`/data/integrations` ekran eksikliği).

#### `E1`) — Entegrasyon Omurgası, Kaynak Soykütüğü, Paraşüt API v4 Salt-Okunur Konnektörü (10 Saplama Onarımı) ve Hibrid Banka Hattı (`Migration 0104`.. Değişecek Mevcut Dosyalar & Oluşturulacak Yeni Dosyalar

- **Oluşturulacak Yeni Dosyalar:**
  1. `supabase/migrations/0104_parasut_v4_lineage_and_hybrid_bank.sql` — API soykütüğü tabloları, hesap eşleme, cari inceleme kuyruğu, fatura tevkifat/stopaj kolonları, benzersiz `invoices_external_key_uq` indeksi ve banka `own_transfer` çapraz-kanal tekilleştirme alanları.
  2. `src/lib/integrations/parasut/oauth.ts` — Paraşüt OAuth 2.0 (`https://api.parasut.com/oauth/token`) `password` / `refresh_token` jeton yöneticisi (`7200 sn` TTL, bellek-içi yenileme kilidi, sıfır konsol/log sır sızıntısı; ağ çağrısı yalnız `ctx.http` seam üzerinden geçer!).
  3. `src/lib/integrations/parasut/rate-limiter.ts` — Paraşüt'ün `10 saniyede 10 istek` kuralına karşı güvenli `8 istek / 10 sn` jeton kovası + HTTP `429 Retry-After` üstel geri çekilme (`exponential backoff`) katmanı.
  4. `src/lib/integrations/parasut/client.ts` — JSON:API v4 sayfalayıcı (`page[size]=25`, `sort=-updated_at`, `include` bileşik belge birleştirici, `high_water_mark - 24 saat` örtüşme penceresi; `/v4/` altında **yalnızca `GET` metoduna** izin veren derleme ve çalışma zamanı muhafızı).
  5. `src/lib/integrations/parasut/mappers.ts` — `"TRL" → "TRY"` dönüşümü, `estimate` teklif filtreleme, henüz GİB serisi almamış e-Faturaları `'draft'` → resmileşince `'issued'` yükseltme (`0044:180` değişmezlik uyumu), tevkifat/stopaj (`withholding_amount`, `vat_withholding_amount`, `payable_amount`), satırsız basit gider fişlerinde `tax_amount = null` (`BLANK ≠ ZERO`), çalışan harcaması (`spender` → `335`) ve kendi hesapları arası virman (`own_transfer`) eşleyicileri.
  6. `src/lib/importers/bank-formats/mt940-camt053-parasut.ts` — SWIFT **MT940** (`:60F:`, `:61:`, `:86:`), **ISO 20022 `camt.053` XML** ve **Paraşüt Banka/Fatura Excel (`.xlsx`)** ayrıştırıcısı + çapraz-kanal `cross_channel_dedupe_hash` (`bank_account_id + tx_date + signed_amount_kurus + normalized_ref`) birleştiricisi.
  7. `src/app/(dashboard)/data/integrations/page.tsx` ve `src/app/(dashboard)/data/integrations/actions.ts` — Paraşüt bağlantı durumu, son senkronizasyon makbuzları, `integration_account_mappings` (Paraşüt hesabı ↔ MAS kasa/banka hesabı IBAN eşleme), `integration_staged_parties` (yeni cari tek tık onay/mevcut cariyle birleştirme) ve manuel/zamanlanmış çekim tetikleme ekranı.
  8. `tests/integrations/parasut-v4-and-hybrid-bank.test.ts` — Gerçekçi Paraşüt JSON:API v4 fixture'ları (`TRL`, `estimate`, GİB taslak→resmi e-Fatura, tevkifatlı satış, detaysız fiş, kendi hesapları arası virman, HTTP `429` geri çekilme ve önce Excel/MT940 sonra Paraşüt API geldiğinde çift kayıt oluşmaması) entegrasyon testi.
- **Değişecek Mevcut Dosyalar:**
  1. `src/lib/integrations/types.ts` (satır `140-195`): `HttpResponse` içine `headers: Record<string, string>` ekle; dış ağ hedefini Paraşüt konnektöründe yalnız `https://api.parasut.com` ile sınırla.
  2. `src/lib/integrations/connectors.ts` (satır `120-360`): Eski kırık `LIMIT 1` banka ve `ON CONFLICT` saplamasını yeni `src/lib/integrations/parasut/*` modüler hattıyla değiştir.
  3. `scripts/boundary-verify.ts` (satır `180-198` — Kontrol H): Eski `"muhasebe vendor seçilmedi (ACCOUNTING_PENDING_REASON)"` kontrolünü **"Paraşüt v4 konnektörü yalnız `https://api.parasut.com` adresine bağlanır ve `/v4/` altında sıfır `POST/PUT/PATCH/DELETE` yazma çağrısı içerir (salt-okunur çekme garantisi)"** yapısal kontrolüne yükselt!
  4. `scripts/ops/background-worker.ts`: Yapılandırılmış aktif Paraşüt entegrasyonu varsa periyodik artımlı senkronizasyon (`integrations.parasut_incremental`) işleyicisini çalıştır.
  5. `src/app/(dashboard)/data/layout.tsx`, `src/lib/authz/matrix.ts`, `tests/interaction/manifest.ts` ve `docs/database-schema.md`: `/data/integrations` sekmesini, yeni tabloların 5-katmanlı RLS sınıflarını, UI kontrollerini ve `0104` şema kaydını ekle.

#### `E1`) — Entegrasyon Omurgası, Kaynak Soykütüğü, Paraşüt API v4 Salt-Okunur Konnektörü (10 Saplama Onarımı) ve Hibrid Banka Hattı (`Migration 0104`.. Veritabanı / SQL Migration (`0104`) Spesifikasyonu

- **Dosya:** `supabase/migrations/0104_parasut_v4_lineage_and_hybrid_bank.sql`:
  - `public.integration_sync_runs`: `id uuid PK`, `integration_id uuid NOT NULL REFERENCES public.integrations(id)`, `started_at timestamptz`, `finished_at timestamptz`, `watermark_from timestamptz`, `watermark_to timestamptz`, `status text CHECK (status IN ('running','succeeded','partial','failed'))`, `fetched_count int`, `upserted_count int`, `staged_party_count int`, `error_summary text`.
  - `public.integration_raw_payloads`: `id uuid PK`, `sync_run_id uuid NOT NULL REFERENCES public.integration_sync_runs(id) ON DELETE CASCADE`, `resource_type text NOT NULL`, `external_id text NOT NULL`, `external_updated_at timestamptz`, `payload_sha256 text NOT NULL`, `payload_json jsonb NOT NULL`, `fetched_at timestamptz NOT NULL DEFAULT now()`, `UNIQUE (resource_type, external_id, payload_sha256)`.
  - `public.integration_entity_links`: `id uuid PK`, `provider text NOT NULL DEFAULT 'parasut'`, `resource_type text NOT NULL`, `external_id text NOT NULL`, `entity_table text NOT NULL`, `entity_id uuid NOT NULL`, `last_payload_id uuid REFERENCES public.integration_raw_payloads(id)`, `last_synced_at timestamptz NOT NULL DEFAULT now()`, `UNIQUE (provider, resource_type, external_id)`.
  - `public.integration_account_mappings`: `id uuid PK`, `provider text NOT NULL DEFAULT 'parasut'`, `external_account_id text NOT NULL`, `external_iban text`, `external_currency text NOT NULL`, `cash_account_id uuid REFERENCES public.cash_accounts(id)`, `bank_account_id uuid REFERENCES public.bank_accounts(id)`, `UNIQUE (provider, external_account_id)`.
  - `public.integration_staged_parties`: `id uuid PK`, `provider text NOT NULL DEFAULT 'parasut'`, `external_contact_id text NOT NULL`, `raw_name text NOT NULL`, `tax_id text`, `iban text`, `account_type text`, `suggested_party_id uuid REFERENCES public.parties(id)`, `status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','linked','created','ignored'))`, `resolved_party_id uuid REFERENCES public.parties(id)`, `reviewed_by uuid REFERENCES public.users(id)`, `reviewed_at timestamptz`, `UNIQUE (provider, external_contact_id)`.
  - `public.invoices` genişletmesi: `withholding_amount numeric(14,2)`, `vat_withholding_amount numeric(14,2)`, `payable_amount numeric(14,2)`, `external_status text` kolonları ve **`CREATE UNIQUE INDEX invoices_external_key_uq ON public.invoices (external_key) WHERE external_key IS NOT NULL`** (`S-1` hatasını kesin kapatır!).
  - `public.bank_transactions` genişletmesi: `transaction_kind text NOT NULL DEFAULT 'standard' CHECK (transaction_kind IN ('standard','own_transfer','bank_fee','tax_payment','payroll'))` ve `cross_channel_dedupe_hash text`; `own_transfer` satırları hesap bazlı bakiyeyi günceller ama konsolide şirket nakit akış gelir/gider toplamlarından düşülür!

#### `E1`) — Entegrasyon Omurgası, Kaynak Soykütüğü, Paraşüt API v4 Salt-Okunur Konnektörü (10 Saplama Onarımı) ve Hibrid Banka Hattı (`Migration 0104`.. Adım Adım Uygulama Talimatları

1. Paraşüt API kimlik bilgileri (`PARASUT_COMPANY_ID`, `PARASUT_CLIENT_ID`, `PARASUT_CLIENT_SECRET`, `PARASUT_USERNAME`, `PARASUT_PASSWORD`) yalnız `src/lib/integrations/types.ts` `readCredential` kapısından okunur; hiçbir zaman veritabanına, `audit_logs` içine veya konsola yazılmaz.
2. Fatura tahsil edilecek kalan tutar hesaplarında `coalesce(inv.payable_amount, inv.gross_amount) - inv.paid_amount` kuralını kullanarak tevkifatlı faturaların nakit projeksiyonunu kuruşu kuruşuna doğru tut.
3. Önce MT940/`camt.053`/Paraşüt Excel ile içeri alınmış bir banka hareketi sonradan Paraşüt API `/transactions` ucundan geldiğinde `cross_channel_dedupe_hash` eşleşmesiyle mevcut satırı bul ve ikinci satır eklemek yerine yalnız `integration_entity_links` bağını ekle.

#### `E1`) — Entegrasyon Omurgası, Kaynak Soykütüğü, Paraşüt API v4 Salt-Okunur Konnektörü (10 Saplama Onarımı) ve Hibrid Banka Hattı (`Migration 0104`.. Zorunlu Doğrulama & Kabul Kapısı (Yalnız Tek Kullanımlık DB!)

- Tek kullanımlık `mas_radar_e1_verify` veritabanında `pnpm db:migrate` ve `pnpm exec vitest run tests/integrations/parasut-v4-and-hybrid-bank.test.ts` → **PASS** (iki kez üst üste aynı veri çekildiğinde `upserted` idempotent kalır, `0` mükerrer fatura/hareket oluşur, `TRL → TRY` dönüşür, `own_transfer` şişkinlik yapmaz, çapraz-kanal tekilleştirme çalışır).
- `pnpm db:roles-rls:verify && pnpm boundary:verify` (`8/8` yeni salt-okunur Paraşüt kontrolüyle!) → **ALL PASS**.
- Kalıcı kapılar: `pnpm typecheck && pnpm lint && pnpm phase17:verify && pnpm phase18:verify` → **ALL PASS**.

---

### Faz 52 (`E2`) — Çift Taraflı Yönetim Defteri (TDHP Uyumlu Hesap Planı, Otomatik Fiş Kural Motoru, Yönetim Mizanı, Bilanço, Gelir Tablosu ve EBITDA) (`Migration 0105`)

#### `E2`) — Çift Taraflı Yönetim Defteri (TDHP Uyumlu Hesap Planı, Otomatik Fiş Kural Motoru, Yönetim Mizanı, Bilanço, Gelir Tablosu ve EBITDA) (`Migration 0105`.. Fazın Amacı & Çözdüğü Rapor Bulguları / Rakip Mekanikleri

- **Amaç:** 2026-10-28 Yönetici Kararı #2 (*"B — Hibrit Yönetim Defteri"*) uyarınca MAS Nakit Radar içinde **Tekdüzen Hesap Planı (TDHP)** uyumlu, veritabanı seviyesinde borç = alacak (`sum(debit_try) = sum(credit_try)`) dengesi zorunlu, değişmez (`immutable` + ters kayıtlı) bir **Çift Taraflı Yönetim Defteri** kurmak; operasyonel fatura, banka tahsilat/ödeme, çek bordrosu, kredi anapara/faiz/BSMV-KKDF ve vergi/SGK işlemlerinden idempotent otomatik yönetim fişleri üretmek; **Yönetim Mizanı, Yönetim Bilançosu, Gelir Tablosu ve Yönetim EBITDA** raporlarını canlı olarak sunmak.
- **Kapatılan Rapor Bulguları:** `Bölüm 1 §3` (en büyük ERP/CFO boşluğu: çift taraflı yönetim defteri, mizan, bilanço, gelir tablosu, EBITDA olmaması), `Bölüm 6.1 #15`, `Bölüm 7.3`.

#### `E2`) — Çift Taraflı Yönetim Defteri (TDHP Uyumlu Hesap Planı, Otomatik Fiş Kural Motoru, Yönetim Mizanı, Bilanço, Gelir Tablosu ve EBITDA) (`Migration 0105`.. Değişecek Mevcut Dosyalar & Oluşturulacak Yeni Dosyalar

- **Oluşturulacak Yeni Dosyalar:**
  1. `supabase/migrations/0105_double_entry_management_ledger.sql` — `management_accounts` (TDHP çekirdek hesap tohumlarıyla), `management_journal_entries`, `management_journal_lines`, ertelenebilir (`DEFERRABLE INITIALLY DEFERRED`) denge tetikleyicisi `assert_management_journal_balanced()`, değişmezlik tetikleyicisi ve `management_trial_balance_v`, `management_income_statement_v`, `management_balance_sheet_v` görünümleri (`WITH (security_invoker = true)`).
  2. `src/lib/ledger/accounts.ts` — TDHP hesap planı sorgulama, alt hesap açma (`120.01`, `102.01`, `300.01`) ve `ebitda_bucket` sınıflandırma modülü.
  3. `src/lib/ledger/posting-engine.ts` — Deterministik otomatik fiş üretici (`syncDomainEventToManagementLedger`) ve manuel dönem sonu yönetim tahakkuk fişi (`postManualManagementAdjustment` — amortisman, bordro tahakkuku, karşılık; ters kayıt `reverseManagementEntry`):
     - **Satış Faturası (`issued`):** Borç `120 Alıcılar` (`payable_amount`), varsa Borç `193/295 Peşin Ödenen Vergi/Tevkifat`, Alacak `600/601 Satışlar` (`net_amount`), Alacak `391 Hesaplanan KDV` (`tax_amount`). *(Basit detaysız kayıtta `tax_amount IS NULL` ise uydurma `0` KDV yazılmaz; `needs_tax_split_review = true` bayrağıyla ayrıştırılır!)*
     - **Alış / Gider Faturası:** Borç ilgili `620/632/730/770/253` gider/maliyet/varlık hesabı, Borç `191 İndirilecek KDV`, Alacak `320 Satıcılar` (veya çalışan harcamasında `335 Personele Borçlar`).
     - **Banka Tahsilat / Ödeme / Virman / Masraf:** `102 Bankalar` ↔ `120` / `320` / `102 (own_transfer)` / `780 Banka Komisyon Giderleri` / `360 Vergi` / `361 SGK`.
     - **Çek Bordrosu:** Müşteri çeki alımı `101.01 Portföy` (Borç) / `120` (Alacak); Tedarikçiye ciro `320` (Borç) / `101.01` (Alacak) + nazım rücu izleme; Tahsile verme `101.02` / `101.01`; Tahsil `102` / `101.02`; Keşide çek `320` / `103 Verilen Çekler`; Keşide ödeme `103` / `102`.
     - **Kredi Kullanımı ve Taksit Ödemesi:** Kullanım `102` (Borç) / `300-400 Banka Kredileri` (Alacak); Taksit ödemesi Borç `300` (`principal_component`), Borç `780 Finansman Giderleri` (`interest_component + tax_component` BSMV/KKDF!), Alacak `102 Bankalar` (`amount`).
     - **Döviz Kuru Kuralı (`BLANK ≠ ZERO`):** İşlem dövizli (`USD`/`EUR`/`GBP`) ve işlem tarihine ait TCMB kuru mevcutsa `fx_rate` uygulanır; kur henüz yoksa **asla `1.0` yazılmaz**, fiş `status = 'provisional_fx'` olarak kaydedilir ve kur geldiğinde otomatik değerlenip `'posted'` yapılır!
  4. `src/app/(dashboard)/finance/ledger/page.tsx` ve `src/app/(dashboard)/finance/ledger/actions.ts` — 4 sekmeli Yönetim Defteri ekranı: **① Yönetim Mizanı**, **② Gelir Tablosu & Yönetim EBITDA Şelalesi** (`Net Satışlar → Brüt Kâr → Faaliyet Giderleri → Faaliyet Kârı (EBIT) + Amortisman = Yönetim EBITDA → Finansman Giderleri (780) → Vergi Öncesi Yönetim Kârı`), **③ Yönetim Bilançosu**, **④ Yevmiye Fişleri & Manuel Tahakkuk / Ters Kayıt Çekmecesi**.
  5. `tests/financial/management-ledger-tdhp.test.ts` — Dengesiz (`borç ≠ alacak`) fişin PostgreSQL `DEFERRABLE` tetikleyicisiyle `COMMIT` anında reddedilmesi, `'posted'` fişin `UPDATE/DELETE` reddi ve ters kayıtla düzeltilmesi, kredi anapara/faiz (`300`/`780`) ayrımı, eksik kurda `'provisional_fx'` davranışı ve EBITDA hesabı birim/entegrasyon testleri.
- **Değişecek Mevcut Dosyalar:**
  1. `src/app/(dashboard)/finance/layout.tsx`, `src/lib/authz/matrix.ts`, `tests/interaction/manifest.ts` ve `docs/database-schema.md`: `/finance/ledger` sekmesini, yeni tabloların 5-katmanlı RLS politikalarını (`viewer` okur, `finance_operator` taslak/otomatik senkron tetikler, `finance_approver+` manuel tahakkuk onaylar, `finance_manager+` ters kayıt açar) ve `0105` şema kaydını ekle.

#### `E2`) — Çift Taraflı Yönetim Defteri (TDHP Uyumlu Hesap Planı, Otomatik Fiş Kural Motoru, Yönetim Mizanı, Bilanço, Gelir Tablosu ve EBITDA) (`Migration 0105`.. Veritabanı / SQL Migration (`0105`) Spesifikasyonu

- **Dosya:** `supabase/migrations/0105_double_entry_management_ledger.sql`:
  - `public.management_accounts`: `id uuid PK`, `code text UNIQUE NOT NULL`, `name text NOT NULL`, `parent_code text`, `account_class text NOT NULL CHECK (account_class IN ('asset','liability','equity','revenue','contra_revenue','cogs','opex','finance_expense','other_income_expense','off_balance'))`, `normal_side text NOT NULL CHECK (normal_side IN ('debit','credit'))`, `ebitda_bucket text NOT NULL CHECK (ebitda_bucket IN ('revenue','cogs','opex','da_addback','financing','tax','non_operating','balance_sheet'))`, `tdhp_root_code text NOT NULL`, `is_active boolean NOT NULL DEFAULT true`.
  - `public.management_journal_entries`: `id uuid PK`, `entry_no bigint GENERATED ALWAYS AS IDENTITY UNIQUE`, `entry_date date NOT NULL`, `period_month date GENERATED ALWAYS AS ((date_trunc('month', entry_date at time zone 'UTC'))::date) STORED`, `source_type text NOT NULL CHECK (source_type IN ('invoice','bank_transaction','check_bordro','loan_installment','payment_instance','manual_adjustment','fx_revaluation','reversal'))`, `source_id uuid`, `idempotency_key text UNIQUE NOT NULL`, `status text NOT NULL DEFAULT 'posted' CHECK (status IN ('draft','provisional_fx','posted','reversed'))`, `description text NOT NULL`, `reversal_of_entry_id uuid REFERENCES public.management_journal_entries(id)`, `reversed_by_entry_id uuid REFERENCES public.management_journal_entries(id)`, `created_by uuid REFERENCES public.users(id)`, `created_at timestamptz NOT NULL DEFAULT now()`.
  - `public.management_journal_lines`: `id uuid PK`, `entry_id uuid NOT NULL REFERENCES public.management_journal_entries(id) ON DELETE CASCADE`, `line_no int NOT NULL`, `account_id uuid NOT NULL REFERENCES public.management_accounts(id)`, `party_id uuid REFERENCES public.parties(id)`, `project_id uuid REFERENCES public.projects(id)`, `cost_center_id uuid REFERENCES public.cost_centers(id)`, `native_currency text NOT NULL CHECK (native_currency ~ '^[A-Z]{3}$')`, `debit_native numeric(14,2) NOT NULL DEFAULT 0 CHECK (debit_native >= 0)`, `credit_native numeric(14,2) NOT NULL DEFAULT 0 CHECK (credit_native >= 0)`, `fx_rate numeric(14,6)`, `debit_try numeric(14,2) CHECK (debit_try IS NULL OR debit_try >= 0)`, `credit_try numeric(14,2) CHECK (credit_try IS NULL OR credit_try >= 0)`, `line_memo text`, `CHECK ((debit_native > 0 AND credit_native = 0) OR (credit_native > 0 AND debit_native = 0))`, `UNIQUE (entry_id, line_no)`.
  - **`CREATE CONSTRAINT TRIGGER management_journal_balance_guard AFTER INSERT OR UPDATE OR DELETE ON public.management_journal_lines DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.assert_management_journal_balanced()`:** `status = 'posted'` olan her `entry_id` için satır sayısı `< 2`, herhangi bir satırda `debit_try IS NULL OR credit_try IS NULL` veya `sum(debit_try) <> sum(credit_try)` ise `RAISE EXCEPTION 'unbalanced_management_journal_entry' USING ERRCODE = '23514'`.
  - Ayrıca Faz 45'teki `enforce_closed_period_lock()` tetikleyicisi `management_journal_entries.entry_date` üzerine de bağlanır!

#### `E2`) — Çift Taraflı Yönetim Defteri (TDHP Uyumlu Hesap Planı, Otomatik Fiş Kural Motoru, Yönetim Mizanı, Bilanço, Gelir Tablosu ve EBITDA) (`Migration 0105`.. Adım Adım Uygulama Talimatları

1. Fiş motorunu (`posting-engine.ts`) `idempotency_key` (`"invoice:issued:<uuid>"`, `"bank_tx:settled:<uuid>"`, `"check_bordro:<uuid>"`) üzerinden tamamen idempotent tasarla; toplu senkronizasyon (`rebuildOrSyncManagementLedger`) birden fazla kez çalıştırıldığında hiçbir mükerrer fiş oluşmasın.
2. Yönetim bilançosu görünümünde (`management_balance_sheet_v`) dönem net kâr/zararını özkaynaklar (`590/591`) satırına dinamik yansıtarak `Aktif Toplamı = Pasif (Yabancı Kaynak + Özkaynak) Toplamı` eşitliğini her tarihte kuruşu kuruşuna koru.

#### `E2`) — Çift Taraflı Yönetim Defteri (TDHP Uyumlu Hesap Planı, Otomatik Fiş Kural Motoru, Yönetim Mizanı, Bilanço, Gelir Tablosu ve EBITDA) (`Migration 0105`.. Zorunlu Doğrulama & Kabul Kapısı (Yalnız Tek Kullanımlık DB!)

- Tek kullanımlık `mas_radar_e2_verify` veritabanında `pnpm db:migrate` ve `pnpm exec vitest run tests/financial/management-ledger-tdhp.test.ts` → **PASS** (`management_trial_balance_v` borç toplamı = alacak toplamı kuruş farkı `0.00`, bilanço aktif = pasif farkı `0.00`, dengesiz fiş `23514` ile reddedilir).
- `pnpm db:roles-rls:verify && pnpm db:constraints:verify` → **ALL PASS**.
- Kalıcı kapılar: `pnpm typecheck && pnpm lint && pnpm phase17:verify && pnpm phase18:verify && pnpm boundary:verify` → **ALL PASS**.

---

### Faz 53 (`E3`) — Mali Müşavir Yasal Mizan (Excel/CSV/XML) İçe Aktarımı ve 12 Kök Nedenli Otomatik Yönetim ↔ Yasal Mizan Mutabakat Köprüsü (`Migration 0106`)

#### `E3`) — Mali Müşavir Yasal Mizan (Excel/CSV/XML) İçe Aktarımı ve 12 Kök Nedenli Otomatik Yönetim ↔ Yasal Mizan Mutabakat Köprüsü (`Migration 0106`.. Fazın Amacı & Çözdüğü Rapor Bulguları / Rakip Mekanikleri

- **Amaç:** Mali müşavirin muhasebe programından (Luca, Logo, Mikro, Zirve, Eta, Paraşüt) gönderdiği aylık/geçici vergi dönemi **Yasal Mizan** dosyasını (`.xlsx`, `.csv`, e-Defter/mizan `.xml`) salt-okunur içeri aktarmak; Faz 52'deki MAS Yönetim Defteri Mizanı ile hesap bazında (`100`–`799`) kuruşu kuruşuna karşılaştırıp farkları **Türkiye muhasebe pratiğine özgü 12 deterministik kök nedene** ayırmak, **Yönetim EBITDA ↔ Yasal `690` Vergi Öncesi Kâr Köprüsünü** kurmak ve müşavire gönderilecek tek tık **"Mali Müşavir Mutabakat Paketi (.xlsx)"** dosyasını üretmek.
- **Kapatılan Rapor Bulguları:** `Bölüm 6.1 #16`, `Bölüm 7.3` (12 kök nedenli yönetim ↔ yasal mizan köprüsü).

#### `E3`) — Mali Müşavir Yasal Mizan (Excel/CSV/XML) İçe Aktarımı ve 12 Kök Nedenli Otomatik Yönetim ↔ Yasal Mizan Mutabakat Köprüsü (`Migration 0106`.. Değişecek Mevcut Dosyalar & Oluşturulacak Yeni Dosyalar

- **Oluşturulacak Yeni Dosyalar:**
  1. `supabase/migrations/0106_statutory_trial_balance_reconciliation.sql` — `statutory_trial_balances`, `statutory_trial_balance_lines`, `trial_balance_reconciliation_runs`, `trial_balance_reconciliation_items` tabloları ve 5-katmanlı RLS politikaları.
  2. `src/lib/ledger/statutory-mizan-importer.ts` — Luca/Logo/Mikro/Zirve mizan `.xlsx` (`ExcelJS`), `.csv` (`csv-parser.ts`) ve `.xml` ayrıştırıcısı: Türkçe başlık tanıma (`Hesap Kodu`, `Hesap Adı`, `Borç Toplamı`, `Alacak Toplamı`, `Borç Bakiyesi`, `Alacak Bakiyesi`), ana hesap (`120`) + kırılımlı alt hesap (`120.01.005`) çift sayım önleyici yaprak-hesap (`is_leaf`) tespiti ve mizan içi öz-denge doğrulaması ($\sum \text{Borç} = \sum \text{Alacak}$).
  3. `src/lib/ledger/trial-balance-bridge.ts` — `reconcileTrialBalance(client, statutoryBalanceId)`:
     - Her TDHP kök grubunda (`100, 101, 102, 103, 120, 131/331, 190/191/391, 300/400, 320, 335, 360, 361, 600–780`) MAS Yönetim Mizanı bakiyesi ile Yasal Mizan bakiyesini karşılaştırır.
     - Farkları Rapor Bölüm 7.3'te tanımlanan **12 deterministik kök-neden koduna** (`CASH_100_INFLATION`, `CHECK_ENDORSEMENT_OR_CLEARING_LAG`, `UNBOOKED_BANK_TXN_OR_FX`, `ISSUED_CHECK_NOT_DELIVERED_TO_CPA`, `CUTOFF_UNBILLED_OR_UNALLOCATED_CASH`, `PARTNER_ACCOUNT_PLUG`, `VAT_TAHAKKUK_UNCLOSED`, `LOAN_PRINCIPAL_VS_GROSS_INSTALLMENT`, `MISSING_PURCHASE_INVOICE`, `PAYROLL_ADVANCE_OR_EXPENSE_GAP`, `UNPAID_OR_RESTRUCTURED_TAX_DEBT`, `MANAGEMENT_EBITDA_TO_STATUTORY_690_BRIDGE`) sınıflandırır ve farkı açıklayan aday MAS kayıtlarını (ör. müşavir mizanında eksik görünen son 5 günün e-Faturası veya ciro bordrosu!) kanıt satırı olarak listeler.
     - **Değişmez Kural:** Hiçbir yönetim fişini veya yasal mizan satırını otomatik değiştirmez (*bayrakla, asla sessiz düzeltme*).
  4. `src/app/(dashboard)/data/trial-balance-bridge/page.tsx`, `actions.ts` ve `src/app/api/ledger/reconciliation/[runId]/export/route.ts` — Mizan yükleme, 12 kök nedenli fark tablosu, EBITDA ↔ `690` şelale köprüsü, farktan tek tıkla `action_items` görev açma ve `ExcelJS` tabanlı 3 sekmeli **"Mali Müşavir Mutabakat Paketi (.xlsx)"** (`1_Ozet_Fark_Tablosu`, `2_Eksik_Belge_Kanit_Listesi`, `3_EBITDA_690_Koprusu`) indirme ucu.
  5. `tests/financial/statutory-mizan-bridge.test.ts` — Luca/Logo formatlı hiyerarşik mizan (`120` + `120.01` çift saymama), 12 kök nedenin her birinin pozitif sınıflandırması ve EBITDA ↔ `690` köprüsü aritmetik doğrulama testi.
- **Değişecek Mevcut Dosyalar:**
  1. `src/app/(dashboard)/data/layout.tsx`, `src/lib/authz/matrix.ts`, `tests/interaction/manifest.ts` ve `docs/database-schema.md`: `/data/trial-balance-bridge` sekmesini, 4 yeni tablonun RLS politikalarını, UI kontrollerini ve `0106` şema kaydını ekle.

#### `E3`) — Mali Müşavir Yasal Mizan (Excel/CSV/XML) İçe Aktarımı ve 12 Kök Nedenli Otomatik Yönetim ↔ Yasal Mizan Mutabakat Köprüsü (`Migration 0106`.. Veritabanı / SQL Migration (`0106`) Spesifikasyonu

- **Dosya:** `supabase/migrations/0106_statutory_trial_balance_reconciliation.sql`:
  - `public.statutory_trial_balances`: `id uuid PK`, `as_of_date date NOT NULL`, `period_label text NOT NULL`, `source_software text`, `original_filename text NOT NULL`, `file_sha256 text NOT NULL`, `total_debit_try numeric(16,2) NOT NULL`, `total_credit_try numeric(16,2) NOT NULL`, `is_self_balanced boolean GENERATED ALWAYS AS (total_debit_try = total_credit_try) STORED`, `imported_by uuid NOT NULL REFERENCES public.users(id)`, `imported_at timestamptz NOT NULL DEFAULT now()`.
  - `public.statutory_trial_balance_lines`: `id uuid PK`, `trial_balance_id uuid NOT NULL REFERENCES public.statutory_trial_balances(id) ON DELETE CASCADE`, `account_code text NOT NULL`, `tdhp_root_code text NOT NULL`, `account_name text NOT NULL`, `is_leaf boolean NOT NULL DEFAULT true`, `debit_total_try numeric(16,2) NOT NULL DEFAULT 0`, `credit_total_try numeric(16,2) NOT NULL DEFAULT 0`, `debit_balance_try numeric(16,2) NOT NULL DEFAULT 0`, `credit_balance_try numeric(16,2) NOT NULL DEFAULT 0`, `UNIQUE (trial_balance_id, account_code)`.
  - `public.trial_balance_reconciliation_runs` ve `public.trial_balance_reconciliation_items`: Her kök hesap için `management_net_try`, `statutory_net_try`, `delta_try`, `root_cause_code text`, `severity text CHECK (severity IN ('match','info','warning','critical'))`, `candidate_evidence_json jsonb`, `action_item_id uuid REFERENCES public.action_items(id)`.

#### `E3`) — Mali Müşavir Yasal Mizan (Excel/CSV/XML) İçe Aktarımı ve 12 Kök Nedenli Otomatik Yönetim ↔ Yasal Mizan Mutabakat Köprüsü (`Migration 0106`.. Adım Adım Uygulama Talimatları

1. Hiyerarşik mizanlarda (`120`, `120.01`, `120.01.001`) bir hesabın kodu kendisinden sonra gelen başka bir satırın önekini oluşturuyorsa `is_leaf = false` işaretle; toplamları **yalnız `is_leaf = true` satırlardan** hesapla ve ana hesap satırının toplamıyla sağlama (`assertion`) yap!
2. Mizan kendi içinde dengeli değilse (`total_debit_try <> total_credit_try`) dosyayı reddetme, `is_self_balanced = false` kritik uyarısıyla kaydet ki eksik/bozuk mizan sayfası operatöre açıkça gösterilsin.

#### `E3`) — Mali Müşavir Yasal Mizan (Excel/CSV/XML) İçe Aktarımı ve 12 Kök Nedenli Otomatik Yönetim ↔ Yasal Mizan Mutabakat Köprüsü (`Migration 0106`.. Zorunlu Doğrulama & Kabul Kapısı (Yalnız Tek Kullanımlık DB!)

- Tek kullanımlık `mas_radar_e3_verify` veritabanında `pnpm db:migrate` ve `pnpm exec vitest run tests/financial/statutory-mizan-bridge.test.ts` → **PASS**.
- `pnpm db:roles-rls:verify && pnpm db:constraints:verify` → **ALL PASS**.
- Kalıcı kapılar: `pnpm typecheck && pnpm lint && pnpm phase17:verify && pnpm phase18:verify && pnpm boundary:verify` → **ALL PASS**.

---

## 9. KÜME F — KÜRESEL CFO ZEKASI (13-HAFTA VARYANS ŞELALESİ, GECE NAKİT DELTASI, KOVENANT/DSCR/BAŞABAŞ) VE NİHAİ ÜRETİM KABUL KAPISI

---

### Faz 54 (`F1`) — Otomatik Tohumlanan 13 Haftalık Doğrudan Nakit Tahmini ve Tahmin Anlık Görüntüsü vs. Gerçekleşen Varyans Şelalesi (`Timing Slip vs. Permanent Variance`) (`Migration 0107`)

#### `F1`) — Otomatik Tohumlanan 13 Haftalık Doğrudan Nakit Tahmini ve Tahmin Anlık Görüntüsü vs. Gerçekleşen Varyans Şelalesi (`Timing Slip vs. Permanent Variance`) (`Migration 0107`.. Fazın Amacı & Çözdüğü Rapor Bulguları / Rakip Mekanikleri

- **Amaç:** Şu an yalnız tek tek manuel satır girilerek kullanılan `/cashflow/13-week` ekranını **Agicap / Float / CashAnalytics** seviyesinde yaşayan bir **13 Haftalık Doğrudan Nakit Tahmini (`13-Week Direct Rolling Cash Forecast`)** motoruna dönüştürmek: açık alacaklardan (`expectedCollectionDateV2` davranışsal tahsilat tarihiyle), planlı ödemelerden, tedarikçi faturalarından, çek bordrosu vadelerinden, kredi taksitlerinden ve Faz 46 Türkiye resmi vergi/SGK takviminden otomatik haftalık nakit akışı tohumlamak; her Pazartesi dondurulan tahmin anlık görüntüsünü (`forecast_snapshots_13w`) gerçekleşen banka hareketleriyle karşılaştırıp sapmayı **Zamanlama Kayması (`Timing Slip` — fatura henüz açık veya sonraki haftada tahsil edildi)** ile **Kalıcı Sapma (`Permanent Variance` — bütçe dışı çıkış veya tutar farkı)** olarak ikiye ayıran şelale raporunu sunmak.
- **Kapatılan Rapor Bulguları & Rakip Mekanikleri:** `Bölüm 8.2` (Agicap / Float / CashAnalytics 13-Hafta Otomatik Tohumlama + Timing vs. Permanent Variance Waterfall).

#### `F1`) — Otomatik Tohumlanan 13 Haftalık Doğrudan Nakit Tahmini ve Tahmin Anlık Görüntüsü vs. Gerçekleşen Varyans Şelalesi (`Timing Slip vs. Permanent Variance`) (`Migration 0107`.. Değişecek Mevcut Dosyalar & Oluşturulacak Yeni Dosyalar

- **Oluşturulacak Yeni Dosyalar:**
  1. `supabase/migrations/0107_forecast_13w_snapshots_and_variance.sql` — `forecast_snapshots_13w`, `forecast_snapshot_13w_lines` tabloları, 5-katmanlı RLS ve `forecast_13w_variance_v` (`WITH (security_invoker = true)`) görünümü.
  2. `src/lib/cashflow/rolling-13w-engine.ts` —
     - `buildAutoSeeded13WeekForecast(client, { asOfDate, currency })`: Pazartesi başlangıçlı 13 ISO haftası için açılış hazine bakiyesi (`FIN-03` uyumlu) + otomatik kaynak satırları (`contracted_ar`, `behavioral_ar`, `scheduled_payment`, `open_ap`, `check_maturity`, `loan_installment`, `statutory_tax_sgk`) + kullanıcının manuel düzeltme/ek satırları (`manual_override`) üzerinden haftalık açılış → giriş → çıkış → net → kapanış → minimum nakit tamponu farkını hesaplar (`overdue_unscheduled` gecikmiş alacakları 1. haftaya sahte giriş olarak yığmaz, ayrı bilgi şeridinde gösterir!).
     - `freezeWeekly13wSnapshot(client, { asOfDate, currency, actor })`: Haftalık tahmini belge bazlı kaynak kimlikleriyle (`source_entity_table`, `source_entity_id`) dondurur.
     - `compute13wVarianceWaterfall(client, { snapshotId, weekStart })`: Dondurulmuş hafta kapandığında gerçekleşen `bank_transactions` (`own_transfer` hariç!) ile tahmin satırlarını kaynak kimliği üzerinden eşleştirerek sapmayı `timing_slip_amount` (kayıt hâlâ açık veya başka haftada kapandı) ve `permanent_variance_amount` (plansız yeni hareket veya kapanış tutar farkı) bileşenlerine ayırır.
  3. `tests/financial/rolling-13w-and-variance-waterfall.test.ts` — Otomatik tohumlama, çift sayım engeli, `FIN-03` `null` açılış yayılımı ve Zamanlama Kayması vs. Kalıcı Sapma şelale matematiği testleri.
- **Değişecek Mevcut Dosyalar:**
  1. `src/app/(dashboard)/cashflow/13-week/page.tsx` ve `src/app/(dashboard)/cashflow/13-week/actions.ts`: **"Açık Kayıtlardan Otomatik Yenile"**, **"Haftalık Tahmin Anlık Görüntüsünü Dondur"** kontrollerini, para birimi seçicisini (`TRY` / `USD` / `EUR`) ve **"Tahmin vs. Gerçekleşen Varyans Şelalesi (Zamanlama Kayması vs. Kalıcı Sapma)"** panelini ekle.
  2. `scripts/ops/background-worker.ts`: Her Pazartesi sabahı otomatik `freezeWeekly13wSnapshot` görevini çalıştır.
  3. `src/lib/authz/matrix.ts`, `tests/interaction/manifest.ts` ve `docs/database-schema.md`: Yeni tabloları, UI düğmelerini ve `0107` şema kaydını işle.

#### `F1`) — Otomatik Tohumlanan 13 Haftalık Doğrudan Nakit Tahmini ve Tahmin Anlık Görüntüsü vs. Gerçekleşen Varyans Şelalesi (`Timing Slip vs. Permanent Variance`) (`Migration 0107`.. Veritabanı / SQL Migration (`0107`) Spesifikasyonu

- **Dosya:** `supabase/migrations/0107_forecast_13w_snapshots_and_variance.sql`:
  - `public.forecast_snapshots_13w`: `id uuid PK`, `snapshot_week_start date NOT NULL`, `as_of_date date NOT NULL`, `currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$')`, `opening_cash numeric(14,2)`, `unknown_opening_count int NOT NULL DEFAULT 0`, `frozen_by uuid REFERENCES public.users(id)`, `frozen_at timestamptz NOT NULL DEFAULT now()`, `UNIQUE (snapshot_week_start, currency)`.
  - `public.forecast_snapshot_13w_lines`: `id uuid PK`, `snapshot_id uuid NOT NULL REFERENCES public.forecast_snapshots_13w(id) ON DELETE CASCADE`, `week_index int NOT NULL CHECK (week_index BETWEEN 1 AND 13)`, `week_start date NOT NULL`, `direction text NOT NULL CHECK (direction IN ('inflow','outflow'))`, `category_bucket text NOT NULL`, `source_classification text NOT NULL CHECK (source_classification IN ('promised','behavioral_dbt','scheduled','statutory_tax','manual_override'))`, `source_entity_table text`, `source_entity_id uuid`, `party_id uuid REFERENCES public.parties(id)`, `label text NOT NULL`, `amount numeric(14,2) NOT NULL CHECK (amount >= 0)`.

#### `F1`) — Otomatik Tohumlanan 13 Haftalık Doğrudan Nakit Tahmini ve Tahmin Anlık Görüntüsü vs. Gerçekleşen Varyans Şelalesi (`Timing Slip vs. Permanent Variance`) (`Migration 0107`.. Adım Adım Uygulama Talimatları

1. Otomatik tohumlamada Faz 44'teki çift sayım kalkanını birebir uygula: bir fatura zaten bir çek (`settled_invoice_id`) veya ödeme örneğiyle temsil ediliyorsa 13 haftalık tabloda yalnız bir kez yer alsın.
2. Tüm şelale toplamlarında `Big` (`src/lib/money.ts`) aritmetiği kullan: `Tahmin Net + Zamanlama Kayması + Kalıcı Giriş Sapması + Kalıcı Çıkış Sapması === Gerçekleşen Banka Net Hareketi` özdeşliğini her koşuda doğrula.

#### `F1`) — Otomatik Tohumlanan 13 Haftalık Doğrudan Nakit Tahmini ve Tahmin Anlık Görüntüsü vs. Gerçekleşen Varyans Şelalesi (`Timing Slip vs. Permanent Variance`) (`Migration 0107`.. Zorunlu Doğrulama & Kabul Kapısı (Yalnız Tek Kullanımlık DB!)

- Tek kullanımlık `mas_radar_f1_verify` veritabanında `pnpm db:migrate` ve `pnpm exec vitest run tests/financial/rolling-13w-and-variance-waterfall.test.ts` → **PASS**.
- `pnpm db:roles-rls:verify && pnpm db:constraints:verify` → **ALL PASS**.
- Kalıcı kapılar: `pnpm typecheck && pnpm lint && pnpm phase17:verify && pnpm phase18:verify && pnpm boundary:verify` → **ALL PASS**.

---

### Faz 55 (`F2`) — Gece Nakit Değişim Atfı ($\Delta\text{Cash}$ & $\Delta\text{Gap7}$ Sabah Brifingi), Kovenant & DSCR Erken Uyarı Radarı, Çift Pist (`Dual Runway`) ve Deterministik Başabaş (`Goal-Seek`) Motoru

#### `F2`) — Gece Nakit Değişim Atfı ($\Delta\text{Cash}$ & $\Delta\text{Gap7}$ Sabah Brifingi), Kovenant & DSCR Erken Uyarı Radarı, Çift Pist (`Dual Runway`) ve Deterministik Başabaş (`Goal-Seek`.. Fazın Amacı & Çözdüğü Rapor Bulguları / Rakip Mekanikleri

- **Amaç:** CFO'nun her sabah ilk sorduğu *"Dünden bugüne kasam ve 7 günlük likidite açığım neden değişti?"* sorusunu kuruşu kuruşuna yanıtlayan **Gece Nakit Değişim Atfı (`Overnight Cash & Gap7 Delta Attribution`)** motorunu kurmak; banka kredileri üzerinde **Kovenant Erken Uyarı + Nakit Borç Servisi Karşılama Oranı (`Cash DSCR`) & CFADS Köprüsünü** devreye almak; yanıltıcı tekil geçmiş pist hesabı yerine **Çift İleri Nakit Pisti (`Floor Runway Days` & `Zero-Cash Runway Months`)** ve ilk nakit açığını kapatmak için gereken tam kaldıracı hesaplayan **Deterministik Başabaş (`solveBreakevenLevers`)** çözücüsünü sunmak.
- **Kapatılan Rapor Bulguları & Rakip Mekanikleri:** `B3-05` (hafızasız sabah brifingi + hatalı `"0 ay"` geçmiş pist hesabı), `Bölüm 8.2` (**Mosaic / Runway / Fathom / Causal** Cash Delta Attribution, Cash DSCR, Dual Runway & Breakeven Goal-Seek).

#### `F2`) — Gece Nakit Değişim Atfı ($\Delta\text{Cash}$ & $\Delta\text{Gap7}$ Sabah Brifingi), Kovenant & DSCR Erken Uyarı Radarı, Çift Pist (`Dual Runway`) ve Deterministik Başabaş (`Goal-Seek`.. Değişecek Mevcut Dosyalar & Oluşturulacak Yeni Dosyalar

- **Oluşturulacak Yeni Dosyalar:**
  1. `src/lib/briefing/delta-attribution.ts` — Son iki brifing/rapor anlık görüntüsü arasındaki $\Delta\text{Cash}$ ve $\Delta\text{Gap7}$ değişimini 5 deterministik bileşene ayıran motor: ① Gerçekleşen banka tahsilatları (`+`), ② Gerçekleşen banka ödemeleri/masrafları (`-`), ③ Yeni eklenen veya vadesi 7 gün içine giren ödemeler/çekler/faturalar, ④ Vadesi kayan veya kırılan tahsilat sözleri (`slipped PTP / overdue AR`), ⑤ Kur değerleme etkisi (`FX`).
  2. `src/lib/financing/covenants-and-dscr.ts` —
     - **Nakit DSCR (`Cash Debt Service Coverage Ratio`):** $\text{DSCR} = \frac{\text{CFADS (Borç Servisi Öncesi Serbest Operasyonel Nakit Akışı)}}{\text{Anapara Taksitleri} + \text{Faiz} + \text{BSMV} + \text{KKDF}}$ (son 3 ay gerçekleşen ve gelecek 3/12 ay projeksiyonu; payda `0` ise `null`, CFADS bilinmeyen kalem içeriyorsa `partial_confidence` bayraklı).
     - **Kovenant Erken Uyarı:** `covenant_records` üzerindeki eşiklere (`min_dscr`, `max_net_debt_to_ebitda` [Faz 52 Yönetim EBITDA'sı üzerinden!], `min_cash_balance`) `%10` yaklaşma (`warning`) ve ihlal (`breached`) tespiti.
  3. `src/lib/scenarios/breakeven-goalseek.ts` — Deterministik ikili-arama / kapalı-form başabaş çözücüsü (`solveBreakevenLevers`):
     - Seçilen ufukta (14 gün / 13 hafta / 12 ay) ilk eksi kasa veya kasa tabanı ihlalini sıfırlamak için tek başına yeterli olan 4 somut kaldıracı hesaplar: ① Tahsilatlarda gereken gün hızlandırması (`-X gün DSO`), ② İhtiyari (`low/normal` öncelikli) giderlerde gereken kesinti yüzdesi/tutarı (`-%Y`), ③ Kullanılabilir rotatif kredi limitinden gereken minimum çekim tutarı (`Z TL`) ve ④ Üretim parça başabaş taban fiyatı (`TL/dk`).
  4. `tests/financial/cfo-intelligence-f2.test.ts` — Gece nakit deltası kuruş toplam özdeşliği, DSCR ve Net Borç / Yönetim EBITDA kovenant uyarıları, Çift Pist (`floorRunwayDays` vs `zeroCashRunwayMonths`) ve `solveBreakevenLevers` doğrulama testleri.
- **Değişecek Mevcut Dosyalar:**
  1. `src/lib/briefing/engine.ts`, `src/lib/briefing/rules.ts` ve `src/app/(dashboard)/insights/briefing/page.tsx`: Sabah brifingine **"Dünden Bugüne Nakit ve 7 Günlük Açık Değişim Köprüsü ($\Delta$)"** kartını ekle (salt-okunur Telegram/e-posta özetinde de kapalı devre kuralına uygun yapılandırılabilir maskeli mod destekle).
  2. `src/lib/facts/engine.ts` (satır `100-130`) ve `src/lib/home/overview-snapshot.ts`: Tekil geçmişe bakan `runway` yerine `floorRunwayDays` (13 haftalık günlük eğride kasa alt limitinin delindiği ilk güne kalan gün sayısı) ve `zeroCashRunwayMonths` (36 aylık eğride bugünden itibaren kasanın `< 0` olduğu ilk aya kalan ay sayısı) çift pist metriklerini üret.
  3. `src/app/(dashboard)/finance/facilities/page.tsx`, `src/app/(dashboard)/finance/treasury/page.tsx` ve `src/app/(dashboard)/cashflow/scenarios/page.tsx`: Kovenant & DSCR erken uyarı kartlarını ve **"Başabaş Kaldıraç Çözücü (`Goal-Seek`)"** panelini bağla; `tests/interaction/manifest.ts` içine yeni UI kontrollerini işle.

#### `F2`) — Gece Nakit Değişim Atfı ($\Delta\text{Cash}$ & $\Delta\text{Gap7}$ Sabah Brifingi), Kovenant & DSCR Erken Uyarı Radarı, Çift Pist (`Dual Runway`) ve Deterministik Başabaş (`Goal-Seek`.. Veritabanı / SQL Migration / Arka Plan İşçisi Spesifikasyonu

- Yeni tablo gerekmez; mevcut `reports` (`payload_json` anlık görüntü geçmişi), `covenant_records`, `credit_facilities`, `management_income_statement_v` (Yönetim EBITDA) ve `forecast_snapshots_13w` yapılarını okur.

#### `F2`) — Gece Nakit Değişim Atfı ($\Delta\text{Cash}$ & $\Delta\text{Gap7}$ Sabah Brifingi), Kovenant & DSCR Erken Uyarı Radarı, Çift Pist (`Dual Runway`) ve Deterministik Başabaş (`Goal-Seek`.. Adım Adım Uygulama Talimatları

1. `solveBreakevenLevers` içinde mevcut rotatif kredi kullanılabilir limiti (`limit_amount - drawn_amount`) nakit açığından küçükse `"Mevcut kredi limiti açığı tek başına kapatmaya yetmiyor; ek X TL finansman veya gider ertelemesi gerekli"` dürüst çıktısını üret.
2. Tüm oran ve bölme işlemlerinde `0`'a bölünmeyi `null` ile koru; hiçbir yerde `NaN` veya `Infinity` üretme.

#### `F2`) — Gece Nakit Değişim Atfı ($\Delta\text{Cash}$ & $\Delta\text{Gap7}$ Sabah Brifingi), Kovenant & DSCR Erken Uyarı Radarı, Çift Pist (`Dual Runway`) ve Deterministik Başabaş (`Goal-Seek`.. Zorunlu Doğrulama & Kabul Kapısı

- `pnpm exec vitest run tests/financial/cfo-intelligence-f2.test.ts src/lib/briefing src/lib/facts src/lib/scenarios` → **ALL PASS**
- Kalıcı kapılar: `pnpm typecheck && pnpm lint && pnpm phase17:verify && pnpm phase18:verify && pnpm boundary:verify` → **ALL PASS**.

---

### Faz 56 (`F3`) — Birleşik Altın Finansal Doğruluk Paketi, Tam Etkileşim Manifestosu (`UNTESTED = 0`), 8 GB RAM Sert SLO Kapısı ve Canlıya Geçiş (`mas_radar_dev` Klonu) Provası

#### `F3`) — Birleşik Altın Finansal Doğruluk Paketi, Tam Etkileşim Manifestosu (`UNTESTED = 0`), 8 GB RAM Sert SLO Kapısı ve Canlıya Geçiş (`mas_radar_dev` Klonu.. Fazın Amacı & Çözdüğü Rapor Bulguları / Rakip Mekanikleri

- **Amaç:** Faz 39–55 arasında tamamlanan tüm güvenlik, şema, Paraşüt v4, yönetim defteri, yasal mizan köprüsü ve CFO iş döngülerini **elle bağımsız hesaplanmış Birleşik Altın Finansal Fixture Paketi**, **`UNTESTED = 0` Tam Etkileşim Manifestosu**, **Sert (`hard: true`) Sıcak $\le 100\text{ ms}$ Rota/Sorgu Performans Kapısı** ve **`backups/*.dump` gerçek veri yedeğinden tek kullanımlık klona (`mas_radar_v5_rc_clone`) tam `0096 → 0107` göç + Golden UI duman provası** ile mühürlemek.
- **Kapatılan Rapor Bulguları:** `B3-07` (`volume.ts` ayın 28–31'i körlüğü, `slow-query.ts` `pool.connect()` körlüğü, gevşek `hard: false` SLO eşikleri), `PROGRESS.md` `Faz 11` (birleşik altın finansal doğruluk paketi eksikliği), `Faz 14` (sert rota/yazma SLO kapısı) ve `Aşama 11` (final RC klon cutover provası).

#### `F3`) — Birleşik Altın Finansal Doğruluk Paketi, Tam Etkileşim Manifestosu (`UNTESTED = 0`), 8 GB RAM Sert SLO Kapısı ve Canlıya Geçiş (`mas_radar_dev` Klonu.. Değişecek Mevcut Dosyalar & Oluşturulacak Yeni Dosyalar

- **Oluşturulacak Yeni Dosyalar:**
  1. `tests/financial/golden-end-to-end-cfo-suite.test.ts` — Elle bağımsız aritmetikle türetilmiş **Birleşik Altın Şirket Senaryosu**: `TRY` + `USD` + `EUR` kasa/banka hesapları (`FIN-03` hem `NULL` hem dolu açılış vakası), Paraşüt v4 satış/tevkifatlı fatura/alış fişi/virman çekimi, MT940 çapraz-kanal banka ekstresi, müşteri çeki cirosu + rücu riski, kredi taksiti (`300`/`780` ayrımı), ödeme paketi (`payment_runs` + `pain.001`), banka eşleştirmesiyle kapanış, dönem kilidi (`0100`), dengeli TDHP Yönetim Defteri Mizan/Bilanço/EBITDA (`0105`), 12 kök nedenli Mali Müşavir Yasal Mizan Mutabakatı (`0106`), 13-Hafta Zamanlama vs. Kalıcı Varyans Şelalesi (`0107`) ve Gece Nakit Deltası + DSCR hesaplarının tamamını tek deterministik veri setinde kuruş farkı `0.00` ile doğrulayan ana kapı.
  2. `scripts/release/v5-clone-rehearsal.ts` — **Canlı `mas_radar_dev`'e hiç bağlanmadan**, en güncel yerel `.dump` yedeğini tek kullanımlık `mas_radar_v5_rc_clone` veritabanına geri yükleyip `0098..0107` migration zincirini uygulayan, 6 temel iş tablosunun satır özeti korunumunu, 81+ görünümün `security_invoker = true` durumunu, `db:roles-rls:verify` kapısını ve Golden UI + parasal spot-check testlerini koşturup işi bitince klon veritabanını temizleyen nihai prova betiği (`assertDisposableTargetDb` korumalı!).
- **Değişecek Mevcut Dosyalar:**
  1. `src/lib/perf/slow-query.ts` ve `src/lib/db.ts`: Yalnız `pool.query` değil, `pool.connect()` ile alınan her `PoolClient.query` çağrısını da yavaş sorgu sayacına ve telemetri halkasına bağla (`slow-query` yazma körlüğü kapanır).
  2. `scripts/perf/volume.ts` (satır `130-150`): Sentetik hacim tarihlerini `date_trunc('month', current_date)` yerine doğrudan `current_date` (`[-45 gün .. +90 gün]`) merkezli üret ki ayın 28–31'inde de 7 günlük sorgular gerçekçi tam yük altında ölçülsün!
  3. `scripts/perf/harness.ts` (satır `120-165`): İzole tek kullanımlık üretim sunucusunda (`minimal-next-server.mjs`) sıcak geçiş (`warm route p95`) hedefini kritik CFO ekranlarında sertleştir (`hard: true`, SQL/veri yükleyici sıcak p95 $\le 50\text{ ms}$, tam HTTP SSR sıcak yanıt p95 $\le 100\text{ ms}$ — 8 GB RAM makinede tek işçiyle deterministik ölçüm).
  4. `tests/interaction/manifest.ts`: Faz 39–55 boyunca eklenen/konsolide edilen tüm ekranların ve kontrollerin kapsama kurallarını tamamla; ölü kural = `0`, `UNTESTED = 0` şartını zorunlu kıl.
  5. `docs/database-schema.md`, `docs/calculation-rules.md`, `docs/risk-register.md` ve `docs/ops/*` (`backup.md`, `restore.md`, `start.md`, `stop.md`, `cutover.md`, `telemetry-alerting.md`): `0098..0107` şema son durumunu, tek dil TS arka plan işçilerini (`background-worker.ts`, `telegram-assistant-worker.ts`) ve doküman kasası yedekleme/geri yükleme adımlarını eksiksiz güncelle.

#### `F3`) — Birleşik Altın Finansal Doğruluk Paketi, Tam Etkileşim Manifestosu (`UNTESTED = 0`), 8 GB RAM Sert SLO Kapısı ve Canlıya Geçiş (`mas_radar_dev` Klonu.. Veritabanı / SQL Migration / Arka Plan İşçisi Spesifikasyonu

- Yeni migration eklenmez; `0001..0107` tam zincirinin hem sıfırdan (`DISPOSABLE_SYNTHETIC`) hem gerçek yedek klonundan (`DISPOSABLE_CLONE`) hatasız ve kayıpsız geçtiği kanıtlanır.

#### `F3`) — Birleşik Altın Finansal Doğruluk Paketi, Tam Etkileşim Manifestosu (`UNTESTED = 0`), 8 GB RAM Sert SLO Kapısı ve Canlıya Geçiş (`mas_radar_dev` Klonu.. Adım Adım Uygulama Talimatları

1. `v5-clone-rehearsal.ts` çalıştırılırken `mas_radar_app` küme parolası **kesinlikle sıfırlanmaz** (`PROGRESS.md:1173` dersi); klon bağlantı dizesi mevcut yerel kimlikten yalnız veritabanı adı `mas_radar_v5_rc_clone` yapılarak türetilir ve derleme çıktısı `MAS_NEXT_DIST_DIR=.next-v5-rehearsal` ile canlı `.next` dizininden izole edilir.
2. Tüm kapılar geçtikten sonra `docs/release-evidence/v5-readiness-board.md` kanıt özeti üretilir; gerçek `mas_radar_dev` üzerine geçiş (`pnpm db:migrate`) **yalnızca sahibin harici USB/NAS diski (`MAS_OFFDEVICE_BACKUP_DIR`) takılıp doğrulanmış makbuz alındıktan ve açık sahip onayı verildikten sonra** ayrı bir adımda çalıştırılır.

#### `F3`) — Birleşik Altın Finansal Doğruluk Paketi, Tam Etkileşim Manifestosu (`UNTESTED = 0`), 8 GB RAM Sert SLO Kapısı ve Canlıya Geçiş (`mas_radar_dev` Klonu.. Zorunlu Doğrulama & Kabul Kapısı (Nihai Tam Sistem Kapısı — Yalnız Tek Kullanımlık DB & Klon!)

1. **Statik ve Sınır Kapıları:**
   - `pnpm typecheck` → **0 hata**
   - `pnpm lint` → **0 hata, 0 uyarı**
   - `pnpm phase17:verify` → **ALL PASS** (sıfır `float8`)
   - `pnpm phase18:verify` → **ALL PASS** (tek `audit.ts`, tek Zod sınırı, `docs/database-schema.md` `0107` güncel)
   - `pnpm boundary:verify` → **8/8 PASS** (kapalı devre + Paraşüt v4 salt-okunur sınırı)
   - `git ls-files "*.py"` → **0 dosya** ve `git grep "xlsx" package.json` → **0 eşleşme**
2. **Birim ve Altın Finansal Doğruluk Paketi:**
   - `pnpm test` (`vitest run` + `golden-end-to-end-cfo-suite.test.ts` + `package-script-references.test.ts`) → **%100 PASS**
3. **Veritabanı RLS, Görünüm Güvenliği, Kısıt ve Geçiş Kapıları (Tek Kullanımlık DB):**
   - `pnpm db:roles-rls:verify` (tüm tablolar + tüm `security_invoker` görünümler + `sessions` iptali) → **%100 PASS**
   - `pnpm db:constraints:verify && pnpm db:transitions:verify && pnpm ops:telemetry:alerting:verify` → **%100 PASS**
4. **Etkileşim Manifestosu, Performans SLO ve Gerçek Yedek Klonu Cutover Provası:**
   - `pnpm interaction:crawl && pnpm interaction:test && pnpm interaction:gate:strict` → **`UNTESTED = 0`, ölü kural = `0`, PASS**
   - `pnpm perf:gate && pnpm perf:route-slo` → **Sert (`hard: true`) sıcak geçiş SLO PASS**
   - `pnpm exec tsx scripts/release/v5-clone-rehearsal.ts` → **Gerçek yedek klonunda `0096 → 0107` göç + 36/36 Golden UI + parasal spot-check %100 PASS (`mas_radar_dev`'e sıfır dokunuş!)**.

---

### Faz 57 — Kapalı Çevrim Finansal Boru Hattı (`runClosedLoopFinancialPipeline`) ve Kendi Parolasını Değiştirme Atomik Denetim İzi

- **Amaç:** Paraşüt API v4 salt-okunur çekiminden sonra banka oto-eşleştirme (`autoMatchUnmatched`), çift taraflı TDHP yönetim defteri kaydı (`syncAllDomainEventsToManagementLedger`), 13 haftalık dönen likidite dondurulmuş anlık görüntüsü (`freeze13WeekSnapshot`) ve vadesi geçen ödeme sözlerinin otomatik kırılması (`sweepBrokenPromises`) adımlarını tek deterministik orkestratör altında (`src/lib/integrations/parasut/sync-pipeline.ts` — `runClosedLoopFinancialPipeline`) birleştirmek; aynı zamanda ilk giriş zorunlu parola değişimi (`changeOwnPassword`) akışını `0096` RLS politikasıyla tam uyumlu atomik denetim kaydına bağlamak.
- **Temel Teslimatlar:**
  1. `src/lib/integrations/parasut/sync-pipeline.ts` — `runClosedLoopFinancialPipeline` 5 aşamalı kapalı çevrim orkestratörü (Faz 59 `F-31` ile `/data/integrations` aksiyonuna ve `scripts/ops/background-worker.ts` zamanlayıcısına doğrudan bağlandı).
  2. `src/lib/users/engine.ts` (`changeOwnPassword`) — `must_change_password` bayrağı sıfırlanırken `audit_logs` kaydının aynı işlem içinde hatasız yazılması.

---

### Faz 58 (`Migration 0108`) — Arka Plan Kuyruk Zarfı Değişmezliği ve `v6` Derin CFO Zekâsı (`7xx` Fiili Gider ↔ Tezgâh Başabaş, TCMB Kur Stresi ve Tahsilat Karnesi)

- **Amaç:** `public.background_jobs` tablosunda iş tanımı (`payload`) ile iş çıktısını (`result`) birbirinden ayırıp yürütme zarfını (`job_type`, `payload`, `max_attempts`, `created_by`, `created_at`) veritabanı tetikleyicisiyle değişmez kılmak; yönetim defteri `7xx` fiili üretim giderlerini tezgâh dakika maliyetleriyle, TCMB döviz kurlarını ise kovenant stres senaryolarıyla birleştirmek.
- **SQL Migration (`0108_background_jobs_result_and_immutability.sql`):**
  - `public.background_jobs` tablosuna `result jsonb` kolonu ve `trg_background_jobs_immutable_envelope` (`enforce_background_jobs_immutable_envelope()`) `BEFORE UPDATE` tetikleyicisi eklendi; `mas_radar_finance_operator` rolünün başkasının iş tanımını tahrif etmesi engellendi.
- **Yeni / Güncellenen Motorlar:**
  1. `src/lib/production/actual-cost-bridge.ts` — Yönetim defteri `710 / 720 / 730` fiili gider toplamlarını standart tezgâh kapasitesiyle karşılaştırıp canlı başabaş `TL/dk` sapmasını hesaplar.
  2. `src/lib/fx/fx-stress.ts` — TCMB kurları üzerinden `+%10 / +%20 / +%30` kur şoku altında net döviz pozisyonu, 13-hafta nakit tabanı ve kovenant kırılma noktasını deterministik hesaplar.
  3. `src/lib/receivables/scorecard.ts` — Karşı taraf bazında ağırlıklı gecikme (`DBT`), söz tutma oranı ve tahsilat güvenilirlik karnesini üretir.

---

### Faz 59 (`Migrations 0109..0113`) — 360° Canlı Denetim Tam Kapanışı (`F-01..F-74`), Kanonik `0113` Canlı Göçü, `FIN-03` + `500.99` Açılış Köprüsü ve Sıcak-Krem CFO İstasyonu

- **Amaç:** Canlı ortam denetiminde (`mas_360_live_audit_report.md`) tespit edilen 74 bulgunun (`F-01..F-74`) ve `docs/MAS_360_SYNTHESIS_REPORT.md` içindeki kalan `9/115` açık/kısmi maddenin (`B1-02`, `B2-08`, `B3-07`, `B4-05`, `B5-04`, `B6-03`, `B7-02`, `B8-01`, `B9-04`) tamamını sıfır açık bırakacak biçimde kapatmak ve canlı `mas_radar_dev` veritabanını ön-yedekle **`0113`** kanonik şemasına yükseltmek.
- **SQL Migration Zinciri (`0109..0113`) ve Canlı Veritabanı Durumu:**
  1. `0109_controlled_archive_restore_and_single_operator_policy.sql` — `0024` arşiv tetikleyicisine yalnız işlem-yerel `set_config('app.allow_archive_restore', 'true', true)` GUC anahtarıyla çalışan kontrollü geri yükleme yolu (`F-54`) ve `approval_rules.allow_single_operator_self_approval` + `self_approved_override` gerekçeli tek-operatör 4-göz yönetişim desteği (`F-14`, `F-46`).
  2. `0110_state_machine_untrap_and_forecast_fixes.sql` — `payment_runs` (`approved -> cancelled`) ve `cashflow_period_locks` hapis durum çıkışları, tevkifatlı fatura tam kapama (`payable_amount`), `checks.linked_invoice_id` hizalaması ve `liquidity_forecast_daily` görünümünde fatura bazlı ödeme sözü tutar düşümü (`F-15`, `F-20`, `F-24`).
  3. `0111_cfo_views_and_opening_equity_bridge.sql` — `cash_accounts.opening_balance_date` kolonu ve TDHP `500.99 Açılış Bilançosu Denkleştirme Hesabı` tohumlaması (`F-16`, `F-45`).
  4. `0112_retire_legacy_zombie_tables.sql` — Hiçbir iş akışına bağlı olmayan 3 zombi tablonun (`facility_drawdowns`, `working_capital_trend_reference`, `forecast_accuracy_log`) boşluk kontrolüyle (`RAISE EXCEPTION` korumalı) emekli edilmesi (`F-17` / `B4-05`).
  5. `0113_fix_liquidity_forecast_promise_allocation_dedup.sql` — `liquidity_forecast_daily` görünümünde hem ödeme sözü (`promise_to_pay`) hem kısmi tahsisat (`allocated_amount` / `paid_amount`) bulunan faturalarda `greatest(paid_amount, allocated_amount) + open_promise` formülüyle çift sayımın tamamen kapatılması.
  - **Canlı Şema Özeti (`mas_radar_dev` @ `0113`):** `113` migration (`0001..0113`), `106` `public` tablo (`%100` RLS) + `1` `auth.users` (`107` toplam tablo), `87` `public` görünüm (`%100` `security_invoker = true`), `0` materialized view.
- **Uygulama, Güvenlik, UX ve Operasyon Teslimatları:**
  - **Güvenlik & RBAC (`F-02`, `F-06..F-11`):** Düz metin `.env.local.bak-*` ve eski `.venv/` kalıntıları temizlendi; `MAS_LOCAL_PASSWORDLESS=0` üretim kilidi zorunlu kılındı; tüm panel sayfalarında `"Çıkış yap"` erişimi açıldı; `80/80` dashboard `page.tsx` dosyasında `requireRouteAccess` RBAC kontrolü (`tests/unit/route-access.test.ts` yapısal kapısıyla) mühürlendi.
  - **Finansal Kesinlik & Orkestrasyon (`F-18..F-45`):** `rolling-13w-engine.ts` `vat_withholding_amount` (`KDV_2` & `KDV_1`), `covenants-and-dscr.ts` yatay görünüm kolonları (`totalEquity`), tekil `payable_amount - greatest(paid_amount, allocated_amount)` kalan borç denklemi, yönetim defteri `103/102` keşide çek ve tek-kaynak `102` kuralı, iptal/geri almada otomatik storno (`reverseManagementEntryWithClient`), `revalueProvisionalFxEntries`, `/finance/treasury` `FIN-03` + `500.99` açılış fişi CRUD ve `runClosedLoopFinancialPipeline` bağlantıları tamamlandı.
  - **UX, Durum Makineleri & Operasyon (`F-54..F-72`):** `NavigationFeedbackProvider` dışa aktarma donması giderildi; `ledger`, `integrations`, `13-week`, `trial-balance-bridge` ve `imports/v2` ekranları sıcak-krem (`warm editorial paper`) CFO temasına geçirildi; `MAS-Background-Worker` (`pnpm ops:worker:schedule`), salt-okunur `pnpm backup:offdevice:verify` (`scripts/ops/verify-offdevice-backup.ts`), `17/17` yerel Windows PG16 `docs/ops/*.md` runbook'u (`0` `docker exec`) ve 9 çekirdek/kök doküman senkronize edildi.

---

## 10. Yürütme Disiplini ve Canlı Operasyonel Kontrol Listesi

### 10.1 Faz Uygulama Kuralı (Değiştirilemez)

1. Fazlar **Faz 39'dan Faz 59'a kadar kesin bağımlılık sırasıyla** uygulanmış ve doğrulanmıştır; yeni eklenecek her fazda tüm kalıcı kapıların (`typecheck`, `lint`, `phase17:verify`, `phase18:verify`, `boundary:verify`, `test`, DB doğrulamaları) yeşil olması zorunludur.
2. Hiçbir doğrulama sırasında yerel kanonik veritabanına (`mas_radar_dev` — `127.0.0.1:5432`) test verisi yazılmaz; tüm DB doğrulama betikleri yalnız tek kullanımlık `mas_radar_*_verify` / `*_clone` veritabanlarında çalışır.
3. 8 GB RAM makine disiplini gereği aynı anda birden fazla ağır derleme/Playwright kümesi açılmaz (`MAS_NEXT_CPUS=1`, `vitest maxWorkers: 2`).

### 10.2 Canlı Ortam ve Sahip Operasyonel Durumu (`Faz 59` / `0113` Sonrası)

1. **Canlı Şema ve Arka Plan İşçisi (`TAMAMLANDI`):** Ön-yedek alınarak canlı `mas_radar_dev` veritabanı **`0113`** sürümüne yükseltildi (`106` `public` tablo `%100` RLS, `87` görünüm `%100` `security_invoker = true`); `postgresql-x64-16` servisi, `MAS-Background-Worker` zamanlanmış görevi (`pnpm ops:worker:schedule`) ve düz metin yedek temizliği devreye alındı.
2. **Harici Yedek Diski (`P0-1` — Fiziksel Medya Adımı):** `pnpm backup:offdevice:verify` betiği devreye alındı ve yerel yedek okunabilirliği (`pg_restore --list`) doğrulandı. Fiziksel USB/NAS diski (`MAS_OFFDEVICE_BACKUP_DIR`, örn. `D:\MAS-Backups\mas_radar_dev`) takıldığında `pnpm ops:backup:daily` + `pnpm backup:offdevice:verify -- --strict-offdevice` komutuyla fiziksel harici kopya makbuzu alınmalıdır.
3. **Bulut ve Yapay Zekâ Politikası:** Eski duraklatılmış Supabase `"Mas-Saas"` bulut projesinin tamamen kapatılması sahip hesabındadır; yerel üretimde `.env.local` içinde `AI_FORCE_DETERMINISTIC=1` ve `MAS_LOCAL_PASSWORDLESS=0` kilitleri aktiftir.
4. **Aktif Kasa/Banka Açılış Bakiyeleri (`FIN-03`):** `/finance/treasury` ekranındaki hesap/IBAN ve açılış bakiyesi (`opening_balance` + `opening_balance_date` -> otomatik `500.99` denkleştirme fişi) arayüzü canlıda hazırdır; operatör gerçek banka açılış bakiyelerini doğrudan bu ekrandan girebilir veya güncelleyebilir.
