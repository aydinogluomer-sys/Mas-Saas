# MAS Nakit Radar — TODO v2

## Phase 0 — DONE

- [x] Verify current workbook parse status. (orijinal+TEMİZ parsed; TEMİZ-4 corrupt, documented)
- [x] Implement workbook parser spike using xlsx/exceljs.
- [x] Build data-map for all sheets. (data-map.md v3 + phase0-parse-report.md)
- [x] Classify sheet types. (42/43 sheets, no silent discard)
- [x] Document import assumptions. (import-mapping.md, calculation-rules.md)
- [→] source_* migrations: implementation.md §20 uyarınca Phase 1 teslimatı — Phase 1 listesine taşındı.

## Phase 1

- [ ] Create source_workbooks/source_sheets/source_cells/import_rows/mapping_reviews migrations. (Phase 0'dan taşındı)
- [ ] Create shared references: parties, categories, cash_accounts.
- [ ] Create payment tables.
- [ ] Create cashflow tables.
- [ ] Create checks and loan tables.
- [ ] Create settings/audit tables.
- [ ] Add RLS.
- [ ] Add seed data.
- [ ] Generate types.

## Phase 2

- [ ] Workbook upload UI.
- [ ] Sheet browser.
- [ ] Mapping review UI.
- [ ] Payment-day matrix preview.
- [ ] Monthly cash-flow preview.
- [ ] Checks preview.

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
