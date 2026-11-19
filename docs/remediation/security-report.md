# MAS Nexus — Security, Approval Workflows & SaaS Isolation Report (`Agent 09`)

## 1. Assigned Incidents & Cross-Cutting Scope
- **Primary Incident:** **`I-015`** — `Onay atlanmış` (`approval_bypass`) and `IBAN değişti/yeni IBAN` (`iban_changed`) findings surfaced in CFO morning briefings and control dashboards.
- **Cross-Cutting Security & Tenant-Isolation Scope:**
  - Multi-layer maker-checker (4-eyes) enforcement for high-value outflows (`>= 100,000 TRY`) across application domain logic and PostgreSQL triggers.
  - BEC (Business Email Compromise) IBAN fraud shield: ISO 13616 MOD-97-10 checksum verification, `public.ibans` vault registration (`verified_at IS NULL`, `approval_status = 'pending_approval'`), maker-checker approval writeback gating, and immutable change/audit logging.
  - Multi-entity `RESTRICTIVE` PostgreSQL Row-Level Security (`matches_active_legal_entity(legal_entity_id)`) and `user_legal_entities` cookie membership pinning (`I-016` / SaaS tenant isolation).
  - Least-privilege PostgreSQL runtime identity (`mas_radar_app` -> `SET LOCAL ROLE` into 5 RBAC tiers) and `mas_radar_viewer` read-only enforcement.
  - Production & non-loopback isolation of `MAS_LOCAL_PASSWORDLESS` and `MAS_QA_BYPASS_AUTH` (`I-001` / `I-016`).
  - Outbound Telegram `allowedChatIds` destination allow-listing, token/secret redaction (`redactBotToken`, `redactSecrets`), raw Turkish IBAN masking (`scrubSensitiveTelegramText`), and internal workflow classification boundaries (never asserting automatic statutory legal proceedings solely from overdue day counters).

---

## 2. Root Causes Confirmed (Source Code + Read-Only `mas_radar_dev` Forensics)

### 2.1 `I-015` Part A — `Onay atlanmış` (`33ad79cf-d017-4fc1-9b58-f7772a4e577a`, `120,000.00 TRY`)
- **Live DB Evidence (`mas_radar_dev`):**
  - `public.payment_instances` row `33ad79cf-d017-4fc1-9b58-f7772a4e577a` (`payment_id = 4c66f34e-1960-436b-8875-d7ef5261448e`, `payment_name = 'TİJEN AKBANK KREDİ KARTI'`, `instance_month = '2026-06-01'`, `due_date = '2026-06-09'`, `amount = 120000.00`, `paid_amount = 120000.00`, `currency = 'TRY'`, `direction = 'outflow'`, `status = 'paid'`, `amount_source = 'legacy_unknown'`) carries `approval_status = 'not_required'` and `approval_id = NULL`.
  - `public.audit_logs` rows `c5ead05c-b256-44cd-b070-0a352a43a465` (`map_payment_candidate` at `2026-07-17 13:14:31.219565+00`, `actor = NULL`) and `ac1b6217-360f-46ec-a249-919881f7389d` (`mark_paid` at `2026-07-17 13:14:33.1653+00`, `actor = NULL`) prove this settlement occurred **during the initial `TEMİZ.xlsx` cutover import on July 17, 2026** — months before the maker-checker approval engine (`0054`), BEC/settlement gates (`0102`), and PostgreSQL trigger hard-gate (`0122`/`0123`) were introduced.
  - `public.control_approval_bypass` (the canonical SQL view defined in `0078` and hardened in `0122`) surfaces this single historical row (`120,000.00 TRY >= 100,000 TRY` threshold without an `'approved'` round in `public.approvals`), and `public.control_alerts` maintains open critical alert `759f030b-0ef7-437c-b634-bb569baa7346` (`check_code = 'approval_bypass'`, `status = 'open'`, `title = 'Onay atlanmış (1 bulgu)'`, `occurrence_count = 8`).
  - **Preservation Decision:** Because `33ad79cf` is genuine pre-gate historical financial evidence, neither `33ad79cf` nor open alert `759f030b-0ef7-437c-b634-bb569baa7346` was closed, altered, or deleted. Forward-going settlements `>= 100,000 TRY` are hard-blocked at both `markInstancePaid` / `markInstancePartial` / `settleBankMatchInternal` (`DomainError("FORBIDDEN")`) and PostgreSQL `BEFORE UPDATE OF status, paid_amount` trigger `enforce_outflow_settlement_approval_gate()` (`SQLSTATE 42501: APPROVAL_REQUIRED`).

### 2.2 `I-015` Part B — `IBAN değişti/yeni IBAN` (`iban_changed`) & BEC Shield Gaps
- **Historical & Schema Root Cause:**
  1. Prior to migration `0122`, `public.control_iban_changes` (`0078`) flagged every row in `public.iban_change_events` within 30 days as `is_recent = true` regardless of whether `public.ibans.approval_status = 'approved'` or `is_active = false`, keeping verified IBANs in `CRITICAL` state for 30 days. Migration `0122` scoped `is_recent` to `changed_at > now() - interval '30 days' AND coalesce(ib.approval_status, 'pending_approval') <> 'approved' AND coalesce(ib.is_active, true) = true` and added `requires_verification`. Currently `mas_radar_dev` has `0` rows in `public.ibans` and `0` rows in `public.iban_change_events` (`iban_changed` state = `PASS`).
  2. Payment template IBAN edits (`public.payments.iban`) now pass through `validateAndTrackTemplateIbanWithClient()` (`src/lib/radar/engine.ts:581-624`), which enforces 26-character `TR` + ISO 13616 MOD-97-10 validation and registers counterparty IBANs via `ensurePartyIbanTrackedWithClient()` (`src/lib/counterparties/engine.ts:859-935`) with `verified_at IS NULL`, `approval_status = 'pending_approval'`, `approvals` round, `control_alerts` (`iban_changed`), and `audit_logs` (`add_iban`).
- **Three Residual Gaps Discovered & Closed in `src/lib/approvals/engine.ts`:**
  1. **Governance Re-Enablement Gap (`updateApprovalGovernanceSettings`):** Migration `0122` set `allow_single_operator_self_approval = false` in `public.approval_governance_settings` because `mas_radar_dev` has `2` active admin approvers (`admin` and `atilla`), which closes `0114`'s `approvals_decide_admin_single_operator` RLS gate. However, `updateApprovalGovernanceSettings()` previously permitted an `admin` to flip `allow_single_operator_self_approval` back to `true` even while `>= 2` active approvers existed. Fixed so `updateApprovalGovernanceSettings` queries active approvers inside the transaction and throws `DomainError("FORBIDDEN")` whenever `activeApproverCount >= 2` and `allowSingleOperatorSelfApproval === true`.
  2. **MOD-97 Writeback Gate on IBAN Approval (`applySubjectWriteback`):** `addIban()` intentionally records source invoice IBANs with warnings (`verified_at = NULL`, `approval_status = 'pending_approval'`) when MOD-97 fails so source evidence is not lost. Previously, `applySubjectWriteback()` in `decideApproval()` updated `public.ibans` to `approval_status = 'approved', verified_at = now()` *before* checking `isValidIbanChecksum`, allowing a corrupted IBAN to be marked verified. Fixed to lock `public.ibans` (`FOR UPDATE`) and reject `decision === 'approved'` with `DomainError("VALIDATION")` whenever `!isValidIbanChecksum(iban_normalized)` or a `TR` IBAN is not 26 characters.
  3. **RLS `SELECT ... FOR UPDATE` False `NOT_FOUND` on Self-Approval (`decideApproval`):** Under PostgreSQL RLS (`0114`), `SELECT ... FROM public.approvals WHERE id = $1 FOR UPDATE` applies the `UPDATE USING` policy (`requested_by is distinct from current_app_user()`), returning `0` rows when a maker attempts to approve their own request. `decideApproval()` previously threw `DomainError("NOT_FOUND", "Onay kaydı bulunamadı.")` instead of `DomainError("FORBIDDEN")`. Fixed (matching `instanceMissingReason` in `src/lib/radar/engine.ts:157`) by probing visibility via `SELECT` when `FOR UPDATE` returns `0` rows and throwing an explicit maker-checker / authorization `DomainError("FORBIDDEN")`.

### 2.3 Statutory Legal Wording & Internal Workflow Boundary (`src/lib/controls/rules.ts`)
- Inspected all control/anomaly status, severity, evidence, and IBAN change labels in [rules.ts](file:///c:/Users/Trade%20Bilisim/Mas%20Saas/src/lib/controls/rules.ts) and all 13 rows of `public.control_registry` in `mas_radar_dev`. None claim automatic statutory court/enforcement proceedings (`icra takibi başlatıldı`, `dava açıldı`, `yasal takip başlatıldı`, `ihtarname çekildi`).
- Added `INTERNAL_WORKFLOW_CLASSIFICATION_ONLY` and deterministic guard `hasStatutoryLegalProceedingClaim(text)` in [rules.ts](file:///c:/Users/Trade%20Bilisim/Mas%20Saas/src/lib/controls/rules.ts#L268-L294) to prevent future drift.

---

## 3. Files Changed (Strictly Within Exclusive Agent 09 Ownership)
1. [engine.ts](file:///c:/Users/Trade%20Bilisim/Mas%20Saas/src/lib/approvals/engine.ts) — Added `activeApproverCount >= 2` hard-block in `updateApprovalGovernanceSettings()`, ISO 13616 MOD-97 + TR-length hard-gate before `approval_status = 'approved'` writeback on `public.ibans`, and RLS `FOR UPDATE` maker-checker `FORBIDDEN` disambiguation in `decideApproval()`.
2. [rules.ts](file:///c:/Users/Trade%20Bilisim/Mas%20Saas/src/lib/controls/rules.ts) — Added `INTERNAL_WORKFLOW_CLASSIFICATION_ONLY` and `hasStatutoryLegalProceedingClaim()` pure boundary validator.
3. [agent09-security-isolation.test.ts](file:///c:/Users/Trade%20Bilisim/Mas%20Saas/tests/remediation/agent09-security-isolation.test.ts) — Created positive & negative security, maker-checker, IBAN vault, `RESTRICTIVE` multi-entity RLS, RBAC tier, loopback passwordless, and Telegram redaction regression suite using `BEGIN ... SAVEPOINT ... ROLLBACK` with before/after live DB immutability fingerprinting.
4. [security-report.md](file:///c:/Users/Trade%20Bilisim/Mas%20Saas/docs/remediation/security-report.md) — Created this forensic & verification report.

---

## 4. Tests Added & Executed

| Command | Scope | Result |
| :--- | :--- | :--- |
| `npx vitest run tests/remediation/agent09-security-isolation.test.ts` | 10 positive & negative security/RLS/maker-checker/IBAN/loopback/Telegram tests + live `mas_radar_dev` before/after zero-mutation fingerprint | **PASS (`10 / 10`, `3.60s`)** |
| `npx vitest run tests/security/write-gates.test.ts tests/security/local-passwordless-guard.test.ts` | 49 AST write-gate, secret-hygiene, and loopback/session boundary tests | **PASS (`49 / 49`, `14.77s`)** |
| `npx vitest run src/lib/controls/rules.test.ts src/lib/approvals/rules.test.ts tests/unit/wave5a-cfo-unblockers.test.ts` | Existing control rules, approval rules, and governance/self-approval unit suites | **PASS** |

### Key Scenarios Verified in `agent09-security-isolation.test.ts`
1. **Historical Finding Transparency (`I-015`):** Verified `33ad79cf-d017-4fc1-9b58-f7772a4e577a` (`120,000.00 TRY`) remains present in `public.control_approval_bypass` and open in `public.control_alerts` (`status = 'open'`).
2. **Dual-Layer High-Value Outflow Hard-Gate:** Verified unapproved `120,000.00 TRY` outflow settlement is rejected at application layer (`markInstancePaid` -> `DomainError("FORBIDDEN")`) and at PostgreSQL trigger layer (`enforce_outflow_settlement_approval_gate` -> `SQLSTATE 42501` on full paid, partial paid, and spoofed `approval_status = 'approved'` without a matching `public.approvals` row), while `< 100,000 TRY` (`99,999.99 TRY`) and genuinely maker-checker-approved `120,000.00 TRY` settlements succeed inside `ROLLBACK`.
3. **Cross-Entity `RESTRICTIVE` RLS Isolation:** Verified `mas_radar_viewer` with `app.current_legal_entity_id = Entity B` sees `0` rows of `Entity A` (`payments`, `payment_instances`, `control_alerts`) while seeing `1` row of `Entity B`, `mas_radar_finance_operator` scoped to `Entity B` is refused cross-entity `INSERT` into `Entity A` (`42501`), and `resolveAllowedLegalEntityId()` pins non-manager roles to assigned `user_legal_entities`.
4. **RBAC Tier & Runtime Identity Boundaries:** Verified unswitched `mas_radar_app` has `rolsuper = false`, `rolbypassrls = false`, sees `0` rows on `payments`, and fails `INSERT` (`42501`); verified `mas_radar_viewer` can `SELECT` but is blocked from `INSERT / UPDATE / DELETE` across `payments`, `payment_instances`, and `approvals`.
5. **Maker-Checker Self-Approval & IBAN MOD-97 Vault Gate:** Verified `evaluateSelfApprovalEligibility` and `updateApprovalGovernanceSettings` reject self-approval when `>= 2` active approvers exist, DB RLS blocks admin self-approval on `public.approvals`, `createPayment` rejects invalid MOD-97 IBANs, valid IBANs land in `public.ibans` (`verified_at IS NULL`, `pending_approval`) with `audit_logs` + `control_iban_changes` (`requires_verification = true`), maker self-approval is rejected (`FORBIDDEN`), checker approval of a broken-checksum IBAN is rejected (`VALIDATION`), and distinct checker approval of a valid MOD-97 IBAN stamps `verified_at` and clears `requires_verification`.
6. **Loopback-Only `MAS_LOCAL_PASSWORDLESS` & Telegram/Secret Redaction:** Verified `NODE_ENV=production` unconditionally disables `MAS_LOCAL_PASSWORDLESS`, non-production rejects external `Host` and `X-Forwarded-Host` headers, `sendTelegramChatMessage` blocks unauthorized `chatId`s before network egress and masks Turkish IBANs, `redactBotToken` / `redactSecrets` strip credentials (`looksLikeSecret(...) === []`), and control descriptions contain zero statutory legal proceeding claims.

---

## 5. Remaining Risks & Operational Notes
- **Foreign-Currency Trigger Parity Note:** Application-layer settlement gates (`markInstancePaid`, `markInstancePartial`, `recordInvoicePayment`, `settleBankMatchInternal`) fail closed (`currency_mismatch -> ruleFires = true`) on foreign-currency outflows when a `TRY` threshold rule is active, while `public.control_approval_bypass` converts foreign currencies via `fx_rate_snapshots`. PostgreSQL trigger `enforce_outflow_settlement_approval_gate()` (`0123`, owned outside Agent 09) currently evaluates `new.currency = 'TRY'` directly in PL/pgSQL; adding non-TRY threshold rules in `public.approval_rules` (`USD`/`EUR`) or extending trigger FX lookup in a future migration would provide identical DB-trigger parity for direct SQL bypasses in foreign currencies.
- **Historical Finding Disposition:** Open alert `759f030b-0ef7-437c-b634-bb569baa7346` (`Onay atlanmış`, referencing `33ad79cf-d017-4fc1-9b58-f7772a4e577a` from July 17, 2026) remains intentionally open until a human finance manager/CFO explicitly reviews and records a documented resolution note via the audited UI workflow.
- **No External Compliance Certification Claims:** All controls verified in this report represent technical application and PostgreSQL security mechanisms; no external compliance certifications (such as SOC 2 or ISO 27001) are claimed.

## 6. Blockers
- **None** (`0` blockers). All assigned Agent 09 checks and negative security regression tests pass with zero live database mutations.
