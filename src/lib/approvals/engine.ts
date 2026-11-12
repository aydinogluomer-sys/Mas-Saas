// Faz 24A + Faz 39 + Faz 48 (D2) — the approval engine (maker-checker).
//
// Inherited rules: money through @/lib/money, Zod at the boundary, canonical audit() in the same
// transaction as the change (Faz 17/18), nothing here creates a counterparty (Faz 19), and every
// UPDATE verifies rowCount === 1 before audit() is called (Faz 39).

import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { isTurkishIban, isValidIbanChecksum } from "@/lib/counterparties/rules";
import { DomainError } from "@/lib/domain-error";
import { intOrNull, moneyOrNull } from "@/lib/money";
import { parseOrThrow } from "@/lib/validation";
import { firingRules, requestKindFor, type ApprovalRuleConfig, type RuleInput } from "./rules";

/* ── schemas ──────────────────────────────────────────────────────────────────────────── */

export const SUBJECT_TABLES = [
  "mapping_reviews", "external_assumptions", "invoices",
  "payment_instances", "payments", "ibans", "parties", "bank_transactions",
  "optimization_runs", "payment_runs", "budgets", "budget_lines", "forecast_lines",
] as const;

export const REQUEST_KINDS = [
  "data_review", "amount_threshold", "new_iban", "new_counterparty",
  "invoice", "payment", "payment_run", "budget", "other",
] as const;

export type ApprovalRequestKind = (typeof REQUEST_KINDS)[number];

export const requestApprovalSchema = z.object({
  subjectTable: z.enum(SUBJECT_TABLES),
  subjectId: z.uuid(),
  subjectLabel: z.string().trim().min(1).optional(),
  requestKind: z.enum(REQUEST_KINDS),
  ruleCode: z.string().trim().min(1).optional(),
  amount: z.coerce.number().optional(),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).optional(),
  note: z.string().trim().min(1).optional(),
});

export const decideApprovalSchema = z.object({
  approvalId: z.uuid(),
  decision: z.enum(["approved", "rejected", "reworked"]),
  note: z.string().trim().min(3, "Karar notu en az 3 karakter olmalı").optional(),
});

export const resubmitApprovalSchema = z.object({
  approvalId: z.uuid(),
  note: z.string().trim().min(3).optional(),
});

/* ── rule evaluation (deterministic) ──────────────────────────────────────────────────── */

export async function evaluateRulesWithClient(
  client: Pick<PoolClient, "query">,
  input: RuleInput,
): Promise<ApprovalRuleConfig[]> {
  const r = await client.query(
    `select code, description, trigger_kind, threshold_amount, currency, applies_to, is_active
     from public.approval_rules where is_active order by code`);
  const configs: ApprovalRuleConfig[] = r.rows.map((row) => ({
    code: row.code,
    description: row.description,
    triggerKind: row.trigger_kind,
    thresholdAmount: moneyOrNull(row.threshold_amount),
    currency: String(row.currency),
    appliesTo: (row.applies_to ?? []) as string[],
    isActive: Boolean(row.is_active),
  }));
  return firingRules(configs, input);
}

export async function evaluateRules(
  pool: Pool,
  input: RuleInput,
): Promise<ApprovalRuleConfig[]> {
  return evaluateRulesWithClient(pool, input);
}

/* ── write side ───────────────────────────────────────────────────────────────────────── */

/**
 * Transaction-aware approval round opener. Used inside `createCounterparty`, `addIban`,
 * `createInvoice`, `changeInvoiceStatus`, `payment_instances` mutations, `submitPaymentRunForApproval`,
 * and `requestApproval` so the financial write and its approval request commit or roll back atomically.
 */
export async function requestApprovalWithClient(
  client: PoolClient,
  raw: unknown,
  actorId: string | null,
  opts: { reuseOpen?: boolean } = {},
): Promise<{ approvalId: string; reused: boolean }> {
  const input = parseOrThrow(requestApprovalSchema, raw, "Onay talebi");

  const latest = await client.query<{ id: string; round_no: string; status: string }>(
    `select id, round_no::text as round_no, status from public.approvals
     where subject_table=$1 and subject_id=$2 order by round_no desc limit 1 for update`,
    [input.subjectTable, input.subjectId],
  );
  if (latest.rowCount === 1 && ["pending", "reworked"].includes(latest.rows[0].status)) {
    if (opts.reuseOpen) {
      return { approvalId: latest.rows[0].id, reused: true };
    }
    throw new DomainError("CONFLICT", "Bu kayıt için zaten bekleyen bir onay var.");
  }
  const round = (intOrNull(latest.rows[0]?.round_no) ?? 0) + 1;

  const ins = await client.query<{ id: string }>(
    `insert into public.approvals
       (subject_table, subject_id, subject_label, request_kind, rule_code, round_no,
        amount, currency, requested_by, notes)
     values ($1,$2,$3,$4,$5,$6,$7::numeric,$8,$9,$10) returning id`,
    [
      input.subjectTable, input.subjectId, input.subjectLabel ?? null, input.requestKind,
      input.ruleCode ?? null, round, input.amount ?? null, input.currency ?? null,
      actorId, input.note ?? null,
    ],
  );
  const approvalId = ins.rows[0].id;

  await client.query(
    `insert into public.approval_steps (approval_id, step_no, action, actor, note, to_status)
     values ($1,1,'requested',$2,$3,'pending')`,
    [approvalId, actorId, input.note ?? null],
  );

  await audit(client, {
    actor: actorId, action: "request_approval", entityTable: "approvals", entityId: approvalId,
    before: null,
    after: {
      subjectTable: input.subjectTable, subjectId: input.subjectId,
      requestKind: input.requestKind, ruleCode: input.ruleCode ?? null, round,
    },
  });

  return { approvalId, reused: false };
}

/**
 * Evaluate active `approval_rules` inside an open transaction and, if any rule fires, open (or reuse)
 * an `approvals` round and return `{ fired, approvalId }`.
 */
export async function evaluateAndRequestIfNeededWithClient(
  client: PoolClient,
  params: {
    ruleInput: RuleInput;
    subjectId: string;
    subjectLabel: string;
    amount?: number | null;
    currency?: string | null;
    note?: string;
    actorId: string | null;
  },
): Promise<{ fired: ApprovalRuleConfig[]; approvalId: string | null }> {
  const fired = await evaluateRulesWithClient(client, params.ruleInput);
  if (fired.length === 0) {
    return { fired: [], approvalId: null };
  }
  const rawKind = requestKindFor(fired);
  const requestKind: ApprovalRequestKind = (REQUEST_KINDS as readonly string[]).includes(rawKind)
    ? (rawKind as ApprovalRequestKind)
    : "other";
  const ruleCode = fired.map((r) => r.code).join(",");
  const { approvalId } = await requestApprovalWithClient(
    client,
    {
      subjectTable: params.ruleInput.subjectTable,
      subjectId: params.subjectId,
      subjectLabel: params.subjectLabel,
      requestKind,
      ruleCode,
      amount: params.amount ?? undefined,
      currency: params.currency ?? undefined,
      note: params.note ?? fired.map((r) => r.description).join(" · "),
    },
    params.actorId,
    { reuseOpen: true },
  );
  return { fired, approvalId };
}

/** Opens a new approval round for a subject. */
export async function requestApproval(pool: Pool, raw: unknown, actorId: string): Promise<{ approvalId: string }> {
  const input = parseOrThrow(requestApprovalSchema, raw, "Onay talebi");
  const client = await pool.connect();
  try {
    await client.query("begin");
    const { approvalId } = await requestApprovalWithClient(client, input, actorId);
    await client.query("commit");
    return { approvalId };
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

/** How a canonical decision maps back onto each legacy column. */
const LEGACY_WRITEBACK: Record<string, Record<string, string>> = {
  mapping_reviews: { approved: "accepted", rejected: "rejected", reworked: "open" },
  external_assumptions: { approved: "approved", rejected: "rejected", reworked: "pending_review" },
};

function assertWritebackRow(rowCount: number | null, subjectTable: string): void {
  if (rowCount !== 1) {
    throw new DomainError(
      "CONFLICT",
      `Hedef kayıt (${subjectTable}) onay durumu güncellenemedi veya yetki kısıtına takıldı.`,
    );
  }
}

async function applySubjectWriteback(
  client: PoolClient,
  approval: { id: string; subject_table: string; subject_id: string },
  decision: "approved" | "rejected" | "reworked",
  actorId: string,
  note: string | null,
): Promise<string | null> {
  const { subject_table: tbl, subject_id: subjectId, id: approvalId } = approval;

  // 1) Legacy Faz 24A writebacks
  const legacy = LEGACY_WRITEBACK[tbl]?.[decision];
  if (legacy) {
    if (tbl === "mapping_reviews") {
      const wb = await client.query(
        `update public.mapping_reviews set status=$2, reviewed_at=now(), reviewed_by=$3 where id=$1`,
        [subjectId, legacy, actorId],
      );
      assertWritebackRow(wb.rowCount, tbl);
    } else {
      const wb = await client.query(
        `update public.external_assumptions
            set review_status=$2,
                reviewed_at = case when $2='approved' then now() else reviewed_at end,
                reviewed_by=$3
          where id=$1`,
        [subjectId, legacy, actorId],
      );
      assertWritebackRow(wb.rowCount, tbl);
    }
    return legacy;
  }

  // 2) Faz 48 (D2): Payment Run maker-checker writeback
  if (tbl === "payment_runs") {
    if (decision === "approved") {
      const wb = await client.query(
        `update public.payment_runs
            set status='approved', approved_by=$2, approved_at=now(), approval_id=$3
          where id=$1`,
        [subjectId, actorId, approvalId],
      );
      assertWritebackRow(wb.rowCount, tbl);

      // Refresh iban_verified on included items whose linked counterparty IBAN is active + approved + valid TR IBAN
      const items = await client.query<{ id: string; beneficiary_iban: string }>(
        `select pri.id, pri.beneficiary_iban
           from public.payment_run_items pri
           join public.ibans ib on ib.id = pri.iban_id
          where pri.run_id = $1
            and pri.status = 'included'
            and pri.iban_verified = false
            and ib.is_active = true
            and ib.approval_status = 'approved'`,
        [subjectId],
      );
      const validItemIds = items.rows
        .filter((r) => isTurkishIban(r.beneficiary_iban) && isValidIbanChecksum(r.beneficiary_iban))
        .map((r) => r.id);
      if (validItemIds.length > 0) {
        await client.query(
          `update public.payment_run_items set iban_verified = true where id = any($1::uuid[])`,
          [validItemIds],
        );
      }
      return "approved";
    }
    if (decision === "rejected") {
      const reason = note ?? "Onay kuyruğunda reddedildi";
      const wb = await client.query(
        `update public.payment_runs
            set status='cancelled', cancelled_at=now(), cancel_reason=$2, approval_id=$3
          where id=$1`,
        [subjectId, reason, approvalId],
      );
      assertWritebackRow(wb.rowCount, tbl);
      await client.query(
        `update public.payment_run_items set status='excluded' where run_id=$1 and status='included'`,
        [subjectId],
      );
      return "cancelled";
    }
    const wb = await client.query(
      `update public.payment_runs set status='draft', approval_id=$2 where id=$1`,
      [subjectId, approvalId],
    );
    assertWritebackRow(wb.rowCount, tbl);
    return "draft";
  }

  // 3) Faz 48 (D2): IBAN BEC fraud shield writeback
  if (tbl === "ibans") {
    if (decision === "approved") {
      const wb = await client.query<{ iban_normalized: string; is_active: boolean }>(
        `update public.ibans
            set approval_status='approved', verified_by=$2, verified_at=now(), approval_id=$3
          where id=$1
          returning iban_normalized, is_active`,
        [subjectId, actorId, approvalId],
      );
      assertWritebackRow(wb.rowCount, tbl);
      const row = wb.rows[0];
      if (row.is_active && isTurkishIban(row.iban_normalized) && isValidIbanChecksum(row.iban_normalized)) {
        await client.query(
          `update public.payment_run_items
              set iban_verified = true
            where iban_id = $1 and status = 'included' and iban_verified = false`,
          [subjectId],
        );
      }
      return "approved";
    }
    const nextStatus = decision === "rejected" ? "rejected" : "pending_approval";
    const wb = await client.query(
      `update public.ibans set approval_status=$2, approval_id=$3 where id=$1`,
      [subjectId, nextStatus, approvalId],
    );
    assertWritebackRow(wb.rowCount, tbl);
    if (decision === "rejected") {
      await client.query(
        `update public.payment_run_items
            set iban_verified = false
          where iban_id = $1 and status = 'included' and iban_verified = true`,
        [subjectId],
      );
    }
    return nextStatus;
  }

  // 4) Faz 48 (D2): Invoices, Payment Instances & Counterparties (parties) writeback
  if (tbl === "invoices" || tbl === "payment_instances" || tbl === "parties") {
    if (decision === "approved") {
      const wb = await client.query(
        `update public.${tbl}
            set approval_status='approved', approved_by=$2, approved_at=now(), approval_id=$3
          where id=$1`,
        [subjectId, actorId, approvalId],
      );
      assertWritebackRow(wb.rowCount, tbl);
      return "approved";
    }
    const nextStatus = decision === "rejected" ? "rejected" : "pending_approval";
    const wb = await client.query(
      `update public.${tbl} set approval_status=$2, approval_id=$3 where id=$1`,
      [subjectId, nextStatus, approvalId],
    );
    assertWritebackRow(wb.rowCount, tbl);
    return nextStatus;
  }

  // 5) Faz 48 / 50: Planning lines (budget_lines / forecast_lines) maker-checker writeback
  if (tbl === "budget_lines" || tbl === "forecast_lines") {
    if (decision === "approved") {
      const wb = await client.query(
        `update public.${tbl}
            set version_status='approved', approved_by=$2, approved_at=now()
          where id=$1`,
        [subjectId, actorId],
      );
      assertWritebackRow(wb.rowCount, tbl);
      return "approved";
    }
    return "draft";
  }

  return null;
}

/**
 * Decide an approval — the checker's act.
 *
 * Faz 39 + Faz 48: both the `approvals` UPDATE and every subject writeback verify `rowCount === 1`
 * before `audit()` runs so an RLS-blocked writeback rolls back atomically instead of writing a
 * false audit entry.
 */
export async function decideApproval(pool: Pool, raw: unknown, actorId: string): Promise<void> {
  const input = parseOrThrow(decideApprovalSchema, raw, "Onay kararı");
  const client = await pool.connect();
  try {
    await client.query("begin");
    const before = await client.query(
      `select id, subject_table, subject_id, status, requested_by, round_no
       from public.approvals where id=$1 for update`, [input.approvalId]);
    if (before.rowCount === 0) throw new DomainError("NOT_FOUND", "Onay kaydı bulunamadı.");
    const a = before.rows[0];

    if (!["pending", "reworked"].includes(a.status)) {
      throw new DomainError("CONFLICT", `'${a.status}' durumundaki bir onay yeniden karara bağlanamaz.`);
    }
    if (input.decision === "reworked" && a.status !== "pending") {
      throw new DomainError("CONFLICT", "Yalnız bekleyen bir onay revizyona gönderilebilir.");
    }
    if (a.requested_by && a.requested_by === actorId) {
      throw new DomainError("FORBIDDEN", "Onayı talep eden kişi onaylayamaz (maker-checker).");
    }

    const approvalUpdate = await client.query(
      `update public.approvals
         set status=$2,
             decided_by = case when $2 in ('approved','rejected') then $3::uuid else null end,
             decided_at = case when $2 in ('approved','rejected') then now() else null end,
             decision_note = $4
       where id=$1`,
      [input.approvalId, input.decision, actorId, input.note ?? null]);
    if (approvalUpdate.rowCount !== 1) {
      throw new DomainError("CONFLICT", "Onay kaydı güncellenemedi veya bu işlem için yetkiniz yok.");
    }

    const step = await client.query<{ n: string }>(
      `select coalesce(max(step_no),0)+1 n from public.approval_steps where approval_id=$1`,
      [input.approvalId]);
    await client.query(
      `insert into public.approval_steps (approval_id, step_no, action, actor, note, from_status, to_status)
       values ($1,$2,$3,$4,$5,$6,$7)`,
      [input.approvalId, intOrNull(step.rows[0].n) ?? 1, input.decision, actorId,
       input.note ?? null, a.status, input.decision]);

    const writeback = await applySubjectWriteback(
      client,
      { id: a.id, subject_table: a.subject_table, subject_id: a.subject_id },
      input.decision,
      actorId,
      input.note ?? null,
    );

    await audit(client, {
      actor: actorId, action: "decide_approval", entityTable: "approvals", entityId: input.approvalId,
      before: { status: a.status, round_no: a.round_no },
      after: {
        status: input.decision, note: input.note ?? null,
        subjectTable: a.subject_table, legacyWriteback: writeback ?? null,
      },
    });
    await client.query("commit");
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

/** The maker resubmits after a rework request. */
export async function resubmitApproval(pool: Pool, raw: unknown, actorId: string): Promise<void> {
  const input = parseOrThrow(resubmitApprovalSchema, raw, "Yeniden gönderim");
  const client = await pool.connect();
  try {
    await client.query("begin");
    const before = await client.query(
      `select id, status, subject_table, subject_id from public.approvals where id=$1 for update`,
      [input.approvalId]);
    if (before.rowCount === 0) throw new DomainError("NOT_FOUND", "Onay kaydı bulunamadı.");
    if (before.rows[0].status !== "reworked") {
      throw new DomainError("CONFLICT", "Yalnız revizyona gönderilmiş bir onay yeniden gönderilebilir.");
    }
    const upd = await client.query(`update public.approvals set status='pending' where id=$1`, [input.approvalId]);
    if (upd.rowCount !== 1) {
      throw new DomainError("CONFLICT", "Onay kaydı yeniden gönderilemedi.");
    }
    if (before.rows[0].subject_table === "payment_runs") {
      await client.query(
        `update public.payment_runs set status='pending_approval' where id=$1 and status='draft'`,
        [before.rows[0].subject_id],
      );
    }
    const step = await client.query<{ n: string }>(
      `select coalesce(max(step_no),0)+1 n from public.approval_steps where approval_id=$1`,
      [input.approvalId]);
    await client.query(
      `insert into public.approval_steps (approval_id, step_no, action, actor, note, from_status, to_status)
       values ($1,$2,'resubmitted',$3,$4,'reworked','pending')`,
      [input.approvalId, intOrNull(step.rows[0].n) ?? 1, actorId, input.note ?? null]);
    await audit(client, {
      actor: actorId, action: "resubmit_approval", entityTable: "approvals", entityId: input.approvalId,
      before: { status: "reworked" }, after: { status: "pending", note: input.note ?? null },
    });
    await client.query("commit");
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

/* ── read side ────────────────────────────────────────────────────────────────────────── */

export interface ApprovalRow {
  id: string;
  subjectTable: string;
  subjectId: string;
  subjectLabel: string | null;
  requestKind: string;
  ruleCode: string | null;
  roundNo: number;
  status: string;
  subjectStatus: string | null;
  amount: number | null;
  currency: string | null;
  requestedByName: string | null;
  requestedAt: string;
  decidedByName: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  stepCount: number;
}

export async function loadApprovalQueue(
  pool: Pool, opts: { status?: string; limit?: number } = {},
): Promise<ApprovalRow[]> {
  const r = await pool.query(
    `select id::text, subject_table, subject_id::text, subject_label, request_kind, rule_code,
            round_no, status, subject_status, amount, currency,
            requested_by_name, to_char(requested_at at time zone 'Europe/Istanbul','YYYY-MM-DD HH24:MI') as requested_at,
            decided_by_name, to_char(decided_at at time zone 'Europe/Istanbul','YYYY-MM-DD HH24:MI') as decided_at,
            decision_note, step_count
     from public.approval_queue
     where ($1='' or status=$1)
     order by case status when 'pending' then 0 when 'reworked' then 1 else 2 end,
              requested_at desc
     limit $2`,
    [opts.status ?? "", opts.limit ?? 200]);
  return r.rows.map((x) => ({
    id: x.id, subjectTable: x.subject_table, subjectId: x.subject_id,
    subjectLabel: x.subject_label, requestKind: x.request_kind, ruleCode: x.rule_code,
    roundNo: intOrNull(x.round_no) ?? 1, status: x.status, subjectStatus: x.subject_status,
    amount: moneyOrNull(x.amount), currency: x.currency,
    requestedByName: x.requested_by_name, requestedAt: x.requested_at,
    decidedByName: x.decided_by_name, decidedAt: x.decided_at,
    decisionNote: x.decision_note, stepCount: intOrNull(x.step_count) ?? 0,
  }));
}

export async function loadApprovalSteps(pool: Pool, approvalId: string) {
  const r = await pool.query(
    `select s.step_no, s.action, s.note, s.from_status, s.to_status,
            to_char(s.created_at at time zone 'Europe/Istanbul','YYYY-MM-DD HH24:MI') as created_at,
            public.user_display_label(s.actor) as actor_name
     from public.approval_steps s
     where s.approval_id=$1 order by s.step_no`, [approvalId]);
  return r.rows.map((x) => ({
    stepNo: intOrNull(x.step_no) ?? 0, action: x.action, note: x.note,
    fromStatus: x.from_status, toStatus: x.to_status,
    createdAt: x.created_at, actorName: x.actor_name,
  }));
}

export async function loadApprovalRules(pool: Pool) {
  const r = await pool.query(
    `select id::text, code, description, trigger_kind, threshold_amount, currency,
            applies_to, is_active
     from public.approval_rules order by trigger_kind, code`);
  return r.rows.map((x) => ({
    id: x.id, code: x.code, description: x.description, triggerKind: x.trigger_kind,
    thresholdAmount: moneyOrNull(x.threshold_amount), currency: x.currency,
    appliesTo: (x.applies_to ?? []) as string[], isActive: Boolean(x.is_active),
  }));
}

/** Counts for the dashboard badge. */
export async function loadApprovalCounts(pool: Pool) {
  const r = await pool.query(
    `select count(*) filter (where status='pending')::int as pending,
            count(*) filter (where status='reworked')::int as reworked,
            count(*) filter (where status='approved')::int as approved,
            count(*) filter (where status='rejected')::int as rejected
     from public.approvals`);
  const x = r.rows[0];
  return {
    pending: intOrNull(x.pending) ?? 0, reworked: intOrNull(x.reworked) ?? 0,
    approved: intOrNull(x.approved) ?? 0, rejected: intOrNull(x.rejected) ?? 0,
  };
}

export type { PoolClient };
