# MAS Nexus — Financial Ledger, Reconciliation & Data Integrity Report (`Agent 04`)

- **Agent:** `AGENT 04 — FINANCIAL LEDGER, RECONCILIATION & DATA INTEGRITY` (`Phase D`)
- **Target Database:** `mas_radar_dev` (`PostgreSQL 16.14`, queried strictly under `default_transaction_read_only = on` / `BEGIN READ ONLY`)
- **Financial Safety Guarantee:** `0` `INSERT` / `UPDATE` / `DELETE` statements executed against `mas_radar_dev`; `null` (unknown) amounts are never coerced to `0` (`BLANK != ZERO`); exact kuruş reconciliation (`unexplainedGapTry === 0`) verified across `2026-06` through `2028-11`.

---

## 1. Assigned Incidents & Remediation Summary

| Incident ID | Observed Discrepancy | Root Cause Proven in Code + Live `mas_radar_dev` | Agent 04 Deliverables | Status |
| :--- | :--- | :--- | :--- | :--- |
| **`I-009`** | `30,000 TRY` monthly gap (`540,000` vs `510,000` and `552,500` vs `522,500`); `2026-06` `50,000 TRY` cancelled row | Legacy `monthSummary()` summed `amount` in `known_total` without `status <> 'cancelled' and cancelled_at is null`, including `23fcaf63-de67-4dc6-88f0-a69416a8dd56` (`VAKIF KREDİ 2`, `30,000.00 TRY`, `cancelled_at = 2026-07-22T08:02:07.815Z`) while `known_remaining` excluded `'cancelled'`. In addition, `monthSummary()` lacked `overpaymentAdjustmentTry` and `unexplainedGapTry` for overpaid settlements. | Hardened `monthSummary()` with `overpayment_adjustment_try`, non-negative `settlement_adjustment_try`, and `unexplainedGapTry` (`0.00 TRY` across all months); added `distribution(pool, monthStartISO, by)` with 1:1 PK joins and identical `cancelled` / `inflow` exclusion. | **VERIFIED** |
| **`I-012`** | `VAKIF KREDİ 2` (`30,000 TRY`, `status = 'partial'`) original vs remaining ambiguity | Live row `0fbd2b5b-0a12-41b5-9bbe-23c8d079f03d` (`due_date = 2026-07-23`) has `amount = 30000.00`, `paid_amount = 12000.00`, `status = 'partial'` (`remaining = 18000.00`). `InstanceRow` previously exposed only `amount` and `paid_amount`, leaving downstream consumers prone to summing `amount` (`30,000`) instead of outstanding balance (`18,000`). | Extended `InstanceRow` and `mapInstanceRow()` via `Contract A` (`computeObligationAmounts`) to populate `original_amount`, `remaining_amount`, and `overpayment_amount` on every decoded row while preserving `amount` and `paid_amount` for backward compatibility. | **VERIFIED** |
| **`I-011`** | `11/19` missing amounts, `19 vs 20` categories, `92` overdue (`2,560,000 TRY`), `Çağdaş` × 3/4 | (1) `92` overdue items as of `2026-11-14` (`93` as of `2026-11-18`) have `31` (`32`) known TRY rows + `61` `amount IS NULL` rows, zero SQL join multiplication (`536 = 536`), and `100%` distinct `(payment_id, instance_month)` pairs; `2,560,000.00 TRY` was the original sum vs `2,548,000.00 TRY` remaining (`12,000.00 TRY` partial payment on `0fbd2b5b`). (2) `public.checks` holds `3 × 2026-08-31` `100,000.00 TRY` active `Çağdaş` rows (`528f6b52`, `4aa4a727`, `78db5fe2` — imported when `mapping_reviews` treated `'resolved'` as `'accepted'`) + `1 × 2026-10-31` `100,000.00 TRY` archived row (`f65484b7`). | Verified zero join multiplication, distinct installment identities, `null` preservation, explicit `cancelled` exclusion in `overdueOpen()`, and non-destructive `control_duplicate_checks` visibility without mutating or deleting canonical check rows. | **VERIFIED** |
| **`I-010`** | Available cash `unknown` (`FIN-03`), `0` bank flows vs negative monthly cash | All `6` active rows in `public.cash_accounts` (`Deniz`, `Halk Business`, `Halk KK - Paraf`, `HESAP Halk`, `Kasa`, `Vinov`) have `opening_balance IS NULL`, `public.bank_transactions` has `0` rows, and `public.cashflow_months` (`35` rows) is a workbook `FORECAST` turning negative from `2026-09-01` (`-58,176.53 TRY`; `2026-11-01 = -543,764.76 TRY`). | Confirmed `loadFourWaySubledgerHealth()` reports `bank_102` as `status = 'unknown_opening_balance'`, `subledgerTry = null`, `unknownOpeningCount = 6` (`FIN-03`), never coercing unknown opening balances to `0`. | **VERIFIED** |

---

## 2. Reproducible Read-Only Forensics on `mas_radar_dev`

### 2.1 `I-009`: Exact Reproduction of the `30,000 TRY` Monthly Discrepancy (`2026-11` & `2026-06`)

**Reproducible Read-Only SQL:**
```sql
SELECT
  to_char(instance_month, 'YYYY-MM-DD') AS month_start,
  count(*)::int AS all_rows,
  count(*) FILTER (WHERE status <> 'cancelled' AND cancelled_at IS NULL AND coalesce(direction, 'outflow') = 'outflow')::int AS active_outflow_count,
  count(*) FILTER (WHERE status <> 'cancelled' AND cancelled_at IS NULL AND coalesce(direction, 'outflow') = 'outflow' AND amount IS NULL)::int AS missing_count,
  coalesce(sum(amount) FILTER (WHERE coalesce(direction, 'outflow') = 'outflow' AND amount IS NOT NULL AND currency = 'TRY'), 0) AS raw_total_incl_cancelled,
  coalesce(sum(amount) FILTER (WHERE status <> 'cancelled' AND cancelled_at IS NULL AND coalesce(direction, 'outflow') = 'outflow' AND amount IS NOT NULL AND currency = 'TRY'), 0) AS known_total,
  coalesce(sum(CASE WHEN status = 'paid' THEN coalesce(paid_amount, amount) WHEN status = 'partial' THEN coalesce(paid_amount, 0) ELSE 0 END) FILTER (WHERE status <> 'cancelled' AND cancelled_at IS NULL AND coalesce(direction, 'outflow') = 'outflow' AND amount IS NOT NULL AND currency = 'TRY'), 0) AS paid_known,
  coalesce(sum(greatest(amount - coalesce(paid_amount, 0), 0)) FILTER (WHERE status <> 'cancelled' AND cancelled_at IS NULL AND coalesce(direction, 'outflow') = 'outflow' AND amount IS NOT NULL AND currency = 'TRY' AND status IN ('unpaid','partial','planned','late')), 0) AS known_remaining,
  count(*) FILTER (WHERE (status = 'cancelled' OR cancelled_at IS NOT NULL) AND coalesce(direction, 'outflow') = 'outflow')::int AS cancelled_count,
  coalesce(sum(amount) FILTER (WHERE (status = 'cancelled' OR cancelled_at IS NOT NULL) AND coalesce(direction, 'outflow') = 'outflow' AND amount IS NOT NULL AND currency = 'TRY'), 0) AS cancelled_known_total
FROM public.payment_instances
WHERE instance_month IN ('2026-06-01', '2026-07-01', '2026-08-01', '2026-09-01', '2026-10-01', '2026-11-01', '2026-12-01')
GROUP BY instance_month
ORDER BY instance_month;
```

**Measured Output (`mas_radar_dev`):**

| `month_start` | `all_rows` | `active_outflow` | `missing_count` | `raw_total_incl_cancelled` | `known_total` | `paid_known` | `known_remaining` | `cancelled_count` | `cancelled_known_total` | `unexplainedGapTry` |
| :--- | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: | :---: |
| `2026-06-01` | `18` | `17` | `11` | `540,000.00` | `490,000.00` | `155,000.00` | `335,000.00` | `1` | `50,000.00` | **`0.00`** |
| `2026-07-01` | `18` | `18` | `11` | `540,000.00` | `540,000.00` | `12,000.00` | `528,000.00` | `0` | `0.00` | **`0.00`** |
| `2026-08-01` | `18` | `17` | `11` | `540,000.00` | `510,000.00` | `0.00` | `510,000.00` | `1` | `30,000.00` | **`0.00`** |
| `2026-09-01` | `18` | `17` | `11` | `540,000.00` | `510,000.00` | `0.00` | `510,000.00` | `1` | `30,000.00` | **`0.00`** |
| `2026-10-01` | `18` | `17` | `11` | `540,000.00` | `510,000.00` | `0.00` | `510,000.00` | `1` | `30,000.00` | **`0.00`** |
| `2026-11-01` | `18` | `17` | `11` | `540,000.00` | `510,000.00` | `0.00` | `510,000.00` | `1` | `30,000.00` | **`0.00`** |
| `2026-12-01` | `18` | `17` | `11` | `540,000.00` | `510,000.00` | `0.00` | `510,000.00` | `1` | `30,000.00` | **`0.00`** |

- **Exact `2026-11` Breakdown:**
  - `6` active known-TRY rows (`garanti kredi` `190,000.00`, `TİJEN AKBANK KREDİ KARTI` `120,000.00`, `MAS TELEFON ÖMER` `90,000.00`, `ATİLLA AKBANK KREDİ KARTI` `50,000.00`, `KİRA` `35,000.00`, `garanti kk` `25,000.00`) = **`510,000.00 TRY`**.
  - `11` active missing-amount rows (`amount IS NULL`) = kept strictly `null` (`missing_count = 11`).
  - `1` cancelled row: `id = 23fcaf63-de67-4dc6-88f0-a69416a8dd56` (`payment_id = 239bd2b1-35c0-4581-b0d1-b446fc220355`, `VAKIF KREDİ 2`, `due_date = 2026-11-23`, `amount = 30000.00`, `status = 'cancelled'`, `cancelled_at = 2026-07-22T08:02:07.815Z` via `audit_logs.id = 0b73849f-decb-4d32-b7ce-4ef57dd5f83e` `legacy_archive_cascade_repair`).
  - Why both **`540,000 vs 510,000`** and **`552,500 vs 522,500`** occurred: On the canonical `TEMİZ.xlsx` dataset (`510,000.00 TRY` active), including `23fcaf63` (`30,000.00 TRY`) in `known_total` while excluding `'cancelled'` from `known_remaining` produced `540,000 vs 510,000`; during an earlier run containing an extra `12,500.00 TRY` active unpaid obligation (`510,000 + 12,500 = 522,500.00 TRY` active; `20` templates vs `19`), the exact same cancelled row `23fcaf63` produced `552,500 vs 522,500`.
- **Exact `2026-06` Cancelled Row:** `id = 77815c3d-6762-4382-b49e-65905c07d8df` (`ATİLLA AKBANK KREDİ KARTI`, `due_date = 2026-06-24`, `amount = 50000.00`, `status = 'cancelled'`, `cancelled_at = 2026-07-17T13:14:33.238Z`), explaining `540,000.00` raw vs `490,000.00` active (`155,000.00` paid across `33ad79cf` `120,000.00` + `e71705d1` `35,000.00`, plus `335,000.00` remaining).

---

### 2.2 `I-012`: Partial Payment Forensics (`VAKIF KREDİ 2`)

**Reproducible Read-Only SQL:**
```sql
SELECT i.id, p.name AS payment_name, to_char(i.due_date, 'YYYY-MM-DD') AS due_date,
       i.amount, i.paid_amount, (i.amount - coalesce(i.paid_amount, 0)) AS remaining_amount,
       i.status, i.paid_at, i.currency, i.direction
FROM public.payment_instances i
LEFT JOIN public.payments p ON p.id = i.payment_id
WHERE i.id = '0fbd2b5b-0a12-41b5-9bbe-23c8d079f03d';
```

- **Measured Row:** `id = 0fbd2b5b-0a12-41b5-9bbe-23c8d079f03d`, `payment_name = 'VAKIF KREDİ 2'`, `due_date = '2026-07-23'`, `amount = 30000.00`, `paid_amount = 12000.00`, `remaining_amount = 18000.00`, `status = 'partial'`, `paid_at = 2026-07-17T13:14:33.193Z` (`audit_logs.id = c96a22b8-d0d2-4e91-8ee7-d6a8d944d4d0`, `action = 'mark_partial'`).
- **Decoded via `mapInstanceRow()` (`Contract A`):** `amount = 30000`, `original_amount = 30000`, `paid_amount = 12000`, `remaining_amount = 18000`, `overpayment_amount = 0`.

---

### 2.3 `I-011`: Overdue `92` vs `93` Items, Join Cardinality & `Çağdaş` Checks

**Reproducible Read-Only SQL (Overdue Exposure Breakdown):**
```sql
SELECT
  $1::text AS as_of,
  count(*)::int AS overdue_count,
  count(DISTINCT i.id)::int AS distinct_id_count,
  count(*) FILTER (WHERE i.amount IS NULL)::int AS missing_amount_count,
  count(*) FILTER (WHERE i.amount IS NOT NULL AND i.currency = 'TRY')::int AS known_try_count,
  coalesce(sum(i.amount) FILTER (WHERE i.amount IS NOT NULL AND i.currency = 'TRY'), 0) AS sum_original_try,
  coalesce(sum(coalesce(i.paid_amount, 0)) FILTER (WHERE i.amount IS NOT NULL AND i.currency = 'TRY'), 0) AS sum_paid_try,
  coalesce(sum(greatest(i.amount - coalesce(i.paid_amount, 0), 0)) FILTER (WHERE i.amount IS NOT NULL AND i.currency = 'TRY'), 0) AS sum_remaining_try
FROM public.payment_instances i
LEFT JOIN public.payments p ON p.id = i.payment_id
LEFT JOIN public.categories c ON c.id = p.category_id
WHERE i.due_date < $1::date
  AND i.status IN ('unpaid','partial','planned','late')
  AND i.status <> 'cancelled'
  AND i.cancelled_at IS NULL;
```

- **As of `2026-11-14`:** `92` overdue items (`distinct_id_count = 92` — **zero SQL join multiplication**), comprising `31` known-TRY items and `61` missing-amount (`amount IS NULL`) items.
  - `sum_original_try = 2,560,000.00 TRY` (what daily reports previously summed because `0fbd2b5b` contributed `30,000.00` instead of `18,000.00`).
  - `sum_paid_try = 12,000.00 TRY` (`0fbd2b5b` partial payment).
  - `sum_remaining_try = 2,548,000.00 TRY` (exact unpaid overdue exposure).
- **As of `2026-11-18`:** `93` overdue items (`distinct_id_count = 93`; +1 item `c9ee2b41-8452-4ac0-b23f-dfa764fef670` `garanti kredi`, `due_date = 2026-11-16`, `amount = 190,000.00 TRY`), `sum_original_try = 2,750,000.00 TRY`, `sum_paid_try = 12,000.00 TRY`, `sum_remaining_try = 2,738,000.00 TRY`.
- **Global Join & Recurring Installment Identity Check (`public.payment_instances`):**
  - `raw_pi_count = 536`, `joined_pi_count = 536`, `distinct_id_count = 536`, `template_backed_count = 536`, `distinct_payment_month_pairs = 536`. Every recurring monthly installment has a unique `id` and a unique `(payment_id, instance_month)` pair.
- **Active Templates (`19` total in `public.payments`):** `18` active (`17` `monthly` + `1` `irregular` `56ba301a-ee4a-4866-994b-561bb4117989` `MAS ALARM-PRONET` with `0` November instances) + `1` archived (`239bd2b1` `VAKIF KREDİ 2`).
- **`Çağdaş` Checks in `public.checks` & `public.mapping_reviews`:**
  - `528f6b52-1aa0-41e1-9f29-ce886c96d19c` (`row_index = 7`, `maturity_date = 2026-08-31`, `amount = 100000.00`, `status = 'planned'`, active)
  - `4aa4a727-0f54-4218-a82a-5a6a27cbd91a` (`row_index = 11`, `maturity_date = 2026-08-31`, `amount = 100000.00`, `status = 'planned'`, active — linked `mapping_reviews` `7eb11b43` `issue_type = 'duplicate_check'`, `status = 'resolved'`)
  - `78db5fe2-4949-4704-aa56-fd6d7be9c754` (`row_index = 18`, `maturity_date = 2026-08-31`, `amount = 100000.00`, `status = 'planned'`, active — linked `mapping_reviews` `cb6bcef8` & `884a088f`, `issue_type = 'duplicate_check'`, `status = 'resolved'`)
  - `f65484b7-f483-4b8a-ae8e-13f87759bc2e` (`row_index = 20`, `maturity_date = 2026-10-31`, `amount = 100000.00`, `status = 'planned'`, `archived_at = 2026-07-17T13:14:47.251957+00:00`)
  - All `3 × 2026-08-31` active checks remain intact (zero destructive deletion) and are transparently flagged by `public.control_duplicate_checks`, while `mapAcceptedChecks()` in `src/lib/financing/engine.ts` now blocks `'resolved'` `duplicate_check` reviews unless explicitly `'accepted'`.

---

### 2.4 `I-010` (`FIN-03`): Cash Accounts, Bank Transactions & Workbook Forecast

**Reproducible Read-Only SQL:**
```sql
SELECT
  (SELECT count(*)::int FROM public.cash_accounts WHERE is_active = true AND archived_at IS NULL) AS active_accounts,
  (SELECT count(*) FILTER (WHERE opening_balance IS NULL)::int FROM public.cash_accounts WHERE is_active = true AND archived_at IS NULL) AS null_opening_accounts,
  (SELECT count(*)::int FROM public.bank_transactions) AS bank_tx_count,
  (SELECT count(*)::int FROM public.cashflow_months) AS forecast_months_count;
```

- **Measured Output:** `active_accounts = 6` (`Deniz`, `Halk Business`, `Halk KK - Paraf`, `HESAP Halk`, `Kasa`, `Vinov`), `null_opening_accounts = 6`, `bank_tx_count = 0`, `forecast_months_count = 35` (`2026-05-01` .. `2029-03-01`; workbook forecast turns negative in `2026-09-01` at `-58,176.53 TRY` and reaches `-543,764.76 TRY` in `2026-11-01`).
- **4-Way Reconciliation Verification (`loadFourWaySubledgerHealth`):** Pillar `bank_102` returns `status = "unknown_opening_balance"`, `subledgerTry = null`, `deltaTry = null`, `unknownOpeningCount = 6` — strictly upholding `FIN-03` (`null` opening balances are never coerced to `0.00 TRY`).

---

## 3. Reconciliation Identity Implemented in `src/lib/radar/queries.ts`

For every calendar month (`instance_month = YYYY-MM-01`), active known-amount `TRY` `outflow` obligations satisfy the exact kuruş identity:

$$\text{known\_total} + \text{overpaymentAdjustmentTry} = \text{paid\_known} + \text{known\_remaining} + \text{settlementAdjustmentTry}$$

$$\text{unexplainedGapTry} = \operatorname{round2}\!\Big(\text{known\_total} + \text{overpaymentAdjustmentTry} - (\text{paid\_known} + \text{known\_remaining} + \text{settlementAdjustmentTry})\Big) \equiv 0$$

- **Unpaid / Planned / Late (`amount = A`):** `known_total = A`, `known_remaining = A`, `paid_known = 0` $\Rightarrow$ gap $= 0$.
- **Partial (`amount = A`, `paid_amount = P <= A`):** `known_total = A`, `paid_known = P`, `known_remaining = A - P` $\Rightarrow$ gap $= 0$.
- **Paid with Settlement Discount (`amount = A`, `paid_amount = P < A`):** `known_total = A`, `paid_known = P`, `settlementAdjustmentTry = A - P` $\Rightarrow$ gap $= 0$.
- **Paid / Partial with Overpayment (`amount = A`, `paid_amount = P > A`):** `known_total = A`, `paid_known = P`, `overpaymentAdjustmentTry = P - A`, `settlementAdjustmentTry = 0` $\Rightarrow$ gap $= 0$.
- **Cancelled (`status = 'cancelled'` or `cancelled_at IS NOT NULL`):** Excluded from active `known_total`, `paid_known`, `known_remaining`, and `distribution()`; disclosed separately via `cancelledCount` and `cancelledKnownTotal`.
- **Unknown (`amount IS NULL`):** Preserved as `null` on `InstanceRow` (`amount`, `original_amount`, `remaining_amount`) and counted in `missing_count` — never coerced to `0`.

---

## 4. Files Changed (Strictly Within Agent 04 Exclusive Ownership)

1. [queries.ts](file:///c:/Users/Trade%20Bilisim/Mas%20Saas/src/lib/radar/queries.ts) *(UPDATED)*
   - Imported `computeObligationAmounts` (`Contract A`) and enriched `InstanceRow` + exported `mapInstanceRow()` with `original_amount`, `remaining_amount`, and `overpayment_amount` while preserving `amount` and `paid_amount` for 100% backward compatibility.
   - Hardened `overdueOpen()` with explicit `i.status <> 'cancelled' and i.cancelled_at is null` predicates.
   - Extended `monthSummary()` with `MonthSummaryResult`, SQL `overpayment_adjustment_try`, non-negative `settlement_adjustment_try` (`greatest(..., 0)`), `amount is not null` parity on `paid_known`, safe mock-pool fallback decoding, and `unexplainedGapTry`.
   - Added exported `distribution(pool, monthStartISO, by)` (`'provider' | 'category' | 'owner'`) using 1:1 PK `LEFT JOIN`s (zero row multiplication) and identical `cancelled` / `inflow` filtering, returning `amount`, `remainingAmount`, `paidAmount`, `count`, and `foreignCount`.
2. [agent04-financial-reconciliation.test.ts](file:///c:/Users/Trade%20Bilisim/Mas%20Saas/tests/remediation/agent04-financial-reconciliation.test.ts) *(CREATED)*
   - 5-test Vitest verification suite covering `Contract A` / `mapInstanceRow` (`null` preservation, partial `30k/10k/20k` & `30k/12k/18k`, cancelled, discount, overpayment), deterministic kuruş identity across mixed synthetic obligations + legacy mock-pool fallback, live read-only `mas_radar_dev` `monthSummary` & `distribution` parity (`2026-06`..`2026-12`), live `overdueOpen` (`2026-11-14` = `92` items vs `2026-11-18` = `93` items), join cardinality, recurring `(payment_id, instance_month)` uniqueness, `Çağdaş` check preservation, `FIN-03` null opening balances, and pre/post financial table digest equality.
3. [financial-reconciliation-report.md](file:///c:/Users/Trade%20Bilisim/Mas%20Saas/docs/remediation/financial-reconciliation-report.md) *(CREATED)*
   - This forensic reproduction and verification report.

---

## 5. Verification Commands & Results

| Command | Scope | Result | Evidence |
| :--- | :--- | :--- | :--- |
| `pnpm boundary:verify` | Static boundary & egress gate | **PASS (`exit 0`)** | `8/8 sınır kontrolü geçti. BOUNDARY VERIFY: ALL PASS` (zero `process.env`, zero `fetch` in `src/lib/radar/queries.ts`). |
| `pnpm phase17:verify` | Decimal money & zero `::float8` gate | **PASS (`exit 0`)** | `9/9 kontrol geçti. PHASE17 VERIFY: ALL PASS`. |
| `npx vitest run tests/remediation/agent04-financial-reconciliation.test.ts` | Agent 04 unit + live read-only DB invariants | **PASS (`exit 0`)** | `5/5 tests passed` (`default_transaction_read_only = on`, `unexplainedGapTry === 0` across `2026-06..2026-12`). |
| `npx vitest run tests/remediation/mandatory-16-scenarios.test.ts -t "Scenario 7"` | Mandatory Scenario 7 (`I-009` `30,000 TRY` cancelled row) | **PASS (`exit 0`)** | `1 passed` (`522,500 === 0 + 522,500`, `cancelledKnownTotal = 30,000`). |
| `npx tsc --noEmit` | Full repository TypeScript check | **PASS (`exit 0`)** | `0` type errors across `src/`, `scripts/`, and `tests/`. |

---

## 6. Zero Data Mutation Proof & Handoff to Agent 08

- **Pre-Test vs Post-Test Live `mas_radar_dev` Financial Digest (`100%` Identical):**
  - `payment_instances`: `536` rows (`sum(amount) = 16080000.00`, `sum(paid_amount) = 167000.00`)
  - `payments`: `19` rows
  - `checks`: `7` rows (`sum(amount) = 590000.00`)
  - `loan_installments`: `48` rows (`sum(amount) = 3443717.76`)
  - `cash_accounts`: `6` rows (`6` with `opening_balance IS NULL`)
  - `bank_transactions`: `0` rows
- **Handoff for Agent 08 (`src/lib/reports/*` & `src/lib/briefing/rules.ts`):**
  - `overdueOpen()`, `instancesBetween()`, `instancesOn()`, and `monthInstances()` in `src/lib/radar/queries.ts` now populate `original_amount`, `paid_amount`, `remaining_amount`, and `overpayment_amount` on every `InstanceRow`, allowing `toReportInstance()` in `src/lib/reports/engine.ts` to forward `originalAmount`, `paidAmount`, and `outstandingAmount` directly without re-deriving.
  - `monthSummary()` now returns `overpaymentAdjustmentTry` and `unexplainedGapTry` alongside `cancelledCount`, `cancelledKnownTotal`, and `settlementAdjustmentTry`, and `distribution(pool, monthStartISO, by)` is exported from `src/lib/radar/queries.ts` for optional adoption by `generateMonthly()`.
