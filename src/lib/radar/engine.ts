// Phase 3 server modules: candidate mapping, instance generation, mutations.
// Eligibility semantics (documented in docs/import-mapping.md §review-status):
//   clean row (no reviews) → eligible
//   all linked reviews ∈ {accepted, resolved} → eligible
//   any review ∈ {open, rejected} → EXCLUDED (rule: no rejected/unresolved rows)
//   name missing → never importable (even if its review was accepted)

import type { Pool, PoolClient } from "pg";
import { extractPaymentMatrix } from "@/lib/importers/extractors";
import type { RowJson, SheetRow } from "@/lib/importers/row-utils";
import { DomainError } from "@/lib/domain-error";
import { assertISODateString } from "@/lib/time/istanbul";
import {
  addMonths,
  computeRisk,
  dueDateFor,
  type RiskThresholds,
} from "./rules";

async function audit(
  client: PoolClient,
  action: string,
  entityTable: string,
  entityId: string | null,
  before: unknown,
  after: unknown,
): Promise<void> {
  await client.query(
    `insert into public.audit_logs (actor, action, entity_table, entity_id, before_data, after_data)
     values (null, $1, $2, $3, $4, $5)`,
    [action, entityTable, entityId, JSON.stringify(before ?? null), JSON.stringify(after ?? null)],
  );
}

export async function loadThresholds(client: PoolClient | Pool): Promise<RiskThresholds> {
  const r = await client.query(`select key, value from public.settings where key in
    ('large_payment_threshold_try','critical_payment_threshold_try','same_day_cluster_count')`);
  const v = (k: string, d: number) => {
    const row = r.rows.find((x) => x.key === k);
    return row ? Number(row.value) : d;
  };
  return {
    large: v("large_payment_threshold_try", 50_000),
    critical: v("critical_payment_threshold_try", 100_000),
    clusterCount: v("same_day_cluster_count", 3),
  };
}

/* ── 1) accepted candidates → payments ── */

export interface MapResult {
  eligible: number;
  created: number;
  skippedAlreadyMapped: number;
  excluded: Array<{ rowIndex: number; reason: string }>;
}

export async function mapAcceptedCandidates(pool: Pool, workbookId: string): Promise<MapResult> {
  const client = await pool.connect();
  try {
    await client.query("begin");

    const sheets = await client.query(
      `select id, sheet_name from public.source_sheets
       where workbook_id=$1 and detected_type='payment_day_matrix'`,
      [workbookId],
    );
    const result: MapResult = { eligible: 0, created: 0, skippedAlreadyMapped: 0, excluded: [] };

    for (const sheet of sheets.rows) {
      const rowsRes = await client.query<{
        id: string;
        row_index: number;
        row_json: RowJson;
        mapping_status: string;
        blocked: boolean;
      }>(
        `select ir.id, ir.row_index, ir.row_json, ir.mapping_status,
                exists (select 1 from public.mapping_reviews mr
                        where mr.import_row_id = ir.id and mr.status in ('open','rejected')) as blocked
         from public.import_rows ir
         where ir.sheet_id = $1
         order by ir.row_index`,
        [sheet.id],
      );
      const sheetRows: SheetRow[] = rowsRes.rows.map((r) => ({
        rowIndex: r.row_index,
        cells: r.row_json,
      }));
      const { candidates } = extractPaymentMatrix(sheetRows);
      const byIndex = new Map(rowsRes.rows.map((r) => [r.row_index, r]));

      for (const c of candidates) {
        const row = byIndex.get(c.rowIndex);
        if (!row) continue;
        if (!c.name) {
          result.excluded.push({ rowIndex: c.rowIndex, reason: "isimsiz (etiketsiz tutar)" });
          continue;
        }
        if (row.blocked) {
          result.excluded.push({ rowIndex: c.rowIndex, reason: "açık/ret inceleme" });
          continue;
        }
        result.eligible++;
        if (row.mapping_status === "mapped") {
          result.skippedAlreadyMapped++;
          continue;
        }
        const recurrence = c.dueDay != null ? "monthly" : "irregular";
        const amountConfidence =
          c.amountCandidate == null
            ? "unknown"
            : c.amountSource === "ag" || c.flags.includes("negative_amount")
              ? "variable"
              : "known";
        const ins = await client.query(
          `insert into public.payments
             (name, recurrence_type, due_day, default_amount, amount_confidence,
              direction, priority, status, source_workbook_id, source_sheet_id, source_row_id,
              source_notes)
           values ($1,$2,$3,$4,$5,'outflow','normal','active',$6,$7,$8,$9)
           returning id`,
          [
            c.name,
            recurrence,
            c.dueDay,
            c.amountCandidate, // null stays null — never zero
            amountConfidence,
            workbookId,
            sheet.id,
            row.id,
            c.flags.length ? `flags: ${c.flags.join(",")}` : null,
          ],
        );
        const paymentId: string = ins.rows[0].id;
        await client.query(
          `update public.import_rows
             set mapping_status='mapped', mapped_entity_table='payments', mapped_entity_id=$2
           where id=$1`,
          [row.id, paymentId],
        );
        await audit(client, "map_payment_candidate", "payments", paymentId, null, {
          name: c.name,
          due_day: c.dueDay,
          default_amount: c.amountCandidate,
          source_row_id: row.id,
        });
        result.created++;
      }
    }
    await client.query("commit");
    return result;
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

/* ── 2) idempotent instance generation ── */

export interface GenerateResult {
  monthStart: string;
  created: number;
  skippedExisting: number;
  shortMonthAdjusted: number;
}

export async function generateInstancesForMonthWithClient(
  client: PoolClient,
  monthStartISO: string,
): Promise<GenerateResult> {
  assertISODateString(monthStartISO);
  const payments = await client.query<{
    id: string;
    due_day: number;
    default_amount: string | null;
    amount_confidence: string;
    direction: string;
  }>(
    `select id, due_day, default_amount, amount_confidence, direction
     from public.payments
     where status='active' and recurrence_type='monthly' and due_day is not null
     order by id`,
  );
  let created = 0;
  let shortMonthAdjusted = 0;
  for (const p of payments.rows) {
    const d = dueDateFor(monthStartISO, p.due_day);
    if (d.shortMonthAdjusted) shortMonthAdjusted++;
    const amount = p.default_amount == null ? null : Number(p.default_amount);
    const amountStatus =
      amount == null ? "missing" : p.amount_confidence === "variable" ? "variable" : "known";
    const res = await client.query(
      `insert into public.payment_instances
         (payment_id, instance_month, due_date, amount, amount_status, direction, status, note, amount_source)
       values ($1,$2,$3,$4,$5,$6,'unpaid',$7,'generated')
       on conflict (payment_id, instance_month) where payment_id is not null do nothing`,
      [
        p.id,
        monthStartISO,
        d.dueDate,
        amount,
        amountStatus,
        p.direction,
        d.shortMonthAdjusted ? "short_month_adjustment" : null,
      ],
    );
    created += res.rowCount ?? 0;
  }
  await audit(client, "generate_instances", "payment_instances", null, null, {
    monthStart: monthStartISO,
    created,
    total: payments.rowCount,
  });
  return {
    monthStart: monthStartISO,
    created,
    skippedExisting: (payments.rowCount ?? 0) - created,
    shortMonthAdjusted,
  };
}

export async function generateInstancesForMonth(
  pool: Pool,
  monthStartISO: string,
): Promise<GenerateResult> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await generateInstancesForMonthWithClient(client, monthStartISO);
    await client.query("commit");
    return result;
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

export async function ensureWindow(pool: Pool, todayISO: string): Promise<GenerateResult[]> {
  const m0 = todayISO.slice(0, 7) + "-01";
  const out: GenerateResult[] = [];
  for (const m of [addMonths(m0, -1), m0, addMonths(m0, 1)]) {
    out.push(await generateInstancesForMonth(pool, m));
  }
  await refreshRiskFlags(pool, todayISO);
  return out;
}

/* ── 3) risk refresh (window: prev..next month) ── */

export async function refreshRiskFlagsWithClient(client: PoolClient, todayISO: string): Promise<number> {
  assertISODateString(todayISO);
  const m0 = todayISO.slice(0, 7) + "-01";
  const from = addMonths(m0, -1);
  const to = addMonths(m0, 2);
  const t = await loadThresholds(client);
  const rows = await client.query<{
    id: string;
    due_date: string;
    amount: string | null;
    status: string;
    paid_amount: string | null;
  }>(
    `select id, to_char(due_date,'YYYY-MM-DD') as due_date, amount, status, paid_amount
     from public.payment_instances
     where instance_month >= $1 and instance_month < $2
     order by id`,
    [from, to],
  );
  const risks = computeRisk(
    rows.rows.map((r) => ({
      id: r.id,
      dueDate: r.due_date,
      amount: r.amount == null ? null : Number(r.amount),
      status: r.status,
      paidAmount: r.paid_amount == null ? null : Number(r.paid_amount),
    })),
    todayISO,
    t,
  );
  let updated = 0;
  for (const [id, r] of risks) {
    const res = await client.query(
      `update public.payment_instances
         set risk_level=$2, risk_reasons=$3
       where id=$1 and (risk_level is distinct from $2 or risk_reasons is distinct from $3)`,
      [id, r.level, r.reasons],
    );
    updated += res.rowCount ?? 0;
  }
  return updated;
}

export async function refreshRiskFlags(pool: Pool, todayISO: string): Promise<number> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await refreshRiskFlagsWithClient(client, todayISO);
    await client.query("commit");
    return result;
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

/* ── 4) paid/unpaid + amount fill — every mutation audited ── */

const PAYABLE_FROM = new Set(["unpaid", "planned", "late", "partial"]);
const REVERSIBLE_FROM = new Set(["paid"]);

export async function markInstancePaid(
  pool: Pool,
  instanceId: string,
  paidAmount: number | null,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const before = await client.query(
      `select id, status, amount, paid_amount, paid_at from public.payment_instances where id=$1 for update`,
      [instanceId],
    );
    if (before.rowCount !== 1) throw new DomainError("instance not found");
    const currentStatus = before.rows[0].status as string;
    if (!PAYABLE_FROM.has(currentStatus)) {
      throw new DomainError(`payment_instances ${instanceId}: '${currentStatus}' durumundan ödendi işaretlenemez`);
    }
    const amount = before.rows[0].amount == null ? null : Number(before.rows[0].amount);
    const finalPaid = paidAmount ?? amount; // may stay null: unknown paid amount is honest
    await client.query(
      `update public.payment_instances
         set status='paid', paid_at=now(), paid_amount=$2
       where id=$1`,
      [instanceId, finalPaid],
    );
    await audit(client, "mark_paid", "payment_instances", instanceId, before.rows[0], {
      status: "paid",
      paid_amount: finalPaid,
    });
    await client.query("commit");
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

export async function markInstanceUnpaid(pool: Pool, instanceId: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const before = await client.query(
      `select id, status, paid_amount, paid_at from public.payment_instances where id=$1 for update`,
      [instanceId],
    );
    if (before.rowCount !== 1) throw new DomainError("instance not found");
    const currentStatus = before.rows[0].status as string;
    if (!REVERSIBLE_FROM.has(currentStatus)) {
      throw new DomainError(`payment_instances ${instanceId}: '${currentStatus}' durumundan geri alınamaz`);
    }
    await client.query(
      `update public.payment_instances
         set status='unpaid', paid_at=null, paid_amount=null
       where id=$1`,
      [instanceId],
    );
    await audit(client, "mark_unpaid", "payment_instances", instanceId, before.rows[0], {
      status: "unpaid",
    });
    await client.query("commit");
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

export async function setInstanceAmount(
  pool: Pool,
  instanceId: string,
  amount: number,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const before = await client.query<{
      id: string;
      amount: string | null;
      amount_status: string;
      amount_source: string;
    }>(
      `select id, amount, amount_status, amount_source from public.payment_instances where id=$1 for update`,
      [instanceId],
    );
    if (before.rowCount !== 1) throw new DomainError("instance not found");
    const b = before.rows[0];
    const currentAmount = b.amount == null ? null : Number(b.amount);
    // Re-entering the identical (amount, already-manual) state must not produce a
    // spurious UPDATE/audit/updated_at bump — but a source transition (e.g.
    // generated → manual at an unchanged numeric value) is a real, audited change.
    const noop = b.amount_status === "known" && b.amount_source === "manual" && currentAmount === amount;
    if (!noop) {
      await client.query(
        `update public.payment_instances set amount=$2, amount_status='known', amount_source='manual' where id=$1`,
        [instanceId, amount],
      );
      await audit(client, "set_instance_amount", "payment_instances", instanceId, b, {
        amount,
        amount_status: "known",
        amount_source: "manual",
      });
    }
    await client.query("commit");
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

const CANCELLABLE_FROM = new Set(["unpaid", "planned", "late"]);

export async function cancelInstanceWithClient(
  client: PoolClient,
  instanceId: string,
  reason: string,
): Promise<void> {
  const trimmedReason = reason.trim();
  const before = await client.query(
    `select id, status, cancelled_at, cancel_reason from public.payment_instances where id=$1 for update`,
    [instanceId],
  );
  if (before.rowCount !== 1) throw new DomainError("instance not found");
  const currentStatus = before.rows[0].status as string;
  if (!CANCELLABLE_FROM.has(currentStatus)) {
    throw new DomainError(`payment_instances ${instanceId}: '${currentStatus}' durumundan iptal edilemez`);
  }
  await client.query(
    `update public.payment_instances set status='cancelled', cancelled_at=now(), cancel_reason=$2 where id=$1`,
    [instanceId, trimmedReason],
  );
  await audit(client, "cancel_instance", "payment_instances", instanceId, before.rows[0], {
    status: "cancelled",
    cancel_reason: trimmedReason,
  });
}

export async function cancelInstance(pool: Pool, instanceId: string, reason: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await cancelInstanceWithClient(client, instanceId, reason);
    await client.query("commit");
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

/* ── 5) reconciliation — propagates a payment template edit onto its already-generated,
   still-open (unpaid/planned; 'late' is excluded from all bulk/automatic mutation)
   future instances. Two independent per-row decisions:
   - due_date: recomputed from the new due_day, but only written if the recomputed
     date does not itself fall before todayISO — otherwise the row is left alone and
     the new due_day simply takes effect starting the next eligible month.
   - amount/amount_status: only touched when amount_source='generated'; 'manual' and
     'legacy_unknown' rows are never rewritten, regardless of due_date outcome.
   Every field is IS-DISTINCT-FROM-guarded in application code before being included
   in an UPDATE, so a true no-op row is never written (no updated_at bump, not counted). ── */

export interface ReconcileFields {
  dueDay: number | null;
  defaultAmount: number | null;
  amountConfidence: string;
}

export interface ReconcileResult {
  dueDateChanged: number;
  amountChanged: number;
  totalEligible: number;
}

const RECONCILIABLE_FROM = new Set(["unpaid", "planned"]);

export async function reconcileInstancesWithClient(
  client: PoolClient,
  paymentId: string,
  fields: ReconcileFields,
  todayISO: string,
): Promise<ReconcileResult> {
  assertISODateString(todayISO);
  const rows = await client.query<{
    id: string;
    instance_month: string;
    due_date: string;
    amount: string | null;
    amount_status: string;
    amount_source: string;
  }>(
    `select id, to_char(instance_month,'YYYY-MM-DD') as instance_month,
            to_char(due_date,'YYYY-MM-DD') as due_date,
            amount, amount_status, amount_source
     from public.payment_instances
     where payment_id=$1 and status = any($2) and due_date >= $3
     order by due_date, id
     for update`,
    [paymentId, Array.from(RECONCILIABLE_FROM), todayISO],
  );

  let dueDateChanged = 0;
  let amountChanged = 0;

  for (const row of rows.rows) {
    let applyDueDate = false;
    let candidateDueDate = row.due_date;
    if (fields.dueDay != null) {
      candidateDueDate = dueDateFor(row.instance_month, fields.dueDay).dueDate;
      applyDueDate = candidateDueDate >= todayISO && candidateDueDate !== row.due_date;
    }

    const currentAmount = row.amount == null ? null : Number(row.amount);
    let applyAmount = false;
    let candidateAmount: number | null = null;
    let candidateAmountStatus = "";
    if (row.amount_source === "generated") {
      candidateAmount = fields.defaultAmount;
      candidateAmountStatus =
        candidateAmount == null ? "missing" : fields.amountConfidence === "variable" ? "variable" : "known";
      applyAmount = candidateAmount !== currentAmount || candidateAmountStatus !== row.amount_status;
    }

    if (!applyDueDate && !applyAmount) continue;

    const setParts: string[] = [];
    const params: unknown[] = [row.id];
    if (applyDueDate) {
      params.push(candidateDueDate);
      setParts.push(`due_date=$${params.length}`);
    }
    if (applyAmount) {
      params.push(candidateAmount);
      setParts.push(`amount=$${params.length}`);
      params.push(candidateAmountStatus);
      setParts.push(`amount_status=$${params.length}`);
    }
    await client.query(`update public.payment_instances set ${setParts.join(", ")} where id=$1`, params);
    if (applyDueDate) dueDateChanged++;
    if (applyAmount) amountChanged++;
  }

  const totalEligible = rows.rowCount ?? 0;
  if (dueDateChanged > 0 || amountChanged > 0) {
    await audit(client, "reconcile_instances", "payment_instances", null, null, {
      paymentId,
      dueDateChanged,
      amountChanged,
      totalEligible,
    });
  }

  return { dueDateChanged, amountChanged, totalEligible };
}
