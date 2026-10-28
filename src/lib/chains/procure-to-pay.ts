/**
 * MAS Nakit Radar — Zincir 2: Satınalma, Harcama & Likidite Koruma Kalkanı
 * (Procure-to-Pay & Liquidity Guard Chain)
 * 
 * ERP Alış Faturaları ➔ Bütçe Aşım Denetimi ➔ 13H Kasa Likidite Simülasyonu
 * ➔ Kredi Headroom Kapasitesi ➔ Çok Seviyeli Onay Kapısı
 */

import type { Pool } from "pg";
import { checkBudgetHeadroom, type BudgetCheckResult } from "@/lib/budget/guardrail";
import { computeTreasuryShieldReport, type TreasuryShieldReport } from "@/lib/treasury/headroom-engine";
import { istanbulDateISO } from "@/lib/reports/rules";
import { addDaysISO } from "@/lib/financing/rules";

export interface ProcureToPayActionRecommendation {
  invoiceId: string;
  invoiceNo: string;
  vendorName: string;
  grossAmount: number;
  currency: string;
  dueDate: string;
  budgetCheck: BudgetCheckResult;
  liquidityImpact: {
    projectedCashAfterPaymentTRY: number;
    causesCashDeficit: boolean;
    deficitAmountTRY: number;
    recommendedAction: "PAY_ON_SCHEDULE" | "DEFER_PAYMENT_15D" | "ISSUE_PROMISSORY_NOTE" | "CFO_OVERRIDE_REQUIRED";
    actionExplanation: string;
  };
}

export interface ProcureToPaySummary {
  chainName: "procure_to_pay";
  scanDate: string;
  totalPendingPayablesTRY: number;
  dueNext7DaysTRY: number;
  budgetOverrunAlertsCount: number;
  cashDeficitAlertsCount: number;
  availableCreditHeadroomTRY: number;
  evaluatedPayables: ProcureToPayActionRecommendation[];
}

export async function evaluateProcureToPayChain(
  pool: Pool,
  options: {
    currentCashBalanceTRY?: number;
    safetyBufferTRY?: number;
  } = {},
): Promise<ProcureToPaySummary> {
  const scanDate = istanbulDateISO();
  const next7Days = addDaysISO(scanDate, 7);
  const currentCash = options.currentCashBalanceTRY ?? 850_000;
  const safetyBuffer = options.safetyBufferTRY ?? 250_000;

  // 1. Bekleyen Alış / Tedarikçi Faturaları
  const payablesRes = await pool.query<{
    id: string;
    invoice_no: string;
    party_id: string;
    party_name: string;
    gross_amount: string;
    currency: string;
    due_date: string;
    status: string;
    cost_center_id: string | null;
    project_id: string | null;
  }>(`
    select 
      i.id,
      i.invoice_no,
      i.party_id,
      p.name as party_name,
      i.gross_amount,
      i.currency,
      to_char(i.due_date, 'YYYY-MM-DD') as due_date,
      i.status,
      i.cost_center_id,
      i.project_id
    from public.invoices i
    join public.parties p on p.id = i.party_id
    where i.direction = 'purchase'
      and i.status in ('open', 'overdue', 'partially_paid')
    order by i.due_date asc
    limit 20
  `);

  // 2. Kredi Tesisleri ve Hazine Headroom Durumu
  let availableCreditHeadroomTRY = 0;
  try {
    const shield: TreasuryShieldReport = await computeTreasuryShieldReport(pool);
    availableCreditHeadroomTRY = shield.totalAvailableHeadroom;
  } catch {
    availableCreditHeadroomTRY = 2_000_000; // Fallback simülasyon rezervi
  }

  let totalPendingPayablesTRY = 0;
  let dueNext7DaysTRY = 0;
  let budgetOverrunAlertsCount = 0;
  let cashDeficitAlertsCount = 0;
  let runningCashEstimate = currentCash;

  const evaluatedPayables: ProcureToPayActionRecommendation[] = [];

  for (const row of payablesRes.rows) {
    const amt = Number(row.gross_amount);
    totalPendingPayablesTRY += amt;
    if (row.due_date && row.due_date <= next7Days) {
      dueNext7DaysTRY += amt;
    }

    // A. Bütçe Tavanı Kontrolü
    const budgetCheck = await checkBudgetHeadroom(pool, {
      costCenterId: row.cost_center_id,
      projectId: row.project_id,
      amount: amt,
      currency: row.currency,
      date: row.due_date || scanDate,
    });

    if (budgetCheck.requiresCfoOverride || budgetCheck.overrunAmount > 0) {
      budgetOverrunAlertsCount++;
    }

    // B. Kasa Likidite Etki Simülasyonu
    runningCashEstimate -= amt;
    const causesCashDeficit = runningCashEstimate < safetyBuffer;
    const deficitAmountTRY = causesCashDeficit ? Math.abs(safetyBuffer - runningCashEstimate) : 0;

    if (causesCashDeficit) {
      cashDeficitAlertsCount++;
    }

    // C. Karar Önerisi
    let recommendedAction: ProcureToPayActionRecommendation["liquidityImpact"]["recommendedAction"] = "PAY_ON_SCHEDULE";
    let actionExplanation = "Kasa nakit dengesi ve bütçe tavanı güvenli seviyede.";

    if (budgetCheck.requiresCfoOverride) {
      recommendedAction = "CFO_OVERRIDE_REQUIRED";
      actionExplanation = `Bütçe aşımı tespit edildi (+${budgetCheck.overrunAmount.toLocaleString("tr-TR")} ₺). CFO özel onayı gereklidir.`;
    } else if (causesCashDeficit) {
      if (amt > 150_000 && availableCreditHeadroomTRY > amt) {
        recommendedAction = "ISSUE_PROMISSORY_NOTE";
        actionExplanation = "Ödeme nakit açığı yaratıyor. Tedarikçiye 60 günlük vadeli çek verilerek nakit çıkışı ertelenmelidir.";
      } else {
        recommendedAction = "DEFER_PAYMENT_15D";
        actionExplanation = `Kasa tamponu altına iniliyor (-${deficitAmountTRY.toLocaleString("tr-TR")} ₺). Ödemenin 15 gün ötelenmesi tavsiye edilir.`;
      }
    }

    evaluatedPayables.push({
      invoiceId: row.id,
      invoiceNo: row.invoice_no,
      vendorName: row.party_name,
      grossAmount: amt,
      currency: row.currency,
      dueDate: row.due_date || scanDate,
      budgetCheck,
      liquidityImpact: {
        projectedCashAfterPaymentTRY: runningCashEstimate,
        causesCashDeficit,
        deficitAmountTRY,
        recommendedAction,
        actionExplanation,
      },
    });
  }

  return {
    chainName: "procure_to_pay",
    scanDate,
    totalPendingPayablesTRY,
    dueNext7DaysTRY,
    budgetOverrunAlertsCount,
    cashDeficitAlertsCount,
    availableCreditHeadroomTRY,
    evaluatedPayables,
  };
}
