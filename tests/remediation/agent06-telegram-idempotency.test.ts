import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { describe, expect, it } from "vitest";

import { addDaysISO } from "@/lib/financing/rules";
import {
  dispatchPending,
  ensureDefaultMaturityRules,
  loadPaymentTargets,
  scheduleReminders,
} from "@/lib/reminders/engine";
import {
  claimAndDispatchOutbox,
  computeNotificationIdempotencyKey,
} from "@/lib/reminders/outbox";
import {
  buildReminderDigestHtml,
  buildReminderMessage,
  evaluateEscalationDecision,
  type ReminderDigestItem,
  type ReminderRule,
  type ReminderTarget,
} from "@/lib/reminders/rules";
import {
  TELEGRAM_HTML_SAFE_MAX_CHARS,
  escapeTelegramHtml,
  mockTransport,
  redactBotToken,
  scrubSensitiveTelegramText,
  sendTelegramChatMessage,
  splitTelegramHtmlMessage,
  type DeliveryResult,
  type Transport,
} from "@/lib/reminders/transport";

/* ── Deterministic In-Memory Mock Pool (Zero Real Network / Zero Live DB Mutation) ── */

interface MockRuleRow {
  id: string;
  name: string;
  target_kind: string;
  offset_days: number;
  channel: "telegram" | "email";
  min_amount: string | null;
  is_active: boolean;
}

interface MockPaymentInstanceRow {
  id: string;
  name: string;
  due_date: string;
  amount: string | null;
  paid_amount: string | null;
  legal_entity_id?: string | null;
  status: string;
  owner?: string | null;
  provider?: string | null;
  risk_reasons?: string[];
}

interface MockLoanInstallmentRow {
  id: string;
  installment_no: number;
  loan_name: string;
  due_date: string;
  amount: string | null;
  paid_amount: string | null;
  legal_entity_id?: string | null;
  status: string;
  provider: string | null;
}

interface MockDeliveryRow {
  id: string;
  reminder_id: string;
  entity_table: string;
  entity_id: string;
  scheduled_for: string;
  status: string;
  claim_token: string | null;
  claimed_at: Date | null;
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
  next_retry_at_sec_offset: number;
  last_error: string | null;
  legal_entity_id: string | null;
}

function createAgent06MockPool(seed: {
  rules?: MockRuleRow[];
  paymentInstances?: MockPaymentInstanceRow[];
  loanInstallments?: MockLoanInstallmentRow[];
  deliveries?: MockDeliveryRow[];
  nowMs?: () => number;
}) {
  const getNowMs = seed.nowMs ?? (() => Date.now());
  const rules = new Map<string, MockRuleRow>((seed.rules ?? []).map((r) => [r.id, { ...r }]));
  const payments = new Map<string, MockPaymentInstanceRow>(
    (seed.paymentInstances ?? []).map((p) => [p.id, { ...p }]),
  );
  const loans = new Map<string, MockLoanInstallmentRow>(
    (seed.loanInstallments ?? []).map((l) => [l.id, { ...l }]),
  );
  const deliveries = new Map<string, MockDeliveryRow>(
    (seed.deliveries ?? []).map((d) => [d.id, { ...d }]),
  );
  const outboxByKey = new Map<string, MockOutboxRow>();
  const lockedDeliveryIds = new Set<string>();
  const lockedOutboxIds = new Set<string>();

  function executeSql(
    rawSql: string,
    params: unknown[] = [],
    heldDelivery?: Set<string>,
    heldOutbox?: Set<string>,
  ): { rows: unknown[]; rowCount: number } {
    const sql = rawSql.replace(/\s+/g, " ").trim().toLowerCase();

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

    if (sql.includes("insert into public.audit_logs")) {
      return { rows: [{ id: randomUUID() }], rowCount: 1 };
    }

    // Rule count query in ensureDefaultMaturityRules
    if (sql.includes("select target_kind, count(*)::int as n from public.reminders")) {
      const counts = new Map<string, number>();
      for (const r of rules.values()) {
        counts.set(r.target_kind, (counts.get(r.target_kind) ?? 0) + 1);
      }
      const rows = [...counts.entries()].map(([target_kind, n]) => ({ target_kind, n }));
      return { rows, rowCount: rows.length };
    }

    // Insert reminder rule
    if (sql.startsWith("insert into public.reminders")) {
      const name = String(params[0]);
      const targetKind = String(params[1]);
      const offsetDays = Number(params[2]);
      const channel: "telegram" | "email" =
        params.length >= 4 && params[3] === "email" ? "email" : "telegram";
      const dup = [...rules.values()].find(
        (r) =>
          r.target_kind === targetKind &&
          r.offset_days === offsetDays &&
          r.channel === channel,
      );
      if (dup) return { rows: [], rowCount: 0 };
      const id = randomUUID();
      rules.set(id, {
        id,
        name,
        target_kind: targetKind,
        offset_days: offsetDays,
        channel,
        min_amount: null,
        is_active: true,
      });
      return { rows: [{ id }], rowCount: 1 };
    }

    // Select rules
    if (sql.includes("from public.reminders") && sql.startsWith("select")) {
      const rows = [...rules.values()].filter((r) =>
        sql.includes("where is_active = true") ? r.is_active : true,
      );
      return { rows, rowCount: rows.length };
    }

    // Payment instances loader
    if (sql.includes("from public.payment_instances")) {
      const open = [...payments.values()].filter((p) =>
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

    // Loan installments loader
    if (sql.includes("from public.loan_installments")) {
      const open = [...loans.values()].filter((li) =>
        ["planned", "unpaid", "partial", "late"].includes(li.status),
      );
      let filtered = open;
      if (sql.includes("any($1")) {
        const ids = new Set((params[0] as string[]) ?? []);
        filtered = open.filter((li) => ids.has(li.id));
      } else if (sql.includes("between ($1::date - $2::int) and ($1::date + $3::int)")) {
        const todayISO = String(params[0]);
        const lookback = Number(params[1]);
        const horizon = Number(params[2]);
        const minDate = addDaysISO(todayISO, -lookback);
        const maxDate = addDaysISO(todayISO, horizon);
        filtered = open.filter((li) => li.due_date >= minDate && li.due_date <= maxDate);
      }
      const rows = filtered.map((li) => {
        const origNum = li.amount == null ? null : Number(li.amount);
        const paidNum = li.paid_amount == null ? null : Number(li.paid_amount);
        const rem =
          li.status === "partial" && origNum != null && paidNum != null
            ? String(Math.max(origNum - paidNum, 0))
            : li.amount;
        return {
          id: li.id,
          name: `${li.loan_name} (Taksit #${li.installment_no})`,
          due_date: li.due_date,
          amount: rem,
          original_amount: li.amount,
          paid_amount: li.paid_amount,
          legal_entity_id: li.legal_entity_id ?? null,
          status: li.status,
          provider: li.provider,
        };
      });
      return { rows, rowCount: rows.length };
    }

    if (
      sql.includes("from public.invoices") ||
      sql.includes("from public.promise_to_pay") ||
      sql.includes("from public.checks") ||
      sql.includes("from public.covenant_records") ||
      sql.includes("from cov_due")
    ) {
      return { rows: [], rowCount: 0 };
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

    // Stale 'claiming' recovery (> 10 minutes)
    if (
      sql.startsWith("update public.reminder_deliveries") &&
      sql.includes("where status = 'claiming'") &&
      !sql.includes("returning")
    ) {
      const tenMinAgo = getNowMs() - 10 * 60 * 1_000;
      let recovered = 0;
      for (const d of deliveries.values()) {
        if (d.status === "claiming" && d.claimed_at && d.claimed_at.getTime() < tenMinAgo) {
          d.status = "pending";
          d.claim_token = null;
          d.claimed_at = null;
          recovered += 1;
        }
      }
      return { rows: [], rowCount: recovered };
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
        d.claimed_at = new Date(getNowMs());
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

    // Finalize reminder_deliveries status
    if (sql.startsWith("update public.reminder_deliveries")) {
      const id = String(params[0]);
      const d = deliveries.get(id);
      if (!d) return { rows: [], rowCount: 0 };
      if (d.status !== "pending" && d.status !== "claiming") {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes("claim_token =") && d.claim_token) {
        const tokenMatched = params.some(
          (p, idx) => idx > 0 && typeof p === "string" && p === d.claim_token,
        );
        if (!tokenMatched) return { rows: [], rowCount: 0 };
      }
      if (sql.includes("set status = 'sent'")) {
        d.status = "sent";
        d.error = null;
        d.claim_token = null;
        if (params[1] && typeof params[1] === "string" && sql.includes("payload = $2::jsonb")) {
          d.payload = JSON.parse(params[1]) as Record<string, unknown>;
        }
      } else {
        d.status = String(params[1]);
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
        if (
          sql.includes("delivery_uncertain") &&
          o.status !== "sent" &&
          o.status !== "delivery_uncertain" &&
          o.status !== "claiming"
        ) {
          continue;
        }
        if (sql.includes("status = 'sent'") && o.status !== "sent") continue;
        rows.push({ id: o.id, idempotency_key: o.idempotency_key, status: o.status });
      }
      return { rows, rowCount: rows.length };
    }

    // Outbox insert
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
        attempt_count: 0,
        max_attempts: Number(maxAttempts ?? 5),
        next_retry_at_sec_offset: 0,
        last_error: null,
        legal_entity_id: legalEntityId ?? null,
      });
      return { rows: [{ id }], rowCount: 1 };
    }

    // Outbox atomic claim (claimAndDispatchOutbox)
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
        if (o.next_retry_at_sec_offset > 0) continue;
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
        target.status =
          target.attempt_count + 1 >= target.max_attempts ? "dead_letter" : "failed_retryable";
      }
      if (sql.includes("next_retry_at = now() + ($5::int")) {
        target.next_retry_at_sec_offset = Number(params[4] ?? 0);
      } else if (sql.includes("next_retry_at = now() + ($3::int")) {
        target.next_retry_at_sec_offset = Number(params[2] ?? 0);
      }
      target.attempt_count += 1;
      target.claim_token = null;
      return { rows: [{ id: target.id }], rowCount: 1 };
    }

    throw new Error(`Unexpected SQL in Agent 06 mock pool: ${rawSql}`);
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

  return { pool, rules, payments, loans, deliveries, outboxByKey };
}

describe("Agent 06 — Telegram Notification Engine, Atomic Claiming & Idempotency (Phase E)", () => {
  it("1. deduplicates repeated processing of the same event (0 duplicates) and binds durable Contract C identity fields", async () => {
    const asOf = "2026-11-18";
    const entityId = "06060606-0001-4000-8000-000000000001";

    // Durable key stability across identical state vs sensitivity to legalEntityId / stateVersion
    const baseParts = [
      "telegram",
      "entity-hq",
      "loan_installments",
      entityId,
      "rule-li-31",
      "overdue_30_plus",
      "2026-10-02",
      "2026-09-01:late:50000.00",
    ] as const;
    const key1 = computeNotificationIdempotencyKey(baseParts);
    const key2 = computeNotificationIdempotencyKey(baseParts);
    const keyDifferentTenant = computeNotificationIdempotencyKey([
      "telegram",
      "entity-subsidiary-b",
      "loan_installments",
      entityId,
      "rule-li-31",
      "overdue_30_plus",
      "2026-10-02",
      "2026-09-01:late:50000.00",
    ]);
    const keyDifferentStateVersion = computeNotificationIdempotencyKey([
      "telegram",
      "entity-hq",
      "loan_installments",
      entityId,
      "rule-li-31",
      "overdue_30_plus",
      "2026-10-02",
      "2026-09-01:partial:20000.00",
    ]);
    expect(key1).toBe(key2);
    expect(key1).not.toBe(keyDifferentTenant);
    expect(key1).not.toBe(keyDifferentStateVersion);

    const { pool, deliveries } = createAgent06MockPool({
      rules: [
        {
          id: "rule-li-31",
          name: "31+ Gün Üst Eskalasyon (İç İnceleme)",
          target_kind: "loan_installment",
          offset_days: -31,
          channel: "telegram",
          min_amount: null,
          is_active: true,
        },
      ],
      loanInstallments: [
        {
          id: entityId,
          installment_no: 4,
          loan_name: "Vakıfbank Yatırım Kredisi",
          due_date: "2026-09-01",
          amount: "50000.00",
          paid_amount: "0.00",
          legal_entity_id: "aaaaaaaa-aaaa-4aaa-8aaa-000000000001",
          status: "late",
          provider: "Vakıfbank",
        },
      ],
    });

    const transport = mockTransport();

    const s1 = await scheduleReminders(pool, asOf);
    const d1 = await dispatchPending(pool, transport, asOf);
    expect(s1.inserted).toBe(1);
    expect(d1.sent).toBe(1);
    expect(transport.sent).toHaveLength(1);

    // Re-running schedule + dispatch on same event produces 0 duplicates
    const s2 = await scheduleReminders(pool, asOf);
    const d2 = await dispatchPending(pool, transport, asOf);
    expect(s2.inserted).toBe(0);
    expect(s2.duplicatesSkipped).toBe(1);
    expect(d2.sent).toBe(0);
    expect(transport.sent).toHaveLength(1);

    // Even if reminder_deliveries row is forcibly reset to 'pending', notification_outbox blocks duplicate send
    const deliveryRow = [...deliveries.values()][0]!;
    deliveryRow.status = "pending";
    const d3 = await dispatchPending(pool, transport, asOf);
    expect(d3.sent).toBe(0);
    expect(d3.skipped).toBe(1);
    expect(deliveryRow.status).toBe("skipped");
    expect(deliveryRow.error).toBe("deduped_by_outbox");
    expect(transport.sent).toHaveLength(1);
  });

  it("2. prevents duplicate sends when two concurrent workers call dispatchPending simultaneously (1 send total, 0 errors) and recovers stale claims", async () => {
    const clockMs = Date.parse("2026-11-18T09:00:00Z");
    const entityId = "06060606-0002-4000-8000-000000000002";
    const { pool, deliveries } = createAgent06MockPool({
      nowMs: () => clockMs,
      rules: [
        {
          id: "rule-li-8",
          name: "8–30 Gün gecikmiş kredi taksiti ihtarı",
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
          loan_name: "İş Bankası Rotatif Kredi",
          due_date: "2026-11-05",
          amount: "95000.00",
          paid_amount: "0.00",
          status: "late",
          provider: "İş Bankası",
        },
      ],
      deliveries: [
        {
          id: "deliv-race-1",
          reminder_id: "rule-li-8",
          entity_table: "loan_installments",
          entity_id: entityId,
          scheduled_for: "2026-11-13",
          status: "pending",
          claim_token: null,
          claimed_at: null,
          payload: { message: "seed" },
          error: null,
        },
      ],
    });

    const outboundMessages: string[] = [];
    const slowTransport: Transport = {
      channel: "telegram",
      async send(msg: string): Promise<DeliveryResult> {
        await new Promise((r) => setTimeout(r, 25));
        outboundMessages.push(msg);
        return { ok: true, providerMessageIds: ["5001"] };
      },
    };

    const [workerA, workerB] = await Promise.allSettled([
      dispatchPending(pool, slowTransport, "2026-11-18"),
      dispatchPending(pool, slowTransport, "2026-11-18"),
    ]);

    expect(workerA.status).toBe("fulfilled");
    expect(workerB.status).toBe("fulfilled");
    expect(outboundMessages).toHaveLength(1);

    const totalSent =
      (workerA.status === "fulfilled" ? workerA.value.sent : 0) +
      (workerB.status === "fulfilled" ? workerB.value.sent : 0);
    expect(totalSent).toBe(1);
    expect(deliveries.get("deliv-race-1")?.status).toBe("sent");

    // Verify stale 'claiming' recovery (> 10 minutes crashed worker)
    const staleEntityId = "06060606-0002-4000-8000-000000000099";
    const staleCtx = createAgent06MockPool({
      nowMs: () => clockMs,
      rules: [
        {
          id: "rule-li-8",
          name: "8–30 Gün gecikmiş kredi taksiti ihtarı",
          target_kind: "loan_installment",
          offset_days: -8,
          channel: "telegram",
          min_amount: null,
          is_active: true,
        },
      ],
      loanInstallments: [
        {
          id: staleEntityId,
          installment_no: 7,
          loan_name: "Garanti Taksit",
          due_date: "2026-11-04",
          amount: "40000.00",
          paid_amount: "0.00",
          status: "late",
          provider: "Garanti",
        },
      ],
      deliveries: [
        {
          id: "deliv-stale-claim",
          reminder_id: "rule-li-8",
          entity_table: "loan_installments",
          entity_id: staleEntityId,
          scheduled_for: "2026-11-12",
          status: "claiming",
          claim_token: randomUUID(),
          claimed_at: new Date(clockMs - 15 * 60 * 1_000), // 15 min ago -> stale
          payload: null,
          error: null,
        },
      ],
    });

    const recoveredTransport = mockTransport();
    const recRes = await dispatchPending(staleCtx.pool, recoveredTransport, "2026-11-18");
    expect(recRes.sent).toBe(1);
    expect(recoveredTransport.sent).toHaveLength(1);
  });

  it("3. classifies post-send TimeoutError as uncertainOutcome: true ('delivery_uncertain') and blocks blind automatic resend on next tick", async () => {
    let httpAttempts = 0;
    const timeoutFetch: typeof fetch = (async () => {
      httpAttempts += 1;
      throw Object.assign(new Error("The operation was aborted due to timeout"), {
        name: "TimeoutError",
      });
    }) as typeof fetch;

    const directTimeout = await sendTelegramChatMessage("-100123456", "Kritik Nakit Uyarısı", {
      token: "999888:SECRET_BOT_TOKEN_ABC",
      allowedChatIds: ["-100123456"],
      fetchImpl: timeoutFetch,
    });
    expect(directTimeout.ok).toBe(false);
    expect(directTimeout.uncertainOutcome).toBe(true);
    expect(directTimeout.failureKind).toBe("timeout");
    expect(directTimeout.error).not.toContain("SECRET_BOT_TOKEN_ABC");

    // End-to-end through dispatchPending: marks both reminder_deliveries & notification_outbox 'delivery_uncertain'
    httpAttempts = 0;
    const entityId = "06060606-0003-4000-8000-000000000003";
    const { pool, deliveries, outboxByKey } = createAgent06MockPool({
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
      paymentInstances: [
        {
          id: entityId,
          name: "SGK Cari Ay Ödemesi",
          due_date: "2026-11-18",
          amount: "145000.00",
          paid_amount: "0.00",
          status: "unpaid",
          provider: "SGK",
        },
      ],
    });

    const tgTransport: Transport = {
      channel: "telegram",
      send: (msg) =>
        sendTelegramChatMessage("-100123456", msg, {
          token: "999888:SECRET_BOT_TOKEN_ABC",
          allowedChatIds: ["-100123456"],
          fetchImpl: timeoutFetch,
        }),
    };

    await scheduleReminders(pool, "2026-11-18");
    const tick1 = await dispatchPending(pool, tgTransport, "2026-11-18");
    expect(httpAttempts).toBe(1);
    expect(tick1.sent).toBe(0);
    expect(tick1.uncertain).toBe(1);

    const deliv = [...deliveries.values()][0]!;
    expect(deliv.status).toBe("delivery_uncertain");
    const outboxRow = [...outboxByKey.values()][0]!;
    expect(outboxRow.status).toBe("delivery_uncertain");

    // Next cron tick MUST NOT blindly re-send an uncertain delivery!
    await scheduleReminders(pool, "2026-11-18");
    const tick2 = await dispatchPending(pool, tgTransport, "2026-11-18");
    expect(tick2.sent).toBe(0);
    expect(httpAttempts).toBe(1);

    // Even if a duplicate pending row were inserted, outbox 'delivery_uncertain' holds it back
    deliveries.set("forced-retry-row", {
      ...deliv,
      id: "forced-retry-row",
      status: "pending",
      claim_token: null,
    });
    const tick3 = await dispatchPending(pool, tgTransport, "2026-11-18");
    expect(tick3.sent).toBe(0);
    expect(tick3.skipped).toBe(1);
    expect(httpAttempts).toBe(1);
  });

  it("4. parses Telegram HTTP 429 retry_after from JSON body or Retry-After header and honors backoff in outbox", async () => {
    const fetch429Json: typeof fetch = (async () =>
      new Response(
        JSON.stringify({
          ok: false,
          error_code: 429,
          description: "Too Many Requests: retry after 17",
          parameters: { retry_after: 17 },
        }),
        { status: 429, headers: { "content-type": "application/json" } },
      )) as typeof fetch;

    const json429 = await sendTelegramChatMessage("-100111", "Test 429 JSON", {
      token: "123:TEST_TOKEN",
      allowedChatIds: ["-100111"],
      fetchImpl: fetch429Json,
    });
    expect(json429.ok).toBe(false);
    expect(json429.failureKind).toBe("rate_limited");
    expect(json429.retryAfterSeconds).toBe(17);
    expect(json429.uncertainOutcome).toBe(false);

    const fetch429Header: typeof fetch = (async () =>
      new Response("Too Many Requests", {
        status: 429,
        headers: { "retry-after": "45" },
      })) as typeof fetch;

    const header429 = await sendTelegramChatMessage("-100111", "Test 429 Header", {
      token: "123:TEST_TOKEN",
      allowedChatIds: ["-100111"],
      fetchImpl: fetch429Header,
    });
    expect(header429.ok).toBe(false);
    expect(header429.failureKind).toBe("rate_limited");
    expect(header429.retryAfterSeconds).toBe(45);

    // Outbox honors larger retry_after (e.g. 90s > 30s initial backoff)
    const { pool, outboxByKey } = createAgent06MockPool({});
    outboxByKey.set("rate-limit-key-1", {
      id: "outbox-429-1",
      stream: "ops_incident",
      channel: "telegram",
      recipient_target: "-100111",
      idempotency_key: "rate-limit-key-1",
      subject: null,
      body_text: "Uyarı",
      body_format: "plain",
      metadata: {},
      status: "pending",
      claim_token: null,
      attempt_count: 0,
      max_attempts: 5,
      next_retry_at_sec_offset: 0,
      last_error: null,
      legal_entity_id: null,
    });

    const outboxSummary = await claimAndDispatchOutbox(pool, {
      transportResolver: () => ({
        channel: "telegram",
        send: async () => ({
          ok: false,
          failureKind: "rate_limited",
          retryAfterSeconds: 90,
          uncertainOutcome: false,
          error: "telegram HTTP 429",
        }),
      }),
    });
    expect(outboxSummary.retried).toBe(1);
    expect(outboxByKey.get("rate-limit-key-1")?.status).toBe("failed_retryable");
    expect(outboxByKey.get("rate-limit-key-1")?.next_retry_at_sec_offset).toBe(90);
  });

  it("5. captures provider message_id on accepted Telegram 200 OK responses across single and multi-chunk sends", async () => {
    let nextMessageId = 88001;
    const okFetch: typeof fetch = (async () =>
      new Response(
        JSON.stringify({
          ok: true,
          result: { message_id: nextMessageId++ },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as typeof fetch;

    const single = await sendTelegramChatMessage("-100111", "Kısa onaylı mesaj", {
      token: "123:TEST_TOKEN",
      allowedChatIds: ["-100111"],
      fetchImpl: okFetch,
    });
    expect(single.ok).toBe(true);
    expect(single.failureKind).toBe("success");
    expect(single.uncertainOutcome).toBe(false);
    expect(single.providerMessageIds).toEqual(["88001"]);

    const multi = await sendTelegramChatMessage(
      "-100111",
      `${"X".repeat(70)}\n${"Y".repeat(70)}`,
      {
        token: "123:TEST_TOKEN",
        allowedChatIds: ["-100111"],
        maxLen: 100,
        fetchImpl: okFetch,
      },
    );
    expect(multi.ok).toBe(true);
    expect(multi.providerMessageIds).toEqual(["88002", "88003"]);
  });

  it("6. flags multi-chunk partial batch failure (chunk 1 -> 200, chunk 2 -> 502) as uncertainOutcome: true while keeping chunk-1 failure retryable", async () => {
    let callIdx = 0;
    const partial502Fetch: typeof fetch = (async () => {
      callIdx += 1;
      if (callIdx === 1) {
        return new Response(
          JSON.stringify({ ok: true, result: { message_id: 7701 } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("Bad Gateway", { status: 502 });
    }) as typeof fetch;

    const partialOutcome = await sendTelegramChatMessage(
      "-100111",
      `${"A".repeat(80)}\n${"B".repeat(80)}`,
      {
        token: "123:TEST_TOKEN",
        allowedChatIds: ["-100111"],
        maxLen: 100,
        fetchImpl: partial502Fetch,
      },
    );
    expect(partialOutcome.ok).toBe(false);
    expect(partialOutcome.uncertainOutcome).toBe(true);
    expect(partialOutcome.failureKind).toBe("temporary_infra_failure");
    expect(partialOutcome.providerMessageIds).toEqual(["7701"]);

    // Contrast: immediate 502 on chunk 1 (0 chunks delivered) -> uncertainOutcome: false
    const firstChunk502 = await sendTelegramChatMessage("-100111", "Tek parça", {
      token: "123:TEST_TOKEN",
      allowedChatIds: ["-100111"],
      fetchImpl: (async () => new Response("Bad Gateway", { status: 502 })) as typeof fetch,
    });
    expect(firstChunk502.ok).toBe(false);
    expect(firstChunk502.uncertainOutcome).toBe(false);
    expect(firstChunk502.failureKind).toBe("temporary_infra_failure");
    expect(firstChunk502.providerMessageIds).toEqual([]);
  });

  it("7. emits intentional new notifications on OVERDUE_1_7 -> OVERDUE_8_30 -> OVERDUE_31_PLUS transitions, deduplicates steady-stage runs, supports >365-day lookback, and preserves partial-payment amounts", async () => {
    const { pool, rules, payments } = createAgent06MockPool({});

    // Seed default maturity rules and verify 31+ naming (zero '30+' and zero 'hukuki')
    const seededCount = await ensureDefaultMaturityRules(pool, "00000000-0000-4000-8000-000000000001");
    expect(seededCount).toBeGreaterThan(0);
    const minus31Rules = [...rules.values()].filter((r) => r.offset_days === -31);
    expect(minus31Rules.length).toBeGreaterThanOrEqual(4);
    for (const r of minus31Rules) {
      expect(r.name).toContain("31+");
      expect(r.name).not.toContain("30+");
      expect(r.name.toLocaleLowerCase("tr-TR")).not.toContain("hukuki");
    }

    // Add a partially paid obligation (original 30,000, paid 12,000 -> 18,000 remaining, due 2026-10-01)
    const payId = "0fbd2b5b-0a12-41b5-9bbe-23c8d079f03d";
    payments.set(payId, {
      id: payId,
      name: "VAKIF KREDİ 2",
      due_date: "2026-10-01",
      amount: "30000.00",
      paid_amount: "12000.00",
      status: "partial",
      provider: "Vakıfbank",
      risk_reasons: ["overdue"],
    });

    const loaded = await loadPaymentTargets(pool, "2026-10-03");
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.originalAmount).toBe(30_000);
    expect(loaded[0]!.paidAmount).toBe(12_000);
    expect(loaded[0]!.outstandingAmount).toBe(18_000);

    const transport = mockTransport();

    // Stage 1: Day +2 (2026-10-03) -> enters OVERDUE_1_7 (1 message with partial breakdown)
    const dec1 = evaluateEscalationDecision({
      obligationId: payId,
      entityTable: "payment_instances",
      dueDateISO: "2026-10-01",
      asOfDateISO: "2026-10-03",
      status: "partial",
    });
    expect(dec1.currentStage).toBe("OVERDUE_1_7");

    await scheduleReminders(pool, "2026-10-03");
    const dStage1 = await dispatchPending(pool, transport, "2026-10-03");
    expect(dStage1.sent).toBe(1);
    expect(transport.sent).toHaveLength(1);
    expect(transport.sent[0]).toContain("1-7 Gün Gecikmiş");
    expect(transport.sent[0]).toContain("18.000 TL");
    expect(transport.sent[0]).toContain("30.000 TL");
    expect(transport.sent[0]).toContain("12.000 TL");

    // Steady in OVERDUE_1_7 on Day +5 (2026-10-06) -> 0 duplicate messages
    await scheduleReminders(pool, "2026-10-06");
    const dSteady1 = await dispatchPending(pool, transport, "2026-10-06");
    expect(dSteady1.sent).toBe(0);
    expect(transport.sent).toHaveLength(1);

    // Stage 2: Day +8 (2026-10-09) -> transitions to OVERDUE_8_30 -> emits 1 new stage message
    const dec8 = evaluateEscalationDecision({
      obligationId: payId,
      entityTable: "payment_instances",
      dueDateISO: "2026-10-01",
      asOfDateISO: "2026-10-09",
      status: "partial",
    });
    expect(dec8.currentStage).toBe("OVERDUE_8_30");
    expect(dec8.transitionReason).toBe("escalated_to_8_30");

    await scheduleReminders(pool, "2026-10-09");
    const dStage2 = await dispatchPending(pool, transport, "2026-10-09");
    expect(dStage2.sent).toBe(1);
    expect(transport.sent).toHaveLength(2);
    expect(transport.sent[1]).toContain("8-30 Gün İhtar");

    // Steady in OVERDUE_8_30 on Day +30 (2026-10-31) -> 0 duplicate messages
    await scheduleReminders(pool, "2026-10-31");
    const dSteady2 = await dispatchPending(pool, transport, "2026-10-31");
    expect(dSteady2.sent).toBe(0);
    expect(transport.sent).toHaveLength(2);

    // Stage 3: Day +31 (2026-11-01) -> transitions to OVERDUE_31_PLUS -> emits 1 new stage message
    const dec31 = evaluateEscalationDecision({
      obligationId: payId,
      entityTable: "payment_instances",
      dueDateISO: "2026-10-01",
      asOfDateISO: "2026-11-01",
      status: "partial",
    });
    expect(dec31.currentStage).toBe("OVERDUE_31_PLUS");
    expect(dec31.transitionReason).toBe("escalated_to_31_plus");

    await scheduleReminders(pool, "2026-11-01");
    const dStage3 = await dispatchPending(pool, transport, "2026-11-01");
    expect(dStage3.sent).toBe(1);
    expect(transport.sent).toHaveLength(3);
    expect(transport.sent[2]).toContain("31+ Gün Üst Eskalasyon (İç İnceleme)");
    expect(transport.sent[2]!.toLocaleLowerCase("tr-TR")).not.toContain("hukuki eskalasyon");

    // Steady in OVERDUE_31_PLUS at Day +400 (2027-11-05, >365 days!) -> still tracked (eligible=1), 0 duplicates!
    const s400 = await scheduleReminders(pool, "2027-11-05");
    const d400 = await dispatchPending(pool, transport, "2027-11-05");
    expect(s400.eligible).toBe(1);
    expect(s400.inserted).toBe(0);
    expect(d400.sent).toBe(0);
    expect(transport.sent).toHaveLength(3);
  });

  it("8. cleanly escapes &, <, >, preserves [P1], translates missing_amount, and scrubs IBANs and bot/bearer tokens", async () => {
    const raw = "[P1] Garanti & Akbank <Rotatif Kredi>";
    const escaped = escapeTelegramHtml(raw);
    expect(escaped).toBe("[P1] Garanti &amp; Akbank &lt;Rotatif Kredi&gt;");
    expect(escaped).not.toContain("&#91;");
    expect(escaped).not.toContain("&#93;");
    expect(escaped).not.toContain("&amp;amp;");

    const sensitive =
      "Hesap TR33 0006 1005 1978 6457 8413 26 · url=https://api.telegram.org/bot777111:AAH_SecretKey99/sendMessage · Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.secret";
    const scrubbed = scrubSensitiveTelegramText(sensitive);
    expect(scrubbed).toContain("TR** **** **** **** **** **26");
    expect(scrubbed).not.toContain("1978 6457");
    expect(scrubbed).toContain("bot[REDACTED]");
    expect(scrubbed).not.toContain("AAH_SecretKey99");
    expect(scrubbed).toContain("Bearer [REDACTED]");
    expect(scrubbed).not.toContain("eyJhbGciOiJIUzI1NiJ9.secret");
    expect(redactBotToken(sensitive)).not.toContain("AAH_SecretKey99");

    const rule: ReminderRule = {
      id: "r-due-0",
      name: "Bugün Ödeme",
      targetKind: "payment_instance",
      offsetDays: 0,
      channel: "telegram",
      minAmount: null,
      isActive: true,
    };
    const target: ReminderTarget = {
      entityTable: "payment_instances",
      entityId: "pi-clean-1",
      name: "[P1] Enerjisa & Başkent Elektrik TR33 0006 1005 1978 6457 8413 26",
      dueDate: "2026-11-18",
      amount: null,
      status: "unpaid",
      owner: null,
      provider: "Enerjisa",
      riskReasons: ["missing_amount", "critical_payment"],
    };

    const rendered = buildReminderMessage(rule, target, "2026-11-18");
    expect(rendered).toContain("[P1]");
    expect(rendered).toContain("tutar: tutar eksik");
    expect(rendered).not.toContain("tutar: 0 TL");
    expect(rendered).toContain("Tutar eksik, Kritik ödeme");
    expect(rendered).not.toContain("missing_amount");
    expect(rendered).not.toContain("missing\\_amount");
    expect(rendered).toContain("TR** **** **** **** **** **26");

    // Unauthorized chatId blocked before any HTTP call with permission_failure
    let networkCalls = 0;
    const blocked = await sendTelegramChatMessage("-100999888", rendered, {
      token: "123:TEST_TOKEN",
      allowedChatIds: ["-100111222"],
      fetchImpl: (async () => {
        networkCalls += 1;
        return new Response("{}", { status: 200 });
      }) as typeof fetch,
    });
    expect(blocked.ok).toBe(false);
    expect(blocked.uncertainOutcome).toBe(false);
    expect(blocked.failureKind).toBe("permission_failure");
    expect(networkCalls).toBe(0);
  });

  it("9. consolidates a large overdue set (92 items) into <= 1 digest summary in dispatchPending and splits >3900-char HTML tag-safely", async () => {
    const asOf = "2026-11-18";
    const paymentSeeds: MockPaymentInstanceRow[] = Array.from({ length: 92 }, (_, idx) => {
      const overdueDays = (idx % 60) + 1;
      const dueDate = addDaysISO(asOf, -overdueDays);
      const isMissing = idx % 10 === 0;
      const isPartial = !isMissing && idx % 7 === 0;
      return {
        id: `06060606-0092-4000-8000-${String(idx + 1).padStart(12, "0")}`,
        name: `[P1] Tedarikçi & Cari Kalem <No #${idx + 1}>`,
        due_date: dueDate,
        amount: isMissing ? null : "30000.00",
        paid_amount: isPartial ? "10000.00" : "0.00",
        status: isPartial ? "partial" : "late",
        provider: "MAS Tedarik",
        risk_reasons: isMissing ? ["missing_amount"] : ["overdue"],
      };
    });

    const { pool } = createAgent06MockPool({
      rules: [
        {
          id: "r-pay-1",
          name: "1–7 Gün gecikmiş ödeme kontrolü",
          target_kind: "payment_instance",
          offset_days: -1,
          channel: "telegram",
          min_amount: null,
          is_active: true,
        },
        {
          id: "r-pay-8",
          name: "8–30 Gün gecikmiş ödeme ihtarı",
          target_kind: "payment_instance",
          offset_days: -8,
          channel: "telegram",
          min_amount: null,
          is_active: true,
        },
        {
          id: "r-pay-31",
          name: "31+ Gün gecikmiş ödeme üst eskalasyon (iç inceleme)",
          target_kind: "payment_instance",
          offset_days: -31,
          channel: "telegram",
          min_amount: null,
          is_active: true,
        },
      ],
      paymentInstances: paymentSeeds,
    });

    const scheduled = await scheduleReminders(pool, asOf);
    expect(scheduled.eligible).toBe(92);
    expect(scheduled.inserted).toBe(92);

    const transportCalls: Array<{ message: string; parseMode?: string }> = [];
    const digestTransport: Transport = {
      channel: "telegram",
      async send(message, opts) {
        transportCalls.push({ message, parseMode: opts?.parseMode });
        return { ok: true, providerMessageIds: ["99001"] };
      },
    };

    const dispatched = await dispatchPending(pool, digestTransport, asOf);
    expect(dispatched.sent).toBe(92);
    // All 92 simultaneous overdue items consolidated into <= 1 outbound transport dispatch!
    expect(transportCalls).toHaveLength(1);
    expect(transportCalls[0]!.parseMode).toBe("HTML");
    expect(transportCalls[0]!.message).toContain("Toplam: <b>92</b> kalem");
    expect(transportCalls[0]!.message).toContain("tutar eksik:");
    expect(transportCalls[0]!.message).not.toContain("&#91;");
    expect(transportCalls[0]!.message).not.toContain("&amp;amp;");

    // Verify expanded 92-item HTML digest (> 3900 chars) splits tag-safely via splitTelegramHtmlMessage & sendTelegramChatMessage
    const digestItems: ReminderDigestItem[] = paymentSeeds.map((p) => ({
      entityTable: "payment_instances",
      entityId: p.id,
      name: p.name,
      dueDate: p.due_date,
      amount: p.amount == null ? null : Number(p.amount),
      originalAmount: p.amount == null ? null : Number(p.amount),
      paidAmount: p.paid_amount == null ? null : Number(p.paid_amount),
      status: p.status,
      provider: p.provider,
      riskReasons: p.risk_reasons,
    }));
    const full92Html = buildReminderDigestHtml(digestItems, asOf, { maxItemsPerTier: 50 });
    expect(full92Html.length).toBeGreaterThan(TELEGRAM_HTML_SAFE_MAX_CHARS);

    const htmlChunks = splitTelegramHtmlMessage(full92Html);
    expect(htmlChunks.length).toBeGreaterThanOrEqual(2);

    const sentPayloads: string[] = [];
    let msgSeq = 300;
    const sendRes = await sendTelegramChatMessage("-100111", full92Html, {
      token: "123:TEST_TOKEN",
      allowedChatIds: ["-100111"],
      parseMode: "HTML",
      fetchImpl: (async (_url, init) => {
        const body = JSON.parse(String(init?.body)) as { text: string; parse_mode?: string };
        expect(body.parse_mode).toBe("HTML");
        sentPayloads.push(body.text);
        return new Response(
          JSON.stringify({ ok: true, result: { message_id: ++msgSeq } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as typeof fetch,
    });

    expect(sendRes.ok).toBe(true);
    expect(sentPayloads.length).toBe(htmlChunks.length);
    for (const chunk of sentPayloads) {
      expect(chunk.length).toBeLessThanOrEqual(TELEGRAM_HTML_SAFE_MAX_CHARS);
      for (const tag of ["b", "i", "code", "pre"]) {
        const opens = (chunk.match(new RegExp(`<${tag}(?:\\s[^>]*)?>`, "g")) ?? []).length;
        const closes = (chunk.match(new RegExp(`</${tag}>`, "g")) ?? []).length;
        expect(opens).toBe(closes);
      }
      expect(chunk).not.toMatch(/<[^>]*$/);
    }
  });
});
