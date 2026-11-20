import { describe, expect, it } from "vitest";
import {
  CHRONIC_HISTORICAL_OVERDUE_DAYS,
  ESCALATION_BUCKET_LABELS,
  bucketToCanonicalStage,
  buildReminderDigestHtml,
  buildReminderMessage,
  classifyEscalationBucket,
  containsUnsubstantiatedLegalClaim,
  daysOverdue,
  eligibleDeliveries,
  evaluateEscalationDecision,
  formatRiskReasonTr,
  isChronicHistoricalOverdue,
  isEligible,
  isOpenObligationStatus,
  isValidISODate,
  matchesReminderOffset,
  resolveReminderAmounts,
  sanitizeReminderLegalWording,
  scheduledForDate,
  stageForOverdueDays,
  thresholdPasses,
  type ReminderRule,
  type ReminderTarget,
} from "@/lib/reminders/rules";
import { istanbulDateISO } from "@/lib/time/istanbul";

const ALL_STANDARD_RULES: ReminderRule[] = [
  { id: "r-plus-3", name: "3 Gün Sonra", targetKind: "payment_instance", offsetDays: 3, channel: "telegram", minAmount: null, isActive: true },
  { id: "r-plus-1", name: "Yarın Ödeme", targetKind: "payment_instance", offsetDays: 1, channel: "telegram", minAmount: null, isActive: true },
  { id: "r-due-0", name: "Bugün Ödeme", targetKind: "payment_instance", offsetDays: 0, channel: "telegram", minAmount: null, isActive: true },
  { id: "r-late-1", name: "1-7 Gün Gecikmiş", targetKind: "payment_instance", offsetDays: -1, channel: "telegram", minAmount: null, isActive: true },
  { id: "r-late-8", name: "8-30 Gün İhtar", targetKind: "payment_instance", offsetDays: -8, channel: "telegram", minAmount: null, isActive: true },
  { id: "r-late-31", name: "31+ Gün Üst Eskalasyon", targetKind: "payment_instance", offsetDays: -31, channel: "telegram", minAmount: null, isActive: true },
];

function makeTarget(overrides: Partial<ReminderTarget> = {}): ReminderTarget {
  return {
    entityTable: "payment_instances",
    entityId: "00000000-0000-4000-8000-000000000505",
    name: "MAS Tedarik Ödemesi",
    dueDate: "2026-11-18",
    amount: 50_000,
    status: "unpaid",
    owner: "MAS",
    provider: "Vakıfbank",
    riskReasons: [],
    ...overrides,
  };
}

describe("Agent 05 — Temporal Rules & Escalation Engine (Phase D)", () => {
  describe("1. Upcoming & Due-Today Offsets (0, +1, +3)", () => {
    const asOf = "2026-11-18";

    it("evaluates due today (0), due tomorrow (+1), and 3 days until due (+3) with strict mutual exclusion", () => {
      // Due today (0)
      expect(daysOverdue("2026-11-18", asOf)).toBe(0);
      expect(Object.is(daysOverdue("2026-11-18", asOf), -0)).toBe(false);
      expect(scheduledForDate("2026-11-18", 0)).toBe(asOf);
      expect(classifyEscalationBucket("2026-11-18", asOf)).toBe("upcoming");
      expect(matchesReminderOffset(0, "2026-11-18", asOf)).toBe(true);
      expect(matchesReminderOffset(1, "2026-11-18", asOf)).toBe(false);
      expect(matchesReminderOffset(3, "2026-11-18", asOf)).toBe(false);
      expect(matchesReminderOffset(-1, "2026-11-18", asOf)).toBe(false);

      const decToday = evaluateEscalationDecision({
        obligationId: "ob-0",
        entityTable: "payment_instances",
        dueDateISO: "2026-11-18",
        asOfDateISO: asOf,
        offsetDays: 0,
      });
      expect(decToday).toEqual({
        obligationId: "ob-0",
        entityTable: "payment_instances",
        asOfDateISO: asOf,
        overdueDays: 0,
        currentStage: "NOT_DUE",
        previousStage: null,
        transitionReason: "not_yet_due",
        eligibleForCurrentNotification: true,
        isHistoricalEvent: false,
      });

      // Due tomorrow (+1)
      expect(daysOverdue("2026-11-19", asOf)).toBe(-1);
      expect(scheduledForDate("2026-11-19", 1)).toBe(asOf);
      expect(classifyEscalationBucket("2026-11-19", asOf)).toBe("upcoming");
      expect(matchesReminderOffset(1, "2026-11-19", asOf)).toBe(true);
      expect(matchesReminderOffset(0, "2026-11-19", asOf)).toBe(false);
      expect(matchesReminderOffset(3, "2026-11-19", asOf)).toBe(false);
      expect(matchesReminderOffset(-1, "2026-11-19", asOf)).toBe(false);

      const decTomorrow = evaluateEscalationDecision({
        obligationId: "ob-plus1",
        entityTable: "payment_instances",
        dueDateISO: "2026-11-19",
        asOfDateISO: asOf,
        offsetDays: 1,
      });
      expect(decTomorrow.overdueDays).toBe(-1);
      expect(decTomorrow.currentStage).toBe("NOT_DUE");
      expect(decTomorrow.transitionReason).toBe("not_yet_due");
      expect(decTomorrow.eligibleForCurrentNotification).toBe(true);
      expect(decTomorrow.isHistoricalEvent).toBe(false);

      // 3 days until due (+3)
      expect(daysOverdue("2026-11-21", asOf)).toBe(-3);
      expect(scheduledForDate("2026-11-21", 3)).toBe(asOf);
      expect(classifyEscalationBucket("2026-11-21", asOf)).toBe("upcoming");
      expect(matchesReminderOffset(3, "2026-11-21", asOf)).toBe(true);
      expect(matchesReminderOffset(1, "2026-11-21", asOf)).toBe(false);
      expect(matchesReminderOffset(0, "2026-11-21", asOf)).toBe(false);
      expect(matchesReminderOffset(-1, "2026-11-21", asOf)).toBe(false);

      const decPlus3 = evaluateEscalationDecision({
        obligationId: "ob-plus3",
        entityTable: "payment_instances",
        dueDateISO: "2026-11-21",
        asOfDateISO: asOf,
        offsetDays: 3,
      });
      expect(decPlus3.overdueDays).toBe(-3);
      expect(decPlus3.currentStage).toBe("NOT_DUE");
      expect(decPlus3.eligibleForCurrentNotification).toBe(true);
    });
  });

  describe("2. Exact Overdue Boundaries (1, 7, 8, 30, 31 days) & Internal 31+ Label Clarity", () => {
    const asOf = "2026-11-18";

    it("enforces disjoint non-overlapping buckets across 1, 7, 8, 30, and 31 days overdue", () => {
      const cases = [
        {
          dueDate: "2026-11-17",
          expectedOverdueDays: 1,
          expectedBucket: "overdue_1_7" as const,
          expectedStage: "OVERDUE_1_7" as const,
          expectedPrevStage: "NOT_DUE" as const,
          expectedReason: "entered_overdue_1_7" as const,
          expectedRuleId: "r-late-1",
        },
        {
          dueDate: "2026-11-11",
          expectedOverdueDays: 7,
          expectedBucket: "overdue_1_7" as const,
          expectedStage: "OVERDUE_1_7" as const,
          expectedPrevStage: "OVERDUE_1_7" as const,
          expectedReason: "steady_in_stage" as const,
          expectedRuleId: "r-late-1",
        },
        {
          dueDate: "2026-11-10",
          expectedOverdueDays: 8,
          expectedBucket: "overdue_8_30" as const,
          expectedStage: "OVERDUE_8_30" as const,
          expectedPrevStage: "OVERDUE_1_7" as const,
          expectedReason: "escalated_to_8_30" as const,
          expectedRuleId: "r-late-8",
        },
        {
          dueDate: "2026-10-19",
          expectedOverdueDays: 30,
          expectedBucket: "overdue_8_30" as const,
          expectedStage: "OVERDUE_8_30" as const,
          expectedPrevStage: "OVERDUE_8_30" as const,
          expectedReason: "steady_in_stage" as const,
          expectedRuleId: "r-late-8",
        },
        {
          dueDate: "2026-10-18",
          expectedOverdueDays: 31,
          expectedBucket: "overdue_30_plus" as const,
          expectedStage: "OVERDUE_31_PLUS" as const,
          expectedPrevStage: "OVERDUE_8_30" as const,
          expectedReason: "escalated_to_31_plus" as const,
          expectedRuleId: "r-late-31",
        },
      ];

      for (const c of cases) {
        expect(daysOverdue(c.dueDate, asOf)).toBe(c.expectedOverdueDays);
        const bucket = classifyEscalationBucket(c.dueDate, asOf);
        expect(bucket).toBe(c.expectedBucket);
        expect(bucketToCanonicalStage(bucket)).toBe(c.expectedStage);

        const deliveries = eligibleDeliveries(
          ALL_STANDARD_RULES,
          [makeTarget({ entityId: `id-${c.expectedOverdueDays}`, dueDate: c.dueDate })],
          asOf,
        );
        expect(deliveries).toHaveLength(1);
        expect(deliveries[0]!.ruleId).toBe(c.expectedRuleId);

        const decision = evaluateEscalationDecision({
          obligationId: `id-${c.expectedOverdueDays}`,
          entityTable: "payment_instances",
          dueDateISO: c.dueDate,
          asOfDateISO: asOf,
          status: "late",
        });
        expect(decision.overdueDays).toBe(c.expectedOverdueDays);
        expect(decision.currentStage).toBe(c.expectedStage);
        expect(decision.previousStage).toBe(c.expectedPrevStage);
        expect(decision.transitionReason).toBe(c.expectedReason);
        expect(decision.eligibleForCurrentNotification).toBe(true);
        expect(decision.isHistoricalEvent).toBe(false);
      }
    });

    it("eliminates Day-30 vs Day-31 label ambiguity and removes statutory 'Hukuki Eskalasyon' claims", () => {
      expect(ESCALATION_BUCKET_LABELS.overdue_8_30).toBe("8-30 Gün İhtar");
      expect(ESCALATION_BUCKET_LABELS.overdue_30_plus).toBe(
        "31+ Gün Üst Eskalasyon (İç İnceleme)",
      );
      expect(ESCALATION_BUCKET_LABELS.overdue_30_plus).not.toContain("30+");
      expect(ESCALATION_BUCKET_LABELS.overdue_30_plus.toLocaleLowerCase("tr-TR")).not.toContain(
        "hukuki eskalasyon",
      );

      const msgDay30 = buildReminderMessage(
        ALL_STANDARD_RULES[4]!,
        makeTarget({ dueDate: "2026-10-19", status: "late" }),
        asOf,
      );
      expect(msgDay30).toContain("🚨 8-30 Gün İhtar kademesi");
      expect(msgDay30).toContain("kademe: 8-30 Gün İhtar (30 gün)");
      expect(msgDay30).not.toContain("31+");

      const msgDay31 = buildReminderMessage(
        ALL_STANDARD_RULES[5]!,
        makeTarget({ dueDate: "2026-10-18", status: "late" }),
        asOf,
      );
      expect(msgDay31).toContain("⚖ 31+ Gün Üst Eskalasyon (İç İnceleme) kademesi");
      expect(msgDay31).toContain("kademe: 31+ Gün Üst Eskalasyon (İç İnceleme) (31 gün)");
      expect(msgDay31).not.toContain("30+");
      expect(msgDay31.toLocaleLowerCase("tr-TR")).not.toContain("hukuki eskalasyon");
    });
  });

  describe("3. Deep Overdue Horizons (60, 123, 364, and 400 days overdue)", () => {
    const asOf = "2026-11-18";

    it("assigns ONLY OVERDUE_31_PLUS (-31) at 60, 123, 364, and 400 days overdue and flags >90d historical & >=365d chronic items", () => {
      expect(CHRONIC_HISTORICAL_OVERDUE_DAYS).toBe(365);
      const deepCases = [
        { dueDate: "2026-09-19", expectedDays: 60, expectedHistorical: false, expectedChronic365: false },
        { dueDate: "2026-07-18", expectedDays: 123, expectedHistorical: true, expectedChronic365: false },
        { dueDate: "2025-11-19", expectedDays: 364, expectedHistorical: true, expectedChronic365: false },
        { dueDate: "2025-11-18", expectedDays: 365, expectedHistorical: true, expectedChronic365: true },
        { dueDate: "2025-10-14", expectedDays: 400, expectedHistorical: true, expectedChronic365: true },
      ];

      for (const dc of deepCases) {
        expect(daysOverdue(dc.dueDate, asOf)).toBe(dc.expectedDays);
        expect(isChronicHistoricalOverdue(dc.dueDate, asOf)).toBe(dc.expectedChronic365);
        expect(matchesReminderOffset(-1, dc.dueDate, asOf)).toBe(false);
        expect(matchesReminderOffset(-8, dc.dueDate, asOf)).toBe(false);
        expect(matchesReminderOffset(-31, dc.dueDate, asOf)).toBe(true);

        const eligible = eligibleDeliveries(
          ALL_STANDARD_RULES,
          [makeTarget({ entityId: `deep-${dc.expectedDays}`, dueDate: dc.dueDate, status: "late" })],
          asOf,
        );
        expect(eligible).toHaveLength(1);
        expect(eligible[0]!.ruleId).toBe("r-late-31");
        expect(eligible[0]!.escalationBucket).toBe("overdue_30_plus");

        const decision = evaluateEscalationDecision({
          obligationId: `deep-${dc.expectedDays}`,
          entityTable: "payment_instances",
          dueDateISO: dc.dueDate,
          asOfDateISO: asOf,
          status: "late",
          offsetDays: -31,
        });
        expect(decision.overdueDays).toBe(dc.expectedDays);
        expect(decision.currentStage).toBe("OVERDUE_31_PLUS");
        expect(decision.previousStage).toBe("OVERDUE_31_PLUS");
        expect(decision.transitionReason).toBe("steady_in_stage");
        expect(decision.eligibleForCurrentNotification).toBe(true);
        expect(decision.isHistoricalEvent).toBe(dc.expectedHistorical);

        // Wrong overdue tiers (-1 and -8) must NEVER be eligible at 60/123/364 days
        expect(
          evaluateEscalationDecision({
            obligationId: `deep-${dc.expectedDays}`,
            entityTable: "payment_instances",
            dueDateISO: dc.dueDate,
            asOfDateISO: asOf,
            status: "late",
            offsetDays: -1,
          }).eligibleForCurrentNotification,
        ).toBe(false);
        expect(
          evaluateEscalationDecision({
            obligationId: `deep-${dc.expectedDays}`,
            entityTable: "payment_instances",
            dueDateISO: dc.dueDate,
            asOfDateISO: asOf,
            status: "late",
            offsetDays: -8,
          }).eligibleForCurrentNotification,
        ).toBe(false);
      }
    });
  });

  describe("4. UTC Midnight Crossing into Next Calendar Day in Türkiye (Europe/Istanbul)", () => {
    it("transitions civil business date at 21:00:00Z (00:00 TRT) rather than 00:00:00Z", () => {
      const beforeIstanbulMidnight = new Date("2026-11-17T20:59:59Z"); // 23:59:59 TRT on 2026-11-17
      const atIstanbulMidnight = new Date("2026-11-17T21:00:00Z"); // 00:00:00 TRT on 2026-11-18
      const afterIstanbulMidnight = new Date("2026-11-17T21:30:00Z"); // 00:30:00 TRT on 2026-11-18

      const trBefore = istanbulDateISO(beforeIstanbulMidnight);
      const trAt = istanbulDateISO(atIstanbulMidnight);
      const trAfter = istanbulDateISO(afterIstanbulMidnight);

      expect(trBefore).toBe("2026-11-17");
      expect(trAt).toBe("2026-11-18");
      expect(trAfter).toBe("2026-11-18");

      // An obligation due 2026-11-17 is NOT_DUE (0d) at 20:59:59Z, and OVERDUE_1_7 (1d) at 21:00:00Z!
      const decBefore = evaluateEscalationDecision({
        obligationId: "trt-cross-1",
        entityTable: "payment_instances",
        dueDateISO: "2026-11-17",
        asOfDateISO: trBefore,
      });
      expect(decBefore.overdueDays).toBe(0);
      expect(decBefore.currentStage).toBe("NOT_DUE");

      const decAfter = evaluateEscalationDecision({
        obligationId: "trt-cross-1",
        entityTable: "payment_instances",
        dueDateISO: "2026-11-17",
        asOfDateISO: trAfter,
      });
      expect(decAfter.overdueDays).toBe(1);
      expect(decAfter.currentStage).toBe("OVERDUE_1_7");
      expect(decAfter.transitionReason).toBe("entered_overdue_1_7");

      // At 21:30Z (2026-11-18 TRT), 2026-11-18 is due today (0) and 2026-11-21 is 3 days ahead (+3)
      expect(matchesReminderOffset(0, "2026-11-18", trAfter)).toBe(true);
      expect(matchesReminderOffset(1, "2026-11-18", trAfter)).toBe(false);
      expect(matchesReminderOffset(3, "2026-11-21", trAfter)).toBe(true);
    });
  });

  describe("5. Month-End & Year-End Calendar Transitions", () => {
    it("computes exact calendar day differences across short month-end (2026-01-31 -> 2026-02-28 -> March)", () => {
      const dueJan31 = "2026-01-31";
      expect(daysOverdue(dueJan31, "2026-02-28")).toBe(28);
      expect(classifyEscalationBucket(dueJan31, "2026-02-28")).toBe("overdue_8_30");
      expect(matchesReminderOffset(-8, dueJan31, "2026-02-28")).toBe(true);

      // Non-leap Feb has 28 days: 2026-03-02 is day 30, 2026-03-03 is day 31
      expect(daysOverdue(dueJan31, "2026-03-02")).toBe(30);
      expect(classifyEscalationBucket(dueJan31, "2026-03-02")).toBe("overdue_8_30");
      expect(matchesReminderOffset(-8, dueJan31, "2026-03-02")).toBe(true);
      expect(matchesReminderOffset(-31, dueJan31, "2026-03-02")).toBe(false);

      expect(daysOverdue(dueJan31, "2026-03-03")).toBe(31);
      expect(classifyEscalationBucket(dueJan31, "2026-03-03")).toBe("overdue_30_plus");
      expect(matchesReminderOffset(-8, dueJan31, "2026-03-03")).toBe(false);
      expect(matchesReminderOffset(-31, dueJan31, "2026-03-03")).toBe(true);

      expect(scheduledForDate("2026-02-28", 28)).toBe("2026-01-31");
    });

    it("computes exact calendar day differences across year-end (2025-12-31 -> 2026-01-01)", () => {
      // Upcoming across year-end
      expect(daysOverdue("2026-01-01", "2025-12-31")).toBe(-1);
      expect(matchesReminderOffset(1, "2026-01-01", "2025-12-31")).toBe(true);
      expect(matchesReminderOffset(3, "2026-01-02", "2025-12-30")).toBe(true);

      // Overdue across year-end
      const decJan1 = evaluateEscalationDecision({
        obligationId: "yearend-1",
        entityTable: "loan_installments",
        dueDateISO: "2025-12-31",
        asOfDateISO: "2026-01-01",
        status: "late",
      });
      expect(decJan1.overdueDays).toBe(1);
      expect(decJan1.currentStage).toBe("OVERDUE_1_7");
      expect(decJan1.previousStage).toBe("NOT_DUE");
      expect(decJan1.transitionReason).toBe("entered_overdue_1_7");

      expect(daysOverdue("2025-12-31", "2026-01-07")).toBe(7);
      expect(daysOverdue("2025-12-31", "2026-01-08")).toBe(8);
      expect(daysOverdue("2025-12-31", "2026-01-30")).toBe(30);
      expect(daysOverdue("2025-12-31", "2026-01-31")).toBe(31);
      expect(classifyEscalationBucket("2025-12-31", "2026-01-30")).toBe("overdue_8_30");
      expect(classifyEscalationBucket("2025-12-31", "2026-01-31")).toBe("overdue_30_plus");
    });
  });

  describe("6. Leap-Year Dates (2024-02-29, 2028-02-29) & Non-Leap Feb 29 Rejection", () => {
    it("accepts real leap-day maturities (2024-02-29, 2028-02-29) and rejects non-leap 2026-02-29", () => {
      expect(isValidISODate("2024-02-29")).toBe(true);
      expect(isValidISODate("2028-02-29")).toBe(true);
      expect(isValidISODate("2026-02-29")).toBe(false);

      // 2024 leap year
      expect(daysOverdue("2024-02-29", "2024-03-01")).toBe(1);
      expect(daysOverdue("2024-02-28", "2024-03-01")).toBe(2);
      expect(daysOverdue("2024-02-29", "2024-03-30")).toBe(30);
      expect(daysOverdue("2024-02-29", "2024-03-31")).toBe(31);
      expect(classifyEscalationBucket("2024-02-29", "2024-03-30")).toBe("overdue_8_30");
      expect(classifyEscalationBucket("2024-02-29", "2024-03-31")).toBe("overdue_30_plus");

      // 2028 leap year
      expect(scheduledForDate("2028-03-01", 1)).toBe("2028-02-29");
      expect(scheduledForDate("2028-03-03", 3)).toBe("2028-02-29");
      expect(matchesReminderOffset(1, "2028-03-01", "2028-02-29")).toBe(true);
      expect(daysOverdue("2028-02-29", "2028-03-07")).toBe(7);
      expect(daysOverdue("2028-02-29", "2028-03-08")).toBe(8);

      const dec2028 = evaluateEscalationDecision({
        obligationId: "leap-2028",
        entityTable: "checks",
        dueDateISO: "2028-02-29",
        asOfDateISO: "2028-03-08",
        status: "in_portfolio",
      });
      expect(dec2028.overdueDays).toBe(8);
      expect(dec2028.currentStage).toBe("OVERDUE_8_30");
      expect(dec2028.transitionReason).toBe("escalated_to_8_30");
    });
  });

  describe("7. Partially Paid Overdue Obligations (30,000 original / 10,000 paid / 20,000 remaining)", () => {
    it("resolves remaining exposure (20,000), evaluates minAmount on remaining, and displays remaining, original, and paid in message & digest", () => {
      const partialTarget = makeTarget({
        entityId: "partial-loan-1",
        name: "VAKIF KREDİ 2",
        dueDate: "2026-11-10",
        amount: 30_000,
        originalAmount: 30_000,
        paidAmount: 10_000,
        status: "partial",
        riskReasons: ["overdue"],
      });

      const resolved = resolveReminderAmounts(partialTarget);
      expect(resolved).toEqual({
        originalAmount: 30_000,
        paidAmount: 10_000,
        outstandingAmount: 20_000,
        hasPartialBreakdown: true,
      });

      // Also resolves via snake_case paid_amount when outstandingAmount is omitted
      const resolvedSnake = resolveReminderAmounts({
        amount: 30_000,
        paid_amount: 10_000,
        status: "partial",
      });
      expect(resolvedSnake.outstandingAmount).toBe(20_000);
      expect(resolvedSnake.paidAmount).toBe(10_000);

      // Preserves BLANK != ZERO when originalAmount is null
      const resolvedMissing = resolveReminderAmounts({
        amount: null,
        paidAmount: null,
        status: "partial",
      });
      expect(resolvedMissing.originalAmount).toBeNull();
      expect(resolvedMissing.outstandingAmount).toBeNull();

      // minAmount threshold tested against remaining 20,000 TRY, NOT original 30,000 TRY
      const ruleMin25k: ReminderRule = {
        ...ALL_STANDARD_RULES[4]!,
        minAmount: 25_000,
      };
      const ruleMin20k: ReminderRule = {
        ...ALL_STANDARD_RULES[4]!,
        minAmount: 20_000,
      };
      expect(isEligible(ruleMin25k, partialTarget, "2026-11-18")).toBe(false);
      expect(isEligible(ruleMin20k, partialTarget, "2026-11-18")).toBe(true);
      expect(
        isEligible(ruleMin25k, makeTarget({ ...partialTarget, amount: null, originalAmount: null, paidAmount: null }), "2026-11-18"),
      ).toBe(true);

      // Single message displays kalan 20.000 TL, asıl 30.000 TL, and ödenen 10.000 TL
      const msg = buildReminderMessage(ALL_STANDARD_RULES[4]!, partialTarget, "2026-11-18");
      expect(msg).toContain("tutar: kalan 20.000 TL (asıl: 30.000 TL · ödenen: 10.000 TL)");
      expect(msg).toContain("durum: Kısmi ödendi");

      // Digest HTML sums ONLY remaining 20.000 TL (+ 15.000 TL unpaid = 35.000 TL, NEVER 45.000 TL)
      const digest = buildReminderDigestHtml(
        [
          partialTarget,
          {
            name: "Ofis Kira",
            dueDate: "2026-11-12",
            amount: 15_000,
            status: "unpaid",
          },
          {
            name: "Tutar Belirsiz Fatura",
            dueDate: "2026-11-18",
            amount: null,
            status: "unpaid",
          },
        ],
        "2026-11-18",
      );
      expect(digest).toContain("bilinen tutar: <b>35.000 TL</b>");
      expect(digest).not.toContain("bilinen tutar: <b>45.000 TL</b>");
      expect(digest).toContain("tutar eksik: <b>1</b> kalem");
      expect(digest).toContain("kalan 20.000 TL (asıl: 30.000 TL · ödenen: 10.000 TL)");
    });
  });

  describe("8. Rescheduled Obligations (rescheduledFromDateISO)", () => {
    it("records transitionReason 'rescheduled' and preserves prior stage from rescheduledFromDateISO", () => {
      // Originally due 2026-11-01 (17d overdue -> OVERDUE_8_30 on 2026-11-18), deferred to 2026-11-25 (-7d -> NOT_DUE)
      const deferredFuture = evaluateEscalationDecision({
        obligationId: "resched-1",
        entityTable: "payment_instances",
        dueDateISO: "2026-11-25",
        rescheduledFromDateISO: "2026-11-01",
        asOfDateISO: "2026-11-18",
        status: "planned",
      });
      expect(deferredFuture).toEqual({
        obligationId: "resched-1",
        entityTable: "payment_instances",
        asOfDateISO: "2026-11-18",
        overdueDays: -7,
        currentStage: "NOT_DUE",
        previousStage: "OVERDUE_8_30",
        transitionReason: "rescheduled",
        eligibleForCurrentNotification: false,
        isHistoricalEvent: false,
      });

      // Originally due 2026-10-01 (48d overdue -> OVERDUE_31_PLUS), restructured to 2026-11-15 (3d overdue -> OVERDUE_1_7)
      const restructuredPartialOverdue = evaluateEscalationDecision({
        obligationId: "resched-2",
        entityTable: "loan_installments",
        dueDateISO: "2026-11-15",
        rescheduledFromDateISO: "2026-10-01",
        asOfDateISO: "2026-11-18",
        status: "late",
        offsetDays: -1,
      });
      expect(restructuredPartialOverdue.overdueDays).toBe(3);
      expect(restructuredPartialOverdue.previousStage).toBe("OVERDUE_31_PLUS");
      expect(restructuredPartialOverdue.currentStage).toBe("OVERDUE_1_7");
      expect(restructuredPartialOverdue.transitionReason).toBe("rescheduled");
      expect(restructuredPartialOverdue.eligibleForCurrentNotification).toBe(true);

      const reschedMsg = buildReminderMessage(
        ALL_STANDARD_RULES[3]!,
        makeTarget({
          dueDate: "2026-11-15",
          rescheduledFromDate: "2026-10-01",
          status: "late",
        }),
        "2026-11-18",
      );
      expect(reschedMsg).toContain("ertelenen vade: 2026-10-01 → 2026-11-15");
    });
  });

  describe("9. Invalid or Missing Dates Guard ('', 'invalid-date', '2026-13-45')", () => {
    const invalidDates = ["", "invalid-date", "2026-13-45", "2026-02-29", "2026/11/18", "2026-11-31"];

    it("never returns NaN, never throws RangeError, and rejects eligibility cleanly on malformed dates", () => {
      for (const bad of invalidDates) {
        expect(isValidISODate(bad)).toBe(false);

        const d1 = daysOverdue(bad, "2026-11-18");
        const d2 = daysOverdue("2026-11-18", bad);
        expect(Number.isNaN(d1)).toBe(false);
        expect(Number.isNaN(d2)).toBe(false);
        expect(d1).toBe(0);
        expect(d2).toBe(0);

        expect(scheduledForDate(bad, 3)).toBe("");
        expect(scheduledForDate(bad, -8)).toBe("");
        expect(classifyEscalationBucket(bad, "2026-11-18")).toBe("upcoming");

        for (const offset of [3, 1, 0, -1, -8, -31]) {
          expect(matchesReminderOffset(offset, bad, "2026-11-18")).toBe(false);
          expect(matchesReminderOffset(offset, "2026-11-18", bad)).toBe(false);
        }

        for (const r of ALL_STANDARD_RULES) {
          expect(isEligible(r, makeTarget({ dueDate: bad }), "2026-11-18")).toBe(false);
          expect(isEligible(r, makeTarget({ dueDate: "2026-11-18" }), bad)).toBe(false);
        }

        const decBadDue = evaluateEscalationDecision({
          obligationId: "bad-date",
          entityTable: "payment_instances",
          dueDateISO: bad,
          asOfDateISO: "2026-11-18",
        });
        expect(decBadDue).toEqual({
          obligationId: "bad-date",
          entityTable: "payment_instances",
          asOfDateISO: "2026-11-18",
          overdueDays: 0,
          currentStage: "NOT_DUE",
          previousStage: null,
          transitionReason: "not_yet_due",
          eligibleForCurrentNotification: false,
          isHistoricalEvent: false,
        });
      }
    });

    it("fails closed on NaN, Infinity, non-integer offsets, and extreme finite offsets without RangeError or OVERDUE_31_PLUS misrouting", () => {
      expect(stageForOverdueDays(Number.NaN)).toBe("NOT_DUE");
      expect(stageForOverdueDays(Number.POSITIVE_INFINITY)).toBe("NOT_DUE");
      expect(stageForOverdueDays(Number.NEGATIVE_INFINITY)).toBe("NOT_DUE");

      expect(() => scheduledForDate("2026-11-18", 1e15)).not.toThrow();
      expect(scheduledForDate("2026-11-18", 1e15)).toBe("");
      expect(scheduledForDate("2026-11-18", 1.5)).toBe("");
      expect(scheduledForDate("2026-11-18", Number.NaN)).toBe("");

      expect(matchesReminderOffset(1.5, "2026-11-18", "2026-11-18")).toBe(false);
      expect(matchesReminderOffset(1e15, "2026-11-18", "2026-11-18")).toBe(false);
      expect(thresholdPasses(50_000, Number.NaN)).toBe(true);
    });
  });

  describe("10. V2 Hardening Golden Locks (RG-06 & F-20): 0..400d Matrix, -30..+500d Disjoint Sweep, Closed Statuses, Seasonal Istanbul Midnight & Legal Wording Safety", () => {
    it("locks exact overdue days and stage classification at 0, 1, 7, 8, 30, 31, 123, 364, and 400 days including >=365 chronic visibility", () => {
      const asOf = "2026-11-18";
      const goldenMatrix = [
        { due: "2026-11-18", days: 0, bucket: "upcoming", stage: "NOT_DUE", ruleId: "r-due-0", hist: false, chronic365: false },
        { due: "2026-11-17", days: 1, bucket: "overdue_1_7", stage: "OVERDUE_1_7", ruleId: "r-late-1", hist: false, chronic365: false },
        { due: "2026-11-11", days: 7, bucket: "overdue_1_7", stage: "OVERDUE_1_7", ruleId: "r-late-1", hist: false, chronic365: false },
        { due: "2026-11-10", days: 8, bucket: "overdue_8_30", stage: "OVERDUE_8_30", ruleId: "r-late-8", hist: false, chronic365: false },
        { due: "2026-10-19", days: 30, bucket: "overdue_8_30", stage: "OVERDUE_8_30", ruleId: "r-late-8", hist: false, chronic365: false },
        { due: "2026-10-18", days: 31, bucket: "overdue_30_plus", stage: "OVERDUE_31_PLUS", ruleId: "r-late-31", hist: false, chronic365: false },
        { due: "2026-07-18", days: 123, bucket: "overdue_30_plus", stage: "OVERDUE_31_PLUS", ruleId: "r-late-31", hist: true, chronic365: false },
        { due: "2025-11-19", days: 364, bucket: "overdue_30_plus", stage: "OVERDUE_31_PLUS", ruleId: "r-late-31", hist: true, chronic365: false },
        { due: "2025-10-14", days: 400, bucket: "overdue_30_plus", stage: "OVERDUE_31_PLUS", ruleId: "r-late-31", hist: true, chronic365: true },
      ] as const;

      for (const g of goldenMatrix) {
        expect(daysOverdue(g.due, asOf)).toBe(g.days);
        expect(classifyEscalationBucket(g.due, asOf)).toBe(g.bucket);
        expect(stageForOverdueDays(g.days)).toBe(g.stage);

        const deliveries = eligibleDeliveries(
          ALL_STANDARD_RULES,
          [makeTarget({ entityId: `golden-${g.days}`, dueDate: g.due, status: g.days > 0 ? "late" : "unpaid" })],
          asOf,
        );
        expect(deliveries).toHaveLength(1);
        expect(deliveries[0]!.ruleId).toBe(g.ruleId);

        const dec = evaluateEscalationDecision({
          obligationId: `golden-${g.days}`,
          entityTable: "payment_instances",
          dueDateISO: g.due,
          asOfDateISO: asOf,
          status: g.days > 0 ? "late" : "unpaid",
        });
        expect(dec.overdueDays).toBe(g.days);
        expect(dec.currentStage).toBe(g.stage);
        expect(dec.isHistoricalEvent).toBe(g.hist);

        if (g.chronic365) {
          expect(deliveries[0]!.message).toContain("31+ Gün Üst Eskalasyon (İç İnceleme) (400 gün)");
          expect(deliveries[0]!.message).toContain("365+");
          const digest400 = buildReminderDigestHtml(
            [{ name: "Kronik Tedarik", dueDate: g.due, amount: 75_000, status: "late" }],
            asOf,
          );
          expect(digest400).toContain("31+ Gün Üst Eskalasyon (İç İnceleme)");
          expect(digest400).toContain("400g gecikmiş · 365+ kronik devir");
        }
      }
    });

    it("enforces strict single-active-stage disjointness across full -30..+500 day sweep", () => {
      const dueDate = "2026-06-15";
      const overdueRules = ALL_STANDARD_RULES.filter((r) => r.offsetDays < 0);

      for (let delta = -30; delta <= 500; delta++) {
        // scheduledForDate(dueDate, -delta) === dueDate + delta days
        const asOf = scheduledForDate(dueDate, -delta);
        expect(isValidISODate(asOf)).toBe(true);
        expect(daysOverdue(dueDate, asOf)).toBe(delta);

        const matchingAll = ALL_STANDARD_RULES.filter((r) =>
          isEligible(r, makeTarget({ dueDate, status: delta > 0 ? "late" : "unpaid" }), asOf),
        );
        expect(matchingAll.length).toBeLessThanOrEqual(1);

        const matchingOverdue = overdueRules.filter((r) =>
          isEligible(r, makeTarget({ dueDate, status: delta > 0 ? "late" : "unpaid" }), asOf),
        );
        if (delta <= 0) {
          expect(matchingOverdue).toHaveLength(0);
        } else {
          expect(matchingOverdue).toHaveLength(1);
          const expectedRuleId = delta <= 7 ? "r-late-1" : delta <= 30 ? "r-late-8" : "r-late-31";
          expect(matchingOverdue[0]!.id).toBe(expectedRuleId);
        }

        const bucket = classifyEscalationBucket(dueDate, asOf);
        const dec = evaluateEscalationDecision({
          obligationId: "sweep-ob",
          entityTable: "payment_instances",
          dueDateISO: dueDate,
          asOfDateISO: asOf,
          status: delta > 0 ? "late" : "unpaid",
        });
        expect(dec.currentStage).toBe(bucketToCanonicalStage(bucket));
      }
    });

    it("ensures paid, cleared, collected, and cancelled items NEVER match eligibility, stage escalation, remaining exposure, or digest totals", () => {
      const asOf = "2026-11-18";
      const closedStatuses = ["paid", "cleared", "collected", "cancelled"] as const;
      const entityConfigs = [
        { table: "payment_instances", kind: "payment_instance" as const },
        { table: "checks", kind: "check" as const },
        { table: "loan_installments", kind: "loan_installment" as const },
        { table: "invoices", kind: "invoice" as const },
      ];
      const testDates = ["2026-11-21", "2026-11-18", "2026-11-15", "2026-11-01", "2025-10-14"];

      for (const status of closedStatuses) {
        expect(isOpenObligationStatus(undefined, status)).toBe(false);
        const resolved = resolveReminderAmounts({ amount: 50_000, status });
        expect(resolved.outstandingAmount).toBe(0);
        expect(resolved.hasPartialBreakdown).toBe(false);

        for (const cfg of entityConfigs) {
          expect(isOpenObligationStatus(cfg.table, status)).toBe(false);
          const rulesForKind = ALL_STANDARD_RULES.map((r) => ({ ...r, targetKind: cfg.kind }));
          for (const dueDate of testDates) {
            const tgt = makeTarget({ entityTable: cfg.table, dueDate, status, amount: 50_000 });
            expect(eligibleDeliveries(rulesForKind, [tgt], asOf)).toHaveLength(0);

            const dec = evaluateEscalationDecision({
              obligationId: `closed-${cfg.table}-${status}`,
              entityTable: cfg.table,
              dueDateISO: dueDate,
              asOfDateISO: asOf,
              status,
            });
            expect(dec.eligibleForCurrentNotification).toBe(false);
            expect(dec.currentStage).toBe("NOT_DUE");
            expect(dec.overdueDays).toBe(0);
            expect(dec.isHistoricalEvent).toBe(false);
          }
        }
      }

      // Digest HTML excludes paid, cleared, collected, and cancelled items from tiers and totals
      const digest = buildReminderDigestHtml(
        [
          { name: "Açık Ödeme", dueDate: "2026-10-01", amount: 25_000, status: "unpaid" },
          { name: "Ödenmiş Kalem", dueDate: "2026-10-01", amount: 90_000, status: "paid" },
          { name: "Tahsil Edilmiş Çek", dueDate: "2026-10-01", amount: 80_000, status: "cleared" },
          { name: "Tahsil Fatura", dueDate: "2026-10-01", amount: 70_000, status: "collected" },
          { name: "İptal Kalem", dueDate: "2026-10-01", amount: 60_000, status: "cancelled" },
        ],
        asOf,
      );
      expect(digest).toContain("Toplam: <b>1</b> kalem · bilinen tutar: <b>25.000 TL</b>");
      expect(digest).not.toContain("Ödenmiş Kalem");
      expect(digest).not.toContain("Tahsil Edilmiş Çek");
      expect(digest).not.toContain("Tahsil Fatura");
      expect(digest).not.toContain("İptal Kalem");
    });

    it("enforces Europe/Istanbul permanent UTC+3 midnight boundary (20:59:59Z vs 21:00:00Z) across winter, summer, and EU/US DST transition dates", () => {
      const seasonalTransitions = [
        // Winter standard
        { utcBefore: "2026-01-15T20:59:59Z", expectedBefore: "2026-01-15", utcAt: "2026-01-15T21:00:00Z", expectedAt: "2026-01-16" },
        // US DST spring forward (2026-03-08)
        { utcBefore: "2026-03-08T20:59:59Z", expectedBefore: "2026-03-08", utcAt: "2026-03-08T21:00:00Z", expectedAt: "2026-03-09" },
        // EU DST spring forward (2026-03-29)
        { utcBefore: "2026-03-29T20:59:59Z", expectedBefore: "2026-03-29", utcAt: "2026-03-29T21:00:00Z", expectedAt: "2026-03-30" },
        // Summer (EU CEST=UTC+2, US EDT=UTC-4, TR=UTC+3)
        { utcBefore: "2026-07-15T20:59:59Z", expectedBefore: "2026-07-15", utcAt: "2026-07-15T21:00:00Z", expectedAt: "2026-07-16" },
        // EU DST autumn fall back (2026-10-25)
        { utcBefore: "2026-10-25T20:59:59Z", expectedBefore: "2026-10-25", utcAt: "2026-10-25T21:00:00Z", expectedAt: "2026-10-26" },
        // US DST autumn fall back (2026-11-01)
        { utcBefore: "2026-11-01T20:59:59Z", expectedBefore: "2026-11-01", utcAt: "2026-11-01T21:00:00Z", expectedAt: "2026-11-02" },
        // Year-end midnight in Istanbul
        { utcBefore: "2026-12-31T20:59:59Z", expectedBefore: "2026-12-31", utcAt: "2026-12-31T21:00:00Z", expectedAt: "2027-01-01" },
      ];

      for (const s of seasonalTransitions) {
        const isoBefore = istanbulDateISO(new Date(s.utcBefore));
        const isoAt = istanbulDateISO(new Date(s.utcAt));
        expect(isoBefore).toBe(s.expectedBefore);
        expect(isoAt).toBe(s.expectedAt);

        // Obligation due on expectedBefore is NOT_DUE (0d) at 20:59:59Z and OVERDUE_1_7 (1d) at 21:00:00Z
        const decBefore = evaluateEscalationDecision({
          obligationId: `dst-${s.expectedBefore}`,
          entityTable: "payment_instances",
          dueDateISO: s.expectedBefore,
          asOfDateISO: isoBefore,
        });
        expect(decBefore.overdueDays).toBe(0);
        expect(decBefore.currentStage).toBe("NOT_DUE");

        const decAt = evaluateEscalationDecision({
          obligationId: `dst-${s.expectedBefore}`,
          entityTable: "payment_instances",
          dueDateISO: s.expectedBefore,
          asOfDateISO: isoAt,
        });
        expect(decAt.overdueDays).toBe(1);
        expect(decAt.currentStage).toBe("OVERDUE_1_7");
        expect(decAt.transitionReason).toBe("entered_overdue_1_7");
      }
    });

    it("guarantees zero unsubstantiated legal action claims across all stage labels, messages, digests, and legacy rule/risk inputs", () => {
      const forbiddenClaims = [
        "hukuki takip başlatıldı",
        "icra başlatıldı",
        "icra takibi başlatıldı",
        "hukuki eskalasyon",
        "yasal takip başlatıldı",
      ];

      for (const label of Object.values(ESCALATION_BUCKET_LABELS)) {
        const lower = label.toLocaleLowerCase("tr-TR");
        for (const claim of forbiddenClaims) {
          expect(lower).not.toContain(claim);
        }
      }

      const legacyRule: ReminderRule = {
        id: "r-legacy-legal",
        name: "31+ Gün Hukuki takip başlatıldı / İcra başlatıldı",
        targetKind: "payment_instance",
        offsetDays: -45,
        channel: "telegram",
        minAmount: null,
        isActive: true,
      };

      const msgWithLegacy = buildReminderMessage(
        legacyRule,
        makeTarget({
          dueDate: "2025-10-14",
          status: "late",
          riskReasons: ["hukuki_takip_başlatıldı", "icra başlatıldı", "Hukuki Eskalasyon"],
        }),
        undefined,
      );
      const msgOverdue400 = buildReminderMessage(
        ALL_STANDARD_RULES[5]!,
        makeTarget({
          dueDate: "2025-10-14",
          status: "late",
          riskReasons: ["hukuki takip başlatıldı", "icra başlatıldı"],
        }),
        "2026-11-18",
      );
      const digest = buildReminderDigestHtml(
        [
          {
            name: "Tedarikçi Faturası",
            dueDate: "2025-10-14",
            amount: 100_000,
            status: "late",
            riskReasons: ["hukuki takip başlatıldı"],
          },
        ],
        "2026-11-18",
      );

      expect(containsUnsubstantiatedLegalClaim("HUKUKİ TAKİP BAŞLATILDI")).toBe(true);
      expect(containsUnsubstantiatedLegalClaim("İcra Başlatıldı")).toBe(true);
      expect(
        containsUnsubstantiatedLegalClaim(
          sanitizeReminderLegalWording("31+ Gün Hukuki takip başlatıldı / İcra başlatıldı"),
        ),
      ).toBe(false);

      for (const output of [
        msgWithLegacy,
        msgOverdue400,
        digest,
        formatRiskReasonTr("hukuki takip başlatıldı"),
        formatRiskReasonTr("icra başlatıldı"),
        formatRiskReasonTr("hukuki_eskalasyon"),
      ]) {
        expect(containsUnsubstantiatedLegalClaim(output)).toBe(false);
        const lower = output.toLocaleLowerCase("tr-TR");
        for (const claim of forbiddenClaims) {
          expect(lower).not.toContain(claim);
        }
      }
    });
  });
});
