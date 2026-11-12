"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireActionPermission } from "@/lib/auth";
import { getPool } from "@/lib/db";
import { DomainError } from "@/lib/domain-error";
import { formObject } from "@/lib/validation";
import { allocateToInvoice, reverseAllocation } from "@/lib/receivables/engine";

const BASE = "/finance/receivables";

function domainRedirect(e: unknown): never {
  if (e instanceof DomainError) redirect(`${BASE}?error=${encodeURIComponent(e.message)}`);
  throw e;
}

export async function allocateAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("invoice_allocations", "insert", BASE);
  const f = formObject(formData);
  const settlementSource = typeof f.settlementSource === "string" ? f.settlementSource.trim() : "";
  if (settlementSource) {
    if (settlementSource === "manual") {
      f.sourceTable = "manual";
      delete f.sourceId;
    } else if (settlementSource.includes(":")) {
      const [sourceTable, sourceId] = settlementSource.split(":", 2);
      f.sourceTable = sourceTable;
      f.sourceId = sourceId;
    }
    delete f.settlementSource;
  }
  try {
    await allocateToInvoice(getPool(), f, session.id);
  } catch (e) { domainRedirect(e); }
  revalidatePath(BASE);
  revalidatePath("/finance/invoices");
  redirect(`${BASE}?result=dagitim-yapildi`);
}

export async function reverseAllocationAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("invoice_allocations", "update", BASE);
  try {
    await reverseAllocation(getPool(), formObject(formData), session.id);
  } catch (e) { domainRedirect(e); }
  revalidatePath(BASE);
  revalidatePath("/finance/invoices");
  redirect(`${BASE}?result=dagitim-iptal`);
}
