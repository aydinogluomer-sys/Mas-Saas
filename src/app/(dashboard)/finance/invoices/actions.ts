"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireActionPermission } from "@/lib/auth";
import {
  isHandledActionError,
  isPgPeriodLockedError,
  toUserActionErrorMessage,
} from "@/lib/cashflow/period-lock";
import { getPool } from "@/lib/db";
import { revalidateFinancialViews } from "@/lib/revalidate-financial-views";
import { formObject } from "@/lib/validation";
import {
  cancelInvoice, changeInvoiceStatus, createInvoice, recordInvoicePayment,
} from "@/lib/invoices/engine";

const BASE = "/finance/invoices";

function domainRedirect(e: unknown): never {
  if (isPgPeriodLockedError(e) || isHandledActionError(e)) {
    redirect(`${BASE}?error=${encodeURIComponent(toUserActionErrorMessage(e, "Fatura işlemi tamamlanamadı."))}`);
  }
  throw e;
}

export async function createInvoiceAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("invoices", "insert", BASE);
  const f = formObject(formData);
  let invoiceId: string;
  try {
    ({ invoiceId } = await createInvoice(getPool(), {
      direction: f.direction,
      invoiceNo: f.invoiceNo,
      partyId: f.partyId,
      issueDate: f.issueDate,
      dueDate: f.dueDate || undefined,
      currency: f.currency || "TRY",
      costCenterId: f.costCenterId || undefined,
      projectId: f.projectId || undefined,
      departmentId: f.departmentId || undefined,
      notes: f.notes || undefined,
      lines: [{
        description: f.lineDescription,
        quantity: f.lineQuantity,
        unitPrice: f.lineUnitPrice,
        taxRate: f.lineTaxRate || 0,
        costCenterId: f.costCenterId || undefined,
        projectId: f.projectId || undefined,
        departmentId: f.departmentId || undefined,
      }],
    }, session.id));
  } catch (e) { domainRedirect(e); }
  revalidatePath(BASE);
  revalidatePath("/finance/profitability");
  revalidatePath("/cashflow/budget");
  revalidateFinancialViews();
  redirect(`${BASE}?result=created&invoice=${invoiceId}`);
}

export async function changeStatusAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("invoices", "update", BASE);
  try {
    await changeInvoiceStatus(getPool(), formObject(formData), session.id);
  } catch (e) { domainRedirect(e); }
  revalidatePath(BASE);
  revalidateFinancialViews();
  redirect(`${BASE}?result=durum-guncellendi`);
}

export async function recordPaymentAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("invoices", "update", BASE);
  try {
    await recordInvoicePayment(getPool(), formObject(formData), session.id);
  } catch (e) { domainRedirect(e); }
  revalidatePath(BASE);
  revalidateFinancialViews();
  redirect(`${BASE}?result=tahsilat-islendi`);
}

/** Cancellation — always with a reason, always with a reversal record. */
export async function cancelInvoiceAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("invoices", "update", BASE);
  try {
    await cancelInvoice(getPool(), formObject(formData), session.id);
  } catch (e) { domainRedirect(e); }
  revalidatePath(BASE);
  revalidateFinancialViews();
  redirect(`${BASE}?result=iptal-edildi`);
}
