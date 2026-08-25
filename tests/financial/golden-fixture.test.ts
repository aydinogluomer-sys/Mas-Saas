// AŞAMA 08 — Consolidated Financial Correctness Gate.
//
// Bu süit, `golden-fixture.ts` içindeki elle yazılmış beklenen değerleri GERÇEK ürün
// fonksiyonlarına karşı sürer. Beklenen değerlerin hiçbiri burada hesaplanmaz; hepsi fixture
// dosyasından okunan literallerdir (rehber §30.2: expected = bağımsız elle aritmetik,
// actual = ürün kodu).
//
// ═══ KAPSAM SINIRI — DÜRÜSTÇE SÖYLENMESİ GEREKEN ═══
//
// Rehber §13'ün property listesi "viewer cannot mutate" satırını da taşır. O bir RLS/RBAC
// kuralıdır, para aritmetiği değil; bu pakette KASITLI OLARAK yoktur ve burada taklidi
// yapılmaz. Gerçek yeri:
//   scripts/db/roles-rls-verify.ts   — canlı role/RLS doğrulaması (pozitif + negatif kontrol)
//   supabase/migrations/*.sql        — RLS politikalarının kendisi
// Uygulama katmanında yazılacak bir "viewer yazamaz" testi, veritabanı politikası hakkında
// hiçbir şey ispat etmez; bu paketin böyle bir iddiası yoktur.
//
// ═══ İKİNCİ SINIR ═══
//
// Ödeme örneği üretimi ve ters kayıt YAZMA yolu (src/lib/radar/engine.ts) saf değildir, `pg`
// havuzu ister. Bu paket süreç-içi ve veritabanısızdır; ters kaydı ve nakit akış kimliğini
// bu yüzden money/rules katmanında aritmetik olarak kapatır — src/lib/financial-invariants.test.ts
// ile aynı yaklaşım, ama onu tekrarlamak yerine GENİŞLETEREK (defter üzerinden ters kayıt,
// çek iptali, hazine ufukları, tolerans sınırları).

import { describe, expect, it } from "vitest";

import {
  MONEY_DP,
  RATE_DP,
  add,
  formatMoney,
  money,
  moneyOrNull,
  sub,
  sumMoney,
} from "@/lib/money";
import {
  ageingBucket,
  assessDuplicate,
  computeLineTotals,
  isTerminal,
  remainingAmount,
  suggestStatusFromPayment,
  sumLineTotals,
  canTransition,
  type InvoiceStatus,
  type LineTotals,
} from "@/lib/invoices/rules";
import {
  collectionBucket,
  computeDSO,
  openAmount,
  planAllocation,
  runningBalance,
  summarizeAgeing,
  wouldExceedCeiling,
  type AllocatableInvoice,
  type AgeingRow,
  type LedgerMovement,
} from "@/lib/receivables/rules";
import {
  buildProjection,
  concentration,
  dayFlags,
  dueDateFor,
  findContinuityIssues,
  riskLevelOf,
  type CashMonth,
  type RiskInputInstance,
  type RiskReason,
} from "@/lib/radar/rules";
import {
  groupMaturities,
  maturityWindows,
  reconcileLoan,
  scheduleDueDates,
  signedToDirection,
  type MaturityItem,
} from "@/lib/financing/rules";
import { maturityBucket, signedMovement, utilization } from "@/lib/financing/facilities";
import { netExposure, revalue, stressTable } from "@/lib/fx/rules";
import { FORECAST_WEEKS, accuracy, variance, weekBuckets, weightedNet } from "@/lib/budget/rules";
import {
  liquidityHorizons,
  reconciliationVerdict,
  effectiveFloor,
  type DatedFlow,
} from "@/lib/treasury/rules";
import { allocate, allocationTotal, cashCycle, profitability } from "@/lib/costing/rules";

import {
  ALLOCATION_CEILING,
  ALLOCATION_FIFO_EXACT,
  ALLOCATION_LEFTOVER,
  BUDGET_NOT_MEASURED,
  BUDGET_VARIANCE,
  CASHFLOW_CONTINUITY,
  CASHFLOW_IDENTITY_MONTHS,
  CASHFLOW_LIQUIDITY_HORIZONS,
  CASHFLOW_RECONCILIATION,
  CASHFLOW_TOLERANCE_BOUNDARY,
  CHECK_MATURITY_GROUPING,
  CHECK_MATURITY_WINDOWS,
  CHECK_SIGNED_DIRECTION,
  CONCENTRATION_RISK,
  COSTING_ALLOCATION_REMAINDER,
  COSTING_CASH_CYCLE,
  COSTING_PROFITABILITY,
  FACILITY_MATURITY_LADDER,
  FACILITY_UTILIZATION,
  FORECAST_ACCURACY,
  FORECAST_WEEK_BUCKETS,
  FORECAST_WEIGHTED_NET,
  FX_LONG_POSITION,
  FX_NET_EXPOSURE,
  FX_SHORT_POSITION,
  FX_STRESS_TABLE,
  FX_UNKNOWN_RATE,
  GOLDEN_CASE_INDEX,
  INVOICE_DUPLICATE,
  INVOICE_LINE_TOTALS,
  INVOICE_OVERPAYMENT,
  INVOICE_PARTIAL_PAYMENT,
  INVOICE_TERMINAL_INERT,
  LOAN_NULL_NOT_ZERO,
  LOAN_RECONCILIATION_MISMATCH,
  LOAN_RECONCILIATION_OK,
  LOAN_SCHEDULE,
  OVERDUE_AGEING_BOUNDARIES,
  OVERDUE_COLLECTION_BOUNDARIES,
  PAYMENT_DAY_FLAGS,
  PAYMENT_DUE_DAY_31,
  PAYMENT_RISK_LADDER,
  PRECISION_BOUNDARY_VALUES,
  PRECISION_LARGE_AMOUNTS,
  PRECISION_MANY_ADDITIONS,
  PRECISION_ROUNDING_DIRECTION,
  RECEIVABLE_AGEING_SUMMARY,
  RECEIVABLE_DSO,
  RECEIVABLE_RUNNING_BALANCE,
  REQUIRED_AREAS,
  REVERSAL_AWKWARD_DECIMALS,
  REVERSAL_CHECK_CANCELLED,
  REVERSAL_LEDGER,
  TODAY,
} from "./golden-fixture";

/* ── küçük yardımcılar: fixture verisini ürün tiplerine taşımak için ────────────────────
   Bunlar YALNIZCA şekil dönüştürür. Hiçbiri para aritmetiği yapmaz; beklenen bir değeri
   üretmezler. §30.2'nin yasakladığı şey budur ve burada olmadığından emin olun. */

const toMaturityItems = (
  rows: ReadonlyArray<{
    id: string;
    dueDate: string;
    amount: number | null;
    direction: "inflow" | "outflow" | "unknown";
  }>,
): MaturityItem[] =>
  rows.map((r) => ({
    id: r.id,
    dueDate: r.dueDate,
    amount: r.amount,
    direction: r.direction,
    kind: "check",
    label: r.id,
  }));

const toCashMonths = (
  rows: ReadonlyArray<{
    monthStart: string;
    opening: number | null;
    income: number | null;
    expense: number | null;
    closing: number | null;
  }>,
): CashMonth[] => rows.map((r) => ({ ...r }));

/* ══════════════════════════════════════════════════════════════════════════════════════
   1. ÖDEME — vade üretimi ve gün seviyesinde risk
   ══════════════════════════════════════════════════════════════════════════════════════ */

describe("FIN-PAY — ödeme: vade günü üretimi ve gün riski", () => {
  it("FIN-PAY-01 · ayın 31'i kısa aylarda son güne çekilir ve bayraklanır", () => {
    const actual = PAYMENT_DUE_DAY_31.input.monthStarts.map((m) =>
      dueDateFor(m, PAYMENT_DUE_DAY_31.input.dueDay),
    );
    expect(actual).toEqual([...PAYMENT_DUE_DAY_31.expected]);
  });

  it("FIN-PAY-02 · günün yükü: ödenmiş kalem yazmaz, bilinmeyen sıfır sayılmaz", () => {
    const instances: RiskInputInstance[] = PAYMENT_DAY_FLAGS.input.instances.map((i) => ({ ...i }));
    const actual = dayFlags(instances, { ...PAYMENT_DAY_FLAGS.input.thresholds });
    expect(actual).toEqual({ ...PAYMENT_DAY_FLAGS.expected });
    // Para eşitliği tam sayı karşılaştırmasıyla; formatlanmış hâli de kuruşu kuruşuna:
    expect(formatMoney(actual.knownSum)).toBe("35000.50");
  });

  it("FIN-PAY-03 · risk merdiveninde en ağır gerekçe kazanır", () => {
    const actual = PAYMENT_RISK_LADDER.input.map((c) => riskLevelOf([...c.reasons] as RiskReason[]));
    expect(actual).toEqual([...PAYMENT_RISK_LADDER.expected]);
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════
   2. FATURA — satır aritmetiği, kısmi ödeme, aşırı ödeme
   ══════════════════════════════════════════════════════════════════════════════════════ */

describe("FIN-INV — fatura: satır toplamları, kısmi ve aşırı ödeme", () => {
  const lineTotals: LineTotals[] = INVOICE_LINE_TOTALS.input.lines.map((l) =>
    computeLineTotals({ ...l }),
  );

  it("FIN-INV-01 · satır bazında net / KDV / brüt elle hesaplanan değerlere eşit", () => {
    expect(lineTotals).toEqual(INVOICE_LINE_TOTALS.expected.lines.map((l) => ({ ...l })));
  });

  it("FIN-INV-01 · başlık toplamı satır toplamlarına KURUŞU KURUŞUNA eşit", () => {
    const header = sumLineTotals(lineTotals);
    expect(header).toEqual({ ...INVOICE_LINE_TOTALS.expected.header });
    // 0044'ün `gross = net + tax` CHECK'inin uygulama karşılığı — tolerans yok, tam eşitlik.
    expect(formatMoney(header.grossAmount)).toBe(
      formatMoney(money(String(header.netAmount + header.taxAmount))),
    );
    // ve satır brütlerinin toplamı da aynı sayı olmalı
    expect(sumMoney(lineTotals.map((l) => l.grossAmount))).toBe(
      INVOICE_LINE_TOTALS.expected.grossFromLines,
    );
  });

  it("FIN-INV-02 · kısmi tahsilat: kalan pozitif, durum 'partial', kalem kapatılamaz", () => {
    const { gross, paid, currentStatus } = INVOICE_PARTIAL_PAYMENT.input;
    expect(remainingAmount(gross, paid)).toBe(INVOICE_PARTIAL_PAYMENT.expected.remaining);
    expect(suggestStatusFromPayment(currentStatus as InvoiceStatus, gross, paid)).toBe(
      INVOICE_PARTIAL_PAYMENT.expected.status,
    );
    expect(remainingAmount(gross, paid) === 0).toBe(INVOICE_PARTIAL_PAYMENT.expected.isSettled);
  });

  it("FIN-INV-03 · aşırı ödeme kalanı NEGATİF bırakır ve fatura 'paid' okunur", () => {
    const { gross, paid, currentStatus } = INVOICE_OVERPAYMENT.input;
    const remaining = remainingAmount(gross, paid);
    expect(remaining).toBe(INVOICE_OVERPAYMENT.expected.remaining);
    expect(suggestStatusFromPayment(currentStatus as InvoiceStatus, gross, paid)).toBe(
      INVOICE_OVERPAYMENT.expected.status,
    );
    // fazla tutar ekranda görünmek zorunda: |kalan| = fazla ödeme
    expect(money(String(-remaining))).toBe(INVOICE_OVERPAYMENT.expected.overpayment);
  });

  it("FIN-INV-04 · terminal ve taslak durumlar ödeme sinyaliyle yeniden sınıflanmaz", () => {
    const actual = INVOICE_TERMINAL_INERT.input.cases.map((c) =>
      suggestStatusFromPayment(c.status as InvoiceStatus, c.gross, c.paid),
    );
    expect(actual).toEqual([...INVOICE_TERMINAL_INERT.expected.suggestions]);
    expect(isTerminal("cancelled")).toBe(INVOICE_TERMINAL_INERT.expected.terminal.cancelled);
    expect(isTerminal("closed")).toBe(INVOICE_TERMINAL_INERT.expected.terminal.closed);
    expect(isTerminal("paid")).toBe(INVOICE_TERMINAL_INERT.expected.terminal.paid);
    for (const t of INVOICE_TERMINAL_INERT.input.transitions) {
      expect(canTransition(t.from as InvoiceStatus, t.to as InvoiceStatus)).toBe(t.allowed);
    }
  });

  it("FIN-INV-05 · çifte fatura tespiti: numara tek başına yeter, tutar+tarih birlikte", () => {
    const { sameNumber, nearMatch, unrelated } = INVOICE_DUPLICATE.input;
    expect(assessDuplicate({ ...sameNumber.a }, { ...sameNumber.b })).toEqual({
      ...INVOICE_DUPLICATE.expected.sameNumber,
      signals: [...INVOICE_DUPLICATE.expected.sameNumber.signals],
    });
    expect(assessDuplicate({ ...nearMatch.a }, { ...nearMatch.b })).toEqual({
      ...INVOICE_DUPLICATE.expected.nearMatch,
      signals: [...INVOICE_DUPLICATE.expected.nearMatch.signals],
    });
    expect(assessDuplicate({ ...unrelated.a }, { ...unrelated.b })).toEqual({
      ...INVOICE_DUPLICATE.expected.unrelated,
      signals: [...INVOICE_DUPLICATE.expected.unrelated.signals],
    });
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════
   3. GECİKME — yaşlandırma kova sınırları
   ══════════════════════════════════════════════════════════════════════════════════════ */

describe("FIN-AGE — gecikme: yaşlandırma kova sınırlarının iki yanı", () => {
  it("FIN-AGE-01 · Faz 21 raporlama yaşlandırması (1-30 / 31-60 / 61-90 / 90+)", () => {
    const actual = OVERDUE_AGEING_BOUNDARIES.input.dueDates.map((d) =>
      ageingBucket(d, OVERDUE_AGEING_BOUNDARIES.input.todayISO),
    );
    expect(actual).toEqual([...OVERDUE_AGEING_BOUNDARIES.expected]);
  });

  it("FIN-AGE-02 · Faz 22 tahsilat aciliyeti yaşlandırması (1-7 / 8-30 / 31-60 / 60+)", () => {
    const actual = OVERDUE_COLLECTION_BOUNDARIES.input.dueDates.map((d) =>
      collectionBucket(d, OVERDUE_COLLECTION_BOUNDARIES.input.todayISO),
    );
    expect(actual).toEqual([...OVERDUE_COLLECTION_BOUNDARIES.expected]);
  });

  it("iki yaşlandırma BİLEREK farklıdır — aynı gecikme farklı kovaya düşer", () => {
    // 2026-07-25 → 31 gün: Faz 21'de '31-60 gün', Faz 22'de de '31-60 gün' ama
    // 2026-08-17 → 8 gün: Faz 21'de '1-30 gün', Faz 22'de '8-30 gün'. Ayrım kasıtlıdır.
    expect(ageingBucket("2026-08-17", TODAY)).toBe("1-30 gün");
    expect(collectionBucket("2026-08-17", TODAY)).toBe("8-30 gün");
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════
   4. ÇEK — işaretli tutar semantiği ve vade takvimi
   ══════════════════════════════════════════════════════════════════════════════════════ */

describe("FIN-CHK — çek: işaretli tutar, aylık takvim, ileri pencereler", () => {
  it("FIN-CHK-01 · işaretli tutar yön + mutlak değere ayrışır; 0 ile null ayrı kalır", () => {
    const actual = CHECK_SIGNED_DIRECTION.input.map((s) => signedToDirection(s));
    expect(actual).toEqual(CHECK_SIGNED_DIRECTION.expected.map((e) => ({ ...e })));
  });

  it("FIN-CHK-02 · aylık vade kovaları: giriş/çıkış ayrı, bilinmeyen sayılır ama toplanmaz", () => {
    const buckets = groupMaturities(toMaturityItems(CHECK_MATURITY_GROUPING.input.items), "month");
    const actual = buckets.map((b) => ({
      key: b.key,
      from: b.from,
      to: b.to,
      count: b.count,
      knownOutflow: b.knownOutflow,
      knownInflow: b.knownInflow,
      missingCount: b.missingCount,
      unknownDirectionCount: b.unknownDirectionCount,
    }));
    expect(actual).toEqual(CHECK_MATURITY_GROUPING.expected.map((e) => ({ ...e })));
  });

  it("FIN-CHK-03 · ileri pencereler yarı-açık: sınır günü bir sonraki ufka düşer", () => {
    const actual = maturityWindows(
      toMaturityItems(CHECK_MATURITY_WINDOWS.input.items),
      CHECK_MATURITY_WINDOWS.input.todayISO,
      [7, 14, 30],
    );
    expect(actual).toEqual(CHECK_MATURITY_WINDOWS.expected.map((e) => ({ ...e })));
  });

  it("FIN-FAC-02 · vade merdiveni: gecikmiş de bir yılı aşan da merdivende yok", () => {
    const actual = FACILITY_MATURITY_LADDER.input.dueDates.map((d) =>
      maturityBucket(d, FACILITY_MATURITY_LADDER.input.todayISO),
    );
    expect(actual).toEqual([...FACILITY_MATURITY_LADDER.expected]);
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════
   5. KREDİ — taksit takvimi, mutabakat, limit kullanımı
   ══════════════════════════════════════════════════════════════════════════════════════ */

describe("FIN-LOAN / FIN-FAC — kredi: takvim, mutabakat, limit", () => {
  it("FIN-LOAN-01 · taksit vadeleri kısa ayda çekilir ama kalıcı kayma yaratmaz", () => {
    const actual = scheduleDueDates(LOAN_SCHEDULE.input.firstPaymentISO, LOAN_SCHEDULE.input.count);
    expect(actual).toEqual(LOAN_SCHEDULE.expected.map((e) => ({ ...e })));
  });

  it("FIN-LOAN-02 · tutarlı kredi mutabakatı sorun üretmez", () => {
    const actual = reconcileLoan({ ...LOAN_RECONCILIATION_OK.input });
    expect(actual.ok).toBe(LOAN_RECONCILIATION_OK.expected.ok);
    expect(actual.issues).toHaveLength(LOAN_RECONCILIATION_OK.expected.issueCount);
  });

  it("FIN-LOAN-03 · 5 TL'lik taksit farkı bayraklanır, kaynak değer düzeltilmez", () => {
    const input = { ...LOAN_RECONCILIATION_MISMATCH.input };
    const actual = reconcileLoan(input);
    expect(actual.ok).toBe(LOAN_RECONCILIATION_MISMATCH.expected.ok);
    expect(actual.issues).toHaveLength(LOAN_RECONCILIATION_MISMATCH.expected.issueCount);
    expect(actual.issues[0].code).toBe(LOAN_RECONCILIATION_MISMATCH.expected.code);
    expect(actual.issues[0].diff).toBe(LOAN_RECONCILIATION_MISMATCH.expected.diff);
    expect(actual.issues[0].message).toBe(LOAN_RECONCILIATION_MISMATCH.expected.message);
    // "flag, don't fix": girdi nesnesi olduğu gibi durmalı
    expect(input.installmentSum).toBe(LOAN_RECONCILIATION_MISMATCH.input.installmentSum);
    expect(input.totalPayment).toBe(LOAN_RECONCILIATION_MISMATCH.input.totalPayment);
  });

  it("FIN-LOAN-04 · eksik anapara 0 sayılmaz; hayalî sapma ÜRETİLMEZ", () => {
    const actual = reconcileLoan({ ...LOAN_NULL_NOT_ZERO.input });
    expect(actual.ok).toBe(LOAN_NULL_NOT_ZERO.expected.ok);
    expect(actual.issues).toHaveLength(LOAN_NULL_NOT_ZERO.expected.issueCount);
    expect(actual.issues[0].code).toBe(LOAN_NULL_NOT_ZERO.expected.code);
    expect(actual.issues[0].message).toBe(LOAN_NULL_NOT_ZERO.expected.message);
    // Asıl kanıt: 1.000.000 TL'lik sahte 'finance_cost_mismatch' YOK.
    expect(actual.issues.some((i) => i.code === "finance_cost_mismatch")).toBe(false);
    expect(actual.issues.map((i) => i.diff)).not.toContain(
      LOAN_NULL_NOT_ZERO.expected.phantomDiffIfNullWereZero,
    );
  });

  it("FIN-FAC-01 · limit kullanımı: aşımda kullanılabilir 0, eksi headroom sızmaz", () => {
    const signed = FACILITY_UTILIZATION.input.within.movements.map((m) =>
      signedMovement(m.type, m.amount),
    );
    expect(signed).toEqual([...FACILITY_UTILIZATION.expected.signed]);

    const within = utilization(FACILITY_UTILIZATION.input.within.limit, signed);
    expect(within.drawnAmount).toBe(FACILITY_UTILIZATION.expected.within.drawnAmount);
    expect(within.availableAmount).toBe(FACILITY_UTILIZATION.expected.within.availableAmount);
    expect(within.utilizationRatio).toBe(FACILITY_UTILIZATION.expected.within.utilizationRatio);
    expect(within.overLimit).toBe(FACILITY_UTILIZATION.expected.within.overLimit);

    const over = utilization(
      FACILITY_UTILIZATION.input.over.limit,
      FACILITY_UTILIZATION.input.over.movements.map((m) => signedMovement(m.type, m.amount)),
    );
    expect(over.drawnAmount).toBe(FACILITY_UTILIZATION.expected.over.drawnAmount);
    expect(over.availableAmount).toBe(FACILITY_UTILIZATION.expected.over.availableAmount);
    expect(over.utilizationRatio).toBe(FACILITY_UTILIZATION.expected.over.utilizationRatio);
    expect(over.overLimit).toBe(FACILITY_UTILIZATION.expected.over.overLimit);

    const zero = utilization(
      FACILITY_UTILIZATION.input.zeroLimit.limit,
      FACILITY_UTILIZATION.input.zeroLimit.movements.map((m) => signedMovement(m.type, m.amount)),
    );
    expect(zero.utilizationRatio).toBe(FACILITY_UTILIZATION.expected.zeroLimit.utilizationRatio);
    expect(zero.availableAmount).toBe(FACILITY_UTILIZATION.expected.zeroLimit.availableAmount);
    expect(zero.overLimit).toBe(FACILITY_UTILIZATION.expected.zeroLimit.overLimit);
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════
   6. ALACAK — yaşlandırma özeti, DSO, cari hesap, yoğunlaşma
   ══════════════════════════════════════════════════════════════════════════════════════ */

describe("FIN-REC — alacak: yaşlandırma özeti, DSO, cari hesap", () => {
  it("FIN-REC-01 · yaşlandırma özeti: her kova görünür, toplam elle sayılabilir", () => {
    const rows: AgeingRow[] = RECEIVABLE_AGEING_SUMMARY.input.rows.map((r) => ({ ...r }));
    const actual = summarizeAgeing(rows, RECEIVABLE_AGEING_SUMMARY.input.todayISO);
    expect(actual).toEqual(RECEIVABLE_AGEING_SUMMARY.expected.buckets.map((b) => ({ ...b })));
    expect(sumMoney(actual.map((b) => b.amount))).toBe(RECEIVABLE_AGEING_SUMMARY.expected.total);
  });

  it("FIN-REC-02 · DSO: satış yoksa 0 değil NULL", () => {
    const { normal, noSales, noPeriod } = RECEIVABLE_DSO.input;
    expect(computeDSO(normal.openReceivables, normal.salesInPeriod, normal.periodDays)).toBe(
      RECEIVABLE_DSO.expected.normal,
    );
    expect(computeDSO(noSales.openReceivables, noSales.salesInPeriod, noSales.periodDays)).toBe(
      RECEIVABLE_DSO.expected.noSales,
    );
    expect(computeDSO(noPeriod.openReceivables, noPeriod.salesInPeriod, noPeriod.periodDays)).toBe(
      RECEIVABLE_DSO.expected.noPeriod,
    );
  });

  it("FIN-REC-03 · yürüyen bakiye tarihe göre sıralanır ve birikir", () => {
    const movements: LedgerMovement[] = RECEIVABLE_RUNNING_BALANCE.input.movements.map((m) => ({
      ...m,
    }));
    const actual = runningBalance(movements);
    expect(actual.map((m) => m.movementDate)).toEqual([
      ...RECEIVABLE_RUNNING_BALANCE.expected.dates,
    ]);
    expect(actual.map((m) => m.balance)).toEqual([...RECEIVABLE_RUNNING_BALANCE.expected.balances]);
  });

  it("FIN-CON-01 · yoğunlaşma: negatif ve sıfır sayılmaz, bilinmeyen ayrıca bildirilir", () => {
    const actual = concentration(
      CONCENTRATION_RISK.input.items.map((i) => ({ ...i })),
      CONCENTRATION_RISK.input.flagRatio,
    );
    expect(actual.knownTotal).toBe(CONCENTRATION_RISK.expected.knownTotal);
    expect(actual.unknownCount).toBe(CONCENTRATION_RISK.expected.unknownCount);
    expect(actual.entries).toEqual(CONCENTRATION_RISK.expected.entries.map((e) => ({ ...e })));
  });

  it("FIN-CST-03 · nakit dönüşüm süresi: stok yoksa CCC null, gerekçesi yazılır", () => {
    const actual = cashCycle(
      COSTING_CASH_CYCLE.input.dsoDays,
      COSTING_CASH_CYCLE.input.dioDays,
      COSTING_CASH_CYCLE.input.dpoDays,
    );
    expect(actual.cashConversionCycleDays).toBe(
      COSTING_CASH_CYCLE.expected.cashConversionCycleDays,
    );
    expect(actual.cycleExcludingInventory).toBe(COSTING_CASH_CYCLE.expected.cycleExcludingInventory);
    expect(actual.unmeasurableReason).toBe(COSTING_CASH_CYCLE.expected.unmeasurableReason);
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════
   7. DAĞITIM — tahsilat ve maliyet dağıtımı
   ══════════════════════════════════════════════════════════════════════════════════════ */

describe("FIN-ALL / FIN-CST — dağıtım: tahsilat FIFO'su ve maliyet kuruşu", () => {
  it("FIN-ALL-01 · en eski vadeden başlayarak tam dağıtım, artan yok", () => {
    const invoices: AllocatableInvoice[] = ALLOCATION_FIFO_EXACT.input.invoices.map((i) => ({
      ...i,
    }));
    const actual = planAllocation(ALLOCATION_FIFO_EXACT.input.amount, invoices);
    expect(actual.lines).toEqual(ALLOCATION_FIFO_EXACT.expected.lines.map((l) => ({ ...l })));
    expect(actual.allocated).toBe(ALLOCATION_FIFO_EXACT.expected.allocated);
    expect(actual.unallocated).toBe(ALLOCATION_FIFO_EXACT.expected.unallocated);
  });

  it("FIN-ALL-02 · artan para son faturaya zorlanmaz, ayrı kalem olarak gösterilir", () => {
    const invoices: AllocatableInvoice[] = ALLOCATION_LEFTOVER.input.invoices.map((i) => ({ ...i }));
    const actual = planAllocation(ALLOCATION_LEFTOVER.input.amount, invoices);
    expect(actual.lines).toEqual(ALLOCATION_LEFTOVER.expected.lines.map((l) => ({ ...l })));
    expect(actual.allocated).toBe(ALLOCATION_LEFTOVER.expected.allocated);
    expect(actual.unallocated).toBe(ALLOCATION_LEFTOVER.expected.unallocated);
  });

  it("FIN-ALL-03 · tavan: tam oturmak serbest, bir kuruş fazlası reddedilir", () => {
    const c = ALLOCATION_CEILING.input;
    expect(
      wouldExceedCeiling(
        c.exactlyAtCeiling.gross,
        c.exactlyAtCeiling.alreadyAllocated,
        c.exactlyAtCeiling.newAmount,
      ),
    ).toBe(ALLOCATION_CEILING.expected.exactlyAtCeiling);
    expect(
      wouldExceedCeiling(
        c.oneKurusOver.gross,
        c.oneKurusOver.alreadyAllocated,
        c.oneKurusOver.newAmount,
      ),
    ).toBe(ALLOCATION_CEILING.expected.oneKurusOver);
    expect(
      wouldExceedCeiling(c.doubleApply.gross, c.doubleApply.alreadyAllocated, c.doubleApply.newAmount),
    ).toBe(ALLOCATION_CEILING.expected.doubleApply);
    expect(
      openAmount(c.openAfterFullSettlement.gross, c.openAfterFullSettlement.allocated),
    ).toBe(ALLOCATION_CEILING.expected.openAfterFullSettlement);
    expect(
      openAmount(c.openAfterOverAllocation.gross, c.openAfterOverAllocation.allocated),
    ).toBe(ALLOCATION_CEILING.expected.openAfterOverAllocation);
  });

  it("FIN-CST-01 · kuruş problemi: parçalar bütüne TAM eşit", () => {
    const equal = allocate(
      COSTING_ALLOCATION_REMAINDER.input.equalThirds.totalCost,
      COSTING_ALLOCATION_REMAINDER.input.equalThirds.targets.map((t) => ({ ...t })),
    );
    expect(equal.map((s) => s.id)).toEqual([
      ...COSTING_ALLOCATION_REMAINDER.expected.equalThirds.order,
    ]);
    expect(equal.map((s) => s.amount)).toEqual([
      ...COSTING_ALLOCATION_REMAINDER.expected.equalThirds.amounts,
    ]);
    expect(allocationTotal(equal)).toBe(COSTING_ALLOCATION_REMAINDER.expected.equalThirds.total);

    const weighted = allocate(
      COSTING_ALLOCATION_REMAINDER.input.weighted.totalCost,
      COSTING_ALLOCATION_REMAINDER.input.weighted.targets.map((t) => ({ ...t })),
    );
    expect(weighted.map((s) => s.id)).toEqual([
      ...COSTING_ALLOCATION_REMAINDER.expected.weighted.order,
    ]);
    expect(weighted.map((s) => s.share)).toEqual([
      ...COSTING_ALLOCATION_REMAINDER.expected.weighted.shares,
    ]);
    expect(weighted.map((s) => s.amount)).toEqual([
      ...COSTING_ALLOCATION_REMAINDER.expected.weighted.amounts,
    ]);
    expect(allocationTotal(weighted)).toBe(COSTING_ALLOCATION_REMAINDER.expected.weighted.total);
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════
   8. KUR — yeniden değerleme ve stres
   ══════════════════════════════════════════════════════════════════════════════════════ */

describe("FIN-FX — kur: yeniden değerleme, yön, stres bantları", () => {
  it("FIN-FX-01 · uzun pozisyon: kâr pozitif, ters yön kurun DÜŞMESİ", () => {
    expect(revalue({ ...FX_LONG_POSITION.input })).toEqual({
      currency: "USD",
      ...FX_LONG_POSITION.expected,
    });
  });

  it("FIN-FX-02 · kısa pozisyon: kur yükselince zarar; işaret yönü karışmaz", () => {
    expect(revalue({ ...FX_SHORT_POSITION.input })).toEqual({
      currency: "EUR",
      ...FX_SHORT_POSITION.expected,
    });
  });

  it("FIN-FX-03 · güncel kur yoksa türetilen her rakam NULL, 0 değil", () => {
    expect(revalue({ ...FX_UNKNOWN_RATE.input })).toEqual({
      currency: "GBP",
      ...FX_UNKNOWN_RATE.expected,
    });
  });

  it("FIN-FX-04 · %5/%10/%20 stres bantları hesap makinesiyle yeniden üretilebilir", () => {
    expect(stressTable(FX_STRESS_TABLE.input.amount, FX_STRESS_TABLE.input.currentRate)).toEqual(
      FX_STRESS_TABLE.expected.map((e) => ({ ...e })),
    );
  });

  it("FIN-FX-05 · net pozisyon: bilinmeyen atlanır, açık sıfır sonucu değiştirmez", () => {
    expect(netExposure([...FX_NET_EXPOSURE.input])).toBe(FX_NET_EXPOSURE.expected);
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════
   9. BÜTÇE VE TAHMİN
   ══════════════════════════════════════════════════════════════════════════════════════ */

describe("FIN-BUD / FIN-FC — bütçe sapması ve 13 haftalık tahmin", () => {
  it("FIN-BUD-01 · sapma yönü hükmü belirler", () => {
    const actual = BUDGET_VARIANCE.input.map((c) => {
      const v = variance(c.direction, c.budget, c.actual);
      return {
        varianceAmount: v.varianceAmount,
        varianceRatio: v.varianceRatio,
        verdict: v.verdict,
      };
    });
    expect(actual).toEqual(BUDGET_VARIANCE.expected.map((e) => ({ ...e })));
  });

  it("FIN-BUD-02 · ölçülmemiş fiili 0 değil NULL; sıfır bütçede oran tanımsız", () => {
    const actual = BUDGET_NOT_MEASURED.input.map((c) => {
      const v = variance(c.direction, c.budget, c.actual);
      return {
        actualAmount: v.actualAmount,
        varianceAmount: v.varianceAmount,
        varianceRatio: v.varianceRatio,
        verdict: v.verdict,
      };
    });
    expect(actual).toEqual(BUDGET_NOT_MEASURED.expected.map((e) => ({ ...e })));
  });

  it("FIN-CST-02 · kârlılık: bilinmeyen maliyet marjı NULL yapar, sıfır ciro marjı silmez", () => {
    const n = profitability(
      COSTING_PROFITABILITY.input.normal.revenue,
      COSTING_PROFITABILITY.input.normal.cost,
    );
    expect(n.margin).toBe(COSTING_PROFITABILITY.expected.normal.margin);
    expect(n.marginRate).toBe(COSTING_PROFITABILITY.expected.normal.marginRate);
    expect(n.confidence).toBe(COSTING_PROFITABILITY.expected.normal.confidence);

    const z = profitability(
      COSTING_PROFITABILITY.input.zeroRevenue.revenue,
      COSTING_PROFITABILITY.input.zeroRevenue.cost,
    );
    expect(z.margin).toBe(COSTING_PROFITABILITY.expected.zeroRevenue.margin);
    expect(z.marginRate).toBe(COSTING_PROFITABILITY.expected.zeroRevenue.marginRate);

    const u = profitability(
      COSTING_PROFITABILITY.input.unknownCost.revenue,
      COSTING_PROFITABILITY.input.unknownCost.cost,
    );
    expect(u.margin).toBe(COSTING_PROFITABILITY.expected.unknownCost.margin);
    expect(u.confidence).toBe(COSTING_PROFITABILITY.expected.unknownCost.confidence);
  });

  it("FIN-FC-01 · 13 haftalık ufuk üretilir; haftalar kesintisiz ve iki uç dahil", () => {
    const buckets = weekBuckets(FORECAST_WEEK_BUCKETS.input.anchorISO, FORECAST_WEEK_BUCKETS.input.weeks);
    expect(buckets).toHaveLength(FORECAST_WEEK_BUCKETS.expected.count);
    expect(FORECAST_WEEKS).toBe(FORECAST_WEEK_BUCKETS.expected.count);
    expect(buckets[0]).toEqual({ ...FORECAST_WEEK_BUCKETS.expected.first });
    expect(buckets[1]).toEqual({ ...FORECAST_WEEK_BUCKETS.expected.second });
    expect(buckets[12]).toEqual({ ...FORECAST_WEEK_BUCKETS.expected.last });
    // kesintisizlik: bir haftanın sonu, sonrakinin başından tam 1 gün önce
    for (let i = 0; i < buckets.length - 1; i += 1) {
      const endMs = Date.parse(`${buckets[i].weekEnd}T00:00:00Z`);
      const nextStartMs = Date.parse(`${buckets[i + 1].weekStart}T00:00:00Z`);
      expect(nextStartMs - endMs).toBe(86_400_000);
    }
  });

  it("FIN-FC-02 · doğruluk yalnız ölçülmüş satırlar üzerinden; dışlananlar bildirilir", () => {
    expect(accuracy(FORECAST_ACCURACY.input.map((r) => ({ ...r })))).toEqual({
      ...FORECAST_ACCURACY.expected,
    });
  });

  it("FIN-FC-03 · güven ağırlıklı net: puansız satır tam yüzle girer, kaybolmaz", () => {
    expect(weightedNet(FORECAST_WEIGHTED_NET.input.map((l) => ({ ...l })))).toBe(
      FORECAST_WEIGHTED_NET.expected,
    );
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════
   10. TERS KAYIT
   ══════════════════════════════════════════════════════════════════════════════════════ */

describe("FIN-REV — ters kayıt: net etki TAM OLARAK sıfır", () => {
  it("FIN-REV-01 · hatalı borç + birebir alacak bakiyeyi hatadan öncesine döndürür", () => {
    const movements: LedgerMovement[] = REVERSAL_LEDGER.input.movements.map((m) => ({ ...m }));
    const actual = runningBalance(movements);
    expect(actual.map((m) => m.balance)).toEqual([...REVERSAL_LEDGER.expected.balances]);
    // net etki: son bakiye − ters kayıttan önceki bakiye
    const net = sub(actual[2].balance, actual[0].balance);
    expect(net.toFixed(2)).toBe("0.00");
    expect(money(net.toString())).toBe(REVERSAL_LEDGER.expected.netEffectOfReversal);
  });

  it("FIN-REV-02 · 0,10 + 0,20 − 0,30 defterde TAM sıfır (float 5,55e−17 verir)", () => {
    const movements: LedgerMovement[] = REVERSAL_AWKWARD_DECIMALS.input.movements.map((m) => ({
      ...m,
    }));
    const actual = runningBalance(movements);
    expect(actual.map((m) => m.balance)).toEqual([...REVERSAL_AWKWARD_DECIMALS.expected.balances]);
    // NEGATİF KONTROL: aynı hesap float ile sıfır vermez, yani bu test bir şey ispat ediyor.
    expect(0.1 + 0.2 - 0.3).toBe(REVERSAL_AWKWARD_DECIMALS.expected.floatResidue);
    expect(0.1 + 0.2 - 0.3).not.toBe(0);
  });

  it("FIN-REV-03 · iptal edilen çek: net 0 ama iki hareket de takvimde kalır", () => {
    const buckets = groupMaturities(toMaturityItems(REVERSAL_CHECK_CANCELLED.input.items), "month");
    expect(buckets).toHaveLength(1);
    expect(buckets[0].key).toBe(REVERSAL_CHECK_CANCELLED.expected.bucket.key);
    expect(buckets[0].count).toBe(REVERSAL_CHECK_CANCELLED.expected.bucket.count);
    expect(buckets[0].knownOutflow).toBe(REVERSAL_CHECK_CANCELLED.expected.bucket.knownOutflow);
    expect(buckets[0].knownInflow).toBe(REVERSAL_CHECK_CANCELLED.expected.bucket.knownInflow);
    expect(money(String(buckets[0].knownInflow - buckets[0].knownOutflow))).toBe(
      REVERSAL_CHECK_CANCELLED.expected.netEffect,
    );
    expect(netExposure([...REVERSAL_CHECK_CANCELLED.input.netExposureAmounts])).toBe(
      REVERSAL_CHECK_CANCELLED.expected.netExposure,
    );
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════
   11. NAKİT AKIŞ KİMLİĞİ
   ══════════════════════════════════════════════════════════════════════════════════════ */

describe("FIN-CF — nakit akış kimliği: kapanış = açılış + gelir − gider", () => {
  const months = toCashMonths(CASHFLOW_IDENTITY_MONTHS.input.months);

  it("FIN-CF-01 · kimlik her ayda kuruşu kuruşuna tutuyor; bilinmeyen ay NULL kalıyor", () => {
    const actual = months.map((m) => {
      if (m.opening === null || m.income === null || m.expense === null) return null;
      // ürün kodu (money katmanı) hesaplar, beklenen değer fixture'dan gelen literal
      return money(sub(add(m.opening, m.income), m.expense).toString());
    });
    expect(actual).toEqual([...CASHFLOW_IDENTITY_MONTHS.expected.identityClosings]);
    // ve hesaplanan kimlik, kayıtlı kapanışla birebir aynı olmalı (tolerans yok)
    for (let i = 0; i < months.length; i += 1) {
      if (actual[i] === null) continue;
      expect(formatMoney(actual[i] as number)).toBe(formatMoney(months[i].closing as number));
    }
  });

  it("FIN-CF-01 · projeksiyon: ilk negatif ay, en kötü ay, en uzun negatif seri", () => {
    const p = buildProjection(months, 0);
    expect(p.series.map((s) => s.delta)).toEqual([...CASHFLOW_IDENTITY_MONTHS.expected.deltas]);
    expect(p.firstNegativeMonth).toBe(CASHFLOW_IDENTITY_MONTHS.expected.firstNegativeMonth);
    expect(p.worstMonth).toBe(CASHFLOW_IDENTITY_MONTHS.expected.worstMonth);
    expect(p.worstBalance).toBe(CASHFLOW_IDENTITY_MONTHS.expected.worstBalance);
    expect(p.longestNegativeRun).toEqual({
      ...CASHFLOW_IDENTITY_MONTHS.expected.longestNegativeRun,
    });
  });

  it("FIN-CF-02 · zincir kopukluğu ve eksik ay bayraklanır, düzeltilmez", () => {
    const chain = toCashMonths(CASHFLOW_CONTINUITY.input.months);
    const { breaks, gaps } = findContinuityIssues(chain);
    expect(breaks).toHaveLength(CASHFLOW_CONTINUITY.expected.breakCount);
    expect(breaks[0]).toEqual({ ...CASHFLOW_CONTINUITY.expected.firstBreak });
    expect(gaps).toHaveLength(CASHFLOW_CONTINUITY.expected.gapCount);
    expect(gaps[0]).toEqual({ ...CASHFLOW_CONTINUITY.expected.firstGap });
    // girdi mutasyona uğramamalı
    expect(chain[2].opening).toBe(CASHFLOW_CONTINUITY.input.months[2].opening);
  });

  it("FIN-CF-03 · zincir toleransı tam 1,00 TL — sınırın iki yanı da çivili", () => {
    const one = findContinuityIssues(toCashMonths(CASHFLOW_TOLERANCE_BOUNDARY.input.exactlyOne));
    expect(one.breaks).toHaveLength(CASHFLOW_TOLERANCE_BOUNDARY.expected.exactlyOne.breakCount);

    const two = findContinuityIssues(toCashMonths(CASHFLOW_TOLERANCE_BOUNDARY.input.twoLira));
    expect(two.breaks).toHaveLength(CASHFLOW_TOLERANCE_BOUNDARY.expected.twoLira.breakCount);
    expect(two.breaks[0].diff).toBe(CASHFLOW_TOLERANCE_BOUNDARY.expected.twoLira.diff);
  });

  it("FIN-CF-04 · hazine 7/30/90: yarı-açık pencere, sözleşmeli ve beklenen ayrı", () => {
    const flows: DatedFlow[] = CASHFLOW_LIQUIDITY_HORIZONS.input.flows.map((f) => ({ ...f }));
    const actual = liquidityHorizons({
      openingPosition: CASHFLOW_LIQUIDITY_HORIZONS.input.openingPosition,
      flows,
      todayISO: CASHFLOW_LIQUIDITY_HORIZONS.input.todayISO,
      minCashFloor: CASHFLOW_LIQUIDITY_HORIZONS.input.minCashFloor,
    });
    expect(actual).toHaveLength(3);
    CASHFLOW_LIQUIDITY_HORIZONS.expected.forEach((e, i) => {
      const a = actual[i];
      expect(a.horizonDays).toBe(e.horizonDays);
      expect(a.toDate).toBe(e.toDate);
      expect(a.flowCount).toBe(e.flowCount);
      expect(a.contractedNet).toBe(e.contractedNet);
      expect(a.expectedNet).toBe(e.expectedNet);
      expect(a.projectedContracted).toBe(e.projectedContracted);
      expect(a.projectedExpected).toBe(e.projectedExpected);
      expect(a.financingNeed).toBe(e.financingNeed);
      expect(a.breachesFloor).toBe(e.breachesFloor);
      // ufuk içi kimlik: projeksiyon = açılış + net
      expect(formatMoney(a.projectedContracted)).toBe(
        formatMoney(add(a.openingPosition, a.contractedNet).toString()),
      );
    });
  });

  it("FIN-CF-05 · mutabakat: 1,00 TL tolerans, eksik taraf 0 sayılmaz", () => {
    const c = CASHFLOW_RECONCILIATION.input;
    expect(reconciliationVerdict(c.aligned.cashflowClosing, c.aligned.treasuryClosing)).toEqual({
      ...CASHFLOW_RECONCILIATION.expected.aligned,
    });
    expect(reconciliationVerdict(c.divergent.cashflowClosing, c.divergent.treasuryClosing)).toEqual({
      ...CASHFLOW_RECONCILIATION.expected.divergent,
    });
    expect(
      reconciliationVerdict(c.cashflowMissing.cashflowClosing, c.cashflowMissing.treasuryClosing),
    ).toEqual({ ...CASHFLOW_RECONCILIATION.expected.cashflowMissing });
    expect(
      reconciliationVerdict(c.noBankMovement.cashflowClosing, c.noBankMovement.treasuryClosing),
    ).toEqual({ ...CASHFLOW_RECONCILIATION.expected.noBankMovement });
  });

  it("taban politikası: iki minimum varsa YÜKSEK olan geçerli, yoksa null", () => {
    expect(effectiveFloor(500_000, 750_000)).toBe(750_000);
    expect(effectiveFloor(750_000, 500_000)).toBe(750_000);
    expect(effectiveFloor(null, 750_000)).toBe(750_000);
    expect(effectiveFloor(500_000, null)).toBe(500_000);
    expect(effectiveFloor(null, null)).toBeNull();
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════
   12. REHBER §13 — PROPERTY INVARIANT'LARI (düzeltilmiş set)
   ══════════════════════════════════════════════════════════════════════════════════════ */

describe("§13 invariant — ters kaydın net etkisi = 0", () => {
  it("her büyüklükte tam ters kayıt kuruş artığı bırakmaz", () => {
    for (const gross of ["100.00", "0.01", "1262.145", "999999999999.99", "33.33", "8450.75"]) {
      const rounded = money(gross);
      expect(remainingAmount(rounded, rounded)).toBe(0);
    }
  });

  it("defter üzerinde ters kayıt: kapanış = ters kayıttan önceki bakiye", () => {
    const before = runningBalance([
      { movementDate: "2026-01-01", debitAmount: 100_000.0, creditAmount: 0 },
    ]);
    const after = runningBalance(
      REVERSAL_LEDGER.input.movements.map((m) => ({ ...m })),
    );
    expect(after[after.length - 1].balance).toBe(before[before.length - 1].balance);
  });
});

describe("§13 invariant — kapalı kalemin açık bakiyesi = 0", () => {
  it("tamamı tahsil edilmiş faturanın kalanı sıfır", () => {
    expect(remainingAmount(money("12500.00"), money("12500.00"))).toBe(0);
    expect(openAmount(100_000.0, 100_000.0)).toBe(0);
  });

  it("kalanı sıfır olmayan kalem kapatılmış sayılamaz", () => {
    const { gross, paid } = INVOICE_PARTIAL_PAYMENT.input;
    expect(remainingAmount(gross, paid)).not.toBe(0);
    expect(suggestStatusFromPayment("open", gross, paid)).toBe("partial");
    // bir kuruş eksik bile 'paid' değildir
    expect(suggestStatusFromPayment("open", money("1500.00"), money("1499.99"))).toBe("partial");
  });
});

describe("§13 invariant — Σdağıtım ≤ kaynak dağıtılabilir tutar", () => {
  it("her dağıtım planında toplam, tahsilatı AŞMAZ ve artan açıkça raporlanır", () => {
    const plans = [
      {
        amount: ALLOCATION_FIFO_EXACT.input.amount,
        plan: planAllocation(
          ALLOCATION_FIFO_EXACT.input.amount,
          ALLOCATION_FIFO_EXACT.input.invoices.map((i) => ({ ...i })),
        ),
      },
      {
        amount: ALLOCATION_LEFTOVER.input.amount,
        plan: planAllocation(
          ALLOCATION_LEFTOVER.input.amount,
          ALLOCATION_LEFTOVER.input.invoices.map((i) => ({ ...i })),
        ),
      },
    ];
    for (const { amount, plan } of plans) {
      expect(plan.allocated).toBeLessThanOrEqual(amount);
      expect(sumMoney(plan.lines.map((l) => l.amount))).toBe(plan.allocated);
      // dağıtılan + artan = tahsilat; hiçbir kuruş yolda kaybolmaz
      expect(formatMoney(add(plan.allocated, plan.unallocated).toString())).toBe(
        formatMoney(amount),
      );
    }
  });

  it("hiçbir dağıtım satırı ilgili faturanın açığını aşmaz", () => {
    const plan = planAllocation(
      ALLOCATION_FIFO_EXACT.input.amount,
      ALLOCATION_FIFO_EXACT.input.invoices.map((i) => ({ ...i })),
    );
    for (const line of plan.lines) {
      const inv = ALLOCATION_FIFO_EXACT.input.invoices.find((i) => i.invoiceId === line.invoiceId);
      expect(inv).toBeDefined();
      expect(line.amount).toBeLessThanOrEqual(inv!.openAmount);
    }
  });

  it("maliyet dağıtımında parçaların toplamı bütüne TAM eşit (kuruş kaybolmaz)", () => {
    const equal = allocate(
      COSTING_ALLOCATION_REMAINDER.input.equalThirds.totalCost,
      COSTING_ALLOCATION_REMAINDER.input.equalThirds.targets.map((t) => ({ ...t })),
    );
    expect(allocationTotal(equal)).toBe(COSTING_ALLOCATION_REMAINDER.input.equalThirds.totalCost);
  });
});

describe("§13 invariant — nakit akış kimliği: kapanış = açılış + gelir − gider", () => {
  it("bilinen her ay için kimlik kuruşu kuruşuna tutuyor", () => {
    const known = CASHFLOW_IDENTITY_MONTHS.input.months.filter(
      (m) => m.opening !== null && m.income !== null && m.expense !== null,
    );
    const expected = ["800000.00", "50000.00", "-300000.00", "300000.00"];
    known.forEach((m, i) => {
      expect(
        sub(add(m.opening as number, m.income as number), m.expense as number).toFixed(2),
      ).toBe(expected[i]);
    });
  });

  it("hazine ufkunda da aynı kimlik: projeksiyon = açılış + net akış", () => {
    const actual = liquidityHorizons({
      openingPosition: CASHFLOW_LIQUIDITY_HORIZONS.input.openingPosition,
      flows: CASHFLOW_LIQUIDITY_HORIZONS.input.flows.map((f) => ({ ...f })),
      todayISO: CASHFLOW_LIQUIDITY_HORIZONS.input.todayISO,
      minCashFloor: CASHFLOW_LIQUIDITY_HORIZONS.input.minCashFloor,
    });
    // elle: 1.500.000 − 150.000 / − 210.000,50 / − 1.110.000,50
    expect(actual.map((h) => formatMoney(h.projectedContracted))).toEqual([
      "1350000.00",
      "1289999.50",
      "389999.50",
    ]);
  });

  it("gider gelirden büyükse kapanış negatife geçer, sıfıra kırpılmaz", () => {
    expect(sub(add(100_000.0, 0), 250_000.0).toFixed(2)).toBe("-150000.00");
  });
});

describe("§13 invariant — aşırı ödeme KORUNUR, sessizce kırpılmaz", () => {
  it("kalan negatif kalır ve fatura 'paid' okunur", () => {
    const { gross, paid } = INVOICE_OVERPAYMENT.input;
    const remaining = remainingAmount(gross, paid);
    expect(remaining).toBe(-549.25);
    expect(remaining).toBeLessThan(0);
    expect(suggestStatusFromPayment("open", gross, paid)).toBe("paid");
  });

  it("NEGATİF KONTROL — sıfıra kırpan naif yol farklı bir cevap verir", () => {
    // Eğer bir gün biri remainingAmount'u Math.max(0, …) ile 'düzeltirse', gerçekten hareket
    // etmiş 549,25 TL ekrandan silinir. Bu iddia o düzeltmenin yapılmadığını ispat eder.
    const { gross, paid } = INVOICE_OVERPAYMENT.input;
    const naiveClamped = Math.max(0, gross - paid);
    expect(naiveClamped).toBe(0);
    expect(remainingAmount(gross, paid)).not.toBe(naiveClamped);
  });
});

describe("§13 invariant — null ASLA sessizce sıfır sayılmaz", () => {
  it("money katmanı: bilinmeyen bilinmeyen kalır, açık sıfır sıfır kalır", () => {
    expect(moneyOrNull(null)).toBeNull();
    expect(moneyOrNull("")).toBeNull();
    expect(moneyOrNull("0.00")).toBe(0);
    expect(sumMoney(["10.00", null, "5.50", undefined, ""])).toBe(15.5);
  });

  it("çek takviminde tutarı bilinmeyen kalem sayılır ama toplanmaz", () => {
    const buckets = groupMaturities(toMaturityItems(CHECK_MATURITY_GROUPING.input.items), "month");
    expect(buckets[0].missingCount).toBe(1);
    expect(buckets[0].count).toBe(4);
    // bilinmeyen 0 sayılsaydı çıkış yine 200.000 çıkardı; ayrımı yapan şey missingCount'tur
    expect(buckets[0].knownOutflow).toBe(200_000.0);
  });

  it("kredi mutabakatında eksik alan hayalî sapma üretmez", () => {
    const actual = reconcileLoan({ ...LOAN_NULL_NOT_ZERO.input });
    expect(actual.issues.map((i) => i.code)).toEqual(["missing_totals"]);
  });

  it("kur, bütçe, limit ve mutabakat: bilinmeyen NULL döner, 0 değil", () => {
    expect(revalue({ ...FX_UNKNOWN_RATE.input }).unrealizedGainLoss).toBeNull();
    expect(variance("expense", 100_000.0, null).varianceAmount).toBeNull();
    expect(variance("expense", 100_000.0, null).verdict).toBe("not_measured");
    expect(utilization(0, [100_000.0]).utilizationRatio).toBeNull();
    expect(reconciliationVerdict(1_290_000.0, null).difference).toBeNull();
    expect(computeDSO(2_450_000.0, 0, 90)).toBeNull();
    expect(profitability(500_000.0, null).margin).toBeNull();
    expect(cashCycle(62.5, null, 41.2).cashConversionCycleDays).toBeNull();
  });

  it("yoğunlaşmada tutarı bilinmeyen satır ayrı sayılır, toplama girmez", () => {
    const actual = concentration(
      CONCENTRATION_RISK.input.items.map((i) => ({ ...i })),
      CONCENTRATION_RISK.input.flagRatio,
    );
    expect(actual.unknownCount).toBe(1);
    expect(actual.knownTotal).toBe(1_500_000.0);
    expect(actual.entries.some((e) => e.key === "Müşteri D")).toBe(false);
  });
});

describe("§13 invariant — fatura / ödeme / banka arasında ÇİFTE SAYIM yasak", () => {
  it("kapanmış faturaya aynı tahsilat ikinci kez yazılamaz", () => {
    const c = ALLOCATION_CEILING.input.doubleApply;
    expect(wouldExceedCeiling(c.gross, c.alreadyAllocated, c.newAmount)).toBe(true);
  });

  it("tamamı kapanmış fatura ikinci dağıtımda aday değildir; para açıkta gösterilir", () => {
    const settled: AllocatableInvoice[] = [
      { invoiceId: "INV-9001", openAmount: 0, dueDate: "2026-06-30", issueDate: "2026-06-01" },
    ];
    const second = planAllocation(100_000.0, settled);
    expect(second.lines).toHaveLength(0);
    expect(second.allocated).toBe(0);
    // 100.000,00 sessizce emilmez; operatöre açıkta olarak gösterilir
    expect(second.unallocated).toBe(100_000.0);
  });

  it("banka bacağı: sınır günündeki hareket TEK bir ufka yazılır", () => {
    const actual = liquidityHorizons({
      openingPosition: CASHFLOW_LIQUIDITY_HORIZONS.input.openingPosition,
      flows: CASHFLOW_LIQUIDITY_HORIZONS.input.flows.map((f) => ({ ...f })),
      todayISO: CASHFLOW_LIQUIDITY_HORIZONS.input.todayISO,
      minCashFloor: CASHFLOW_LIQUIDITY_HORIZONS.input.minCashFloor,
    });
    // 30 günlük sözleşmeli net − 7 günlük sözleşmeli net = yalnız 09-01 tarihli tek hareket
    expect(formatMoney(sub(actual[1].contractedNet, actual[0].contractedNet).toString())).toBe(
      "-60000.50",
    );
    expect(actual[0].flowCount).toBe(2);
    expect(actual[1].flowCount).toBe(4);
  });

  it("fatura bacağı: aynı fatura iki kez girildiğinde şüpheli olarak işaretlenir", () => {
    const { sameNumber } = INVOICE_DUPLICATE.input;
    const a = assessDuplicate({ ...sameNumber.a }, { ...sameNumber.b });
    expect(a.isSuspect).toBe(true);
    expect(a.confidence).toBe(1);
  });

  it("çek bacağı: ileri pencereler yarı-açık, bir çek iki pencerede birden SAYILMAZ", () => {
    const windows = maturityWindows(
      toMaturityItems(CHECK_MATURITY_WINDOWS.input.items),
      CHECK_MATURITY_WINDOWS.input.todayISO,
      [7, 14],
    );
    // 14 günlük pencere 7 günlüğü KAPSAR; fark tam olarak W-3'ün 60.000,00'ıdır
    expect(formatMoney(sub(windows[1].knownOutflow, windows[0].knownOutflow).toString())).toBe(
      "60000.00",
    );
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════
   13. REHBER §13 — PRECISION
   ══════════════════════════════════════════════════════════════════════════════════════ */

describe("§13 precision — yarım kuruş, negatif, çok büyük, binlerce toplama, sınır, yön", () => {
  it("yuvarlama YÖNÜ half-up (sıfırdan uzağa) — banker's rounding DEĞİL", () => {
    const actual = PRECISION_ROUNDING_DIRECTION.input.map((v) => formatMoney(v));
    expect(actual).toEqual([...PRECISION_ROUNDING_DIRECTION.expected.halfUp]);
    // ayırt edici iki vaka: half-even olsaydı 2,66 ve 2,68 çıkardı
    expect(formatMoney("2.665")).not.toBe(PRECISION_ROUNDING_DIRECTION.expected.halfEvenWouldGive[0]);
    expect(formatMoney("2.685")).not.toBe(PRECISION_ROUNDING_DIRECTION.expected.halfEvenWouldGive[1]);
  });

  it("NEGATİF KONTROL — JS toFixed aynı girdilerde farklı cevap verir", () => {
    const viaToFixed = PRECISION_ROUNDING_DIRECTION.input.map((v) => Number(v).toFixed(2));
    expect(viaToFixed).toEqual([...PRECISION_ROUNDING_DIRECTION.expected.toFixedGives]);
    // en az bir yerde ayrışmak zorunda, yoksa money katmanı hiçbir şey ispat etmiyor demektir
    expect(viaToFixed).not.toEqual([...PRECISION_ROUNDING_DIRECTION.expected.halfUp]);
    expect(Number("1.005").toFixed(2)).toBe("1.00");
    expect(formatMoney("1.005")).toBe("1.01");
  });

  it("yarım kuruş fatura satırında da half-up: 1,005 → 1,01", () => {
    const line = computeLineTotals({ quantity: 1, unitPrice: 1.005, taxRate: 0.2 });
    expect(line.netAmount).toBe(1.01);
    expect(line.grossAmount).toBe(1.21);
    // NEGATİF KONTROL: toFixed yolu 1,00 verirdi ve KDV tabanı bir kuruş eksik olurdu
    expect(Number((1.005).toFixed(2))).toBe(1.0);
    expect(line.netAmount).not.toBe(Number((1.005).toFixed(2)));
  });

  it("negatif tutarlar da sıfırdan uzağa yuvarlanır", () => {
    expect(formatMoney("-2.675")).toBe("-2.68");
    expect(money("-0.005")).toBe(-0.01);
    expect(money("-999999999999.99")).toBe(-999999999999.99);
  });

  it("milyar TL ölçeği: her kuruş korunur", () => {
    expect(sumMoney([...PRECISION_LARGE_AMOUNTS.input.billions])).toBe(
      PRECISION_LARGE_AMOUNTS.expected.billions,
    );
    expect(formatMoney(sumMoney([...PRECISION_LARGE_AMOUNTS.input.billions]))).toBe(
      PRECISION_LARGE_AMOUNTS.expected.billionsFormatted,
    );
    expect(sumMoney([...PRECISION_LARGE_AMOUNTS.input.nearMax])).toBe(
      PRECISION_LARGE_AMOUNTS.expected.nearMax,
    );
    expect(formatMoney(sumMoney([...PRECISION_LARGE_AMOUNTS.input.nearMax]))).toBe(
      PRECISION_LARGE_AMOUNTS.expected.nearMaxFormatted,
    );
    expect(sumMoney([...PRECISION_LARGE_AMOUNTS.input.maxPlusMax])).toBe(
      PRECISION_LARGE_AMOUNTS.expected.maxPlusMax,
    );
  });

  it("binlerce toplama sürüklenmiyor — 5.000 × 12.345,67", () => {
    const rows = Array.from({ length: PRECISION_MANY_ADDITIONS.input.rowCount }, () =>
      PRECISION_MANY_ADDITIONS.input.amount,
    );
    expect(sumMoney(rows)).toBe(PRECISION_MANY_ADDITIONS.expected.exact);
    expect(formatMoney(sumMoney(rows))).toBe(PRECISION_MANY_ADDITIONS.expected.exactFormatted);
  });

  it("NEGATİF KONTROL — aynı toplama `+=` ile float üzerinde SÜRÜKLENİYOR", () => {
    let drift = 0;
    for (let i = 0; i < PRECISION_MANY_ADDITIONS.input.rowCount; i += 1) {
      drift += Number(PRECISION_MANY_ADDITIONS.input.amount);
    }
    expect(drift).toBe(PRECISION_MANY_ADDITIONS.expected.floatDrift);
    expect(drift).not.toBe(PRECISION_MANY_ADDITIONS.expected.exact);
  });

  it("sınır değerler: açık sıfır ile bilinmeyen ayrı, en küçük birim 0,01 TL", () => {
    const actual = PRECISION_BOUNDARY_VALUES.input.map((v) => moneyOrNull(v));
    expect(actual).toEqual([...PRECISION_BOUNDARY_VALUES.expected]);
  });

  it("ölçek sabitleri şemayla uyumlu (para 2 hane, oran 10 hane)", () => {
    expect(MONEY_DP).toBe(2);
    expect(RATE_DP).toBe(10);
  });

  it("NEGATİF KONTROL — gün farkı çıkarması float ile 21,3 vermiyor", () => {
    // costing.cashCycle 62,5 − 41,2 için ondalık kullanır; düz float 21.299999999999997 verir.
    expect(62.5 - 41.2).toBe(COSTING_CASH_CYCLE.expected.floatResult);
    expect(62.5 - 41.2).not.toBe(COSTING_CASH_CYCLE.expected.cycleExcludingInventory);
    expect(cashCycle(62.5, null, 41.2).cycleExcludingInventory).toBe(
      COSTING_CASH_CYCLE.expected.cycleExcludingInventory,
    );
  });
});

/* ══════════════════════════════════════════════════════════════════════════════════════
   14. KAPSAM MANİFESTOSU — rehber §13'ün listesi eksiksiz kapanmalı
   ══════════════════════════════════════════════════════════════════════════════════════ */

describe("kapsam manifestosu — §13 listesindeki her başlık kapsanıyor", () => {
  it("her zorunlu alan en az bir golden vaka tarafından kapsanıyor", () => {
    const covered = new Set(GOLDEN_CASE_INDEX.map((c) => c.area));
    const missing = REQUIRED_AREAS.filter((a) => !covered.has(a));
    expect(missing).toEqual([]);
  });

  it("vaka kimlikleri benzersiz", () => {
    const ids = GOLDEN_CASE_INDEX.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("paket asgari genişlikte (14 zorunlu alan, en az 40 vaka)", () => {
    expect(REQUIRED_AREAS).toHaveLength(14);
    expect(GOLDEN_CASE_INDEX.length).toBeGreaterThanOrEqual(40);
  });
});
