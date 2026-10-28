// Kilit Taşı 6 — Telegram Yönetici Teslimat Botu & İnteraktif Onay (Telegram Executive Delivery Bot & Interactive Approvals)
//
// 1. reports_cfo_briefing / BriefingFacts verilerini mobil ekranlar için optimize edilmiş
//    yönetici brifingine dönüştürür.
// 2. Bekleyen kritik CFO onaylarını (approvals) Telegram Inline Keyboard butonlarına çevirir.
// 3. Telegram 64-byte callback_data kısıtına uygun, HMAC-SHA256 imzalı güvenli onay/red token'ı üretir.
// 4. Webhook callback geldiğinde:
//    - İmzayı doğrular (replay ve yetkisiz müdahale engeli),
//    - Kapalı devre iç kontrol (gatekeeper) filtresinden geçirir,
//    - Kararı `decideApproval` üzerinden maker-checker ile işletir,
//    - Önbelleği (CONTROLS, CFO_BRIEFING, PAYMENTS) temizler ve net mesaj döndürür.

import crypto from "node:crypto";
import type { Pool } from "pg";
import type { BriefingFacts } from "@/lib/briefing/rules";
import { decideApproval, type ApprovalRow } from "@/lib/approvals/engine";
import { DomainError } from "@/lib/domain-error";

export interface TelegramInlineButton {
  text: string;
  callback_data: string;
}

export interface TelegramInlineKeyboard {
  inline_keyboard: TelegramInlineButton[][];
}

export interface TelegramExecutiveMessage {
  text: string;
  parse_mode: "HTML";
  reply_markup?: TelegramInlineKeyboard;
}

export interface CallbackVerificationResult {
  valid: boolean;
  approvalId: string;
  decision: "approved" | "rejected";
}

export interface CallbackExecutionResult {
  ok: boolean;
  message: string;
  approvalId: string;
  decision: "approved" | "rejected";
  isBlockedByControls?: boolean;
}

function formatTRY(amount: number | null): string {
  if (amount == null) return "Bilinmiyor";
  return new Intl.NumberFormat("tr-TR", {
    style: "currency",
    currency: "TRY",
    maximumFractionDigits: 0,
  }).format(amount);
}

/**
 * 64-byte Telegram limitine uygun HMAC-SHA256 imzası üretir (8 karakter hex).
 */
export function generateCallbackSignature(
  approvalId: string,
  decision: "approved" | "rejected",
  secret: string,
): string {
  const hmac = crypto.createHmac("sha256", secret);
  hmac.update(`${approvalId}:${decision}`);
  return hmac.digest("hex").slice(0, 8);
}

/**
 * Telegram callback_data dizesini ve imzasını doğrular.
 * Format: `app:<approvalId>:<a|r>:<sig>` (toplam ~50 karakter <= 64 byte limit)
 */
export function verifyCallbackData(
  callbackData: string,
  secret: string,
): CallbackVerificationResult {
  const parts = callbackData.split(":");
  if (parts.length !== 4 || parts[0] !== "app") {
    return { valid: false, approvalId: "", decision: "rejected" };
  }

  const [, approvalId, decCode, signature] = parts;
  const decision: "approved" | "rejected" = decCode === "a" ? "approved" : "rejected";
  if (decCode !== "a" && decCode !== "r") {
    return { valid: false, approvalId, decision: "rejected" };
  }

  const expectedSig = generateCallbackSignature(approvalId, decision, secret);
  const isValid =
    signature.length === expectedSig.length &&
    crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSig));

  return {
    valid: isValid,
    approvalId,
    decision,
  };
}

/**
 * Bekleyen onaylar için Telegram inline keyboard butonları oluşturur.
 */
export function buildApprovalKeyboard(
  pendingApprovals: ApprovalRow[],
  secret: string,
): TelegramInlineKeyboard {
  const keyboard: TelegramInlineButton[][] = [];

  for (const app of pendingApprovals.slice(0, 3)) {
    const label = app.subjectLabel || app.subjectTable;
    const amountStr = app.amount != null ? ` (${formatTRY(app.amount)})` : "";
    const shortLabel = label.length > 18 ? label.slice(0, 16) + "…" : label;

    const sigApprove = generateCallbackSignature(app.id, "approved", secret);
    const sigReject = generateCallbackSignature(app.id, "rejected", secret);

    keyboard.push([
      {
        text: `✅ Onayla: ${shortLabel}${amountStr}`,
        callback_data: `app:${app.id}:a:${sigApprove}`,
      },
      {
        text: `❌ Reddet`,
        callback_data: `app:${app.id}:r:${sigReject}`,
      },
    ]);
  }

  return { inline_keyboard: keyboard };
}

/**
 * CFO için sabah özet metnini ve interaktif onay butonlarını hazırlar.
 */
export function renderCfoBriefingTelegram(
  facts: BriefingFacts,
  pendingApprovals: ApprovalRow[] = [],
  secret = "mas-radar-default-secret",
): TelegramExecutiveMessage {
  const cashColor = (facts.availableCash ?? 0) >= (facts.minCashFloor ?? 0) ? "🟢" : "🔴";
  const gap7Str = facts.liquidityGap7 != null && facts.liquidityGap7 > 0
    ? `⚠️ 7G Finansman Açığı: <b>${formatTRY(facts.liquidityGap7)}</b>`
    : `✅ 7G Likidite: Fazla / Yeterli`;

  const criticalControlsText = facts.criticalControls.length === 0
    ? "✅ <b>Kritik Alarm Yok</b> (Sistem temiz)"
    : `🚨 <b>${facts.criticalControls.length} Adet Kritik Alarm!</b>\n   • ${facts.criticalControls.slice(0, 3).join("\n   • ")}`;

  const pendingText = pendingApprovals.length > 0
    ? `\n\n📝 <b>Bekleyen CFO Onayları (${pendingApprovals.length} adet):</b>\n` +
      pendingApprovals
        .slice(0, 5)
        .map((a) => `   • ${a.subjectLabel || a.subjectTable}${a.amount != null ? ` (${formatTRY(a.amount)})` : ""}`)
        .join("\n") +
      `\n\nAşağıdaki butonlardan tek tıkla onaylayabilir veya reddedebilirsiniz.`
    : "";

  const text = [
    `<b>📊 MAS NAKİT RADAR — CFO GÜNLÜK BRİFİNGİ</b>`,
    `<i>Tarih: ${facts.todayISO}</i>`,
    ``,
    `<b>💰 Likidite & Kasa Durumu</b>`,
    `${cashColor} Mevcut Nakit (TRY): <b>${formatTRY(facts.availableCash)}</b>`,
    `🎯 Asgari Kasa Tabanı: <b>${formatTRY(facts.minCashFloor)}</b>`,
    `${gap7Str}`,
    ``,
    `<b>⚡ Bugünkü Nakit Akışı</b>`,
    `🔺 Planlanan Çıkış: <b>${formatTRY(facts.todayOutflowKnown)}</b> (${facts.todayCount} işlem)`,
    `🔻 Beklenen Giriş: <b>${formatTRY(facts.todayInflowKnown)}</b>`,
    `⏳ Günü Geçmiş Ödemeler: <b>${formatTRY(facts.overdueKnownOutflow)}</b> (${facts.overdueCount} işlem)`,
    ``,
    `<b>🛡️ Risk & İç Kontrol</b>`,
    `${criticalControlsText}`,
    `🤝 Bugün Vadesi Dolan Ödeme Sözleri: <b>${facts.promisesDueToday}</b> adet`,
    `${pendingText}`,
  ].join("\n");

  const reply_markup = pendingApprovals.length > 0
    ? buildApprovalKeyboard(pendingApprovals, secret)
    : undefined;

  return {
    text,
    parse_mode: "HTML",
    reply_markup,
  };
}

/**
 * Telegram Webhook üzerinden gelen onay/red callback talebini yürütür.
 */
export async function handleTelegramApprovalCallback(
  pool: Pool,
  callbackData: string,
  actorId: string,
  secret: string,
): Promise<CallbackExecutionResult> {
  const verification = verifyCallbackData(callbackData, secret);

  if (!verification.valid) {
    throw new DomainError("Geçersiz veya tahrif edilmiş Telegram onay imzası.");
  }

  const { approvalId, decision } = verification;
  const decisionTr = decision === "approved" ? "onaylandı" : "reddedildi";
  const note = `Telegram CFO Bot üzerinden ${decisionTr}.`;

  try {
    await decideApproval(
      pool,
      {
        approvalId,
        decision,
        note,
      },
      actorId,
    );

    return {
      ok: true,
      approvalId,
      decision,
      message: `✅ İşlem Başarılı: Talep ${decisionTr}.`,
    };
  } catch (err: unknown) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    const isBlocked = errorMsg.includes("İç kontrol alarmı") || errorMsg.includes("blokaj");

    return {
      ok: false,
      approvalId,
      decision,
      isBlockedByControls: isBlocked,
      message: isBlocked
        ? `⛔ ONAY ENGELLENDİ: ${errorMsg}`
        : `❌ Hata: ${errorMsg}`,
    };
  }
}
