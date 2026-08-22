"use server";

// Faz 19 — counterparty server actions.
//
// These are the ONLY paths that create a counterparty or link one to a financial record. The
// importer deliberately has no such path: it matches on normalized name, keeps the raw label,
// and leaves the FK null when it cannot match (src/lib/financing/engine.ts's partyIdByName).
// Every function here therefore starts from something a logged-in person typed or clicked.
//
// Input is parsed by the engine through @/lib/validation's parseOrThrow (Faz 18's rule), which
// throws a DomainError carrying a message written for the operator. That is why the catch below
// only converts DomainError into a redirect: anything else is an unexpected fault and must
// propagate rather than be flattened into a friendly message. Mirrors the pattern established
// in src/app/(dashboard)/finance/actions.ts.

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireSession } from "@/lib/auth";
import { getPool } from "@/lib/db";
import { DomainError } from "@/lib/domain-error";
import { formObject } from "@/lib/validation";
import {
  addIban,
  createCounterparty,
  createDimension,
  deactivateIban,
  linkCheckCounterparty,
  type DimensionTable,
} from "@/lib/counterparties/engine";

const BASE = "/finance/counterparties";

/** DomainError -> a message the page can show; everything else propagates. */
function domainRedirect(e: unknown, back: string): never {
  if (e instanceof DomainError) {
    redirect(`${back}?error=${encodeURIComponent(e.message)}`);
  }
  throw e;
}

export async function createCounterpartyAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  let partyId: string;
  try {
    ({ partyId } = await createCounterparty(getPool(), formObject(formData), session.id));
  } catch (e) {
    domainRedirect(e, BASE);
  }
  revalidatePath(BASE);
  redirect(`${BASE}?result=created&party=${partyId}`);
}

export async function addIbanAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  let warnings: string[] = [];
  try {
    ({ warnings } = await addIban(getPool(), formObject(formData), session.id));
  } catch (e) {
    domainRedirect(e, BASE);
  }
  revalidatePath(BASE);
  // A failing checksum is reported, not rejected — the row is written and the operator is told.
  // Refusing to record what the source document says would break the preserve-the-source rule.
  redirect(warnings.length > 0 ? `${BASE}?warn=${encodeURIComponent(warnings.join(" "))}` : `${BASE}?result=iban-added`);
}

export async function deactivateIbanAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  try {
    await deactivateIban(getPool(), String(formData.get("ibanId") ?? ""), session.id);
  } catch (e) {
    domainRedirect(e, BASE);
  }
  revalidatePath(BASE);
  redirect(`${BASE}?result=iban-deactivated`);
}

/**
 * Resolve a raw counterparty label to an existing party.
 *
 * The reviewed, explicit act that migration 0039's `counterparty_unresolved` view exists to
 * make visible — and that Faz 19 deliberately refused to do automatically for the rows already
 * in the database.
 */
export async function linkCounterpartyAction(formData: FormData): Promise<void> {
  const session = await requireSession();
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
  const session = await requireSession();
  const table = String(formData.get("table") ?? "") as DimensionTable;
  try {
    await createDimension(getPool(), table, formObject(formData), session.id);
  } catch (e) {
    domainRedirect(e, BASE);
  }
  revalidatePath(BASE);
  redirect(`${BASE}?result=dimension-created`);
}
