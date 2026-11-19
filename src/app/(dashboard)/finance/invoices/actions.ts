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

  const descriptions = formData.getAll("lineDescription").map((v) => String(v ?? "").trim());
  const quantities = formData.getAll("lineQuantity").map((v) => String(v ?? "").trim());
  const unitPrices = formData.getAll("lineUnitPrice").map((v) => String(v ?? "").trim());
  const taxRates = formData.getAll("lineTaxRate").map((v) => String(v ?? "").trim());
  const discountRates = formData.getAll("lineDiscountRate").map((v) => String(v ?? "").trim());
  const stopajRates = formData.getAll("lineIncomeTaxWithholdingRate").map((v) => String(v ?? "").trim());
  const units = formData.getAll("lineUnit").map((v) => String(v ?? "").trim());

  const lines = descriptions
    .map((desc, idx) => ({
      description: desc,
      quantity: quantities[idx] || "1",
      unitPrice: unitPrices[idx] || "0",
      taxRate: taxRates[idx] || "0",
      discountRate: discountRates[idx] || "0",
      incomeTaxWithholdingRate: stopajRates[idx] || "0",
      unit: units[idx] || undefined,
      costCenterId: f.costCenterId || undefined,
      projectId: f.projectId || undefined,
      departmentId: f.departmentId || undefined,
    }))
    .filter((l) => l.description.length > 0);

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
      linkedPaymentInstanceId: f.linkedPaymentInstanceId || undefined,
      notes: f.notes || undefined,
      lines: lines.length > 0 ? lines : [{
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
  const f = formObject(formData);
  try {
    await recordInvoicePayment(
      getPool(),
      {
        invoiceId: f.invoiceId,
        amount: f.amount,
        cashAccountId: f.cashAccountId || undefined,
        fxRate: f.fxRate || undefined,
      },
      session.id,
    );
  } catch (e) { domainRedirect(e); }
  revalidatePath(BASE);
  revalidatePath("/finance/bank");
  revalidatePath("/finance/ledger");
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
