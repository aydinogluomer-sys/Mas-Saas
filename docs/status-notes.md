# Status Notes

## Kanonik modül tamamlama — AI / Senaryo v2 / Veri Kalitesi / Aksiyon

- AI soru-cevap ve rapor yorumu `/insights/ask/*` ve `/insights/reports/*` kanonik rotalarında cevap modu, model, güvenlik notu, kaynak kanıtı ve göreve dönüştürme ile görünür.
- Senaryo v2 hedefli tahsilat gecikmesi, ödeme ertelemesi, faktoring, kapasite, verim ve borç servisini açar; optimizasyon adayları çalıştırılıp kaydedilebilir ve iki çalışma karşılaştırılabilir.
- Veri Sağlığı karar güveni, mutabakat, sorun dağılımı, eski üretim tarifesi, dış varsayım ve denetim sinyallerini gösterir. İnceleme Kuyruğu doğrudan karar ve görev aksiyonları sunar.
- Görevler arama/durum filtresi, manuel oluşturma, başlatma, engelleme, tamamlama, iptal ve kapanış notu akışlarını kullanır. İnternet kaynaklı dış varsayımlarda URL zorunludur.
- Merkezi özellik kayıt listesi motor/arayüz/test/kanonik rota durumlarını `/system/features` üzerinde üretir; eski üst seviye rotalar modül rotalarına yönlenir.

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
- Engine: mapCapacitySheet/mapCostSheets (eligibility=sheet-review açık/ret→hariç; idempotent), calculatePartProfitability (maliyet=Σ(dk×op-rate); süre-eksik→needs_review + maliyet NULL; idempotent per part×model), ~~calculateMachineRoiSnapshot (her zaman needs_review — tablo sekmesi kişisel/şirket karışık)~~ **[Bulgu #3, commit 2185d03 ile kaldırıldı — ROI yalnız mapMachineRoi/workbook aktarımıyla yazılır]**, loaders + loadCapacityDemand + loadActualMonthlyIncome. **payments/instances/cashflow/checks/loans/reminders/reports MUTASYONU YOK.**
- UI: /production (disclaimer + kapasite kartları + NORMAL vs MESAİLİ + TL/dk + teorik-vs-gerçek gelir + kapasite kullanımı %249 aşırı-yük içgörüsü + maliyet tablosu + parça kârlılığı en-düşük-20 + makine ROI needs_review + deterministik içgörüler + kaynak sekme linkleri). nav ÜRETİM, workbook "üretim analitiğini aktar" (amber) butonu.
- phase7-verify: no-silent-discard (68 parça talep=G5+H5), izlenebilirlik, stale-rate, başabaş=G6 birebir+mutabakat, süre-eksik null, ROI needs_review, idempotency, **mali bütünlük before==after**. ALL PASS.
- Gate: lint ✓ typecheck ✓ vitest 128/128 ✓ db:verify ✓ import:real ✓ phase3/4/5/6/6b/7:verify ✓ build ✓ 6-route smoke ✓.

## UX refactor — DONE (decision-first cockpit; mali mantık/hesaplama/modül/backend DEĞİŞMEDİ)
- Sorun: MVP detail-first idi (doğrudan /radar açılıyor, modüller/tablolar/review'lar/doğrulama kavramları erken görünüyor → Excel'den zor hissettiriyor). Çözüm: **default ekranlar açıklar, detay ekranlar kanıtlar.** Yalnız IA/nav/layout/sunum değişti; hiçbir hesaplama/importer/engine/migration dokunulmadı.
- **Ana Ekran `/`** (redirect kaldırıldı → `(dashboard)/page.tsx`, nav+gate+stagger içinde): mevcut loader'ları (radar queries + buildProjection + loadDebtOverlay + listReports + deliveryCounts + loadCapacityModels + concentration) salt-okunur composla — 20 saniyede 7 soru: 5 büyük KeyStat + tek-cümle en-büyük-risk + "Ne yapmalıyım?" (max 5 deterministik aksiyon, `src/lib/home/cockpit.ts`) + durum şeridi (son rapor/hatırlatma/üretim). Veri yoksa onboarding kartı.
- **cockpit.ts** saf: `buildActions` (aday sinyaller severity+sabit öncelikle sıralanır, cap 5; boş→"rutin kontrol"; her satır mevcut fact'e dayalı, LLM yok), `pickHeadlineRisk`. 7 birim test → vitest **145**.
- **Nav 10→6** (Ana Ekran/Ödemeler=/radar/Nakit Akış/Finansman/Senaryolar/Yönetim). İkincil route'lar `/admin` Yönetim hub'ında gruplandı (operasyon/rapor-hatırlatma/analitik/veri-kaynak) — **hiçbir route silinmedi**, hepsi erişilebilir.
- **Reorder + collapse**: cashflow 35-ay tablosu, financing çek defteri + vade takvimi, scenarios geçmiş çalışmaları → `DetailsDisclosure` (native `<details>`, erişilebilir, JS'siz, `[&::-webkit-details-marker]:hidden`). Özet/KPI/grafik üstte, teknik detay altta.
- **Senaryo presetleri**: yalnız motorun BİREBİR desteklediği 3 varsayım tek-tıkla preset (Gelir %10↓ / Gider %10↑ / Borç-servisi dahil — hidden-input form, değişmeyen `runScenarioAction`'ı reuse). "Hpt 30 gün gecikirse" → müşteri-bazlı gecikme motoru olmadığından **disabled "yakında"** çipi. "Kapasite %75" → deterministik üretim→cashflow bağı olmadığından yalnız advanced formda. Kural: preset adı = motorun tam yaptığı. Advanced form collapse.
- **Görsel sadeleme**: `globals.css` body fontu sans (system-ui stack); sayılar/kodlar/section-label'lar `font-mono`/`.tnum` ile mono kalır. Yeni `KeyStat` (büyük hero sayı) + `DetailsDisclosure` primitifleri (`shell.tsx`). Düz Türkçe etiketler, 3–5 kart / ≤5 aksiyon / 1 ana grafik / 1 detay tablo hedefi.
- Gate: lint ✓ typecheck ✓ vitest 145/145 ✓ db:verify ✓ import:real ✓ phase3-8:verify hepsi ALL PASS ✓ (mali mantık değişmedi kanıtı) build ✓ 11-route smoke ✓ visual 8/8 (Ana Ekran dahil) ✓.

## Frontend polish — DONE (UI/UX sprint; mali mantık/import/hesaplama DEĞİŞMEDİ)
- Yeni özellik yok. Design-system tutarlılığı + a11y (WCAG 2.2 AA hedefi) + responsive + subtle motion + visual regression.
- **Tokens** (`globals.css`): finance paleti CSS değişkenleri (surface-0..3, line/text kademeleri, pos/neg/warn/info/accent, focus, radius). a11y base: `:focus-visible` ring (yalnız klavye), `::selection`, ince scrollbar, `prefers-reduced-motion` sıfırlama. Motion: rise-in + `.stagger` kaskadı (reduced-motion'da anında).
- **Primitives** (`src/components/ui/`): `PageHeader` (h1+subtitle+meta+action), `KpiCard`/`StatBox` (finansal işaret renk-kodlu), `ChartShell` (`<figure>` + `sr-only` metin özeti + kaynak + empty), `TableShell` (role=region, tabIndex, scroll affordance), `EmptyState`, `Disclaimer`, `Nav` (client, aktif-route `aria-current`). `Panel`/`Badge` geriye uyumlu (accent/dot, AA kontrast). previews testi (Badge metin render) bozulmadı.
- **Uygulama**: 7 ana route (radar/cashflow/financing/reports/reminders/production/scenarios) tutarlı PageHeader + KPI grid + ChartShell + Disclaimer'a taşındı; ad-hoc stat box'lar KpiCard/StatBox oldu; production/scenarios "analitik/senaryo tahmindir" banner'ları `Disclaimer` bileşeni; chart hex renkleri token paletine hizalandı (SVG'ler `role=img`+`aria-label` korudu).
- **Layout**: sticky header + marka accent rail + client Nav (aktif route) + logout; `main.stagger` giriş kaskadı; body token renkleri.
- **Visual regression** (Playwright): `playwright.config.ts` + `tests/visual/dashboard.spec.ts` 7 route full-page snapshot; determinizm için `data-vr="1"` → `[data-volatile]` (timestamp/"bugün") CSS ile gizli; `pnpm test:visual` / `test:visual:update`; baseline'lar `tests/visual/__snapshots__` (Windows-özel, commit'li). next.config `devIndicators:false` (temiz screenshot).
- **Bilinen sınır:** radar en dinamik sayfa (her GET ensureWindow + "bugün" tarihine bağlı) → visual baseline günlük drift edebilir; docs: önce stabil domain seed + `test:visual:update`. Font render OS-özel → baseline'lar makineye bağlı.
- Gate: lint ✓ typecheck ✓ vitest 138/138 ✓ db:verify ✓ import:real ✓ phase3-8:verify ✓ build ✓ 9-route smoke ✓ visual 7/7 ✓. `docs/frontend-polish-guidelines.md` eklendi.

## Deploy — DONE (yerel özel production hazırlığı, Option A — Phase 8 sonrası sprint)
- Yeni ürün özelliği YOK; yalnız production-readiness. MVP zip (`../mas-nakit-radar-mvp.zip`) temiz klasörde fresh install ile doğrulandı (install/lint/typecheck/test 138/build) — kaynaktan yeniden derlenebilir, gizli veri içermez (0 xlsx, 0 hardcoded token, 0 .env).
- Deploy dosyaları: `docker-compose.yml` (postgres:16, kalıcı volume `mas_radar_pgdata`, 127.0.0.1 bind, healthcheck), `.env.example`, `scripts/deploy/{local-start,local-stop,backup-db,restore-db}.sh`, `scripts/deploy/check-env.ts` (secret VALUE'ları yazmaz — yalnız presence + DSN maskeler). `.gitignore`'a `backups/` + `*.dump` eklendi.
- `/health` (app+DB erişilebilirlik; select 1; 200/503; secret/finansal veri yok) ve `/version` (name/version/commit/build/node; secret yok) — (dashboard) grubunun DIŞINDA, access gate'e takılmaz.
- ~~**Minimal access gate**~~ (`APP_ACCESS_PASSWORD`, tek paylaşılan parola + HMAC cookie): **P0-A ile tamamen kaldırıldı**, yerine gerçek çok-kullanıcılı auth geldi. Bu satır tarihsel kayıt olarak duruyor; güncel durum için aşağıdaki "P0-A" bölümüne bakın.
- Güvenlik audit: tek 'use client' (upload-form) yalnız server action referansı alır (doğru RSC); TELEGRAM token yalnız transport.ts'te (server fonksiyon içi); .xlsx client bundle'a girmez; hiçbir yerde env/secret console'a yazılmaz.
- **Backup/restore kanıtı** (yerel Docker PG): backup-db.sh pg_dump -Fc → backups/ (gitignore); restore-db.sh taze DB'ye (FORCE guard) → **0 hata**, restored sayaçlar dev ile birebir (2 workbook/9817 hücre/1601 satır), 33 public tablo, 0 RLS-kapalı, seed (7 ayar/5 hatırlatma) intact. restore-db.sh yalnız cluster rollerini idempotent yaratır, auth schema'yı dump'a bırakır (spurious hata yok).
- Docs: `docs/local-production-deploy.md` (env, start/stop, import, reminders, reports, scenarios, backup/restore, güvenlik sınırları, neden-Vercel/Supabase-değil), mvp-runbook güncellendi.
- **Neden bulut değil:** finansal ham veri özel; kullanıcı talimatı "remote Supabase'e migration uygulama". App DB-URL-taşınabilir (aynı migration her yerde çalışır) → gelecekte hosted deploy config değişikliği, yeniden yazım değil; ama bilinçli ayrı karar.

## Next — Phase 8 slice plan (scenario engine)
implementation.md §20 Phase 8: salt-okunur senaryo overlay'leri. baseline korunur; gelir/gider/kapasite/verim varsayımları ayarlanır; senaryo çıktısı kaynak-of-truth'a yazmaz (ayrı scenario_runs tablosu), baseline vs senaryo karşılaştırma, değişiklikler auditable. Kural-önce: senaryo uygulama saf fonksiyon (baseline + delta → projeksiyon) + test; sonra read-only overlay engine. Mali çekirdeği ve üretim analitiğini bozmaz.

## Phase 8 — DONE (senaryo motoru — MVP TAMAMLANDI)
- Migration 0011: 5 senaryo tablosu + RLS. **Baseline asla mutasyona uğramaz**; senaryo çıktısı yalnız scenario_* tablolarına yazılır; her run açık varsayımlarını ve kullandığı baseline'ı (label + ay sayısı) saklar.
- Kural-önce: scenario/rules.ts — `applyScenario` baseline'ı klonlar, DISCLOSED varsayımları uygular (revenuePct/expensePct income/expense ölçekler; customerDelayMonths geliri N ay ileri kaydırır — **tutar korunur, zamanlama değişir**; capacityUtilizationPct gelir vekili; efficiencyPct gider vekili; includeDebtService Phase-5 borç-servisini gidere ekler) ve **closing zincirini yeniden kurar** (opening[0]=baseline devir, sonraki opening=önceki scenario closing). null gelir/gider → scenario closing null, zincir son bilinen closing'i taşır (uydurmaz). `compareScenarioToBaseline`: final Δ, ilk negatif (baz vs senaryo), en kötü ay/bakiye, maks nakit açığı (>=0), toparlanma ayı, belirsiz-ay sayısı. `scenarioConfidence` (belirsiz oran >%10→low). `buildScenarioInsights` deterministik. **10 birim test**, vitest **138/138**.
- Engine: createScenario/runScenario/createAndRun/loadScenarioRun/listScenarioRuns/deleteScenarioRun — baseline'ı `loadCashMonths` ile OKUR, borç-servisini Phase-5'ten alır, scenario_runs+run_lines+assumptions+comparisons+audit yazar. **payments/instances/cashflow/checks/loans/reminders/reports/production MUTASYONU YOK.** Silme yalnız scenario_* cascade (güvenli), audit'li.
- UI: /scenarios (disclaimer "Senaryo çıktısı tahmindir; muhasebe gerçeği değildir. Kaynak kayıtları değiştirmez." + varsayım formu + çalışma listesi), /scenarios/[runId] (7 sonuç kartı + açık varsayımlar + içgörüler + baz-vs-senaryo SVG chart + 35-ay karşılaştırma tablosu + güvenli sil). nav SENARYO; /cashflow·/production·/financing "senaryo üret" linkleri.
- **Gerçek çalışma (phase8-verify kombine senaryo):** gelir −%10 + gider +%5 + borç-servisi + 1 ay gecikme → final Δ ≈ −13,1M, ilk negatif 2026-08'e çekiliyor, maks açık ≈ 16,2M. revenue%→yalnız gelir, expense%→yalnız gider (SQL cross-check), karşılaştırma=SQL, baseline row-hash + tüm mali tablo fingerprint before==after.
- Gate: lint ✓ typecheck ✓ vitest 138/138 ✓ db:verify ✓ import:real ✓ phase3/4/5/6/6b/7/8:verify ✓ build ✓ 8-route smoke ✓. **MVP tamam** — implementation.md §0 tüm 7 inşa adımı bitti.


## P0-A — DONE (gerçek çok-kullanıcılı auth + kullanıcı yönetimi)

- **Kaldırıldı:** tek paylaşılan parolalı `APP_ACCESS_PASSWORD` access gate (HMAC cookie). Yerine
  adlandırılmış hesaplar geldi; eski env değişkeni artık hiçbir yerde okunmuyor.
- **Migration 0031** (`users` + `sessions`): argon2id `password_hash`, `username` CHECK'i
  (`^[a-z0-9_.-]{3,32}$`), admin/operatör rolü, `failed_login_count`/`locked_until` (5 hata → 15 dk
  kilit). RLS burada **default-deny** (`using(false)`) — diğer tabloların "authenticated her şeyi
  yapar" modelinden bilinçli sapma, çünkü bu tablolar canlı kimlik bilgisi tutuyor.
  **Fail-closed değişmez:** en az bir aktif admin kalmalı — `deferrable initially deferred`
  constraint trigger ile DB seviyesinde; arayüz kontrolü tek başına yeterli değil (admin script'i
  veya iki admin oturumu arasındaki yarış onu aşabilirdi).
- **Migration 0032:** `audit_logs.actor_id` artık `public.users(id)`'ye FK. Oturumsuz çalışan
  otomatik araçlar (`seed-demo`, `import-real`, verify script'leri, `legacy-repair-apply`) rezerve
  edilmiş, `is_active=false` **"system"** hesabına yazıyor (`scripts/db/seed-system-actor.ts`) —
  sessiz `null` actor yok.
- **Oturum modeli:** rastgele opak token (`randomBytes(32)`), DB'de yalnız SHA-256'sı; httpOnly
  cookie, 7 gün. Çıkış ve parola sıfırlama oturumu **gerçekten** iptal eder (`revoked_at`), sadece
  client kopyasını silmez.
- **`src/middleware.ts`:** default-deny matcher — `/login`, `/health`, `/version`, `_next/*` dışında
  her yol cookie varlığı ister. Yapısal düzeltme: `src/app/api/facts` (dashboard route grubunun
  dışındaydı) hiçbir auth kontrolü olmadan finansal veri servis ediyordu. Artık **sonradan eklenen
  her rota otomatik korunuyor** — kimsenin kontrol eklemeyi hatırlaması gerekmiyor. Edge-safe:
  yalnız cookie varlığına bakar, DB'ye gitmez; gerçek doğrulama `requireSession()`/`requireAdmin()`.
- **Kullanıcı yönetimi** (`/system/security`, tamamı `requireAdmin()` arkasında): kullanıcı listesi
  (rol/durum/kilit/açık oturum/son görülme), yeni hesap oluşturma, parola sıfırlama, rol değiştirme,
  pasifleştirme/aktifleştirme, kilit açma. Motor: `src/lib/users/engine.ts`.
  - **Parola asla denetim kaydına yazılmaz** — `before_data`/`after_data` yalnız gizli olmayan
    alanları taşır; parola değişikliği "oldu" bilgisi olarak kaydedilir, değeri veya özeti değil.
  - Parola sıfırlama ve pasifleştirme, hedefin canlı oturumlarını **aynı transaction'da** iptal eder.
  - Rezerve hesaplar (`system`, `testsprite-qa`) listede gösterilmez ve id'si doğrudan gönderilse
    bile yönetilemez.
  - Admin kendi erişimini kaldıramaz (kendini pasifleştirme/operatöre düşürme engelli); son-admin
    durumu ayrıca DB trigger'ı tarafından kesin olarak bloklanır.
- **Bootstrap:** `tsx scripts/db/seed-admin.ts --username <ad> --display-name "<Ad>"`. Parola argv'den
  **kabul edilmiyor** (shell geçmişinde ve process listesinde görünür); `SEED_ADMIN_PASSWORD` env
  veya maskeli interaktif giriş.
- **Gate:** typecheck ✓ (135 → 0 hata) · lint ✓ (0 hata, 1 önceden var olan uyarı) · vitest 200/200 ✓ ·
  db:verify ✓ · db:migrate:verify ✓ · build ✓ · phase3…14e verify 20/20 PASS (atılabilir DB) ·
  9-modül smoke ✓.

### Bu sprintte düzeltilen yarım kalmış işler
- `scripts/` altındaki 20 dosyada **135 typecheck hatası**: engine imzalarına `actorId` eklendiğinde
  çağrı yerleri güncellenmemişti; repo hiç build alamıyordu. Hepsi rezerve "system" actor'ına bağlandı.
- **Phase verify script'leri `audit_logs`'u TRUNCATE ediyordu** — 0022 ile bu tablo append-only
  (UPDATE/DELETE/TRUNCATE yok, kalıcı olarak). Script'ler 0022'den önce yazılmıştı. Değişmez
  zayıflatılmadı; bunun yerine `audit_logs` reset listelerinden çıkarıldı ve her verify çalışması
  **taze oluşturulmuş** atılabilir DB alıyor.
- `scripts/db/assertions.sql`'deki "her public tabloda policy olmalı" kontrolü `schema_migrations`
  için başarısız oluyordu. Sessizce atlamak yerine: tablo kontrolden çıkarıldı **ve** karşılığında
  RLS'inin açık, policy sayısının 0, uygulama rollerine grant'inin 0 olduğu açıkça iddia edildi —
  istisna, doğrulanmış bir değişmez olarak duruyor.
- `src/lib/feature-registry.ts` her satırda `tested: true` hardcode ediyordu; ekranda canlı test
  sonucu gibi okunan, asla kırmızıya dönemeyen bir rozet üretiyordu. `tested` alanı kaldırıldı,
  yerine o özelliği gerçekten çalıştıran gate script'ini adlandıran `verifiedBy` geldi; `/phases`
  ekranı artık bunun **elle tutulan bir envanter** olduğunu açıkça söylüyor.

### P0-A kapanış turu — verify script'lerinin gerçek `pnpm` komutlarıyla doğrulanması

- **`db:transitions:verify` 163/167 → 167/167** (`EXIT=0`). P0-A sonrası `markPaidAction`/
  `markUnpaidAction` kendi içlerinde `requireSession()` → `cookies()` çağırıyor; script bunları
  çıplak fonksiyon olarak çağırdığı için gerçek bir Next.js request scope'u yoktu ve dördü
  "`cookies` was called outside a request scope" ile düşüyordu. Yeni bir test kancası icat
  edilmedi: var olan QA bypass kullanıldı (`getQaBypassUser()`, `src/lib/auth.ts`). Script
  `sanitize-testsprite.sql` ile **birebir aynı** idempotent `testsprite-qa` (is_active=false)
  satırını seed ediyor ve `MAS_QA_BYPASS_AUTH` bayrağını **yalnız o dört assertion boyunca**
  açıyor (try/finally ile eski değerine dönüyor) — script'in geri kalanı auth açısından
  fail-closed kalıyor.
- **`start-testsprite.ts` yorumu düzeltildi:** `testsprite-qa` satırının
  `scripts/db/create-testsprite-db.ts` tarafından seed edildiğini söylüyordu; o dosyada böyle bir
  insert yok. Satır aslında onun çalıştırdığı `scripts/db/sanitize-testsprite.sql`'de. Mekanizma
  çalışıyordu, yalnız yorum yanlış dosyayı işaret ediyordu.
- **`db:legacy-repair:verify` düzeltildi (183/183, `EXIT=0`).** Bu suite 0030'dan itibaren **tüm**
  migration'ları kasıtlı olarak gizliyor (0031/0032 dahil), çünkü test ettiği şey 0022-0029 dönemi
  onarım araçları — yani `public.users` orada tasarım gereği yok. Bir önceki turda
  `legacy-repair-apply.ts`'e eklenen koşulsuz `getSystemActorId()` çağrısı bu bağlamda
  "relation public.users does not exist" ile patlıyordu. Actor artık **koşullu** çözülüyor:
  `to_regclass('public.users')` varsa rezerve "system" hesabı, yoksa `null` — ki bu, 0032'nin
  açıkça meşru saydığı değer ("actor stays nullable here — every pre-P0-A row keeps actor=null
  forever"). Tip düzeyinde `LegacyRepairActorId` ile belgelendi; etkileşimli çağrı yolları
  `string` olarak kalıyor.

### Doğrulanmış operasyonel uyarı — `phase*:verify` script'leri gerçek DB'ye yazar

`scripts/db/*-verify.ts` script'lerinin aksine **`phase*-verify.ts` dosyaları kendi atılabilir
veritabanlarını KURMAZ.** `pnpm phaseN:verify` = `tsx scripts/db/ensure.ts && tsx scripts/phaseN-verify.ts`;
`ensure.ts` yalnız Docker konteynerini başlatır. `DATABASE_URL` verilmezse script'ler
`postgres://…/mas_radar_dev` varsayılanına düşer ve ilk iş olarak
`truncate public.payments, public.payment_instances … cascade` çalıştırır — yani **gerçek finansal
veriyi siler.**

Bu yüzden bu script'ler daima açık bir hedefle çalıştırılmalıdır:

```bash
DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/<atilabilir_db> pnpm phase3:verify
```

Ayrıca `audit_logs` 0022'den beri append-only olduğu için her phase **taze oluşturulmuş** bir DB
ister; aynı DB'de arka arkaya çalıştırmak audit sayımlarını bozar.

### Veri temizliği — mas_radar_dev'deki sentetik ROI satırları silindi (2026-08-11)

Bulgu #3 ile `calculateMachineRoiSnapshot` kaldırıldı (commit 2185d03), ama kodu kaldırmak
onun daha önce **gerçek veritabanına yazdığı** satırları silmez. `scripts/seed-demo.ts`'in
manuel geçişi `mas_radar_dev`'e 8 adet uydurma ROI snapshot'ı yazmıştı (2025 + 2026 × 4 makine,
`3.000.000 + index×800.000 − yearIndex×300.000` formülüyle) ve `/production/roi` bunları
gerçek veriymiş gibi gösteriyordu.

Silme ölçütü **`source_sheet_id is null`** oldu — gerçek `mapMachineRoi` satırları her zaman bir
kaynak sekmeden gelir ve hem `source_workbook_id` hem `source_sheet_id` taşır; sentetik olanlar
yalnız workbook id taşıyordu. Silme öncesi salt-okunur doğrulama: 8 satırın 8'i `has_sheet=false`,
`source_sheet_id is not null` olan **tek satır bile yoktu** (olsaydı işlem durdurulacaktı).

Silinen veri kaybolmadı: `audit_logs`'a `delete_synthetic_roi_rows` eylemiyle, actor=`system`,
`before_data` içinde **8 satırın tam JSON'ı** (id/revenue/cost/tax/net dahil) kanıt olarak
saklandı. "8 satır silindi" demekle yetinilmedi.

Sonrası: `machine_roi_snapshots` = 0 (bu ortamda gerçek ROI aktarımı `personal_data_mixed`
incelemesiyle hâlâ bloklu, dolayısıyla boş olması beklenen durum). `/production/roi` ve
`/production` HTTP 200 render ediyor, konsol hatası yok, uydurma rakamlar ekrandan kalktı.
Mali veri değişmedi: payments=19, checks=7, loans=1, cashflow_months=35.

### Veri temizliği — hatalı capacity_utilization metrikleri silindi (2026-08-11)

Bulgu #6 ile `collectMetricSnapshots`'tan `capacity_utilization` metriği kaldırıldı (commit 7bc9a13),
ama kod kaldırmak onun daha önce yazdığı satırları silmez. `mas_radar_dev`'de 8 haftalık snapshot
(2026-05-29 … 2026-07-17) **yıllık talep ÷ aylık kapasite** ile hesaplanmış hatalı oranı taşıyordu
— örnek değer `37.8605`, yani %3786.

Silme ölçütü `metric_key='capacity_utilization'` — bu tek metriğe scoped; başka metrik ve tarih
etkilenmedi (diğer 184 satır yerinde). Silme öncesi salt-okunur sayım tam 8 çıktı (farklı olsaydı
işlem durdurulacaktı).

Silinen veri `audit_logs`'ta `delete_stale_capacity_utilization_snapshots` eylemiyle, actor=`system`,
`before_data` içinde 8 satırın tam JSON'ı (id/snapshot_date/value_numeric/confidence/meta dahil)
kanıt olarak saklandı.

Mali veri değişmedi: payments=19, checks=7, loans=1, cashflow_months=35.

## Implementation Plan v4 — Faz 15-38 yol haritası belgeye eklendi (2026-08-17)

`implementation.md`'ye `## 17. Implementation Plan v4 — Faz 15-38 Kurumsal Genisleme Yol Haritasi`
bölümü eklendi. Kaynak: kullanıcının verdiği `MAS_Nakit_Radar_Revize_Mimari_Listesi.md` (34 bölüm,
~700 madde), kod tabanının gerçek durumuna göre mutabakatlandırılmış hâli. Mevcut `## 17. Legacy v2
Plan` bölümü `## 18` olarak kaydı; gövdesi karakterine kadar aynı kaldı.

Kapsam: 24 faz numarası, 25 faz başlığı (Faz 24, rol matrisi + RLS'in büyüklüğü nedeniyle **24A**
approval-workflow ve **24B** tam 5 katmanlı rol matrisi + satır-seviyesi RLS olarak ikiye ayrıldı).
34 kaynak bölümün hiçbiri sessizce düşürülmedi — bölüm→faz eşlemesi v4'ün "Kapsam kontrolü"
alt başlığında satır satır duruyor. Çözülen kararlar: Python runtime YOK (Faz 29 ve Faz 34 dahil
tüm deterministik hesap TypeScript/SQL'de kalır), Entegrasyon Merkezi (Faz 37) tam kapsam onaylı,
muhasebe yazılımı vendor seçimi Faz 37 başında netleşecek. Dokuz konu bilinçli olarak açık bırakıldı
ve ilgili faz başlarken sorulacak.

**Bu tur yalnızca dokümantasyondur.** Kod, migration, tablo, script eklenmedi; v3'ün Faz 1-14 +
P0-A/B/C bölümlerine ve DONE işaretlerine dokunulmadı (1-568. satırlar bit-bit aynı).

Bilinçli yapılmayan: `## 16. Commit ve Gate Kurali`'ndeki pnpm zincirine `phase15:verify` …
`phase38:verify` **eklenmedi**. Bu script'ler henüz yok; şimdi eklemek çalıştırılamayan bir gate
üretirdi. Her faz kendi verify script'ini o faz uygulanırken zincire ekler — v4'ün Doğrulama
maddesi de bunu "genişletiliyor mu (yerine geçmiyor mu)" diye kontrol etmeyi şart koşuyor.

Plan onayı 24 fazın tek seferde uygulanacağı anlamına gelmez; CLAUDE.md'nin "en küçük güvenli
dilimi belirle → uygula → doğrula → dokümanı güncelle → o fazdan sonra dur" akışı Faz 15'ten
başlayarak her faz için ayrı ayrı işletilir.

## Kullanıcı eylemi bekleniyor — implementasyon oturumunun yapamayacağı iki iş (2026-08-17)

Aşağıdaki ikisi kod veya migration değil, hesap/panel işidir. Bir Claude oturumu bunları
yapamaz; yalnızca burada kayıt altına alır. İkisi de **Faz 15 başlamadan** yapılmalı.

1. **GitHub repo görünürlüğü private yapılacak — `aydinogluomer-sys/Mas-Saas`.**
   Depo gerçek finansal iş mantığını, şema kararlarını ve operasyon dokümanlarını taşıyor.
   v4'ün Doğrulama bölümü bunu "planın geri kalanının uygulanmasını beklemeden yapılacak tek
   adım" olarak işaretliyor. Durum: **beklemede** — görünürlüğün mevcut değeri bu oturumda
   doğrulanmadı, kullanıcının GitHub panelinden kontrol edip private'a çekmesi gerekiyor.

2. **Secret rotation — DB parolası, `SEED_ADMIN_PASSWORD`, `TELEGRAM_BOT_TOKEN`, `OPENAI_API_KEY`.**
   Depo bir süre public kaldıysa bu değerlerin sızmış sayılması gerekir; görünürlüğü private
   yapmak zaten dışarı çıkmış bir sırrı geri getirmez. Rotasyon GitHub / hosting / ilgili servis
   panellerinden yapılır (Telegram BotFather, OpenAI panel, DB kullanıcı parolası), **koddan
   değil** — bu değerler yalnızca ortam değişkeni olarak okunuyor, depoda tutulmuyor.
   Durum: **beklemede**.

## Faz 15 — DONE (acil güvenlik ve repo hijyeni: runtime DB rolü ayrımı, env merkezi, README)

### Fazı başlatan bulgu: RLS bugüne kadar hiç devrede olmamıştı

`src/lib/db.ts` ve `scripts/db/migrate.ts` aynı `DATABASE_URL`'i kullanıyordu ve kümede tek rol
vardı: `postgres` (superuser). PostgreSQL superuser'ları RLS'i policy'nin hedef rolünden bağımsız
olarak **her zaman** bypass eder. Dolayısıyla 0007'den beri yazılan bütün `to authenticated
using(true)` politikaları dekoratifti. Faz 15 uygulamayı düşük yetkili `mas_radar_app` rolüne
taşıyarak bu politikaları ilk kez fiilen devreye soktu.

### Uygulamadan ÖNCE bulunan bloker: plan olduğu gibi uygulansaydı login tamamen ölürdü

Faz 15 planı `users`/`sessions` için "ek revoke gerekmiyor, RLS `using(false)` zaten tüm satırları
engelliyor" diyordu ve bunu bir güvenlik özelliği sayıyordu. Oysa 0031'in `users_deny_all` /
`sessions_deny_all` politikaları, o migration'ın **kendi yorumunda yazdığı gibi**, uygulamanın
superuser olduğu varsayımıyla yazılmıştı: *"The app itself connects as the Postgres superuser
(src/lib/db.ts) and bypasses RLS like everywhere else."* Faz 15 tam da bu varsayımı kaldırıyor.
`src/lib/auth.ts` bu iki tabloya 8 noktada dokunur (login select/update, session insert, getSession
join, last_seen_at, logout).

**Karşı-olgu deneysel olarak kanıtlandı.** Disposable DB'de 0035'in runtime policy'leri düşürülüp
`db:roles:verify` çalıştırıldığında: `public.users` **okunabiliyor ama 0 satır dönüyor** — oysa
`system` hesabı az önce seed edilmişti. Yani her hesap için "kullanıcı bulunamadı". Kritik olan:
planın önerdiği **dört kontrolün dördü de bu bozuk halde PASS veriyor** (current_user, rolsuper/
bypassrls, schema_migrations reddi, payments okunabilirliği). Gate yeşil yanar, login ölü olurdu.

Çözüm (kullanıcı onayıyla): `deny_all` yerinde bırakıldı, yanına `mas_radar_app` hedefli
`users_app_runtime` / `sessions_app_runtime` (`using(true)`) eklendi. PERMISSIVE politikalar
OR'landığı için uygulama erişir, `authenticated`'ın diğer üyeleri hâlâ erişemez — 0031'in
savunma derinliği niyeti korunur. `db:roles:verify` bu iki policy'nin **ikisinin birden**
durduğunu ayrıca kontrol eder.

### İkinci bulgu: TRUNCATE uygulama yetkisi değildir

`import:real` düşük yetkili rolle `permission denied for table source_workbooks` verdi. Sebep:
**23 script SQL `TRUNCATE` kullanıyor, uygulama runtime'ı (`src/`) hiç kullanmıyor** (`src/`'deki
tüm eşleşmeler Tailwind'in `truncate` CSS sınıfı). `TRUNCATE`'i `authenticated`'a vermek runtime
rolüne `payments`/`checks`/`loans`'u tek komutla silme yetkisi verirdi — üstelik `TRUNCATE` satır
tetikleyicilerini atladığı için `audit_logs`'a **hiçbir iz düşmeden**. Verilmedi; truncate eden
operatör araçları owner bağlantısına taşındı.

### Üçüncü bulgu: 20 gate script'inde gerçek veritabanına superuser düşüşü

20 faz script'i `process.env.DATABASE_URL ?? "postgres://postgres:postgres@127.0.0.1:5432/mas_radar_dev"`
kalıbını taşıyordu: env değişkeni unutulursa **gerçek geliştirme veritabanına superuser olarak
bağlanıp TRUNCATE ediyorlardı**. Hepsi `requireOwnerDatabaseUrl()`'e çevrildi — varsayılana düşmek
yerine yüksek sesle hata verir. `scripts/import-real.ts` ve `scripts/seed-demo.ts` de aynı şekilde.

### Bilinçli olarak UYGULANMAYAN plan maddesi

Plan, `migrate.ts`'in `ANCHORS` dizisine 0035 için bir kayıt eklenmesini istiyordu. **Eklenmedi.**
`ANCHORS` yalnız "ledger yok / ledger boş" yolunda, şemanın *legacy* (≤0019) olup olmadığını
anlamak için kullanılır ve karar `allPass` / `allFail` üzerinden verilir. Gerçek bir legacy DB'de
0035 anchor'ı kaçınılmaz olarak fail eder → `allPass=false, allFail=false` → `INCONSISTENT_PARTIAL`
hard-fail. Legacy onarım yolu tamamen kilitlenirdi. `legacy-baseline-0019.json` sınırı kasıtlıdır.

Ayrıca planın `backup-docker-postgres.ts` ve `create-testsprite-db.ts` için istediği env değişikliği
uygulanamadı çünkü **bu iki script hiç bağlantı stringi okumuyor**; `docker exec ... -U postgres`
ile çalışıyorlar, yani zaten owner tarafındalar.

### Env düzeni (Faz 15 sonrası)

| Değişken | Kim okur | Ne |
| --- | --- | --- |
| `DATABASE_URL` | yalnız `src/lib/env.ts` → `getPool()` | düşük yetkili `mas_radar_app` |
| `MIGRATION_DATABASE_URL` | şema/rol/seed/gate script'leri | owner (`postgres`) |
| `MAS_RADAR_APP_DB_PASSWORD` | yalnız `set-app-role-password.ts` | asla loglanmaz |

`src/lib/env.ts` yedi dosyaya dağılmış `process.env` okumalarını tek, Zod ile doğrulanmış ve
dondurulmuş bir objede topladı; hatalar tek seferde toplu raporlanır. `NODE_ENV` bilinçli olarak
dışarıda bırakıldı (Next.js build-time inline eder, client bileşeninden de okunur). `db.ts`'in
`DEFAULT_LOCAL` superuser fallback'i kaldırıldı — fazın anlamını sessizce geri alırdı.
`APP_COMMIT_SHA` için iki farklı fallback ("unknown" / "commit unknown") tek bir "unknown"a indirildi.

### Doğrulama sırasında yakalanan kendi regresyonum: dondurulmuş env bayrakları

`env.ts`'in ilk hâli **bütün** değerleri modül yüklenirken bir kez okuyup donduruyordu.
`db:transitions:verify` bunu 167/167'den **163/167**'ye düşürerek yakaladı: dört testin dördü de
`cookies was called outside a request scope` veriyordu. Sebep, yetki değil zamanlama —
`transitions-verify.ts:498` `MAS_QA_BYPASS_AUTH="1"`'i dynamic import'lardan **sonra**, yalnız tek
bir blok boyunca ayarlıyor (`try/finally` ile geri alıyor, script'in geri kalanı fail-closed kalsın
diye). Donmuş snapshot bu geçici açılışı görmüyordu.

Aynı hata ikinci bir yerde daha vardı ve **testler onu maskeledi**: `phase12a-verify.ts:17` ve
`phase14d-verify.ts:12`, `AI_FORCE_DETERMINISTIC="1"`'i modül gövdesinde ayarlıyor — oysa statik
import'lar gövdeden önce çalışır, yani `env.ts` çoktan donmuş olur. Bu iki faz yine de PASS verdi,
çünkü bu makinede `OPENAI_API_KEY` tanımsız ve `!apiKey` kontrolü zaten deterministik yola
düşürüyordu. `OPENAI_API_KEY`'in tanımlı olduğu bir makinede bu iki doğrulama **gerçek OpenAI
API'sine gidecekti**.

Düzeltme: `qaBypassAuth` ve `aiForceDeterministic` canlı getter'a çevrildi (diğer her şey
dondurulmuş kalır — onlar süreç iş yapmaya başlamadan önce sabitlenen değerler). Gerekçe env.ts'te
yorum olarak duruyor.

### Gate sonuçları (hepsi disposable DB üzerinde, `mas_radar_dev`'e dokunulmadan)

| Adım | Sonuç |
| --- | --- |
| `pnpm lint` | exit 0 (1 uyarı: `analytics-chart.tsx`, önceden var, dokunulmadı) |
| `pnpm typecheck` | exit 0 |
| `pnpm test` | 200/200, exit 0 |
| `pnpm db:verify` | ALL ASSERTIONS PASSED, exit 0 |
| `pnpm db:roles:verify` | 8/8 PASS, exit 0 |
| `pnpm import:real` | ALL PASS — 43 sekme / 9.817 hücre / 1.601 satır / 62 review |
| `phase3…phase14e:verify` (20 faz) | 20/20 PASS — her faz TAZE bir DB'de |
| `pnpm db:migrate:verify` | PASS |
| `pnpm db:constraints:verify` | PASS |
| `pnpm db:transitions:verify` | 167/167 PASS |
| `pnpm db:reconciliation:verify` | PASS |
| `pnpm db:legacy-repair:verify` | 183/183 PASS |
| `pnpm build` | exit 0 |

Faz zinciri gerçek üretim düzeniyle koşuldu: **aynı veritabanı, iki farklı rol** —
`DATABASE_URL`=`mas_radar_app`, `MIGRATION_DATABASE_URL`=owner.

Login yazma yolu ayrıca kanıtlandı (`users` SELECT/UPDATE, `sessions` INSERT/UPDATE düşük yetkili
rolle çalışıyor); tümü transaction içinde yapılıp geri alındı, hiçbir satır yazılmadı.

`mas_radar_dev` doğrulaması: şema **0034**'te (0035 uygulanmadı), `app_runtime` policy sayısı **0**,
payments=19 · checks=7 · loans=1 · cashflow_months=35 · users=12 — hepsi baseline ile birebir.

### Kullanıcı eylemi gereken tek adım

Doğrulama sırasında role geçici bir parola atandı; **oturum sonunda geri alındı** — `mas_radar_app`
şu an migration 0035'in tanımladığı hâlde, yani `NOLOGIN`. Disposable DB'ler (`mas_faz15`,
`mas_faz15_ph`) düşürüldü; kümede yalnız `mas_radar_dev`, `mas_radar_restored`,
`mas_radar_testsprite` kaldı. Kullanıcı kendi parolasını belirleyip `.env.local`'i güncellemelidir:

```bash
pnpm db:app-role:password     # MAS_RADAR_APP_DB_PASSWORD'den okur, yoksa maskeli sorar
# sonra .env.local: DATABASE_URL=postgres://mas_radar_app:<parola>@127.0.0.1:5432/mas_radar_dev
#                   MIGRATION_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/mas_radar_dev
pnpm db:migrate               # mas_radar_dev'e 0035'i uygular (bu oturumda UYGULANMADI)
pnpm db:roles:verify
```

**Önemli:** `mas_radar_dev` bu oturumda kasıtlı olarak hiç değiştirilmedi — şeması hâlâ 0034'te,
`app_runtime` policy'si yok. Doğrulamaların tamamı disposable DB'lerde yapıldı. Faz 15'in gerçek
ortamda etkinleşmesi yukarıdaki adımlara bağlıdır.

## Faz 16 — DONE (CI/CD, gözlemlenebilirlik, API/oturum güvenliği temeli)

Faz 15'in üzerine eklenir, hiçbir parçasını geri almaz. Düşük yetkili `mas_radar_app` rolü,
`MIGRATION_DATABASE_URL` ayrımı ve `db:roles:verify` aynen yerinde; CI bu ayrımı kendi de kurar.

### DOKUNULMAYAN dosyalar (bilinçli)

- **`src/lib/domain-error.ts`** — sınıfın kendisi değişmedi. Faz 16 yalnız onu *yakalayan* bir
  route-handler sarmalayıcısı ekledi. Kalan engine'lerin DomainError'a geçirilmesi Faz 18'in işi.
- **`src/app/(dashboard)/system/page.tsx`** — yapısı değişmedi; yalnızca başlığa
  `/system/diagnostics` bağlantısı eklendi. KPI rolü (uygulama/DB/sürüm/karar güveni) aynen duruyor.
  Tanılama, `system/security` ve `system/backup` gibi bağımsız bir alt sayfa olarak eklendi.
- **Mevcut `console.log`/`console.error` çağrıları** — yapılandırılmış log yalnız Faz 16'nın kendi
  kodunda kullanılıyor. Hepsini toplu değiştirmek büyük ve riskli bir diff olurdu; üstelik verify
  script'lerinin bir kısmı o çıktıyı ayrıştırıyor.
- **Mevcut route handler'ların toplu retrofit'i yapılmadı** — zarf yalnız `/api/facts`'e ve yeni
  eklenen `/ready`'ye uygulandı.

### /ready ile /health kasıtlı olarak FARKLI sinyaller

`/ready` hiçbir şeye dokunmaz, hep 200 döner — "süreç yaşıyor mu". `/health` `select 1` çalıştırır,
DB düşükse 503 — "trafik gönderilebilir mi / DBA çağrılmalı mı". Yeniden başlatma politikası
`/health`'e bağlanırsa PostgreSQL her hıçkırdığında sağlam uygulama yeniden başlatılır; ayrım tam
olarak bunu önlemek için. `src/middleware.ts` matcher'ına `ready` eklendi — eklenmeseydi izleme
aracı login sayfasını ölçüp "ayakta" derdi.

### Plandan sapma 1: rate limit route handler'da değil MIDDLEWARE'de

İlk uygulama limiti `/api/facts` route handler'ına koydu ve `phase16:verify` **429'u hiç göremedi**.
Sebep: middleware default-deny; kimliksiz istek route'a hiç ulaşmadan 307 ile login'e yönleniyor.
Limit middleware'e, cookie kontrolünden **önce** taşındı. Bu hem testi mümkün kıldı hem de daha
doğru davranış: sele verilecek cevap login'e yönlendirme değil, 429'dur. Route handler'daki ikinci
sayaç kaldırıldı — aynı bütçeyi iki kovaya bölmek limiti anlaşılmaz yapardı.

Middleware Edge runtime'da çalıştığı için `src/lib/rate-limit.ts` node API'si kullanmıyor
(`global` yerine `globalThis`), ve middleware `api-response.ts`/`logger.ts`'i **import edemez**
(ikisi de `process.stderr`'a uzanır) — 429 zarfı orada elle yazıldı, şekli `api-response.ts` ile
uyumlu tutuluyor.

### Plandan sapma 2: CSRF durum koduyla değil, framework'ün kendi kararıyla doğrulandı

Next 15'in server-action Origin/Host kontrolünü **varsaymadık, ölçtük** — ama bu üç deneme aldı:

1. Uydurma bir `Next-Action` id'siyle POST: iki Origin için de **404**. Next önce action'ı çözüyor,
   bulamayınca 404 dönüyor; test hiçbir şey kanıtlamıyordu.
2. Derleme çıktısındaki `server-reference-manifest.json`'dan **gerçek** action id okundu, ama
   `application/x-www-form-urlencoded` gövdeyle yine 404 — Next bir server action'ı ancak form
   (multipart) gövdesiyle tanıyor.
3. Multipart'la iki taraf da **500**. Durum kodu ayırt edici değil.

Kesin kanıt sunucu logunda çıktı:

```
`x-forwarded-host` header with value `127.0.0.1:3118` does not match `origin` header
with value `saldirgan.example` from a forwarded Server Actions request. Aborting the action.
⨯ [Error: Invalid Server Actions request.]
```

`phase16:verify` artık bunu ölçüyor: yabancı Origin'li istekten sonra sunucu logunda iptal izi
**oluşmalı**, aynı Origin'li istekten sonra **oluşmamalı**. Durum kodundan daha doğrudan kanıt.
Route handler'lar için ayrıca `checkOrigin()` yazıldı (şu an mutasyon yapan route handler yok;
birim testleri dört senaryoyu kapsıyor).

### CI kapsamı: 14 faz doğrulaması CI'da ÇALIŞAMAZ, sahte veriyle "çalıştırılmadı"

`data/` gitignore'da — gerçek çalışma kitapları özel finansal veri. Temiz bir checkout'ta
`import:real` ve ona bağlı 14 faz script'i (phase3…phase9d, phase12a, phase13a, phase14a)
kaynak dosyayı bulamaz. Bunları sahte bir fixture'la "geçirmek" mümkün değil: gerçek rakamları
iddia ediyorlar (43 sekme, 9.817 hücre, TİJEN −60.000). Uydurma veriyle geçen bir test, test değil.

CI bu yüzden veriden bağımsız olanları koşar: lint, typecheck, test, `db:verify`,
`db:migrate:verify`, ledger ile DB kurulumu, `db:app-role:password`, `db:roles:verify`,
6 faz doğrulaması (phase11b, 13b, 14b, 14c, 14d, 14e), `build`, `phase16:verify`.
Veriye bağlı 14'ü **yerel pre-merge kapısı** olarak kalır — bugünkü durumdan bir gerileme değil,
sadece artık yazılı.

### CI neden GitHub'ın `services:` Postgres'ini kullanmıyor

`scripts/db/ensure.ts` kendi `mas-radar-pg` container'ını `127.0.0.1:5432`'ye bağlayarak başlatır.
Bir `services:` container'ı o portu zaten tutardı; ikisi çakışır ve hangisi kazanırsa kazansın CI,
her yerel çalıştırmanın kullandığından **farklı** bir Postgres'i test etmiş olurdu. Kapıyı iki kez
çalıştırmanın tüm anlamı ikisinin aynı olması olduğu için `ensure.ts` CI'da da yerelde yaptığının
aynısını yapıyor. CI'da **hiçbir deploy adımı yok** — `docs/local-production-deploy.md` uzaktan
deploy'u kapsam dışı bırakıyor; CI yalnız pre-merge gate runner'dır.

CI'daki `CI_APP_DB_PASSWORD` bilerek açık yazılmıştır ve sır değildir: ait olduğu veritabanı
runner içinde sıfırdan yaratılıp runner'la birlikte yok olur. GitHub Secrets'a koymak, bir şeyi
koruduğu izlenimi verirdi.

**Bilinen sapma:** CI Node 22 (LTS) kullanıyor, geliştirici makinesi Node 26. Node sürümüne özgü
bir hata çıkarsa bakılacak ilk yer burasıdır.

### Oturum sertleştirme kanıtı (8/8)

Bu kontroller `phase16:verify`'a **konmadı**, çünkü kullanıcı ve oturum satırı yazıyorlar;
phase16:verify bir operatörün gerçek DB'ye karşı da çalıştırabileceği bir kapı olduğu için
salt-okunur kaldı. Disposable DB'de tek seferlik probla doğrulandı, prob dosyası silindi:

- taze oturum korumalı sayfaya erişir (200)
- 2 saat boşta kalan oturum reddedilir (307 → /login)
- boşta kalan oturum DB'de `revoked_at` ile **iptal edilir**, yalnızca görmezden gelinmez
- **mutlak 7 günlük `expires_at` DEĞİŞMEDİ** — boşta penceresi ona ek, yerine değil
- rol değişince hedefin tüm açık oturumları iptal edilir (açık oturum sayısı 0)
- iptal edilen oturum artık korumalı sayfaya erişemez
- iptal sayısı `audit_logs.after_data.sessions_revoked` olarak kaydedilir

`last_seen_at` NULL başladığı için boşta ölçümü `created_at`'e düşer; aksi halde yeni açılmış her
oturum epoch'tan ölçülüp anında öldürülürdü.

### Gate sonuçları

| Adım | Sonuç |
| --- | --- |
| `pnpm lint` | exit 0 (1 uyarı: `analytics-chart.tsx`, önceden var) |
| `pnpm typecheck` | exit 0 |
| `pnpm test` | 218/218 (200 mevcut + 18 yeni), exit 0 |
| `pnpm build` | exit 0 |
| `pnpm phase16:verify` | **18/18 PASS** |
| `pnpm db:roles:verify` | 8/8 PASS (Faz 15 gerilemedi) |
| `pnpm db:transitions:verify` | 167/167 PASS (auth.ts değişti, gerileme yok) |
| CI'ın koşacağı 6 faz doğrulaması | 6/6 PASS (her biri taze DB'de) |
| Oturum sertleştirme probu | 8/8 PASS |

Bir build hatası yaşandı ve **kod kaynaklı değildi**: webpack'in `WasmHash._updateWithBuffer`
çağrısında `Cannot read properties of undefined`. `.next` temizlenince geçti — bayat derleme
önbelleği. Makine boyunca boş bellek 0,4–0,6 GB civarındaydı (başka projelerin dev sunucuları
çalışıyor); bu tür hataları gerçek gerileme sanmamak gerekiyor.

Doğrulama sonrası ortam Faz 15'teki gibi geri alındı: disposable DB'ler düşürüldü,
`mas_radar_app` yeniden `NOLOGIN` (migration 0035'teki hâli). `mas_radar_dev` bu fazda da hiç
değiştirilmedi — şema hâlâ 0034, payments=19, users=12. Faz 15'in kullanıcı adımları
(`pnpm db:app-role:password` → `.env.local` → `pnpm db:migrate`) hâlâ bekliyor; Faz 16 kodu
onlardan bağımsız olarak derlenip test edildi.

---

## Faz 17 — DONE (para hassasiyeti: uçtan uca numeric katmanı)

Faz 15/16'nın hiçbir parçasını geri almaz. Bu faz **şema değiştirmedi, migration eklemedi** —
gerekmedi (aşağıdaki ilk başlık nedenini anlatıyor). Değişen şey yalnız SQL/JS sınırı.

### Planın iddiası doğrulandı, ama sayı ve kapsam düzeltildi

implementation.md §17 1d "141 adet `::float8`, 25 dosyada" diyordu. Bizzat sayıldı:

| Nerede | Bulunan | Ne yapıldı |
| --- | --- | --- |
| `src/**` (uygulama kodu) | **136 cast, 16 dosyada** | tamamı kaldırıldı |
| `scripts/**` (doğrulama oracle'ı) | **47 cast, 9 dosyada** | **bilinçli olarak ERTELENDİ** (aşağıda) |
| `supabase/migrations/**` | **0** float8/double precision/real kolon | doğrulandı, kontrol altına alındı |

Yani plandaki "141" `src` için 136, ve planın hiç saymadığı 47 cast daha doğrulama
script'lerinde duruyordu. Toplam 183. Bu, sayının eskimiş olmasından değil, `scripts/`in hiç
taranmamış olmasından kaynaklanıyor.

Şemaya dair iddia da doğrulandı: 41 tablonun tamamında para kolonları `numeric(p,s)`; tek bir
float8/double precision/real kolon yok. Yani risk gerçekten depoda değil, sınırdaydı.

### Ölçüldü, varsayılmadı: cast'i kaldırmak TEK BAŞINA yetmiyor

Tek kullanımlık DB'de (Postgres 16) ölçülen:

```
select (100000::numeric / 3::numeric)          -> "33333.333333333333"   (string, tam)
select (100000::numeric / 3::numeric)::float8  ->  33333.333333333336    (number, yanlış)
Number("33333.333333333333")                   ->  33333.333333333336    (aynı yanlış!)
```

Kritik bulgu: cast'i kaldırıp değeri düz `Number()` ile okumak **aynı hatayı** veriyor.
Bu yüzden faz yalnız "cast'leri sil" değil, "değeri decimal olarak taşı" olmak zorundaydı —
`src/lib/money.ts`'in var oluş sebebi bu.

### Kütüphane seçimi: big.js (decimal.js değil) — ölçümle

İkisi de Postgres numeric string'lerini doğru ayrıştırıyor (ölçüldü). Ayrım, sayı OLMAYAN
girdide ne yaptıkları:

| Girdi | decimal.js | big.js |
| --- | --- | --- |
| `NaN` | `NaN` (yayılır) | **fırlatır** |
| `Infinity` | `Infinity` (yayılır) | **fırlatır** |
| `1 / 0` | `Infinity` (yayılır) | **fırlatır** |

CLAUDE.md'nin ilk mali kuralı "null tutar bilinmeyendir, sıfır değildir". Sessizce yayılan bir
`NaN`, nakit akış toplamında "NaN TL" olarak görünen ya da daha kötüsü aşağıda bir yerde 0'a
çevrilen tam olarak o hata sınıfı. decimal.js'in IEEE benzeri NaN/Infinity semantiği bilimsel
hesap için doğru, para için yanlış. big.js hatayı bozulmanın olduğu yerde reddediyor.

İkincil gerekçeler: ~6KB'a karşı ~32KB; ve kod tabanında **sıfır** `pow`/`sqrt`/`ln`/`exp`
kullanımı var (grep ile doğrulandı — bütün `**` eşleşmeleri `/**` yorum açacıydı), yani
decimal.js'in kesirli üs ve transandantal fonksiyonları burada hiçbir şey satın almıyor. Kredi
matematiği bu depoda analitik bileşik faiz değil, kaynak-güdümlü mutabakat. İleride analitik
bileşiklendirme gerekirse seçim o zaman yeniden değerlendirilmeli, şimdiden değil.

`money.ts` global `Big`'i değil, **kendi yapıcısını** (`Big()`) kullanıyor: big.js DP/RM/strict
değerlerini yapıcı üzerinde değiştirilebilir statik olarak tutuyor, global olanı paylaşmak
herhangi bir bağımlılığın (ya da "burada 4 basamak lazım" diyen ileriki bir çağrı noktasının)
süreçteki bütün mali rakamların yuvarlamasını sessizce değiştirebilmesi demekti. Yalıtım
çalışma zamanında doğrulandı: sonradan `Big.DP` değiştirmek `MoneyBig.DP`'yi oynatmıyor.
`phase17:verify` bu yapıcının yerinde durduğunu kontrol ediyor.

### Yuvarlama: uygulama ile veritabanı artık AYNI cevabı veriyor

Postgres `round(numeric, n)` sıfırdan uzağa yarı-yukarı yuvarlar. JS `toFixed` ikili double'ı
yuvarladığı için sıradan değerlerde veritabanıyla **anlaşamıyor** (ölçüldü):

| Değer | `toFixed(2)` | pg `round(_,2)` | money.ts |
| --- | --- | --- | --- |
| 2.675 | `2.67` ✗ | 2.68 | `2.68` ✓ |
| 1.005 | `1.00` ✗ | 1.01 | `1.01` ✓ |
| 1262.145 | `1262.14` ✗ | 1262.15 | `1262.15` ✓ |
| 70.285 | `70.28` ✗ | 70.29 | `70.29` ✓ |

Dürüst not: `fmtTL` zaten `Intl.NumberFormat` kullanıyor ve o, decimal değeri doğru yuvarlıyor
— yani **ana TL gösterimi bu hatadan zaten etkilenmiyordu**. Hata `toFixed(2)` kullanılan
yerlerde gerçekti: TL/dk değerleri (`breakEven`, `finance_cost_per_minute`) ve
`reconcileLoan`'ın mutabakat mesajları.

### Dürüstlük notu: yüzde-üstü-yüzde her zaman kaymıyor

İlk ölçümde denenen dört `anapara × oran + BSMV + KKDF` vakasının **dördü de** float ile decimal
arasında aynı çıktı. Bu "sorun yok" demek değil, "o dördü şanslıydı" demek: 8 anapara × 8 oran
taranınca **30 vakada gerçek kayma** bulundu, ör.

```
1234567.89 × 0.0825 + %5 + %15   float 122222.22110999998   exact 122222.22111
987654.32  × 0.0349 + %5 + %15   float  41362.962921599996  exact  41362.9629216
```

`money.test.ts` bu vakaları, **float'ın yanlış değerini de assert ederek** tutuyor — yoksa V8
davranışı değiştiği gün test sessizce hiçbir şey kanıtlamamaya başlardı.

Yine dürüstlük: 2 basamağa yuvarlandığında bu kaymaların çoğu aynı stringe düşüyor, ve 36 aya
kadar bileşiklendirmede float ile decimal aynı sonucu verdi. Asıl ölçülebilir kazanç
**biriktirmede**: 20.000 satır × 0,07 float `+=` ile 1399.9999999999804, decimal ile tam 1400
(Postgres `sum()` de 1400.00 diyor). 1.000 satır × 33,33 → float 33330.00000000085.

### Tip yalanı: asıl tehlike cast değil, haritalanmamış satırdı

Bu fazın en riskli tarafı cast'leri silmek değildi. `radar/queries.ts`'te yedi fonksiyon
`return (...).rows` ile `Promise<InstanceRow[]>` döndürüyordu ve `InstanceRow.amount`
`number | null` diye ilan edilmişti. Cast kaldırılınca node-postgres **string** döndürür;
haritalama eklenmeseydi TypeScript sayıya inanmaya devam ederken çalışma zamanı string
taşıyacaktı — cast'ten çok daha sinsi bir hata. Aynı desen `external-assumptions`,
`scenarios`, `production`, `reports`, `data-quality` ve dört sayfa bileşeninde de vardı; hepsine
açık decode eklendi (`mapInstanceRow`, `mapAssumption`, satır-içi `.map()`'ler).

### Gerçekten bir hata düzeltildi: karışık `::numeric`/`::float8`

`radar/queries.ts`'in `paymentHistoryEvents`'i, `audit_events` CTE'sinde **aynı JSON alanını iki
farklı şekilde** okuyordu: `paid_amount` kolonu için `::float8`, `remaining_amount`
aritmetiğinin içinde `::numeric`. Yani iki kolon aynı değer hakkında farklı şey söyleyebiliyordu
ve `amount − paid_amount` her zaman bildirilen `remaining_amount`'a eşit olmuyordu. İkisi de
`numeric` yapıldı. Bu, planın "karışık satır" dediği şeyin gerçekte ne olduğu.

### Kapsam kararı: doğrulama script'leri BİLİNÇLİ olarak ertelendi

`scripts/**`'daki 47 cast'e **dokunulmadı**, ve bu bir ihmal değil bir gerekçe:

Bu script'ler uygulamanın rakamlarının kaynak çalışma kitabıyla hâlâ eşleştiğini kanıtlayan
**bağımsız oracle**. Kontrol ettikleri kodu değiştiren commit'te onları da değiştirmek,
**cetveli ve ölçülen nesneyi birlikte değiştirmek** olurdu — iki tarafta birbirini götüren bir
hata görünmez hale gelirdi. Mevcut float8 yollarında bırakıldılar ki Faz 17 gate'leri yeni
uygulamayı **DEĞİŞMEMİŞ** bir referansa karşı ölçsün. Nitekim 20 faz doğrulamasının tamamı
gerçek veriyle, değişmemiş oracle'a karşı geçti — Faz 17'nin hiçbir mali çıktıyı
değiştirmediğinin asıl kanıtı bu.

`phase17:verify` bu yüzden üç farklı standart uyguluyor: `src/` sıfır tolerans,
`supabase/` sıfır float8 kolon, `scripts/` **sabitlenmiş sayım** (yeni cast eklenemez, mevcut
47 kayıtlı). Sayım düşerse script uyarı basıp baseline'ın güncellenmesini istiyor. Migrasyonu
Faz 17B yapmalı.

### `pg` tip ayrıştırıcısı EKLENMEDİ (plandaki isteğe bağlı madde)

Plan `numeric` OID'i için global bir `setTypeParser` öneriyordu. Yapılmadı, çünkü bu, her
`numeric` kolonun tipini tek hamlede **her tüketici için** değiştirirdi — üstelik depoda zaten
cast'siz `numeric` okuyup kendi `Number()`'ını çağıran yerler var (`radar/engine.ts:394,396,776`,
`users/engine.ts:76`, `analytics/snapshots.ts`). Bunlar çağrı noktası başına gözden geçirilmeden
sessizce davranış değiştirirdi; bu fazın disiplininin tam tersi. Decode, her çağrı noktasında
açık.

### DOKUNULMAYAN dosyalar (bilinçli)

- **`scripts/phase{4,5,6,7,8,9b,9d,13a}-verify.ts`, `scripts/seed-demo.ts`** — yukarıdaki
  oracle gerekçesi.
- **`src/lib/financing/rules.ts`, `production/rules.ts`, `reports/rules.ts`** — `+=` ile
  biriktiren fonksiyonları (`groupMaturities`, `maturityWindows`, `exposureBy`) DURUYOR.
  Yalnız `radar/rules.ts`'in `concentration`'ı decimal'e taşındı, çünkü doğrudan bu fazda
  taşınan sorgulardan besleniyor ve **%40 eşiğiyle karşılaştırma** yapıyor — yuvarlama hatasının
  gösterilen rakamı değil, VERİLEN CEVABI değiştirdiği tek yer sınıfı. Kalan biriktiricilerin
  taşınması ayrı ve gözden geçirilebilir bir dilim olmalı.
- **`fmtTL` / `Intl.NumberFormat` çağrıları** — zaten doğru yuvarlıyorlar (yukarıda ölçüldü),
  toptan değiştirmek gereksiz büyük bir diff olurdu.
- **`src/lib/domain-error.ts`, 13 `audit()` kopyası** — Faz 18'in işi, bu fazda dokunulmadı.

### `numeric(14,2)` float64'e sığıyor mu? — evet, ve bu kayıt altında

Money yardımcıları decimal olarak ayrıştırıp **bir kez** TL ölçeğinde yuvarlıyor ve sonra
`number` döndürüyor. Bu güvenli: `numeric(14,2)` en fazla 10^14 kuruş, float64'ün tam tamsayı
aralığı 2^53 ≈ 9,0×10^15. Yani sınır 90 trilyon TL civarında — MAS'ın ölçeğinin çok üstünde.
Bu bir gün aşılırsa dönüş tipleri `Decimal` yapılmalı. Oranlar `RATE_DP = 10` ile yuvarlanıyor
(şemadaki en geniş oran ölçeği `numeric(18,6)`), yani oran hassasiyeti de kaybolmuyor.

### Gate sonuçları

| Adım | Sonuç |
| --- | --- |
| `pnpm lint` | exit 0 (1 uyarı: `analytics-chart.tsx`, önceden var) |
| `pnpm typecheck` | exit 0 |
| `pnpm test` | **265/265** (218 mevcut + 47 yeni money testi), exit 0 |
| `pnpm db:verify` | ALL ASSERTIONS PASSED (27 invariant) |
| `pnpm db:roles:verify` | **8/8** (Faz 15 gerilemedi) |
| `db:transitions:verify` | 167/167 |
| `db:constraints:verify` | 38/38 |
| `db:reconciliation:verify` | 77/77 |
| `pnpm import:real` | ALL PASS (43 sekme, 9.817 hücre, TİJEN −60.000, kimlik uyuşmazlığı 0) |
| phase3…phase9d (7 script) | 7/7 PASS |
| phase9a…phase14e (13 script) | 13/13 PASS |
| `pnpm build` | exit 0 |
| `pnpm phase16:verify` | **18/18** (Faz 16 gerilemedi) |
| `pnpm phase17:verify` | **10/10 PASS** |

`db:roles:verify` ilk çalıştırmada 7/8 verdi: "users satırları RLS üzerinden görünüyor" kontrolü
0 satır gördü. Gerileme DEĞİLDİ — kontrolün kendi mesajının söylediği ikinci ihtimaldi, taze
`mas_radar_verify` veritabanında hiç kullanıcı seed'lenmemişti. `seed-system-actor` çalıştırılınca
8/8. Bu, kontrolün hata mesajını iyi yazmanın karşılığı.

`pnpm test` bir çalıştırmada 215/218 gösterdi: `previews.test.tsx` için vitest worker'ı
başlatılamadı ("Timeout waiting for worker to respond"). Kod kaynaklı değil — dosya tek başına
koşturulunca 3/3 geçiyor ve sonraki tam çalıştırmada 20/20 dosya sorunsuz koştu. Faz 16'nın
kaydettiği bellek baskısıyla aynı sınıf (`WasmHash` build hatası) — bu tür şeyleri gerileme
sanmamak gerekiyor.

### Doğrulama sonrası ortam

Faz 15/16'daki gibi geri alındı: `mas_radar_verify` ve `mas_radar_money_probe` düşürüldü,
`mas_radar_app` yeniden `NOLOGIN` (migration 0035'teki hâli), ölçüm prob dosyaları silindi.
**`mas_radar_dev` bu fazda da hiç değiştirilmedi** — şema hâlâ 0034, payments=19, users=12
(commit öncesi teyit edildi). Faz 15'in kullanıcı adımları
(`pnpm db:app-role:password` → `.env.local` → `pnpm db:migrate`) hâlâ bekliyor.

### Faz 18'e devredilen açık nokta

`scripts/**`'daki 47 cast (Faz 17B) ve `financing/rules.ts` + `production/rules.ts`'teki
`+=` biriktiricileri. İkisi de `phase17:verify` tarafından kayıt altında; sessizce büyüyemezler.

---

## Faz 18 — DONE (paylaşılan `audit()` / `DomainError` / Zod sınırı + şema dokümanı yenilemesi)

Faz 15/16/17'nin hiçbir parçasını geri almaz. **Şema değişmedi, migration eklenmedi** — bu faz
tamamen uygulama katmanı. Riskli taraf da buydu: on üç `audit()` kopyasını birleştirmek, mali
denetim izini yazan kodun tamamına dokunmak demek.

### Plandaki sayı doğruydu ama EKSİKTİ: 13 değil 16 dosya

`grep` ile bizzat sayıldı:

| Ne | Bulunan |
| --- | --- |
| Yerel `audit()` yardımcısı | **13** — planın saydığı 13'ün aynısı (ai, analytics/snapshots, archive, cashflow, data-quality, external-assumptions, financing, payments, production, radar, reports, scenarios, users) |
| Yardımcısı OLMAYAN, satır içi `insert into public.audit_logs` yazan server action | **3** — `finance/actions.ts` (2 adet), `payments/actions.ts`, `imports/actions.ts` |
| **Toplam insert ifadesi** | **18, 16 dosyada** |

Plan yalnız yardımcıları saymıştı; ama gate "audit.ts dışında hiçbir yerde
`insert into public.audit_logs` olmayacak" dediği için üç action dosyasının da taşınması
zorunluydu. Hepsi taşındı; `pnpm phase18:verify` artık sıfır tolerans uyguluyor.

### Kanonik imza: radar taban alındı ama KONUMSAL DEĞİL

Plan `radar/engine.ts`'in imzasını taban öneriyordu ve bu doğruydu — on üçü arasında tek
eksiksiz olan oydu: `actor` nullable, `entityTable` parametre, hem `before` hem `after`,
legacy-repair için opsiyonel `createdAt` override'ı, ve eklenen satırın id'sini döndürüyor.

Ama imzanın **konumsal şekli** kopyalanmadı, çünkü eski kodun en kötü özelliği tam olarak oydu:

```
payments/engine.ts    audit(client, actor, action, entityTable, entityId, before, after)
financing/engine.ts   audit(client, actor, action, entityTable, entityId, after, before?)
                                                                          ^^^^^  ^^^^^^
```

**Aynı depoda iki yardımcı, `before`/`after`'ı TERS sırada alıyordu.** Kopyala-yapıştır bir
çağrının yeni değeri eski değer olarak kaydetmesini engelleyen tek şey dikkatti. Kanonik API
adlandırılmış alanlı bir nesne alıyor (`audit(client, { actor, action, entityTable, entityId,
before, after, createdAt })`), böylece bu hata **temsil edilemez** hale geliyor. Bu fazın
diff'e değmesinin asıl sebebi bu; `phase18:verify` nesne imzasının konumsala geri dönmediğini
de kontrol ediyor.

Taşıma sırasında financing'in iki settlement çağrısı ayrı ayrı elle doğrulandı: 6. konumsal
argüman `after`, 7. `before` idi (`currentStatus` güncellemeden ÖNCE okunan statü). Yeni
çağrılarda alanlar bu anlamla eşleştirildi ve çağrı noktalarına yorum düşüldü.

### Kapsam disiplini: NE yazıldığı değil, NEREDE yazıldığı değişti

Her çağrı noktası alan-alan taşındı: tablosunu sabit yazan bir yardımcı artık aynı literali
parametre olarak geçiyor, `before`'ı hep null yazan biri hâlâ `before` geçmiyor, JSON kodlaması
(`JSON.stringify(x ?? null)`) birebir aynı. 46 yardımcı çağrısı + 4 satır içi insert = 50 nokta.

**Tek bilinçli normalleştirme, ölçülerek zararsız bulundu.** Üç server action `before_data`'yı
ya hiç yazmıyor ya da SQL `null` geçiyordu (→ SQL NULL); `audit()` ise diğer 13 yardımcı gibi
jsonb `'null'` yazıyor. Fark yalnız depolama seviyesinde:

- `system/audit/page.tsx` `x.before_data == null ? "—" : …` diyor. node-postgres **hem** SQL
  NULL'ı **hem** jsonb `'null'`'ı JS `null` olarak veriyor — bizzat ölçüldü:
  `select null::jsonb, 'null'::jsonb` → ikisi de `js=null, ==null:true`. İkisi de "—" basıyor.
- `radar/queries.ts`'in `before_data->>'status'` okuması her iki biçimde de SQL NULL veriyor.
- Doğrulama script'lerinin hiçbiri ayrımı kullanmıyor.

Yani okuyan hiç kimse farkı göremiyor, ve tablo artık tek biçimli (gerçek veriyle dolu
doğrulama DB'sinde 378 satırın 378'i jsonb `'null'`, 0 SQL NULL).

### Yol boyunca bulunan gerçek bir sızıntı: ham `ZodError.message`

`radar/engine.ts:111` şunu yapıyordu:

```ts
throw new DomainError(`… geçersiz input — ${parsed.error.message}`);
```

Zod v4'te `ZodError.message` **ham issue dizisinin JSON dökümüdür** (ölçüldü):
`[{ "origin": "string", "code": "invalid_format", "format": "uuid", "path": ["id"], … }]`.
Ve Faz 16'dan beri `api-response.ts` bir DomainError'ın mesajını **istemciye aynen geçiriyor**
(diğer her şey jenerik 500). Yani iç doğrulama yapısı dışarıya açılabiliyordu.
`formatIssues()` aynı hatayı tek okunur satıra indiriyor; `phase18:verify` bu kalıbın geri
gelmediğini kontrol ediyor.

### Zod sınırı: `src/lib/validation/` gerçek bir sınır oldu

Önce yalnız 6 satırlık `financial.ts` vardı. Eklenen `index.ts`:

- `parseOrThrow(schema, value, label)` → başarısızlıkta **DomainError** (düz `Error` değil:
  geçersiz form girdisi BEKLENEN bir hatadır ve operatöre gösterilmelidir; düz Error jenerik
  "beklenmeyen hata"ya düşer ve "vade tarihi zorunlu"yu gizlerdi).
- `formatIssues(error)` → `alan: mesaj; alan: mesaj` — kod/origin/expected iç yapısı yok.
- `parseOrIssues(...)` → fırlatmayan varyant.
- `formObject(formData)` → tekrar eden anahtarları **diziye** topluyor (`Object.fromEntries`
  sonuncusu hariç hepsini sessizce düşürür — çoklu seçimde gerçek bir tuzak), `File` girdilerini
  atıyor, boş string'i koruyor ("operatör alanı temizledi" ile "alan gönderilmedi" farklı
  ifadelerdir).

**Kural bu fazdan itibaren YENİ kod için zorunlu**, mevcut action'lar bilinçli olarak
retrofit EDİLMEDİ (aşağıda).

### DOKUNULMAYANLAR (bilinçli)

- **Mevcut server action'ların form ayrıştırması.** Bugün hâlâ `String(formData.get("x") ?? "")`
  ve elle `Number()` kullanıyorlar. On üç audit yardımcısını birleştirirken aynı anda her form
  ayrıştırmasını da yeniden yazmak, iki değişikliği de gözden geçirilemez yapardı. Yardımcı
  artık var; sırada yazılacak şeyin gidecek doğru bir yeri var.
- **`DomainError` sınıfının kendisi** (tek satır) — değişmedi. Mevcut kodun toptan
  DomainError'a geçirilmesi plan gereği kapsam dışı; yalnız audit taşımasında dokunulan
  `radar/engine.ts`'in sızıntısı düzeltildi.
- **`scripts/db/constraints-verify.ts`'in doğrudan insert'i** — 0022'nin append-only
  trigger'ını kanıtlayan sonda. `audit()`'ten geçirmek constraint'i değil yardımcıyı test
  etmek olurdu. `phase18:verify`'da gerekçeli izin listesinde, sayımı sabit.
- **`finance/actions.ts`'in ATOMIK OLMAYAN audit yazımı.** `createCheckAction` çeki ve denetim
  satırını iki ayrı `pool.query` ile, transaction DIŞINDA yazıyor — yani çek yaratılıp denetim
  satırı yazılmayabilir. `audit()` bu yüzden `Pool | PoolClient` kabul ediyor: bu fazın kuralı
  "her çağrı noktasının davranışını birebir koru" idi ve 16 dosyalık bir refactor'ın içinde
  sessizce transaction semantiği değiştirmek doğru olmazdı. **Gerçek bir açık, ayrı bir dilimde
  kapatılmalı** (`createLoanAction` zaten transaction içinde — desen orada doğru).

### Şema dokümanı ~0021'den 0035'e getirildi

`docs/database-schema.md` gerçekten geride kalmıştı: 0022, 0031, 0035 anılıyordu ama
0023-0030 ve 0032-0034 hiç yoktu (11 migration). `phase18:verify` bunu **kendisi yakaladı** —
kontrol yazıldıktan sonra ilk çalıştırmada 11/12 verip eksikleri tek tek listeledi.

Eklenen bölüm konu bazlı: denetim izi dokunulmazlığı (0022), arşiv yaşam döngüsü (0023/0024),
ödeme kalemi alan tutarlılığı (0025/0028/0029), iptal meta verisi (0026/0030), statü geçiş
guard'ları (0027/0033/0034) ve kimlik/aktör (0031/0032). Guard bölümü bu deponun en pahalı
dersini açıkça yazıyor: 0027'nin izin listeleri eksik çıktı, 7/7 çek ve 48/48 taksit
`planned`de sıkıştı, `paid_count` KPI'ı Faz 5'ten beri 0 döndürdü, ve kısmi ödeme **hiç**
kaydedilemedi — 0033/0034'e kadar.

Ayrıca **"yeni tablo eklerken checklist"** eklendi (RLS politikası · EKSİKSİZ transition guard ·
`audit()` çağrısı, mutasyonla aynı transaction'da · migration ledger/idempotency, VALIDATE ayrı
dilim · Zod sınırı). Beş madde de bu şemanın geçmişte gerçekten kırıldığı beş yer.
`phase18:verify` belgenin en son migration'ı ve 0022+ aralığının tamamını andığını sürekli
kontrol ediyor, böylece bir daha sessizce geride kalamaz.

### Gate sonuçları

| Adım | Sonuç |
| --- | --- |
| `pnpm lint` | exit 0 (1 uyarı: `analytics-chart.tsx`, önceden var) |
| `pnpm typecheck` | exit 0 |
| `pnpm test` | **292/292** (265 mevcut + 27 yeni: 12 audit, 15 validation) |
| `pnpm db:verify` | ALL ASSERTIONS PASSED |
| `pnpm db:roles:verify` | **8/8** (Faz 15 gerilemedi) |
| `db:transitions:verify` | **167/167** — taşınan cancel/settlement audit yollarını koşan gate |
| `db:constraints:verify` | 38/38 |
| `db:reconciliation:verify` | 77/77 |
| `db:legacy-repair:verify` | **183/183** — `createdAt` override'ını ve dönen id'yi koşan gate |
| `pnpm import:real` | ALL PASS (43 sekme, 9.817 hücre, TİJEN −60.000) |
| phase3…phase14e (20 script) | 20/20 PASS |
| `pnpm build` | exit 0 |
| `pnpm phase16:verify` | **18/18** (Faz 16 gerilemedi) |
| `pnpm phase17:verify` | **10/10** (Faz 17 gerilemedi) |
| `pnpm phase18:verify` | **12/12 PASS** |

Refactor'ın davranışsal kanıtı `transitions` (167/167) ve `legacy-repair` (183/183): ikisi de
denetim satırı yazan yolları gerçek bir veritabanına karşı koşuyor, ve legacy-repair
`createdAt` override'ı ile dönen audit id'sini birebir doğruluyor. Ayrıca gerçek veriyle dolu
doğrulama DB'sinde 378 audit satırı `action`/`entity_table`/`before`/`after` dolulukları
bakımından tek tek gözden geçirildi.

`audit.test.ts` bilerek sahte bir client'a karşı SQL ve **bind parametre dizisini** assert
ediyor, veritabanına gitmiyor: burada gerileyebilecek şey adlandırılmış alanların konumsal
parametrelere eşlenmesi, ve gerçek bir veritabanı bunu YAKALAYAMAZ — her kolon nullable jsonb,
`before` ile `after`'ı takas etmek kusursuz geçerli ama yanlış bir satır üretir.

### Doğrulama sonrası ortam

`mas_radar_verify` düşürüldü, `mas_radar_app` yeniden `NOLOGIN` (0035'teki hâli), geçici prob
dosyaları silindi. **`mas_radar_dev` bu fazda da hiç değiştirilmedi** — şema 0034, payments=19,
users=12 (commit öncesi teyit edildi).

### Faz 19'a devredilen açık noktalar

1. **`finance/actions.ts:createCheckAction` audit'i transaction dışında** — çek yaratılıp
   denetim satırı yazılmayabilir. Küçük ve tek başına gözden geçirilebilir bir düzeltme.
2. **Mevcut server action'ların Zod'a geçirilmesi** — yardımcı hazır, retrofit yapılmadı.
3. Faz 17'den devam: `scripts/**`'daki 47 `::float8` (Faz 17B) ve `financing/rules.ts` +
   `production/rules.ts`'teki `+=` biriktiricileri.

---

## Faz 19 — DONE (karşı taraf / cari hesap ve organizasyonel boyutlar çekirdek veri modeli)

Faz 15-18'den **kategori olarak farklı**: bu depoda ilk kez yeni tablo ve migration eklendi
(0036-0039). Dört migration, sekiz tablo, dört view. **Gerçek `mas_radar_dev`'e UYGULANMADI** —
aşağıda.

### FK grafiği önce ÖLÇÜLDÜ, sonra tasarlandı

Plan "checks/loans/payments'taki payee/payer/bank_party_id" diyordu — üç FK. Taze migre edilmiş
bir veritabanına `information_schema` sorgusu atıldı ve gerçek grafik **6 tabloda 8 FK** çıktı:

```
cash_accounts.provider_party_id   cashflow_lines.party_id
checks.payee_party_id             checks.payer_party_id      checks.bank_party_id
loans.lender_party_id             payments.owner_party_id    payments.provider_party_id
```

Hepsi `NO ACTION`. Yani `parties`, şemanın en çok referans verilen tablosu ve yeniden
şekillendirilmesi en riskli olanı. Bu yüzden Faz 19 `parties`'e **hiç dokunmadı**: ne kolon
ekledi, ne yeniden adlandırdı, ne anahtarını değiştirdi. Tüm detay 1:1 sidecar olarak asıldı.
`phase19:verify` bu sekizinin her koşuda hâlâ yerinde olduğunu kontrol ediyor (şu an 12 FK:
8 eski + 4 Faz 19).

### 0036 — counterparty_profiles

1:1 **yapısal olarak** zorlanıyor: `party_id` birincil anahtar, ikinci profil ifade edilemez.
`ON DELETE CASCADE` bir gevşetme değil — 8 FK'nın hepsi `NO ACTION` olduğu için mali kaydı olan
parti zaten silinemiyor; cascade yalnız hiç geçmişi olmayan parti için çalışıyor.

Vergi no/dairesinde **format doğrulaması yok** (yabancı karşı taraf, boşluk, yazım hatası
korunup işaretlenir — reddedilmez); yalnız "boşluktan ibaret" reddediliyor. `credit_limit`:
sıfır **gerçek bir değer** ("peşin"), null "limit kaydedilmemiş" — `constraints-verify` ikisini
ayrı ayrı test ediyor.

### 0037 — ibans + salt-ekleme değişiklik geçmişi

Neden yalnız bu tabloya geçmiş: IBAN değişikliği bu uygulamadaki **en yüksek sonuçlu düzenleme**
— parayı sessizce başka hesaba yönlendirir, klasik fatura dolandırıcılığı vektörü. Diğer her alan
kaynak kitaptan yeniden kurulabilir; yanlış hesaba giden ödeme kurulamaz.

- `iban_normalized` **generated column**; uniqueness onun üzerinde. TS'teki `normalizeIban()`
  birebir aynı olmak zorunda — `phase19:verify` ikisini karşılaştırıyor. Sapsalardı uygulama,
  index'in reddedeceği bir IBAN'ı kaydetmeyi teklif ederdi.
- **Uniqueness parti-kapsamlı, global DEĞİL.** `parties` (normalized_name, party_type) üzerinden
  unique olduğu için aynı firma bir kez `customer` bir kez `vendor` olarak var olabilir ve aynı
  IBAN'ı taşır; global unique bu **doğru** durumu ifade edilemez kılar ve dürüst bir içe
  aktarmayı başarısız ederdi. Farklı karşı taraflarda aynı IBAN bir sinyaldir → 0039'un
  `iban_shared_across_parties` view'i raporluyor.
- `iban_change_events` 0022'nin `audit_logs` deseniyle salt-ekleme: REVOKE savunma derinliği,
  asıl zorlayıcı BEFORE trigger'ları, **superuser dahil** reddediyor.
- `iban_id`/`party_id` **kasıtlı olarak FK DEĞİL**: satır, tarif ettiği IBAN'dan uzun yaşamalı.
  CASCADE olsaydı saklanmaya en değer olay olan silme, kanıtını tam da ilginçleştiği anda
  silerdi. Disposable DB'de doğrulandı: IBAN silindi, `deleted` olayı kaldı.
- **audit_logs'un yerini almaz.** Engine ayrıca Faz 18'in `audit()`'ini çağırıyor. `audit_logs`
  "hangi operatör ne yaptı" (uygulama yazar); `iban_change_events` "bu IBAN ne dedi" (veritabanı
  yazar — değişiklik uygulamadan mı, script'ten mi, psql'den mi geldiğine bakmadan).

### 0038 — beş referans tablosu, gerçekten minimal

`cost_centers`, `departments`, `projects`, `products`, `orders` — yalnız kod/ad/aktiflik +
opsiyonel karşı taraf bağı. Tahsis mantığı, sipariş yaşam döngüsü, satır kalemi, tutar **hiç
eklenmedi** (var-ama-kullanılmıyor değil): boş bir kolon ikinci ve çelişkili bir gerçek kaynağı
davet eder. §3 açık soru #9'un cevabı bu.

### §17 kural 3 (transition guard) neden N/A — ve bunun kanıtlanması

Faz 19'un hiçbir tablosunda `status` enum'u **yok**; yalnız `is_active` boolean'ları var ve
boolean'ın kısıtlanacak geçişi yoktur. Bu kuraldan kaçış değil, kurala uyum: 0027 üç eksik izin
listesiyle çıktı ve 7/7 çeki, 48/48 taksiti sekiz migration boyunca `planned`de kilitledi. Yarım
tasarlanmış bir yaşam döngüsünü kötü korumaktansa hiç eklememek doğru olan. Sipariş yaşam
döngüsü gerçekten gerektiğinde guard'ıyla aynı migration'da gelir.

**İddia kontrol ediliyor:** `phase19:verify` yeni tabloların hepsinde `status`/`state`/`lifecycle`
kolonu arıyor ve bulmamayı şart koşuyor. Bir sonraki faz sessizce bir statü kolonu eklerse gate
düşer.

### 0039 — dört VIEW, kalıcı kolon yok

`counterparty_exposure` materialized bile değil: ikinci bir gerçek kaynak sessizce bayatlar ve bu
şemada zaten yaşanmış bir yara var (0034 öncesi `paid_count` KPI'ı Faz 5'ten beri 0 dönüyordu).
Tek operatörlü bir panelde birkaç bin satır için yeniden hesaplama maliyeti yok; matview
bayatlığı geri getirir + kimsenin hatırlamayacağı bir refresh takvimi ekler.

Doğrulanan davranışlar (gerçek veriyle dolu disposable DB'de):
- **Bilinmeyen tutar SAYILIR, sıfır olarak toplanmaz.** Bir çekin tutarı null yapıldı →
  `item_count` 4'te kaldı, `unknown_amount_count` 1 oldu, `total_exposure` 400.000→300.000
  düştü. Üç tutarsız çeki olan karşı taraf "sıfır risk" okunmuyor.
- `exposure_ratio` / `credit_limit_utilization` bölecek bir şey yoksa **null**, sıfır değil
  (money.ts'in `ratioOrNull`'ıyla aynı ayrım). Sıfır limit ise gerçek değer: aşım işaretleniyor
  ama bölme yapılmıyor.
- Çek ataması payee/payer üzerinden, **banka üzerinden değil** — `bank_party_id` "hangi bankaya
  keşide" demek ve katılsaydı bankanın riskini çok abartırdı.

### Geri-doldurma kararı: YAPILMADI, ve karar veriye dayandırıldı

Kural: içe aktarma bir ismi çözemezse ham metni saklar, FK'yı boş bırakır
(`partyIdByName`: "Never creates parties silently"). Faz 19 bu satırları geri **doldurmadı** —
serbest metni bir karşı tarafa eşlemek bir yargıdır, CLAUDE.md yargıyı incelenmiş insan eylemine
ayırır.

Gerçek veritabanında **salt-okunur** ölçüldü:

| | Sonuç |
| --- | --- |
| checks | 7 satır, **7'si zaten bir partiye çözülmüş**, **0'ı çözümsüz etiket taşıyor** |
| loans | 1 satır, `lender_party_id` **null** |
| parties | 16 |

Üstelik introspection ile doğrulandı: **`loans`'ta `counterparty_label` kolonu YOK** — yalnız
`checks`'te var. Planın "çekler/krediler ham counterparty_label tutuyor" ifadesi yarı doğru.
Kredinin karşı tarafı ancak `loans.name`'den, yani **kredinin kendi adından** tahmin edilebilirdi
ki bu tam da kuralın yasakladığı çıkarım.

Yani reddedilen geri-doldurma bugün `checks`'te **zaten hiçbir şeye dokunmayacaktı** ve
`loans`'ta **dokunamazdı**. Karar prensipten değil, ölçümle desteklenerek verildi.

Yerine eklenen: `counterparty_unresolved` view'i + `/finance/counterparties` sayfasında bigram
benzerliğiyle **sıralanan ama asla otomatik bağlanmayan** öneri listesi.
`suggestCounterparties()`'in dönüş tipinde bilerek `autoLinkable` benzeri bir alan **yok** — bir
sonraki çağıranın "izin" sanabileceği alan bırakılmadı; birim testi bunu da kontrol ediyor.
Eşleştirme yapıldığında `counterparty_label` **SİLİNMİYOR**: ham metin kaynak kanıtı, çözülen FK
onun üzerine eklenen yorum. Audit satırı `counterparty_label_preserved` alanıyla bunu açıkça
kaydediyor.

### Gate yazarken bulunan iki gerçek hata (ikisi de kendi kontrollerimde)

1. **Satır-seviyesi trigger boş tabloda ateşlenmez.** İlk append-only sondası, IBAN'ı hiç
   olmayan taze bir DB'de `iban_change_events`'e UPDATE/DELETE denedi ve **sahte PASS** verdi —
   satır yoksa BEFORE ROW trigger'ı hiç çalışmıyor. (TRUNCATE statement-seviyesi olduğu için
   üçünden yalnız ikisi etkilenmişti.) Sonda artık önce bir olay yaratıyor, sonra reddi ölçüyor,
   ve tamamı geri alınan bir transaction içinde çalışıyor.
2. **`git ls-files` yeni dosyayı görmez.** Aynı tuzak Faz 18'in gate'inde de vardı ve Faz 19
   ortaya çıkardı: `phase18:verify`'ın şema-belgesi kontrolü yalnız *tracked* migration'ları
   sayıyordu, bu yüzden 0036-0039 henüz commit'lenmemişken "en son migration 0035" deyip
   **memnuniyetle geçiyordu**. Düzeltildi (`--others --exclude-standard`); artık 39 migration
   görüyor ve 0022-0039'un tamamının belgede anıldığını şart koşuyor. Faz 18'in gate'i bu fazda
   gerçekten güçlendi.

Ayrıca `phase19:verify`'da "audit'siz parti yaratılmamış" şeklindeki **veri-şekilli** bir kontrol
denendi ve **atıldı**: ledger zaman damgalarına ve hangi seed'in yüklü olduğuna bağlı olduğu için
seeded disposable DB ile gerçek DB'de farklı rapor veriyordu. Yerine yapısal ve kesin olan kondu:
`src/` içinde `insert into public.parties` **tam olarak bir** dosyada — açık operatör eyleminde.
Kurt masalı anlatan bir kontrol, kontrolsüzlükten kötüdür.

### Migration ledger disiplini

- **`ANCHORS`'a EKLEME YAPILMADI** (`git diff scripts/db/migrate.ts` boş). O dizi yalnız
  0001-0019 legacy tespiti için; ötesine eklemek allPass/allFail mantığını bozup gerçek bir
  legacy DB'de `INCONSISTENT_PARTIAL` hard-fail üretirdi (Faz 15'te bizzat doğrulanmıştı).
- Dört migration da **idempotent** (`if not exists` / `create or replace` / policy-varlık
  kontrolü) — hepsi arka arkaya iki kez çalıştırılıp doğrulandı, `LEDGER_EMPTY_RECOVERY` şartı.
- `db:migrate:verify` **49/49**: ledger artık 39 satır görüyor, checksum sürüklenmesi hard-fail
  ediyor, LEDGER_EMPTY_RECOVERY doğru state'i seçiyor.
- Her yeni tabloda **RLS açıkça** açıldı + policy yazıldı (0035'in ALTER DEFAULT PRIVILEGES'ine
  güvenilmedi): grant ayrı şey, RLS ayrı şey — belgede kayıtlı olan 11 tablolu boşluk tam da bu
  karışıklıktan doğmuştu.

### Gate sonuçları

| Adım | Sonuç |
| --- | --- |
| `pnpm lint` | exit 0 (1 uyarı: `analytics-chart.tsx`, önceden var) |
| `pnpm typecheck` | exit 0 |
| `pnpm test` | **323/323** (292 mevcut + 31 yeni counterparty kuralı) |
| `pnpm db:verify` | ALL ASSERTIONS PASSED |
| `db:migrate:verify` | **49/49** (ledger 39 migration) |
| `db:constraints:verify` | **54/54** (38 mevcut + **16 yeni Faz 19 FK/CHECK**) |
| `db:transitions:verify` | 167/167 |
| `db:reconciliation:verify` | 77/77 |
| `db:legacy-repair:verify` | 183/183 |
| `pnpm db:roles:verify` | **8/8** (Faz 15 gerilemedi) |
| `pnpm import:real` | ALL PASS (43 sekme, 9.817 hücre, TİJEN −60.000) |
| phase3…phase14e (20 script) | 20/20 PASS |
| `pnpm build` | exit 0 |
| `pnpm phase16:verify` | **18/18** |
| `pnpm phase17:verify` | **10/10** |
| `pnpm phase18:verify` | **12/12** (artık 0039'a kadar kontrol ediyor) |
| `pnpm phase19:verify` | **26/26 PASS** (hem boş hem veri dolu DB'de) |

### GERÇEK VERİTABANINA UYGULANMADI — bilinçli

`mas_radar_dev` bu fazda da hiç değiştirilmedi ve **0036-0039 ORAYA UYGULANMADI**. Commit
öncesi teyit edildi:

```
schema=0034 · payments=19 · users=12 · counterparty_profiles=YOK · ibans=YOK
```

Bu depoda yerleşik kural: gerçek veriye geçiş her zaman ayrı, kullanıcının kendi onayladığı bir
adımdır. Faz 15'in kullanıcı adımları (`pnpm db:app-role:password` → `.env.local` →
`pnpm db:migrate`) hâlâ bekliyor; Faz 19'un migration'ları o adım çalıştırıldığında 0035'ten
sonra sırayla uygulanacak. Doğrulamanın tamamı `mas_radar_verify` ve `mas_radar_p19` disposable
veritabanlarında yapıldı, ikisi de düşürüldü, `mas_radar_app` yeniden `NOLOGIN`.

### Faz 20'ye devredilen açık noktalar

1. **`orders`/`products` henüz hiçbir mali kayda bağlı değil** — bilinçli (minimal referans
   verisi). Fatura Merkezi bunları gerçekten kullanacak.
2. **Kredi `lender_party_id` çözümü için UI yok** — `counterparty_unresolved` krediyi listeliyor
   ama eşleştirme action'ı yalnız çekler için var (kredide farklı bir kolon ve farklı bir karar).
3. Faz 17/18'den devam: `scripts/**`'daki 47 `::float8` (Faz 17B), `rules.ts` biriktiricileri,
   `finance/actions.ts:createCheckAction`'ın transaction dışı audit'i, mevcut action'ların Zod'a
   geçirilmesi.

---

## Faz 20 — DONE (Banka Merkezi: ekstre importu, kural-tabanlı sınıflandırma, mutabakat eşleştirmesi)

Dört migration (0040-0043), üç tablo, üç view, bir CSV/XLSX import hattı, deterministik
sınıflandırma ve eşleştirme. **Gerçek `mas_radar_dev`'e uygulanmadı** — aşağıda.

### Mimari karar: ayrık `bank_accounts`, veriye bakılarak verildi

Plan bunu bilerek açık bırakmıştı ("cash_accounts'a kolon eklemek **veya** ayrık tablo"). Karar
tahminle değil, gerçek tablo içeriğine bakılarak verildi:

| name | account_type |
| --- | --- |
| Deniz · HESAP Halk | bank_account |
| **Kasa** | **cash** — kasa kutusu; IBAN'ı, şubesi, KMH'si yok |
| Vinov | check_account |
| **Halk Business · Halk KK - Paraf** | **credit_card** — IBAN'ı, şubesi yok |

**Altı satırın yalnız ikisi banka hesabı.** `cash_accounts`'ı genişletmek satırların üçte
ikisinde kalıcı olarak null ve anlamsız beş kolon eklerdi, ve tablonun anlamını sessizce
değiştirirdi — belge onu "genel defter nakit pozisyonu" diye tanımlıyor ve `cashflow_lines`,
`payments`, `payment_instances`, `checks` buna bağlı. Ayrıca `cash_accounts`'a **4 FK** işaret
ediyor. Faz 19'un `parties` emsali aynen uygulandı: referans verilen tabloyu yeniden
şekillendirme, detayı yanına as.

`bank_accounts.cash_account_id` birincil anahtar, yani banka hesabı aynı paranın ikinci bir
kimliği değil — bir kasa hesabının banka detayı. `phase20:verify` `cash_accounts`'a banka-özel
kolon sızmadığını her koşuda kontrol ediyor.

Karşıt bir karar da bilinçli: **kendi IBAN'ımız GLOBAL unique**, oysa 0037'de karşı taraf IBAN'ı
parti-kapsamlıydı. Gerekçe transfer olmuyor: 0037'de aynı firma `parties`'te iki kez
bulunabildiği için aynı hesabı iki satırda taşıyabilir; burada bunlar MAS'ın **kendi** hesapları
ve iki kasa hesabının aynı IBAN'ı iddia etmesi, o hesabın ekstresini ikiye bölen bir veri hatası.

### Durum geçişi: ÜÇÜNCÜ kez tekrarlanmadı, ve kanıtı sayımla

`bank_transactions.status` CHECK'i beş değer kabul ediyor
(`unmatched · suggested · matched · reconciled · ignored`); izin listesi **aynı migration'da**
(0042) ve **on bir geçişle** kuruldu; red yolu (`suggested → unmatched`) dahil. Bilerek
yasaklananların her biri gerekçeli (ör. `reconciled → unmatched` yok; önce `matched`'e dönülür ki
yeniden açma kendi başına denetlenebilsin).

**Kanıt okumayla değil sayımla:** `phase20:verify` izin verilen durumları **canlı CHECK
constraint'inden türetiyor** (bu dosyadan değil), 5×5 = **25 çiftin tamamını** gerçek bir satır
üzerinde deniyor ve gözlenen kabul/ret matrisini beyanla karşılaştırıyor. Sonuç: **25/25 uyum,
0 uyuşmazlık**, beş durumun **beşi de** başlangıçtan erişilebilir, ölü değer yok. Ayrıca ters
yön de kontrol ediliyor: guard, CHECK'te olmayan bir duruma atıfta bulunamaz.

0027'de başarısız olan şey tam olarak "migration'ı okuyup doğru sanmak"tı; bu yüzden gate
okumuyor, deniyor. CHECK'e geçişleri olmayan bir durum eklenirse gate "ÖLÜ DURUM" diyerek düşer.

### Faz 2'nin lineage deseni yeniden kullanıldı, ikincisi icat edilmedi

Ekstreler **aynı** staging katmanından geçiyor: `source_workbooks → source_sheets →
source_cells → import_rows`, ve her `bank_transaction` `source_row_id` taşıyor. Uçtan uca
testte dört satırın dördünde de lineage doğrulandı.

Bunun bir bedeli vardı ve ödendi: `source_sheets.detected_type` bir CHECK enum'u ve
`workbook-parser.ts`'in `SheetDetectedType` union'ıyla birebir aynı olmak zorunda (dosyanın kendi
başlığı "Do not drift" diyor). 0041 CHECK'i genişletiyor, union da aynı üyeyi alıyor.

**`classifySheetName` bu türü asla döndürmüyor** — ekstre importu, operatörün hangi hesaba
aktardığını seçtiği açık bir eylem, tür sayfa adından tahmin edilmiyor. Tahmin burada ayrıca
tehlikeliydi: gerçek çalışma kitabında **"faiz hesaplama"** adlı bir sayfa var ve makul görünen
bir "hesap" anahtar kelimesi onu `loan_calculation`'dan çalardı.

### CSV desteği, §1.1 koruması bozulmadan

`safeParseWorkbookBuffer` ZIP/CFB imzası olmayan her şeyi reddediyor ve bu **belirtilmiş, testli**
bir davranış (§1.1: tamamı sıfır bayt olan bozuk yükleme "ayrıştırılmış" sayılmamalı). Ekstreler
sık sık CSV geliyor — ama imza kontrolünü gevşetmek uygulamadaki HER workbook importu için
bozuk-dosya deliğini yeniden açardı.

Workbook yoluna **dokunulmadı**; CSV kendi kapısını ve kendi korumasını aldı
(`statement-parser.ts`): boş dosya, NUL bayt içeren içerik ve ayırıcısız metin reddediliyor —
`phase20:verify` all-zero bir dosyanın `.csv` adıyla bile reddedildiğini ayrıca kontrol ediyor.
UTF-8 BOM stripleniyor (aksi halde ilk başlık hücresi "﻿İşlem Tarihi" olur ve sütun tanıma
çöker). Ayırıcı ilk satırdan sayılarak bulunuyor; Türkçe CSV'ler `;` kullanıyor çünkü `,`
ondalık ayırıcı.

### Kendi testimin yakaladığı gerçek tasarım hatası

İlk `MATCH_WEIGHTS` tablosunda `amountExact = 0.6` idi ve öneri eşiği 0.5 — yani **tek başına
tutar tutması öneri üretiyordu**, tam da doc comment'in "asla olmamalı" dediği şey. Birim testi
yakaladı. Ağırlıklar düşürüldü (`amountExact = 0.45`) ve artık **hiçbir tek ağırlık eşiği tek
başına geçemiyor**; bu yapısal değişmez ayrıca tüm tablo üzerinde test ediliyor. 10.000 TL gibi
yuvarlak bir tutarın tek başına tutması, güvenle yanlış mutabakat üreten klasik rastlantıdır.

### Sınıflandırma: kural, model değil

Sıralı kural tablosu, **ilk eşleşen kazanır**, ve sıra spesifikasyonun kendisi ("kredi kartı"
mutlaka "kredi taksit"ten önce). Her hareket hangi kuralın çalıştığını (`category_rule`)
saklıyor ve arayüzde gösteriyor. Eşleşme yoksa `unknown` + **null kural** — en iyi tahmin
üretilmiyor. Açıklanamayan bir sınıflandırma güvenilmemesi gereken bir sınıflandırmadır.

### Uçtan uca kanıt (disposable DB, gerçek pipeline)

5 satırlık TR formatlı bir CSV (`;` ayırıcı, `1.234,56` sayı, `Borç`/`Alacak` sütunları):

```
import #1: rowsSeen=6 inserted=4 duplicates=0 skipped=1 ("satır 6: tarih okunamadı" — TOPLAM satırı)
import #2 (aynı dosya): inserted=0 duplicates=4        ← yinelenen tespiti
2026-03-01      -15.00 outflow bank_fee         rule=eft_havale_fee    lineage=true
2026-03-05   -45000.00 outflow salary           rule=salary            lineage=true
2026-03-10    10000.00 inflow  incoming_payment rule=incoming_transfer lineage=true
2026-03-10  -100000.00 outflow check_settlement rule=check_settlement  lineage=true
matcher: scanned=4 suggested=1 candidates=1
aday: checks conf=0.8500 ["amount_exact","date_same_day","label_contained"]
kabul edildi → çekin durumu: planned (DEĞİŞMEDİ ✓)
```

Son satır bu fazın en önemli davranışı: **bir eşleşmeyi kabul etmek mali kaydı değiştirmez.**
Ekstre planla ilişkilendirilir; ödemeyi "ödendi" yapmak ayrı ve ayrıca denetlenen bir işlemdir.
Denetim satırı bunu `financial_record_mutated: false` alanıyla açıkça kaydediyor.

Ayrıca atlanan satır **gerekçesiyle bildiriliyor** (sessiz atlama, gerçek bir işlemin mutabakattan
kaybolma yolu) ve yok sayma **gerekçe zorunlu** (0042'de CHECK ile de zorlanıyor).

### İkinci bir durum makinesi kurulmadı

`bank_transaction_match_candidates`'ın statü enum'u **yok**: bir aday ya vardır ya
reddedilmiştir. Statü olarak modellemek ikinci bir tam guard gerektirirdi ve §17 kural 3 tam da
bu yüzden var. `rejected_at` nullable bir zaman damgası — kısıtlanacak geçişi yok. Redler
silinmiyor, **hatırlanıyor**; yoksa eşleştirici aynı adayı her koşuda yeniden önerirdi.

### Faz 18'in gate'i yine işini yaptı

Docs yazılmadan önce `phase18:verify` **10/12** verip eksik migration'ları (0040-0043) tek tek
listeledi. Faz 19'da düzeltilen "untracked dosyayı görme" hatası olmasaydı bu sessizce
geçecekti. Docs yazıldıktan sonra 12/12.

Ayrıca koordinatörün bildirdiği kozmetik sorun düzeltildi: `phase17-verify.ts`'teki sabit
"41 tablonun tamamında" metni artık dinamik (`44 migration dosyasının tamamında`).

### DOKUNULMAYANLAR (bilinçli)

- **`cash_accounts`** — hiç değiştirilmedi; banka detayı sidecar'da.
- **`safeParseWorkbookBuffer` ve workbook import yolu** — CSV için gevşetilmedi, ayrı kapı açıldı.
- **`payments`/`checks`/`loan_installments`** — eşleştirme bu kayıtları OKUR, yazmaz.
- **Fatura/tahsilat eşleştirmesi** — Faz 22'nin işi; o tablolar henüz yok, aday CHECK'i bugün
  var olan üç entity ile sınırlı ve Faz 22 kendi migration'ında genişletecek.
- **Banka API'si** — Faz 37. `phase20:verify` engine'de ağ çağrısı olmadığını kontrol ediyor.

### Gate sonuçları

| Adım | Sonuç |
| --- | --- |
| `pnpm lint` | exit 0 (1 uyarı: `analytics-chart.tsx`, önceden var) |
| `pnpm typecheck` | exit 0 |
| `pnpm test` | **388/388** (323 mevcut + 65 yeni banka kuralı) |
| `pnpm db:verify` | ALL ASSERTIONS PASSED |
| `db:migrate:verify` | **49/49** (ledger 43 migration) |
| `db:constraints:verify` | 54/54 |
| `db:transitions:verify` | 167/167 |
| `db:reconciliation:verify` | 77/77 |
| `db:legacy-repair:verify` | 183/183 |
| `pnpm db:roles:verify` | **8/8** |
| `pnpm import:real` | ALL PASS (43 sekme, 9.817 hücre) |
| phase3…phase14e (20 script) | 20/20 PASS |
| `pnpm build` | exit 0 |
| `pnpm phase16:verify` | 18/18 |
| `pnpm phase17:verify` | 10/10 |
| `pnpm phase18:verify` | **12/12** (0043'e kadar) |
| `pnpm phase19:verify` | 26/26 |
| `pnpm phase20:verify` | **30/30 PASS** |

### GERÇEK VERİTABANINA UYGULANMADI

Commit öncesi teyit: `schema=0034 · payments=19 · users=12 · bank_accounts=YOK ·
bank_transactions=YOK`. Bu depoda yerleşik kural: gerçek veriye geçiş her zaman ayrı,
kullanıcının kendi onayladığı bir adım. Doğrulamanın tamamı `mas_radar_verify` ve
`mas_radar_p20` disposable veritabanlarında yapıldı, ikisi de düşürüldü, `mas_radar_app`
yeniden `NOLOGIN`.

### Faz 21'e devredilen açık noktalar

1. **Ekstre bakiyesi ile hesaplanan bakiye karşılaştırılmıyor.** `balance_after` içe aktarılıyor
   ama bir "ekstre bakiyesi ↔ uygulama bakiyesi" mutabakat kontrolü yok; kendi başına bir dilim.
2. **Kredi kartı ekstreleri** `bank_accounts` sidecar'ını alabilir ama IBAN'sız; kart ekstresi
   biçimi ayrıca ele alınmalı.
3. **`matched → reconciled` toplu işlemi yok** — dönem kapatma Faz 21/23'ün konusu.
4. Faz 17/18/19'dan devam: `scripts/**`'daki 47 `::float8`, `rules.ts` biriktiricileri,
   `createCheckAction`'ın transaction dışı audit'i, mevcut action'ların Zod'a geçirilmesi,
   kredi `lender_party_id` eşleştirme UI'ı.

---

## Faz 20 düzeltmesi — `phase20:verify` kendi kanıtını sessizce eksik kümeyle "geçirebiliyordu"

Bağımsız doğrulamada bulundu. Faz 20 commit'i (`07ebc26`) yazarın makinesinde **30/30**
veriyordu; doğrulayan aynı script'i kendi ortamında çalıştırdığında **29/30** aldı. Fark koddan
değil, **satır sırasından** kaynaklanıyordu — yani gate'in kendisi ortama göre farklı sonuç
üretiyordu.

### Hata

`scripts/phase20-verify.ts` durum kümesini canlı CHECK constraint'inden okuyordu — doğru fikir,
yanlış sorgu:

```sql
select pg_get_constraintdef(oid) as def from pg_constraint
 where conrelid='public.bank_transactions'::regclass and contype='c'
   and pg_get_constraintdef(oid) like '%status%'      -- ORDER BY yok
```

…ve `[0]?.def` ile **ilk satırı** alıyordu. Oysa bu tabloda `status` geçen **üç** CHECK var, ve
her biri değer-çıkarma regex'ine farklı bir küme veriyor (disposable DB'de bizzat ölçüldü):

| constraint | çıkarılan değerler | üretilen matris |
| --- | --- | --- |
| `bank_transactions_status_check` (**istenen**) | unmatched, suggested, matched, reconciled, ignored | 5×5 = **25** |
| `bank_transactions_match_consistency` | matched, reconciled | 2×2 = 4 |
| `bank_transactions_ignore_reason` | ignored | 1×1 = **1** |

Postgres `ORDER BY` olmadan satır sırasını garanti etmez. Doğrulayanın ortamında `[0]`
`ignore_reason` oldu: regex tek bir `'ignored'` değeri çıkardı, geçiş kanıtı **1×1 matrisle**
koştu — ve gate yine **PASS** bastı. Beş durumlu bir makineyi tek durum test ederek
"kanıtlayabilen" bir gate, gate olmaktan çıkar.

**Bu, Faz 20'nin önlemek için var olduğu hatanın mikro-versiyonu.** 0027 "migration'ı okudum ve
doğru sandım"dı; bu "sorgunun ilk satırını okudum ve doğrusu sandım"dı. Kanıt üreten kodun
kendisi de kanıtlanmak zorunda.

### Düzeltme — metin araması değil, yapısal hedefleme

Durum enum'u, bu tabloda `conkey`'i **tam olarak tek başına `status` kolonu** olan yegâne
CHECK'tir (diğer ikisi 2 ve 3 kolona yayılıyor). Sorgu artık bunu hedefliyor:

```sql
select c.conname, pg_get_constraintdef(c.oid) as def
from pg_constraint c
join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
where c.conrelid = 'public.bank_transactions'::regclass
  and c.contype = 'c' and array_length(c.conkey, 1) = 1
  and a.attname = 'status'
order by c.conname
```

Ve kritik olarak: **aday sayısı 1 değilse gate düşer**, bir tanesini seçmez. Bu tam olarak
`phase3-verify.ts`'in PRONET sorgusunda zaten uyguladığı disiplin
(`if (pronet.length !== 1) fail(...)`) — önce kardinaliteyi doğrula, sonra `[0]`'ı oku.

İki bağımsız koruma eklendi:
1. `status enum CHECK'i TEK ve kesin olarak belirlendi (metin araması değil, conkey ile)` —
   aday sayısı tam 1 olmalı.
2. `çıkarılan durum kümesi gerçekten çok-değerli bir enum (≥3) ve ANY(ARRAY[…]) biçiminde` —
   ileride sorgu yeniden belirsizleşse bile 1 veya 2 değerli bir sonuç burada düşer.

Ayrıca küme 3'ten azsa script **exception fırlatıyor**; matris eksik bir kümeyle hiç
çalıştırılmıyor. Kontrol sayısı 30 → **31**.

### Determinizm kanıtı (tek seferlik şans değil)

Yapısal argüman: yeni sorgu **tam olarak 1 aday** döndürüyor, dolayısıyla sıralamadan bağımsız
(eski sorgu 3 aday döndürüyordu). Buna ek olarak aynı disposable DB'de **6 kez art arda**
çalıştırıldı ve üç koşuda `pg_constraint`'in fiziksel düzeni kasıtlı olarak bozuldu (araya geçici
bir CHECK constraint eklenip düşürülerek):

```
koşu 1                        31/31
koşu 2 (katalog karıştırıldı) 31/31
koşu 3                        31/31
koşu 4 (katalog karıştırıldı) 31/31
koşu 5                        31/31
koşu 6 (katalog karıştırıldı) 31/31
```

### Aynı desen başka yerde var mı? — tarandı, yok

`pg_constraint`/`pg_get_constraintdef` kullanan her yer ve `like '%…%'` ile satır seçen her
sorgu tarandı:

- `scripts/db/reconciliation-verify.ts`, `legacy-cancellation-fixture.ts` ve migration
  0028/0029/0030/0032 → hepsi `where conname = '…'` ile **tam ada** göre hedefliyor
  (`conname` benzersiz), belirsizlik yok.
- `scripts/import-real.ts`'in üç `like '%…%'` sorgusu → `count(*)` agregası, inşaen tek satır.
- `scripts/phase3-verify.ts:83` (`name ilike '%PRONET%'`) → `[0]`'ı okumadan ÖNCE
  `pronet.length !== 1` kontrolü yapıyor. **Doğru desen zaten buydu.**

Yani `phase20-verify.ts:127` tek örnekti ve düzeltildi.

### Gate sonuçları (düzeltmeden sonra, tam zincir yeniden koşuldu)

| Adım | Sonuç |
| --- | --- |
| `pnpm lint` | exit 0 (1 uyarı: `analytics-chart.tsx`, önceden var) |
| `pnpm typecheck` | exit 0 |
| `pnpm test` | 388/388 |
| `pnpm db:verify` | ALL ASSERTIONS PASSED |
| `db:migrate:verify` | 49/49 |
| `db:constraints:verify` | 54/54 |
| `db:transitions:verify` | 167/167 |
| `db:reconciliation:verify` | 77/77 |
| `pnpm db:roles:verify` | 8/8 |
| `pnpm build` | exit 0 |
| `pnpm phase16:verify` | 18/18 |
| `pnpm phase17:verify` | 10/10 |
| `pnpm phase18:verify` | 12/12 |
| `pnpm phase19:verify` | 26/26 |
| `pnpm phase20:verify` | **31/31** (6 koşuda da) |

`mas_radar_dev` yine hiç değiştirilmedi (şema 0034, `bank_transactions=YOK`); disposable
veritabanları düşürüldü, `mas_radar_app` yeniden `NOLOGIN`.

### Alınan ders (yeni bir standing kural)

**Bir katalog sorgusu birden fazla satır döndürebiliyorsa, `[0]`'ı okumadan önce kardinalite
doğrulanır** — ya sorgu tek satıra indirgenir (benzersiz anahtarla), ya da sayı açıkça
assert edilir. `like '%kolon_adı%'` bir hedefleme yöntemi değildir; aynı kolonu anan her
constraint'i toplar.

---

## Faz 21 — DONE (Fatura Merkezi: 6 durumlu yaşam döngüsü, duplicate tespiti, reversal kaydıyla iptal)

Dört migration (0044-0047), üç tablo, beş view. **Gerçek `mas_radar_dev`'e uygulanmadı** —
aşağıda. Faz 19'un referans verisi üzerine kurulu; gerçek kolon adları migration yazılmadan
ÖNCE introspection'la doğrulandı (`projects.party_id`, `projects.cost_center_id`,
`orders.party_id` — plandan tahmin edilmedi).

### Altı durum, 36 çift, sayımla kanıtlandı

`draft · open · partial · paid · closed · cancelled` — CHECK ile izin listesi **aynı
migration'da** (0044), on dört geçişle. `phase21:verify` **36 çiftin tamamını gerçek satırlar
üzerinde** deniyor ve gözlenen matrisi beyanla karşılaştırıyor: **36/36 uyum, 6/6 durum
erişilebilir, ölü değer yok.**

İki karar özellikle gerekçeli:
- **Hiçbir şey → draft yok.** Düzenlenmiş bir fatura "düzenlenmemiş" yapılamaz; bu hem karşı
  tarafın eline geçtiği gerçeğini silmek hem de içerik dokunulmazlığını yeniden açmak olurdu.
- **`cancelled` TERMİNAL.** İptal, bağlı reversal kaydıyla belgelenir; çare yeni fatura
  düzenlemektir. Denetim izi ile yeniden yazma arasındaki fark tam olarak budur.

### Faz 20'nin gate dersi baştan uygulandı — ve burada da gerekliydi

Faz 20'nin düzeltmesinde öğrenilen kural (`like '%kolon%'` ile constraint hedefleme + ORDER BY'sız
`[0]` = belirsizlik) bu fazın gate'inde **en baştan** uygulandı: constraint `conkey` ile yapısal
olarak hedefleniyor ve **aday sayısı 1 değilse gate düşüyor**.

Bunun boş bir tedbir olmadığı ölçüldü: `invoices` üzerinde `like '%status%'` **üç** constraint
eşliyor (`invoices_status_check`, `invoices_cancel_consistency`, `invoices_close_consistency`).
Faz 20'nin hatası burada birebir tekrarlanacaktı. `phase21:verify` bunu ayrı bir kontrol olarak
da raporluyor: *"metin araması burada da belirsiz olurdu (bu yüzden kullanılmadı) — like
'%status%' 3 constraint eşliyor; conkey ile 1 tanesi kalıyor."*

### İptal = bağlı kayıt, sessiz durum değişimi DEĞİL

`status='cancelled'` yalnız "geçersiz mi" sorusunu yanıtlar; kimin/ne zaman/neden iptal ettiğini
ve **faturanın iptal anında ne dediğini** yanıtlayamaz. Her iptal, faturanın ve kalemlerinin
dondurulmuş JSON kopyasını taşıyan bir `invoice_reversals` kaydı yazar (0022 salt-ekleme kurgusu,
0026 iptal alanları, 0024 dokunulmazlık duruşu — üçü de yeniden kullanıldı, dördüncü bir
mekanizma icat edilmedi).

Asıl zorlayıcı **`invoices_require_reversal_record`**, DEFERRABLE constraint trigger: bağlı kaydı
olmayan bir `cancelled` fatura COMMIT edilemiyor. Bu olmasaydı tasarım tavsiye niteliğinde
kalırdı. `phase21:verify` sessiz iptalin reddedildiğini, reversal kaydıyla iptalin geçtiğini,
ikinci bir cancellation'ın reddedildiğini ve kaydın UPDATE/DELETE edilemediğini ayrı ayrı
ölçüyor.

### İçerik dokunulmazlığı — ve guard'ın ÇOK GENİŞ olmadığının kanıtı

`draft` tek düzenlenebilir durum. Düzenlendikten sonra karşı taraf, numara, tarihler ve tutarlar
donuyor; düzeltme iptal+yeniden düzenlemeyle yapılıyor. Kalemler başlığın dokunulmazlığını
izliyor (başlığı dondurup kalemleri serbest bırakmak tiyatro olurdu). Düzenlenmiş fatura
silinemiyor; taslak silinebiliyor.

Ama guard bilerek dar: `status`, `paid_amount`, iptal/kapatma meta verisi ve `notes` donmuyor —
düzenlenmiş faturaya tahsilat işlenebilmeli. **Guard'ı buraya kadar genişletmek 0027'nin "satır
kullanılamaz hale geldi" hatasını başka kılıkta tekrarlamak olurdu**, ve gate bunu ayrıca test
ediyor ("guard ÇOK GENİŞ değil: paid_amount ve status hâlâ değişebiliyor").

### `import:real` gerçek bir tasarım hatası yakaladı: TRUNCATE CASCADE

0046'nın ilk hâli `invoice_id uuid not null references public.invoices(id) on delete restrict`
diyordu. **`pnpm import:real` anında düştü.**

Kök neden: `scripts/import-real.ts` `truncate public.source_workbooks cascade` çalıştırıyor,
faturalar `source_workbook_id` lineage kolonu taşıyor, ve **TRUNCATE CASCADE `ON DELETE`
eylemine bakmaksızın referans veren HER tabloyu izliyor** — cascade `invoice_reversals`'a ulaştı
ve salt-ekleme trigger'ı meşru bir geliştirme sıfırlamasını iptal etti.

Normal işleyişi bozacak kadar geniş çizilmiş bir guard, 0027 hatasının başka kılığı.

Düzeltme FK'yı kaldırmak — ve bu, hatayı çözmek için uydurulmuş bir kaçamak değil, bu depoda
**zaten var olan emsalin** aynısı: 0037'nin `iban_change_events.iban_id`'si aynı gerekçeyle FK
değil ("satır, tarif ettiği şeyden uzun yaşamalı"). Genel kural olarak: **bir append-only kanıt
tablosuna cascade edebilen her tablo, o kanıtı yok edebilir.** Bütünlük ait olduğu yerde
korunuyor — engine faturayı yazmadan önce çözüp kilitliyor, deferred trigger kayıtsız iptali
reddediyor.

Faz 20'de `iban_change_events` bu sorunu hiç yaşamamıştı çünkü zaten FK'sızdı; yani emsal
doğruydu, ben Faz 21'de ona uymayı ilk denemede atlamıştım.

### Temiz DB'de ortaya çıkan ikinci gate hatası (yine kendi kontrolümde)

`invoice_reversals` düzeltildikten sonra `mas_radar_p21` sıfırdan kurulunca **"kalem gross <>
net + tax REDDEDİLİR" kontrolü düştü**. Sebep kısıt değildi: sonda
`select id ... from public.invoices limit 1` ile rastgele bir fatura seçiyordu ve daha önce
yalnız elle yapılan bir testten kalan **commit edilmiş** bir satır olduğu için geçiyordu. Temiz
veritabanında sıfır satır seçildi, INSERT hiçbir şey yazmadı, "reddedildi" false döndü.

**Faz 20'nin boş-tablo tuzağıyla aynı aile:** vakumda başarılı olabilen bir sonda hiçbir şey
kanıtlamaz. Sonda artık kendi taslak faturasını yaratıyor, ve yanına bir **pozitif kontrol**
eklendi (doğru aritmetikli kalem KABUL EDİLİYOR) ki reddin gerçekten CHECK'ten geldiği belli
olsun. Kontrol sayısı 34 → **35**.

### Birim testinde üçüncü bir ders: değişmezi float ile doğrulamak

`rules.test.ts` ilk hâlinde `expect(t.grossAmount).toBe(t.netAmount + t.taxAmount)` yazıyordu ve
q=7, p=1.115'te düştü: **kod doğru olarak 9.22 üretti, TEST ise 7.81 + 1.41 = 9.219999999999999
hesapladı.** Test, kodun kaçınmak için var olduğu aritmetiği kullanıyordu ve "düzeltmesi" kodu
bozmak olurdu. 0044'ün CHECK'i Postgres'te `numeric` ile değerlendiriliyor; assertion da öyle
olmak zorunda. `expectGrossInvariant` yardımcısı decimal ile karşılaştırıyor.

### Duplicate: tespit var, kısıt YOK

Karşı taraf + numara + tutar + tarih sezgisi iki ayrı sinyal olarak raporlanıyor: `same_number`
ve `near_match` (aynı tutar, ≤7 gün, FARKLI numara — tedarikçinin yeni numarayla yeniden
gönderdiği durum). İptal edilenler listeden düşüyor.

**Engellenmiyor**, ve bu Faz 20'yle bilinçli bir karşıtlık: `bank_transactions.dedupe_hash`
unique'tir çünkü örtüşen ekstre dönemini yeniden indirmek mekanik ve beklenen bir iştir. Fatura
duplicate'i insan/tedarikçi hatasıdır, iki satır anlamlı şekilde farklı olabilir, ve ikincisini
reddetmek operatörü ya rakamı çarpıtmaya ya içe aktarmayı bırakmaya zorlar.

Başlık/kalem uyuşmazlığı da aynı mantıkla raporlanıyor: kalemler zorunlu olarak başlıktan SONRA
yazılır, engelleyen bir trigger normal ekleme sırasını yasaklardı. Deponun bu sınıf için yerleşik
cevabı nakit-akış kimlik kontrolü.

### DOKUNULMAYANLAR (bilinçli)

- **`payments`/`checks`/`bank_transactions`** — fatura tahsilatı bu kayıtlara dokunmuyor.
  Tahsilatı üreten parayla bağlantı **Faz 22'nin** işi; audit satırı bunu
  `linked_settlement_source: null` ile açıkça kaydediyor.
- **Çok kalemli fatura editörü** — UI tek kalemli taslak açıyor; engine dizi alıyor.
- **İade faturası (credit_note) akışı** — tablo ve tip destekliyor, UI akışı bu fazda yok.

### Gate sonuçları

| Adım | Sonuç |
| --- | --- |
| `pnpm lint` | exit 0 (1 uyarı: `analytics-chart.tsx`, önceden var) |
| `pnpm typecheck` | exit 0 |
| `pnpm test` | **432/432** (388 mevcut + 44 yeni fatura kuralı) |
| `pnpm db:verify` | ALL ASSERTIONS PASSED |
| `db:migrate:verify` | 49/49 (ledger 47 migration) |
| `db:constraints:verify` | 54/54 |
| `db:transitions:verify` | 167/167 |
| `db:reconciliation:verify` | 77/77 |
| `pnpm db:roles:verify` | 8/8 |
| `pnpm import:real` | ALL PASS (TRUNCATE CASCADE hatası düzeltildikten sonra) |
| phase3…phase14e (20 script) | 20/20 PASS |
| `pnpm build` | exit 0 |
| `pnpm phase16/17/18:verify` | 18/18 · 10/10 · 12/12 |
| `pnpm phase19:verify` | 26/26 |
| `pnpm phase20:verify` | 31/31 |
| `pnpm phase21:verify` | **35/35** — beş koşunun beşinde de (üçünde katalog karıştırılarak), her seferinde 6×6 matris |

### GERÇEK VERİTABANINA UYGULANMADI

Commit öncesi teyit: `schema=0034 · payments=19 · users=12 · invoices=YOK ·
invoice_reversals=YOK`. Doğrulamanın tamamı `mas_radar_verify` ve `mas_radar_p21` disposable
veritabanlarında yapıldı, ikisi de düşürüldü, `mas_radar_app` yeniden `NOLOGIN`.

### Faz 22'ye devredilen açık noktalar

1. **Tahsilat ↔ para bağlantısı yok.** `recordInvoicePayment` yalnız `paid_amount`'ı hareket
   ettiriyor; hangi banka hareketi veya ödeme kaleminin onu ürettiği kaydedilmiyor — Faz 22'nin
   çekirdek işi. `bank_transaction_match_candidates.target_table` CHECK'i o zaman
   `invoices`/`invoice_lines` ile genişletilecek.
2. **Çok kalemli fatura UI'ı** ve **iade faturası akışı**.
3. Faz 17-20'den devam: `scripts/**`'daki 47 `::float8`, `rules.ts` biriktiricileri,
   `createCheckAction`'ın transaction dışı audit'i, mevcut action'ların Zod'a geçirilmesi,
   kredi `lender_party_id` eşleştirme UI'ı, ekstre bakiyesi ↔ hesaplanan bakiye mutabakatı.

---

## Faz 22 — DONE (tahsilat/ödeme dağıtımı, alacak/borç read-model, cari hesap kartı)

Üç migration (0048-0050), bir tablo, dokuz view. **Gerçek `mas_radar_dev`'e uygulanmadı**.

### §18'in ilk gerçek testi: dağıtım tavanı, veritabanı seviyesinde

`Σ(açık dağıtım) ≤ invoices.gross_amount` — trigger olarak kuruldu, konvansiyon olarak değil.
implementation.md §18 uygulama-seviyesi kontrolün yetmeyeceğini açıkça söylüyor.

**Neden CHECK değil trigger:** CHECK tek satır görür; bu değişmez BAŞKA bir tablodaki bir değere
karşı ÇOK satırın toplamıdır. Hiçbir CHECK bunu ifade edemez. `db:constraints:verify`'e eklenen
11 test bunu ayrıca vurguluyor — özellikle *"dağıtım TOPLAMI fatura tutarını aşamaz (satır bazlı
CHECK yakalayamazdı)"*.

Disposable DB'de doğrulanan davranışlar: tek dağıtım > fatura RED · toplam > fatura RED ·
tam tutar KABUL · UPDATE ile tavan aşma RED · **dağıtım başka faturaya taşınınca İKİ taraf da
yeniden hesaplanıyor** (INV-A 120→0, INV-B 0→120) · iptal edilen dağıtım toplamdan düşülüyor ·
taslak/iptal edilmiş faturaya dağıtım RED · `invoices.allocated_amount` trigger tarafından doğru
tutuluyor. `constraints-verify` 54 → **65**.

### Tek tablo, iki isim

Plan `payment_allocations`/`collection_allocations` diyor; ikisi kolon kolon aynı olurdu (yön
zaten `invoices.direction`'dan belli) ve ayırmak, tavan değişmezinin iki tablo üzerinden iki
trigger'la toplanmasını gerektirirdi. **Tek tablo = tek trigger = değişmezin yaşadığı tek yer.**
Planın istediği iki isim 0050'de filtrelenmiş view olarak sağlandı, söz dağarcığı korundu.

### `paid_amount` ile `allocated_amount`: muhasebe farkı

- `paid_amount` (Faz 21): bu faturaya karşı **kaydedilmiş** para. Tavanı YOK — fazla tahsilat
  gerçektir ve engellemek operatörü kaydı çarpıtmaya zorlar.
- `allocated_amount` (Faz 22): bu paranın faturaya **resmen atanmış** kısmı. Fatura tutarıyla
  sınırlı — 120'lik faturaya 130 atamak fazla tahsilat değil, 10'unun başka yere ait olmasıdır.

Fazla tahsilat artık `settlement_unallocated` view'inde görünüyor: para var, o faturaya ait
değil. Gate bunu ölçüyor (130 TL hareket, 120 dağıtıldı, 10 dağıtılmamış olarak raporlandı).

### AÇIK TASARIM KARARI: receivables/payables VIEW, tablo DEĞİL

Uygulanan test: bir alacağın bugün, faturasının zaten taşımadığı tek bir özniteliği var mı?
Karşı taraf/tutar/tarihler faturada, kalan `gross − allocated`, yaşlandırma `due_date`'ten,
durum `invoices.status`. **Geriye hiçbir şey kalmıyor.**

Bugün bir receivables tablosu her kolonu kopyalar ve faturada yaşayan tutarlar için anında
ikinci bir gerçek kaynak olurdu — bu şemanın zaten ısırıldığı bayatlama (0034 öncesi
`paid_count` Faz 5'ten beri 0 dönüyordu; 0039/0043/0047 hep aynı sebeple view).

Tabloyu haklı çıkaracak şeyler gerçek ama bu fazda yok: **promise-to-pay** (implementation.md
§1c ayrı bir gelecek entity olarak listeliyor), dunning/tahsilat durumu, alacak-bazlı sorumluluk
ataması. Bunlar kendi öznitelikleri ve kendi yaşam döngüleriyle geldiğinde terfi edilir — kendi
migration'ı ve kendi eksiksiz transition-guard'ıyla. Şimdi terfi ettirmek, içine koyacak bir şey
olmadan yaşam döngüsü icat etmek olurdu.

### `bank_transactions` CHECK genişletmesi — ayrı ve açık bir adım (0049)

Faz 20 `matched_entity_table` CHECK'ini o gün var olan üç entity ile göndermişti; 0043'ün notu
bu genişletmeyi Faz 22'ye yazılı olarak bırakmıştı.

`bank_transactions` üzerinde `matched_entity_table` geçen **iki** CHECK var (değer listesi ve
null-eşleşme tutarlılığı). Yalnız birincisi değiştirildi ve **adıyla** hedeflendi — metin
aramasıyla değil. **Faz 20'nin gate dersi DDL için de geçerli:** `like '%matched_entity_table%'`
ikisini de bulur ve "bulduğunu düşüren" bir migration, tutarlılık kuralını sessizce silebilirdi.

`bank_transaction_match_candidates.target_table` CHECK'i **aynı anda** genişletildi. Birini
genişletip diğerini bırakmak, eşleştiricinin artık eşleşmesine izin verilen şeyi hiç
ÖNEREMEMESİ demekti — tam olarak 0027'nin biçimi. Gate ikisini ayrı ayrı doğruluyor, ve Faz
20'nin üç hedefinin KORUNDUĞUNU da (genişletme, daraltma değil).

Eşleştirici (`bank/engine.ts`) artık açık faturaları da aday havuzuna alıyor — ve teklif edilen
tutar **hâlâ açık olan** kısım (`gross − allocated`), fatura toplamı değil: yarısı tahsil edilmiş
bir faturada kalan yarıyı tutan ekstre satırı asıl ilginç adaydır, toplamı teklif etmek onu
uyuşmazlık olarak skorlardı.

### Yaşlandırma kovaları Faz 21'den farklı — kasıtlı

0047 1-30/31-60/61-90/90+ kullanıyor (klasik AR **raporlama** yaşlandırması). Faz 22
1-7/8-30/31-60/60+ kullanıyor (**tahsilat aciliyeti**): ilk ayı böler çünkü müşterinin üç gün mü
üç hafta mı geciktiği bugün ne yapacağını değiştirir; 60'tan sonra bölmez çünkü aksiyon aynıdır.
İkisi de korunuyor ve `phase22:verify` TS ile SQL uygulamasını aynı satırlara karşı
karşılaştırıyor.

`summarizeAgeing` **her kovayı** döndürüyor, boş olanlar dahil — eksik bir satırla sıfır satır,
sorun arayan birine çok farklı okunur.

### DSO/DPO: view bileşen verir, oran değil

Bir view parametre alamaz; dönemi SQL'e gömmek, herkesin alıntıladığı ama azının aynı tanımladığı
bir metrikte en kritik varsayımı gizlemek olurdu. Oran `rules.ts`'te, formülü yazılı ve
birim-testli. **Dönemde satış yoksa sonuç null, sıfır değil** — sıfır, hiçbir şey satmamış bir
şirket için "müşteriler anında ödüyor" demektir.

### Cari hesap: alacak ve borç NETLEŞTİRİLMEZ

Mahsup iki taraf arasında hukuki bir işlemdir, aritmetik değil; netlemek var olmayan bir
anlaşmayı varsaymak olurdu. `counterparty_settlement_speed` **gerçekleşmiş** süredir: yalnız
tahsil edilmiş faturaları sayar, çünkü ödenmemiş bir faturanın süresi yoktur ve sıfır saymak
karşı tarafı olmadığı kadar iyi gösterirdi.

### Gate yazarken uygulanan (ve bir kez daha gereken) dersler

1. **Kardinalite kuralı** baştan uygulandı: `matched_entity_table` için `like` ile **iki**
   constraint eşleşiyor, `conkey` ile bir. Gate bunu ayrı bir kontrol olarak raporluyor.
2. **Vakumda geçen sonda yok:** her negatif kontrolün yanında pozitif kontrol var (tam tutar
   KABUL ediliyor), ve iptal sondası ihtiyacı olan kullanıcıyı **kendisi yaratıyor** — ilk hâli
   `select id from public.users limit 1` okuyordu ve seed'siz bir DB'de sahte FAIL verirdi. Aynı
   ambient-veri tuzağı Faz 20/21'de iki kez vakumda PASS üretmişti.
3. **`constraints-verify`'da Türkçe regex:** ilk yazımda `/asamaz/i` ve `/baglanamaz/i` kullandım,
   trigger ise `aşamaz`/`bağlanamaz` fırlatıyor — dört test "başarısız" göründü hâlbuki kısıt
   çalışıyordu. Kısıtı değil kendi desenimi düzelttim.

### Gate sonuçları

| Adım | Sonuç |
| --- | --- |
| `pnpm lint` | exit 0 (1 uyarı: `analytics-chart.tsx`, önceden var) |
| `pnpm typecheck` | exit 0 |
| `pnpm test` | **470/470** (432 + 38 yeni) |
| `pnpm db:verify` | ALL ASSERTIONS PASSED |
| `db:migrate:verify` | 49/49 (ledger 50 migration) |
| `db:constraints:verify` | **65/65** (54 + **11 yeni dağıtım tavanı testi**) |
| `db:transitions:verify` | 167/167 |
| `db:reconciliation:verify` | 77/77 |
| `pnpm db:roles:verify` | 8/8 |
| `pnpm import:real` | ALL PASS |
| phase3…phase14e (20 script) | 20/20 |
| `pnpm build` | exit 0 |
| phase16/17/18 | 18/18 · 10/10 · 12/12 |
| phase19/20/21 | 26/26 · 31/31 · 35/35 |
| `pnpm phase22:verify` | **35/35** — beş koşunun beşinde de (üçünde katalog karıştırılarak), her seferinde `conkey ile 1` |

### GERÇEK VERİTABANINA UYGULANMADI

Commit öncesi teyit: `schema=0034 · payments=19 · invoice_allocations=YOK`. Doğrulamanın tamamı
`mas_radar_verify` ve `mas_radar_p22` disposable veritabanlarında yapıldı.

### Faz 23'e devredilen açık noktalar

1. **Promise-to-pay / dunning** — receivables'ı tabloya terfi ettirecek asıl gerekçe; geldiğinde
   kendi migration'ı ve kendi eksiksiz transition-guard'ıyla gelmeli.
2. **Kaynak tarafı tavanı trigger'sız:** bir banka hareketinin taşıdığından fazlasını dağıtmasını
   `allocateBankTransaction` engelliyor ama arkasında DB trigger'ı yok (fatura tarafındaki tavan
   var). Kaynak-tarafı değişmezini de veritabanına indirmek ayrı bir dilim.
3. **Faz 21'in `recordInvoicePayment`'ı** hâlâ `paid_amount`'ı doğrudan hareket ettiriyor;
   allocation yolu tercih edilen yol oldu ama eski yol kaldırılmadı (Faz 21 gate'ini bozmamak
   için). İkisinin tek yola indirilmesi ayrı bir temizlik.
4. Faz 17-21'den devam: `scripts/**`'daki 47 `::float8`, `rules.ts` biriktiricileri,
   `createCheckAction`'ın transaction dışı audit'i, çok kalemli fatura UI'ı, iade faturası akışı.

---

## Faz 23 — DONE (tahsilat riski, ödeme önceliklendirme, elle şüpheli-alacak bayrağı)

İki migration (0051-0052), sıfır yeni tablo, dört view + üç kolon. Ağırlıklı olarak Faz 19-22'nin
üzerine read-model. **Gerçek `mas_radar_dev`'e uygulanmadı.**

### KRİTİK REGRESYON ŞARTI KARŞILANDI

Planın kendi sözü: bu faz mevcut vade/gecikme mantığını **genişletir, bozmaz**.

```
phase4   PHASE4 VERIFY: ALL PASS
phase5   PHASE5 VERIFY: ALL PASS
```

`payment_instances` ve `cashflow_months` şemasına dokunulmadı; `payments`'ın `priority` ve
`flexibility_class` kolonları **okundu**, değiştirilmedi. `phase23:verify` radar kolonlarının
yerinde olduğunu ayrıca yapısal olarak kontrol ediyor.

### Bad-debt: elle, denetlenen, ve otomasyonun YOKLUĞU kanıtlanan

Bu fazda bu kolonları yazan hiçbir kural, trigger veya zamanlanmış iş yok. "90 günü geçerse
işaretle" türü hiçbir sezgi eklenmedi. CLAUDE.md'nin kaynak-doğruluk kuralı bunu insan elinde
tutuyor; 0052'nin skorları bir faturanın tahsil edilemez göründüğünü söyleyebilir, **o görüşe
göre hareket edemez.**

`phase23:verify` bunu **iki yönden** doğruluyor:
1. `src/` içinde `bad_debt_at =` yazan tek dosya `collections/engine.ts` (yorum satırları
   ayıklanarak; kolonu yalnız ANLATAN dosyalar yazar sanılmıyor).
2. Katalogda `bad_debt_at`'i güncelleyen bir PL/pgSQL fonksiyonu yok — SQL tarafından yapılacak
   bir otomasyon grep'i atlatırdı.

**Neden bayrak, neden durum değil:** `status` zaten zarar yazma için `closed`, iptal için
`cancelled` taşıyor. Şüpheli alacak ikisi de değil — hâlâ **açık** ve hâlâ tahsil edilebilir bir
faturanın üzerine konan bir değerlendirme. Görüşü kaydetmek için faturayı `open`'dan çıkarmak,
sonraki tahsilatı bir diriliş gibi gösterirdi. Gate bunu ölçüyor: işaretli fatura hem `open`
kalıyor hem de açık alacak listesinden düşmüyor.

Kısıtlar: üç kolon birlikte hareket eder, gerekçe boş olamaz (**gerekçesi ve yazarı olmayan bir
zarar yazma, imzasız bir suçlamadır**), ve iptal edilmiş faturaya bayrak konamaz.

### Deterministik sezgi — model değil, adlandırılmış kural tablosu

**Beklenen tahsilat tarihi:** karşı taraf **en az 3** fatura tahsil etmişse gerçekleşmiş
ortalaması; yoksa vade; o da yoksa düzenleme+30 ve **açıkça "fallback" etiketi**. Üç bilinçli
bir alt sınır — tek faturalık ortalama anekdottur ve onu tahmin diye sunmak tam da kaçınılması
gereken sahte güvendir. Her sonuç `basis` alanıyla hangi kuralın çalıştığını söylüyor; arayüz de
tarihi değil tarih+gerekçeyi gösteriyor.

**Tahsilat olasılığı** taban 0.95'ten adlandırılmış ayarlamalarla iniyor ve **onu üreten
sinyalleri birlikte döndürüyor.** Gerekçesiz bir sayı eyleme dönüştürülemez: operatör 0.45'in
"bu müşteri yavaş" mı "geçen hafta işaretledik" mi demek olduğunu ayırt edemez, ve ikisi zıt
tepkiler gerektirir. Şüpheli-alacak bayrağı her şeyi bastırır ama **sıfıra indirmez** — işaretli
alacak da tahsil edilir ve sert sıfır, listeye "denemeyi bırak" derdi (gate ölçtü: 0.05).

**Yoğunlaşma eşiği 0.40** — deponun başka yerlerinde zaten kullanılan sayı (radar/rules.ts,
financing/rules.ts), neredeyse aynı şeyi ifade eden ikinci bir sayı değil.

### Ödeme önceliği: mevcut modülü besler, yenisini icat etmez

Sıralama girdileri `payments`'ın zaten taşıdığı `flexibility_class` (critical/flexible/optional)
ve `priority` (low/normal/high/critical) — introspection'la doğrulandı, plandan tahmin edilmedi.
Paralel bir öncelik şeması "önce neyi ödeyeceğiz" sorusuna iki cevap demek olurdu.

View bir **SIRA** üretir, karar değil: nakit bakiyesini bilmez, kesme noktası okuma anında
TypeScript'te uygulanır. Hangi tedarikçinin ödenmeyeceğine SQL'de sessizce karar veren bir view,
iş kararını yanlış yerde verirdi.

**Karşılanamayan kalem gizlenmez, işaretlenir** — sığmayanları listeden düşürmek sorunu değil
yalnız görüntüsünü ortadan kaldırırdı. **Tutarı bilinmeyen kalemler kümülatif toplama katılmaz
ve asla "karşılanıyor" sayılmaz**; sıfır saymak nakdin gittiğinden daha uzağa gittiğini
göstermek olurdu — bu uygulamanın yapabileceği en tehlikeli yuvarlama. Takvim de tutarsız
yükümlülükleri ayrıca sayıyor: dört tutarsız yükümlülüğü olan gün ucuz bir gün değildir.

### Gate yazarken düzeltilen iki şey (ikisi de kendi kontrolümde)

1. **`pg_get_functiondef()` aggregate'lerde patlıyor.** Trigger taraması `public` şemasındaki
   tüm fonksiyonları dolaşıyordu ve `array_agg` üzerinde hata verdi; `prokind='f'` ile düz
   fonksiyonlara daraltıldı.
2. **`amount_status='unknown'` diye bir değer yok** — şema eksik tutarı `'missing'` diye
   adlandırıyor. Sondayı şemaya uydurdum; kısıt doğruydu, varsayımım yanlıştı.

Ayrıca yazar taraması yorum satırlarını ayıklıyor, yoksa kolonu yalnız **anlatan** dosyalar
(migration açıklamaları, bu gate'in kendi başlığı) yazar sanılırdı.

### Gate sonuçları

| Adım | Sonuç |
| --- | --- |
| `pnpm lint` | exit 0 (1 uyarı: `analytics-chart.tsx`, önceden var) |
| `pnpm typecheck` | exit 0 |
| `pnpm test` | **500/500** (470 + 30 yeni) |
| `pnpm db:verify` | ALL ASSERTIONS PASSED |
| `db:migrate:verify` | 49/49 (ledger 52 migration) |
| `db:constraints:verify` | 65/65 |
| `db:transitions:verify` | 167/167 |
| `db:reconciliation:verify` | 77/77 |
| `pnpm db:roles:verify` | 8/8 |
| `pnpm import:real` | ALL PASS |
| **`pnpm phase4:verify`** | **ALL PASS (kritik regresyon şartı)** |
| **`pnpm phase5:verify`** | **ALL PASS (kritik regresyon şartı)** |
| phase3 + phase6…phase14e (18 script) | 18/18 |
| `pnpm build` | exit 0 |
| phase16/17/18 | 18/18 · 10/10 · 12/12 |
| phase19/20/21/22 | 26/26 · 31/31 · 35/35 · 35/35 |
| `pnpm phase23:verify` | **29/29** — beş koşunun beşinde de (üçünde katalog karıştırılarak) |

### GERÇEK VERİTABANINA UYGULANMADI

Commit öncesi teyit: `schema=0034 · payments=19 · bad_debt kolonu=YOK`. Doğrulamanın tamamı
`mas_radar_verify` ve `mas_radar_p23` disposable veritabanlarında yapıldı.

### Faz 24'e devredilen açık noktalar

1. **Olasılık ağırlıkları ölçüm değil, başlangıç noktası.** Adlandırılmış sabitler olarak
   duruyorlar ki değiştirmek görünür bir diff olsun; gerçek tahsilat verisi biriktikçe
   kalibre edilmeleri gerekir — ama kalibrasyon da elle ve gerekçeli olmalı, öğrenilen bir
   ağırlık olarak değil.
2. **Şüpheli alacak muhasebeleştirilmiyor** — bayrak bir görüştür, karşılık ayırma (provision)
   kaydı üretmez. Gerçek karşılık muhasebesi ayrı bir faz.
3. Faz 17-22'den devam: `scripts/**`'daki 47 `::float8`, `rules.ts` biriktiricileri,
   `createCheckAction`'ın transaction dışı audit'i, kaynak-tarafı dağıtım tavanının trigger'sız
   oluşu, Faz 21'in `recordInvoicePayment`'ının allocation yoluna indirilmesi.

---

## Faz 23 düzeltmesi — `phase23:verify` ortam bağımlıydı: hem sahipsiz veri hem tanımsız beraberlik

Bağımsız doğrulamada bulundu. Faz 23 commit'i (`6e1e269`) yazarın makinesinde **29/29** veriyordu;
doğrulayan aynı script'i kendi ortamında çalıştırdığında **28/29** aldı — ve Faz 20'nin aksine
bu bir kerelik şans değildi: **üç koşuda da aynı** şekilde düştü.

```
- kritik yükümlülük esnek olanın ÖNÜNDE sıralanıyor: loan_installment:-30 check:-30 invoice:90
```

### Kök neden — İKİ bağımsız kusur, ikisi de sondada, view'de değil

Sonda şunu yapıyordu: `payment_priority_queue`'yu 2026-03 penceresinde sorgula, `order by
priority_rank` ile sırala, **ilk satırın** `check` olduğunu iddia et.

**(a) SAHİPSİZ VERİ.** Pencere, veritabanında zaten ne varsa onu da yakalıyordu. Tam gate
zinciri koşulduğunda gerçek kredinin **48 taksiti** geride kalıyor (2024-10 → 2028-09) ve
bunlardan biri **2026-03-18** vadeli. Yani sonda, kendi kurduğu satırları değil üretim
fixture'larını ölçüyordu.

**(b) TANIMSIZ BERABERLİK.** Çek ve kredi taksiti **ikisi de** critical/critical, dolayısıyla
ikisi de aynı `priority_rank` değerini alıyor; `order by priority_rank` eşit anahtarlar arasında
hiçbir sıra garanti etmez. `[0]`'a hangisinin geleceği şanstı — bende `check`, doğrulayanda
`loan_installment`. **Beraberliğin kendisi DOĞRU** (iki kritik yükümlülüğün önceliği gerçekten
eşittir), dolayısıyla aralarında bir sıra iddia etmek tasarımın hiç vaat etmediği bir şeyi iddia
etmekti.

Doğrulayanın tarih-görelilik şüphesi de haklıydı ve (b)'yi **seyrekleştirmiyor, ağırlaştırıyor**:
`priority_rank` içinde `least(greatest(due_date - current_date, -30), 60)` var, yani vadesi 30
günden fazla geçmiş HER kalem aynı −30'a kırpılıyor ve beraberlik istisna değil kural hâline
geliyor.

### Neden bende geçti — ortam farkı bulundu ve ölçüldü

İki farklı disposable DB kullanmışım:
- Determinizm koşularında `mas_radar_p23` — bootstrap + migration + `seed.sql`, **import yok**,
  dolayısıyla hiç kredi taksiti yok → pencerede tek kritik kalem (çek) → beraberlik hiç oluşmadı.
- Tam zincir koşusunda `mas_radar_verify` — 48 taksit vardı, beraberlik oluştu, ama `[0]`'a
  tesadüfen `check` geldi.

Yani "5/5 koşu 29/29" doğruydu ama **yanlış soruyu** ölçüyordu. Kusur ilk koşuda görünmeliydi;
görünmemesi test kurgusunun sahipsiz veriye bağımlı olmasındandı.

**Kusur birebir yeniden üretildi:** `pnpm db:verify` ile kurulan temiz DB'ye 2026-03-18 vadeli
tek bir kredi taksiti eklendiğinde script **5 koşuda 5 kez** doğrulayanın gördüğü çıktının
aynısını verdi.

### Düzeltme — konum değil DEĞİŞMEZ ölçülüyor

İki bağımlılık da kaldırıldı:

1. **Sonda kendi yükümlülüklerini 2099 tarihlerinde kuruyor** — bu depodaki hiçbir gerçek,
   seed veya fixture satırının işgal edemeyeceği bir aralık. Aynı düzeltme takvim sondalarına da
   uygulandı (2026-03-02 → 2099-03-02, 2026-04-10 → 2099-04-10), çünkü
   `payment_calendar_extended` güne göre topluyor ve aynı gündeki sahipsiz satırlar toplamı
   kirletirdi.
2. **İddia satır sırası değil SIRA DEĞERİ karşılaştırması:** aynı vadede kritik bir
   yükümlülüğün `priority_rank`'i esnek olanınkinden **kesin küçük** olmalı. Bu değişmez,
   kırpma nedeniyle mutlak değerler kayarken bile doğru kalır.
3. **Beraberliğin tasarım gereği olduğu artık POZİTİF olarak test ediliyor:** aynı güne bir çek
   ve bir kredi taksiti konuluyor ve ikisinin **tek bir** `priority_rank` değeri paylaştığı
   doğrulanıyor. Böylece gelecekte biri "beraberliği kıralım" diye sıralamaya keyfi bir ikincil
   anahtar eklerse gate bunu yakalar.

Kontrol sayısı 29 → **30**.

### Determinizm kanıtı — üç farklı ortam, 11 koşu

| Ortam | Koşu | Sonuç |
| --- | --- | --- |
| Kusuru üreten kirli DB (2026-03-18 vadeli taksit eklenmiş) | 5 | **5/5 → 30/30** |
| `pnpm db:verify` ile tertemiz DB (0 taksit) | 3 | **3/3 → 30/30** |
| Tam zincir sonrası (48 gerçek taksit, 1'i 2026-03 penceresinde) | 3 | **3/3 → 30/30** |

Üçüncü satır kritik: kusurun oluşması için gereken tam koşul (pencerede gerçek bir kredi
taksiti) mevcutken bile geçiyor.

### Alınan ders (Faz 20/21/22'nin kuralına eklenen madde)

Depoda zaten şu kural vardı: *bir sonda vakumda başarılı olabiliyorsa hiçbir şey kanıtlamaz.*
Bu bulgu ikinci bir maddeyi ekliyor:

**Bir sonda, kendi kurmadığı satırları kapsayan bir sorgu üzerinden iddiada bulunmamalı; ve
sıralama iddiaları satır konumuna değil, sıralama ANAHTARININ kendisine dayanmalı** — `ORDER BY`
eşit anahtarlar arasında hiçbir şey garanti etmez, dolayısıyla beraberliğin mümkün olduğu her
yerde `rows[0]` tanımsız bir cevaptır.

### Gate sonuçları (düzeltmeden sonra, tam zincir yeniden koşuldu)

| Adım | Sonuç |
| --- | --- |
| `pnpm lint` | exit 0 (1 uyarı: `analytics-chart.tsx`, önceden var) |
| `pnpm typecheck` | exit 0 |
| `pnpm test` | 500/500 |
| `pnpm db:verify` | ALL ASSERTIONS PASSED |
| `db:migrate:verify` | 49/49 |
| `db:constraints:verify` | 65/65 |
| `db:transitions:verify` | 167/167 |
| `db:reconciliation:verify` | 77/77 |
| `pnpm db:roles:verify` | 8/8 |
| `pnpm import:real` | ALL PASS |
| **`pnpm phase4:verify`** | **ALL PASS (regresyon şartı hâlâ karşılanıyor)** |
| **`pnpm phase5:verify`** | **ALL PASS (regresyon şartı hâlâ karşılanıyor)** |
| phase3 + phase6…phase14e | 18/18 |
| `pnpm build` | exit 0 |
| phase16/17/18 | 18/18 · 10/10 · 12/12 |
| phase19/20/21/22 | 26/26 · 31/31 · 35/35 · 35/35 |
| `pnpm phase23:verify` | **30/30** (üç ortamda, toplam 11 koşu) |

`mas_radar_dev` yine hiç değiştirilmedi (şema 0034).

---

## Faz 24A — DONE (Onay/Maker-Checker varlığı, kural yapılandırması, iki legacy sistemin birleştirilmesi)

**migration 0053-0055 · `src/lib/approvals/{rules,rules.test,engine}.ts` · `/data/approvals` ·
`scripts/phase24a-verify.ts` (39/39, 3 ardışık koşuda aynı)**

### Önce ölçtüm, sonra taşıdım

Koordinatör bu fazın Faz 18 benzeri bir refactor riski taşıdığını söyledi ve haklıydı. İki mevcut
sistemin davranışını introspection + kod okumasıyla çıkarmak, tasarımın tamamını belirledi:

- **Hiçbirinde transition guard yok.** Altı gate scripti statüyü keyfî sıçratıyor
  (`phase3`→accepted, `phase4`/`phase5`/`phase12a`/`phase13a`→resolved), satırın o an ne olduğuna
  bakmadan. Bu kolonlara guard eklemek altı doğrulanmış gate'i ilk sıçramada kırardı — yani 0027
  hatasının tam bilgiyle tekrarı. **Guard eklemedim.** Bunun yerine, legacy bir sıçrama yeni
  tablonun guard'ını ihlal edecekse köprü yeni bir onay **turu** açıyor.
- `external_assumptions.reviewed_at` yalnız `approved`'da taşınıyor, diğer durumlarda korunuyor —
  ve bu `external_assumptions_check1` için yük taşıyan bir semantik. Korundu, testle çivilendi.

Birleştirme "iki çalışan durum makinesini yeniden yazmak" değil: `approvals` tek Onay **varlığı**
oldu, iki legacy sistem de ilk günden onu besliyor. Üçüncü bir çeşit kalmadı.

### İki gerçek hata — ikisi de legacy yazımını İPTAL ETTİRDİ

Bunları ayrıca yazıyorum, çünkü ikisi de fazın merkezî vaadini (hiçbir mevcut yazım yolu bozulmaz)
fiilen çiğnedi ve **yalnız `approvals`'a bakan bir doğrulama ikisinde de memnun kalırdı**.

**1. `record "old" has no field "review_status"`.** Köprü fonksiyonu ilk sürümde
`case when v_subject_table='mapping_reviews' then old.status else old.review_status end` yazıyordu.
PL/pgSQL alan aramasını, hangi CASE dalının seçileceğine bakmadan gerçek rowtype'a karşı çözüyor;
`mapping_reviews` için `old.review_status` yok ve exception AFTER trigger'dan dışarı taşıp
**legacy INSERT'i öldürdü**. NEW/OLD artık ayrı `if` dallarında, tek bir ifadenin içinde değil.

**2. `approvals_decision_consistency` ihlali.** Kısıtın ilk hâli her karar için isimli bir karar
verici istiyordu (`(decided_at is not null) = (decided_by is not null)`). Altı gate scripti
`mapping_reviews`'ı **anonim** çözüyor — `set status='resolved', reviewed_at=now()`, kullanıcı yok —
ve köprü `decided_at` yazıp `decided_by`'ı boş bırakınca kısıt patladı, **legacy UPDATE iptal oldu**
(`legacy=open`, `resolved` denenmesine rağmen).

İkincisinin çözümü mekanik değil, bir doğruluk kararıydı: bu geçmişi boş bir karar vericiyle doğru
temsil etmek mi, yoksa kısıtı sağlamak için bir aktör **uydurmak** mı? Faz 19'un arşiv motorundan
sabit kodlanmış "Yerel kullanıcı" fallback'i tam da bunun için kaldırılmıştı. Kısıt gevşetildi:
`decided_at` karara bağlı kalıyor, `decided_by` boş olabiliyor ve boş olması "bu karar
maker-checker akışını öncelemiş ya da atlamıştır" demek. Motor üzerinden verilen her karar
vericisini isimlendiriyor ve `phase24a:verify` bunu **tablodan değil motordan** talep ediyor
(kaynak kodu üzerinde yapısal kontrol). Ekranda da boş karar verici "— (legacy kayıt)" olarak
görünüyor, doldurulmuş bir isim olarak değil.

### Üç gate dersi baştan uygulandı

Faz 20/22/23'te pahalıya öğrenilen üç kural bu script'e sonradan eklenmedi, ilk satırdan itibaren
içindeydi:

1. **Yapısal hedefleme.** `approvals.status` CHECK'i `conkey` üzerinden (kısıtladığı kolondan)
   bulunuyor ve aday sayısının **tam 1** olduğu ayrıca kontrol ediliyor. `like '%status%'` Faz
   20'de bozuk bir kontrolü geçirmişti.
2. **Boşlukta geçen kontrol yok.** Her probe kendi satırlarını kuruyor, her negatif kontrolün bir
   pozitif kontrolü var: aynı kullanıcı onaylayamıyor **ve** farklı kontrolör onaylayabiliyor;
   `approval_steps` UPDATE/DELETE/TRUNCATE engelli **ve** INSERT çalışıyor; eşik CHECK'i iki yönlü
   **ve** sıfır eşik geçerli.
3. **Sıralama anahtar DEĞERİYLE.** Kuyruk sırası `sort_key` değerleri karşılaştırılarak
   doğrulanıyor, satır konumuyla değil — ve `approved`/`rejected` beraberliği **pozitif olarak**
   test ediliyor (tasarım gereği eşit öncelikli).

12 sıralı geçiş çiftinin tamamı gerçek satırlar üstünde deneniyor: 5 kabul, 7 ret, allow-list'le
birebir. Dört durumun her birinde kendine-geçişin no-op olduğu ayrıca kontrol ediliyor.

### Birim testte kendi hatam

`rules.test.ts`'e "float'ın yanlış hesaplayacağı bir değerde kural tetiklenir" diye bir test
yazdım ve **test yanlıştı, kod doğruydu** — Faz 21'deki hatanın aynısı. `99999.98 + 0.01 + 0.01`
float'ta 99999.999999999985 ediyor; bu gerçekten eşiğin altında, dolayısıyla kural haklı olarak
tetiklenmiyor. Kusur yukarıda, toplamada. Testi dürüst hâline çevirdim: aynı parçalar float
toplanınca eşiği **geçemiyor**, `sumDecimal` ile toplanınca geçiyor. Bu arada `RuleInput.amount`
tipini `NumericInput`'a genişlettim — pg'nin numeric'i string döndürdüğü yerde araya hiç float
girmesin diye.

### Kalan sınırlar

- Onay kuralları tanımlı ve `evaluateRules` ile okunuyor; **kuralları fiilen tetikleyen çağrı
  noktaları** (fatura/ödeme/IBAN/cari yaratımında otomatik onay talebi açmak) bu fazın kapsamında
  değil — `approvals` varlığı ve workflow'u kuruldu, entegrasyon Faz 24B/28'e ait.
- `invoice_requires_approval` ve `payment_requires_approval` pasif geliyor (gerekçe 0054'te).

---

## Faz 24B — DONE (beş katmanlı rol matrisi, gerçek DB rolleri, satır-seviyesi RLS)

**migration 0056-0058 · `src/lib/authz/{matrix,context}.ts` · `src/lib/db.ts` iki havuz ·
`scripts/db/roles-rls-verify.ts` (29/29, 3 ardışık koşuda aynı) · 58 blanket politika → 225
rol-farkında politika**

Planın en geniş kapsamlı fazı ve koordinatörün uyardığı gibi en yüksek regresyon riskini taşıyanı.
Bu yüzden aşağıda ne çalıştığından çok **ne kırıldığı** yazıyor.

### Mimari karar: gerçek DB rolleri, ve onları güvenli kılan PG16 özelliği

Uygulama tek login rolüyle bağlanıyor, yani veritabanı kendi başına izleyiciyi yöneticiden
ayıramaz. Seçenekler: politikaların okuduğu bir GUC, ya da bağlantının içine geçtiği gerçek
roller. Gerçek roller seçildi — `to <role>` planlayıcıda, her ifadede çalışır; unutulabilecek bir
ifade yoktur.

Tuzak şu: politikalar rol **üyeliğine** göre eşleşiyor, yani düz bir grant uygulamayı beş katmanın
da üyesi yapar ve **birleşim** yetkisi verirdi — kalıcı admin, fazın tam tersi. PostgreSQL 16
üyeliğin iki yarısını ayırıyor: `grant ... with inherit false, set true`. **Tasarıma bağlanmadan
önce bu kümede ölçtüm**: geçişsiz uygulama bağlantısı sıfır satır görüyor, `set role` sonrası
katman politikaları uygulanıyor, `reset role` sonrası yine sıfır. Sonuncusu havuzlanmış bağlantıda
güvenliğin temeli.

### `operator → finance_manager`, `finance_operator` DEĞİL

İsim benzerliği yanıltıcı. Bugünkü `operator` onay da veriyor; yeni matriste `finance_operator`
veremiyor. `operator → finance_operator` eşlemesi her mevcut hesaptan günlük kullandığı bir yetkiyi
**sessizce alırdı**. Bir migration operatörün seçtiği kısıtlamaları ekleyebilir, hesabın zaten
sahip olduğunu sessizce alamaz. Daraltma güvenlik ekranından, insanın kararıyla, denetim kaydına
düşerek yapılır.

### Dört gerçek kırılma — ve hepsini farklı bir kontrol yakaladı

**1. `users_role_check`: tüm zincir çöktü (28 gate'ten 26'sı).** `seed-system-actor.ts`,
`seed-admin.ts` ve üç phase gate'i hâlâ `role='operator'` yazıyordu; yeni CHECK reddetti. Enum'u
genişletirken `src/` içini taradım ama `scripts/` içini taramadım — enum genişletmesinin yazarları
yalnız uygulamada değil.

**2. ANCHORS 0007 çapası: `LEDGER_EMPTY_RECOVERY` hard-fail.** Çapa
`payments_authenticated_all` politikasını arıyordu; 0058 onu kasıtlı düşürüyor. Sonuç: 0007'nin
açıkça çalıştığı bir DB'de "çalışmamış" — ve on dokuz geçen çapa arasında bir kalan tam olarak
`INCONSISTENT_PARTIAL`, yani herhangi bir 24B veritabanının ham geri yüklemesi migrate etmeyi
reddederdi. **Koordinatörün "ANCHORS'a dokunma" kuralı ekleme yapmayı yasaklıyor; burada mevcut
bir çapa bu fazın meşru bir değişikliğiyle geçersizleşti.** 0007 iki şey yapıyor: RLS'i açıyor ve
blanket politikaları kuruyor; 24B yalnız ikincisinin yerine geçiyor. Çapa artık kalıcı yarıyı
(`payments.relrowsecurity`) parmak izi alıyor — aynı soru, hem 24B öncesi hem sonrası doğru cevap.
**Dizi uzamadı**: aynı sayıda, aynı versiyonlar. Bunu ayrıca raporda işaretledim.

**3. `getPool().end()` artık havuzun yarısını kapatıyordu.** Tek havuzu ikiye böldüm; disposable
DB'sini düşürmeye çalışan `db:transitions:verify` "başka oturum kullanıyor" hatası aldı — hiç
istemediği raw havuz açık kalmıştı. Çağıran için tek bir veritabanı katmanı var, o yüzden `end`
artık ikisini birden kapatıyor.

**4. `pnpm start` HİÇ AÇILMADI — ve bunu yalnız gerçekten çalıştırmak gösterdi.** DB gate'lerinin
29/29'u bunu yakalayamazdı: `prepare-runtime.ts` ilk istekten önce çalışıyor, oturum yok, dolayısıyla
katman yok, dolayısıyla hiçbir yazma hakkı yok. İki ayrı hata olarak patladı (önce `audit_logs`,
sonra `users`) ve çözümü mekanik değil kavramsaldı: **arka plan işleri gerçek bir kategoridir ve
kimliklerini sessizce miras almak yerine açıkça istemeliler.** `runAsSystem()` katmanı açıkça
söylüyor (`finance_manager` — üretim için yeterli, ayar/kural/hesap değiştirmek için kasıtlı olarak
yetersiz); sistem hesabının kendisini sağlamak ise uygulamanın **kendi** servis hesabını bakımı
olduğu için Faz 15'in `mas_radar_app` politikası üzerinden geçişsiz raw havuzda kalıyor.

### Gate kendi hatasını iki kez yakaladı

- **Kod matrisi ile migration çeliştiğinde migration haklıydı.** Kod `finance_approver`'a
  `approvals` INSERT'i veriyordu; 0058 vermiyordu. Doğru olan 0058: talep açmak veri girişidir ve
  kararını verdiği talepleri kendisi açabilen bir onaylayıcı yalnız isimde maker-checker'dır. Aynı
  şekilde tek bir `auth` sınıfı admin'in `sessions`'a INSERT edebildiğini iddia ediyordu; veritabanı
  (doğru olarak) reddediyordu — sınıf `auth_users`/`auth_sessions` olarak ayrıldı.
- **Kendi boşlukta geçen testim.** İlk koşuda dört kontrol "reddedildi" dedi; gerçek "reddedilecek
  bir şey yoktu" idi (`payments` boştu, tek kullanıcı vardı). Faz 20/23'ün kuralını onurlandırmak
  için yazılan gate, tam o kurala takıldı. Artık kendi fixture'ını kuruyor.

### RLS semantiğiyle ilgili, gate tasarımını belirleyen ölçüm

Politikası olmayan bir UPDATE/DELETE **hata fırlatmıyor** — PostgreSQL sessizce sıfır satır
etkiliyor. İstisna bekleyen bir gate hiçbir şey zorlamadan geçerdi. Bu yüzden yazma kontrolleri
**etkilenen satır sayısıyla** yargılanıyor. INSERT ise farklı: RLS reddi `42501` ile ve **NOT
NULL'dan ÖNCE** geliyor (ölçüldü), bu da `insert ... default values` ile 61 tablonun tamamı için
tek satır bile yazmadan gerçek bir INSERT verdicti veriyor — 5 katman × 61 tablo = **305
kombinasyon** tek kontrolde.

### Satır seviyesi: dürüstçe kapsanmış

61 tablonun yalnız 8'inde sahiplik kolonu var (ölçüldü). Diğer 53'e `created_by` ekleyip NULL
doldurmak, sahiplik politikası altında hiçbir operatörün hiçbir geçmiş kaydı düzenleyememesi
demekti — sıkılaştırmanın değerinden büyük bir erişim kaybı. Sahiplik verinin desteklediği yerde:
`action_items`/`invoice_allocations`/`scenarios` (operatör yalnız kendi kaydı) ve `approvals`
(onaylayıcı kendi talebini güncelleyemez). Kalanı komut granülerliğinde — hâlâ gerçek ve test
edilmiş bir kısıt.

### Giriş akışının bozulmadığının kanıtı

- `users_deny_all`/`sessions_deny_all` + `users_app_runtime`/`sessions_app_runtime` dördü de
  **aynen** duruyor; gate hedef rolleriyle birlikte kontrol ediyor.
- Katmana geçmemiş bağlantı `users`'ı **okuyabiliyor** (pozitif kontrol) ama `payments`'ı
  okuyamıyor — giriş yolu çalışıyor, iş tabloları kapalı.
- **Gerçek sunucu smoke testi:** `pnpm start` açıldı; admin oturumuyla `/overview`, `/payments`,
  `/data/approvals`, `/system/security`, `/cashflow` hepsi 200; viewer oturumuyla veriler görünüyor,
  `/system` nav'dan düşüyor, `/system/security` admin içeriği vermiyor.

### Kalan sınırlar

- Rol-bazlı navigasyonun yalnız **backend** yarısı yapıldı (`navigationFor`/`canSeeModule`); UI
  tarafı plana göre Faz 36.
- `settings` tüm katmanlarca okunabiliyor (eşikler neredeyse her ekranı besliyor), yalnız admin
  yazabiliyor. Sır barındırmıyor — token'lar ortam değişkenlerinde.

---

## Faz 25 — DONE (Tahsilat Merkezi: ödeme sözü, kırılan söz tespiti, müşteri tahsilat puanı)

**migration 0059-0061 · `src/lib/collections/{promises,promises-engine}.ts` · `/finance/promises` ·
`scripts/phase25-verify.ts` (51/51, 4 ardışık koşuda aynı)**

Fazın tamamı tek bir ayrım üzerine kurulu: **bir söz, bir alacak değildir.** `promise_to_pay`
muhasebe ağırlığı taşımıyor — hiçbir faturanın bakiyesini değiştirmiyor, üzerine dağıtım
yapılamıyor. Var olma sebebi söylenen ile geleni arasındaki farkın ölçülebilmesi.

### İkinci bir görev modeli icat edilmedi

Koordinatör `action_items`'ın gerçek şemasını okumamı, uydurmamamı istedi. Okudum ve tasarımı o
belirledi: tablo zaten `related_entity_table`/`related_entity_id` genel bağını ve **açık görev
varken ikincisini engelleyen kısmi unique indeksleri** taşıyor — kırılan söz işinin idempotent
olması için gereken şeyin tam olarak kendisi. Yani takip işi bir `action_item`; 0060 yalnız tek
bir `source_type` değeri ekliyor (`collection`), üç değil, çünkü neyle ilgili olduğunu zaten
`related_entity_*`, aciliyeti zaten `severity` söylüyor.

Sözün **kendisi** ayrı bir tablo, çünkü bir görev değil: karşı tarafı, tutarı, gerçekle
karşılaştırılan bir tarihi ve bir puana beslenen bir sonucu var. `action_item` olarak modellemek
hepsini `note` alanına sıkıştırmak olurdu.

### Atlanması en kolay geçiş: `broken → kept`

İzin listesi dört geçiş: `pending→kept`, `pending→broken`, `pending→cancelled` ve **`broken→kept`**.
Sonuncusu tasarımın en kolay kaçırılan yeri: **geç ödeme, kırılan bir sözün olağan sonucudur**,
istisnası değil. Bu geçiş olmasaydı üç gün geç ödeyen müşteri sonsuza kadar `broken` donar ve bu
tabloya dayanan her puan onu kalıcı olarak olduğundan kötü gösterirdi. `kept`/`cancelled` terminal —
karara bağlanmış bir sözü yeniden açmak tahsilat geçmişini sessizce yeniden yazmaktır; dürüst yol
yeni bir söz kaydetmek, ki puanın görmesi gereken de budur.

CHECK ve guard aynı migration'da (0027 dersi), ve gate 12 sıralı çiftin tamamını gerçek satırlar
üstünde deniyor: 4 kabul, 8 ret, üstelik koddaki `canTransition` ile **birebir aynı** olduğu ayrıca
kanıtlanıyor.

### İşin tüm doğruluğu tek karakterde: `<` mi `<=` mi

Kırılan söz tespiti **bugün** vadesi olan sözü kırılmış saymıyor — paranın günün geri kalanı var.
Sabah 09:00'da "kırıldı" diyen bir iş, henüz olmamış bir başarısızlığı kaydeder. Hem SQL hem
`isBroken()` bu sınırı `<` ile kuruyor ve gate ikisini de ayrı ayrı, 2099 tarihli kendi
fixture'ıyla sınıyor.

### Otomatik yazmaya neden İZİN var (şüpheli alacakta yokken)

CLAUDE.md şüpheli alacağı insana ayırıyor; bu iş ise otomatik yazıyor. Çelişki değil, çünkü ikisi
farklı türde olgu:

- **şüpheli alacak** — paranın asla gelmeyeceği **yargısı**. İnsan ister.
- **kırılan söz** — bir tarihin geçtiği ve paranın gelmediği **gözlemi**. Takvim yeter; kimsenin
  görüşü işin içinde değil ve olgu bu iş çalışsa da çalışmasa da zaten doğru.

İş yine de hiçbir mali kaydı değiştirmiyor (gate `invoices/payments/payment_instances/checks`
üzerine UPDATE olmadığını kaynak seviyesinde kontrol ediyor) ve her kayıt `automated: true` ile
denetleniyor. Otomatik karar bir aktör **uydurmuyor**: `resolved_by` null kalıyor,
`resolution_source='auto_detection'` hangi mekanizmanın karar verdiğini söylüyor — Faz 24A'nın
kararının aynen tekrarı.

### Ölçtükten sonra değişen üç şey

**1. `reminders.channel` zaten `email` içeriyordu.** 0006'dan beri. Faz 25 kanal değerini değil
**taşıyıcıyı** ekliyor; 0060'ta bu yüzden bilerek ALTER yok ve yokluğun bir bulgu olarak okunması
için migration içine yazıldı.

**2. `targetKindOf()` bir fallthrough'du.** Tanımadığı her tablo için `'loan_installment'`
dönüyordu — üç tür varken zararsız, ama dördüncü eklendiği anda **her faturayı ve her sözü sessizce
kredi taksiti diye dosyalardı**. Artık açık eşleme, bilinmeyen için `null`.

**3. `OPEN` tek bir kümeydi (`unpaid`/`partial`).** Bu kelimeler fatura ve söz sözlüğünde yok
(açık fatura `open`, bekleyen söz `pending`). Tek kümeyi koruyup yeni türleri eklemek her faturayı
ve her sözü **kalıcı olarak uygunsuz** yapardı: hiçbir şey hatırlatmayan bir hatırlatma motoru,
fark edilmesi en zor arıza türü. Küme artık tür başına.

### Bulunduğu gibi bırakılan eksik

`check` ve `loan_installment` hatırlatma türleri 0006'dan beri CHECK'te izinli ama **hiçbir zaman
hedef yükleyicileri olmadı** — yani bu türdeki kurallar her zaman sıfır teslimat üretti. Faz 25
tahsilatın ihtiyaç duyduğu iki türü (`invoice`, `promise_to_pay`) ekliyor; çek ve kredi taksitini
bağlamak finansman işidir ve bu faza kaçak sokulmadı. Eksik `scheduleReminders` içinde yorumla
kayıtlı.

### E-posta: gerçek SMTP kurulmadı

Telegram deseni birebir izlendi — env ile adlandırılmış HTTP uç noktası, tanımsız/erişilemezken
**fırlatmayan** başarısız `DeliveryResult`, hatada API anahtarı yok. `nodemailer` eklenmedi (gate
`package.json`'da olmadığını kontrol ediyor): burada hiç çalıştırılamayacak bir kod yolu için bir
bağımlılık ve sızacak bir sır eklemek olurdu. `mockTransport` artık kanalı **parametre** alıyor —
`"telegram"` sabit kodluydu ve e-posta yolu var olduğu anda onu test edilemez kılardı.

### Puan: adlandırılmış kurallar, ve "geçmişi yok" ≠ "kötü"

100'den başlayıp adlandırılmış kurallarla düşüyor; ad `score_reasons` içinde sayıyla birlikte
taşınıyor (Faz 23 kuralı). Sebebi pratik: "82, çünkü iki söz kırıldı ve en eski fatura 47 gün
gecikmiş" bir müşteriye savunulabilir, çıplak 82 savunulamaz.

`kept_ratio` hiç söz çözülmemişse **NULL**, 0 değil — hiç söz vermemiş müşteri, sözünü tutmayan
müşteri değildir; 0'a çevirmek kanıt yokluğunu kanıt saymak olurdu. `cancelled` orandan dışlanıyor:
geri çekilmiş söz, müşterinin ödeyip ödemediği hakkında hiçbir şey söylemez. Gate ikisini de
pozitif olarak sınıyor (söz geçmişi olmayan cari 100 puan alıyor).

### Faz 24B rol matrisine entegrasyon (koordinatörün ayrıca istediği doğrulama)

`promise_to_pay` blanket politikayla değil, 24B'nin beş katmanlı modeliyle yazıldı; sınıf 0058'in
kendi mantığından seçildi: **operational** (payments/invoices ile aynı). `src/lib/authz/matrix.ts`
aynı sınıflandırmayı taşıyor. `db:roles-rls:verify` artık **62 tablo / 310 (katman × tablo) INSERT
kombinasyonu** görüyor ve hepsi kodla uyuşuyor; yeni tabloda `authenticated` hedefli politika
sayısı sıfır.

**Kasıtlı olarak owner-scoped değil**, `action_items`'ın aksine: tahsilat ekip işidir, para
geldiğinde telefonu kim açtıysa sözü "tutuldu" işaretleyebilmeli. Kaydı girene kilitlemek, biri
izinliyken sözlerin `pending` takılı kalması demekti.

### Kapsam dışı

WhatsApp iskeleti — implementation.md §3 açık soru #4 gereği ertelendi, eklenmedi; gate kaynak
seviyesinde eklenmediğini kontrol ediyor.

---

## Faz 25 düzeltmesi — gate'ler kendi belgeledikleri kullanım şekliyle çalışmıyordu

Koordinatör `phase25:verify`'ı script'in **kendi başındaki dokümantasyonla birebir** çalıştırdı
(`MIGRATION_DATABASE_URL=... node --import tsx scripts/phase25-verify.ts`) ve 3 kez art arda aynı
şekilde çöktü — 51/51 değil, **hiç başlamadan**:

```
Error: Ortam değişkeni doğrulaması başarısız (1 sorun):
  - DATABASE_URL: DATABASE_URL zorunlu.
    at src/lib/env.ts:87
    ... at src/lib/reminders/transport.ts:5:21
```

### Neden benim koşularımda çıkmadı

Çünkü ben her koşuda alışkanlıkla `export DATABASE_URL="$MIGRATION_DATABASE_URL"` yazıyordum.
Yani **belgelediğim yolu bir kez bile denemedim**; her zaman ikisini birden verdiğim için hata
maskelendi. Determinizmi 4 kez kanıtlamış olmam da işe yaramadı — dördü de yanlış komutla.

### Kök neden: mekanik bir "DATABASE_URL da ekle" yaması DEĞİL

`transport.ts` en üstte `import { env } from "@/lib/env"` yapıyordu. `env.ts` tasarım gereği
**modül yüklenirken** doğruluyor (Faz 15 kararı) ve `DATABASE_URL` zorunlu. Yani bir transport'u
**içe aktarmak**, yalnızca `send()` çağrıldığında okunan değerler için sert bir veritabanı
zorunluluğu getiriyordu.

Sonucun ne kadar ters olduğu kök nedeni de kanıtlıyor: **`mockTransport` — hiçbir yapılandırma
istemeden yerine geçmesi tek amacı olan bağımlılıksız test ikizi — `DATABASE_URL` olmadan içe
aktarılamıyordu.**

Ve bu Faz 25'in getirdiği bir hata değil: `scripts/phase6b-verify.ts` **Faz 6B'den beri** yalnız
`mockTransport` içe aktarıyor ve `DATABASE_URL` olmadan aynı şekilde çöküyordu. Ölçtüm, ikisini
de aynı komutla tekrar ürettim. Faz 25 hatayı üretmedi, **görünür kıldı**.

### Seçilen çözüm

Üç seçenek vardı (dokümantasyonu düzeltmek, gerçek modülü import etmemek, bağımlılığı kaldırmak).
Doğrusu üçüncüsü — ama sahte bir `DATABASE_URL` enjekte ederek değil, **gereksiz modül-yükleme
bağını kaldırarak**: `env` okuması `send()` içine, `try` bloğunun içine taşındı.

Hiçbir şey zayıflamıyor:
- `env.ts` hâlâ tek doğrulanmış kaynak — bu dosya `process.env`'e **dokunmuyor** (Faz 15'in var
  olma sebebi olan kural).
- Başlangıç doğrulaması hâlâ yapılıyor, çünkü `@/lib/db` `env`'i statik import ediyor ve her
  sunucu yolu havuzdan geçiyor.
- `import`, `send()`'in `try`'ı **içinde**: yanlış yapılandırılmış bir ortam, fırlatma değil
  raporlanan bir `DeliveryResult` hatası olarak yüzeye çıkmalı — `reminder_deliveries`'in
  `'failed'` durumunun dayandığı özellik bu.

Değişen tek gözlemlenebilir davranış: `DATABASE_URL` yokken e-posta hatası artık
"EMAIL_API_URL/EMAIL_TO tanımlı değil" yerine ortam doğrulama mesajını taşıyor. Üretimde bu yol
erişilemez (DATABASE_URL yoksa uygulama zaten açılmıyor), ve `ok:false` + sır sızdırmama
özellikleri aynen duruyor.

### Tekrarını engelleyen yapısal kontrol

`phase25:verify`'a bir kontrol eklendi: `transport.ts` `@/lib/env`'i **modül seviyesinde** import
etmemeli (ve `await import` ile tembel yüklemeli). Kontrolün gerçekten işe yaradığı **negatif
kontrolle** kanıtlandı: statik import geçici olarak geri konduğunda gate 52/52'den 51/52'ye düştü
ve hatayı adıyla bildirdi.

### Doğrulama

- `phase25:verify` **kendi belgelediği kullanım şekliyle** (yalnız `MIGRATION_DATABASE_URL`)
  **4 kez art arda 52/52**.
- `phase6b:verify` aynı komutla ALL PASS (eski gizli hata da kapandı).
- Tüm zincir regresyonsuz: phase3-25 **29/29**, db:migrate:verify 49/49,
  db:constraints:verify 65/65, db:transitions:verify 167/167, db:reconciliation:verify 77/77,
  db:legacy-repair:verify 183/183, db:roles:verify 8/8, **db:roles-rls:verify 29/29 (×3)**,
  test 564/564, build, phase16 18/18.
- Faz 24B iddiası yeniden doğrulandı: **62 tablo / 310 (katman × tablo) INSERT kombinasyonu**,
  kalan blanket politika 0.

### Ders

Bir gate'in determinizmini kanıtlamak, onu **doğru komutla** çalıştırmadıkça hiçbir şey kanıtlamaz.
Bundan sonra yeni bir gate'in ilk koşusu, kendi başlığındaki `Usage:` satırı kopyalanarak —
fazladan hiçbir ortam değişkeni verilmeden — yapılmalı.

---

## Faz 26 — DONE (Hazine/Likidite Merkezi: nakit pozisyonu, 7/30/90 gün likidite, tutarlılık kuralı)

**migration 0062-0063 · `src/lib/treasury/{rules,engine}.ts` · `/finance/treasury` ·
`scripts/phase26-verify.ts` (40/40, kendi Usage komutuyla 3+ kez art arda)**

Hazine yeni bir defter değil, mevcut veriye bakan bir mercek: 0063 hiçbir yeni kaynak veri
üretmiyor, altı read-model'in hepsi VIEW.

### Yeni standing kural ilk kez baştan uygulandı

Faz 25'in dersi bu fazda kural olarak işletildi: gate, **kendi Usage yorumundaki komutla**
çalıştırıldı —

```
env -u DATABASE_URL MIGRATION_DATABASE_URL="postgres://..." pnpm phase26:verify
```

`DATABASE_URL`'in gerçekten tanımsız olduğu ayrıca doğrulandı (`node -e` ile `UNSET` basıldı).
Yazmadan önce de import grafiği modül modül kontrol edildi: `treasury/rules.ts`,
`treasury/engine.ts`, `radar/rules.ts`, `audit.ts`, `validation`, `money.ts`, `domain-error.ts`,
`authz/matrix.ts` — hiçbiri `@/lib/env`'e ulaşmıyor, yani transport'ta olan kaza burada
tekrarlanamaz.

### Tutarlılık kuralı: sapma BİLDİRİLİR, düzeltilmez

Planın merkezî şartı tek seferlik bir assertion değil, birinci sınıf bir read-model oldu
(`treasury_cashflow_reconciliation`). İki rakam gerçekten farklı yerlerden geliyor — biri gözden
geçirilmiş aylık workbook projeksiyonu (`cashflow_months.closing_balance`), diğeri içe aktarılmış
banka hareketlerinin toplamı — dolayısıyla farklı olabilirler ve sık sık meşru şekilde olurlar.

View onları mutabık kılmıyor: ortalamıyor, birini tercih etmiyor, "düzeltmiyor". Yan yana koyup
farkı ve dört durumdan birini veriyor. Gate bunu **kasıtlı olarak uyuşmayan fixture'larla**
kanıtlıyor:

| Ay | Nakit akışı | Hazine | Sonuç |
|---|---|---|---|
| 2099-01 | 600,00 | 600,00 | `aligned`, fark 0 |
| 2099-02 | 1.600,00 | 850,00 | **`divergent`, fark −750,00 tam olarak bildiriliyor** |
| 2099-03 | 1.600,00 | (hareket yok) | `no_bank_movement`, fark **null** — sıfır sayılmıyor |

Ayrıca aynı karar TypeScript'te de hesaplanıyor (`reconciliationVerdict`) ve gate ikisinin üç ayda
da **birebir aynı** olduğunu kanıtlıyor. Tolerans 1,00 TL ve `findContinuityIssues`'un mevcut
yuvarlama payıyla aynı — hazine "yeterince yakın"ın ikinci bir tanımını icat etmiyor.

Aynı dürüstlük hesap bazında da var: `bank_cash_position` bankanın beyan ettiği bakiye ile
hareketlerden türetileni **yan yana** veriyor ve farkı hesaplıyor. Birini sessizce seçmek bu fazın
uyarıldığı arızanın ta kendisi olurdu.

### Faz 5 motoru GENİŞLETİLDİ, çatallanmadı

`treasury/rules.ts` aylık primitifleri `@/lib/radar/rules`'tan **içe aktarıyor**; `monthlyProjection`
`buildProjection`'ın döndürdüğünün aynısını döndürüyor ve birim test bunu `toEqual` ile çiviliyor.
Bölüm: `radar/rules` → **aylar** (workbook projeksiyonu), `treasury/rules` → **günler** (tarihli
yükümlülükler). Gate, import'un varlığını kaynak seviyesinde kontrol ediyor — "paralel motor icat
etme" kuralı iddia değil, test.

Ufuk penceresi **yarı açık** `[bugün, bugün+N)`: tam N gün sonraki akış bir sonraki ufka ait, iki
kez sayılmıyor; bugünkü akış dahil.

### Alarmı susturamayan söz

`treasury_liquidity_gap` iki projeksiyon birden veriyor: `projected_contracted` (yalnız
yükümlülükler) ve `projected_expected` (Faz 25 sözlerine de inanan). **Taban ihlali SÖZLEŞMELİ
rakamla yargılanıyor** — bir müşteri sözü finansman ihtiyacını gizleyememeli. `financing_need` asla
negatif değil. **Tutarı bilinmeyen söz tahmine hiç girmiyor**, sıfır olarak değil (gate: 2 sözden
yalnız tutarlı olan, toplam 5.000).

### Eşik kod değil veri, ve ikinci sayı icat edilmedi

`treasury_policies` Faz 24A'nın `approval_rules` emsalini izliyor. Varsayılan `min_cash` tabanı 0
ve bu **`settings.negative_cash_threshold_try` ile aynı sayı** — gate eşitliği kontrol ediyor.
`buffer_days` **pasif** geliyor: açmak neyin "açık" sayıldığını değiştirir, bu operatörün bilinçli
kararı olmalı.

Yaşam döngüsü kolonu yok ve bu **yapısal olarak** doğrulanıyor (§17 kural 3 gerçekten N/A —
`status`/`state`/`lifecycle` kolonu olmadığı sorgulanıyor, yalnız yorumda iddia edilmiyor).
Kapsam CHECK'i iki yönlü, sıfır taban geçerli (0 ≠ null), aynı kur için ikinci **aktif** politika
engelli (NULLS NOT DISTINCT) — olsaydı view hangi tabanı seçeceğini bilemezdi.

**RLS: `config` sınıfı**, `settings` ile aynı — her katman okur, yalnız **admin** yazar. Bilerek
yöneticiye kapalı: kendi likidite uyarılarını yöneten tabanı indirebilen bir yönetici, soruyu
cevaplamak yerine alarmı kapatıyor olurdu.

### 24B mekanizması yine iş gördü

`db:migrate:verify` 48/49'a düştü: `treasury_policies` iki satır tohumluyor ve "yeni tablolar boş"
değişmezini kırdı. Kural gevşetilmedi — tablo **adıyla beyan edildi** (Faz 24B'nin
`DECLARED_POPULATING_MIGRATIONS` listesi), böylece beyan edilmeden dolu gelen bir sonraki tablo
hâlâ bu gate'i düşürüyor. Bu, mekanizmanın tasarlandığı gibi çalıştığının kanıtı.

`db:roles-rls:verify` artık **63 tablo / 315 (katman × tablo) INSERT kombinasyonu** görüyor.

### Para birimleri asla netleştirilmiyor

Her pozisyon kur bazında gruplanıyor; hiçbir view kurlar arası toplama yapmıyor. Faz 27'ye kadar
kur tablosu yok ve burada TRY ile EUR'yu toplamak bir kur **icat etmeyi** gerektirirdi. Sessizce
kur icat eden bir hazine ekranı, iki satır gösterenden kötüdür.

---

## Faz 27 — DONE (Finansman genişletme: kredi limitleri, teminat/kovenant, vade merdiveni, FX riski)

**migration 0064-0067 · `src/lib/fx/{rules,provider,engine}.ts` · `src/lib/financing/facilities.ts` ·
`/finance/facilities` + `/finance/fx` · `scripts/phase27-verify.ts` (53/53, KENDİ Usage komutuyla
4 kez art arda)**

### `credit_facilities` neden `loans`'a bir kolon değil

Tasarımdan önce ölçüldü. `loans` **sabit planlı**: `principal`, `term_months`,
`installment_count`, `first_payment_date`, tek `installment_amount` — ve 0005 tüm amortismanı
yaratıldığı anda materyalize ediyor. Bu kolonların hepsi paranın **zaten alındığını** varsayıyor.

Limit bunu varsaymaz: bir **tavan**dır, bir yıl sıfır kullanımda durabilir ve yine de hazine
ekranındaki en önemli sayı olabilir — çünkü **henüz borçlanılmadan var olan likidite**dir. Kredi
olarak modellemek, kimsenin çekmediği para için sahte anapara ve sahte taksit planı uydurmak
olurdu. İkisi buluştuğunda (rotatiften çekim çoğu zaman planlı bir kredi yaratır) bağ
`facility_drawdowns.loan_id` nullable FK'sı — birleştirilmiş tablo değil.

`drawn`/`available` **saklanmıyor**; 0067'de view kolonu. Saklanan kullanım rakamı bir sonraki
çekimde bayatlar ve yanlışken makul görünür.

### Atlanması kolay iki geçiş

Sekiz geçişlik allow-list'te ikisi ayrıca yazılmayı hak ediyor:
- **`suspended → expired`** — dondurulmuş limit de yaşlanır; bu olmasaydı her donmuş hat vadesi
  geçtiğinde sonsuza kadar `suspended` kalırdı.
- **`expired → active`** — yenileme. Bankalar yıllık limitleri rutin yeniler; yeni satır açmak
  limiti kendi çekim geçmişinden koparırdı.

Kovenantlarda aynı sınıftan bir karar: **`waived → active`**, çünkü muafiyetler süreli verilir ve
bu geçiş olmasaydı madde kalıcı muaf görünürdü — unutulan kovenant tam olarak odur.

**Kovenant kaydı MADDEnin kendisi, ölçüm değil.** Uyum bir test sonucudur ve veri kolonu
(`last_test_date`/`last_test_result`); yaşam döngüsü değil. Aksi hâlde rutin aylık bir testin
geçip kalması maddeyi sahibi olmadığı bir durum makinesinde sürüklerdi.

### Teminat/kovenant bağı: polimorfizm DEĞİL, gerçek FK

0053 approvals polimorfik (tablo, id) kullandı çünkü yedi ilgisiz tabloyu kapsıyordu. Burada tam
iki hedef var ve ikisi de gerçek tablo — iki nullable FK + "tam olarak biri" CHECK'i. Gerçek FK
simetriden değerli: artık var olmayan bir krediyi işaret eden kovenantı engeller.

### FX: gözlem ile maruziyet farklı karakterde

`fx_rate_snapshots` bir **gözlem** ve **SALT-EKLEME** (0022 deseni + Faz 24B `evidence` sınıfı).
Sonradan düzenlenebilen bir kur, üzerine kurulan her değerlemeyi **çürütülemez** yapar — geçen
çeyreğin kârını her zaman istediğiniz gibi gösterebilirsiniz. Aynı gün + aynı kaynak için ikinci
kayıt reddediliyor; **düzeltme farklı bir kaynaktır**, üzerine yazma değil (motor bunu okunur bir
cümleyle söylüyor).

`fx_positions.amount` **işaretli** (pozitif varlık, negatif yükümlülük): net pozisyon düz bir
toplam oluyor ve hiçbir tüketici işareti unutamıyor.

### En kolay yapılacak hata: işaretsiz stres

`worst_case_20_delta` pozisyonun **yönüne** göre hesaplanıyor: uzun pozisyon kur düşünce, kısa
pozisyon kur yükselince zarar eder. İşaretsiz tek bir "±%20 etkisi" yayımlamak, hazineciye **en
büyük yükümlülüğünün en büyük tamponu olduğunu** söylerdi. Birim test her iki yönde de sonucun
zarar olduğunu çiviliyor.

Stres bantları deterministik: aynı pozisyonun sabit yüzde oynatılmış kurla değeri — her hücre
hesap makinesiyle yeniden üretilebilir. Model/volatilite/dağılım yok.

`entry_rate` yoksa kazanç **NULL**, sıfır değil: sıfır "kazanç yok" iddiasıdır, bilinmiyor iddia
değildir (Faz 26'nın `no_bank_movement` kararıyla aynı ayrım).

### Vade merdiveni: kullanılmayan limit çıkış değil

30/90/180/365. İki farklı yükümlülük aynı merdivende ama **etiketli**: taksit hesaptan çıkacak bir
tutar, limit vadesi ise yenilenmesi gereken bir tavan. Tek "vadesi gelen tutar"a toplamak
**kullanılmayan her lira kadar** çıkışı şişirirdi; nakit maruziyeti sütunu yalnız **çekilen** kısmı
sayıyor.

Aynı dürüstlük kullanımda da: `available` sıfırda sabitleniyor ve **aşım ayrıca** bildiriliyor —
negatif başlık, aşağı akan her toplamda grup likiditesini birinin aşımı kadar sessizce azaltırdı.

### TCMB: manuel/talep üzerine, canlı akış DEĞİL

Faz 20/25 taşıyıcı deseni: arayüz + erişilemezken **dürüst hata dönen (fırlatmayan)** gerçek
uygulama + deterministik mock. Zamanlayıcı/polling yok (gate kod üzerinde kontrol ediyor).
**Ortam değişkeni yok** — uç nokta belgelenmiş varsayılanı olan bir parametre; `@/lib/env`'i modül
yüklenirken import etmek `phase25-verify`/`phase6b-verify`'ı kendi komutlarıyla çalışamaz hâle
getiren şeydi.

`parseTcmbXml`'de iki incelik, ikisi de makul ama yanlış sayı üretirdi: **`Unit`** (bazı kurlar 100
birim üzerinden kotalı — yok saymak JPY maruziyetini yüz kat şişirirdi) ve **boş elemanlar**
(`<ForexBuying/>` → NULL, 0 değil; sıfır kur pozisyonu değersiz gösterirdi, değerlenmemiş değil).

`importRates` **başarısız çekimde hiçbir şey kaydetmiyor**: yarım aktarılmış bülten bazı pariteleri
güncel bazılarını bayat bırakır ve değerleme ikisini ayırt edemez.

### Para: gün-1'den decimal, ve ölçülmüş bir sapma

Tüm FX/finansman matematiği `money.ts` üzerinden. Birim test **ölçülmüş** bir yarım-kuruş sapması
çiviliyor: `1 × 1,005` decimal half-up ile **1,01**, float'ta **1,00** (1.005 aslında
1.00499999999999989). Yazdığım ilk hassasiyet testinin iddiası fazlaydı — 1.000.000 × yakın kurlar
float'ta 99,9999999962 veriyor ama 2 haneye yuvarlanınca aynı kuruşa dönüyor, yani sapmayı
göstermiyordu. Testi dürüst hâline çevirdim ve gerçekten farklılaşan vakayı ekledim. Ayrıca bir
beklenen değerim düpedüz yanlış aritmetikti (458.270,31 → doğrusu 458.313,95); kod doğruydu.

### Gate kendi dokümantasyonuna takıldı — iki kez

Kaynak seviyesindeki üç kontrol (`::float8` yok, env import yok, zamanlayıcı yok) **ham metni**
tarıyordu ve taranan dosyaların hepsi bunları içermediğini **bir yorumda açıklıyordu**. Açıklama ile
suç birbirinden ayırt edilemez hâle geldi. Kontroller artık **kodu** tarıyor (`codeOnly()` ile
yorumlar ayıklanıyor) ve regex'ler gerçek ifadeleri hedefliyor (`setInterval(` çağrısı, gerçek
`import ... "@/lib/env"` ifadesi). **Negatif kontrolle** kanıtlandı: koda gerçek bir cast
enjekte edildiğinde gate 53/53'ten 52/53'e düşüp dosyayı adıyla bildirdi; yorumdaki metin ise
tetiklemiyor.

Aynı sınıftan ikinci vaka: `phase17:verify` benim gate script'imi yakaladı — başlık yorumumda
literal cast geçiyordu. Yorum yeniden yazıldı, kontrol için literal parça parça birleştiriliyor.

**Ders:** bir yorumun tetikleyebildiği kontrol, sonsuza kadar kurt masalı anlatır.

### Doğrulama

Gate **kendi Usage komutuyla** çalıştırıldı, fazladan hiçbir env değişkeni olmadan:

```
env -u DATABASE_URL MIGRATION_DATABASE_URL="postgres://..." pnpm phase27:verify
```

**53/53, 4 kez art arda**; `DATABASE_URL`'in tanımsız olduğu ayrıca doğrulandı. Import grafiği
yazmadan önce modül modül tarandı (fx/rules, fx/provider, fx/engine, financing/facilities, money,
audit, validation, authz/matrix) — hiçbiri `@/lib/env`'e ulaşmıyor.

`db:roles-rls:verify` artık **69 tablo / 345 (katman × tablo) INSERT kombinasyonu** görüyor; altı
yeni tablonun hepsi Faz 24B sınıflandırmasında (`fx_rate_snapshots` → `evidence`, kalanı
`operational`), blanket politika sayısı sıfır.

---

## Faz 28 — DONE (Bütçe, varyans, rolling forecast ve 13 haftalık ufuk)

**migration 0068-0070 · `src/lib/budget/{rules,engine}.ts` · `/cashflow/budget` ·
`scripts/phase28-verify.ts` (46/46, KENDİ Usage komutuyla 4 kez art arda)**

### Mimari karar: yeni `forecasts` tabloları, `scenario_runs`'ın genişletilmesi değil

Plan iki seçeneği de açık bırakıyor ve gerekçe istiyor. Önce introspect ettim; şekil kararı verdi:

`scenario_run_lines` = `(month_start, baseline_income, scenario_income, baseline_expense,
scenario_expense, baseline_closing, scenario_closing, delta)` — **her değer kolonu bir
baseline/senaryo ÇİFTİ**. O tablo "bu iki dünya nasıl farklılaşıyor" sorusunu cevaplıyor. Rolling
forecast iki dünyanın karşılaştırması değil; revize edilen, kaynağına göre sınıflanan, güven skoru
verilen ve sonradan gerçekleşenle ölçülen **TEK** projeksiyon. Oraya koymak her satırın yarısını
anlamsız bırakır ve "bu run aslında what-if değil" diyen bir ayırt edici kolon gerektirirdi.

Üç somut uyumsuzluk daha: **granülerlik** (13 haftalık ufuk HAFTALIK, `month_start` kesin aylık —
hafta başlangıçlarını oraya yazmak sonraki her okuyucunun devraldığı bir yalan olurdu);
**yaşam döngüsü** (`scenario_runs` arşivsel/değişmez çıktı, bu faz versiyon döngüsü istiyor —
takmak mevcut her senaryo satırının anlamını değiştirirdi); **kimlik** (senaryo bir kez üretilir ve
okunur, tahmin sürdürülür).

Kopyalanmak yerine yeniden kullanılan: `forecasts.scenario_run_id` nullable FK. Senaryo motoru
**bağlanarak** genişletiliyor, aşırı yüklenerek değil.

### Ölçülmüş bir sınır: departman gerçekleşeni izlenemiyor

Boyutlardan yalnız `cost_center` ve `project` bir işlem tablosuna bağlı (`invoices`), `category`
yalnız `payments`'a. **Hiçbir tablo departmanı bir işleme bağlamıyor.** Departman bütçesi
yazılabiliyor ama karşılaştırılacak gerçekleşeni yok — view gerçekleşeni **NULL bırakıyor**, tahsis
kuralı icat etmiyor, ve ekran bunu "departman gerçekleşeni izlenemiyor" diye **söylüyor** (boş
hücre bırakmak yerine). Uydurmak, bu veritabanında hiçbir satırın kaydetmediği bir soruyu
cevaplamak olurdu. Gate boşluğu yapısal olarak doğruluyor.

### Çift sayma tuzağı

Aynı para hem fatura hem onu kapatan ödeme olarak görünür; ikisini toplamak gerçekleşen gideri
kabaca **iki katına** çıkarır ve sayı yine makul görünürdü. Gerçekleşen yalnız **faturalardan**
geliyor; ödeme tarafı bilerek katılmıyor.

### Guard: `approved → draft` reddediliyor

Her iki tabloda (budget_lines, forecast_lines) altı sıralı çiftten üçü izinli:
`draft→approved`, `draft→superseded`, `approved→superseded`. **Onaylanmış satırı yeniden açmak**,
birinin imzaladığı rakamı sessizce yeniden yazardı ve üzerine kurulu her varyans raporu
okuyucularının altında, hiçbir kayıt bırakmadan değişirdi. Revizyon = eskisini supersede eden yeni
satır. Gate her iki tabloda 6 çiftin tamamını gerçek satırlarda deniyor ve koddaki
`canTransition` ile birebir aynı olduğunu ayrıca kanıtlıyor.

Tutarlılık kısıtı imalar yığını yerine **tüketici**: superseded bir satır önce onaylanmış da
olabilir, taslaktan doğrudan supersede edilmiş de.

### Yön duyarlı varyans, ve "ölçülmedi" ≠ sıfır

Gider bütçesini aşmak ile gelir hedefini aşmak zıt sonuçlar; işaretsiz tek bir varyans **iyi bir
ayı kırmızıya boyardı**. Gate aynı +200 farkın giderde `over_budget`, gelirde
`on_or_above_target` olduğunu kanıtlıyor. Gerçekleşen yoksa sonuç **NULL ve `not_measured`** —
sıfır "hiç harcanmadı" iddiasıdır. Açık sıfır gerçekleşen ise ölçülmüş sayılıyor.

Yalnız **ONAYLI** satırlar ölçülüyor: taslak çalışma notu, superseded geçmiştir; ikisine karşı
varyans raporlamak, birileri hâlâ düzenlerken bir sayının değişmesine izin vermek olurdu.

### 13 haftalık ufuk ve doğruluk

Haftalar **üretiliyor**, var olan satırlardan türetilmiyor: ufuk her zaman tam 13 kova. Tahmin
satırı olmayan hafta boş görünmeli — nakit tahmininden sessizce düşen bir hafta, boşluğun
görünmez hâle gelme biçimidir. Yanında iki alternatif net akış: **yalnız sözleşmeli** (her tahmin
yanlış çıkarsa ayakta kalan) ve **güven ağırlıklı** (skoru olmayan satır tam ağırlıkla girer —
sessizce para eksilten bir tahmin daha kötüdür).

Doğruluk yalnız **ölçülmüş** satırları sayıyor: ölçülmemiş satırı dahil etmek, tahmini ne kadar az
kontrol edilmişse o kadar doğru göstermek olurdu — tam tersi. MAPE'de sıfır tahminli satırlar
hariç ve **hariç tutulan sayı ayrıca raporlanıyor**.

### Pekiştirme: LLM forecast zincirinin dışında (negatif kontrolle kanıtlandı)

`src/lib/budget/{rules,engine}.ts` `@/lib/ai`'yi **hiç import etmiyor**; gate bunu kod üzerinde
(yorumlar ayıklanarak) kontrol ediyor. **Negatif kontrol:** gerçek bir `import` enjekte edildiğinde
gate 46/46'dan 45/46'ya düştü ve satırı adıyla bildirdi; dosyadaki iki açıklama yorumu (`@/lib/ai`
geçen) tetiklemedi — Faz 27'nin yorum/kod ayrımı dersi baştan uygulandı. `ai/engine.ts`'in "önce
deterministik" sınırı (Faz 12) olduğu gibi duruyor; Python/dış çözücü yok.

### Bir ölçüm tutarsızlığı, kovalandı

Ara bir koşuda test sayısı 33 dosya / 662 test göründü (beklenen 34/665). Dosya silinmiş olabilir
diye kontrol ettim: diskte 34 dosya vardı, git'te silinme yoktu, ve peş peşe üç koşu 34/665
verdi. Negatif kontrol geri yüklemesiyle aynı komut bloğunda alınmış geçici/eskimiş bir okumaydı —
kayıp dosya değil. Yine de kovalandı, çünkü "bir test dosyası sessizce çalışmıyor" göz ardı
edilecek bir sinyal değil.

### Doğrulama

```
env -u DATABASE_URL MIGRATION_DATABASE_URL="postgres://..." pnpm phase28:verify
```
**46/46, 4 kez art arda**; `DATABASE_URL`'in tanımsız olduğu ayrıca doğrulandı.
`db:roles-rls:verify` artık **73 tablo / 365 (katman × tablo) INSERT kombinasyonu** görüyor.

---

## Faz 29 — DONE (deterministik optimizasyon, senaryo karşılaştırma, approvals bağlantısı)

**migration 0071-0073 · `src/lib/optimization/{rules,engine}.ts` ·
`scripts/phase29-verify.ts` (36/36, KENDİ Usage komutuyla 4 kez art arda)**

Bu faz bir oturum limiti yüzünden ikiye bölündü; kesinti anında üç migration uygulanmış ve
`rules.ts` yazılmıştı. Devam ederken diskteki durum `git status` ve dosya okumasıyla doğrulandı
(hiçbiri yarım yazılmamıştı), sonra kalan iş tamamlandı — baştan başlanmadı.

### Baseline korunur invariant'ı, yeni çalışma tipine karşı nasıl kanıtlandı

Plan bunu şart koşuyor ve gate **alt küme kontrolüyle değil, tam satır karşılaştırmasıyla** yapıyor:

1. Bir baseline `scenario_run`'ın **her kolonu**, `scenario_comparisons` satırları, **tüm**
   `cashflow_months` ve **tüm** `payment_instances` satırları anlık görüntüye alınıyor
   (`select *`, seçilmiş alanlar değil).
2. Optimizatör uçtan uca çalıştırılıyor: `runOptimization` + `requestOptimizationApproval`.
3. Anlık görüntüler `JSON.stringify` ile birebir karşılaştırılıyor.

**İlk sürümde bu kontrol boş kümeyle geçiyordu** — `payment_instances` sıfır satırdı, yani hiçbir
şey kanıtlamıyordu. Fixture artık iki gerçek taksit kuruyor (biri `normal`, biri `critical`
öncelikli), yani optimizatörün gerçekten mutasyona uğratabileceği adaylar var; kontrol artık boş
küme olduğunda **başarısız oluyor** (`>= 2` şartı).

Buna ek olarak kaynak seviyesinde: motorun mali/senaryo tablolarına yazan hiçbir ifadesi olmadığı
(yorumlar ayıklanarak) ve çözücü kurallarının veritabanına **hiç erişmediği** — yani yapısal olarak
mutasyon yapamayacağı — doğrulanıyor.

### Approvals'a bağlanma, çatallama değil

`optimization_runs`'ta **yaşam döngüsü/onay kolonu yok** ve gate bunu yapısal olarak kontrol
ediyor. Onay durumu `approvals`'ta yaşıyor; 0072 polimorfik `subject_table`'a bir değer ekliyor ve
motor Faz 24A'nın `requestApproval`'ını değiştirmeden çağırıyor. Buraya bir statü koymak, bir öneri
kümesinin onaylı olup olmadığı hakkında ikinci bir doğruluk kaynağı yaratırdı — Faz 24A'nın bir
fazını harcayarak kaldırdığı arıza. `optimization_run_summary` onay durumunu **JOIN ediyor**,
kopyalamıyor.

### Üç gerçek hata, üçü de farklı bir mekanizmayla yakalandı

**1. `array_length()` boş dizide NULL döner — ve NULL'a düşen CHECK GEÇER.**
`array_length(rationale_codes,1) >= 1` kısıtı, tam olarak engellemek için var olduğu boş-gerekçe
satırlarını kabul ediyordu, üstelik çalışıyormuş gibi okunuyordu. Kümede ölçüldü
(`(array_length('{}',1) >= 1) is null` → `t`) ve `coalesce(...,0) >= 1` ile düzeltildi. Migration
hem yeni veritabanları hem de bozuk sürümü çalıştırmış olanlar için idempotent onarım içeriyor.

**2. Zod enum'u ile DB CHECK'i sürüklendi ve typecheck göremedi.**
`requestApprovalSchema` `raw: unknown` alıyor, dolayısıyla önce CHECK'i genişletip
`SUBJECT_TABLES`'ı genişletmemek derleyiciye görünmez; hata ancak çağrı anında bir Zod doğrulama
hatası olarak çıkardı. Gate artık iki listeyi doğrudan karşılaştırıp yalnız-DB/yalnız-kod farkını
adıyla bildiriyor.

**3. Çözücü, erteleme hedefini yanlış seçiyordu (birim test yakaladı).**
İlk sürüm ödemeyi ihlalden **bir gün sonrasına** taşıyordu; kapatıcı giriş üç gün sonraysa bakiye
yeni tarihte de tabanın altında kalıyor ve en kötü bakiye hiç değişmiyordu (−400 → −400). Hedef
artık ödemenin **gerçekten karşılanabildiği ilk gün**. Ufuk içinde böyle bir gün yoksa öneri
üretilmiyor — yalnızca ilerleme gibi görünen bir hamle yapmaktansa hiçbir şey önermemek doğru.
Testteki beklenen değer de düzeltildi (01-03 → 01-05); kod doğruydu, beklentim eski davranışa
yazılmıştı.

Ayrıca `payment_instances`'ta olmayan bir `priority` kolonu okunuyordu; introspection ile
düzeltildi (`priority` `payments`'ta, `risk_level` instance'ta) ve ikisinden biri `critical` ise
ödeme taşınamaz sayılıyor — muhafazakâr okuma bilinçli.

### Deterministik çözücü, kütüphane değil

Açık kural tabanlı sezgisel: LP/MIP yok, istatistiksel optimizatör yok, öğrenilmiş ağırlık yok,
Python yok. Her öneri adlandırılmış bir kuralla üretiliyor ve o kuralın adını taşıyor
(`rationale_codes` boş olamaz). Sert vadeli ödeme asla ertelenmeye önerilmiyor ve **ertelenemediği
ayrıca bildiriliyor**; kapatılamayan açık da `limit_yetersiz` ile raporlanıyor — sessiz bir kısmi
cevap "çözüldü" diye okunurdu.

Determinizm gereklilik: çalışma bir `result_digest` saklıyor, gate optimizatörü yeniden koşup
karşılaştırıyor. Bu her sıralamanın **tam sıra** olmasını zorunlu kıldı — her karşılaştırıcı id
eşitlik-bozucuyla bitiyor. Gate hem tekrarlanabilirliği hem **girdi sırasından bağımsızlığı** ayrı
ayrı kanıtlıyor.

### Doğrulama

```
env -u DATABASE_URL MIGRATION_DATABASE_URL="postgres://..." pnpm phase29:verify
```
**36/36, 4 kez art arda**; `DATABASE_URL`'in tanımsız olduğu ayrıca doğrulandı.
`db:roles-rls:verify` artık **75 tablo / 375 (katman × tablo) INSERT kombinasyonu** görüyor.

---

## Faz 30 — DONE (maliyet dağıtımı, kârlılık view'ları, işletme sermayesi)

**migration 0074-0075 · `src/lib/costing/{rules,engine}.ts` · `/finance/profitability` ·
`scripts/phase30-verify.ts` (40/40, KENDİ Usage komutuyla 4 kez art arda)**

### Kârlılık deseni kopyalandı, yeniden icat edilmedi

`production/rules.ts:partProfitability` bu depoda marjın nasıl hesaplandığını zaten belirlemişti;
`costing/rules.ts` birebir onu izliyor: `margin = revenue − cost` ve iki taraftan biri
bilinmiyorsa **NULL** (asla 0), `marginRate` ciro 0 ya da bilinmiyorsa **NULL**, eksik girdi bir
`confidence` bayrağıyla söyleniyor.

Gerekçe estetik değil: maliyeti kaydedilmediği için 0 görünen bir marj **gerçek bir başabaştan
ayırt edilemez**. Birim test iki hesabın aynı sayıyı verdiğini `partProfitability`'yi içe aktarıp
karşılaştırarak çiviliyor; gate ayrıca SQL view'ı ile TS fonksiyonunun aynı fixture üzerinde
birebir aynı sonucu verdiğini kanıtlıyor (400 marj / `estimated`, maliyet yokken NULL /
`needs_review`).

### İki ölçülmüş sınır, ikisi de uydurulmadı

**Departman kârlılığı hesaplanamıyor.** Hiçbir işlem tablosu `department_id` taşımıyor (Faz 28
aynı bulguyu bütçe gerçekleşeni için kaydetmişti). View her departmanı NULL rakamlar ve
`unmeasurable_reason='no_transaction_link'` ile listeliyor; ekran nedeni yazıyor, böylece boşluk
"kâr sıfır" diye okunmuyor.

**DIO ve dolayısıyla CCC hesaplanamıyor.** Şemada envanter yok — stok tablosu yok, eldeki-miktar
kolonu yok. Cazip kısayol DIO'yu 0 saymaktı; bu, döngüyü işletmenin malzeme tuttuğu gün sayısı
kadar **kısaltır**, yani işletme sermayesini olduğundan **İYİ** gösterir — bu metrik için yanlış
olmanın en tehlikeli yönü. Onun yerine `cash_cycle_excluding_inventory` veriliyor ve **tam olarak
neyi dışladığıyla adlandırılıyor**. Gate hem envanter tablosunun yokluğunu hem de DIO/CCC'nin
NULL + gerekçeli olduğunu ayrı ayrı kontrol ediyor.

Faz 22 `dso_dpo_components`'ı bilerek oransız bırakmıştı; bölme bu fazda yapıldı — sıfır paydada
**NULL**, çünkü DSO 0 "müşteriler anında ödüyor" diye okunur, gerçek ise "satış geçmişimiz yok".

### Dağıtımda kaybolan kuruş

100,00'ü üçe bölmek 33,33 veriyor ve 33,33 × 3 = 99,99 — bir kuruşun bir yere gitmesi gerekiyor,
yoksa dağıtım **sessizce para kaybeder** ve bir yıllık aylık koşuda her maliyet merkezinde
açıklanamayan gerçek bir sapma bırakır. Kalan en büyük paya veriliyor (eşitlikler id ile
çözülüyor, seçim tekrarlanabilir) ve `allocate` parçaların girdiye **tam** eşit toplandığını
garanti ediyor. Test bunu 100 / 0,01 / 1 / 999,99 / 1234,56 tutarlarını 3, 6, 7 ve 11 hedefe
bölerek doğruluyor; gate 33,34 + 33,33 + 33,33 = 100,00 çıktısını gösteriyor.

### Yanlış tabloya bağlanma, introspection'la yakalandı

`profitability_by_machine`'in ilk taslağı `machine_minute_allocations`'ı join ediyordu; migration
uygulanırken `column a.machine_id does not exist` hatası verdi. İnceleme o tablonun
`(capacity_model_id, operation_type)` ile anahtarlandığını ve **hiç makine taşımadığını** gösterdi
— **kapasite kullanımını** ölçüyor, farklı bir eksen. Kullanmak atölye geneli dakikaları tek tek
makinelere atfetmek olurdu. View `machine_roi_snapshots` üzerine kuruldu: zaten makine başına
ciro/maliyet ve kendi `confidence` kolonunu taşıyor — bu fazın şablon alması söylenen kârlılık
emsalinin ta kendisi.

### Cari rolü: iddia değil gözlem

Müşteri/tedarikçi için iki ayrı view yerine tek view — aynı cari çoğu zaman ikisidir ve ayrı
raporlamak net ilişkiyi görünmez kılardı. `observed_role` verinin **gösterdiğini** söylüyor
(`both` dahil), `party_type` kolonunun iddia ettiğini değil. Gate bunu 800 satış + 300 alış olan
bir cariyle kanıtlıyor: rol `both`, net katkı 500.

### Dağıtım tabanı veri, ve yalnız admin'e açık

`cost_allocation_rules` `approval_rules`/`treasury_policies` emsalini izliyor. **Yaşam döngüsü
kolonu yok** ve §17 kural 3'ün N/A olduğu **yapısal olarak** doğrulanıyor. RLS `config` sınıfı:
her katman okur, yalnız **admin** yazar — dağıtımı yeniden tabanlayabilen bir yönetici, hiçbir
mali kayıt değişmeden maliyeti kendi merkezinden başkasınınkine kaydırabilirdi.

### 24B mekanizması yine iş gördü

`db:migrate:verify` 48/49'a düştü: `cost_allocation_rules` dört satır tohumluyor ve "yeni tablolar
boş" değişmezini kırdı. Kural gevşetilmedi — tablo **adıyla beyan edildi**, böylece beyan edilmeden
dolu gelen bir sonraki tablo hâlâ bu gate'i düşürüyor.

`db:roles-rls:verify` artık **76 tablo / 380 (katman × tablo) INSERT kombinasyonu** görüyor.

### Doğrulama

```
env -u DATABASE_URL MIGRATION_DATABASE_URL="postgres://..." pnpm phase30:verify
```
**40/40, 4 kez art arda**; `DATABASE_URL`'in tanımsız olduğu ayrıca doğrulandı. Kârlılık
matematiğinin `@/lib/ai`'yi import etmediği kod üzerinde (yorumlar ayıklanarak) kontrol ediliyor.

---

## Faz 31 — DONE (finansal kontrol merkezi, anomali tespiti, uyarı yaşam döngüsü)

**migration 0076-0078 · `src/lib/controls/{rules,engine}.ts` · `/system/controls` ·
`scripts/phase31-verify.ts` (42/42, KENDİ Usage komutuyla 4 kez art arda) ·
`db:constraints:verify` 65 → 75**

### Tekrar etmeme disiplini: her kontrol önce sınıflandırıldı

Bu sentez fazının en önemli işi, zaten tutan bir invariant'ı ikinci kez zorlamamaktı. Her kontrol
yazılmadan **önce** ilgili mevcut mekanizma okundu; sınıflandırma `control_registry.enforcement`
kolonunda **veri olarak** duruyor ve gate her "zaten zorlanıyor" iddiasını **mekanizmayı
çalıştırarak** kanıtlıyor:

**ZATEN ZORLANIYOR — yalnız görünürlük eklendi (4):**
- `allocation_over_invoice` — Faz 22'nin tavan trigger'ı. Gate fatura üstü dağıtımın **hâlâ**
  reddedildiğini deneyerek doğruluyor.
- `near_duplicate_bank_txn` — `bank_transactions_dedupe_uq` **UNIQUE** (gate `indisunique`'i
  okuyor). Birebir kopya imkânsız, o yüzden kontrol **yakın** kopyaları arıyor.
- `iban_changed` — Faz 19'un `iban_change_events`'i zaten salt-ekleme kaydediyor.
- `unknown_counterparty` — Faz 19 kararı: uygulama sessizce `parties` yaratmıyor.

**GERÇEKTEN YENİ (7):** `duplicate_invoice`, `payment_without_invoice`, `approval_bypass`,
`closed_period_mutation`, `missing_source_document`, `unmatched_bank_txn_aged`, `large_payment`.

Ölçülen en keskin ayrım: **`invoices_dedupe_idx` unique DEĞİL**, `bank_transactions_dedupe_uq` ise
unique. Yani yinelenen banka hareketi imkânsız ama yinelenen **fatura** tamamen mümkün — gate
ikisini de indeks kataloğundan okuyarak kanıtlıyor.

### Planın bir atfı düzeltildi

Plan kapalı-dönem kontrolünün "Faz 24B'nin dönem kilidini gerektirdiğini" söylüyor. Faz 24B
aslında rol-tabanlı RLS teslim etti; **dönem kilidi kavramı ondan önce vardı** —
`cashflow_months.status` erken fazlardan beri `'locked'` taşıyor. Kontrol o çıpaya bağlandı ve
gate `locked` bir ay + sonradan güncellenmiş fatura fixture'ıyla tetiklendiğini gösteriyor.

### Uyarı yaşam döngüsü: iki kritik geçiş

20 sıralı çiftin 11'i izinli. İkisi ayrıca yazılmayı hak ediyor:
- **`snoozed → open`** — erteleme SÜRESİ DOLAR. Olmasaydı ertelenen her uyarı kalıcı susturulurdu;
  kimsenin güvenmediği bir alarm sisteminin tam arıza biçimi.
- **`resolved`/`false_positive` terminal** — kapatılmış bulguyu yeniden açmak kontrol geçmişini
  yeniden yazmak olurdu. Tekrar ederse yeni uyarı açılır (kısmi unique indeks buna izin veriyor).

**`false_positive` `resolved`'ın çeşidi değil, birinci sınıf sonuç** — kural başına yanlış-alarm
oranını hesaplanabilir kılan tam olarak bu ayrım. Oran yalnız **kapanmış** uyarılardan
hesaplanıyor: triyaj edilmemiş bir kontrol "kusursuz" görünmemeli (Faz 28'in "ölçülmemiş ≠
mükemmel" dersinin aynısı).

### Boş küme kanıt değil

Gate her tespit görünümünü bir fixture'la **gerçekten tetikliyor**: duplicate_invoice=1,
missing_source_document=2, large_payment=1, approval_bypass=1, payment_without_invoice=1,
closed_period_mutation=1, round_number=1, split_payment=1. Boş bir veritabanında sıfır satır
döndüren bir kontrol hiçbir şey kanıtlamaz.

### Dürüstçe adlandırılan bir sınır

**`bank_transactions`'ta işlem saati YOK** — yalnız `txn_date` (tarih). Ölçüldü. Dolayısıyla
"gece 3'te yapılan ödeme" tespit **edilemiyor**; tespit edilen "gece 3'te **kaydedilen** satır".
Bu da gerçek bir sinyal ama farklı bir sinyal; view'ın adı (`anomaly_unusual_record_hour`), bir
`caveat` kolonu ve ekrandaki uyarı bunu söylüyor. İşlem saati demek, verinin desteklemediği bir
iddiada bulunmak olurdu.

### İkinci görev modeli yok, LLM yok

Takip görevi bir `action_item` (Faz 14 modeli, Faz 25'in tahsilatta yaptığı gibi); 0077 tek bir
`source_type` değeri ekliyor. Motor `control_alerts`, `action_items` ve `audit_logs` yazıyor,
**hiçbir mali kayda yazmıyor** — bulduğunu "düzelten" bir kontrol, otomasyonun tutar/vade
değiştirmesi olurdu. `src/lib/controls/*` `@/lib/ai`'yi import etmiyor (negatif kontrol): bir
kontrol bulgusu, aynı kuralları aynı satırlara uygulayan ikinci bir kişi tarafından **yeniden
üretilebilmeli**.

### İki gerçek hata, ikisi de gate zinciri tarafından yakalandı

**1. Paylaşılan enum'un tam boyutunu sabitleyen bir gate (cross-phase kırılma).**
`phase25:verify` `action_items.source_type` kümesinin boyutunu **7'ye sabitlemişti**; Faz 31
meşru olarak `'control'` ekleyince phase25 kırıldı. Sonraki her genişletme ilgisiz bir fazın
gate'ini kıracaktı. Assertion, Faz 25'in gerçekten önemsediği şeye çevrildi: **kendi değeri var
VE kendisinden önceki değerlerin hiçbiri silinmemiş** (üst küme kontrolü).

Bunun bir **sınıf** olup olmadığını taradım: diğer `size === N` iddialarının hepsi DB enum'unu bir
**kod sabitiyle** karşılaştırıyor (`ALERT_STATUSES`, `SOURCE_KINDS`, `FACILITY_STATUSES`…), yani
ikisi birlikte genişlediğinde kendiliğinden senkron kalıyorlar — doğru kuplaj. Kod sabiti
olmayan tek enum `action_items.source_type` idi, ve kırılan da tam olarak oydu.

**2. Lint'in yakaladığı sahte tip daraltması.** `ruleCodes.filter((r): r is AnomalyRule => true)`
her şeyi kabul eden bir predicate'ti; lint kullanılmayan parametreyi bildirdi ama asıl sorun
başkaydı: kontrol-özel bir kural kodu (ya da bir yazım hatası) `ANOMALY_WEIGHT[undefined]`
üzerinden skora karışabilirdi. Artık kayıt defterine göre filtreleniyor — tanınmayan kod uyarıda
kayıt olarak taşınıyor ama **skoru sessizce oynatamıyor**.

### `db:constraints:verify` genişletildi, değiştirilmedi

Planın şartı: her yeni CHECK kendi girdisini aldı. `runFaz31ConstraintAssertions()` eklendi,
mevcut `runFaz19`/`runFaz22` fonksiyonlarına dokunulmadı. **65 → 75 test.** `has_rules` kısıtı
Faz 29'un `coalesce(array_length(...),0)` dersiyle baştan yazıldı ve kendi girdisi var.

### Doğrulama

```
env -u DATABASE_URL MIGRATION_DATABASE_URL="postgres://..." pnpm phase31:verify
```
**42/42, 4 kez art arda**; `DATABASE_URL`'in tanımsız olduğu ayrıca doğrulandı.
`db:roles-rls:verify` artık **78 tablo / 390 (katman × tablo) INSERT kombinasyonu** görüyor.

## Faz 32 — DONE (CFO sabah brifingi, yönetim kokpiti, birleşik finansal takvim)

Migration **0079-0080**, **yeni tablo yok**. Faz 26-31'in ürettiği rakamlar tek ekranda ve tek
dilde toplanıyor; bu fazın işi yeni bir gerçeklik üretmek değil.

### Planın açık sorusu kapatıldı: yeni tekrar-eden-yükümlülük tablosu YOK

implementation.md §3, maaş/SGK/vergi/kira/sigorta/CapEx için yeni hafif bir yükümlülük kaydı mı
gerektiğini bu faz başlarken netleştirmemizi istiyordu. Önce **ölçtüm**: `payments` zaten
`recurrence_type` (`one_off|monthly|weekly|yearly|irregular`), `due_day` (monthly ise CHECK ile
zorunlu), `category_id` ve `provider_party_id` taşıyor; `payment_instances` her tekrarı zaten
maddeleştiriyor. Aylık bordro ile aylık kira arasında **şema farkı yok** — ikisi de kategorili,
tekrar eden ödeme.

Yeni tablo, `payments`'ın var olma sebebi olan tek şey için rakip bir doğruluk kaynağı olurdu.
Gate kararı iki yönden kilitliyor: `recurring`/`obligation` adlı yeni tablo **olmadığı**, ve
`payments.recurrence_type` CHECK'inin tekrar modelini **gerçekten** taşıdığı doğrulanıyor —
gerekçe iddia değil, kısıt.

### "Sapma yasak" şartı: yapısal olarak imkânsız kılındı, test edilerek umulmadı

Planın kritik şartı, brifing rakamlarının alttaki panolardan **sapmaması**. Bunu bir eşitlik
testiyle "kontrol etmek" yeterli olmazdı: test, sapmayı yalnız **kendi fixture'ında** görür.

`src/lib/briefing/engine.ts` bu yüzden hiçbir manşet rakamı için **kendi SQL'ini yazmıyor**.
Sayfaların çağırdığı **aynı** yükleyicileri çağırıyor: `loadPositionSummary` / `loadLiquidityGap`
(hazine), `loadWorkingCapital` (maliyet), `loadControlDashboard` / `loadAlerts` (kontrol),
`loadOpenPromises` (tahsilat), `instancesOn` / `overdueOpen` (radar). Sapma için aynı fonksiyonun
tek istekte iki farklı cevap vermesi gerekirdi.

**Faz 26'dan bilinçli fark:** orada hazine ile `cashflow_months` gerçekten **iki ayrı kaynaktı** ve
dürüst olan farkı **raporlamaktı**. Burada tek kaynak var, dolayısıyla fark bir bulgu değil
**hata**; gate fark raporlamıyor, **eşitlik** iddia ediyor.

Gate her iki katmanı da tutuyor: yükleyici çağrılarının varlığı kaynak seviyesinde (yorumlar
ayıklanarak), rakamlar ise gerçek fixture üzerinde karşılaştırılıyor.

### Karşılaştırmanın boş kümede yapılmadığı ayrıca iddia ediliyor

İlk sürümde üç karşılaştırma `0 === 0` ve `null === null` ile geçiyordu — yani hiçbir şey
kanıtlamıyordu. Fixture, üç rakamı da gerçekten dolduracak şekilde yeniden kuruldu (3 gün sonrasına
5.000.000 TL çıkış → **4.250.000 TL** likidite açığı; satış/alış faturası → **DSO 365**; 40 gün
gecikmiş kalem), ve gate artık **rakamların dolu olduğunu da** ayrı bir kontrol olarak iddia
ediyor. Vakum geçiş, geçmeyen testten daha tehlikelidir.

**Negatif kontrol:** `availableCash`'e kasten `+1` eklendim; gate `brifing=750001 pano=750000`
diyerek düştü. 1 TL'lik sapmayı yakalıyor.

### Bilinmeyen "—" olarak gösteriliyor, 0 TL olarak değil

Hem brifing metninde hem kokpit tile'larında. `0 TL` ile "hesaplanamadı" farklı ifadeler ve
ikincisini birincisi gibi gösteren ekran, tam olarak yanlışken güvenilen ekrandır. Ekranın
kendisi de bunu yazıyor, yalnız kod yorumunda kalmıyor.

Takvimde aynı ayrım iki yerde daha: limit vadesi satırının tutarı **NULL** (sıfır olsaydı günün
netine karışırdı), ve tutarı bilinmeyen ödeme sözü takvime **girmiyor**.

### `cockpit.ts` genişletildi, değiştirilmedi

Widget katmanı mevcut `CockpitFacts`/`buildActions` yanına **ayrı bir arayüzle** eklendi;
`/overview` sayfasının bağlı olduğu şey bozulmadı. Dosyanın kendi sözü de korundu — yeni finansal
matematik yok, veritabanı yok, LLM yok: her rakam onu üreten fazdan **okunuyor**, bu modül yalnız
sıralama ve ifade seçiyor. Gate saflığı kaynak seviyesinde doğruluyor.

### LLM zincirin tamamen dışında

`src/lib/briefing/*` ve `cockpit.ts` `@/lib/ai`'yi import etmiyor; negatif kontrolle kanıtlandı.
Gerekçe pratik: brifingi okuyan kişinin rakamları panoya karşı **yeniden üretebilmesi** gerekir.

### UI: onuncu modül açılmadı

Dokuz modül mimarisi korundu. CFO brifingi + kokpit **İçgörüler**e (`/insights/briefing`),
birleşik takvim **Finansman**a (`/finance/calendar`) sekme olarak eklendi. Brifing üretimi sayfa
açılışında **otomatik değil**: kaydedilen bir `reports` satırı ve denetim kaydı üretmek, birinin
ekranı açmasının yan etkisi olmamalı.

### Doğrulama

```
env -u DATABASE_URL MIGRATION_DATABASE_URL="postgresql://..." pnpm phase32:verify
```
**44/44, 3 kez art arda**; `DATABASE_URL`'in tanımsız olduğu ayrıca doğrulandı. Fixture temizliği
de bununla kanıtlandı — sızsaydı ikinci koşu iki gecikmiş kalem görürdü.

## Faz 33 — DONE (arka plan kuyruğu, ölçülmüş sorgu optimizasyonu, indeks/N+1 denetimi)

Migration **0081-0082**. Bu faz diğerlerinden farklı bir kategori: yeni bir iş alanı değil,
altyapı. İki özel şart vardı ve ikisi de ölçümle karşılandı.

### Önce ölçtüm, sonra yazdım — sıralama tahmini yalanladı

77 read model gerçekçi hacimde (24.000 fatura, 60.000 banka hareketi, 12.500 taksit) üçer kez
çalıştırılıp medyanla sıralandı. Dosyaları okuyup "en çok JOIN'i olan" seçilseydi yanlış hedefe
çalışılacaktı. Gerçek aykırı değer: **`working_capital_trend`, 37 satır için 5.995 ms** — 77
view'ın toplamının %55'i, üstelik kârlılık sayfasını besliyor.

`EXPLAIN (ANALYZE, BUFFERS)` sebebi söyledi: dört bağıntılı alt sorgu, faturaları **ay başına**
yeniden tarıyor — 37 satır için **234.882 buffer hit**.

### Dört aday kuruldu, biri ölçümle ELENDİ

| | ms | buffer |
| --- | ---: | ---: |
| A eski view, indekssiz | 6.478 | 234.879 |
| B eski view + kapsayan indeks | 2.185 | |
| D tek geçişli yeniden yazım, indeksiz | 969 | |
| **C ikisi birden (uygulanan)** | **683** | **5.247** |

**9,5× hız, 45× daha az buffer**, iki değişiklik de bağımsız katkılı.

Beşinci bir aday — kümülatif toplam + as-of arama — yazıldı, çıktısının birebir aynı olduğu
kanıtlandı ve **3.225 ms ölçüldü**: yerine geçeceği şeyden yavaş. Atıldı. Ölçmeseydim
"optimizasyon" diye girecekti, çünkü zekice görünüyordu. Koordinatörün uyardığı hata tam buydu.

### Materialized view'a gerek kalmadı — ve bu bir karar

Plan MV öneriyor, koordinatör de dikkatli olmamı istedi. Kullanmadım: MV **saklanmış türetilmiş
veridir**, girdisi olan faturalar sürekli değişiyor (bugün girilen tahsilat iki yıl önceki ayın
alacağını değiştirir), yani tazelemeler arasında bayat kalırdı. Altındaki faturalarla sessizce
çelişen bir işletme sermayesi trendi, Faz 19/22/23/26'nın kaçındığı ikinci doğruluk kaynağının
ta kendisi. 9,5×, hiçbir rakamı değiştirmeyen bir yeniden yazım ve bir indeksten geldi; kalan
milisaniyeleri bayatlık karşılığında almak 683 ms'de kötü bir takas.

### Rakamların değişmediği KANITLANDI, söz verilmedi

Eski tanım `working_capital_trend_reference` olarak birebir korundu — hiçbir katmana grant yok,
hiçbir sayfa okumuyor. Gate **her koşuda** simetrik `EXCEPT` ile iki tanımı karşılaştırıyor: sıfır
fark. Yalnız yeniden yazım günü karşılaştırsaydım bir sonraki düzenleme sessizce geçerdi.

Korunan zor ayrıntı: 365 günlük pencere ay sınırına oturmuyor. Aya yuvarlayan ilk taslağım yılda
bir güne denk gelen faturaları düşürürdü.

### Kuyruk: tek tablo, dört teslimat

Plan dört kuyruk sayıyor; bunlar tek mekanizma. Dört tablo, dört durum sözlüğü ve birbirinden
sürüklenen dört retry politikası demekti. `job_type` bir kolon. Ölü mektup da ayrı tablo değil
ayrı **durum** — geçmişi (denemeler, hata, payload) aynı satırda kalıyor.

Geçiş koruyucusu CHECK ile aynı migration'da. Reddedilenin gerekçesi somut: `succeeded → running`
olsaydı bir retry döngüsü bitmiş bir importu yeniden çalıştırıp yazdığı her satırı ikiye
katlardı. SQL guard'ı ile TS izin listesi gate'te küme olarak karşılaştırılıyor (Faz 29 dersi).

### Yol boyunca bulunan gerçek bir hata: hacimde HİÇBİR migration uygulanamıyordu

Hacmi yükledikten sonra `db:migrate` her seferinde `spawnSync docker EOF` ile düştü. Sebep:
zorunlu yedeğin doğrulaması dump'ın **tamamını belleğe alıp** `spawnSync` stdin'inden
`pg_restore --list`'e veriyordu. 82 migration boyunca görünmemişti çünkü her test veritabanı
küçüktü. Sonucu kozmetik değil: **gerçek veri taşıyan hiçbir veritabanına migration
uygulanamazdı.**

Düzeltme transportu değiştiriyor, doğrulamayı değil: dump `docker cp` ile konteynere kopyalanıp
aynı `pg_restore --list` dosya üzerinde çalıştırılıyor. Doğrulanan baytlar aynı. Onu kıran hacmin
ta kendisinde kanıtlandı.

### Gate'in kendi hatası da düzeltildi

İlk koşu `unusedIndexes`'te belirsiz kolon yüzünden **fırlatarak** çıktı, temizlik hiç çalışmadı,
artık işler kuyrukta kaldı ve **ikinci koşu bambaşka bir sebepten** düştü (claim, test edilen
satır yerine artığı kaptı). Fixture'lar artık payload ile etiketleniyor, başlangıçta da
temizleniyor ve temizlik `finally`'de — kendi başarısızlığından sağ çıkan bir fixture, sonraki
her koşuyu sebep hakkında yalan söyletir.

### Yavaş sorgu kaydı: bellekte, tabloda değil

`getPool()`'un query proxy'sine bağlandı — 530 çağrı yerine tek geçiş noktası. Tablo olmamasının
üç ölçülü sebebi var: her sorguyu kaydeden bir tabloya yazmak **kendini kaydeder** (özyineleme);
yazma yükü bu fazın tersidir; ve RLS yüzünden yavaş bir SELECT çalıştıran viewer log satırı
ekleyemez — yani en çok ilgilenilen katmanda tam da çalışmazdı. Bedeli kalıcı olmaması, ve bu
ekranda yazıyor.

**Parametre değerleri asla saklanmıyor** — yalnız sorgu şekli. Bu sorguların parametreleri fatura
tutarları ve karşı taraf adları; bir tanı ekranı finansal verinin sızacağı yer değil.

### İndeks denetimi: 110 aday, 1 indeks

110 indekssiz yabancı anahtar, 0 gereksiz ön-ek indeksi bulundu. 110'unu birden indekslemek bu
fazın kendi disiplinine aykırı olurdu — her indeks her insert'e **ölçülmemiş** yazma maliyeti
bindirir. Ölçüm neyi haklı çıkardıysa o eklendi: bir tane.

### Gate kendi optimizasyonunda düştü — ve haklıydı: görünürlük haritası

Taze bir veritabanında gate kendi indeksini kullanmadığını bildirdi: **455.011 buffer**, index-only
scan yok. Dakikalar sonra aynı veritabanında **7.185 buffer** ve index-only scan. Optimizasyon
değişmemişti; eksik olan **VACUUM**'du.

Bir index-only scan, heap'i yalnızca **görünürlük haritasının** "tümü görünür" işaretlediği
sayfalar için atlayabilir ve o haritayı yalnız VACUUM kurar. Toplu insert'ten hemen sonra hiçbir
sayfa öyle işaretli değildir, dolayısıyla planner index-only scan'i **doğru olarak** reddediyordu —
plan tablonun o anki durumu için doğruydu, yalnızca autovacuum'dan önce gelmişti.

`ANALYZE` yerine `VACUUM ANALYZE`. Bu olmadan tüm önce/sonra karşılaştırması autovacuum
zamanlamasına atılmış bir yazı-tura olurdu.

### Duvar saati eşiği: ısıtma, ve neden gevşetildiği

Aynı taze veritabanında oran **1,9×** ölçüldü; ısınmış hâlde **2,4-3,4×**. Buffer sayıları iki
ölçümde de **birebir aynıydı** (7.185 / 35.421) — yani plan değişmemişti, yalnız önbellek durumu.
Bu bir performans özelliği değil ölçüm artefaktı, o yüzden **her iki sorgu da eşit şekilde** birer
kez ısıtılıyor.

Eşik 1,5×'e çekildi, bilerek pay bırakarak: kesin ve tekrarlanabilir kanıt **buffer sayısı**
(4,9×, üç koşuda da aynı rakam); duvar saati gerçek bir kontrol olarak duruyor ama makine
gürültüsünde çırpınan bir gate, insanlara "geçene kadar tekrar çalıştır" öğretir.

### Faz 33 REGRESYONU DEĞİL — taban çizgisinde de düşenler

Zinciri taze bir veritabanında tek geçişte çalıştırınca beş script düştü. "Benim mi?" sorusunu
tahminle değil **deneyle** cevapladım: önceki commit'ten (Faz 32) ayrı bir git worktree kurup aynı
sırayı aynı şekilde taze bir veritabanında çalıştırdım.

| | Faz 32 tabanı | Faz 33 (bu çalışma) |
| --- | --- | --- |
| phase5, phase6, phase6b, phase26 | **düşüyor** | düşüyor |
| phase24a | **düşüyor** | **geçiyor (düzelttim)** |

**Aynı küme, eksi bir tane.** Faz 33 sıfır regresyon getirdi ve bir tanesini düzeltti. Bu dördü
ortam/birikmiş duruma bağlı (phase26 `cash_accounts` istiyor ve taze kurulumda o tablo boş;
phase6 denetim satırlarını global sayıp tam 3 bekliyor ve her koşuda artıyor). Bilerek
**dokunmadım**: yazmadığım dört gate'e fixture uydurmak, anlamadığım bir şeyi sessizce maskeleme
riskidir. Kanıtı raporluyorum, düzeltmeyi ilgili faza bırakıyorum.

Not: worktree denemesinde phase17/18 de kırmızı çıktı, ama bu bir artefakt — karşılaştırma adil
olsun diye `data/source/*.xlsx` dosyalarını oraya kopyalamıştım ve o gate'ler takip edilmeyen
dosyaları tarıyor. Kendi depomda ikisi de geçiyor.

### Yol boyunca düzeltilen ÖNCEDEN VAR OLAN üç gate açığı

1. `db:roles-rls:verify` — `update public.payments` arşivlenmiş satıra çarpıyordu (seed:demo bir
   ödemeyi arşivliyor, 0026 tetikleyicisi her güncellemeyi reddediyor). Gate RLS'i ölçüyor, arşiv
   değişmezliğini değil; `archived_at is null` ile kapsandı. Owner bağlantısıyla da yeniden
   üretildi, yani RLS'e özgü değildi.
2. `db:roles-rls:verify` — `settings` fixture'ı **yoktu** ve taze kurulumda tablo boş, dolayısıyla
   "yalnız admin değiştirebilir" kontrolü admin için de 0 satır görüp hiçbir şey zorlamıyordu.
   Dosyanın kendi başlığındaki vakumluluk kuralı, fixture'ı olmayan tek özneye uygulanmamıştı.
3. `phase24a:verify` — `settings.critical_payment_threshold_try` satırını **hiçbir migration
   yazmıyor**; `radar/engine.ts` yoksa 100.000 varsayılanını kullanıyor. Gate "yok"u 0 sanıp
   karşılaştırıyordu. Artık yürürlükteki eşikle karşılaştırıyor: satır varsa o, yoksa motorun
   belgelenmiş varsayılanı. Test edilen özellik aynı — onay kuralı **ikinci** bir sayı icat
   etmemeli.

### Doğrulama

```
env -u DATABASE_URL MIGRATION_DATABASE_URL="postgresql://..." pnpm phase33:verify
```
**58/58, 3 kez art arda**, hacmin ilk kez üretildiği TAZE bir veritabanında (yani hatayı üreten
senaryonun ta kendisinde). Buffer sayıları üç koşuda da birebir aynı: **7.185 / 35.421**. Duvar
saati beklendiği gibi oynuyor ama her zaman ≥2,4×. `DATABASE_URL`'in tanımsız olduğu ayrıca
doğrulandı.

## Faz 34 — DONE (analiz kaydı, dönem fonksiyonları, yedi analiz, üç chart tipi, export)

**Migration YOK.** Bu faz kod ekliyor, şema eklemiyor — gerekçesi aşağıda. İki açık soruyu da
planın kendi dar önerisiyle kapattım.

### AÇIK SORU #2 — Monte Carlo: EKLENMEDİ, ve gerekçe ölçüldü

Monte Carlo'nun girdisi **dağılımdır**. Bu sistemde dağılım verisi **yok** — iddia değil, ölçüm:

- 82 migration'ın tamamında `stddev / variance / distribution / probability / percentile /
  confidence_interval` adında **tek bir kolon bile yok**. Arama yalnız üç dosyada, üçü de
  **yorum** olarak eşleşti — ve üçü de aynı kararı bağımsız olarak vermiş: 0052 "no probability
  and no score", 0067 "no model, no volatility estimate and no distribution", 0078 "no learned
  weighting, no distribution fitting".
- `external_assumptions` bir faiz oranını `value_numeric` **tek nokta değeri** + kaynak + tarih +
  inceleme durumu olarak tutuyor. Ortalama+varyans değil.
- Faz 8/11'in senaryo tipleri adlandırılmış ve yönlü (`revenue_up_down_percent`,
  `customer_delay_days`…), Faz 27'nin FX stresi ±%5/10/20 sabit bantlar, Faz 29'un çözücüsü
  deterministik.

Simülasyon kurmak için dağılımları **uydurmam** gerekirdi (normal varsay, bir σ seç). O σ'dan
türeyen bir P95, otoriter görünen ama arkasında hiçbir şey olmayan bir rakamdır ve okuyanın
yeniden üretmesi imkânsızdır — Faz 27'nin volatilite modeli yerine "hesap makinesiyle
doğrulanabilir" bantları seçerken kullandığı gerekçenin aynısı. CLAUDE.md'nin "belirsiz satırdan
kesin doğru çıkarma" kuralına da doğrudan aykırı olurdu.

Gate bu kararı **kanıtla bağlıyor**: şemada dağılım kolonu olmadığını ve `external_assumptions`'ın
tek nokta değer taşıdığını her koşuda doğruluyor. Bir gün biri varyans kolonu eklerse karar
yeniden değerlendirilmeyi hak eder ve gate bunu haber verir.

### AÇIK SORU #3 — Kapsam: YEDİ analiz, ~40 değil

Wishlist ~40 tip sayıyor. Kırk sığ analiz, kimsenin güvenmediği kırk ekran ve doğru tutulacak
kırk şey demekti. Yedisini seçtim, ve seçim kriteri tek: **bugün bu sistemde arkasında gerçek
veri olması** — şemaya bakarak doğruladım, wishlist'ten adı kulağa hoş geldiği için almadım.

| Analiz | Arkasındaki veri |
| --- | --- |
| Varyans ayrıştırma | `budget_vs_actual` (Faz 28) |
| Yoğunlaşma (Pareto) | `invoices` + `parties` (Faz 21/23) |
| İşletme sermayesi ayrıştırma | `working_capital_metrics` (Faz 30) |
| Nakit köprüsü | `cashflow_months` (Faz 5) |
| Yaşlandırma dağılımı | `invoices.due_date` (Faz 21/22) |
| Dönemsel karşılaştırma (MoM/QoQ/YoY) | herhangi bir aylık seri |
| Hareketli pencere (7/30/90/365) | herhangi bir günlük seri |

**Sekizinci aday REDDEDİLDİ:** envanter devir hızı. Envanter verisi yok; yapmak için uydurmak
gerekirdi. Kayıt bu eksikliği `dio_days` metriği olarak **taşıyor** — silseydim DSO−DPO tam nakit
dönüşüm döngüsü sanılırdı.

### Kayıt neden TABLO değil, KOD

Bir kaydın gerçek olması için üç şey gerekir: neye **bağımlı** olduğu, hangi **sürümün** ürettiği,
sayıların **nereden** geldiği. Üçü de hesabın özelliği, satırın değil — ve hesap git'te duruyor;
git, bu fazın açabileceği herhangi bir tablodan daha iyi sürümlenmiş, denetlenebilir bir depo.

`metric_definitions` tablosu, tarif ettiği fonksiyonlarla **elle** senkron tutulmak zorunda
kalırdı. Biri formülü değiştirip satırı güncellemediği ilk gün, kayıt tam da tarif etmek için var
olduğu sistem hakkında yalan söylerdi — ve hiçbir şey fark etmezdi.

Veritabanına ait olan şey metriğin **zaman içindeki değeri**, ve Faz 17 bunu zaten tutuyor:
`metric_snapshots` (snapshot_date, value, unknown_count, confidence, **source_cutoff**, **meta**).
Yeniden üretilebilirlik damgası o mevcut `meta`'ya yazılır — Faz 32'nin kararı, yine.

**Sonucu:** bu faz migration eklemedi, tablo eklemedi, dolayısıyla yaşam-döngüsü kolonu da yok —
CHECK+guard disiplini burada atlanmadı, **yapısal olarak N/A**. Gate bunu iddia etmiyor,
kanıtlıyor: en son migration hâlâ 0082 (Faz 33'ten kalan).

### KALICI KURAL: LLM-bağımsızlığı artık repo-geneli

Plan bu fazdan itibaren tek seferlik değil **kalıcı** bir kontrol istiyordu. Gate dosya listesi
tutmuyor — `src/lib/analytics`, `src/lib/facts` ve `src/components/charts` ağaçlarını **yürüyerek**
tarıyor (şu an 21 dosya). Faz 40'ta eklenecek bir dosya, kimse listeyi güncellemeyi hatırlamadan,
yazıldığı gün kapsama giriyor. Kalıcı bir kuralın kalıcı kalmasının tek yolu bu.

**Negatif kontrol:** `periods.ts`'e kasten `@/lib/ai/engine` import'u ekledim; gate dosyayı
adıyla bildirerek düştü. Ayrıca dedektörün `@/lib/aircraft`'ı yanlışlıkla yakalamadığı da
doğrulandı.

### Python yok, istatistik kütüphanesi de yok

Çözülen Karar #2 Python'u yasaklıyor. İhtiyaç da olmadı: tamamı toplama, sıralama, oran ve
kümülatif toplam. Bir istatistik paketi çekmek, sayısal davranışını bu projede kimsenin bir
denetçiye anlatamayacağı bir bağımlılığı, tek ekrana sığan aritmetik karşılığında eklemek olurdu.

### Grafik geometrisi göz kararı değil, kanıtlanıyor

Üç chart tipi (şelale, ısı haritası, ağaç haritası) **yerleşim modeli** olarak yazıldı; React
bileşeni yalnız verileni çiziyor. Bu ayrım sayesinde geometri birim testlenebiliyor: gate
treemap'in birim kareyi **tam** kapladığını (alan = 1,000000000000), her karonun alanının payıyla
orantılı olduğunu ve **hiçbir karonun çakışmadığını** ölçüyor. Karoları çakışan bir ağaç
haritası, ekrana gözlerini kısarak bakan birinin fark edeceği bir hata olmamalı.

### Null yine sıfır değil — her katmanda

- Varyans: eksik gerçekleşen **dışlanıyor** (0 sayılsaydı en gurur verici tasarruf raporu çıkardı).
- Hareketli pencere: tamamen bilinmeyen pencere **null**, ve penceresi dolmayan noktalar **kısmi**
  işaretleniyor — gizlenseydi verinin başladığı yer bir "trend" gibi görünürdü.
- Dönemsel: önceki dönem yoksa **%-100 değil "ölçülemez"**; olmayan bir çöküş icat etmek en kolay
  yoldur.
- Yaşlandırma: vadesi olmayan kalem "vadesi gelmemiş" sayılmıyor — bu, eksik verinin en iyimser
  okuması olurdu.
- Isı haritası: eksik hücre **null yoğunluk**, en soğuk renk değil. En soğuk renk "en küçük değer"
  demektir; bilmediğini iddia etmek olurdu.
- XLSX/CSV: bilinmeyen hücre **boş** çıkıyor, 0 değil — sahte sıfırlarla dolu bir tabloda `SUM()`
  sessizce yanlış toplar.

### Saçmalık üretmek yerine reddetmek

Pareto negatif değerde hesap yapmıyor (−100 ile +100'ün toplamı sıfır, her pay sonsuz olurdu),
treemap negatif değeri reddediyor (alan negatif bir büyüklüğü temsil edemez; büyüklüğe göre
çizmek borcu aynı boyda alacak gibi gösterirdi), ve nakit köprüsü tutmayan mutabakatı
**raporluyor** — sessizce çizilen, altındaki defterle çelişen bir grafik olurdu.

### Yol boyunca bulunan bir hata

`toXlsxBuffer` aynı adlı iki sayfada **çöküyordu** (SheetJS uyarı vermiyor, fırlatıyor). Aynı
başlığı paylaşan iki grafik tamamen normal; adlar artık tekilleştiriliyor. Gate bunu üç modeli de
"t" diye adlandırdığı için yakaladı.

### Export

SVG/CSV/XLSX sunucuda üretiliyor. **PNG ve PDF tarayıcıda**: sayfadaki SVG'yi canvas ile
rasterlemek ve tarayıcının kendi yazdırma hattını kullanmak, zaten görüntülenen bir resmi
dönüştürmek için runtime'a headless tarayıcı eklemekten iyi bir takas. Bu, gizlenmiş bir eksik
değil — "PNG export" deyip "ekran görüntüsü alın" demenin bu projenin reddettiği yarım teslimat
olduğunu bildiğim için açıkça yazdım. XLSX'e **Kaynak sayfası** ekleniyor: e-postayla dolaşan bir
tabloda rakamın hangi hesap sürümünden çıktığı yazılı olmalı.

### Doğrulama

```
env -u DATABASE_URL MIGRATION_DATABASE_URL="postgresql://..." pnpm phase34:verify
```
**60/60, 3 kez art arda**, gate'in kendi kurduğu fixture üzerinde (Pareto her koşuda aynı sonucu
verdi: 3/4 karşı taraf açık alacağın %80'ini taşıyor). `DATABASE_URL`'in tanımsız olduğu ayrıca
doğrulandı. 99 yeni birim testi.

## Faz 35 — DONE (doküman merkezi, evrensel arama, ⌘K paleti, doğal-dil sınırı)

Migration **0083**. Açık soru #7'yi kapattım; kritik güvenlik şartını üç ayrı yoldan kanıtladım.

### AÇIK SORU #7 — Depolama: YEREL DİSK, ve precedent zaten repoda

Karar iddiaya değil, mevcut koda dayanıyor: **Faz 2 bunu zaten çözmüş ve kimse yazmamış.**
`source_workbooks` (migration 0001) şu iki kolonu taşıyor:

```
storage_path text,
file_sha256  text,
```

Yani baytlar yerel diskte, veritabanı yol + sağlama tutuyor. `attachments` bilerek **aynı şekil**;
ikinci bir depolama geleneği kurmak, öğrenilecek ikinci bir şey olurdu.

İki alternatif, bu projenin gösterebileceği sebeplerle reddedildi:

- **Obje depolama (S3 vb.)**, CLAUDE.md'nin tek şirketli, özel, yerel Docker Postgres üzerinde
  çalışan bir iç kontrol paneli olarak tanımladığı sisteme **harici bulut bağımlılığı** eklerdi.
  Ayrıca finansal dokümanları, sahibinin bir dosya yöneticisiyle açamayacağı bir yere koyardı.
- **Baytları Postgres'e koymak** (bytea/large object) her taranmış sözleşmeyi yedeğe sokardı.
  **Faz 33 bunun bedelini ölçtü**: 24.000 faturada pg_dump zaten yedek doğrulama yolunu tamamen
  kıracak kadar büyüktü. Zorunlu migration-öncesi yedek, pratik olmaktan çıkmaması gereken tek
  şey.

**Yerel diskin bedeli, açıkça yazıldı:** veritabanı tek başına geri yükleme için yeterli değil —
dump + kayıp doküman dizini = ölü bağlantılarla dolu bir dump. Bu yüzden iki şey yapıldı,
umulmadı:

1. `file_sha256` burada **NOT NULL** (0001'de nullable) — bir geri yükleme hangi dosyanın eksik
   veya bozuk olduğunu en azından **kanıtlayabilir**.
2. `verifyStored()` okurken yeniden sağlama alır; bozulma hata olarak yüzeye çıkar, sessizce
   değişmiş bir doküman olarak değil. Doküman sayfası bunu bir bütünlük süpürmesi olarak gösterir.

**İçerik adresli yerleşim** (`<kök>/aa/bb/<sha256>`): aynı baytlar bir kez saklanır, dosyanın adı
kendi bütünlük kontrolüdür, ve **kullanıcı metni yola hiç girmediği için** dizin dışına çıkma
yapısal olarak imkânsızdır. Gate `../../etc/passwd` denemesinin reddedildiğini doğruluyor.

### KRİTİK ŞART — Arama RLS'i atlamıyor: ÜÇ YOLDAN kanıtlandı

Uyarılan tuzak gerçek ve yaygın: aramayı "performans için" tek geniş bağlantı üzerinden çalıştırıp
sonuçları uygulama katmanında filtrelemek. O zaman bir viewer, ürünün geri kalanının ondan
sakladığı satırları arama sonuçlarında görür — ve sızıntı bir özellik gibi görünür.

1. **YAPISAL** — `src/lib/search/*` hiçbir bağlantı **almıyor**: `new Pool` yok, `getPool` yok,
   `getRawPool` yok, `runAsSystem` yok. Havuz çağırandan geliyor.
   *Negatif kontrol:* motora kasten `getRawPool()` çağrısı ekledim; gate dosyayı adıyla bildirerek
   düştü.
2. **SINIFLANDIRMAYLA** — arama kaydındaki 9 tablonun hepsi Faz 24B'de sınıflandırılmış ve
   **hiçbiri** herhangi bir katmanın göremeyeceği bir tablo değil. `ledger` sınıfı
   (`schema_migrations`) aranabilir değil. Arama, kısıtlı bir tablonun göründüğü tek ekran olamaz.
3. **DAVRANIŞSAL — gerçek `SET ROLE` ile** — aynı `runSearch()` fonksiyonu, sahibin gördüğü bir
   fixture dokümanı üzerinde:
   - **katmana geçmemiş** `mas_radar_app` bağlantısında → **0 sonuç**
   - **`SET ROLE mas_radar_viewer`** ile → dokümanı **görüyor** (pozitif kontrol: (a)'daki sıfır
     RLS yüzünden, alakasız bir sebepten değil)
   - viewer `schema_migrations`'ı **doğrudan** da okuyamıyor
   Parola verilmediğinde gate bu kontrolü **sessizce atlamıyor, yüksek sesle düşüyor** — çalışmayan
   bir güvenlik kontrolü, olmayan bir güvenlik kontrolünden kötüdür.

### Doğal-dil sınırı: model daraltabilir, ASLA genişletemez

`ai/engine.ts`'in zaten çizdiği sınırın aynısı, yeni mimari yok:

- Türkçe sorgu **önce ve her zaman deterministik** ayrıştırılır. Model isteğe bağlı bir
  iyileştirmedir; API anahtarı bittiğinde çalışmayı durduran şey arama değildir.
- Modelin döndürebileceği tek şey, kayıt anahtarlarından kurulmuş bir **Zod enum**'una uyan
  yapısal niyettir. `"users"` veya `"parties; drop table invoices"` ayrıştırmayı geçemez —
  modelin bir tablo adı katabileceği kod yolu **yoktur**.
- `reconcileModelIntent()` modelin listesini kullanıcının kendi sözleriyle **kesiştirir**:
  kapsam yalnız **daraltılabilir**. Kullanıcı "faturaları" dediyse, prompt-injection ile gelen
  "her şeyi ara" `audit_logs`'a ulaşamaz.
- Arama **metni** her zaman kullanıcıdan gelir; model onu yeniden yazamaz.
- `mutationIntent()` (Faz 6'nın mevcut koruması, yeniden kullanıldı) veri değiştiren ifadeleri
  arama olarak çalıştırmayı reddediyor.

Sorgu üreteci tarafında: her tanımlayıcı **kayıttan gelen bir literal** ve `assertSafeIdentifiers`
ile sorgu kurulurken yeniden kontrol ediliyor; her **değer** bağlı parametre. Gate bunu yapısal
olarak doğruluyor — SQL kuran iki yapıda (`where.push(...)` parçaları ve `sql` şablonu) `intent.`
geçmiyor.

### Türkçe ayrıştırıcı: iki gerçek hata testlerle yakalandı

1. **Ekler.** `\b(fatura|faturalar)\b` "faturaları"yı eşleştirmiyordu — yani en bariz sorgu hiçbir
   entity bulmuyordu. Türkçe eklemeli; artık **gövde + ek** olarak eşleşiyor.
2. **Filtre kelimeleri metinde kalıyordu.** Eşleştirme normalize metinde, silme ham metinde
   yapılıyordu: desen "gun" diyor, ham metin "gün". Ayrıştırıcı **token tabanlı** yeniden yazıldı —
   karar normalize biçimde, saklanan ham biçimde.

### Şema disiplini

`documents.status` (active/archived/superseded) CHECK + geçiş koruyucusu **aynı migration'da**.
Reddedilenin gerekçesi somut: `superseded → active` olsaydı, ikisi de güncel olduğunu iddia eden
iki doküman kalırdı ve her bağlantı sessizce belirsizleşirdi. `archived → active` ise gerçek bir
operatör hamlesi, izinli.

`attachments` **append-only** (0022 deseni): düzeltilebilen bir sürüm geçmişi geçmiş değildir;
düzeltme, sürüm N+1 eklemektir — zaten olan da budur. Faz 24B sınıfı **evidence**: hiçbir katmanda
UPDATE/DELETE policy'si yok, ve tetikleyiciler bunu veritabanında da zorluyor.

`(document_id, file_sha256)` tekil: birebir aynı baytları "sürüm 2" diye kaydetmek, **olmayan bir
değişikliği** kaydeder. Motor bunu hata değil, "duplicate" olarak bildiriyor.

Güncel sürüm bir **VIEW** (`document_current_version`), `current_attachment_id` kolonu değil —
saklanan bir işaretçi, `max(version_no)`'nun zaten cevapladığı şey için ikinci kaynaktır.

### Doğrulama

```
env -u DATABASE_URL MAS_RADAR_APP_DB_PASSWORD=... \
  MIGRATION_DATABASE_URL="postgresql://..." pnpm phase35:verify
```
**43/43, 3 kez art arda.** 923 birim testi (+34). RLS davranış testi gerçek bir
`mas_radar_app` girişi ve gerçek `SET ROLE` kullanıyor.

## Faz 36 — DONE (rol-bazlı navigasyonun UI yarısı, global filtreler, kayıtlı görünümler, tablo standardı)

Migration **0084-0085**. Faz 24B'nin bilerek ertelediği tek eksik kapatıldı, ve yol boyunca üç
fazın (33, 35, 36) paylaştığı **yayınlanmış bir hata** bulundu.

### Boşluk sidebar'da değildi — bir kat altındaydı

Yazmadan önce **ölçtüm**: sidebar zaten `navigationFor(session.role, NAV)` ile filtreleniyordu.
Faz 24B'nin UI yarısı orada eksik değildi. Eksik olan bir kat aşağıdaydı — `ModuleFrame` her
modülün **sekmelerini** çiziyor ve **rol farkındalığı sıfırdı** (`grep -c "role" module-tabs.tsx`
→ 0); sekiz modül layout'unun hepsi ona sabit bir liste veriyordu. Bir izleyiciye, kendisini
reddedecek bir ekrana açılan sekme sunulabiliyordu.

`ROUTE_MIN_TIER` + `canSeeRoute()` + `tabsFor()` eklendi. Kritik tasarım ayrıntısı **devralma**:
kendi girdisi olmayan bir rota, **modülünün** kapısını devralır. Olmasaydı `/system` altındaki bir
sekme, yalnızca kimse listeye eklemeyi hatırlamadığı için izleyiciye görünür kalırdı — sessiz
başarısızlık, ve bu fonksiyonun var olma sebebi tam da o.

### UI tarafı nasıl KANITLANDI

Üç yoldan, ve iddiaya değil ölçüme dayanarak:

1. **Sekiz layout'un hepsi gerçekten `tabsFor()` çağırıyor** — kaynak seviyesinde, yorumlar
   ayıklanarak. *Negatif kontrol:* `finance` layout'unu filtresiz bıraktım, gate modülü adıyla
   bildirerek düştü.
2. **Filtreleme SUNUCUDA** — layout'lar client component değil ve `requireSession()` çağırıyor.
   Gizlenen sekme tarayıcıya hiç gönderilmiyor; CSS ile saklamak erişim kontrolü değil, güvenlik
   adı taşıyan bir render tercihidir.
3. **Sızıntı taraması gerçek listeler üzerinde** — sekiz layout'tan `href`'ler ayrıştırıldı
   (**59 sekme**), 5 katman × 59 sekme denendi: hiçbir katmana göremeyeceği bir sekme sunulmuyor.
   **İki pozitif kontrol**: izleyiciden gerçekten 9 sekme gizleniyor (yoksa "sızıntı yok" hiçbir
   şey yapmayan bir filtre için de geçerdi) ve yöneticiden hiçbiri gizlenmiyor.

Ayrıca sayfa içi **yetenek kapıları**: gizli sekme işin yarısı — okunabilen bir sayfa hâlâ yazan
bir buton çizebilir. `UI_CAPABILITIES` + `canPerform()` aynı `can()` matrisine delege ediyor, yani
bir buton, kimin yazabileceği hakkında ikinci bir görüşe dayanarak sunulamıyor.

### `saved_views`: iki kez geri adım attım, ikisi de gate yüzünden

1. INSERT'i sahiplikle kapsadım → `db:roles-rls:verify` düştü: sınıf matrisi operatörün insert
   edebilmesini bekliyor. 0058 zaten sahipliği UPDATE'te uyguluyor; precedent'e uydum.
2. İzleyiciye kendi görünümlerini verdim → Faz 24B'nin **"izleyici hiçbir tabloya yazamaz"**
   invariant'ı düştü. Geri aldım. İnvariant, kolaylıktan değerli: herkesin tek cümlede kontrol
   edebileceği bir kural, ilk istisnasını kazandığı anda her okuyucu kendi vakasının istisna mı
   kural mı olduğunu yeniden türetmek zorunda kalır.

Bir de politika **adı**: 0058'in koruyucusu `_select_all_tiers` son ekine bakıyor. Doğru ama son
eki tutmayan `saved_views_select_own_or_shared`, ledger-kurtarma provasında migration'ı düşürdü.
Ad artık iki bilgiyi de taşıyor.

### Yayınlanmış gerçek bir hata: sahiplik FK'leri boş bir tabloyu gösteriyordu

`auth.users` bu kurulumda **boş**; uygulamanın hesapları `public.users`'ta ve `session.id` oradan
geliyor. Dört kolon yine de `references auth.users(id)` diyordu — `background_jobs.created_by`
(Faz 33), `documents.created_by` / `attachments.uploaded_by` / `document_links.created_by`
(Faz 35).

Sonucu kozmetik değil: **`createDocument()` her giriş yapmış kullanıcı için başarısız**,
`enqueueJob()` gerçek bir aktör verildiğinde başarısız. İkisi de yayınlanmıştı.

**Neden hiçbir gate yakalamadı:** phase33:verify `actorId=null` geçiyordu, phase35:verify
dokümanları `created_by` içermeyen ham SQL ile yazıyordu. İkisi de test edilen alanı, **kırık bir
FK'yi sağlayan tek değerle** geçti. *Test edilen alandan kaçınan bir fixture, o alanın testi
değildir* — bu fazın en pahalı dersi ve gate'e kalıcı olarak yazıldı: artık hem şema genelinde
hiçbir sahiplik FK'sinin boş `auth.users`'ı göstermediği, hem de **gerçek bir oturum kullanıcısıyla**
doküman oluşturulabildiği doğrulanıyor.

### Global filtreler ve tablo standardı

Filtreler bir **değer**; URL doğruluk kaynağı. Bellekte tutulan bir filtre adlandırılamaz,
paylaşılamaz, bağlantılanamaz — ve iki kişinin farklı sayılara bakıp bunu fark edemediği o klasik
destek konuşmasını üretir. Paylaşılan bir bağlantıdaki **tek bozuk parametre**, gönderenin diğer
seçimlerini silmiyor. `describeFilters()` her export'a giriyor: filtrelendiğini söylemeyen bir
tablo, yanlış toplamı dolaştırmanın en kolay yolu.

Tablo standardında üç ayrıntı ölçülerek kondu: sıralama anahtarı **beyaz listeden** geçiyor
(query string'den gelir), sıralamaya her zaman **eşitlik bozucu** ekleniyor (yoksa sayfa 2, sayfa
1'in satırını tekrar edebilir), ve null'lar **iki yönde de sona** (bilinmeyen tutar en küçük tutar
değildir). Toplu işlem onayı kapsamı açıkça söylüyor: 12 görünen satır ile 40.000 görülmemiş satır
farklı kararlardır.

**İkinci bir export mekanizması icat edilmedi** — Faz 34'ün `analytics/export` rotası tek yol,
gate bunu doğruluyor.

### Örneklenen tutarlılık kontrol listesi (planın istediği gibi)

Her sayfa değil, **modül başına bir**, ve seçim gerekçeli: her modülün en **veri-yoğun** sayfası —
tablosu, boş durumu ve yükleme yolu olması en muhtemel, yani tutarsızlığın bulunmaya değer olduğu
ekran. ~60 sayfanın tamamını taramak çoğunlukla önemsiz özet ekranlarını yeniden doğrulardı ve
gate'i insanların çalıştırmayı bıraktığı kadar yavaşlatırdı.

Örneklem gerçek bir tutarsızlık buldu: `payments/items` ortak `PageHeader`'ı kullanmıyordu.
Düzeltildi. Bir modülde tek ekranın kendini farklı tanıtması, ürünün tasarlanmış değil monte
edilmiş hissettirmeye başladığı yerdir.

### Doğrulama

```
env -u DATABASE_URL MAS_RADAR_APP_DB_PASSWORD=... \
  MIGRATION_DATABASE_URL="postgresql://..." pnpm phase36:verify
```
**53/53, 3 kez art arda.** 949 birim testi (+26). `db:migrate:verify` 49/49,
`db:roles-rls:verify` 29/29.

> **AÇIK KARAR — muhasebe yazılımı seçimi kullanıcı onayı bekliyor.** Paraşüt / Logo / Mikro / Luca arasındaki seçim bu depodan türetilemez; şirketin hâlihazırda kullandığı pakete ve muhasebecisine bağlıdır. Faz 37 vendor-agnostik bir konnektör arayüzü teslim etti ve sıfır vendor uygulaması yazdı.

## Faz 37 — DONE (entegrasyon merkezi: dört konnektör, tek kuyruk, sıfır canlı çağrı)

Migration **0086**. Bu faz kategorik olarak farklıydı: üç gerçek kısıt vardı, ikisi çözüldü,
biri **bilerek aşılmadı**.

### DÜRÜSTLÜK NOTU — hiçbir şey canlı uçta test EDİLMEDİ

Bu ortamın dış ağ erişimi yok. Banka API'si, e-Fatura ve TCMB için **gerçek istek kurma mantığı**
yazıldı, ama hiçbiri canlı bir uca gönderilmedi ve gönderilemez. Kanıtlanabilen tek şey isteğin
**nasıl kurulduğu**, ve gate bunu `mockHttpClient` ile doğruluyor: URL, `Authorization` başlığı,
gövde. Bu, buradan kanıtlanabilecek şeyin dürüst sınırı — "canlı test edildi" demek yanlış olurdu.

Gate ayrıca **global bir fetch tuzağı** kuruyor: koşu boyunca herhangi bir kod gerçek bir istek
denerse URL kaydedilir ve gate düşer. Üç koşuda da tuzak hiç tetiklenmedi.

### AÇIK KARAR — muhasebe yazılımı seçimi kullanıcı onayı bekliyor

Paraşüt / Logo / Mikro / Luca arasındaki seçim bu depodan **türetilemez**: şirketin hâlihazırda
ödediği pakete, muhasebecisinin kullandığı yazılıma ve sahip oldukları sözleşmeye bağlı. Şemayı ne
kadar okursam okuyayım cevap çıkmıyor, ve tahmin etmek kimsenin istemediği vendor-şeklinde bir
entegrasyon üretirdi — defter verisini **yanlış sisteme** itme riskiyle.

Teslim edilen: vendor-agnostik bir konnektör **arayüzü** (kimlik doğrulama, senkron, hata/retry
şekli) ve **sıfır satır vendor uygulaması**. `accountingConnector()` gerçek bir konnektör ama
temiz ve **kalıcı** olarak reddediyor — karara bağlanmamış bir iş sorusunu tekrar denemek onu
çözmez, o yüzden iş anında ölü mektuba düşüyor, beş kez denenmiyor.

`provider` kolonu bilerek **kapalı liste değil**: bugün bir CHECK yazmak ya onlar adına tahmin
etmek ya da karar günü migration yazmak olurdu. Gate hem vendor-özel kod olmadığını hem de bu
notun docs'ta durduğunu doğruluyor.

### TCMB — Faz 27 zaten yapmıştı, yeniden yazmadım

Ayrıştırıcıyı (`parseTcmbXml`), sağlayıcıyı (`tcmbProvider`) ve yazıcıyı (`importRates`) Faz 27
gerçek bülten şeması testleriyle birlikte teslim etmiş; `fx_rate_snapshots` daha o zaman
`forex_buying/selling`, `banknote_buying/selling` ve `source='tcmb'` taşıyordu. Faz 37'nin eklediği
**zamanlanmış yarı**: aynı okuyucu, bir insan tıklaması yerine kuyruk tarafından aralıkla
sürülüyor.

Yol boyunca kendi varsayımım düzeldi: mock XML'imi **virgüllü** ondalıkla yazmıştım; TCMB'nin XML'i
**nokta** kullanır (virgül HTML gösteriminde). Ayrıştırıcı doğruydu, benim şema varsayımım
yanlıştı.

### Kuyruk GENİŞLETİLDİ, ikincisi kurulmadı

Dört senkron türü Faz 33'ün `background_jobs`'una eklendi. Retry, geri çekilme, ölü mektup ve
geçiş koruyucusu zaten oradaydı. Gate ikinci bir kuyruk/çalışma tablosu **açılmadığını**
doğruluyor.

**Faz 29'un sürüklenme dersi burada yeniden yaşandı:** DB CHECK'ini genişletip TS `JOB_TYPES`
listesini unuttum; `enqueueJob()` veritabanının kabul edeceği bir iş türünü reddetti. Typecheck
bunu göremez (şema `raw: unknown` alır). Gate artık iki listeyi **karşılaştırıyor**.

### Gate yakaladığı iki gerçek hata

1. **`bank_transactions.amount` NOT NULL.** Tutarı ayrıştırılamayan bir satırı `null` olarak
   yazmaya çalışıyordum — senkron çöküyordu. İki seçenek de yanlıştı: `0` yazmak olmayan bir
   sıfır-liralık hareket uydurur, `null` yazmak çökertir. Doğru cevap **atlamak ve saymak** —
   operatör bir satırın sunulup reddedildiğini görüyor ve bankayı arayabiliyor.
2. **Faz 19'un tek-yazar kuralı.** e-Fatura konnektörüm tedarikçiyi otomatik yaratıyordu;
   `phase19:verify` `parties`'e yazan tek dosyanın `counterparties/engine.ts` olması gerektiğini
   söyleyerek düştü. Kural doğru ve bu konnektör tam da var olma sebebi: tedarikçi-adı
   string'lerinden otomatik parti yaratmak, yazım hataları ve unvan varyantlarından kopyalarla
   listeyi doldurur ve kimse ona bir daha güvenmez. Artık **arıyor, yaratmıyor**; tanınmayan
   tedarikçinin faturası atlanıyor ve ayrıca sayılıyor (`unknownSupplier`), çünkü yeni bir
   karşı tarafı bir insanın tanımlaması doğru iş akışı.

İkinci hatayı bulduktan sonra gate'ime **uçtan uca e-fatura yazma testi** ekledim — çünkü yalnız
eşleme testleri yazma yolunu hiç çalıştırmıyordu, ve bu fazın kendi notu tam da onu Faz 33/35'te
kırık bir FK'nin yayınlanmasına izin veren hata olarak işaretliyor.

### Kimlik bilgisi bu veritabanında durmaz

Tablo bağlantının var olduğunu ve nasıl yapılandırıldığını tutar; token/parola/secret **asla**.
`credential_env_var` değerin **adını** taşır. Bu projenin her migration öncesi aldığı pg_dump aksi
hâlde bir kimlik sızıntısı olurdu. Gate: böyle bir kolon yok, ve konnektörler `process.env`'e hiç
dokunmuyor.

### Dört entegrasyon birbirinden bağımsız

Planın şartı. Konnektörler birbirini import etmiyor ve gate dördünü **ayrı bloklarda**
kapılıyor — birinin eksiği diğerlerinin çalışmasını ve raporlamasını durdurmuyor. Muhasebe bloğu
bir uygulamanın **yokluğunu** iddia ediyor, ki bu da o maddenin bilinçli olarak atlandığının
kanıtı.

### Doğrulama

```
env -u DATABASE_URL MIGRATION_DATABASE_URL="postgresql://..." pnpm phase37:verify
```
**59/59, 3 kez art arda**, üç koşuda da "hiçbir gerçek ağ isteği denenmedi". 949 birim testi.
