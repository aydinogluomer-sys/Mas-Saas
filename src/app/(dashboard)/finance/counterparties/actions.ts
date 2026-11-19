"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireActionPermission } from "@/lib/auth";
import { can } from "@/lib/authz/matrix";
import {
  isHandledActionError,
  isPgPeriodLockedError,
  toUserActionErrorMessage,
} from "@/lib/cashflow/period-lock";
import { getPool } from "@/lib/db";
import { DomainError } from "@/lib/domain-error";
import { formObject } from "@/lib/validation";
import {
  addIban,
  createCounterparty,
  createDimension,
  deactivateIban,
  linkCheckCounterparty,
  updateCounterparty,
  type DimensionTable,
} from "@/lib/counterparties/engine";

const BASE = "/finance/counterparties";

function domainRedirect(e: unknown, back: string): never {
  if (isPgPeriodLockedError(e) || isHandledActionError(e)) {
    redirect(`${back}?error=${encodeURIComponent(toUserActionErrorMessage(e, "Cari hesap işlemi tamamlanamadı."))}`);
  }
  throw e;
}

export async function createCounterpartyAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("parties", "insert", BASE);
  let partyId: string;
  try {
    ({ partyId } = await createCounterparty(getPool(), formObject(formData), session.id));
  } catch (e) {
    domainRedirect(e, BASE);
  }
  revalidatePath(BASE);
  redirect(`${BASE}?result=created&ledgerParty=${partyId}`);
}

export async function updateCounterpartyAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("parties", "update", BASE);
  let partyId: string;
  try {
    ({ partyId } = await updateCounterparty(getPool(), formObject(formData), session.id));
  } catch (e) {
    domainRedirect(e, BASE);
  }
  revalidatePath(BASE);
  revalidatePath("/finance/invoices");
  revalidatePath("/finance/receivables");
  redirect(`${BASE}?result=updated&ledgerParty=${partyId}#cari-ekstre`);
}

export async function addIbanAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("ibans", "insert", BASE);
  let warnings: string[] = [];
  try {
    ({ warnings } = await addIban(getPool(), formObject(formData), session.id));
  } catch (e) {
    domainRedirect(e, BASE);
  }
  revalidatePath(BASE);
  redirect(warnings.length > 0 ? `${BASE}?warn=${encodeURIComponent(warnings.join(" "))}` : `${BASE}?result=iban-added`);
}

export async function deactivateIbanAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("ibans", "update", BASE);
  try {
    await deactivateIban(getPool(), String(formData.get("ibanId") ?? ""), session.id);
  } catch (e) {
    domainRedirect(e, BASE);
  }
  revalidatePath(BASE);
  redirect(`${BASE}?result=iban-deactivated`);
}

export async function linkCounterpartyAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("checks", "update", BASE);
  try {
    await linkCheckCounterparty(getPool(), formObject(formData), session.id);
  } catch (e) {
    domainRedirect(e, BASE);
  }
  revalidatePath(BASE);
  revalidatePath("/finance/checks");
  redirect(`${BASE}?result=linked`);
}

export async function createDimensionAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("cost_centers", "insert", BASE);
  const table = String(formData.get("table") ?? "") as DimensionTable;
  if (table && !can(session.role, table, "insert")) {
    throw new DomainError("FORBIDDEN", "Bu işlem için yetkiniz yok.");
  }
  try {
    await createDimension(getPool(), table, formObject(formData), session.id);
  } catch (e) {
    domainRedirect(e, BASE);
  }
  revalidatePath(BASE);
  redirect(`${BASE}?result=dimension-created`);
}
