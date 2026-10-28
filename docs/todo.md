# MAS Nakit Radar — TODO v2

## Phase 0 — DONE

- [x] Verify current workbook parse status. (orijinal+TEMİZ parsed; TEMİZ-4 corrupt, documented)
- [x] Implement workbook parser spike using xlsx/exceljs.
- [x] Build data-map for all sheets. (data-map.md v3 + phase0-parse-report.md)
- [x] Classify sheet types. (42/43 sheets, no silent discard)
- [x] Document import assumptions. (import-mapping.md, calculation-rules.md)
- [→] source_* migrations: implementation.md §20 uyarınca Phase 1 teslimatı — Phase 1 listesine taşındı.

## Phase 1 — DONE

- [x] source_* migrations (0001)
- [x] parties/categories/cash_accounts (0002)
- [x] payments/payment_instances + idempotency unique (0003)
- [x] cashflow_months/lines/snapshots (0004)
- [x] checks/check_events/loans/loan_installments (0005)
- [x] settings/audit_logs + reminders/reminder_deliveries/reports (0002+0006)
- [x] RLS all tables + policies (0007)
- [x] seed (18 kategori · 16 parti · 6 hesap · 7 ayar · 5 hatırlatma kuralı)
- [x] Types generated from verified schema (22 tables) — pnpm db:types
- [x] Verify: pnpm db:verify — 2× tam sıfırlama, 10 iddia grubu PASS

## Phase 2 — DONE

- [x] Imports list + workbook upload (server action, raw preservation)
- [x] Workbook detail (meta, sha256, failed parse_error yüzeyi)
- [x] Sheet list + detected type / confidence badges
- [x] Raw row/cell viewer (sayfalama, formül işareti, needs_review rozeti)
- [x] Mapping review table (filtre + kabul/ret/çözüldü + audit_logs)
- [x] Payment-day matrix preview
- [x] Monthly cashflow preview (kimlik rozeti dahil)
- [x] Checks preview (yön/çift-kayıt rozetleri)
- [x] Verification: import:real — 43 sekme, 9.817 hücre sıfır kayıp, 58 review, bozuk dosya failed-path, E2E smoke 3×200

## Phase 3 — DONE

- [x] Accepted candidates → payments mapping (eligibility: temiz ∪ accepted/resolved; open/rejected/isimsiz hariç)
- [x] Idempotent monthly instance generator (ON CONFLICT + partial-unique; tekrar=0 kanıtlı)
- [x] Payment CRUD (create/update/archive, audit'li; aylıkta gün zorunlu doğrulaması)
- [x] Today/tomorrow/next-7 view (/radar)
- [x] Monthly payment calendar (/calendar, gün detayı + risk kenarlıkları)
- [x] Missing amount report (instance'a özel tutar girme; null asla 0 olmaz)
- [x] Overdue report
- [x] Payment risk flags (ladder + gün bayrakları; eşikler settings'ten)
- [x] Paid/unpaid marking → audit_logs (before/after doğrulandı)
- [x] /radar dashboard
- [x] Verification: phase3:verify ALL PASS (gerçek veri, 19 kalem, Şubat kırpma DB'de, DB-unique dupe engeli, +2 audit)

## Phase 4 — DONE

- [x] Cash-flow dashboard (/cashflow, /cashflow/[monthId]); 35 ay kaynak mutabakatı, zincir bayrağı, projeksiyon, konsantrasyon.

## Phase 5 — DONE (checks + financing)

- [x] financing/rules.ts saf fonksiyonlar + 20 birim test (signed→direction, hafta/ay maturity, ISO-week, exposure %40, scheduleDueDates, reconcileLoan flag-only, debtService).
- [x] extractLoan (extractors.ts) + 5 birim test (faiz hesaplama çapaları, F4 serial, boş-A satırı döngüyü durdurur, null asla 0).
- [x] Migration 0008: checks.source_row_id + loans.source_sheet_id partial-unique (idempotency) + 2 yeni assertion.
- [x] Migration 0009: checks.counterparty_label (ham KİME/KİMDEN korunur — Phase 4 label deseni; parti sessiz yaratılmaz).
- [x] Engine: mapAcceptedChecks (signed→yön, |amount|, banka ASCII-lowercase eşleşme, çift-kayıt açık=hariç), mapLoans (ambiguity açık=hariç, Σtaksit mutabakatı, sapma→loan_reconciliation, kaynak değeri kazanır), loaders + loadMaturityItems.
- [x] extractLoan importer'a bağlandı (faiz hesaplama issue'ları review olur).
- [x] /financing (ufuk pencereleri 7/14/30, kredi kartları, aylık borç servisi, banka+karşı-taraf exposure, vade takvimi 12 hafta, çek defteri yön rozetli) + /financing/loans/[loanId] (taksit planı, türetilmiş vadeler) + nav ÇEK/KREDİ aktif + workbook "çek/kredi aktar" butonu.
- [x] phase5-verify.ts (PHASE5_SRC ile dry-run edilebilir): eligibility+idempotency, signed→yön, negatif-anomali-değil, maturity SQL cross-check, banka exposure SQL, kredi mutabakatı (total=B10, cost=total−principal), 48 taksit türetimi, DB uniques, borç servisi. **Dry-run (ÇEKLER/faiz-özdeş orijinal): ALL PASS.**
- [ ] **BEKLİYOR:** import:real / phase3:verify / phase4:verify / phase5:verify GERÇEK TEMİZ.xlsx üzerinde (dosya makinede yok — kullanıcıdan bekleniyor). Bu 4 gate yeşil olmadan commit YOK.

## Phase 6A — DONE (reports + debt-service overlay)

- [x] reports/rules.ts saf fonksiyonlar + 9 birim test (istanbulDateISO tz, buildDaily/Weekly/Monthly, overlayDebtService pressure, buildCommentaryPrompt mutasyon-yasağı). null asla 0 ("TUTAR EKSİK").
- [x] reports/engine.ts: generateDaily/Weekly/Monthly → reports tablosuna snapshot yazar, audit'li; loaders reuse (radar/queries, financing/engine, financing/rules). **Mali kayıt mutasyonu YOK** (before==after fingerprint kanıtlı).
- [x] Borç-servisi × nakit-akış overlay (loadDebtOverlay) → /cashflow ay tablosuna "borç servisi" kolonu + baskı/izle rozetleri (kullanıcının "eklensin" isteği).
- [x] AI yorum promptu yalnız string (buildCommentaryPrompt) — model çağrılmaz, mutasyon yasağı metni gömülü; /reports/[id]'de "model çağrılmadı" rozetiyle gösterilir.
- [x] /reports (üret + geçmiş liste) + /reports/[reportId] (body_md + prompt) + nav RAPOR aktif.
- [x] phase6-verify.ts: 3 rapor SQL cross-check, overlay 35 ay SQL-birebir, **mali bütünlük before==after**, commentary prompt-only, Istanbul tz, audit 3 satır. **ALL PASS (gerçek TEMİZ).**
- [x] Gate: lint ✓ typecheck ✓ vitest 96/96 ✓ db:verify ✓ import:real ✓ phase3-6:verify ✓ build ✓ smoke (/reports, rapor detay, /cashflow overlay 200).

## Phase 6B — DONE (reminders)

- [x] reminders/rules.ts saf fonksiyonlar + 14 birim test (scheduledForDate offset 7/3/1/0/−1, isEligible aktif+unpaid/partial+tz+eşik, thresholdPasses null-asla-hariç, eligibleDeliveries, buildReminderMessage tüm alanlar). null asla 0 → "tutar eksik".
- [x] reminders/transport.ts: Transport arayüzü + mockTransport (success/failOn) + telegramTransport (token/chat SERVER-ONLY env, erişilemezse fırlatmaz→failed döner, token client'a sızmaz).
- [x] reminders/engine.ts: scheduleReminders (eligibility→pending, ON CONFLICT duplicate önleme, DB-idempotent), dispatchPending (her denemeyi teslimat satırına LOGLAR: sent/failed+sent_at+error, exception fırlatmaz), loaders. **Mali kayıt mutasyonu YOK.**
- [x] /reminders (durum sayaçları + planla/gönder butonları + teslimat kaydı tablosu) + nav HATIRLATMA aktif.
- [x] phase6b-verify.ts: eligibility (6 teslimat doğru offset), duplicate önleme (schedule#2=0 + DB unique), mock success (sent+sent_at+mesaj alanları), idempotent gönderim, **failure yolu (failed+error loglandı)**, mali bütünlük before==after, Istanbul tz. **ALL PASS.**
- [x] Gate: lint ✓ typecheck ✓ vitest 110/110 ✓ db:verify ✓ import:real ✓ phase3-6+6b:verify ✓ build ✓ smoke (/reminders 200).

## Phase 7 — DONE (kapasite/maliyet analitiği)

- [x] Migration 0010: 6 üretim tablosu (implementation.md §14 + Phase-7 sertleştirme: kapasite rate/theoretical-revenue/stale kolonları, cost break-even/effective-minutes) + RLS/policy + idempotency uniques + machine seed (Awea/Arion/Sister/Doosan) + assertions (RLS 6 yeni tabloyu kapsar, ROI needs_review default, 3 idempotency).
- [x] production/rules.ts saf fonksiyonlar + 18 birim test (effectiveMinutes, utilizationRate, breakEvenTLPerMin, capacityGap, theoreticalRevenue, compareScenarios normal/mesaili, partProfitability missing-op→needs_review, machineRoi needs_review, revenueGap, buildInsights). null asla 0.
- [x] extractCapacity (C1/C2 rate + B3 verim + I8/K8 teorik + parça bloğu, **gap-toleranslı → sessiz atlama yok**) + extractCostModel (A2/A6/E6/F6/G6/B7 çapa + effective-minutes & break-even mutabakat) → importer'a bağlandı (stale_rate/missing_operation_time/reconciliation reviews).
- [x] production/engine.ts: mapCapacitySheet (68 parça, source_row izli, ON CONFLICT idempotent), mapCostSheets (normal+mesaili, sapma→review kaynak kazanır), calculatePartProfitability (idempotent, süre-eksik→needs_review+null maliyet), ~~calculateMachineRoiSnapshot (needs_review)~~ **[Bulgu #3 ile kaldırıldı]**, loaders + demand/actual-income.
- [x] /production UI: disclaimer "Analitik tahmindir; muhasebe gerçeği değildir." + kapasite kartları + NORMAL vs MESAİLİ + TL/dk maliyet + teorik vs gerçek gelir + kapasite kullanımı (aşırı yük/atıl) + maliyet tablosu + parça kârlılığı (en düşük 20 marj) + makine ROI + deterministik içgörüler + kaynak linkleri. nav ÜRETİM, workbook "üretim analitiğini aktar" butonu.
- [x] phase7-verify.ts: **sessiz-atlama-yok (68 parça talep=kaynak G5+H5)**, kaynak izlenebilirlik, stale-rate bayrağı, başabaş=kaynak G6 birebir (normal 26.18/mesaili 21.54, mutabakat), süre-eksik→needs_review+null, ROI needs_review, idempotency, **mali bütünlük before==after (Phase 7 hiçbir mali tabloyu değiştirmez)**. ALL PASS.
- [x] Gate: lint ✓ typecheck ✓ vitest 128/128 ✓ db:verify ✓ import:real ✓ phase3-7:verify ✓ build ✓ smoke (/radar,/cashflow,/financing,/reports,/reminders,/production 200).

## Phase 9 — DONE (Excel kapsama boşlukları — docs/excel-coverage-gaps analizi; 9A/9B/9C/9D tamam, implementation.md Faz 10)

### 9A — DONE (maliyet detayı + Akon kâr marjı)
- [x] `priceMargin` saf fonksiyon + 4 test (Akon TL/dk − başabaş; zarar bayrağı; null-asla-0). vitest 149.
- [x] Migration 0012: `cost_breakdown_lines` (blok/etiket/tutar, kaynak-izli, idempotent) + `cost_models.akon_freze/torna` + assertions (RLS+idempotency).
- [x] extractCostModel genişletildi: 28 gider döküm satırı (sabit defter A8:B24 + genel/personel blokları E/F/G) + Akon K2/K4. Engine mapCostSheets bunları yazar (kaynak-izli).
- [x] /production: **"KÂR MARJI — AKON FİYATI vs BAŞABAŞ"** paneli (her senaryo kendi Akon oranıyla; **normal torna ZARARINA satış** bayraklı) + "Sabit gider dökümü" DetailsDisclosure. Ana Ekran "Üretim içgörüsü" şeridi zarar durumunu gösterir.
- [x] **Gerçeklik:** iki maliyet sekmesinin kendi Akon oranları farklı (normal 27,5/21,88 · mesaili 25/19,89); her model kendi oranını kullanır.
- [x] phase9a-verify: Akon kaynak K2/K4 birebir, 28 döküm kaynak-izli, marj=fiyat−başabaş, normal-torna zarar bayraklı, **mali bütünlük before==after**. Gate: typecheck/lint/test 149/db:verify/import:real/phase3-8+9a/build ✓.
### 9B — DONE (aylık gider dökümü)
- [x] F1 gider formülü analizi: `gider = BORÇLAR(B17)+STANDART(B26)+vendor(G3, zaten var)+PERSONEL(G17)+GENEL(G24)+banka(K3)`. 4 eksik blok (BORÇLAR/STANDART/PERSONEL/GENEL) **bileşen satırları** (alt-toplam değil → çift-sayım yok) eklendi.
- [x] extractMonthlyCashflow genişletildi: A18:B25, A27:B31, F18:G23, F25:G31 → cashflow_lines (loan_payment/tax/operational_cost; etiket keyword ile sınıflandırma). Etiketsiz-ama-tutarlı satır (ör. ÜCRET GİDERLERİ) düşmez. Engine değişmedi (data.lines otomatik yazar).
- [x] /cashflow/[monthId]: İŞLETME GİDERLERİ · VERGİ/SGK · KREDİ/FİNANSMAN grupları eklendi.
- [x] phase9b-verify: **35 ay Σgider-satırı = kaynak B17+B26+G17+G24 mutabakatı** (çift-sayım yok), 910 satır %100 kaynak-izli, idempotent, **ay toplamları değişmedi** (kompozisyon gider/kasayı bozmaz). Gate: typecheck/lint/test 149/db:verify/import:real/phase3-8+9a+9b/build ✓.
- [x] 9C makine ROI+ekipman (tablo, kişisel hariç) · 9D kapasite makine-dakika + finansman maliyeti makine tahsisi. Motor ve bağımsız `/production/roi` ile `/production/capacity` arayüzleri mevcut.

## Phase 8 — DONE (senaryo motoru) — MVP TAMAMLANDI

- [x] Migration 0011: 5 senaryo tablosu (scenarios/scenario_runs/scenario_run_lines/scenario_assumptions/scenario_comparisons) + RLS/policy + assertions (run-line idempotency, comparison uniqueness, cascade delete).
- [x] scenario/rules.ts saf fonksiyonlar + 10 birim test (applyScenario: revenue/expense %, customer delay=zamanlama, debt overlay, capacity/efficiency + closing zinciri yeniden kurma; compareScenarioToBaseline: ilk negatif/en kötü/maks açık/toparlanma/final Δ; scenarioConfidence; buildScenarioInsights). null asla 0; belirsiz tutar ölçeklenmez.
- [x] scenario/engine.ts: createScenario, runScenario, createAndRun, loadScenarioRun, listScenarioRuns, compareScenarioToBaselineRun, deleteScenarioRun (güvenli cascade) — **salt-okunur** (baseline+mali tablolara yazmaz), her run audit'li + açık varsayım satırları.
- [x] /scenarios UI: disclaimer + varsayım formu (gelir/gider/gecikme/kapasite/verim %, borç-servisi checkbox) + çalışma listesi; /scenarios/[runId]: sonuç kartları (final baz/senaryo/Δ, ilk negatif, en kötü, maks açık, toparlanma) + açık varsayımlar + içgörüler + baz-vs-senaryo SVG chart + aylık karşılaştırma tablosu + güvenli sil. nav SENARYO; /cashflow·/production·/financing'e "senaryo üret" linkleri.
- [x] phase8-verify.ts: **baseline immutable** (row-hash before==after), **mali bütünlük** (payments/cashflow/checks/loans/reminders/reports/production before==after), senaryo yalnız scenario_* tablolarına yazar, revenue%→yalnız gelir, expense%→yalnız gider, gecikme=zamanlama-değil-tutar, karşılaştırma=SQL, deterministik içgörü, güvenli cascade sil. ALL PASS.
- [x] Gate: lint ✓ typecheck ✓ vitest 138/138 ✓ db:verify ✓ import:real ✓ phase3-8:verify ✓ build ✓ 8-route smoke (radar/cashflow/financing/reports/reminders/production/scenarios + senaryo detay 200).
- [x] docs/mvp-runbook.md yazıldı; mas-nakit-radar-mvp.zip üretildi.

## Deploy — DONE (yerel özel production hazırlığı, Option A)

- [x] MVP zip doğrulandı + temiz klasörde fresh install (install/lint/typecheck/test 138/build) yeşil — zip kaynaktan yeniden derlenebilir.
- [x] Deploy dosyaları: docker-compose.yml (kalıcı volume, 127.0.0.1 bind, healthcheck), .env.example (DATABASE_URL/APP_ACCESS_PASSWORD/TELEGRAM_*/version), scripts/deploy/{local-start,local-stop,backup-db,restore-db}.sh + check-env.ts (secret maskeler, presence-only).
- [x] /health (app+DB erişilebilirlik, secret yok, 200/503) + /version (name/version/commit/build/node, secret yok) route handler'ları.
- [x] ~~Minimal access gate: APP_ACCESS_PASSWORD…~~ **(GEÇERSİZ — P0-A ile kaldırıldı; aşağıdaki P0-A bölümüne bakın.)** Tarihsel kayıt olarak duruyor.
- [x] Güvenlik audit: tek client component (upload-form) yalnız server action referansı; token yalnız transport.ts (server); .xlsx client bundle'a girmez; env/secret loglanmaz.
- [x] Backup/restore ispatı: pg_dump → taze DB restore (0 hata, sayaçlar birebir 2/9817/1601, 33 tablo, 0 RLS-kapalı, seed intact).
- [x] docs/local-production-deploy.md + mvp-runbook güncellendi.
- [x] Gate: lint ✓ typecheck ✓ vitest 138 ✓ db:verify ✓ import:real ✓ phase3-8:verify ✓ build ✓ 9-route smoke (+/health +/version).

## P0-C (minimal) — DONE (migration ledger altyapısı, iki-AI denetim sonrası)

- [x] `schema_migrations` ledger (migration 0020/0021), checksum (BOM+CRLF normalize), advisory lock, dört durumlu state machine (EMPTY/LEGACY_COMPLETE/LEDGER_MANAGED/LEDGER_EMPTY_RECOVERY) — `scripts/db/migrate.ts` (`npm run db:migrate`).
- [x] Backup helper `scripts/db/backup-docker-postgres.ts` (streaming, pg_restore--list doğrulamalı, cluster-identity eşleşmesi `pg_control_system()`).
- [x] `scripts/db/legacy-baseline-0019.json` — 0001-0019 için version-control'lü checksum manifest.
- [x] Disposable-DB test paketi `scripts/db/migrate-verify.ts` (`npm run db:migrate:verify`): 31/31 assertion geçti (file-set validation, manifest-drift, EMPTY, LEGACY_COMPLETE+idempotency, checksum-drift, LEDGER_EMPTY_RECOVERY smoke, cluster-identity).
- [x] `scripts/deploy/local-start.sh` artık var olan DB'de migrasyonu atlamıyor — her çalıştırmada `migrate.ts` çağırıyor.
- [x] Gerçek `mas_radar_dev` 2026-07-18'de kontrollü migre edildi (LEGACY_COMPLETE, 21 satır, veri değişmedi, doğrulanmış yedek alındı).
- [x] Gate: typecheck ✓ lint ✓ (0 hata, 1 önceden var olan uyarı) ✓ vitest 188/188 ✓ build ✓.
- Kapsam dışı bırakıldı (sıradaki fazlar): yeni finansal DB constraint'leri (P0-B), auth (P0-A).

## Frontend polish — DONE (UI/UX, mali mantık değişmedi)

- [x] Tasarım sistemi: globals.css design tokenları (surface/line/text/financial/focus/radius) + a11y base (focus-visible ring, ::selection, scrollbar, reduced-motion) + subtle CSS motion (rise-in/stagger, prefers-reduced-motion'a saygılı).
- [x] Shared primitives: PageHeader, KpiCard, StatBox, ChartShell (sr-only özet + empty), TableShell (a11y region + scroll), EmptyState, Disclaimer, Nav (aktif route aria-current). Panel/Badge geriye uyumlu zenginleştirildi (accent, dot, AA kontrast).
- [x] Layout/nav: sticky header + marka accent rail + client Nav aktif-route state + logout; main `.stagger` giriş kaskadı.
- [x] Route polish: radar/cashflow/financing/reports/reminders/production/scenarios → tutarlı PageHeader + KpiCard grid + ChartShell + Disclaimer bileşenleri; chart renkleri token paletine hizalandı.
- [x] A11y: h1(PageHeader)/h2(Panel) semantik, `:focus-visible` ring, chart `role=img`+`aria-label`+`sr-only` özet, nav `aria-current`, TableShell labeled region, renk-tek-anlam yok. Responsive: KPI grid 4/5→2, nav wrap, geniş tablolar TableShell'de kayar.
- [x] Playwright visual regression: 7 route baseline (`tests/visual/__snapshots__`), deterministik `data-vr` + `[data-volatile]` gizleme; `pnpm test:visual` / `test:visual:update`. Gate: lint ✓ typecheck ✓ vitest 138 ✓ db:verify ✓ import:real ✓ phase3-8:verify ✓ build ✓ 9-route smoke ✓ visual 7/7 ✓.
- [x] docs/frontend-polish-guidelines.md yazıldı.

## UX refactor — DONE (decision-first cockpit; mali mantık/hesaplama/modül DEĞİŞMEDİ)

- [x] Gerçek Ana Ekran `/` (redirect kaldırıldı, `(dashboard)/page.tsx`): 5 KeyStat (bugün çıkış · 7 gün çıkış · geciken · ilk negatif ay · en kötü ay) + tek-cümle "en büyük risk" + "Ne yapmalıyım?" (max 5 deterministik aksiyon) + durum şeridi (son rapor / hatırlatma / üretim). Salt-okunur, mevcut loader'ları composla; yeni sorgu/math yok.
- [x] `src/lib/home/cockpit.ts` saf modül (buildActions/pickHeadlineRisk) + 7 birim test — severity sıralama, max-5 cap, null-asla-0, boş-durum tek satır, no-LLM. vitest 145.
- [x] Nav birincil 6'ya indirildi (Ana Ekran/Ödemeler=/radar/Nakit Akış/Finansman/Senaryolar/Yönetim); ikincil route'lar `/admin` Yönetim hub'ında (Takvim, ödeme kalemleri, içe aktarım, raporlar, hatırlatmalar, üretim, incelemeler) — hiçbir route silinmedi.
- [x] Ana route'lar yeniden sıralandı (özet→içgörü→aksiyon→grafik→detay); teknik detaylar (cashflow 35-ay tablosu, financing çek defteri + vade takvimi, scenarios geçmiş) `DetailsDisclosure` (native `<details>`, JS'siz, erişilebilir) altında collapse.
- [x] Senaryo: 3 hızlı preset (Gelir %10↓, Gider %10↑, Borç-servisi dahil — motor birebir) + disabled "Hpt 30 gün gecikirse · müşteri bazlı gecikme yakında" çipi; advanced özel form collapse. Kural: preset adı = motorun tam yaptığı.
- [x] Görsel sadeleme: body fontu sans (sayılar/kodlar/etiketler mono kalır), büyük hero sayılar (KeyStat), düz Türkçe etiketler, daha az panel.
- [x] Visual spec'e `/` eklendi; guidelines'a IA bölümü. Gate: lint ✓ typecheck ✓ vitest 145 ✓ db:verify ✓ import:real ✓ phase3-8:verify ✓ build ✓ 11-route smoke ✓ visual 8/8 ✓.


## P0-A — DONE (gerçek çok-kullanıcılı auth, kullanıcı yönetimi, yarım kalan geçişin kapatılması)

- [x] Migration 0031 `users` + `sessions`: argon2id hash, username CHECK, admin/operatör rolü,
      5 hatalı giriş → 15 dk kilit, RLS **default-deny** (kimlik bilgisi tutan tek tablolar),
      "en az bir aktif admin" deferred constraint trigger (DB seviyesinde, arayüzde değil).
- [x] Migration 0032: `audit_logs.actor_id` → `public.users(id)` FK. Oturumsuz araçlar rezerve
      `system` hesabına yazar (`scripts/db/seed-system-actor.ts`) — sessiz null actor yok.
- [x] `src/middleware.ts` default-deny matcher (`/login`,`/health`,`/version`,`_next/*` hariç her yol).
      Gerçek boşluk kapatıldı: `src/app/api/facts` auth'suz finansal veri servis ediyordu.
- [x] Eski `APP_ACCESS_PASSWORD` tek-paylaşılan-parola gate'i tamamen kaldırıldı (kod + docs).
- [x] `scripts/db/seed-admin.ts`: ilk admin bootstrap; parola argv'den kabul edilmez
      (`SEED_ADMIN_PASSWORD` env veya maskeli TTY girişi), min 12 karakter, idempotent.
- [x] **Kullanıcı yönetimi ekranı** `/system/security` (tamamı `requireAdmin()` arkasında):
      liste (rol/durum/kilit/açık oturum/son görülme) + oluştur + parola sıfırla + rol değiştir +
      pasifleştir/aktifleştir + kilit aç. Motor `src/lib/users/engine.ts`, hepsi audit'li.
      Parola denetim kaydına ASLA yazılmaz; sıfırlama/pasifleştirme oturumları aynı transaction'da
      iptal eder; rezerve hesaplar yönetilemez; admin kendi erişimini kaldıramaz.
- [x] **135 typecheck hatası kapatıldı** (20 script dosyası): engine imzalarına eklenen `actorId`
      çağrı yerlerine işlenmedi ve repo build alamıyordu. `reconciliation-verify` + `transitions-verify`
      dahil hepsi rezerve `system` actor'ına bağlandı.
- [x] Phase verify script'leri `audit_logs` TRUNCATE etmiyor artık (0022 append-only değişmezi
      **zayıflatılmadı**); her verify çalışması taze oluşturulan atılabilir DB alıyor.
- [x] `scripts/db/assertions.sql`: `schema_migrations` policy istisnası — sessiz atlama değil,
      karşılığında RLS açık / 0 policy / 0 uygulama-grant'i açıkça iddia ediliyor.
- [x] `src/lib/feature-registry.ts`: sahte `tested: true` kaldırıldı → `verifiedBy` (özelliği gerçekten
      çalıştıran gate script'i). `/phases` artık "elle tutulan envanter, canlı durum değil" diyor.
- [x] **Gate:** lint ✓ (0 hata, 1 önceden var olan uyarı) · typecheck ✓ 0 hata · vitest 200/200 ✓ ·
      db:verify ✓ · db:migrate:verify ✓ · build ✓ · phase3…14e verify **20/20 PASS** (atılabilir DB,
      `mas_radar_dev`'e dokunulmadan) · 9-modül smoke ✓.


## Wave 0 / S3 — DONE (uydurma rakamlar; incelenmemiş 46541d8 katmanının seçici karantinası)

- [x] `/finance/cockpit` ve `/finance/chains` ekranları, `/api/chains`, `src/lib/chains/*`,
      `nervous-system-hub`, `scripts/test-live-chains.ts` ve testleri kaldırıldı (sabit TL yedekleri,
      demo faturalar, oturum kapısız server action'lar, arka uca gitmeyen "uygulandı" butonları).
- [x] Yalnız bu ekranlarca kullanılan motorlar testleriyle kaldırıldı: cash-runway,
      dynamic-discounting, fx-hedging, simulations/sandbox, cash-pooling, headroom-engine,
      budget/guardrail, audit/hash-chain, fraud-guard, auto-matcher, discipline-engine.
- [x] İncelenmiş sayfalara takılan şelale (`/cashflow`), kum havuzu (`/scenarios`), "DSO radarı"
      (`/finance/counterparties`) ve brifing yönetici görünümü (`/insights/briefing`) kaldırıldı;
      sayfalar `af210fd`'ye döndü.
- [x] R3: CFO copilot (widget, `/api/ai/cfo-chat`, copilot-engine, guardrails) ve onay gatekeeper'ı
      karantinada (etikette korunuyor); `boundary-verify` izin listesi yine 4 modül.
- [x] ⌘K paleti, `/system` (gerçek `select 1` yoklaması), `/payments/missing` boş durumu, Ana Ekran
      onboarding'i `af210fd`'ye döndü; sistem açıklamasından "kriptografik denetim", finansman
      sekmelerinden ve ölçüm betiklerinden kaldırılan rotalar çıktı.
- [x] R10: 12 aylık kasa eğilimi (`closingTrend`), nakit köprüsü (bilinmeyen açılış → ölçülemez),
      brifing rozeti (`briefingStatus`: "likidite bilinmiyor"), kokpit nakit kutusu ("Taban tanımlı
      değil") — birim testli; `tests/no-fabricated-figures.test.ts` sayfa bağlantısını korur.
- [x] Gate: vitest 2002/2002 ✓ · boundary:verify 8/8 ✓ · typecheck kaynakta 0 hata (yalnız eski
      `.next/types`) · lint: kalan sorunlar yalnız sonraki dilimlerin dosyalarında.
- [ ] Backlog (LABEL): belgelenmiş model sabitlerini ekranda "varsayım" olarak etiketle — radar eşik
      varsayılanları, senaryo optimizasyon varsayımları, tahsilat olasılık katsayıları.


## Wave 0 / S4 — DONE (süreç içi önbellek ve açılış ön yüklemesi; incelenmemiş 46541d8 katmanının seçici karantinası)

- [x] `src/lib/cache/*` ve `tests/cache-invalidation.test.ts` silindi. Farkı yalnız önbellek olan 26 dosya
      `af210fd`'ye döndü; karışık dosyalarda (Ana Ekran, `/system/security`, `users/engine`, `ai/engine`,
      `approvals/engine`) yalnız önbellek satırları çıktı — KEEP zorunlu parola değişikliği, S3'ün R10
      düzeltmesi ve R6 OpenAI zaman aşımı duruyor. S2'nin kaldırdığı oturum önbelleği geri gelmedi.
- [x] `jobs/dispatcher.ts` (KEEP) önbellekten ayrıldı: iş sonrası etiket düşürme ve `cacheTagsToInvalidate`
      yok; `tests/job-dispatcher.test.ts` claim → çalıştır → complete/fail akışını test ediyor.
- [x] `radar/engine.ts`'teki `NODE_ENV === "test"` kaçışı kaldırıldı; `generate-instances-audit.test.ts`
      (CASE C/D) üretimdeki yolda yeşil.
- [x] 60 rotalık açılış ön yüklemesi (perde, ısıtma efekti, CSS, `preload-routes.ts`, layout rota listeleri) ve
      sidebar/sekme hover-focus `prefetchLinkHandlers` kaldırıldı; next/link varsayılan prefetch'i kalır.
- [x] `navigation-feedback.test.tsx` yeniden yazıldı (eski koda karşı 7 iddianın 5'i kırmızı — anti-totoloji);
      `interactive-readiness.spec.ts` perde iddialarını bıraktı, ilk-tıklama bütçesi TREND
      (`NAVIGATION_CLICK_BUDGET_MS` verilirse SERT); `tests/interaction/workspace-ready.ts` açıklaması güncel.
- [x] Gate: vitest 1997/1997 ✓ · boundary:verify 8/8 ✓ · typecheck kaynakta 0 hata (yalnız eski
      `.next/types`) · lint: kalan sorunlar yalnız sonraki dilimlerin dosyalarında.
- [ ] İlk tıklama gecikmesini production derlemesinde, sentetik veritabanına karşı yeniden ölç ve yeni tabanı
      `NAVIGATION_CLICK_BUDGET_MS` olarak sabitle (Playwright bu dilimde koşturulmadı — DB kuralı).
- [ ] S7 restyle geri dönüşü: `af210fd`'nin `globals.css`/`module-tabs.tsx` sürümleri perde CSS'ini ve
      `prefetchLinkHandlers` kullanımını geri getirir — bu dilimin kaldırmalarını koru; iskelet gecikmesinin
      iki CSS kuralını (`.is-active`, `.navigation-skeleton-active`) taşı ya da gecikmeyi birlikte geri al.


## Wave 0 / S5 — DONE (Import V2; incelenmemiş 46541d8 katmanının seçici karantinası)

- [x] Excel formül hatası her kolon tipinde BİLİNMİYOR: değer null, `formula_error` (yüksek), satır reddedilir,
      ham hücre `row_json`'da; katmanın `#REF!` → 0 ve metinde sessiz boş davranışı ve onu kilitleyen testler gitti.
- [x] Birleştirilmiş hücre: değer yalnız ana hücreden; diğerleri null + `raw.__merged__`; `merged_cell` (orta);
      birleştirilmiş başlık sessizce veri düşürmüyor. Önizlemede FORMÜL HATALARI / BİRLEŞTİRİLMİŞ HÜCRELER listeleri.
- [x] R8: asenkron yol yalnız önizler (rapor `background_jobs.payload.result`); kimlik `created_by` + `public.users`
      (varsayılan rol/aktör yok), önizleme kişinin katmanında (`runAsUser`), kuyruk işlemleri `runAsSystem` + 'system'
      hesabı; uuid sahneleme belirteci, SHA doğrulaması, terminalde silme, 24 saatlik süpürme; GET uuid/katman/sahiplik.
- [x] `/imports`, yükleme formu, `/data/imports/v2` ve önizleme akışı `af210fd`'ye döndü (Phase 5 açıklaması,
      §4.2 sayaç adları, `İÇE AKTAR` etiketi).
- [x] R9: Phase 5 sayım/matris tutarsızlığı (40/9 ↔ 39/10) tarihçeden çözülemedi → hiçbir kolon kaldırılmadı;
      gerekçe karar belgesinde. Şablon 2.0.0 / `f965a1ba…` değişmedi.
- [x] Gate: vitest 2063/2063 ✓ · boundary:verify 8/8 ✓ · typecheck kaynakta 0 hata (yalnız eski `.next/types`) ·
      lint: kalan sorunlar yalnız sonraki dilimlerin dosyalarında.
- [ ] Sahip kararı: Phase 5 `REMOVED_FROM_FUTURE_TEMPLATE` dokuz kolonu ADIYLA teyit edilsin; sonra tek sürümde
      `ColumnSpec.removedFromTemplate` + şablon filtresi + `missingColumns` hariç tutma + `TEMPLATE_VERSION` 2.1.0 +
      README'ye formül hatası ve birleştirilmiş hücre kuralları + `pnpm import:template:v2` + belge sayımı.
- [ ] `background_jobs.result jsonb` kolonu ve `payload`/`created_by`/`job_type` değişmezlik tetikleyicisi (Wave 0'ın
      tek migration'ı başka dilimde; sonuç şimdilik `payload.result`'ta).
- [ ] Önizleme işçisinin (`scripts/ops/process-import-jobs.ts`) çalıştırılma kararı: package script + zamanlanmış görev
      (ops). Bugün kuyruğa alınan önizlemeler işçi elle koşturulana kadar bekler.
- [ ] Sentetik DB'de uçtan uca: Excel'de üretilmiş `=1/0` / `#N/A` / birleştirilmiş çek tutarı dosyası (önizleme
      sayaçları, onay sonrası `mapping_reviews`, domain sayıları değişmemiş); asenkron yol + işçi; `interaction:test --
      import-v2` ve etkileşim kapsam kapısı.
