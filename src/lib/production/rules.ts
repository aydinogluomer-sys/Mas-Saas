// Production capacity & cost rules (Phase 7). Pure & deterministic — sources:
// docs/calculation-rules.md §Capacity/cost + .claude/skills/mas-cost-capacity-analyst.
// ANALYTICS ONLY: outputs are planning estimates, never accounting truth. null stays
// null (never 0); stale rates and missing operation time are FLAGGED, never fixed.

/** Effective monthly minutes = machines × per-machine monthly minutes × efficiency.
 *  Any null input ⇒ null (unknown capacity, never silently 0). */
export function effectiveMinutes(
  machineCount: number | null,
  monthlyMinutesPerMachine: number | null,
  efficiency: number | null,
): number | null {
  if (machineCount == null || monthlyMinutesPerMachine == null || efficiency == null) return null;
  return machineCount * monthlyMinutesPerMachine * efficiency;
}

/** Utilization = demanded minutes ÷ effective capacity minutes. */
export function utilizationRate(demandMinutes: number | null, effMinutes: number | null): number | null {
  if (demandMinutes == null || effMinutes == null || effMinutes === 0) return null;
  return demandMinutes / effMinutes;
}

/** Break-even TL/dk = allocated monthly fixed cost ÷ effective monthly minutes. */
export function breakEvenTLPerMin(monthlyCost: number | null, effMinutes: number | null): number | null {
  if (monthlyCost == null || effMinutes == null || effMinutes === 0) return null;
  return monthlyCost / effMinutes;
}

/** Capacity gap = effective − demanded minutes (positive ⇒ idle, negative ⇒ over-committed). */
export function capacityGap(effMinutes: number | null, demandMinutes: number | null): number | null {
  if (effMinutes == null || demandMinutes == null) return null;
  return effMinutes - demandMinutes;
}

/** Theoretical monthly revenue = effective minutes × blended TL/dk (source-computed rate). */
export function theoreticalRevenue(effMinutes: number | null, tlPerMin: number | null): number | null {
  if (effMinutes == null || tlPerMin == null) return null;
  return effMinutes * tlPerMin;
}

/* ── normal vs overtime/mesaili comparison ── */

export interface ScenarioModel {
  scenario: "normal" | "overtime";
  effMinutes: number | null;
  monthlyCost: number | null;
  breakEvenTLPerMin: number | null;
  efficiency: number | null;
}

export interface ScenarioComparison {
  minutesDelta: number | null; // overtime − normal effective minutes
  costDelta: number | null; // overtime − normal monthly cost
  breakEvenDelta: number | null; // overtime − normal break-even TL/dk
  verdict: "mesaili_iyilestiriyor" | "mesaili_kotulestiriyor" | "belirsiz";
}

/**
 * Compares overtime against normal on the same part mix. Verdict is by break-even:
 * a LOWER overtime TL/dk means overtime lowers unit cost (improves); higher = worsens.
 * Any unknown side ⇒ 'belirsiz' (honest, never guessed).
 */
export function compareScenarios(normal: ScenarioModel, overtime: ScenarioModel): ScenarioComparison {
  const minutesDelta = normal.effMinutes != null && overtime.effMinutes != null ? overtime.effMinutes - normal.effMinutes : null;
  const costDelta = normal.monthlyCost != null && overtime.monthlyCost != null ? overtime.monthlyCost - normal.monthlyCost : null;
  const breakEvenDelta =
    normal.breakEvenTLPerMin != null && overtime.breakEvenTLPerMin != null
      ? overtime.breakEvenTLPerMin - normal.breakEvenTLPerMin
      : null;
  let verdict: ScenarioComparison["verdict"] = "belirsiz";
  if (breakEvenDelta != null) verdict = breakEvenDelta < 0 ? "mesaili_iyilestiriyor" : breakEvenDelta > 0 ? "mesaili_kotulestiriyor" : "belirsiz";
  return { minutesDelta, costDelta, breakEvenDelta, verdict };
}

/* ── part profitability ── */

export interface PartInput {
  code: string | null;
  name: string;
  quantity: number | null;
  tornaMinutesPerUnit: number | null;
  frezeMinutesPerUnit: number | null;
  revenue: number | null; // source FİYAT (total for the qty)
}

export interface PartProfitability {
  tornaTotalMinutes: number | null;
  frezeTotalMinutes: number | null;
  estimatedTornaCost: number | null;
  estimatedFrezeCost: number | null;
  estimatedTotalCost: number | null;
  estimatedRevenue: number | null;
  estimatedMargin: number | null;
  marginRate: number | null;
  missingOperationTime: boolean;
  confidence: "estimated" | "needs_review";
}

/**
 * Part cost = total operation minutes × break-even TL/dk (per operation rate).
 * Missing BOTH torna and freze time ⇒ flagged + confidence needs_review; the row is
 * still produced (traceable), amounts stay null where source is null.
 */
export function partProfitability(
  part: PartInput,
  tornaTLPerMin: number | null,
  frezeTLPerMin: number | null,
): PartProfitability {
  const qty = part.quantity ?? null;
  const tornaTotal = part.tornaMinutesPerUnit != null && qty != null ? part.tornaMinutesPerUnit * qty : null;
  const frezeTotal = part.frezeMinutesPerUnit != null && qty != null ? part.frezeMinutesPerUnit * qty : null;
  const tornaCost = tornaTotal != null && tornaTLPerMin != null ? tornaTotal * tornaTLPerMin : null;
  const frezeCost = frezeTotal != null && frezeTLPerMin != null ? frezeTotal * frezeTLPerMin : null;
  const totalCost =
    tornaCost == null && frezeCost == null ? null : (tornaCost ?? 0) + (frezeCost ?? 0);
  const revenue = part.revenue;
  const margin = totalCost != null && revenue != null ? revenue - totalCost : null;
  const marginRate = margin != null && revenue != null && revenue !== 0 ? margin / revenue : null;
  const missingOperationTime = part.tornaMinutesPerUnit == null && part.frezeMinutesPerUnit == null;
  return {
    tornaTotalMinutes: tornaTotal,
    frezeTotalMinutes: frezeTotal,
    estimatedTornaCost: tornaCost,
    estimatedFrezeCost: frezeCost,
    estimatedTotalCost: totalCost,
    estimatedRevenue: revenue,
    estimatedMargin: margin,
    marginRate,
    missingOperationTime,
    confidence: missingOperationTime ? "needs_review" : "estimated",
  };
}

/* ── machine ROI (always needs_review until a human confirms) ── */

export interface RoiInput {
  revenue: number | null;
  cost: number | null;
  tax: number | null;
}
export interface RoiSnapshot {
  remaining: number | null;
  netAfterTax: number | null;
  confidence: "needs_review";
}

/** ROI is never trusted automatically (source `tablo` mixes personal/company data). */
export function machineRoi(input: RoiInput): RoiSnapshot {
  const remaining = input.revenue != null && input.cost != null ? input.revenue - input.cost : null;
  const netAfterTax = remaining != null && input.tax != null ? remaining - input.tax : remaining;
  return { remaining, netAfterTax, confidence: "needs_review" };
}

/* ── theoretical vs actual revenue gap (capacity revenue vs cashflow income) ── */

export function revenueGap(theoretical: number | null, actual: number | null): {
  gap: number | null;
  ratio: number | null;
  flagged: boolean;
} {
  if (theoretical == null || actual == null) return { gap: null, ratio: null, flagged: false };
  const gap = theoretical - actual;
  const ratio = theoretical !== 0 ? actual / theoretical : null;
  // flag when actual realises less than 60% of theoretical capacity revenue
  return { gap, ratio, flagged: ratio != null && ratio < 0.6 };
}

/* ── deterministic insight text (NOT AI; never mutates) ── */

export interface InsightInput {
  utilization: number | null;
  comparison: ScenarioComparison | null;
  revenueGapRatio: number | null;
  isStaleRate: boolean;
  missingPartCount: number;
  totalPartCount: number;
}

export function buildInsights(i: InsightInput): string[] {
  const out: string[] = [];
  if (i.utilization != null && i.utilization > 1)
    out.push(`Talep kapasiteyi aşıyor (kullanım %${(i.utilization * 100).toFixed(0)}) — mesai/ek vardiya gerekli.`);
  else if (i.utilization != null && i.utilization < 0.6)
    out.push(`Kapasite kullanım açığı yüksek (kullanım %${(i.utilization * 100).toFixed(0)}).`);
  if (i.comparison?.verdict === "mesaili_iyilestiriyor")
    out.push("Mesaili model birim maliyeti azaltıyor (başabaş TL/dk düşüyor).");
  else if (i.comparison?.verdict === "mesaili_kotulestiriyor")
    out.push("Mesaili model birim maliyeti artırıyor (başabaş TL/dk yükseliyor).");
  if (i.revenueGapRatio != null && i.revenueGapRatio < 0.6)
    out.push(`Teorik gelir ile gerçekleşen gelir arasında büyük fark var (gerçekleşme %${(i.revenueGapRatio * 100).toFixed(0)}).`);
  if (i.isStaleRate) out.push("Stale-rate risk: kapasite oranları eski tarife (2023) — güncellenene dek tahmin.");
  if (i.totalPartCount > 0 && i.missingPartCount > 0)
    out.push(`Eksik kaynak verisi nedeniyle hesap güveni düşük: ${i.missingPartCount}/${i.totalPartCount} parçada işlem süresi eksik.`);
  if (out.length === 0) out.push("Belirgin kapasite/maliyet uyarısı yok (analitik tahmin).");
  return out;
}
