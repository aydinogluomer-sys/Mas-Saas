import { Pool } from "pg";
import { describe, expect, it } from "vitest";

import {
  buildOvernightDeltaAttribution,
  formatOvernightDeltaBridgeMd,
  loadOvernightDeltaAttribution,
} from "@/lib/briefing/delta-attribution";
import {
  briefingStatus,
  buildMorningBriefing,
  headline,
  renderBriefing,
  summariseDay,
  todaysActions,
  type BriefingFacts,
} from "@/lib/briefing/rules";
import type { SourceCompletenessStatus } from "@/lib/contracts/remediation-contracts";
import { readExpectedSchemaManifest } from "@/lib/db/schema-parity";
import { mapInstanceRow, monthSummary } from "@/lib/radar/queries";
import {
  REPORT_CALCULATION_VERSION,
  WORKBOOK_STALE_THRESHOLD_DAYS,
  buildBoardPackExcelBuffer,
  buildStaleDataWatermark,
  evaluateReportContractE,
  loadBoardFinancialPackage,
  loadReportProvenance,
  renderBoardPackMarkdown,
  renderExecutiveReportHtml,
  renderReportCsv,
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
import { readEnvLocal } from "../../scripts/db/app-url";
import { SUBPROCESS_TEST_TIMEOUT_MS } from "../setup/test-timeouts";

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
          return { rows: [{ migration_count: readExpectedSchemaManifest().expectedCount, latest_version: readExpectedSchemaManifest().expectedLatestVersion }], rowCount: 1 };
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
    expect(snapshotContract.schemaVersion).toBe(readExpectedSchemaManifest().expectedLatestVersion);
    expect(snapshotContract.sourceFreshnessDays).toBe(124);
    expect(snapshotContract.confidenceGrade).toBe("UNVERIFIED_CASH_BASIS");
    expect(snapshotContract.contentSha256).toMatch(/^[0-9a-f]{64}$/);

    // Sub-case B: When ONLY an empty or failed workbook exists in DB, valid_workbook_imports returns 0 rows -> workbookStaleDays stays null (NEVER 0)
    const onlyEmptyWorkbookPool = {
      async query(sql: string) {
        const norm = sql.replace(/\s+/g, " ").trim().toLowerCase();
        if (norm.includes("get_schema_ledger_summary")) {
          return { rows: [{ migration_count: readExpectedSchemaManifest().expectedCount, latest_version: readExpectedSchemaManifest().expectedLatestVersion }], rowCount: 1 };
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
        return { rows: [{ migration_count: readExpectedSchemaManifest().expectedCount, latest_version: readExpectedSchemaManifest().expectedLatestVersion }], rowCount: 1 };
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

  it("6. V2 (F-15 / RG-10): never fabricates 0 TL actual cash or realized bank flows when cashSourceStatus is unverified/SCHEMA_INCOMPATIBLE or hasVerifiedBankFeed === false across all 5 builders", async () => {
    const unverifiedStatuses: SourceCompletenessStatus[] = [
      "PARTIAL_MISSING_OPENING",
      "LEGACY_UNVERIFIED",
      "SCHEMA_INCOMPATIBLE",
      "SOURCE_UNAVAILABLE",
    ];

    // (a) buildOvernightDeltaAttribution: asymmetric bankOutflows > 0 with bankInflows = [] while cash is null/unverified MUST NOT fabricate 0 TL realizedBankInflows
    const asymmetricUnknownDelta = buildOvernightDeltaAttribution({
      fromDateISO: "2026-11-17",
      toDateISO: "2026-11-18",
      previousAvailableCash: null,
      currentAvailableCash: null,
      previousLiquidityGap7: null,
      currentLiquidityGap7: null,
      hasVerifiedBankFeed: true,
      bankInflows: [],
      bankOutflows: [
        {
          id: "bt-syn-out-1",
          txnDate: "2026-11-18",
          amount: 50_000,
          description: "Sentetik Banka Çıkışı",
          counterpartyName: "Sentetik Tedarikçi A",
        },
      ],
      newlyEntered7dObligations: [],
      slippedPromisesAndOverdueAr: [],
    });
    expect(asymmetricUnknownDelta.realizedBankInflows).toBeNull();
    expect(asymmetricUnknownDelta.realizedBankOutflows).toBeNull();
    expect(asymmetricUnknownDelta.cashDeltaIdentityBalanced).toBe(false);
    const asymmetricMd = formatOvernightDeltaBridgeMd(asymmetricUnknownDelta);
    expect(asymmetricMd).not.toContain("Tahsilatları (+): 0,00 TL");
    expect(asymmetricMd).not.toContain("Tahsilatları (+): 0 TL");

    // (b) loadOvernightDeltaAttribution on 42P01 / 42703 schema drift marks SCHEMA_INCOMPATIBLE and never emits 0 TL cash or bank flows
    const schemaBrokenClient = {
      async query() {
        throw Object.assign(new Error("relation public.bank_transactions does not exist"), {
          code: "42P01",
        });
      },
    } as unknown as Pool;
    const brokenDelta = await loadOvernightDeltaAttribution(schemaBrokenClient, "2026-11-18", {
      currentAvailableCash: 0,
    });
    expect(brokenDelta.cashSourceStatus).toBe("SCHEMA_INCOMPATIBLE");
    expect(brokenDelta.currentAvailableCash).toBeNull();
    expect(brokenDelta.deltaAvailableCash).toBeNull();
    expect(brokenDelta.realizedBankInflows).toBeNull();
    expect(brokenDelta.realizedBankOutflows).toBeNull();
    expect(brokenDelta.cashDeltaIdentityBalanced).toBe(false);
    expect(formatOvernightDeltaBridgeMd(brokenDelta)).toContain("SCHEMA_INCOMPATIBLE");

    // (c) All 4 unverified statuses across buildDailyReport, buildMonthlyReport, and buildMorningBriefing
    for (const status of unverifiedStatuses) {
      const daily = buildDailyReport(
        {
          dueSoon: [],
          overdue: [],
          maturities: [],
          criticalThreshold: 100_000,
          actualBankCashStatus: {
            availableCashTry: 0,
            unknownOpeningCount: status === "PARTIAL_MISSING_OPENING" ? 2 : 0,
            hasVerifiedBankFeed: false,
            reconciledTxCount: 0,
            unmatchedTxCount: 0,
            cashSourceStatus: status,
          },
        },
        "2026-11-18",
      );
      expect(daily.monetaryBasisByMetric.availableBankCash).toBe("UNKNOWN");
      expect(daily.monetaryBasisByMetric.bankReconciledFlows).toBe("UNKNOWN");
      expect(daily.bodyMd).toContain("[UNKNOWN]");
      expect(daily.bodyMd).not.toContain("[ACTUAL] 0 TL");

      const monthly = buildMonthlyReport({
        monthStart: "2026-11-01",
        knownTotal: 100_000,
        knownRemaining: 100_000,
        paidKnown: 0,
        missingCount: 0,
        totalCount: 1,
        topPayments: [],
        providerDist: [],
        categoryDist: [],
        ownerDist: [],
        checksInMonth: [],
        installmentsInMonth: [],
        cashMonth: null,
        actualBankCashStatus: {
          availableCashTry: 0,
          unknownOpeningCount: status === "PARTIAL_MISSING_OPENING" ? 2 : 0,
          hasVerifiedBankFeed: false,
          reconciledTxCount: 0,
          unmatchedTxCount: 0,
          cashSourceStatus: status,
        },
        dataQualityIssues: [],
      });
      expect(monthly.monetaryBasisByMetric.availableBankCash).toBe("UNKNOWN");
      expect(monthly.monetaryBasisByMetric.bankReconciledFlows).toBe("UNKNOWN");
      expect(monthly.bodyMd).not.toContain("[ACTUAL] 0 TL");

      const briefingMd = buildMorningBriefing({
        todayISO: "2026-11-18",
        availableCash: 0,
        consolidatedCashTry: 0,
        minCashFloor: null,
        liquidityGap7: null,
        liquidityGap30: null,
        projectedContracted7: null,
        todayOutflowKnown: 0,
        todayInflowKnown: 0,
        todayCount: 0,
        todayUnknownAmountCount: 0,
        todayForeignCurrencyCount: 0,
        overdueForeignCurrencyCount: 0,
        overdueCount: 0,
        overdueKnownOutflow: 0,
        criticalControls: [],
        openAlertCount: 0,
        newCriticalAlerts: [],
        promisesDueToday: 0,
        overduePromises: 0,
        dsoDays: null,
        dpoDays: null,
        cycleExcludingInventory: null,
        cashSourceStatus: status,
        hasVerifiedBankFeed: false,
      });
      expect(briefingMd).toContain("Kullanılabilir nakit: — [UNKNOWN]");
      expect(briefingMd).not.toContain("Kullanılabilir nakit: 0 TL");
      expect(briefingMd).not.toContain("Konsolide çok-dövizli nakit: 0 TL");
    }

    // (d) loadBoardFinancialPackage: 0.00 opening balance with NO verified bank feed (last_bt_at = null) or 42P01 schema drift MUST NOT emit 0,00 TL [ACTUAL]
    const unverifiedZeroBoardPool = {
      async query(sql: string) {
        const norm = sql.replace(/\s+/g, " ").trim().toLowerCase();
        if (norm.includes("from public.cash_accounts ca")) {
          return {
            rows: [{ currency: "TRY", bal: "0.00", known_n: 1, unknown_opening_n: 0 }],
            rowCount: 1,
          };
        }
        if (norm.includes("from public.bank_transactions")) {
          return { rows: [{ last_bt_at: null }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
    } as unknown as Pool;
    const unverifiedBoard = await loadBoardFinancialPackage(unverifiedZeroBoardPool, "2026-11-18");
    const unverifiedBoardMd = renderBoardPackMarkdown(unverifiedBoard);
    expect(unverifiedBoard.executiveSummary.consolidatedCashTry).toBeNull();
    expect(unverifiedBoard.provenance?.confidenceGrade).toBe("UNVERIFIED_CASH_BASIS");
    expect(unverifiedBoardMd).not.toContain("[ACTUAL]: 0,00 TL");

    const schemaDriftBoardPool = {
      async query(sql: string) {
        const norm = sql.replace(/\s+/g, " ").trim().toLowerCase();
        if (norm.includes("from public.cash_accounts") || norm.includes("from public.bank_transactions")) {
          throw Object.assign(new Error("relation does not exist"), { code: "42P01" });
        }
        return { rows: [], rowCount: 0 };
      },
    } as unknown as Pool;
    const driftedBoard = await loadBoardFinancialPackage(schemaDriftBoardPool, "2026-11-18");
    expect(driftedBoard.cashSourceStatus).toBe("SCHEMA_INCOMPATIBLE");
    expect(driftedBoard.executiveSummary.consolidatedCashTry).toBeNull();
    expect(renderBoardPackMarkdown(driftedBoard)).toContain("SCHEMA_INCOMPATIBLE");
  });

  it("7. V2 (RG-10): enforces cashDeltaIdentityBalanced === false whenever previous/current cash is null, bank feed is unverified, or cashSourceStatus is unverified", () => {
    const baseInput = {
      fromDateISO: "2026-11-17",
      toDateISO: "2026-11-18",
      previousLiquidityGap7: 0,
      currentLiquidityGap7: 0,
      bankInflows: [],
      bankOutflows: [],
      newlyEntered7dObligations: [],
      slippedPromisesAndOverdueAr: [],
    };

    const prevNull = buildOvernightDeltaAttribution({
      ...baseInput,
      previousAvailableCash: null,
      currentAvailableCash: 100_000,
      hasVerifiedBankFeed: true,
    });
    expect(prevNull.cashDeltaIdentityBalanced).toBe(false);

    const currNull = buildOvernightDeltaAttribution({
      ...baseInput,
      previousAvailableCash: 100_000,
      currentAvailableCash: null,
      hasVerifiedBankFeed: true,
    });
    expect(currNull.cashDeltaIdentityBalanced).toBe(false);

    const noBankFeed = buildOvernightDeltaAttribution({
      ...baseInput,
      previousAvailableCash: 100_000,
      currentAvailableCash: 100_000,
      hasVerifiedBankFeed: false,
    });
    expect(noBankFeed.cashDeltaIdentityBalanced).toBe(false);

    const schemaUnverified = buildOvernightDeltaAttribution({
      ...baseInput,
      previousAvailableCash: 100_000,
      currentAvailableCash: 100_000,
      hasVerifiedBankFeed: true,
      cashSourceStatus: "SCHEMA_INCOMPATIBLE",
    });
    expect(schemaUnverified.cashDeltaIdentityBalanced).toBe(false);

    const verifiedBalanced = buildOvernightDeltaAttribution({
      ...baseInput,
      previousAvailableCash: 100_000,
      currentAvailableCash: 125_000,
      hasVerifiedBankFeed: true,
      bankInflows: [{ id: "in-1", txnDate: "2026-11-18", amount: 40_000 }],
      bankOutflows: [{ id: "out-1", txnDate: "2026-11-18", amount: 15_000 }],
      explicitFxImpact: 0,
    });
    expect(verifiedBalanced.cashDeltaIdentityBalanced).toBe(true);
    expect(verifiedBalanced.cashDeltaIdentityDiff).toBe(0);
  });

  it("8. V2 (F-15 / RG-10): surfaces full epistemic taxonomy, source_id lineage, reconciliationStatus, stale watermark (>45d & null), and deterministic contentSha256 across reports & board package", async () => {
    expect(buildStaleDataWatermark(10, { sourceId: "wb-10" })).toBeNull();
    expect(buildStaleDataWatermark(46, { sourceId: "wb-46" })).toContain("STALE DATA WATERMARK");
    expect(buildStaleDataWatermark(null)).toContain("STALE DATA WATERMARK");

    const makeLineagePool = (wbRow: {
      last_wb_id: string;
      last_wb_at: string;
      last_wb_date: string;
      last_wb_name: string;
    } | null) => {
      const execQuery = async (rawSql: string, params: unknown[] = []) => {
        const sql = rawSql.replace(/\s+/g, " ").trim().toLowerCase();
        if (sql === "begin" || sql === "commit" || sql === "rollback") {
          return { rows: [], rowCount: 0 };
        }
        if (sql.startsWith("insert into public.reports")) {
          return { rows: [{ id: String(params[0]) }], rowCount: 1 };
        }
        if (sql.startsWith("insert into public.audit_logs")) {
          return { rows: [{ id: "audit-1" }], rowCount: 1 };
        }
        if (sql.includes("get_schema_ledger_summary")) {
          return {
            rows: [
              {
                migration_count: readExpectedSchemaManifest().expectedCount,
                latest_version: readExpectedSchemaManifest().expectedLatestVersion,
              },
            ],
            rowCount: 1,
          };
        }
        if (sql.includes("from public.valid_workbook_imports")) {
          return wbRow ? { rows: [wbRow], rowCount: 1 } : { rows: [], rowCount: 0 };
        }
        if (sql.includes("from public.cash_accounts ca")) {
          return {
            rows: [{ currency: "TRY", bal: "250000.00", known_n: 2, unknown_opening_n: 0 }],
            rowCount: 1,
          };
        }
        if (sql.includes("actual_cash_try") && sql.includes("bt_reconciled")) {
          return {
            rows: [
              {
                unknown_opening_n: 0,
                known_opening_n: 2,
                actual_cash_try: "250000.00",
                bt_total: 5,
                bt_reconciled: 5,
                bt_unmatched: 0,
              },
            ],
            rowCount: 1,
          };
        }
        if (sql.includes("from public.cash_accounts")) {
          return { rows: [{ unknown_opening_n: 0, known_opening_n: 2 }], rowCount: 1 };
        }
        if (sql.includes("from public.bank_transactions")) {
          return { rows: [{ last_bt_at: "2026-11-18" }], rowCount: 1 };
        }
        if (sql.includes("known_remaining") && sql.includes("cancelled_known_total")) {
          return {
            rows: [
              {
                known_total: "100000.00",
                known_remaining: "80000.00",
                paid_known: "20000.00",
                missing_count: 0,
                foreign_count: 0,
                total_count: 2,
                cancelled_count: 0,
                cancelled_known_total: "0.00",
                settlement_adjustment_try: "0.00",
                overpayment_adjustment_try: "0.00",
              },
            ],
            rowCount: 1,
          };
        }
        if (sql.includes("no_provider") && sql.includes("no_category")) {
          return { rows: [{ no_provider: 0, no_category: 0 }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      };
      return {
        query: execQuery,
        async connect() {
          return {
            query: execQuery,
            release() {},
          };
        },
      } as unknown as Pool;
    };

    // (a) Stale workbook (> 45d: 124d) with verified cash -> STALE_SOURCE_WARNING + watermark + source_id + deterministic contentSha256
    const stalePool = makeLineagePool({
      last_wb_id: "wb-stale-0124",
      last_wb_at: "2026-07-17T09:00:00Z",
      last_wb_date: "2026-07-17",
      last_wb_name: "synthetic_workbook.xlsx",
    });

    const packA = await loadBoardFinancialPackage(stalePool, "2026-11-18");
    const packB = await loadBoardFinancialPackage(stalePool, "2026-11-18");
    const provA = packA.provenance!;
    const provB = packB.provenance!;

    expect(provA.contentSha256).toBe(provB.contentSha256);
    expect(provA.confidenceGrade).toBe("STALE_SOURCE_WARNING");
    expect(provA.sourceWorkbookId).toBe("wb-stale-0124");
    expect(provA.source_id).toBe("wb-stale-0124");
    expect(provA.latestValidImportAt).toBe("2026-07-17T09:00:00Z");
    expect(provA.businessDateISO).toBe("2026-11-18");
    expect(provA.sourceFreshnessDays).toBe(124);
    expect(provA.reconciliationAligned).toBe(true);
    expect(provA.reconciliationStatus).toBe("ALIGNED");
    expect(provA.staleDataWatermark).toContain("STALE DATA WATERMARK");

    const boardMd = renderBoardPackMarkdown(packA);
    expect(boardMd).toContain("STALE DATA WATERMARK");
    expect(boardMd).toContain("wb-stale-0124");
    expect(boardMd).toContain("ACTUAL");
    expect(boardMd).toContain("RECONCILED");
    expect(boardMd).toContain("PLANNED");
    expect(boardMd).toContain("FORECAST");

    const boardHtml = renderExecutiveReportHtml(
      {
        id: "11111111-1111-4111-8111-111111111111",
        report_type: "strategic",
        period_start: "2026-11-01",
        period_end: "2026-11-18",
        body_md: boardMd,
        created_at: "2026-11-18 09:00",
      },
      packA,
    );
    expect(boardHtml).toContain("STALE DATA WATERMARK");
    expect(boardHtml).toContain("wb-stale-0124");

    const boardCsv = renderReportCsv(packA);
    expect(boardCsv).toContain("wb-stale-0124");
    expect(boardCsv).toContain("STALE DATA WATERMARK");

    const xlsxBuffer = await buildBoardPackExcelBuffer(
      {
        id: "11111111-1111-4111-8111-111111111111",
        report_type: "strategic",
        period_start: "2026-11-01",
        period_end: "2026-11-18",
        body_md: boardMd,
      },
      packA,
    );
    expect(xlsxBuffer.byteLength).toBeGreaterThan(1_000);

    const genMonthly = await generateMonthly(stalePool, "2026-11-01", ACTOR_ID);
    expect(genMonthly.bodyMd).toContain("STALE DATA WATERMARK");
    expect(genMonthly.bodyMd).toContain("wb-stale-0124");
    expect(genMonthly.bodyMd).toContain("STALE_SOURCE_WARNING");

    // (b) Missing workbook (sourceFreshnessDays === null) -> explicit stale watermark emitted
    const nullWbPool = makeLineagePool(null);
    const nullWbPack = await loadBoardFinancialPackage(nullWbPool, "2026-11-18");
    expect(nullWbPack.provenance?.sourceFreshnessDays).toBeNull();
    expect(nullWbPack.provenance?.staleDataWatermark).toContain("STALE DATA WATERMARK");
    expect(renderBoardPackMarkdown(nullWbPack)).toContain("STALE DATA WATERMARK");

    // (c) Fresh workbook (10d <= 45d) -> staleDataWatermark is null and NOT emitted
    const freshPool = makeLineagePool({
      last_wb_id: "wb-fresh-0010",
      last_wb_at: "2026-11-08T09:00:00Z",
      last_wb_date: "2026-11-08",
      last_wb_name: "fresh_workbook.xlsx",
    });
    const freshPack = await loadBoardFinancialPackage(freshPool, "2026-11-18");
    expect(freshPack.provenance?.sourceFreshnessDays).toBe(10);
    expect(freshPack.provenance?.confidenceGrade).toBe("VERIFIED_COMPLETE");
    expect(freshPack.provenance?.staleDataWatermark).toBeNull();
    expect(renderBoardPackMarkdown(freshPack)).not.toContain("STALE DATA WATERMARK");
  });

  it("9. V2 (RG-04 / RG-05): preserves 30,000 TRY cancelled obligation separate from active exposure and partial tri-value in buildDailyReport & buildMonthlyReport", () => {
    const partialObligation: ReportInstance = {
      name: "Sentetik Kredi Taksiti",
      dueDate: "2026-11-18",
      amount: 30_000,
      originalAmount: 30_000,
      paidAmount: 10_000,
      outstandingAmount: 20_000,
      status: "partial",
      riskLevel: "high",
      riskReasons: [],
      currency: "TRY",
    };
    const cancelledObligation30k: ReportInstance = {
      name: "İptal Edilen Tedarik Ödemesi",
      dueDate: "2026-11-18",
      amount: 30_000,
      originalAmount: 30_000,
      paidAmount: 0,
      status: "cancelled",
      riskLevel: "none",
      riskReasons: [],
      currency: "TRY",
    };

    const daily = buildDailyReport(
      {
        dueSoon: [partialObligation, cancelledObligation30k],
        overdue: [],
        maturities: [],
        criticalThreshold: 50_000,
      },
      "2026-11-18",
    );

    expect(daily.dueToday).toHaveLength(1);
    expect(daily.next7KnownTotal).toBe(20_000);
    expect(daily.cancelledCount).toBe(1);
    expect(daily.cancelledKnownTotal).toBe(30_000);
    expect(daily.bodyMd).toContain("kalan 20.000 TL (asıl: 30.000 TL · ödenen: 10.000 TL)");
    expect(daily.bodyMd).toContain("İptal edilen (toplam dışı): 1 kalem · 30.000 TL");
    expect(daily.bodyMd).not.toContain("İptal Edilen Tedarik Ödemesi · 0 TL");
  });
});

function resolveOptionalReadOnlyUrl(): string {
  let fileEnv: Record<string, string> = {};
  try {
    fileEnv = readEnvLocal();
  } catch {
    // Disposable static CI has no .env.local
  }
  return (
    process.env.MIGRATION_DATABASE_URL?.trim() ||
    fileEnv.MIGRATION_DATABASE_URL?.trim() ||
    process.env.DATABASE_URL?.trim() ||
    fileEnv.DATABASE_URL?.trim() ||
    ""
  );
}

const optionalRoUrl = resolveOptionalReadOnlyUrl();

describe.runIf(Boolean(optionalRoUrl))(
  "Agent 08 — Live Read-Only RG-10 & Zero-Mutation Verification (default_transaction_read_only=on)",
  () => {
    it(
      "10. verifies RG-10 board-pack provenance lineage, reproducible contentSha256, 30k cancelled obligation, and 0 DB mutations on read-only connection",
      async () => {
        const roPool = new Pool({
          connectionString: optionalRoUrl,
          max: 4,
          connectionTimeoutMillis: 30_000,
          options: "-c default_transaction_read_only=on",
        });
        try {
          const roCheck = await roPool.query<{ transaction_read_only: string }>(
            "SHOW transaction_read_only",
          );
          expect(roCheck.rows[0]?.transaction_read_only).toBe("on");

          const readDigest = async () => {
            const res = await roPool.query<{
              rep_cnt: number;
              aud_cnt: number;
              pi_cnt: number;
              pi_sum: string;
              bt_cnt: number;
            }>(`
              select
                (select count(*)::int from public.reports) as rep_cnt,
                (select count(*)::int from public.audit_logs) as aud_cnt,
                (select count(*)::int from public.payment_instances) as pi_cnt,
                (select coalesce(sum(amount), 0)::numeric(16,2)::text from public.payment_instances) as pi_sum,
                (select count(*)::int from public.bank_transactions) as bt_cnt
            `);
            return res.rows[0]!;
          };

          const before = await readDigest();

          const packA = await loadBoardFinancialPackage(roPool, "2026-11-18");
          const packB = await loadBoardFinancialPackage(roPool, "2026-11-18");
          const [novSummary, liveDelta] = await Promise.all([
            monthSummary(roPool, "2026-11-01"),
            loadOvernightDeltaAttribution(roPool, "2026-11-18"),
          ]);

          expect(packA.executiveSummary.consolidatedCashTry).toBeNull();
          expect(packA.provenance).toBeDefined();
          expect(packA.provenance?.contentSha256).toMatch(/^[0-9a-f]{64}$/);
          expect(packA.provenance?.contentSha256).toBe(packB.provenance?.contentSha256);
          expect(packA.provenance?.confidenceGrade).toBe("UNVERIFIED_CASH_BASIS");
          expect(packA.provenance?.businessDateISO).toBe("2026-11-18");
          expect(typeof packA.provenance?.source_id).toBe("string");
          expect((packA.provenance?.source_id ?? "").length).toBeGreaterThan(0);
          expect(packA.provenance?.staleDataWatermark).toContain("STALE DATA WATERMARK");

          const md = renderBoardPackMarkdown(packA);
          expect(md).toContain("STALE DATA WATERMARK");
          expect(md).not.toContain("[ACTUAL]: 0,00 TL");

          expect(novSummary.cancelledKnownTotal).toBe(30_000);
          expect(novSummary.unexplainedGapTry).toBe(0);

          expect(liveDelta.currentAvailableCash).toBeNull();
          expect(liveDelta.realizedBankInflows).toBeNull();
          expect(liveDelta.realizedBankOutflows).toBeNull();
          expect(liveDelta.cashDeltaIdentityBalanced).toBe(false);

          const after = await readDigest();
          expect(after).toEqual(before);
        } finally {
          await roPool.end();
        }
      },
      SUBPROCESS_TEST_TIMEOUT_MS,
    );
  },
);
