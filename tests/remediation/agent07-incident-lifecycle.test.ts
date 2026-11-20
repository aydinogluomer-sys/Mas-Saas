import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { deliverAlerts, formatAlertMessage } from "@/lib/ops/alert-delivery";
import {
  backupAgeAlert,
  evaluateOffDeviceRunLog,
  importStaleAlert,
  isUnreadableTelemetryValue,
  jobsStuckAlert,
  ledgerAlert,
  outboxUncertainAlert,
  reconciliationAlert,
  runtimeIdentityAlert,
} from "@/lib/ops/telemetry-alerts";
import {
  assertValidIncidentResolutionEvidence,
  beginOutboxSending,
  claimAndDispatchOutbox,
  classifyThrownTransportError,
  evaluateAndRecordOpsIncidents,
  finalizeOutboxSendingOutcome,
  isValidIncidentResolutionEvidence,
  markOutboxSendingStarted,
  prepareOutboxSendingIntent,
  recoverStaleOutboxClaims,
  resolveOpsIncidentVerified,
  type OpsIncidentRecord,
} from "@/lib/reminders/outbox";
import { mockTransport, type DeliveryResult, type Transport } from "@/lib/reminders/transport";
import { databaseNameFromUrl, isDisposableDatabaseName } from "../../scripts/db/owner-url";
import { runTelemetryWatch } from "../../scripts/ops/telemetry-watch";
import { SUBPROCESS_TEST_TIMEOUT_MS } from "../setup/test-timeouts";

const tempDirs: string[] = [];

function createTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

function resolveExplicitEnvDbUrl(): string | null {
  const url =
    process.env.MIGRATION_DATABASE_URL?.trim() ||
    process.env.MAS_DISPOSABLE_TEST_DATABASE_URL?.trim() ||
    "";
  return url || null;
}

/* ── Deterministic Stateful Outbox & Incident Mock Pool (Zero Live DB Writes, Zero Network) ── */

interface StatefulOutboxRow {
  id: string;
  stream: string;
  channel: "telegram" | "email" | "sms" | "whatsapp";
  recipient_target: string;
  idempotency_key: string;
  subject: string | null;
  body_text: string;
  body_format: "plain" | "html";
  metadata: Record<string, unknown>;
  status: string;
  claim_token: string | null;
  claimed_at: Date | null;
  uncertain_at: Date | null;
  sent_at: Date | null;
  attempt_count: number;
  max_attempts: number;
  next_retry_at: Date;
  provider_message_ids: string[];
  last_error: string | null;
  legal_entity_id: string | null;
  created_at: Date;
  updated_at: Date;
}

interface StatefulIncidentRow {
  signal_key: string;
  severity: "P0" | "P1" | "P2";
  state: string;
  last_value: string;
  state_fingerprint: string;
  note: string;
  opened_at: string | null;
  acknowledged_at: string | null;
  resolved_at: string | null;
  suppressed_until: string | null;
  suppression_reason: string | null;
  last_checked_at: string | null;
  last_success_at: string | null;
  resolution_evidence: unknown;
  correlation_id: string | null;
  last_notified_at: string | null;
  last_notified_state: string | null;
  occurrence_count: number;
  updated_at: string;
}

function createStatefulAgent07Pool(opts: {
  now?: () => Date;
  initialOutbox?: StatefulOutboxRow[];
  initialIncidents?: StatefulIncidentRow[];
} = {}) {
  const getNow = opts.now ?? (() => new Date("2026-11-18T12:00:00.000Z"));
  const outboxRows = new Map<string, StatefulOutboxRow>(
    (opts.initialOutbox ?? []).map((r) => [
      r.id,
      { ...r, metadata: { ...r.metadata }, provider_message_ids: [...r.provider_message_ids] },
    ]),
  );
  const incidentRows = new Map<string, StatefulIncidentRow>(
    (opts.initialIncidents ?? []).map((r) => [r.signal_key, { ...r }]),
  );
  const queryLog: Array<{ sql: string; params: unknown[] }> = [];

  function parseJsonParam(val: unknown): Record<string, unknown> {
    if (!val) return {};
    if (typeof val === "string") {
      try {
        const p = JSON.parse(val) as unknown;
        return p && typeof p === "object" && !Array.isArray(p) ? (p as Record<string, unknown>) : {};
      } catch {
        return {};
      }
    }
    if (typeof val === "object" && !Array.isArray(val)) {
      return val as Record<string, unknown>;
    }
    return {};
  }

  async function execute(rawSql: string, params: unknown[] = []): Promise<{ rows: unknown[]; rowCount: number }> {
    const sql = rawSql.replace(/\s+/g, " ").trim();
    const lower = sql.toLowerCase();
    queryLog.push({ sql, params });

    if (lower === "begin" || lower === "commit" || lower === "rollback" || lower === "select 1") {
      return { rows: lower === "select 1" ? [{ "?column?": 1 }] : [], rowCount: lower === "select 1" ? 1 : 0 };
    }

    // ops_incidents SELECT
    if (lower.startsWith("select") && lower.includes("from public.ops_incidents")) {
      return { rows: [...incidentRows.values()].map((r) => ({ ...r })), rowCount: incidentRows.size };
    }

    // ops_incidents UPSERT
    if (lower.startsWith("insert into public.ops_incidents")) {
      const [
        signal_key,
        severity,
        state,
        last_value,
        state_fingerprint,
        note,
        opened_at,
        acknowledged_at,
        resolved_at,
        suppressed_until,
        suppression_reason,
        last_checked_at,
        last_success_at,
        resolution_evidence,
        correlation_id,
        last_notified_at,
        last_notified_state,
        occurrence_count,
        updated_at,
      ] = params;
      incidentRows.set(String(signal_key), {
        signal_key: String(signal_key),
        severity: severity as "P0" | "P1" | "P2",
        state: String(state),
        last_value: String(last_value ?? ""),
        state_fingerprint: String(state_fingerprint ?? ""),
        note: String(note ?? ""),
        opened_at: (opened_at as string | null) ?? null,
        acknowledged_at: (acknowledged_at as string | null) ?? null,
        resolved_at: (resolved_at as string | null) ?? null,
        suppressed_until: (suppressed_until as string | null) ?? null,
        suppression_reason: (suppression_reason as string | null) ?? null,
        last_checked_at: (last_checked_at as string | null) ?? null,
        last_success_at: (last_success_at as string | null) ?? null,
        resolution_evidence: resolution_evidence ? parseJsonParam(resolution_evidence) : null,
        correlation_id: (correlation_id as string | null) ?? null,
        last_notified_at: (last_notified_at as string | null) ?? null,
        last_notified_state: (last_notified_state as string | null) ?? null,
        occurrence_count: Number(occurrence_count ?? 0),
        updated_at: String(updated_at ?? getNow().toISOString()),
      });
      return { rows: [], rowCount: 1 };
    }

    // ops_incidents UPDATE
    if (lower.startsWith("update public.ops_incidents")) {
      const signalKey = String(params[0]);
      const existing = incidentRows.get(signalKey);
      if (!existing) return { rows: [], rowCount: 0 };
      if (lower.includes("set last_notified_at")) {
        existing.last_notified_at = String(params[1]);
        existing.last_notified_state = String(params[2]);
        existing.updated_at = String(params[1]);
      }
      return { rows: [], rowCount: 1 };
    }

    // notification_outbox SELECT
    if (lower.startsWith("select") && lower.includes("from public.notification_outbox")) {
      if (lower.includes("where idempotency_key = $1")) {
        const key = String(params[0]);
        const found = [...outboxRows.values()].find((r) => r.idempotency_key === key);
        return found ? { rows: [{ ...found }], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      if (lower.includes("where id = $1")) {
        const found = outboxRows.get(String(params[0]));
        return found ? { rows: [{ ...found }], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      return { rows: [...outboxRows.values()], rowCount: outboxRows.size };
    }

    // notification_outbox INSERT
    if (lower.startsWith("insert into public.notification_outbox")) {
      const [
        stream,
        channel,
        recipientTarget,
        idempotencyKey,
        subject,
        bodyText,
        bodyFormat,
        metadataRaw,
        maxAttempts,
        legalEntityId,
      ] = params;
      const dup = [...outboxRows.values()].find((r) => r.idempotency_key === String(idempotencyKey));
      if (dup) return { rows: [], rowCount: 0 };
      const now = getNow();
      const id = randomUUID();
      outboxRows.set(id, {
        id,
        stream: String(stream),
        channel: channel as StatefulOutboxRow["channel"],
        recipient_target: String(recipientTarget),
        idempotency_key: String(idempotencyKey),
        subject: (subject as string | null) ?? null,
        body_text: String(bodyText),
        body_format: (bodyFormat as "plain" | "html") ?? "plain",
        metadata: parseJsonParam(metadataRaw),
        status: "pending",
        claim_token: null,
        claimed_at: null,
        uncertain_at: null,
        sent_at: null,
        attempt_count: 0,
        max_attempts: Number(maxAttempts ?? 5),
        next_retry_at: now,
        provider_message_ids: [],
        last_error: null,
        legal_entity_id: (legalEntityId as string | null) ?? null,
        created_at: now,
        updated_at: now,
      });
      return { rows: [{ id }], rowCount: 1 };
    }

    // Stale-claim recovery on notification_outbox (`where status = 'claiming' and claimed_at < ...`)
    if (lower.startsWith("update public.notification_outbox") && lower.includes("where status = 'claiming'")) {
      const staleMinutes = Number(params[0] ?? 10);
      const cutoffMs = getNow().getTime() - staleMinutes * 60_000;
      const onlySending = lower.includes("= 'sending'");
      const excludeSending = lower.includes("<> 'sending'") || lower.includes("!= 'sending'");
      const targetUncertain = lower.includes("set status = 'delivery_uncertain'");

      let count = 0;
      for (const row of outboxRows.values()) {
        if (row.status !== "claiming") continue;
        if (!row.claimed_at || row.claimed_at.getTime() >= cutoffMs) continue;
        const phase = String(row.metadata?.dispatchPhase ?? "");
        if (onlySending && phase !== "sending") continue;
        if (excludeSending && phase === "sending") continue;

        const now = getNow();
        if (targetUncertain) {
          row.status = "delivery_uncertain";
          row.uncertain_at = row.uncertain_at ?? now;
          row.claim_token = null;
          row.last_error =
            row.last_error ?? "stale_claim_after_sending_started: operator_reconciliation_required";
          row.metadata = {
            ...row.metadata,
            dispatchPhase: "delivery_uncertain",
            requiresOperatorReconciliation: true,
          };
          row.updated_at = now;
        } else {
          row.status = "failed_retryable";
          row.claim_token = null;
          row.last_error =
            row.last_error ??
            (excludeSending ? "stale_pre_send_claim_recovered" : "stale_claim_recovered");
          if (excludeSending) {
            row.metadata = { ...row.metadata, dispatchPhase: "failed_retryable" };
          }
          row.updated_at = now;
        }
        count += 1;
      }
      return { rows: [], rowCount: count };
    }

    // Atomic claim (`with due as (...) update public.notification_outbox ... returning ...`)
    if (lower.startsWith("with due as") && lower.includes("update public.notification_outbox")) {
      const streamFilter = (params[0] as string | null) ?? null;
      const channelFilter = (params[1] as string | null) ?? null;
      const batchSize = Number(params[2] ?? 25);
      const now = getNow();

      const candidates = [...outboxRows.values()]
        .filter((r) => {
          if (r.status !== "pending" && r.status !== "failed_retryable") return false;
          if (r.next_retry_at.getTime() > now.getTime()) return false;
          if (streamFilter && r.stream !== streamFilter) return false;
          if (channelFilter && r.channel !== channelFilter) return false;
          return true;
        })
        .sort(
          (a, b) =>
            a.next_retry_at.getTime() - b.next_retry_at.getTime() ||
            a.created_at.getTime() - b.created_at.getTime(),
        )
        .slice(0, batchSize);

      const claimed: Record<string, unknown>[] = [];
      for (const r of candidates) {
        r.status = "claiming";
        r.claim_token = randomUUID();
        r.claimed_at = now;
        r.updated_at = now;
        if (lower.includes("dispatchphase") && lower.includes("claimed")) {
          r.metadata = { ...r.metadata, dispatchPhase: "claimed" };
        }
        claimed.push({
          id: r.id,
          stream: r.stream,
          channel: r.channel,
          recipient_target: r.recipient_target,
          idempotency_key: r.idempotency_key,
          subject: r.subject,
          body_text: r.body_text,
          body_format: r.body_format,
          metadata: { ...r.metadata },
          claim_token: r.claim_token,
          attempt_count: r.attempt_count,
          max_attempts: r.max_attempts,
        });
      }
      return { rows: claimed, rowCount: claimed.length };
    }

    // Row-targeted notification_outbox UPDATE
    if (lower.startsWith("update public.notification_outbox")) {
      if (lower.includes("where idempotency_key = $1")) {
        return { rows: [], rowCount: 0 };
      }
      const id = String(params[0]);
      const row = outboxRows.get(id);
      if (!row) return { rows: [], rowCount: 0 };
      const now = getNow();

      // Pre-send claiming transition from prepareOutboxSendingIntent (`where id = $1 and status in ('pending', 'failed_retryable')`)
      if (lower.includes("set status = 'claiming'")) {
        if (row.status !== "pending" && row.status !== "failed_retryable") {
          return { rows: [], rowCount: 0 };
        }
        row.status = "claiming";
        row.claim_token = String(params[1]);
        row.claimed_at = now;
        row.metadata = { ...row.metadata, ...parseJsonParam(params[2]) };
        row.updated_at = now;
        return { rows: [{ id: row.id }], rowCount: 1 };
      }

      // Check claim_token when required in WHERE clause
      if (lower.includes("claim_token = $2")) {
        const expectedToken = String(params[1] ?? "");
        if (row.claim_token !== expectedToken) return { rows: [], rowCount: 0 };
        if (lower.includes("status = 'claiming'") && row.status !== "claiming") {
          return { rows: [], rowCount: 0 };
        }
      }

      // Durable `markOutboxSendingStarted` (`set metadata = ... dispatchPhase: 'sending'`)
      if (lower.startsWith("update public.notification_outbox set metadata =") && lower.includes("'sending'")) {
        row.metadata = {
          ...row.metadata,
          dispatchPhase: "sending",
          sendingStartedAt: now.toISOString(),
          sendAttempt: row.attempt_count + 1,
          ...parseJsonParam(params[2]),
        };
        row.updated_at = now;
        return { rows: [{ id: row.id }], rowCount: 1 };
      }

      if (lower.includes("set status = 'sent'")) {
        row.status = "sent";
        row.sent_at = now;
        row.attempt_count += 1;
        row.last_error = null;
        row.claim_token = null;
        if (params[2] !== undefined) row.metadata = { ...row.metadata, ...parseJsonParam(params[2]) };
        if (Array.isArray(params[3]) && params[3].length > 0) {
          row.provider_message_ids = (params[3] as unknown[]).map(String);
        }
        row.updated_at = now;
        return { rows: [{ id: row.id }], rowCount: 1 };
      }

      if (lower.includes("set status = 'skipped'")) {
        row.status = "skipped";
        row.attempt_count += 1;
        row.last_error = String(params[2] ?? "skipped_unconfigured");
        row.claim_token = null;
        if (params[3] !== undefined) row.metadata = { ...row.metadata, ...parseJsonParam(params[3]) };
        row.updated_at = now;
        return { rows: [{ id: row.id }], rowCount: 1 };
      }

      if (lower.includes("set status = 'delivery_uncertain'")) {
        row.status = "delivery_uncertain";
        row.uncertain_at = row.uncertain_at ?? now;
        row.attempt_count += 1;
        row.last_error = String(params[2] ?? "delivery_uncertain");
        row.claim_token = null;
        if (params[3] !== undefined) row.metadata = { ...row.metadata, ...parseJsonParam(params[3]) };
        if (Array.isArray(params[4]) && params[4].length > 0) {
          row.provider_message_ids = (params[4] as unknown[]).map(String);
        }
        row.updated_at = now;
        return { rows: [{ id: row.id }], rowCount: 1 };
      }

      // Retryable / dead_letter branch (`set status = $3`)
      const nextStatus = String(params[2]);
      const nextAttempt = Number(params[3]);
      const backoffSec = Number(params[4]);
      const safeError = String(params[5] ?? "");
      row.status = nextStatus;
      row.attempt_count = nextAttempt;
      row.next_retry_at = new Date(now.getTime() + backoffSec * 1_000);
      row.last_error = safeError;
      row.claim_token = null;
      if (params[6] !== undefined) row.metadata = { ...row.metadata, ...parseJsonParam(params[6]) };
      row.updated_at = now;
      return { rows: [{ id: row.id }], rowCount: 1 };
    }

    throw new Error(`Unsupported SQL in createStatefulAgent07Pool: ${sql}`);
  }

  const pool = {
    query: (sql: string, params?: unknown[]) => execute(sql, params),
    connect: async () => ({
      query: (sql: string, params?: unknown[]) => execute(sql, params),
      release() {},
    }),
  } as unknown as Pool;

  return { pool, outboxRows, incidentRows, queryLog };
}

describe("Agent 07 — Telemetry, Incident State Machine & Outbox Crash-Window Safety", () => {
  it("1. emits initial [OPEN] for P0, P1, AND P2 (latest_import_age_days = 124) and enforces 6h/24h/72h cooldown deduplication", async () => {
    const dir = createTempDir("mas-agent07-cooldown-");
    const stateFilePath = path.join(dir, "ops-incident-state.json");
    const t0 = new Date("2026-11-18T08:00:00.000Z");

    const firingSignals = [
      {
        signal: "reconciliation_mismatch",
        severity: "P0" as const,
        value: "2",
        threshold: "sıfırdan farklı satır sayısı",
      },
      {
        signal: "jobs_stuck",
        severity: "P1" as const,
        value: "3",
        threshold: "> 30 dk 'running'",
      },
      {
        signal: "latest_import_age_days",
        severity: "P2" as const,
        value: "124",
        threshold: "eşik 45 gün",
        note: "SYNTHETIC_WORKBOOK.xlsx 124 gün önce içe aktarıldı",
      },
    ];

    const run1 = await evaluateAndRecordOpsIncidents(null, firingSignals, {
      now: t0,
      stateFilePath,
      correlationId: "tel-run-1",
    });
    expect(run1.notifications).toHaveLength(3);
    expect(
      run1.notifications.find((n) => n.signalKey === "reconciliation_mismatch")?.formattedLine,
    ).toContain("[OPEN][P0]");
    expect(run1.notifications.find((n) => n.signalKey === "jobs_stuck")?.formattedLine).toContain(
      "[OPEN][P1]",
    );
    expect(
      run1.notifications.find((n) => n.signalKey === "latest_import_age_days")?.formattedLine,
    ).toContain("[OPEN][P2]");

    const t2h = new Date(t0.getTime() + 2 * 60 * 60 * 1_000);
    const run2 = await evaluateAndRecordOpsIncidents(null, firingSignals, {
      now: t2h,
      stateFilePath,
      correlationId: "tel-run-2",
    });
    expect(run2.notifications).toHaveLength(0);
    expect(
      run2.records.find((r) => r.signalKey === "latest_import_age_days")?.occurrenceCount,
    ).toBe(2);

    const t6h = new Date(t0.getTime() + 6 * 60 * 60 * 1_000);
    const run3 = await evaluateAndRecordOpsIncidents(null, firingSignals, {
      now: t6h,
      stateFilePath,
      correlationId: "tel-run-3",
    });
    expect(run3.notifications.map((n) => n.signalKey)).toEqual(["reconciliation_mismatch"]);

    const t24h = new Date(t0.getTime() + 24 * 60 * 60 * 1_000);
    const run4 = await evaluateAndRecordOpsIncidents(null, firingSignals, {
      now: t24h,
      stateFilePath,
      correlationId: "tel-run-4",
    });
    expect(run4.notifications.map((n) => n.signalKey)).toEqual([
      "reconciliation_mismatch",
      "jobs_stuck",
    ]);

    const t71h = new Date(t0.getTime() + 71 * 60 * 60 * 1_000);
    const run4b = await evaluateAndRecordOpsIncidents(null, firingSignals, {
      now: t71h,
      stateFilePath,
      correlationId: "tel-run-4b",
    });
    expect(run4b.notifications.some((n) => n.signalKey === "latest_import_age_days")).toBe(false);

    const t72h = new Date(t0.getTime() + 72 * 60 * 60 * 1_000);
    const run5 = await evaluateAndRecordOpsIncidents(null, firingSignals, {
      now: t72h,
      stateFilePath,
      correlationId: "tel-run-5",
    });
    const p2Reemit = run5.notifications.find((n) => n.signalKey === "latest_import_age_days");
    expect(p2Reemit).toBeDefined();
    expect(p2Reemit!.formattedLine).toContain("[OPEN][P2]");
  });

  it("2. emits intentional transition notifications on severity escalation (P2 -> P1 and P1 -> P0) even inside cooldown", async () => {
    const dir = createTempDir("mas-agent07-escalation-");
    const stateFilePath = path.join(dir, "ops-incident-state.json");
    const t0 = new Date("2026-11-18T09:00:00.000Z");

    const openP2 = await evaluateAndRecordOpsIncidents(
      null,
      [{ signal: "import_failures_24h", severity: "P2", value: "1", note: "1 hata" }],
      { now: t0, stateFilePath, correlationId: "esc-1" },
    );
    expect(openP2.notifications).toHaveLength(1);
    expect(openP2.notifications[0]!.formattedLine).toContain("[OPEN][P2]");

    const t10m = new Date(t0.getTime() + 10 * 60 * 1_000);
    const escP1 = await evaluateAndRecordOpsIncidents(
      null,
      [{ signal: "import_failures_24h", severity: "P1", value: "5", note: "5 hata" }],
      { now: t10m, stateFilePath, correlationId: "esc-2" },
    );
    expect(escP1.notifications).toHaveLength(1);
    expect(escP1.notifications[0]!.severity).toBe("P1");
    expect(escP1.notifications[0]!.formattedLine).toContain("[OPEN][P1]");
    expect(escP1.notifications[0]!.formattedLine).toContain("P2 -> P1");

    const t20m = new Date(t0.getTime() + 20 * 60 * 1_000);
    const escP0 = await evaluateAndRecordOpsIncidents(
      null,
      [{ signal: "import_failures_24h", severity: "P0", value: "25", note: "kritik hata fırtınası" }],
      { now: t20m, stateFilePath, correlationId: "esc-3" },
    );
    expect(escP0.notifications).toHaveLength(1);
    expect(escP0.notifications[0]!.severity).toBe("P0");
    expect(escP0.notifications[0]!.formattedLine).toContain("[OPEN][P0]");
    expect(escP0.notifications[0]!.formattedLine).toContain("P1 -> P0");
  });

  it("3. classifies unreadable telemetry ('?', null, empty, parse error) as fail-closed alert + UNKNOWN incident (never OK / RESOLVED / ALL CLEAR)", async () => {
    // Pure fail-closed predicate verification on ?, null, undefined, empty, and parse-error inputs
    for (const unreadable of ["?", null, undefined, "", "   ", "NaN", "PARSE_ERROR", "BOZUK KOŞU KAYDI"]) {
      expect(isUnreadableTelemetryValue(unreadable)).toBe(true);
      expect(jobsStuckAlert(unreadable)).toBe(true);
      expect(outboxUncertainAlert(unreadable)).toBe(true);
      expect(importStaleAlert(unreadable, 45)).toBe(true);
      expect(reconciliationAlert(unreadable)).toBe(true);
      expect(ledgerAlert(unreadable, "125/0125")).toBe(true);
      expect(ledgerAlert("125/0125", unreadable)).toBe(true);
      expect(ledgerAlert(unreadable, unreadable)).toBe(true);
    }
    expect(backupAgeAlert(-1, 36)).toBe(true);
    expect(backupAgeAlert(Number.NaN, 36)).toBe(true);
    expect(runtimeIdentityAlert(null)).toBe(true);
    expect(evaluateOffDeviceRunLog("{not-valid-json").alert).toBe(true);
    expect(evaluateOffDeviceRunLog("{not-valid-json").value).toBe("BOZUK KOŞU KAYDI");

    const dir = createTempDir("mas-agent07-unknown-");
    const stateFilePath = path.join(dir, "ops-incident-state.json");
    const t0 = new Date("2026-11-18T10:00:00.000Z");

    await evaluateAndRecordOpsIncidents(
      null,
      [
        { signal: "jobs_stuck", severity: "P1", value: "4", threshold: "> 30 dk" },
        { signal: "latest_import_age_days", severity: "P2", value: "124", threshold: "eşik 45 gün" },
      ],
      { now: t0, stateFilePath, correlationId: "unk-0" },
    );

    // Query failure ('?'), null value, and parse error ('BOZUK KOŞU KAYDI') -> ALL map to UNKNOWN (never RESOLVED)
    const t5m = new Date(t0.getTime() + 5 * 60 * 1_000);
    const unknownRun = await evaluateAndRecordOpsIncidents(
      null,
      [
        { signal: "jobs_stuck", severity: "P1", value: "?", note: "UNKNOWN — DB sorgusu başarısız" },
        { signal: "reconciliation_mismatch", severity: "P0", value: null, note: "okunamadı" },
        { signal: "offdevice_backup_status", severity: "P1", value: "BOZUK KOŞU KAYDI", note: "JSON bozuk" },
        { signal: "latest_import_age_days", severity: "P2", value: "124", threshold: "eşik 45 gün" },
      ],
      { now: t5m, stateFilePath, correlationId: "unk-1" },
    );

    const jobsUnknown = unknownRun.records.find((r) => r.signalKey === "jobs_stuck");
    expect(jobsUnknown?.state).toBe("UNKNOWN");
    expect(jobsUnknown?.lastCheckedAt).toBe(t5m.toISOString());
    expect(jobsUnknown?.lastSuccessAt).toBe(t0.toISOString());

    expect(unknownRun.records.find((r) => r.signalKey === "reconciliation_mismatch")?.state).toBe(
      "UNKNOWN",
    );
    expect(unknownRun.records.find((r) => r.signalKey === "offdevice_backup_status")?.state).toBe(
      "UNKNOWN",
    );

    const alertText = formatAlertMessage("unk-fmt", [
      {
        signal: "offdevice_backup_status",
        section: "DB",
        value: "BOZUK KOŞU KAYDI",
        threshold: "daily-runs.jsonl",
        severity: "P1",
        message: "bozuk",
      },
    ]);
    expect(alertText).toContain("[UNKNOWN][P1]");
    expect(alertText).not.toContain("ALL CLEAR");

    // Blind snapshot crash (telemetry_snapshot_unavailable) MUST NOT resolve prior OPEN/UNKNOWN incidents
    const t10m = new Date(t0.getTime() + 10 * 60 * 1_000);
    const blindRun = await evaluateAndRecordOpsIncidents(
      null,
      [
        {
          signal: "telemetry_snapshot_unavailable",
          severity: "P0",
          value: "SNAPSHOT_UNAVAILABLE (exit 3)",
          snapshotUnavailable: true,
        },
      ],
      { now: t10m, stateFilePath, correlationId: "watch-blind-1" },
    );

    expect(
      blindRun.records.find((r) => r.signalKey === "latest_import_age_days")?.state,
    ).toBe("OPEN");
    expect(blindRun.records.find((r) => r.signalKey === "jobs_stuck")?.state).toBe("UNKNOWN");
    expect(blindRun.notifications.every((n) => n.nextState !== "RESOLVED")).toBe(true);
  });

  it("4. honors active SUPPRESSED window with zero notifications and resumes [OPEN] once suppressedUntil expires", async () => {
    const dir = createTempDir("mas-agent07-suppressed-");
    const stateFilePath = path.join(dir, "ops-incident-state.json");
    const t0 = new Date("2026-11-18T08:00:00.000Z");

    const seededSuppressed: OpsIncidentRecord = {
      signalKey: "offdevice_backup_status",
      severity: "P1",
      state: "SUPPRESSED",
      lastValue: "TEK KOPYA (exit 3)",
      stateFingerprint: "fp-suppressed",
      note: "harici disk bakımı",
      openedAt: t0.toISOString(),
      acknowledgedAt: null,
      resolvedAt: null,
      suppressedUntil: "2026-11-18T14:00:00.000Z",
      suppressionReason: "Planlı NAS bakımı",
      lastCheckedAt: t0.toISOString(),
      lastSuccessAt: t0.toISOString(),
      resolutionEvidence: null,
      correlationId: "sup-init",
      lastNotifiedAt: null,
      lastNotifiedState: null,
      occurrenceCount: 1,
      updatedAt: t0.toISOString(),
    };
    writeFileSync(
      stateFilePath,
      JSON.stringify(
        { updatedAt: t0.toISOString(), incidents: { offdevice_backup_status: seededSuppressed } },
        null,
        2,
      ),
      "utf8",
    );

    const duringWindow = await evaluateAndRecordOpsIncidents(
      null,
      [{ signal: "offdevice_backup_status", severity: "P1", value: "TEK KOPYA (exit 3)" }],
      { now: new Date("2026-11-18T12:00:00.000Z"), stateFilePath, correlationId: "sup-active" },
    );
    const activeRec = duringWindow.records.find((r) => r.signalKey === "offdevice_backup_status");
    expect(activeRec?.state).toBe("SUPPRESSED");
    expect(activeRec?.suppressedUntil).toBe("2026-11-18T14:00:00.000Z");
    expect(activeRec?.suppressionReason).toBe("Planlı NAS bakımı");
    expect(activeRec?.occurrenceCount).toBe(2);
    expect(duringWindow.notifications).toHaveLength(0);

    const afterExpiry = await evaluateAndRecordOpsIncidents(
      null,
      [{ signal: "offdevice_backup_status", severity: "P1", value: "TEK KOPYA (exit 3)" }],
      { now: new Date("2026-11-18T14:05:00.000Z"), stateFilePath, correlationId: "sup-expired" },
    );
    const reopenedRec = afterExpiry.records.find((r) => r.signalKey === "offdevice_backup_status");
    expect(reopenedRec?.state).toBe("OPEN");
    expect(reopenedRec?.suppressedUntil).toBeNull();
    expect(reopenedRec?.suppressionReason).toBeNull();
    expect(afterExpiry.notifications).toHaveLength(1);
    expect(afterExpiry.notifications[0]!.formattedLine).toContain("[OPEN][P1]");
  });

  it("5. requires verified IncidentResolutionEvidence for RESOLVED and rejects unverified resolution attempts", async () => {
    const dir = createTempDir("mas-agent07-resolve-");
    const logPath = path.join(dir, "alerts.jsonl");
    const stateFilePath = path.join(dir, "ops-incident-state.json");
    const tg = mockTransport({ channel: "telegram" });

    // Negative controls on IncidentResolutionEvidence validator
    expect(isValidIncidentResolutionEvidence(null)).toBe(false);
    expect(
      isValidIncidentResolutionEvidence({
        whatChanged: "",
        verifiedByCheck: "telemetry:schema_ledger",
        verifiedAtISO: "2026-11-18T09:15:00.000Z",
        measuredValue: "OK",
        evidenceSource: "telemetry",
      }),
    ).toBe(false);
    expect(
      isValidIncidentResolutionEvidence({
        whatChanged: "fixed",
        verifiedByCheck: "telemetry:schema_ledger",
        verifiedAtISO: "not-an-iso-date",
        measuredValue: "OK",
        evidenceSource: "telemetry",
      }),
    ).toBe(false);
    expect(
      isValidIncidentResolutionEvidence({
        whatChanged: "fixed",
        verifiedByCheck: "telemetry:schema_ledger",
        verifiedAtISO: "2026-11-18T09:15:00.000Z",
        measuredValue: "?",
        evidenceSource: "telemetry",
      }),
    ).toBe(false);
    expect(() => assertValidIncidentResolutionEvidence({ measuredValue: "UNKNOWN" }, "schema_ledger")).toThrow(
      /IncidentResolutionEvidence/,
    );

    const tOpen = new Date("2026-11-18T08:00:00.000Z");
    const openReport = await deliverAlerts({
      runId: "tel-corr-open-01",
      alerts: [
        {
          signal: "schema_ledger",
          section: "APP",
          value: "115/0115",
          threshold: "beklenen 119/0119",
          severity: "P0",
          message: "schema_ledger = 115/0115 (beklenen 119/0119)",
        },
      ],
      logPath,
      channels: ["log", "telegram"],
      transports: { telegram: tg },
      now: tOpen,
    });
    expect(openReport.allDelivered).toBe(true);
    expect(openReport.incidentNotifications).toHaveLength(1);
    expect(openReport.incidentNotifications![0]!.correlationId).toBe("tel-corr-open-01");

    // Attempting unverified manual resolution via resolveOpsIncidentVerified MUST throw and keep state OPEN
    await expect(
      resolveOpsIncidentVerified(null, {
        signalKey: "schema_ledger",
        evidence: {
          whatChanged: "tahmin edildi",
          verifiedByCheck: "",
          verifiedAtISO: "2026-11-18T09:00:00.000Z",
          measuredValue: "?",
          evidenceSource: "",
        },
        stateFilePath,
      }),
    ).rejects.toThrow(/IncidentResolutionEvidence/);

    // Attempting unverified resolution via resolutionEvidenceBySignal: { schema_ledger: null } MUST stay OPEN
    const rejectedResolve = await deliverAlerts({
      runId: "tel-corr-unverified-resolve",
      alerts: [],
      logPath,
      channels: ["log", "telegram"],
      transports: { telegram: tg },
      now: new Date("2026-11-18T09:05:00.000Z"),
      resolutionEvidenceBySignal: { schema_ledger: null },
    });
    expect(rejectedResolve.incidentNotifications).toHaveLength(0);
    expect(
      rejectedResolve.incidentRecords?.find((r) => r.signalKey === "schema_ledger")?.state,
    ).toBe("OPEN");

    // Verified resolution succeeds and emits [RESOLVED][P0] with complete structured evidence
    const tResolved = new Date("2026-11-18T09:15:00.000Z");
    const resolvedReport = await deliverAlerts({
      runId: "tel-corr-resolved-02",
      alerts: [],
      logPath,
      channels: ["log", "telegram"],
      transports: { telegram: tg },
      now: tResolved,
    });
    expect(resolvedReport.allDelivered).toBe(true);
    expect(resolvedReport.incidentNotifications).toHaveLength(1);

    const notif = resolvedReport.incidentNotifications![0]!;
    const rec = resolvedReport.incidentRecords?.find((r) => r.signalKey === "schema_ledger");

    expect(notif.nextState).toBe("RESOLVED");
    expect(notif.correlationId).toBe("tel-corr-resolved-02");
    expect(notif.formattedLine).toContain("[RESOLVED][P0]");
    expect(notif.formattedLine).toContain("telemetry:schema_ledger -> OK");

    expect(rec?.state).toBe("RESOLVED");
    expect(rec?.resolutionEvidence).toEqual({
      whatChanged: "schema_ledger: 115/0115 -> OK",
      verifiedByCheck: "telemetry:schema_ledger",
      verifiedAtISO: tResolved.toISOString(),
      measuredValue: "OK",
      evidenceSource: "telemetry:tel-corr-resolved-02",
    });

    const stateJson = JSON.parse(readFileSync(stateFilePath, "utf8")) as {
      incidents: Record<string, OpsIncidentRecord>;
    };
    expect(stateJson.incidents.schema_ledger?.resolutionEvidence?.verifiedByCheck).toBe(
      "telemetry:schema_ledger",
    );
  });

  it("6. persists durable dispatchPhase='sending' BEFORE transport.send() and aborts send if claim_token was lost", async () => {
    const events: string[] = [];
    const executedUpdates: Array<{ sql: string; params: unknown[] }> = [];
    const claimedRows = [
      {
        id: "outbox-uncertain-row",
        stream: "ops_incident",
        channel: "telegram",
        recipient_target: "-1001111111",
        idempotency_key: "idem-unc-07",
        subject: null,
        body_text: "Kritik P0 Uyarısı",
        body_format: "plain",
        metadata: {},
        claim_token: "11111111-1111-4111-8111-111111111111",
        attempt_count: 0,
        max_attempts: 5,
      },
      {
        id: "outbox-429-row",
        stream: "ops_incident",
        channel: "email",
        recipient_target: "ops@mas.local",
        idempotency_key: "idem-429-07",
        subject: "Uyarı",
        body_text: "Rate limited test",
        body_format: "plain",
        metadata: {},
        claim_token: "22222222-2222-4222-8222-222222222222",
        attempt_count: 0,
        max_attempts: 5,
      },
    ];

    const mockPool = {
      async connect() {
        return {
          async query(sql: string) {
            if (sql.toLowerCase().includes("with due as")) {
              return { rows: claimedRows, rowCount: claimedRows.length };
            }
            return { rows: [], rowCount: 0 };
          },
          release() {},
        };
      },
      async query(sql: string, params: unknown[] = []) {
        const normalized = sql.replace(/\s+/g, " ").trim();
        executedUpdates.push({ sql: normalized, params });
        if (normalized.toLowerCase().includes("'sending'")) {
          events.push(`db:sending:${String(params[0])}`);
        } else {
          events.push(`db:finalize:${String(params[0])}`);
        }
        return { rows: [{ id: params[0] }], rowCount: 1 };
      },
    } as unknown as Pool;

    const summary = await claimAndDispatchOutbox(mockPool, {
      transportResolver: (ch): Transport => ({
        channel: ch,
        async send(): Promise<DeliveryResult> {
          events.push(`transport:send:${ch}`);
          if (ch === "telegram") {
            return {
              ok: false,
              error: "TimeoutError after socket write",
              uncertainOutcome: true,
            } as DeliveryResult;
          }
          return {
            ok: false,
            error: "HTTP 429 Too Many Requests",
            retryAfterSeconds: 95,
          } as DeliveryResult;
        },
      }),
    });

    expect(summary).toEqual({
      claimed: 2,
      sent: 0,
      retried: 1,
      deadLettered: 0,
      skipped: 0,
      uncertain: 1,
    });

    // Strict ordering proof: db:sending MUST execute BEFORE transport:send for every claimed row!
    expect(events).toEqual([
      "db:sending:outbox-uncertain-row",
      "transport:send:telegram",
      "db:finalize:outbox-uncertain-row",
      "db:sending:outbox-429-row",
      "transport:send:email",
      "db:finalize:outbox-429-row",
    ]);

    const uncertainFinalUpdate = executedUpdates.find((u) =>
      u.sql.toLowerCase().includes("set status = 'delivery_uncertain'"),
    );
    expect(uncertainFinalUpdate).toBeDefined();
    expect(uncertainFinalUpdate!.params[0]).toBe("outbox-uncertain-row");
    expect(uncertainFinalUpdate!.params[1]).toBe("11111111-1111-4111-8111-111111111111");

    const retryFinalUpdate = executedUpdates.find((u) => u.params[2] === "failed_retryable");
    expect(retryFinalUpdate).toBeDefined();
    expect(retryFinalUpdate!.params[4]).toBe(95);

    // Fencing check: if claim_token was invalidated before markOutboxSendingStarted, transport.send is NEVER called
    expect(beginOutboxSending).toBe(markOutboxSendingStarted);
    await expect(
      markOutboxSendingStarted(
        { query: async () => ({ rows: [], rowCount: 0 }) } as unknown as Pool,
        "ob-lost-claim",
        "33333333-3333-4333-8333-333333333333",
      ),
    ).rejects.toThrow(/claim_token/);
  });

  it("7. [F-09 REPRODUCER] holds stale claiming row in 'delivery_uncertain' when metadata.dispatchPhase === 'sending' (NEVER resets to failed_retryable or duplicate-resends)", async () => {
    const now = new Date("2026-11-18T12:00:00.000Z");
    const staleClaimedAt = new Date(now.getTime() - 15 * 60_000);

    const { pool, outboxRows, incidentRows } = createStatefulAgent07Pool({
      now: () => now,
      initialOutbox: [
        {
          id: "ob-stale-sending",
          stream: "ops_incident",
          channel: "telegram",
          recipient_target: "-100777001",
          idempotency_key: "idem-f09-stale-sending",
          subject: null,
          body_text: "[OPEN][P0] Zaten dış kanala gönderimi başlamış mesaj",
          body_format: "plain",
          metadata: {
            dispatchPhase: "sending",
            sendingStartedAt: "2026-11-18T11:45:01.000Z",
          },
          status: "claiming",
          claim_token: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          claimed_at: staleClaimedAt,
          uncertain_at: null,
          sent_at: null,
          attempt_count: 0,
          max_attempts: 5,
          next_retry_at: staleClaimedAt,
          provider_message_ids: [],
          last_error: null,
          legal_entity_id: null,
          created_at: staleClaimedAt,
          updated_at: staleClaimedAt,
        },
        {
          id: "ob-stale-presend",
          stream: "ops_incident",
          channel: "telegram",
          recipient_target: "-100777001",
          idempotency_key: "idem-f09-stale-presend",
          subject: null,
          body_text: "[OPEN][P1] Henüz ağ çağrısı başlamadan çöken mesaj",
          body_format: "plain",
          metadata: {
            dispatchPhase: "claimed",
          },
          status: "claiming",
          claim_token: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
          claimed_at: staleClaimedAt,
          uncertain_at: null,
          sent_at: null,
          attempt_count: 0,
          max_attempts: 5,
          next_retry_at: staleClaimedAt,
          provider_message_ids: [],
          last_error: null,
          legal_entity_id: null,
          created_at: staleClaimedAt,
          updated_at: staleClaimedAt,
        },
      ],
    });

    const spyTransport = mockTransport({ channel: "telegram" });
    const summary = await claimAndDispatchOutbox(pool, {
      staleClaimMinutes: 10,
      transportResolver: () => spyTransport,
    });

    const staleSendingAfter = outboxRows.get("ob-stale-sending")!;
    const stalePreSendAfter = outboxRows.get("ob-stale-presend")!;

    expect(staleSendingAfter.status).toBe("delivery_uncertain");
    expect(staleSendingAfter.claim_token).toBeNull();
    expect(staleSendingAfter.uncertain_at).not.toBeNull();
    expect(staleSendingAfter.metadata.dispatchPhase).toBe("delivery_uncertain");
    expect(staleSendingAfter.metadata.requiresOperatorReconciliation).toBe(true);
    expect(spyTransport.sent).not.toContain(
      "[OPEN][P0] Zaten dış kanala gönderimi başlamış mesaj",
    );
    expect(incidentRows.get("outbox_delivery_uncertain")?.state).toBe("OPEN");
    expect(summary.uncertain).toBe(1);

    expect(stalePreSendAfter.status).toBe("sent");
    expect(spyTransport.sent).toEqual(["[OPEN][P1] Henüz ağ çağrısı başlamadan çöken mesaj"]);
  });

  it("8. classifies thrown socket/timeout transport errors as delivery_uncertain and persists providerMessageIds on sent/uncertain outcomes", async () => {
    const socketResetErr = Object.assign(
      new Error("socket hang up https://api.telegram.org/bot999888:SECRET_TOK/sendMessage"),
      { code: "ECONNRESET" },
    );
    const classifiedReset = classifyThrownTransportError(socketResetErr);
    expect(classifiedReset.uncertainOutcome).toBe(true);
    expect(classifiedReset.error).not.toContain("SECRET_TOK");

    const preConnectErr = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:443"), {
      code: "ECONNREFUSED",
    });
    expect(classifyThrownTransportError(preConnectErr).uncertainOutcome).toBe(false);

    const now = new Date("2026-11-18T12:00:00.000Z");
    const { pool, outboxRows } = createStatefulAgent07Pool({
      now: () => now,
      initialOutbox: [
        {
          id: "ob-throw-reset",
          stream: "ops_incident",
          channel: "telegram",
          recipient_target: "-100777",
          idempotency_key: "idem-throw-reset",
          subject: null,
          body_text: "Throw socket reset",
          body_format: "plain",
          metadata: {},
          status: "pending",
          claim_token: null,
          claimed_at: null,
          uncertain_at: null,
          sent_at: null,
          attempt_count: 0,
          max_attempts: 5,
          next_retry_at: now,
          provider_message_ids: [],
          last_error: null,
          legal_entity_id: null,
          created_at: now,
          updated_at: now,
        },
        {
          id: "ob-ok-msgid",
          stream: "cfo_briefing",
          channel: "email",
          recipient_target: "cfo@mas.local",
          idempotency_key: "idem-ok-msgid",
          subject: "Günlük Özet",
          body_text: "Özet metni",
          body_format: "plain",
          metadata: {},
          status: "pending",
          claim_token: null,
          claimed_at: null,
          uncertain_at: null,
          sent_at: null,
          attempt_count: 0,
          max_attempts: 5,
          next_retry_at: now,
          provider_message_ids: [],
          last_error: null,
          legal_entity_id: null,
          created_at: now,
          updated_at: now,
        },
      ],
    });

    const summary = await claimAndDispatchOutbox(pool, {
      transportResolver: (ch): Transport => ({
        channel: ch,
        async send(): Promise<DeliveryResult> {
          if (ch === "telegram") {
            throw socketResetErr;
          }
          return {
            ok: true,
            providerMessageIds: ["msg-9001", "msg-9002"],
          };
        },
      }),
    });

    expect(summary).toEqual({
      claimed: 2,
      sent: 1,
      retried: 0,
      deadLettered: 0,
      skipped: 0,
      uncertain: 1,
    });
    expect(outboxRows.get("ob-throw-reset")?.status).toBe("delivery_uncertain");
    expect(outboxRows.get("ob-throw-reset")?.last_error).not.toContain("SECRET_TOK");
    expect(outboxRows.get("ob-ok-msgid")?.status).toBe("sent");
    expect(outboxRows.get("ob-ok-msgid")?.provider_message_ids).toEqual(["msg-9001", "msg-9002"]);
    expect(outboxRows.get("ob-ok-msgid")?.metadata.providerMessageIds).toEqual([
      "msg-9001",
      "msg-9002",
    ]);
  });

  it("9. supports Agent 06 pre-send durable intent contract (prepareOutboxSendingIntent + finalizeOutboxSendingOutcome + crash recovery)", async () => {
    let currentNow = new Date("2026-11-18T12:00:00.000Z");
    const { pool, outboxRows } = createStatefulAgent07Pool({ now: () => currentNow });

    // 1) Agent 06 prepares durable sending intent BEFORE transport.send()
    const intent1 = await prepareOutboxSendingIntent(pool, {
      stream: "reminder_digest",
      channel: "telegram",
      idempotencyKey: "idem-agent06-crash-test",
      bodyText: "Vadesi gelen ödeme bildirimi",
      bodyFormat: "html",
      metadata: { ruleId: "r-1" },
    });
    expect(intent1.alreadyHandled).toBe(false);
    expect(intent1.outboxId).toBeTruthy();
    expect(intent1.claimToken).toBeTruthy();

    const preSendRow = outboxRows.get(intent1.outboxId!)!;
    expect(preSendRow.status).toBe("claiming");
    expect(preSendRow.metadata.dispatchPhase).toBe("sending");

    // Concurrent worker attempting same idempotencyKey while in-flight is blocked (`alreadyHandled: true`)
    const concurrentAttempt = await prepareOutboxSendingIntent(pool, {
      stream: "reminder_digest",
      channel: "telegram",
      idempotencyKey: "idem-agent06-crash-test",
      bodyText: "Vadesi gelen ödeme bildirimi",
    });
    expect(concurrentAttempt.alreadyHandled).toBe(true);
    expect(concurrentAttempt.existingStatus).toBe("claiming");

    // Simulate process crash AFTER external send began; 15 minutes later stale recovery runs
    currentNow = new Date("2026-11-18T12:15:00.000Z");
    const recovered = await recoverStaleOutboxClaims(pool, 10);
    expect(recovered).toEqual({ uncertainCount: 1, preSendRetryableCount: 0 });
    expect(outboxRows.get(intent1.outboxId!)?.status).toBe("delivery_uncertain");

    // Subsequent worker seeing `delivery_uncertain` MUST NOT auto-resend (`alreadyHandled: true`)
    const postCrashAttempt = await prepareOutboxSendingIntent(pool, {
      stream: "reminder_digest",
      channel: "telegram",
      idempotencyKey: "idem-agent06-crash-test",
      bodyText: "Vadesi gelen ödeme bildirimi",
    });
    expect(postCrashAttempt.alreadyHandled).toBe(true);
    expect(postCrashAttempt.existingStatus).toBe("delivery_uncertain");

    // 2) Clean end-to-end prepare -> finalize sent with providerMessageId
    const intent2 = await prepareOutboxSendingIntent(pool, {
      stream: "reminder_digest",
      channel: "telegram",
      idempotencyKey: "idem-agent06-clean-sent",
      bodyText: "Temiz gönderim",
    });
    expect(intent2.alreadyHandled).toBe(false);

    const finalState = await finalizeOutboxSendingOutcome(pool, {
      outboxId: intent2.outboxId!,
      claimToken: intent2.claimToken!,
      delivery: { ok: true, providerMessageId: 774411 },
    });
    expect(finalState).toBe("sent");
    expect(outboxRows.get(intent2.outboxId!)?.provider_message_ids).toEqual(["774411"]);
    expect(outboxRows.get(intent2.outboxId!)?.metadata.providerMessageIds).toEqual(["774411"]);
  });

  it("10. ensures runTelemetryWatch treats corrupt/unparseable snapshot JSON as SNAPSHOT_UNAVAILABLE -> UNKNOWN (exit 3, never ALL CLEAR)", async () => {
    const dir = createTempDir("mas-agent07-watch-corrupt-");
    const fakeSnapshotPath = path.join(dir, "fake-corrupt-snapshot.ts");
    writeFileSync(
      fakeSnapshotPath,
      `import { writeFileSync } from "node:fs";
       const idx = process.argv.indexOf("--json");
       if (idx !== -1 && process.argv[idx + 1]) {
         writeFileSync(process.argv[idx + 1], "{corrupt-json-payload", "utf8");
       }
       process.exit(0);
      `,
      "utf8",
    );

    const tgSpy = mockTransport({ channel: "telegram" });
    const exitCode = await runTelemetryWatch({
      logDir: dir,
      snapshotScriptPath: fakeSnapshotPath,
      envLocalOverride: {
        MIGRATION_DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:5432/mas_radar_watch_test",
        MAS_ALERT_CHANNELS: "log,telegram",
      },
      transports: { telegram: tgSpy },
    });

    expect(exitCode).toBe(3);
    expect(tgSpy.sent).toHaveLength(1);
    expect(tgSpy.sent[0]).toContain("[UNKNOWN][P0]");
    expect(tgSpy.sent[0]).toContain("SNAPSHOT_PARSE_ERROR");
    expect(tgSpy.sent[0]).not.toContain("ALL CLEAR");

    const runLog = JSON.parse(
      readFileSync(path.join(dir, "telemetry-runs.jsonl"), "utf8").trim(),
    ) as { verdict: string; checks: Array<{ verdict: string }> };
    expect(runLog.verdict).toBe("SNAPSHOT_UNAVAILABLE");
    expect(runLog.checks.every((c) => c.verdict === "UNKNOWN")).toBe(true);
  }, SUBPROCESS_TEST_TIMEOUT_MS);

  it("11. persists full incident lifecycle (OPEN -> SUPPRESSED -> RESOLVED with resolution_evidence & correlation_id) to SQL public.ops_incidents", async () => {
    const dir = createTempDir("mas-agent07-sql-");
    const logPath = path.join(dir, "alerts.jsonl");
    const { pool, incidentRows } = createStatefulAgent07Pool();

    const tOpen = new Date("2026-11-18T11:00:00.000Z");
    await deliverAlerts({
      runId: "pg-corr-open-07",
      alerts: [
        {
          signal: "latest_import_age_days",
          section: "APP",
          value: "124",
          threshold: "eşik 45 gün",
          severity: "P2",
          message: "latest_import_age_days = 124",
        },
      ],
      logPath,
      channels: ["log"],
      pool,
      now: tOpen,
    });

    const dbOpen = incidentRows.get("latest_import_age_days");
    expect(dbOpen?.state).toBe("OPEN");
    expect(dbOpen?.severity).toBe("P2");
    expect(dbOpen?.correlation_id).toBe("pg-corr-open-07");

    incidentRows.set("latest_import_age_days", {
      ...dbOpen!,
      state: "SUPPRESSED",
      suppressed_until: "2026-11-18T12:00:00.000Z",
      suppression_reason: "Planlı veri aktarımı",
    });

    const supReport = await deliverAlerts({
      runId: "pg-corr-suppressed-07",
      alerts: [
        {
          signal: "latest_import_age_days",
          section: "APP",
          value: "124",
          threshold: "eşik 45 gün",
          severity: "P2",
          message: "latest_import_age_days = 124",
        },
      ],
      logPath,
      channels: ["log"],
      pool,
      now: new Date("2026-11-18T11:30:00.000Z"),
    });
    expect(supReport.incidentNotifications ?? []).toHaveLength(0);

    const tResolved = new Date("2026-11-18T12:30:00.000Z");
    await deliverAlerts({
      runId: "pg-corr-resolved-07",
      alerts: [],
      logPath,
      channels: ["log"],
      pool,
      now: tResolved,
    });

    const dbResolved = incidentRows.get("latest_import_age_days");
    expect(dbResolved?.state).toBe("RESOLVED");
    expect(dbResolved?.suppressed_until).toBeNull();
    expect(dbResolved?.correlation_id).toBe("pg-corr-resolved-07");
    expect(dbResolved?.resolution_evidence).toEqual({
      whatChanged: "latest_import_age_days: 124 -> OK",
      verifiedByCheck: "telemetry:latest_import_age_days",
      verifiedAtISO: tResolved.toISOString(),
      measuredValue: "OK",
      evidenceSource: "telemetry:pg-corr-resolved-07",
    });
  });

  it("12. verifies Migration 0122 & 0124 SQL schema contracts for notification_outbox, ops_incidents, and valid_workbook_imports without mutating live DB", () => {
    const mig0122 = readFileSync(
      path.resolve("supabase/migrations/0122_audit_hardening_schema_outbox_controls_entity_rls.sql"),
      "utf8",
    );
    const mig0124 = readFileSync(
      path.resolve("supabase/migrations/0124_remediation_outbox_incidents_import_freshness.sql"),
      "utf8",
    );

    expect(mig0122).toContain("create table if not exists public.notification_outbox");
    expect(mig0122).toContain("claim_token uuid");
    expect(mig0122).toContain("claimed_at timestamptz");
    expect(mig0122).toContain("metadata jsonb not null default '{}'::jsonb");
    expect(mig0122).toContain("provider_message_ids text[] not null default '{}'");

    expect(mig0124).toContain("uncertain_at timestamptz");
    expect(mig0124).toContain("'delivery_uncertain'");
    expect(mig0124).toContain("'SUPPRESSED'");
    expect(mig0124).toContain("suppressed_until timestamptz");
    expect(mig0124).toContain("resolution_evidence jsonb");
    expect(mig0124).toContain("correlation_id text");
    expect(mig0124).toContain("create or replace view public.valid_workbook_imports");
    expect(mig0124).toContain("sw.status in ('parsed', 'mapped')");
    expect(mig0124).toContain("from public.import_rows ir");
  });
});

/* ── Optional Explicit Read-Only PostgreSQL Session Check (`prod_db_writes = 0`) ── */
const explicitDbUrl = resolveExplicitEnvDbUrl();

describe.skipIf(!explicitDbUrl)(
  "Agent 07 — Read-Only PostgreSQL Schema & View Parity (0 DB Mutations)",
  () => {
    let roPool: Pool;

    beforeAll(async () => {
      roPool = new Pool({
        connectionString: explicitDbUrl!,
        max: 1,
        connectionTimeoutMillis: 30_000,
        options: "-c default_transaction_read_only=on",
      });
    }, SUBPROCESS_TEST_TIMEOUT_MS);

    afterAll(async () => {
      await roPool?.end().catch(() => {});
    });

    it("verifies notification_outbox, ops_incidents, and valid_workbook_imports catalog under strict read-only session", async () => {
      const client = await roPool.connect();
      try {
        await client.query("BEGIN READ ONLY");
        const roCheck = await client.query<{ transaction_read_only: string }>(
          "show transaction_read_only",
        );
        expect(roCheck.rows[0]?.transaction_read_only).toBe("on");

        const outboxCols = await client.query<{ column_name: string }>(
          `select column_name
             from information_schema.columns
            where table_schema = 'public'
              and table_name = 'notification_outbox'`,
        );
        const colSet = new Set(outboxCols.rows.map((r) => r.column_name));
        for (const requiredCol of [
          "status",
          "claim_token",
          "claimed_at",
          "uncertain_at",
          "metadata",
          "last_error",
          "correlation_id",
          "provider_message_ids",
        ]) {
          expect(colSet.has(requiredCol)).toBe(true);
        }

        const dbName = databaseNameFromUrl(explicitDbUrl!);
        if (dbName && !isDisposableDatabaseName(dbName)) {
          const ageRes = await client.query<{ age_days: string }>(
            `select coalesce(round(extract(epoch from (now() - max(imported_at))) / 86400)::text, 'İÇE AKTARIM YOK') as age_days
               from public.valid_workbook_imports`,
          );
          expect(Number(ageRes.rows[0]?.age_days ?? "0")).toBeGreaterThan(45);
        }
      } finally {
        await client.query("ROLLBACK").catch(() => {});
        client.release();
      }
    }, SUBPROCESS_TEST_TIMEOUT_MS);
  },
);
