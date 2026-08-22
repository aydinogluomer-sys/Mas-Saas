"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getPool } from "@/lib/db";
import { requireSession } from "@/lib/auth";
import { decideApproval, resubmitApproval } from "@/lib/approvals/engine";
import { DomainError } from "@/lib/domain-error";

// The queue and the two legacy screens must agree, so every write here revalidates all three.
// decideApproval writes the legacy column back inside the same transaction; if that stopped
// happening, these paths would silently drift apart.
function revalidateAll(): void {
  revalidatePath("/data/approvals");
  revalidatePath("/data/reviews");
  revalidatePath("/data/assumptions");
  revalidatePath("/data/quality");
}

export async function decideApprovalAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const approvalId = String(formData.get("approvalId") ?? "");
  const decision = String(formData.get("decision") ?? "");
  const note = String(formData.get("note") ?? "").trim();
  try {
    await decideApproval(getPool(), {
      approvalId, decision, note: note === "" ? undefined : note,
    }, session.id);
  } catch (e) {
    // A refused decision is an ANSWER, not a crash — maker-checker rejection is the most likely
    // case and the operator needs to read why, not see a stack trace.
    if (e instanceof DomainError) {
      revalidateAll();
      redirect(`/data/approvals?error=${encodeURIComponent(e.message)}`);
    }
    throw e;
  }
  revalidateAll();
  redirect("/data/approvals?result=decided");
}

export async function resubmitApprovalAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const approvalId = String(formData.get("approvalId") ?? "");
  const note = String(formData.get("note") ?? "").trim();
  try {
    await resubmitApproval(getPool(), {
      approvalId, note: note === "" ? undefined : note,
    }, session.id);
  } catch (e) {
    if (e instanceof DomainError) {
      revalidateAll();
      redirect(`/data/approvals?error=${encodeURIComponent(e.message)}`);
    }
    throw e;
  }
  revalidateAll();
  redirect("/data/approvals?result=resubmitted");
}
