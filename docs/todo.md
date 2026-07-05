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

## Phase 3

- [ ] Payment CRUD.
- [ ] Instance generation.
- [ ] Calendar.
- [ ] Missing data.
- [ ] Paid/unpaid marking.

## Phase 4+

- [ ] Cash-flow dashboard.
- [ ] Checks/loan dashboard.
- [ ] Reminder engine.
- [ ] Reports.
- [ ] Capacity/cost analytics.
- [ ] Scenario engine.
