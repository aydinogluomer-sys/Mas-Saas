"use server";

// Faz 22 — allocation server actions.
//
// Every mutation goes through src/lib/receivables/engine.ts (Zod at the boundary, canonical
// audit() in the same transaction). The allocation ceiling is enforced by migration 0048's
// trigger; the engine's check exists only to turn a refusal into a readable sentence, and
// implementation.md §18 is explicit that an application check is never sufficient on its own.

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireSession } from "@/lib/auth";
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
  const session = await requireSession();
  try {
    await allocateToInvoice(getPool(), formObject(formData), session.id);
  } catch (e) { domainRedirect(e); }
  revalidatePath(BASE);
  redirect(`${BASE}?result=dagitim-yapildi`);
}

export async function reverseAllocationAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  try {
    await reverseAllocation(getPool(), formObject(formData), session.id);
  } catch (e) { domainRedirect(e); }
  revalidatePath(BASE);
  redirect(`${BASE}?result=dagitim-iptal`);
}
