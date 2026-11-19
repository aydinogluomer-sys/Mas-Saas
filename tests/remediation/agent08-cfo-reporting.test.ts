import type { Pool } from "pg";
import { describe, expect, it } from "vitest";

import {
  briefingStatus,
  headline,
  renderBriefing,
  summariseDay,
  todaysActions,
  type BriefingFacts,
} from "@/lib/briefing/rules";
import { mapInstanceRow } from "@/lib/radar/queries";
import {
  REPORT_CALCULATION_VERSION,
  WORKBOOK_STALE_THRESHOLD_DAYS,
  evaluateReportContractE,
  loadBoardFinancialPackage,
  loadReportProvenance,
  renderBoardPackMarkdown,
  toFinancialReportSnapshotContract,
} from "@/lib/reports/board-pack";
import {
  generateDaily,
  generateMonthly,
  generateWeekly,
  toReportInstance,
} from "@/lib/reports/engine";
import {
  buildDailyReport,
  buildMonthlyReport,
  buildWeeklyReport,
  reportFmtTL,
  resolveReportInstanceAmounts,
  type ReportInstance,
} from "@/lib/reports/rules";

const ACTOR_ID = "00000000-0000-4000-8000-000000000008";

describe("Agent 08 — CFO Reporting & Cash-Flow Intelligence Remediation (Phase D)", () => {
  it("1. computes unpaid/overdue exposure from remaining amount on partial payments (30,000/10,000 -> 20,000 and VAKIF KREDİ 2 30,000/12,000 -> 18,000) across daily, weekly, monthly & briefing rules", () => {
    // (a) Synthetic Scenario 6 partial obligation: 30,000 original, 10,000 paid -> 20,000 remaining
    const partial20kRow = mapInstanceRow({
      id: "pi-scen6-20k",
      payment_id: "pay-scen6",
      name: "Ticari Taksit Ödemesi",
      due_date: "2026-11-10",
      amount: "30000.00",
      amount_status: "known",
      status: "partial",
      paid_amount: "10000.00",
      risk_level: "high",
      risk_reasons: ["overdue"],
      note: null,
      currency: "TRY",
    });
    const inst20k = toReportInstance(partial20kRow);
    expect(resolveReportInstanceAmounts(inst20k)).toEqual({
      orig: 30_000,
      paid: 10_000,
      rem: 20_000,
    });

    // (b) Live mirror VAKIF KREDİ 2: 30,000 original, 12,000 paid -> 18,000 remaining
    const vakifRow = mapInstanceRow({
      id: "0fbd2b5b-0a12-41b5-9bbe-23c8d079f03d",
      payment_id: "239bd2b1-35c0-4581-b0d1-b446fc220355",
      name: "VAKIF KREDİ 2",
      due_date: "2026-07-23",
      amount: "30000.00",
      amount_status: "known",
      status: "partial",
      paid_amount: "12000.00",
      risk_level: "high",
      risk_reasons: ["overdue"],
      note: null,
      currency: "TRY",
    });
    const vakifInst = toReportInstance(vakifRow);
    expect(resolveReportInstanceAmounts(vakifInst)).toEqual({
      orig: 30_000,
      paid: 12_000,
      rem: 18_000,
    });

    // (c) Missing amount stays strictly null (never coerced to 0)
    const missingInst: ReportInstance = {
      name: "MAS Elektrik Faturası",
      dueDate: "2026-11-18",
      amount: null,
      status: "unpaid",
      riskLevel: "medium",
      riskReasons: ["missing_amount"],
      currency: "TRY",
    };
    expect(resolveReportInstanceAmounts(missingInst)).toEqual({
      orig: null,
      paid: null,
      rem: null,
    });

    // Daily report: overdue exposure sums 20,000 + 18,000 = 38,000 (NOT 60,000!)
    // and dueSoon partial (30,000 orig / 10,000 paid -> 20,000 rem) is below 25,000 criticalThreshold
    const dueSoonPartial: ReportInstance = {
      name: "Tedarikçi Kısmi Ödeme",
      dueDate: "2026-11-18",
      amount: 30_000,
      paidAmount: 10_000,
      status: "partial",
      riskLevel: "medium",
      riskReasons: [],
      currency: "TRY",
    };
    const daily = buildDailyReport(
      {
        dueSoon: [dueSoonPartial, missingInst],
        overdue: [inst20k, vakifInst],
        maturities: [],
        criticalThreshold: 25_000,
      },
      "2026-11-18",
    );

    expect(daily.next7KnownTotal).toBe(20_000);
    expect(daily.next7MissingCount).toBe(1);
    expect(daily.criticalItems).toHaveLength(0);
    expect(daily.overdueCount).toBe(2);
    expect(daily.overdueKnownTotal).toBe(38_000);
    expect(daily.bodyMd).toContain("kalan 20.000 TL (asıl: 30.000 TL · ödenen: 10.000 TL)");
    expect(daily.bodyMd).toContain("kalan 18.000 TL (asıl: 30.000 TL · ödenen: 12.000 TL)");
    expect(daily.bodyMd).toContain("TUTAR EKSİK");

    // Weekly report: uses remaining exposure for knownTotal & largest threshold/sorting
    const weekly = buildWeeklyReport(
      {
        weekInstances: [
          {
            name: "VAKIF KREDİ 2",
            dueDate: "2026-11-20",
            amount: 30_000,
            originalAmount: 30_000,
            paidAmount: 12_000,
            outstandingAmount: 18_000,
            status: "partial",
            riskLevel: "high",
            riskReasons: [],
            currency: "TRY",
          },
          {
            name: "Kısmi Kira",
            dueDate: "2026-11-21",
            amount: 30_000,
            paid_amount: 10_000,
            status: "partial",
            riskLevel: "medium",
            riskReasons: [],
            currency: "TRY",
          },
          missingInst,
        ],
        maturitiesWeek: [],
        installmentsMonth: [],
        riskDays: [],
        largeThreshold: 15_000,
      },
      "2026-11-18",
    );

    expect(weekly.knownTotal).toBe(38_000);
    expect(weekly.missingCount).toBe(1);
    expect(weekly.largest.map((x) => x.name)).toEqual(["Kısmi Kira", "VAKIF KREDİ 2"]);
    expect(weekly.bodyMd).toContain("kalan 20.000 TL (asıl: 30.000 TL · ödenen: 10.000 TL)");
    expect(weekly.bodyMd).toContain("kalan 18.000 TL (asıl: 30.000 TL · ödenen: 12.000 TL)");

    // Briefing summariseDay also uses remaining exposure on partial rows while counting null separately
    const daySummary = summariseDay([
      { amount: 30_000, paidAmount: 12_000, status: "partial", direction: "outflow", currency: "TRY" },
      { amount: null, direction: "outflow", currency: "TRY" },
    ]);
    expect(daySummary.knownOutflow).toBe(18_000);
    expect(daySummary.unknownCount).toBe(1);
  });

  it("2. enforces ACTUAL vs FORECAST vs RECONCILED vs PLANNED vs UNKNOWN cash distinctions in buildMonthlyReport and renderBriefing (FIN-03 vs -543,764.76 TRY forecast)", () => {
    const vakifPartial: ReportInstance = {
      name: "VAKIF KREDİ 2",
      dueDate: "2026-07-23",
      amount: 30_000,
      originalAmount: 30_000,
      paidAmount: 12_000,
      outstandingAmount: 18_000,
      status: "partial",
      riskLevel: "high",
      riskReasons: ["overdue"],
      currency: "TRY",
    };

    const monthlyFin03 = buildMonthlyReport({
      monthStart: "2026-11-01",
      knownTotal: 510_000,
      knownRemaining: 510_000,
      paidKnown: 0,
      missingCount: 11,
      totalCount: 17,
      cancelledCount: 1,
      cancelledKnownTotal: 30_000,
      settlementAdjustmentTry: 0,
      topPayments: [vakifPartial],
      providerDist: [{ key: "Vakıfbank", amount: 510_000 }],
      categoryDist: [{ key: "Kredi", amount: 510_000 }],
      ownerDist: [{ key: "MAS", amount: 510_000 }],
      checksInMonth: [],
      installmentsInMonth: [],
      cashMonth: {
        opening: -33_764.76,
        income: 0,
        expense: 510_000,
        closing: -543_764.76,
      },
      actualBankCashStatus: {
        availableCashTry: null,
        unknownOpeningCount: 6,
        hasVerifiedBankFeed: false,
        reconciledTxCount: 0,
        unmatchedTxCount: 0,
      },
      provenance: {
        confidenceGrade: "UNVERIFIED_CASH_BASIS",
        workbookStaleDays: 124,
        missingMaterialInputs: [
          "FIN-03: Nakit hesap açılış bakiyesi eksik (6 aktif hesap)",
          "Banka ekstresi hareketi yok",
          "Çalışma kitabı > 45 gün eski (124 gün)",
        ],
      },
      dataQualityIssues: ["11 kalemde tutar eksik"],
    });

    expect(monthlyFin03.monetaryBasisByMetric).toEqual({
      availableBankCash: "UNKNOWN",
      scheduledOutflows: "PLANNED",
      workbookMonthlyCash: "FORECAST",
      bankReconciledFlows: "UNKNOWN",
    });
    expect(monthlyFin03.bodyMd).toContain("[UNKNOWN] Bilinmiyor (FIN-03: 6 aktif hesapta açılış bakiyesi tanımsız)");
    expect(monthlyFin03.bodyMd).toContain("[UNKNOWN] Bilinmiyor (banka ekstresi hareketi yok)");
    expect(monthlyFin03.bodyMd).toContain("[FORECAST]");
    expect(monthlyFin03.bodyMd).toContain("-543.764,76 TL");
    expect(monthlyFin03.bodyMd).toContain("fiili banka kasası [UNKNOWN] durumdadır");
    expect(monthlyFin03.bodyMd).toContain("UNVERIFIED_CASH_BASIS");
    expect(monthlyFin03.bodyMd).toContain("kalan 18.000 TL (asıl: 30.000 TL · ödenen: 12.000 TL)");
    expect(monthlyFin03.bodyMd).not.toContain("fiili kullanılabilir kasa: 0 TL");

    // Contrasting verified bank cash & reconciled bank feed case
    const monthlyVerified = buildMonthlyReport({
      monthStart: "2026-11-01",
      knownTotal: 200_000,
      knownRemaining: 50_000,
      paidKnown: 150_000,
      missingCount: 0,
      totalCount: 4,
      topPayments: [],
      providerDist: [],
      categoryDist: [],
      ownerDist: [],
      checksInMonth: [],
      installmentsInMonth: [],
      cashMonth: { opening: 300_000, income: 250_000, expense: 200_000, closing: 350_000 },
      actualBankCashStatus: {
        availableCashTry: 410_000,
        unknownOpeningCount: 0,
        hasVerifiedBankFeed: true,
        reconciledTxCount: 18,
        unmatchedTxCount: 1,
      },
      dataQualityIssues: [],
    });
    expect(monthlyVerified.monetaryBasisByMetric.availableBankCash).toBe("ACTUAL");
    expect(monthlyVerified.monetaryBasisByMetric.bankReconciledFlows).toBe("RECONCILED");
    expect(monthlyVerified.bodyMd).toContain("[ACTUAL] 410.000 TL");
    expect(monthlyVerified.bodyMd).toContain("[RECONCILED] 18 mutabık");

    // CFO Morning Briefing: FIN-03 unknown cash + null DSO + negative workbook forecast
    const fin03BriefingFacts: BriefingFacts = {
      todayISO: "2026-11-18",
      availableCash: null,
      minCashFloor: 250_000,
      liquidityGap7: null,
      liquidityGap30: null,
      projectedContracted7: null,
      todayOutflowKnown: 45_000,
      todayInflowKnown: 0,
      todayCount: 1,
      todayUnknownAmountCount: 0,
      todayForeignCurrencyCount: 0,
      overdueForeignCurrencyCount: 0,
      overdueCount: 93,
      overdueKnownOutflow: 2_738_000,
      criticalControls: [],
      openAlertCount: 0,
      newCriticalAlerts: [],
      promisesDueToday: 0,
      overduePromises: 0,
      dsoDays: null,
      dpoDays: null,
      cycleExcludingInventory: null,
      workbookForecastClosingTry: -543_764.76,
      provenance: {
        snapshotId: "88888888-8888-4888-8888-888888888888",
        asOfDate: "2026-11-18",
        asOfAt: "2026-11-18T06:00:00.000Z",
        schemaVersion: "0124",
        migrationCount: 124,
        lastWorkbookImportAt: "2026-07-17T09:00:00Z",
        lastWorkbookFilename: "TEMİZ.xlsx",
        workbookStaleDays: 124,
        lastBankTxAt: null,
        contentSha256: "a".repeat(64),
        calculationVersion: REPORT_CALCULATION_VERSION,
        confidenceGrade: "UNVERIFIED_CASH_BASIS",
        missingMaterialInputs: [
          "FIN-03: Nakit hesap açılış bakiyesi eksik (6 aktif hesap)",
          "Banka ekstresi hareketi yok",
          "Çalışma kitabı > 45 gün eski (124 gün)",
        ],
      },
    };

    const briefingMd = renderBriefing(fin03BriefingFacts);
    expect(briefingMd).toContain("Kullanılabilir nakit: — [UNKNOWN]");
    expect(briefingMd).toContain("7 gün likidite açığı: — (bilinmiyor / ölçülemez) [UNKNOWN]");
    expect(briefingMd).toContain("30 gün likidite açığı: — (bilinmiyor / ölçülemez) [UNKNOWN]");
    expect(briefingMd).toContain("Çalışma kitabı tahmini kapanış ([FORECAST] — fiili banka kasası değildir): -543.764,76 TL");
    expect(briefingMd).toContain("DSO: —");
    expect(briefingMd).toContain("UNVERIFIED_CASH_BASIS");
    expect(briefingMd).not.toContain("Kullanılabilir nakit: 0 TL");
    expect(briefingMd).not.toContain("DSO: 0 gün");
    expect(briefingStatus(fin03BriefingFacts)).toEqual({ text: "likidite bilinmiyor", tone: "neutral" });
    expect(headline({ ...fin03BriefingFacts, overdueCount: 0, todayCount: 0 }).tone).toBe("warn");
    expect(todaysActions(fin03BriefingFacts)[0]).toContain("bilinmiyor (ölçülemez)");
  });

  it("3. grades Contract E provenance deterministically across UNVERIFIED_CASH_BASIS, STALE_SOURCE_WARNING, PARTIAL_MISSING_INPUTS, and VERIFIED_COMPLETE", () => {
    expect(WORKBOOK_STALE_THRESHOLD_DAYS).toBe(45);

    // (a) FIN-03 active -> UNVERIFIED_CASH_BASIS
    const unverified = evaluateReportContractE({
      unknownOpeningAccountCount: 6,
      knownOpeningAccountCount: 0,
      hasVerifiedBankFeed: false,
      workbookStaleDays: 124,
      hasValidWorkbookImport: true,
      missingPaymentAmountCount: 11,
    });
    expect(unverified.calculationVersion).toBe(REPORT_CALCULATION_VERSION);
    expect(unverified.confidenceGrade).toBe("UNVERIFIED_CASH_BASIS");
    expect(unverified.monetaryBasisByMetric).toEqual({
      availableBankCash: "UNKNOWN",
      scheduledOutflows: "PLANNED",
      workbookMonthlyCash: "FORECAST",
      bankReconciledFlows: "UNKNOWN",
    });
    expect(unverified.missingMaterialInputs).toEqual(
      expect.arrayContaining([
        expect.stringContaining("FIN-03"),
        "Banka ekstresi hareketi yok",
        expect.stringContaining("> 45 gün eski"),
        expect.stringContaining("11 kalem"),
      ]),
    );

    // (b) Known cash + bank feed, but >45d stale workbook -> STALE_SOURCE_WARNING
    const stale = evaluateReportContractE({
      unknownOpeningAccountCount: 0,
      knownOpeningAccountCount: 2,
      hasVerifiedBankFeed: true,
      workbookStaleDays: 62,
      hasValidWorkbookImport: true,
      missingPaymentAmountCount: 0,
    });
    expect(stale.confidenceGrade).toBe("STALE_SOURCE_WARNING");
    expect(stale.monetaryBasisByMetric.availableBankCash).toBe("ACTUAL");
    expect(stale.monetaryBasisByMetric.bankReconciledFlows).toBe("RECONCILED");
    expect(stale.missingMaterialInputs).toContain("Çalışma kitabı > 45 gün eski (62 gün)");

    // (c) Known cash + fresh workbook (<=45d), but no bank feed -> PARTIAL_MISSING_INPUTS
    const partialMissing = evaluateReportContractE({
      unknownOpeningAccountCount: 0,
      knownOpeningAccountCount: 2,
      hasVerifiedBankFeed: false,
      workbookStaleDays: 12,
      hasValidWorkbookImport: true,
      missingPaymentAmountCount: 0,
    });
    expect(partialMissing.confidenceGrade).toBe("PARTIAL_MISSING_INPUTS");
    expect(partialMissing.missingMaterialInputs).toEqual(["Banka ekstresi hareketi yok"]);

    // (d) All inputs verified & fresh (<=45d) -> VERIFIED_COMPLETE
    const verified = evaluateReportContractE({
      unknownOpeningAccountCount: 0,
      knownOpeningAccountCount: 3,
      hasVerifiedBankFeed: true,
      workbookStaleDays: 10,
      hasValidWorkbookImport: true,
      missingPaymentAmountCount: 0,
      reconciliationAligned: true,
      controlAlertsOpenCount: 0,
    });
    expect(verified.confidenceGrade).toBe("VERIFIED_COMPLETE");
    expect(verified.missingMaterialInputs).toEqual([]);
  });

  it("4. excludes empty (0 import_rows) and failed workbooks in loadReportProvenance so workbookStaleDays NEVER resets to 0", async () => {
    const asOf = "2026-11-18";

    // Sub-case A: Primary query uses public.valid_workbook_imports; empty upload today does NOT reset 124-day staleness
    const executedSqlPrimary: string[] = [];
    const mockPrimaryPool = {
      async query(sql: string) {
        const norm = sql.replace(/\s+/g, " ").trim().toLowerCase();
        executedSqlPrimary.push(norm);

        if (norm.includes("get_schema_ledger_summary")) {
          return { rows: [{ migration_count: 124, latest_version: "0124" }], rowCount: 1 };
        }
        if (norm.includes("from public.valid_workbook_imports")) {
          // Empty workbook uploaded on 2026-11-18 is excluded by valid_workbook_imports view;
          // last valid workbook with rows is TEMİZ.xlsx from 2026-07-17 (124 days ago).
          return {
            rows: [
              {
                last_wb_at: "2026-07-17T09:15:00Z",
                last_wb_date: "2026-07-17",
                last_wb_name: "TEMİZ.xlsx",
              },
            ],
            rowCount: 1,
          };
        }
        if (norm.includes("from public.source_workbooks")) {
          throw new Error("Should not query unfiltered source_workbooks when valid_workbook_imports succeeds");
        }
        if (norm.includes("from public.bank_transactions")) {
          return { rows: [{ last_bt_at: null }], rowCount: 1 };
        }
        if (norm.includes("from public.cash_accounts")) {
          return { rows: [{ unknown_opening_n: 6, known_opening_n: 0 }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
    } as unknown as Pick<Pool, "query">;

    const provStale = await loadReportProvenance(mockPrimaryPool, asOf, {
      snapshotId: "11111111-2222-4333-8444-555555555555",
    });
    expect(executedSqlPrimary.some((s) => s.includes("from public.valid_workbook_imports"))).toBe(true);
    expect(provStale.lastWorkbookFilename).toBe("TEMİZ.xlsx");
    expect(provStale.workbookStaleDays).toBe(124);
    expect(provStale.workbookStaleDays).not.toBe(0);
    expect(provStale.confidenceGrade).toBe("UNVERIFIED_CASH_BASIS");
    expect(provStale.missingMaterialInputs).toEqual(
      expect.arrayContaining([
        "FIN-03: Nakit hesap açılış bakiyesi eksik (6 aktif hesap)",
        "Banka ekstresi hareketi yok",
        "Çalışma kitabı > 45 gün eski (124 gün)",
      ]),
    );

    const snapshotContract = toFinancialReportSnapshotContract(provStale);
    expect(snapshotContract.snapshotId).toBe("11111111-2222-4333-8444-555555555555");
    expect(snapshotContract.businessDateISO).toBe(asOf);
    expect(snapshotContract.schemaVersion).toBe("0124");
    expect(snapshotContract.sourceFreshnessDays).toBe(124);
    expect(snapshotContract.confidenceGrade).toBe("UNVERIFIED_CASH_BASIS");
    expect(snapshotContract.contentSha256).toMatch(/^[0-9a-f]{64}$/);

    // Sub-case B: When ONLY an empty or failed workbook exists in DB, valid_workbook_imports returns 0 rows -> workbookStaleDays stays null (NEVER 0)
    const onlyEmptyWorkbookPool = {
      async query(sql: string) {
        const norm = sql.replace(/\s+/g, " ").trim().toLowerCase();
        if (norm.includes("get_schema_ledger_summary")) {
          return { rows: [{ migration_count: 124, latest_version: "0124" }], rowCount: 1 };
        }
        if (norm.includes("from public.valid_workbook_imports")) {
          return { rows: [], rowCount: 0 };
        }
        if (norm.includes("from public.bank_transactions")) {
          return { rows: [{ last_bt_at: "2026-11-18" }], rowCount: 1 };
        }
        if (norm.includes("from public.cash_accounts")) {
          return { rows: [{ unknown_opening_n: 0, known_opening_n: 2 }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
    } as unknown as Pick<Pool, "query">;

    const provEmptyOnly = await loadReportProvenance(onlyEmptyWorkbookPool, asOf);
    expect(provEmptyOnly.lastWorkbookImportAt).toBeNull();
    expect(provEmptyOnly.workbookStaleDays).toBeNull();
    expect(provEmptyOnly.confidenceGrade).toBe("PARTIAL_MISSING_INPUTS");
    expect(provEmptyOnly.missingMaterialInputs).toContain("Geçerli çalışma kitabı içe aktarımı yok");

    // Sub-case C: Fallback path when valid_workbook_imports throws 42P01 still enforces status in ('parsed','mapped') and exists (select 1 from public.import_rows ...)
    let fallbackSqlObserved = "";
    const fallbackPool = {
      async query(sql: string) {
        const norm = sql.replace(/\s+/g, " ").trim().toLowerCase();
        if (norm.includes("get_schema_ledger_summary")) {
          return { rows: [{ migration_count: 123, latest_version: "0123" }], rowCount: 1 };
        }
        if (norm.includes("from public.valid_workbook_imports")) {
          throw Object.assign(new Error("relation valid_workbook_imports does not exist"), {
            code: "42P01",
          });
        }
        if (norm.includes("from public.source_workbooks sw")) {
          fallbackSqlObserved = norm;
          return {
            rows: [
              {
                last_wb_at: "2026-09-19T10:00:00Z",
                last_wb_date: "2026-09-19",
                last_wb_name: "fallback_valid.xlsx",
              },
            ],
            rowCount: 1,
          };
        }
        if (norm.includes("from public.bank_transactions")) {
          return { rows: [{ last_bt_at: "2026-11-17" }], rowCount: 1 };
        }
        if (norm.includes("from public.cash_accounts")) {
          return { rows: [{ unknown_opening_n: 0, known_opening_n: 1 }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
    } as unknown as Pick<Pool, "query">;

    const provFallback = await loadReportProvenance(fallbackPool, asOf);
    expect(fallbackSqlObserved).toContain("sw.status in ('parsed', 'mapped')");
    expect(fallbackSqlObserved).toContain("from public.import_rows ir where ir.workbook_id = sw.id");
    expect(provFallback.workbookStaleDays).toBe(60);
    expect(provFallback.confidenceGrade).toBe("STALE_SOURCE_WARNING");
  });

  it("5. guarantees zero contradictory figures across persisted snapshot metadata and rendered Markdown in generateDaily, generateWeekly, generateMonthly & Board Pack", async () => {
    const savedReports: Array<{
      id: string;
      type: string;
      periodStart: string;
      periodEnd: string;
      bodyMd: string;
      meta: Record<string, unknown>;
    }> = [];

    const executeMockSql = async (rawSql: string, params: unknown[] = []) => {
      const sql = rawSql.replace(/\s+/g, " ").trim().toLowerCase();

      if (sql === "begin" || sql === "commit" || sql === "rollback") {
        return { rows: [], rowCount: 0 };
      }

      if (sql.startsWith("insert into public.reports")) {
        const [id, type, periodStart, periodEnd, bodyMd, rawMeta] = params as [
          string,
          string,
          string,
          string,
          string,
          string,
        ];
        savedReports.push({
          id,
          type,
          periodStart,
          periodEnd,
          bodyMd,
          meta: JSON.parse(rawMeta) as Record<string, unknown>,
        });
        return { rows: [{ id }], rowCount: 1 };
      }

      if (sql.startsWith("insert into public.audit_logs")) {
        return { rows: [{ id: "audit-ok" }], rowCount: 1 };
      }

      // Guard against any financial record mutation
      if (/^(insert\s+into|update|delete\s+from)\s+public\./.test(sql)) {
        throw new Error(`Forbidden financial mutation in report engine: ${rawSql}`);
      }

      // Thresholds
      if (sql.includes("from public.settings")) {
        return { rows: [], rowCount: 0 };
      }

      // Provenance & schema
      if (sql.includes("get_schema_ledger_summary")) {
        return { rows: [{ migration_count: 124, latest_version: "0124" }], rowCount: 1 };
      }
      if (sql.includes("from public.valid_workbook_imports")) {
        return {
          rows: [
            {
              last_wb_at: "2026-07-17T09:00:00Z",
              last_wb_date: "2026-07-17",
              last_wb_name: "TEMİZ.xlsx",
            },
          ],
          rowCount: 1,
        };
      }

      // Monthly summary (I-009: 510,000 active known TRY = 12,000 paid + 498,000 remaining; 1 cancelled = 30,000 TRY)
      if (sql.includes("known_remaining") && sql.includes("cancelled_known_total")) {
        return {
          rows: [
            {
              known_total: "510000.00",
              known_remaining: "498000.00",
              paid_known: "12000.00",
              missing_count: 2,
              foreign_count: 0,
              total_count: 4,
              cancelled_count: 1,
              cancelled_known_total: "30000.00",
              settlement_adjustment_try: "0.00",
              overpayment_adjustment_try: "0.00",
            },
          ],
          rowCount: 1,
        };
      }

      // Unassigned counts in generateMonthly
      if (sql.includes("no_provider") && sql.includes("no_category")) {
        return { rows: [{ no_provider: 1, no_category: 0 }], rowCount: 1 };
      }

      // Distribution in generateMonthly
      if (sql.includes("group by 1 order by amount desc nulls last")) {
        return { rows: [{ key: "Vakıfbank", amount: "510000.00", foreign_count: 0 }], rowCount: 1 };
      }

      // Payment instances (dueSoon / overdue / monthInstances)
      if (sql.includes("from public.payment_instances i") && sql.includes("i.paid_amount")) {
        if (sql.includes("where i.due_date < $1")) {
          // Overdue: VAKIF KREDİ 2 (30,000 orig, 12,000 paid -> 18,000 remaining)
          return {
            rows: [
              {
                id: "0fbd2b5b-0a12-41b5-9bbe-23c8d079f03d",
                payment_id: "239bd2b1-35c0-4581-b0d1-b446fc220355",
                name: "VAKIF KREDİ 2",
                due_date: "2026-07-23",
                amount: "30000.00",
                amount_status: "known",
                status: "partial",
                paid_amount: "12000.00",
                risk_level: "high",
                risk_reasons: ["overdue"],
                note: null,
                currency: "TRY",
                direction: "outflow",
              },
            ],
            rowCount: 1,
          };
        }
        // dueSoon / week / monthInstances
        return {
          rows: [
            {
              id: "pi-week-partial",
              payment_id: "p-1",
              name: "Tedarikçi Taksit",
              due_date: "2026-11-18",
              amount: "30000.00",
              amount_status: "known",
              status: "partial",
              paid_amount: "10000.00",
              risk_level: "medium",
              risk_reasons: [],
              note: null,
              currency: "TRY",
              direction: "outflow",
            },
            {
              id: "pi-week-missing",
              payment_id: "p-2",
              name: "MAS Elektrik",
              due_date: "2026-11-19",
              amount: null,
              amount_status: "missing",
              status: "unpaid",
              paid_amount: null,
              risk_level: "low",
              risk_reasons: ["missing_amount"],
              note: null,
              currency: "TRY",
              direction: "outflow",
            },
          ],
          rowCount: 2,
        };
      }

      // Cashflow months (workbook forecast negative -543,764.76)
      if (sql.includes("from public.cashflow_months")) {
        return {
          rows: [
            {
              month_start: "2026-11-01",
              opening: "-33764.76",
              income: "0.00",
              expense: "510000.00",
              closing: "-543764.76",
            },
          ],
          rowCount: 1,
        };
      }

      // Monthly actual bank cash status (FIN-03: 6 null openings, 0 bank tx)
      if (sql.includes("actual_cash_try") && sql.includes("bt_reconciled")) {
        return {
          rows: [
            {
              unknown_opening_n: 6,
              known_opening_n: 0,
              actual_cash_try: null,
              bt_total: 0,
              bt_reconciled: 0,
              bt_unmatched: 0,
            },
          ],
          rowCount: 1,
        };
      }

      // Board pack cash_accounts query
      if (sql.includes("from public.cash_accounts ca")) {
        return {
          rows: [{ currency: "TRY", bal: null, known_n: 0, unknown_opening_n: 6 }],
          rowCount: 1,
        };
      }
      if (sql.includes("from public.cash_accounts")) {
        return { rows: [{ unknown_opening_n: 6, known_opening_n: 0 }], rowCount: 1 };
      }

      // Bank transactions max txn_date
      if (sql.includes("from public.bank_transactions")) {
        return { rows: [{ last_bt_at: null }], rowCount: 1 };
      }

      // Working capital metrics (null DSO/DPO when unmeasured)
      if (sql.includes("from public.working_capital_metrics")) {
        return {
          rows: [
            {
              dso_days: null,
              dio_days: null,
              dpo_days: null,
              cash_conversion_cycle_days: null,
              cash_cycle_excluding_inventory: null,
            },
          ],
          rowCount: 1,
        };
      }

      return { rows: [], rowCount: 0 };
    };

    const mockPool = {
      query: executeMockSql,
      async connect() {
        return {
          query: executeMockSql,
          release() {},
        };
      },
    } as unknown as Pool;

    // 1) Daily report end-to-end
    const dailyRes = await generateDaily(mockPool, "2026-11-18", ACTOR_ID);
    const savedDaily = savedReports.find((r) => r.id === dailyRes.id)!;
    const dailySnapshot = savedDaily.meta.snapshot as {
      reportMetrics: Record<string, unknown>;
      provenance: Record<string, unknown>;
    };

    expect(dailySnapshot.provenance.workbookStaleDays).toBe(124);
    expect(savedDaily.meta.next7KnownTotal).toBe(20_000);
    expect(savedDaily.meta.overdueKnownTotal).toBe(18_000);
    expect(savedDaily.meta.missingCount).toBe(1);
    expect(dailySnapshot.reportMetrics.next7KnownTotal).toBe(savedDaily.meta.next7KnownTotal);
    expect(dailySnapshot.reportMetrics.overdueKnownTotal).toBe(savedDaily.meta.overdueKnownTotal);
    expect(savedDaily.bodyMd).toContain(`7 gün bilinen toplam: ${reportFmtTL(20_000)}`);
    expect(savedDaily.bodyMd).toContain(`Geciken (1) — bilinen ${reportFmtTL(18_000)}`);
    expect(savedDaily.bodyMd).toContain("kalan 18.000 TL (asıl: 30.000 TL · ödenen: 12.000 TL)");

    // 2) Weekly report end-to-end
    const weeklyRes = await generateWeekly(mockPool, "2026-11-18", ACTOR_ID);
    const savedWeekly = savedReports.find((r) => r.id === weeklyRes.id)!;
    const weeklySnapshot = savedWeekly.meta.snapshot as {
      reportMetrics: Record<string, unknown>;
    };
    expect(savedWeekly.meta.knownTotal).toBe(20_000);
    expect(weeklySnapshot.reportMetrics.knownTotal).toBe(20_000);
    expect(savedWeekly.bodyMd).toContain(`Bilinen ödeme yükü: ${reportFmtTL(20_000)}`);

    // 3) Monthly report end-to-end
    const monthlyRes = await generateMonthly(mockPool, "2026-11-01", ACTOR_ID);
    const savedMonthly = savedReports.find((r) => r.id === monthlyRes.id)!;
    const monthlySnapshot = savedMonthly.meta.snapshot as {
      reportMetrics: Record<string, unknown>;
      provenance: {
        confidenceGrade: string;
        workbookStaleDays: number;
        calculationVersion: string;
        monetaryBasisByMetric: Record<string, string>;
        missingMaterialInputs: string[];
      };
    };

    expect(savedMonthly.meta.knownTotal).toBe(510_000);
    expect(savedMonthly.meta.paidKnown).toBe(12_000);
    expect(savedMonthly.meta.knownRemaining).toBe(498_000);
    expect(savedMonthly.meta.cancelledKnownTotal).toBe(30_000);
    expect(savedMonthly.meta.unexplainedGapTry).toBe(0);
    expect(monthlySnapshot.reportMetrics.knownTotal).toBe(savedMonthly.meta.knownTotal);
    expect(monthlySnapshot.reportMetrics.knownRemaining).toBe(savedMonthly.meta.knownRemaining);
    expect(monthlySnapshot.reportMetrics.paidKnown).toBe(savedMonthly.meta.paidKnown);
    expect(monthlySnapshot.provenance.confidenceGrade).toBe("UNVERIFIED_CASH_BASIS");
    // periodEndISO for 2026-11-01 is 2026-11-30 -> 2026-11-30 minus 2026-07-17 = 136 days
    expect(monthlySnapshot.provenance.workbookStaleDays).toBe(136);
    expect(monthlySnapshot.provenance.calculationVersion).toBe(REPORT_CALCULATION_VERSION);
    expect(savedMonthly.bodyMd).toContain("510.000 TL");
    expect(savedMonthly.bodyMd).toContain("498.000 TL");
    expect(savedMonthly.bodyMd).toContain("12.000 TL");
    expect(savedMonthly.bodyMd).toContain("30.000 TL");
    expect(savedMonthly.bodyMd).toContain("-543.764,76 TL");
    expect(savedMonthly.bodyMd).toContain("[UNKNOWN]");
    expect(savedMonthly.bodyMd).toContain("[FORECAST]");

    // 4) Board pack FIN-03 + null DSO consistency
    const boardPack = await loadBoardFinancialPackage(mockPool, "2026-11-18");
    const boardMd = renderBoardPackMarkdown(boardPack);
    expect(boardPack.executiveSummary.consolidatedCashTry).toBeNull();
    expect(boardPack.executiveSummary.worst13WeekCashTry).toBeNull();
    expect(boardPack.executiveSummary.dsoDays).toBeNull();
    expect(boardPack.provenance?.confidenceGrade).toBe("UNVERIFIED_CASH_BASIS");
    expect(boardMd).toContain("UNVERIFIED_CASH_BASIS");
    expect(boardMd).toContain("[UNKNOWN]: Bilinmiyor (FIN-03 açılış eksik)");
    expect(boardMd).toContain("DSO —g");
    expect(boardMd).not.toContain("DSO 0g");
  });
});
