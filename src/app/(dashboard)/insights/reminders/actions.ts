"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { requireActionPermission } from "@/lib/auth";
import type { AppRole } from "@/lib/authz/matrix";
import { getPool } from "@/lib/db";
import { DomainError } from "@/lib/domain-error";
import {
  dispatchPending,
  ensureDefaultMaturityRules,
  scheduleReminders,
  toggleReminderRule,
  upsertReminderRule,
} from "@/lib/reminders/engine";
import { transportFor } from "@/lib/reminders/transport";
import { istanbulDateISO } from "@/lib/reports/rules";
import { formObject, parseOrThrow } from "@/lib/validation";

const PAGE = "/insights/reminders";

const REMINDER_OPERATORS: readonly AppRole[] = ["finance_operator", "finance_manager", "admin"];

async function requireReminderOperator(action: "insert" | "update" = "update") {
  const session = await requireActionPermission("reminders", action, PAGE);
  if (!REMINDER_OPERATORS.includes(session.role)) {
    throw new DomainError("FORBIDDEN", "Hatırlatma yönetimi için finans operatörü veya yönetici yetkisi gerekir.");
  }
  return session;
}

/** A refusal is an answer the operator must read, not a stack trace — same shape as system/controls. */
function fail(e: unknown): never {
  if (e instanceof DomainError) {
    redirect(`${PAGE}?error=${encodeURIComponent(e.message)}`);
  }
  throw e;
}

export async function scheduleRemindersAction(): Promise<void> {
  const session = await requireReminderOperator("update").catch((e) => fail(e));
  const pool = getPool();
  const seeded = await ensureDefaultMaturityRules(pool, session.id);
  const res = await scheduleReminders(pool, istanbulDateISO());
  revalidatePath(PAGE);
  const note = `Vade taraması tamamlandı: ${res.inserted} yeni hatırlatma planlandı (${res.duplicatesSkipped} mükerrer atlandı${seeded > 0 ? `, ${seeded} varsayılan çek/kredi kuralı eklendi` : ""}).`;
  redirect(`${PAGE}?result=${encodeURIComponent(note)}`);
}

export async function dispatchRemindersAction(): Promise<void> {
  try {
    await requireReminderOperator("update");
  } catch (e) {
    fail(e);
  }
  const pool = getPool();
  const res = await dispatchPending(pool, transportFor, istanbulDateISO());
  revalidatePath(PAGE);
  const note = `Gönderim tamamlandı: ${res.sent} gönderildi, ${res.failed} başarısız, ${res.skipped} atlandı.`;
  redirect(`${PAGE}?result=${encodeURIComponent(note)}`);
}

const ruleFormSchema = z.object({
  id: z.string().trim().optional(),
  name: z.string().trim().min(1, "Kural adı gerekli").max(160),
  targetKind: z.enum(["payment_instance", "check", "loan_installment", "invoice", "promise_to_pay"]),
  offsetDays: z.coerce.number().int("Gün farkı tam sayı olmalı").min(-365).max(365),
  channel: z.enum(["telegram", "email"]).default("telegram"),
  minAmount: z.string().trim().optional(),
  isActive: z.string().trim().optional(),
});

export async function upsertReminderRuleAction(formData: FormData): Promise<void> {
  try {
    const session = await requireReminderOperator("insert");
    const parsed = parseOrThrow(ruleFormSchema, formObject(formData), "Hatırlatma kuralı formu");
    const minAmountRaw = parsed.minAmount ? Number(parsed.minAmount) : null;
    const minAmount = minAmountRaw != null && Number.isFinite(minAmountRaw) ? minAmountRaw : null;
    const activeEntries = formData.getAll("isActive").map((v) => String(v));
    const isActive =
      activeEntries.length === 0
        ? true
        : activeEntries.includes("on") || activeEntries.includes("true");

    await upsertReminderRule(
      getPool(),
      {
        id: parsed.id || null,
        name: parsed.name,
        targetKind: parsed.targetKind,
        offsetDays: parsed.offsetDays,
        channel: parsed.channel,
        minAmount,
        isActive,
      },
      session.id,
    );
  } catch (e) {
    fail(e);
  }
  revalidatePath(PAGE);
  redirect(`${PAGE}?result=${encodeURIComponent("Hatırlatma kuralı kaydedildi.")}`);
}

const toggleRuleFormSchema = z.object({
  id: z.string().uuid("Geçerli kural kimliği gerekli"),
  nextActive: z.string().trim().optional(),
});

export async function toggleReminderRuleAction(formData: FormData): Promise<void> {
  const session = await requireReminderOperator("update").catch((e) => fail(e));
  let nextState = true;
  try {
    const parsed = parseOrThrow(toggleRuleFormSchema, formObject(formData), "Kural durum değiştirme");
    const desired =
      parsed.nextActive === "true" ? true : parsed.nextActive === "false" ? false : undefined;
    const res = await toggleReminderRule(getPool(), { id: parsed.id, isActive: desired }, session.id);
    nextState = res.isActive;
  } catch (e) {
    fail(e);
  }
  revalidatePath(PAGE);
  redirect(
    `${PAGE}?result=${encodeURIComponent(`Kural durumu güncellendi: ${nextState ? "Aktif" : "Pasif"}.`)}`,
  );
}


