"use server";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { requireActionPermission, requireSession } from "@/lib/auth";
import { can, type AppRole } from "@/lib/authz/matrix";
import { getPool } from "@/lib/db";
import { DomainError } from "@/lib/domain-error";
import {
  dispatchPending,
  ensureDefaultMaturityRules,
  scheduleReminders,
  toggleReminderRule,
  upsertReminderRule,
} from "@/lib/reminders/engine";
import { sendCounterpartyReminder, transportFor } from "@/lib/reminders/transport";
import { istanbulDateISO } from "@/lib/reports/rules";
import { formObject, parseOrThrow } from "@/lib/validation";

const PAGE = "/insights/reminders";

function redirectWithFlash(kind: "result" | "error", message: string): never {
  redirect(`${PAGE}?${kind}=${encodeURIComponent(message)}`);
}

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
  targetKind: z.enum([
    "payment_instance",
    "check",
    "loan_installment",
    "invoice",
    "promise_to_pay",
    "covenant_record",
  ]),
  offsetDays: z.coerce.number().int("Gün farkı tam sayı olmalı").min(-365).max(365),
  channel: z.enum(["telegram", "email"]).default("telegram"),
  minAmount: z.string().trim().optional(),
  isActive: z.union([z.string(), z.array(z.string())]).optional(),
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

const multiChannelDispatchSchema = z.object({
  partyName: z.string().trim().min(1, "Cari / karşı taraf ünvanı zorunludur.").max(200),
  invoiceId: z.string().trim().uuid().optional(),
  invoiceNo: z.string().trim().max(80).optional(),
  dueDate: z.string().trim().max(20).optional(),
  amountFormatted: z.string().trim().max(60).optional(),
  currency: z.string().trim().max(10).optional(),
  email: z.string().trim().max(240).optional(),
  phone: z.string().trim().max(40).optional(),
  whatsappPhone: z.string().trim().max(40).optional(),
  customMessage: z.string().trim().max(1500).optional(),
  channels: z
    .array(z.enum(["telegram", "email", "sms", "whatsapp"]))
    .min(1, "En az bir bildirim kanalı (Telegram, HTML E-posta, SMS veya WhatsApp) seçin."),
});

const CHANNEL_TR: Record<"telegram" | "email" | "sms" | "whatsapp", string> = {
  telegram: "Telegram",
  email: "HTML E-posta",
  sms: "SMS",
  whatsapp: "WhatsApp",
};

export async function sendMultiChannelCounterpartyReminderAction(
  formData: FormData,
): Promise<void> {
  const session = await requireSession();
  if (!can(session.role, "reminders", "update") || !REMINDER_OPERATORS.includes(session.role)) {
    redirectWithFlash(
      "error",
      "Çok kanallı hatırlatma gönderimi için finans operatörü veya yönetici yetkisi gerekir.",
    );
  }

  const f = formObject(formData);
  const str = (v: string | string[] | undefined) =>
    (Array.isArray(v) ? (v[0] ?? "") : (v ?? "")).trim();
  const rawChannels = formData.getAll("channels").map((v) => String(v).trim());
  const rawInvoiceId = str(f.invoiceId);

  const parsed = multiChannelDispatchSchema.safeParse({
    partyName: str(f.partyName),
    invoiceId: rawInvoiceId.length > 0 ? rawInvoiceId : undefined,
    invoiceNo: str(f.invoiceNo) || undefined,
    dueDate: str(f.dueDate) || undefined,
    amountFormatted: str(f.amountFormatted) || undefined,
    currency: str(f.currency) || undefined,
    email: str(f.email) || undefined,
    phone: str(f.phone) || undefined,
    whatsappPhone: str(f.whatsappPhone) || undefined,
    customMessage: str(f.customMessage) || undefined,
    channels: rawChannels,
  });

  if (!parsed.success) {
    redirectWithFlash(
      "error",
      parsed.error.issues[0]?.message ?? "Çok kanallı hatırlatma alanlarını kontrol edin.",
    );
  }

  const data = parsed.data;
  const channelSummaries: string[] = [];
  const auditStatuses: Record<string, string> = {};

  if (data.channels.includes("telegram")) {
    const tgParts = [
      `MAS Nakit Radar · Vade Hatırlatma`,
      `Cari: ${data.partyName}`,
      data.invoiceNo ? `Belge: ${data.invoiceNo}` : null,
      data.dueDate ? `Vade: ${data.dueDate}` : null,
      data.amountFormatted
        ? `Tutar: ${data.amountFormatted}${data.currency ? ` ${data.currency}` : ""}`
        : null,
      data.customMessage ? `Not: ${data.customMessage}` : null,
    ].filter(Boolean);
    const tgRes = await transportFor("telegram").send(tgParts.join("\n"));
    auditStatuses.telegram = tgRes.ok
      ? "sent"
      : tgRes.skippedUnconfigured
        ? "skipped_unconfigured"
        : `failed:${tgRes.error ?? "error"}`;
    channelSummaries.push(
      `${CHANNEL_TR.telegram}: ${
        tgRes.ok
          ? "gönderildi"
          : tgRes.skippedUnconfigured
            ? "yapılandırılmadı (atlandı)"
            : `hata (${tgRes.error ?? "iletim hatası"})`
      }`,
    );
  }

  const externalChannels = data.channels.filter(
    (ch): ch is "email" | "sms" | "whatsapp" => ch !== "telegram",
  );

  if (externalChannels.length > 0) {
    const outcome = await sendCounterpartyReminder({
      partyName: data.partyName,
      email: data.email ?? null,
      phone: data.phone ?? null,
      whatsappPhone: data.whatsappPhone ?? data.phone ?? null,
      invoiceNo: data.invoiceNo ?? null,
      dueDate: data.dueDate ?? null,
      amountFormatted: data.amountFormatted ?? null,
      currency: data.currency ?? null,
      customMessage: data.customMessage ?? null,
      channels: externalChannels,
    });

    for (const ch of externalChannels) {
      const res = outcome.results[ch];
      auditStatuses[ch] = res?.ok
        ? "sent"
        : res?.skippedUnconfigured
          ? "skipped_unconfigured"
          : `failed:${res?.error ?? "error"}`;
      channelSummaries.push(
        `${CHANNEL_TR[ch]}: ${
          res?.ok
            ? "gönderildi"
            : res?.skippedUnconfigured
              ? "yapılandırılmadı (atlandı)"
              : `hata (${res?.error ?? "iletim hatası"})`
        }`,
      );
    }
  }

  const pool = getPool();
  await audit(pool, {
    actor: session.id,
    action: "dispatch_multichannel_counterparty_reminder",
    entityTable: data.invoiceId ? "invoices" : "reminders",
    entityId: data.invoiceId ?? null,
    after: {
      partyName: data.partyName,
      invoiceNo: data.invoiceNo ?? null,
      dueDate: data.dueDate ?? null,
      channels: data.channels,
      statuses: auditStatuses,
    },
  });

  revalidatePath(PAGE);
  redirectWithFlash(
    "result",
    `Çok kanallı hatırlatma (${data.partyName}): ${channelSummaries.join(" · ")}`,
  );
}


