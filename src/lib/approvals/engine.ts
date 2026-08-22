// Faz 24A — the approval engine (maker-checker).
//
// Inherited rules: money through @/lib/money, Zod at the boundary, canonical audit() in the same
// transaction as the change (Faz 17/18), nothing here creates a counterparty (Faz 19).
//
// THE CONSOLIDATION, in one sentence: `approvals` is the single Approval entity, migration 0055
// makes every legacy review produce one, and this engine is the only place a NEW approval is
// decided. The two legacy setters (imports/actions.ts, external-assumptions/engine.ts) are left
// exactly as they were — they keep working, and the bridge turns their writes into approvals
// without them knowing. That is what "no third variant" means here: not a rewrite of two working
// domain state machines, but one entity that both now feed.

import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { DomainError } from "@/lib/domain-error";
import { intOrNull, moneyOrNull } from "@/lib/money";
import { parseOrThrow } from "@/lib/validation";
import { firingRules, type ApprovalRuleConfig, type RuleInput } from "./rules";

/* ── schemas ──────────────────────────────────────────────────────────────────────────── */

// MUST stay in lockstep with approvals_subject_table_check in the migrations. The schema takes
// `raw: unknown`, so TypeScript cannot catch a drift here — widening only the database CHECK
// (as Faz 29 first did) leaves this enum rejecting the new value at runtime with a validation
// error and no compile-time warning. phase29:verify now compares the two lists directly.
export const SUBJECT_TABLES = [
  "mapping_reviews", "external_assumptions", "invoices",
  "payment_instances", "ibans", "parties", "bank_transactions",
  // Faz 29 — optimisation runs are approved through this same entity, not a forked one.
  "optimization_runs",
] as const;

export const requestApprovalSchema = z.object({
  subjectTable: z.enum(SUBJECT_TABLES),
  subjectId: z.uuid(),
  subjectLabel: z.string().trim().min(1).optional(),
  requestKind: z.enum([
    "data_review", "amount_threshold", "new_iban", "new_counterparty", "invoice", "payment", "other",
  ]),
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

/**
 * Which configured rules demand a checker for this subject.
 *
 * The decision itself lives in ./rules.ts and is pure; this only supplies it with the configured
 * rows. Reading the rules from the database rather than hard-coding them is the point of 0054 —
 * the thresholds are operator-tunable configuration, not a constant in a source file.
 */
export async function evaluateRules(
  pool: Pool,
  input: RuleInput,
): Promise<ApprovalRuleConfig[]> {
  const r = await pool.query(
    `select code, description, trigger_kind, threshold_amount, applies_to, is_active
     from public.approval_rules where is_active order by code`);
  const configs: ApprovalRuleConfig[] = r.rows.map((row) => ({
    code: row.code,
    description: row.description,
    triggerKind: row.trigger_kind,
    thresholdAmount: moneyOrNull(row.threshold_amount),
    appliesTo: (row.applies_to ?? []) as string[],
    isActive: Boolean(row.is_active),
  }));
  return firingRules(configs, input);
}

/* ── write side ───────────────────────────────────────────────────────────────────────── */

/** Opens a new approval round for a subject. */
export async function requestApproval(pool: Pool, raw: unknown, actorId: string): Promise<{ approvalId: string }> {
  const input = parseOrThrow(requestApprovalSchema, raw, "Onay talebi");
  const client = await pool.connect();
  try {
    await client.query("begin");

    const latest = await client.query(
      `select id, round_no, status from public.approvals
       where subject_table=$1 and subject_id=$2 order by round_no desc limit 1 for update`,
      [input.subjectTable, input.subjectId]);
    if (latest.rowCount === 1 && ["pending", "reworked"].includes(latest.rows[0].status)) {
      throw new DomainError("Bu kayıt için zaten bekleyen bir onay var.");
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
      ]);
    const approvalId = ins.rows[0].id;

    await client.query(
      `insert into public.approval_steps (approval_id, step_no, action, actor, note, to_status)
       values ($1,1,'requested',$2,$3,'pending')`,
      [approvalId, actorId, input.note ?? null]);

    await audit(client, {
      actor: actorId, action: "request_approval", entityTable: "approvals", entityId: approvalId,
      before: null,
      after: {
        subjectTable: input.subjectTable, subjectId: input.subjectId,
        requestKind: input.requestKind, ruleCode: input.ruleCode ?? null, round,
      },
    });
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

/**
 * Decide an approval — the checker's act.
 *
 * MAKER-CHECKER is refused here with a readable message AND by 0053's CHECK constraint. Both,
 * deliberately: this one can be bypassed by any other code path, the constraint cannot.
 *
 * For the two legacy subjects the decision is written back to the domain column in the SAME
 * transaction, so the approvals queue and the existing screens can never disagree. That write
 * re-enters 0055's bridge, which finds the approval already in the matching state and only
 * refreshes `subject_status` — no second round, no recursion.
 */
export async function decideApproval(pool: Pool, raw: unknown, actorId: string): Promise<void> {
  const input = parseOrThrow(decideApprovalSchema, raw, "Onay kararı");
  const client = await pool.connect();
  try {
    await client.query("begin");
    const before = await client.query(
      `select id, subject_table, subject_id, status, requested_by, round_no
       from public.approvals where id=$1 for update`, [input.approvalId]);
    if (before.rowCount === 0) throw new DomainError("Onay kaydı bulunamadı.");
    const a = before.rows[0];

    if (!["pending", "reworked"].includes(a.status)) {
      throw new DomainError(`'${a.status}' durumundaki bir onay yeniden karara bağlanamaz.`);
    }
    if (input.decision === "reworked" && a.status !== "pending") {
      throw new DomainError("Yalnız bekleyen bir onay revizyona gönderilebilir.");
    }
    if (a.requested_by && a.requested_by === actorId) {
      throw new DomainError("Onayı talep eden kişi onaylayamaz (maker-checker).");
    }

    await client.query(
      `update public.approvals
         set status=$2,
             decided_by = case when $2 in ('approved','rejected') then $3::uuid else null end,
             decided_at = case when $2 in ('approved','rejected') then now() else null end,
             decision_note = $4
       where id=$1`,
      [input.approvalId, input.decision, actorId, input.note ?? null]);

    const step = await client.query<{ n: string }>(
      `select coalesce(max(step_no),0)+1 n from public.approval_steps where approval_id=$1`,
      [input.approvalId]);
    await client.query(
      `insert into public.approval_steps (approval_id, step_no, action, actor, note, from_status, to_status)
       values ($1,$2,$3,$4,$5,$6,$7)`,
      [input.approvalId, intOrNull(step.rows[0].n) ?? 1, input.decision, actorId,
       input.note ?? null, a.status, input.decision]);

    // Legacy write-back, same transaction.
    const writeback = LEGACY_WRITEBACK[a.subject_table]?.[input.decision];
    if (writeback) {
      if (a.subject_table === "mapping_reviews") {
        await client.query(
          `update public.mapping_reviews set status=$2, reviewed_at=now(), reviewed_by=$3 where id=$1`,
          [a.subject_id, writeback, actorId]);
      } else {
        // reviewed_at only moves on 'approved' — the exact semantics the legacy setter has,
        // and load-bearing for constraint external_assumptions_check1.
        await client.query(
          `update public.external_assumptions
             set review_status=$2,
                 reviewed_at = case when $2='approved' then now() else reviewed_at end,
                 reviewed_by=$3
           where id=$1`,
          [a.subject_id, writeback, actorId]);
      }
    }

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
      `select id, status from public.approvals where id=$1 for update`, [input.approvalId]);
    if (before.rowCount === 0) throw new DomainError("Onay kaydı bulunamadı.");
    if (before.rows[0].status !== "reworked") {
      throw new DomainError("Yalnız revizyona gönderilmiş bir onay yeniden gönderilebilir.");
    }
    await client.query(`update public.approvals set status='pending' where id=$1`, [input.approvalId]);
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
    `select step_no, action, note, from_status, to_status,
            to_char(created_at at time zone 'Europe/Istanbul','YYYY-MM-DD HH24:MI') as created_at,
            u.display_name as actor_name
     from public.approval_steps s
     left join public.users u on u.id = s.actor
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
