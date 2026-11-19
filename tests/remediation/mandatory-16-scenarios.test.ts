import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Pool, PoolClient } from "pg";
import { afterEach, describe, expect, it } from "vitest";
import { SUBPROCESS_TEST_TIMEOUT_MS } from "../setup/test-timeouts";

import { computeObligationAmounts } from "@/lib/contracts/remediation-contracts";
import { evaluateSelfApprovalEligibility } from "@/lib/approvals/engine";
import { assertSchemaParity, checkSchemaParity, readExpectedSchemaManifest } from "@/lib/db/schema-parity";
import { DomainError } from "@/lib/domain-error";
import { mapAcceptedChecks } from "@/lib/financing/engine";
import { addDaysISO } from "@/lib/financing/rules";
import { extractChecks } from "@/lib/importers/extractors";
import type { CellVal, SheetRow } from "@/lib/importers/row-utils";
import { looksLikeSecret, redactSecrets } from "@/lib/ops/alert-delivery";
import {
  evaluateOffDeviceRunLog,
  jobsStuckAlert,
  ledgerAlert,
  reconciliationAlert,
  runtimeIdentityAlert,
} from "@/lib/ops/telemetry-alerts";
import { markInstancePaid } from "@/lib/radar/engine";
import { monthSummary } from "@/lib/radar/queries";
import {
  dispatchPending,
  eligibleMaturityDeliveries,
  scheduleReminders,
} from "@/lib/reminders/engine";
import {
  claimAndDispatchOutbox,
  computeNotificationIdempotencyKey,
  evaluateAndRecordOpsIncidents,
} from "@/lib/reminders/outbox";
import {
  ESCALATION_BUCKET_LABELS,
  buildReminderDigestHtml,
  buildReminderMessage,
  classifyEscalationBucket,
  daysOverdue,
  matchesReminderOffset,
  scheduledForDate,
  thresholdPasses,
  type ReminderRule,
  type ReminderTarget,
} from "@/lib/reminders/rules";
import {
  TELEGRAM_HTML_SAFE_MAX_CHARS,
  escapeTelegramHtml,
  mockTransport,
  sendTelegramChatMessage,
  splitTelegramHtmlMessage,
  type DeliveryResult,
  type Transport,
} from "@/lib/reminders/transport";
import {
  buildDailyReport,
  buildMonthlyReport,
  istanbulDateISO,
  type ReportInstance,
} from "@/lib/reports/rules";
import {
  classifyOffDeviceTarget,
  planPrune,
  type DumpEntry,
  type RetentionPolicy,
} from "../../scripts/ops/backup-lib";
import {
  readWorkerScheduleState,
  runScheduledMaintenance,
  writeWorkerScheduleStateAtomic,
} from "../../scripts/ops/background-worker";

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

/* ── Shared Stateful Mock Pool for Reminder Scheduling & Concurrent Dispatch ── */

interface MockDeliveryRow {
  id: string;
  reminder_id: string;
  entity_table: string;
  entity_id: string;
  scheduled_for: string;
  status: string;
  claim_token: string | null;
  payload: Record<string, unknown> | null;
  error: string | null;
}

interface MockOutboxRow {
  id: string;
  stream: string;
  channel: string;
  recipient_target: string;
  idempotency_key: string;
  subject: string | null;
  body_text: string;
  body_format: "plain" | "html";
  metadata: Record<string, unknown>;
  status: string;
  claim_token: string | null;
  attempt_count: number;
  max_attempts: number;
  last_error: string | null;
}

function createStatefulReminderPool(seed: {
  rules: Array<{
    id: string;
    name: string;
    target_kind: string;
    offset_days: number;
    channel: "telegram" | "email";
    min_amount: string | null;
    is_active: boolean;
  }>;
  loanInstallments: Array<{
    id: string;
    installment_no: number;
    loan_name: string;
    due_date: string;
    amount: string | null;
    paid_amount: string | null;
    status: string;
    provider: string | null;
  }>;
  deliveries?: MockDeliveryRow[];
}) {
  const rules = new Map(seed.rules.map((r) => [r.id, { ...r }]));
  const loans = new Map(seed.loanInstallments.map((l) => [l.id, { ...l }]));
  const deliveries = new Map<string, MockDeliveryRow>(
    (seed.deliveries ?? []).map((d) => [d.id, { ...d }]),
  );
  const outboxByKey = new Map<string, MockOutboxRow>();
  const lockedDeliveryIds = new Set<string>();
  const lockedOutboxIds = new Set<string>();
  const advisoryLocks = new Set<string>();

  function executeSql(
    rawSql: string,
    params: unknown[] = [],
    clientHeldDeliveryLocks?: Set<string>,
    clientHeldOutboxLocks?: Set<string>,
    clientAdvisoryLocks?: Set<string>,
  ): { rows: Record<string, unknown>[]; rowCount: number } {
    const sql = rawSql.replace(/\s+/g, " ").trim().toLowerCase();

    if (
      sql === "begin" ||
      sql === "commit" ||
      sql === "rollback" ||
      sql.startsWith("savepoint ") ||
      sql.startsWith("release savepoint ") ||
      sql.startsWith("rollback to savepoint ") ||
      sql.startsWith("set local ") ||
      sql.startsWith("set statement_timeout") ||
      sql.startsWith("reset statement_timeout")
    ) {
      if (sql === "commit" || sql === "rollback") {
        if (clientHeldDeliveryLocks) {
          for (const id of clientHeldDeliveryLocks) lockedDeliveryIds.delete(id);
          clientHeldDeliveryLocks.clear();
        }
        if (clientHeldOutboxLocks) {
          for (const id of clientHeldOutboxLocks) lockedOutboxIds.delete(id);
          clientHeldOutboxLocks.clear();
        }
      }
      return { rows: [], rowCount: 0 };
    }

    // PostgreSQL session/transaction advisory locks
    if (sql.includes("pg_try_advisory_lock") || sql.includes("pg_try_advisory_xact_lock")) {
      const key = JSON.stringify(params);
      if (advisoryLocks.has(key)) {
        return {
          rows: [{ pg_try_advisory_lock: false, pg_try_advisory_xact_lock: false, locked: false, acquired: false }],
          rowCount: 1,
        };
      }
      advisoryLocks.add(key);
      clientAdvisoryLocks?.add(key);
      return {
        rows: [{ pg_try_advisory_lock: true, pg_try_advisory_xact_lock: true, locked: true, acquired: true }],
        rowCount: 1,
      };
    }

    if (sql.includes("pg_advisory_unlock")) {
      const key = JSON.stringify(params);
      const existed = advisoryLocks.delete(key);
      clientAdvisoryLocks?.delete(key);
      return { rows: [{ pg_advisory_unlock: existed }], rowCount: 1 };
    }

    // Active rules loader
    if (sql.includes("from public.reminders") && sql.startsWith("select")) {
      const rows = [...rules.values()].filter((r) =>
        sql.includes("where is_active = true") ? r.is_active : true,
      );
      return { rows, rowCount: rows.length };
    }

    // Loan installment targets loader (both scheduleReminders range query and loadLiveTargetsForPending id=any($1))
    if (sql.includes("from public.loan_installments")) {
      const list = [...loans.values()].filter((li) =>
        ["planned", "unpaid", "partial", "late"].includes(li.status),
      );
      let filtered = list;
      if (sql.includes("any($1")) {
        const ids = new Set((params[0] as string[]) ?? []);
        filtered = list.filter((li) => ids.has(li.id));
      } else if (sql.includes("between ($1::date - $2::int) and ($1::date + $3::int)")) {
        const todayISO = String(params[0]);
        const lookback = Number(params[1]);
        const horizon = Number(params[2]);
        const minDate = addDaysISO(todayISO, -lookback);
        const maxDate = addDaysISO(todayISO, horizon);
        filtered = list.filter((li) => li.due_date >= minDate && li.due_date <= maxDate);
      } else if (sql.includes("due_date <=")) {
        const todayISO = String(params[0]);
        const horizon = Number(params[params.length - 1] ?? 30);
        const maxDate = Number.isFinite(horizon) ? addDaysISO(todayISO, horizon) : "9999-12-31";
        filtered = list.filter((li) => li.due_date <= maxDate);
      }

      const rows = filtered.map((li) => {
        const origNum = li.amount == null ? null : Number(li.amount);
        const paidNum = li.paid_amount == null ? null : Number(li.paid_amount);
        const computedRemaining =
          li.status === "partial" && origNum != null && paidNum != null
            ? String(Math.max(origNum - paidNum, 0))
            : li.amount;
        return {
          id: li.id,
          name: `${li.loan_name} (Taksit #${li.installment_no})`,
          due_date: li.due_date,
          amount: computedRemaining,
          original_amount: li.amount,
          paid_amount: li.paid_amount,
          outstanding_amount: computedRemaining,
          status: li.status,
          provider: li.provider,
        };
      });
      return { rows, rowCount: rows.length };
    }

    // Other empty target tables during scheduleReminders / loadLiveTargetsForPending
    if (
      sql.includes("from public.payment_instances") ||
      sql.includes("from public.invoices") ||
      sql.includes("from public.promise_to_pay") ||
      sql.includes("from public.checks") ||
      sql.includes("from public.covenant_records") ||
      sql.includes("from cov_due")
    ) {
      return { rows: [], rowCount: 0 };
    }

    // Insert into reminder_deliveries with unique (reminder_id, entity_table, entity_id, scheduled_for)
    if (sql.startsWith("insert into public.reminder_deliveries")) {
      const [reminderId, entityTable, entityId, scheduledFor, rawPayload] = params as [
        string,
        string,
        string,
        string,
        string,
      ];
      const duplicate = [...deliveries.values()].find(
        (d) =>
          d.reminder_id === reminderId &&
          d.entity_table === entityTable &&
          d.entity_id === entityId &&
          d.scheduled_for === scheduledFor,
      );
      if (duplicate) {
        return { rows: [], rowCount: 0 };
      }
      const id = randomUUID();
      deliveries.set(id, {
        id,
        reminder_id: reminderId,
        entity_table: entityTable,
        entity_id: entityId,
        scheduled_for: scheduledFor,
        status: "pending",
        claim_token: null,
        payload: rawPayload ? (JSON.parse(rawPayload) as Record<string, unknown>) : null,
        error: null,
      });
      return { rows: [{ id }], rowCount: 1 };
    }

    // Stale upcoming window expiry in dispatchPending
    if (
      sql.startsWith("update public.reminder_deliveries") &&
      sql.includes("expired_stale_window")
    ) {
      const todayISO = String(params[0]);
      const cutoff = addDaysISO(todayISO, -1);
      let count = 0;
      for (const d of deliveries.values()) {
        const rule = rules.get(d.reminder_id);
        if (rule && d.status === "pending" && rule.offset_days >= 0 && d.scheduled_for < cutoff) {
          d.status = "skipped";
          d.error = "expired_stale_window";
          count += 1;
        }
      }
      return { rows: [], rowCount: count };
    }

    // Stale claiming recovery on reminder_deliveries (if implemented)
    if (
      sql.startsWith("update public.reminder_deliveries") &&
      sql.includes("where status = 'claiming'") &&
      !sql.includes("returning")
    ) {
      return { rows: [], rowCount: 0 };
    }

    // Atomic CTE/UPDATE claiming on reminder_deliveries (`with due as (... for update skip locked) update public.reminder_deliveries ... set status = 'claiming' ... returning ...`)
    if (
      (sql.startsWith("with ") || sql.startsWith("update public.reminder_deliveries")) &&
      sql.includes("reminder_deliveries") &&
      sql.includes("returning") &&
      (sql.includes("claiming") || sql.includes("processing") || sql.includes("for update"))
    ) {
      const todayISO = String(params[0] ?? "9999-12-31");
      const claimed: Record<string, unknown>[] = [];
      const sorted = [...deliveries.values()].sort((a, b) =>
        a.scheduled_for === b.scheduled_for
          ? a.id.localeCompare(b.id)
          : a.scheduled_for.localeCompare(b.scheduled_for),
      );
      for (const d of sorted) {
        if (d.status !== "pending") continue;
        if (d.scheduled_for > todayISO) continue;
        if (lockedDeliveryIds.has(d.id)) continue;
        const r = rules.get(d.reminder_id);
        if (!r) continue;
        d.status = "claiming";
        d.claim_token = randomUUID();
        claimed.push({
          id: d.id,
          reminder_id: d.reminder_id,
          entity_table: d.entity_table,
          entity_id: d.entity_id,
          scheduled_for: d.scheduled_for,
          payload: d.payload,
          claim_token: d.claim_token,
          rule_name: r.name,
          target_kind: r.target_kind,
          offset_days: r.offset_days,
          channel: r.channel,
          min_amount: r.min_amount,
          is_active: r.is_active,
        });
      }
      return { rows: claimed, rowCount: claimed.length };
    }

    // SELECT from reminder_deliveries (with or without FOR UPDATE SKIP LOCKED)
    if (sql.includes("from public.reminder_deliveries d") && sql.startsWith("select")) {
      const todayISO = String(params[0] ?? "9999-12-31");
      const hasSkipLocked = sql.includes("for update");
      const out: Record<string, unknown>[] = [];
      const sorted = [...deliveries.values()].sort((a, b) =>
        a.scheduled_for === b.scheduled_for
          ? a.id.localeCompare(b.id)
          : a.scheduled_for.localeCompare(b.scheduled_for),
      );
      for (const d of sorted) {
        if (d.status !== "pending") continue;
        if (d.scheduled_for > todayISO) continue;
        if (hasSkipLocked && lockedDeliveryIds.has(d.id)) continue;
        const r = rules.get(d.reminder_id);
        if (!r) continue;
        if (hasSkipLocked) {
          lockedDeliveryIds.add(d.id);
          clientHeldDeliveryLocks?.add(d.id);
        }
        out.push({
          id: d.id,
          reminder_id: d.reminder_id,
          entity_table: d.entity_table,
          entity_id: d.entity_id,
          scheduled_for: d.scheduled_for,
          payload: d.payload,
          claim_token: d.claim_token,
          rule_name: r.name,
          target_kind: r.target_kind,
          offset_days: r.offset_days,
          channel: r.channel,
          min_amount: r.min_amount,
          is_active: r.is_active,
        });
      }
      return { rows: out, rowCount: out.length };
    }

    // Finalizing status on reminder_deliveries
    if (sql.startsWith("update public.reminder_deliveries")) {
      const id = String(params[0]);
      const d = deliveries.get(id);
      if (!d) return { rows: [], rowCount: 0 };

      const allowsClaiming =
        sql.includes("'claiming'") ||
        sql.includes("claim_token") ||
        !sql.includes("status = 'pending'");
      const statusMatches =
        d.status === "pending" || (allowsClaiming && d.status === "claiming");
      if (!statusMatches) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("claim_token =")) {
        const tokenParam = params.find(
          (p, idx) => idx > 0 && typeof p === "string" && p === d.claim_token,
        );
        if (d.claim_token && !tokenParam) {
          return { rows: [], rowCount: 0 };
        }
      }

      if (sql.includes("set status = 'claiming'")) {
        d.status = "claiming";
        d.claim_token = d.claim_token ?? randomUUID();
      } else if (sql.includes("set status = 'sent'")) {
        d.status = "sent";
        d.claim_token = null;
        d.error = null;
      } else if (sql.includes("set status = 'skipped'")) {
        d.status = "skipped";
        d.claim_token = null;
      } else if (sql.includes("set status = 'delivery_uncertain'")) {
        d.status = "delivery_uncertain";
        d.claim_token = null;
      } else {
        d.status = String(params[1] ?? "failed");
        d.error = params[2] != null ? String(params[2]) : null;
        d.claim_token = null;
      }
      return { rows: [{ id: d.id }], rowCount: 1 };
    }

    // Outbox deduplication lookup
    if (sql.includes("from public.notification_outbox") && sql.startsWith("select")) {
      const keys = new Set<string>(
        Array.isArray(params[0]) ? (params[0] as string[]) : [String(params[0] ?? "")],
      );
      const rows: Record<string, unknown>[] = [];
      for (const o of outboxByKey.values()) {
        if (!keys.has(o.idempotency_key)) continue;
        if (sql.includes("status = 'sent'") && o.status !== "sent") continue;
        if (
          sql.includes("delivery_uncertain") &&
          o.status !== "sent" &&
          o.status !== "delivery_uncertain" &&
          o.status !== "claiming"
        ) {
          continue;
        }
        rows.push({ id: o.id, idempotency_key: o.idempotency_key, status: o.status });
      }
      return { rows, rowCount: rows.length };
    }

    // Outbox idempotent insert
    if (sql.startsWith("insert into public.notification_outbox")) {
      const [stream, channel, recipientTarget, idempotencyKey, subject, bodyText, bodyFormat, metadataRaw, maxAttempts] =
        params as [string, string, string, string, string | null, string, "plain" | "html", string, number];
      if (outboxByKey.has(idempotencyKey)) {
        return { rows: [], rowCount: 0 };
      }
      const id = randomUUID();
      outboxByKey.set(idempotencyKey, {
        id,
        stream,
        channel,
        recipient_target: recipientTarget,
        idempotency_key: idempotencyKey,
        subject,
        body_text: bodyText,
        body_format: bodyFormat,
        metadata: metadataRaw ? (JSON.parse(metadataRaw) as Record<string, unknown>) : {},
        status: "pending",
        claim_token: null,
        attempt_count: 0,
        max_attempts: Number(maxAttempts ?? 5),
        last_error: null,
      });
      return { rows: [{ id }], rowCount: 1 };
    }

    // Outbox atomic claim
    if (
      sql.startsWith("with due as") &&
      sql.includes("update public.notification_outbox") &&
      sql.includes("returning")
    ) {
      const streamFilter = params[0] as string | null;
      const channelFilter = params[1] as string | null;
      const limit = Number(params[2] ?? 25);
      const claimed: Record<string, unknown>[] = [];
      for (const o of outboxByKey.values()) {
        if (claimed.length >= limit) break;
        if (o.status !== "pending" && o.status !== "failed_retryable") continue;
        if (streamFilter && o.stream !== streamFilter) continue;
        if (channelFilter && o.channel !== channelFilter) continue;
        if (lockedOutboxIds.has(o.id)) continue;
        o.status = "claiming";
        o.claim_token = randomUUID();
        claimed.push({ ...o });
      }
      return { rows: claimed, rowCount: claimed.length };
    }

    // Outbox updates
    if (sql.startsWith("update public.notification_outbox")) {
      if (sql.includes("where status = 'claiming'")) {
        return { rows: [], rowCount: 0 };
      }
      let target: MockOutboxRow | undefined;
      if (sql.includes("where idempotency_key = $1")) {
        target = outboxByKey.get(String(params[0]));
      } else {
        const id = String(params[0]);
        const token = String(params[1] ?? "");
        target = [...outboxByKey.values()].find(
          (o) => o.id === id && (!sql.includes("claim_token") || o.claim_token === token),
        );
      }
      if (!target) return { rows: [], rowCount: 0 };

      const literalMatch = sql.match(/set\s+status\s*=\s*'([a-z_]+)'/);
      const paramMatch = sql.match(/set\s+status\s*=\s*\$(\d+)/);
      if (literalMatch) {
        target.status = literalMatch[1]!;
      } else if (paramMatch) {
        const idx = Number(paramMatch[1]) - 1;
        target.status = String(params[idx]);
      } else if (sql.includes("dead_letter")) {
        target.status = target.attempt_count + 1 >= target.max_attempts ? "dead_letter" : "failed_retryable";
      }
      target.attempt_count += 1;
      target.claim_token = null;
      return { rows: [{ id: target.id }], rowCount: 1 };
    }

    throw new Error(`Mock reminder pool: beklenmeyen SQL: ${rawSql}`);
  }

  const pool = {
    async query(sql: string, params?: unknown[]) {
      return executeSql(sql, params);
    },
    async connect() {
      const heldDelivery = new Set<string>();
      const heldOutbox = new Set<string>();
      const heldAdv = new Set<string>();
      return {
        async query(sql: string, params?: unknown[]) {
          return executeSql(sql, params, heldDelivery, heldOutbox, heldAdv);
        },
        release() {
          for (const id of heldDelivery) lockedDeliveryIds.delete(id);
          heldDelivery.clear();
          for (const id of heldOutbox) lockedOutboxIds.delete(id);
          heldOutbox.clear();
          for (const key of heldAdv) advisoryLocks.delete(key);
          heldAdv.clear();
        },
      };
    },
  } as unknown as Pool;

  return { pool, deliveries, outboxByKey };
}

describe("MAS Nexus — Mandatory 16 Remediation & Regression Scenarios (Section 5)", () => {
  it("Scenario 1 (I-006): 364-day overdue loan & 400-day overdue loan match ONLY 31+ (-31) and are not dropped by scheduleReminders lookback", async () => {
    const asOf = "2026-11-18";
    const due364 = "2025-11-19"; // 364 days overdue
    const due400 = "2025-10-14"; // 400 days overdue (> 365-day legacy cap)

    expect(daysOverdue(due364, asOf)).toBe(364);
    expect(daysOverdue(due400, asOf)).toBe(400);

    // Must match ONLY -31 (`31+`), NEVER -1 (`1-7`) or -8 (`8-30`)
    expect(matchesReminderOffset(-1, due364, asOf)).toBe(false);
    expect(matchesReminderOffset(-8, due364, asOf)).toBe(false);
    expect(matchesReminderOffset(-31, due364, asOf)).toBe(true);

    const loanRules: ReminderRule[] = [
      { id: "r-li-1", name: "1-7 Gün", targetKind: "loan_installment", offsetDays: -1, channel: "telegram", minAmount: null, isActive: true },
      { id: "r-li-8", name: "8-30 Gün", targetKind: "loan_installment", offsetDays: -8, channel: "telegram", minAmount: null, isActive: true },
      { id: "r-li-31", name: "31+ Gün", targetKind: "loan_installment", offsetDays: -31, channel: "telegram", minAmount: null, isActive: true },
    ];
    const target364: ReminderTarget = {
      entityTable: "loan_installments",
      entityId: "11111111-1111-4111-8111-000000000364",
      name: "Vakıfbank Ticari Kredi (Taksit #1)",
      dueDate: due364,
      amount: 45_000,
      status: "late",
      owner: null,
      provider: "Vakıfbank",
      riskReasons: ["gecikmiş kredi taksiti"],
    };

    const pureEligible = eligibleMaturityDeliveries(loanRules, [target364], asOf);
    expect(pureEligible).toHaveLength(1);
    expect(pureEligible[0]!.ruleId).toBe("r-li-31");

    // End-to-end scheduleReminders check proving a 400-day overdue loan is NOT dropped by a 365-day lookback window
    const { pool, deliveries } = createStatefulReminderPool({
      rules: loanRules.map((r) => ({
        id: r.id,
        name: r.name,
        target_kind: r.targetKind,
        offset_days: r.offsetDays,
        channel: r.channel,
        min_amount: null,
        is_active: true,
      })),
      loanInstallments: [
        {
          id: "11111111-1111-4111-8111-000000000364",
          installment_no: 1,
          loan_name: "Vakıfbank Ticari Kredi",
          due_date: due364,
          amount: "45000.00",
          paid_amount: "0.00",
          status: "late",
          provider: "Vakıfbank",
        },
        {
          id: "11111111-1111-4111-8111-000000000400",
          installment_no: 2,
          loan_name: "Halkbank İşletme Kredisi",
          due_date: due400,
          amount: "60000.00",
          paid_amount: "0.00",
          status: "late",
          provider: "Halkbank",
        },
      ],
    });

    const sched = await scheduleReminders(pool, asOf);
    expect(sched.eligible).toBe(2);
    expect(sched.inserted).toBe(2);
    for (const d of deliveries.values()) {
      expect(d.reminder_id).toBe("r-li-31");
    }
  });

  it("Scenario 2 (I-006, Section 7): Day-30 vs Day-31 boundary & explicit '31+' internal workflow label without statutory 'Hukuki Eskalasyon'", () => {
    const asOf = "2026-11-18";
    const due30 = "2026-10-19"; // Exactly 30 days overdue
    const due31 = "2026-10-18"; // Exactly 31 days overdue

    expect(daysOverdue(due30, asOf)).toBe(30);
    expect(daysOverdue(due31, asOf)).toBe(31);

    const bucket30 = classifyEscalationBucket(due30, asOf);
    const bucket31 = classifyEscalationBucket(due31, asOf);

    expect(bucket30).toBe("overdue_8_30");
    expect(["overdue_30_plus", "overdue_31_plus"]).toContain(bucket31);

    expect(matchesReminderOffset(-8, due30, asOf)).toBe(true);
    expect(matchesReminderOffset(-31, due30, asOf)).toBe(false);
    expect(matchesReminderOffset(-8, due31, asOf)).toBe(false);
    expect(matchesReminderOffset(-31, due31, asOf)).toBe(true);

    const label31 = ESCALATION_BUCKET_LABELS[bucket31];
    expect(label31).toContain("31+");
    expect(label31).not.toContain("30+");
    expect(label31.toLocaleLowerCase("tr-TR")).not.toContain("hukuki eskalasyon");

    const rule31: ReminderRule = {
      id: "r-li-31",
      name: "31+ Gün Üst Eskalasyon",
      targetKind: "loan_installment",
      offsetDays: -31,
      channel: "telegram",
      minAmount: null,
      isActive: true,
    };
    const target31: ReminderTarget = {
      entityTable: "loan_installments",
      entityId: "22222222-2222-4222-8222-000000000031",
      name: "İş Bankası Kredi (Taksit #3)",
      dueDate: due31,
      amount: 75_000,
      status: "late",
      owner: null,
      provider: "İş Bankası",
      riskReasons: ["gecikmiş kredi taksiti"],
    };

    const msg31 = buildReminderMessage(rule31, target31, asOf);
    expect(msg31).toContain("31+");
    expect(msg31).not.toContain("30+");
    expect(msg31.toLocaleLowerCase("tr-TR")).not.toContain("hukuki eskalasyon");
  });

  it("Scenario 3 (I-007): Repeated cron execution produces stable deduplication identity and zero duplicate sends", async () => {
    const asOf = "2026-11-18";
    const keyA = computeNotificationIdempotencyKey([
      "telegram",
      "loan_installments",
      "33333333-3333-4333-8333-000000000001",
      "overdue_31_plus",
      "2026-10-01",
    ]);
    const keyB = computeNotificationIdempotencyKey([
      "telegram",
      "loan_installments",
      "33333333-3333-4333-8333-000000000001",
      "overdue_31_plus",
      "2026-10-01",
    ]);
    expect(keyA).toHaveLength(64);
    expect(keyA).toBe(keyB);

    const { pool } = createStatefulReminderPool({
      rules: [
        {
          id: "r-li-31",
          name: "31+ Gün Eskalasyon",
          target_kind: "loan_installment",
          offset_days: -31,
          channel: "telegram",
          min_amount: null,
          is_active: true,
        },
      ],
      loanInstallments: [
        {
          id: "33333333-3333-4333-8333-000000000001",
          installment_no: 5,
          loan_name: "Akbank Kredi",
          due_date: "2026-09-01",
          amount: "50000.00",
          paid_amount: "0.00",
          status: "late",
          provider: "Akbank",
        },
      ],
    });

    const transport = mockTransport();

    const s1 = await scheduleReminders(pool, asOf);
    const d1 = await dispatchPending(pool, transport, asOf);
    expect(s1.inserted).toBe(1);
    expect(d1.sent).toBe(1);
    expect(transport.sent).toHaveLength(1);

    // Second and third cron ticks on the same overdue event must emit ZERO duplicate sends
    const s2 = await scheduleReminders(pool, asOf);
    const d2 = await dispatchPending(pool, transport, asOf);
    const s3 = await scheduleReminders(pool, asOf);
    const d3 = await dispatchPending(pool, transport, asOf);

    expect(s2.inserted).toBe(0);
    expect(s2.duplicatesSkipped).toBe(1);
    expect(d2.sent).toBe(0);
    expect(s3.inserted).toBe(0);
    expect(d3.sent).toBe(0);
    expect(transport.sent).toHaveLength(1);
  });

  it("Scenario 4 (I-007): Concurrent cron processes running dispatchPending simultaneously call transport.send AT MOST ONCE", async () => {
    const asOf = "2026-11-18";
    const entityId = "44444444-4444-4444-8444-000000000004";
    const { pool } = createStatefulReminderPool({
      rules: [
        {
          id: "r-li-8",
          name: "8-30 Gün İhtar",
          target_kind: "loan_installment",
          offset_days: -8,
          channel: "telegram",
          min_amount: null,
          is_active: true,
        },
      ],
      loanInstallments: [
        {
          id: entityId,
          installment_no: 2,
          loan_name: "Yapı Kredi Taksit",
          due_date: "2026-11-05",
          amount: "85000.00",
          paid_amount: "0.00",
          status: "late",
          provider: "Yapı Kredi",
        },
      ],
      deliveries: [
        {
          id: "deliv-concurrent-1",
          reminder_id: "r-li-8",
          entity_table: "loan_installments",
          entity_id: entityId,
          scheduled_for: "2026-11-13",
          status: "pending",
          claim_token: null,
          payload: { message: "initial" },
          error: null,
        },
      ],
    });

    const sent: string[] = [];
    const concurrentTransport: Transport = {
      channel: "telegram",
      async send(message: string): Promise<DeliveryResult> {
        await new Promise((resolve) => setTimeout(resolve, 20));
        sent.push(message);
        return { ok: true };
      },
    };

    const settled = await Promise.allSettled([
      dispatchPending(pool, concurrentTransport, asOf),
      dispatchPending(pool, concurrentTransport, asOf),
    ]);

    expect(sent).toHaveLength(1);
    expect(settled.every((r) => r.status === "fulfilled")).toBe(true);
    const totalSent = settled.reduce(
      (sum, r) => sum + (r.status === "fulfilled" ? r.value.sent : 0),
      0,
    );
    expect(totalSent).toBe(1);
  });

  it("Scenario 5 (I-010, I-011): Missing payment amount (amount: null) stays null / 'TUTAR EKSİK' / 'tutar eksik', never coerced to 0, and increments missingCount", () => {
    const amounts = computeObligationAmounts({
      originalAmount: null,
      paidAmount: null,
      status: "unpaid",
    });
    expect(amounts.originalAmount).toBeNull();
    expect(amounts.allocatedPaidAmount).toBeNull();
    expect(amounts.outstandingAmount).toBeNull();

    expect(thresholdPasses(100_000, null)).toBe(true);

    const daily = buildDailyReport(
      {
        dueSoon: [
          {
            name: "MAS Elektrik Faturası",
            dueDate: "2026-11-18",
            amount: null,
            status: "unpaid",
            riskLevel: "medium",
            riskReasons: ["missing_amount"],
            currency: "TRY",
          },
          {
            name: "Ofis Kira Ödemesi",
            dueDate: "2026-11-19",
            amount: 45_000,
            status: "planned",
            riskLevel: "none",
            riskReasons: [],
            currency: "TRY",
          },
        ],
        overdue: [],
        maturities: [],
        criticalThreshold: 100_000,
      },
      "2026-11-18",
    );

    expect(daily.next7KnownTotal).toBe(45_000);
    expect(daily.next7MissingCount).toBe(1);
    expect(daily.bodyMd).toContain("TUTAR EKSİK");
    expect(daily.bodyMd).toContain("1 kalem tutar eksik");

    const ruleDueToday: ReminderRule = {
      id: "r-pay-0",
      name: "Bugün Ödeme",
      targetKind: "payment_instance",
      offsetDays: 0,
      channel: "telegram",
      minAmount: 50_000,
      isActive: true,
    };
    const missingTarget: ReminderTarget = {
      entityTable: "payment_instances",
      entityId: "pi-missing-1",
      name: "MAS Elektrik Faturası",
      dueDate: "2026-11-18",
      amount: null,
      status: "unpaid",
      owner: null,
      provider: "Enerjisa",
      riskReasons: ["missing_amount"],
    };

    const msg = buildReminderMessage(ruleDueToday, missingTarget, "2026-11-18");
    expect(msg).toContain("tutar eksik");
    expect(msg).not.toContain("tutar: 0 TL");

    const digest = buildReminderDigestHtml([missingTarget], "2026-11-18");
    expect(digest).toContain("tutar eksik: <b>1</b> kalem");
    expect(digest).toContain("tutar: tutar eksik");
  });

  it("Scenario 6 (I-012): Partially paid loan (original 30,000, paid 10,000, status 'partial') calculates overdue exposure as 20,000 and displays 30.000 TL, 10.000 TL, and 20.000 TL", () => {
    const computed = computeObligationAmounts({
      originalAmount: 30_000,
      paidAmount: 10_000,
      status: "partial",
    });
    expect(computed.originalAmount).toBe(30_000);
    expect(computed.allocatedPaidAmount).toBe(10_000);
    expect(computed.outstandingAmount).toBe(20_000);

    const partialReportFixture: ReportInstance & Record<string, unknown> = {
      name: "VAKIF KREDİ 2",
      dueDate: "2026-11-10",
      amount: 30_000,
      originalAmount: 30_000,
      paidAmount: 10_000,
      paid_amount: 10_000,
      allocatedPaidAmount: 10_000,
      outstandingAmount: 20_000,
      status: "partial",
      riskLevel: "high",
      riskReasons: ["overdue"],
      currency: "TRY",
    };

    const daily = buildDailyReport(
      {
        dueSoon: [],
        overdue: [partialReportFixture],
        maturities: [],
        criticalThreshold: 100_000,
      },
      "2026-11-18",
    );

    // Overdue exposure MUST be remaining 20,000 TRY — NEVER overstated as full 30,000 TRY
    expect(daily.overdueKnownTotal).toBe(20_000);
    expect(daily.bodyMd).toContain("30.000 TL");
    expect(daily.bodyMd).toContain("10.000 TL");
    expect(daily.bodyMd).toContain("20.000 TL");

    const overdueRule: ReminderRule = {
      id: "r-pay-8",
      name: "8-30 Gün İhtar",
      targetKind: "payment_instance",
      offsetDays: -8,
      channel: "telegram",
      minAmount: null,
      isActive: true,
    };
    const partialReminderFixture: ReminderTarget & Record<string, unknown> = {
      entityTable: "payment_instances",
      entityId: "0fbd2b5b-0a12-41b5-9bbe-23c8d079f03d",
      name: "VAKIF KREDİ 2",
      dueDate: "2026-11-10",
      amount: 30_000,
      originalAmount: 30_000,
      paidAmount: 10_000,
      paid_amount: 10_000,
      allocatedPaidAmount: 10_000,
      outstandingAmount: 20_000,
      status: "partial",
      owner: null,
      provider: "Vakıfbank",
      riskReasons: ["overdue"],
    };

    const reminderMsg = buildReminderMessage(overdueRule, partialReminderFixture, "2026-11-18");
    expect(reminderMsg).toContain("30.000 TL");
    expect(reminderMsg).toContain("10.000 TL");
    expect(reminderMsg).toContain("20.000 TL");
  });

  it("Scenario 7 (I-009): Financial reconciliation excludes 30,000 TRY cancelled row from active knownTotal (522,500 === 0 + 522,500) while disclosing cancelledKnownTotal = 30,000", async () => {
    const fixtureRows = [
      {
        amount: 522_500,
        paid_amount: 0,
        status: "unpaid",
        cancelled_at: null,
        direction: "outflow",
        currency: "TRY",
      },
      {
        amount: 30_000,
        paid_amount: 0,
        status: "cancelled",
        cancelled_at: "2026-11-05T10:00:00Z",
        direction: "outflow",
        currency: "TRY",
      },
    ];

    const mockPool = {
      async query(sql: string) {
        const normalized = sql.toLowerCase();
        expect(normalized).toContain("status <> 'cancelled'");
        expect(normalized).toContain("cancelled_at is null");
        expect(normalized).toContain("cancelled_known_total");

        const active = fixtureRows.filter(
          (r) => r.status !== "cancelled" && r.cancelled_at === null && r.direction === "outflow" && r.currency === "TRY",
        );
        const cancelled = fixtureRows.filter(
          (r) => r.status === "cancelled" && r.direction === "outflow" && r.currency === "TRY",
        );

        const knownTotal = active.reduce((s, r) => s + r.amount, 0);
        const paidKnown = active.reduce((s, r) => s + r.paid_amount, 0);
        const knownRemaining = active.reduce((s, r) => s + Math.max(r.amount - r.paid_amount, 0), 0);
        const cancelledKnownTotal = cancelled.reduce((s, r) => s + r.amount, 0);

        return {
          rows: [
            {
              known_total: knownTotal.toFixed(2),
              known_remaining: knownRemaining.toFixed(2),
              paid_known: paidKnown.toFixed(2),
              missing_count: 0,
              foreign_count: 0,
              total_count: active.length,
              cancelled_count: cancelled.length,
              cancelled_known_total: cancelledKnownTotal.toFixed(2),
              settlement_adjustment_try: "0.00",
              overpayment_adjustment_try: "0.00",
            },
          ],
          rowCount: 1,
        };
      },
    } as unknown as Pool;

    const summary = await monthSummary(mockPool, "2026-11-01");
    expect(summary.known_total).toBe(522_500);
    expect(summary.paid_known).toBe(0);
    expect(summary.known_remaining).toBe(522_500);
    expect(summary.known_total - (summary.paid_known + summary.known_remaining + summary.settlementAdjustmentTry)).toBe(0);
    expect(summary.cancelledCount).toBe(1);
    expect(summary.cancelledKnownTotal).toBe(30_000);

    const monthly = buildMonthlyReport({
      monthStart: "2026-11-01",
      knownTotal: summary.known_total,
      knownRemaining: summary.known_remaining,
      paidKnown: summary.paid_known,
      missingCount: summary.missing_count,
      totalCount: summary.total_count,
      cancelledCount: summary.cancelledCount,
      cancelledKnownTotal: summary.cancelledKnownTotal,
      settlementAdjustmentTry: summary.settlementAdjustmentTry,
      topPayments: [],
      providerDist: [],
      categoryDist: [],
      ownerDist: [],
      checksInMonth: [],
      installmentsInMonth: [],
      cashMonth: null,
      dataQualityIssues: [],
    });

    expect(monthly.bodyMd).toContain("522.500 TL");
    expect(monthly.bodyMd).toContain("30.000 TL");
  });

  it("Scenario 8 (I-001, I-004): DB outage alerts fail closed (true) AND runScheduledMaintenance does NOT stamp lastHourlySlot when scheduleReminders/dispatchPending fail", async () => {
    // (a) Fail-closed telemetry alert predicates on unmeasured/failed DB probes
    expect(runtimeIdentityAlert(null)).toBe(true);
    expect(runtimeIdentityAlert(undefined)).toBe(true);
    expect(runtimeIdentityAlert("postgres")).toBe(true);
    expect(runtimeIdentityAlert("mas_radar_app")).toBe(false);
    expect(jobsStuckAlert("?")).toBe(true);
    expect(reconciliationAlert("?")).toBe(true);

    // (b) Scheduler batch failure safety: DB outage during hourly reminder scheduling/dispatch must NOT stamp lastHourlySlot
    const dir = createTempDir("mas-scen8-worker-");
    const statePath = path.join(dir, "background-worker-state.json");
    await writeWorkerScheduleStateAtomic(statePath, {
      lastHourlySlot: "2026-11-18T13",
      lastDailyDate: "2026-11-18", // Already completed daily; isolate hourly slot 14
      updatedAt: "2026-11-18T10:00:00.000Z",
    });

    const dbOutageError = Object.assign(
      new Error("connect ECONNREFUSED 127.0.0.1:5432"),
      { code: "ECONNREFUSED" },
    );

    const outagePool = {
      async query(sql: string) {
        if (sql.toLowerCase().includes("pg_try_advisory")) {
          return { rows: [{ pg_try_advisory_lock: true, acquired: true }], rowCount: 1 };
        }
        if (sql.toLowerCase().includes("pg_advisory_unlock")) {
          return { rows: [{ pg_advisory_unlock: true }], rowCount: 1 };
        }
        throw dbOutageError;
      },
      async connect() {
        throw dbOutageError;
      },
    } as unknown as Pool;

    await runScheduledMaintenance({
      pool: outagePool,
      systemActorId: "00000000-0000-4000-8000-000000000001",
      statePath,
      todayISO: "2026-11-18",
      hourSlot: "2026-11-18T14",
      enableTcmbSync: false,
      enableMorningBriefingDispatch: false,
    }).catch(() => undefined);

    const savedState = await readWorkerScheduleState(statePath);
    expect(savedState.lastHourlySlot).not.toBe("2026-11-18T14");
    expect(savedState.lastHourlySlot).toBe("2026-11-18T13");
  });

  it(
    "Scenario 9 (I-003): Missing off-device directory surfaces ENOENT, classifyOffDeviceTarget rejects source===target, and planPrune NEVER deletes last remaining verified .dump",
    () => {
      // (a) evaluateOffDeviceRunLog with exitCode: 3 and ENOENT
      const runStatus = evaluateOffDeviceRunLog(
        JSON.stringify({
          ok: false,
          exitCode: 3,
          stage: "offdevice",
          offDeviceOk: false,
          offDeviceNote: "ENOENT: no such file or directory, mkdir 'D:\\MAS-Backups\\mas_radar_dev'",
        }),
      );
      expect(runStatus.alert).toBe(true);
      expect(runStatus.note).toContain("ENOENT");
      expect(runStatus.note).toContain("D:\\MAS-Backups\\mas_radar_dev");

      // (b) classifyOffDeviceTarget MUST reject when targetDir resolves to sourceDir (both local and UNC)
      const sameLocalDir = createTempDir("mas-scen9-same-backup-");
      const localSameClass = classifyOffDeviceTarget(sameLocalDir, sameLocalDir);
      expect(localSameClass.offDeviceSatisfied).toBe(false);
      expect(localSameClass.sameVolumeAsSource).toBe(true);

      const sameUncDir = "\\\\nas-backup\\mas_radar_dev\\daily";
      const uncSameClass = classifyOffDeviceTarget(sameUncDir, sameUncDir);
      expect(uncSameClass.offDeviceSatisfied).toBe(false);

      // (c) planPrune MUST NEVER delete the last remaining verified .dump even when its age exceeds retention
      const now = new Date("2026-11-18T12:00:00.000Z");
      const lastVerifiedOldDump: DumpEntry = {
        name: "daily-2025-10-01T02-00-00-000Z.dump",
        fullPath: "/backups/daily-2025-10-01T02-00-00-000Z.dump",
        bytes: 4_200_000,
        timestamp: new Date("2025-10-01T02:00:00.000Z"), // 413 days old
        timestampSource: "filename",
        label: "daily",
        retentionClass: "rolling",
        immutableReason: null,
        sidecars: [
          "/backups/daily-2025-10-01T02-00-00-000Z.dump.receipt.json",
          "/backups/daily-2025-10-01T02-00-00-000Z.dump.sha256",
        ],
      };
      const newerUnverifiedDump: DumpEntry = {
        name: "daily-2026-11-15T02-00-00-000Z.dump",
        fullPath: "/backups/daily-2026-11-15T02-00-00-000Z.dump",
        bytes: 4_300_000,
        timestamp: new Date("2026-11-15T02:00:00.000Z"), // 3 days old, NO verification sidecars
        timestampSource: "filename",
        label: "daily",
        retentionClass: "rolling",
        immutableReason: null,
        sidecars: [],
      };

      const tightPolicy: RetentionPolicy = { daily: 1, weekly: 1, monthly: 1, minAgeHours: 24 };
      const plan = planPrune([newerUnverifiedDump, lastVerifiedOldDump], tightPolicy, now);
      const verifiedDecision = plan.decisions.find(
        (d) => d.entry.fullPath === lastVerifiedOldDump.fullPath,
      );
      expect(verifiedDecision).toBeDefined();
      expect(verifiedDecision!.keep).toBe(true);
    },
    SUBPROCESS_TEST_TIMEOUT_MS,
  );

  it("Scenario 10 (I-002): checkSchemaParity detects version/count drift (aligned: false) and ledgerAlert('115/0115', '119/0119') === true", async () => {
    expect(ledgerAlert("115/0115", "119/0119")).toBe(true);
    expect(ledgerAlert("?", "119/0119")).toBe(true);
    expect(ledgerAlert("119/0119", "?")).toBe(true);
    expect(ledgerAlert("?", "?")).toBe(true);
    expect(ledgerAlert("123/0123", "123/0123")).toBe(false);

    const manifest = readExpectedSchemaManifest();
    expect(manifest.expectedCount).toBeGreaterThan(100);

    const driftedPool = {
      async query() {
        return {
          rows: [
            {
              migration_count: 115,
              latest_version: "0115",
              checksum_digest: "deadbeef0115",
              last_applied_at: "2026-11-01T00:00:00Z",
            },
          ],
          rowCount: 1,
        };
      },
    } as unknown as Pool;

    const parity = await checkSchemaParity(driftedPool);
    expect(parity.aligned).toBe(false);
    expect(parity.actualCount).toBe(115);
    expect(parity.actualLatestVersion).toBe("0115");

    await expect(assertSchemaParity(driftedPool)).rejects.toThrow(/115\/0115/);
  });

  it("Scenario 11 (I-008): UTC 2026-11-17T21:30:00Z (= 2026-11-18 00:30 Europe/Istanbul) resolves to '2026-11-18', classifying 2026-11-18 as due today and 2026-11-21 as 3 days ahead", () => {
    const utcCrossMidnight = new Date("2026-11-17T21:30:00Z");
    expect(utcCrossMidnight.toISOString().slice(0, 10)).toBe("2026-11-17");

    const trToday = istanbulDateISO(utcCrossMidnight);
    expect(trToday).toBe("2026-11-18");

    // 2026-11-18 obligation is due TODAY (offsetDays = 0), NOT tomorrow (offsetDays = 1)
    expect(matchesReminderOffset(0, "2026-11-18", trToday)).toBe(true);
    expect(matchesReminderOffset(1, "2026-11-18", trToday)).toBe(false);

    // 2026-11-21 obligation is 3 days ahead (offsetDays = 3)
    expect(scheduledForDate("2026-11-21", 3)).toBe("2026-11-18");
    expect(matchesReminderOffset(3, "2026-11-21", trToday)).toBe(true);

    const daily = buildDailyReport(
      {
        dueSoon: [
          {
            name: "SGK Prim Ödemesi",
            dueDate: "2026-11-18",
            amount: 125_000,
            status: "planned",
            riskLevel: "none",
            riskReasons: [],
            currency: "TRY",
          },
        ],
        overdue: [],
        maturities: [],
        criticalThreshold: 500_000,
      },
      trToday,
    );
    expect(daily.dueToday).toHaveLength(1);
    expect(daily.dueTomorrow).toHaveLength(0);
  });

  it("Scenario 12 (I-011): Multiple Çağdaş records (100,000 TRY, 2026-08-31) are NOT auto-merged, while 'resolved' duplicate_check reviews are excluded until explicitly 'accepted'", async () => {
    const cell = (v: string | number): CellVal => ({ v, t: typeof v === "number" ? "n" : "s" });
    const sheetRows: SheetRow[] = [
      { rowIndex: 1, cells: { A: cell("TARİH"), B: cell("KİME"), C: cell("TUTAR") } },
      { rowIndex: 2, cells: { A: cell("2026-08-31"), B: cell("Çağdaş"), C: cell(-100_000) } },
      { rowIndex: 3, cells: { A: cell("2026-08-31"), B: cell("Çağdaş"), C: cell(-100_000) } },
      { rowIndex: 4, cells: { A: cell("2026-08-31"), B: cell("Çağdaş"), C: cell(-100_000) } },
    ];

    const extracted = extractChecks(sheetRows);
    expect(extracted.candidates).toHaveLength(3);
    expect(extracted.candidates.every((c) => c.flags.includes("duplicate_check"))).toBe(true);

    function createChecksMapperPool(reviewStatusForDuplicates: "resolved" | "accepted") {
      const insertedChecks: Array<{ rowId: string; amount: number | null }> = [];
      const reviews = new Map<string, { issue_type: string; status: string }>([
        ["ir-3", { issue_type: "duplicate_check", status: reviewStatusForDuplicates }],
        ["ir-4", { issue_type: "duplicate_check", status: reviewStatusForDuplicates }],
      ]);

      const client = {
        async query(sql: string, params: unknown[] = []) {
          const norm = sql.replace(/\s+/g, " ").trim().toLowerCase();
          if (norm === "begin" || norm === "commit" || norm === "rollback") {
            return { rows: [], rowCount: 0 };
          }
          if (norm.includes("from public.source_sheets")) {
            return { rows: [{ id: "sheet-cekler", sheet_name: "ÇEKLER" }], rowCount: 1 };
          }
          if (norm.includes("from public.import_rows ir")) {
            expect(norm).toContain("duplicate_check");
            const acceptsResolvedBug = !norm.includes("'resolved'");
            const dbRows = sheetRows.map((sr) => {
              const id = `ir-${sr.rowIndex}`;
              const rev = reviews.get(id);
              const blocked =
                rev != null &&
                (rev.status === "open" ||
                  rev.status === "rejected" ||
                  (!acceptsResolvedBug && rev.issue_type === "duplicate_check" && rev.status === "resolved"));
              const resolvedDuplicate =
                rev != null && rev.issue_type === "duplicate_check" && rev.status === "resolved";
              return {
                id,
                row_index: sr.rowIndex,
                row_json: sr.cells,
                mapping_status: "pending",
                blocked,
                resolved_duplicate: resolvedDuplicate,
              };
            });
            return { rows: dbRows, rowCount: dbRows.length };
          }
          if (norm.includes("from public.parties")) {
            return { rows: [{ id: "party-cagdas" }], rowCount: 1 };
          }
          if (norm.startsWith("insert into public.checks")) {
            const checkId = `chk-${insertedChecks.length + 1}`;
            insertedChecks.push({ rowId: String(params[2]), amount: Number(params[9]) });
            return { rows: [{ id: checkId }], rowCount: 1 };
          }
          if (
            norm.startsWith("insert into public.check_events") ||
            norm.startsWith("update public.import_rows") ||
            norm.startsWith("insert into public.audit_logs")
          ) {
            return { rows: [{ id: "ok" }], rowCount: 1 };
          }
          throw new Error(`Unexpected SQL in mapAcceptedChecks test: ${sql}`);
        },
        release() {},
      };

      return {
        pool: { async connect() { return client; } } as unknown as Pool,
        insertedChecks,
      };
    }

    // Sub-case A: 'resolved' (not explicitly 'accepted') duplicate reviews MUST be excluded
    const resolvedRun = createChecksMapperPool("resolved");
    const resResolved = await mapAcceptedChecks(resolvedRun.pool, "wb-1", "actor-1");
    expect(resResolved.created).toBe(1);
    expect(resResolved.excluded).toHaveLength(2);
    expect(resolvedRun.insertedChecks).toHaveLength(1);

    // Sub-case B: Explicitly 'accepted' reviews import ALL 3 distinct checks without auto-merging
    const acceptedRun = createChecksMapperPool("accepted");
    const resAccepted = await mapAcceptedChecks(acceptedRun.pool, "wb-1", "actor-1");
    expect(resAccepted.created).toBe(3);
    expect(acceptedRun.insertedChecks).toHaveLength(3);
  });

  it("Scenario 13 (I-005, I-013): Incident lifecycle transitions OPEN+'?' -> UNKNOWN, emits initial [OPEN][P2], honors SUPPRESSED, and attaches resolutionEvidence on OPEN -> RESOLVED", async () => {
    const dir = createTempDir("mas-scen13-incidents-");
    const stateFilePath = path.join(dir, "ops-incident-state.json");

    // (a) OPEN receiving value '?' MUST transition to UNKNOWN, NEVER RESOLVED
    const t0 = new Date("2026-11-18T08:00:00.000Z");
    await evaluateAndRecordOpsIncidents(
      null,
      [{ signal: "jobs_stuck", severity: "P1", value: "3", threshold: "0" }],
      { now: t0, stateFilePath },
    );

    const t1 = new Date("2026-11-18T08:05:00.000Z");
    const unknownEval = await evaluateAndRecordOpsIncidents(
      null,
      [{ signal: "jobs_stuck", severity: "P1", value: "?", note: "DB query failed" }],
      { now: t1, stateFilePath },
    );
    const jobsRec = unknownEval.records.find((r) => r.signalKey === "jobs_stuck");
    expect(jobsRec?.state).toBe("UNKNOWN");
    expect(jobsRec?.state).not.toBe("RESOLVED");

    // (b) P2 signal (`latest_import_age_days = "124"`) transitioning OK -> OPEN MUST emit initial [OPEN][P2]
    const p2StateFile = path.join(dir, "ops-p2-state.json");
    const p2OpenEval = await evaluateAndRecordOpsIncidents(
      null,
      [
        {
          signal: "latest_import_age_days",
          severity: "P2",
          value: "124",
          threshold: "<= 45 gün",
          note: "TEMİZ.xlsx 124 gün önce içe aktarıldı",
        },
      ],
      { now: t0, stateFilePath: p2StateFile },
    );
    const p2Notif = p2OpenEval.notifications.find((n) => n.signalKey === "latest_import_age_days");
    expect(p2Notif).toBeDefined();
    expect(p2Notif!.formattedLine).toContain("[OPEN][P2]");

    // (c) SUPPRESSED state suppresses notifications while active, until unsuppressed
    const supStateFile = path.join(dir, "ops-suppressed-state.json");
    writeFileSync(
      supStateFile,
      JSON.stringify(
        {
          updatedAt: t0.toISOString(),
          incidents: {
            offdevice_backup_status: {
              signalKey: "offdevice_backup_status",
              severity: "P1",
              state: "SUPPRESSED",
              lastValue: "TEK KOPYA (exit 3)",
              stateFingerprint: "sup-fp-1",
              note: "harici disk bakımı",
              openedAt: t0.toISOString(),
              acknowledgedAt: null,
              resolvedAt: null,
              suppressedUntil: "2026-11-19T08:00:00.000Z",
              lastNotifiedAt: null,
              lastNotifiedState: null,
              occurrenceCount: 1,
              updatedAt: t0.toISOString(),
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const whileSuppressed = await evaluateAndRecordOpsIncidents(
      null,
      [{ signal: "offdevice_backup_status", severity: "P1", value: "TEK KOPYA (exit 3)" }],
      { now: new Date("2026-11-18T12:00:00.000Z"), stateFilePath: supStateFile },
    );
    const supRec = whileSuppressed.records.find((r) => r.signalKey === "offdevice_backup_status");
    expect(supRec?.state).toBe("SUPPRESSED");
    expect(whileSuppressed.notifications).toHaveLength(0);

    // Unsuppress (clear suppression window) and verify notifications resume
    writeFileSync(
      supStateFile,
      JSON.stringify(
        {
          updatedAt: "2026-11-18T13:00:00.000Z",
          incidents: {
            offdevice_backup_status: {
              ...supRec,
              state: "OK",
              suppressedUntil: null,
            },
          },
        },
        null,
        2,
      ),
      "utf8",
    );
    const afterUnsuppressed = await evaluateAndRecordOpsIncidents(
      null,
      [{ signal: "offdevice_backup_status", severity: "P1", value: "TEK KOPYA (exit 3)" }],
      { now: new Date("2026-11-18T13:05:00.000Z"), stateFilePath: supStateFile },
    );
    expect(afterUnsuppressed.notifications).toHaveLength(1);
    expect(afterUnsuppressed.notifications[0]!.formattedLine).toContain("[OPEN][P1]");

    // (d) OPEN -> RESOLVED attaches structured resolutionEvidence (verifiedAtISO, measuredValue, verifiedByCheck)
    const resolveStateFile = path.join(dir, "ops-resolve-state.json");
    await evaluateAndRecordOpsIncidents(
      null,
      [{ signal: "reconciliation_mismatch", severity: "P0", value: "2", threshold: "0" }],
      { now: t0, stateFilePath: resolveStateFile },
    );
    const tResolved = new Date("2026-11-18T09:30:00.000Z");
    const resolvedEval = await evaluateAndRecordOpsIncidents(null, [], {
      now: tResolved,
      stateFilePath: resolveStateFile,
    });
    const resolvedRec = resolvedEval.records.find(
      (r) => r.signalKey === "reconciliation_mismatch",
    ) as (Record<string, unknown> & { state?: string }) | undefined;
    const resolvedNotif = resolvedEval.notifications.find(
      (n) => n.signalKey === "reconciliation_mismatch",
    ) as Record<string, unknown> | undefined;

    expect(resolvedRec?.state).toBe("RESOLVED");
    const evidence = (resolvedRec?.resolutionEvidence ?? resolvedNotif?.resolutionEvidence) as
      | Record<string, unknown>
      | null
      | undefined;
    expect(evidence).toBeDefined();
    expect(evidence).not.toBeNull();
    expect(typeof evidence!.verifiedAtISO).toBe("string");
    expect(typeof evidence!.measuredValue).toBe("string");
    expect(typeof evidence!.verifiedByCheck).toBe("string");
  });

  it("Scenario 14 (I-015): Unauthorized Telegram chatId, unapproved high-value outflow settlement, and self-approval with >= 2 approvers are rejected", async () => {
    // 1) Unauthorized Telegram chatId rejected with zero HTTP calls
    let httpCallCount = 0;
    const guardFetch: typeof fetch = (async () => {
      httpCallCount += 1;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;

    const tgBlocked = await sendTelegramChatMessage("-1009999999", "Gizli CFO Özeti", {
      token: "123456:ABCDEF_TEST_TOKEN",
      allowedChatIds: ["-1001111111"],
      fetchImpl: guardFetch,
    });
    expect(tgBlocked.ok).toBe(false);
    expect(httpCallCount).toBe(0);

    // 2) Unapproved high-value outflow settlement (120,000 TRY >= 100,000 TRY rule) rejected with FORBIDDEN
    let paidStatusUpdated = false;
    const instanceId = "33ad79cf-0000-4000-8000-000000000014";
    const settlementClient = {
      async query(sql: string) {
        const norm = sql.replace(/\s+/g, " ").trim().toLowerCase();
        if (
          norm === "begin" ||
          norm === "commit" ||
          norm === "rollback" ||
          norm.startsWith("savepoint ") ||
          norm.startsWith("release savepoint ") ||
          norm.startsWith("rollback to savepoint ")
        ) {
          return { rows: [], rowCount: 0 };
        }
        if (norm.includes("from public.payment_instances where id=$1 for update")) {
          return {
            rows: [
              {
                id: instanceId,
                status: "unpaid",
                amount: "120000.00",
                paid_amount: null,
                paid_at: null,
                direction: "outflow",
                currency: "TRY",
                approval_status: "not_required",
                due_date: "2026-11-18",
              },
            ],
            rowCount: 1,
          };
        }
        if (norm.includes("from public.approval_rules")) {
          return {
            rows: [
              {
                code: "high_value_outflow_100k",
                description: "100.000 TL ve üzeri çıkış ödemeleri 4-göz onayına tabidir",
                trigger_kind: "amount_threshold",
                threshold_amount: "100000.00",
                currency: "TRY",
                applies_to: ["payment_instances"],
                is_active: true,
              },
            ],
            rowCount: 1,
          };
        }
        if (norm.includes("from public.approvals")) {
          return { rows: [], rowCount: 0 };
        }
        if (norm.startsWith("insert into public.approvals")) {
          return { rows: [{ id: "aaaa0000-0000-4000-8000-000000000001" }], rowCount: 1 };
        }
        if (
          norm.startsWith("insert into public.approval_steps") ||
          norm.startsWith("insert into public.audit_logs") ||
          norm.includes("set approval_status = 'pending_approval'")
        ) {
          return { rows: [{ id: "ok" }], rowCount: 1 };
        }
        if (norm.includes("set status='paid'")) {
          paidStatusUpdated = true;
          return { rows: [], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
      release() {},
    };
    const settlementPool = {
      async connect() {
        return settlementClient;
      },
    } as unknown as Pool;

    await expect(
      markInstancePaid(settlementPool, instanceId, 120_000, "00000000-0000-4000-8000-000000000099"),
    ).rejects.toThrow(DomainError);
    expect(paidStatusUpdated).toBe(false);

    // 3) Self-approval when >= 2 active approvers exist is unconditionally rejected (4-eyes policy)
    const twoApproverClient = {
      async query(sql: string) {
        if (sql.toLowerCase().includes("count(*)::int as cnt")) {
          return { rows: [{ cnt: 2 }], rowCount: 1 };
        }
        return { rows: [{ role: "admin" }], rowCount: 1 };
      },
    } as unknown as Pick<PoolClient, "query">;

    await expect(
      evaluateSelfApprovalEligibility(
        twoApproverClient,
        "00000000-0000-4000-8000-000000000099",
        "Acil tedarikçi ödemesi gerekçesi",
      ),
    ).rejects.toThrow(DomainError);
  });

  it("Scenario 15 (I-007, I-014): Clean Telegram HTML escaping, HTTP 429 retry_after extraction, and post-request timeout -> uncertainOutcome / 'delivery_uncertain'", async () => {
    // (a) Clean escaping without &#91;, double &amp;amp;, or missing\_amount across HTML pipeline
    const escapedRaw = escapeTelegramHtml("[P1] Garanti & Akbank <Kredi>");
    expect(escapedRaw).toBe("[P1] Garanti &amp; Akbank &lt;Kredi&gt;");
    expect(escapedRaw).not.toContain("&#91;");
    expect(escapedRaw).not.toContain("&amp;amp;");

    const digestHtml = buildReminderDigestHtml(
      [
        {
          name: "[P1] Garanti & Akbank",
          dueDate: "2026-11-18",
          amount: null,
          status: "unpaid",
          riskReasons: ["missing_amount"],
        },
      ],
      "2026-11-18",
    );
    const outboundHtmlPayloads: string[] = [];
    await sendTelegramChatMessage("-1001111111", digestHtml, {
      token: "123456:ABCDEF_TEST_TOKEN",
      allowedChatIds: ["-1001111111"],
      parseMode: "HTML",
      fetchImpl: (async (_url, init) => {
        const parsed = JSON.parse(String(init?.body)) as { text: string };
        outboundHtmlPayloads.push(parsed.text);
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }) as typeof fetch,
    });
    expect(outboundHtmlPayloads).toHaveLength(1);
    expect(outboundHtmlPayloads[0]).toContain("[P1] Garanti &amp; Akbank");
    expect(outboundHtmlPayloads[0]).not.toContain("&#91;");
    expect(outboundHtmlPayloads[0]).not.toContain("&amp;amp;");
    expect(outboundHtmlPayloads[0]).not.toContain("missing\\_amount");

    const msg = buildReminderMessage(
      {
        id: "r-0",
        name: "Bugün ödeme",
        targetKind: "payment_instance",
        offsetDays: 0,
        channel: "telegram",
        minAmount: null,
        isActive: true,
      },
      {
        entityTable: "payment_instances",
        entityId: "pi-esc-1",
        name: "[P1] Garanti & Akbank",
        dueDate: "2026-11-18",
        amount: null,
        status: "unpaid",
        owner: null,
        provider: null,
        riskReasons: ["missing_amount"],
      },
      "2026-11-18",
    );
    expect(msg).toContain("[P1]");
    expect(msg).not.toContain("&#91;");
    expect(msg).not.toContain("missing\\_amount");
    expect(msg).not.toContain("missing_amount");
    expect(msg).toContain("Tutar eksik");

    // (b) HTTP 429 with parameters.retry_after = 17 surfaces retryAfterSeconds: 17
    const fetch429: typeof fetch = (async () =>
      new Response(
        JSON.stringify({
          ok: false,
          error_code: 429,
          description: "Too Many Requests: retry after 17",
          parameters: { retry_after: 17 },
        }),
        { status: 429, headers: { "content-type": "application/json" } },
      )) as typeof fetch;

    const rateLimited = (await sendTelegramChatMessage("-1001111111", "Test 429", {
      token: "123456:ABCDEF_TEST_TOKEN",
      allowedChatIds: ["-1001111111"],
      fetchImpl: fetch429,
    })) as DeliveryResult & { retryAfterSeconds?: number | null };

    expect(rateLimited.ok).toBe(false);
    expect(rateLimited.retryAfterSeconds).toBe(17);

    // (c) Post-request timeout (TimeoutError) & multi-chunk partial failure -> uncertainOutcome: true & 'delivery_uncertain' in outbox
    const timeoutFetch: typeof fetch = (async () => {
      throw Object.assign(new Error("The operation was aborted due to timeout"), {
        name: "TimeoutError",
      });
    }) as typeof fetch;

    const timeoutRes = (await sendTelegramChatMessage("-1001111111", "Kritik Uyarı", {
      token: "123456:ABCDEF_TEST_TOKEN",
      allowedChatIds: ["-1001111111"],
      fetchImpl: timeoutFetch,
    })) as DeliveryResult & { uncertainOutcome?: boolean };

    expect(timeoutRes.ok).toBe(false);
    expect(timeoutRes.uncertainOutcome).toBe(true);

    let chunkAttempt = 0;
    const partialChunkFetch: typeof fetch = (async () => {
      chunkAttempt += 1;
      if (chunkAttempt === 1) {
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return new Response("Bad Gateway", { status: 502 });
    }) as typeof fetch;

    const partialRes = (await sendTelegramChatMessage(
      "-1001111111",
      `${"A".repeat(80)}\n${"B".repeat(80)}`,
      {
        token: "123456:ABCDEF_TEST_TOKEN",
        allowedChatIds: ["-1001111111"],
        maxLen: 100,
        fetchImpl: partialChunkFetch,
      },
    )) as DeliveryResult & { uncertainOutcome?: boolean };

    expect(partialRes.ok).toBe(false);
    expect(partialRes.uncertainOutcome).toBe(true);

    // Verify claimAndDispatchOutbox transitions the row to 'delivery_uncertain' instead of 'failed_retryable'
    const { pool: outboxPool, outboxByKey } = createStatefulReminderPool({
      rules: [],
      loanInstallments: [],
    });
    outboxByKey.set("idem-uncertain-1", {
      id: "outbox-row-uncertain-1",
      stream: "ops_incident",
      channel: "telegram",
      recipient_target: "-1001111111",
      idempotency_key: "idem-uncertain-1",
      subject: null,
      body_text: "Kritik Uyarı",
      body_format: "html",
      metadata: {},
      status: "pending",
      claim_token: null,
      attempt_count: 0,
      max_attempts: 5,
      last_error: null,
    });

    await claimAndDispatchOutbox(outboxPool, {
      transportResolver: () => ({
        channel: "telegram",
        send: () =>
          sendTelegramChatMessage("-1001111111", "Kritik Uyarı", {
            token: "123456:ABCDEF_TEST_TOKEN",
            allowedChatIds: ["-1001111111"],
            fetchImpl: timeoutFetch,
          }),
      }),
    });

    expect(outboxByKey.get("idem-uncertain-1")?.status).toBe("delivery_uncertain");
  });

  it("Scenario 16: Core computeObligationAmounts, splitTelegramHtmlMessage (<= 3900 balanced HTML), and redactSecrets preserve existing functionality", () => {
    // 1) computeObligationAmounts invariants
    expect(computeObligationAmounts({ originalAmount: 50_000, paidAmount: 0, status: "unpaid" })).toEqual({
      originalAmount: 50_000,
      allocatedPaidAmount: 0,
      outstandingAmount: 50_000,
      overpaymentAmount: 0,
    });
    expect(computeObligationAmounts({ originalAmount: 10_000, paidAmount: 10_750, status: "paid" })).toEqual({
      originalAmount: 10_000,
      allocatedPaidAmount: 10_750,
      outstandingAmount: 0,
      overpaymentAmount: 750,
    });
    expect(computeObligationAmounts({ originalAmount: 30_000, paidAmount: 0, status: "cancelled" })).toEqual({
      originalAmount: 30_000,
      allocatedPaidAmount: 0,
      outstandingAmount: 0,
      overpaymentAmount: 0,
    });

    // 2) splitTelegramHtmlMessage <= 3900 chars with balanced HTML tags
    const longBody = Array.from(
      { length: 120 },
      (_, idx) => `<b>Kalem #${idx + 1}:</b> <i>Garanti &amp; Akbank Taksit Ödemesi — 25.000 TL</i>`,
    ).join("\n");
    const htmlMessage = `<b><i>${longBody}</i></b>`;
    expect(htmlMessage.length).toBeGreaterThan(TELEGRAM_HTML_SAFE_MAX_CHARS * 2);

    const chunks = splitTelegramHtmlMessage(htmlMessage);
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(TELEGRAM_HTML_SAFE_MAX_CHARS);
      const bOpens = (chunk.match(/<b>/g) ?? []).length;
      const bCloses = (chunk.match(/<\/b>/g) ?? []).length;
      const iOpens = (chunk.match(/<i>/g) ?? []).length;
      const iCloses = (chunk.match(/<\/i>/g) ?? []).length;
      expect(bOpens).toBe(bCloses);
      expect(iOpens).toBe(iCloses);
    }

    // 3) redactSecrets + looksLikeSecret zero-leak guarantee
    const rawLog =
      "DB hata postgres://mas_radar_app:Sup3rS3cret!@127.0.0.1:5432/mas_radar_dev " +
      "ve https://api.telegram.org/bot987654321:AAF-xyzSecretToken_123/sendMessage " +
      "Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9 hedef=-10099887766";
    const redacted = redactSecrets(rawLog, ["-10099887766"]);
    expect(redacted).not.toContain("Sup3rS3cret!");
    expect(redacted).not.toContain("AAF-xyzSecretToken_123");
    expect(redacted).not.toContain("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9");
    expect(redacted).not.toContain("-10099887766");
    expect(looksLikeSecret(redacted, ["-10099887766"])).toEqual([]);
  });
});
