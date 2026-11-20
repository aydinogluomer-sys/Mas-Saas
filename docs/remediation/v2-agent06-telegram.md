# MAS Nexus — V2 Production Hardening Handoff Report (`Agent 06` · Telegram Dispatch & Crash-Window Safety Engineer)

- **Agent:** `Agent 06` (Telegram / Notification Dispatch Engineer)
- **Branch:** `remediation/v2-hardening` (Parent `HEAD`: `65f29251ad9a98b4a87d50b25a807c5f00da631a`)
- **Assigned Scope:** `F-08` (`P1` — Telegram Pre-Send Durable `SENDING` Intent & Post-Send Crash-Window Duplicate Prevention) and `F-20` / `RG-07` (`P2` — Adversarial Dispatch Chaos Suite, `ECONNRESET` / Timeout / Partial-Chunk `delivery_uncertain`, Single-Chunk `429 retry_after`, Provider Message ID Capture, HTML Single-Pass Escaping & Redaction)
- **Overall Agent Verdict:** **`PASS`** (`9 / 9` tests in `tests/ops/notification-crash-chaos.test.ts` + `10 / 10` tests in `tests/remediation/agent06-telegram-idempotency.test.ts` + `16 / 16` in `mandatory-16-scenarios.test.ts` + `87 / 87` cross-suite regression tests across `agent07-incident-lifecycle.test.ts`, `agent09-security-isolation.test.ts`, `telegram-and-background-worker.test.ts`, `rules.test.ts`, and `alert-delivery.test.ts` = **`122 / 122` green**; `8 / 8` `boundary:verify` `PASS`; `0` ESLint errors/warnings; `0` TypeScript errors in owned scope & peers)
- **Safety & Privacy Invariants:** `prod_db_writes = 0`, `real_network_sends = 0` (`100%` mock `Transport` / injected fake `fetchImpl`), zero SQL DDL migrations required (`125/0125` preserved), `100%` synthetic/redacted fixtures (`0` real counterparty names, `0` raw IBANs, `0` secrets).

---

## 1. V2 Structured Handoff Contract (`Agent 06 -> Agent 00, Agent 07 & Agent 11`)

```json
{
  "schemaVersion": "mas-v2-agent-handoff-v1",
  "agentId": "Agent 06",
  "role": "Telegram / Notification Dispatch & Crash Safety Engineer",
  "branch": "remediation/v2-hardening",
  "parentCommitSha": "65f29251ad9a98b4a87d50b25a807c5f00da631a",
  "measuredAtISO": "2026-11-20T05:32:00.000Z",
  "status": "PASS",
  "prod_db_writes": 0,
  "real_network_sends": 0,
  "exclusive_write_allowlist": [
    "src/lib/reminders/engine.ts",
    "src/lib/reminders/transport.ts",
    "tests/remediation/agent06-telegram-idempotency.test.ts",
    "tests/ops/notification-crash-chaos.test.ts",
    "docs/remediation/v2-agent06-telegram.md"
  ],
  "files_modified": [
    "src/lib/reminders/engine.ts",
    "src/lib/reminders/transport.ts",
    "tests/remediation/agent06-telegram-idempotency.test.ts"
  ],
  "files_created": [
    "tests/ops/notification-crash-chaos.test.ts",
    "docs/remediation/v2-agent06-telegram.md"
  ],
  "files_modified_outside_allowlist": [],
  "findings": {
    "F-08": {
      "priority": "P1",
      "status": "PASS",
      "confidence": "D",
      "summary": "Reproduced F-08 test-first (exit_code: 1 in tests/ops/notification-crash-chaos.test.ts where transport.send() succeeded at Telegram, a simulated worker crash / DB disconnect occurred before post-send DB writes, and +15m cron restart blindly reset stale 'claiming' rows to 'pending' and sent duplicate messages). Closed the crash window across both individual and >5 consolidated digest dispatches by durably committing SENDING intent in public.notification_outbox (via Agent 07's prepareOutboxSendingIntent) AND stamping payload.dispatchPhase = 'sending' on public.reminder_deliveries asserting (id, status = 'claiming', claim_token) BEFORE invoking activeTransport.send(). Separated stale claim recovery in claimPendingDeliveriesAtomic so stale post-sending rows transition atomically to status = 'delivery_uncertain' (claim_token = null, error = 'crash_window_after_sending_started: operator_reconciliation_required') + P1 ops_incidents signal with 0 automatic duplicate resends, while pre-send crashes (dispatchPhase <> 'sending') safely recover to 'pending'."
    },
    "F-20": {
      "priority": "P2",
      "status": "PASS",
      "confidence": "D",
      "summary": "Hardened sendTelegramChatMessage & telegramTransport in transport.ts to capture providerMessageId + messageIds + providerMessageIds from Telegram 200 OK responses, classify post-dispatch network drops (ECONNRESET, EPIPE, UND_ERR_SOCKET, socket hang up, ETIMEDOUT, TimeoutError, AbortError, HTTP 504) and multi-chunk partial successes (chunk 1 -> 200 OK, chunk 2 -> 500/429) as uncertainOutcome: true ('delivery_uncertain', retryAfterSeconds: null so chunk 1 is never resent), restrict retryAfterSeconds scheduling on HTTP 429 strictly to 0-chunk pre-delivery rejections, and lock single-pass HTML escaping, balanced <=3900-char HTML chunking, >5 digest summarization, expired 'Bugün' suppression, partial tri-value amounts, unknown != 0 TL, chat allowlist enforcement, and IBAN/bot-token redaction in an adversarial chaos suite."
    }
  },
  "consumed_contracts_from_peers": {
    "Agent 07": [
      "prepareOutboxSendingIntent(client, entry): Promise<PreparedOutboxSendingIntent>",
      "finalizeOutboxSendingOutcome(client, params): Promise<OutboxStatus>",
      "recoverStaleOutboxClaims(client, staleMinutes?): Promise<StaleOutboxRecoverySummary>",
      "classifyThrownTransportError(err): DeliveryResult"
    ],
    "Agent 05": [
      "buildReminderMessage",
      "buildReminderDigestHtml",
      "classifyEscalationBucket",
      "matchesReminderOffset",
      "resolveReminderAmounts",
      "scheduledForDate",
      "thresholdPasses"
    ]
  },
  "exported_contracts_for_peers": {
    "Agent 02 & Agent 11": [
      "dispatchPending(pool, transportOrResolver?, todayISO?): Promise<DispatchResult>",
      "scheduleReminders(pool, todayISO?): Promise<{ eligible: number; inserted: number; duplicatesSkipped: number }>",
      "sendTelegramChatMessage(chatId, message, opts?): Promise<DeliveryResult>",
      "splitTelegramHtmlMessage(html, maxLen?): string[]",
      "escapeTelegramHtml(text): string",
      "scrubSensitiveTelegramText(text): string"
    ]
  },
  "release_gate_signals": [
    {
      "id": "RG-07",
      "scope": "ci_and_host",
      "status": "PASS",
      "evidence": "Pre-send durable dispatchPhase='sending' committed on both notification_outbox and reminder_deliveries before transport.send(); post-send crash +15m cron restart yields 1 send total and status='delivery_uncertain' (0 duplicates); concurrent racePool & Mandatory-16 Scenario 3/4/15/16 green."
    }
  ],
  "edge_cases_reproduced_and_fixed": [
    {
      "id": "EC-06-01",
      "symbol": "dispatchPending / claimPendingDeliveriesAtomic (F-08 Single & Digest Crash Window)",
      "defectBeforeFix": "engine.ts:1773 & 1852 invoked activeTransport.send() before persisting durable 'sending' state, and engine.ts:1492-1498 blindly reset all stale 'claiming' rows (>10m) back to 'pending', causing duplicate Telegram messages if the worker crashed or lost DB connectivity after Telegram returned 200 OK.",
      "minimalFix": "Added beginDurableOutboxSendingIntent (wrapping prepareOutboxSendingIntent) + markReminderDeliverySendingStarted (stamping payload.dispatchPhase='sending' asserting claim_token) strictly BEFORE activeTransport.send() in both individual and >5 digest branches, and split stale claim recovery in claimPendingDeliveriesAtomic so dispatchPhase='sending' rows transition atomically to 'delivery_uncertain' while only pre-send ('<> sending') rows recover to 'pending'."
    },
    {
      "id": "EC-06-02",
      "symbol": "sendTelegramChatMessage / classifyFetchTransportException (transport.ts)",
      "defectBeforeFix": "Socket resets during fetch (ECONNRESET / socket hang up / UND_ERR_SOCKET) and Node ETIMEDOUT strings (no 'u' in TIMEDOUT) fell through to uncertainOutcome: false, and HTTP 429 on chunk >= 2 returned non-null retryAfterSeconds despite chunk 1 already being delivered.",
      "minimalFix": "Added classifyFetchTransportException handling ETIMEDOUT, ECONNRESET, EPIPE, UND_ERR_SOCKET, socket hang up, and HTTP 504 as uncertainOutcome: true while keeping ECONNREFUSED/ENOTFOUND pre-connect errors retryable (uncertainOutcome: false), and gated retryAfterSeconds on HTTP 429 strictly to chunksSentCount === 0."
    },
    {
      "id": "EC-06-03",
      "symbol": "DeliveryResult / buildProviderMessagePayloadFields (Provider Message ID Lineage)",
      "defectBeforeFix": "DeliveryResult only exposed providerMessageIds without singular providerMessageId / messageIds alias, and delivery_uncertain rows on partial multi-chunk failures discarded already-delivered chunk message_ids from reminder_deliveries.payload.",
      "minimalFix": "Populated providerMessageId, messageIds, and providerMessageIds in sendTelegramChatMessage (typed as string | number | null compatible with Agent 07's finalizeOutboxSendingOutcome) and persisted providerMessageIds + providerMessageId into reminder_deliveries.payload on both 'sent' and 'delivery_uncertain' outcomes."
    }
  ],
  "verification": {
    "baselineNegativeReproducerCommand": "pnpm exec vitest run tests/ops/notification-crash-chaos.test.ts",
    "baselineNegativeReproducerResult": "exit_code=1 (6/9 failed before fix: crashedDelivery.payload.dispatchPhase was undefined, 7-item digest crash window resent duplicate digest with res2.sent=7, DB failure during sending fence still sent 1 network message, and ECONNRESET returned uncertainOutcome=false)",
    "vitestCommand": "pnpm exec vitest run tests/ops/notification-crash-chaos.test.ts tests/remediation/agent06-telegram-idempotency.test.ts tests/remediation/mandatory-16-scenarios.test.ts",
    "vitestResult": "3 test files passed, 35 tests passed (9 in notification-crash-chaos.test.ts + 10 in agent06-telegram-idempotency.test.ts + 16 in mandatory-16-scenarios.test.ts); extended cross-suite run: 8 files, 122 passed, 0 failed",
    "boundaryCommand": "pnpm boundary:verify",
    "boundaryResult": "8/8 PASS (zero process.env and zero fetch in engine.ts; lazy env import only in transport.ts; zero secret console logging)",
    "eslintCommand": "pnpm exec eslint src/lib/reminders/engine.ts src/lib/reminders/transport.ts tests/remediation/agent06-telegram-idempotency.test.ts tests/ops/notification-crash-chaos.test.ts",
    "eslintResult": "0 errors, 0 warnings",
    "typecheckNote": "0 TypeScript errors in all Agent 06 owned files and Agent 07 outbox integration (workspace tsc --noEmit observed only unrelated in-flight errors in Agent 02, Agent 08, and Agent 12 test files)."
  },
  "rollback_plan": "Restore src/lib/reminders/engine.ts, src/lib/reminders/transport.ts, and tests/remediation/agent06-telegram-idempotency.test.ts to 65f29251ad9a98b4a87d50b25a807c5f00da631a and remove tests/ops/notification-crash-chaos.test.ts and docs/remediation/v2-agent06-telegram.md. Pure TypeScript changes using existing Migration 0122/0124 JSONB/status columns; zero SQL DDL rollback required."
}
```

---

## 2. Durable Dispatch State Machine (`F-08` Closure in `src/lib/reminders/engine.ts`)

| Phase (`reminder_deliveries.status` + `payload.dispatchPhase`) | Persistence Point | Crash / Disconnect Recovery (`> 10m` Stale Claim) | External Send Count |
|---|---|---|---|
| `pending` (`dispatchPhase = "pending"` / initial) | `scheduleReminders` (`ON CONFLICT DO NOTHING`) | Eligible for `FOR UPDATE SKIP LOCKED` claim on `scheduled_for <= todayISO` | `0` |
| `claiming` (`dispatchPhase = "claimed"`) | `claimPendingDeliveriesAtomic` (`claim_token = gen_random_uuid()`) | Worker crashed **before** `SENDING` fence: recovers safely to `status = 'pending'`, `claim_token = null` | `0` (recovers & sends `1` time on next tick) |
| `claiming` (`dispatchPhase = "sending"`) | `beginDurableOutboxSendingIntent` + `markReminderDeliverySendingStarted` (**committed BEFORE `activeTransport.send()`**) | Worker crashed or DB dropped **after** entering `SENDING`: transitions atomically to `status = 'delivery_uncertain'`, `claim_token = null`, `error = 'crash_window_after_sending_started: operator_reconciliation_required'` + `P1` `outbox_delivery_uncertain` incident | **`1` (`0` automatic duplicate sends)** |
| `sent` (`dispatchPhase = "sent"`) | `completeDurableOutboxSendingOutcome` + `markReminderDeliveryStatusStrict("sent")` | Terminal; persists `providerMessageId` + `providerMessageIds` | `1` |
| `delivery_uncertain` (`dispatchPhase = "delivery_uncertain"`) | Post-send timeout / `ECONNRESET` / HTTP `504` / partial multi-chunk failure / stale `'sending'` claim | Held for operator reconciliation; blocked in both `reminder_deliveries` unique tuple and `notification_outbox` (`loadAlreadySentOutboxKeys`) | **`<= 1` (never auto-retried)** |
| `skipped` (`expired_stale_window` / `superseded_or_closed` / `deduped_by_outbox`) | Pre-claim stale upcoming expiry or live target re-validation / outbox dedupe | Terminal for that cadence slot | `0` |

---

## 3. Adversarial Chaos Verification Matrix (`tests/ops/notification-crash-chaos.test.ts` & `tests/remediation/agent06-telegram-idempotency.test.ts`)

| # | Scenario | Expected Invariant | Verified Result |
|---|---|---|---|
| 1 | **`F-08` Single-Item Post-Send Crash Window** (`200 OK` -> DB disconnect before outcome write -> `+15m` cron restart) | `sentPayloads.length === 1`; both `reminder_deliveries` and `notification_outbox` land in `delivery_uncertain`; `0` duplicate sends | **PASS** (`notification-crash-chaos` Test `#1`, `agent06` Test `#10`) |
| 2 | **`F-08` `>= 6` Digest Post-Send Crash Window** (7-item HTML digest `200 OK` -> DB crash -> `+15m` cron restart) | `digestSends === 1`; all 7 `reminder_deliveries` rows transition to `delivery_uncertain`; `0` duplicate digests | **PASS** (`notification-crash-chaos` Test `#2`) |
| 3 | **Pre-Send Crash (`dispatchPhase = 'claimed'`)** (OOM/DB error during target load before `SENDING` -> `+15m` cron restart) | `0` sends during crash; stale pre-send claim recovers to `pending` and delivers `1` time with `providerMessageId: "93001"` | **PASS** (`notification-crash-chaos` Test `#3`, `agent06` Test `#2`) |
| 4 | **DB Failure While Committing `SENDING` Fence** | Aborts before `activeTransport.send()` (`networkSends === 0`) | **PASS** (`notification-crash-chaos` Test `#4`) |
| 5 | **Concurrent Workers Racing + Duplicate Cadence Trigger** | `FOR UPDATE SKIP LOCKED` + `claim_token` + outbox `idempotency_key` -> `1` send total, `0` duplicates | **PASS** (`notification-crash-chaos` Test `#5`, `agent06` Tests `#1, #2`) |
| 6 | **Network Timeout (`TimeoutError` / `ETIMEDOUT`) & `ECONNRESET` During `fetch`** | `uncertainOutcome: true` -> `delivery_uncertain`; `0` automatic retries on subsequent ticks | **PASS** (`notification-crash-chaos` Test `#6`, `agent06` Test `#3`) |
| 7 | **Multi-Chunk HTML Partial Success (`chunk 1 -> 200`, `chunk 2 -> 500/429`) vs Single-Chunk `429 retry_after: 17`** | Partial send -> `uncertainOutcome: true`, `retryAfterSeconds: null`, `delivery_uncertain` (never re-sends chunk 1); single-chunk `429` -> `uncertainOutcome: false`, `retryAfterSeconds: 17` | **PASS** (`notification-crash-chaos` Test `#7`, `agent06` Tests `#4, #5, #6`) |
| 8 | **Rescheduled Future Due Date / Paid / Cancelled & Expired `'Bugün'` Suppression** | Skipped before `SENDING` (`superseded_or_closed` / `expired_stale_window`, `0` sends, `0` outbox rows) | **PASS** (`notification-crash-chaos` Test `#8`) |
| 9 | **`null != 0 TL`, Partial Tri-Value, `>= 6` Digest, Single-Pass HTML Escaping, Balanced Chunking, Allowlist & IBAN/Token Masking** | `tutar eksik` (never `0 TL`), `30.000 / 10.000 / 20.000 TL`, single-pass `&amp;/&lt;/&gt;`, balanced `<=3900` chunks, `permission_failure` (`0` HTTP calls), `bot[REDACTED]` & `TR** ... **XX` | **PASS** (`notification-crash-chaos` Test `#9`, `agent06` Tests `#7, #8, #9`) |
