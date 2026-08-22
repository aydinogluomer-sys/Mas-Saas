// Faz 32 — CFO briefing rules. Pure, deterministic, no database, no model.
//
// The briefing's TEXT is assembled here from facts gathered elsewhere. Keeping the rendering pure
// is what lets the gate compare the rendered summary against the same facts the dashboards use:
// if this file could reach the database it could reach a different row, and the "no deviation"
// requirement would become a hope rather than a property.
//
// Does not import @/lib/ai. reports/engine.ts (Faz 6/12) set the boundary — deterministic numbers
// first, commentary strictly afterwards and separately.

import { decimal, moneyOrNull, type NumericInput } from "@/lib/money";

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
}

export interface DaySummary {
  knownOutflow: number;
  knownInflow: number;
  /** Rows whose amount is unknown. Counted, never silently treated as 0 (CLAUDE.md). */
  unknownCount: number;
}

/**
 * Total a day's movements, keeping unknown amounts VISIBLE.
 *
 * A null amount is counted separately rather than added as zero. "Three payments today totalling
 * 40.000 TL" and "three payments today totalling 40.000 TL plus one of unknown size" are different
 * briefings, and only the second is honest when an amount is missing.
 */
export function summariseDay(
  rows: Array<{ amount: NumericInput; direction?: string }>,
): DaySummary {
  let out = decimal(0);
  let inflow = decimal(0);
  let unknown = 0;
  for (const r of rows) {
    const amt = moneyOrNull(r.amount);
    if (amt === null) { unknown += 1; continue; }
    if (r.direction === "inflow") inflow = inflow.plus(decimal(amt));
    else out = out.plus(decimal(amt));
  }
  return {
    knownOutflow: Number(out.toFixed(2)),
    knownInflow: Number(inflow.toFixed(2)),
    unknownCount: unknown,
  };
}

const tl = (n: number | null): string =>
  n == null ? "—" : new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 0 }).format(n) + " TL";

/**
 * The single most important sentence, chosen deterministically.
 *
 * Fixed priority, worst first: a liquidity breach outranks a control failure, which outranks
 * overdue items. No scoring — an operator must be able to predict which line they will see.
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
  return { text: "Bugün için kritik bir kalem görünmüyor.", tone: "pos" };
}

/**
 * Today's actions, deterministic and capped.
 *
 * Only triggered items appear, in a fixed order. The cap exists because a morning briefing with
 * fifteen "urgent" lines is one nobody acts on.
 */
export function todaysActions(f: BriefingFacts, limit = 5): string[] {
  const a: string[] = [];
  if (f.liquidityGap7 != null && f.liquidityGap7 > 0) {
    a.push(`Likidite açığını kapat: ${tl(f.liquidityGap7)} (7 gün).`);
  }
  for (const c of f.newCriticalAlerts) a.push(`Kritik uyarıyı incele: ${c}`);
  if (f.overdueCount > 0) a.push(`${f.overdueCount} gecikmiş kalemi gözden geçir.`);
  if (f.overduePromises > 0) a.push(`${f.overduePromises} vadesi geçmiş ödeme sözünü ara.`);
  if (f.todayUnknownAmountCount > 0) {
    a.push(`${f.todayUnknownAmountCount} kalemin tutarı eksik — bugünkü çıkış eksik hesaplanıyor.`);
  }
  if (f.promisesDueToday > 0) a.push(`Bugün ${f.promisesDueToday} ödeme sözünün vadesi.`);
  return a.slice(0, limit);
}

/**
 * Render the briefing as Markdown.
 *
 * Every figure comes from `facts`; nothing is recomputed here. That is what allows
 * `phase32:verify` to assert the rendered text and the dashboards agree — they are the same
 * numbers, formatted twice.
 */
export function renderBriefing(f: BriefingFacts): string {
  const h = headline(f);
  const lines: string[] = [];
  lines.push(`# CFO Sabah Brifingi — ${f.todayISO}`);
  lines.push("");
  lines.push(`**${h.text}**`);
  lines.push("");
  lines.push("## Nakit");
  lines.push(`- Kullanılabilir nakit: ${tl(f.availableCash)}`);
  lines.push(`- Asgari kasa tabanı: ${tl(f.minCashFloor)}`);
  lines.push(`- 7 gün likidite açığı: ${f.liquidityGap7 == null ? "—" : tl(f.liquidityGap7)}`);
  lines.push(`- 30 gün likidite açığı: ${f.liquidityGap30 == null ? "—" : tl(f.liquidityGap30)}`);
  lines.push("");
  lines.push("## Bugün");
  lines.push(`- Kalem sayısı: ${f.todayCount}`);
  lines.push(`- Bilinen çıkış: ${tl(f.todayOutflowKnown)}`);
  lines.push(`- Bilinen giriş: ${tl(f.todayInflowKnown)}`);
  if (f.todayUnknownAmountCount > 0) {
    // Stated, never folded into the total — an unknown amount is not zero.
    lines.push(`- **Tutarı bilinmeyen: ${f.todayUnknownAmountCount} kalem** (toplamlar eksik)`);
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
