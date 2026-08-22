"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { getPool } from "@/lib/db";
import { requireSession } from "@/lib/auth";
import { raiseActionItemForAlert, setAlertStatus } from "@/lib/controls/engine";
import { DomainError } from "@/lib/domain-error";

const PAGE = "/system/controls";

function fail(e: unknown): never {
  // A refused transition is an ANSWER the operator must read — most often "a closed finding is
  // not reopened" — not a stack trace.
  if (e instanceof DomainError) {
    revalidatePath(PAGE);
    redirect(`${PAGE}?error=${encodeURIComponent(e.message)}`);
  }
  throw e;
}

export async function setAlertStatusAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  const snooze = String(formData.get("snoozeUntil") ?? "").trim();
  const note = String(formData.get("note") ?? "").trim();
  try {
    await setAlertStatus(getPool(), {
      alertId: String(formData.get("alertId") ?? ""),
      status: String(formData.get("status") ?? ""),
      note: note === "" ? undefined : note,
      snoozeUntil: snooze === "" ? null : snooze,
    }, session.id);
  } catch (e) { fail(e); }
  revalidatePath(PAGE);
  redirect(`${PAGE}?result=updated`);
}

/** Turn a finding into a task — reusing action_items, not a second task model. */
export async function raiseActionItemAction(formData: FormData): Promise<void> {
  const session = await requireSession();
  try {
    await raiseActionItemForAlert(getPool(), String(formData.get("alertId") ?? ""), session.id);
  } catch (e) { fail(e); }
  revalidatePath(PAGE);
  revalidatePath("/insights");
  redirect(`${PAGE}?result=task_raised`);
}
