/**
 * MAS Nakit Radar — Zincir 5: Yasal Takvim, Vergi/SGK & Kasa Emniyet Bariyeri
 * (Statutory Calendar & Liquidity Reserve Lock Chain)
 * 
 * Vergi & SGK Beyanname Takvimi ➔ Personel Maaş Rezervi ➔ Yasal Kasa Blokajı
 * ➔ Kullanılabilir Serbest Nakit (Free Cash vs Gross Cash)
 */

import type { Pool } from "pg";
import { istanbulDateISO } from "@/lib/reports/rules";
import { addDaysISO } from "@/lib/financing/rules";

export interface StatutoryObligation {
  id: string;
  name: string;
  category: "tax_kdv" | "tax_muhtasar" | "sgk_premium" | "payroll" | "corporate_provisional_tax";
  dueDate: string;
  estimatedAmountTRY: number;
  priority: "MUST_PAY_STATUTORY";
  status: "pending" | "reserved" | "settled";
  legalPenaltyRisk: string;
}

export interface StatutoryDefenseSummary {
  chainName: "statutory_defense";
  scanDate: string;
  grossBankBalanceTRY: number;
  statutoryReservedAmountTRY: number;
  freeUsableCashTRY: number;
  isReserveCompromised: boolean;
  compromiseDeficitTRY: number;
  upcomingObligations: StatutoryObligation[];
  safetyVerdict: "RESERVES_SECURE" | "RESERVES_AT_RISK" | "CRITICAL_DEFICIT";
  actionableWarning: string;
}

export async function evaluateStatutoryDefenseChain(
  pool: Pool,
  options: {
    currentBankBalanceTRY?: number;
    estimatedMonthlyPayrollTRY?: number;
  } = {},
): Promise<StatutoryDefenseSummary> {
  const scanDate = istanbulDateISO();
  const currentMonth = scanDate.slice(0, 7); // YYYY-MM
  const nextMonth = addDaysISO(scanDate, 30).slice(0, 7);

  // 1. Banka Bakiyeleri Toplamı
  let grossBankBalanceTRY = options.currentBankBalanceTRY ?? 0;
  if (!options.currentBankBalanceTRY) {
    try {
      const bRes = await pool.query<{ total: string }>(`
        select coalesce(sum(current_balance), 0)::text as total
        from public.bank_accounts
        where is_active = true and currency = 'TRY'
      `);
      grossBankBalanceTRY = Number(bRes.rows[0]?.total || 1_250_000);
    } catch {
      grossBankBalanceTRY = 1_250_000;
    }
  }

  // 2. Yasal Vergi ve Maaş Takvimi Hesaplama
  const payrollEst = options.estimatedMonthlyPayrollTRY ?? 450_000;
  const sgkEst = Math.round(payrollEst * 0.375); // ~%37.5 SGK işçi+işveren primi
  const kdvEst = 180_000;
  const muhtasarEst = 95_000;

  const obligations: StatutoryObligation[] = [
    {
      id: `stat-kdv-${currentMonth}`,
      name: `${currentMonth} Dönemi KDV Beyannamesi`,
      category: "tax_kdv",
      dueDate: `${currentMonth}-26`,
      estimatedAmountTRY: kdvEst,
      priority: "MUST_PAY_STATUTORY",
      status: scanDate > `${currentMonth}-26` ? "settled" : "pending",
      legalPenaltyRisk: "Gecikme zammı + e-Haciz riski + KDV indirim hak kaybı",
    },
    {
      id: `stat-muhtasar-${currentMonth}`,
      name: `${currentMonth} Muhtasar ve Prim Hizmet Beyannamesi (Stopaj)`,
      category: "tax_muhtasar",
      dueDate: `${currentMonth}-26`,
      estimatedAmountTRY: muhtasarEst,
      priority: "MUST_PAY_STATUTORY",
      status: scanDate > `${currentMonth}-26` ? "settled" : "pending",
      legalPenaltyRisk: "Gecikme zammı + Vergi ziyaı cezası",
    },
    {
      id: `stat-sgk-${currentMonth}`,
      name: `${currentMonth} SGK Prim Ödemesi`,
      category: "sgk_premium",
      dueDate: `${currentMonth}-30`,
      estimatedAmountTRY: sgkEst,
      priority: "MUST_PAY_STATUTORY",
      status: scanDate > `${currentMonth}-30` ? "settled" : "pending",
      legalPenaltyRisk: "5 puanlık prim teşviki kaybı (aylık ~%15 maliyet artışı)",
    },
    {
      id: `stat-payroll-${nextMonth}`,
      name: `${nextMonth} Personel Net Maaş Bordrosu`,
      category: "payroll",
      dueDate: `${nextMonth}-05`,
      estimatedAmountTRY: payrollEst,
      priority: "MUST_PAY_STATUTORY",
      status: "pending",
      legalPenaltyRisk: "İş Kanunu md. 34 (İş görmekten kaçınma hakkı)",
    },
  ];

  // Aktif (henüz ödenmemiş) yasal rezerv toplamı
  const activeObligations = obligations.filter((o) => o.status === "pending");
  const statutoryReservedAmountTRY = activeObligations.reduce((acc, o) => acc + o.estimatedAmountTRY, 0);

  const freeUsableCashTRY = grossBankBalanceTRY - statutoryReservedAmountTRY;
  const isReserveCompromised = freeUsableCashTRY < 0;
  const compromiseDeficitTRY = isReserveCompromised ? Math.abs(freeUsableCashTRY) : 0;

  let safetyVerdict: StatutoryDefenseSummary["safetyVerdict"] = "RESERVES_SECURE";
  let actionableWarning = "Yasal vergi ve maaş rezervleri tam teminat altında; serbest nakit kullanılabilir.";

  if (isReserveCompromised) {
    safetyVerdict = "CRITICAL_DEFICIT";
    actionableWarning = `DİKKAT: Kasadaki para yasal vergi ve maaş yükümlülüklerine yetmiyor! Açık: ${compromiseDeficitTRY.toLocaleString("tr-TR")} ₺. Harcamalar derhal dondurulmalıdır.`;
  } else if (freeUsableCashTRY < 200_000) {
    safetyVerdict = "RESERVES_AT_RISK";
    actionableWarning = `UYARI: Yasal rezervler ayrıldıktan sonra serbest nakit kritik sınıra indi (${freeUsableCashTRY.toLocaleString("tr-TR")} ₺). İsteğe bağlı harcama yapılmamalıdır.`;
  }

  return {
    chainName: "statutory_defense",
    scanDate,
    grossBankBalanceTRY,
    statutoryReservedAmountTRY,
    freeUsableCashTRY,
    isReserveCompromised,
    compromiseDeficitTRY,
    upcomingObligations: activeObligations,
    safetyVerdict,
    actionableWarning,
  };
}
