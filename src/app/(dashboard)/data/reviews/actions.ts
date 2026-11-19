"use server";

import { revalidatePath } from "next/cache";
import { getPool } from "@/lib/db";
import { requireActionPermission } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { DomainError } from "@/lib/domain-error";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ALLOWED_BULK_STATUSES = ["accepted", "resolved", "rejected"] as const;

export type BulkReviewDecisionStatus = (typeof ALLOWED_BULK_STATUSES)[number];

export type BulkUpdateReviewStatusResult =
  | {
      ok: true;
      updatedCount: number;
      updatedIds: string[];
      status: BulkReviewDecisionStatus;
    }
  | { ok: false; error: string };

function isNextRedirectError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "digest" in err &&
    typeof (err as { digest?: unknown }).digest === "string" &&
    (err as { digest: string }).digest.startsWith("NEXT_REDIRECT")
  );
}

export async function bulkUpdateReviewStatusAction(input: {
  ids: string[];
  status: BulkReviewDecisionStatus;
}): Promise<BulkUpdateReviewStatusResult> {
  try {
    const session = await requireActionPermission(
      "mapping_reviews",
      "update",
      "/data/reviews",
    );

    const status = input?.status;
    if (!ALLOWED_BULK_STATUSES.includes(status)) {
      return { ok: false, error: "Geçersiz inceleme durumu seçildi." };
    }

    const uniqueIds = Array.from(
      new Set((input?.ids ?? []).map((id) => String(id).trim()).filter(Boolean)),
    );
    if (
      uniqueIds.length === 0 ||
      uniqueIds.length > 500 ||
      !uniqueIds.every((id) => UUID_RE.test(id))
    ) {
      return {
        ok: false,
        error: "Geçerli inceleme kayıtları seçilmelidir (1–500 kayıt).",
      };
    }

    const pool = getPool();
    const client = await pool.connect();
    let updatedIds: string[] = [];

    try {
      await client.query("begin");

      const before = await client.query<{ id: string; status: string }>(
        `select id::text as id, status
           from public.mapping_reviews
          where id = any($1::uuid[])
          for update`,
        [uniqueIds],
      );

      if ((before.rowCount ?? 0) === 0) {
        throw new DomainError(
          "NOT_FOUND",
          "İnceleme kaydı bulunamadı veya bu işlem için yetkiniz yok.",
        );
      }

      const upd = await client.query<{ id: string }>(
        `update public.mapping_reviews
            set status = $1,
                reviewed_at = now(),
                reviewed_by = $2
          where id = any($3::uuid[])
          returning id::text as id`,
        [status, session.id, uniqueIds],
      );

      if ((upd.rowCount ?? 0) === 0) {
        throw new DomainError(
          "FORBIDDEN",
          "İnceleme kayıtları güncellenemedi veya yetkiniz yok.",
        );
      }

      updatedIds = upd.rows.map((r) => r.id);

      if (updatedIds.length === 1) {
        const singleId = updatedIds[0];
        const prevRow = before.rows.find((r) => r.id === singleId) ?? before.rows[0];
        await audit(client, {
          actor: session.id,
          action: "review_status_change",
          entityTable: "mapping_reviews",
          entityId: singleId,
          before: prevRow,
          after: { id: singleId, status },
        });
      } else {
        await audit(client, {
          actor: session.id,
          action: "bulk_review_status_change",
          entityTable: "mapping_reviews",
          entityId: null,
          before: {
            count: before.rowCount ?? 0,
            rows: before.rows.map((r) => ({ id: r.id, status: r.status })),
          },
          after: {
            status,
            updatedCount: updatedIds.length,
            ids: updatedIds,
          },
        });
      }

      await client.query("commit");
    } catch (err) {
      await client.query("rollback").catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }

    revalidatePath("/data/reviews");
    revalidatePath("/data/quality");
    revalidatePath("/data/imports");
    revalidatePath("/");

    return {
      ok: true,
      updatedCount: updatedIds.length,
      updatedIds,
      status,
    };
  } catch (err) {
    if (isNextRedirectError(err)) {
      throw err;
    }
    if (err instanceof DomainError) {
      return { ok: false, error: err.message };
    }
    throw err;
  }
}
