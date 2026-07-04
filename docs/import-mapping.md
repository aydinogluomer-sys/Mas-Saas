# Import Mapping Rules — v1 (Phase 0)

How each sheet family maps through the three layers: `source_*` → `import_rows`/`mapping_reviews` → domain tables. Grounded in the real audit of `mesaili_nakit_akış_tek_vardiya.xlsx` (42 sheets) and its cleaned TEMİZ variant (43 sheets). Nothing here authorizes skipping the review layer: ambiguous rows always land in `mapping_reviews`.

## 1. `ödeme tablosu` → payment_day_matrix

Layout: rows ≈3–25; col `A` = payment name; cols `B..AF` = days **1..31** (day = column_index − 1); col `AG` = amount candidate.

| Signal | Meaning | Mapping |
|---|---|---|
| `X`/`x` in day cell | due day marker | `payments.due_day` |
| numeric in day cell (e.g. `K23`=35000 on KİRA row) | due day **and** amount | `due_day` = that column, `default_amount` = value |
| `AG` numeric | monthly amount candidate | `default_amount`, `amount_confidence='variable'` |
| row with no marker (MAS ALARM-PRONET) | missing due day | payment with `due_day` null is invalid for `recurrence='monthly'` → keep as `import_rows.mapping_status='needs_review'` + `mapping_reviews(issue_type='missing_due_day')` |
| negative `AG` (MAS TELEFON TİJEN −60.000) | suspicious | `mapping_reviews(issue_type='negative_amount', severity='high')` |
| unlabeled amount (`AG25`=120.000, no name) | orphan value | `mapping_reviews(issue_type='unlabeled_amount', severity='high')` |
| implausible amount on row (telefon 45k/90k) | AG column alignment doubt | `mapping_reviews(issue_type='amount_alignment', severity='high')` — do **not** auto-write `default_amount` |

Party/category inference from name substrings (HALK/DENİZ/VAKIF/AKBANK/GARANTİ→bank; TELEFON/İNTERNET/ELEKTRİK/SU/KİRA/ALARM→category; MAS/ATİLLA/TİJEN/ÖMER/ESMA/ARMAĞAN→owner) is **suggestion-only**: written to `mapping_reviews.suggested_mapping`, never directly to domain tables.

## 2. `ÇEKLER` → checks

Columns (observed): date, serial, kime/payee, kimden/payer, bank (HALK/DENİZ/VİNOV), signed amount. Negative = outgoing obligation (**direction, not anomaly** — calculation-rules §amount-semantics). Consecutive duplicate-looking rows (AKR −45.000 ×2, çağdaş −100.000 ×2) → `mapping_reviews(issue_type='duplicate_check', severity='medium')`; import both, merge only after human review.

Map: `maturity_date`, `serial_no`, `payee_party_id`, `payer_party_id`, `bank_party_id`, `signed_amount` (as-is), `amount=abs(signed_amount)`, `direction = signed<0 ? 'outflow' : 'inflow'`.

## 3. `faiz hesaplama` → loans + loan_installments

Anchor cells (stable in both file variants):

| Cell | Field |
|---|---|
| B4 | principal (1.500.000) |
| B5 | term_months / installment basis (48) |
| B6 | simple/base rate (3,14) |
| B7 / B8 | BSMV %10 / KKDF %10 |
| B9 | installment_amount (PMT formula ×1,0543084 ≈ 71.744) |
| B10 / B11 | total_payment / total_finance_cost (fark) |
| F4 | first_payment_date (2024-10-18) |
| F5–F7 | applied rate 3,63 · monthly cost 4,80116 |

Amortization rows ~14..105 (col sums at row 12) → `loan_installments` (installment_no, due_date, amount, components). Reconciliation rule: Σ installments ≈ B10; B10 − B4 ≈ B11; mismatch → `mapping_reviews(issue_type='loan_reconciliation')`.

## 4. Monthly cash-flow sheets (×35) → cashflow_months + cashflow_lines

Header cell map (identical template all months):

| Cell | Field |
|---|---|
| B1 | opening_balance / devir (formula `='<prev>'!J1`) |
| D1 | projected_income / gelir (`=SUM(B3:B16)`) |
| F1 | projected_expense / gider (`=+B17+B26+G3+G17+G24+K3`) |
| H1 | monthly_delta / fark aylık |
| J1 | closing_balance / kasa (`=B1+D1−F1`) |

Line regions:
- `A3:E16` customer income (akon, metsan, hpt, egemet…; B=SUM(C:E)) → `line_type='customer_income'`, direction inflow, party from label.
- `F3:I16` CARİ ÖDEMELER (elit, çağdaş, akbaş…) → `vendor_payment`, outflow.
- `J3:M16` bankalar block (HESAP halk, halk business, halk kk-PARAF, deniz, vinov; L=−hesap, M=+hesap) → `bank_balance` / `credit_card`, direction `balance`; negatives are balances, not anomalies.
- rows 17–21 (J/K) side balance trackers (vakıf / elit / akon cari / akon tezgah; K = prev-month K + this-month H) → `adjustment` lines with note `side_tracker`; known historical chain defects (see data-map §anomalies) already repaired in TEMİZ.
- B17/B26 expense blocks rows 18–25 (ÜCRET GİDERLERİ H18, SGK, KDV, muhtasar…) → `operational_cost`/`tax`.
- `O4:O16` stray extra amounts → `unknown` lines + `mapping_reviews(issue_type='orphan_amount')`.
- TEMİZ-only rows: D30 FİNANSMAN GİDERLERİ (linked to faiz) → `loan_payment`; row 33 capacity ratio and row 34 ödeme-tablosu reference are **informational**, import as `unknown` with `amount_status='estimated'`, excluded from rollups.

Continuity: `next.B1 == prev.J1` must hold; both original-file breaks (haziran 2026 blank B1; ARALIK 2028 → EKİM 2028) are repaired in TEMİZ, but the validator must still flag any `continuity_break` on import — never trust, always verify.

## 5. `kapasite` → production_parts + capacity_models

Anchors: C1 freze TL/dk (`=12.58*1.6`, **2023 tarife** → `mapping_reviews(issue_type='stale_rate', severity='medium')`), C2 torna, B3 efficiency 0,75, L2/M2/N2/O2 = 60/22/24/12 time params, G5/H5 minute sums, I8 total capacity revenue (≈18,57M). Parts rows 10..113: A code, B name, C qty, D torna-min, E freze-min, G/H totals, I price. Missing operation time → part-level flag.

## 6. `maliyet-mastechnic` / `-mesaili` → capacity_models + cost_models

Two scenarios (`normal` | `overtime`). Extract fixed-cost blocks (yemek, yol personel/çırak, sağlık sigortası, makine sigortası…), staff/apprentice counts, monthly hours/minutes, efficiency, and break-even TL/dk outputs. Analytics-only; never feeds accounting truth.

## 7. `tablo` → machine_roi_snapshots (needs_review)

Machine economics + tax mixed with **personal/family expenses** (ev, tiyatro, harçlık). All rows import with `confidence='needs_review'`; personal-looking lines additionally get `mapping_reviews(issue_type='personal_data_mixed', severity='high')`. Nothing from this sheet reaches dashboards before review.

## 8. TEMİZ-only `DEĞİŞİKLİK NOTLARI`

Classifier: `unknown` (correct). Import raw, set `import_rows.mapping_status='ignored'` with note `cleanup_changelog` — preserved, traceable, excluded from finance.

## 9. Corrupt workbook handling

`TEMİZ-4` (all zero bytes) is the canonical failure fixture: importer records `source_workbooks.status='failed'`, `parse_error='no valid XLSX/ZIP signature…'`, UI shows the technical failure and allows re-upload. No partial rows are ever written for a failed workbook.
