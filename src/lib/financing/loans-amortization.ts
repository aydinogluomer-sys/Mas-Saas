// Faz 58 (M-39 & M-40) — Tam Kredi & Finansal Kiralama (Leasing) Ödeme Planı Üreticisi
// (Eşit Taksit / Eşit Anapara / Tek Vadeli Spot / Leasing 301-302; Sabit ve Değişken TLREF/SOFR/EURIBOR + Spread;
// Ticari BSMV %5 & KKDF; Banka Kullanım Girişi ve 102/300 & 253+302/301 Açılış Yevmiyesi).

import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { sha256 } from "@/lib/importers/row-utils";
import { DomainError } from "@/lib/domain-error";
import { postJournalEntryWithClient } from "@/lib/ledger/posting-engine";
import { decimal, money } from "@/lib/money";
import { parseOrThrow } from "@/lib/validation";
import { scheduleDueDates } from "./rules";

export const LOAN_KINDS = ["installment", "spot", "revolving", "leasing"] as const;
export type LoanKind = (typeof LOAN_KINDS)[number];

export const LOAN_SCHEDULE_METHODS = ["annuity", "equal_principal", "spot", "leasing"] as const;
export type LoanScheduleMethod = (typeof LOAN_SCHEDULE_METHODS)[number];

export const LOAN_INTEREST_TYPES = [
  "fixed",
  "floating_tlref",
  "floating_sofr",
  "floating_euribor",
] as const;
export type LoanInterestType = (typeof LOAN_INTEREST_TYPES)[number];

export interface AmortizationInput {
  principal: number;
  installmentCount: number;
  firstPaymentDate: string;
  scheduleMethod: LoanScheduleMethod;
  interestType: LoanInterestType;
  annualInterestRatePct: number; // e.g. 48 for 48% annual nominal when fixed
  referenceRatePct?: number | null; // e.g. 45.5 for TLREF
  spreadBps?: number | null; // e.g. 350 for +3.50%
  bsmvRate?: number; // decimal ratio e.g. 0.05 (5% commercial BSMV)
  kkdfRate?: number; // decimal ratio e.g. 0 (0% commercial TRY KKDF)
}

export interface GeneratedInstallmentRow {
  installmentNo: number;
  dueDate: string;
  openingPrincipal: number;
  principalComponent: number;
  interestComponent: number;
  bsmvComponent: number;
  kkdfComponent: number;
  taxComponent: number;
  installmentAmount: number;
  closingPrincipal: number;
}

export interface GeneratedLoanSchedule {
  effectiveAnnualRatePct: number;
  monthlyNominalRatePct: number;
  monthlyCostRatePct: number;
  annualCostRatePct: number;
  totalPrincipal: number;
  totalInterest: number;
  totalBsmv: number;
  totalKkdf: number;
  totalTax: number;
  totalFinanceCost: number;
  totalPayment: number;
  representativeInstallmentAmount: number;
  rows: GeneratedInstallmentRow[];
}

/**
 * Pure decimal (`big.js`) Turkish commercial loan & leasing schedule generator.
 * ZERO native floating-point arithmetic (`Math.pow` avoided — exact `Decimal.pow` used).
 */
export function generateLoanAmortizationSchedule(raw: AmortizationInput): GeneratedLoanSchedule {
  const principalDec = decimal(raw.principal).round(2);
  if (principalDec.lte(0)) {
    throw new DomainError("Kredi anaparası sıfırdan büyük olmalıdır.");
  }

  const isSpot = raw.scheduleMethod === "spot";
  const n = isSpot ? 1 : Math.max(1, Math.min(360, Math.trunc(raw.installmentCount)));
  const bsmvRateDec =
    raw.scheduleMethod === "leasing"
      ? decimal(0)
      : decimal(Math.max(0, raw.bsmvRate ?? 0.05));
  const kkdfRateDec =
    raw.scheduleMethod === "leasing"
      ? decimal(0)
      : decimal(Math.max(0, raw.kkdfRate ?? 0));

  const effectiveAnnualPctDec =
    raw.interestType === "fixed"
      ? decimal(Math.max(0, raw.annualInterestRatePct))
      : decimal(Math.max(0, raw.referenceRatePct ?? raw.annualInterestRatePct)).plus(
          decimal(raw.spreadBps ?? 0).div(100),
        );

  // Monthly nominal interest rate as decimal ratio: (annualPct / 100) / 12
  // For spot loans with termMonths = raw.installmentCount > 1, accrue over installmentCount months!
  const spotMonths = isSpot ? Math.max(1, Math.trunc(raw.installmentCount)) : 1;
  const rMonthly = effectiveAnnualPctDec.div(100).div(12);
  const taxMultiplier = decimal(1).plus(bsmvRateDec).plus(kkdfRateDec);
  const rEffectiveMonthly = rMonthly.times(taxMultiplier);

  const dates = scheduleDueDates(raw.firstPaymentDate, n);
  const rows: GeneratedInstallmentRow[] = [];

  let remaining = principalDec;
  let fixedAnnuityPayment = decimal(0);

  if ((raw.scheduleMethod === "annuity" || raw.scheduleMethod === "leasing") && n > 1) {
    if (rEffectiveMonthly.eq(0)) {
      fixedAnnuityPayment = principalDec.div(n).round(2);
    } else {
      // PMT = P * rEff * (1 + rEff)^n / ((1 + rEff)^n - 1) using big.js integer exponent .pow(n)
      const onePlusR = decimal(1).plus(rEffectiveMonthly);
      const factor = onePlusR.pow(n);
      fixedAnnuityPayment = principalDec
        .times(rEffectiveMonthly)
        .times(factor)
        .div(factor.minus(1))
        .round(2);
    }
  }

  const fixedEqualPrincipalSlice =
    raw.scheduleMethod === "equal_principal" ? principalDec.div(n).round(2) : decimal(0);

  for (let i = 0; i < n; i++) {
    const isLast = i === n - 1;
    const dueDate = dates[i]?.dueDate ?? raw.firstPaymentDate;
    const opening = remaining;

    const periodRate = isSpot ? rMonthly.times(spotMonths) : rMonthly;
    const interest = opening.times(periodRate).round(2);
    const bsmv = interest.times(bsmvRateDec).round(2);
    const kkdf = interest.times(kkdfRateDec).round(2);
    const tax = bsmv.plus(kkdf).round(2);

    let principalSlice: ReturnType<typeof decimal>;
    if (isLast) {
      principalSlice = opening;
    } else if (raw.scheduleMethod === "equal_principal") {
      principalSlice = fixedEqualPrincipalSlice;
    } else if (raw.scheduleMethod === "spot") {
      principalSlice = opening;
    } else {
      const candidatePrincipal = fixedAnnuityPayment.minus(interest).minus(tax).round(2);
      principalSlice = candidatePrincipal.gt(0)
        ? candidatePrincipal.gt(opening)
          ? opening
          : candidatePrincipal
        : decimal(0);
    }

    const totalInstallment = principalSlice.plus(interest).plus(tax).round(2);
    const closing = opening.minus(principalSlice).round(2);
    remaining = closing;

    rows.push({
      installmentNo: i + 1,
      dueDate,
      openingPrincipal: Number(opening.toFixed(2)),
      principalComponent: Number(principalSlice.toFixed(2)),
      interestComponent: Number(interest.toFixed(2)),
      bsmvComponent: Number(bsmv.toFixed(2)),
      kkdfComponent: Number(kkdf.toFixed(2)),
      taxComponent: Number(tax.toFixed(2)),
      installmentAmount: Number(totalInstallment.toFixed(2)),
      closingPrincipal: Number(closing.toFixed(2)),
    });
  }

  const sumBy = (fn: (r: GeneratedInstallmentRow) => number) =>
    rows.reduce((acc, r) => acc.plus(fn(r)), decimal(0)).round(2);

  const totalPrincipal = sumBy((r) => r.principalComponent);
  const totalInterest = sumBy((r) => r.interestComponent);
  const totalBsmv = sumBy((r) => r.bsmvComponent);
  const totalKkdf = sumBy((r) => r.kkdfComponent);
  const totalTax = sumBy((r) => r.taxComponent);
  const totalFinanceCost = totalInterest.plus(totalTax).round(2);
  const totalPayment = totalPrincipal.plus(totalFinanceCost).round(2);

  const monthlyNominalPct = Number(rMonthly.times(100).round(4).toFixed(4));
  const monthlyCostPct = Number(rEffectiveMonthly.times(100).round(4).toFixed(4));
  const annualCostPct = Number(rEffectiveMonthly.times(12).times(100).round(4).toFixed(4));

  return {
    effectiveAnnualRatePct: Number(effectiveAnnualPctDec.round(4).toFixed(4)),
    monthlyNominalRatePct: monthlyNominalPct,
    monthlyCostRatePct: monthlyCostPct,
    annualCostRatePct: annualCostPct,
    totalPrincipal: Number(totalPrincipal.toFixed(2)),
    totalInterest: Number(totalInterest.toFixed(2)),
    totalBsmv: Number(totalBsmv.toFixed(2)),
    totalKkdf: Number(totalKkdf.toFixed(2)),
    totalTax: Number(totalTax.toFixed(2)),
    totalFinanceCost: Number(totalFinanceCost.toFixed(2)),
    totalPayment: Number(totalPayment.toFixed(2)),
    representativeInstallmentAmount: rows[0]?.installmentAmount ?? 0,
    rows,
  };
}

export const createAmortizedLoanSchema = z.object({
  name: z.string().trim().min(2, "Kredi adı en az 2 karakter olmalıdır.").max(180),
  lenderPartyId: z.string().uuid().nullable().optional(),
  currency: z.string().trim().toUpperCase().regex(/^[A-Z]{3}$/).default("TRY"),
  loanKind: z.enum(LOAN_KINDS).default("installment"),
  scheduleMethod: z.enum(LOAN_SCHEDULE_METHODS).default("annuity"),
  interestType: z.enum(LOAN_INTEREST_TYPES).default("fixed"),
  principal: z.coerce.number().positive("Anapara sıfırdan büyük olmalıdır."),
  installmentCount: z.coerce.number().int().min(1).max(360),
  firstPaymentDate: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "İlk taksit tarihi YYYY-MM-DD olmalıdır."),
  disbursementDate: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  annualInterestRatePct: z.coerce.number().min(0).max(500).default(0),
  referenceRatePct: z.coerce.number().min(0).max(500).nullable().optional(),
  spreadBps: z.coerce.number().int().min(-5000).max(50000).nullable().optional(),
  bsmvRate: z.coerce.number().min(0).max(1).default(0.05),
  kkdfRate: z.coerce.number().min(0).max(1).default(0),
  disbursementAccountId: z.string().uuid().nullable().optional(),
  notes: z.string().trim().max(1000).nullable().optional(),
});

async function ensureBankAccountRow(client: PoolClient, cashAccountId: string): Promise<string> {
  const acct = await client.query<{ id: string; currency: string }>(
    `select id::text, currency from public.cash_accounts where id = $1 and is_active = true`,
    [cashAccountId],
  );
  if (acct.rowCount !== 1) {
    throw new DomainError("Seçilen kasa/banka hesabı bulunamadı veya aktif değil.");
  }
  await client.query(
    `insert into public.bank_accounts (cash_account_id) values ($1) on conflict (cash_account_id) do nothing`,
    [cashAccountId],
  );
  return acct.rows[0].currency;
}

export async function createLoanWithAmortization(
  pool: Pool,
  raw: unknown,
  actorId: string,
): Promise<{ loanId: string; installmentsCreated: number; openingJournalEntryId: string | null }> {
  const input = parseOrThrow(createAmortizedLoanSchema, raw, "Kredi ve ödeme planı oluşturma");
  const effectiveMethod: LoanScheduleMethod =
    input.loanKind === "leasing"
      ? "leasing"
      : input.loanKind === "spot"
        ? "spot"
        : input.scheduleMethod;

  const schedule = generateLoanAmortizationSchedule({
    principal: input.principal,
    installmentCount: input.installmentCount,
    firstPaymentDate: input.firstPaymentDate,
    scheduleMethod: effectiveMethod,
    interestType: input.interestType,
    annualInterestRatePct: input.annualInterestRatePct,
    referenceRatePct: input.referenceRatePct ?? null,
    spreadBps: input.spreadBps ?? null,
    bsmvRate: input.bsmvRate,
    kkdfRate: input.kkdfRate,
  });

  const client = await pool.connect();
  try {
    await client.query("begin");

    if (input.disbursementAccountId) {
      const acctCurr = await ensureBankAccountRow(client, input.disbursementAccountId);
      if (acctCurr !== input.currency) {
        throw new DomainError(
          `Kredi para birimi (${input.currency}) ile seçilen kullanım banka hesabı (${acctCurr}) aynı olmalıdır.`,
        );
      }
    }

    const loanIns = await client.query<{ id: string }>(
      `insert into public.loans
         (name, lender_party_id, currency, loan_kind, interest_type,
          reference_rate_pct, spread_bps,
          principal, term_months, installment_count, first_payment_date,
          simple_interest_rate, applied_interest_rate, monthly_cost_rate, annual_cost_rate,
          bsmv_rate, kkdf_rate, installment_amount, total_payment, total_finance_cost,
          disbursement_account_id, status, notes)
       values ($1, $2, $3, $4, $5,
               $6, $7,
               $8::numeric, $9, $10, $11::date,
               $12::numeric, $13::numeric, $14::numeric, $15::numeric,
               $16::numeric, $17::numeric, $18::numeric, $19::numeric, $20::numeric,
               $21, 'active', $22)
       returning id::text`,
      [
        input.name,
        input.lenderPartyId ?? null,
        input.currency,
        input.loanKind,
        input.interestType,
        input.referenceRatePct ?? null,
        input.spreadBps ?? null,
        money(input.principal),
        input.installmentCount,
        schedule.rows.length,
        input.firstPaymentDate,
        decimal(schedule.effectiveAnnualRatePct).div(100).toFixed(4),
        decimal(schedule.monthlyNominalRatePct).div(100).toFixed(4),
        decimal(schedule.monthlyCostRatePct).div(100).toFixed(4),
        decimal(schedule.annualCostRatePct).div(100).toFixed(4),
        input.loanKind === "leasing" ? 0 : input.bsmvRate,
        input.loanKind === "leasing" ? 0 : input.kkdfRate,
        schedule.representativeInstallmentAmount,
        schedule.totalPayment,
        schedule.totalFinanceCost,
        input.disbursementAccountId ?? null,
        input.notes ?? null,
      ],
    );
    if (loanIns.rowCount !== 1) {
      throw new DomainError("Kredi kaydı oluşturulamadı.");
    }
    const loanId = loanIns.rows[0].id;

    for (const row of schedule.rows) {
      await client.query(
        `insert into public.loan_installments
           (loan_id, installment_no, due_date, amount,
            principal_component, interest_component, tax_component,
            bsmv_component, kkdf_component, status)
         values ($1, $2, $3::date, $4::numeric,
                 $5::numeric, $6::numeric, $7::numeric,
                 $8::numeric, $9::numeric, 'planned')`,
        [
          loanId,
          row.installmentNo,
          row.dueDate,
          row.installmentAmount,
          row.principalComponent,
          row.interestComponent,
          row.taxComponent,
          row.bsmvComponent,
          row.kkdfComponent,
        ],
      );
    }

    const disbDate = input.disbursementDate ?? input.firstPaymentDate;
    let openingJournalEntryId: string | null = null;

    if (input.loanKind === "leasing") {
      // M-40: Finansal kiralama açılış yevmiyesi: Borç 253 (anapara) + Borç 302 (ertelenmiş faiz) / Alacak 301 (brüt kira borcu)
      const grossLeaseLiability = Number(
        decimal(schedule.totalPrincipal).plus(schedule.totalInterest).round(2).toFixed(2),
      );
      const leaseLines = [
        {
          accountCode: "253",
          debitNative: schedule.totalPrincipal,
          partyId: input.lenderPartyId ?? null,
          memo: `Finansal kiralama varlık aktifleştirmesi (${input.name})`,
        },
        ...(schedule.totalInterest > 0
          ? [
              {
                accountCode: "302",
                debitNative: schedule.totalInterest,
                partyId: input.lenderPartyId ?? null,
                memo: `Ertelenmiş finansal kiralama borçlanma maliyeti (${input.name})`,
              },
            ]
          : []),
        {
          accountCode: "301",
          creditNative: grossLeaseLiability,
          partyId: input.lenderPartyId ?? null,
          memo: `Finansal kiralama işlemlerinden borçlar (${input.name})`,
        },
      ];
      const je = await postJournalEntryWithClient(
        client,
        {
          entryDate: disbDate,
          sourceType: "loan_disbursement",
          sourceId: loanId,
          idempotencyKey: `loan:disbursement:${loanId}`,
          description: `Finansal Kiralama Sözleşme Açılışı (${input.name})`,
          currency: input.currency,
          lines: leaseLines,
        },
        actorId,
      );
      openingJournalEntryId = je.entryId;
    } else if (input.disbursementAccountId) {
      // M-39: Kredi kullanımı banka girişi + 102 / 300 TDHP yevmiyesi
      const dedupeHash = sha256(Buffer.from(`loan_disbursement:${loanId}:${input.disbursementAccountId}`, "utf8"));
      await client.query(
        `insert into public.bank_transactions
           (bank_account_id, txn_date, value_date, amount, currency, description,
            counterparty_name_raw, category, category_rule, transaction_kind, status, dedupe_hash)
         values ($1, $2::date, $2::date, $3::numeric, $4, $5,
                 $6, 'loan_inflow', 'system_internal_settlement', 'standard', 'unmatched', $7)`,
        [
          input.disbursementAccountId,
          disbDate,
          money(input.principal),
          input.currency,
          `Kredi kullanımı anapara girişi: ${input.name}`,
          input.name,
          dedupeHash,
        ],
      );

      const je = await postJournalEntryWithClient(
        client,
        {
          entryDate: disbDate,
          sourceType: "loan_disbursement",
          sourceId: loanId,
          idempotencyKey: `loan:disbursement:${loanId}`,
          description: `Banka Kredisi Kullanım Açılışı (${input.name})`,
          currency: input.currency,
          lines: [
            {
              accountCode: "102",
              debitNative: money(input.principal),
              memo: `Kredi kullanımı banka girişi (${input.name})`,
            },
            {
              accountCode: "300",
              creditNative: money(input.principal),
              partyId: input.lenderPartyId ?? null,
              memo: `Banka kredileri anapara yükümlülüğü (${input.name})`,
            },
          ],
        },
        actorId,
      );
      openingJournalEntryId = je.entryId;
    }

    if (openingJournalEntryId) {
      await client.query(
        `update public.loans set opening_journal_entry_id = $2 where id = $1`,
        [loanId, openingJournalEntryId],
      );
    }

    await audit(client, {
      actor: actorId,
      action: "create_loan_with_amortization",
      entityTable: "loans",
      entityId: loanId,
      after: {
        name: input.name,
        loanKind: input.loanKind,
        scheduleMethod: effectiveMethod,
        interestType: input.interestType,
        currency: input.currency,
        principal: money(input.principal),
        installmentCount: schedule.rows.length,
        effectiveAnnualRatePct: schedule.effectiveAnnualRatePct,
        totalInterest: schedule.totalInterest,
        totalBsmv: schedule.totalBsmv,
        totalKkdf: schedule.totalKkdf,
        totalPayment: schedule.totalPayment,
        disbursementAccountId: input.disbursementAccountId ?? null,
        openingJournalEntryId,
      },
    });

    await client.query("commit");
    return {
      loanId,
      installmentsCreated: schedule.rows.length,
      openingJournalEntryId,
    };
  } catch (e) {
    await client.query("rollback").catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}
