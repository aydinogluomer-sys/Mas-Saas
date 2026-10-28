# Cutover fingerprint — 2026-08-25

- Clone: `mas_radar_stage11_clone` (her koşuda düşürülüp yeniden yaratılır)
- Ledger: öncesi `34/0034` → sonrası `87/0087`
- Sonuç: **PASS** (14/14)

## Değişmezler

| Kontrol | Sonuç | Ayrıntı |
|---|---|---|
| fresh dump alındı | PASS | 869575 bayt |
| pg_restore --list arşivi okuyabiliyor | PASS | 391 TOC girdisi |
| öncesi parmak izi alındı | PASS | 43 tablo · ledger 34/0034 · operator=2 |
| ledger satır sayısı = 87 | PASS | 87 |
| ledger son sürüm = 0087 | PASS | 0087 |
| bayat 'operator' rolü kalmadı | PASS | 0 satır |
| finance_manager artışı = önceki operator sayısı | PASS | önce 0 → sonra 2 (operator 2) |
| en az bir aktif admin | PASS | 1 aktif admin |
| users_role_check beş katmanı sayıyor | PASS | CHECK ((role = ANY (ARRAY['viewer'::text, 'finance_operator'::text, 'finance_approver'::te |
| FK hedefleri çözülüyor | PASS | 170 FK, hedefsiz 0 |
| blanket 'authenticated_all' RLS politikası yok | PASS | 0 adet |
| assistant arşiv tutarlılık kısıtı yerinde | PASS | status↔archived_at↔archive_reason bağlı |
| migration checksum drift = 0 | PASS | 87 ledger satırı diskle uyumlu |
| legacy finansal tabloların veri hash'i DEĞİŞMEDİ | PASS | payments=b57642e6 payment_instances=2194273f checks=c1ce99d2 loans=1bba5c47 loan_installments=6ea1679b cashflow_months=e1aee258 |

## Rol sayıları

| Rol | Öncesi | Sonrası |
|---|---:|---:|
| admin | 10 | 10 |
| finance_manager | 0 | 2 |
| operator | 2 | 0 |

## Parasal toplamlar

| Alan | Öncesi | Sonrası |
|---|---:|---:|
| payments.default_amount | 540000.00 | 540000.00 |
| payment_instances.amount | 14550000.00 | 14550000.00 |
| checks.amount | 590000.00 | 590000.00 |
| loans.principal | 1500000.00 | 1500000.00 |
| loan_installments.amount | 3443717.76 | 3443717.76 |
| cashflow_months.closing_balance | -53839702.88 | -53839702.88 |

## Legacy finansal tablolar (hash öncesi/sonrası)

| Tablo | Satır (ö→s) | Hash öncesi | Hash sonrası | Aynı? |
|---|---|---|---|---|
| payments | 19→19 | `b57642e6e2b8` | `b57642e6e2b8` | EVET |
| payment_instances | 485→485 | `2194273fb67d` | `2194273fb67d` | EVET |
| checks | 7→7 | `c1ce99d24d85` | `c1ce99d24d85` | EVET |
| loans | 1→1 | `1bba5c477255` | `1bba5c477255` | EVET |
| loan_installments | 48→48 | `6ea1679b9be5` | `6ea1679b9be5` | EVET |
| cashflow_months | 35→35 | `e1aee2583ad7` | `e1aee2583ad7` | EVET |

## Beklenen mutation whitelist dışındaki hash değişimleri

- `schema_migrations` (34 → 87 satır)
- `users` (12 → 12 satır)

## Yeni tablolar (şema eklemesi — whitelist)

- `alert_escalation_rules` (2 satır)
- `approval_rules` (5 satır)
- `approval_steps` (0 satır)
- `approvals` (68 satır)
- `assistant_conversations` (0 satır)
- `attachments` (0 satır)
- `background_jobs` (0 satır)
- `bank_accounts` (0 satır)
- `bank_transaction_match_candidates` (0 satır)
- `bank_transactions` (0 satır)
- `budget_lines` (0 satır)
- `budgets` (0 satır)
- `collateral_records` (0 satır)
- `control_alerts` (0 satır)
- `cost_allocation_rules` (4 satır)
- `cost_centers` (0 satır)
- `counterparty_profiles` (0 satır)
- `covenant_records` (0 satır)
- `credit_facilities` (0 satır)
- `departments` (0 satır)
- `document_links` (0 satır)
- `documents` (0 satır)
- `facility_drawdowns` (0 satır)
- `forecast_lines` (0 satır)
- `forecasts` (0 satır)
- `fx_positions` (0 satır)
- `fx_rate_snapshots` (0 satır)
- `iban_change_events` (0 satır)
- `ibans` (0 satır)
- `integration_connections` (0 satır)
- `invoice_allocations` (0 satır)
- `invoice_lines` (0 satır)
- `invoice_reversals` (0 satır)
- `invoices` (0 satır)
- `optimization_recommendations` (0 satır)
- `optimization_runs` (0 satır)
- `orders` (0 satır)
- `products` (0 satır)
- `projects` (0 satır)
- `promise_to_pay` (0 satır)
- `saved_views` (0 satır)
- `treasury_policies` (2 satır)

---

Yeniden üretim:

```bash
SOURCE_DATABASE_URL=postgres://…/mas_radar_dev \
CLONE_DB=mas_radar_stage11_clone \
  pnpm release:golden-fingerprint
```

Kaynak veritabanına yalnız `pg_dump` dokunur; her yazma clone'a gider.
