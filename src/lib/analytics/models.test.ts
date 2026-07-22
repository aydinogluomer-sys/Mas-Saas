import { describe, expect, it } from "vitest";
import { filterChartPeriod } from "./chart";
import { analyzePaymentPressure, capacityModel, cashTrendModel, incomeExpenseModel, paymentPressureModel, prioritizePayments } from "./models";
import type { InstanceRow } from "@/lib/radar/queries";
import type { CashMonth } from "@/lib/radar/rules";

const row = (overrides: Partial<InstanceRow>): InstanceRow => ({
  id: "1", payment_id: "p", name: "Demo", due_date: "2026-07-20", amount: 100,
  amount_status: "known", status: "unpaid", paid_amount: null, risk_level: "none",
  risk_reasons: [], note: null, ...overrides,
});

describe("payment pressure semantics", () => {
  it("derives overdue from date regardless of raw open status", () => {
    const model = paymentPressureModel([row({ due_date: "2026-07-01", status: "unpaid" })], "2026-07-13");
    expect(model.series.find((s) => s.id === "overdue")?.points[0].value).toBe(100);
    expect(model.series.find((s) => s.id === "planned")?.points).toHaveLength(0);
  });
  it("uses remaining amount for partial payments", () => {
    const model = paymentPressureModel([row({ status: "partial", paid_amount: 35 })], "2026-07-13");
    expect(model.series.find((s) => s.id === "partial")?.points[0].value).toBe(65);
  });
  it("keeps an entirely unknown bucket null", () => {
    const model = paymentPressureModel([row({ amount: null })], "2026-07-13");
    expect(model.series.find((s) => s.id === "planned")?.points[0].value).toBeNull();
  });
  it("reconciles the strategic report fixture without production constants", () => {
    const groups: Array<[number, number, string]> = [
      [5, 1_629_969.8, "2026-07-03"], [3, 486_507, "2026-06-03"],
      [15, 10_983_113.8, "2026-08-01"], [13, 6_143_956.8, "2026-11-01"],
      [28, 14_387_309.2, "2027-02-01"], [56, 28_056_711.5, "2027-08-01"],
    ];
    let index = 0;
    const rows = groups.flatMap(([count, total, dueDate]) => {
      const cents = Math.round(total * 100), base = Math.floor(cents / count);
      return Array.from({ length: count }, (_, groupIndex) => {
        const amount = (groupIndex === count - 1 ? cents - base * (count - 1) : base) / 100;
        const flexibility = index < 74 ? "critical" : index < 108 ? "flexible" : "optional";
        index++;
        return row({ id: String(index), due_date: dueDate, amount, flexibility });
      });
    });
    const analysis = analyzePaymentPressure(rows, "2026-07-13");
    expect(analysis.recordCount).toBe(120);
    expect(analysis.knownTotal).toBeCloseTo(61_687_568.1, 2);
    expect(analysis.horizons.map((item) => item.count)).toEqual([8, 15, 13, 28, 56]);
    expect(analysis.horizons[0].knownAmount).toBeCloseTo(2_116_476.8, 2);
    expect(analysis.ageing.map((item) => item.count)).toEqual([5, 3, 0]);
    expect(analysis.flexibility.map((item) => item.count)).toEqual([74, 34, 12, 0]);
  });
  it("prioritizes overdue before today and tomorrow, then criticality and remaining balance", () => {
    const rows = [
      row({ id: "tomorrow", due_date: "2026-07-14", amount: 500_000, risk_level: "critical" }),
      row({ id: "today", due_date: "2026-07-13", amount: 10_000 }),
      row({ id: "overdue-small", due_date: "2026-07-12", amount: 1_000 }),
      row({ id: "later", due_date: "2026-07-20", amount: 9_000_000 }),
    ];
    expect(prioritizePayments(rows, "2026-07-13").map((item) => item.id)).toEqual(["overdue-small", "today", "tomorrow"]);
  });
});

const ASOF = "2026-07-15";
// 24 forward months from the asOf month, with day-01 source keys (as loadCashMonths returns).
const forwardMonths: CashMonth[] = Array.from({ length: 24 }, (_, i) => {
  const month = ((7 - 1 + i) % 12) + 1;
  const year = 2026 + Math.floor((7 - 1 + i) / 12);
  return { monthStart: `${year}-${String(month).padStart(2, "0")}-01`, opening: 100000 - i * 1000, income: 50000, expense: 55000, closing: 95000 - i * 1000 };
});

describe("cashflow chart models", () => {
  it("emits month-shaped keys and a forward time direction", () => {
    const model = cashTrendModel(forwardMonths, ASOF);
    expect(model.timeDirection).toBe("forward");
    expect(model.summaryMode).toBe("endpoint"); // balances are not summable
    expect(model.series[0].points.every((p) => /^\d{4}-\d{2}$/.test(p.key))).toBe(true);
    expect(model.series[0].points[0].key).toBe("2026-07");
  });

  it("marks the income/expense model as summable over the period", () => {
    expect(incomeExpenseModel(forwardMonths, ASOF).summaryMode).toBe("sum");
  });
  it("windows 3m/6m/12m/24m into distinct forward ranges instead of collapsing", () => {
    const model = cashTrendModel(forwardMonths, ASOF);
    const len = (period: "3m" | "6m" | "12m" | "24m") => filterChartPeriod(model, period).series[0].points.length;
    expect([len("3m"), len("6m"), len("12m"), len("24m")]).toEqual([3, 6, 12, 24]);
    expect(filterChartPeriod(model, "3m").series[0].points[0].key).toBe("2026-07");
  });
  it("applies the same forward windowing to the income/expense model", () => {
    const model = incomeExpenseModel(forwardMonths, ASOF);
    expect(model.timeDirection).toBe("forward");
    expect(filterChartPeriod(model, "6m").series[0].points).toHaveLength(6);
  });
});

describe("categorical production charts", () => {
  const rows = ["torna", "freze", "lazer", "cnc"].map((op, i) => ({ operation_type: op, utilization_rate: 0.5 + i * 0.1, capacity_model_name: "M1" }));
  it("marks capacity as categorical and never slices bars by a month period", () => {
    const model = capacityModel(rows, ASOF);
    expect(model.timeDirection).toBe("categorical");
    expect(filterChartPeriod(model, "3m").series[0].points).toHaveLength(rows.length);
    expect(filterChartPeriod(model, "24m").series[0].points).toHaveLength(rows.length);
  });
});
