"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getPool } from "@/lib/db";
import { importWorkbook } from "@/lib/importers/workbook-importer";
import { refreshMetricSnapshots } from "@/lib/analytics/snapshots";
import { requireActionPermission, safeRedirectPath } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { DomainError } from "@/lib/domain-error";

export async function uploadWorkbookAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("source_workbooks", "insert", "/data/imports");
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) {
    redirect("/data/imports?error=" + encodeURIComponent("Dosya seçilmedi."));
  }
  const buf = Buffer.from(await file.arrayBuffer());
  const result = await importWorkbook(getPool(), buf, file.name, session.id);
  if (result.ok) await refreshMetricSnapshots(getPool(), session.id).catch(() => undefined);
  revalidatePath("/data/imports");
  redirect(`/data/imports/${result.workbookId}`);
}

const REVIEW_STATUSES = ["open", "accepted", "rejected", "resolved"] as const;
type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export async function setReviewStatusAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("mapping_reviews", "update", "/data/imports");
  const id = String(formData.get("id") ?? "");
  const status = String(formData.get("status") ?? "") as ReviewStatus;
  const backTo = safeRedirectPath(formData.get("backTo"), "/data/reviews");
  if (!id || !REVIEW_STATUSES.includes(status)) return;

  const pool = getPool();
  const client = await pool.connect();
  try {
    await client.query("begin");
    const before = await client.query(
      `select id, status from public.mapping_reviews where id=$1 for update`,
      [id],
    );
    if (before.rowCount !== 1) {
      throw new DomainError("NOT_FOUND", "İnceleme kaydı bulunamadı veya yetkiniz yok.");
    }
    const upd = await client.query(
      `update public.mapping_reviews
         set status=$2, reviewed_at=now(), reviewed_by=$3
       where id=$1`,
      [id, status, session.id],
    );
    if (upd.rowCount !== 1) {
      throw new DomainError("FORBIDDEN", "İnceleme kaydı güncellenemedi veya yetkiniz yok.");
    }
    await audit(client, {
      actor: session.id, action: "review_status_change", entityTable: "mapping_reviews", entityId: id,
      before: before.rows[0], after: { id, status },
    });
    await client.query("commit");
  } catch (e) {
    await client.query("rollback");
    throw e;
  } finally {
    client.release();
  }
  revalidatePath(backTo);
  revalidatePath("/data/reviews");
  revalidatePath("/data/quality");
}

