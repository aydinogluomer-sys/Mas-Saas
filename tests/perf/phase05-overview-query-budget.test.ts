import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({
  env: {
    databaseUrl: "postgres://sahte@127.0.0.1:5432/sahte",
    databasePoolMax: 2,
    databaseStatementTimeoutMs: 5_000,
  },
}));
import {
  computeOverviewPrimary,
  computeOverviewSecondary,
  loadOverviewSnapshot,
} from "@/lib/home/overview-snapshot";

describe("Faz 5 — Ana Ekran 41 sorgu → ≤2 sorgu birleşik özet okuma modeli", () => {
  it("boş veritabanında (onboarding) tek bağlantı ve yalnızca 1 SQL sorgusu ile döner", async () => {
    let connectCalls = 0;
    let queryCalls = 0;

    const fakePool = {
      async connect() {
        connectCalls += 1;
        return {
          async query() {
            queryCalls += 1;
            return {
              rows: [
                {
                  month_total_count: 0,
                  month_missing_count: 0,
                  cash_months: [],
                  active_instances: [],
                  maturities: [],
                  open_review_count: 0,
                  high_open_count: 0,
                  reconciliation_signal_count: 0,
                  missing_amount_count: 0,
                  external_pending_count: 0,
                  capacity_total_count: 0,
                  stale_rate_count: 0,
                  first_is_stale: false,
                },
              ],
              rowCount: 1,
            };
          },
          release() {},
        };
      },
    } as unknown as Pool;

    const snap = await loadOverviewSnapshot(fakePool, "2026-11-01");
    expect(snap.hasData).toBe(false);
    expect(connectCalls).toBe(1);
    expect(queryCalls).toBe(1);
  });

  it("dolu veritabanında 41 sorgu yerine tek bağlantı üzerinde tam olarak 2 SQL sorgusu çalıştırır", async () => {
    let connectCalls = 0;
    let queryCalls = 0;
    let released = 0;

    const fakePool = {
      async connect() {
        connectCalls += 1;
        return {
          async query() {
            queryCalls += 1;
            if (queryCalls === 1) {
              return {
                rows: [
                  {
                    month_total_count: 4,
                    month_missing_count: 1,
                    cash_months: [
                      {
                        month_start: "2026-11-01",
                        opening: "250000.00",
                        income: "120000.00",
                        expense: "180000.00",
                        closing: "190000.00",
                      },
                      {
                        month_start: "2026-12-01",
                        opening: "190000.00",
                        income: "90000.00",
                        expense: "340000.00",
                        closing: "-60000.50",
                      },
                      {
                        month_start: "2027-01-01",
                        opening: null,
                        income: null,
                        expense: null,
                        closing: null,
                      },
                    ],
                    active_instances: [
                      {
                        id: "ovd-1",
                        due_date: "2026-10-28",
                        amount: "42500.75",
                        status: "late",
                        currency: "TRY",
                      },
                      {
                        id: "tdy-try",
                        due_date: "2026-11-01",
                        amount: "15000.25",
                        status: "unpaid",
                        currency: "TRY",
                      },
                      {
                        id: "tdy-null",
                        due_date: "2026-11-01",
                        amount: null,
                        status: "planned",
                        currency: "TRY",
                      },
                      {
                        id: "tdy-usd",
                        due_date: "2026-11-01",
                        amount: "2500.00",
                        status: "unpaid",
                        currency: "USD",
                      },
                      {
                        id: "wk-paid",
                        due_date: "2026-11-04",
                        amount: "8000.00",
                        status: "paid",
                        currency: "TRY",
                      },
                    ],
                    maturities: [
                      {
                        id: "chk:1",
                        due: "2026-12-15",
                        amount: "75000.00",
                        direction: "outflow",
                        kind: "check",
                        label: "Tedarikçi Çeki",
                      },
                    ],
                    open_review_count: 3,
                    high_open_count: 1,
                    reconciliation_signal_count: 0,
                    missing_amount_count: 2,
                    external_pending_count: 0,
                    capacity_total_count: 1,
                    stale_rate_count: 1,
                    first_is_stale: true,
                  },
                ],
                rowCount: 1,
              };
            }
            return {
              rows: [
                {
                  income_lines: [
                    { key: "Akon Savunma", amount: "700000.00" },
                    { key: "Diğer Müşteri", amount: "300000.00" },
                  ],
                  cost_models: [
                    {
                      break_even: "48.5000",
                      akon_freze: "44.0000",
                      akon_torna: "52.0000",
                    },
                  ],
                  last_report: {
                    id: "rep-1",
                    report_type: "weekly",
                    created_at: "2026-11-01 09:00",
                  },
                  reminder_counts: [
                    { status: "sent", n: 12 },
                    { status: "pending", n: 3 },
                    { status: "failed", n: 2 },
                  ],
                  approved_external: [
                    {
                      assumption_type: "fx_rate",
                      label: "USD/TRY TCMB",
                      period_start: "2026-11-01",
                      period_end: null,
                      value_numeric: "34.8250",
                      unit: "TL",
                      currency: "USD",
                      source_name: "TCMB",
                      source_date: "2026-11-01",
                    },
                  ],
                },
              ],
              rowCount: 1,
            };
          },
          release() {
            released += 1;
          },
        };
      },
    } as unknown as Pool;

    const snap = await loadOverviewSnapshot(fakePool, "2026-11-01");

    expect(connectCalls).toBe(1);
    expect(queryCalls).toBe(2);
    expect(released).toBe(1);

    // Kuruş hassasiyeti + BLANK ≠ ZERO + TRY-only para birimi politikası:
    expect(snap.todayOutflow).toEqual({
      total: 15000.25,
      count: 3, // tdy-try + tdy-null + tdy-usd (hepsi açık)
      missing: 1, // tdy-null 0 sayılmadı
      foreign: 1, // tdy-usd TRY toplamına karıştırılmadı
    });
    expect(snap.weekOutflow).toEqual({
      total: 15000.25, // wk-paid kapalı olduğu için açık çıkışa girmez
      count: 3,
      missing: 1,
      foreign: 1,
    });
    expect(snap.overdueOutflow).toEqual({
      total: 42500.75,
      count: 1,
      missing: 0,
      foreign: 0,
    });

    // Sparkline serileri null ve TRY-dışı kalemleri 0 çizmez, çıkarıp sayar:
    expect(snap.weekTrendValues).toEqual([15000.25, 8000]);
    expect(snap.weekTrendOmitted).toBe(2); // tdy-null + tdy-usd
    expect(snap.closingSeries).toEqual({
      values: [190000, -60000.5],
      unknownCount: 1, // 2027-01 kapanışı null -> 0 çizilmez
    });

    // Runway + borç baskısı + başabaş altı üretim + karar güveni:
    expect(snap.projection.firstNegativeMonth).toBe("2026-12-01");
    expect(snap.runwayFact.value).toBe("1 ay");
    expect(snap.runwayFact.severity).toBe("critical");
    expect(snap.debtPressureMonths).toBe(1); // 2026-12 negatif kasa + 75.000 TL çek çıkışı
    expect(snap.marginLoss).toBe(true); // akonFreze (44) < breakEven (48.5)
    expect(snap.dataQuality.decisionConfidence).toBe(71); // 100 - (1*14 + 2*3 + 0 + 2*2 + 1*5 + 0) = 71
    expect(snap.headline.tone).toBe("neg");
    expect(snap.headline.text).toContain("1 geciken ödeme");

    // Kanıt çekmecesi (ProofItem) eşleşmeleri korunur:
    expect(snap.actions.map((a) => a.key)).toContain("overdue");
    expect(snap.proofByActionKey.overdue?.[0]?.key).toBe("overdue_payment_load");
    expect(snap.proofByActionKey.overdue?.[0]?.value).toBe("1");
  });

  it("karar güveni cezasını data-quality/rules.ts ile birebir hesaplar", () => {
    const primary = computeOverviewPrimary(
      {
        monthTotalCount: 1,
        monthMissingCount: 0,
        cashMonths: [],
        activeInstances: [],
        maturities: [],
        dq: {
          openReviewCount: 3,
          highOpenCount: 1,
          reconciliationSignalCount: 0,
          missingAmountCount: 2,
          externalPendingCount: 0,
          capacityTotalCount: 1,
          staleProductionRateCount: 1,
          firstCapacityStale: true,
        },
      },
      "2026-11-01",
    );
    // 100 - (1*14 + (3-1)*3 + 0*10 + 2*2 + 1*5 + 0*4) = 100 - 29 = 71
    expect(primary.dataQuality.decisionConfidence).toBe(71);

    const secondary = computeOverviewSecondary(primary, {
      incomeLines: [],
      costModels: [],
      lastReport: null,
      reminderCounts: [],
      approvedExternal: [],
    });
    expect(secondary.staleProductionRate).toBe(true);
    expect(secondary.actions[0]?.key).toBe("stale_rate");
  });

  it("Ana Ekran sayfası artık ölü loadThresholds ve 14-sorguluk loadDataQualityCenter motorlarını çağırmaz", () => {
    const pageSrc = readFileSync(
      join(process.cwd(), "src/app/(dashboard)/page.tsx"),
      "utf8",
    );
    expect(pageSrc).toMatch(/loadOverview(Primary|Snapshot)/);
    expect(pageSrc).not.toContain("loadThresholds");
    expect(pageSrc).not.toContain("loadDataQualityCenter");
    expect(pageSrc).not.toContain("loadDecisionFacts");
    expect(pageSrc).not.toContain("listReports");
  });
});
