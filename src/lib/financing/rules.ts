// Financing domain rules (Phase 5). Pure & deterministic —
// sources: docs/calculation-rules.md §Loan/§Checks + .claude/skills/mas-loan-check-analyst.
// Invariants: null amount stays null (never zero); validators FLAG, never fix.

import { decimal, money, ratioOrNull, zero, type Decimal } from "@/lib/money";
import { addMonths, dueDateFor, monthStartOf } from "@/lib/radar/rules";

/* ── signed amount semantics (calculation-rules §Checks) ── */

export type CheckDirection = "inflow" | "outflow" | "unknown";

/**
 * direction = signed < 0 ? outflow : inflow; amount = |signed|.
 * null stays null/unknown; explicit 0 keeps amount 0 but carries no direction.
 */
export function signedToDirection(signed: number | null): {
  direction: CheckDirection;
  amount: number | null;
} {
  if (signed == null) return { direction: "unknown", amount: null };
  if (signed < 0) return { direction: "outflow", amount: Math.abs(signed) };
  if (signed > 0) return { direction: "inflow", amount: signed };
  return { direction: "unknown", amount: 0 };
}

/* ── maturity calendar (checks + loan installments share one shape) ── */

export interface MaturityItem {
  id: string;
  dueDate: string; // ISO date
  amount: number | null; // absolute value; null = unknown
  direction: CheckDirection;
  kind: "check" | "loan_installment";
  label: string;
}

export interface MaturityBucket {
  key: string; // '2026-W28' (week) | '2026-07' (month)
  from: string;
  to: string; // inclusive range
  count: number;
  knownOutflow: number;
  knownInflow: number;
  missingCount: number; // unknown amounts — counted & disclosed, never summed as 0
  unknownDirectionCount: number;
  items: MaturityItem[];
}

export function addDaysISO(iso: string, days: number): string {
  const d = new Date(iso + "T00:00:00Z");
  return new Date(d.getTime() + days * 86400000).toISOString().slice(0, 10);
}

/** ISO-8601 week of a date-only ISO string (dates are already Europe/Istanbul-local). */
export function isoWeekOf(iso: string): { key: string; from: string; to: string } {
  const d = new Date(iso + "T00:00:00Z");
  const mondayOffset = (d.getUTCDay() + 6) % 7; // Mon=0..Sun=6
  const monday = new Date(d.getTime() - mondayOffset * 86400000);
  const thursday = new Date(monday.getTime() + 3 * 86400000);
  const isoYear = thursday.getUTCFullYear();
  const week = Math.ceil(((thursday.getTime() - Date.UTC(isoYear, 0, 1)) / 86400000 + 1) / 7);
  return {
    key: `${isoYear}-W${String(week).padStart(2, "0")}`,
    from: monday.toISOString().slice(0, 10),
    to: new Date(monday.getTime() + 6 * 86400000).toISOString().slice(0, 10),
  };
}

/**
 * QA-F2: toplamlar ondalık birikir, yayımlanan tip değişmez.
 *
 * Buradaki `knownOutflow`/`knownInflow` yalnız GÖSTERİLEN toplamlardır — hiçbir eşik
 * karşılaştırması bunlara dayanmaz (kardeş `exposureBy`'ın aksine, orada `ratio > flagRatio`
 * cevabı çevirebiliyordu). Yine de `+=` float birikimini ondalığa çevirdik: gösterilen rakam
 * ile Postgres `sum()` arasında kuruş altı bir fark bırakmanın savunulur bir gerekçesi yok.
 */
export function groupMaturities(
  items: MaturityItem[],
  granularity: "week" | "month",
): MaturityBucket[] {
  const map = new Map<string, MaturityBucket>();
  const sums = new Map<string, { out: Decimal; inn: Decimal }>();
  for (const it of [...items].sort((a, b) => (a.dueDate < b.dueDate ? -1 : 1))) {
    const g =
      granularity === "week"
        ? isoWeekOf(it.dueDate)
        : {
            key: it.dueDate.slice(0, 7),
            from: monthStartOf(it.dueDate),
            to: dueDateFor(monthStartOf(it.dueDate), 31).dueDate,
          };
    let b = map.get(g.key);
    if (!b) {
      b = {
        key: g.key, from: g.from, to: g.to,
        count: 0, knownOutflow: 0, knownInflow: 0,
        missingCount: 0, unknownDirectionCount: 0, items: [],
      };
      map.set(g.key, b);
      sums.set(g.key, { out: zero(), inn: zero() });
    }
    const s = sums.get(g.key)!;
    b.count++;
    b.items.push(it);
    if (it.amount == null) b.missingCount++;
    else if (it.direction === "outflow") s.out = s.out.plus(decimal(it.amount));
    else if (it.direction === "inflow") s.inn = s.inn.plus(decimal(it.amount));
    else b.unknownDirectionCount++;
  }
  for (const [key, b] of map) {
    const s = sums.get(key)!;
    b.knownOutflow = money(s.out);
    b.knownInflow = money(s.inn);
  }
  return [...map.values()].sort((a, b) => (a.from < b.from ? -1 : 1));
}

export interface MaturityWindow {
  days: number;
  from: string;
  toExclusive: string;
  count: number;
  knownOutflow: number;
  knownInflow: number;
  missingCount: number;
}

/**
 * Forward-looking windows [today, today+days). Overdue items are NOT window members.
 *
 * QA-F2: `groupMaturities` ile aynı gerekçe — pencere toplamları GÖSTERİM içindir, hiçbir
 * eşiği tetiklemez, ama yine de ondalık birikir ki ekrandaki rakam veritabanının toplamıyla
 * kuruşu kuruşuna aynı olsun.
 */
export function maturityWindows(
  items: MaturityItem[],
  todayISO: string,
  windows: number[] = [7, 14, 30],
): MaturityWindow[] {
  return windows.map((days) => {
    const toExclusive = addDaysISO(todayISO, days);
    const win = items.filter((i) => i.dueDate >= todayISO && i.dueDate < toExclusive);
    let outflow = zero(), inflow = zero(), missingCount = 0;
    for (const i of win) {
      if (i.amount == null) missingCount++;
      else if (i.direction === "outflow") outflow = outflow.plus(decimal(i.amount));
      else if (i.direction === "inflow") inflow = inflow.plus(decimal(i.amount));
    }
    return {
      days, from: todayISO, toExclusive, count: win.length,
      knownOutflow: money(outflow), knownInflow: money(inflow), missingCount,
    };
  });
}

/* ── bank / counterparty exposure (calculation-rules threshold 0.40) ── */

export interface ExposureEntry {
  key: string;
  outflowSum: number;
  inflowSum: number;
  total: number; // |amount| both directions
  ratio: number; // total / knownTotal
  flagged: boolean;
}

/**
 * QA-F2: birikim tam, yayımlanan şekil değişmedi.
 *
 * Bu fonksiyon `radar/rules.ts`'teki `concentration()` ile AYNI algoritmayı aynı 0,40 eşiğiyle
 * koşturur; ikisinden yalnız biri (concentration) Faz 17'de ondalığa çevrilmişti, bu ise
 * float `+=` ve float bölme üzerinde kalmıştı. Tek bir eşik karşılaştırması — `e.ratio >
 * flagRatio` — bir yuvarlama hatasının GÖSTERİLEN bir haneyi değil, CEVABIN KENDİSİNİ
 * çevirebildiği yerdir: ölçülen örnek, kuruşu kuruşuna 400.000,00 eden üç satırın float ile
 * 400.000,00000000006 vermesi ve 1.000.000,00 bilinen toplam karşısında oranı 0,4000000000000001
 * yapıp tam sınırdaki bir bankayı HAKSIZ YERE bayraklamasıdır. Ondalık birikimle oran tam 0,4
 * çıkar ve karşılaştırma `>` olduğu için sınırdaki kayıt bayraklanmaz.
 *
 * Çağıranlar ve testler yine düz sayı alır — sınır tipleri kımıldamadı; `concentration()`
 * bunu nasıl yaptıysa aynen öyle.
 */
export function exposureBy(
  items: Array<{ key: string | null; amount: number | null; direction: CheckDirection }>,
  flagRatio = 0.4,
): { entries: ExposureEntry[]; knownTotal: number; unknownCount: number } {
  const acc = new Map<string, { out: Decimal; inn: Decimal }>();
  let knownTotal = zero();
  let unknownCount = 0;
  for (const it of items) {
    if (it.amount == null) {
      unknownCount++;
      continue;
    }
    // maruziyet iki yönü de mutlak değeriyle sayar (işaretli tutar semantiği yukarıda);
    // açık sıfır ise hiçbir yoğunlaşmaya katkı vermez.
    const v = decimal(it.amount).abs();
    if (v.eq(0)) continue;
    knownTotal = knownTotal.plus(v);
    const k = it.key ?? "(atanmadı)";
    const e = acc.get(k) ?? { out: zero(), inn: zero() };
    if (it.direction === "outflow") e.out = e.out.plus(v);
    else if (it.direction === "inflow") e.inn = e.inn.plus(v);
    acc.set(k, e); // yönü bilinmeyen kayıt da anahtarı görünür kılar — gizlenmez
  }
  const entries = [...acc.entries()]
    .map(([key, e]) => {
      const total = e.out.plus(e.inn);
      return {
        key,
        outflowSum: money(e.out),
        inflowSum: money(e.inn),
        total: money(total),
        // ratioOrNull payda bilinmiyorsa null döner; "bilinen toplam yok" ile "%0 yoğunlaşma"
        // aynı cümle değildir, ama yayımlanan şekil sayı olduğu için null burada — sözleşmeyi
        // değiştirmemek adına — eskisi gibi 0'a çöker.
        ratio: ratioOrNull(total, knownTotal) ?? 0,
        flagged: false,
      };
    })
    .sort((a, b) => b.total - a.total)
    .map((e) => ({ ...e, flagged: e.ratio > flagRatio }));
  return { entries, knownTotal: money(knownTotal), unknownCount };
}

/* ── loan installment schedule (derived due dates; amounts always from source) ── */

export interface ScheduledInstallment {
  no: number;
  dueDate: string;
  shortMonthAdjusted: boolean;
}

/**
 * Source sheet has NO per-row dates; due dates derive deterministically from
 * first_payment_date + (no−1) months on the same day (short months clamp — dueDateFor).
 */
export function scheduleDueDates(firstPaymentISO: string, count: number): ScheduledInstallment[] {
  const day = Number(firstPaymentISO.slice(8, 10));
  const m0 = monthStartOf(firstPaymentISO);
  return Array.from({ length: count }, (_, i) => {
    const d = dueDateFor(addMonths(m0, i), day);
    return { no: i + 1, dueDate: d.dueDate, shortMonthAdjusted: d.shortMonthAdjusted };
  });
}

/* ── loan reconciliation (calculation-rules §Loan; ±1 TL) — FLAGS ONLY ── */

export interface LoanReconIssue {
  code: "installment_sum_mismatch" | "finance_cost_mismatch" | "missing_totals";
  message: string;
  diff: number | null;
}

/** Σtaksit ≈ toplam ödeme; toplam − anapara ≈ fark. Mismatch is flagged, values NEVER adjusted. */
export function reconcileLoan(input: {
  installmentSum: number | null; // source Σ cell (B12)
  totalPayment: number | null; // B10
  principal: number | null; // B4
  financeCost: number | null; // B11
  toleranceTry?: number;
}): { ok: boolean; issues: LoanReconIssue[] } {
  const tol = input.toleranceTry ?? 1;
  const issues: LoanReconIssue[] = [];
  const missing = (
    [
      ["installmentSum", input.installmentSum],
      ["totalPayment", input.totalPayment],
      ["principal", input.principal],
      ["financeCost", input.financeCost],
    ] as const
  )
    .filter(([, v]) => v == null)
    .map(([k]) => k);
  if (missing.length > 0) {
    issues.push({
      code: "missing_totals",
      message: `Kaynakta eksik mutabakat alanları: ${missing.join(", ")}`,
      diff: null,
    });
  }
  if (input.installmentSum != null && input.totalPayment != null) {
    const diff = input.installmentSum - input.totalPayment;
    if (Math.abs(diff) > tol) {
      issues.push({
        code: "installment_sum_mismatch",
        message: `Σtaksit ${input.installmentSum.toFixed(2)} ≠ toplam ödeme ${input.totalPayment.toFixed(2)} (fark ${diff.toFixed(2)})`,
        diff,
      });
    }
  }
  if (input.totalPayment != null && input.principal != null && input.financeCost != null) {
    const diff = input.totalPayment - input.principal - input.financeCost;
    if (Math.abs(diff) > tol) {
      issues.push({
        code: "finance_cost_mismatch",
        message: `toplam − anapara ≠ fark (sapma ${diff.toFixed(2)})`,
        diff,
      });
    }
  }
  return { ok: issues.length === 0, issues };
}

/* ── debt-service monthly load (checks + installments) ── */

export interface DebtServiceMonth {
  monthStart: string;
  count: number;
  knownOutflow: number;
  knownInflow: number;
  missingCount: number;
}

export function debtServiceByMonth(items: MaturityItem[]): DebtServiceMonth[] {
  return groupMaturities(items, "month").map((b) => ({
    monthStart: b.from,
    count: b.count,
    knownOutflow: b.knownOutflow,
    knownInflow: b.knownInflow,
    missingCount: b.missingCount,
  }));
}
