"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireActionPermission } from "@/lib/auth";
import {
  isPgPeriodLockedError,
  PERIOD_LOCKED_USER_MESSAGE,
  translatePeriodLockError,
} from "@/lib/cashflow/period-lock";
import { getPool } from "@/lib/db";
import { DomainError } from "@/lib/domain-error";
import {
  closeFxPosition,
  createFxPosition,
  runPeriodEndVuk280Revaluation,
} from "@/lib/financing/fx-ops";
import { recordRate } from "@/lib/fx/engine";

const PAGE = "/finance/fx";

function redirectWithFxError(e: unknown): never {
  if (isPgPeriodLockedError(e)) {
    revalidatePath(PAGE);
    redirect(`${PAGE}?error=${encodeURIComponent(PERIOD_LOCKED_USER_MESSAGE)}`);
  }
  try {
    translatePeriodLockError(e);
  } catch (translated) {
    if (translated instanceof DomainError) {
      revalidatePath(PAGE);
      redirect(`${PAGE}?error=${encodeURIComponent(translated.message)}`);
    }
    throw translated;
  }
}

function revalidateFxSurfaces(): void {
  revalidatePath(PAGE);
  revalidatePath("/finance");
  revalidatePath("/finance/treasury");
  revalidatePath("/finance/exposure");
  revalidatePath("/finance/ledger");
}

export async function recordRateAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("fx_rate_snapshots", "insert", PAGE);
  const rate = Number(formData.get("rate"));
  try {
    await recordRate(
      getPool(),
      {
        baseCurrency: String(formData.get("baseCurrency") ?? "").trim().toUpperCase(),
        quoteCurrency: "TRY",
        rateDate: String(formData.get("rateDate") ?? ""),
        rate: Number.isFinite(rate) ? rate : 0,
        source: String(formData.get("source") ?? "manual"),
        sourceRef: "elle girildi",
      },
      session.id,
    );
  } catch (e) {
    redirectWithFxError(e);
  }
  revalidateFxSurfaces();
  redirect(`${PAGE}?result=${encodeURIComponent("Döviz kuru kaydedildi.")}`);
}

export async function createFxPositionAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("fx_positions", "insert", PAGE);
  const entryRateRaw = String(formData.get("entryRate") ?? "").trim();
  const entryRate = entryRateRaw ? Number(entryRateRaw) : null;
  const partyRaw = String(formData.get("counterpartyPartyId") ?? "").trim();
  try {
    await createFxPosition(
      getPool(),
      {
        currency: String(formData.get("currency") ?? "").trim().toUpperCase(),
        direction: String(formData.get("direction") ?? "long") === "short" ? "short" : "long",
        amount: Number(formData.get("amount")),
        instrumentSubtype: (String(formData.get("instrumentSubtype") ?? "forward") || "forward") as
          | "forward"
          | "option"
          | "swap"
          | "manual",
        asOfDate: String(formData.get("asOfDate") ?? "").trim(),
        entryRate: entryRate != null && Number.isFinite(entryRate) ? entryRate : null,
        counterpartyPartyId: partyRaw || null,
        sourceNote: String(formData.get("sourceNote") ?? "").trim() || undefined,
      },
      session.id,
    );
  } catch (e) {
    redirectWithFxError(e);
  }
  revalidateFxSurfaces();
  redirect(`${PAGE}?result=${encodeURIComponent("Forward / döviz hedge pozisyonu eklendi.")}`);
}

export async function closeFxPositionAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("fx_positions", "update", PAGE);
  const positionId = String(formData.get("positionId") ?? "").trim();
  try {
    await closeFxPosition(getPool(), positionId, session.id);
  } catch (e) {
    redirectWithFxError(e);
  }
  revalidateFxSurfaces();
  redirect(`${PAGE}?result=${encodeURIComponent("Döviz hedge pozisyonu kapatıldı.")}`);
}

export async function runPeriodEndVuk280RevaluationAction(formData: FormData): Promise<void> {
  const session = await requireActionPermission("management_journal_entries", "insert", PAGE);
  let msg = "";
  try {
    const res = await runPeriodEndVuk280Revaluation(
      getPool(),
      {
        asOfDate: String(formData.get("asOfDate") ?? "").trim(),
      },
      session.id,
    );
    msg =
      res.adjustedLinesCount > 0
        ? `VUK 280 dönem sonu kur değerleme fişi oluşturuldu (${res.adjustedLinesCount} hesap · 646 Kâr: ${res.totalGainTry.toFixed(2)} TL · 656 Zarar: ${res.totalLossTry.toFixed(2)} TL).`
        : `Seçilen tarihte (${res.asOfDate}) değerleme farkı oluşan parasal döviz bakiyesi bulunmadı (${res.revaluedProvisionalCount} geçici fiş kesinleştirildi).`;
  } catch (e) {
    redirectWithFxError(e);
  }
  revalidateFxSurfaces();
  redirect(`${PAGE}?result=${encodeURIComponent(msg)}`);
}
