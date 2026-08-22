"use server";

// Faz 21 — invoice server actions.
//
// Every mutation goes through src/lib/invoices/engine.ts, which parses input with a Zod schema
// and records through the canonical audit() inside the same transaction (Faz 18). This file
// only translates form data and turns a DomainError into a message the page can show; anything
// else propagates, because an unexpected fault must not be flattened into a friendly sentence.
//
// There is deliberately NO "cancel" shortcut that only flips a status. Cancellation goes
// through cancelInvoice, which writes the reversal record in the same transaction — and
// migration 0046's deferred trigger refuses the commit if it is missing.

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireSession } from "@/lib/auth";
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

/**
 * Create a draft invoice.
 *
 * The form posts one line's worth of fields; multi-line entry belongs to a dedicated editor and
 * is not part of this phase's surface. The engine derives the header totals from the lines, so
 * nothing here computes money.
 */
export async function createInvoiceAction(formData: FormData): Promise<void> {
  const session = await requireSession();
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
      notes: f.notes || undefined,
      lines: [{
        description: f.lineDescription,
        quantity: f.lineQuantity,
        unitPrice: f.lineUnitPrice,
        taxRate: f.lineTaxRate || 0,
      }],
    }, session.id));
  } catch (e) { domainRedirect(e); }
  revalidatePath(BASE);
  redirect(`${BASE}?result=created&invoice=${invoiceId}`);
}

export async function changeStatusAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  try {
    await changeInvoiceStatus(getPool(), formObject(formData), session.id);
  } catch (e) { domainRedirect(e); }
  revalidatePath(BASE);
  redirect(`${BASE}?result=durum-guncellendi`);
}

export async function recordPaymentAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  try {
    await recordInvoicePayment(getPool(), formObject(formData), session.id);
  } catch (e) { domainRedirect(e); }
  revalidatePath(BASE);
  redirect(`${BASE}?result=tahsilat-islendi`);
}

/** Cancellation — always with a reason, always with a reversal record. */
export async function cancelInvoiceAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  try {
    await cancelInvoice(getPool(), formObject(formData), session.id);
  } catch (e) { domainRedirect(e); }
  revalidatePath(BASE);
  redirect(`${BASE}?result=iptal-edildi`);
}
