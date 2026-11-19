# MAS Nexus — Database Reliability & Migrations Remediation Report (`Agent 01`)

- **Agent:** `AGENT 01 — DATABASE RELIABILITY & MIGRATIONS` (`Phase C`)
- **Target Database:** `mas_radar_dev` (`PostgreSQL 16.14`, native local cluster `system_identifier = 7701622016215066972`)
- **Applied Ledger State:** `124/0124` (`0124_remediation_outbox_incidents_import_freshness.sql`, `checksum_digest = 87cb14b6662446793bcb61cb4768ab470d3069344c31703fabdc7ea652dd7bb2`, applied `2026-11-18T14:04:53.862Z`)
- **Data Safety Guarantee:** `100%` additive, idempotent, zero row deletion, mandatory pre-migration verified backup created (`backups\migrate-mas_radar_dev-2026-11-18T14-04-51-783Z.dump`, `2,073,472` bytes).

---

## 1. Assigned Incidents & Cross-Agent Schema Deliverables

| Incident ID | Scope Owned by Agent 01 | Remediation Status |
| :--- | :--- | :--- |
| **`I-001`** | Least-privilege runtime DB identity (`mas_radar_app`, `!rolsuper`, `!rolbypassrls`, `NOINHERIT`), fail-closed schema/connection probe (`checkSchemaParity` / `assertSchemaParity` returning `aligned: false` on `ECONNREFUSED`), and `132/132` (`100%`) RLS + `91/91` (`100%`) `security_invoker = true` verification. | **VERIFIED** |
| **`I-002`** | Historical migration drift forensics (`96/0096` vs `107/0107`, `115/0115` vs `119/0119`), `public.get_schema_ledger_summary()` `SECURITY DEFINER` parity gate verification (`124/0124`), duplicate-execution idempotency proof, and canonical `docs/database-schema.md` alignment (`0001..0124`). | **VERIFIED** |
| **`I-011` (DB parts)** | Non-destructive duplicate check/payment control views (`public.control_duplicate_checks`, `public.control_duplicate_payments` with `security_invoker = true`) preserving all canonical financial rows (`Çağdaş` `100,000 TRY` × 3) without silent auto-merge or deletion. | **VERIFIED** |
| **`I-005` / `I-006` / `I-007` / `I-013` (Schema Foundation for Phase C/D/E)** | Migration `0124`: `notification_outbox` (`'delivery_uncertain'`, `uncertain_at`, `correlation_id`), `reminder_deliveries` (`'claiming'`, `'delivery_uncertain'`, `claim_token`, `claimed_at`, `reminder_deliveries_pending_sched_idx`), `ops_incidents` (`'SUPPRESSED'`, `suppressed_until`, `suppression_reason`, `last_checked_at`, `last_success_at`, `resolution_evidence`, `correlation_id`), `public.valid_workbook_imports` (`WITH (security_invoker = true)`), and `-31` reminder rule name standardization (`'31+'` + `'üst eskalasyon (iç inceleme)'`). | **VERIFIED** |

---

## 2. Root Causes Confirmed

### 2.1 Why `115/0115` vs `119/0119` (and `96/0096` vs `107/0107`) Diverged Historically (`I-002`)
Cross-referencing `public.schema_migrations` timestamps against `logs/alerts.jsonl` confirmed the exact operational timeline and architectural root cause:
1. **Unapplied On-Disk Migrations Without a Runtime Startup Gate:**
   - Earlier drift (`2026-11-10T04:03:26Z` – `2026-11-12T04:00:09Z`): `mas_radar_dev` sat at `96/0096` while `0097..0108` were authored on disk before `pnpm db:migrate` ran on `2026-11-12`.
   - `115/0115` vs `119/0119` drift (`2026-11-13T04:00:12Z` – `2026-11-15T06:01:52Z`): Migration `0115` (`0115_reminder_deliveries_operational_rls.sql`) was applied on `2026-11-12T19:11:47.920Z`. Phase 60 migrations `0116..0119` were then authored in `supabase/migrations/`, advancing the on-disk manifest to `119/0119` while `mas_radar_dev` remained at `115/0115` for ~49 hours until `pnpm db:migrate` applied `0116..0119` on `2026-11-15T07:45:37.029Z–38.444Z`.
2. **Why the Application Runtime Did Not Self-Stop Before `0122`:**
   - By design (`0020` / `0035` / `0058`), `public.schema_migrations` revokes all privileges from `mas_radar_app` and all five RBAC tiers (`42501 insufficient_privilege`). Consequently, the Next.js runtime and background worker had no safe way to inspect ledger parity at startup; only the scheduled owner-role `telemetry-snapshot.ts` task detected the mismatch.
   - Furthermore, when `0116..0119` were applied on `2026-11-15T07:45:37Z`, `telemetry-snapshot.ts` simply ceased firing `[P0] schema_ledger` without recording a stateful `OPEN -> RESOLVED` transition or `resolution_evidence` (`I-013`).
   - **Closure:** Migration `0122` introduced `public.get_schema_ledger_summary()` (`SECURITY DEFINER`, `search_path = public, pg_temp`), `src/lib/db/schema-parity.ts` enforces `checkSchemaParity()` / `assertSchemaParity()` fail-closed on both drift and connection failure, `docs/database-schema.md` header drift (`Migration 0115` / `0119` vs live `0124`) was corrected, and Migration `0124` adds `ops_incidents.resolution_evidence` + `SUPPRESSED` columns for auditable incident closure.

### 2.2 Runtime DB Downtime & Fail-Closed Semantics (`I-001`)
- When local PostgreSQL 16 (`127.0.0.1:5432`) was unreachable (`ECONNREFUSED`), unguarded callers risked misinterpreting failed probes if errors were not surfaced as explicit `aligned: false` / `?` states.
- Verified that `mas_radar_app` enforces `rolsuper = false`, `rolbypassrls = false`, and `rolinherit = false` (`NOINHERIT`), sees `0` rows on unswitched `public.payments`, is denied `INSERT` on `public.schema_migrations` (`42501`), and `checkSchemaParity()` returns `aligned: false` with the underlying `ECONNREFUSED` message whenever the pool throws.

### 2.3 Schema Gaps Blocking Atomic Notification Claiming, Incident Suppression & Valid Import Freshness (`I-005`, `I-006`, `I-007`, `I-013`)
1. **Staging Table Naming (`I-005`):** Live catalog inspection confirmed the canonical workbook row table in PostgreSQL is `public.import_rows(workbook_id)` (`1,601` rows linked to `TEMİZ.xlsx`), **not** `source_rows`. Additionally, legacy imports set `source_workbooks.status = 'parsed'` (`workbook-importer.ts:240`) while Standard Import V2 sets `status = 'mapped'` (`v2/mapper.ts:1566`).
2. **Narrow CHECK Constraints (`I-007`, `I-013`):**
   - `notification_outbox_status_check` lacked `'delivery_uncertain'`, preventing post-request timeout / partial multi-chunk sends from being quarantined without blind retry.
   - `reminder_deliveries_status_check` only permitted `('pending', 'sent', 'failed', 'skipped')` and lacked `claim_token` / `claimed_at` + partial claim index, blocking atomic `FOR UPDATE SKIP LOCKED` claiming across concurrent cron workers.
   - `ops_incidents_state_check` lacked `'SUPPRESSED'` and structured `resolution_evidence` / `correlation_id` / `last_checked_at` / `last_success_at` columns.
3. **`-31` Escalation Rule Naming (`I-006`, Section 7):** Live `public.reminders` rows for `offset_days = -31` carried `'30+ Gün gecikmiş ödeme hukuki eskalasyon'` and `'30+ Gün gecikmiş kredi taksiti eskalasyonu'`, contradicting the `8–30` day bucket at day 30 and asserting statutory legal action.

---

## 3. Files Changed (Strictly Within Agent 01 Exclusive Ownership)

1. [0124_remediation_outbox_incidents_import_freshness.sql](file:///c:/Users/Trade%20Bilisim/Mas%20Saas/supabase/migrations/0124_remediation_outbox_incidents_import_freshness.sql) *(CREATED)*
   - Widened `notification_outbox_status_check` to include `'delivery_uncertain'`; added `uncertain_at timestamptz` and `correlation_id text`.
   - Widened `reminder_deliveries_status_check` to `('pending', 'claiming', 'sent', 'failed', 'skipped', 'delivery_uncertain')`; added `claim_token uuid`, `claimed_at timestamptz`, and partial index `reminder_deliveries_pending_sched_idx`.
   - Widened `ops_incidents_state_check` to `('OK', 'OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'UNKNOWN', 'SUPPRESSED')`; added `suppressed_until`, `suppression_reason`, `last_checked_at`, `last_success_at`, `resolution_evidence jsonb`, and `correlation_id`.
   - Created `public.valid_workbook_imports` `WITH (security_invoker = true)` filtering `source_workbooks` to `status IN ('parsed', 'mapped')` with `EXISTS (SELECT 1 FROM public.import_rows ir WHERE ir.workbook_id = sw.id)`, revoking all write privileges and granting `SELECT` strictly to the 5 RBAC tier roles.
   - Updated `-31` `public.reminders` rule names in-place (`'30+' -> '31+'`, `'hukuki eskalasyon' -> 'üst eskalasyon (iç inceleme)'`) preserving rule UUIDs and FK history.
   - Included post-DDL `$verify_0124$` block asserting `0` unprotected views in `public`.
2. [database-schema.md](file:///c:/Users/Trade%20Bilisim/Mas%20Saas/docs/database-schema.md) *(UPDATED)*
   - Synchronized canonical catalog summary header (`0001..0124`, `132/132` RLS tables, `91/91` `security_invoker = true` views) and documented Migration `0124`.
3. [agent01-db-migrations.test.ts](file:///c:/Users/Trade%20Bilisim/Mas%20Saas/tests/remediation/agent01-db-migrations.test.ts) *(CREATED)*
   - 5-test Vitest regression suite covering runtime role privileges, fail-closed `ECONNREFUSED` / drift parity, `100%` table RLS & view `security_invoker` + `valid_workbook_imports` filtering, `124/0124` manifest/checksum parity + `-31` rule naming, and rolled-back `BEGIN ... ROLLBACK` constraint validation with before/after row-count equality.
4. [database-report.md](file:///c:/Users/Trade%20Bilisim/Mas%20Saas/docs/remediation/database-report.md) *(CREATED)*
   - This forensic and verification report.

---

## 4. Tests Added / Executed & Results

| Command | Target | Result | Summary Evidence |
| :--- | :--- | :--- | :--- |
| `pnpm db:migrate` *(Run #1)* | `mas_radar_dev` | **PASS (`exit 0`)** | Verified pre-backup `migrate-mas_radar_dev-2026-11-18T14-04-51-783Z.dump` (`2,073,472` bytes), `pending uygulandı: 0124`, `Ledger (124 satır)`, `pg_policies(schema_migrations) = 0`. |
| `pnpm db:migrate` *(Run #2 — Idempotency)* | `mas_radar_dev` | **PASS (`exit 0`)** | `state=LEDGER_MANAGED`, `Değişiklik yok — DB zaten güncel.`, `Ledger (124 satır)`. |
| `pnpm db:roles:verify` | `mas_radar_dev` (`mas_radar_app`) | **PASS (`exit 0`)** | `8/8 kontrol geçti` (`current_user='mas_radar_app'`, `rolsuper=false`, `rolbypassrls=false`, `schema_migrations` `INSERT` -> `42501`, `13` users visible via auth runtime policy). |
| `pnpm phase18:verify` | Repo + Vitest audit/validation | **PASS (`exit 0`)** | `13/13 kontrol geçti. PHASE18 VERIFY: ALL PASS` (`docs/database-schema.md` covers `0124` and every migration `0022–0124`). |
| `npx vitest run tests/remediation/agent01-db-migrations.test.ts` | `mas_radar_dev` (read-only + `ROLLBACK`) | **PASS (`exit 0`)** | `5/5 tests passed` (`3.92s`), pre/post row counts identical across `source_workbooks`, `notification_outbox`, `reminder_deliveries`, and `ops_incidents`. |
| `pnpm db:migrate:verify` | Disposable PG16 DBs | **48/49 checks PASS (`exit 1` on pre-existing `0109`/`0122` seed assertion)** | `EMPTY` (`124` rows), `LEGACY_COMPLETE` (`124` rows), `Idempotency` (`124` rows), `Checksum-drift` (`124` rows), `LEDGER_EMPTY_RECOVERY` (`124` rows), and `Cluster-identity` all **PASS**. Only `LEGACY_COMPLETE` pre-existing table row-count equality on `p0c-checkpoint-2026-07-18` failed due to pre-existing `0109` (`settings`) and `0122` (`reminders` 5 seeded rules) inserts; `0124` performs zero inserts/deletes. |

---

## 5. Concrete Live Catalog Evidence (`mas_radar_dev` Post-`0124`)

- **`public.get_schema_ledger_summary()` (executed as `mas_radar_app`):**
  ```json
  {
    "migration_count": 124,
    "latest_version": "0124",
    "checksum_digest": "87cb14b6662446793bcb61cb4768ab470d3069344c31703fabdc7ea652dd7bb2",
    "last_applied_at": "2026-11-18T14:04:53.862Z"
  }
  ```
- **Catalog Security Counts:**
  - `public_tables = 132`, `rls_tables = 132` (`100%`)
  - `public_views = 91`, `invoker_views = 91` (`100%`), writable views across `mas_radar_app` + 5 tiers = `0`
- **Standardized `-31` `public.reminders` Rows (UUIDs & FK History Intact):**
  - `3d3b4d64-a71e-46fa-b56c-cc800d1bc0f0` (`loan_installment`, `-31`): `"31+ Gün gecikmiş kredi taksiti eskalasyonu"`
  - `02956158-d836-492c-9c81-9bf77db3d967` (`payment_instance`, `-31`): `"31+ Gün gecikmiş ödeme üst eskalasyon (iç inceleme)"`
- **`public.valid_workbook_imports` Live Result:**
  - Returns `1` valid workbook: `f7af8764-2249-4a41-abf6-ebed7198c2f1` (`TEMİZ.xlsx`, `status = 'parsed'`, `imported_at = 2026-07-17T13:14:28.804Z`, `1,601` `import_rows`).

---

## 6. Remaining Risks & Blockers

- **Pre-existing `scripts/db/migrate-verify.ts` Row-Count Allowlist Drift (Non-blocking for `0124`, Out of Agent 01 Write Scope):**
  - In `scripts/db/migrate-verify.ts:421-430`, `testLegacyCompleteAndIdempotency` asserts `preKeys.every((k) => preCounts[k] === postCounts[k])` against the July 2026 `p0c-checkpoint` dump. Because earlier migrations `0109` (`INSERT INTO public.settings` for `allow_single_operator_self_approval`) and `0122` (`INSERT INTO public.reminders` for 5 overdue escalation rules) intentionally seeded configuration rows into pre-existing tables without updating `migrate-verify.ts`, 1 of 49 assertions in `pnpm db:migrate:verify` reports that pre-existing `0109`/`0122` count delta while all 48 migration/ledger/idempotency/checksum/recovery checks pass at `124/0124`. Per strict disjoint file ownership, Agent 01 did not modify `scripts/db/migrate-verify.ts`; Orchestrator (`Agent 00`) may optionally whitelist `settings` (+1) and `reminders` (+5) in `migrate-verify.ts` during Phase F integration if desired.
- **External TestSprite Deployment URL:**
  - `.testsprite/config.json` points to an ephemeral Cloudflare tunnel (`trycloudflare.com`) rather than a live deployed staging instance with Migration `0124`; local PostgreSQL verification was completed directly via Vitest and native PG16 gates.
- **Blockers for Downstream Agents (Agents 02–11):** **NONE.** Migration `0124` is live in `mas_radar_dev` (`124/0124`).
