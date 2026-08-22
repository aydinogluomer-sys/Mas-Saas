import type { Pool } from "pg";
import { DomainError } from "@/lib/domain-error";
import { assertISODateString } from "@/lib/time/istanbul";
import { addMonths } from "@/lib/radar/rules";
import { audit } from "@/lib/audit";
import {
  cancelInstanceWithClient,
  generateInstancesForMonthWithClient,
  reconcileInstancesWithClient,
  refreshRiskFlagsWithClient,
  type ReconcileFields,
} from "@/lib/radar/engine";

export interface ArchivePaymentInput {
  reason: string;
  archivedByLabel: string;
}

// Archive cascade only ever selects unpaid/planned rows — 'late' is deliberately
// excluded from this bulk/automatic mutation (see reconcileInstancesWithClient),
// and this WHERE clause never selects partial/paid/already-cancelled rows at all.
const ARCHIVE_CASCADE_FROM = ["unpaid", "planned"];

export async function archivePayment(
  pool: Pool,
  id: string,
  input: ArchivePaymentInput,
  todayISO: string,
  actorId: string,
): Promise<void> {
  assertISODateString(todayISO);
  const client = await pool.connect();
  try {
    await client.query("begin");
    const before = await client.query(
      `select id, status, archived_at, archive_reason, archived_by_label
       from public.payments where id=$1 for update`,
      [id],
    );
    if (before.rowCount !== 1) throw new Error("payment not found");
    await client.query(
      `update public.payments
         set status='archived', archived_at=now(), archive_reason=$2, archived_by_label=$3
       where id=$1`,
      [id, input.reason, input.archivedByLabel],
    );
    await audit(client, {
      actor: actorId, action: "archive_payment", entityTable: "payments", entityId: id,
      before: before.rows[0],
      after: {
        status: "archived",
        archive_reason: input.reason,
        archived_by_label: input.archivedByLabel,
      },
    });

    // Cascade: only future (due_date >= todayISO) unpaid/planned instances — a
    // past-due-but-open row, or a currently-'late' row, is left alone (a real past
    // obligation should not be silently erased by an administrative archive action).
    // Reuses the same transaction/client as the archive itself — no second transaction.
    const eligible = await client.query<{ id: string }>(
      `select id from public.payment_instances
       where payment_id=$1 and status = any($2) and due_date >= $3
       order by due_date, id
       for update`,
      [id, ARCHIVE_CASCADE_FROM, todayISO],
    );
    for (const row of eligible.rows) {
      await cancelInstanceWithClient(client, row.id, `Ödeme arşivlendi: ${input.reason}`, actorId);
    }

    await client.query("commit");
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}

export interface UpdatePaymentFields {
  name: string;
  recurrence_type: string;
  due_day: number | null;
  due_date: string | null;
  default_amount: number | null;
  amount_confidence: string;
  direction: string;
  priority: string;
  flexibility_class: string | null;
  status: string;
  category_id: string | null;
  provider_party_id: string | null;
  owner_party_id: string | null;
  cash_account_id: string | null;
  description: string | null;
}

/** Single-transaction payment-template update: template UPDATE + audit + instance
 * reconciliation (due_date/amount) + missing-instance generation (prev/current/next
 * month, across all active payments — matches ensureWindow's existing scope, not
 * narrowed to this payment) + risk refresh. Replaces the previous two-transaction
 * flow (payments UPDATE, then a separate ensureWindow call). */
export async function updatePaymentAndReconcile(
  pool: Pool,
  id: string,
  f: UpdatePaymentFields,
  todayISO: string,
  actorId: string,
): Promise<void> {
  assertISODateString(todayISO);
  const client = await pool.connect();
  try {
    await client.query("begin");
    const before = await client.query(`select * from public.payments where id=$1 for update`, [id]);
    if (before.rowCount !== 1) throw new DomainError("payment not found");
    await client.query(
      `update public.payments set
         name=$2, recurrence_type=$3, due_day=$4, due_date=$5, default_amount=$6,
         amount_confidence=$7, direction=$8, priority=$9, flexibility_class=$10, status=$11,
         category_id=$12, provider_party_id=$13, owner_party_id=$14, cash_account_id=$15,
         description=$16
       where id=$1`,
      [id, f.name, f.recurrence_type, f.due_day, f.due_date, f.default_amount,
       f.amount_confidence, f.direction, f.priority, f.flexibility_class, f.status,
       f.category_id, f.provider_party_id, f.owner_party_id, f.cash_account_id, f.description],
    );
    await audit(client, {
      actor: actorId, action: "update_payment", entityTable: "payments", entityId: id,
      before: before.rows[0], after: f,
    });

    const reconcileFields: ReconcileFields = {
      dueDay: f.due_day,
      defaultAmount: f.default_amount,
      amountConfidence: f.amount_confidence,
    };
    await reconcileInstancesWithClient(client, id, reconcileFields, todayISO, actorId);

    const m0 = todayISO.slice(0, 7) + "-01";
    for (const m of [addMonths(m0, -1), m0, addMonths(m0, 1)]) {
      await generateInstancesForMonthWithClient(client, m, actorId);
    }
    await refreshRiskFlagsWithClient(client, todayISO);

    await client.query("commit");
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}
