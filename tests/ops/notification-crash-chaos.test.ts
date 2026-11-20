import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { describe, expect, it } from "vitest";

import { addDaysISO } from "@/lib/financing/rules";
import { dispatchPending, scheduleReminders } from "@/lib/reminders/engine";
import { claimAndDispatchOutbox } from "@/lib/reminders/outbox";
import {
  buildReminderDigestHtml,
  buildReminderMessage,
  type ReminderDigestItem,
  type ReminderRule,
  type ReminderTarget,
} from "@/lib/reminders/rules";
import {
  TELEGRAM_HTML_SAFE_MAX_CHARS,
  escapeTelegramHtml,
  redactBotToken,
  scrubSensitiveTelegramText,
  sendTelegramChatMessage,
  splitTelegramHtmlMessage,
  type Transport,
} from "@/lib/reminders/transport";

/* ── Deterministic Fake Clock & Stateful PostgreSQL Simulator (0 Real Sends / 0 Prod DB Writes) ── */

class DeterministicClock {
  private currentMs: number;

  constructor(initialISO = "2026-11-18T09:00:00.000Z") {
    this.currentMs = Date.parse(initialISO);
  }

  nowMs(): number {
    return this.currentMs;
  }

  nowDate(): Date {
    return new Date(this.currentMs);
  }

  nowISO(): string {
    return new Date(this.currentMs).toISOString();
  }

  advanceMinutes(minutes: number): void {
    this.currentMs += minutes * 60 * 1_000;
  }

  advanceSeconds(seconds: number): void {
    this.currentMs += seconds * 1_000;
  }
}

interface SimRuleRow {
  id: string;
  name: string;
  target_kind: string;
  offset_days: number;
  channel: "telegram" | "email";
  min_amount: string | null;
  is_active: boolean;
}

interface SimPaymentRow {
  id: string;
  name: string;
  due_date: string;
  amount: string | null;
  paid_amount: string | null;
  legal_entity_id?: string | null;
  status: string;
  cancelled_at?: string | null;
  owner?: string | null;
  provider?: string | null;
  risk_reasons?: string[];
}

interface SimDeliveryRow {
  id: string;
  reminder_id: string;
  entity_table: string;
  entity_id: string;
  scheduled_for: string;
  status: string;
  claim_token: string | null;
  claimed_at: Date | null;
  sent_at: Date | null;
  payload: Record<string, unknown> | null;
  error: string | null;
}

interface SimOutboxRow {
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
  claimed_at: Date | null;
  uncertain_at: Date | null;
  sent_at: Date | null;
  attempt_count: number;
  max_attempts: number;
  next_retry_at_ms: number;
  provider_message_ids: string[];
  last_error: string | null;
  legal_entity_id: string | null;
}

interface SimOpsIncidentRow {
  signal_key: string;
  severity: string;
  state: string;
  last_value: string;
  note: string;
}

function createChaosReminderDb(seed: {
  clock: DeterministicClock;
  rules?: SimRuleRow[];
  payments?: SimPaymentRow[];
  deliveries?: SimDeliveryRow[];
}) {
  const { clock } = seed;
  const rules = new Map<string, SimRuleRow>((seed.rules ?? []).map((r) => [r.id, { ...r }]));
  const payments = new Map<string, SimPaymentRow>(
    (seed.payments ?? []).map((p) => [p.id, { ...p }]),
  );
  const deliveries = new Map<string, SimDeliveryRow>(
    (seed.deliveries ?? []).map((d) => [d.id, { ...d }]),
  );
  const outboxByKey = new Map<string, SimOutboxRow>();
  const opsIncidents = new Map<string, SimOpsIncidentRow>();
  const lockedDeliveryIds = new Set<string>();
  const lockedOutboxIds = new Set<string>();

  let faultHook: ((sqlNormalized: string, rawSql: string, params: unknown[]) => void) | null = null;

  function setFaultHook(
    fn: ((sqlNormalized: string, rawSql: string, params: unknown[]) => void) | null,
  ) {
    faultHook = fn;
  }

  function executeSql(
    rawSql: string,
    params: unknown[] = [],
    heldDelivery?: Set<string>,
    heldOutbox?: Set<string>,
  ): { rows: unknown[]; rowCount: number } {
    const sql = rawSql.replace(/\s+/g, " ").trim().toLowerCase();

    if (faultHook) {
      faultHook(sql, rawSql, params);
    }

    if (sql === "begin" || sql === "commit" || sql === "rollback") {
      if (sql === "commit" || sql === "rollback") {
        if (heldDelivery) {
          for (const id of heldDelivery) lockedDeliveryIds.delete(id);
          heldDelivery.clear();
        }
        if (heldOutbox) {
          for (const id of heldOutbox) lockedOutboxIds.delete(id);
          heldOutbox.clear();
        }
      }
      return { rows: [], rowCount: 0 };
    }

    // Active rules
    if (sql.includes("from public.reminders") && sql.startsWith("select")) {
      const rows = [...rules.values()].filter((r) =>
        sql.includes("where is_active = true") ? r.is_active : true,
      );
      return { rows, rowCount: rows.length };
    }

    // Payment instances loader
    if (sql.includes("from public.payment_instances")) {
      const open = [...payments.values()].filter(
        (p) =>
          p.cancelled_at == null &&
          ["planned", "unpaid", "partial", "late"].includes(p.status),
      );
      let filtered = open;
      if (sql.includes("any($1")) {
        const ids = new Set((params[0] as string[]) ?? []);
        filtered = open.filter((p) => ids.has(p.id));
      } else if (sql.includes("between ($1::date - $2::int) and ($1::date + $3::int)")) {
        const todayISO = String(params[0]);
        const lookback = Number(params[1]);
        const horizon = Number(params[2]);
        const minDate = addDaysISO(todayISO, -lookback);
        const maxDate = addDaysISO(todayISO, horizon);
        filtered = open.filter((p) => p.due_date >= minDate && p.due_date <= maxDate);
      }
      const rows = filtered.map((p) => ({
        id: p.id,
        name: p.name,
        due_date: p.due_date,
        amount: p.amount,
        paid_amount: p.paid_amount,
        legal_entity_id: p.legal_entity_id ?? null,
        status: p.status,
        owner: p.owner ?? null,
        provider: p.provider ?? null,
        risk_reasons: p.risk_reasons ?? [],
      }));
      return { rows, rowCount: rows.length };
    }

    if (
      sql.includes("from public.loan_installments") ||
      sql.includes("from public.invoices") ||
      sql.includes("from public.promise_to_pay") ||
      sql.includes("from public.checks") ||
      sql.includes("from public.covenant_records") ||
      sql.includes("from cov_due")
    ) {
      return { rows: [], rowCount: 0 };
    }

    // ops_incidents read/write
    if (sql.includes("from public.ops_incidents") && sql.startsWith("select")) {
      return { rows: [...opsIncidents.values()], rowCount: opsIncidents.size };
    }
    if (sql.startsWith("insert into public.ops_incidents")) {
      const signalKey = String(params[0] ?? "outbox_delivery_uncertain");
      const severity = String(params[1] ?? "P1");
      const state = String(params[2] ?? "OPEN");
      const lastValue = String(params[3] ?? "1");
      const note = String(params[5] ?? "");
      opsIncidents.set(signalKey, {
        signal_key: signalKey,
        severity,
        state,
        last_value: lastValue,
        note,
      });
      return { rows: [{ signal_key: signalKey }], rowCount: 1 };
    }

    // Insert reminder_deliveries
    if (sql.startsWith("insert into public.reminder_deliveries")) {
      const [reminderId, entityTable, entityId, scheduledFor, rawPayload] = params as [
        string,
        string,
        string,
        string,
        string,
      ];
      const dup = [...deliveries.values()].find(
        (d) =>
          d.reminder_id === reminderId &&
          d.entity_table === entityTable &&
          d.entity_id === entityId &&
          d.scheduled_for === scheduledFor,
      );
      if (dup) return { rows: [], rowCount: 0 };
      const id = randomUUID();
      deliveries.set(id, {
        id,
        reminder_id: reminderId,
        entity_table: entityTable,
        entity_id: entityId,
        scheduled_for: scheduledFor,
        status: "pending",
        claim_token: null,
        claimed_at: null,
        sent_at: null,
        payload: rawPayload ? (JSON.parse(rawPayload) as Record<string, unknown>) : null,
        error: null,
      });
      return { rows: [{ id }], rowCount: 1 };
    }

    // Expire stale upcoming window
    if (
      sql.startsWith("update public.reminder_deliveries") &&
      sql.includes("expired_stale_window")
    ) {
      const todayISO = String(params[0]);
      const cutoff = addDaysISO(todayISO, -1);
      let count = 0;
      for (const d of deliveries.values()) {
        const r = rules.get(d.reminder_id);
        if (r && d.status === "pending" && r.offset_days >= 0 && d.scheduled_for < cutoff) {
          d.status = "skipped";
          d.error = "expired_stale_window";
          count += 1;
        }
      }
      return { rows: [], rowCount: count };
    }

    // Stale 'claiming' recovery on reminder_deliveries (> 10 minutes)
    if (
      sql.startsWith("update public.reminder_deliveries") &&
      sql.includes("where status = 'claiming'") &&
      !sql.includes("returning")
    ) {
      const tenMinAgo = clock.nowMs() - 10 * 60 * 1_000;
      const onlySending =
        sql.includes("dispatchphase") &&
        sql.includes("= 'sending'") &&
        !sql.includes("<> 'sending'");
      const excludeSending =
        sql.includes("dispatchphase") && sql.includes("<> 'sending'");
      const targetUncertain = sql.includes("set status = 'delivery_uncertain'");

      let count = 0;
      for (const d of deliveries.values()) {
        if (d.status !== "claiming" || !d.claimed_at || d.claimed_at.getTime() >= tenMinAgo) {
          continue;
        }
        const phase = String(d.payload?.dispatchPhase ?? "");
        if (onlySending && phase !== "sending") continue;
        if (excludeSending && phase === "sending") continue;

        if (targetUncertain) {
          d.status = "delivery_uncertain";
          d.claim_token = null;
          d.error =
            d.error ?? "crash_window_after_sending_started: operator_reconciliation_required";
          d.payload = {
            ...(d.payload ?? {}),
            dispatchPhase: "delivery_uncertain",
            requiresOperatorReconciliation: true,
          };
        } else {
          d.status = "pending";
          d.claim_token = null;
          d.claimed_at = null;
          if (d.payload) {
            d.payload = { ...d.payload, dispatchPhase: "pending" };
          }
        }
        count += 1;
      }
      return { rows: [], rowCount: count };
    }

    // Atomic CTE claiming on reminder_deliveries
    if (
      sql.startsWith("with due as") &&
      sql.includes("update public.reminder_deliveries") &&
      sql.includes("returning")
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
        d.claimed_at = clock.nowDate();
        if (sql.includes("dispatchphase")) {
          d.payload = { ...(d.payload ?? {}), dispatchPhase: "claimed" };
        }
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

    // Row-level updates on reminder_deliveries (sending phase stamp + final status)
    if (sql.startsWith("update public.reminder_deliveries")) {
      const id = String(params[0]);
      const d = deliveries.get(id);
      if (!d) return { rows: [], rowCount: 0 };
      if (d.status !== "pending" && d.status !== "claiming") {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("and status = 'claiming'") && d.status !== "claiming") {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("claim_token =")) {
        const tokenMatched = params.some(
          (p, idx) => idx > 0 && typeof p === "string" && p === d.claim_token,
        );
        if (d.claim_token && !tokenMatched) return { rows: [], rowCount: 0 };
      }

      if (sql.includes("set status = 'claiming'")) {
        d.status = "claiming";
        const jsonPatchRaw = params[2];
        if (typeof jsonPatchRaw === "string") {
          d.payload = {
            ...(d.payload ?? {}),
            ...(JSON.parse(jsonPatchRaw) as Record<string, unknown>),
          };
        }
        return { rows: [{ id: d.id }], rowCount: 1 };
      }

      if (sql.includes("set status = 'sent'")) {
        d.status = "sent";
        d.sent_at = clock.nowDate();
        d.error = null;
        d.claim_token = null;
        if (typeof params[1] === "string" && sql.includes("payload =")) {
          d.payload = {
            ...(d.payload ?? {}),
            ...(JSON.parse(params[1]) as Record<string, unknown>),
          };
        }
        return { rows: [{ id: d.id }], rowCount: 1 };
      }

      d.status = String(params[1]);
      d.error = params[2] != null ? String(params[2]) : null;
      d.claim_token = null;
      if (typeof params[3] === "string" && sql.includes("payload =")) {
        d.payload = {
          ...(d.payload ?? {}),
          ...(JSON.parse(params[3]) as Record<string, unknown>),
        };
      }
      return { rows: [{ id: d.id }], rowCount: 1 };
    }

    // Outbox SELECT
    if (sql.includes("from public.notification_outbox") && sql.startsWith("select")) {
      if (sql.includes("where id = $1")) {
        const id = String(params[0]);
        const found = [...outboxByKey.values()].find((o) => o.id === id);
        return found ? { rows: [{ ...found }], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      const keys = new Set<string>(
        Array.isArray(params[0]) ? (params[0] as string[]) : [String(params[0] ?? "")],
      );
      const rows: Record<string, unknown>[] = [];
      for (const o of outboxByKey.values()) {
        if (!keys.has(o.idempotency_key)) continue;
        if (
          sql.includes("status in ('sent', 'delivery_uncertain', 'claiming')") &&
          o.status !== "sent" &&
          o.status !== "delivery_uncertain" &&
          o.status !== "claiming"
        ) {
          continue;
        }
        if (sql.includes("status = 'sent'") && o.status !== "sent") continue;
        rows.push({
          id: o.id,
          idempotency_key: o.idempotency_key,
          status: o.status,
          attempt_count: o.attempt_count,
          max_attempts: o.max_attempts,
        });
      }
      return { rows, rowCount: rows.length };
    }

    // Outbox INSERT
    if (sql.startsWith("insert into public.notification_outbox")) {
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
      ] = params as [
        string,
        string,
        string,
        string,
        string | null,
        string,
        "plain" | "html",
        string,
        number,
        string | null,
      ];
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
        claimed_at: null,
        uncertain_at: null,
        sent_at: null,
        attempt_count: 0,
        max_attempts: Number(maxAttempts ?? 5),
        next_retry_at_ms: clock.nowMs(),
        provider_message_ids: [],
        last_error: null,
        legal_entity_id: legalEntityId ?? null,
      });
      return { rows: [{ id }], rowCount: 1 };
    }

    // Outbox stale 'claiming' recovery (recoverStaleOutboxClaims)
    if (
      sql.startsWith("update public.notification_outbox") &&
      sql.includes("where status = 'claiming'") &&
      !sql.includes("returning")
    ) {
      const staleMinutes = Number(params[0] ?? 10);
      const cutoffMs = clock.nowMs() - staleMinutes * 60 * 1_000;
      const onlySending =
        sql.includes("dispatchphase") &&
        sql.includes("= 'sending'") &&
        !sql.includes("<> 'sending'");
      const excludeSending =
        sql.includes("dispatchphase") && sql.includes("<> 'sending'");

      let count = 0;
      for (const o of outboxByKey.values()) {
        if (o.status !== "claiming" || !o.claimed_at || o.claimed_at.getTime() >= cutoffMs) {
          continue;
        }
        const phase = String(o.metadata?.dispatchPhase ?? "");
        if (onlySending && phase !== "sending") continue;
        if (excludeSending && phase === "sending") continue;

        if (sql.includes("set status = 'delivery_uncertain'")) {
          o.status = "delivery_uncertain";
          o.uncertain_at = o.uncertain_at ?? clock.nowDate();
          o.claim_token = null;
          o.last_error =
            o.last_error ?? "stale_claim_after_sending_started: operator_reconciliation_required";
          o.metadata = {
            ...o.metadata,
            dispatchPhase: "delivery_uncertain",
            requiresOperatorReconciliation: true,
          };
        } else {
          o.status = "failed_retryable";
          o.claim_token = null;
          o.last_error = o.last_error ?? "stale_pre_send_claim_recovered";
          o.metadata = {
            ...o.metadata,
            dispatchPhase: "failed_retryable",
          };
        }
        count += 1;
      }
      return { rows: [], rowCount: count };
    }

    // Outbox CTE claiming (claimAndDispatchOutbox)
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
        if (o.next_retry_at_ms > clock.nowMs()) continue;
        if (streamFilter && o.stream !== streamFilter) continue;
        if (channelFilter && o.channel !== channelFilter) continue;
        if (lockedOutboxIds.has(o.id)) continue;
        o.status = "claiming";
        o.claim_token = randomUUID();
        o.claimed_at = clock.nowDate();
        o.metadata = { ...o.metadata, dispatchPhase: "claimed" };
        claimed.push({ ...o });
      }
      return { rows: claimed, rowCount: claimed.length };
    }

    // Outbox row updates (prepareOutboxSendingIntent / markOutboxSendingStarted / finalizeOutboxSendingOutcome / recordOutboxOutcomeSafe)
    if (sql.startsWith("update public.notification_outbox")) {
      let target: SimOutboxRow | undefined;

      if (sql.includes("where idempotency_key = $1")) {
        target = outboxByKey.get(String(params[0]));
      } else if (
        sql.includes("where id = $1") &&
        sql.includes("status in ('pending', 'failed_retryable')")
      ) {
        const id = String(params[0]);
        target = [...outboxByKey.values()].find(
          (o) => o.id === id && (o.status === "pending" || o.status === "failed_retryable"),
        );
        if (!target) return { rows: [], rowCount: 0 };
        target.status = "claiming";
        target.claim_token = String(params[1]);
        target.claimed_at = clock.nowDate();
        if (typeof params[2] === "string") {
          target.metadata = {
            ...target.metadata,
            ...(JSON.parse(params[2]) as Record<string, unknown>),
          };
        }
        return { rows: [{ id: target.id }], rowCount: 1 };
      } else {
        const id = String(params[0]);
        const token = String(params[1] ?? "");
        target = [...outboxByKey.values()].find(
          (o) => o.id === id && (!sql.includes("claim_token = $2") || o.claim_token === token),
        );
      }

      if (!target) return { rows: [], rowCount: 0 };

      // markOutboxSendingStarted (`dispatchPhase = 'sending'` without status change)
      if (
        sql.includes("'dispatchphase', 'sending'") &&
        sql.includes("where id = $1 and status = 'claiming'")
      ) {
        if (target.status !== "claiming") return { rows: [], rowCount: 0 };
        const extra = typeof params[2] === "string" ? (JSON.parse(params[2]) as Record<string, unknown>) : {};
        target.metadata = {
          ...target.metadata,
          dispatchPhase: "sending",
          sendingStartedAt: clock.nowISO(),
          sendAttempt: target.attempt_count + 1,
          ...extra,
        };
        return { rows: [{ id: target.id }], rowCount: 1 };
      }

      const literalMatch = sql.match(/set\s+status\s*=\s*'([a-z_]+)'/);
      const paramMatch = sql.match(/set\s+status\s*=\s*\$(\d+)/);
      if (literalMatch) {
        target.status = literalMatch[1]!;
      } else if (paramMatch) {
        const idx = Number(paramMatch[1]) - 1;
        target.status = String(params[idx]);
      } else if (sql.includes("dead_letter")) {
        target.status =
          target.attempt_count + 1 >= target.max_attempts ? "dead_letter" : "failed_retryable";
      }

      if (target.status === "sent") {
        target.sent_at = clock.nowDate();
        target.last_error = null;
      } else if (target.status === "delivery_uncertain") {
        target.uncertain_at = target.uncertain_at ?? clock.nowDate();
      }

      for (const p of params) {
        if (Array.isArray(p) && p.every((x) => typeof x === "string")) {
          if (p.length > 0) target.provider_message_ids = [...(p as string[])];
        } else if (typeof p === "string" && p.startsWith("{") && p.includes("dispatchPhase")) {
          try {
            target.metadata = {
              ...target.metadata,
              ...(JSON.parse(p) as Record<string, unknown>),
            };
          } catch {
            // ignore non-json string
          }
        }
      }

      if (sql.includes("next_retry_at = now() + ($5::int")) {
        target.next_retry_at_ms = clock.nowMs() + Number(params[4] ?? 0) * 1_000;
      } else if (sql.includes("next_retry_at = now() + ($3::int")) {
        target.next_retry_at_ms = clock.nowMs() + Number(params[2] ?? 0) * 1_000;
      }

      if (sql.includes("claim_token = null")) {
        target.claim_token = null;
      }
      if (sql.includes("attempt_count = attempt_count + 1")) {
        target.attempt_count += 1;
      } else if (sql.includes("attempt_count = $4")) {
        target.attempt_count = Number(params[3]);
      }
      return { rows: [{ id: target.id }], rowCount: 1 };
    }

    throw new Error(`Unexpected SQL in chaos simulator: ${rawSql}`);
  }

  const pool = {
    async query(sql: string, params?: unknown[]) {
      return executeSql(sql, params);
    },
    async connect() {
      const heldDelivery = new Set<string>();
      const heldOutbox = new Set<string>();
      return {
        async query(sql: string, params?: unknown[]) {
          return executeSql(sql, params, heldDelivery, heldOutbox);
        },
        release() {
          for (const id of heldDelivery) lockedDeliveryIds.delete(id);
          heldDelivery.clear();
          for (const id of heldOutbox) lockedOutboxIds.delete(id);
          heldOutbox.clear();
        },
      };
    },
  } as unknown as Pool;

  return { pool, rules, payments, deliveries, outboxByKey, opsIncidents, setFaultHook };
}

describe("F-08 & F-20 Notification Crash-Window & Adversarial Chaos Suite", () => {
  it("1. [F-08 CRASH WINDOW] transport.send() succeeds -> worker crashes / loses DB before outcome write -> +15m cron restart -> 1 send total, status = 'delivery_uncertain' (0 duplicate sends)", async () => {
    const clock = new DeterministicClock("2026-11-18T09:00:00.000Z");
    const asOf = "2026-11-18";
    const paymentId = "08080808-0001-4000-8000-000000000001";

    const sim = createChaosReminderDb({
      clock,
      rules: [
        {
          id: "rule-pay-8",
          name: "8-30 Gün İhtar",
          target_kind: "payment_instance",
          offset_days: -8,
          channel: "telegram",
          min_amount: null,
          is_active: true,
        },
      ],
      payments: [
        {
          id: paymentId,
          name: "Sentetik Tedarikçi A.Ş. Fatura Ödemesi",
          due_date: "2026-11-05",
          amount: "75000.00",
          paid_amount: "0.00",
          status: "late",
          provider: "Sentetik Tedarikçi A.Ş.",
          risk_reasons: ["overdue"],
        },
      ],
    });

    await scheduleReminders(sim.pool, asOf);
    expect(sim.deliveries.size).toBe(1);

    const sentPayloads: string[] = [];
    let crashAfterSendArmed = false;

    sim.setFaultHook((sql) => {
      if (
        crashAfterSendArmed &&
        (sql.includes("notification_outbox") || sql.includes("reminder_deliveries"))
      ) {
        throw Object.assign(new Error("Connection terminated unexpectedly (simulated worker crash after Telegram 200 OK)"), {
          code: "57P01",
        });
      }
    });

    const fakeTelegramFetch: typeof fetch = (async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { text: string };
      sentPayloads.push(body.text);
      crashAfterSendArmed = true;
      return new Response(
        JSON.stringify({ ok: true, result: { message_id: 91001 } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const worker1Transport: Transport = {
      channel: "telegram",
      send: (msg, opts) =>
        sendTelegramChatMessage("-1005550001", msg, {
          token: "123456:SYNTHETIC_BOT_TOKEN",
          allowedChatIds: ["-1005550001"],
          parseMode: opts?.parseMode,
          fetchImpl: fakeTelegramFetch,
        }),
    };

    // Worker 1 sends the Telegram message (200 OK), then crashes before post-send DB confirmation
    await expect(dispatchPending(sim.pool, worker1Transport, asOf)).rejects.toThrow(
      /Connection terminated unexpectedly/,
    );
    expect(sentPayloads).toHaveLength(1);

    // Durable 'sending' phase MUST already be persisted in both reminder_deliveries and notification_outbox
    const crashedDelivery = [...sim.deliveries.values()][0]!;
    expect(crashedDelivery.status).toBe("claiming");
    expect(crashedDelivery.payload?.dispatchPhase).toBe("sending");

    const crashedOutbox = [...sim.outboxByKey.values()][0];
    expect(crashedOutbox).toBeDefined();
    expect(crashedOutbox?.status).toBe("claiming");
    expect(crashedOutbox?.metadata?.dispatchPhase).toBe("sending");

    // Advance deterministic clock +15 minutes (> 10 minute stale claim threshold) and restore DB for Worker 2
    sim.setFaultHook(null);
    clock.advanceMinutes(15);
    crashAfterSendArmed = false;

    const worker2Transport: Transport = {
      channel: "telegram",
      send: (msg, opts) =>
        sendTelegramChatMessage("-1005550001", msg, {
          token: "123456:SYNTHETIC_BOT_TOKEN",
          allowedChatIds: ["-1005550001"],
          parseMode: opts?.parseMode,
          fetchImpl: fakeTelegramFetch,
        }),
    };

    await scheduleReminders(sim.pool, asOf);
    const worker2Result = await dispatchPending(sim.pool, worker2Transport, asOf);

    // CRITICAL F-08 INVARIANT: ZERO duplicate sends; stale 'sending' claim transitions to 'delivery_uncertain'
    expect(sentPayloads).toHaveLength(1);
    expect(worker2Result.sent).toBe(0);

    const reconciledDelivery = [...sim.deliveries.values()][0]!;
    expect(reconciledDelivery.status).toBe("delivery_uncertain");
    expect(reconciledDelivery.claim_token).toBeNull();
    expect(reconciledDelivery.error).toContain("operator_reconciliation_required");

    const reconciledOutbox = [...sim.outboxByKey.values()][0]!;
    expect(reconciledOutbox.status).toBe("delivery_uncertain");
    expect(reconciledOutbox.claim_token).toBeNull();
    expect(reconciledOutbox.metadata.requiresOperatorReconciliation).toBe(true);
  });

  it("2. [F-08 DIGEST CRASH WINDOW] >= 6 items consolidated digest succeeds at Telegram -> crash before post-send DB write -> +15m cron restart -> 1 digest send total, all rows 'delivery_uncertain'", async () => {
    const clock = new DeterministicClock("2026-11-18T10:00:00.000Z");
    const asOf = "2026-11-18";

    const payments: SimPaymentRow[] = Array.from({ length: 7 }, (_, idx) => ({
      id: `08080808-0002-4000-8000-${String(idx + 1).padStart(12, "0")}`,
      name: `Sentetik Cari Kalem #${idx + 1}`,
      due_date: addDaysISO(asOf, -(idx + 2)),
      amount: `${(idx + 1) * 10_000}.00`,
      paid_amount: "0.00",
      status: "late",
      provider: "Sentetik Tedarik",
      risk_reasons: ["overdue"],
    }));

    const sim = createChaosReminderDb({
      clock,
      rules: [
        {
          id: "rule-pay-1",
          name: "1-7 Gün Gecikmiş",
          target_kind: "payment_instance",
          offset_days: -1,
          channel: "telegram",
          min_amount: null,
          is_active: true,
        },
        {
          id: "rule-pay-8",
          name: "8-30 Gün İhtar",
          target_kind: "payment_instance",
          offset_days: -8,
          channel: "telegram",
          min_amount: null,
          is_active: true,
        },
      ],
      payments,
    });

    await scheduleReminders(sim.pool, asOf);
    expect(sim.deliveries.size).toBe(7);

    let digestSends = 0;
    let crashArmed = false;
    sim.setFaultHook((sql) => {
      if (
        crashArmed &&
        (sql.includes("notification_outbox") || sql.includes("reminder_deliveries"))
      ) {
        throw new Error("DB socket closed immediately after digest 200 OK");
      }
    });

    const digestTransport: Transport = {
      channel: "telegram",
      async send() {
        digestSends += 1;
        crashArmed = true;
        return {
          ok: true,
          providerMessageId: "92001",
          messageIds: ["92001"],
          providerMessageIds: ["92001"],
        };
      },
    };

    await expect(dispatchPending(sim.pool, digestTransport, asOf)).rejects.toThrow(
      /DB socket closed/,
    );
    expect(digestSends).toBe(1);

    // +15m later: Worker 2 MUST NOT re-send the 7-item digest
    sim.setFaultHook(null);
    crashArmed = false;
    clock.advanceMinutes(15);

    await scheduleReminders(sim.pool, asOf);
    const res2 = await dispatchPending(sim.pool, digestTransport, asOf);
    expect(res2.sent).toBe(0);
    expect(digestSends).toBe(1);
    for (const d of sim.deliveries.values()) {
      expect(d.status).toBe("delivery_uncertain");
    }
  });

  it("3. crash BEFORE SENDING phase (dispatchPhase = 'claimed', 0 network sends) + +15m cron restart -> safely recovers to 'pending' and delivers exactly once", async () => {
    const clock = new DeterministicClock("2026-11-18T11:00:00.000Z");
    const asOf = "2026-11-18";
    const paymentId = "08080808-0003-4000-8000-000000000003";

    const sim = createChaosReminderDb({
      clock,
      rules: [
        {
          id: "rule-pay-0",
          name: "Bugün Ödeme",
          target_kind: "payment_instance",
          offset_days: 0,
          channel: "telegram",
          min_amount: null,
          is_active: true,
        },
      ],
      payments: [
        {
          id: paymentId,
          name: "Sentetik Kira Ödemesi",
          due_date: asOf,
          amount: "60000.00",
          paid_amount: "0.00",
          status: "unpaid",
          provider: "Sentetik Gayrimenkul",
        },
      ],
    });

    await scheduleReminders(sim.pool, asOf);

    // Crash during live target load (AFTER claiming, BEFORE SENDING intent & BEFORE transport.send)
    sim.setFaultHook((sql) => {
      if (sql.includes("from public.payment_instances") && sql.includes("any($1")) {
        throw new Error("Worker OOM killed before SENDING phase");
      }
    });

    let networkSends = 0;
    const okTransport: Transport = {
      channel: "telegram",
      send: (msg) =>
        sendTelegramChatMessage("-1005550003", msg, {
          token: "123456:SYNTHETIC_BOT_TOKEN",
          allowedChatIds: ["-1005550003"],
          fetchImpl: (async () => {
            networkSends += 1;
            return new Response(
              JSON.stringify({ ok: true, result: { message_id: 93001 } }),
              { status: 200, headers: { "content-type": "application/json" } },
            );
          }) as typeof fetch,
        }),
    };

    await expect(dispatchPending(sim.pool, okTransport, asOf)).rejects.toThrow(
      /Worker OOM killed before SENDING phase/,
    );
    expect(networkSends).toBe(0);

    const preSendClaimed = [...sim.deliveries.values()][0]!;
    expect(preSendClaimed.status).toBe("claiming");
    expect(preSendClaimed.payload?.dispatchPhase).not.toBe("sending");

    // +15m later: pre-send stale claim recovers to 'pending' and sends 1 time
    sim.setFaultHook(null);
    clock.advanceMinutes(15);

    const recovered = await dispatchPending(sim.pool, okTransport, asOf);
    expect(recovered.sent).toBe(1);
    expect(networkSends).toBe(1);

    const finalDelivery = [...sim.deliveries.values()][0]!;
    expect(finalDelivery.status).toBe("sent");
    expect(finalDelivery.payload?.providerMessageIds).toEqual(["93001"]);
    expect(finalDelivery.payload?.providerMessageId).toBe("93001");
  });

  it("4. DB failure WHILE committing SENDING fence aborts BEFORE transport.send() (0 network sends)", async () => {
    const clock = new DeterministicClock("2026-11-18T11:30:00.000Z");
    const asOf = "2026-11-18";

    const sim = createChaosReminderDb({
      clock,
      rules: [
        {
          id: "rule-pay-0",
          name: "Bugün Ödeme",
          target_kind: "payment_instance",
          offset_days: 0,
          channel: "telegram",
          min_amount: null,
          is_active: true,
        },
      ],
      payments: [
        {
          id: "08080808-0004-4000-8000-000000000004",
          name: "Sentetik Vergi Ödemesi",
          due_date: asOf,
          amount: "110000.00",
          paid_amount: "0.00",
          status: "unpaid",
        },
      ],
    });

    await scheduleReminders(sim.pool, asOf);

    sim.setFaultHook((sql) => {
      if (sql.startsWith("insert into public.notification_outbox")) {
        throw new Error("DB write failed while persisting SENDING intent");
      }
    });

    let networkSends = 0;
    const guardedTransport: Transport = {
      channel: "telegram",
      async send() {
        networkSends += 1;
        return { ok: true };
      },
    };

    await expect(dispatchPending(sim.pool, guardedTransport, asOf)).rejects.toThrow(
      /DB write failed while persisting SENDING intent/,
    );
    expect(networkSends).toBe(0);
  });

  it("5. concurrent workers racing on the same due batch + duplicate cron trigger in same cadence slot emit 1 send total", async () => {
    const clock = new DeterministicClock("2026-11-18T12:00:00.000Z");
    const asOf = "2026-11-18";

    const sim = createChaosReminderDb({
      clock,
      rules: [
        {
          id: "rule-pay-8",
          name: "8-30 Gün İhtar",
          target_kind: "payment_instance",
          offset_days: -8,
          channel: "telegram",
          min_amount: null,
          is_active: true,
        },
      ],
      payments: [
        {
          id: "08080808-0005-4000-8000-000000000005",
          name: "Sentetik Enerji Ödemesi",
          due_date: "2026-11-06",
          amount: "82000.00",
          paid_amount: "0.00",
          status: "late",
        },
      ],
    });

    await scheduleReminders(sim.pool, asOf);

    let sendCalls = 0;
    const slowTransport: Transport = {
      channel: "telegram",
      async send() {
        await new Promise((r) => setTimeout(r, 20));
        sendCalls += 1;
        return { ok: true, providerMessageId: "95001", providerMessageIds: ["95001"] };
      },
    };

    // 3 concurrent workers racing on the same batch
    const results = await Promise.all([
      dispatchPending(sim.pool, slowTransport, asOf),
      dispatchPending(sim.pool, slowTransport, asOf),
      dispatchPending(sim.pool, slowTransport, asOf),
    ]);
    expect(sendCalls).toBe(1);
    expect(results.reduce((acc, r) => acc + r.sent, 0)).toBe(1);

    // Duplicate cron trigger in same cadence slot -> 0 additional sends
    const dupSched = await scheduleReminders(sim.pool, asOf);
    const dupDisp = await dispatchPending(sim.pool, slowTransport, asOf);
    expect(dupSched.inserted).toBe(0);
    expect(dupDisp.sent).toBe(0);
    expect(sendCalls).toBe(1);
  });

  it("6. network timeout & ECONNRESET during fetch -> 'delivery_uncertain' with 0 automatic duplicate retries", async () => {
    const clock = new DeterministicClock("2026-11-18T13:00:00.000Z");
    const asOf = "2026-11-18";

    // (a) Direct ECONNRESET during sendTelegramChatMessage -> uncertainOutcome: true
    const econnresetFetch: typeof fetch = (async () => {
      throw Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
    }) as typeof fetch;

    const resetOutcome = await sendTelegramChatMessage("-1005550006", "Kritik Ödeme", {
      token: "123456:SYNTHETIC_BOT_TOKEN",
      allowedChatIds: ["-1005550006"],
      fetchImpl: econnresetFetch,
    });
    expect(resetOutcome.ok).toBe(false);
    expect(resetOutcome.uncertainOutcome).toBe(true);
    expect(resetOutcome.failureKind).toBe("unknown_outcome");

    // (b) ETIMEDOUT during sendTelegramChatMessage -> uncertainOutcome: true, failureKind: 'timeout'
    const etimedoutFetch: typeof fetch = (async () => {
      throw Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" });
    }) as typeof fetch;

    const timeoutOutcome = await sendTelegramChatMessage("-1005550006", "Kritik Ödeme", {
      token: "123456:SYNTHETIC_BOT_TOKEN",
      allowedChatIds: ["-1005550006"],
      fetchImpl: etimedoutFetch,
    });
    expect(timeoutOutcome.ok).toBe(false);
    expect(timeoutOutcome.uncertainOutcome).toBe(true);
    expect(timeoutOutcome.failureKind).toBe("timeout");

    // (c) End-to-end through dispatchPending: ECONNRESET -> delivery_uncertain, no auto-retry on subsequent ticks
    const sim = createChaosReminderDb({
      clock,
      rules: [
        {
          id: "rule-pay-0",
          name: "Bugün Ödeme",
          target_kind: "payment_instance",
          offset_days: 0,
          channel: "telegram",
          min_amount: null,
          is_active: true,
        },
      ],
      payments: [
        {
          id: "08080808-0006-4000-8000-000000000006",
          name: "Sentetik Lojistik Ödemesi",
          due_date: asOf,
          amount: "48000.00",
          paid_amount: "0.00",
          status: "unpaid",
        },
      ],
    });

    let fetchCalls = 0;
    const resetTransport: Transport = {
      channel: "telegram",
      send: (msg) =>
        sendTelegramChatMessage("-1005550006", msg, {
          token: "123456:SYNTHETIC_BOT_TOKEN",
          allowedChatIds: ["-1005550006"],
          fetchImpl: (async () => {
            fetchCalls += 1;
            throw Object.assign(new Error("socket hang up (ECONNRESET)"), {
              code: "ECONNRESET",
            });
          }) as typeof fetch,
        }),
    };

    await scheduleReminders(sim.pool, asOf);
    const firstTick = await dispatchPending(sim.pool, resetTransport, asOf);
    expect(fetchCalls).toBe(1);
    expect(firstTick.sent).toBe(0);
    expect(firstTick.uncertain).toBe(1);
    expect([...sim.deliveries.values()][0]?.status).toBe("delivery_uncertain");
    expect([...sim.outboxByKey.values()][0]?.status).toBe("delivery_uncertain");

    // Advance +30m and run cron again -> 0 automatic retries!
    clock.advanceMinutes(30);
    await scheduleReminders(sim.pool, asOf);
    const secondTick = await dispatchPending(sim.pool, resetTransport, asOf);
    expect(secondTick.sent).toBe(0);
    expect(fetchCalls).toBe(1);
  });

  it("7. multi-chunk HTML partial success (chunk 1 -> 200 OK, chunk 2 -> 500 or 429) -> uncertainOutcome: true ('delivery_uncertain', never re-sends chunk 1) vs single-chunk 429 retry_after: 17", async () => {
    const clock = new DeterministicClock("2026-11-18T14:00:00.000Z");
    const longHtml = `<b>${"Sentetik Ödeme Satırı &amp; Kontrol Detayı\n".repeat(120)}</b>`;
    expect(longHtml.length).toBeGreaterThan(TELEGRAM_HTML_SAFE_MAX_CHARS);

    // (a) Multi-chunk where chunk 1 -> 200 OK (message_id: 7101) and chunk 2 -> 500
    let attempt500 = 0;
    const partial500 = await sendTelegramChatMessage("-1005550007", longHtml, {
      token: "123456:SYNTHETIC_BOT_TOKEN",
      allowedChatIds: ["-1005550007"],
      parseMode: "HTML",
      fetchImpl: (async () => {
        attempt500 += 1;
        if (attempt500 === 1) {
          return new Response(
            JSON.stringify({ ok: true, result: { message_id: 7101 } }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response("Internal Server Error", { status: 500 });
      }) as typeof fetch,
    });
    expect(partial500.ok).toBe(false);
    expect(partial500.uncertainOutcome).toBe(true);
    expect(partial500.providerMessageIds).toEqual(["7101"]);
    expect(partial500.providerMessageId).toBe("7101");

    // (b) Multi-chunk where chunk 1 -> 200 OK (message_id: 7201) and chunk 2 -> 429 retry_after: 17
    // MUST mark uncertainOutcome: true and retryAfterSeconds: null so chunk 1 is NEVER auto-resent!
    let attempt429 = 0;
    const partial429 = await sendTelegramChatMessage("-1005550007", longHtml, {
      token: "123456:SYNTHETIC_BOT_TOKEN",
      allowedChatIds: ["-1005550007"],
      parseMode: "HTML",
      fetchImpl: (async () => {
        attempt429 += 1;
        if (attempt429 === 1) {
          return new Response(
            JSON.stringify({ ok: true, result: { message_id: 7201 } }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(
          JSON.stringify({ ok: false, parameters: { retry_after: 17 } }),
          { status: 429, headers: { "content-type": "application/json" } },
        );
      }) as typeof fetch,
    });
    expect(partial429.ok).toBe(false);
    expect(partial429.uncertainOutcome).toBe(true);
    expect(partial429.retryAfterSeconds).toBeNull();
    expect(partial429.providerMessageIds).toEqual(["7201"]);

    // Verify outbox holds partial429 in 'delivery_uncertain' and NEVER retries after +60s
    const sim = createChaosReminderDb({ clock });
    sim.outboxByKey.set("partial-chunk-key", {
      id: "ob-partial-429",
      stream: "reminder_digest",
      channel: "telegram",
      recipient_target: "-1005550007",
      idempotency_key: "partial-chunk-key",
      subject: null,
      body_text: longHtml,
      body_format: "html",
      metadata: {},
      status: "pending",
      claim_token: null,
      claimed_at: null,
      uncertain_at: null,
      sent_at: null,
      attempt_count: 0,
      max_attempts: 5,
      next_retry_at_ms: clock.nowMs(),
      provider_message_ids: [],
      last_error: null,
      legal_entity_id: null,
    });

    let outboxSendCount = 0;
    await claimAndDispatchOutbox(sim.pool, {
      transportResolver: () => ({
        channel: "telegram",
        async send() {
          outboxSendCount += 1;
          return partial429;
        },
      }),
    });
    expect(outboxSendCount).toBe(1);
    expect(sim.outboxByKey.get("partial-chunk-key")?.status).toBe("delivery_uncertain");
    expect(sim.outboxByKey.get("partial-chunk-key")?.provider_message_ids).toEqual(["7201"]);

    clock.advanceSeconds(120);
    await claimAndDispatchOutbox(sim.pool, {
      transportResolver: () => ({
        channel: "telegram",
        async send() {
          outboxSendCount += 1;
          return { ok: true };
        },
      }),
    });
    expect(outboxSendCount).toBe(1);

    // (c) Single-chunk 429 retry_after: 17 (0 chunks delivered) -> definite failure, uncertainOutcome: false, retryAfterSeconds: 17
    const single429 = await sendTelegramChatMessage("-1005550007", "Kısa mesaj", {
      token: "123456:SYNTHETIC_BOT_TOKEN",
      allowedChatIds: ["-1005550007"],
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({
            ok: false,
            error_code: 429,
            description: "Too Many Requests: retry after 17",
            parameters: { retry_after: 17 },
          }),
          { status: 429, headers: { "content-type": "application/json" } },
        )) as typeof fetch,
    });
    expect(single429.ok).toBe(false);
    expect(single429.uncertainOutcome).toBe(false);
    expect(single429.failureKind).toBe("rate_limited");
    expect(single429.retryAfterSeconds).toBe(17);
    expect(single429.providerMessageIds).toEqual([]);
  });

  it("8. skips obligations edited to future due date, marked paid, or cancelled before dispatchPending AND suppresses expired 'Bugün' reminders (0 sends)", async () => {
    const clock = new DeterministicClock("2026-11-18T15:00:00.000Z");
    const asOf = "2026-11-18";

    const sim = createChaosReminderDb({
      clock,
      rules: [
        {
          id: "rule-pay-0",
          name: "Bugün Ödeme",
          target_kind: "payment_instance",
          offset_days: 0,
          channel: "telegram",
          min_amount: null,
          is_active: true,
        },
        {
          id: "rule-pay-8",
          name: "8-30 Gün İhtar",
          target_kind: "payment_instance",
          offset_days: -8,
          channel: "telegram",
          min_amount: null,
          is_active: true,
        },
      ],
      payments: [
        {
          id: "08080808-0008-4000-8000-000000000001",
          name: "Vadeli Ertelenen Ödeme",
          due_date: "2026-11-05",
          amount: "40000.00",
          paid_amount: "0.00",
          status: "late",
        },
        {
          id: "08080808-0008-4000-8000-000000000002",
          name: "Ödenmiş Fatura",
          due_date: asOf,
          amount: "50000.00",
          paid_amount: "0.00",
          status: "unpaid",
        },
        {
          id: "08080808-0008-4000-8000-000000000003",
          name: "İptal Edilen Ödeme",
          due_date: asOf,
          amount: "30000.00",
          paid_amount: "0.00",
          status: "unpaid",
        },
      ],
      deliveries: [
        // Stale August 'Bugün Ödeme' evaluated in November -> must expire with 'expired_stale_window'
        {
          id: "deliv-expired-bugun",
          reminder_id: "rule-pay-0",
          entity_table: "payment_instances",
          entity_id: "08080808-0008-4000-8000-000000000099",
          scheduled_for: "2026-08-15",
          status: "pending",
          claim_token: null,
          claimed_at: null,
          sent_at: null,
          payload: { message: "eski" },
          error: null,
        },
      ],
    });

    await scheduleReminders(sim.pool, asOf);
    expect(sim.deliveries.size).toBe(4);

    // Before dispatchPending runs:
    // 1) Overdue item rescheduled into future (2026-12-15)
    sim.payments.get("08080808-0008-4000-8000-000000000001")!.due_date = "2026-12-15";
    sim.payments.get("08080808-0008-4000-8000-000000000001")!.status = "planned";
    // 2) Second item settled as 'paid'
    sim.payments.get("08080808-0008-4000-8000-000000000002")!.status = "paid";
    sim.payments.get("08080808-0008-4000-8000-000000000002")!.paid_amount = "50000.00";
    // 3) Third item cancelled
    sim.payments.get("08080808-0008-4000-8000-000000000003")!.status = "cancelled";
    sim.payments.get("08080808-0008-4000-8000-000000000003")!.cancelled_at =
      "2026-11-18T14:55:00.000Z";

    let sends = 0;
    const zeroSendTransport: Transport = {
      channel: "telegram",
      async send() {
        sends += 1;
        return { ok: true };
      },
    };

    const res = await dispatchPending(sim.pool, zeroSendTransport, asOf);
    expect(sends).toBe(0);
    expect(res.sent).toBe(0);
    expect(res.skipped).toBe(4);
    expect(sim.outboxByKey.size).toBe(0);
    expect(sim.deliveries.get("deliv-expired-bugun")?.status).toBe("skipped");
    expect(sim.deliveries.get("deliv-expired-bugun")?.error).toBe("expired_stale_window");
  });

  it("9. enforces unknown (null) != 0 TL, partial tri-value display, >= 6 digest summarization, single-pass HTML escaping, balanced chunking, chat allowlist & token/IBAN masking", async () => {
    const asOf = "2026-11-18";

    const ruleDue: ReminderRule = {
      id: "r-0",
      name: "Bugün Ödeme",
      targetKind: "payment_instance",
      offsetDays: 0,
      channel: "telegram",
      minAmount: null,
      isActive: true,
    };

    // Unknown (null) amount -> never rendered as 0 TL
    const unknownTarget: ReminderTarget = {
      entityTable: "payment_instances",
      entityId: "pi-null-amt",
      name: "[P1] Sentetik Enerji & Su <Fatura> TR12 0006 2000 0001 2345 6789 99",
      dueDate: asOf,
      amount: null,
      status: "unpaid",
      owner: null,
      provider: "Sentetik Enerji",
      riskReasons: ["missing_amount"],
    };
    const unknownMsg = buildReminderMessage(ruleDue, unknownTarget, asOf);
    expect(unknownMsg).toContain("tutar eksik");
    expect(unknownMsg).not.toContain("0 TL");
    expect(unknownMsg).toContain("TR** **** **** **** **** **99");
    expect(unknownMsg).not.toContain("2345 6789");

    // Partial payment -> displays original, paid, and remaining
    const partialTarget: ReminderTarget = {
      entityTable: "payment_instances",
      entityId: "pi-partial-amt",
      name: "Sentetik Makine Alımı",
      dueDate: "2026-11-10",
      amount: 30_000,
      originalAmount: 30_000,
      paidAmount: 10_000,
      outstandingAmount: 20_000,
      status: "partial",
      owner: null,
      provider: "Sentetik Makine",
      riskReasons: ["overdue"],
    };
    const partialMsg = buildReminderMessage(
      { ...ruleDue, id: "r-8", name: "8-30 Gün İhtar", offsetDays: -8 },
      partialTarget,
      asOf,
    );
    expect(partialMsg).toContain("30.000 TL");
    expect(partialMsg).toContain("10.000 TL");
    expect(partialMsg).toContain("20.000 TL");

    // >= 6 items -> summarized digest HTML with single-pass escaping
    const sixItems: ReminderDigestItem[] = Array.from({ length: 6 }, (_, i) => ({
      entityTable: "payment_instances",
      entityId: `pi-dig-${i + 1}`,
      name: `[P1] Sentetik Cari & Ortaklar <Kalem #${i + 1}>`,
      dueDate: addDaysISO(asOf, -(i + 1)),
      amount: i === 0 ? null : 15_000,
      status: "late",
      riskReasons: i === 0 ? ["missing_amount"] : ["overdue"],
    }));
    const digestHtml = buildReminderDigestHtml(sixItems, asOf);
    expect(digestHtml).toContain("Toplam: <b>6</b> kalem");
    expect(digestHtml).toContain("tutar eksik: <b>1</b> kalem");
    expect(digestHtml).toContain("[P1] Sentetik Cari &amp; Ortaklar &lt;Kalem #1&gt;");
    expect(digestHtml).not.toContain("&amp;amp;");
    expect(digestHtml).not.toContain("&#91;");

    expect(escapeTelegramHtml("[P1] A & B <C>")).toBe("[P1] A &amp; B &lt;C&gt;");
    expect(
      scrubSensitiveTelegramText(
        "https://api.telegram.org/bot999111:AAH_SyntheticSecretTok/sendMessage Bearer syn_jwt_token_123 TR120006200000012345678942",
      ),
    ).toBe(
      "https://api.telegram.org/bot[REDACTED]/sendMessage Bearer [REDACTED] TR** **** **** **** **** **42",
    );
    expect(redactBotToken("bot12345:SecretBotKey")).toBe("bot[REDACTED]");

    const splitChunks = splitTelegramHtmlMessage(
      `<b><i>${"Sentetik Satır &amp; Kontrol\n".repeat(200)}</i></b>`,
    );
    expect(splitChunks.length).toBeGreaterThanOrEqual(2);
    for (const chunk of splitChunks) {
      expect(chunk.length).toBeLessThanOrEqual(TELEGRAM_HTML_SAFE_MAX_CHARS);
      expect((chunk.match(/<b>/g) ?? []).length).toBe((chunk.match(/<\/b>/g) ?? []).length);
      expect((chunk.match(/<i>/g) ?? []).length).toBe((chunk.match(/<\/i>/g) ?? []).length);
    }

    // Chat allowlist blocks unapproved target before network egress
    let egressCalls = 0;
    const blocked = await sendTelegramChatMessage("-100999999", "Test", {
      token: "123456:SYNTHETIC_BOT_TOKEN",
      allowedChatIds: ["-100111111"],
      fetchImpl: (async () => {
        egressCalls += 1;
        return new Response("{}", { status: 200 });
      }) as typeof fetch,
    });
    expect(blocked.ok).toBe(false);
    expect(blocked.failureKind).toBe("permission_failure");
    expect(egressCalls).toBe(0);
  });
});
