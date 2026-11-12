// Faz 32 + Faz 46 — CFO briefing rules. Pure, deterministic, no database, no model.
//
// Does not import @/lib/ai.

import { decimal, moneyOrNull, type NumericInput } from "@/lib/money";
import { partitionByCurrency } from "@/lib/currency-policy";
import { formatOvernightDeltaBridgeMd, type OvernightDeltaAttribution } from "./delta-attribution";

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
  /** PHASE 2.2 (#11): TRY-dışı/para birimi bilinmeyen kalemler — toplamda yok. */
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
  cycleExcludingInventory: number | null;
  overnightDelta?: OvernightDeltaAttribution | null;
}

export interface DaySummary {
  knownOutflow: number;
  knownInflow: number;
  /** Rows whose amount is unknown. Counted, never silently treated as 0 (CLAUDE.md). */
  unknownCount: number;
  /** PHASE 2.2 (#11): TRY-dışı/para birimi bilinmeyen satırlar — toplamda YOK, sayılır. */
  foreignCount: number;
}

export function summariseDay(
  rows: Array<{ amount: NumericInput; direction?: string; currency?: string | null }>,
): DaySummary {
  let out = decimal(0);
  let inflow = decimal(0);
  let unknown = 0;
  const { comparable, foreignCount } = partitionByCurrency(rows);
  for (const r of comparable) {
    const amt = moneyOrNull(r.amount);
    if (amt === null) { unknown += 1; continue; }
    if (r.direction === "inflow") inflow = inflow.plus(decimal(amt));
    else out = out.plus(decimal(amt));
  }
  return {
    knownOutflow: Number(out.toFixed(2)),
    knownInflow: Number(inflow.toFixed(2)),
    unknownCount: unknown,
    foreignCount,
  };
}

const tl = (n: number | null): string =>
  n == null ? "—" : new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 0 }).format(n) + " TL";

/**
 * The single most important sentence, chosen deterministically.
 *
 * Faz 46 (Dalga 1 #4): Never emit a green all-clear ("Bugün için kritik bir kalem görünmüyor.")
 * or imply liquidity safety when `liquidityGap7 == null` or `availableCash == null` (e.g. FIN-03
 * unknown opening balance or missing TRY position).
 */
export function headline(f: BriefingFacts): { text: string; tone: "neg" | "warn" | "pos" } {
  if (f.liquidityGap7 != null && f.liquidityGap7 > 0) {
    return { text: `7 gün içinde ${tl(f.liquidityGap7)} likidite açığı var.`, tone: "neg" };
  }
  if (f.criticalControls.length > 0) {
    return { text: `${f.criticalControls.length} kritik kontrol bulgusu açık.`, tone: "neg" };
  }
  if (f.availableCash != null && f.minCashFloor != null && f.availableCash < f.minCashFloor) {
    return { text: `Nakit, ${tl(f.minCashFloor)} tabanının altında.`, tone: "neg" };
  }
  if (f.overdueCount > 0) {
    return { text: `${f.overdueCount} gecikmiş kalem var (${tl(f.overdueKnownOutflow)}).`, tone: "warn" };
  }
  if (f.todayCount > 0) {
    return { text: `Bugün ${f.todayCount} kalem, ${tl(f.todayOutflowKnown)} çıkış.`, tone: "warn" };
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

export function todaysActions(f: BriefingFacts, limit = 5): string[] {
  const a: string[] = [];
  if (f.liquidityGap7 != null && f.liquidityGap7 > 0) {
    a.push(`Likidite açığını kapat: ${tl(f.liquidityGap7)} (7 gün).`);
  } else if (f.liquidityGap7 == null || f.availableCash == null) {
    a.push("7 günlük likidite pozisyonu bilinmiyor (ölçülemez) — kasa/banka açılış bakiyelerini tamamla.");
  }
  for (const c of f.newCriticalAlerts) a.push(`Kritik uyarıyı incele: ${c}`);
  if (f.overdueCount > 0) a.push(`${f.overdueCount} gecikmiş kalemi gözden geçir.`);
  if (f.overduePromises > 0) a.push(`${f.overduePromises} vadesi geçmiş ödeme sözünü ara.`);
  if (f.todayUnknownAmountCount > 0) {
    a.push(`${f.todayUnknownAmountCount} kalemin tutarı eksik — bugünkü çıkış eksik hesaplanıyor.`);
  }
  if (f.todayForeignCurrencyCount > 0) {
    a.push(`${f.todayForeignCurrencyCount} kalem TRY-dışı — bugünkü çıkış toplamında yok, ayrıca değerlendir.`);
  }
  if (f.promisesDueToday > 0) a.push(`Bugün ${f.promisesDueToday} ödeme sözünün vadesi.`);
  return a.slice(0, limit);
}

export function renderBriefing(f: BriefingFacts, options: { masked?: boolean } = {}): string {
  const h = headline(f);
  const lines: string[] = [];
  lines.push(`# CFO Sabah Brifingi — ${f.todayISO}`);
  lines.push("");
  lines.push(`**${h.text}**`);
  lines.push("");
  lines.push("## Nakit");
  lines.push(`- Kullanılabilir nakit: ${tl(f.availableCash)}`);
  lines.push(`- Asgari kasa tabanı: ${tl(f.minCashFloor)}`);
  lines.push(
    `- 7 gün likidite açığı: ${f.liquidityGap7 == null ? "— (bilinmiyor / ölçülemez)" : tl(f.liquidityGap7)}`,
  );
  lines.push(
    `- 30 gün likidite açığı: ${f.liquidityGap30 == null ? "— (bilinmiyor / ölçülemez)" : tl(f.liquidityGap30)}`,
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
  lines.push(`- Bilinen çıkış: ${tl(f.todayOutflowKnown)}`);
  lines.push(`- Bilinen giriş: ${tl(f.todayInflowKnown)}`);
  if (f.todayUnknownAmountCount > 0) {
    lines.push(`- **Tutarı bilinmeyen: ${f.todayUnknownAmountCount} kalem** (toplamlar eksik)`);
  }
  if (f.todayForeignCurrencyCount > 0 || f.overdueForeignCurrencyCount > 0) {
    lines.push(`- **TRY-dışı: bugün ${f.todayForeignCurrencyCount}, gecikmiş ${f.overdueForeignCurrencyCount} kalem** (toplamlarda yok; kur çevrilmez)`);
  }
  lines.push("");
  lines.push("## Gecikmiş");
  lines.push(`- Gecikmiş kalem: ${f.overdueCount} (${tl(f.overdueKnownOutflow)})`);
  lines.push(`- Vadesi geçmiş ödeme sözü: ${f.overduePromises}`);
  lines.push("");
  lines.push("## Kontroller");
  lines.push(`- Kritik kontrol bulgusu: ${f.criticalControls.length}`);
  lines.push(`- Açık uyarı: ${f.openAlertCount}`);
  for (const c of f.criticalControls.slice(0, 5)) lines.push(`  - ${c}`);
  lines.push("");
  lines.push("## İşletme sermayesi");
  lines.push(`- DSO: ${f.dsoDays == null ? "—" : `${f.dsoDays} gün`}`);
  lines.push(`- DPO: ${f.dpoDays == null ? "—" : `${f.dpoDays} gün`}`);
  lines.push(
    `- Nakit döngüsü (envanter hariç): ${f.cycleExcludingInventory == null ? "—" : `${f.cycleExcludingInventory} gün`}`);
  lines.push("");
  const actions = todaysActions(f);
  lines.push("## Bugünün aksiyonları");
  if (actions.length === 0) lines.push("- Bekleyen kritik aksiyon yok.");
  for (const x of actions) lines.push(`- ${x}`);
  return lines.join("\n");
}
