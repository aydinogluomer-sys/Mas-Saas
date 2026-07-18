import type { Pool, PoolClient } from "pg";

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

export interface ArchivePaymentInput {
  reason: string;
  archivedByLabel: string;
}

export async function archivePayment(pool: Pool, id: string, input: ArchivePaymentInput): Promise<void> {
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
    await audit(client, "archive_payment", "payments", id, before.rows[0], {
      status: "archived",
      archive_reason: input.reason,
      archived_by_label: input.archivedByLabel,
    });
    await client.query("commit");
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
}
