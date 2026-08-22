"use server";

// Faz 23 — collections server actions.
//
// TWO ACTIONS, BOTH MANUAL, BOTH AUDITED. There is deliberately no "flag everything over 90
// days" bulk action and no scheduled job: CLAUDE.md reserves the write-off judgement for a
// person, and migration 0051 plus phase23:verify both enforce that nothing else writes those
// columns. The risk scores on the page are opinions the operator reads before deciding.

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireSession } from "@/lib/auth";
import { getPool } from "@/lib/db";
import { DomainError } from "@/lib/domain-error";
import { formObject } from "@/lib/validation";
import { clearBadDebt, markBadDebt } from "@/lib/collections/engine";

const BASE = "/finance/collections";

function domainRedirect(e: unknown): never {
  if (e instanceof DomainError) redirect(`${BASE}?error=${encodeURIComponent(e.message)}`);
  throw e;
}

export async function markBadDebtAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  try {
    await markBadDebt(getPool(), formObject(formData), session.id);
  } catch (e) { domainRedirect(e); }
  revalidatePath(BASE);
  redirect(`${BASE}?result=supheli-alacak-isaretlendi`);
}

export async function clearBadDebtAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  try {
    await clearBadDebt(getPool(), formObject(formData), session.id);
  } catch (e) { domainRedirect(e); }
  revalidatePath(BASE);
  redirect(`${BASE}?result=isaret-kaldirildi`);
}
