// Phase 6B reminder engine. Two deterministic steps, both financial-record read-only:
//   scheduleReminders — compute eligible (rule × instance) pairs for today and insert
//     reminder_deliveries as 'pending'. Duplicate prevention is DB-enforced
//     (unique(reminder_id, entity_table, entity_id, scheduled_for)) → re-run is idempotent.
//   dispatchPending — send each pending delivery via the injected Transport, then LOG
//     the outcome on the delivery row (status sent/failed, sent_at, error, payload).
// Reminders never mutate payments/instances/checks/loans. Telegram token stays server-side.

import type { Pool } from "pg";
import { istanbulDateISO } from "@/lib/reports/rules";
import {
  eligibleDeliveries,
  type ReminderRule,
  type ReminderTarget,
} from "./rules";
import type { Transport } from "./transport";

export async function loadActiveRules(pool: Pool): Promise<ReminderRule[]> {
  const r = await pool.query(
    `select id, name, target_kind, offset_days, channel, min_amount::float8 as min_amount, is_active
     from public.reminders where is_active = true`,
  );
  return r.rows.map((x) => ({
    id: x.id, name: x.name, targetKind: x.target_kind, offsetDays: x.offset_days,
    channel: x.channel, minAmount: x.min_amount, isActive: x.is_active,
  }));
}

/** payment_instance targets in a window around today (covers offsets 7..-1). */
export async function loadPaymentTargets(pool: Pool, todayISO: string): Promise<ReminderTarget[]> {
  const r = await pool.query(
    `select i.id, coalesce(p.name,'(silinmiş kalem)') as name,
            to_char(i.due_date,'YYYY-MM-DD') as due_date, i.amount::float8 as amount, i.status,
            po.name as owner, pr.name as provider, i.risk_reasons
     from public.payment_instances i
     left join public.payments p on p.id = i.payment_id
     left join public.parties po on po.id = p.owner_party_id
     left join public.parties pr on pr.id = p.provider_party_id
     where i.status in ('unpaid','partial')
       and i.due_date between ($1::date - 1) and ($1::date + 7)`,
    [todayISO],
  );
  return r.rows.map((x) => ({
    entityTable: "payment_instances", entityId: x.id, name: x.name,
    dueDate: x.due_date, amount: x.amount, status: x.status,
    owner: x.owner, provider: x.provider, riskReasons: x.risk_reasons ?? [],
  }));
}

export interface ScheduleResult {
  eligible: number;
  inserted: number;
  duplicatesSkipped: number;
}

export async function scheduleReminders(pool: Pool, todayISO = istanbulDateISO()): Promise<ScheduleResult> {
  const [rules, targets] = await Promise.all([
    loadActiveRules(pool),
    loadPaymentTargets(pool, todayISO),
  ]);
  const eligible = eligibleDeliveries(rules, targets, todayISO);
  let inserted = 0;
  const client = await pool.connect();
  try {
    await client.query("begin");
    for (const d of eligible) {
      const res = await client.query(
        `insert into public.reminder_deliveries
           (reminder_id, entity_table, entity_id, scheduled_for, status, payload)
         values ($1,$2,$3,$4,'pending',$5)
         on conflict (reminder_id, entity_table, entity_id, scheduled_for) do nothing`,
        [d.ruleId, d.entityTable, d.entityId, d.scheduledFor, JSON.stringify({ message: d.message })],
      );
      inserted += res.rowCount ?? 0;
    }
    await client.query("commit");
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
  return { eligible: eligible.length, inserted, duplicatesSkipped: eligible.length - inserted };
}

export interface DispatchResult {
  attempted: number;
  sent: number;
  failed: number;
}

/** Sends pending deliveries scheduled on/before today. Logs every attempt on the row. */
export async function dispatchPending(
  pool: Pool,
  transport: Transport,
  todayISO = istanbulDateISO(),
): Promise<DispatchResult> {
  const pending = await pool.query(
    `select id, payload from public.reminder_deliveries
     where status='pending' and scheduled_for <= $1 order by scheduled_for`,
    [todayISO],
  );
  let sent = 0, failed = 0;
  for (const row of pending.rows) {
    const message: string = row.payload?.message ?? "";
    let result;
    try {
      result = await transport.send(message);
    } catch (e) {
      result = { ok: false, error: `transport threw: ${(e as Error).message}` };
    }
    if (result.ok) {
      await pool.query(
        `update public.reminder_deliveries set status='sent', sent_at=now(), error=null where id=$1`,
        [row.id],
      );
      sent++;
    } else {
      // failed delivery is LOGGED, never thrown — stays retryable-visible
      await pool.query(
        `update public.reminder_deliveries set status='failed', error=$2 where id=$1`,
        [row.id, result.error ?? "bilinmeyen hata"],
      );
      failed++;
    }
  }
  return { attempted: pending.rows.length, sent, failed };
}

/* ── read-side for /reminders ── */

export async function loadDeliveries(pool: Pool) {
  const r = await pool.query(
    `select d.id, r.name as rule_name, r.offset_days, d.entity_table, d.entity_id,
            to_char(d.scheduled_for,'YYYY-MM-DD') as scheduled_for, d.status,
            to_char(d.sent_at at time zone 'Europe/Istanbul','YYYY-MM-DD HH24:MI') as sent_at,
            d.error, d.payload,
            coalesce(p.name, i.id::text) as target_name
     from public.reminder_deliveries d
     join public.reminders r on r.id = d.reminder_id
     left join public.payment_instances i on i.id = d.entity_id and d.entity_table='payment_instances'
     left join public.payments p on p.id = i.payment_id
     order by d.scheduled_for desc, d.status`,
  );
  return r.rows as Array<{
    id: string; rule_name: string; offset_days: number; entity_table: string; entity_id: string;
    scheduled_for: string; status: string; sent_at: string | null; error: string | null;
    payload: { message?: string } | null; target_name: string;
  }>;
}

export async function deliveryCounts(pool: Pool) {
  const r = await pool.query(
    `select status, count(*)::int as n from public.reminder_deliveries group by status`,
  );
  const m = new Map(r.rows.map((x) => [x.status, x.n]));
  return {
    pending: m.get("pending") ?? 0,
    sent: m.get("sent") ?? 0,
    failed: m.get("failed") ?? 0,
    skipped: m.get("skipped") ?? 0,
  };
}
