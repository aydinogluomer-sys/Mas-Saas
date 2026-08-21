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
