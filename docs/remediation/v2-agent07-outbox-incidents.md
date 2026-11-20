# MAS Nexus — V2 Production Hardening Handoff Report (`Agent 07` · Outbox, Incident Lifecycle & Telemetry Engineer)

- **Agent:** `Agent 07` (Outbox, Incident Lifecycle & Telemetry Engineer)
- **Branch:** `remediation/v2-hardening` (Parent `HEAD`: `65f29251ad9a98b4a87d50b25a807c5f00da631a`)
- **Assigned Scope:** `F-09` (`P1` — Outbox Stale-Claim Crash-Window Duplicate-Send Prevention), `Agent 06` Pre-Send Durable Outbox Intent Contract (`F-08` handoff), and `F-20` / `RG-07` / `RG-08` (`P1/P2` — Incident Lifecycle, Suppression Expiry, Verified `RESOLVED` Evidence & Fail-Closed Telemetry)
- **Overall Agent Verdict:** **`PASS`** (`12 / 12` tests in `agent07-incident-lifecycle.test.ts` + `102 / 102` cross-suite regression tests in `telemetry-alerts.test.ts`, `alert-delivery.test.ts`, `rules.test.ts`, `agent06-telegram-idempotency.test.ts`, and `mandatory-16-scenarios.test.ts` = `114 / 114` green; `8 / 8` `boundary:verify` `PASS`; `0` ESLint errors/warnings; `0` TypeScript errors in owned scope)
- **Safety & Privacy Invariants:** `prod_db_writes = 0` (`default_transaction_read_only=on` + `BEGIN READ ONLY ... ROLLBACK`), `real_network_sends = 0`, zero SQL DDL migrations required (`125/0125` preserved), `100%` synthetic/redacted examples (`0` real counterparty names, `0` raw IBANs, `0` secrets).

---

## 1. V2 Structured Handoff Contract (`Agent 07 -> Agent 00 & Agent 06`)

```json
{
  "schemaVersion": "mas-v2-agent-handoff-v1",
  "agentId": "Agent 07",
  "role": "Outbox, Incident Lifecycle & Telemetry Engineer",
  "branch": "remediation/v2-hardening",
  "parentCommitSha": "65f29251ad9a98b4a87d50b25a807c5f00da631a",
  "measuredAtISO": "2026-11-20T05:06:00.000Z",
  "status": "PASS",
  "prod_db_writes": 0,
  "real_network_sends": 0,
  "exclusive_write_allowlist": [
    "src/lib/reminders/outbox.ts",
    "src/lib/ops/telemetry-alerts.ts",
    "src/lib/ops/alert-delivery.ts",
    "scripts/ops/telemetry-snapshot.ts",
    "scripts/ops/telemetry-watch.ts",
    "tests/remediation/agent07-incident-lifecycle.test.ts",
    "docs/remediation/v2-agent07-outbox-incidents.md"
  ],
  "files_modified": [
    "src/lib/reminders/outbox.ts",
    "src/lib/ops/telemetry-alerts.ts",
    "src/lib/ops/alert-delivery.ts",
    "scripts/ops/telemetry-snapshot.ts",
    "scripts/ops/telemetry-watch.ts",
    "tests/remediation/agent07-incident-lifecycle.test.ts"
  ],
  "files_created": [
    "docs/remediation/v2-agent07-outbox-incidents.md"
  ],
  "files_modified_outside_allowlist": [],
  "findings": {
    "F-09": {
      "priority": "P1",
      "status": "PASS",
      "confidence": "D",
      "summary": "Reproduced F-09 crash-window bug test-first (exit_code: 1 where a stale 'claiming' row with metadata.dispatchPhase === 'sending' was blindly reset to 'failed_retryable' and duplicate-resent as 'sent'). Separated durable pre-send 'claimed' from post-intent 'sending' via markOutboxSendingStarted / beginOutboxSending BEFORE transport.send(), split recoverStaleOutboxClaims so stale 'sending' rows transition atomically to 'delivery_uncertain' (requiresOperatorReconciliation = true) + P1 ops_incidents record without ever auto-requeuing, classified thrown post-send socket/timeout errors as uncertainOutcome = true -> 'delivery_uncertain', and exported prepareOutboxSendingIntent + finalizeOutboxSendingOutcome for Agent 06."
    },
    "F-20": {
      "priority": "P2",
      "status": "PASS",
      "confidence": "D",
      "summary": "Hardened fail-closed telemetry predicates (isUnreadableTelemetryValue, jobsStuckAlert, importStaleAlert, reconciliationAlert, ledgerAlert, backupAgeAlert, outboxUncertainAlert) so '?', null, undefined, empty strings, and JSON parse errors ('BOZUK KOŞU KAYDI' including Turkish uppercase dotless-I folding) always alert fail-closed and transition incidents to UNKNOWN (never OK/RESOLVED/ALL CLEAR). Enforced initial [OPEN][P2] alert emission with 72h cooldown, SUPPRESSED expiry re-opening, strict IncidentResolutionEvidence validation (assertValidIncidentResolutionEvidence / resolveOpsIncidentVerified rejecting unverified resolutions), and strict JSON validation in telemetry-watch.ts."
    }
  },
  "exported_contracts_for_peers": {
    "Agent 06": [
      "markOutboxSendingStarted(client, id, claimToken, extraMeta?): Promise<void>",
      "beginOutboxSending(client, id, claimToken, extraMeta?): Promise<void>",
      "prepareOutboxSendingIntent(client, entry): Promise<PreparedOutboxSendingIntent>",
      "finalizeOutboxSendingOutcome(client, params): Promise<OutboxStatus>",
      "recoverStaleOutboxClaims(client, staleMinutes?): Promise<StaleOutboxRecoverySummary>",
      "classifyThrownTransportError(err): DeliveryResult"
    ],
    "Agent 02": [
      "claimAndDispatchOutbox(pool, opts?): Promise<OutboxDispatchSummary>",
      "evaluateAndRecordOpsIncidents(poolOrNull, signals, opts?): Promise<OpsIncidentEvaluationResult>"
    ]
  },
  "release_gate_signals": [
    {
      "id": "RG-07",
      "scope": "ci_and_host",
      "status": "PASS",
      "evidence": "Durable pre-send dispatchPhase='sending' committed before transport.send(); stale 'sending' claims held in delivery_uncertain with 0 duplicate resends; 429 retryAfterSeconds & providerMessageIds verified."
    },
    {
      "id": "RG-08",
      "scope": "ci_and_host",
      "status": "PASS",
      "evidence": "Unreadable telemetry ('?', null, '', parse error) -> UNKNOWN; initial [OPEN][P2] emitted; SUPPRESSED window respected & re-opened on expiry; unverified RESOLVED rejected without valid IncidentResolutionEvidence."
    }
  ],
  "edge_cases_reproduced_and_fixed": [
    {
      "id": "EC-07-01",
      "symbol": "recoverStaleOutboxClaims / claimAndDispatchOutbox (F-09)",
      "defectBeforeFix": "outbox.ts:180-189 reset ALL stale 'claiming' rows to 'failed_retryable' and outbox.ts:239-246 invoked transport.send() without first persisting metadata.dispatchPhase = 'sending', causing duplicate external sends if a worker crashed or lost DB connectivity after initiating send.",
      "minimalFix": "Stamped metadata.dispatchPhase = 'claimed' on initial claim, executed markOutboxSendingStarted ('dispatchPhase' = 'sending', asserting rowCount === 1) strictly BEFORE transport.send(), and split recoverStaleOutboxClaims to move stale 'sending' rows to 'delivery_uncertain' + P1 'outbox_delivery_uncertain' incident while recovering only pre-send ('<> sending') rows to 'failed_retryable'."
    },
    {
      "id": "EC-07-02",
      "symbol": "classifyThrownTransportError (outbox.ts:247-252)",
      "defectBeforeFix": "Uncaught exceptions thrown by transport.send() (e.g. ECONNRESET / socket hang up / TimeoutError) fell into `{ ok: false }` without `uncertainOutcome: true`, routing indeterminate post-send failures into `failed_retryable`.",
      "minimalFix": "Added classifyThrownTransportError(err) marking all post-send thrown errors (except explicit pre-connect ECONNREFUSED/ENOTFOUND/EAI_AGAIN/ERR_INVALID_URL or uncertainOutcome === false) as uncertainOutcome: true -> 'delivery_uncertain' with token redaction."
    },
    {
      "id": "EC-07-03",
      "symbol": "jobsStuckAlert / importStaleAlert / reconciliationAlert / isUnreadableTelemetryValue",
      "defectBeforeFix": "Number('') === 0 and Number(null) === 0 caused jobsStuckAlert(''), importStaleAlert('', 45), and reconciliationAlert('') to return false (healthy/OK), and JavaScript /kaydı/i missed Turkish uppercase 'BOZUK KOŞU KAYDI' (ASCII 'I' != 'ı').",
      "minimalFix": "Added strict regex numeric parser parseFiniteNonNegativeMetric and Turkish dotless-I-safe isUnreadableTelemetryValue (/bozuk\\s+ko[sş]u\\s+kayd[iı]/i) so null, empty, '?', and parse errors always alert fail-closed and transition to UNKNOWN."
    },
    {
      "id": "EC-07-04",
      "symbol": "resolveOpsIncidentVerified / evaluateAndRecordOpsIncidents (F-20 / RG-08)",
      "defectBeforeFix": "parseResolutionEvidence checked only typeof === 'string', permitting blank strings, invalid ISO timestamps, or measuredValue='?'/'UNKNOWN' to satisfy RESOLVED.",
      "minimalFix": "Enforced non-empty trimmed strings, finite Date.parse(verifiedAtISO), and readable non-UNKNOWN measuredValue in parseResolutionEvidence / assertValidIncidentResolutionEvidence / resolveOpsIncidentVerified, rejecting unverified resolution attempts."
    },
    {
      "id": "EC-07-05",
      "symbol": "tests/remediation/agent07-incident-lifecycle.test.ts (G-02 Zero Live DB Writes & CI Static Execution)",
      "defectBeforeFix": "V1 agent07-incident-lifecycle.test.ts skipped the entire file when DATABASE_URL was unset (CI static job) and issued committed INSERT/UPDATE/DELETE statements on ownerPool (mas_radar_dev) when .env.local was present.",
      "minimalFix": "Made all 11 behavioral outbox/incident/telemetry tests run unconditionally with zero DB writes, and converted the live DB suite to strictly read-only (`default_transaction_read_only=on` + `BEGIN READ ONLY` + `ROLLBACK`, `prod_db_writes = 0`)."
    }
  ],
  "verification": {
    "baselineNegativeReproducerCommand": "pnpm exec vitest run tests/remediation/agent07-incident-lifecycle.test.ts",
    "baselineNegativeReproducerResult": "exit_code=1 (Expected: 'delivery_uncertain', Received: 'sent' on ob-stale-sending before outbox.ts fix)",
    "vitestCommand": "pnpm exec vitest run tests/remediation/agent07-incident-lifecycle.test.ts src/lib/ops/telemetry-alerts.test.ts src/lib/ops/alert-delivery.test.ts src/lib/reminders/rules.test.ts tests/remediation/agent06-telegram-idempotency.test.ts tests/remediation/mandatory-16-scenarios.test.ts",
    "vitestResult": "6 test files passed, 114 tests passed (12 in agent07-incident-lifecycle.test.ts + 102 across dependent suites)",
    "boundaryCommand": "pnpm boundary:verify",
    "boundaryResult": "8/8 PASS (zero process.env, zero fetch, zero secret console logging in boundary modules)",
    "eslintCommand": "pnpm exec eslint src/lib/reminders/outbox.ts src/lib/ops/telemetry-alerts.ts src/lib/ops/alert-delivery.ts scripts/ops/telemetry-snapshot.ts scripts/ops/telemetry-watch.ts tests/remediation/agent07-incident-lifecycle.test.ts",
    "eslintResult": "0 errors, 0 warnings",
    "typecheckNote": "0 TypeScript errors in all Agent 07 owned files and importers (workspace tsc --noEmit observed only 3 unrelated in-flight errors in Agent 01 migrate-verify.ts and Agent 09 security test files)."
  },
  "rollback_plan": "Restore src/lib/reminders/outbox.ts, src/lib/ops/telemetry-alerts.ts, src/lib/ops/alert-delivery.ts, scripts/ops/telemetry-snapshot.ts, scripts/ops/telemetry-watch.ts, and tests/remediation/agent07-incident-lifecycle.test.ts to 65f29251ad9a98b4a87d50b25a807c5f00da631a and remove docs/remediation/v2-agent07-outbox-incidents.md. Pure TypeScript changes using existing Migration 0122/0124 columns; zero SQL DDL rollback required."
}
```

---

## 2. Exported Outbox API Contract for `Agent 06` (`src/lib/reminders/engine.ts`)

All helpers live in [`src/lib/reminders/outbox.ts`](../../src/lib/reminders/outbox.ts) with **zero `process.env`** and **zero `fetch`** references (`boundary:verify` compliant) and use existing `public.notification_outbox` columns (`status`, `claim_token`, `claimed_at`, `uncertain_at`, `metadata`, `provider_message_ids`, `last_error`).

### 2.1 Pre-Send Durable Intent + Post-Send Finalization (`Agent 06` Direct Dispatch Pattern)

```ts
export type OutboxQueryable = Pick<Pool, "query"> | Pick<PoolClient, "query">;

export interface PreparedOutboxSendingIntent {
  outboxId: string | null;
  claimToken: string | null;
  /** True when the idempotencyKey is already sent, delivery_uncertain, claiming, skipped, or dead_letter. */
  alreadyHandled: boolean;
  existingStatus: OutboxStatus | null;
}

export async function prepareOutboxSendingIntent(
  client: OutboxQueryable,
  entry: EnqueueOutboxInput & { claimToken?: string },
): Promise<PreparedOutboxSendingIntent>;

export async function finalizeOutboxSendingOutcome(
  client: OutboxQueryable,
  params: {
    outboxId: string;
    claimToken: string;
    idempotencyKey?: string;
    attemptCount?: number;
    maxAttempts?: number;
    delivery: DeliveryResult & {
      uncertainOutcome?: boolean;
      retryAfterSeconds?: number | null;
      providerMessageId?: string | number | null;
      messageIds?: readonly (string | number)[];
    };
  },
): Promise<OutboxStatus>;
```

**Recommended `Agent 06` Usage Flow:**
1. Call `const intent = await prepareOutboxSendingIntent(pool, { stream: "reminder_digest", channel, idempotencyKey, bodyText, bodyFormat, metadata, legalEntityId });` **BEFORE** invoking `activeTransport.send(...)`.
2. If `intent.alreadyHandled || !intent.outboxId || !intent.claimToken`, skip external send (`0` duplicate messages).
3. Invoke `activeTransport.send(...)` (catching unexpected throws with `classifyThrownTransportError(err)`).
4. Call `await finalizeOutboxSendingOutcome(pool, { outboxId: intent.outboxId, claimToken: intent.claimToken, idempotencyKey, delivery });`.
5. If the worker crashes between Steps 2 and 4, `recoverStaleOutboxClaims` sees `status = 'claiming'` + `metadata.dispatchPhase = 'sending'` and transitions the row to `'delivery_uncertain'` (never `'failed_retryable'`).

### 2.2 Explicit Sending-Phase Marker & Stale-Claim Reaper

```ts
export async function markOutboxSendingStarted(
  client: OutboxQueryable,
  id: string,
  claimToken: string,
  extraMeta?: Record<string, unknown>,
): Promise<void>;

/** Alias of markOutboxSendingStarted for Agent 06 ergonomics. */
export const beginOutboxSending: typeof markOutboxSendingStarted;

export async function recoverStaleOutboxClaims(
  client: OutboxQueryable,
  staleMinutes?: number,
): Promise<{ uncertainCount: number; preSendRetryableCount: number }>;

export function classifyThrownTransportError(err: unknown): DeliveryResult;
```

---

## 3. Durable Outbox State Machine & `F-09` Crash-Window Closure

| Phase (`status` + `metadata.dispatchPhase`) | Transition Trigger | Crash / Timeout Recovery Behavior | Auto-Requeue Permitted? |
|---|---|---|---|
| `pending` (`dispatchPhase = "prepared"`) | `enqueueOutboxNotification` | Remains queued until `next_retry_at <= now()` | Yes (external send not started) |
| `claiming` (`dispatchPhase = "claimed"`) | `claimAndDispatchOutbox` `FOR UPDATE SKIP LOCKED` | Worker crashed **before** `markOutboxSendingStarted`: `recoverStaleOutboxClaims` moves to `failed_retryable` (`stale_pre_send_claim_recovered`) | **Yes** (safe — zero network I/O occurred) |
| `claiming` (`dispatchPhase = "sending"`) | `markOutboxSendingStarted` / `prepareOutboxSendingIntent` (**committed before `transport.send()`**) | Worker crashed or DB dropped **after** send began: `recoverStaleOutboxClaims` moves to `delivery_uncertain` (`requiresOperatorReconciliation = true`) + opens `P1` `outbox_delivery_uncertain` incident | **NO — Strictly Forbidden (`F-09`)** |
| `sent` (`dispatchPhase = "sent"`) | `delivery.ok === true` | Terminal; records `sent_at` and `providerMessageIds` | No |
| `delivery_uncertain` (`dispatchPhase = "delivery_uncertain"`) | `delivery.uncertainOutcome === true`, post-send thrown timeout/socket reset, or stale `'sending'` claim | Held for operator reconciliation; surfaced by `outbox_delivery_uncertain` (`P1`) in `telemetry-snapshot.ts` | **NO — Operator Reconciliation Required** |
| `failed_retryable` / `dead_letter` | Deterministic retryable failure (`uncertainOutcome === false`, e.g. HTTP `429` with `retryAfterSeconds` or `ECONNREFUSED`) | Exponential backoff (`max(retryAfterSeconds, 30 * 2^(attempt-1))`) up to `max_attempts`, then `dead_letter` | Yes while `attempt < max_attempts` |

---

## 4. Incident Lifecycle & Telemetry Verification Matrix (`F-20`, `RG-08`)

| Invariant | Implementation Surface | Test Coverage in `agent07-incident-lifecycle.test.ts` | Status |
|---|---|---|---|
| **Unreadable Telemetry (`?`, `null`, `""`, parse error) -> `UNKNOWN`** | `isUnreadableTelemetryValue`, `jobsStuckAlert`, `importStaleAlert`, `reconciliationAlert`, `ledgerAlert`, `outboxUncertainAlert`, `evaluateAndRecordOpsIncidents`, `parseSnapshotJsonStrict` | Tests `#3` & `#10` (asserts all unreadable & corrupt JSON inputs alert fail-closed, map to `[UNKNOWN]`, preserve prior `OPEN` states, and exit `3` in `runTelemetryWatch`) | **PASS** |
| **Initial `P2` Alert Emission & `6h/24h/72h` Cooldowns** | `evaluateAndRecordOpsIncidents`, `cooldownMsForSeverity` | Test `#1` (`[OPEN][P0]`, `[OPEN][P1]`, `[OPEN][P2]` emitted at `t0`; `6h`, `24h`, `72h` deduplication windows verified) | **PASS** |
| **Severity Escalation (`P2 -> P1`, `P1 -> P0`) Inside Cooldown** | `evaluateAndRecordOpsIncidents` (`severityRank`) | Test `#2` (immediate `[OPEN][P1]` and `[OPEN][P0]` notifications inside cooldown window) | **PASS** |
| **`SUPPRESSED` Window & Expiry Re-Open** | `evaluateAndRecordOpsIncidents` (`suppressedUntil`) | Tests `#4` & `#11` (`0` notifications while `now < suppressedUntil`; automatic transition to `[OPEN]` or `[RESOLVED]` once expired) | **PASS** |
| **Verified `RESOLVED` Evidence Enforcement** | `isValidIncidentResolutionEvidence`, `assertValidIncidentResolutionEvidence`, `resolveOpsIncidentVerified`, `evaluateAndRecordOpsIncidents` | Test `#5` (rejects `null`, blank fields, invalid `verifiedAtISO`, and `measuredValue = "?"` / `"UNKNOWN"`; verifies full 5-field `IncidentResolutionEvidence` on valid resolution) | **PASS** |
