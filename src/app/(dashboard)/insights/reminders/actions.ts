"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireActionPermission } from "@/lib/auth";
import type { AppRole } from "@/lib/authz/matrix";
import { getPool } from "@/lib/db";
import { DomainError } from "@/lib/domain-error";
import { dispatchPending, scheduleReminders } from "@/lib/reminders/engine";
import { transportFor } from "@/lib/reminders/transport";
import { istanbulDateISO } from "@/lib/reports/rules";

const PAGE = "/insights/reminders";

const REMINDER_OPERATORS: readonly AppRole[] = ["finance_manager", "admin"];

async function requireReminderOperator(): Promise<void> {
  const session = await requireActionPermission("reminders", "update", PAGE);
  if (!REMINDER_OPERATORS.includes(session.role)) {
    throw new DomainError("FORBIDDEN", "Hatırlatma bakımı için finans yöneticisi veya yönetici yetkisi gerekir.");
  }
}

/** A refusal is an answer the operator must read, not a stack trace — same shape as system/controls. */
function fail(e: unknown): never {
  if (e instanceof DomainError) {
    redirect(`${PAGE}?error=${encodeURIComponent(e.message)}`);
  }
  throw e;
}

export async function scheduleRemindersAction(): Promise<void> {
  try {
    await requireReminderOperator();
  } catch (e) {
    fail(e);
  }
  const pool = getPool();
  await scheduleReminders(pool, istanbulDateISO());
  revalidatePath(PAGE);
}

export async function dispatchRemindersAction(): Promise<void> {
  try {
    await requireReminderOperator();
  } catch (e) {
    fail(e);
  }
  const pool = getPool();
  await dispatchPending(pool, transportFor, istanbulDateISO());
  revalidatePath(PAGE);
}

