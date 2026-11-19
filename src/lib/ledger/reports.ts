// Faz 58 (M-42) — Tarih Aralıklı Yönetim Mizanı (Açılış + Dönem İçi + Kapanış),
// Dönemsel Gelir Tablosu / EBITDA, Tarih Bazlı Bilanço, 102.99 Banka Geçici Mutabakat Özeti
// ve TDHP 7xx -> 7x1 -> 6xx -> 690 -> 590/591 Dönem Sonu Yansıtma & Kapanış Sihirbazı.

import type { Pool } from "pg";
import { z } from "zod";
import { DomainError } from "@/lib/domain-error";
import { decimal, money } from "@/lib/money";
import { parseOrThrow } from "@/lib/validation";
import { isMissingSchemaError } from "./accounts";
import {
  postJournalEntryWithClient,
  type BalanceSheetItem,
  type IncomeStatementSummary,
  type JournalLineInput,
  type PostJournalEntryResult,
} from "./posting-engine";

export interface DateFilteredTrialBalanceRow {
  accountId: string;
  accountCode: string;
  accountName: string;
  tdhpRootCode: string;
  accountClass: string;
  normalSide: string;
  ebitdaBucket: string;
  entryCount: number;
  openingDebitTry: number;
  openingCreditTry: number;
  periodDebitTry: number;
  periodCreditTry: number;
  debitTotalTry: number;
  creditTotalTry: number;
  debitBalanceTry: number;
  creditBalanceTry: number;
  netBalanceTry: number;
}

export interface SuspenseBankItem {
  entryId: string;
  entryNo: number;
  entryDate: string;
  bankTransactionId: string | null;
  description: string;
  currency: string;
  debitTry: number;
  creditTry: number;
  netSuspenseTry: number;
}

export interface DateFilteredLedgerReport {
  fromDate: string | null;
  toDate: string | null;
  trialBalance: DateFilteredTrialBalanceRow[];
  totalOpeningDebitTry: number;
  totalOpeningCreditTry: number;
  totalPeriodDebitTry: number;
  totalPeriodCreditTry: number;
  totalDebitTry: number;
  totalCreditTry: number;
  totalDebitBalanceTry: number;
  totalCreditBalanceTry: number;
  incomeStatement: IncomeStatementSummary;
  balanceSheet: BalanceSheetItem[];
  totalAssetsTry: number;
  totalLiabilitiesAndEquityTry: number;
  suspense10299Items: SuspenseBankItem[];
  suspense10299NetTry: number;
}

const isoDateOpt = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .nullable()
  .optional();

export const ledgerDateFilterSchema = z.object({
  from: isoDateOpt,
  to: isoDateOpt,
});

export async function loadDateFilteredLedgerReport(
  pool: Pool,
  rawFilter?: { from?: string | null; to?: string | null },
): Promise<DateFilteredLedgerReport> {
  const parsed = ledgerDateFilterSchema.safeParse({
    from: rawFilter?.from || null,
    to: rawFilter?.to || null,
  });
  const fromDate = parsed.success ? (parsed.data.from ?? null) : null;
  const toDate = parsed.success ? (parsed.data.to ?? null) : null;

  if (fromDate && toDate && fromDate > toDate) {
    throw new DomainError("Başlangıç tarihi bitiş tarihinden sonra olamaz.");
  }

  const [tbRes, plRes, suspenseRes] = await Promise.all([
    pool
      .query<{
        account_id: string;
        account_code: string;
        account_name: string;
        tdhp_root_code: string;
        account_class: string;
        normal_side: string;
        ebitda_bucket: string;
        entry_count: number;
        opening_debit_try: string;
        opening_credit_try: string;
        period_debit_try: string;
        period_credit_try: string;
      }>(
        `select ma.id::text as account_id,
                ma.code as account_code,
                ma.name as account_name,
                ma.tdhp_root_code,
                ma.account_class,
                ma.normal_side,
                ma.ebitda_bucket,
                count(distinct case
                  when ($1::date is null or je.entry_date >= $1::date)
                   and ($2::date is null or je.entry_date <= $2::date)
                  then je.id
                  else null
                end)::int as entry_count,
                coalesce(sum(case
                  when $1::date is not null and je.entry_date < $1::date then jl.debit_try
                  else 0
                end), 0)::numeric(16,2)::text as opening_debit_try,
                coalesce(sum(case
                  when $1::date is not null and je.entry_date < $1::date then jl.credit_try
                  else 0
                end), 0)::numeric(16,2)::text as opening_credit_try,
                coalesce(sum(case
                  when ($1::date is null or je.entry_date >= $1::date)
                   and ($2::date is null or je.entry_date <= $2::date)
                  then jl.debit_try
                  else 0
                end), 0)::numeric(16,2)::text as period_debit_try,
                coalesce(sum(case
                  when ($1::date is null or je.entry_date >= $1::date)
                   and ($2::date is null or je.entry_date <= $2::date)
                  then jl.credit_try
                  else 0
                end), 0)::numeric(16,2)::text as period_credit_try
           from public.management_accounts ma
           left join (
             public.management_journal_lines jl
             join public.management_journal_entries je
               on je.id = jl.entry_id
              and je.status in ('posted', 'reversed')
           ) on jl.account_id = ma.id
          where ma.is_active = true
          group by ma.id, ma.code, ma.name, ma.tdhp_root_code, ma.account_class, ma.normal_side, ma.ebitda_bucket
          order by ma.code asc`,
        [fromDate, toDate],
      )
      .catch((err: unknown) => {
        if (isMissingSchemaError(err)) return { rows: [], rowCount: 0 };
        throw err;
      }),
    pool
      .query<{
        gross_sales_try: string;
        sales_discounts_try: string;
        cogs_try: string;
        opex_total_try: string;
        da_addback_try: string;
        other_net_income_try: string;
        financing_expense_try: string;
        tax_expense_try: string;
        cumulative_unclosed_net_income_try: string;
      }>(
        `select coalesce(sum(case
                  when ($1::date is null or je.entry_date >= $1::date)
                   and ($2::date is null or je.entry_date <= $2::date)
                   and je.source_type <> 'period_closing'
                   and ma.account_class = 'revenue'
                  then jl.credit_try - jl.debit_try else 0 end), 0)::numeric(16,2)::text as gross_sales_try,
                coalesce(sum(case
                  when ($1::date is null or je.entry_date >= $1::date)
                   and ($2::date is null or je.entry_date <= $2::date)
                   and je.source_type <> 'period_closing'
                   and ma.account_class = 'contra_revenue'
                  then jl.debit_try - jl.credit_try else 0 end), 0)::numeric(16,2)::text as sales_discounts_try,
                coalesce(sum(case
                  when ($1::date is null or je.entry_date >= $1::date)
                   and ($2::date is null or je.entry_date <= $2::date)
                   and je.source_type <> 'period_closing'
                   and ma.account_class = 'cogs'
                  then jl.debit_try - jl.credit_try else 0 end), 0)::numeric(16,2)::text as cogs_try,
                coalesce(sum(case
                  when ($1::date is null or je.entry_date >= $1::date)
                   and ($2::date is null or je.entry_date <= $2::date)
                   and je.source_type <> 'period_closing'
                   and ma.account_class = 'opex'
                  then jl.debit_try - jl.credit_try else 0 end), 0)::numeric(16,2)::text as opex_total_try,
                coalesce(sum(case
                  when ($1::date is null or je.entry_date >= $1::date)
                   and ($2::date is null or je.entry_date <= $2::date)
                   and je.source_type <> 'period_closing'
                   and ma.ebitda_bucket = 'da_addback'
                  then jl.debit_try - jl.credit_try else 0 end), 0)::numeric(16,2)::text as da_addback_try,
                coalesce(sum(case
                  when ($1::date is null or je.entry_date >= $1::date)
                   and ($2::date is null or je.entry_date <= $2::date)
                   and je.source_type <> 'period_closing'
                   and ma.account_class = 'other_income_expense'
                   and ma.ebitda_bucket <> 'tax'
                  then jl.credit_try - jl.debit_try else 0 end), 0)::numeric(16,2)::text as other_net_income_try,
                coalesce(sum(case
                  when ($1::date is null or je.entry_date >= $1::date)
                   and ($2::date is null or je.entry_date <= $2::date)
                   and je.source_type <> 'period_closing'
                   and ma.account_class = 'finance_expense'
                  then jl.debit_try - jl.credit_try else 0 end), 0)::numeric(16,2)::text as financing_expense_try,
                coalesce(sum(case
                  when ($1::date is null or je.entry_date >= $1::date)
                   and ($2::date is null or je.entry_date <= $2::date)
                   and je.source_type <> 'period_closing'
                   and ma.ebitda_bucket = 'tax'
                  then jl.debit_try - jl.credit_try else 0 end), 0)::numeric(16,2)::text as tax_expense_try,
                coalesce(sum(case
                  when ($2::date is null or je.entry_date <= $2::date)
                   and ma.account_class in ('revenue', 'contra_revenue', 'cogs', 'opex', 'finance_expense', 'other_income_expense')
                  then jl.credit_try - jl.debit_try else 0 end), 0)::numeric(16,2)::text as cumulative_unclosed_net_income_try
           from public.management_journal_lines jl
           join public.management_journal_entries je
             on je.id = jl.entry_id
            and je.status in ('posted', 'reversed')
           join public.management_accounts ma
             on ma.id = jl.account_id`,
        [fromDate, toDate],
      )
      .catch((err: unknown) => {
        if (isMissingSchemaError(err)) return { rows: [], rowCount: 0 };
        throw err;
      }),
    pool
      .query<{
        entry_id: string;
        entry_no: string;
        entry_date: string;
        source_id: string | null;
        description: string;
        native_currency: string;
        debit_try: string;
        credit_try: string;
      }>(
        `select je.id::text as entry_id,
                je.entry_no::text as entry_no,
                to_char(je.entry_date, 'YYYY-MM-DD') as entry_date,
                je.source_id::text as source_id,
                je.description,
                jl.native_currency,
                coalesce(jl.debit_try, 0)::text as debit_try,
                coalesce(jl.credit_try, 0)::text as credit_try
           from public.management_journal_lines jl
           join public.management_journal_entries je on je.id = jl.entry_id
           join public.management_accounts ma on ma.id = jl.account_id
          where ma.code = '102.99'
            and je.status = 'posted'
            and ($1::date is null or je.entry_date <= $1::date)
          order by je.entry_date desc, je.entry_no desc
          limit 50`,
        [toDate],
      )
      .catch((err: unknown) => {
        if (isMissingSchemaError(err)) return { rows: [], rowCount: 0 };
        throw err;
      }),
  ]);

  const trialBalance: DateFilteredTrialBalanceRow[] = tbRes.rows.map((r) => {
    const openD = decimal(r.opening_debit_try ?? 0);
    const openC = decimal(r.opening_credit_try ?? 0);
    const openNet = openD.minus(openC);
    const openingDebitTry = openNet.gt(0) ? Number(openNet.round(2).toFixed(2)) : 0;
    const openingCreditTry = openNet.lt(0) ? Number(openNet.abs().round(2).toFixed(2)) : 0;

    const perD = decimal(r.period_debit_try ?? 0);
    const perC = decimal(r.period_credit_try ?? 0);
    const cumD = openD.plus(perD).round(2);
    const cumC = openC.plus(perC).round(2);
    const net = cumD.minus(cumC).round(2);

    return {
      accountId: r.account_id,
      accountCode: r.account_code,
      accountName: r.account_name,
      tdhpRootCode: r.tdhp_root_code,
      accountClass: r.account_class,
      normalSide: r.normal_side,
      ebitdaBucket: r.ebitda_bucket,
      entryCount: Number(r.entry_count ?? 0),
      openingDebitTry,
      openingCreditTry,
      periodDebitTry: Number(perD.round(2).toFixed(2)),
      periodCreditTry: Number(perC.round(2).toFixed(2)),
      debitTotalTry: Number(cumD.toFixed(2)),
      creditTotalTry: Number(cumC.toFixed(2)),
      debitBalanceTry: net.gt(0) ? Number(net.toFixed(2)) : 0,
      creditBalanceTry: net.lt(0) ? Number(net.abs().toFixed(2)) : 0,
      netBalanceTry: Number(net.toFixed(2)),
    };
  });

  const sumCol = (fn: (r: DateFilteredTrialBalanceRow) => number) =>
    Number(trialBalance.reduce((acc, r) => acc.plus(fn(r)), decimal(0)).round(2).toFixed(2));

  const totalOpeningDebitTry = sumCol((r) => r.openingDebitTry);
  const totalOpeningCreditTry = sumCol((r) => r.openingCreditTry);
  const totalPeriodDebitTry = sumCol((r) => r.periodDebitTry);
  const totalPeriodCreditTry = sumCol((r) => r.periodCreditTry);
  const totalDebitTry = sumCol((r) => r.debitTotalTry);
  const totalCreditTry = sumCol((r) => r.creditTotalTry);
  const totalDebitBalanceTry = sumCol((r) => r.debitBalanceTry);
  const totalCreditBalanceTry = sumCol((r) => r.creditBalanceTry);

  const pl = plRes.rows[0];
  const grossSales = decimal(pl?.gross_sales_try ?? 0);
  const salesDiscounts = decimal(pl?.sales_discounts_try ?? 0);
  const netSales = grossSales.minus(salesDiscounts);
  const cogs = decimal(pl?.cogs_try ?? 0);
  const grossProfit = netSales.minus(cogs);
  const opexTotal = decimal(pl?.opex_total_try ?? 0);
  const daAddback = decimal(pl?.da_addback_try ?? 0);
  const opexCash = opexTotal.minus(daAddback);
  const ebit = grossProfit.minus(opexTotal);
  const ebitda = ebit.plus(daAddback);
  const otherNet = decimal(pl?.other_net_income_try ?? 0);
  const finExp = decimal(pl?.financing_expense_try ?? 0);
  const ebt = ebit.plus(otherNet).minus(finExp);
  const taxExp = decimal(pl?.tax_expense_try ?? 0);
  const netInc = ebt.minus(taxExp);

  const incomeStatement: IncomeStatementSummary = {
    grossSalesTry: Number(grossSales.round(2).toFixed(2)),
    salesDiscountsTry: Number(salesDiscounts.round(2).toFixed(2)),
    netSalesTry: Number(netSales.round(2).toFixed(2)),
    cogsTry: Number(cogs.round(2).toFixed(2)),
    grossProfitTry: Number(grossProfit.round(2).toFixed(2)),
    opexTotalTry: Number(opexTotal.round(2).toFixed(2)),
    daAddbackTry: Number(daAddback.round(2).toFixed(2)),
    opexCashTry: Number(opexCash.round(2).toFixed(2)),
    ebitTry: Number(ebit.round(2).toFixed(2)),
    managementEbitdaTry: Number(ebitda.round(2).toFixed(2)),
    otherNetIncomeTry: Number(otherNet.round(2).toFixed(2)),
    financingExpenseTry: Number(finExp.round(2).toFixed(2)),
    ebtTry: Number(ebt.round(2).toFixed(2)),
    taxExpenseTry: Number(taxExp.round(2).toFixed(2)),
    netIncomeTry: Number(netInc.round(2).toFixed(2)),
  };

  const balanceSheet: BalanceSheetItem[] = [];
  for (const r of trialBalance) {
    if (r.accountClass === "asset" || r.accountClass === "liability" || r.accountClass === "equity") {
      const amt =
        r.accountClass === "asset"
          ? r.netBalanceTry
          : Number(decimal(0).minus(r.netBalanceTry).round(2).toFixed(2));
      if (amt !== 0) {
        balanceSheet.push({
          accountCode: r.accountCode,
          accountName: r.accountName,
          tdhpRootCode: r.tdhpRootCode,
          section: r.accountClass,
          amountTry: amt,
          isDynamicNetIncome: false,
        });
      }
    }
  }

  const unclosedNetIncome = money(pl?.cumulative_unclosed_net_income_try ?? 0);
  if (unclosedNetIncome !== 0) {
    balanceSheet.push({
      accountCode: unclosedNetIncome >= 0 ? "590.DYN" : "591.DYN",
      accountName:
        unclosedNetIncome >= 0
          ? "Dönem Net Kârı (Dinamik — Henüz Kapatılmamış)"
          : "Dönem Net Zararı (- Dinamik — Henüz Kapatılmamış)",
      tdhpRootCode: unclosedNetIncome >= 0 ? "590" : "591",
      section: "equity",
      amountTry: unclosedNetIncome,
      isDynamicNetIncome: true,
    });
  }

  const totalAssetsTry = Number(
    balanceSheet
      .filter((b) => b.section === "asset")
      .reduce((acc, b) => acc.plus(b.amountTry), decimal(0))
      .round(2)
      .toFixed(2),
  );
  const totalLiabilitiesAndEquityTry = Number(
    balanceSheet
      .filter((b) => b.section === "liability" || b.section === "equity")
      .reduce((acc, b) => acc.plus(b.amountTry), decimal(0))
      .round(2)
      .toFixed(2),
  );

  const suspense10299Row = trialBalance.find((t) => t.accountCode === "102.99");
  const suspense10299NetTry = suspense10299Row?.netBalanceTry ?? 0;

  const suspense10299Items: SuspenseBankItem[] = suspenseRes.rows.map((s) => {
    const d = money(s.debit_try);
    const c = money(s.credit_try);
    return {
      entryId: s.entry_id,
      entryNo: Number(s.entry_no),
      entryDate: s.entry_date,
      bankTransactionId: s.source_id,
      description: s.description,
      currency: s.native_currency,
      debitTry: d,
      creditTry: c,
      netSuspenseTry: Number(decimal(d).minus(c).round(2).toFixed(2)),
    };
  });

  return {
    fromDate,
    toDate,
    trialBalance,
    totalOpeningDebitTry,
    totalOpeningCreditTry,
    totalPeriodDebitTry,
    totalPeriodCreditTry,
    totalDebitTry,
    totalCreditTry,
    totalDebitBalanceTry,
    totalCreditBalanceTry,
    incomeStatement,
    balanceSheet,
    totalAssetsTry,
    totalLiabilitiesAndEquityTry,
    suspense10299Items,
    suspense10299NetTry,
  };
}

/* ── TDHP 7xx -> 7x1 -> 6xx -> 690 -> 590/591 Dönem Sonu Yansıtma & Kapanış Sihirbazı ─────────── */

const COST_REFLECTION_MAP: Record<string, { reflectionCode: string; target6xxCode: string; label: string }> = {
  "710": { reflectionCode: "711", target6xxCode: "620", label: "Direkt İlk Madde ve Malzeme Yansıtması" },
  "720": { reflectionCode: "721", target6xxCode: "620", label: "Direkt İşçilik Giderleri Yansıtması" },
  "730": { reflectionCode: "731", target6xxCode: "620", label: "Genel Üretim Giderleri Yansıtması" },
  "760": { reflectionCode: "761", target6xxCode: "631", label: "Pazarlama, Satış ve Dağıtım Giderleri Yansıtması" },
  "770": { reflectionCode: "771", target6xxCode: "632", label: "Genel Yönetim Giderleri Yansıtması" },
  "770.99": { reflectionCode: "771", target6xxCode: "632", label: "Amortisman ve İtfa Giderleri Yansıtması" },
  "780": { reflectionCode: "781", target6xxCode: "660", label: "Finansman Giderleri Yansıtması" },
};

export const periodClosingInputSchema = z.object({
  fromDate: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "Başlangıç tarihi YYYY-MM-DD olmalıdır."),
  toDate: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, "Bitiş tarihi YYYY-MM-DD olmalıdır."),
  entryDate: z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});

export interface PeriodClosingPreview {
  fromDate: string;
  toDate: string;
  entryDate: string;
  reflected7xxTotalTry: number;
  netResultTry: number;
  targetEquityAccount: "590" | "591" | null;
  lines: JournalLineInput[];
}

export async function previewPeriodClosing(
  pool: Pool,
  raw: unknown,
): Promise<PeriodClosingPreview> {
  const input = parseOrThrow(periodClosingInputSchema, raw, "Dönem sonu kapanış önizlemesi");
  if (input.fromDate > input.toDate) {
    throw new DomainError("Kapanış başlangıç tarihi bitiş tarihinden büyük olamaz.");
  }
  const entryDate = input.entryDate ?? input.toDate;

  const balRes = await pool.query<{
    code: string;
    account_class: string;
    net_try: string;
  }>(
    `select ma.code,
            ma.account_class,
            coalesce(sum(jl.debit_try - jl.credit_try), 0)::numeric(16,2)::text as net_try
       from public.management_journal_lines jl
       join public.management_journal_entries je
         on je.id = jl.entry_id
        and je.status in ('posted', 'reversed')
       join public.management_accounts ma
         on ma.id = jl.account_id
      where je.entry_date >= $1::date
        and je.entry_date <= $2::date
        and ma.account_class in ('revenue', 'contra_revenue', 'cogs', 'opex', 'finance_expense', 'other_income_expense')
      group by ma.code, ma.account_class
      having coalesce(sum(jl.debit_try - jl.credit_try), 0) <> 0
      order by ma.code asc`,
    [input.fromDate, input.toDate],
  );

  const lines: JournalLineInput[] = [];
  let reflected7xx = decimal(0);
  // Track net balances after Step A (7xx -> 7x1 -> 6xx)
  const post7xxNetByCode = new Map<string, ReturnType<typeof decimal>>();
  for (const r of balRes.rows) {
    post7xxNetByCode.set(r.code, decimal(r.net_try));
  }

  // Step 1: 7xx -> 7x1 -> 6xx reflection & 7x1 <-> 7xx closure
  for (const [code7xx, cfg] of Object.entries(COST_REFLECTION_MAP)) {
    const bal = post7xxNetByCode.get(code7xx);
    if (!bal || bal.lte(0)) continue;
    const amt = Number(bal.round(2).toFixed(2));
    reflected7xx = reflected7xx.plus(amt);

    // 6xx (Borç) / 7x1 (Alacak)
    lines.push({
      accountCode: cfg.target6xxCode,
      debitNative: amt,
      memo: `${cfg.label} (${code7xx} -> ${cfg.target6xxCode})`,
    });
    lines.push({
      accountCode: cfg.reflectionCode,
      creditNative: amt,
      memo: `${cfg.label} (${cfg.reflectionCode})`,
    });
    // 7x1 (Borç) / 7xx (Alacak) — closes 7xx and 7x1 to zero
    lines.push({
      accountCode: cfg.reflectionCode,
      debitNative: amt,
      memo: `7/A yansıtma hesabı kapanışı (${cfg.reflectionCode} <-> ${code7xx})`,
    });
    lines.push({
      accountCode: code7xx,
      creditNative: amt,
      memo: `7/A gider hesabı dönem sonu kapanışı (${code7xx})`,
    });

    post7xxNetByCode.set(code7xx, decimal(0));
    const cur6xx = post7xxNetByCode.get(cfg.target6xxCode) ?? decimal(0);
    post7xxNetByCode.set(cfg.target6xxCode, cur6xx.plus(amt));
  }

  // Step 2: Close all remaining 6xx accounts into 690 Dönem Kârı veya Zararı
  let net690CreditMinusDebit = decimal(0); // >0 = profit, <0 = loss
  const sortedCodes = [...post7xxNetByCode.keys()].sort();
  for (const code of sortedCodes) {
    if (code === "690") continue;
    const net = post7xxNetByCode.get(code) ?? decimal(0); // debit - credit
    if (net.eq(0)) continue;
    const absAmt = Number(net.abs().round(2).toFixed(2));
    if (absAmt <= 0) continue;

    if (net.gt(0)) {
      // Expense / debit balance -> Debit 690 / Credit 6xx
      lines.push({
        accountCode: "690",
        debitNative: absAmt,
        memo: `Gelir tablosu gider devri (${code} -> 690)`,
      });
      lines.push({
        accountCode: code,
        creditNative: absAmt,
        memo: `Dönem sonu hesap kapanışı (${code})`,
      });
      net690CreditMinusDebit = net690CreditMinusDebit.minus(absAmt);
    } else {
      // Revenue / credit balance -> Debit 6xx / Credit 690
      lines.push({
        accountCode: code,
        debitNative: absAmt,
        memo: `Dönem sonu gelir kapanışı (${code})`,
      });
      lines.push({
        accountCode: "690",
        creditNative: absAmt,
        memo: `Gelir tablosu gelir devri (${code} -> 690)`,
      });
      net690CreditMinusDebit = net690CreditMinusDebit.plus(absAmt);
    }
  }

  // Also include any pre-existing balance on 690 itself
  const existing690 = post7xxNetByCode.get("690") ?? decimal(0);
  net690CreditMinusDebit = net690CreditMinusDebit.minus(existing690);

  // Step 3: Close 690 into 590 (Dönem Net Kârı) or 591 (Dönem Net Zararı (-))
  let targetEquityAccount: "590" | "591" | null = null;
  const finalAbs = Number(net690CreditMinusDebit.abs().round(2).toFixed(2));
  if (finalAbs > 0) {
    if (net690CreditMinusDebit.gt(0)) {
      targetEquityAccount = "590";
      lines.push({
        accountCode: "690",
        debitNative: finalAbs,
        memo: "Dönem net kârının bilançoya devri (690 -> 590)",
      });
      lines.push({
        accountCode: "590",
        creditNative: finalAbs,
        memo: `Dönem Net Kârı (${input.fromDate} .. ${input.toDate})`,
      });
    } else {
      targetEquityAccount = "591";
      lines.push({
        accountCode: "591",
        debitNative: finalAbs,
        memo: `Dönem Net Zararı (${input.fromDate} .. ${input.toDate})`,
      });
      lines.push({
        accountCode: "690",
        creditNative: finalAbs,
        memo: "Dönem net zararının bilançoya devri (690 -> 591)",
      });
    }
  }

  return {
    fromDate: input.fromDate,
    toDate: input.toDate,
    entryDate,
    reflected7xxTotalTry: Number(reflected7xx.round(2).toFixed(2)),
    netResultTry: Number(net690CreditMinusDebit.round(2).toFixed(2)),
    targetEquityAccount,
    lines,
  };
}

export async function postPeriodClosing(
  pool: Pool,
  raw: unknown,
  actorId: string,
): Promise<PostJournalEntryResult & { reflected7xxTotalTry: number; netResultTry: number }> {
  const preview = await previewPeriodClosing(pool, raw);
  if (preview.lines.length < 2) {
    throw new DomainError(
      `${preview.fromDate} – ${preview.toDate} aralığında kapatılacak açık 7xx / 6xx gelir-gider bakiyesi bulunamadı.`,
    );
  }

  const client = await pool.connect();
  try {
    await client.query("begin");
    const res = await postJournalEntryWithClient(
      client,
      {
        entryDate: preview.entryDate,
        sourceType: "period_closing",
        idempotencyKey: `period_closing:${preview.fromDate}:${preview.toDate}`,
        description: `TDHP Dönem Sonu 7xx→7x1→6xx→690 Kapanış Fişi (${preview.fromDate} – ${preview.toDate})`,
        currency: "TRY",
        fxRate: 1,
        status: "posted",
        lines: preview.lines,
      },
      actorId,
    );
    await client.query("commit");
    return {
      ...res,
      reflected7xxTotalTry: preview.reflected7xxTotalTry,
      netResultTry: preview.netResultTry,
    };
  } catch (e) {
    await client.query("rollback").catch(() => undefined);
    throw e;
  } finally {
    client.release();
  }
}
