# MAS Nakit Radar — Implementation Plan v3

> 14 fazli uygulama yol haritasi. Bu bolum guncel kaynak-of-truth planidir.
> Eski v2 plan asagida tarihsel detay ve domain referansi olarak korunur.

---

## 0. Product Boundary

MAS Nakit Radar, MAS'in gercek Excel calisma seklini kaybetmeden; odeme,
nakit akis, cek/kredi, uretim maliyeti, senaryo, rapor ve AI destekli
yorum/cevap katmanina donusturen ozel bir finans-operasyon panelidir.

Urun degildir:

- public SaaS
- ERP
- muhasebe defteri / double-entry accounting sistemi
- AI muhasebeci
- cok kiracili platform
- public landing / pricing / subscription urunu

Degismez kurallar:

- Ham Excel verisi once korunur; sonra staging/review; sonra domain tablolarina aktarilir.
- Null tutar asla 0 sayilmaz.
- Negatif tutar baglama gore yorumlanir; ceklerde yon, odeme tablosunda anomali olabilir.
- Sessiz duzeltme yoktur; validator bayrak koyar, degeri degistirmez.
- Her domain kaydi mumkun oldugunca source workbook/sheet/row izine doner.
- AI kaynak-of-truth degildir; sadece deterministik hesaplari aciklar, soru cevaplar ve aksiyon onerir.
- Senaryo/analitik ciktilari muhasebe gercegi degil, planlama katmanidir.

---

## 1. Faz Durumu

| Faz | Baslik | Durum |
|---:|---|---|
| 1 | Kaynak veri haritasi ve parser foundation | DONE |
| 2 | Veritabani foundation | DONE |
| 3 | Import, raw viewer ve mapping review UI | DONE |
| 4 | Odeme radari MVP | DONE |
| 5 | Nakit akis radari | DONE |
| 6 | Cek/kredi finansman radari | DONE |
| 7 | Raporlar ve hatirlatmalar | DONE |
| 8 | Uretim kapasite/maliyet analitigi | DONE |
| 9 | Salt-okunur senaryo motoru MVP | DONE |
| 10 | Excel coverage close-out: 9A/9B/9C/9D | DONE |
| 11 | Decision facts / metrics katmani | IN PROGRESS |
| 12 | AI soru-cevap ve rapor yorum katmani | IN PROGRESS |
| 13 | Senaryo v2 ve finansman optimizasyonu | IN PROGRESS |
| 14 | Veri kalite merkezi, disgoru ve aksiyon workflow | PLANNED |

Mevcut git gercegi:

- Faz 10A / 9A commitli: `feat(production): surface cost breakdown and Akon price margin (Phase 9A)`.
- Faz 10B / 9B commitli: `feat(cashflow): surface monthly expense breakdown (Phase 9B)`.
- Faz 10C / 9C commitli: `feat(production): add machine ROI mapping (Phase 9C)`.
- Faz 10D / 9D commitli: `feat(production): allocate machine minutes and finance cost (Phase 9D)`.

---

## 2. Faz 1 — Kaynak Veri Haritasi ve Parser Foundation

Amac: Excel dosyasinin gercek yapisini kanitli bicimde okumak, bozuk dosyayi
ayirt etmek ve hicbir sekmeyi sessizce atmamak.

Teslimatlar:

- Safe workbook parser.
- Sheet classifier: loan, capacity, machine ROI, payment matrix, checks, cost models, monthly cashflow, unknown.
- `docs/data-map.md`, `docs/import-mapping.md`, `docs/calculation-rules.md`.
- Bozuk XLSX/ZIP signature failure yolu.

Gate:

- Tum sekmeler listelenir.
- Typecheck, lint, unit tests.
- Parse report guncellenir.

---

## 3. Faz 2 — Veritabani Foundation

Amac: ham kaynak, staging ve normalize domain katmanlarini kurmak.

Teslimatlar:

- `source_workbooks`, `source_sheets`, `source_cells`, `import_rows`, `mapping_reviews`.
- `parties`, `categories`, `cash_accounts`, `settings`, `audit_logs`.
- Payments, cashflow, checks, loans, reminders, reports tablolari.
- RLS ve seed verileri.

Gate:

- `pnpm db:verify`.
- Constraints: null tutar korunur, paid status `paid_at` ister, idempotency unique'leri calisir.
- Generated DB types guncel tutulur.

Not: `src/types/database.ts` yeni production/scenario/cost tablolarini da kapsayacak sekilde guncellenmelidir.

---

## 4. Faz 3 — Import, Raw Viewer ve Mapping Review UI

Amac: Excel'i domain tablolara dogrudan yazmadan once ham veriyi korumak ve
insan onayi gereken satirlari review'a dusurmek.

Teslimatlar:

- Workbook upload.
- Sheet listesi ve detected type rozetleri.
- Raw row/cell viewer.
- Payment/cashflow/check/loan/capacity/cost preview'lari.
- Mapping review filtreleri ve kabul/ret/cozuldu aksiyonlari.

Gate:

- `pnpm import:real`.
- Hucre ve satir sayisi source ile mutabik.
- Anomaliler review'a duser.
- Failed workbook partial row yazmaz.

---

## 5. Faz 4 — Odeme Radari MVP

Amac: gunluk operasyon icin odemeleri gorunur ve aksiyonlanabilir yapmak.

Teslimatlar:

- Payment CRUD.
- Idempotent monthly instance generation.
- Bugun / yarin / 7 gun gorunumu.
- Aylik takvim, riskli gunler, gecikenler, eksik tutar raporu.
- Paid/unpaid ve tutar girisi.
- Audit log.

Gate:

- `pnpm phase3:verify`.
- Due-day 29/30/31 kisa-ay kurali.
- Eksik tutar 0 olmaz.
- Duplicate instance DB seviyesinde engellenir.

---

## 6. Faz 5 — Nakit Akis Radari

Amac: 35 aylik Excel nakit akis sekmelerini projeksiyon ve karar ekranina cevirmek.

Teslimatlar:

- `cashflow_months`, `cashflow_lines`, `cashflow_snapshots`.
- Devir/gelir/gider/fark/kasa kartlari.
- Ilk negatif ay, en kotu ay, negatif seri.
- Gelir/gider yogunlasma analizi.
- Borc servisi overlay icin hazir temel.

Gate:

- `pnpm phase4:verify`.
- Header hucreleri source ile +-0,5 TL mutabik.
- Continuity break bayraklanir, deger degistirilmez.

---

## 7. Faz 6 — Cek/Kredi Finansman Radari

Amac: cek vadeleri, kredi taksitleri, banka/karsi taraf exposure ve borc
servisi yukunu nakit akisla birlikte gorunur yapmak.

Teslimatlar:

- Checks ledger.
- Check events.
- Loans ve loan installments.
- Vade pencereleri 7/14/30 gun.
- Banka/karsi taraf exposure.
- Aylik borc servisi.

Gate:

- `pnpm phase5:verify`.
- Negatif cek tutari anomali degil, outflow yonudur.
- Cift kayit adaylari otomatik merge edilmez.
- Loan total/payment/cost source ile mutabik.

---

## 8. Faz 7 — Raporlar ve Hatirlatmalar

Amac: gunluk/haftalik/aylik ozetleri ve hatirlatma akisini karar destegine cevirmek.

Teslimatlar:

- Daily/weekly/monthly report builders.
- Report snapshots.
- AI commentary prompt template; model cagrisi yok.
- Reminder rules: 7/3/1/0/-1 offset.
- Mock ve Telegram transport.
- Delivery log.

Gate:

- `pnpm phase6:verify`.
- `pnpm phase6b:verify`.
- Report/reminder finansal kayitlari mutasyona ugratmaz.
- Istanbul timezone kullanilir.

---

## 9. Faz 8 — Uretim Kapasite/Maliyet Analitigi

Amac: kapasite, maliyet, basabas TL/dk, parca karliligi ve normal/mesaili
karsilastirmasini analitik katmana almak.

Teslimatlar:

- `machine_assets`, `production_parts`, `capacity_models`, `cost_models`,
  `part_profitability_runs`, `machine_roi_snapshots`.
- Normal vs mesaili.
- Basabas TL/dk.
- Parca karliligi.
- Stale-rate ve missing operation time bayraklari.

Gate:

- `pnpm phase7:verify`.
- Uretim analitigi finans cekirdegini degistirmez.
- 2023 stale rate gorunur kalir.

---

## 10. Faz 9 — Salt-Okunur Senaryo Motoru MVP

Amac: baseline nakit akis uzerinde varsayimlari uygulamak, source-of-truth'u
degistirmeden baz vs senaryo karsilastirmasi uretmek.

Teslimatlar:

- `scenarios`, `scenario_runs`, `scenario_run_lines`,
  `scenario_assumptions`, `scenario_comparisons`.
- Gelir %, gider %, tum tahsilat gecikmesi, kapasite/verim proxy, borc servisi.
- Baseline vs scenario chart/table.
- Acik varsayim paneli.

Gate:

- `pnpm phase8:verify`.
- Baseline row-hash ve finance/production fingerprint degismez.
- Scenario sadece `scenario_*` tablolarina yazar.

---

## 11. Faz 10 — Excel Coverage Close-Out

Amac: Excel'de MVP'nin yuzeysel kaldigi alanlari domain'e daha derin ve
guvenli bicimde tasimak.

### 10A / 9A — Maliyet Detayi ve Akon Kar Marji

Durum: DONE, commitli.

Teslimatlar:

- `priceMargin` saf fonksiyon ve test.
- `cost_breakdown_lines`.
- `cost_models.akon_freze_tl_per_min`, `akon_torna_tl_per_min`.
- `extractCostModel` gider dokumu + Akon oranlari.
- `/production` kar marji paneli.
- Ana Ekran uretim seridi.

Gate:

- `pnpm phase9a:verify`.
- Tam gate ve commit.

### 10B / 9B — Aylik Gider Dokumu

Durum: DONE, commitli.

Teslimatlar:

- Aylik nakit akis sekmelerinde borclar, standart giderler, personel ve genel gider leaf satirlari.
- `cashflow_lines` gider kompozisyonu.
- `/cashflow/[monthId]` isletme gideri / vergi-SGK / kredi-finansman gruplari.

Gate:

- `pnpm phase9b:verify`.
- Ay toplamlarini degistirmeden kompozisyonu acma.
- Tam gate ve commit.

### 10C / 9C — Makine ROI + Ekipman

Durum: DONE, commitli.

Teslimatlar:

- `tablo` sekmesinden yalniz makine ROI ve ekipman maliyeti cikarilir.
- Kisisel/aile giderleri domain tablolara yazilmaz.
- `personal_data_mixed` review cozulmeden ROI map edilmez.
- `machine_assets.purchase_cost` guncellenir.
- Per-machine ve aggregate ROI snapshot yazilir.
- ROI confidence `needs_review` kalir.
- `/production` ROI paneli bu veriyi gosterir.
- `phase9c-verify.ts`.

Gate:

- `pnpm phase9c:verify`.
- Privacy leak testi.
- Idempotency testi.
- Financial integrity before/after testi.
- Tam gate ve commit.

### 10D / 9D — Kapasite Makine-Dakika + Faiz Makine-Tahsis

Durum: DONE, commitli.

Amac:

- Kapasite sekmesindeki parca/dakika bilgisini makine tipi ve mumkunse makine varligi seviyesine indirmek.
- Kredi/faiz maliyetini kapasite veya makine bazli tahsis edilebilir analitik yuke cevirmek.

Teslimatlar:

- Yeni tablolar veya kolonlar:
  - machine-minute allocation
  - machine utilization snapshots
  - finance cost allocation snapshots
- Extractor:
  - kapasite parca satirlarindan torna/freze dakika toplamlarini makine tipi seviyesine ayirir.
  - faiz hesaplama kredi maliyetini tahsis edilebilir toplam finansman maliyeti olarak alir.
- Engine:
  - makine tipi basina dakika, kapasite, kullanim, atil/asiri yuk.
  - finansman maliyeti / dakika veya finansman maliyeti / makine tahmini.
- UI:
  - `/production` icinde makine-dakika paneli.
  - finansman tahsis paneli: "bu makine/kaynak maliyeti uretim fiyatina ne kadar bindiriyor?"

Gate:

- `pnpm phase9d:verify`.
- Tahsis analitik olarak etiketlenir; muhasebe gercegi gibi sunulmaz.
- Finance/cashflow source tablolarini degistirmez.
- Tam gate ve commit.

---

## 12. Faz 11 — Decision Facts / Metrics Katmani

Durum: IN PROGRESS. 11A ile `src/lib/facts` registry, `/api/facts` ve Ana Ekran karar sinyalleri eklendi.

Amac: Dashboard, AI ve raporlar icin guvenli, deterministik, tekil bir facts API'si
olusturmak. AI ham SQL'e veya ham Excel'e gitmez; sadece bu facts katmanindan
cevap uretir.

Teslimatlar:

- `src/lib/facts/` modulu.
- Fact registry:
  - first negative month
  - worst cash month
  - cash runway
  - debt pressure months
  - top customer concentration
  - missing amount count
  - overdue payment load
  - check maturity load
  - loan debt service
  - production margin loss
  - stale-rate flags
  - unresolved review count
- Her fact icin:
  - value
  - severity
  - explanation
  - source links
  - freshness timestamp
  - confidence
- `/api/facts` veya server-only loader.
- Ana Ekran ve raporlar bu facts katmanini kullanmaya baslar.

Gate:

- Unit tests: fact hesaplari mevcut engine'lerle mutabik.
- No mutation.
- Source trace zorunlu.

---

## 13. Faz 12 — AI Soru-Cevap ve Rapor Yorum Katmani

Durum: IN PROGRESS. 12A ile `/ask`, `ai_response_snapshots`, optional OpenAI Responses API provider,
deterministik fallback, rapor AI yorumu ve mutation guard eklendi.

Amac: Kullanici sorularini dogrudan cevaplamak ve cevabi tablo/grafik/kaynak linkiyle gostermek.

Ornek sorular:

- "Eylul 2026 neden eksiye dusuyor?"
- "Onumuzdeki 3 ay en riskli odeme hangisi?"
- "Hangi musterinin gecikmesi kasayi bozuyor?"
- "Bu ay hangi cek/kredi yukleri ust uste biniyor?"
- "Akon fiyatlari basabasi karsiliyor mu?"

Teslimatlar:

- `/ask` veya Ana Ekran icinde soru-cevap paneli.
- AI tool contract:
  - facts oku
  - scenario calistir
  - rapor oku
  - source row linki getir
  - finansal kayit mutasyonu yasak
- Cevap formatlari:
  - kisa cevap
  - nedenler
  - kaynak satir/sekme linkleri
  - onerilen aksiyon
  - ilgili grafik/table view
- Raporlarda "AI yorum uret" butonu.
- AI response snapshot ve audit.

Gate:

- AI hicbir payment/check/loan/cashflow kaydini degistiremez.
- Prompt injection ve source-content safety.
- Model cevaplari deterministik facts ile sinirlandirilir.
- Unit/integration tests: tool whitelist ve mutation guard.

---

## 14. Faz 13 — Senaryo v2 ve Finansman Optimizasyonu

Durum: IN PROGRESS. 13A ile hedefli gelir gecikmesi, hedefli gider/odeme ertelemesi,
faktoring/iskonto overlay'i ve minimum finansman ihtiyaci metrigi scenario motoruna eklendi.

Amac: "what-if" motorunu karar motoruna yaklastirmak.

Teslimatlar:

- Musteri bazli gecikme:
  - "Hpt 30 gun gecikirse"
  - "Akon tahsilati 2 ay kayarsa"
- Tek odeme/cek/kredi taksit erteleme:
  - "Garanti kredi 2 ay otelenirse"
  - "Cagdas cekleri 30 gun kayarsa"
- Cek iskonto/faktoring senaryosu:
  - nakit girisi bugune cekilir
  - iskonto maliyeti gider olarak eklenir
- Minimum finansman ihtiyaci:
  - "Kasayi hic eksiye dusurmemek icin hangi ay ne kadar lazim?"
- Finansman optimizasyonu:
  - en az maliyetli mudahale kombinasyonu
  - odeme erteleme vs kredi vs cek iskonto karsilastirmasi
- Production -> cash link:
  - kapasite/verim degisiminin gelir/gider proxy'si acik varsayimla nakit akisa baglanir

Gate:

- Scenario output read-only kalir.
- Her varsayim `scenario_assumptions` satiri olarak acik beyan edilir.
- Baseline degismez.
- SQL cross-check ve before/after fingerprint.

---

## 15. Faz 14 — Veri Kalite Merkezi, Disgoru ve Aksiyon Workflow

Amac: Sistemin sadece gostermesini degil, karar almayi engelleyen sorunlari
yonetmesini ve dis varsayimlarla projeksiyonu zenginlestirmesini saglamak.

Teslimatlar:

### Veri kalite merkezi

- `/data-quality` veya Yonetim altinda yeni merkez.
- "Karar almayi engelleyen 5 veri sorunu".
- Eksik tutar tamamlama akisi.
- Negatif/anomali onay-ret.
- Excel versiyon farki:
  - workbook A vs workbook B
  - degisen aylar
  - degisen odeme kalemleri
  - degisen formuller
- `01_DASHBOARD`, `02_AYLIK OZET`, `00_REHBER` sekmelerinin ozel taninmasi.
- Excel dashboard degerleri ile uygulama hesaplari arasinda mutabakat paneli.

### Disgoru katmani

- Varsayim tablolari:
  - faiz oranlari
  - kur
  - enflasyon
  - personel/asgari ucret
  - enerji maliyeti
  - kredi oranlari
- Dis veri her zaman source ve tarih ile kaydedilir.
- Otomatik internet verisi varsa user-reviewed status ister.
- Disgoru, kaynak-of-truth'u degistirmez; sadece scenario/report/AI yorum katmanini besler.

### Aksiyon workflow

- Ana Ekran "Ne yapmaliyim?" listesi gorevlesir.
- Gorev alanlari:
  - title
  - severity
  - owner
  - due date
  - status
  - source fact
  - related entity
  - note
- Rapor ve AI cevaplari gorev olusturabilir; finansal kayit degistiremez.

Gate:

- Data-quality actionlari audit log yazar.
- Dis veri finansal source tablolarini degistirmez.
- Gorev workflow'u payment/check/loan mutasyonu yapmaz.
- AI task creation varsa onayli ve auditli olur.

---

## 16. Commit ve Gate Kurali

Her faz veya alt-faz ayri commitlenir.

Minimum gate:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm db:verify
pnpm import:real
pnpm phase3:verify
pnpm phase4:verify
pnpm phase5:verify
pnpm phase6:verify
pnpm phase6b:verify
pnpm phase7:verify
pnpm phase8:verify
pnpm phase9a:verify
pnpm phase9b:verify
pnpm phase9c:verify   # Faz 10C tamamlaninca
pnpm phase9d:verify   # Faz 10D tamamlaninca
pnpm build
```

Gerekirse phase-specific verify script'i once eklenir, sonra implementasyon yapilir.

---

## 17. Legacy v2 Plan

Asagidaki v2 plan, domain kararlarini ve tarihsel baglami korumak icin saklanmistir.

# MAS Nakit Radar — Implementation Plan v2

> Product type: private, single-company, single-operator internal finance/operations SaaS.  
> Product name: **MAS Nakit Radar**.  
> Updated scope: payment radar + cash-flow forecast + check maturity tracking + loan/interest tracking + production capacity/cost analytics.  
> Non-goal: public SaaS, multi-tenant accounting system, subscription product, ERP clone, bank/e-invoice automation-first project, public landing page, pricing page, onboarding flow, marketplace, or AI accountant.

---

## 0. Executive Decision — What Changed After the New Data

The first implementation plan treated the product mainly as a **payment calendar / payment radar**. The new workbook inspection data expands the real domain. The app should now be designed as a **private MAS finance and operations control panel** with four major analytical pillars:

1. **Payment radar** — recurring due-day payments, overdue items, missing amounts, critical days, reminders.
2. **Cash-flow radar** — monthly projected income, expenses, devir/kasa, cumulative deficit/surplus, bank/card balances from May 2026 to March 2029.
3. **Financing radar** — loans, interest, BSMV/KKDF, installments, checks, maturity concentration, bank/provider exposure.
4. **Production economics radar** — capacity, machine time, normal vs overtime/mesaili cost model, TL/minute break-even, part-level profitability, machine ROI.

The product should **not** become a generic ERP. It should remain a private MAS tool. But the data model must now be broader than `payments` and `payment_instances`.

### Scope impact

| Area | Original plan | v2 change |
|---|---|---|
| Payment tracking | Core | Still core, first vertical slice |
| Cash-flow months | Light monthly summary | Now first-class model: `cashflow_months`, `cashflow_lines`, `cashflow_snapshots` |
| Checks | Generic payment instance | Now first-class model: `checks`, `check_events`, maturity calendar |
| Loans | Generic recurring payment | Now first-class model: `loans`, `loan_installments`, finance-cost analytics |
| Capacity/cost | Out of scope | Add as analytics module, not v1 blocking workflow |
| Machine ROI/tax | Out of scope | Add as strategic analytics module after payment/cash-flow is stable |
| AI | Report commentary | Still commentary only; never source of truth |

### Build priority remains strict

Do **not** start with the shiny analytics. Start with source preservation and the payment/cash-flow backbone.

Correct order:

1. Raw workbook preservation and mapping.
2. Payment calendar/radar.
3. Monthly cash-flow projection.
4. Checks and loan modules.
5. Risk engine and reports.
6. Capacity/cost analytics.
7. Scenario engine.

---

## 1. Source File Reality and Data Evidence

### 1.1 Current uploaded binary workbook status

The currently mounted workbook path is:

```txt
/mnt/data/mesaili_nakit_akış_tek_vardiya_TEMİZ-4.xlsx
```

Technical check in the active environment still shows this file cannot be parsed as a valid Excel workbook because it does not expose a valid XLSX/ZIP signature. Therefore the app must still be designed to support a real workbook upload/import later.

### 1.2 New user-provided inspection outputs

The new text files contain pandas inspection outputs from a workbook named:

```txt
mesaili_nakit akış_tek vardiya.xlsx
```

These outputs should be treated as **data-map evidence** for implementation planning. They show the workbook contains:

- financing and loan worksheets
- capacity and production worksheets
- machine/ROI/tax worksheet
- payment-day matrix worksheet
- checks worksheet
- normal and overtime cost models
- monthly cash-flow sheets from **May 2026 through March 2029**

### 1.3 Sheet families discovered

The workbook contains these major sheet groups:

#### A. Finance / loan / payment tracking

- `faiz hesaplama`
- `ödeme tablosu`
- `ÇEKLER`

#### B. Operations / capacity / cost

- `kapasite`
- `tablo`
- `maliyet-mastechnicmesaili`
- `maliyet-mastechnic`

#### C. Monthly forecast sheets

- `mayıs 2026` through `mart 2029`
- mixed casing is present, for example `ARALIK 2026`, `OCAK 2027`, `ŞUBAT 2028`, `EKİM 2028`, `KASIM 2028`, `ARALIK 2028`

### 1.4 Crucial import rule

Sheet names, row positions, headers, casing, merged-table style, and sign conventions are inconsistent. The importer must never assume clean rectangular tables. The app must preserve raw cells first, then map detected regions into typed domain tables.

---

## 2. Product Definition v2

Build:

> **MAS Nakit Radar** — MAS’a özel ödeme, nakit akış, finansman, çek, maliyet ve kapasite kontrol paneli.

The app must answer these operational questions:

### Payment questions

- Bugün hangi ödemeler var?
- Yarın hangi ödemeler var?
- Önümüzdeki 7 gün hangi ödemeler var?
- Hangi ödemelerin tutarı eksik?
- Hangi ödemeler gecikti?
- Aynı güne sıkışan ödeme kümeleri nerede?
- 50.000 TL / 100.000 TL üstü kritik ödemeler hangileri?

### Cash-flow questions

- Bu ay gelir, gider, fark aylık ve kasa/devir durumu nedir?
- Önümüzdeki 3, 6, 12, 24, 36 ayda kasa ne yöne gidiyor?
- İlk eksi kasa hangi ay başlıyor?
- Kümülatif nakit açığı hangi hızla büyüyor?
- Hangi aylar finansman müdahalesi gerektiriyor?
- Cari müşteri gelirlerinin hangi firmalara bağımlılığı var?

### Financing/check questions

- Hangi çekler hangi tarihte vadesine geliyor?
- Çekler hangi bankalarda yoğunlaşıyor?
- Aynı ay/hafta çek ve ödeme yükü çakışıyor mu?
- Kredi toplam geri ödeme, finansman maliyeti ve taksit yükü nedir?
- Banka/kredi kartı/çek exposure dağılımı nedir?

### Production/cost questions

- Normal tek vardiya ve mesaili modelde başabaş TL/dk nedir?
- Mesai kapasiteyi artırıyor mu, yoksa verim düşüşü maliyeti yiyor mu?
- Parça bazında torna/freze süreleri ve maliyetler ne gösteriyor?
- Hangi parçalar kârlı/kârsız görünüyor?
- Hangi tezgah daha yüksek ROI üretiyor?

---

## 3. Hard Scope Boundaries

### Never build in v1/v2 unless explicitly approved

- Multi-tenant organization model
- External customer accounts
- Pricing, subscription, billing, trial, Stripe, iyzico
- Public marketing landing page
- Public SaaS onboarding
- Marketplace
- Full ERP
- Full double-entry accounting ledger
- Payroll module
- Stock/inventory module
- E-invoice integration
- Live bank integration
- OCR-first automation
- AI chatbot as the primary interface
- AI-powered mutation of financial records
- Mobile native app
- Complex RBAC beyond one admin/operator role

### Must build

- Secure login
- Single-company settings
- Raw workbook import/audit layer
- Payment template and payment instance model
- Monthly cash-flow model
- Check ledger
- Loan/financing model
- Data-quality and mapping review screens
- Risk engine
- Dashboard and reporting
- Telegram reminder engine
- Audit log
- Deterministic calculations with tests

---

## 4. Recommended Stack

### Application

- Next.js App Router
- TypeScript strict mode
- Tailwind CSS
- shadcn/ui
- TanStack Table
- TanStack Query where server-state handling is needed
- React Hook Form
- Zod validation
- Recharts
- date-fns
- Lucide icons

### Backend / database

- Supabase
- PostgreSQL
- Supabase Auth
- Supabase Storage for source workbooks and receipts/dekont/fatura attachments
- Supabase migrations
- SQL views for dashboard summaries
- SQL functions for instance generation, risk flags, and monthly rollups
- RLS enabled even for single-company mode

### Automation

- Supabase Edge Functions, Vercel Route Handlers, or server-only scheduled scripts
- Supabase scheduled functions / pg_cron / Vercel Cron
- Telegram Bot API for reminders
- Optional Resend/SMTP for email reports

### AI layer

AI is a commentary layer only.

AI may:

- explain weekly/monthly risk
- write executive summaries
- highlight data anomalies already detected deterministically
- generate “what to check next” action lists

AI must not:

- calculate source-of-truth amounts
- mark anything paid
- alter due dates
- delete or merge records
- infer final truth from ambiguous Excel rows without user review

---

## 5. Repository / Package Map

Use these as references/dependencies. Do not blindly clone generic SaaS starters because most include billing, organizations, onboarding, or public marketing baggage.

| Area | Repo / Package | Use |
|---|---|---|
| Framework | https://github.com/vercel/next.js | App Router, server components, route handlers |
| Backend | https://github.com/supabase/supabase | Auth, Postgres, storage, edge functions |
| Supabase examples | https://github.com/supabase-community/supabase-by-example | Reference patterns only |
| UI | https://github.com/shadcn-ui/ui | Dashboard components, forms, dialogs, tables |
| Charts | https://github.com/recharts/recharts | Cash-flow, payment load, capacity charts |
| Tables | https://github.com/TanStack/table | Payment ledger, check ledger, import review, cost tables |
| Server state | https://github.com/TanStack/query | Optional client caching/mutations |
| Forms | https://github.com/react-hook-form/react-hook-form | Create/edit forms |
| Validation | https://github.com/colinhacks/zod | Runtime validation and DTO schemas |
| Excel parsing | https://github.com/SheetJS/sheetjs | Workbook parsing and raw sheet extraction |
| Alternative Excel parsing | https://github.com/exceljs/exceljs | Styles/formulas/worksheet metadata when needed |
| ORM optional | https://github.com/drizzle-team/drizzle-orm | Optional typed SQL layer; avoid if it slows MVP |
| Email | https://github.com/resend/resend-node | Optional email summaries |
| Email templates | https://github.com/resend/react-email | Optional structured email reports |
| Telegram | https://github.com/yagop/node-telegram-bot-api | Telegram reminders |
| Starter reference | https://github.com/t3-oss/create-t3-app | TypeScript discipline only; do not import SaaS baggage |
| React architecture | https://github.com/alan2207/bulletproof-react | Folder structure inspiration only |

### Install command set

```bash
pnpm create next-app mas-nakit-radar --ts --tailwind --eslint --app --src-dir
cd mas-nakit-radar
pnpm dlx shadcn@latest init
pnpm dlx shadcn@latest add button card table badge calendar dialog dropdown-menu form input label select textarea tabs sheet separator alert switch skeleton toast command popover
pnpm add @supabase/supabase-js @supabase/ssr zod react-hook-form @hookform/resolvers @tanstack/react-table @tanstack/react-query recharts date-fns lucide-react
pnpm add xlsx exceljs node-telegram-bot-api resend @react-email/components
pnpm add -D vitest @testing-library/react @testing-library/jest-dom playwright eslint-config-prettier prettier tsx
```

---

## 6. Claude Code Setup

Create and maintain:

```txt
CLAUDE.md
implementation.md
docs/
  data-map.md
  database-schema.md
  todo.md
  risk-register.md
  repo-map.md
  import-mapping.md
  calculation-rules.md
.claude/
  skills/
    mas-excel-data-auditor/
      SKILL.md
    mas-db-architect/
      SKILL.md
    mas-payment-risk-engine/
      SKILL.md
    mas-dashboard-ux/
      SKILL.md
    mas-reminder-engine/
      SKILL.md
    mas-report-writer/
      SKILL.md
    mas-qa-gate/
      SKILL.md
    mas-implementation-slicer/
      SKILL.md
    mas-cashflow-forecaster/
      SKILL.md
    mas-loan-check-analyst/
      SKILL.md
    mas-cost-capacity-analyst/
      SKILL.md
```

### Claude operating rule

Claude must never jump straight into broad coding.

Every phase must follow:

1. inspect current files and docs
2. update data map and assumptions
3. write migration/types/tests first where applicable
4. implement the smallest vertical slice
5. run typecheck/lint/tests
6. document changes
7. stop for review after phase completion

---

## 7. Domain Model Overview

The app must have three data layers:

1. **Raw source layer** — every workbook/sheet/cell/row preserved.
2. **Mapped staging layer** — candidate entities extracted from messy Excel regions, awaiting review.
3. **Normalized domain layer** — clean entities used by dashboard, reminders, reports, and analytics.

### Why three layers?

The workbook is not a clean accounting export. It is an operational planning workbook with multiple embedded mini-tables. Some headers are in rows, some in columns, some are numeric values, and some sheets mix operational and financial data. A direct import into final tables would create silent errors.

---

## 8. Raw Source and Import Tables

### `source_workbooks`

```sql
create table public.source_workbooks (
  id uuid primary key default gen_random_uuid(),
  original_filename text not null,
  storage_path text,
  file_sha256 text,
  imported_by uuid references auth.users(id),
  imported_at timestamptz not null default now(),
  status text not null default 'pending' check (status in ('pending','parsed','mapped','failed')),
  parse_error text,
  notes text
);
```

### `source_sheets`

```sql
create table public.source_sheets (
  id uuid primary key default gen_random_uuid(),
  workbook_id uuid not null references public.source_workbooks(id) on delete cascade,
  sheet_name text not null,
  sheet_name_normalized text,
  sheet_index int not null,
  used_range text,
  row_count int,
  column_count int,
  detected_type text check (detected_type in (
    'loan_calculation','capacity','machine_roi','payment_day_matrix','checks',
    'cost_model_normal','cost_model_overtime','monthly_cashflow','unknown'
  )),
  parse_confidence text not null default 'unknown' check (parse_confidence in ('high','medium','low','unknown')),
  created_at timestamptz not null default now(),
  unique(workbook_id, sheet_index)
);
```

### `source_cells`

```sql
create table public.source_cells (
  id uuid primary key default gen_random_uuid(),
  workbook_id uuid not null references public.source_workbooks(id) on delete cascade,
  sheet_id uuid not null references public.source_sheets(id) on delete cascade,
  row_index int not null,
  column_index int not null,
  address text not null,
  raw_value text,
  normalized_value text,
  inferred_type text,
  formula text,
  style_json jsonb,
  created_at timestamptz not null default now(),
  unique(sheet_id, row_index, column_index)
);
```

### `import_rows`

```sql
create table public.import_rows (
  id uuid primary key default gen_random_uuid(),
  workbook_id uuid not null references public.source_workbooks(id) on delete cascade,
  sheet_id uuid not null references public.source_sheets(id) on delete cascade,
  row_index int not null,
  row_json jsonb not null,
  row_hash text,
  detected_entity_type text,
  mapping_status text not null default 'unmapped' check (mapping_status in ('unmapped','mapped','ignored','needs_review')),
  mapped_entity_table text,
  mapped_entity_id uuid,
  notes text,
  created_at timestamptz not null default now(),
  unique(sheet_id, row_index)
);
```

### `mapping_reviews`

```sql
create table public.mapping_reviews (
  id uuid primary key default gen_random_uuid(),
  workbook_id uuid not null references public.source_workbooks(id) on delete cascade,
  sheet_id uuid references public.source_sheets(id) on delete cascade,
  import_row_id uuid references public.import_rows(id) on delete cascade,
  issue_type text not null,
  severity text not null default 'medium' check (severity in ('low','medium','high','critical')),
  message text not null,
  suggested_mapping jsonb,
  status text not null default 'open' check (status in ('open','accepted','rejected','resolved')),
  reviewed_by uuid references auth.users(id),
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);
```

---

## 9. Shared Reference Tables

### `parties`

Use `parties` for customers, vendors, persons, banks, providers, and internal owners. Avoid splitting too early.

```sql
create table public.parties (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  normalized_name text not null,
  party_type text not null default 'unknown' check (party_type in (
    'company','person','bank','provider','customer','vendor','internal_owner','unknown'
  )),
  is_active boolean not null default true,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(normalized_name, party_type)
);
```

Seed examples from the workbook evidence:

- Internal/company: `MAS`
- Customers/cari gelir: `Akon`, `Metsan`, `Hpt`, `Egemet`
- Vendors/cari ödemeler: `Elit`, `Çağdaş`, `Akbaş`
- Banks/providers: `Halk`, `Deniz`, `Vinov`, `Telekom`, `Süperbox`, `Pronet`
- Persons/owners: `Armağan`, `Esma`, plus manually reviewed names

### `categories`

```sql
create table public.categories (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  domain text not null default 'payment' check (domain in ('payment','cashflow','check','loan','cost','capacity','tax','other')),
  sort_order int not null default 100,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);
```

Seed examples:

- `Kredi`
- `Kredi Kartı`
- `Çek`
- `Kira`
- `Telefon`
- `İnternet`
- `Elektrik/Su`
- `Alarm/Güvenlik`
- `Cari Ödeme`
- `Cari Gelir`
- `Banka/Hesap`
- `Yemek`
- `Yol`
- `Personel`
- `Sigorta`
- `Vergi`
- `Diğer`
- `Bilinmiyor`

### `cash_accounts`

```sql
create table public.cash_accounts (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  provider_party_id uuid references public.parties(id),
  account_type text not null default 'unknown' check (account_type in ('cash','bank_account','credit_card','loan','check_account','other','unknown')),
  currency text not null default 'TRY',
  opening_balance numeric(14,2),
  is_active boolean not null default true,
  notes text,
  created_at timestamptz not null default now()
);
```

Seed examples:

- `Kasa`
- `HESAP Halk`
- `Halk Business`
- `Halk KK - Paraf`
- `Deniz`
- `Vinov`

---

## 10. Payment Radar Model

### `payments`

```sql
create table public.payments (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  description text,
  category_id uuid references public.categories(id),
  provider_party_id uuid references public.parties(id),
  owner_party_id uuid references public.parties(id),
  cash_account_id uuid references public.cash_accounts(id),

  recurrence_type text not null default 'monthly' check (recurrence_type in ('one_off','monthly','weekly','yearly','irregular')),
  due_day int check (due_day between 1 and 31),
  due_date date,

  default_amount numeric(14,2),
  currency text not null default 'TRY',
  amount_confidence text not null default 'known' check (amount_confidence in ('known','unknown','estimated','variable')),

  direction text not null default 'outflow' check (direction in ('inflow','outflow','transfer','unknown')),
  priority text not null default 'normal' check (priority in ('low','normal','high','critical')),
  status text not null default 'active' check (status in ('active','paused','archived')),

  source_workbook_id uuid references public.source_workbooks(id),
  source_sheet_id uuid references public.source_sheets(id),
  source_row_id uuid references public.import_rows(id),
  source_notes text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint payment_due_rule check (
    (recurrence_type = 'monthly' and due_day is not null)
    or (recurrence_type <> 'monthly')
  )
);
```

### `payment_instances`

```sql
create table public.payment_instances (
  id uuid primary key default gen_random_uuid(),
  payment_id uuid references public.payments(id) on delete set null,
  instance_month date not null,
  due_date date not null,
  due_day int generated always as (extract(day from due_date)::int) stored,

  amount numeric(14,2),
  currency text not null default 'TRY',
  amount_status text not null default 'known' check (amount_status in ('known','missing','estimated','variable')),
  direction text not null default 'outflow' check (direction in ('inflow','outflow','transfer','unknown')),

  status text not null default 'unpaid' check (status in ('planned','unpaid','partial','paid','late','cancelled','unknown')),
  paid_amount numeric(14,2),
  paid_at timestamptz,
  paid_from_account_id uuid references public.cash_accounts(id),

  risk_level text not null default 'none' check (risk_level in ('none','low','medium','high','critical')),
  risk_reasons text[] not null default '{}',

  note text,
  source_workbook_id uuid references public.source_workbooks(id),
  source_sheet_id uuid references public.source_sheets(id),
  source_row_id uuid references public.import_rows(id),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint paid_requires_paid_at check (
    status <> 'paid' or paid_at is not null
  )
);
```

---

## 11. Monthly Cash-Flow Model

The monthly sheets are first-class. They should not be forced into payment instances only.

### `cashflow_months`

```sql
create table public.cashflow_months (
  id uuid primary key default gen_random_uuid(),
  month_start date not null unique,
  source_workbook_id uuid references public.source_workbooks(id),
  source_sheet_id uuid references public.source_sheets(id),

  opening_balance numeric(14,2), -- devir
  projected_income numeric(14,2), -- gelir
  projected_expense numeric(14,2), -- gider
  monthly_delta numeric(14,2), -- fark aylık
  closing_balance numeric(14,2), -- kasa
  confidence text not null default 'source_imported' check (confidence in ('source_imported','calculated','reviewed','estimated')),

  status text not null default 'draft' check (status in ('draft','review_needed','reviewed','locked')),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

### `cashflow_lines`

```sql
create table public.cashflow_lines (
  id uuid primary key default gen_random_uuid(),
  cashflow_month_id uuid not null references public.cashflow_months(id) on delete cascade,
  source_row_id uuid references public.import_rows(id),

  line_type text not null check (line_type in (
    'customer_income','vendor_payment','bank_balance','credit_card','loan_payment','check_payment',
    'operational_cost','tax','transfer','adjustment','unknown'
  )),
  direction text not null default 'unknown' check (direction in ('inflow','outflow','balance','transfer','unknown')),
  party_id uuid references public.parties(id),
  account_id uuid references public.cash_accounts(id),
  label text not null,
  amount numeric(14,2),
  amount_status text not null default 'known' check (amount_status in ('known','missing','estimated','variable')),
  date_value date,
  notes text,
  created_at timestamptz not null default now()
);
```

### `cashflow_snapshots`

```sql
create table public.cashflow_snapshots (
  id uuid primary key default gen_random_uuid(),
  snapshot_date date not null default current_date,
  horizon_months int not null,
  total_projected_income numeric(14,2),
  total_projected_expense numeric(14,2),
  final_projected_balance numeric(14,2),
  first_negative_month date,
  worst_month date,
  worst_balance numeric(14,2),
  created_at timestamptz not null default now()
);
```

### Required cash-flow analytics

- month-by-month opening/devir → income → expense → delta → closing/kasa
- cumulative cash burn
- first negative month
- worst projected month
- 3/6/12/24/36-month forecast cards
- income concentration by customer
- expense concentration by vendor/category
- bank/card exposure trend
- cash rescue threshold alerts

---

## 12. Checks / Çekler Model

The `ÇEKLER` sheet uses dated rows, parties, banks, and negative signed amounts. Do not treat all negative numbers as anomalies here. In the checks module, sign must be interpreted as direction.

### `checks`

```sql
create table public.checks (
  id uuid primary key default gen_random_uuid(),
  source_workbook_id uuid references public.source_workbooks(id),
  source_sheet_id uuid references public.source_sheets(id),
  source_row_id uuid references public.import_rows(id),

  maturity_date date not null,
  serial_no text,
  payee_party_id uuid references public.parties(id), -- kime
  payer_party_id uuid references public.parties(id), -- kimden
  bank_party_id uuid references public.parties(id),
  account_id uuid references public.cash_accounts(id),

  amount numeric(14,2),
  signed_amount numeric(14,2),
  direction text not null default 'outflow' check (direction in ('inflow','outflow','unknown')),
  status text not null default 'planned' check (status in ('planned','cleared','bounced','cancelled','unknown')),

  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

### `check_events`

```sql
create table public.check_events (
  id uuid primary key default gen_random_uuid(),
  check_id uuid not null references public.checks(id) on delete cascade,
  event_type text not null check (event_type in ('created','reminded','cleared','bounced','cancelled','note')),
  event_at timestamptz not null default now(),
  event_note text,
  created_by uuid references auth.users(id)
);
```

### Required check analytics

- maturity calendar
- bank-by-bank check exposure
- payee/payer concentration
- weekly/monthly check load
- overlap with payment instances
- check-heavy month warning
- duplicate-looking checks review

---

## 13. Loan / Financing Model

The `faiz hesaplama` sheet includes credit principal, maturity, interest, taxes, installment, total payment, and difference/finance cost. These need dedicated tables.

### `loans`

```sql
create table public.loans (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  lender_party_id uuid references public.parties(id),
  source_workbook_id uuid references public.source_workbooks(id),
  source_sheet_id uuid references public.source_sheets(id),

  principal numeric(14,2) not null,
  term_months int,
  installment_count int,
  first_payment_date date,
  simple_interest_rate numeric(8,4),
  applied_interest_rate numeric(8,4),
  monthly_cost_rate numeric(8,4),
  annual_cost_rate numeric(8,4),
  bsmv_rate numeric(8,4),
  kkdf_rate numeric(8,4),
  installment_amount numeric(14,2),
  total_payment numeric(14,2),
  total_finance_cost numeric(14,2),

  status text not null default 'active' check (status in ('active','closed','planned','unknown')),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
```

### `loan_installments`

```sql
create table public.loan_installments (
  id uuid primary key default gen_random_uuid(),
  loan_id uuid not null references public.loans(id) on delete cascade,
  installment_no int,
  due_date date not null,
  amount numeric(14,2) not null,
  principal_component numeric(14,2),
  interest_component numeric(14,2),
  tax_component numeric(14,2),
  status text not null default 'planned' check (status in ('planned','unpaid','partial','paid','late','cancelled')),
  paid_at timestamptz,
  created_at timestamptz not null default now(),
  unique(loan_id, installment_no)
);
```

### Required loan analytics

- total principal
- total repayment
- total finance cost
- monthly installment load
- remaining installments
- paid/unpaid schedule
- debt service pressure by month
- overlap with cash-flow deficit months

---

## 14. Production Capacity and Cost Model

This module is important but should not block the payment radar MVP. It should be implemented after the finance backbone.

### `machine_assets`

```sql
create table public.machine_assets (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  machine_type text check (machine_type in ('torna','freze','other','unknown')),
  purchase_cost numeric(14,2),
  notes text,
  created_at timestamptz not null default now()
);
```

Seed candidates: `Awea`, `Arion`, `Sister`, `Doosan`.

### `production_parts`

```sql
create table public.production_parts (
  id uuid primary key default gen_random_uuid(),
  part_code text,
  part_name text not null,
  quantity int,
  torna_minutes numeric(14,4),
  freze_minutes numeric(14,4),
  source_workbook_id uuid references public.source_workbooks(id),
  source_sheet_id uuid references public.source_sheets(id),
  source_row_id uuid references public.import_rows(id),
  created_at timestamptz not null default now()
);
```

### `capacity_models`

```sql
create table public.capacity_models (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  scenario_type text not null check (scenario_type in ('normal','overtime','custom')),
  monthly_hours numeric(10,2),
  monthly_minutes numeric(14,2),
  work_days_per_month numeric(10,2),
  efficiency_rate numeric(8,4),
  staff_count numeric(10,2),
  apprentice_count numeric(10,2),
  notes text,
  source_workbook_id uuid references public.source_workbooks(id),
  source_sheet_id uuid references public.source_sheets(id),
  created_at timestamptz not null default now()
);
```

### `cost_models`

```sql
create table public.cost_models (
  id uuid primary key default gen_random_uuid(),
  capacity_model_id uuid references public.capacity_models(id),
  model_name text not null,
  model_month date,
  food_daily_cost numeric(14,2),
  transport_staff_daily_cost numeric(14,2),
  transport_apprentice_daily_cost numeric(14,2),
  health_insurance_cost numeric(14,2),
  machine_insurance_cost numeric(14,2),
  total_fixed_cost numeric(14,2),
  monthly_allocated_cost numeric(14,2),
  break_even_torna_tl_per_min numeric(14,4),
  break_even_freze_tl_per_min numeric(14,4),
  source_workbook_id uuid references public.source_workbooks(id),
  source_sheet_id uuid references public.source_sheets(id),
  created_at timestamptz not null default now()
);
```

### `part_profitability_runs`

```sql
create table public.part_profitability_runs (
  id uuid primary key default gen_random_uuid(),
  part_id uuid not null references public.production_parts(id) on delete cascade,
  cost_model_id uuid not null references public.cost_models(id) on delete cascade,
  estimated_torna_cost numeric(14,2),
  estimated_freze_cost numeric(14,2),
  estimated_total_cost numeric(14,2),
  estimated_revenue numeric(14,2),
  estimated_margin numeric(14,2),
  margin_rate numeric(8,4),
  created_at timestamptz not null default now()
);
```

### Required production analytics

- normal vs overtime TL/minute comparison
- efficiency sensitivity
- part-level cost/profit estimate
- machine utilization
- capacity equivalent of monthly revenue
- break-even price floor
- low-margin / negative-margin part flags

---

## 15. Machine ROI / Strategic Table Model

The `tablo` sheet appears to compare machine economics, net remaining amounts, costs, taxes, and possibly personal/company allocations. This must be treated as review-needed strategic data, not blindly normalized in MVP.

### `machine_roi_snapshots`

```sql
create table public.machine_roi_snapshots (
  id uuid primary key default gen_random_uuid(),
  source_workbook_id uuid references public.source_workbooks(id),
  source_sheet_id uuid references public.source_sheets(id),
  machine_asset_id uuid references public.machine_assets(id),
  snapshot_year int,
  revenue numeric(14,2),
  cost numeric(14,2),
  remaining numeric(14,2),
  tax numeric(14,2),
  net_after_tax numeric(14,2),
  confidence text not null default 'needs_review' check (confidence in ('needs_review','reviewed','calculated')),
  notes text,
  created_at timestamptz not null default now()
);
```

### Required ROI analytics

- machine-level gross/net outcome
- tax burden
- payback period approximation
- risk: low confidence until reviewed

---

## 16. Risk Engine v2

Risk must be deterministic. AI only explains already-computed risks.

### Payment risks

- Missing amount
- Missing due date/due day
- Overdue unpaid
- Partial paid after due date
- Large payment above `large_payment_threshold_try`, default 50,000 TRY
- Critical payment above `critical_payment_threshold_try`, default 100,000 TRY
- Same-day cluster, default 3+ payments
- Due day 29/30/31 short-month edge case

### Cash-flow risks

- Closing balance below zero
- First negative month
- Three consecutive negative months
- Monthly delta below threshold
- Expense spike month
- Income concentration above threshold
- Vendor/payment concentration above threshold
- Forecast confidence low because source row is ambiguous

### Check risks

- Check maturity in next 7/14/30 days
- Check maturity overlaps with high payment week
- Bank exposure concentration
- Duplicate-looking checks
- Negative signed amount without direction mapping

### Loan risks

- Loan installment overlaps with deficit month
- Financing cost ratio high
- Remaining debt-service load high
- Missing lender/payment schedule

### Production/cost risks

- Break-even TL/minute above quoted or assumed price
- Overtime scenario increases capacity but worsens margin
- Efficiency sensitivity causes margin collapse
- Part with missing operation time
- Machine ROI confidence low

---

## 17. Dashboard v2

### Global dashboard top cards

1. Today due
2. Tomorrow due
3. Next 7 days known outflow
4. Missing amount count
5. Overdue count
6. Current month projected closing balance
7. First negative forecast month
8. Checks due in next 30 days
9. Loan installments this month
10. Highest-risk day/month

### Main dashboard sections

#### A. Payment Radar

- Today/tomorrow/7-day list
- Monthly calendar day grid
- Risk-day heatmap
- Missing-data panel

#### B. Cash-Flow Radar

- Month-by-month devir/gelir/gider/fark/kasa table
- Cash balance line chart
- Monthly income/expense bar chart
- Worst months list
- First negative month banner

#### C. Checks and Financing

- Check maturity table
- Bank exposure chart
- Loan summary cards
- Installment schedule

#### D. Production Economics

- Normal vs overtime model cards
- Break-even TL/min chart
- Part-level profitability table
- Capacity utilization estimate

#### E. Reports

- Daily checklist
- Weekly finance action summary
- Monthly executive summary
- Data-quality report

---

## 18. UX Rules

- Dense but readable.
- Serious internal finance tone.
- No landing-page aesthetic.
- No animated marketing sections.
- Mobile responsive enough for quick checks.
- Unknown amount is always visible, never treated as zero.
- Negative amount is not always an error; context decides whether it is signed direction or anomaly.
- High-risk months and days must be visually dominant.
- Cash deficit must be impossible to miss.
- Every imported row must be traceable back to source sheet/row.

---

## 19. Reports v2

### Daily report

- Due today
- Due tomorrow
- Next 7 days known outflow
- Missing amount list
- Check maturities in next 7 days
- Overdue payments
- Action checklist

### Weekly report

- Payment load this week
- Check load this week
- Loan installments this week/month
- Risk-day clusters
- Missing data
- Bank/provider concentration
- Cash readiness checklist

### Monthly report

- Opening/devir
- Income
- Expense
- Monthly delta
- Closing/kasa
- Top 10 outflows
- Customer concentration
- Vendor concentration
- Checks maturing
- Loan burden
- First/worst forecast risk
- Data quality issues

### Strategic report

- 3/6/12/24/36-month cash runway
- First negative month and deficit growth
- Normal vs mesaili cost comparison
- Part-level margin warnings
- Machine ROI snapshot

---

## 20. Implementation Phases

### Phase 0 — Data-map and project setup

Goal: confirm workbook structure and update docs before coding business logic.

Deliverables:

- `docs/data-map.md`
- `docs/import-mapping.md`
- `docs/calculation-rules.md`
- `docs/risk-register.md`
- confirmed source sheet categories
- source file parser spike using `xlsx` and/or `exceljs`

Verification:

- list all sheets
- classify each sheet as loan/capacity/roi/payment/checks/cost/monthly_cashflow/unknown
- no silent discard
- invalid workbook failure documented

### Phase 1 — Database foundation

Goal: create raw source layer and normalized finance skeleton.

Deliverables:

- Supabase migrations for:
  - source tables
  - parties/categories/accounts
  - payments/payment_instances
  - cashflow_months/cashflow_lines
  - checks
  - loans/loan_installments
  - reminders/reports/audit_logs/settings
- seed data
- RLS policies
- generated database types

Verification:

- migration reset works
- constraints pass
- null amount remains null
- paid requires paid_at
- RLS enabled

### Phase 2 — Import review and mapping UI

Goal: preserve workbook data and map candidates safely.

Deliverables:

- workbook upload screen
- sheet list screen
- raw row/cell viewer
- detected sheet type badges
- mapping review table
- payment-day matrix extraction preview
- monthly cash-flow extraction preview
- check extraction preview

Verification:

- every source row can be traced
- ambiguous rows go to review
- no direct write into final tables without mapped status

### Phase 3 — Payment radar MVP

Goal: operational payment tool usable daily.

Deliverables:

- payment CRUD
- monthly instance generation
- today/tomorrow/next 7 days
- monthly payment calendar
- paid/unpaid marking
- missing data report
- overdue report
- payment risk flags

Verification:

- due-day 31 edge cases tested
- duplicate instance generation prevented
- missing amount visible
- overdue visible

### Phase 4 — Cash-flow radar

Goal: turn monthly sheets into forecast dashboard.

Deliverables:

- monthly cash-flow table
- devir/gelir/gider/fark/kasa cards
- cash balance trend
- first negative month detection
- worst month detection
- customer/vendor concentration

Verification:

- monthly rollups match imported values
- closing balance continuity checked
- negative cash months flagged

### Phase 5 — Checks and financing

Goal: track check maturities and loan pressure.

Deliverables:

- checks ledger
- check maturity calendar
- bank exposure chart
- loan summary
- installment schedule
- debt-service monthly load

Verification:

- signed amounts mapped with direction
- negative checks not blindly flagged as errors
- duplicate-looking check rows reviewed
- loan totals reconcile with source values

### Phase 6 — Reminders and reports

Goal: operational alerting and decision summaries.

Deliverables:

- Telegram reminders
- reminder delivery log
- daily/weekly/monthly reports
- AI commentary prompt templates

Verification:

- duplicate reminder prevention
- Istanbul timezone handling
- AI cannot mutate records

### Phase 7 — Production cost/capacity analytics

Goal: add management insight without breaking finance core.

Deliverables:

- capacity model import
- normal vs overtime comparison
- cost model cards
- part-level profitability table
- break-even TL/minute charts

Verification:

- low-confidence data remains marked
- calculations have tests
- outputs are labeled as analytics, not accounting truth

### Phase 8 — Scenario engine

Goal: safe what-if analysis.

Deliverables:

- scenario runs
- adjustable income/expense/capacity assumptions
- no mutation of source-of-truth data
- compare baseline vs scenario

Verification:

- scenarios are read-only overlays
- baseline preserved
- changes auditable

---

## 21. Routes

```txt
/app
  /(auth)
    /login
  /(dashboard)
    /dashboard
    /payments
    /payments/calendar
    /payments/missing-data
    /cashflow
    /cashflow/months
    /cashflow/forecast
    /checks
    /loans
    /capacity
    /reports
    /imports
    /imports/[workbookId]
    /imports/[workbookId]/sheets/[sheetId]
    /settings
```

---

## 22. File Structure

```txt
src/
  app/
  components/
    dashboard/
    payments/
    cashflow/
    checks/
    loans/
    capacity/
    imports/
    reports/
    shared/
  lib/
    supabase/
    validation/
    calculations/
    risk/
    importers/
    reminders/
    reports/
    ai/
  server/
    actions/
    queries/
    jobs/
  types/
supabase/
  migrations/
  seed.sql
docs/
  data-map.md
  database-schema.md
  import-mapping.md
  calculation-rules.md
  risk-register.md
  todo.md
```

---

## 23. Calculation Rules

### Amount semantics

- `null` amount means unknown.
- `0` amount means explicitly zero.
- Negative amount means signed source value; context determines inflow/outflow/anomaly.
- Checks may use negative signed amount for outgoing obligations.
- Cash-flow sheets may use negative values for bank/card balances.

### Monthly continuity

For monthly cash-flow:

```txt
closing_balance = opening_balance + projected_income - projected_expense + adjustments
next_month.opening_balance should equal previous_month.closing_balance unless there is a manual correction.
```

Mismatch must be flagged as `continuity_break`.

### Due-day normalization

- due_day 1-28: direct mapping
- due_day 29-31: if month has fewer days, map to last day of month and flag `short_month_adjustment`

### Risk thresholds defaults

```txt
large_payment_threshold_try = 50_000
critical_payment_threshold_try = 100_000
same_day_cluster_count = 3
negative_cash_threshold_try = 0
high_customer_concentration_ratio = 0.40
high_bank_exposure_ratio = 0.40
```

---

## 24. Tests Required

### Unit tests

- due-date generation
- due-day 31 February mapping
- null vs zero amount
- negative amount semantics
- risk-level assignment
- cash-flow continuity
- first negative month detection
- loan finance cost calculation
- check maturity grouping
- capacity/cost calculation

### Integration tests

- import workbook → source tables
- source rows → mapping review
- payment matrix → payment templates
- monthly cashflow sheet → cashflow_months and lines
- checks sheet → checks ledger
- loan sheet → loan and installments
- reminder job → delivery log

### E2E tests

- login
- view dashboard
- mark payment paid
- view missing data
- upload workbook
- review mapped rows
- view cash-flow forecast
- view checks calendar

---

## 25. Risk Register

| Risk | Severity | Mitigation |
|---|---:|---|
| Workbook format is inconsistent | Critical | Preserve raw cells, map through review layer |
| Binary workbook upload is invalid | High | Import UI must show technical parse failure and allow re-upload |
| Negative values misread as errors | High | Add direction/signed amount semantics |
| Monthly cash-flow row labels shift | High | Detect by sheet type + candidate labels + review screen |
| AI gives misleading financial interpretation | High | AI commentary only, deterministic calculations are source of truth |
| Scope creep into ERP | High | Keep module gates; no inventory/payroll/accounting ledger |
| User builds analytics before payment workflow | Medium | Phase-gate: payment/cashflow first, capacity later |
| Multi-year forecast gives false confidence | Medium | Show source/import confidence and last review date |
| Check duplicate rows | Medium | Duplicate detection + manual review |
| Cash continuity mismatch | Medium | Continuity validation rules |

---

## 26. Claude Initial Prompt v2

Use this after uploading the updated package:

```text
You are Claude Code acting as a senior full-stack product architect, database architect, QA lead, and implementation engineer.

I uploaded the MAS Nakit Radar package. Read implementation.md first.

Important update:
This is no longer only a payment calendar. The workbook evidence shows four pillars:
1. payment radar
2. monthly cash-flow forecast
3. checks + loans + financing radar
4. production capacity/cost analytics

Still, this is NOT a public SaaS and NOT an ERP.
Do not build multi-tenant features, subscriptions, pricing pages, public landing pages, Stripe/iyzico, onboarding, marketplace logic, or generic SaaS features.

Start by inspecting all docs and the .claude skills.
Then provide:
1. what the app is now
2. what changed from the previous payment-only scope
3. the safest Phase 0 and Phase 1 plan
4. exact files you will create/modify
5. what you will not build yet

Do not start Phase 2 or broad UI polish.
Implement Phase 0 and Phase 1 only after confirming the plan.
```

---

## 27. Final Product Boundary

The correct final product is not:

- a public SaaS
- an ERP
- a bookkeeping/accounting replacement
- an AI accountant
- a generic dashboard template

The correct final product is:

> MAS’ın gerçek Excel çalışma şeklini güvenli, izlenebilir, hatırlatmalı, raporlu ve analiz edilebilir bir iç operasyon paneline dönüştüren özel finans-operasyon sistemi.

MVP mantra:

> Önce veriyi kaybetme. Sonra ödeme ve nakit riskini görünür yap. En son stratejik kapasite/maliyet zekasını ekle.
