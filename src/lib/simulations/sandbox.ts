// Faz 3 — CFO Risk & Simülasyon: "What-If" Finansal Kum Havuzu (Scenario Sandbox Engine)
//
// CFO'nun veritabanına dokunmadan, tamamen in-memory simülasyon ortamında:
//   - "Müşteri X 2.000.000 TL ödemesini 4 hafta geciktirirse?"
//   - "3.000.000 TL'lik makine yatırımı (CAPEX) nakit yapılırsa 13 haftalık nakit akışı bozulur mu?"
//   - "Enflasyon nedeniyle genel giderler %15 artarsa kasanın dip noktası ne olur?"
//   - "Satış gelirleri %20 düşerse finansman açığı ne zaman patlar?"
// gibi kritik soruları simüle etmesini sağlar. 13 haftalık dinamik nakit akışı projeksiyonunu
// yeniden hesaplar ve kasanın eksiye düştüğü ilk haftayı ve gereken kredi tamponunu raporlar.

import type { Pool } from "pg";

export interface CapexModifier {
  weekIndex: number; // 1 - 13
  amount: number;
  label: string;
}

export interface DelayedInflowModifier {
  fromWeekIndex: number;
  toWeekIndex: number;
  amount: number;
  label: string;
}

export interface SimulationModifiers {
  capexOutflows?: CapexModifier[];
  delayedInflows?: DelayedInflowModifier[];
  revenueShockPercent?: number;       // Örn: -15 için -15
  expenseInflationPercent?: number;   // Örn: +10 için 10
}

export interface SimulationWeekInput {
  weekIndex: number;
  weekStartDate: string;
  inflow: number;
  outflow: number;
}

export interface SimulationWeeklyPoint {
  weekIndex: number;
  weekStartDate: string;
  baselineInflow: number;
  baselineOutflow: number;
  baselineClosingBalance: number;
  simulatedInflow: number;
  simulatedOutflow: number;
  simulatedClosingBalance: number;
  netDelta: number;
  isDeficit: boolean;
  deficitAmount: number;
}

export interface SimulationReport {
  scenarioName: string;
  initialCash: number;
  minCashFloor: number;
  baselineMinCash: number;
  simulatedMinCash: number;
  deficitOccurs: boolean;
  firstDeficitWeek: number | null;
  firstDeficitDate: string | null;
  maxDeficitAmount: number;
  headroomRequired: number;
  weeklyTimeline: SimulationWeeklyPoint[];
  cfoExecutiveVerdict: string;
  recommendedActions: string[];
}

/**
 * 13 haftalık nakit projeksiyonu üzerinde "What-If" simülasyonunu icra eder (Pure function).
 */
export function runWhatIfSimulation(input: {
  scenarioName?: string;
  initialCash: number;
  minCashFloor: number;
  weeks: SimulationWeekInput[];
  modifiers: SimulationModifiers;
}): SimulationReport {
  const {
    scenarioName = "Özel CFO Simülasyonu",
    initialCash,
    minCashFloor,
    weeks,
    modifiers,
  } = input;

  const timeline: SimulationWeeklyPoint[] = [];

  let baseBalance = initialCash;
  let simBalance = initialCash;

  let baselineMin = initialCash;
  let simulatedMin = initialCash;

  let firstDeficitWeek: number | null = null;
  let firstDeficitDate: string | null = null;
  let maxDeficit = 0;

  // Hafta hafta simülasyonu işlet
  for (const week of weeks) {
    const baseInflow = week.inflow;
    const baseOutflow = week.outflow;

    // Modifiers uygula
    let simInflow = baseInflow;
    let simOutflow = baseOutflow;

    // 1. Gelir şoku (örneğin -%20 satış düşüşü)
    if (modifiers.revenueShockPercent != null && modifiers.revenueShockPercent !== 0) {
      simInflow *= (1 + modifiers.revenueShockPercent / 100);
    }

    // 2. Gider enflasyonu (örneğin +%10 masraf artışı)
    if (modifiers.expenseInflationPercent != null && modifiers.expenseInflationPercent !== 0) {
      simOutflow *= (1 + modifiers.expenseInflationPercent / 100);
    }

    // 3. CAPEX tek seferlik yatırım çıkışları
    if (modifiers.capexOutflows) {
      for (const cap of modifiers.capexOutflows) {
        if (cap.weekIndex === week.weekIndex) {
          simOutflow += cap.amount;
        }
      }
    }

    // 4. Tahsilat gecikmeleri (fromWeek'ten toWeek'e kaydırma)
    if (modifiers.delayedInflows) {
      for (const del of modifiers.delayedInflows) {
        if (del.fromWeekIndex === week.weekIndex) {
          simInflow -= del.amount;
        }
        if (del.toWeekIndex === week.weekIndex) {
          simInflow += del.amount;
        }
      }
    }

    // Baseline bakiye hesabı
    baseBalance = baseBalance + baseInflow - baseOutflow;
    if (baseBalance < baselineMin) baselineMin = baseBalance;

    // Simüle edilen bakiye hesabı
    simBalance = simBalance + simInflow - simOutflow;
    if (simBalance < simulatedMin) simulatedMin = simBalance;

    const deficit = Math.max(0, minCashFloor - simBalance);
    const isDeficit = deficit > 0;

    if (isDeficit) {
      if (firstDeficitWeek === null) {
        firstDeficitWeek = week.weekIndex;
        firstDeficitDate = week.weekStartDate;
      }
      if (deficit > maxDeficit) {
        maxDeficit = deficit;
      }
    }

    timeline.push({
      weekIndex: week.weekIndex,
      weekStartDate: week.weekStartDate,
      baselineInflow: Math.round(baseInflow),
      baselineOutflow: Math.round(baseOutflow),
      baselineClosingBalance: Math.round(baseBalance),
      simulatedInflow: Math.round(simInflow),
      simulatedOutflow: Math.round(simOutflow),
      simulatedClosingBalance: Math.round(simBalance),
      netDelta: Math.round(simBalance - baseBalance),
      isDeficit,
      deficitAmount: Math.round(deficit),
    });
  }

  const deficitOccurs = maxDeficit > 0;

  // CFO Yönetici Değerlendirmesi
  let verdict = "Senaryo güvenli: 13 hafta boyunca nakit tamponu korunuyor.";
  const recommendations: string[] = [];

  if (deficitOccurs) {
    verdict = `RİSKLİ SENARYO: ${firstDeficitWeek}. haftada (${firstDeficitDate}) kasa tabanının altına inilmekte ve en derin noktada ₺${Math.round(maxDeficit).toLocaleString("tr-TR")} finansman açığı oluşmaktadır!`;
    recommendations.push(`Hafta ${firstDeficitWeek} öncesinde asgari ₺${Math.round(maxDeficit).toLocaleString("tr-TR")} tutarında rotatif kredi veya ortak avansı hazır bulundurulmalı.`);
    recommendations.push("İlgili dönemdeki tedarikçi vadelerinin uzatılması veya yatırımların taksitlendirilmesi müzakere edilmeli.");
  } else {
    recommendations.push("Mevcut nakit ve tahsilat projeksiyonu bu senaryo yükünü absorbe etmeye yeterlidir.");
    recommendations.push("Yatırım veya harcama kararı güvenle onaylanabilir.");
  }

  return {
    scenarioName,
    initialCash,
    minCashFloor,
    baselineMinCash: Math.round(baselineMin),
    simulatedMinCash: Math.round(simulatedMin),
    deficitOccurs,
    firstDeficitWeek,
    firstDeficitDate,
    maxDeficitAmount: Math.round(maxDeficit),
    headroomRequired: Math.round(maxDeficit),
    weeklyTimeline: timeline,
    cfoExecutiveVerdict: verdict,
    recommendedActions: recommendations,
  };
}

/**
 * PostgreSQL üzerindeki 13 haftalık nakit akışı görünümünden (cash_forecast_13w)
 * canlı verileri çekerek simülasyonu çalıştırır.
 */
export async function runSandboxFromDatabase(
  pool: Pool,
  modifiers: SimulationModifiers,
  scenarioName = "13 Haftalık Canlı Simülasyon",
): Promise<SimulationReport> {
  const [posRes, forecastRes] = await Promise.all([
    pool.query(`select available_now from public.treasury_position_summary where currency='TRY'`).catch(() => ({ rows: [] })),
    pool.query(`
      select
        week_number,
        forecast_date::text as forecast_date,
        coalesce(inflow_contracted, 0) as inflow,
        coalesce(outflow_contracted, 0) as outflow
      from public.cash_forecast_13w
      order by week_number asc
      limit 13
    `).catch(() => ({ rows: [] })),
  ]);

  const initialCash = Number(posRes.rows[0]?.available_now ?? 1000000);
  const minFloor = 200000;

  // DB'de henüz 13 hafta yoksa sentetik haftalık veri oluştur
  const weeks: SimulationWeekInput[] = [];
  if (forecastRes.rows.length >= 4) {
    for (const r of forecastRes.rows) {
      weeks.push({
        weekIndex: Number(r.week_number),
        weekStartDate: String(r.forecast_date),
        inflow: Number(r.inflow),
        outflow: Number(r.outflow),
      });
    }
  } else {
    // Fallback: 13 hafta örnek projeksiyon
    const now = new Date();
    for (let w = 1; w <= 13; w++) {
      const d = new Date(now.getTime() + (w - 1) * 7 * 86400000);
      weeks.push({
        weekIndex: w,
        weekStartDate: d.toISOString().slice(0, 10),
        inflow: 500000,
        outflow: 450000,
      });
    }
  }

  return runWhatIfSimulation({
    scenarioName,
    initialCash,
    minCashFloor: minFloor,
    weeks,
    modifiers,
  });
}
