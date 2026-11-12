import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { cashBridge, varianceDecomposition } from "@/lib/analytics/analyses";
import { rollingWindow } from "@/lib/analytics/periods";
import { resolveSignedAmount, scoreMatch } from "@/lib/bank/rules";
import { briefingStatus, headline } from "@/lib/briefing/rules";
import {
  getTurkishHoliday,
  isTurkishHoliday,
  listTurkishHolidaysForYear,
  nextTurkishBusinessDay,
} from "@/lib/calendar/tr-holidays";
import {
  generateTrStatutoryObligations,
  generateTrStatutoryObligationsForYear,
} from "@/lib/calendar/tr-tax-calendar";
import {
  computeDbtPercentileDays,
  expectedCollectionDateV2,
  type CollectionSignalsV2,
} from "@/lib/collections/rules";
import { computeForwardCashRunway } from "@/lib/facts/engine";
import { addMonthsPreservingAnchorDay, scheduleDueDates } from "@/lib/financing/rules";
import { parseTcmbBulletinDate, parseTcmbXml } from "@/lib/fx/rules";
import { optimize, UNKNOWN_OPENING_CASH_HALT_REASON } from "@/lib/optimization/rules";
import {
  buildDailyReport,
  buildMonthlyReport,
  buildWeeklyReport,
  overlayDebtService,
} from "@/lib/reports/rules";
import { liquidityHorizons } from "@/lib/treasury/rules";

describe("Faz 46 (C3) — 5-Tier Deterministic Behavioral Collection Date (expectedCollectionDateV2)", () => {
  const baseSignals: CollectionSignalsV2 = {
    issueDate: "2026-01-01",
    dueDate: "2026-02-01",
    daysOverdue: 9,
    openAmount: 150_000,
    partySettledCount: 0,
    partyAvgDaysToSettle: null,
    partyLateRatio: null,
    partyInvoiceCount: 1,
    partiallySettled: false,
    badDebtFlagged: false,
    activePromiseDate: null,
    partyDbtSamples: [],
  };

  it("Tier 1: excludes bad-debt flagged receivables from 7d/30d projected inflows even when promised", () => {
    const res = expectedCollectionDateV2(
      {
        ...baseSignals,
        badDebtFlagged: true,
        activePromiseDate: "2026-02-12",
        partyDbtSamples: [5, 7, 10],
      },
      "2026-02-10",
    );
    expect(res.bucket).toBe("doubtful_excluded");
    expect(res.projectedDate).toBeNull();
    expect(res.daysFromToday).toBeNull();
    expect(res.basis).toBe("bad_debt_excluded");
  });

  it("Tier 2: honors active unbroken promise_to_pay >= todayISO ahead of historical DBT", () => {
    const res = expectedCollectionDateV2(
      {
        ...baseSignals,
        dueDate: "2026-01-15",
        activePromiseDate: "2026-02-18",
        partyDbtSamples: [10, 12, 15],
      },
      "2026-02-10",
    );
    expect(res.bucket).toBe("promised");
    expect(res.projectedDate).toBe("2026-02-18");
    expect(res.daysFromToday).toBe(8);
    expect(res.basis).toBe("active_promise");
  });

  it("Tier 3: projects dueDate + median/P75 DBT when >= 3 settled invoice samples exist and date >= todayISO", () => {
    const samples = [4, 14, 15, 16, 40]; // sorted: median = 15, P75 = 16
    const medianRes = expectedCollectionDateV2(
      {
        ...baseSignals,
        dueDate: "2026-02-01",
        partyDbtSamples: samples,
      },
      "2026-02-10",
      { mode: "median" },
    );
    expect(medianRes.bucket).toBe("behavioral_dbt");
    expect(medianRes.basis).toBe("behavioral_dbt_median");
    expect(medianRes.appliedDbtDays).toBe(15);
    expect(medianRes.projectedDate).toBe("2026-02-16");

    const p75Res = expectedCollectionDateV2(
      {
        ...baseSignals,
        dueDate: "2026-02-01",
        partyDbtSamples: samples,
      },
      "2026-02-10",
      { mode: "p75" },
    );
    expect(p75Res.bucket).toBe("behavioral_dbt");
    expect(p75Res.basis).toBe("behavioral_dbt_p75");
    expect(p75Res.appliedDbtDays).toBe(16);
    expect(p75Res.projectedDate).toBe("2026-02-17");

    // Fewer than 3 samples cannot fabricate behavioral DBT
    expect(computeDbtPercentileDays([10, 20])).toBeNull();
  });

  it("Tier 4: schedules unmatured invoices at dueDate + defaultLagDays", () => {
    const res = expectedCollectionDateV2(
      {
        ...baseSignals,
        dueDate: "2026-02-20",
      },
      "2026-02-10",
      { defaultLagDays: 3 },
    );
    expect(res.bucket).toBe("scheduled");
    expect(res.basis).toBe("scheduled_due_date");
    expect(res.projectedDate).toBe("2026-02-23");
    expect(res.daysFromToday).toBe(13);
  });

  it("Tier 5: eliminates the 'Today Cliff' — overdue receivables past expected date never pile onto todayISO", () => {
    const res = expectedCollectionDateV2(
      {
        ...baseSignals,
        dueDate: "2025-11-15",
        activePromiseDate: "2026-01-05", // broken/expired promise (< todayISO)
        partyDbtSamples: [5, 7, 10], // 2025-11-22 is still < todayISO
      },
      "2026-02-10",
    );
    expect(res.bucket).toBe("overdue_unscheduled");
    expect(res.basis).toBe("overdue_unscheduled");
    expect(res.projectedDate).toBeNull();
    expect(res.expectedDate).toBeNull();
    expect(res.daysFromToday).toBeNull();
  });
});

describe("Faz 46 (C3) — Live TCMB XML Bulletin Date & Rate Parser", () => {
  const REAL_TCMB_XML = `<?xml version="1.0" encoding="UTF-8"?>
<Tarih_Date Tarih="21.08.2026" Date="08/21/2026" Bulten_No="2026/160">
  <Currency CrossOrder="0" Kod="USD" CurrencyCode="USD">
    <Unit>1</Unit>
    <Isim>ABD DOLARI</Isim>
    <ForexBuying>34.1200</ForexBuying>
    <ForexSelling>34.1815</ForexSelling>
    <BanknoteBuying>34.0950</BanknoteBuying>
    <BanknoteSelling>34.2300</BanknoteSelling>
  </Currency>
  <Currency CrossOrder="4" Kod="JPY" CurrencyCode="JPY">
    <Unit>100</Unit>
    <Isim>JAPON YENI</Isim>
    <ForexBuying>23.1000</ForexBuying>
    <ForexSelling>23.2500</ForexSelling>
    <BanknoteBuying/>
    <BanknoteSelling/>
  </Currency>
</Tarih_Date>`;

  it("extracts bulletin_date from real TCMB Tarih='DD.MM.YYYY' and falls back to US Date='MM/DD/YYYY'", () => {
    expect(parseTcmbBulletinDate(REAL_TCMB_XML)).toBe("2026-08-21");
    expect(
      parseTcmbBulletinDate(`<Tarih_Date Date="08/21/2026" Bulten_No="2026/160"></Tarih_Date>`),
    ).toBe("2026-08-21");
    expect(parseTcmbBulletinDate(`<Tarih_Date Tarih="32.13.2026"></Tarih_Date>`)).toBeNull();
  });

  it("normalizes per-unit rates (Unit=100) and keeps empty banknote tags null rather than 0", () => {
    const parsed = parseTcmbXml(REAL_TCMB_XML);
    const usd = parsed.find((r) => r.baseCurrency === "USD");
    const jpy = parsed.find((r) => r.baseCurrency === "JPY");
    expect(usd?.rate).toBe(34.1815);
    expect(jpy?.rate).toBe(0.2325);
    expect(jpy?.banknoteBuying).toBeNull();
    expect(jpy?.banknoteSelling).toBeNull();
  });
});

describe("Faz 46 (C3) — Anchor-Preserving 36-Month Loan Schedule (Jan 31 Start)", () => {
  it("clamps Feb 2026 to 28, restores Mar 31 & Apr 30, and handles leap-year Feb 29 in 2028", () => {
    const schedule = scheduleDueDates("2026-01-31", 36);
    expect(schedule).toHaveLength(36);
    expect(schedule[0]).toEqual({ no: 1, dueDate: "2026-01-31", shortMonthAdjusted: false });
    expect(schedule[1]).toEqual({ no: 2, dueDate: "2026-02-28", shortMonthAdjusted: true });
    expect(schedule[2]).toEqual({ no: 3, dueDate: "2026-03-31", shortMonthAdjusted: false });
    expect(schedule[3]).toEqual({ no: 4, dueDate: "2026-04-30", shortMonthAdjusted: true });
    expect(schedule[4]).toEqual({ no: 5, dueDate: "2026-05-31", shortMonthAdjusted: false });
    // Installment #26 = Jan 2026 + 25 months = Feb 2028 (leap year -> 29!)
    expect(schedule[25]).toEqual({ no: 26, dueDate: "2028-02-29", shortMonthAdjusted: true });
    expect(schedule[26]).toEqual({ no: 27, dueDate: "2028-03-31", shortMonthAdjusted: false });
    expect(addMonthsPreservingAnchorDay("2026-01-31", 13).dueDate).toBe("2027-02-28");
    expect(addMonthsPreservingAnchorDay("2026-01-31", 14).dueDate).toBe("2027-03-31");
  });
});

describe("Faz 46 (C3) — Treasury Intra-Horizon Floor Breach Detection", () => {
  it("flags a Day-3 default (-20) even when Day-5 inflow recovers horizon-end balance above floor", () => {
    const [h7] = liquidityHorizons({
      openingPosition: 100_000,
      minCashFloor: 50_000,
      todayISO: "2026-03-01",
      horizons: [7],
      flows: [
        { flowDate: "2026-03-03", amountSigned: -120_000, certainty: "contracted" }, // Day-3 balance = -20_000!
        { flowDate: "2026-03-05", amountSigned: 200_000, certainty: "contracted" }, // Day-5 balance = +180_000
      ],
    });
    expect(h7.projectedContracted).toBe(180_000);
    expect(h7.minIntraHorizonBalance).toBe(-20_000);
    expect(h7.worstDayISO).toBe("2026-03-03");
    expect(h7.breachesFloor).toBe(true);
    expect(h7.financingNeed).toBe(70_000); // 50_000 floor - (-20_000 worst day) = 70_000
  });
});

describe("Faz 46 (C3) — Liquidity Optimization Solver Objectives & FIN-03 Null Opening Halt", () => {
  it("halts cleanly without inventing 0 opening cash when openingCash is null (FIN-03)", () => {
    const res = optimize({
      objective: "min_financing_cost",
      anchorDate: "2026-04-01",
      horizonDays: 14,
      openingCash: null,
      minCashFloor: 50_000,
      inflows: [{ date: "2026-04-05", amount: 100_000 }],
      payments: [
        {
          id: "pay-1",
          label: "Tedarikçi A",
          dueDate: "2026-04-02",
          amount: 80_000,
          hardDeadline: false,
        },
      ],
      facilities: [{ id: "fac-1", label: "KMH", available: 500_000, interestRate: 0.48 }],
    });
    expect(res.recommendations).toEqual([]);
    expect(res.haltedReason).toBe(UNKNOWN_OPENING_CASH_HALT_REASON);
  });

  it("applies distinct deterministic strategies across min_late_payment, min_financing_cost, and max_liquidity_buffer", () => {
    const common = {
      anchorDate: "2026-04-01",
      horizonDays: 10,
      openingCash: 80_000,
      minCashFloor: 50_000,
      inflows: [{ date: "2026-04-08", amount: 150_000 }],
      payments: [
        {
          id: "soft-small",
          label: "Küçük Fatura",
          dueDate: "2026-04-02",
          amount: 25_000,
          hardDeadline: false,
          subjectTable: "invoices" as const,
        },
        {
          id: "soft-large",
          label: "Büyük Fatura",
          dueDate: "2026-04-02",
          amount: 75_000,
          hardDeadline: false,
          subjectTable: "payment_instances" as const,
        },
        {
          id: "hard-check",
          label: "Çek #901",
          dueDate: "2026-04-02",
          amount: 10_000,
          hardDeadline: true,
          subjectTable: "checks" as const,
        },
      ],
      facilities: [{ id: "fac-1", label: "BCH Kredisi", available: 200_000, interestRate: 0.42 }],
    };

    const maxBuffer = optimize({ ...common, objective: "max_liquidity_buffer" });
    const minCost = optimize({ ...common, objective: "min_financing_cost" });
    const minLate = optimize({ ...common, objective: "min_late_payment" });

    // Hard check is NEVER deferred in any objective
    for (const r of [maxBuffer, minCost, minLate]) {
      expect(
        r.recommendations.some((rec) => rec.actionKind === "defer_payment" && rec.subjectId === "hard-check"),
      ).toBe(false);
    }

    // max_liquidity_buffer defers largest soft payment first
    const maxBufferDeferrals = maxBuffer.recommendations.filter((r) => r.actionKind === "defer_payment");
    expect(maxBufferDeferrals[0]?.subjectId).toBe("soft-large");

    // min_financing_cost defers smallest soft payment first before touching interest-bearing facility
    const minCostDeferrals = minCost.recommendations.filter((r) => r.actionKind === "defer_payment");
    expect(minCostDeferrals[0]?.subjectId).toBe("soft-small");

    // min_late_payment draws credit facility FIRST so supplier deferrals are avoided when headroom suffices
    expect(minLate.recommendations[0]?.actionKind).toBe("draw_facility");
    expect(minLate.recommendations.filter((r) => r.actionKind === "defer_payment")).toHaveLength(0);
  });
});

describe("Faz 46 (C3) — Bank Matcher Sign/Currency Guard, Zero Preservation & Dynamic Scenarios", () => {
  it("preserves explicit 0,00 debit/credit statement lines as '0' while keeping blank lines null", () => {
    expect(resolveSignedAmount({ debit: "0,00", credit: "" })).toBe("0");
    expect(resolveSignedAmount({ debit: "", credit: "0.00" })).toBe("0");
    expect(resolveSignedAmount({ debit: "", credit: "", amount: "" })).toBeNull();
  });

  it("rejects opposite-sign and cross-currency bank match candidates with confidence 0", () => {
    const outflowTarget = {
      table: "invoices" as const,
      id: "inv-purchase-1",
      amount: 50_000,
      dueDate: "2026-03-10",
      label: "Atlas Makina Sanayi",
      direction: "outflow" as const,
      currency: "TRY",
    };

    // Incoming +50,000 TRY cannot match an outflow purchase invoice!
    const wrongDirection = scoreMatch(
      {
        amount: 50_000,
        txnDate: "2026-03-10",
        description: "Atlas Makina Sanayi",
        counterparty: "Atlas Makina Sanayi",
        currency: "TRY",
      },
      outflowTarget,
    );
    expect(wrongDirection.confidence).toBe(0);
    expect(wrongDirection.reasons).toContain("direction_mismatch");

    // Outgoing -50,000 USD cannot match a TRY purchase invoice!
    const wrongCurrency = scoreMatch(
      {
        amount: -50_000,
        txnDate: "2026-03-10",
        description: "Atlas Makina Sanayi",
        counterparty: "Atlas Makina Sanayi",
        currency: "USD",
      },
      outflowTarget,
    );
    expect(wrongCurrency.confidence).toBe(0);
    expect(wrongCurrency.reasons).toContain("currency_mismatch");

    // Outgoing -50,000 TRY matches cleanly (0.55 exact amount + 0.15 same day + 0.15 strong label = 0.85)
    const validMatch = scoreMatch(
      {
        amount: -50_000,
        txnDate: "2026-03-10",
        description: "Atlas Makina Sanayi",
        counterparty: "Atlas Makina Sanayi",
        currency: "TRY",
      },
      outflowTarget,
    );
    expect(validMatch.confidence).toBeCloseTo(0.85, 4);
  });

  it("removes hardcoded 'Cagdas' and 'Hpt' strings from scenario engine & rules", () => {
    const engineSrc = readFileSync(
      path.join(process.cwd(), "src/lib/scenarios/engine.ts"),
      "utf8",
    );
    const rulesSrc = readFileSync(
      path.join(process.cwd(), "src/lib/scenarios/rules.ts"),
      "utf8",
    );
    expect(engineSrc).not.toMatch(/cagdas|çağdaş|\bhpt\b/i);
    expect(rulesSrc).not.toMatch(/cagdas|çağdaş|\bhpt\b/i);
  });
});

describe("Faz 46 (C3) — Briefing, Analytics, Reports & Forward Cash Runway", () => {
  it("reports warning headline when 7-day liquidity gap is null instead of false all-clear", () => {
    const h = headline({
      todayISO: "2026-03-10",
      availableCash: null,
      minCashFloor: 50_000,
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
    });
    expect(h.tone).toBe("warn");
    expect(h.text).toContain("7 günlük likidite açığı hesaplanamadı");
    expect(briefingStatus({ criticalControls: [], liquidityGap7: null }).tone).toBe("neutral");
  });

  it("marks cashBridge as incomplete_unknown_lines when movement lines contain null values", () => {
    const partialBridge = cashBridge({
      startLabel: "2026-05 açılış",
      startValue: 100_000,
      endLabel: "2026-05 kapanış",
      reportedEndValue: 120_000,
      movements: [
        { key: "2026-05-in", label: "Gelir", value: 80_000 },
        { key: "2026-05-out", label: "Gider", value: null },
      ],
    });
    expect(partialBridge.unknownCount).toBe(1);
    expect(partialBridge.reconciles).toBeNull();
    expect(partialBridge.difference).toBeNull();
    expect(partialBridge.reconciliationStatus).toBe("incomplete_unknown_lines");

    // Exact decimal arithmetic: 0.1 + 0.2 has zero float tail
    const exactVar = varianceDecomposition([{ key: "k", label: "K", budget: 0.1, actual: 0.3 }]);
    expect(exactVar.rows[0]?.value).toBe(0.2);
    const exactRoll = rollingWindow(
      [
        { key: "2026-03-01", value: 0.1 },
        { key: "2026-03-02", value: 0.2 },
      ],
      7,
      "sum",
    );
    expect(exactRoll[1]?.value).toBe(0.3);
  });

  it("distinguishes healthy ('none'), 'watch', and 'high' in overlayDebtService and excludes inflow checks from debt service", () => {
    const overlay = overlayDebtService(
      [
        { monthStart: "2026-05-01", closing: 500_000 }, // 10k / 500k = 2% <= 25% -> none
        { monthStart: "2026-06-01", closing: 200_000 }, // 90k / 200k = 45% (>25%, <=75%) -> watch
        { monthStart: "2026-07-01", closing: 200_000 }, // 180k / 200k = 90% (>75%) -> high
        { monthStart: "2026-08-01", closing: -10_000 }, // negative closing -> high
      ],
      [
        { monthStart: "2026-05-01", knownOutflow: 10_000, count: 1, missingCount: 0 },
        { monthStart: "2026-06-01", knownOutflow: 90_000, count: 1, missingCount: 0 },
        { monthStart: "2026-07-01", knownOutflow: 180_000, count: 1, missingCount: 0 },
        { monthStart: "2026-08-01", knownOutflow: 20_000, count: 1, missingCount: 0 },
      ],
    );
    expect(overlay.map((r) => r.pressure)).toEqual(["none", "watch", "high", "high"]);

    const inflowCheck = {
      label: "Müşteri Çeki",
      dueDate: "2026-07-08",
      amount: 95_000,
      direction: "inflow" as const,
      kind: "check" as const,
    };
    const outflowCheck = {
      label: "Tedarikçi Çeki",
      dueDate: "2026-07-09",
      amount: 40_000,
      direction: "outflow" as const,
      kind: "check" as const,
    };

    const daily = buildDailyReport(
      { dueSoon: [], overdue: [], maturities: [inflowCheck, outflowCheck], criticalThreshold: 100_000 },
      "2026-07-06",
    );
    expect(daily.checksNext7).toHaveLength(1);
    expect(daily.checksNext7[0]?.amount).toBe(40_000);

    const weekly = buildWeeklyReport(
      {
        weekInstances: [],
        maturitiesWeek: [inflowCheck, outflowCheck],
        installmentsMonth: [],
        riskDays: [],
        largeThreshold: 50_000,
      },
      "2026-07-06",
    );
    expect(weekly.checkLoad).toBe(40_000);

    const monthly = buildMonthlyReport({
      monthStart: "2026-07-01",
      knownTotal: 40_000,
      knownRemaining: 40_000,
      paidKnown: 0,
      missingCount: 0,
      totalCount: 1,
      topPayments: [],
      providerDist: [],
      categoryDist: [],
      ownerDist: [],
      checksInMonth: [inflowCheck, outflowCheck],
      installmentsInMonth: [],
      cashMonth: null,
      dataQualityIssues: [],
    });
    expect(monthly.debtServiceKnown).toBe(40_000);
  });

  it("computes cash_runway strictly over forward months >= todayMonthStart, ignoring historical negative months", () => {
    const months = [
      { monthStart: "2025-11-01", closing: -80_000 }, // historical negative!
      { monthStart: "2026-03-01", closing: 150_000 }, // anchorMonth
      { monthStart: "2026-04-01", closing: 120_000 },
      { monthStart: "2026-05-01", closing: 90_000 },
      { monthStart: "2026-06-01", closing: -15_000 }, // 3 months ahead of 2026-03-01
    ];
    const runway = computeForwardCashRunway(months, "2026-03-01");
    expect(runway.runwayMonths).toBe(3);
    expect(runway.firstForwardNegativeMonth).toBe("2026-06-01");
    expect(runway.value).toBe("3 ay");
  });
});

describe("Faz 46 (C3) — VUK Md. 18 Turkish Holiday Roll-Forward & Statutory Tax/SGK Calendar", () => {
  it("shifts weekends, national holidays, and Ramazan/Kurban Bayramı + Arife to the first Turkish business day", () => {
    // 2026-03-19 is Thursday (Ramazan Bayramı Arifesi), Mar 20-22 is Ramazan Bayramı -> Monday 2026-03-23!
    const ramazanShift = nextTurkishBusinessDay("2026-03-19");
    expect(ramazanShift.effectiveDate).toBe("2026-03-23");
    expect(ramazanShift.shiftedFrom).toBe("2026-03-19");
    expect(ramazanShift.reason).toContain("VUK Md. 18");

    // 2026-05-26 is Tuesday (Kurban Bayramı Arifesi), May 27-30 is Kurban Bayramı, May 31 is Sunday -> Monday 2026-06-01!
    const kurbanShift = nextTurkishBusinessDay("2026-05-26");
    expect(kurbanShift.effectiveDate).toBe("2026-06-01");

    // 2026-10-28 (Cumhuriyet Bayramı Arifesi, Wed) + 2026-10-29 (Cumhuriyet Bayramı, Thu) -> Friday 2026-10-30!
    expect(nextTurkishBusinessDay("2026-10-28").effectiveDate).toBe("2026-10-30");

    // Normal business weekday stays unshifted
    expect(nextTurkishBusinessDay("2026-04-15")).toEqual({
      effectiveDate: "2026-04-15",
      shiftedFrom: null,
      reason: null,
    });

    // Overlap check: 2029-04-23 is both 23 Nisan (full-day national) and Kurban Bayramı Arifesi (half-day)
    const overlap = getTurkishHoliday("2029-04-23");
    expect(overlap?.halfDay).toBe(false);
    expect(isTurkishHoliday("2026-08-30")).toBe(true);
    expect(listTurkishHolidaysForYear(2026).length).toBeGreaterThanOrEqual(15);
  });

  it("generates all 4 periods of Kurumlar Geçici Vergi (Law No. 7566), rolls deadlines via VUK Md. 18, and NEVER generates abolished BA/BS", () => {
    const items = generateTrStatutoryObligations("2026-01-01", "2027-03-01");

    // Zero BA/BS forms anywhere
    expect(items.some((i) => /\bba\b|\bbs\b|ba\/bs|form ba|form bs/i.test(`${i.code} ${i.label}`))).toBe(false);

    // All 4 quarters of 2026 Kurumlar Geçici Vergi exist (May 17, Aug 17, Nov 17, and Feb 17 2027)
    const gecici2026 = items.filter(
      (i) => i.code === "KURUMLAR_GECICI_VERGI" && i.taxPeriod.startsWith("2026-Q"),
    );
    expect(gecici2026.map((i) => i.taxPeriod)).toEqual([
      "2026-Q1",
      "2026-Q2",
      "2026-Q3",
      "2026-Q4",
    ]);
    // 2026-05-17 is Sunday -> rolled to Monday 2026-05-18!
    expect(gecici2026[0]?.statutoryNominalDate).toBe("2026-05-17");
    expect(gecici2026[0]?.effectiveDueDate).toBe("2026-05-18");
    // Q4 nominal date is 2027-02-17 (Wednesday -> unshifted 2027-02-17)
    expect(gecici2026[3]?.statutoryNominalDate).toBe("2027-02-17");
    expect(gecici2026[3]?.effectiveDueDate).toBe("2027-02-17");

    // April 2026 MPHB (nominal 2026-05-26 = Kurban Bayramı Arifesi!) & KDV-1 (2026-05-28) & SGK (2026-05-31) all roll to 2026-06-01!
    const apr2026Mphb = items.find((i) => i.code === "MPHB" && i.taxPeriod === "2026-04");
    const apr2026Kdv1 = items.find((i) => i.code === "KDV_1" && i.taxPeriod === "2026-04");
    const apr2026Sgk = items.find((i) => i.code === "SGK_4A" && i.taxPeriod === "2026-04");
    expect(apr2026Mphb?.effectiveDueDate).toBe("2026-06-01");
    expect(apr2026Kdv1?.effectiveDueDate).toBe("2026-06-01");
    expect(apr2026Sgk?.effectiveDueDate).toBe("2026-06-01");

    // MTV 1st & 2nd installments and Annual Kurumlar Vergisi exist in calendar year 2026
    const y2026 = generateTrStatutoryObligationsForYear(2026);
    expect(y2026.some((i) => i.code === "MTV_TAKSIT_1")).toBe(true);
    expect(y2026.some((i) => i.code === "MTV_TAKSIT_2")).toBe(true);
    expect(y2026.some((i) => i.code === "KURUMLAR_VERGISI_YILLIK")).toBe(true);
  });
});
