"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { requireSession } from "@/lib/auth";
import { can } from "@/lib/authz/matrix";
import { getPool } from "@/lib/db";
import { DomainError } from "@/lib/domain-error";
import { decimal, money, rate } from "@/lib/money";
import { formObject } from "@/lib/validation";

const BASE = "/production/kiosk";

function strField(v: string | string[] | undefined, fallback = ""): string {
  if (Array.isArray(v)) return (v[0] ?? fallback).trim();
  return (v ?? fallback).trim();
}

function redirectWithFlash(
  kind: "result" | "error",
  message: string,
  codeFilter?: string,
): never {
  const params = new URLSearchParams();
  if (codeFilter && codeFilter.trim().length > 0) {
    params.set("code", codeFilter.trim());
  }
  params.set(kind, message);
  redirect(`${BASE}?${params.toString()}`);
}

interface LockedWorkOrderRow {
  id: string;
  order_no: string;
  status: "planned" | "in_progress" | "completed" | "cancelled";
  planned_qty: string;
  good_qty: string;
  scrap_qty: string;
  planned_minutes: string;
  actual_run_minutes: string;
  downtime_minutes: string;
  downtime_reason: string | null;
  operator_note: string | null;
  started_at: string | null;
  completed_at: string | null;
}

const SELECT_FOR_UPDATE_SQL = `
  select id::text,
         order_no,
         status,
         planned_qty::text,
         good_qty::text,
         scrap_qty::text,
         planned_minutes::text,
         actual_run_minutes::text,
         downtime_minutes::text,
         downtime_reason,
         operator_note,
         started_at::text,
         completed_at::text
    from public.work_orders
   where id = $1::uuid
   for update
`;

const startSchema = z.object({
  workOrderId: z.string().trim().uuid("Geçersiz iş emri kimliği."),
  operatorNote: z.string().trim().max(500).optional(),
});

export async function kioskStartWorkOrderAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const f = formObject(formData);
  const codeFilter = strField(f.codeFilter);
  if (!can(session.role, "work_orders", "update")) {
    redirectWithFlash("error", "Atölye iş emri başlatma yetkiniz yok.", codeFilter);
  }

  const parsed = startSchema.safeParse({
    workOrderId: strField(f.workOrderId),
    operatorNote: strField(f.operatorNote) || undefined,
  });
  if (!parsed.success) {
    redirectWithFlash(
      "error",
      parsed.error.issues[0]?.message ?? "Geçersiz iş emri başlatma formu.",
      codeFilter,
    );
  }

  const pool = getPool();
  const client = await pool.connect();
  let orderNo = "";
  try {
    await client.query("begin");
    const prevRes = await client.query<LockedWorkOrderRow>(SELECT_FOR_UPDATE_SQL, [
      parsed.data.workOrderId,
    ]);
    if (prevRes.rowCount !== 1) {
      throw new DomainError("NOT_FOUND", "İş emri bulunamadı.");
    }
    const before = prevRes.rows[0];
    orderNo = before.order_no;
    if (before.status === "cancelled") {
      throw new DomainError("CONFLICT", `${before.order_no} iptal edilmiş; başlatılamaz.`);
    }

    const nextNote = parsed.data.operatorNote ?? before.operator_note;
    const upd = await client.query(
      `update public.work_orders
          set status = 'in_progress',
              started_at = coalesce(started_at, now()),
              operator_note = $2,
              last_kiosk_event_at = now(),
              updated_at = now()
        where id = $1::uuid`,
      [parsed.data.workOrderId, nextNote],
    );
    if (upd.rowCount !== 1) {
      throw new DomainError("FORBIDDEN", "İş emri üretime alınamadı.");
    }

    await audit(client, {
      actor: session.id,
      action: "kiosk_start_work_order",
      entityTable: "work_orders",
      entityId: parsed.data.workOrderId,
      before,
      after: {
        order_no: before.order_no,
        status: "in_progress",
        operator_note: nextNote,
      },
    });
    await client.query("commit");
  } catch (e) {
    await client.query("rollback").catch(() => undefined);
    if (e instanceof DomainError) {
      redirectWithFlash("error", e.message, codeFilter);
    }
    throw e;
  } finally {
    client.release();
  }

  revalidatePath(BASE);
  revalidatePath("/production");
  redirectWithFlash("result", `${orderNo} tezgâhta üretime alındı.`, codeFilter);
}

const downtimeSchema = z.object({
  workOrderId: z.string().trim().uuid("Geçersiz iş emri kimliği."),
  addedDowntimeMinutes: z.coerce
    .number()
    .positive("Duruş süresi 0'dan büyük olmalıdır (dk).")
    .max(1440, "Tek seferde en fazla 1440 dakika girilebilir."),
  downtimeReason: z
    .string()
    .trim()
    .min(2, "Duruş nedeni zorunludur.")
    .max(300, "Duruş nedeni en fazla 300 karakter olabilir."),
  operatorNote: z.string().trim().max(500).optional(),
});

export async function kioskReportDowntimeAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const f = formObject(formData);
  const codeFilter = strField(f.codeFilter);
  if (!can(session.role, "work_orders", "update")) {
    redirectWithFlash("error", "Atölye duruş bildirimi yetkiniz yok.", codeFilter);
  }

  const parsed = downtimeSchema.safeParse({
    workOrderId: strField(f.workOrderId),
    addedDowntimeMinutes: strField(f.addedDowntimeMinutes),
    downtimeReason: strField(f.downtimeReason),
    operatorNote: strField(f.operatorNote) || undefined,
  });
  if (!parsed.success) {
    redirectWithFlash(
      "error",
      parsed.error.issues[0]?.message ?? "Duruş bildirim alanlarını kontrol edin.",
      codeFilter,
    );
  }

  const pool = getPool();
  const client = await pool.connect();
  let orderNo = "";
  let nextDowntime = 0;
  try {
    await client.query("begin");
    const prevRes = await client.query<LockedWorkOrderRow>(SELECT_FOR_UPDATE_SQL, [
      parsed.data.workOrderId,
    ]);
    if (prevRes.rowCount !== 1) {
      throw new DomainError("NOT_FOUND", "İş emri bulunamadı.");
    }
    const before = prevRes.rows[0];
    orderNo = before.order_no;
    if (before.status === "completed" || before.status === "cancelled") {
      throw new DomainError(
        "CONFLICT",
        `${before.order_no} kapalı durumda (${before.status}); duruş eklenemez.`,
      );
    }

    nextDowntime = money(
      decimal(rate(before.downtime_minutes)).plus(parsed.data.addedDowntimeMinutes),
    );
    const nextNote = parsed.data.operatorNote ?? before.operator_note;

    const upd = await client.query(
      `update public.work_orders
          set downtime_minutes = $2,
              downtime_reason = $3,
              operator_note = $4,
              last_kiosk_event_at = now(),
              updated_at = now()
        where id = $1::uuid`,
      [parsed.data.workOrderId, nextDowntime, parsed.data.downtimeReason, nextNote],
    );
    if (upd.rowCount !== 1) {
      throw new DomainError("FORBIDDEN", "Duruş kaydı işlenemedi.");
    }

    await audit(client, {
      actor: session.id,
      action: "kiosk_report_downtime",
      entityTable: "work_orders",
      entityId: parsed.data.workOrderId,
      before,
      after: {
        order_no: before.order_no,
        downtime_minutes: nextDowntime,
        downtime_reason: parsed.data.downtimeReason,
        operator_note: nextNote,
      },
    });
    await client.query("commit");
  } catch (e) {
    await client.query("rollback").catch(() => undefined);
    if (e instanceof DomainError) {
      redirectWithFlash("error", e.message, codeFilter);
    }
    throw e;
  } finally {
    client.release();
  }

  revalidatePath(BASE);
  revalidatePath("/production");
  redirectWithFlash(
    "result",
    `${orderNo} duruş kaydedildi (+${parsed.data.addedDowntimeMinutes} dk · toplam ${nextDowntime} dk).`,
    codeFilter,
  );
}

const outputAndScrapSchema = z
  .object({
    workOrderId: z.string().trim().uuid("Geçersiz iş emri kimliği."),
    addedGoodQty: z.coerce.number().min(0, "Sağlam adet negatif olamaz.").max(1_000_000),
    addedScrapQty: z.coerce.number().min(0, "Fire adet negatif olamaz.").max(1_000_000),
    addedRunMinutes: z.coerce
      .number()
      .min(0, "Çalışma süresi negatif olamaz.")
      .max(1440, "Tek seferde en fazla 1440 dk eklenebilir."),
    operatorNote: z.string().trim().max(500).optional(),
  })
  .refine(
    (v) =>
      v.addedGoodQty > 0 ||
      v.addedScrapQty > 0 ||
      v.addedRunMinutes > 0 ||
      Boolean(v.operatorNote),
    {
      message: "En az sağlam adet, fire adedi, çalışma dakikası veya operatör notu girilmelidir.",
    },
  );

export async function kioskRecordOutputAndScrapAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const f = formObject(formData);
  const codeFilter = strField(f.codeFilter);
  if (!can(session.role, "work_orders", "update")) {
    redirectWithFlash("error", "Üretim ve fire kayıt yetkiniz yok.", codeFilter);
  }

  const parsed = outputAndScrapSchema.safeParse({
    workOrderId: strField(f.workOrderId),
    addedGoodQty: strField(f.addedGoodQty, "0") || "0",
    addedScrapQty: strField(f.addedScrapQty, "0") || "0",
    addedRunMinutes: strField(f.addedRunMinutes, "0") || "0",
    operatorNote: strField(f.operatorNote) || undefined,
  });
  if (!parsed.success) {
    redirectWithFlash(
      "error",
      parsed.error.issues[0]?.message ?? "Üretim / fire giriş değerleri geçersiz.",
      codeFilter,
    );
  }

  const pool = getPool();
  const client = await pool.connect();
  let orderNo = "";
  let nextGood = 0;
  let nextScrap = 0;
  try {
    await client.query("begin");
    const prevRes = await client.query<LockedWorkOrderRow>(SELECT_FOR_UPDATE_SQL, [
      parsed.data.workOrderId,
    ]);
    if (prevRes.rowCount !== 1) {
      throw new DomainError("NOT_FOUND", "İş emri bulunamadı.");
    }
    const before = prevRes.rows[0];
    orderNo = before.order_no;
    if (before.status === "completed" || before.status === "cancelled") {
      throw new DomainError(
        "CONFLICT",
        `${before.order_no} kapalı durumda (${before.status}); üretim adedi eklenemez.`,
      );
    }

    nextGood = money(decimal(rate(before.good_qty)).plus(parsed.data.addedGoodQty));
    nextScrap = money(decimal(rate(before.scrap_qty)).plus(parsed.data.addedScrapQty));
    const nextRun = money(
      decimal(rate(before.actual_run_minutes)).plus(parsed.data.addedRunMinutes),
    );
    const nextStatus = before.status === "planned" ? "in_progress" : before.status;
    const nextNote = parsed.data.operatorNote ?? before.operator_note;

    const upd = await client.query(
      `update public.work_orders
          set status = $2,
              good_qty = $3,
              scrap_qty = $4,
              actual_run_minutes = $5,
              operator_note = $6,
              started_at = coalesce(started_at, now()),
              last_kiosk_event_at = now(),
              updated_at = now()
        where id = $1::uuid`,
      [parsed.data.workOrderId, nextStatus, nextGood, nextScrap, nextRun, nextNote],
    );
    if (upd.rowCount !== 1) {
      throw new DomainError("FORBIDDEN", "Üretim ve fire kaydı işlenemedi.");
    }

    await audit(client, {
      actor: session.id,
      action: "kiosk_record_output_and_scrap",
      entityTable: "work_orders",
      entityId: parsed.data.workOrderId,
      before,
      after: {
        order_no: before.order_no,
        status: nextStatus,
        good_qty: nextGood,
        scrap_qty: nextScrap,
        actual_run_minutes: nextRun,
        operator_note: nextNote,
      },
    });
    await client.query("commit");
  } catch (e) {
    await client.query("rollback").catch(() => undefined);
    if (e instanceof DomainError) {
      redirectWithFlash("error", e.message, codeFilter);
    }
    throw e;
  } finally {
    client.release();
  }

  revalidatePath(BASE);
  revalidatePath("/production");
  redirectWithFlash(
    "result",
    `${orderNo} güncellendi: sağlam ${nextGood} adet · fire ${nextScrap} adet.`,
    codeFilter,
  );
}

const completeSchema = z.object({
  workOrderId: z.string().trim().uuid("Geçersiz iş emri kimliği."),
  operatorNote: z.string().trim().max(500).optional(),
});

export async function kioskCompleteWorkOrderAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const f = formObject(formData);
  const codeFilter = strField(f.codeFilter);
  if (!can(session.role, "work_orders", "update")) {
    redirectWithFlash("error", "İş emri tamamlama yetkiniz yok.", codeFilter);
  }

  const parsed = completeSchema.safeParse({
    workOrderId: strField(f.workOrderId),
    operatorNote: strField(f.operatorNote) || undefined,
  });
  if (!parsed.success) {
    redirectWithFlash(
      "error",
      parsed.error.issues[0]?.message ?? "Geçersiz iş emri tamamlama formu.",
      codeFilter,
    );
  }

  const pool = getPool();
  const client = await pool.connect();
  let orderNo = "";
  let finalGoodQty = 0;
  try {
    await client.query("begin");
    const prevRes = await client.query<LockedWorkOrderRow>(SELECT_FOR_UPDATE_SQL, [
      parsed.data.workOrderId,
    ]);
    if (prevRes.rowCount !== 1) {
      throw new DomainError("NOT_FOUND", "İş emri bulunamadı.");
    }
    const before = prevRes.rows[0];
    orderNo = before.order_no;
    if (before.status === "completed" || before.status === "cancelled") {
      throw new DomainError("CONFLICT", `${before.order_no} zaten kapalı (${before.status}).`);
    }

    if (before.status === "planned") {
      const step = await client.query(
        `update public.work_orders
            set status = 'in_progress',
                started_at = coalesce(started_at, now()),
                updated_at = now()
          where id = $1::uuid`,
        [parsed.data.workOrderId],
      );
      if (step.rowCount !== 1) {
        throw new DomainError("FORBIDDEN", "İş emri üretime alınamadı.");
      }
    }

    const curGood = rate(before.good_qty);
    const curRun = rate(before.actual_run_minutes);
    finalGoodQty = curGood > 0 ? curGood : rate(before.planned_qty);
    const finalRunMinutes = curRun > 0 ? curRun : rate(before.planned_minutes);
    const nextNote = parsed.data.operatorNote ?? before.operator_note;

    const upd = await client.query(
      `update public.work_orders
          set status = 'completed',
              good_qty = $2,
              actual_run_minutes = $3,
              operator_note = $4,
              started_at = coalesce(started_at, now()),
              completed_at = now(),
              last_kiosk_event_at = now(),
              updated_at = now()
        where id = $1::uuid`,
      [parsed.data.workOrderId, finalGoodQty, finalRunMinutes, nextNote],
    );
    if (upd.rowCount !== 1) {
      throw new DomainError("FORBIDDEN", "İş emri tamamlanamadı.");
    }

    await audit(client, {
      actor: session.id,
      action: "kiosk_complete_work_order",
      entityTable: "work_orders",
      entityId: parsed.data.workOrderId,
      before,
      after: {
        order_no: before.order_no,
        status: "completed",
        good_qty: finalGoodQty,
        actual_run_minutes: finalRunMinutes,
        operator_note: nextNote,
      },
    });
    await client.query("commit");
  } catch (e) {
    await client.query("rollback").catch(() => undefined);
    if (e instanceof DomainError) {
      redirectWithFlash("error", e.message, codeFilter);
    }
    throw e;
  } finally {
    client.release();
  }

  revalidatePath(BASE);
  revalidatePath("/production");
  redirectWithFlash(
    "result",
    `${orderNo} tamamlandı (${finalGoodQty} sağlam adet).`,
    codeFilter,
  );
}
