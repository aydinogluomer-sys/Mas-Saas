/**
 * MAS Nakit Radar — Zincir 1: Otonom Tahsilat & Erken Nakit Çevirme Döngüsü
 * (Order-to-Cash & DSO Autonomic Loop)
 * 
 * ERP Satış Faturaları ➔ Cari Risk & DSO ➔ Ödeme Sözleri & Disiplin
 * ➔ Dinamik İskonto Arbitrajı ➔ Banka Otomatik Eşleme
 */

import type { Pool } from "pg";
import { analyzeDiscountArbitrage, type EarlyDiscountOffer, type ArbitrageAnalysisResult } from "@/lib/finance/dynamic-discounting";
import { planPromiseReminders, type PromiseReminderPlan } from "@/lib/collections/discipline-engine";
import { istanbulDateISO } from "@/lib/reports/rules";
import { addDaysISO } from "@/lib/financing/rules";

export interface OrderToCashSummary {
  chainName: "order_to_cash";
  scanDate: string;
  totalOpenReceivablesTRY: number;
  overdueReceivablesTRY: number;
  weightedAverageDSO: number;
  criticalDsoCustomers: Array<{
    partyId: string;
    partyName: string;
    dsoDays: number;
    openReceivableTRY: number;
    riskBand: string;
  }>;
  activePromises: Array<{
    promiseId: string;
    partyName: string;
    promisedDate: string;
    amount: number;
    status: string;
    reminders: PromiseReminderPlan;
  }>;
  dynamicDiscountOpportunities: Array<{
    invoiceId: string;
    invoiceNo: string;
    counterpartyName: string;
    grossAmount: number;
    dueDate: string;
    recommendedDiscountPercent: number;
    earlyPaymentDate: string;
    arbitrage: ArbitrageAnalysisResult;
  }>;
  reconciliationSummary: {
    unmatchedBankTransactionsCount: number;
    unmatchedInvoicesCount: number;
    potentialMatchVolumeTRY: number;
  };
}

export async function evaluateOrderToCashChain(
  pool: Pool,
  options: {
    companyBorrowingRateAnnual?: number;
    availableCashTRY?: number;
    minCashFloorTRY?: number;
  } = {},
): Promise<OrderToCashSummary> {
  const scanDate = istanbulDateISO();
  const borrowingRate = options.companyBorrowingRateAnnual ?? 42.0; // Türkiye KOBİ gösterge faizi
  const availableCash = options.availableCashTRY ?? 1_500_000;
  const minFloor = options.minCashFloorTRY ?? 300_000;

  // 1. Açık ve vadesi geçmiş satış faturalarını çek
  const invRes = await pool.query<{
    id: string;
    invoice_no: string;
    party_id: string;
    party_name: string;
    gross_amount: string;
    currency: string;
    due_date: string;
    issue_date: string;
    status: string;
  }>(`
    select 
      i.id,
      i.invoice_no,
      i.party_id,
      p.name as party_name,
      i.gross_amount,
      i.currency,
      to_char(i.due_date, 'YYYY-MM-DD') as due_date,
      to_char(i.issue_date, 'YYYY-MM-DD') as issue_date,
      i.status
    from public.invoices i
    join public.parties p on p.id = i.party_id
    where i.direction = 'sales'
      and i.status in ('open', 'overdue', 'partially_paid')
    order by i.due_date asc
    limit 100
  `);

  let totalOpenReceivablesTRY = 0;
  let overdueReceivablesTRY = 0;
  const invoices = invRes.rows;

  for (const inv of invoices) {
    const amt = Number(inv.gross_amount);
    totalOpenReceivablesTRY += amt;
    if (inv.due_date && inv.due_date < scanDate) {
      overdueReceivablesTRY += amt;
    }
  }

  // 2. Cari DSO ve Risk Bantları
  const dsoRes = await pool.query<{
    party_id: string;
    party_name: string;
    dso_days: string | null;
    open_balance: string | null;
    score_band: string | null;
  }>(`
    select 
      p.id as party_id,
      p.name as party_name,
      coalesce(cp.payment_terms_days, 45)::text as dso_days,
      coalesce(sum(i.gross_amount), 0)::text as open_balance,
      case 
        when coalesce(cp.payment_terms_days, 45) > 75 then 'CRITICAL'
        when coalesce(cp.payment_terms_days, 45) > 60 then 'HIGH'
        when coalesce(cp.payment_terms_days, 45) > 40 then 'MEDIUM'
        else 'LOW'
      end as score_band
    from public.parties p
    left join public.counterparty_profiles cp on cp.party_id = p.id
    left join public.invoices i on i.party_id = p.id and i.direction = 'sales' and i.status = 'open'
    group by p.id, p.name, cp.payment_terms_days
    having coalesce(sum(i.gross_amount), 0) > 0
    order by coalesce(cp.payment_terms_days, 45) desc
    limit 10
  `);

  const criticalDsoCustomers = dsoRes.rows.map((r) => ({
    partyId: r.party_id,
    partyName: r.party_name,
    dsoDays: Number(r.dso_days || 45),
    openReceivableTRY: Number(r.open_balance || 0),
    riskBand: r.score_band || "MEDIUM",
  }));

  const weightedAverageDSO =
    criticalDsoCustomers.length > 0
      ? Math.round(
          criticalDsoCustomers.reduce((acc, c) => acc + c.dsoDays * c.openReceivableTRY, 0) /
            (criticalDsoCustomers.reduce((acc, c) => acc + c.openReceivableTRY, 0) || 1),
        )
      : 45;

  // 3. Aktif Ödeme Sözleri ve Hatırlatma Planları
  const promisesRes = await pool.query<{
    id: string;
    party_id: string;
    party_name: string;
    promised_amount: string | null;
    promised_date: string;
    currency: string;
    status: string;
  }>(`
    select 
      pr.id,
      pr.party_id,
      p.name as party_name,
      pr.promised_amount,
      to_char(pr.promised_date, 'YYYY-MM-DD') as promised_date,
      pr.currency,
      pr.status
    from public.promise_to_pay pr
    join public.parties p on p.id = pr.party_id
    where pr.status = 'pending'
    order by pr.promised_date asc
    limit 10
  `);

  const activePromises = promisesRes.rows.map((r) => {
    const amt = Number(r.promised_amount || 0);
    const plan = planPromiseReminders({
      promiseId: r.id,
      partyId: r.party_id,
      partyName: r.party_name,
      promisedDate: r.promised_date,
      amount: amt,
      currency: r.currency,
    });
    return {
      promiseId: r.id,
      partyName: r.party_name,
      promisedDate: r.promised_date,
      amount: amt,
      status: r.status,
      reminders: plan,
    };
  });

  // 4. Dinamik İskonto Fırsatları (Vadesi henüz gelmemiş faturalar için erken tahsilat teşviği)
  const discountOpportunities: OrderToCashSummary["dynamicDiscountOpportunities"] = [];
  const candidateInvoices = invoices.filter((i) => i.due_date && i.due_date > scanDate);

  for (const inv of candidateInvoices.slice(0, 5)) {
    const earlyPayDate = addDaysISO(scanDate, 3);
    const offer: EarlyDiscountOffer = {
      invoiceId: inv.id,
      counterpartyName: inv.party_name,
      invoiceAmount: Number(inv.gross_amount),
      originalDueDate: inv.due_date,
      earlyPaymentDate: earlyPayDate,
      discountPercent: 2.5, // %2.5 Erken Ödeme İskontosu
    };

    const arbitrage = analyzeDiscountArbitrage(offer, {
      borrowingCostAnnual: borrowingRate,
      availableCashTRY: availableCash,
      minCashFloorTRY: minFloor,
    });

    discountOpportunities.push({
      invoiceId: inv.id,
      invoiceNo: inv.invoice_no,
      counterpartyName: inv.party_name,
      grossAmount: Number(inv.gross_amount),
      dueDate: inv.due_date,
      recommendedDiscountPercent: 2.5,
      earlyPaymentDate: earlyPayDate,
      arbitrage,
    });
  }

  const matchRes = await pool.query<{
    unmatched_tx: string;
    unmatched_inv: string;
    potential_vol: string;
  }>(`
    select 
      (select count(*)::text from public.bank_transactions where status in ('unmatched', 'suggested')) as unmatched_tx,
      (select count(*)::text from public.invoices where status in ('open', 'overdue')) as unmatched_inv,
      (select coalesce(sum(gross_amount), 0)::text from public.invoices where status in ('open', 'overdue')) as potential_vol
  `);

  return {
    chainName: "order_to_cash",
    scanDate,
    totalOpenReceivablesTRY,
    overdueReceivablesTRY,
    weightedAverageDSO,
    criticalDsoCustomers,
    activePromises,
    dynamicDiscountOpportunities: discountOpportunities,
    reconciliationSummary: {
      unmatchedBankTransactionsCount: Number(matchRes.rows[0]?.unmatched_tx || 0),
      unmatchedInvoicesCount: Number(matchRes.rows[0]?.unmatched_inv || 0),
      potentialMatchVolumeTRY: Number(matchRes.rows[0]?.potential_vol || 0),
    },
  };
}
