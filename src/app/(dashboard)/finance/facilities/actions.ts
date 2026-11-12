"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireActionPermission } from "@/lib/auth";
import { getPool } from "@/lib/db";
import { DomainError } from "@/lib/domain-error";
import { formObject } from "@/lib/validation";
import {
  addCollateral,
  createFacility,
  recordFacilityMovement,
  upsertCovenant,
} from "@/lib/financing/facilities";

const BASE = "/finance/facilities";

function domainRedirect(e: unknown): never {
  if (e instanceof DomainError) {
    redirect(`${BASE}?error=${encodeURIComponent(e.message)}`);
  }
  throw e;
}

function revalidateFacilitySurfaces(): void {
  revalidatePath(BASE);
  revalidatePath("/cashflow/optimization");
  revalidatePath("/cashflow/treasury");
  revalidatePath("/insights/briefing");
}

export async function createFacilityAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("credit_facilities", "insert", BASE);
  const f = formObject(formData);
  try {
    await createFacility(
      getPool(),
      {
        name: f.name,
        lenderPartyId: f.lenderPartyId || null,
        facilityType: f.facilityType || "revolving",
        limitAmount: Number(f.limitAmount),
        currency: f.currency || "TRY",
        interestRate: f.interestRate ? Number(f.interestRate) : null,
        commissionRate: f.commissionRate ? Number(f.commissionRate) : null,
        startDate: f.startDate || null,
        expiryDate: f.expiryDate || null,
        reviewDate: f.reviewDate || null,
        status: f.status || "active",
        notes: f.notes || undefined,
      },
      session.id,
    );
  } catch (e) {
    domainRedirect(e);
  }
  revalidateFacilitySurfaces();
  redirect(`${BASE}?result=limit-eklendi`);
}

export async function recordFacilityMovementAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("facility_movements", "insert", BASE);
  const f = formObject(formData);
  try {
    await recordFacilityMovement(
      getPool(),
      {
        facilityId: f.facilityId,
        movementType: f.movementType,
        movementDate: f.movementDate,
        amount: Number(f.amount),
        currency: f.currency || "TRY",
        bankTxId: f.bankTxId || null,
        notes: f.notes || undefined,
      },
      session.id,
    );
  } catch (e) {
    domainRedirect(e);
  }
  revalidateFacilitySurfaces();
  redirect(`${BASE}?result=hareket-islendi`);
}

export async function addCollateralAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("collateral_records", "insert", BASE);
  const f = formObject(formData);
  const subjectRaw = String(f.subject ?? "");
  const [subjectKind, subjectId] = subjectRaw.includes(":") ? subjectRaw.split(":", 2) : ["facility", f.facilityId];
  try {
    await addCollateral(
      getPool(),
      {
        facilityId: subjectKind === "facility" ? subjectId || null : null,
        loanId: subjectKind === "loan" ? subjectId || null : null,
        collateralType: f.collateralType,
        description: f.description || undefined,
        valueAmount: f.valueAmount ? Number(f.valueAmount) : null,
        currency: f.currency || "TRY",
        valuationDate: f.valuationDate || null,
        valuationSource: f.valuationSource || null,
        notes: f.notes || undefined,
      },
      session.id,
    );
  } catch (e) {
    domainRedirect(e);
  }
  revalidateFacilitySurfaces();
  redirect(`${BASE}?result=teminat-eklendi`);
}

export async function upsertCovenantAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission(
    "covenant_records",
    formData.get("covenantId") ? "update" : "insert",
    BASE,
  );
  const f = formObject(formData);
  const isUpdate = Boolean(f.covenantId);
  const subjectRaw = String(f.subject ?? "");
  const [subjectKind, subjectId] = subjectRaw.includes(":") ? subjectRaw.split(":", 2) : ["facility", f.facilityId];
  try {
    await upsertCovenant(
      getPool(),
      {
        covenantId: f.covenantId || null,
        facilityId: !isUpdate && subjectKind === "facility" ? subjectId || null : null,
        loanId: !isUpdate && subjectKind === "loan" ? subjectId || null : null,
        covenantType: f.covenantType || "dscr",
        description: f.description,
        comparison: f.comparison || "gte",
        thresholdValue: Number(f.thresholdValue),
        testFrequency: f.testFrequency || "quarterly",
        status: f.status || "active",
        lastTestDate: f.lastTestDate || null,
        lastTestValue: f.lastTestValue !== undefined && f.lastTestValue !== "" ? Number(f.lastTestValue) : null,
        notes: f.notes || undefined,
      },
      session.id,
    );
  } catch (e) {
    domainRedirect(e);
  }
  revalidateFacilitySurfaces();
  redirect(`${BASE}?result=kovenant-kaydedildi`);
}
