// Phase 6B, Faz 25, Faz 40 (A2) & Wave 5B (F-52) reminder engine.
// BOUNDARY INVARIANT: Never access process.env or fetch here (transport.ts owns egress).

import type { Pool } from "pg";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { DomainError } from "@/lib/domain-error";
import { moneyOrNull } from "@/lib/money";
import { istanbulDateISO } from "@/lib/reports/rules";
import { parseOrThrow } from "@/lib/validation";
import {
  buildReminderMessage,
  eligibleDeliveries,
  scheduledForDate,
  thresholdPasses,
  type EligibleDelivery,
  type ReminderRule,
  type ReminderTarget,
} from "./rules";
import {
  emailTransport,
  redactBotToken,
  transportFor,
  type DeliveryResult,
  type Transport,
} from "./transport";

export const CHECK_REMINDER_STATUSES: ReadonlySet<string> = new Set([
  "planned",
  "in_portfolio",
  "in_bank_collection",
  "in_bank_collateral",
  "issued_to_vendor",
]);

export const LOAN_INSTALLMENT_REMINDER_STATUSES: ReadonlySet<string> = new Set([
  "planned",
  "unpaid",
  "partial",
  "late",
]);

export async function loadActiveRules(pool: Pool): Promise<ReminderRule[]> {
  const r = await pool.query(
    `select id, name, target_kind, offset_days, channel, min_amount, is_active
     from public.reminders where is_active = true
     order by target_kind asc, offset_days desc, channel asc`,
  );
  return r.rows.map((x) => ({
    id: x.id, name: x.name, targetKind: x.target_kind, offsetDays: x.offset_days,
    channel: x.channel, minAmount: moneyOrNull(x.min_amount), isActive: x.is_active,
  }));
}

export async function loadAllRules(pool: Pool): Promise<ReminderRule[]> {
  const r = await pool.query(
    `select id, name, target_kind, offset_days, channel, min_amount, is_active
     from public.reminders
     order by is_active desc, target_kind asc, offset_days desc, channel asc`,
  );
  return r.rows.map((x) => ({
    id: x.id,
    name: x.name,
    targetKind: x.target_kind,
    offsetDays: Number(x.offset_days),
    channel: x.channel,
    minAmount: moneyOrNull(x.min_amount),
    isActive: Boolean(x.is_active),
  }));
}

const upsertReminderRuleSchema = z.object({
  id: z.string().uuid("Geçerli kural kimliği gerekli").nullable().optional(),
  name: z.string().trim().min(1, "Kural adı gerekli").max(160),
  targetKind: z.enum(["payment_instance", "check", "loan_installment", "invoice", "promise_to_pay"]),
  offsetDays: z.number().int("Gün farkı tam sayı olmalı").min(-365).max(365),
  channel: z.enum(["telegram", "email"]).default("telegram"),
  minAmount: z.number().nonnegative("Minimum tutar negatif olamaz").nullable().optional(),
  isActive: z.boolean().optional().default(true),
});

export async function upsertReminderRule(
  pool: Pool,
  raw: unknown,
  actorId: string,
): Promise<string> {
  const input = parseOrThrow(upsertReminderRuleSchema, raw, "Hatırlatma kuralı");
  const client = await pool.connect();
  try {
    await client.query("begin");
    let ruleId: string;
    if (input.id) {
      const dup = await client.query<{ id: string }>(
        `select id from public.reminders
          where target_kind = $1 and offset_days = $2 and channel = $3 and id <> $4
          limit 1`,
        [input.targetKind, input.offsetDays, input.channel, input.id],
      );
      if ((dup.rowCount ?? 0) > 0) {
        throw new DomainError(
          "CONFLICT",
          "Aynı hedef türü, gün farkı ve kanal kombinasyonu için zaten başka bir kural mevcut.",
        );
      }
      const upd = await client.query<{ id: string }>(
        `update public.reminders
            set name = $2,
                target_kind = $3,
                offset_days = $4,
                channel = $5,
                min_amount = $6,
                is_active = $7
          where id = $1
          returning id`,
        [
          input.id,
          input.name,
          input.targetKind,
          input.offsetDays,
          input.channel,
          input.minAmount ?? null,
          input.isActive,
        ],
      );
      if ((upd.rowCount ?? 0) === 0) {
        throw new DomainError("NOT_FOUND", "Güncellenecek hatırlatma kuralı bulunamadı.");
      }
      ruleId = upd.rows[0].id;
    } else {
      const ins = await client.query<{ id: string }>(
        `insert into public.reminders
           (name, target_kind, offset_days, channel, min_amount, is_active)
         values ($1, $2, $3, $4, $5, $6)
         on conflict (target_kind, offset_days, channel) do update
           set name = excluded.name,
               min_amount = excluded.min_amount,
               is_active = excluded.is_active
         returning id`,
        [
          input.name,
          input.targetKind,
          input.offsetDays,
          input.channel,
          input.minAmount ?? null,
          input.isActive,
        ],
      );
      ruleId = ins.rows[0].id;
    }

    await audit(client, {
      actor: actorId,
      action: "upsert_reminder_rule",
      entityTable: "reminders",
      entityId: ruleId,
      after: {
        name: input.name,
        target_kind: input.targetKind,
        offset_days: input.offsetDays,
        channel: input.channel,
        min_amount: input.minAmount ?? null,
        is_active: input.isActive,
      },
    });
    await client.query("commit");
    return ruleId;
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

const toggleReminderRuleSchema = z.object({
  id: z.string().uuid("Geçerli kural kimliği gerekli"),
  isActive: z.boolean().optional(),
});

export async function toggleReminderRule(
  pool: Pool,
  raw: unknown,
  actorId: string,
): Promise<{ id: string; isActive: boolean }> {
  const input = parseOrThrow(toggleReminderRuleSchema, raw, "Hatırlatma kural durumu");
  const client = await pool.connect();
  try {
    await client.query("begin");
    const upd = await client.query<{ id: string; is_active: boolean }>(
      `update public.reminders
          set is_active = coalesce($2::boolean, not is_active)
        where id = $1
        returning id, is_active`,
      [input.id, input.isActive ?? null],
    );
    if ((upd.rowCount ?? 0) === 0) {
      throw new DomainError("NOT_FOUND", "Hatırlatma kuralı bulunamadı.");
    }
    const row = upd.rows[0];
    await audit(client, {
      actor: actorId,
      action: "toggle_reminder_rule",
      entityTable: "reminders",
      entityId: row.id,
      after: { is_active: row.is_active },
    });
    await client.query("commit");
    return { id: row.id, isActive: Boolean(row.is_active) };
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

export async function ensureDefaultMaturityRules(pool: Pool, actorId?: string | null): Promise<number> {
  const existing = await pool.query<{ target_kind: string; n: number }>(
    `select target_kind, count(*)::int as n
       from public.reminders
      where target_kind in ('check', 'loan_installment')
      group by target_kind`,
  );
  const countByKind = new Map(existing.rows.map((r) => [r.target_kind, Number(r.n)]));
  const defaults: Array<{ name: string; targetKind: "check" | "loan_installment"; offsetDays: number }> = [];

  if ((countByKind.get("check") ?? 0) === 0) {
    defaults.push(
      { name: "Çek/Senet — 7 gün önce vade hazırlığı", targetKind: "check", offsetDays: 7 },
      { name: "Çek/Senet — 3 gün önce nakit/tahsilat kontrolü", targetKind: "check", offsetDays: 3 },
      { name: "Çek/Senet — 1 gün önce yarın vade", targetKind: "check", offsetDays: 1 },
      { name: "Çek/Senet — bugün vade günü", targetKind: "check", offsetDays: 0 },
      { name: "Çek/Senet — vadesi geçmiş kontrolü", targetKind: "check", offsetDays: -1 },
    );
  }
  if ((countByKind.get("loan_installment") ?? 0) === 0) {
    defaults.push(
      { name: "Kredi Taksiti — 7 gün önce hazırlık", targetKind: "loan_installment", offsetDays: 7 },
      { name: "Kredi Taksiti — 3 gün önce bakiye kontrolü", targetKind: "loan_installment", offsetDays: 3 },
      { name: "Kredi Taksiti — 1 gün önce yarın ödeme", targetKind: "loan_installment", offsetDays: 1 },
      { name: "Kredi Taksiti — bugün taksit günü", targetKind: "loan_installment", offsetDays: 0 },
      { name: "Kredi Taksiti — gecikmiş taksit uyarısı", targetKind: "loan_installment", offsetDays: -1 },
    );
  }
  if (defaults.length === 0) return 0;

  let created = 0;
  const client = await pool.connect();
  try {
    await client.query("begin");
    for (const d of defaults) {
      const ins = await client.query<{ id: string }>(
        `insert into public.reminders (name, target_kind, offset_days, channel, is_active)
         values ($1, $2, $3, 'telegram', true)
         on conflict (target_kind, offset_days, channel) do nothing
         returning id`,
        [d.name, d.targetKind, d.offsetDays],
      );
      if ((ins.rowCount ?? 0) > 0) {
        created++;
        if (actorId) {
          await audit(client, {
            actor: actorId,
            action: "seed_maturity_reminder_rule",
            entityTable: "reminders",
            entityId: ins.rows[0].id,
            after: { name: d.name, target_kind: d.targetKind, offset_days: d.offsetDays },
          });
        }
      }
    }
    await client.query("commit");
    return created;
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

export async function loadPaymentTargets(
  pool: Pool,
  todayISO: string,
  lookbackDays = 1,
  horizonDays = 7,
): Promise<ReminderTarget[]> {
  const r = await pool.query(
    `select i.id, coalesce(p.name,'(silinmiş kalem)') as name,
            to_char(i.due_date,'YYYY-MM-DD') as due_date, i.amount, i.status,
            po.name as owner, pr.name as provider, i.risk_reasons
     from public.payment_instances i
     left join public.payments p on p.id = i.payment_id
     left join public.parties po on po.id = p.owner_party_id
     left join public.parties pr on pr.id = p.provider_party_id
     where i.status in ('unpaid','partial')
       and i.due_date between ($1::date - $2::int) and ($1::date + $3::int)`,
    [todayISO, lookbackDays, horizonDays],
  );
  return r.rows.map((x) => ({
    entityTable: "payment_instances", entityId: x.id, name: x.name,
    dueDate: x.due_date, amount: moneyOrNull(x.amount), status: x.status,
    owner: x.owner, provider: x.provider, riskReasons: x.risk_reasons ?? [],
  }));
}

export async function loadInvoiceTargets(
  pool: Pool,
  todayISO: string,
  lookbackDays = 1,
  horizonDays = 7,
): Promise<ReminderTarget[]> {
  const r = await pool.query(
    `select v.id, coalesce(pa.name, v.invoice_no, '(cari yok)') as name,
            to_char(v.due_date,'YYYY-MM-DD') as due_date,
            (v.gross_amount - coalesce(v.allocated_amount,0)) as amount,
            v.status, pa.name as owner
     from public.invoices v
     left join public.parties pa on pa.id = v.party_id
     where v.direction = 'sales'
       and v.status in ('open','partial')
       and v.due_date between ($1::date - $2::int) and ($1::date + $3::int)`,
    [todayISO, lookbackDays, horizonDays],
  );
  return r.rows.map((x) => ({
    entityTable: "invoices", entityId: x.id, name: x.name,
    dueDate: x.due_date, amount: moneyOrNull(x.amount), status: x.status,
    owner: x.owner, provider: null, riskReasons: [],
  }));
}

export async function loadPromiseTargets(
  pool: Pool,
  todayISO: string,
  lookbackDays = 1,
  horizonDays = 7,
): Promise<ReminderTarget[]> {
  const r = await pool.query(
    `select p.id, pa.name as name,
            to_char(p.promised_date,'YYYY-MM-DD') as due_date,
            p.promised_amount as amount, p.status, pa.name as owner
     from public.promise_to_pay p
     join public.parties pa on pa.id = p.party_id
     where p.status = 'pending'
       and p.promised_date between ($1::date - $2::int) and ($1::date + $3::int)`,
    [todayISO, lookbackDays, horizonDays],
  );
  return r.rows.map((x) => ({
    entityTable: "promise_to_pay", entityId: x.id, name: x.name,
    dueDate: x.due_date, amount: moneyOrNull(x.amount), status: x.status,
    owner: x.owner, provider: null, riskReasons: [],
  }));
}

export async function loadCheckTargets(
  pool: Pool,
  todayISO: string,
  lookbackDays = 365,
  horizonDays = 30,
): Promise<ReminderTarget[]> {
  const r = await pool.query(
    `select c.id,
            coalesce(
              nullif(btrim(c.counterparty_label), ''),
              py.name,
              pr.name,
              nullif(btrim(c.serial_no), ''),
              '(çek/senet)'
            ) as name,
            to_char(c.maturity_date, 'YYYY-MM-DD') as due_date,
            coalesce(c.amount, abs(c.signed_amount)) as amount,
            c.status,
            coalesce(pr.name, py.name) as owner,
            bp.name as provider,
            c.risk_flag
       from public.checks c
       left join public.parties pr on pr.id = c.payer_party_id
       left join public.parties py on py.id = c.payee_party_id
       left join public.parties bp on bp.id = c.bank_party_id
      where c.archived_at is null
        and c.status in ('planned', 'in_portfolio', 'in_bank_collection', 'in_bank_collateral', 'issued_to_vendor')
        and c.maturity_date between ($1::date - $2::int) and ($1::date + $3::int)`,
    [todayISO, lookbackDays, horizonDays],
  );
  return r.rows.map((x) => {
    const dueDate = x.due_date as string;
    const reasons: string[] = [];
    if (dueDate < todayISO) reasons.push("vadesi geçmiş çek/senet");
    if (x.risk_flag) reasons.push(String(x.risk_flag));
    return {
      entityTable: "checks",
      entityId: x.id as string,
      name: x.name as string,
      dueDate,
      amount: moneyOrNull(x.amount),
      status: x.status as string,
      owner: (x.owner as string | null) ?? null,
      provider: (x.provider as string | null) ?? null,
      riskReasons: reasons,
    };
  });
}

export async function loadLoanInstallmentTargets(
  pool: Pool,
  todayISO: string,
  lookbackDays = 365,
  horizonDays = 30,
): Promise<ReminderTarget[]> {
  const r = await pool.query(
    `select li.id,
            case when li.installment_no is not null
                 then l.name || ' (Taksit #' || li.installment_no::text || ')'
                 else l.name end as name,
            to_char(li.due_date, 'YYYY-MM-DD') as due_date,
            case when li.status = 'partial' and li.amount is not null and li.paid_amount is not null
                 then greatest(li.amount - li.paid_amount, 0)
                 else li.amount end as amount,
            li.status,
            lp.name as provider
       from public.loan_installments li
       join public.loans l on l.id = li.loan_id
       left join public.parties lp on lp.id = l.lender_party_id
      where l.archived_at is null
        and li.cancelled_at is null
        and li.status in ('planned', 'unpaid', 'partial', 'late')
        and li.due_date between ($1::date - $2::int) and ($1::date + $3::int)`,
    [todayISO, lookbackDays, horizonDays],
  );
  return r.rows.map((x) => {
    const dueDate = x.due_date as string;
    const status = x.status as string;
    const reasons: string[] = [];
    if (dueDate < todayISO || status === "late") reasons.push("gecikmiş kredi taksiti");
    return {
      entityTable: "loan_installments",
      entityId: x.id as string,
      name: x.name as string,
      dueDate,
      amount: moneyOrNull(x.amount),
      status,
      owner: null,
      provider: (x.provider as string | null) ?? null,
      riskReasons: reasons,
    };
  });
}

/**
 * Evaluates upcoming and overdue `checks` and `loan_installments` targets against active rules.
 * - Upcoming/due-today rules (`offsetDays >= 0`) fire on `scheduledForDate(dueDate, offsetDays) === todayISO`.
 * - Overdue rules (`offsetDays < 0`) fire when `scheduledForDate(dueDate, offsetDays) <= todayISO`
 *   using deterministic `scheduledFor = scheduledForDate(dueDate, offsetDays)` so DB unique key
 *   `(reminder_id, entity_table, entity_id, scheduled_for)` guarantees strict idempotency across reruns.
 */
export function eligibleMaturityDeliveries(
  rules: ReminderRule[],
  targets: ReminderTarget[],
  todayISO: string,
): EligibleDelivery[] {
  const out: EligibleDelivery[] = [];
  for (const rule of rules) {
    if (!rule.isActive) continue;
    if (rule.targetKind !== "check" && rule.targetKind !== "loan_installment") continue;

    for (const target of targets) {
      if (rule.targetKind === "check") {
        if (target.entityTable !== "checks") continue;
        if (!CHECK_REMINDER_STATUSES.has(target.status)) continue;
      } else {
        if (target.entityTable !== "loan_installments") continue;
        if (!LOAN_INSTALLMENT_REMINDER_STATUSES.has(target.status)) continue;
      }

      const fireDate = scheduledForDate(target.dueDate, rule.offsetDays);
      const matchesDate =
        rule.offsetDays >= 0 ? fireDate === todayISO : fireDate <= todayISO;
      if (!matchesDate) continue;
      if (!thresholdPasses(rule.minAmount, target.amount)) continue;

      out.push({
        ruleId: rule.id,
        ruleName: rule.name,
        entityTable: target.entityTable,
        entityId: target.entityId,
        scheduledFor: fireDate,
        message: buildReminderMessage(rule, target),
      });
    }
  }
  return out;
}

export interface ScheduleResult {
  eligible: number;
  inserted: number;
  duplicatesSkipped: number;
}

export async function scheduleReminders(pool: Pool, todayISO = istanbulDateISO()): Promise<ScheduleResult> {
  const rules = await loadActiveRules(pool);
  const maxFutureOffset = Math.max(7, ...rules.filter((r) => r.offsetDays > 0).map((r) => r.offsetDays));
  const maxPastOffset = Math.max(1, ...rules.filter((r) => r.offsetDays < 0).map((r) => Math.abs(r.offsetDays)));
  const hasOverdueMaturityRule = rules.some(
    (r) => (r.targetKind === "check" || r.targetKind === "loan_installment") && r.offsetDays < 0,
  );
  const maturityLookback = hasOverdueMaturityRule ? Math.max(365, maxPastOffset) : maxPastOffset;

  const [paymentTargets, invoiceTargets, promiseTargets, checkTargets, loanInstallmentTargets] =
    await Promise.all([
      loadPaymentTargets(pool, todayISO, maxPastOffset, maxFutureOffset),
      loadInvoiceTargets(pool, todayISO, maxPastOffset, maxFutureOffset),
      loadPromiseTargets(pool, todayISO, maxPastOffset, maxFutureOffset),
      loadCheckTargets(pool, todayISO, maturityLookback, maxFutureOffset),
      loadLoanInstallmentTargets(pool, todayISO, maturityLookback, maxFutureOffset),
    ]);

  const baseEligible = eligibleDeliveries(
    rules,
    [...paymentTargets, ...invoiceTargets, ...promiseTargets],
    todayISO,
  );
  const maturityEligible = eligibleMaturityDeliveries(
    rules,
    [...checkTargets, ...loanInstallmentTargets],
    todayISO,
  );
  const eligible = [...baseEligible, ...maturityEligible];

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
  skipped: number;
}

export type TransportOrResolver = Transport | ((channel: Transport["channel"]) => Transport);

/**
 * Sends pending deliveries scheduled on/before today.
 *
 * Faz 40 (A2): Joins `public.reminders` to inspect each rule's `channel`. Email deliveries NEVER
 * leak onto a Telegram transport; if `channel === "email"` and the email endpoint is unconfigured,
 * the delivery row is recorded as `status='skipped'`, `error='skipped_unconfigured'`.
 */
export async function dispatchPending(
  pool: Pool,
  transportOrResolver: TransportOrResolver = transportFor,
  todayISO = istanbulDateISO(),
): Promise<DispatchResult> {
  const pending = await pool.query<{
    id: string;
    payload: { message?: string } | null;
    channel: Transport["channel"];
  }>(
    `select d.id, d.payload, r.channel
     from public.reminder_deliveries d
     join public.reminders r on r.id = d.reminder_id
     where d.status='pending' and d.scheduled_for <= $1
     order by d.scheduled_for`,
    [todayISO],
  );
  let sent = 0, failed = 0, skipped = 0;
  for (const row of pending.rows) {
    const channel: Transport["channel"] = row.channel === "email" ? "email" : "telegram";
    const activeTransport: Transport =
      typeof transportOrResolver === "function"
        ? transportOrResolver(channel)
        : channel === "email" && transportOrResolver.channel !== "email"
          ? emailTransport()
          : transportOrResolver;

    const message: string = row.payload?.message ?? "";
    let result: DeliveryResult;
    try {
      result = await activeTransport.send(message);
    } catch (e) {
      result = { ok: false, error: `transport threw: ${redactBotToken((e as Error).message)}` };
    }
    if (result.ok) {
      await pool.query(
        `update public.reminder_deliveries set status='sent', sent_at=now(), error=null where id=$1`,
        [row.id],
      );
      sent++;
    } else if (result.skippedUnconfigured) {
      await pool.query(
        `update public.reminder_deliveries set status='skipped', error='skipped_unconfigured' where id=$1`,
        [row.id],
      );
      skipped++;
    } else {
      await pool.query(
        `update public.reminder_deliveries set status='failed', error=$2 where id=$1`,
        [row.id, redactBotToken(result.error ?? "bilinmeyen hata")],
      );
      failed++;
    }
  }
  return { attempted: pending.rows.length, sent, failed, skipped };
}

/* ── read-side for /reminders ── */

export async function loadDeliveries(pool: Pool) {
  const r = await pool.query(
    `select d.id, r.name as rule_name, r.offset_days, r.target_kind, r.channel,
            d.entity_table, d.entity_id,
            to_char(d.scheduled_for,'YYYY-MM-DD') as scheduled_for, d.status,
            to_char(d.sent_at at time zone 'Europe/Istanbul','YYYY-MM-DD HH24:MI') as sent_at,
            d.error, d.payload,
            coalesce(
              p.name,
              nullif(btrim(chk.counterparty_label), ''),
              chk.serial_no,
              case when li.id is not null
                   then ln.name || coalesce(' #' || li.installment_no::text, '')
                   else null end,
              inv_p.name,
              inv.invoice_no,
              ptp_p.name,
              d.entity_id::text
            ) as target_name
     from public.reminder_deliveries d
     join public.reminders r on r.id = d.reminder_id
     left join public.payment_instances i on i.id = d.entity_id and d.entity_table = 'payment_instances'
     left join public.payments p on p.id = i.payment_id
     left join public.checks chk on chk.id = d.entity_id and d.entity_table = 'checks'
     left join public.loan_installments li on li.id = d.entity_id and d.entity_table = 'loan_installments'
     left join public.loans ln on ln.id = li.loan_id
     left join public.invoices inv on inv.id = d.entity_id and d.entity_table = 'invoices'
     left join public.parties inv_p on inv_p.id = inv.party_id
     left join public.promise_to_pay ptp on ptp.id = d.entity_id and d.entity_table = 'promise_to_pay'
     left join public.parties ptp_p on ptp_p.id = ptp.party_id
     order by d.scheduled_for desc, d.status`,
  );
  return r.rows as Array<{
    id: string;
    rule_name: string;
    offset_days: number;
    target_kind: string;
    channel: string;
    entity_table: string;
    entity_id: string;
    scheduled_for: string;
    status: string;
    sent_at: string | null;
    error: string | null;
    payload: { message?: string } | null;
    target_name: string;
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
