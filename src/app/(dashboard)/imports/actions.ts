"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getPool } from "@/lib/db";
import { importWorkbook } from "@/lib/importers/workbook-importer";

export async function uploadWorkbookAction(formData: FormData): Promise<void> {
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    redirect("/imports?error=" + encodeURIComponent("Dosya seçilmedi."));
  }
  const buf = Buffer.from(await file.arrayBuffer());
  const result = await importWorkbook(getPool(), buf, file.name);
  revalidatePath("/imports");
  // Failed imports are a recorded outcome, not an exception: user lands on the
  // detail page where parse_error is shown (risk-register: show technical failure).
  redirect(`/imports/${result.workbookId}`);
}

const REVIEW_STATUSES = ["open", "accepted", "rejected", "resolved"] as const;
type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export async function setReviewStatusAction(formData: FormData): Promise<void> {
  const id = String(formData.get("id") ?? "");
  const status = String(formData.get("status") ?? "") as ReviewStatus;
  const backTo = String(formData.get("backTo") ?? "/imports");
  if (!id || !REVIEW_STATUSES.includes(status)) return;

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("begin");
    const before = await client.query(
      `select id, status from public.mapping_reviews where id=$1 for update`,
      [id],
    );
    if (before.rowCount === 1) {
      await client.query(
        `update public.mapping_reviews
           set status=$2, reviewed_at=now()
         where id=$1`,
        [id, status],
      );
      // CLAUDE.md: audit trail on mutations. Phase 2 has no auth session yet
      // (remote Supabase deferred) → actor null, action carries context.
      await client.query(
        `insert into public.audit_logs (actor, action, entity_table, entity_id, before_data, after_data)
         values (null, 'review_status_change', 'mapping_reviews', $1, $2, $3)`,
        [id, JSON.stringify(before.rows[0]), JSON.stringify({ id, status })],
      );
    }
    await client.query("commit");
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
  revalidatePath(backTo);
}
