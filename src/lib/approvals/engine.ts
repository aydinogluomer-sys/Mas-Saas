// Faz 24A + Faz 39 + Faz 48 (D2) — the approval engine (maker-checker).
//
// Inherited rules: money through @/lib/money, Zod at the boundary, canonical audit() in the same
// transaction as the change (Faz 17/18), nothing here creates a counterparty (Faz 19), and every
// UPDATE verifies rowCount === 1 before audit() is called (Faz 39).

import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { isTurkishIban, isValidIbanChecksum, normalizeIban } from "@/lib/counterparties/rules";
import { DomainError } from "@/lib/domain-error";
import { decimal, intOrNull, money, moneyOrNull } from "@/lib/money";
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
  justification: z.string().trim().max(1000).optional(),
});

export const resubmitApprovalSchema = z.object({
  approvalId: z.uuid(),
  note: z.string().trim().min(3).optional(),
});

export const updateGovernanceSettingsSchema = z.object({
  allowSingleOperatorSelfApproval: z.boolean(),
  minJustificationLength: z.coerce
    .number()
    .int()
    .min(10, "Asgari gerekçe uzunluğu en az 10 karakter olmalıdır")
    .max(500, "Asgari gerekçe uzunluğu en fazla 500 karakter olabilir")
    .default(10),
});

export const TRIGGER_KINDS = [
  "amount_threshold",
  "new_iban",
  "new_counterparty",
  "invoice",
  "payment",
  "payment_run",
  "budget",
] as const;
export type ApprovalTriggerKind = (typeof TRIGGER_KINDS)[number];

export const upsertApprovalRuleSchema = z.object({
  ruleId: z.uuid().optional(),
  code: z
    .string()
    .trim()
    .min(2, "Kural kodu en az 2 karakter olmalıdır")
    .max(64)
    .regex(/^[a-z0-9_]+$/, "Kural kodu yalnız küçük harf, rakam ve alt çizgi içerebilir"),
  description: z.string().trim().min(3, "Kural açıklaması en az 3 karakter olmalıdır").max(240),
  triggerKind: z.preprocess(
    (v) => (v === "amount_gte" ? "amount_threshold" : v === "always" ? "payment" : v),
    z.enum(TRIGGER_KINDS),
  ),
  thresholdAmount: z.number().min(0, "Eşik tutarı negatif olamaz").nullable().optional(),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).default("TRY"),
  appliesTo: z.array(z.string().trim().min(1)).default([]),
  isActive: z.boolean().default(true),
});

export interface ApprovalGovernanceSettings {
  allowSingleOperatorSelfApproval: boolean;
  minJustificationLength: number;
  updatedBy: string | null;
  updatedAt: string | null;
}

export interface SelfApprovalEvaluation {
  allowed: true;
  activeApproverCount: number;
  minJustificationLength: number;
  justification: string;
}

function isMissingRelationOrCol(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === "42P01" || code === "42703";
}

/**
 * F-46 (A1): Evaluates Controlled Single-Operator 4-Eyes Policy inside an active transaction.
 *
 * Self-approval (`maker === checker`) is ONLY permitted when:
 *   1) `activeApproverCount` (`admin` + `finance_manager` with `is_active = true`) <= 1, AND
 *   2) `allow_single_operator_self_approval === true` in `approval_governance_settings`, AND
 *   3) actor's active role is `'admin'`, AND
 *   4) trimmed justification length >= `Math.max(10, min_justification_length)`.
 *
 * Whenever `activeApproverCount >= 2`, strict `maker <> checker` is enforced unconditionally.
 */
export async function evaluateSelfApprovalEligibility(
  client: Pick<PoolClient, "query">,
  actorId: string,
  justification?: string | null,
): Promise<SelfApprovalEvaluation> {
  const countRes = await client.query<{ cnt: number | string }>(
    `select count(*)::int as cnt
       from public.users
      where is_active = true
        and role in ('finance_approver', 'finance_manager', 'admin')`,
  );
  const activeApproverCount = Number(countRes.rows[0]?.cnt ?? 0);

  if (activeApproverCount >= 2) {
    throw new DomainError(
      "FORBIDDEN",
      `Sistemde ${activeApproverCount} aktif onaycı (admin / finans yöneticisi / onaylayıcı) bulunduğu için 4-göz (maker-checker) kuralı zorunludur; kendi oluşturduğunuz kaydı başka bir onaycı karara bağlamalıdır.`,
    );
  }

  const actorRes = await client.query<{ role: string }>(
    `select role from public.users where id = $1 and is_active = true`,
    [actorId],
  );
  const actorRole = actorRes.rows[0]?.role ?? null;

  const govRes = await client
    .query<{
      allow_single_operator_self_approval: boolean;
      min_justification_length: number | string;
    }>(
      `select allow_single_operator_self_approval, min_justification_length
         from public.approval_governance_settings
        where singleton_id = true`,
    )
    .catch((err: unknown) => {
      if (isMissingRelationOrCol(err)) {
        return {
          rows: [{ allow_single_operator_self_approval: false, min_justification_length: 10 }],
          rowCount: 1,
        };
      }
      throw err;
    });

  const govRow = govRes.rows[0];
  const allowSingleOperator =
    govRow == null ? false : Boolean(govRow.allow_single_operator_self_approval);
  const minJustificationLength = Math.max(
    10,
    intOrNull(govRow?.min_justification_length) ?? 10,
  );

  if (!allowSingleOperator) {
    throw new DomainError(
      "FORBIDDEN",
      "Tek operatör öz-onay politikası kapalı; talep eden kişi kendi kaydını onaylayamaz (maker-checker).",
    );
  }

  if (actorRole !== "admin" || activeApproverCount !== 1) {
    throw new DomainError(
      "FORBIDDEN",
      "Tek aktif onaycı öz-onay istisnası yalnızca aktif 'admin' rolü için geçerlidir (maker-checker).",
    );
  }

  const trimmed = (justification ?? "").trim();
  if (trimmed.length < minJustificationLength) {
    throw new DomainError(
      "VALIDATION",
      `Tek operatör öz-onayı için en az ${minJustificationLength} karakterlik gerekçe notu zorunludur.`,
    );
  }

  return {
    allowed: true,
    activeApproverCount,
    minJustificationLength,
    justification: trimmed,
  };
}

export async function loadApprovalGovernanceSettings(
  pool: Pick<Pool, "query">,
): Promise<ApprovalGovernanceSettings> {
  const r = await pool
    .query<{
      allow_single_operator_self_approval: boolean;
      min_justification_length: number | string;
      updated_by: string | null;
      updated_at: string | null;
    }>(
      `select allow_single_operator_self_approval,
              min_justification_length,
              updated_by::text as updated_by,
              to_char(updated_at at time zone 'Europe/Istanbul', 'YYYY-MM-DD HH24:MI') as updated_at
         from public.approval_governance_settings
        where singleton_id = true`,
    )
    .catch((err: unknown) => {
      if (isMissingRelationOrCol(err)) return { rows: [], rowCount: 0 };
      throw err;
    });

  const row = r.rows[0];
  if (!row) {
    return {
      allowSingleOperatorSelfApproval: false,
      minJustificationLength: 10,
      updatedBy: null,
      updatedAt: null,
    };
  }
  return {
    allowSingleOperatorSelfApproval: Boolean(row.allow_single_operator_self_approval),
    minJustificationLength: Math.max(10, intOrNull(row.min_justification_length) ?? 10),
    updatedBy: row.updated_by ?? null,
    updatedAt: row.updated_at ?? null,
  };
}

export async function loadActiveApproverCount(pool: Pick<Pool, "query">): Promise<number> {
  const r = await pool
    .query<{ cnt: number | string }>(
      `select count(*)::int as cnt
         from public.users
        where is_active = true
          and role in ('finance_approver', 'finance_manager', 'admin')`,
    )
    .catch(() => ({ rows: [{ cnt: 0 }], rowCount: 1 }));
  return Number(r.rows[0]?.cnt ?? 0);
}

async function assertAdminActorWithClient(
  client: Pick<PoolClient, "query">,
  actorId: string,
): Promise<void> {
  const r = await client.query<{ role: string }>(
    `select role from public.users where id = $1 and is_active = true`,
    [actorId],
  );
  if (r.rows[0]?.role !== "admin") {
    throw new DomainError(
      "FORBIDDEN",
      "Onay yönetişim politikası ve kural eşikleri yalnızca 'admin' tarafından değiştirilebilir.",
    );
  }
}

export async function updateApprovalGovernanceSettings(
  pool: Pool,
  raw: unknown,
  actorId: string,
): Promise<ApprovalGovernanceSettings> {
  const input = parseOrThrow(updateGovernanceSettingsSchema, raw, "Onay yönetişim politikası");
  const client = await pool.connect();
  try {
    await client.query("begin");
    await assertAdminActorWithClient(client, actorId);

    if (input.allowSingleOperatorSelfApproval) {
      const countRes = await client.query<{ cnt: number | string }>(
        `select count(*)::int as cnt
           from public.users
          where is_active = true
            and role in ('finance_approver', 'finance_manager', 'admin')`,
      );
      const activeApproverCount = Number(countRes.rows[0]?.cnt ?? 0);
      if (activeApproverCount >= 2) {
        throw new DomainError(
          "FORBIDDEN",
          `Sistemde ${activeApproverCount} aktif onaycı bulunduğu için tek operatör öz-onay istisnası etkinleştirilemez (zorunlu 4-göz maker-checker).`,
        );
      }
    }

    const beforeRes = await client.query<{
      allow_single_operator_self_approval: boolean;
      min_justification_length: number | string;
    }>(
      `select allow_single_operator_self_approval, min_justification_length
         from public.approval_governance_settings
        where singleton_id = true
        for update`,
    );
    const prev = beforeRes.rows[0] ?? null;

    const upRes = await client.query<{
      allow_single_operator_self_approval: boolean;
      min_justification_length: number | string;
      updated_by: string | null;
      updated_at: string | null;
    }>(
      `insert into public.approval_governance_settings
         (singleton_id, allow_single_operator_self_approval, min_justification_length, updated_by)
       values (true, $1, $2, $3)
       on conflict (singleton_id) do update set
         allow_single_operator_self_approval = excluded.allow_single_operator_self_approval,
         min_justification_length = excluded.min_justification_length,
         updated_by = excluded.updated_by,
         updated_at = now()
       returning allow_single_operator_self_approval,
                 min_justification_length,
                 updated_by::text as updated_by,
                 to_char(updated_at at time zone 'Europe/Istanbul', 'YYYY-MM-DD HH24:MI') as updated_at`,
      [input.allowSingleOperatorSelfApproval, input.minJustificationLength, actorId],
    );
    const updated = upRes.rows[0];

    await audit(client, {
      actor: actorId,
      action: "update_approval_governance_settings",
      entityTable: "approval_governance_settings",
      entityId: null,
      before: prev
        ? {
            allowSingleOperatorSelfApproval: Boolean(prev.allow_single_operator_self_approval),
            minJustificationLength: intOrNull(prev.min_justification_length) ?? 10,
          }
        : null,
      after: {
        allowSingleOperatorSelfApproval: Boolean(updated.allow_single_operator_self_approval),
        minJustificationLength: intOrNull(updated.min_justification_length) ?? 10,
      },
    });

    await client.query("commit");
    return {
      allowSingleOperatorSelfApproval: Boolean(updated.allow_single_operator_self_approval),
      minJustificationLength: intOrNull(updated.min_justification_length) ?? 10,
      updatedBy: updated.updated_by ?? null,
      updatedAt: updated.updated_at ?? null,
    };
  } catch (e) {
    await client.query("rollback").catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

export async function upsertApprovalRule(
  pool: Pool,
  raw: unknown,
  actorId: string,
): Promise<{ ruleId: string }> {
  const input = parseOrThrow(upsertApprovalRuleSchema, raw, "Onay kuralı");
  const normalizedThreshold =
    input.triggerKind === "amount_threshold" ? (input.thresholdAmount ?? null) : null;
  if (input.triggerKind === "amount_threshold" && normalizedThreshold == null) {
    throw new DomainError(
      "VALIDATION",
      "Tutar eşiği ('amount_threshold') kuralı için eşik tutarı zorunludur.",
    );
  }

  const client = await pool.connect();
  try {
    await client.query("begin");
    await assertAdminActorWithClient(client, actorId);

    let ruleId: string;
    if (input.ruleId) {
      const prevRes = await client.query(
        `select id::text, code, description, trigger_kind, threshold_amount, currency, applies_to, is_active
           from public.approval_rules
          where id = $1
          for update`,
        [input.ruleId],
      );
      if (prevRes.rowCount === 0) {
        throw new DomainError("NOT_FOUND", "Güncellenecek onay kuralı bulunamadı.");
      }
      const prev = prevRes.rows[0];
      const upd = await client.query<{ id: string }>(
        `update public.approval_rules
            set description = $2,
                trigger_kind = $3,
                threshold_amount = $4::numeric,
                currency = $5,
                applies_to = $6::text[],
                is_active = $7
          where id = $1
          returning id::text as id`,
        [
          input.ruleId,
          input.description,
          input.triggerKind,
          normalizedThreshold,
          input.currency,
          input.appliesTo,
          input.isActive,
        ],
      );
      if (upd.rowCount !== 1) {
        throw new DomainError("CONFLICT", "Onay kuralı güncellenemedi.");
      }
      ruleId = upd.rows[0].id;
      await audit(client, {
        actor: actorId,
        action: "update_approval_rule",
        entityTable: "approval_rules",
        entityId: ruleId,
        before: {
          code: prev.code,
          description: prev.description,
          triggerKind: prev.trigger_kind,
          thresholdAmount: moneyOrNull(prev.threshold_amount),
          currency: prev.currency,
          appliesTo: prev.applies_to,
          isActive: Boolean(prev.is_active),
        },
        after: {
          code: prev.code,
          description: input.description,
          triggerKind: input.triggerKind,
          thresholdAmount: normalizedThreshold,
          currency: input.currency,
          appliesTo: input.appliesTo,
          isActive: input.isActive,
        },
      });
    } else {
      const ins = await client.query<{ id: string }>(
        `insert into public.approval_rules
           (code, description, trigger_kind, threshold_amount, currency, applies_to, is_active)
         values ($1, $2, $3, $4::numeric, $5, $6::text[], $7)
         on conflict (code) do update set
           description = excluded.description,
           trigger_kind = excluded.trigger_kind,
           threshold_amount = excluded.threshold_amount,
           currency = excluded.currency,
           applies_to = excluded.applies_to,
           is_active = excluded.is_active
         returning id::text as id`,
        [
          input.code,
          input.description,
          input.triggerKind,
          normalizedThreshold,
          input.currency,
          input.appliesTo,
          input.isActive,
        ],
      );
      ruleId = ins.rows[0].id;
      await audit(client, {
        actor: actorId,
        action: "upsert_approval_rule",
        entityTable: "approval_rules",
        entityId: ruleId,
        before: null,
        after: {
          code: input.code,
          description: input.description,
          triggerKind: input.triggerKind,
          thresholdAmount: normalizedThreshold,
          currency: input.currency,
          appliesTo: input.appliesTo,
          isActive: input.isActive,
        },
      });
    }

    await client.query("commit");
    return { ruleId };
  } catch (e) {
    await client.query("rollback").catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

export async function toggleApprovalRule(
  pool: Pool,
  ruleId: string,
  isActive: boolean,
  actorId: string,
): Promise<void> {
  const parsedId = parseOrThrow(z.uuid(), ruleId, "Onay kuralı kimliği");
  const client = await pool.connect();
  try {
    await client.query("begin");
    await assertAdminActorWithClient(client, actorId);

    const prevRes = await client.query<{ code: string; is_active: boolean }>(
      `select code, is_active from public.approval_rules where id = $1 for update`,
      [parsedId],
    );
    if (prevRes.rowCount === 0) {
      throw new DomainError("NOT_FOUND", "Onay kuralı bulunamadı.");
    }
    const prev = prevRes.rows[0];

    const upd = await client.query(
      `update public.approval_rules set is_active = $2 where id = $1`,
      [parsedId, Boolean(isActive)],
    );
    if (upd.rowCount !== 1) {
      throw new DomainError("CONFLICT", "Onay kuralı durumu güncellenemedi.");
    }

    await audit(client, {
      actor: actorId,
      action: "toggle_approval_rule",
      entityTable: "approval_rules",
      entityId: parsedId,
      before: { code: prev.code, isActive: Boolean(prev.is_active) },
      after: { code: prev.code, isActive: Boolean(isActive) },
    });

    await client.query("commit");
  } catch (e) {
    await client.query("rollback").catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}

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
  selfOverride: { selfApprovedOverride: boolean; selfApprovalJustification: string | null } = {
    selfApprovedOverride: false,
    selfApprovalJustification: null,
  },
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

  // 2) Faz 48 (D2) + F-46 (A1): Payment Run maker-checker writeback
  if (tbl === "payment_runs") {
    if (decision === "approved") {
      const wb = await client.query(
        `update public.payment_runs
            set status='approved',
                approved_by=$2,
                approved_at=now(),
                approval_id=$3,
                self_approved_override=$4,
                self_approval_justification=$5
          where id=$1`,
        [
          subjectId,
          actorId,
          approvalId,
          selfOverride.selfApprovedOverride,
          selfOverride.selfApprovalJustification,
        ],
      );
      assertWritebackRow(wb.rowCount, tbl);

      // Refresh iban_verified ONLY on included items whose linked counterparty IBAN is active + approved + verified + exact match + valid TR IBAN
      const items = await client.query<{
        id: string;
        beneficiary_iban: string | null;
        iban_normalized?: string | null;
        verified_at?: string | null;
      }>(
        `select pri.id, pri.beneficiary_iban, ib.iban_normalized, ib.verified_at::text as verified_at
           from public.payment_run_items pri
           join public.ibans ib on ib.id = pri.iban_id
          where pri.run_id = $1
            and pri.status = 'included'
            and pri.iban_verified = false
            and ib.is_active = true
            and ib.approval_status = 'approved'
            and ib.verified_at is not null`,
        [subjectId],
      );
      const validItemIds = items.rows
        .filter((r) => {
          const beneficiary = typeof r.beneficiary_iban === "string" ? r.beneficiary_iban : "";
          if (!beneficiary) return false;
          if ("verified_at" in r && r.verified_at == null) return false;
          if (typeof r.iban_normalized === "string" && r.iban_normalized.trim() !== "") {
            if (normalizeIban(beneficiary) !== normalizeIban(r.iban_normalized)) return false;
          }
          return isTurkishIban(beneficiary) && isValidIbanChecksum(beneficiary);
        })
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

  // 3) Faz 48 (D2): IBAN BEC fraud shield writeback (hard-gated on ISO 13616 MOD-97 checksum)
  if (tbl === "ibans") {
    if (decision === "approved") {
      const pre = await client.query<{ iban_normalized: string; is_active: boolean }>(
        `select iban_normalized, is_active from public.ibans where id=$1 for update`,
        [subjectId],
      );
      assertWritebackRow(pre.rowCount, tbl);
      const candidateIban = String(pre.rows[0].iban_normalized ?? "").trim();
      const trLengthInvalid = candidateIban.startsWith("TR") && !isTurkishIban(candidateIban);
      if (!isValidIbanChecksum(candidateIban) || trLengthInvalid) {
        throw new DomainError(
          "VALIDATION",
          "BEC Kalkanı: IBAN biçimi veya ISO 13616 MOD-97 kontrol basamağı geçersiz olduğu için IBAN kaydı onaylanamaz; lütfen kaydı reddedip geçerli bir IBAN tanımlayın.",
        );
      }
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
            where iban_id = $1
              and status = 'included'
              and iban_verified = false
              and upper(regexp_replace(beneficiary_iban, '\\s', '', 'g')) = $2`,
          [subjectId, normalizeIban(row.iban_normalized)],
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

  // 6) Dalga 2B (M-54): Optimization runs (`optimization_runs`) approval writeback & execution
  if (tbl === "optimization_runs") {
    if (decision !== "approved") {
      return decision === "rejected" ? "rejected" : "reworked";
    }
    const roleRes = await client.query<{ rol: string }>(`select current_user::text as rol`);
    const dbRole = roleRes.rows[0]?.rol ?? "";
    // `mas_radar_finance_approver` is a pure checker without operational INSERT rights on `payment_runs`;
    // managers/admins/operators execute immediately on approval, while pure approvers unlock one-click execution.
    if (dbRole === "mas_radar_finance_approver") {
      return "approved_ready_for_execution";
    }
    await applyApprovedOptimizationRecommendationsInTx(client, subjectId, actorId, approvalId);
    return "executed";
  }

  return null;
}

export interface OptimizationExecutionSummary {
  runId: string;
  alreadyExecuted: boolean;
  deferredCount: number;
  advancedCount: number;
  paymentRunId: string | null;
  paymentRunCode: string | null;
  paymentRunItemCount: number;
}

async function applyApprovedOptimizationRecommendationsInTx(
  client: PoolClient,
  runId: string,
  actorId: string,
  approvalId: string | null,
): Promise<OptimizationExecutionSummary> {
  const runRes = await client.query<{
    id: string;
    name: string;
    currency: string;
    anchor_date: string;
    notes: string | null;
  }>(
    `select id::text, name, currency, to_char(anchor_date, 'YYYY-MM-DD') as anchor_date, notes
       from public.optimization_runs
      where id = $1
      for update`,
    [runId],
  );
  if (runRes.rowCount !== 1) {
    throw new DomainError("NOT_FOUND", "Optimizasyon çalışması bulunamadı.");
  }
  const optRun = runRes.rows[0];
  if (optRun.notes && optRun.notes.includes("[EXECUTED:")) {
    return {
      runId,
      alreadyExecuted: true,
      deferredCount: 0,
      advancedCount: 0,
      paymentRunId: null,
      paymentRunCode: null,
      paymentRunItemCount: 0,
    };
  }

  const recsRes = await client.query<{
    id: string;
    action_kind: string;
    subject_table: string | null;
    subject_id: string | null;
    subject_label: string | null;
    current_date_value: string | null;
    proposed_date: string | null;
    amount: string | null;
    currency: string;
  }>(
    `select id::text, action_kind, subject_table, subject_id::text, subject_label,
            to_char(current_date_value, 'YYYY-MM-DD') as current_date_value,
            to_char(proposed_date, 'YYYY-MM-DD') as proposed_date,
            amount::text, currency
       from public.optimization_recommendations
      where run_id = $1
      order by rank asc`,
    [runId],
  );

  let deferredCount = 0;
  let advancedCount = 0;
  const draftBatchItems: Array<{
    targetType: "payment_instance" | "invoice";
    targetId: string;
    partyId: string | null;
    ibanId: string | null;
    beneficiaryName: string;
    beneficiaryIban: string;
    ibanVerified: boolean;
    amount: number;
    currency: string;
    dueDate: string | null;
    description: string;
  }> = [];

  for (const rec of recsRes.rows) {
    if (
      (rec.action_kind === "defer_payment" || rec.action_kind === "advance_payment") &&
      rec.proposed_date &&
      rec.subject_id
    ) {
      if (rec.subject_table === "payment_instances") {
        const upd = await client.query(
          `update public.payment_instances
              set due_date = $2::date,
                  due_day = extract(day from $2::date)::int
            where id = $1::uuid
              and status in ('planned', 'unpaid', 'partial', 'late')`,
          [rec.subject_id, rec.proposed_date],
        );
        if (upd.rowCount === 1) {
          if (rec.action_kind === "defer_payment") deferredCount += 1;
          else advancedCount += 1;
          await audit(client, {
            actor: actorId,
            action:
              rec.action_kind === "defer_payment"
                ? "optimization_defer_payment_instance"
                : "optimization_advance_payment_instance",
            entityTable: "payment_instances",
            entityId: rec.subject_id,
            before: { dueDate: rec.current_date_value },
            after: { dueDate: rec.proposed_date, optimizationRunId: runId },
          });
        }

        // Taslak ödeme paketi adayı (`payment_run_items`)
        const piMeta = await client.query<{
          party_id: string | null;
          party_name: string | null;
          iban_id: string | null;
          iban_norm: string | null;
          iban_approved: boolean;
          rem_amount: string | null;
          already_in_run: boolean;
        }>(
          `select
             coalesce(p.provider_party_id, p.counterparty_id)::text as party_id,
             coalesce(pa.name, p.name, $2) as party_name,
             ib.id::text as iban_id,
             ib.iban_normalized as iban_norm,
             (ib.id is not null and ib.is_active = true and ib.approval_status = 'approved' and ib.verified_at is not null) as iban_approved,
             greatest(0, case when pi.status = 'partial' then pi.amount - coalesce(pi.paid_amount, 0) else pi.amount end)::numeric(14,2)::text as rem_amount,
             exists (
               select 1 from public.payment_run_items pri
                where pri.target_type = 'payment_instance'
                  and pri.target_id = pi.id
                  and pri.status = 'included'
             ) as already_in_run
           from public.payment_instances pi
           left join public.payments p on p.id = pi.payment_id
           left join public.parties pa on pa.id = coalesce(p.provider_party_id, p.counterparty_id)
           left join lateral (
             select i.id, i.iban_normalized, i.is_active, i.approval_status, i.verified_at
               from public.ibans i
              where i.party_id = coalesce(p.provider_party_id, p.counterparty_id)
                and i.is_active = true
              order by (i.approval_status = 'approved' and i.verified_at is not null) desc, i.is_primary desc, i.created_at desc
              limit 1
           ) ib on true
           where pi.id = $1::uuid`,
          [rec.subject_id, rec.subject_label ?? "Planlı Ödeme"],
        );
        const m = piMeta.rows[0];
        const amt = moneyOrNull(rec.amount) ?? moneyOrNull(m?.rem_amount) ?? 0;
        if (m && !m.already_in_run && amt > 0 && rec.currency === optRun.currency) {
          const rawIban = (m.iban_norm ?? "").trim();
          const verified =
            Boolean(m.iban_approved) && isTurkishIban(rawIban) && isValidIbanChecksum(rawIban);
          if (rawIban && verified) {
            draftBatchItems.push({
              targetType: "payment_instance",
              targetId: rec.subject_id,
              partyId: m.party_id,
              ibanId: m.iban_id,
              beneficiaryName: (m.party_name ?? "Planlı Ödeme").trim() || "Planlı Ödeme",
              beneficiaryIban: rawIban,
              ibanVerified: true,
              amount: amt,
              currency: rec.currency,
              dueDate: rec.proposed_date,
              description: `Optimizasyon (${optRun.name}): ${rec.subject_label ?? "Planlı Ödeme"}`,
            });
          }
        }
      } else if (rec.subject_table === "invoices") {
        const upd = await client.query(
          `update public.invoices
              set due_date = $2::date
            where id = $1::uuid
              and direction = 'purchase'
              and status in ('open', 'partial')`,
          [rec.subject_id, rec.proposed_date],
        );
        if (upd.rowCount === 1) {
          if (rec.action_kind === "defer_payment") deferredCount += 1;
          else advancedCount += 1;
          await audit(client, {
            actor: actorId,
            action:
              rec.action_kind === "defer_payment"
                ? "optimization_defer_invoice"
                : "optimization_advance_invoice",
            entityTable: "invoices",
            entityId: rec.subject_id,
            before: { dueDate: rec.current_date_value },
            after: { dueDate: rec.proposed_date, optimizationRunId: runId },
          });
        }

        const invMeta = await client.query<{
          party_id: string | null;
          party_name: string | null;
          iban_id: string | null;
          iban_norm: string | null;
          iban_approved: boolean;
          open_amount: string | null;
          already_in_run: boolean;
        }>(
          `select
             inv.party_id::text,
             coalesce(pa.name, $2) as party_name,
             ib.id::text as iban_id,
             ib.iban_normalized as iban_norm,
             (ib.id is not null and ib.is_active = true and ib.approval_status = 'approved' and ib.verified_at is not null) as iban_approved,
             greatest(0, inv.gross_amount - coalesce(inv.allocated_amount, 0))::numeric(14,2)::text as open_amount,
             exists (
               select 1 from public.payment_run_items pri
                where pri.target_type = 'invoice'
                  and pri.target_id = inv.id
                  and pri.status = 'included'
             ) as already_in_run
           from public.invoices inv
           left join public.parties pa on pa.id = inv.party_id
           left join lateral (
             select i.id, i.iban_normalized, i.is_active, i.approval_status, i.verified_at
               from public.ibans i
              where i.party_id = inv.party_id
                and i.is_active = true
              order by (i.approval_status = 'approved' and i.verified_at is not null) desc, i.is_primary desc, i.created_at desc
              limit 1
           ) ib on true
           where inv.id = $1::uuid`,
          [rec.subject_id, rec.subject_label ?? "Alım Faturası"],
        );
        const m = invMeta.rows[0];
        const amt = moneyOrNull(rec.amount) ?? moneyOrNull(m?.open_amount) ?? 0;
        if (m && !m.already_in_run && amt > 0 && rec.currency === optRun.currency) {
          const rawIban = (m.iban_norm ?? "").trim();
          const verified =
            Boolean(m.iban_approved) && isTurkishIban(rawIban) && isValidIbanChecksum(rawIban);
          if (rawIban && verified) {
            draftBatchItems.push({
              targetType: "invoice",
              targetId: rec.subject_id,
              partyId: m.party_id,
              ibanId: m.iban_id,
              beneficiaryName: (m.party_name ?? "Tedarikçi").trim() || "Tedarikçi",
              beneficiaryIban: rawIban,
              ibanVerified: true,
              amount: amt,
              currency: rec.currency,
              dueDate: rec.proposed_date,
              description: `Optimizasyon (${optRun.name}): ${rec.subject_label ?? "Alım Faturası"}`,
            });
          }
        }
      }
    }
  }

  let paymentRunId: string | null = null;
  let paymentRunCode: string | null = null;

  if (draftBatchItems.length > 0) {
    const bankRes = await client.query<{ cash_account_id: string }>(
      `select ba.cash_account_id::text
         from public.bank_accounts ba
         join public.cash_accounts ca on ca.id = ba.cash_account_id
        where ca.is_active = true
          and ca.archived_at is null
          and ca.currency = $1
        order by ca.created_at asc
        limit 1`,
      [optRun.currency],
    );
    const userExists = await client.query<{ ok: number }>(
      `select 1 as ok from public.users where id = $1::uuid`,
      [actorId],
    );

    if (bankRes.rowCount === 1 && userExists.rowCount === 1) {
      const totalAmount = money(
        draftBatchItems.reduce((acc, it) => acc.plus(decimal(it.amount)), decimal(0)),
      );
      const earliestExecDate = draftBatchItems.reduce(
        (minD, it) => (it.dueDate && it.dueDate < minD ? it.dueDate : minD),
        draftBatchItems[0].dueDate ?? optRun.anchor_date,
      );
      const shortId = runId.replace(/-/g, "").slice(0, 8).toUpperCase();
      const stamp = Date.now().toString().slice(-5);
      const codeCandidate = `OPT-${shortId}-${stamp}`;

      const prIns = await client.query<{ id: string }>(
        `insert into public.payment_runs (
           run_code, planned_execution_date, source_bank_account_id,
           currency, total_amount, item_count, status, created_by, notes
         ) values ($1, $2::date, $3::uuid, $4, $5, $6, 'draft', $7::uuid, $8)
         returning id::text`,
        [
          codeCandidate,
          earliestExecDate,
          bankRes.rows[0].cash_account_id,
          optRun.currency,
          totalAmount,
          draftBatchItems.length,
          actorId,
          `Onaylı likidite optimizasyon planından oluşturuldu (${optRun.name})`,
        ],
      );
      if (prIns.rowCount === 1) {
        paymentRunId = prIns.rows[0].id;
        paymentRunCode = codeCandidate;
        for (const item of draftBatchItems) {
          const itemIns = await client.query(
            `insert into public.payment_run_items (
               run_id, target_type, target_id, party_id, iban_id,
               beneficiary_name, beneficiary_iban, amount, currency,
               due_date, description, iban_verified, status
             ) values ($1::uuid,$2,$3::uuid,$4::uuid,$5::uuid,$6,$7,$8,$9,$10::date,$11,$12,'included')`,
            [
              paymentRunId,
              item.targetType,
              item.targetId,
              item.partyId,
              item.ibanId,
              item.beneficiaryName,
              item.beneficiaryIban,
              item.amount,
              item.currency,
              item.dueDate,
              item.description,
              item.ibanVerified,
            ],
          );
          if (itemIns.rowCount !== 1) {
            throw new DomainError("CONFLICT", "Taslak ödeme paketi kalemi oluşturulamadı.");
          }
        }
        await audit(client, {
          actor: actorId,
          action: "create_draft_payment_run_from_optimization",
          entityTable: "payment_runs",
          entityId: paymentRunId,
          after: {
            runCode: paymentRunCode,
            optimizationRunId: runId,
            itemCount: draftBatchItems.length,
            totalAmount,
          },
        });
      }
    }
  }

  const execTag = `[EXECUTED:${paymentRunCode ?? "NO_BATCH"}:defer=${deferredCount}:adv=${advancedCount}]`;
  const noteUpd = await client.query(
    `update public.optimization_runs
        set notes = case
          when notes is null or btrim(notes) = '' then $2
          else notes || ' | ' || $2
        end
      where id = $1::uuid`,
    [runId, execTag],
  );
  if (noteUpd.rowCount !== 1) {
    throw new DomainError("CONFLICT", "Optimizasyon icra durumu güncellenemedi.");
  }

  await audit(client, {
    actor: actorId,
    action: "execute_optimization_run",
    entityTable: "optimization_runs",
    entityId: runId,
    after: {
      approvalId,
      deferredCount,
      advancedCount,
      paymentRunId,
      paymentRunCode,
      paymentRunItemCount: paymentRunId ? draftBatchItems.length : 0,
    },
  });

  return {
    runId,
    alreadyExecuted: false,
    deferredCount,
    advancedCount,
    paymentRunId,
    paymentRunCode,
    paymentRunItemCount: paymentRunId ? draftBatchItems.length : 0,
  };
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
    if (before.rowCount === 0) {
      const visible = await client.query<{ requested_by: string | null }>(
        `select requested_by::text as requested_by from public.approvals where id=$1`,
        [input.approvalId],
      );
      if ((visible.rowCount ?? 0) > 0) {
        if (visible.rows[0]?.requested_by === actorId) {
          throw new DomainError(
            "FORBIDDEN",
            "4-göz (maker-checker) kuralı gereği kendi oluşturduğunuz onay talebini kendiniz karara bağlayamazsınız.",
          );
        }
        throw new DomainError("FORBIDDEN", "Bu onay kaydını karara bağlama yetkiniz yok.");
      }
      throw new DomainError("NOT_FOUND", "Onay kaydı bulunamadı.");
    }
    const a = before.rows[0];

    if (!["pending", "reworked"].includes(a.status)) {
      throw new DomainError("CONFLICT", `'${a.status}' durumundaki bir onay yeniden karara bağlanamaz.`);
    }
    if (input.decision === "reworked" && a.status !== "pending") {
      throw new DomainError("CONFLICT", "Yalnız bekleyen bir onay revizyona gönderilebilir.");
    }

    let selfApprovedOverride = false;
    let selfApprovalJustification: string | null = null;
    let isSelfMaker = Boolean(a.requested_by && a.requested_by === actorId);
    if (!isSelfMaker && String(a.subject_table) === "payment_runs" && input.decision === "approved") {
      const prMakerRes = await client.query<{ created_by: string | null }>(
        `select created_by::text as created_by from public.payment_runs where id = $1`,
        [a.subject_id],
      );
      if (prMakerRes.rows[0]?.created_by === actorId) {
        isSelfMaker = true;
      }
    }
    if (isSelfMaker) {
      if (String(a.subject_table) === "ibans") {
        const becCountRes = await client.query<{ cnt: number | string }>(
          `select count(*)::int as cnt
             from public.users
            where is_active = true
              and role in ('finance_approver', 'finance_manager', 'admin')`,
        );
        const becApproverCount = Number(becCountRes.rows[0]?.cnt ?? 0);
        if (becApproverCount >= 2) {
          throw new DomainError(
            "FORBIDDEN",
            "BEC Kalkanı: Sistemde en az 2 aktif onaycı bulunduğu için IBAN kaydı onu ekleyen kişi tarafından karara bağlanamaz (zorunlu 4-göz maker-checker).",
          );
        }
      }
      const elig = await evaluateSelfApprovalEligibility(
        client,
        actorId,
        input.justification ?? input.note,
      );
      selfApprovedOverride = true;
      selfApprovalJustification = elig.justification;
    }

    const effectiveNote =
      input.note ?? (input.justification && input.justification.trim().length >= 3 ? input.justification.trim() : undefined) ?? selfApprovalJustification ?? null;

    // Legacy tables (`mapping_reviews`, `external_assumptions`) carry an AFTER UPDATE trigger
    // (`approval_sync_from_legacy`) that maps `'open'` / `'pending_review'` back to `'pending'`.
    // When `decision === 'reworked'`, running the legacy writeback while `approvals.status` is still
    // `'pending'` prevents the trigger from overwriting `'reworked'` back to `'pending'`.
    const runLegacyReworkFirst =
      input.decision === "reworked" &&
      Object.prototype.hasOwnProperty.call(LEGACY_WRITEBACK, String(a.subject_table));

    let writeback: string | null = null;
    if (runLegacyReworkFirst) {
      writeback = await applySubjectWriteback(
        client,
        { id: a.id, subject_table: a.subject_table, subject_id: a.subject_id },
        input.decision,
        actorId,
        effectiveNote,
        { selfApprovedOverride, selfApprovalJustification },
      );
    }

    const approvalUpdate = await client.query(
      `update public.approvals
         set status=$2,
             decided_by = case when $2 in ('approved','rejected') then $3::uuid else null end,
             decided_at = case when $2 in ('approved','rejected') then now() else null end,
             decision_note = $4,
             self_approved_override = $5,
             self_approval_justification = $6
       where id=$1`,
      [
        input.approvalId,
        input.decision,
        actorId,
        effectiveNote,
        selfApprovedOverride,
        selfApprovalJustification,
      ],
    );
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
       effectiveNote, a.status, input.decision]);

    if (!runLegacyReworkFirst) {
      writeback = await applySubjectWriteback(
        client,
        { id: a.id, subject_table: a.subject_table, subject_id: a.subject_id },
        input.decision,
        actorId,
        effectiveNote,
        { selfApprovedOverride, selfApprovalJustification },
      );
    }

    await audit(client, {
      actor: actorId, action: "decide_approval", entityTable: "approvals", entityId: input.approvalId,
      before: { status: a.status, round_no: a.round_no },
      after: {
        status: input.decision,
        note: effectiveNote,
        subjectTable: a.subject_table,
        legacyWriteback: writeback ?? null,
        selfApprovedOverride,
        justification: selfApprovalJustification,
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
  requestedBy: string | null;
  requestedByName: string | null;
  requestedAt: string;
  decidedByName: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  selfApprovedOverride: boolean;
  selfApprovalJustification: string | null;
  stepCount: number;
}

export async function loadApprovalQueue(
  pool: Pool, opts: { status?: string; limit?: number } = {},
): Promise<ApprovalRow[]> {
  const r = await pool
    .query(
      `select q.id::text, q.subject_table, q.subject_id::text, q.subject_label, q.request_kind, q.rule_code,
              q.round_no, q.status, q.subject_status, q.amount, q.currency,
              q.requested_by::text as requested_by,
              q.requested_by_name, to_char(q.requested_at at time zone 'Europe/Istanbul','YYYY-MM-DD HH24:MI') as requested_at,
              q.decided_by_name, to_char(q.decided_at at time zone 'Europe/Istanbul','YYYY-MM-DD HH24:MI') as decided_at,
              q.decision_note, q.step_count,
              coalesce(ap.self_approved_override, false) as self_approved_override,
              ap.self_approval_justification
         from public.approval_queue q
         left join public.approvals ap on ap.id = q.id
        where ($1='' or q.status=$1)
        order by case q.status when 'pending' then 0 when 'reworked' then 1 else 2 end,
                 q.requested_at desc
        limit $2`,
      [opts.status ?? "", opts.limit ?? 200],
    )
    .catch((err: unknown) => {
      if ((err as { code?: string } | null)?.code === "42703") {
        return pool.query(
          `select id::text, subject_table, subject_id::text, subject_label, request_kind, rule_code,
                  round_no, status, subject_status, amount, currency,
                  requested_by::text as requested_by,
                  requested_by_name, to_char(requested_at at time zone 'Europe/Istanbul','YYYY-MM-DD HH24:MI') as requested_at,
                  decided_by_name, to_char(decided_at at time zone 'Europe/Istanbul','YYYY-MM-DD HH24:MI') as decided_at,
                  decision_note, step_count,
                  false as self_approved_override,
                  null::text as self_approval_justification
             from public.approval_queue
            where ($1='' or status=$1)
            order by case status when 'pending' then 0 when 'reworked' then 1 else 2 end,
                     requested_at desc
            limit $2`,
          [opts.status ?? "", opts.limit ?? 200],
        );
      }
      throw err;
    });
  return r.rows.map((x) => ({
    id: x.id, subjectTable: x.subject_table, subjectId: x.subject_id,
    subjectLabel: x.subject_label, requestKind: x.request_kind, ruleCode: x.rule_code,
    roundNo: intOrNull(x.round_no) ?? 1, status: x.status, subjectStatus: x.subject_status,
    amount: moneyOrNull(x.amount), currency: x.currency,
    requestedBy: x.requested_by ?? null,
    requestedByName: x.requested_by_name, requestedAt: x.requested_at,
    decidedByName: x.decided_by_name, decidedAt: x.decided_at,
    decisionNote: x.decision_note,
    selfApprovedOverride: Boolean(x.self_approved_override),
    selfApprovalJustification: x.self_approval_justification ?? null,
    stepCount: intOrNull(x.step_count) ?? 0,
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

const executeOptimizationSchema = z.object({
  runId: z.uuid(),
});

/**
 * Dalga 2B (`M-54`): Onaylanmış bir `optimization_runs` çalışmasının önerilerini
 * atomik olarak icra eder (`payment_instances` / `invoices` vade güncellemesi + taslak `payment_runs`).
 */
export async function executeApprovedOptimizationRun(
  pool: Pool,
  raw: unknown,
  actorId: string,
): Promise<OptimizationExecutionSummary> {
  const { runId } = parseOrThrow(
    executeOptimizationSchema,
    typeof raw === "string" ? { runId: raw } : raw,
    "Optimizasyon icrası",
  );
  const client = await pool.connect();
  try {
    await client.query("begin");
    const appRes = await client.query<{ id: string; status: string }>(
      `select id::text, status
         from public.approvals
        where subject_table = 'optimization_runs'
          and subject_id = $1::uuid
        order by round_no desc
        limit 1`,
      [runId],
    );
    if (appRes.rowCount === 0 || appRes.rows[0].status !== "approved") {
      throw new DomainError(
        "CONFLICT",
        "Optimizasyon planı henüz onaylanmamış; icra öncesi /data/approvals üzerinden onaylanmalıdır.",
      );
    }
    const summary = await applyApprovedOptimizationRecommendationsInTx(
      client,
      runId,
      actorId,
      appRes.rows[0].id,
    );
    await client.query("commit");
    return summary;
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

export type { PoolClient };
