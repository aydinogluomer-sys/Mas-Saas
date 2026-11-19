# MAS Nexus — Telegram Notification Engine, Atomic Claiming & Idempotency Report (`Agent 06`)

## 1. Assigned Incidents & Architectural Scope
- **Primary Incidents:**
  - **`I-007`** — Duplicate overdue alerts, repeated daily CFO briefings & monthly reports, concurrent `dispatchPending` worker race, post-send timeout retry ambiguity, and missing Telegram HTTP `429 retry_after` handling.
  - **`I-014`** — Escaped Telegram HTML/Markdown artifacts (`&#91;P1&#93;`, `&amp;amp;`, `missing\_amount`) and outbound IBAN/token scrubbing.
  - **`I-006` (Engine & Telegram Scope)** — Legacy `365`-day `overdueLookback` truncation silently dropping `>= 366`-day overdue obligations (`Scenario 1`), and legacy `"30+ ... hukuki eskalasyon"` default `-31` rule names in `ensureDefaultMaturityRules` (`Scenario 2` / `Section 7`).
  - **`I-012` (Engine Scope)** — Preserving `originalAmount`, `paidAmount`, and `outstandingAmount` (`Contract A`) in `loadPaymentTargets`, `loadLoanInstallmentTargets`, `loadLiveTargetsForPending`, and batched HTML digests so partially paid obligations are never overstated at face value.
- **Strict Boundary Invariants (`pnpm boundary:verify`):**
  - [transport.ts](file:///c:/Users/Trade%20Bilisim/Mas%20Saas/src/lib/reminders/transport.ts) is the sole reminder egress module owning `fetch` and lazy `await import("@/lib/env")` (zero top-level `@/lib/env` imports, zero direct `process.env` reads).
  - [engine.ts](file:///c:/Users/Trade%20Bilisim/Mas%20Saas/src/lib/reminders/engine.ts) contains **zero `process.env`** and **zero `fetch`** references.

---

## 2. Root Causes Confirmed & Remediations Implemented

### 2.1 Concurrent Cron Race & Atomic Row Claiming (`I-007`, `Scenario 4`)
- **Root Cause:** `dispatchPending()` previously loaded due rows via an unlocked `SELECT ... FROM public.reminder_deliveries WHERE status = 'pending'` before performing live target queries and slow outbound HTTP calls, then updated `WHERE id = $1 AND status = 'pending'`. Two overlapping scheduler/worker ticks could read the exact same `pending` rows simultaneously and send duplicate Telegram messages.
- **Remediation:**
  1. Added `claimPendingDeliveriesAtomic()` in [engine.ts](file:///c:/Users/Trade%20Bilisim/Mas%20Saas/src/lib/reminders/engine.ts#L1296-L1372), which first recovers crashed stale claims (`status = 'claiming' AND claimed_at < now() - interval '10 minutes'`) and then atomically claims due rows in a single autocommit CTE:
     ```sql
     with due as (
       select d.id
         from public.reminder_deliveries d
        where d.status = 'pending'
          and d.scheduled_for <= $1::date
        order by d.scheduled_for asc, d.id asc
        for update skip locked
     )
     update public.reminder_deliveries d
        set status = 'claiming',
            claim_token = gen_random_uuid(),
            claimed_at = now()
       from due, public.reminders r
      where d.id = due.id and r.id = d.reminder_id
     returning ...
     ```
  2. Updated `markReminderDeliveryStatusStrict()` in [engine.ts](file:///c:/Users/Trade%20Bilisim/Mas%20Saas/src/lib/reminders/engine.ts#L1077-L1189) to support `"sent" | "skipped" | "failed" | "delivery_uncertain"`, match `status in ('pending', 'claiming')`, validate `claim_token`, and clear `claim_token = null` on terminal transition.

### 2.2 Uncertain Delivery State on Post-Send Timeouts & Partial Multi-Chunk Sends (`I-007`, `Scenario 15c`, `Section 6`)
- **Root Cause:** When an outbound `sendMessage` request timed out (`TimeoutError` / `AbortError`) after bytes left the socket—or when chunk 1 of a split Telegram message returned `200 OK` and chunk 2 failed with `502`—`sendTelegramChatMessage()` returned a plain `{ ok: false }` failure, allowing automatic retry loops to blindly re-send already-delivered messages.
- **Remediation:**
  1. Extended `DeliveryResult` in [transport.ts](file:///c:/Users/Trade%20Bilisim/Mas%20Saas/src/lib/reminders/transport.ts#L356-L365) with `retryAfterSeconds?: number | null`, `uncertainOutcome?: boolean`, `failureKind?: ExternalOperationOutcomeKind`, and `providerMessageIds?: string[]`.
  2. In `sendTelegramChatMessage()` ([transport.ts](file:///c:/Users/Trade%20Bilisim/Mas%20Saas/src/lib/reminders/transport.ts#L426-L579)), wrapped each chunk's `fetchFn` call to track `chunksSentCount` and `providerMessageIds`:
     - Any `TimeoutError` / `AbortError` or any error/non-2xx after `chunksSentCount > 0` returns `uncertainOutcome: true` with classified `failureKind` (`"timeout"`, `"unknown_outcome"`, `"rate_limited"`, `"permission_failure"`, `"temporary_infra_failure"`, or `"permanent_config_failure"`).
     - Pre-send config/allow-list blocks (`!token`, `!chatId`, unauthorized `chatId`) and chunk-1 non-timeout infra errors (`chunksSentCount === 0`) return `uncertainOutcome: false`.
  3. Updated `recordOutboxOutcomeSafe()`, `loadAlreadySentOutboxKeys()`, and `dispatchPending()` in [engine.ts](file:///c:/Users/Trade%20Bilisim/Mas%20Saas/src/lib/reminders/engine.ts#L1191-L1630) so `uncertainOutcome === true` transitions both `public.notification_outbox` (`uncertain_at = now()`) and `public.reminder_deliveries` to `'delivery_uncertain'`, and `loadAlreadySentOutboxKeys()` suppresses automatic duplicate retries whenever `status in ('sent', 'delivery_uncertain', 'claiming')`.

### 2.3 Telegram HTTP `429` Rate Limiting & Provider `message_id` Tracking (`I-007`, `Scenario 15b`)
- **Remediation:**
  - Added `extractTelegramRetryAfterSeconds()` in [transport.ts](file:///c:/Users/Trade%20Bilisim/Mas%20Saas/src/lib/reminders/transport.ts#L401-L424) extracting positive finite `parameters.retry_after` seconds from Telegram's `429` JSON payload with fallback to the HTTP `Retry-After` header, surfacing `{ ok: false, retryAfterSeconds, uncertainOutcome: chunksSentCount > 0, failureKind: "rate_limited", error: "telegram HTTP 429" }`.
  - Parsed `result.message_id` from `200 OK` responses into `providerMessageIds` (tolerating empty or non-JSON mock bodies) and persisted `providerMessageIds` in `reminder_deliveries.payload`.

### 2.4 Durable `Contract C` Event Identity & High-Volume Digest Consolidation (`I-007`, `Scenario 3`)
- **Remediation:**
  - Updated `dispatchPending()` in [engine.ts](file:///c:/Users/Trade%20Bilisim/Mas%20Saas/src/lib/reminders/engine.ts#L1458-L1480) to compute `computeNotificationIdempotencyKey` over `[channel, legalEntityId ?? "default", entityTable, entityId, ruleId, escalationTier, cadenceSlot, stateVersion]` where `stateVersion = "${dueDate}:${status}:${outstandingAmount}"`.
  - Repeated cron evaluations on unchanged state produce the exact same 64-char SHA-256 key (`0` duplicates), whereas stage transitions (`OVERDUE_1_7 -> OVERDUE_8_30 -> OVERDUE_31_PLUS`) or material settlement/reschedule changes produce distinct keys.
  - Batches of `> 5` simultaneous due/overdue items per channel (such as `92` overdue obligations) consolidate into `<= 1` HTML digest via `buildReminderDigestHtml()` and split tag-safely at `<= 3900` chars via `splitTelegramHtmlMessage()`.

### 2.5 Clean Telegram Escaping, Redaction & Allow-Listing (`I-014`, `Scenario 14`, `Scenario 15a`, `Scenario 16`)
- Verified `escapeTelegramHtml()` escapes only `&`, `<`, and `>` in a single pass (preserving `[P1]` without `&#91;` or `&amp;amp;`), `buildReminderMessage()` / `buildReminderDigestHtml()` render Turkish labels (`missing_amount` -> `Tutar eksik` / `tutar eksik`, never `0 TL`), unauthorized `chatId`s are rejected with `failureKind: "permission_failure"` and `0` HTTP calls, and `scrubSensitiveTelegramText()` / `redactBotToken()` mask raw Turkish IBANs (`TR** **** **** **** **** **XX`) and credentials.

### 2.6 10-Year Overdue Lookback (`3650` Days), `31+` Rule Naming & Partial-Payment Exposure (`I-006`, `I-012`, `Scenario 1`, `Scenario 2`, `Scenario 6`)
- Expanded `overdueLookback` in `scheduleReminders()`, `loadPaymentTargets()`, `loadInvoiceTargets()`, `loadCheckTargets()`, `loadLoanInstallmentTargets()`, and `loadEscalationRadarSummary()` in [engine.ts](file:///c:/Users/Trade%20Bilisim/Mas%20Saas/src/lib/reminders/engine.ts#L387-L870) from `365` days to `3650` days (10 years) so `364`-day, `400`-day, and `1,000`-day overdue items are never silently dropped.
- Standardized all default `-31` rule names in `ensureDefaultMaturityRules()` ([engine.ts](file:///c:/Users/Trade%20Bilisim/Mas%20Saas/src/lib/reminders/engine.ts#L259-L296)) from `"30+ ... hukuki eskalasyon"` to `"31+ ... üst eskalasyon (iç inceleme)"`.
- Wired `paid_amount` and `legal_entity_id` through `mapPaymentInstanceAmounts()` and `mapLoanInstallmentAmounts()` via `computeObligationAmounts()` (`Contract A`), populating `originalAmount`, `paidAmount`, and `outstandingAmount` on live targets and digest items.

---

## 3. Files Modified & Created (Exclusive Agent 06 Scope)
1. [transport.ts](file:///c:/Users/Trade%20Bilisim/Mas%20Saas/src/lib/reminders/transport.ts) — Extended `DeliveryResult` (`retryAfterSeconds`, `uncertainOutcome`, `failureKind`, `providerMessageIds`), added `extractTelegramRetryAfterSeconds()`, post-send timeout & partial multi-chunk `uncertainOutcome` classification, `200 OK` `message_id` capture, and explicit `permission_failure` / `permanent_config_failure` classifications while keeping `@/lib/env` lazy.
2. [engine.ts](file:///c:/Users/Trade%20Bilisim/Mas%20Saas/src/lib/reminders/engine.ts) — Added `claimPendingDeliveriesAtomic()` (`FOR UPDATE SKIP LOCKED` + stale claim recovery), `'delivery_uncertain'` persistence & deduplication hold, `3650`-day overdue lookback, `"31+ ... üst eskalasyon (iç inceleme)"` default rule names, `Contract A` partial-payment amount mapping, and durable `Contract C` idempotency keys (zero `process.env`, zero `fetch`).
3. [agent06-telegram-idempotency.test.ts](file:///c:/Users/Trade%20Bilisim/Mas%20Saas/tests/remediation/agent06-telegram-idempotency.test.ts) — Created 9-scenario mock-only verification suite covering duplicate suppression, concurrent worker race (`1` send, `0` errors), `TimeoutError` -> `delivery_uncertain` hold, HTTP `429 retry_after` JSON & header parsing, `200 OK` `message_id` capture, multi-chunk partial `502` failure, `OVERDUE_1_7 -> OVERDUE_8_30 -> OVERDUE_31_PLUS` transitions + partial-payment exposure + `>365`-day lookback, HTML/IBAN/token escaping & redaction, and `92`-item digest consolidation + tag-safe HTML splitting.
4. [telegram-reliability-report.md](file:///c:/Users/Trade%20Bilisim/Mas%20Saas/docs/remediation/telegram-reliability-report.md) — Created this remediation & verification report.

---

## 4. Verification Evidence

| Command | Scope | Result |
| :--- | :--- | :--- |
| `pnpm boundary:verify` | Static boundary gate (`8/8` checks: egress allow-list, zero `process.env` in `engine.ts`/`transport.ts`, lazy `@/lib/env` in `transport.ts`, secret-free console) | **PASS (`8 / 8`)** |
| `npx vitest run tests/remediation/agent06-telegram-idempotency.test.ts` | All 9 Agent 06 idempotency, concurrency, timeout/uncertain, `429`, partial-batch, escalation, escaping/redaction, and 92-item digest tests (100% mocked, zero real Telegram traffic) | **PASS (`9 / 9`)** |
| `npx vitest run tests/remediation/mandatory-16-scenarios.test.ts -t "Scenario 1\|Scenario 3\|Scenario 4\|Scenario 14\|Scenario 15\|Scenario 16"` | Mandatory Scenarios 1, 3, 4, 10–16 (`10` executed scenarios) | **PASS (`10 / 10`)** |
| `npx vitest run src/lib/reminders/rules.test.ts tests/ops/telegram-and-background-worker.test.ts` | Existing reminder rules, outbox incident state machine, and Telegram worker unit suites (`37` tests) | **PASS (`37 / 37`)** |
| `npx tsc --noEmit` | Full repository TypeScript strict typecheck | **PASS (`0` errors)** |

---

## 5. Remaining Risks & Blockers
- **Uncertain Delivery Operator Workflow:** Rows marked `'delivery_uncertain'` in `public.notification_outbox` and `public.reminder_deliveries` intentionally halt blind automatic retries when post-send acknowledgment is lost (`TimeoutError` or partial chunk failure). Operators can inspect `delivery_uncertain` counts via `deliveryCounts()` and manually review before re-triggering if needed.
- **Blockers:** **None (`0` blockers).**
