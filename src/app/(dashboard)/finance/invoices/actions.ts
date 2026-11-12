"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireActionPermission } from "@/lib/auth";
import { getPool } from "@/lib/db";
import { DomainError } from "@/lib/domain-error";
import { formObject } from "@/lib/validation";
import {
  cancelInvoice, changeInvoiceStatus, createInvoice, recordInvoicePayment,
} from "@/lib/invoices/engine";

const BASE = "/finance/invoices";

function domainRedirect(e: unknown): never {
  if (e instanceof DomainError) redirect(`${BASE}?error=${encodeURIComponent(e.message)}`);
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
  redirect(`${BASE}?result=created&invoice=${invoiceId}`);
}

export async function changeStatusAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("invoices", "update", BASE);
  try {
    await changeInvoiceStatus(getPool(), formObject(formData), session.id);
  } catch (e) { domainRedirect(e); }
  revalidatePath(BASE);
  redirect(`${BASE}?result=durum-guncellendi`);
}

export async function recordPaymentAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("invoices", "update", BASE);
  try {
    await recordInvoicePayment(getPool(), formObject(formData), session.id);
  } catch (e) { domainRedirect(e); }
  revalidatePath(BASE);
  redirect(`${BASE}?result=tahsilat-islendi`);
}

/** Cancellation — always with a reason, always with a reversal record. */
export async function cancelInvoiceAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("invoices", "update", BASE);
  try {
    await cancelInvoice(getPool(), formObject(formData), session.id);
  } catch (e) { domainRedirect(e); }
  revalidatePath(BASE);
  redirect(`${BASE}?result=iptal-edildi`);
}
