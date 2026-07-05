# Calculation Rules — v1 (Phase 0)

Deterministic rules. AI never computes source-of-truth values (CLAUDE.md). Every rule below must have a corresponding test before the module that uses it ships.

## Amount semantics

| Value | Meaning | Handling |
|---|---|---|
| `null` | unknown | excluded from sums; **counted and displayed** ("n kalem tutarı eksik"); never rendered as 0 |
| `0` | explicit zero | included in sums as 0 |
| negative | signed source value | context decides: checks/cashflow-balances = direction; ödeme tablosu = anomaly → review |

## Monthly cash-flow continuity

```
closing_balance = opening_balance + projected_income − projected_expense (+ adjustments)
next_month.opening_balance == previous_month.closing_balance
```

Mismatch ⇒ flag `continuity_break` (severity high). Known history: the original workbook had two breaks (haziran 2026 opening blank; ARALIK 2028 chained to EKİM 2028, skipping KASIM). Repaired in TEMİZ; validator still checks every import.

## Due-day normalization

- due_day 1–28 → direct date in instance month.
- due_day 29–31 in a shorter month → **last day of month** + flag `short_month_adjustment` (Şubat 2027→28, Şubat 2028→29 artık yıl, 30-day months→30).

## Instance generation

- Idempotency key: `(payment_id, instance_month)` — DB-level unique; regeneration never duplicates.
- Generation only for months ≥ payment creation month unless the row originates from a source workbook (then source month applies).
- Monthly recurrence **requires** `due_day` (DB constraint `payment_due_rule`).

## Payment status

- `paid` ⇒ `paid_at` not null (DB constraint `paid_requires_paid_at`).
- Overdue: `due_date < today` AND status ∈ {unpaid, partial}.
- Timezone for "today", reminder eligibility and reports: **Europe/Istanbul**.

## Risk thresholds (defaults; overridable in `settings`)

```
large_payment_threshold_try      = 50_000
critical_payment_threshold_try   = 100_000
same_day_cluster_count           = 3
negative_cash_threshold_try      = 0
high_customer_concentration_ratio = 0.40
high_bank_exposure_ratio          = 0.40
```

Day risk flags: cluster (count ≥ 3 pending same day), large (any known ≥ 50k), critical (any known ≥ 100k OR known day-sum ≥ 100k).

## Cash-flow analytics definitions

- **First negative month**: earliest month with `closing_balance < negative_cash_threshold_try`.
- **Worst month**: minimum `closing_balance` over horizon.
- **Consecutive negatives**: ≥3 sequential months with closing < 0 ⇒ escalate severity.
- **Concentration**: party share of period income (or expense) > 0.40 ⇒ flag; unknown-amount lines excluded from the ratio and disclosed.

## Loan calculations

- `total_finance_cost = total_payment − principal` (source: B11 = B10 − B4).
- Installment source formula: `PMT(rate_adj, term, −principal) × 1.0543084` — preserved as *source formula*, reconciled (±1 TL) against imported values; divergence ⇒ `loan_reconciliation` review, source value wins until reviewed.
- Debt-service monthly load = Σ installments due in month; overlay on cash-flow deficit months.

## Checks

- `direction = signed_amount < 0 ? outflow : inflow`; `amount = |signed_amount|`.
- Maturity grouping: ISO week and calendar month, Europe/Istanbul.
- Duplicate suspicion: same counterparty (KİMDEN if present, else KİME; TR-normalized so case variants like çağdaş/ÇAĞDAŞ match) + same |amount| within ±3 days ⇒ review, never auto-merge. (Real ÇEKLER sheet: KİMDEN empty; duplicates keyed by KİME.)

## Capacity / cost (analytics-only)

- Break-even TL/dk = allocated monthly fixed cost ÷ effective monthly minutes (minutes × efficiency).
- Normal vs overtime compared on identical part mix; outputs labeled *analytics, not accounting truth*.
- 2023 tariff rates in `kapasite` are stale ⇒ every derived figure carries `stale_rate` badge until user updates rates.

## Risk ladder (instance level — Phase 3)

`critical_payment → critical` · `overdue → high` · `large/cluster/negative → medium` · yalnız `missing_amount → low` · aksi `none`. Ödenmiş/iptal kayıtlar risk almaz. Yığılma sayımı aynı vade gününe düşen AÇIK kayıtlar üzerinden.

## Review-status semantics (mapping eligibility)

- inceleme yok (temiz satır) → aktarılabilir
- tüm incelemeler ∈ {accepted, resolved} → aktarılabilir (accepted = "bu haliyle doğru, aktar")
- herhangi biri ∈ {open, rejected} → AKTARILMAZ
- isimsiz satır → inceleme kabul edilse bile ASLA aktarılmaz (ad zorunlu)
- kabul edilen günsüz kalem → recurrence='irregular' olarak aktarılır; takvime giremez, Radar "günsüz" raporunda görünür
- kabul edilen negatif tutar → olduğu gibi korunur (confidence=variable), instance'ta negative_amount risk bayrağı sürer

## Horizon cards (Phase 4)

Çapa ay = bugünün ayı (veri aralığındaysa), değilse ilk veri ayı. Ufuklar 3/6/12/24/36 ay; pencere veri sonunu aşarsa kart "veri sonu" rozetiyle kesilir (uydurma projeksiyon yapılmaz). Pencere toplamları yalnız bilinen tutarlarla; eksik ay sayısı kartta beyan edilir.
