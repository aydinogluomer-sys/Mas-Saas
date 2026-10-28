// Faz 3 — CFO Risk & Simülasyon: Net Açık FX Pozisyonu & Doğal Hedge Motoru
// (Net FX Open Position & Natural Hedge Engine)
//
// 1. Döviz bazında (USD, EUR, GBP vb.) dövizli varlık (alacaklar, mevduat) ve
//    yükümlülükleri (borçlar, kredi taksitleri) eşleştirerek "Net Açık FX Pozisyonunu" hesaplar.
// 2. Doğal Hedge Oranını (Natural Hedge Ratio) tespit eder: Döviz girişleri döviz çıkışlarını ne ölçüde karşılıyor?
// 3. Kur Stres Testi (%10, %20, %30 devalüasyon şoku) ile şirketin net nakit ve kâr/zarar etkisini çıkarır.
// 4. Açıkta kalan risk için CFO'ya türev koruma (Forward / Collar) aksiyon önerileri üretir.

import type { Pool } from "pg";

export type NaturalHedgeVerdict =
  | "EXCELLENT_NATURAL_HEDGE" // %80+ Doğal koruma (Türev maliyetine gerek yok)
  | "MODERATE_NATURAL_HEDGE"  // %50-%79 Kısmi doğal koruma (Yakın takip)
  | "UNHEDGED_EXPOSURE";       // <%50 Açık risk (Türev hedge veya vade eşitleme şart)

export interface CurrencyHedgeAnalysis {
  currency: string;
  inflowFX: number;            // Dövizli alacaklar + dövizli nakit
  outflowFX: number;           // Dövizli borçlar + dövizli krediler
  netExposureFX: number;       // inflowFX - outflowFX (+ = Net Uzun/Long, - = Net Kısa/Açık)
  positionType: "NET_LONG" | "NET_SHORT" | "SQUARE";
  spotRateTRY: number;
  netExposureTRY: number;
  naturalHedgeRatio: number;   // 0 - 100%
  verdict: NaturalHedgeVerdict;
  stressTest: {
    shock10PctDeltaTRY: number;
    shock20PctDeltaTRY: number;
    shock30PctDeltaTRY: number;
  };
  recommendation: string;
}

export interface FxHedgingReport {
  asOfDate: string;
  totalNetExposureTRY: number;
  totalWorstCase20DeltaTRY: number;
  currencies: CurrencyHedgeAnalysis[];
  executiveSummary: string;
}

/**
 * Tek bir para birimi için doğal hedge ve kur şok simülasyonunu hesaplar (Pure function).
 */
export function analyzeCurrencyHedge(input: {
  currency: string;
  inflowFX: number;
  outflowFX: number;
  spotRateTRY: number;
}): CurrencyHedgeAnalysis {
  const { currency, inflowFX, outflowFX, spotRateTRY } = input;

  const netExposureFX = Math.round((inflowFX - outflowFX) * 100) / 100;
  const netExposureTRY = Math.round(netExposureFX * spotRateTRY * 100) / 100;

  const positionType: "NET_LONG" | "NET_SHORT" | "SQUARE" =
    netExposureFX > 1 ? "NET_LONG" : netExposureFX < -1 ? "NET_SHORT" : "SQUARE";

  // Doğal Hedge Oranı: Min(Giriş, Çıkış) / Max(Giriş, Çıkış)
  const maxFlow = Math.max(inflowFX, outflowFX);
  const minFlow = Math.min(inflowFX, outflowFX);
  const naturalHedgeRatio = maxFlow > 0 ? Number(((minFlow / maxFlow) * 100).toFixed(1)) : 100;

  let verdict: NaturalHedgeVerdict = "UNHEDGED_EXPOSURE";
  if (naturalHedgeRatio >= 80) {
    verdict = "EXCELLENT_NATURAL_HEDGE";
  } else if (naturalHedgeRatio >= 50) {
    verdict = "MODERATE_NATURAL_HEDGE";
  }

  // Kur Şok Simülasyonu (+%10, +%20, +%30 Kur Artışı)
  // Net Short pozisyonda kur artışı şirkete ZARAR yazdırır (negatif delta)
  const shock10 = Math.round(netExposureFX * spotRateTRY * 0.10 * 100) / 100;
  const shock20 = Math.round(netExposureFX * spotRateTRY * 0.20 * 100) / 100;
  const shock30 = Math.round(netExposureFX * spotRateTRY * 0.30 * 100) / 100;

  let recommendation = "";
  if (positionType === "NET_SHORT") {
    const absExposureFX = Math.abs(netExposureFX);
    const absLoss20 = Math.abs(shock20);
    if (naturalHedgeRatio < 50 && absExposureFX > 20000) {
      recommendation = `🚨 YÜKSEK KUR RİSKİ: Şirket ${absExposureFX.toLocaleString("tr-TR")} ${currency} açık pozisyonda. Olası %20 kur artışında net zarar ₺${absLoss20.toLocaleString("tr-TR")} olacaktır. Açığın en az %70'i için Vadeli Döviz Alım Sözleşmesi (Forward) veya Collar opsiyonu yapılmalıdır.`;
    } else {
      recommendation = `⚠️ KISMİ AÇIK: ${absExposureFX.toLocaleString("tr-TR")} ${currency} net kısa pozisyon. Doğal hedge oranı %${naturalHedgeRatio}. Vadeli alacakların tahsilatı hızlandırılarak döviz açığı kapatılmalıdır.`;
    }
  } else if (positionType === "NET_LONG") {
    recommendation = `✅ DOĞAL KORUMA: Şirket ${netExposureFX.toLocaleString("tr-TR")} ${currency} net uzun pozisyondadır. Kur artışları kambiyo kârı ve pozitif nakit tamponu üretmektedir. Ek türev maliyetine gerek yoktur.`;
  } else {
    recommendation = `✅ DENGELİ POZİSYON: ${currency} giriş ve çıkışları tamamen örtüşmektedir. Kur riski nötrdür.`;
  }

  return {
    currency,
    inflowFX,
    outflowFX,
    netExposureFX,
    positionType,
    spotRateTRY,
    netExposureTRY,
    naturalHedgeRatio,
    verdict,
    stressTest: {
      shock10PctDeltaTRY: shock10,
      shock20PctDeltaTRY: shock20,
      shock30PctDeltaTRY: shock30,
    },
    recommendation,
  };
}

/**
 * PostgreSQL üzerindeki fx_exposure_summary ve kur tablolarından canlı FX Raporu oluşturur.
 */
export async function loadFxHedgingReport(pool: Pool): Promise<FxHedgingReport> {
  const [exposureRes, ratesRes] = await Promise.all([
    pool.query(`
      select
        currency,
        coalesce(sum(amount) filter (where amount > 0), 0) as inflow_fx,
        coalesce(abs(sum(amount) filter (where amount < 0)), 0) as outflow_fx
      from public.fx_positions
      where is_active = true and currency <> 'TRY'
      group by currency
    `).catch(() => ({ rows: [] })),
    pool.query(`
      select base_currency, rate
      from public.fx_latest_rates
      where quote_currency = 'TRY'
    `).catch(() => ({ rows: [] })),
  ]);

  const rateMap = new Map<string, number>();
  for (const r of ratesRes.rows) {
    rateMap.set(r.base_currency, Number(r.rate));
  }

  // Varsayılan kurlar (Tabloda kur yoksa koruyucu fallback)
  if (!rateMap.has("USD")) rateMap.set("USD", 35.0);
  if (!rateMap.has("EUR")) rateMap.set("EUR", 38.0);
  if (!rateMap.has("GBP")) rateMap.set("GBP", 45.0);

  const analyses: CurrencyHedgeAnalysis[] = [];
  let totalNetTRY = 0;
  let totalWorstCase20TRY = 0;

  for (const row of exposureRes.rows) {
    const cur = String(row.currency);
    const rate = rateMap.get(cur) ?? 35.0;
    const analysis = analyzeCurrencyHedge({
      currency: cur,
      inflowFX: Number(row.inflow_fx),
      outflowFX: Number(row.outflow_fx),
      spotRateTRY: rate,
    });

    analyses.push(analysis);
    totalNetTRY += analysis.netExposureTRY;
    if (analysis.stressTest.shock20PctDeltaTRY < 0) {
      totalWorstCase20TRY += Math.abs(analysis.stressTest.shock20PctDeltaTRY);
    }
  }

  let summary = "Şirket kur pozisyonu dengeli düzeydedir.";
  if (totalWorstCase20TRY > 100000) {
    summary = `DİKKAT: Şirketin döviz açık pozisyonu nedeniyle olası %20 devalüasyon durumunda beklenen kur farkı zararı ₺${Math.round(totalWorstCase20TRY).toLocaleString("tr-TR")} seviyesindedir. Türev koruma planı gerekmektedir.`;
  }

  return {
    asOfDate: new Date().toISOString().slice(0, 10),
    totalNetExposureTRY: Math.round(totalNetTRY * 100) / 100,
    totalWorstCase20DeltaTRY: Math.round(totalWorstCase20TRY * 100) / 100,
    currencies: analyses,
    executiveSummary: summary,
  };
}
