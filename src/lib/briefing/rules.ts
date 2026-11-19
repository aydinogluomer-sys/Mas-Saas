// Faz 32 + Faz 46 — CFO briefing rules. Pure, deterministic, no database, no model.
//
// Does not import @/lib/ai.

import {
  computeObligationAmounts,
  type MonetaryEpistemicBasis,
  type ReportConfidenceGrade,
} from "@/lib/contracts/remediation-contracts";
import { decimal, moneyOrNull, type NumericInput } from "@/lib/money";
import { partitionByCurrency } from "@/lib/currency-policy";
import { formatOvernightDeltaBridgeMd, type OvernightDeltaAttribution } from "./delta-attribution";

export interface BriefingCurrencyPosition {
  currency: string;
  availableNow: number | null;
  rateToTry: number | null;
  tryEquivalent: number | null;
}

export interface BriefingProvenance {
  snapshotId: string;
  asOfDate: string;
  asOfAt: string;
  schemaVersion: string | null;
  migrationCount?: number | null;
  lastWorkbookImportAt: string | null;
  lastWorkbookFilename?: string | null;
  workbookStaleDays: number | null;
  lastBankTxAt: string | null;
  contentSha256: string;
  calculationVersion?: string;
  sourceFreshnessDays?: number | null;
  monetaryBasisByMetric?: Readonly<Record<string, MonetaryEpistemicBasis>>;
  missingMaterialInputs?: readonly string[];
  reconciliationAligned?: boolean;
  controlAlertsOpenCount?: number;
  confidenceGrade?: ReportConfidenceGrade;
}

export interface BriefingFacts {
  todayISO: string;
  availableCash: number | null;
  minCashFloor: number | null;
  liquidityGap7: number | null;
  liquidityGap30: number | null;
  projectedContracted7: number | null;
  todayOutflowKnown: number;
  todayInflowKnown: number;
  todayCount: number;
  todayUnknownAmountCount: number;
  /** PHASE 2.2 (#11): TRY-dışı/para birimi bilinmeyen kalemler — kur yoksa toplamda yok. */
  todayForeignCurrencyCount: number;
  overdueForeignCurrencyCount: number;
  overdueCount: number;
  overdueKnownOutflow: number;
  criticalControls: string[];
  openAlertCount: number;
  newCriticalAlerts: string[];
  promisesDueToday: number;
  overduePromises: number;
  dsoDays: number | null;
  dpoDays: number | null;
  dioDays?: number | null;
  cashConversionCycleDays?: number | null;
  cycleExcludingInventory: number | null;
  overnightDelta?: OvernightDeltaAttribution | null;
  /** Optional workbook forecast closing balance (`FORECAST` — never substituted for `ACTUAL` bank cash). */
  workbookForecastClosingTry?: number | null;
  /** Multi-currency TCMB fx_rate_snapshots consolidation */
  fxRatesAsOf?: string | null;
  consolidatedCashTry?: number | null;
  consolidatedGap7Try?: number | null;
  consolidatedGap30Try?: number | null;
  todayConsolidatedOutflowTry?: number;
  todayConsolidatedInflowTry?: number;
  overdueConsolidatedOutflowTry?: number;
  convertedForeignCount?: number;
  unconvertibleForeignCount?: number;
  currencyPositions?: BriefingCurrencyPosition[];
  provenance?: BriefingProvenance | null;
}

export interface DaySummary {
  knownOutflow: number;
  knownInflow: number;
  /** Rows whose amount is unknown. Counted, never silently treated as 0 (CLAUDE.md). */
  unknownCount: number;
  /** PHASE 2.2 (#11): TRY-dışı/para birimi bilinmeyen satırlar. */
  foreignCount: number;
  /** TCMB kuru ile TL karşılığı hesaplanmış konsolide çıkış/giriş. */
  consolidatedOutflowTry: number;
  consolidatedInflowTry: number;
  convertedForeignCount: number;
  unconvertibleForeignCount: number;
}

export interface SummariseDayRow {
  amount: NumericInput;
  paidAmount?: NumericInput;
  paid_amount?: NumericInput;
  outstandingAmount?: NumericInput;
  remainingAmount?: NumericInput;
  remaining_amount?: NumericInput;
  status?: string;
  direction?: string;
  currency?: string | null;
}

function resolveSummariseRowAmount(r: SummariseDayRow): number | null {
  const explicitRem = moneyOrNull(
    r.outstandingAmount ?? r.remainingAmount ?? r.remaining_amount ?? null,
  );
  if (explicitRem !== null) return explicitRem;
  const orig = moneyOrNull(r.amount);
  if (orig === null) return null;
  const paid = moneyOrNull(r.paidAmount ?? r.paid_amount ?? null);
  if (paid !== null && r.status && r.status.trim().toLowerCase() === "partial") {
    return computeObligationAmounts({
      originalAmount: orig,
      paidAmount: paid,
      status: r.status,
    }).outstandingAmount;
  }
  return orig;
}

export function summariseDay(
  rows: SummariseDayRow[],
  fxRates?: Readonly<Record<string, number>>,
): DaySummary {
  let out = decimal(0);
  let inflow = decimal(0);
  let consOut = decimal(0);
  let consInflow = decimal(0);
  let unknown = 0;
  let convertedForeignCount = 0;
  let unconvertibleForeignCount = 0;
  const { comparable, foreign, foreignCount } = partitionByCurrency(rows);
  for (const r of comparable) {
    const amt = resolveSummariseRowAmount(r);
    if (amt === null) { unknown += 1; continue; }
    if (r.direction === "inflow") {
      inflow = inflow.plus(decimal(amt));
      consInflow = consInflow.plus(decimal(amt));
    } else {
      out = out.plus(decimal(amt));
      consOut = consOut.plus(decimal(amt));
    }
  }
  for (const r of foreign) {
    const amt = resolveSummariseRowAmount(r);
    if (amt === null) { unknown += 1; continue; }
    const ccy = (r.currency ?? "").trim().toUpperCase();
    const rate = ccy && fxRates ? fxRates[ccy] : undefined;
    if (rate != null && rate > 0) {
      const tryAmt = decimal(amt).times(decimal(rate));
      if (r.direction === "inflow") consInflow = consInflow.plus(tryAmt);
      else consOut = consOut.plus(tryAmt);
      convertedForeignCount += 1;
    } else {
      unconvertibleForeignCount += 1;
    }
  }
  return {
    knownOutflow: Number(out.toFixed(2)),
    knownInflow: Number(inflow.toFixed(2)),
    unknownCount: unknown,
    foreignCount,
    consolidatedOutflowTry: Number(consOut.toFixed(2)),
    consolidatedInflowTry: Number(consInflow.toFixed(2)),
    convertedForeignCount,
    unconvertibleForeignCount,
  };
}

const tl = (n: number | null, masked = false): string => {
  if (n == null) return "—";
  if (masked) return n === 0 ? "0 TL" : "[MASKELİ TL]";
  return (
    new Intl.NumberFormat("tr-TR", {
      minimumFractionDigits: 0,
      maximumFractionDigits: 2,
    }).format(n) + " TL"
  );
};

function normalizeCriticalTitle(raw: string): string {
  return raw.trim().toLocaleLowerCase("tr-TR").replace(/\s+/g, " ");
}

/**
 * Merges `criticalControls` (live SQL views) and `newCriticalAlerts` (open alert records),
 * deduplicating normalized titles so every critical finding in `## Kontroller` appears in
 * `## Bugünün aksiyonları`.
 */
export function collectCriticalFindings(
  f: Pick<BriefingFacts, "criticalControls" | "newCriticalAlerts">,
): string[] {
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const raw of [...f.criticalControls, ...f.newCriticalAlerts]) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const key = normalizeCriticalTitle(trimmed);
    if (seen.has(key)) continue;
    const coveredByControl = [...seen].some(
      (existing) =>
        existing !== key &&
        (key.startsWith(`${existing}:`) ||
          key.startsWith(`${existing} —`) ||
          key.startsWith(`${existing} (`)),
    );
    if (coveredByControl) continue;
    seen.add(key);
    merged.push(trimmed);
  }
  return merged;
}

/**
 * The single most important sentence, chosen deterministically.
 *
 * Faz 46 (Dalga 1 #4): Never emit a green all-clear ("Bugün için kritik bir kalem görünmüyor.")
 * or imply liquidity safety when `liquidityGap7 == null` or `availableCash == null` (e.g. FIN-03
 * unknown opening balance or missing TRY position).
 */
export function headline(
  f: BriefingFacts,
  options: { masked?: boolean } = {},
): { text: string; tone: "neg" | "warn" | "pos" } {
  const masked = Boolean(options.masked);
  if (f.liquidityGap7 != null && f.liquidityGap7 > 0) {
    return { text: `7 gün içinde ${tl(f.liquidityGap7, masked)} likidite açığı var.`, tone: "neg" };
  }
  if (f.criticalControls.length > 0) {
    return { text: `${f.criticalControls.length} kritik kontrol bulgusu açık.`, tone: "neg" };
  }
  if (f.availableCash != null && f.minCashFloor != null && f.availableCash < f.minCashFloor) {
    return { text: `Nakit, ${tl(f.minCashFloor, masked)} tabanının altında.`, tone: "neg" };
  }
  if (f.overdueCount > 0) {
    return { text: `${f.overdueCount} gecikmiş kalem var (${tl(f.overdueKnownOutflow, masked)}).`, tone: "warn" };
  }
  if (f.todayCount > 0) {
    return { text: `Bugün ${f.todayCount} kalem, ${tl(f.todayOutflowKnown, masked)} çıkış.`, tone: "warn" };
  }
  if (f.liquidityGap7 == null || f.availableCash == null) {
    return {
      text: "7 günlük likidite açığı hesaplanamadı — likidite pozisyonu bilinmiyor / ölçülemez (açılış bakiyesi eksik).",
      tone: "warn",
    };
  }
  return { text: "Bugün için kritik bir kalem görünmüyor.", tone: "pos" };
}

export function briefingStatus(
  f: Pick<BriefingFacts, "criticalControls" | "liquidityGap7"> & { availableCash?: number | null },
): { text: string; tone: "neg" | "neutral" | "pos" } {
  if (f.criticalControls.length > 0) {
    return { text: `${f.criticalControls.length} kritik kontrol`, tone: "neg" };
  }
  if (f.liquidityGap7 == null || f.availableCash === null) {
    return { text: "likidite bilinmiyor", tone: "neutral" };
  }
  if (f.liquidityGap7 > 0) return { text: "likidite açığı var", tone: "neg" };
  return { text: "kritik bulgu yok", tone: "pos" };
}

export function todaysActions(
  f: BriefingFacts,
  limit = 5,
  options: { masked?: boolean } = {},
): string[] {
  const masked = Boolean(options.masked);
  const a: string[] = [];
  if (f.liquidityGap7 != null && f.liquidityGap7 > 0) {
    a.push(`Likidite açığını kapat: ${tl(f.liquidityGap7, masked)} (7 gün).`);
  } else if (f.liquidityGap7 == null || f.availableCash == null) {
    a.push("7 günlük likidite pozisyonu bilinmiyor (ölçülemez) — kasa/banka açılış bakiyelerini tamamla.");
  }
  for (const c of collectCriticalFindings(f)) {
    a.push(`Kritik uyarıyı incele: ${c}`);
  }
  if (f.overdueCount > 0) a.push(`${f.overdueCount} gecikmiş kalemi gözden geçir.`);
  if (f.overduePromises > 0) a.push(`${f.overduePromises} vadesi geçmiş ödeme sözünü ara.`);
  if (f.todayUnknownAmountCount > 0) {
    a.push(`${f.todayUnknownAmountCount} kalemin tutarı eksik — bugünkü çıkış eksik hesaplanıyor.`);
  }
  if ((f.unconvertibleForeignCount ?? 0) > 0) {
    a.push(`${f.unconvertibleForeignCount} döviz kalemi için TCMB kuru bulunamadı — kur tablosunu yenileyin.`);
  } else if (f.todayForeignCurrencyCount > 0 && f.todayConsolidatedOutflowTry == null) {
    a.push(`${f.todayForeignCurrencyCount} kalem TRY-dışı — bugünkü çıkış toplamında yok, ayrıca değerlendir.`);
  }
  if (f.promisesDueToday > 0) a.push(`Bugün ${f.promisesDueToday} ödeme sözünün vadesi.`);
  return a.slice(0, limit);
}

export function renderBriefing(f: BriefingFacts, options: { masked?: boolean } = {}): string {
  const masked = Boolean(options.masked);
  const h = headline(f, options);
  const cashBasis: MonetaryEpistemicBasis = f.availableCash == null ? "UNKNOWN" : "ACTUAL";
  const lines: string[] = [];
  lines.push(`# CFO Sabah Brifingi — ${f.todayISO}`);
  lines.push("");
  lines.push(`**${h.text}**`);
  lines.push("");
  lines.push("## Nakit");
  lines.push(`- Kullanılabilir nakit: ${tl(f.availableCash, masked)} [${cashBasis}]`);
  if (f.consolidatedCashTry != null && f.consolidatedCashTry !== f.availableCash) {
    lines.push(
      `- Konsolide çok-dövizli nakit (TCMB${f.fxRatesAsOf ? ` ${f.fxRatesAsOf}` : ""}): ${tl(f.consolidatedCashTry, masked)} [ACTUAL]`,
    );
  }
  if (f.workbookForecastClosingTry !== undefined) {
    lines.push(
      `- Çalışma kitabı tahmini kapanış ([FORECAST] — fiili banka kasası değildir): ${tl(f.workbookForecastClosingTry, masked)}`,
    );
  }
  lines.push(`- Asgari kasa tabanı: ${tl(f.minCashFloor, masked)}`);
  lines.push(
    `- 7 gün likidite açığı: ${f.liquidityGap7 == null ? "— (bilinmiyor / ölçülemez) [UNKNOWN]" : `${tl(f.liquidityGap7, masked)} [PLANNED]`}`,
  );
  if (f.consolidatedGap7Try != null && f.consolidatedGap7Try !== f.liquidityGap7) {
    lines.push(`- 7 gün konsolide likidite açığı (TCMB TL karşılığı): ${tl(f.consolidatedGap7Try, masked)} [PLANNED]`);
  }
  lines.push(
    `- 30 gün likidite açığı: ${f.liquidityGap30 == null ? "— (bilinmiyor / ölçülemez) [UNKNOWN]" : `${tl(f.liquidityGap30, masked)} [PLANNED]`}`,
  );
  if (f.availableCash == null || f.liquidityGap7 == null) {
    lines.push("- **Likidite uyarısı: 7 günlük likidite açığı / nakit pozisyonu bilinmiyor (ölçülemez).**");
  }
  lines.push("");
  if (f.overnightDelta) {
    lines.push(formatOvernightDeltaBridgeMd(f.overnightDelta, options));
    lines.push("");
  }
  lines.push("## Bugün");
  lines.push(`- Kalem sayısı: ${f.todayCount}`);
  lines.push(`- Bilinen çıkış: ${tl(f.todayOutflowKnown, masked)} [PLANNED]`);
  if (f.todayConsolidatedOutflowTry != null && f.todayConsolidatedOutflowTry !== f.todayOutflowKnown) {
    lines.push(`- Konsolide çıkış (TCMB kur çevrimli): ${tl(f.todayConsolidatedOutflowTry, masked)} [PLANNED]`);
  }
  lines.push(`- Bilinen giriş: ${tl(f.todayInflowKnown, masked)} [PLANNED]`);
  if (f.todayConsolidatedInflowTry != null && f.todayConsolidatedInflowTry !== f.todayInflowKnown) {
    lines.push(`- Konsolide giriş (TCMB kur çevrimli): ${tl(f.todayConsolidatedInflowTry, masked)} [PLANNED]`);
  }
  if (f.todayUnknownAmountCount > 0) {
    lines.push(`- **Tutarı bilinmeyen: ${f.todayUnknownAmountCount} kalem** (toplamlar eksik)`);
  }
  if (f.todayForeignCurrencyCount > 0 || f.overdueForeignCurrencyCount > 0) {
    if ((f.convertedForeignCount ?? 0) > 0 && (f.unconvertibleForeignCount ?? 0) === 0) {
      lines.push(
        `- Dövizli yükümlülükler: bugün ${f.todayForeignCurrencyCount}, gecikmiş ${f.overdueForeignCurrencyCount} kalem TCMB kuru (${f.fxRatesAsOf ?? "son kur"}) ile konsolide TL karşılığına çevrildi`,
      );
    } else {
      lines.push(`- **TRY-dışı: bugün ${f.todayForeignCurrencyCount}, gecikmiş ${f.overdueForeignCurrencyCount} kalem** (toplamlarda yok; kur çevrilmez)`);
    }
  }
  lines.push("");
  lines.push("## Gecikmiş");
  lines.push(`- Gecikmiş kalem: ${f.overdueCount} (${tl(f.overdueKnownOutflow, masked)}) [PLANNED]`);
  if (f.overdueConsolidatedOutflowTry != null && f.overdueConsolidatedOutflowTry !== f.overdueKnownOutflow) {
    lines.push(`- Gecikmiş konsolide çıkış (TCMB TL karşılığı): ${tl(f.overdueConsolidatedOutflowTry, masked)} [PLANNED]`);
  }
  lines.push(`- Vadesi geçmiş ödeme sözü: ${f.overduePromises}`);
  lines.push("");
  lines.push("## Kontroller");
  lines.push(`- Kritik kontrol bulgusu: ${f.criticalControls.length}`);
  lines.push(`- Açık uyarı: ${f.openAlertCount}`);
  for (const c of f.criticalControls.slice(0, 5)) lines.push(`  - ${c}`);
  lines.push("");
  lines.push("## İşletme sermayesi");
  lines.push(`- DSO: ${f.dsoDays == null ? "—" : `${f.dsoDays} gün`}`);
  if (f.dioDays != null) {
    lines.push(`- DIO: ${f.dioDays} gün`);
  }
  lines.push(`- DPO: ${f.dpoDays == null ? "—" : `${f.dpoDays} gün`}`);
  if (f.cashConversionCycleDays != null) {
    lines.push(`- Tam Nakit Dönüşüm Döngüsü (CCC = DSO + DIO - DPO): ${f.cashConversionCycleDays} gün`);
  }
  lines.push(
    `- Nakit döngüsü (envanter hariç): ${f.cycleExcludingInventory == null ? "—" : `${f.cycleExcludingInventory} gün`}`);
  if (f.provenance) {
    lines.push("");
    lines.push("## Veri kaynağı ve güven derecesi");
    lines.push(
      `- Güven derecesi: ${f.provenance.confidenceGrade ?? (f.availableCash == null ? "UNVERIFIED_CASH_BASIS" : "PARTIAL_MISSING_INPUTS")}`,
    );
    lines.push(
      `- Son çalışma kitabı: ${f.provenance.workbookStaleDays != null ? `${f.provenance.workbookStaleDays} gün eski` : "yok"} · Son banka ekstresi: ${f.provenance.lastBankTxAt ? `${f.provenance.lastBankTxAt} [RECONCILED]` : "yok [UNKNOWN]"}`,
    );
    if (f.provenance.missingMaterialInputs && f.provenance.missingMaterialInputs.length > 0) {
      lines.push(`- Eksik girdiler: ${f.provenance.missingMaterialInputs.join(" · ")}`);
    }
  }
  lines.push("");
  const actionLimit = Math.max(5, 1 + collectCriticalFindings(f).length);
  const actions = todaysActions(f, actionLimit, options);
  lines.push("## Bugünün aksiyonları");
  if (actions.length === 0) lines.push("- Bekleyen kritik aksiyon yok.");
  for (const x of actions) lines.push(`- ${x}`);
  return lines.join("\n");
}

function maskUnmaskedTlAmounts(text: string): string {
  return text.replace(
    /([+-]?)\b(\d{1,3}(?:\.\d{3})*(?:,\d{1,2})?|\d+(?:,\d{1,2})?)\s*TL\b/g,
    (full, sign: string, digits: string) => {
      const normalized = digits.replace(/\./g, "").replace(",", ".");
      const num = Number(normalized);
      if (!Number.isFinite(num) || num === 0) return full;
      return `${sign}[MASKELİ TL]`;
    },
  );
}

/**
 * Formats a CFO briefing as clean plain text for Telegram without raw Markdown (`#`, `##`, `**`)
 * clutter, applying `{ masked: true }` by default so confidential TL balances never leak onto chat.
 */
export function renderBriefingTelegramText(
  source: BriefingFacts | string,
  options: { masked?: boolean } = {},
): string {
  const masked = options.masked ?? true;
  const rawMd = typeof source === "string" ? source : renderBriefing(source, { masked });
  const maskedMd = masked && typeof source === "string" ? maskUnmaskedTlAmounts(rawMd) : rawMd;

  return maskedMd
    .split(/\r?\n/)
    .map((line) => {
      let cleaned = line.replace(/\*\*(.+?)\*\*/g, "$1");
      if (cleaned.startsWith("# ")) {
        cleaned = `${cleaned.slice(2).trim().toLocaleUpperCase("tr-TR")}\n━━━━━━━━━━━━━━━━━━━━`;
      } else if (cleaned.startsWith("### ")) {
        cleaned = `▸ ${cleaned.slice(4).trim()}`;
      } else if (cleaned.startsWith("## ")) {
        cleaned = `▸ ${cleaned.slice(3).trim().toLocaleUpperCase("tr-TR")}`;
      } else if (cleaned.startsWith("  - ")) {
        cleaned = `  ◦ ${cleaned.slice(4)}`;
      } else if (cleaned.startsWith("- ")) {
        cleaned = `• ${cleaned.slice(2)}`;
      }
      return cleaned;
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
