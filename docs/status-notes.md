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

## Phase 3 — DONE
- Kural-önce: rules.ts (kırpma + risk merdiveni) 9 birim test, sonra engine.
- mapAcceptedCandidates: temiz ∪ {accepted,resolved}; open/rejected/isimsiz hariç; import_rows→mapped işareti + payments.source_row_id ile idempotent; her aktarım audit'li. Gerçek veri: 19 kalem (TİJEN open→dışarıda, ATİLLA rejected→dışarıda, ÖMER accepted→içeride, PRONET→irregular, etiketsizler→asla).
- generateInstancesForMonth: ON CONFLICT(partial unique) → tekrar üretim 0; ayrıca DB-seviyesinde ham INSERT ile unique kanıtı. Şubat 2027'de gün-30 → 28 + short_month_adjustment notu DB'de doğrulandı. 44 eksik tutar NULL kaldı, sıfır adet 0.
- Risk: gün-9 yığılması tam 3 (Business+Paraf+Tijen Akbank), kritik=2 (190k, 120k); eşikler settings'ten.
- Mutasyonlar: mark_paid/mark_unpaid/set_instance_amount + payment CRUD — hepsi before/after audit_logs (script +2 kanıtı).
- TASARIM KARARLARI: (1) kalem düzenlemesi üretilmiş açık kayıtları GERİYE DÖNÜK değiştirmez (tarihsel gerçek korunur; formda not var). (2) /radar ve /calendar GET'i idempotent ensureWindow/generate çağırır — tek operatör için kabul, perf riski register'da. (3) Ödenen-tutarı bilinmeyen kalem "ödendi" işaretlenebilir (paid_amount null) — dürüst belirsizlik.
- Gate: lint ✓ typecheck ✓ vitest 54/54 ✓ db:verify ✓ import:real ✓ phase3:verify ✓ build ✓ smoke 4×200 (radar gerçek rozetlerle: kritik×10, yığılma×18, TUTAR EKSİK×64).

## Next — Phase 4 slice plan (cashflow)
(1) monthly_cashflow accepted satırları → cashflow_months+lines mapping (kimlik zaten importta doğrulanıyor), (2) devir zinciri validator (continuity_break), (3) /cashflow ay listesi + ay detayı, (4) horizon projeksiyonu + first_negative_month/worst_month (cashflow_snapshots), (5) konsantrasyon oranları. Gate: birim (zincir/projeksiyon) + gerçek-veri (35 ay, bilinen kasa serisi birebir) + smoke.

## Phase 4 — DONE
- Kural-önce: findContinuityIssues / buildProjection / horizonCards / concentration → 8 birim test (toplam 62), sonra engine.
- mapCashflowMonths: ay-seviyesi açık/ret inceleme → ay hariç; satır-seviyesi → yalnız o satır hariç (66 satır). 35/35 ay, 1.058 satır, %100 source_row_id izli, 17 null tutar NULL kaldı, party eşleşmesi yalnız normalize-birebir (268 satır).
- **Kaynak mutabakatı iddiası**: 35 ayın beşli başlık değerleri source_cells B1/D1/F1/H1/J1 ile ±0.5 birebir (SQL cross-join kanıtı). Final kasa 2029-03 = −3.064.607,57 — Oturum-1'de elle doğrulanan değerle aynı.
- Zincir: TEMİZ'de 0 kırık; enjekte edilen kırık → mapping_reviews(continuity_break) bayrağı, değer DEĞİŞMEDİ (sessiz-düzeltme yasağı kanıtlı); month_gap ayrı tip.
- Projeksiyon çapraz-doğrulama (SQL vs pure fn): ilk negatif 2026-09, en kötü 2029-03, 31 ay ardışık negatif. Konsantrasyon: Hpt %79 (>%40 bayraklı) — beklenmedik ama gerçek; akon değil Hpt baskın müşteri.
- UI: /cashflow (5 ufuk kartı + uyarılar + 2 SVG grafik + 2 konsantrasyon paneli + 35 ay tablosu), /cashflow/[monthId] (kimlik rozeti + gruplu satırlar + kaynak sekme linki), workbook sayfasında "nakit akışını aktar" butonu, nav NAKİT aktif.
- scripts/seed-demo.ts: tam demo durumu (19 kalem + 35 ay) — smoke ve dev için.
- Gate: lint ✓ typecheck ✓ vitest 62/62 ✓ db:verify ✓ import:real ✓ phase3:verify ✓ phase4:verify ✓ build ✓ smoke 4×200 (RSC payload'da ilk-negatif rozetleri ×5, 31-ardışık uyarısı, −3.064.608 ×8 doğrulandı).
- Not: curl-grep RSC metin bölünmesine takılabiliyor; sayısal kanıtın esası phaseN-verify scriptleri.

## Next — Phase 5 slice plan (checks + loans / financing)
(1) ÇEKLER accepted satırları → checks (signed→direction, |amount| tutarlılığı DB'de zaten kısıtlı; duplicate_check open=hariç), (2) faiz hesaplama → loans + loan_installments (amortisman satırları 14..105; Σtaksit≈B10 mutabakat, sapma→loan_reconciliation review), (3) vade takvimi (hafta/ay gruplu çek vadeleri + kredi taksitleri), (4) /financing UI (çek listesi yön rozetli, kredi kartı + taksit tablosu), (5) nakit akış ayına borç-servisi bindirmesi (kredi taksit toplamı aylık satır). Gate: birim (amortisman/mutabakat) + phase5:verify (gerçek 143 çek satırı + 1.5M kredi) + smoke.

## Ortam değişikliği (Oturum 2 — Windows'a taşındı)
- Geliştirme artık **Windows 11** üzerinde. Önceki Linux konteyneri yok. PostgreSQL 16 **Docker container** (`mas-radar-pg`, 127.0.0.1:5432, restart unless-stopped) olarak çalışıyor. `scripts/db/{ensure,verify,dev-reset}.sh` Debian `pg_ctlcluster`/`su postgres`'ten `docker exec`'e uyarlandı (davranış birebir korundu, assertions/migrations aynı).
- pnpm 11 (`npm i -g pnpm`) + `pnpm-workspace.yaml` allowBuilds (esbuild/sharp/unrs-resolver). Bağımlılıklar lockfile'dan kuruldu.
- Kaynak dosyalar `data/source/` (gitignore'lu): orijinal 42-sekme dosya + bozuk TEMİZ-4 fixture mevcut. **TEMİZ.xlsx (43 sekme, sha256 d725390a…) bu makinede YOK** — kullanıcı claude.ai eski oturumdan yeniden indirecek. import:real/phase3/phase4/phase5 verify bu dosya olmadan çalışamaz.

## Phase 5 — DONE (kod tamam; gerçek-veri gate'i TEMİZ bekliyor)
- Kural-önce: `src/lib/financing/rules.ts` (signedToDirection, groupMaturities hafta/ay, isoWeekOf, maturityWindows 7/14/30, exposureBy %40, scheduleDueDates türetimi + kısa-ay kırpma, reconcileLoan FLAG-only ±1 TL, debtServiceByMonth) → 20 birim test. Ayrıca `extractLoan` (faiz çapaları B4/B5/B9/B10/B11/B12/F4/F6/F7, boş-A satırı döngüyü durdurur, F1≠B5→loan_field_ambiguous) → 5 birim test. Toplam vitest **87/87**.
- Migration 0008: `checks.source_row_id` + `loans.source_sheet_id` partial-unique (DB-idempotency, Phase-3 deseni) + assertions.sql'e 2 yeni PASS. Migration 0009: `checks.counterparty_label` (ham KİME/KİMDEN; Phase 4 label deseni — parti sessiz yaratılmaz, FK null kalır insan bağlayana dek).
- Engine (`src/lib/financing/engine.ts`): `mapAcceptedChecks` (eligibility=temiz∪{accepted,resolved}; duplicate_check/unparsed açık→hariç; signed→yön, |amount|, banka **ASCII-lowercase** eşleşme — normalizeTr "DENIZ"→"denız" bug'ı düzeltildi; check_events 'created'; audit'li; ON CONFLICT source_row idempotent), `mapLoans` (sheet-seviyesi açık/ret inceleme→hariç; ambiguity resolve edilene dek kredi girmez; taksit vadeleri `scheduleDueDates` ile TÜRETİLİR — kaynakta satır-tarihi yok; Σtaksit mutabakatı sapma→loan_reconciliation review ama **kaynak değeri kazanır**, ON CONFLICT source_sheet + (loan_id,no) idempotent), loaders + `loadMaturityItems`.
- **Gerçeklik bulgusu (dry-run):** gerçek ÇEKLER'de 7 satır, hepsi DENİZ bankası, hepsi negatif (outflow=ödeme yükümlülüğü, anomali DEĞİL). Çift-kayıt: AKR (±0 gün) + çağdaş üçlüsü → duplicate_check açık → ilk map'te hariç; insan resolve edince hepsi girer, idempotent. Kredi: 1.5M anapara, 48 taksit, ilk 2024-10-18, total 3.443.717,58 = kaynak B10 birebir, finansman maliyeti 1.943.717,58 = total−anapara. F1="kredi taksit sayısı"=25 ≠ B5 vade=48 → loan_field_ambiguous (insan kararı).
- UI: `/financing` (5+ panel), `/financing/loans/[loanId]` (taksit planı, türetilmiş vadeler), nav ÇEK/KREDİ aktif, workbook detayında "çek/kredi aktar" (mor) butonu. Smoke: /financing 200 + ÇEK DEFTERİ/KREDİLER/BANKA EXPOSURE(Deniz)/VADE TAKVİMİ/borç-servisi render; loan detail 200 + taksit planı + vade 2024-10-18→2028-09-18.
- Gate durumu: lint ✓ typecheck ✓ vitest 87/87 ✓ db:verify(×reset, 0008+0009+12 assertion) ✓ build ✓ **phase5:verify dry-run (PHASE5_SRC=orijinal, ÇEKLER/faiz özdeş) ALL PASS ✓**. **BEKLEYEN:** import:real / phase3:verify / phase4:verify / phase5:verify GERÇEK TEMİZ'de — dosya gelince çalışacak; hepsi yeşil olmadan commit yok.
- Not (borç-servisi × nakit-akış bindirmesi, plan adım 5): /financing'de aylık borç servisi paneli var; cashflow ay-detayına overlay ayrı küçük dilim olarak Phase 6'ya bırakıldı (scope disiplini — tek doğrulanmış dikey dilim).

## Next — Phase 6 slice plan (reminders + reports)
implementation.md §0 sırası: risk motoru/raporlar. Reminder motoru mock transport ile (api.telegram.org erişilemez); duplicate önleme DB'de zaten kısıtlı (reminder_deliveries unique). İlk dilim: rapor üreticiler (günlük/haftalık/aylık) saf fonksiyon + test, sonra reminder eligibility. Borç-servisi×nakit-akış overlay bu fazın küçük bir parçası olarak eklenebilir.

## Phase 6A — DONE (raporlar + borç-servisi overlay; reminders 6B'ye bırakıldı)
- **Dilim kararı:** Phase 6 ikiye bölündü. 6A = raporlar + overlay (tamamen read-only, sıfır mutasyon riski). 6B = reminder engine (mock transport, ayrı endişe). Slicer kuralı: tek doğrulanmış dikey dilim.
- Kural-önce: `src/lib/reports/rules.ts` (istanbulDateISO Europe/Istanbul tz; buildDailyReport bugün/yarın/7g/geciken/çek/aksiyon; buildWeeklyReport hafta yükü/çek/taksit/riskli gün; buildMonthlyReport devir-gelir-gider-kasa/ödenen-kalan/top10/dağılımlar/veri-kalitesi; overlayDebtService baskı=negatif kasa+borç, izle=pozitif ama borç kayda değer; buildCommentaryPrompt yalnız prompt-string, mutasyon yasağı gömülü). null asla 0 → "TUTAR EKSİK". **9 birim test**, vitest **96/96**.
- Engine (`src/lib/reports/engine.ts`): generateDaily/Weekly/Monthly domain veriyi yükler (radar/queries + financing loaders reuse), saf builder'ı çağırır, `public.reports`'a snapshot + audit yazar. **Mali kayıt (payments/instances/checks/loans/installments/cashflow) MUTASYONU YOK** — phase6-verify before==after fingerprint ile kanıtlı. AI yorum katmanı yalnız `meta.commentary_prompt` string'i; model çağrılmaz.
- **Overlay ("eklensin"):** `loadDebtOverlay` = Phase-4 kasa + Phase-5 borç-servisi (o ay vadesi gelen çek+taksit). `/cashflow` ay tablosuna "borç servisi" kolonu + baskı(kırmızı)/izle(amber) rozetleri. Gerçek veri: 35 ay SQL-birebir, 29 ayda borç yükü, 25 ay yüksek baskı (negatif kasa + borç).
- UI: `/reports` (üret butonları + geçmiş liste), `/reports/[reportId]` (body_md `<pre>` + AI prompt paneli "model çağrılmadı" rozetiyle), nav RAPOR aktif. Smoke: /reports 200, rapor detay 200 (mutasyon-yasağı metni render), /cashflow overlay (baskı/izle rozetleri) render.
- phase6-verify.ts (PHASE6_SRC ile de çalışır): domain kur (import→map payments/cashflow/checks/loans, resolve reviews) → 3 rapor üret → daily next7/monthly knownTotal SQL cross-check, overlay 35 ay SQL-birebir, mali bütünlük before==after, commentary prompt-only (update/insert/delete içermez), Istanbul tz sınırı, audit 3 satır. **ALL PASS.**
- Gate: lint ✓ typecheck ✓ vitest 96/96 ✓ db:verify ✓ import:real ✓ phase3/4/5/6:verify ✓ build ✓ smoke ✓.

## Next — Phase 6B slice plan (reminders)
reminders/reminder_deliveries tabloları + 5 seed kural hazır (0006). İlk dilim: eligibility saf fonksiyon (offset_days 7/3/1/0/−1, min_amount filtresi, Istanbul tz) + test; sonra schedule engine (reminder_deliveries yazar, unique(reminder_id,entity,scheduled_for) duplicate önler — DB'de kanıtlı); mock Telegram transport (fetch enjekte edilebilir, gerçek gönderim yok); delivery log UI. AI/gönderim mali kaydı değiştiremez.

## Phase 6B — DONE (reminder engine)
- Kural-önce: `src/lib/reminders/rules.ts` (scheduledForDate: offset N → due−N günü tetikler, −1=vade+1 gecikme; isEligible=aktif+unpaid/partial+scheduled==bugün(Istanbul)+eşik; thresholdPasses: min_amount null-ya-da-tutar-null → HARİÇ TUTMAZ, yalnız BİLİNEN düşük tutar filtrelenir; buildReminderMessage: ad/vade/tutar|tutar-eksik/durum/sahip/sağlayıcı/risk). **14 birim test**, vitest **110/110**.
- Transport (`transport.ts`): Transport arayüzü; `mockTransport({failOn})` (deterministik, sent[] toplar); `telegramTransport()` token+chat SERVER-ONLY env'den, yoksa/erişilemezse **fırlatmaz** → `{ok:false,error}` döner (token asla client'a sızmaz; api.telegram.org bu ortamda erişilemez).
- Engine (`engine.ts`): `scheduleReminders` (eligibility→reminder_deliveries 'pending', ON CONFLICT(reminder_id,entity_table,entity_id,scheduled_for) do nothing → duplicate önleme DB-seviyesinde), `dispatchPending(transport)` (her bekleyeni gönderir, sonucu satıra LOGLAR: sent+sent_at | failed+error; exception yutulur, 'sent' yeniden gönderilmez), loaders. **payments/instances/checks/loans MUTASYONU YOK.**
- UI: `/reminders` (pending/sent/failed/skipped sayaçları + "bugünü planla" + "bekleyenleri gönder (Telegram)" + teslimat kaydı tablosu). Dispatch gerçek telegramTransport kullanır → token yoksa dürüstçe 'failed' loglar (sahte başarı yok). nav HATIRLATMA aktif.
- phase6b-verify.ts (PHASE6B_SRC ile de): TODAY=2026-07-06 sabit; 57 açık instance × 5 kural → 6 eligible teslimat (hepsi due−offset=bugün); schedule#2=0 (duplicate) + ham dup insert unique_violation; mock success → 6 'sent'+sent_at+mesaj alanları; tekrar dispatch attempted=0; bir kayıt pending'e çekilip failing-mock → 1 'failed'+error loglandı; mali bütünlük before==after; Istanbul tz. **ALL PASS.**
- Gate: lint ✓ typecheck ✓ vitest 110/110 ✓ db:verify ✓ import:real ✓ phase3/4/5/6/6b:verify ✓ build ✓ smoke ✓.

## Next — Phase 7 slice plan (capacity/cost analytics)
implementation.md §0 sırası: kapasite/maliyet. Tablolar tasarımda var (machine_assets/production_parts/capacity_models/cost_models/part_profitability_runs), henüz uygulanmadı. Kaynak sekmeler: kapasite (2023 stale-rate), maliyet-mastechnic(mesaili). Kural-önce: başabaş TL/dk = aylık sabit maliyet ÷ (etkin dakika × verim), normal vs mesaili aynı parça mixinde; çıktı "analitik, muhasebe gerçeği değil" etiketli; stale_rate rozeti korunur. AI yorum-only. Bu faz mali çekirdeği bozmaz.

## Phase 7 — DONE (kapasite/maliyet analitiği)
- **Tablolar ilk kez uygulandı** (Migration 0010): implementation.md §14'ün 6 tablosu + Phase-7 kolonları (capacity: freze/torna rate, rate_year, is_stale_rate, theoretical_monthly/total_revenue, effective_monthly_minutes; cost: break_even_tl_per_min, effective_monthly_minutes, scenario_type). RLS+policy (0007 bunlardan önce çalıştığı için 0010 kendi içinde enable eder), idempotency uniques (production_parts.source_row, capacity/cost.source_sheet, profitability(part,cost)), machine seed 4 aday, ROI needs_review default. assertions.sql'e 3 yeni PASS.
- **Gerçek sekme yapısı (audit):** kapasite C1=20.128 freze / C2=16 torna (2023 stale), B3=0.75 verim, I8=18.57M yıllık teorik, K8=1.55M aylık teorik, G5+H5=1.199.429 toplam talep dk. Parça bloğu satır 10..87, **aralarda grup başlıkları (ARS14000/OJ/TEKNOPAR) ve 5-satır boşluk var** → extractCapacity gap-toleranslı (quantity varsa parça, başlık/boşluk atla, 20-satır boşlukta bitir); **68 parça, sessiz atlama YOK (talep=kaynak G5+H5 birebir kanıtlı)**. maliyet-mastechnic(mesaili): A2 dk/ay-makine, A6=3.8 tezgah, E6 verim, F6 etkin dk (=A6×A2×E6), G6 başabaş (=B7÷F6), B7 aylık maliyet. Normal başabaş 26.1836, mesaili 21.5397 (mesaili daha düşük — birim maliyeti azaltıyor).
- Kural-önce: production/rules.ts (effectiveMinutes, utilizationRate, breakEvenTLPerMin, capacityGap, theoreticalRevenue, compareScenarios, partProfitability, machineRoi, revenueGap, buildInsights) → **18 birim test**, vitest **128/128**.
- Engine: mapCapacitySheet/mapCostSheets (eligibility=sheet-review açık/ret→hariç; idempotent), calculatePartProfitability (maliyet=Σ(dk×op-rate); süre-eksik→needs_review + maliyet NULL; idempotent per part×model), calculateMachineRoiSnapshot (**her zaman needs_review** — tablo sekmesi kişisel/şirket karışık), loaders + loadCapacityDemand + loadActualMonthlyIncome. **payments/instances/cashflow/checks/loans/reminders/reports MUTASYONU YOK.**
- UI: /production (disclaimer + kapasite kartları + NORMAL vs MESAİLİ + TL/dk + teorik-vs-gerçek gelir + kapasite kullanımı %249 aşırı-yük içgörüsü + maliyet tablosu + parça kârlılığı en-düşük-20 + makine ROI needs_review + deterministik içgörüler + kaynak sekme linkleri). nav ÜRETİM, workbook "üretim analitiğini aktar" (amber) butonu.
- phase7-verify: no-silent-discard (68 parça talep=G5+H5), izlenebilirlik, stale-rate, başabaş=G6 birebir+mutabakat, süre-eksik null, ROI needs_review, idempotency, **mali bütünlük before==after**. ALL PASS.
- Gate: lint ✓ typecheck ✓ vitest 128/128 ✓ db:verify ✓ import:real ✓ phase3/4/5/6/6b/7:verify ✓ build ✓ 6-route smoke ✓.

## Next — Phase 8 slice plan (scenario engine)
implementation.md §20 Phase 8: salt-okunur senaryo overlay'leri. baseline korunur; gelir/gider/kapasite/verim varsayımları ayarlanır; senaryo çıktısı kaynak-of-truth'a yazmaz (ayrı scenario_runs tablosu), baseline vs senaryo karşılaştırma, değişiklikler auditable. Kural-önce: senaryo uygulama saf fonksiyon (baseline + delta → projeksiyon) + test; sonra read-only overlay engine. Mali çekirdeği ve üretim analitiğini bozmaz.
