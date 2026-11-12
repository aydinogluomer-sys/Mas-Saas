"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireActionPermission } from "@/lib/auth";
import { updateAllocationRule } from "@/lib/costing/engine";
import { getPool } from "@/lib/db";
import { DomainError } from "@/lib/domain-error";

const BASE = "/finance/profitability";

export async function updateAllocationRuleAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("cost_allocation_rules", "update", BASE);
  const code = String(formData.get("code") ?? "").trim();
  const allocationBasis = String(formData.get("allocationBasis") ?? "").trim();
  const rawPct = String(formData.get("fixedPercentPct") ?? "").trim();
  const fixedPercent =
    rawPct === "" ? null : Number.isFinite(Number(rawPct)) ? Number(rawPct) / 100 : null;
  const isActive = String(formData.get("isActive") ?? "true") !== "false";
  const notes = String(formData.get("notes") ?? "").trim() || undefined;

  try {
    await updateAllocationRule(
      getPool(),
      { code, allocationBasis, fixedPercent, isActive, notes },
      session.id,
    );
  } catch (e) {
    if (e instanceof DomainError) {
      redirect(`${BASE}?error=${encodeURIComponent(e.message)}`);
    }
    throw e;
  }
  revalidatePath(BASE);
  redirect(`${BASE}?result=kural-guncellendi`);
}

