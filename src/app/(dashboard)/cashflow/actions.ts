"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getPool } from "@/lib/db";
import { mapCashflowMonths, validateContinuity, writeSnapshots } from "@/lib/cashflow/engine";
import { lockCashflowPeriod, reopenCashflowPeriod } from "@/lib/cashflow/period-lock";
import { requireActionPermission, requireSession } from "@/lib/auth";
import { DomainError } from "@/lib/domain-error";
import { safeRedirectPath } from "@/lib/security/redirect";

export async function mapCashflowAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("cashflow_months", "insert", "/cashflow");
  const workbookId = String(formData.get("workbookId") ?? "");
  if (!workbookId) return;
  const pool = getPool();
  const r = await mapCashflowMonths(pool, workbookId, session.id);
  await validateContinuity(pool);
  await writeSnapshots(pool, new Date().toISOString().slice(0, 10));
  revalidatePath("/cashflow");
  redirect(`/cashflow?months=${r.monthsCreated}&lines=${r.linesCreated}`);
}

export async function lockCashflowPeriodAction(formData: FormData): Promise<void> {
  const session = await requireSession({ routePrefix: "/cashflow" });
  const monthId = String(formData.get("monthId") ?? "").trim();
  const notesRaw = String(formData.get("notes") ?? "").trim();
  const fallback = monthId ? `/cashflow/${encodeURIComponent(monthId)}` : "/cashflow";
  const returnTo = safeRedirectPath(formData.get("returnTo"), fallback);

  try {
    const res = await lockCashflowPeriod(
      getPool(),
      { monthId, notes: notesRaw || undefined },
      { id: session.id, role: session.role },
    );
    revalidatePath("/cashflow");
    revalidatePath(`/cashflow/${res.monthId}`);
    revalidatePath(`/cashflow/${res.ym}`);
    const msg = `${res.ym} dönemi kilitlendi (parmak izi: ${res.lockFingerprint.slice(0, 12)}).`;
    redirect(`${returnTo}?notice=${encodeURIComponent(msg)}`);
  } catch (err) {
    if (err instanceof DomainError) {
      redirect(`${returnTo}?error=${encodeURIComponent(err.message)}`);
    }
    throw err;
  }
}

export async function reopenCashflowPeriodAction(formData: FormData): Promise<void> {
  const session = await requireSession({ routePrefix: "/cashflow" });
  const monthId = String(formData.get("monthId") ?? "").trim();
  const reason = String(formData.get("reason") ?? "");
  const fallback = monthId ? `/cashflow/${encodeURIComponent(monthId)}` : "/cashflow";
  const returnTo = safeRedirectPath(formData.get("returnTo"), fallback);

  try {
    const res = await reopenCashflowPeriod(
      getPool(),
      { monthId, reason },
      { id: session.id, role: session.role },
    );
    revalidatePath("/cashflow");
    revalidatePath(`/cashflow/${res.monthId}`);
    revalidatePath(`/cashflow/${res.ym}`);
    const msg = `${res.ym} dönem kilidi gerekçeli olarak yeniden açıldı.`;
    redirect(`${returnTo}?notice=${encodeURIComponent(msg)}`);
  } catch (err) {
    if (err instanceof DomainError) {
      redirect(`${returnTo}?error=${encodeURIComponent(err.message)}`);
    }
    throw err;
  }
}
