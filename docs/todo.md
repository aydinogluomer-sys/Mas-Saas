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

## Phase 7+

- [ ] Capacity/cost analytics.
- [ ] Scenario engine.
