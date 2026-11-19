"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getPool } from "@/lib/db";
import { mapCashflowMonths, validateContinuity, writeSnapshots } from "@/lib/cashflow/engine";
import {
  isHandledActionError,
  isPgPeriodLockedError,
  lockCashflowPeriod,
  reopenCashflowPeriod,
  toUserActionErrorMessage,
} from "@/lib/cashflow/period-lock";
import { requireActionPermission, requireSession } from "@/lib/auth";
import { safeRedirectPath } from "@/lib/security/redirect";
import { istanbulDateISO } from "@/lib/time/istanbul";

export async function mapCashflowAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("cashflow_months", "insert", "/cashflow");
  const workbookId = String(formData.get("workbookId") ?? "");
  if (!workbookId) return;
  const pool = getPool();
  let monthsCreated = 0;
  let linesCreated = 0;
  try {
    const r = await mapCashflowMonths(pool, workbookId, session.id);
    monthsCreated = r.monthsCreated;
    linesCreated = r.linesCreated;
    await validateContinuity(pool);
    await writeSnapshots(pool, istanbulDateISO());
  } catch (err) {
    if (isPgPeriodLockedError(err) || isHandledActionError(err)) {
      redirect(`/cashflow?error=${encodeURIComponent(toUserActionErrorMessage(err, "Nakit akışı eşleştirilemedi."))}`);
    }
    throw err;
  }
  revalidatePath("/cashflow");
  revalidatePath("/cashflow/monthly");
  redirect(`/cashflow?months=${monthsCreated}&lines=${linesCreated}`);
}

export async function lockCashflowPeriodAction(formData: FormData): Promise<void> {
  const session = await requireSession({ routePrefix: "/cashflow" });
  const monthId = String(formData.get("monthId") ?? "").trim();
  const notesRaw = String(formData.get("notes") ?? "").trim();
  const fallback = monthId ? `/cashflow/${encodeURIComponent(monthId)}` : "/cashflow";
  const returnTo = safeRedirectPath(formData.get("returnTo"), fallback);

  let res: Awaited<ReturnType<typeof lockCashflowPeriod>>;
  try {
    res = await lockCashflowPeriod(
      getPool(),
      { monthId, notes: notesRaw || undefined },
      { id: session.id, role: session.role },
    );
  } catch (err) {
    if (isPgPeriodLockedError(err) || isHandledActionError(err)) {
      redirect(`${returnTo}${returnTo.includes("?") ? "&" : "?"}error=${encodeURIComponent(toUserActionErrorMessage(err, "Dönem kilitlenemedi."))}`);
    }
    throw err;
  }
  revalidatePath("/cashflow");
  revalidatePath("/cashflow/monthly");
  revalidatePath("/cashflow/close");
  revalidatePath(`/cashflow/${res.monthId}`);
  revalidatePath(`/cashflow/${res.ym}`);
  const msg = `${res.ym} dönemi kilitlendi (parmak izi: ${res.lockFingerprint.slice(0, 12)}).`;
  redirect(`${returnTo}${returnTo.includes("?") ? "&" : "?"}notice=${encodeURIComponent(msg)}`);
}

export async function reopenCashflowPeriodAction(formData: FormData): Promise<void> {
  const session = await requireSession({ routePrefix: "/cashflow" });
  const monthId = String(formData.get("monthId") ?? "").trim();
  const reason = String(formData.get("reason") ?? "");
  const fallback = monthId ? `/cashflow/${encodeURIComponent(monthId)}` : "/cashflow";
  const returnTo = safeRedirectPath(formData.get("returnTo"), fallback);

  let res: Awaited<ReturnType<typeof reopenCashflowPeriod>>;
  try {
    res = await reopenCashflowPeriod(
      getPool(),
      { monthId, reason },
      { id: session.id, role: session.role },
    );
  } catch (err) {
    if (isPgPeriodLockedError(err) || isHandledActionError(err)) {
      redirect(`${returnTo}${returnTo.includes("?") ? "&" : "?"}error=${encodeURIComponent(toUserActionErrorMessage(err, "Dönem kilidi açılamadı."))}`);
    }
    throw err;
  }
  revalidatePath("/cashflow");
  revalidatePath("/cashflow/monthly");
  revalidatePath("/cashflow/close");
  revalidatePath(`/cashflow/${res.monthId}`);
  revalidatePath(`/cashflow/${res.ym}`);
  const msg = `${res.ym} dönem kilidi gerekçeli olarak yeniden açıldı.`;
  redirect(`${returnTo}${returnTo.includes("?") ? "&" : "?"}notice=${encodeURIComponent(msg)}`);
}
