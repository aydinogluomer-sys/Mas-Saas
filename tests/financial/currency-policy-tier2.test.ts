// PHASE 2.2 — Tier 2 kapanışı: kullanıcıya gösterilen HER toplam yalnız TRY; TRY-dışı satır
// toplanmaz ama SAYILIR ve ekrana çıkar. Bu dosya, modül modül o sözü kilitler. DB yok.
//
// Kural (src/lib/currency-policy.ts):
//   undefined = alan yok (yapısal TRY) → toplanır · null = bilinmiyor → toplanmaz, sayılır
//   "TRY" → toplanır · "USD"/"EUR"/… → toplanmaz, sayılır
import { describe, expect, it } from "vitest";
import {
  foreignNote, isComparableCurrency, isReportingCurrency, partitionByCurrency, sumKnownReporting,
} from "@/lib/currency-policy";
import { summariseDay } from "@/lib/briefing/rules";
import { buildDailyReport, type ReportInstance } from "@/lib/reports/rules";
import { analyzePaymentPressure, paymentPressureModel } from "@/lib/analytics/models";
import type { InstanceRow } from "@/lib/radar/queries";
import { summarizeAgeing } from "@/lib/receivables/rules";
import { knownPayableTotal, scheduleWithinCash, type PayableItem } from "@/lib/collections/rules";
import { accuracy, weightedNet, weightedNetDetailed } from "@/lib/budget/rules";
import { utilization } from "@/lib/financing/facilities";

describe("currency-policy — tek kaynak", () => {
  it("undefined = yapısal TRY (toplanır); null = bilinmiyor (toplanmaz); USD toplanmaz", () => {
    expect(isComparableCurrency(undefined)).toBe(true);
    expect(isComparableCurrency("TRY")).toBe(true);
    expect(isComparableCurrency(null)).toBe(false);
    expect(isComparableCurrency("USD")).toBe(false);
    expect(isReportingCurrency(undefined)).toBe(false); // açık TRY sorusu: undefined TRY DEĞİL
    const p = partitionByCurrency([{ a: 1 }, { a: 2, currency: "TRY" }, { a: 3, currency: null }, { a: 4, currency: "USD" }]);
    expect(p.comparable.map((x) => x.a)).toEqual([1, 2]);
    expect(p.foreignCount).toBe(2);
  });

  it("sumKnownReporting: null 0 sayılmaz, USD toplanmaz, ondalık birikim yok", () => {
    const k = sumKnownReporting([
      { amount: 0.1, currency: "TRY" }, { amount: 0.2, currency: "TRY" },
      { amount: null, currency: "TRY" }, { amount: 1_000_000, currency: "USD" }, { amount: 5 },
    ], (r) => r.amount);
    expect(k.total).toBe(5.3);          // 0.1 + 0.2 + 5 — float olsaydı 5.300000000000001
    expect(k.missing).toBe(1);
    expect(k.foreignCount).toBe(1);
    expect(k.count).toBe(4);
    expect(foreignNote(k.foreignCount)).toBe("1 kalem TRY-dışı — toplamda yok");
    expect(foreignNote(0)).toBeNull();
  });
});

describe("#11 briefing summariseDay", () => {
  it("USD kalem ne çıkışa ne girişe eklenir; foreignCount=1; null ayrı sayılır", () => {
    const s = summariseDay([
      { amount: 100, direction: "outflow", currency: "TRY" },
      { amount: 999, direction: "outflow", currency: "USD" },
      { amount: null, direction: "outflow", currency: "TRY" },
      { amount: 40, direction: "inflow" }, // alan yok → yapısal TRY
    ]);
    expect(s).toEqual({ knownOutflow: 100, knownInflow: 40, unknownCount: 1, foreignCount: 1 });
  });
});

describe("#10 reports — günlük rapor", () => {
  const inst = (o: Partial<ReportInstance>): ReportInstance => ({
    name: "x", dueDate: "2026-09-14", amount: 100, status: "unpaid", riskLevel: "none", riskReasons: [], ...o,
  });
  it("7 gün toplamı yalnız TRY; USD kalem sayılır ve metne yazılır; kritik eşik USD'ye uygulanmaz", () => {
    const r = buildDailyReport({
      dueSoon: [inst({ amount: 1000, currency: "TRY" }), inst({ amount: 250_000, currency: "USD" }), inst({ amount: null, currency: "TRY" })],
      overdue: [inst({ amount: 50, currency: "EUR", dueDate: "2026-09-01" })],
      maturities: [], criticalThreshold: 100_000,
    }, "2026-09-13");
    expect(r.next7KnownTotal).toBe(1000);
    expect(r.next7MissingCount).toBe(1);
    expect(r.criticalItems).toHaveLength(0);             // 250.000 USD kritik SAYILMAZ (kur yok)
    expect(r.overdueKnownTotal).toBe(0);                 // EUR geciken toplamda yok
    expect(r.bodyMd).toContain("1 kalem TRY-dışı — toplamda yok");
    expect(r.actions.some((a) => a.includes("TRY-dışı"))).toBe(true);
  });
});

describe("#13 analytics — ödeme baskısı", () => {
  const row = (o: Partial<InstanceRow>): InstanceRow => ({
    id: "1", payment_id: "p", name: "x", due_date: "2026-09-20", amount: 100, amount_status: "known",
    status: "unpaid", paid_amount: null, risk_level: "none", risk_reasons: [], note: null, currency: "TRY", ...o,
  });
  it("USD kalem knownTotal'a girmez, foreignCurrencyCount'ta; count para biriminden bağımsız", () => {
    const a = analyzePaymentPressure([row({ id: "a" }), row({ id: "b", amount: 5000, currency: "USD" }), row({ id: "c", amount: 7, currency: "EUR" })], "2026-09-13");
    expect(a.knownTotal).toBe(100);
    expect(a.recordCount).toBe(3);
    expect(a.foreignCurrencyCount).toBe(2);
    const h = a.horizons.find((x) => x.id === "0-3")!;
    expect(h.count).toBe(3); expect(h.knownAmount).toBe(100); expect(h.foreignCurrencyCount).toBe(2);
    const m = paymentPressureModel([row({ id: "a" }), row({ id: "b", amount: 5000, currency: "USD" })], "2026-09-13");
    const pt = m.series.find((s) => s.id === "planned")!.points[0];
    expect(pt.value).toBe(100);
    expect((pt.meta as { foreignCurrencyCount: number }).foreignCurrencyCount).toBe(1);
  });
});

describe("#50 receivables — yaşlandırma", () => {
  it("USD alacak kovaya toplanmaz, foreignCount'ta; count kalır", () => {
    const s = summarizeAgeing([
      { dueDate: "2026-09-10", openAmount: 100, currency: "TRY" },
      { dueDate: "2026-09-10", openAmount: 9_000, currency: "USD" },
      { dueDate: "2026-09-10", openAmount: 1 }, // alan yok → yapısal TRY
    ], "2026-09-13");
    const b = s.find((x) => x.bucket === "1-7 gün")!;
    expect(b).toEqual({ bucket: "1-7 gün", count: 3, amount: 101, foreignCount: 1 });
  });
});

describe("#57 collections — nakde duyarlı sıra", () => {
  const item = (o: Partial<PayableItem>): PayableItem => ({
    kind: "invoice", entityId: "e", dueDate: "2026-09-20", label: "x", amount: 100, flexibilityClass: "flexible", priorityRank: 1, ...o,
  });
  it("USD kalem TRY nakitle KARŞILANMAZ, kümülatife girmez, foreignCount'ta; knownPayableTotal yalnız TRY", () => {
    const s = scheduleWithinCash([
      item({ entityId: "a", priorityRank: 1, currency: "TRY" }),
      item({ entityId: "b", priorityRank: 2, amount: 1_000_000, currency: "USD" }),
      item({ entityId: "c", priorityRank: 3, amount: 50, currency: "TRY" }),
    ], 200);
    expect(s.totalKnown).toBe(150);
    expect(s.foreignCount).toBe(1);
    expect(s.items.find((x) => x.entityId === "b")!.covered).toBe(false);
    expect(s.items.find((x) => x.entityId === "c")!.covered).toBe(true); // USD kalem nakdi tüketmedi
    expect(s.shortfall).toBe(0);
    expect(knownPayableTotal([item({ amount: 10, currency: "TRY" }), item({ amount: 99, currency: "EUR" }), item({ amount: null })])).toBe(10);
  });
});

describe("#64 budget — doğruluk ve ağırlıklı net", () => {
  it("USD satır skorlanmaz ve sayılır; weightedNet USD'yi toplamaz", () => {
    const a = accuracy([{ forecast: 100, actual: 110, currency: "TRY" }, { forecast: 100, actual: 500, currency: "USD" }, { forecast: 10, actual: 10 }]);
    expect(a.measuredCount).toBe(2);
    expect(a.biasTotal).toBe(10);
    expect(a.foreignCount).toBe(1);
    const lines = [
      { amount: 100, direction: "inflow" as const, currency: "TRY" },
      { amount: 1000, direction: "inflow" as const, currency: "USD" },
      { amount: 30, direction: "outflow" as const },
    ];
    expect(weightedNet(lines)).toBe(70);
    expect(weightedNetDetailed(lines)).toEqual({ total: 70, foreignCount: 1 });
  });
});

describe("#34 facilities — kullanım", () => {
  it("facility para biriminden farklı hareket kullanıma girmez; düz sayı eski davranış", () => {
    const u = utilization(10_000, [{ amount: 4_000, currency: "USD" }, { amount: 2_000, currency: "TRY" }, 500], "USD");
    expect(u.drawnAmount).toBe(4_500);
    expect(u.foreignMovementCount).toBe(1);
    expect(utilization(1_000, [300, 200]).drawnAmount).toBe(500);
    expect(utilization(1_000, [300, 200]).foreignMovementCount).toBe(0);
  });
});
