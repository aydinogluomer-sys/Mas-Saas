// Phase 6B, Faz 25, Faz 40 (A2), Wave 5B (F-52) & Phase E (Agent 06) reminder engine.
// BOUNDARY INVARIANT: Never access process.env or fetch here (transport.ts owns egress).

import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { computeObligationAmounts } from "@/lib/contracts/remediation-contracts";
import { DomainError } from "@/lib/domain-error";
import { moneyOrNull } from "@/lib/money";
import { istanbulDateISO } from "@/lib/reports/rules";
import { parseOrThrow } from "@/lib/validation";
import {
  buildReminderDigestHtml,
  buildReminderMessage,
  classifyEscalationBucket,
  daysOverdue,
  eligibleDeliveries,
  ESCALATION_BUCKET_LABELS,
  matchesReminderOffset,
  resolveReminderAmounts,
  scheduledForDate,
  thresholdPasses,
  type EligibleDelivery,
  type EscalationBucketKey,
  type ReminderDigestItem,
  type ReminderRule,
  type ReminderTarget,
  type ReminderTargetKind,
} from "./rules";
import {
  classifyThrownTransportError,
  computeNotificationIdempotencyKey,
  enqueueOutboxNotification,
  finalizeOutboxSendingOutcome,
  prepareOutboxSendingIntent,
  recoverStaleOutboxClaims,
  type PreparedOutboxSendingIntent,
} from "./outbox";
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
  targetKind: z.enum([
    "payment_instance",
    "check",
    "loan_installment",
    "invoice",
    "promise_to_pay",
    "covenant_record",
  ]),
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
      if (ins.rowCount !== 1) {
        throw new DomainError("CONFLICT", "Hatırlatma kuralı kaydedilemedi.");
      }
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
      where target_kind in ('payment_instance', 'check', 'loan_installment', 'invoice', 'covenant_record')
      group by target_kind`,
  );
  const countByKind = new Map(existing.rows.map((r) => [r.target_kind, Number(r.n)]));
  const defaults: Array<{ name: string; targetKind: ReminderRule["targetKind"]; offsetDays: number }> = [];

  if ((countByKind.get("payment_instance") ?? 0) === 0) {
    defaults.push(
      { name: "Ödeme — 7 gün önce hazırlık", targetKind: "payment_instance", offsetDays: 7 },
      { name: "Ödeme — 3 gün önce nakit kontrolü", targetKind: "payment_instance", offsetDays: 3 },
      { name: "Ödeme — 1 gün önce yarın ödeme", targetKind: "payment_instance", offsetDays: 1 },
      { name: "Ödeme — bugün ödeme günü", targetKind: "payment_instance", offsetDays: 0 },
    );
  }
  defaults.push(
    { name: "1–7 Gün gecikmiş ödeme kontrolü", targetKind: "payment_instance", offsetDays: -1 },
    { name: "8–30 Gün gecikmiş ödeme ihtarı", targetKind: "payment_instance", offsetDays: -8 },
    { name: "31+ Gün gecikmiş ödeme üst eskalasyon (iç inceleme)", targetKind: "payment_instance", offsetDays: -31 },
  );

  if ((countByKind.get("check") ?? 0) === 0) {
    defaults.push(
      { name: "Çek/Senet — 7 gün önce vade hazırlığı", targetKind: "check", offsetDays: 7 },
      { name: "Çek/Senet — 3 gün önce nakit/tahsilat kontrolü", targetKind: "check", offsetDays: 3 },
      { name: "Çek/Senet — 1 gün önce yarın vade", targetKind: "check", offsetDays: 1 },
      { name: "Çek/Senet — bugün vade günü", targetKind: "check", offsetDays: 0 },
      { name: "Çek/Senet — 1-7 gün gecikmiş kontrolü", targetKind: "check", offsetDays: -1 },
      { name: "Çek/Senet — 8-30 gün ihtar eskalasyonu", targetKind: "check", offsetDays: -8 },
      { name: "Çek/Senet — 31+ gün üst eskalasyon (iç inceleme)", targetKind: "check", offsetDays: -31 },
    );
  }
  if ((countByKind.get("loan_installment") ?? 0) === 0) {
    defaults.push(
      { name: "Kredi Taksiti — 7 gün önce hazırlık", targetKind: "loan_installment", offsetDays: 7 },
      { name: "Kredi Taksiti — 3 gün önce bakiye kontrolü", targetKind: "loan_installment", offsetDays: 3 },
      { name: "Kredi Taksiti — 1 gün önce yarın ödeme", targetKind: "loan_installment", offsetDays: 1 },
      { name: "Kredi Taksiti — bugün taksit günü", targetKind: "loan_installment", offsetDays: 0 },
    );
  }
  defaults.push(
    { name: "1–7 Gün gecikmiş kredi taksiti", targetKind: "loan_installment", offsetDays: -1 },
    { name: "8–30 Gün gecikmiş kredi taksiti ihtarı", targetKind: "loan_installment", offsetDays: -8 },
    { name: "31+ Gün gecikmiş kredi taksiti üst eskalasyon (iç inceleme)", targetKind: "loan_installment", offsetDays: -31 },
  );
  if ((countByKind.get("invoice") ?? 0) === 0) {
    defaults.push(
      { name: "Fatura — 3 gün önce vade yaklaşımı", targetKind: "invoice", offsetDays: 3 },
      { name: "Fatura — 1-7 gün gecikmiş tahsilat/ödeme takibi", targetKind: "invoice", offsetDays: -1 },
      { name: "Fatura — 8-30 gün ihtar kademesi", targetKind: "invoice", offsetDays: -8 },
      { name: "Fatura — 31+ gün üst eskalasyon (iç inceleme)", targetKind: "invoice", offsetDays: -31 },
    );
  }
  if ((countByKind.get("covenant_record") ?? 0) === 0) {
    defaults.push(
      { name: "Kovenant — 14 gün önce test tarihi hazırlığı", targetKind: "covenant_record", offsetDays: 14 },
      { name: "Kovenant — 3 gün önce kovenant ölçüm kontrolü", targetKind: "covenant_record", offsetDays: 3 },
      { name: "Kovenant — test tarihi geçmiş eskalasyon", targetKind: "covenant_record", offsetDays: -1 },
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
      if (ins.rowCount === 1) {
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

type EngineReminderTarget = ReminderTarget & {
  legalEntityId?: string | null;
};

function normalizeOptionalId(val: unknown): string | null {
  if (typeof val !== "string") return null;
  const trimmed = val.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function safeMoneyOrNull(val: unknown): number | null {
  if (val == null) return null;
  if (typeof val === "number" || typeof val === "string") return moneyOrNull(val);
  return null;
}

function mapPaymentInstanceAmounts(x: Record<string, unknown>): {
  amount: number | null;
  originalAmount: number | null;
  paidAmount: number | null;
  outstandingAmount: number | null;
} {
  const status = String(x.status ?? "unpaid");
  const orig = safeMoneyOrNull(x.original_amount !== undefined ? x.original_amount : x.amount);
  const paid = x.paid_amount !== undefined ? safeMoneyOrNull(x.paid_amount) : null;
  const computed = computeObligationAmounts({
    originalAmount: orig,
    paidAmount: paid,
    status,
  });
  const outstanding =
    x.outstanding_amount !== undefined
      ? safeMoneyOrNull(x.outstanding_amount)
      : computed.outstandingAmount;
  return {
    amount: outstanding,
    originalAmount: computed.originalAmount,
    paidAmount: paid,
    outstandingAmount: outstanding,
  };
}

function mapLoanInstallmentAmounts(x: Record<string, unknown>): {
  amount: number | null;
  originalAmount: number | null;
  paidAmount: number | null;
  outstandingAmount: number | null;
} {
  const status = String(x.status ?? "unpaid");
  const rawAmount = safeMoneyOrNull(x.amount);
  const hasExplicitOriginal = x.original_amount !== undefined;
  const orig = hasExplicitOriginal ? safeMoneyOrNull(x.original_amount) : rawAmount;
  const paid = x.paid_amount !== undefined ? safeMoneyOrNull(x.paid_amount) : null;
  const computed = computeObligationAmounts({
    originalAmount: orig,
    paidAmount: paid,
    status,
  });
  const outstanding =
    x.outstanding_amount !== undefined
      ? safeMoneyOrNull(x.outstanding_amount)
      : hasExplicitOriginal
        ? computed.outstandingAmount
        : rawAmount;
  return {
    amount: outstanding,
    originalAmount: orig,
    paidAmount: paid,
    outstandingAmount: outstanding,
  };
}

export async function loadPaymentTargets(
  pool: Pool,
  todayISO: string,
  lookbackDays = 3650,
  horizonDays = 7,
): Promise<ReminderTarget[]> {
  const r = await pool.query(
    `select i.id, coalesce(p.name,'(silinmiş kalem)') as name,
            to_char(i.due_date,'YYYY-MM-DD') as due_date, i.amount,
            to_jsonb(i)->>'paid_amount' as paid_amount,
            to_jsonb(i)->>'legal_entity_id' as legal_entity_id,
            i.status,
            po.name as owner, pr.name as provider, i.risk_reasons
     from public.payment_instances i
     left join public.payments p on p.id = i.payment_id
     left join public.parties po on po.id = p.owner_party_id
     left join public.parties pr on pr.id = p.provider_party_id
     where i.status in ('planned','unpaid','partial','late')
       and i.due_date between ($1::date - $2::int) and ($1::date + $3::int)`,
    [todayISO, lookbackDays, horizonDays],
  );
  return r.rows.map((x) => {
    const amounts = mapPaymentInstanceAmounts(x as Record<string, unknown>);
    const target: EngineReminderTarget = {
      entityTable: "payment_instances",
      entityId: x.id,
      name: x.name,
      dueDate: x.due_date,
      amount: amounts.amount,
      originalAmount: amounts.originalAmount,
      paidAmount: amounts.paidAmount,
      outstandingAmount: amounts.outstandingAmount,
      status: x.status,
      owner: x.owner,
      provider: x.provider,
      riskReasons: x.risk_reasons ?? [],
      legalEntityId: normalizeOptionalId(x.legal_entity_id),
    };
    return target;
  });
}

export async function loadInvoiceTargets(
  pool: Pool,
  todayISO: string,
  lookbackDays = 3650,
  horizonDays = 30,
): Promise<ReminderTarget[]> {
  const r = await pool.query(
    `select v.id,
            (case when v.direction = 'sales' then '[Tahsilat] ' else '[Ödeme] ' end) ||
            coalesce(pa.name, v.invoice_no, '(cari yok)') ||
            coalesce(' (' || v.invoice_no || ')', '') as name,
            to_char(v.due_date,'YYYY-MM-DD') as due_date,
            greatest(0, coalesce(v.payable_amount, v.gross_amount) - greatest(coalesce(v.allocated_amount,0), coalesce(v.paid_amount,0))) as amount,
            to_jsonb(v)->>'legal_entity_id' as legal_entity_id,
            v.status,
            pa.name as owner,
            v.direction
     from public.invoices v
     left join public.parties pa on pa.id = v.party_id
     where v.status in ('open','partial')
       and v.archived_at is null
       and v.bad_debt_at is null
       and v.due_date is not null
       and v.due_date between ($1::date - $2::int) and ($1::date + $3::int)`,
    [todayISO, lookbackDays, horizonDays],
  );
  return r.rows.map((x) => {
    const dueDate = x.due_date as string;
    const reasons: string[] = [];
    if (dueDate < todayISO) {
      const bucket = classifyEscalationBucket(dueDate, todayISO);
      reasons.push(ESCALATION_BUCKET_LABELS[bucket]);
    }
    const target: EngineReminderTarget = {
      entityTable: "invoices",
      entityId: x.id as string,
      name: x.name as string,
      dueDate,
      amount: moneyOrNull(x.amount),
      status: x.status as string,
      owner: (x.owner as string | null) ?? null,
      provider: x.direction === "purchase" ? ((x.owner as string | null) ?? null) : null,
      riskReasons: reasons,
      legalEntityId: normalizeOptionalId(x.legal_entity_id),
    };
    return target;
  });
}

export async function loadCovenantTargets(
  pool: Pool,
  todayISO: string,
  lookbackDays = 180,
  horizonDays = 60,
): Promise<ReminderTarget[]> {
  try {
    const r = await pool.query(
      `with cov_due as (
         select cr.id,
                coalesce(cf.name || ' — ', ln.name || ' — ', '')
                  || cr.description
                  || ' (' || cr.comparison || ' ' || cr.threshold_value::text || ')' as name,
                (
                  coalesce(cr.last_test_date, cr.created_at::date) +
                  case cr.test_frequency
                    when 'monthly' then interval '1 month'
                    when 'quarterly' then interval '3 months'
                    when 'semiannual' then interval '6 months'
                    when 'annual' then interval '1 year'
                    else interval '30 days'
                  end
                )::date as next_due_date,
                coalesce(cr.last_test_result, 'not_tested') as test_status,
                coalesce(cfp.name, ln.lender) as provider,
                to_jsonb(cr)->>'legal_entity_id' as legal_entity_id
           from public.covenant_records cr
           left join public.credit_facilities cf on cf.id = cr.facility_id
           left join public.parties cfp on cfp.id = cf.lender_party_id
           left join public.loans ln on ln.id = cr.loan_id
          where cr.status = 'active'
       )
       select id,
              name,
              to_char(next_due_date, 'YYYY-MM-DD') as due_date,
              test_status as status,
              provider,
              legal_entity_id
         from cov_due
        where next_due_date between ($1::date - $2::int) and ($1::date + $3::int)
           or test_status = 'breached'`,
      [todayISO, lookbackDays, horizonDays],
    );
    return r.rows.map((x) => {
      const target: EngineReminderTarget = {
        entityTable: "covenant_records",
        entityId: x.id as string,
        name: x.name as string,
        dueDate: x.due_date as string,
        amount: null,
        status: (x.status as string) || "compliant",
        owner: null,
        provider: (x.provider as string | null) ?? null,
        riskReasons: x.status === "breach" || x.status === "breached" ? ["kovenant_ihlali"] : [],
        legalEntityId: normalizeOptionalId(x.legal_entity_id),
      };
      return target;
    });
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (code === "42P01" || code === "42703") return [];
    throw err;
  }
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
            p.promised_amount as amount,
            to_jsonb(p)->>'legal_entity_id' as legal_entity_id,
            p.status, pa.name as owner
     from public.promise_to_pay p
     join public.parties pa on pa.id = p.party_id
     where p.status = 'pending'
       and p.promised_date between ($1::date - $2::int) and ($1::date + $3::int)`,
    [todayISO, lookbackDays, horizonDays],
  );
  return r.rows.map((x) => {
    const target: EngineReminderTarget = {
      entityTable: "promise_to_pay",
      entityId: x.id,
      name: x.name,
      dueDate: x.due_date,
      amount: moneyOrNull(x.amount),
      status: x.status,
      owner: x.owner,
      provider: null,
      riskReasons: [],
      legalEntityId: normalizeOptionalId(x.legal_entity_id),
    };
    return target;
  });
}

export async function loadCheckTargets(
  pool: Pool,
  todayISO: string,
  lookbackDays = 3650,
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
            to_jsonb(c)->>'legal_entity_id' as legal_entity_id,
            c.status,
            coalesce(pr.name, py.name) as owner,
            bp.name as provider
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
    const target: EngineReminderTarget = {
      entityTable: "checks",
      entityId: x.id as string,
      name: x.name as string,
      dueDate,
      amount: moneyOrNull(x.amount),
      status: x.status as string,
      owner: (x.owner as string | null) ?? null,
      provider: (x.provider as string | null) ?? null,
      riskReasons: reasons,
      legalEntityId: normalizeOptionalId(x.legal_entity_id),
    };
    return target;
  });
}

export async function loadLoanInstallmentTargets(
  pool: Pool,
  todayISO: string,
  lookbackDays = 3650,
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
            li.amount as original_amount,
            li.paid_amount,
            to_jsonb(l)->>'legal_entity_id' as legal_entity_id,
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
    const amounts = mapLoanInstallmentAmounts(x as Record<string, unknown>);
    const target: EngineReminderTarget = {
      entityTable: "loan_installments",
      entityId: x.id as string,
      name: x.name as string,
      dueDate,
      amount: amounts.amount,
      originalAmount: amounts.originalAmount,
      paidAmount: amounts.paidAmount,
      outstandingAmount: amounts.outstandingAmount,
      status,
      owner: null,
      provider: (x.provider as string | null) ?? null,
      riskReasons: reasons,
      legalEntityId: normalizeOptionalId(x.legal_entity_id),
    };
    return target;
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

      if (!matchesReminderOffset(rule.offsetDays, target.dueDate, todayISO)) continue;
      const resolved = resolveReminderAmounts(target);
      if (!thresholdPasses(rule.minAmount, resolved.outstandingAmount)) continue;

      const fireDate =
        rule.offsetDays >= 0 ? todayISO : scheduledForDate(target.dueDate, rule.offsetDays);

      out.push({
        ruleId: rule.id,
        ruleName: rule.name,
        entityTable: target.entityTable,
        entityId: target.entityId,
        scheduledFor: fireDate,
        message: buildReminderMessage(rule, target, todayISO),
        escalationBucket: classifyEscalationBucket(target.dueDate, todayISO),
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
  const maxFutureOffset = Math.max(14, ...rules.filter((r) => r.offsetDays > 0).map((r) => r.offsetDays));
  const maxPastOffset = Math.max(1, ...rules.filter((r) => r.offsetDays < 0).map((r) => Math.abs(r.offsetDays)));
  const hasAnyOverdueRule = rules.some((r) => r.offsetDays < 0);
  const overdueLookback = hasAnyOverdueRule ? Math.max(3650, maxPastOffset) : maxPastOffset;

  const [paymentTargets, invoiceTargets, promiseTargets, checkTargets, loanInstallmentTargets, covenantTargets] =
    await Promise.all([
      loadPaymentTargets(pool, todayISO, overdueLookback, maxFutureOffset),
      loadInvoiceTargets(pool, todayISO, overdueLookback, maxFutureOffset),
      loadPromiseTargets(pool, todayISO, overdueLookback, maxFutureOffset),
      loadCheckTargets(pool, todayISO, overdueLookback, maxFutureOffset),
      loadLoanInstallmentTargets(pool, todayISO, overdueLookback, maxFutureOffset),
      loadCovenantTargets(pool, todayISO, overdueLookback, maxFutureOffset),
    ]);

  const baseEligible = eligibleDeliveries(
    rules,
    [...paymentTargets, ...invoiceTargets, ...promiseTargets, ...covenantTargets],
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
        [
          d.ruleId,
          d.entityTable,
          d.entityId,
          d.scheduledFor,
          JSON.stringify({ message: d.message, escalationBucket: d.escalationBucket }),
        ],
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

export interface EscalationRadarBucketSummary {
  bucket: EscalationBucketKey;
  label: string;
  count: number;
  knownAmountTry: number;
  items: Array<{
    entityTable: string;
    entityId: string;
    name: string;
    dueDate: string;
    daysLate: number;
    amount: number | null;
  }>;
}

export async function loadEscalationRadarSummary(
  pool: Pool,
  todayISO = istanbulDateISO(),
): Promise<EscalationRadarBucketSummary[]> {
  const [payments, invoices, promises, checks, loans, covenants] = await Promise.all([
    loadPaymentTargets(pool, todayISO, 3650, 14),
    loadInvoiceTargets(pool, todayISO, 3650, 14),
    loadPromiseTargets(pool, todayISO, 3650, 14),
    loadCheckTargets(pool, todayISO, 3650, 14),
    loadLoanInstallmentTargets(pool, todayISO, 3650, 14),
    loadCovenantTargets(pool, todayISO, 180, 30),
  ]);

  const all = [...payments, ...invoices, ...promises, ...checks, ...loans, ...covenants];
  const keys: EscalationBucketKey[] = [
    "upcoming",
    "overdue_1_7",
    "overdue_8_30",
    "overdue_30_plus",
  ];
  const grouped = new Map<
    EscalationBucketKey,
    { count: number; sum: number; items: EscalationRadarBucketSummary["items"] }
  >(keys.map((k) => [k, { count: 0, sum: 0, items: [] }]));

  for (const t of all) {
    const b = classifyEscalationBucket(t.dueDate, todayISO);
    const entry = grouped.get(b)!;
    entry.count += 1;
    const effectiveAmount = resolveReminderAmounts(t).outstandingAmount;
    if (effectiveAmount != null && Number.isFinite(effectiveAmount)) {
      entry.sum = Math.round((entry.sum + effectiveAmount) * 100) / 100;
    }
    entry.items.push({
      entityTable: t.entityTable,
      entityId: t.entityId,
      name: t.name,
      dueDate: t.dueDate,
      daysLate: daysOverdue(t.dueDate, todayISO),
      amount: effectiveAmount,
    });
  }

  return keys.map((k) => {
    const g = grouped.get(k)!;
    g.items.sort((a, b) => b.daysLate - a.daysLate || (b.amount ?? 0) - (a.amount ?? 0));
    return {
      bucket: k,
      label: ESCALATION_BUCKET_LABELS[k],
      count: g.count,
      knownAmountTry: g.sum,
      items: g.items.slice(0, 6),
    };
  });
}

export interface DispatchResult {
  attempted: number;
  sent: number;
  failed: number;
  skipped: number;
  uncertain?: number;
}

export type TransportOrResolver = Transport | ((channel: Transport["channel"]) => Transport);

const REMINDER_CHANNEL_DIGEST_THRESHOLD = 5;

function isMissingOutboxTableError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return code === "42P01" || code === "42703";
}

function isLegacyClaimingUnsupportedError(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  if (code === "42703" || code === "42P01" || code === "22P02") return true;
  const msg = String((err as Error | null)?.message ?? "");
  return /beklenmeyen sql|unhandled sql|unexpected sql/i.test(msg);
}

function resolveActiveTransport(
  transportOrResolver: TransportOrResolver,
  channel: "telegram" | "email",
): Transport {
  if (typeof transportOrResolver === "function") {
    return transportOrResolver(channel);
  }
  if (channel === "email" && transportOrResolver.channel !== "email") {
    return emailTransport();
  }
  return transportOrResolver;
}

async function loadLiveTargetsForPending(
  pool: Pool,
  rows: ReadonlyArray<{ entity_table: string; entity_id: string }>,
  todayISO: string,
): Promise<Map<string, EngineReminderTarget>> {
  const idsByTable = new Map<string, Set<string>>();
  for (const r of rows) {
    let set = idsByTable.get(r.entity_table);
    if (!set) {
      set = new Set<string>();
      idsByTable.set(r.entity_table, set);
    }
    set.add(r.entity_id);
  }

  const out = new Map<string, EngineReminderTarget>();

  const payIds = [...(idsByTable.get("payment_instances") ?? [])];
  if (payIds.length > 0) {
    const res = await pool.query(
      `select i.id::text as id,
              coalesce(p.name, '(silinmiş kalem)') as name,
              to_char(i.due_date, 'YYYY-MM-DD') as due_date,
              i.amount,
              to_jsonb(i)->>'paid_amount' as paid_amount,
              to_jsonb(i)->>'legal_entity_id' as legal_entity_id,
              i.status,
              po.name as owner,
              pr.name as provider,
              i.risk_reasons
         from public.payment_instances i
         left join public.payments p on p.id = i.payment_id
         left join public.parties po on po.id = p.owner_party_id
         left join public.parties pr on pr.id = p.provider_party_id
        where i.id = any($1::uuid[])
          and i.cancelled_at is null
          and i.status in ('planned', 'unpaid', 'partial', 'late')
          and (p.id is null or (p.archived_at is null and p.status = 'active'))`,
      [payIds],
    );
    for (const x of res.rows) {
      const amounts = mapPaymentInstanceAmounts(x as Record<string, unknown>);
      out.set(`payment_instances:${x.id as string}`, {
        entityTable: "payment_instances",
        entityId: x.id as string,
        name: x.name as string,
        dueDate: x.due_date as string,
        amount: amounts.amount,
        originalAmount: amounts.originalAmount,
        paidAmount: amounts.paidAmount,
        outstandingAmount: amounts.outstandingAmount,
        status: x.status as string,
        owner: (x.owner as string | null) ?? null,
        provider: (x.provider as string | null) ?? null,
        riskReasons: (x.risk_reasons as string[] | null) ?? [],
        legalEntityId: normalizeOptionalId(x.legal_entity_id),
      });
    }
  }

  const checkIds = [...(idsByTable.get("checks") ?? [])];
  if (checkIds.length > 0) {
    const res = await pool.query(
      `select c.id::text as id,
              coalesce(
                nullif(btrim(c.counterparty_label), ''),
                py.name,
                pr.name,
                nullif(btrim(c.serial_no), ''),
                '(çek/senet)'
              ) as name,
              to_char(c.maturity_date, 'YYYY-MM-DD') as due_date,
              coalesce(c.amount, abs(c.signed_amount)) as amount,
              to_jsonb(c)->>'legal_entity_id' as legal_entity_id,
              c.status,
              coalesce(pr.name, py.name) as owner,
              bp.name as provider
         from public.checks c
         left join public.parties pr on pr.id = c.payer_party_id
         left join public.parties py on py.id = c.payee_party_id
         left join public.parties bp on bp.id = c.bank_party_id
        where c.id = any($1::uuid[])
          and c.archived_at is null
          and c.status in ('planned', 'in_portfolio', 'in_bank_collection', 'in_bank_collateral', 'issued_to_vendor')`,
      [checkIds],
    );
    for (const x of res.rows) {
      const dueDate = x.due_date as string;
      const reasons: string[] = [];
      if (dueDate < todayISO) reasons.push("vadesi geçmiş çek/senet");
      out.set(`checks:${x.id as string}`, {
        entityTable: "checks",
        entityId: x.id as string,
        name: x.name as string,
        dueDate,
        amount: moneyOrNull(x.amount),
        status: x.status as string,
        owner: (x.owner as string | null) ?? null,
        provider: (x.provider as string | null) ?? null,
        riskReasons: reasons,
        legalEntityId: normalizeOptionalId(x.legal_entity_id),
      });
    }
  }

  const loanIds = [...(idsByTable.get("loan_installments") ?? [])];
  if (loanIds.length > 0) {
    const res = await pool.query(
      `select li.id::text as id,
              case when li.installment_no is not null
                   then l.name || ' (Taksit #' || li.installment_no::text || ')'
                   else l.name end as name,
              to_char(li.due_date, 'YYYY-MM-DD') as due_date,
              case when li.status = 'partial' and li.amount is not null and li.paid_amount is not null
                   then greatest(li.amount - li.paid_amount, 0)
                   else li.amount end as amount,
              li.amount as original_amount,
              li.paid_amount,
              to_jsonb(l)->>'legal_entity_id' as legal_entity_id,
              li.status,
              lp.name as provider
         from public.loan_installments li
         join public.loans l on l.id = li.loan_id
         left join public.parties lp on lp.id = l.lender_party_id
        where li.id = any($1::uuid[])
          and l.archived_at is null
          and li.cancelled_at is null
          and li.status in ('planned', 'unpaid', 'partial', 'late')`,
      [loanIds],
    );
    for (const x of res.rows) {
      const dueDate = x.due_date as string;
      const status = x.status as string;
      const reasons: string[] = [];
      if (dueDate < todayISO || status === "late") reasons.push("gecikmiş kredi taksiti");
      const amounts = mapLoanInstallmentAmounts(x as Record<string, unknown>);
      out.set(`loan_installments:${x.id as string}`, {
        entityTable: "loan_installments",
        entityId: x.id as string,
        name: x.name as string,
        dueDate,
        amount: amounts.amount,
        originalAmount: amounts.originalAmount,
        paidAmount: amounts.paidAmount,
        outstandingAmount: amounts.outstandingAmount,
        status,
        owner: null,
        provider: (x.provider as string | null) ?? null,
        riskReasons: reasons,
        legalEntityId: normalizeOptionalId(x.legal_entity_id),
      });
    }
  }

  const invIds = [...(idsByTable.get("invoices") ?? [])];
  if (invIds.length > 0) {
    const res = await pool.query(
      `select v.id::text as id,
              (case when v.direction = 'sales' then '[Tahsilat] ' else '[Ödeme] ' end) ||
              coalesce(pa.name, v.invoice_no, '(cari yok)') ||
              coalesce(' (' || v.invoice_no || ')', '') as name,
              to_char(v.due_date, 'YYYY-MM-DD') as due_date,
              greatest(0, coalesce(v.payable_amount, v.gross_amount) - greatest(coalesce(v.allocated_amount, 0), coalesce(v.paid_amount, 0))) as amount,
              to_jsonb(v)->>'legal_entity_id' as legal_entity_id,
              v.status,
              pa.name as owner,
              v.direction
         from public.invoices v
         left join public.parties pa on pa.id = v.party_id
        where v.id = any($1::uuid[])
          and v.status in ('open', 'partial')
          and v.archived_at is null
          and v.bad_debt_at is null
          and v.due_date is not null`,
      [invIds],
    );
    for (const x of res.rows) {
      const dueDate = x.due_date as string;
      const reasons: string[] = [];
      if (dueDate < todayISO) {
        reasons.push(ESCALATION_BUCKET_LABELS[classifyEscalationBucket(dueDate, todayISO)]);
      }
      out.set(`invoices:${x.id as string}`, {
        entityTable: "invoices",
        entityId: x.id as string,
        name: x.name as string,
        dueDate,
        amount: moneyOrNull(x.amount),
        status: x.status as string,
        owner: (x.owner as string | null) ?? null,
        provider: x.direction === "purchase" ? ((x.owner as string | null) ?? null) : null,
        riskReasons: reasons,
        legalEntityId: normalizeOptionalId(x.legal_entity_id),
      });
    }
  }

  const ptpIds = [...(idsByTable.get("promise_to_pay") ?? [])];
  if (ptpIds.length > 0) {
    const res = await pool.query(
      `select p.id::text as id,
              pa.name as name,
              to_char(p.promised_date, 'YYYY-MM-DD') as due_date,
              p.promised_amount as amount,
              to_jsonb(p)->>'legal_entity_id' as legal_entity_id,
              p.status,
              pa.name as owner
         from public.promise_to_pay p
         join public.parties pa on pa.id = p.party_id
        where p.id = any($1::uuid[])
          and p.status = 'pending'`,
      [ptpIds],
    );
    for (const x of res.rows) {
      out.set(`promise_to_pay:${x.id as string}`, {
        entityTable: "promise_to_pay",
        entityId: x.id as string,
        name: x.name as string,
        dueDate: x.due_date as string,
        amount: moneyOrNull(x.amount),
        status: x.status as string,
        owner: (x.owner as string | null) ?? null,
        provider: null,
        riskReasons: [],
        legalEntityId: normalizeOptionalId(x.legal_entity_id),
      });
    }
  }

  const covIds = [...(idsByTable.get("covenant_records") ?? [])];
  if (covIds.length > 0) {
    try {
      const res = await pool.query(
        `with cov_due as (
           select cr.id::text as id,
                  coalesce(cf.name || ' — ', ln.name || ' — ', '')
                    || cr.description
                    || ' (' || cr.comparison || ' ' || cr.threshold_value::text || ')' as name,
                  (
                    coalesce(cr.last_test_date, cr.created_at::date) +
                    case cr.test_frequency
                      when 'monthly' then interval '1 month'
                      when 'quarterly' then interval '3 months'
                      when 'semiannual' then interval '6 months'
                      when 'annual' then interval '1 year'
                      else interval '30 days'
                    end
                  )::date as next_due_date,
                  coalesce(cr.last_test_result, 'not_tested') as test_status,
                  coalesce(cfp.name, ln.lender) as provider,
                  to_jsonb(cr)->>'legal_entity_id' as legal_entity_id
             from public.covenant_records cr
             left join public.credit_facilities cf on cf.id = cr.facility_id
             left join public.parties cfp on cfp.id = cf.lender_party_id
             left join public.loans ln on ln.id = cr.loan_id
            where cr.id = any($1::uuid[])
              and cr.status = 'active'
         )
         select id, name, to_char(next_due_date, 'YYYY-MM-DD') as due_date, test_status as status, provider, legal_entity_id
           from cov_due`,
        [covIds],
      );
      for (const x of res.rows) {
        const status = (x.status as string) || "compliant";
        out.set(`covenant_records:${x.id as string}`, {
          entityTable: "covenant_records",
          entityId: x.id as string,
          name: x.name as string,
          dueDate: x.due_date as string,
          amount: null,
          status,
          owner: null,
          provider: (x.provider as string | null) ?? null,
          riskReasons: status === "breach" || status === "breached" ? ["kovenant_ihlali"] : [],
          legalEntityId: normalizeOptionalId(x.legal_entity_id),
        });
      }
    } catch (err) {
      if (!isMissingOutboxTableError(err)) throw err;
    }
  }

  return out;
}

async function markReminderDeliveryStatusStrict(
  pool: Pool,
  id: string,
  status: "sent" | "skipped" | "failed" | "delivery_uncertain",
  opts: { error?: string | null; payload?: Record<string, unknown>; claimToken?: string | null } = {},
): Promise<void> {
  const claimToken = opts.claimToken ?? null;

  if (status === "sent") {
    let upd;
    try {
      if (claimToken) {
        upd = opts.payload
          ? await pool.query(
              `update public.reminder_deliveries
                  set status = 'sent',
                      sent_at = now(),
                      error = null,
                      claim_token = null,
                      payload = $2::jsonb
                where id = $1
                  and status in ('pending', 'claiming')
                  and claim_token = $3::uuid`,
              [id, JSON.stringify(opts.payload), claimToken],
            )
          : await pool.query(
              `update public.reminder_deliveries
                  set status = 'sent',
                      sent_at = now(),
                      error = null,
                      claim_token = null
                where id = $1
                  and status in ('pending', 'claiming')
                  and claim_token = $2::uuid`,
              [id, claimToken],
            );
      } else {
        upd = opts.payload
          ? await pool.query(
              `update public.reminder_deliveries
                  set status = 'sent',
                      sent_at = now(),
                      error = null,
                      payload = $2::jsonb
                where id = $1
                  and status in ('pending', 'claiming')`,
              [id, JSON.stringify(opts.payload)],
            )
          : await pool.query(
              `update public.reminder_deliveries
                  set status = 'sent',
                      sent_at = now(),
                      error = null
                where id = $1
                  and status in ('pending', 'claiming')`,
              [id],
            );
      }
    } catch (err) {
      if (!isLegacyClaimingUnsupportedError(err)) throw err;
      upd = opts.payload
        ? await pool.query(
            `update public.reminder_deliveries
                set status = 'sent',
                    sent_at = now(),
                    error = null,
                    payload = $2::jsonb
              where id = $1
                and status in ('pending', 'claiming')`,
            [id, JSON.stringify(opts.payload)],
          )
        : await pool.query(
            `update public.reminder_deliveries
                set status = 'sent',
                    sent_at = now(),
                    error = null
              where id = $1
                and status in ('pending', 'claiming')`,
            [id],
          );
    }
    if (upd.rowCount !== 1) {
      throw new Error(`Hatırlatma teslimat güncellemesi (sent) başarısız: satır bulunamadı veya durum değişti (${id}).`);
    }
    return;
  }

  let upd;
  try {
    if (opts.payload) {
      upd = claimToken
        ? await pool.query(
            `update public.reminder_deliveries
                set status = $2,
                    error = $3,
                    claim_token = null,
                    payload = coalesce(payload, '{}'::jsonb) || $4::jsonb
              where id = $1
                and status in ('pending', 'claiming')
                and claim_token = $5::uuid`,
            [id, status, opts.error ?? null, JSON.stringify(opts.payload), claimToken],
          )
        : await pool.query(
            `update public.reminder_deliveries
                set status = $2,
                    error = $3,
                    payload = coalesce(payload, '{}'::jsonb) || $4::jsonb
              where id = $1
                and status in ('pending', 'claiming')`,
            [id, status, opts.error ?? null, JSON.stringify(opts.payload)],
          );
    } else {
      upd = claimToken
        ? await pool.query(
            `update public.reminder_deliveries
                set status = $2,
                    error = $3,
                    claim_token = null
              where id = $1
                and status in ('pending', 'claiming')
                and claim_token = $4::uuid`,
            [id, status, opts.error ?? null, claimToken],
          )
        : await pool.query(
            `update public.reminder_deliveries
                set status = $2,
                    error = $3
              where id = $1
                and status in ('pending', 'claiming')`,
            [id, status, opts.error ?? null],
          );
    }
  } catch (err) {
    if (!isLegacyClaimingUnsupportedError(err)) throw err;
    upd = await pool.query(
      `update public.reminder_deliveries
          set status = $2,
              error = $3
        where id = $1
          and status in ('pending', 'claiming')`,
      [id, status, opts.error ?? null],
    );
  }
  if (upd.rowCount !== 1) {
    throw new Error(`Hatırlatma teslimat güncellemesi (${status}) başarısız: satır bulunamadı veya durum değişti (${id}).`);
  }
}

async function loadAlreadySentOutboxKeys(
  pool: Pool,
  keys: readonly string[],
): Promise<Set<string>> {
  if (keys.length === 0) return new Set();
  try {
    const res = await pool.query<{ idempotency_key: string }>(
      `select idempotency_key
         from public.notification_outbox
        where idempotency_key = any($1::text[])
          and status in ('sent', 'delivery_uncertain', 'claiming')`,
      [keys],
    );
    return new Set(res.rows.map((r) => r.idempotency_key));
  } catch (err) {
    if (isMissingOutboxTableError(err)) return new Set();
    if (isLegacyClaimingUnsupportedError(err)) {
      try {
        const fallback = await pool.query<{ idempotency_key: string }>(
          `select idempotency_key
             from public.notification_outbox
            where idempotency_key = any($1::text[])
              and status = 'sent'`,
          [keys],
        );
        return new Set(fallback.rows.map((r) => r.idempotency_key));
      } catch (innerErr) {
        if (isMissingOutboxTableError(innerErr)) return new Set();
        throw innerErr;
      }
    }
    throw err;
  }
}

interface OutboxIntentEntryInput {
  channel: "telegram" | "email";
  idempotencyKey: string;
  bodyText: string;
  bodyFormat: "plain" | "html";
  metadata: Record<string, unknown>;
  legalEntityId?: string | null;
}

interface DurableOutboxSendingHandle {
  outboxId: string | null;
  claimToken: string | null;
  alreadyHandled: boolean;
  existingStatus: string | null;
  legacyFallback: boolean;
}

async function beginDurableOutboxSendingIntent(
  pool: Pool,
  entry: OutboxIntentEntryInput,
): Promise<DurableOutboxSendingHandle> {
  try {
    const prepared: PreparedOutboxSendingIntent = await prepareOutboxSendingIntent(pool, {
      stream: "reminder_digest",
      channel: entry.channel,
      recipientTarget: `default:${entry.channel}`,
      idempotencyKey: entry.idempotencyKey,
      bodyText: entry.bodyText,
      bodyFormat: entry.bodyFormat,
      metadata: entry.metadata,
      legalEntityId: entry.legalEntityId ?? null,
    });

    if (!prepared.alreadyHandled && prepared.outboxId && prepared.claimToken) {
      return {
        outboxId: prepared.outboxId,
        claimToken: prepared.claimToken,
        alreadyHandled: false,
        existingStatus: prepared.existingStatus,
        legacyFallback: false,
      };
    }

    if (prepared.alreadyHandled && prepared.outboxId && prepared.existingStatus === "claiming") {
      const checkPending = await pool.query<{ status?: string }>(
        `select status
           from public.notification_outbox
          where idempotency_key = $1
          limit 1`,
        [entry.idempotencyKey],
      );
      const currentStatus = checkPending.rows[0]?.status;
      if (currentStatus === "pending" || currentStatus === "failed_retryable") {
        const fallbackToken = randomUUID();
        const sendingMeta = JSON.stringify({
          ...entry.metadata,
          dispatchPhase: "sending",
          sendingStartedAt: new Date().toISOString(),
        });
        const fallbackClaim = await pool.query(
          `update public.notification_outbox
              set status = 'claiming',
                  claimed_at = now(),
                  metadata = coalesce(metadata, '{}'::jsonb) || $2::jsonb,
                  updated_at = now()
            where idempotency_key = $1
              and status in ('pending', 'failed_retryable')
              and claim_token is null`,
          [entry.idempotencyKey, sendingMeta],
        );
        if ((fallbackClaim.rowCount ?? 0) === 1) {
          return {
            outboxId: prepared.outboxId,
            claimToken: fallbackToken,
            alreadyHandled: false,
            existingStatus: currentStatus,
            legacyFallback: false,
          };
        }
      }
    }

    return {
      outboxId: prepared.outboxId,
      claimToken: null,
      alreadyHandled: true,
      existingStatus: prepared.existingStatus,
      legacyFallback: false,
    };
  } catch (err) {
    if (isMissingOutboxTableError(err) || isLegacyClaimingUnsupportedError(err)) {
      return {
        outboxId: null,
        claimToken: null,
        alreadyHandled: false,
        existingStatus: null,
        legacyFallback: true,
      };
    }
    throw err;
  }
}

async function releaseUnstartedOutboxIntentBestEffort(
  pool: Pool,
  handle: DurableOutboxSendingHandle,
): Promise<void> {
  if (!handle.outboxId || !handle.claimToken) return;
  try {
    await pool.query(
      `update public.notification_outbox
          set status = 'pending',
              claim_token = null,
              metadata = coalesce(metadata, '{}'::jsonb) || '{"dispatchPhase":"prepared"}'::jsonb,
              updated_at = now()
        where id = $1
          and status = 'claiming'
          and claim_token = $2::uuid`,
      [handle.outboxId, handle.claimToken],
    );
  } catch {
    // Non-fatal cleanup if delivery claim was lost prior to network I/O.
  }
}

async function completeDurableOutboxSendingOutcome(
  pool: Pool,
  handle: DurableOutboxSendingHandle,
  entry: OutboxIntentEntryInput,
  outcome: DeliveryResult,
): Promise<void> {
  if (handle.legacyFallback || !handle.outboxId || !handle.claimToken) {
    await recordOutboxOutcomeSafe(pool, entry, outcome);
    return;
  }
  try {
    await finalizeOutboxSendingOutcome(pool, {
      outboxId: handle.outboxId,
      claimToken: handle.claimToken,
      idempotencyKey: entry.idempotencyKey,
      delivery: outcome,
    });
  } catch (err) {
    if (isMissingOutboxTableError(err) || isLegacyClaimingUnsupportedError(err)) {
      await recordOutboxOutcomeSafe(pool, entry, outcome);
      return;
    }
    throw err;
  }
}

async function markReminderDeliverySendingStarted(
  pool: Pool,
  id: string,
  claimToken: string | null,
  meta: {
    outboxIdempotencyKey: string;
    outboxId?: string | null;
    batchKey?: string | null;
  },
): Promise<boolean> {
  const sendingPatch = JSON.stringify({
    dispatchPhase: "sending",
    sendingStartedAt: new Date().toISOString(),
    outboxIdempotencyKey: meta.outboxIdempotencyKey,
    ...(meta.outboxId ? { outboxId: meta.outboxId } : {}),
    ...(meta.batchKey ? { batchKey: meta.batchKey } : {}),
  });

  if (!claimToken) {
    try {
      const upd = await pool.query(
        `update public.reminder_deliveries
            set payload = coalesce(payload, '{}'::jsonb) || $2::jsonb
          where id = $1
            and status = 'pending'`,
        [id, sendingPatch],
      );
      return (upd.rowCount ?? 0) === 1;
    } catch (err) {
      if (isLegacyClaimingUnsupportedError(err)) return true;
      throw err;
    }
  }

  try {
    const upd = await pool.query(
      `update public.reminder_deliveries
          set status = 'claiming',
              payload = coalesce(payload, '{}'::jsonb) || $3::jsonb
        where id = $1
          and status = 'claiming'
          and claim_token = $2::uuid`,
      [id, claimToken, sendingPatch],
    );
    return (upd.rowCount ?? 0) === 1;
  } catch (err) {
    if (isLegacyClaimingUnsupportedError(err)) return true;
    throw err;
  }
}

function buildProviderMessagePayloadFields(
  result: DeliveryResult,
): { providerMessageIds?: string[]; providerMessageId?: string | null } {
  const rawIds =
    Array.isArray(result.providerMessageIds) && result.providerMessageIds.length > 0
      ? result.providerMessageIds
      : Array.isArray(result.messageIds) && result.messageIds.length > 0
        ? result.messageIds
        : result.providerMessageId != null && String(result.providerMessageId).trim() !== ""
          ? [String(result.providerMessageId).trim()]
          : [];
  const ids = rawIds.map((v) => String(v).trim()).filter(Boolean);
  if (ids.length === 0) return {};
  return {
    providerMessageIds: ids,
    providerMessageId:
      result.providerMessageId != null ? String(result.providerMessageId) : (ids[0] ?? null),
  };
}

async function recordUncertainDeliveryOpsIncidentBestEffort(
  pool: Pool,
  uncertainCount: number,
): Promise<void> {
  if (uncertainCount <= 0) return;
  try {
    const valueStr = String(uncertainCount);
    const fingerprint = createHash("sha256")
      .update(`outbox_delivery_uncertain|P1|OPEN|${valueStr}`, "utf8")
      .digest("hex")
      .slice(0, 16);
    await pool.query(
      `insert into public.ops_incidents
         (signal_key, severity, state, last_value, state_fingerprint, note, opened_at, occurrence_count, updated_at)
       values ($1, $2, $3, $4, $5, $6, now(), 1, now())
       on conflict (signal_key) do update
         set severity = excluded.severity,
             state = case when public.ops_incidents.state = 'SUPPRESSED' then public.ops_incidents.state else 'OPEN' end,
             last_value = excluded.last_value,
             state_fingerprint = excluded.state_fingerprint,
             note = excluded.note,
             opened_at = coalesce(public.ops_incidents.opened_at, now()),
             resolved_at = null,
             occurrence_count = public.ops_incidents.occurrence_count + 1,
             updated_at = now()`,
      [
        "outbox_delivery_uncertain",
        "P1",
        "OPEN",
        valueStr,
        fingerprint,
        "sending fazında kesilen hatırlatma delivery_uncertain durumuna alındı; operatör mutabakatı gerekli",
      ],
    );
  } catch {
    // Non-fatal on minimal unit-test mock pools that omit `public.ops_incidents`.
  }
}

async function recordOutboxOutcomeSafe(
  pool: Pool,
  entry: OutboxIntentEntryInput,
  outcome: DeliveryResult,
): Promise<void> {
  try {
    await enqueueOutboxNotification(pool, {
      stream: "reminder_digest",
      channel: entry.channel,
      recipientTarget: `default:${entry.channel}`,
      idempotencyKey: entry.idempotencyKey,
      bodyText: entry.bodyText,
      bodyFormat: entry.bodyFormat,
      metadata: entry.metadata,
      legalEntityId: entry.legalEntityId ?? null,
    });
    if (outcome.ok) {
      await pool.query(
        `update public.notification_outbox
            set status = 'sent',
                sent_at = now(),
                attempt_count = attempt_count + 1,
                last_error = null,
                claim_token = null,
                updated_at = now()
          where idempotency_key = $1`,
        [entry.idempotencyKey],
      );
    } else if (outcome.skippedUnconfigured) {
      await pool.query(
        `update public.notification_outbox
            set status = 'skipped',
                attempt_count = attempt_count + 1,
                last_error = $2,
                claim_token = null,
                updated_at = now()
          where idempotency_key = $1`,
        [entry.idempotencyKey, redactBotToken(outcome.error ?? "skipped_unconfigured")],
      );
    } else if (outcome.uncertainOutcome === true) {
      const safeError = redactBotToken(
        outcome.error ?? "delivery_uncertain: gönderim sonrası yanıt doğrulanamadı",
      );
      try {
        await pool.query(
          `update public.notification_outbox
              set status = 'delivery_uncertain',
                  uncertain_at = now(),
                  attempt_count = attempt_count + 1,
                  last_error = $2,
                  claim_token = null,
                  updated_at = now()
            where idempotency_key = $1`,
          [entry.idempotencyKey, safeError],
        );
      } catch (uncertainErr) {
        if (!isLegacyClaimingUnsupportedError(uncertainErr)) throw uncertainErr;
        await pool.query(
          `update public.notification_outbox
              set status = 'delivery_uncertain',
                  attempt_count = attempt_count + 1,
                  last_error = $2,
                  claim_token = null,
                  updated_at = now()
            where idempotency_key = $1`,
          [entry.idempotencyKey, safeError],
        );
      }
    } else {
      const retrySec =
        typeof outcome.retryAfterSeconds === "number" &&
        Number.isFinite(outcome.retryAfterSeconds) &&
        outcome.retryAfterSeconds > 0
          ? Math.max(300, Math.ceil(outcome.retryAfterSeconds))
          : 300;
      await pool.query(
        `update public.notification_outbox
            set status = case when attempt_count + 1 >= max_attempts then 'dead_letter' else 'failed_retryable' end,
                attempt_count = attempt_count + 1,
                next_retry_at = now() + ($3::int * interval '1 second'),
                last_error = $2,
                claim_token = null,
                updated_at = now()
          where idempotency_key = $1`,
        [entry.idempotencyKey, redactBotToken(outcome.error ?? "bilinmeyen hata"), retrySec],
      );
    }
  } catch (err) {
    if (!isMissingOutboxTableError(err)) throw err;
  }
}

interface ClaimedDeliveryRow {
  id: string;
  reminder_id: string;
  entity_table: string;
  entity_id: string;
  scheduled_for: string;
  payload: Record<string, unknown> | null;
  claim_token?: string | null;
  rule_name: string;
  target_kind: ReminderTargetKind;
  offset_days: number;
  channel: Transport["channel"];
  min_amount: string | number | null;
  is_active: boolean;
}

async function claimPendingDeliveriesAtomic(
  pool: Pool,
  todayISO: string,
): Promise<ClaimedDeliveryRow[]> {
  try {
    await recoverStaleOutboxClaims(pool, 10);
  } catch (err) {
    if (!isMissingOutboxTableError(err) && !isLegacyClaimingUnsupportedError(err)) {
      throw err;
    }
  }

  let postSendingUncertainRecovered = 0;
  try {
    // F-08: Stale claims that ALREADY entered `dispatchPhase = 'sending'` MUST transition
    // atomically to `'delivery_uncertain'` (NEVER back to `'pending'`, preventing duplicate sends).
    const uncertainRes = await pool.query(
      `update public.reminder_deliveries
          set status = 'delivery_uncertain',
              claim_token = null,
              error = coalesce(error, 'crash_window_after_sending_started: operator_reconciliation_required'),
              payload = coalesce(payload, '{}'::jsonb) || '{"dispatchPhase":"delivery_uncertain","requiresOperatorReconciliation":true}'::jsonb
        where status = 'claiming'
          and claimed_at < now() - interval '10 minutes'
          and coalesce(payload->>'dispatchPhase', '') = 'sending'`,
    );
    postSendingUncertainRecovered = uncertainRes.rowCount ?? 0;

    // Only pre-send stale claims (`dispatchPhase <> 'sending'`, zero external send initiated) recover to `'pending'`.
    await pool.query(
      `update public.reminder_deliveries
          set status = 'pending',
              claim_token = null,
              payload = coalesce(payload, '{}'::jsonb) || '{"dispatchPhase":"pending"}'::jsonb
        where status = 'claiming'
          and claimed_at < now() - interval '10 minutes'
          and coalesce(payload->>'dispatchPhase', '') <> 'sending'`,
    );
  } catch (err) {
    if (!isLegacyClaimingUnsupportedError(err)) throw err;
  }

  if (postSendingUncertainRecovered > 0) {
    await recordUncertainDeliveryOpsIncidentBestEffort(pool, postSendingUncertainRecovered);
  }

  try {
    const claimed = await pool.query<ClaimedDeliveryRow>(
      `with due as (
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
              claimed_at = now(),
              payload = coalesce(d.payload, '{}'::jsonb) || '{"dispatchPhase":"claimed"}'::jsonb
         from due,
              public.reminders r
        where d.id = due.id
          and r.id = d.reminder_id
       returning d.id::text as id,
                 d.reminder_id::text as reminder_id,
                 d.entity_table,
                 d.entity_id::text as entity_id,
                 to_char(d.scheduled_for, 'YYYY-MM-DD') as scheduled_for,
                 d.payload,
                 d.claim_token::text as claim_token,
                 r.name as rule_name,
                 r.target_kind,
                 r.offset_days,
                 r.channel,
                 r.min_amount,
                 r.is_active`,
      [todayISO],
    );
    const rows = [...claimed.rows];
    rows.sort((a, b) =>
      a.scheduled_for === b.scheduled_for
        ? a.id.localeCompare(b.id)
        : a.scheduled_for.localeCompare(b.scheduled_for),
    );
    return rows;
  } catch (err) {
    if (!isLegacyClaimingUnsupportedError(err)) throw err;
    const legacy = await pool.query<ClaimedDeliveryRow>(
      `select d.id::text as id,
              d.reminder_id::text as reminder_id,
              d.entity_table,
              d.entity_id::text as entity_id,
              to_char(d.scheduled_for, 'YYYY-MM-DD') as scheduled_for,
              d.payload,
              r.name as rule_name,
              r.target_kind,
              r.offset_days,
              r.channel,
              r.min_amount,
              r.is_active
         from public.reminder_deliveries d
         join public.reminders r on r.id = d.reminder_id
        where d.status = 'pending'
          and d.scheduled_for <= $1::date
        order by d.scheduled_for asc, d.id asc`,
      [todayISO],
    );
    return legacy.rows;
  }
}

/**
 * Sends pending deliveries scheduled on/before today:
 *  1. Expires stale upcoming/due-today rows (`offset_days >= 0` and `scheduled_for < todayISO - 1`).
 *  2. Recovers stale claims safely (`dispatchPhase = 'sending'` -> `'delivery_uncertain'`; pre-send -> `'pending'`)
 *     and atomically claims due `pending` rows via `FOR UPDATE SKIP LOCKED` (`status = 'claiming'`, `claim_token = gen_random_uuid()`).
 *  3. Re-verifies each live target row is still open/unarchived/uncancelled and still in the rule's
 *     disjoint bucket on `todayISO`, rebuilding the message fresh from live facts (`todayISO`).
 *  4. Durably commits `dispatchPhase = 'sending'` in BOTH `notification_outbox` and `reminder_deliveries`
 *     BEFORE invoking `activeTransport.send()`, captures `providerMessageId` / `providerMessageIds`,
 *     holds `'delivery_uncertain'` on post-send crashes/timeouts/partial chunks without blind retries,
 *     and consolidates `> 5` simultaneous items per channel into a single structured digest (`buildReminderDigestHtml`).
 */
export async function dispatchPending(
  pool: Pool,
  transportOrResolver: TransportOrResolver = transportFor,
  todayISO = istanbulDateISO(),
): Promise<DispatchResult> {
  // 1) Expire stale upcoming / due-today deliveries so an August "Bugün ödeme" can NEVER fire in November.
  const expiredRes = await pool.query(
    `update public.reminder_deliveries d
        set status = 'skipped',
            error = 'expired_stale_window'
       from public.reminders r
      where d.reminder_id = r.id
        and d.status = 'pending'
        and r.offset_days >= 0
        and d.scheduled_for < ($1::date - 1)`,
    [todayISO],
  );
  const expiredStaleCount = expiredRes.rowCount ?? 0;

  const claimedRows = await claimPendingDeliveriesAtomic(pool, todayISO);

  let sent = 0;
  let failed = 0;
  let skipped = expiredStaleCount;
  let uncertain = 0;

  if (claimedRows.length === 0) {
    return { attempted: expiredStaleCount, sent: 0, failed: 0, skipped, uncertain: 0 };
  }

  // 2) Live target re-verification + fresh message rendering as of `todayISO`.
  const liveTargets = await loadLiveTargetsForPending(pool, claimedRows, todayISO);

  interface VerifiedPendingItem {
    deliveryId: string;
    claimToken: string | null;
    legalEntityId: string | null;
    channel: "telegram" | "email";
    entityTable: string;
    entityId: string;
    escalationBucket: EscalationBucketKey;
    idempotencyKey: string;
    freshMessage: string;
    digestItem: ReminderDigestItem;
  }

  const verifiedItems: VerifiedPendingItem[] = [];

  for (const row of claimedRows) {
    const channel: "telegram" | "email" = row.channel === "email" ? "email" : "telegram";
    const rule: ReminderRule = {
      id: row.reminder_id,
      name: row.rule_name,
      targetKind: row.target_kind,
      offsetDays: Number(row.offset_days),
      channel,
      minAmount: moneyOrNull(row.min_amount),
      isActive: Boolean(row.is_active),
    };

    const liveTarget = liveTargets.get(`${row.entity_table}:${row.entity_id}`);
    const resolvedAmounts = liveTarget ? resolveReminderAmounts(liveTarget) : null;
    const bucketValid =
      liveTarget !== undefined &&
      resolvedAmounts !== null &&
      rule.isActive &&
      thresholdPasses(rule.minAmount, resolvedAmounts.outstandingAmount) &&
      (rule.offsetDays < 0
        ? matchesReminderOffset(rule.offsetDays, liveTarget.dueDate, todayISO)
        : liveTarget.dueDate >= todayISO &&
          (matchesReminderOffset(rule.offsetDays, liveTarget.dueDate, todayISO) ||
            (rule.offsetDays > 0 && liveTarget.dueDate > todayISO)));

    if (!liveTarget || !resolvedAmounts || !bucketValid) {
      await markReminderDeliveryStatusStrict(pool, row.id, "skipped", {
        error: "superseded_or_closed",
        claimToken: row.claim_token ?? null,
      });
      skipped += 1;
      continue;
    }

    const escalationBucket = classifyEscalationBucket(liveTarget.dueDate, todayISO);
    const escalationTier =
      rule.offsetDays >= 0 ? `upcoming_${rule.offsetDays}` : escalationBucket;
    const cadenceSlot = scheduledForDate(liveTarget.dueDate, rule.offsetDays);
    const legalEntityId = liveTarget.legalEntityId ?? null;
    const stateVersion = [
      liveTarget.dueDate,
      liveTarget.status.trim().toLowerCase(),
      resolvedAmounts.outstandingAmount == null
        ? "null"
        : resolvedAmounts.outstandingAmount.toFixed(2),
    ].join(":");

    const idempotencyKey = computeNotificationIdempotencyKey([
      channel,
      legalEntityId ?? "default",
      row.entity_table,
      row.entity_id,
      rule.id,
      escalationTier,
      cadenceSlot,
      stateVersion,
    ]);

    const freshMessage = buildReminderMessage(rule, liveTarget, todayISO);

    verifiedItems.push({
      deliveryId: row.id,
      claimToken: row.claim_token ?? null,
      legalEntityId,
      channel,
      entityTable: row.entity_table,
      entityId: row.entity_id,
      escalationBucket,
      idempotencyKey,
      freshMessage,
      digestItem: {
        entityTable: liveTarget.entityTable,
        entityId: liveTarget.entityId,
        name: liveTarget.name,
        dueDate: liveTarget.dueDate,
        amount: liveTarget.amount,
        originalAmount: liveTarget.originalAmount,
        paidAmount: liveTarget.paidAmount,
        outstandingAmount: liveTarget.outstandingAmount,
        status: liveTarget.status,
        owner: liveTarget.owner,
        provider: liveTarget.provider,
        riskReasons: liveTarget.riskReasons,
      },
    });
  }

  // 3) Deduplicate against `notification_outbox` (`status in ('sent', 'delivery_uncertain', 'claiming')`) and batch `> 5` per channel.
  const alreadySentKeys = await loadAlreadySentOutboxKeys(
    pool,
    verifiedItems.map((i) => i.idempotencyKey),
  );

  const byChannel: Record<"telegram" | "email", VerifiedPendingItem[]> = {
    telegram: [],
    email: [],
  };

  for (const item of verifiedItems) {
    if (alreadySentKeys.has(item.idempotencyKey)) {
      await markReminderDeliveryStatusStrict(pool, item.deliveryId, "skipped", {
        error: "deduped_by_outbox",
        claimToken: item.claimToken,
      });
      skipped += 1;
      continue;
    }
    byChannel[item.channel].push(item);
  }

  for (const channel of ["telegram", "email"] as const) {
    const channelItems = byChannel[channel];
    if (channelItems.length === 0) continue;

    const activeTransport = resolveActiveTransport(transportOrResolver, channel);

    if (channelItems.length > REMINDER_CHANNEL_DIGEST_THRESHOLD) {
      const digestHtml = buildReminderDigestHtml(
        channelItems.map((c) => c.digestItem),
        todayISO,
      );
      const batchKey = computeNotificationIdempotencyKey([
        "reminder_digest_batch",
        channel,
        todayISO,
        ...[...channelItems.map((c) => c.idempotencyKey)].sort(),
      ]);

      const batchEntry: OutboxIntentEntryInput = {
        channel,
        idempotencyKey: batchKey,
        bodyText: digestHtml,
        bodyFormat: channel === "telegram" ? "html" : "plain",
        metadata: {
          todayISO,
          itemCount: channelItems.length,
          deliveryIds: channelItems.map((c) => c.deliveryId),
        },
      };

      // Pre-send durable intent #1: batch outbox key
      const batchHandle = await beginDurableOutboxSendingIntent(pool, batchEntry);
      if (batchHandle.alreadyHandled) {
        for (const item of channelItems) {
          await markReminderDeliveryStatusStrict(pool, item.deliveryId, "skipped", {
            error: "deduped_by_outbox",
            claimToken: item.claimToken,
          });
          skipped += 1;
        }
        continue;
      }

      // Pre-send durable intent #2: per-item outbox + reminder_deliveries `dispatchPhase = 'sending'`
      const activeDigestItems: Array<{
        item: VerifiedPendingItem;
        entry: OutboxIntentEntryInput;
        handle: DurableOutboxSendingHandle;
      }> = [];

      for (const item of channelItems) {
        const itemEntry: OutboxIntentEntryInput = {
          channel,
          idempotencyKey: item.idempotencyKey,
          bodyText: item.freshMessage,
          bodyFormat: "plain",
          metadata: { todayISO, batchKey, deliveryId: item.deliveryId },
          legalEntityId: item.legalEntityId,
        };
        const itemHandle = await beginDurableOutboxSendingIntent(pool, itemEntry);
        if (itemHandle.alreadyHandled) {
          await markReminderDeliveryStatusStrict(pool, item.deliveryId, "skipped", {
            error: "deduped_by_outbox",
            claimToken: item.claimToken,
          });
          skipped += 1;
          continue;
        }

        const deliveryFenceOk = await markReminderDeliverySendingStarted(
          pool,
          item.deliveryId,
          item.claimToken,
          {
            outboxIdempotencyKey: item.idempotencyKey,
            outboxId: itemHandle.outboxId,
            batchKey,
          },
        );
        if (!deliveryFenceOk) {
          await releaseUnstartedOutboxIntentBestEffort(pool, itemHandle);
          continue;
        }

        activeDigestItems.push({ item, entry: itemEntry, handle: itemHandle });
      }

      if (activeDigestItems.length === 0) {
        await releaseUnstartedOutboxIntentBestEffort(pool, batchHandle);
        continue;
      }

      const finalDigestHtml =
        activeDigestItems.length === channelItems.length
          ? digestHtml
          : buildReminderDigestHtml(
              activeDigestItems.map((x) => x.item.digestItem),
              todayISO,
            );

      let result: DeliveryResult;
      try {
        result = await activeTransport.send(
          finalDigestHtml,
          channel === "telegram" ? { parseMode: "HTML" } : undefined,
        );
      } catch (e) {
        result = classifyThrownTransportError(e);
      }

      const providerFields = buildProviderMessagePayloadFields(result);
      await completeDurableOutboxSendingOutcome(pool, batchHandle, batchEntry, result);

      for (const { item, entry, handle } of activeDigestItems) {
        await completeDurableOutboxSendingOutcome(pool, handle, entry, result);

        if (result.ok) {
          await markReminderDeliveryStatusStrict(pool, item.deliveryId, "sent", {
            payload: {
              message: item.freshMessage,
              escalationBucket: item.escalationBucket,
              batchedDigest: true,
              evaluatedOn: todayISO,
              dispatchPhase: "sent",
              ...providerFields,
            },
            claimToken: item.claimToken,
          });
          sent += 1;
        } else if (result.skippedUnconfigured) {
          await markReminderDeliveryStatusStrict(pool, item.deliveryId, "skipped", {
            error: "skipped_unconfigured",
            payload: { dispatchPhase: "skipped" },
            claimToken: item.claimToken,
          });
          skipped += 1;
        } else if (result.uncertainOutcome === true) {
          await markReminderDeliveryStatusStrict(pool, item.deliveryId, "delivery_uncertain", {
            error: redactBotToken(
              result.error ?? "delivery_uncertain: gönderim sonrası yanıt doğrulanamadı",
            ),
            payload: {
              dispatchPhase: "delivery_uncertain",
              requiresOperatorReconciliation: true,
              ...providerFields,
            },
            claimToken: item.claimToken,
          });
          failed += 1;
          uncertain += 1;
        } else {
          await markReminderDeliveryStatusStrict(pool, item.deliveryId, "failed", {
            error: redactBotToken(result.error ?? "bilinmeyen hata"),
            payload: { dispatchPhase: "failed_retryable" },
            claimToken: item.claimToken,
          });
          failed += 1;
        }
      }
      continue;
    }

    for (const item of channelItems) {
      const itemEntry: OutboxIntentEntryInput = {
        channel,
        idempotencyKey: item.idempotencyKey,
        bodyText: item.freshMessage,
        bodyFormat: "plain",
        metadata: { todayISO, deliveryId: item.deliveryId },
        legalEntityId: item.legalEntityId,
      };

      // Pre-send durable intent BEFORE external transport send (`F-08`):
      // 1. Claim/insert `notification_outbox` with `metadata.dispatchPhase = 'sending'`
      const outboxHandle = await beginDurableOutboxSendingIntent(pool, itemEntry);
      if (outboxHandle.alreadyHandled) {
        await markReminderDeliveryStatusStrict(pool, item.deliveryId, "skipped", {
          error: "deduped_by_outbox",
          claimToken: item.claimToken,
        });
        skipped += 1;
        continue;
      }

      // 2. Stamp `reminder_deliveries.payload.dispatchPhase = 'sending'` asserting `(id, claim_token)`
      const deliveryFenceOk = await markReminderDeliverySendingStarted(
        pool,
        item.deliveryId,
        item.claimToken,
        {
          outboxIdempotencyKey: item.idempotencyKey,
          outboxId: outboxHandle.outboxId,
        },
      );
      if (!deliveryFenceOk) {
        await releaseUnstartedOutboxIntentBestEffort(pool, outboxHandle);
        continue;
      }

      let result: DeliveryResult;
      try {
        result = await activeTransport.send(item.freshMessage);
      } catch (e) {
        result = classifyThrownTransportError(e);
      }

      const providerFields = buildProviderMessagePayloadFields(result);
      await completeDurableOutboxSendingOutcome(pool, outboxHandle, itemEntry, result);

      if (result.ok) {
        await markReminderDeliveryStatusStrict(pool, item.deliveryId, "sent", {
          payload: {
            message: item.freshMessage,
            escalationBucket: item.escalationBucket,
            evaluatedOn: todayISO,
            dispatchPhase: "sent",
            ...providerFields,
          },
          claimToken: item.claimToken,
        });
        sent += 1;
      } else if (result.skippedUnconfigured) {
        await markReminderDeliveryStatusStrict(pool, item.deliveryId, "skipped", {
          error: "skipped_unconfigured",
          payload: { dispatchPhase: "skipped" },
          claimToken: item.claimToken,
        });
        skipped += 1;
      } else if (result.uncertainOutcome === true) {
        await markReminderDeliveryStatusStrict(pool, item.deliveryId, "delivery_uncertain", {
          error: redactBotToken(
            result.error ?? "delivery_uncertain: gönderim sonrası yanıt doğrulanamadı",
          ),
          payload: {
            dispatchPhase: "delivery_uncertain",
            requiresOperatorReconciliation: true,
            ...providerFields,
          },
          claimToken: item.claimToken,
        });
        failed += 1;
        uncertain += 1;
      } else {
        await markReminderDeliveryStatusStrict(pool, item.deliveryId, "failed", {
          error: redactBotToken(result.error ?? "bilinmeyen hata"),
          payload: { dispatchPhase: "failed_retryable" },
          claimToken: item.claimToken,
        });
        failed += 1;
      }
    }
  }

  return {
    attempted: expiredStaleCount + claimedRows.length,
    sent,
    failed,
    skipped,
    uncertain,
  };
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
              cov.description,
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
     left join public.covenant_records cov on cov.id = d.entity_id and d.entity_table = 'covenant_records'
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
    uncertain: m.get("delivery_uncertain") ?? 0,
  };
}
