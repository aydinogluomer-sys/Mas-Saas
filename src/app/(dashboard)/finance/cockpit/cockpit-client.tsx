"use client";

import { useState, useTransition } from "react";
import { Panel, fmtTL, Num } from "@/components/ui/panel";
import { KpiCard, PageHeader } from "@/components/ui/shell";
import type { CashRunwayReport } from "@/lib/finance/cash-runway";
import type { BatchDiscountOptimizationReport, EarlyDiscountOffer } from "@/lib/finance/dynamic-discounting";
import type { FxHedgingReport } from "@/lib/finance/fx-hedging";
import type { SimulationReport } from "@/lib/simulations/sandbox";
import type { CashPoolingReport } from "@/lib/treasury/cash-pooling";
import type { ChainVerificationResult } from "@/lib/audit/hash-chain";
import {
  verifyAuditChainAction,
  runSimulationAction,
  recomputeDiscountArbitrageAction,
} from "./actions";

interface Props {
  initialRunway: CashRunwayReport;
  initialArbitrage: BatchDiscountOptimizationReport;
  initialFx: FxHedgingReport;
  initialSimulation: SimulationReport;
  initialPooling: CashPoolingReport;
  initialAudit: ChainVerificationResult;
  sampleOffers: EarlyDiscountOffer[];
}

export function CfoCockpitClient({
  initialRunway,
  initialArbitrage,
  initialFx,
  initialSimulation,
  initialPooling,
  initialAudit,
  sampleOffers,
}: Props) {
  // Stres Senaryosu Seçimi (Runway)
  const [selectedScenario, setSelectedScenario] = useState<"baseline" | "pessimistic" | "severeShock">("baseline");

  // What-If Simülasyon Durumları
  const [revenueShock, setRevenueShock] = useState<number>(0);
  const [expenseInflation, setExpenseInflation] = useState<number>(0);
  const [capexAmount, setCapexAmount] = useState<number>(0);
  const [capexWeek, setCapexWeek] = useState<number>(3);
  const [simReport, setSimReport] = useState<SimulationReport>(initialSimulation);
  const [isSimulating, startSimTransition] = useTransition();

  // Dinamik İskonto Arbitraj Durumu
  const [borrowingCost, setBorrowingCost] = useState<number>(42);
  const [arbitrageReport, setArbitrageReport] = useState<BatchDiscountOptimizationReport>(initialArbitrage);
  const [isArbitrageLoading, startArbitrageTransition] = useTransition();

  // Kriptografik Denetim Zinciri Doğrulama
  const [auditResult, setAuditResult] = useState<ChainVerificationResult>(initialAudit);
  const [isVerifyingAudit, startAuditTransition] = useTransition();

  const currentRunway = initialRunway.scenarios[selectedScenario];

  const handleRunSimulation = () => {
    startSimTransition(async () => {
      const updated = await runSimulationAction({
        revenueShockPercent: revenueShock !== 0 ? revenueShock : undefined,
        expenseInflationPercent: expenseInflation !== 0 ? expenseInflation : undefined,
        capexOutflows: capexAmount > 0 ? [{ weekIndex: capexWeek, amount: capexAmount, label: "Simüle Edilen CAPEX" }] : undefined,
      });
      setSimReport(updated);
    });
  };

  const handleRecalculateArbitrage = (rate: number) => {
    setBorrowingCost(rate);
    startArbitrageTransition(async () => {
      const updated = await recomputeDiscountArbitrageAction(sampleOffers, rate);
      setArbitrageReport(updated);
    });
  };

  const handleVerifyAuditChain = () => {
    startAuditTransition(async () => {
      const res = await verifyAuditChainAction();
      setAuditResult(res);
    });
  };

  return (
    <div className="space-y-4">
      {/* ── 1. ÜST BAŞLIK VE KONTROL AKSİYONU ── */}
      <PageHeader
        title="CFO Karar Konsolu & Yönetici Kokpiti"
        subtitle="Canlı likidite stresi, nakit yakma hızı (Runway), iskonto arbitrajı, döviz doğal hedge ve What-If simülatörü."
        action={
          <button
            onClick={handleVerifyAuditChain}
            disabled={isVerifyingAudit}
            className="button-accent px-3.5 py-1.5 font-sans font-medium text-xs flex items-center gap-1.5 disabled:opacity-50"
          >
            {isVerifyingAudit ? "Doğrulanıyor..." : "🛡️ Denetim Zincirini Doğrula"}
          </button>
        }
      />

      {/* ── 2. TEMEL YÖNETİCİ KPI'LARI ── */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-6">
        <KpiCard
          label="Mevcut Likit Nakit"
          value={fmtTL(initialRunway.totalLiquidCash)}
          tone="pos"
          emphasize
          note={`Kredi Tamponu: ${fmtTL(initialRunway.availableCreditHeadroom)}`}
        />
        <KpiCard
          label="Cash-Out Day (Normal)"
          value={`${initialRunway.scenarios.baseline.runwayDays} Gün`}
          tone={initialRunway.scenarios.baseline.runwayDays > 60 ? "pos" : "warn"}
          emphasize
          note={`Tarih: ${initialRunway.scenarios.baseline.cashOutDate}`}
        />
        <KpiCard
          label="Kötümsel Cash-Out"
          value={`${initialRunway.scenarios.pessimistic.runwayDays} Gün`}
          tone={initialRunway.scenarios.pessimistic.runwayDays > 30 ? "warn" : "neg"}
          emphasize
          note={`Tarih: ${initialRunway.scenarios.pessimistic.cashOutDate}`}
        />
        <KpiCard
          label="Net Açık FX Riski"
          value={fmtTL(Math.abs(initialFx.totalNetExposureTRY))}
          tone={initialFx.totalWorstCase20DeltaTRY > 50000 ? "warn" : "neutral"}
          note={`%20 Şok: ${fmtTL(initialFx.totalWorstCase20DeltaTRY)}`}
        />
        <KpiCard
          label="Arbitraj Kâr Potansiyeli"
          value={fmtTL(arbitrageReport.totalNetArbitrageProfit)}
          tone="pos"
          note={`Ort. %${arbitrageReport.averageAnnualizedAPR} APR Getiri`}
        />
        <KpiCard
          label="Kriptografik Denetim"
          value={auditResult.isValid ? "Kusursuz" : "İhlal Var"}
          tone={auditResult.isValid ? "pos" : "neg"}
          note={`${auditResult.verifiedCount} log doğrulandı`}
        />
      </div>

      {/* ── 3. BÖLÜM: LİKİDİTE STRES TESTİ & CASH RUNWAY ── */}
      <Panel
        title="1. Likidite Stres Testi & Cash Runway (Kasanın Sıfırlanma Tarihi)"
        subtitle="Mevcut yakma hızına (burn rate) ve tahsilat şoklarına göre şirketin hayatta kalma süresi."
        right={
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => setSelectedScenario("baseline")}
              className={`px-3 py-1 font-sans text-xs font-medium rounded-full transition-all ${
                selectedScenario === "baseline" ? "bg-accent text-white shadow-sm" : "border border-line bg-surface-1 text-tone-3 hover:text-tone-1 hover:border-line-strong"
              }`}
            >
              Normal (Trend)
            </button>
            <button
              onClick={() => setSelectedScenario("pessimistic")}
              className={`px-3 py-1 font-sans text-xs font-medium rounded-full transition-all ${
                selectedScenario === "pessimistic" ? "bg-warn text-white shadow-sm" : "border border-line bg-surface-1 text-tone-3 hover:text-tone-1 hover:border-line-strong"
              }`}
            >
              Kötümsel (-%25)
            </button>
            <button
              onClick={() => setSelectedScenario("severeShock")}
              className={`px-3 py-1 font-sans text-xs font-medium rounded-full transition-all ${
                selectedScenario === "severeShock" ? "bg-neg text-white shadow-sm" : "border border-line bg-surface-1 text-tone-3 hover:text-tone-1 hover:border-line-strong"
              }`}
            >
              Kara Kuğu (-%60)
            </button>
          </div>
        }
      >
        <div className="grid gap-4 md:grid-cols-3">
          <div className="space-y-2 border-r border-line pr-4">
            <div className="font-sans text-xs font-medium text-tone-3">Seçili Senaryo:</div>
            <div className="font-mono text-sm font-semibold text-tone-1">{currentRunway.scenarioName}</div>
            <p className="text-xs text-tone-3">{currentRunway.description}</p>
            <div className="mt-2 pt-2 border-t border-line space-y-1 font-mono text-xs">
              <div className="flex justify-between">
                <span className="text-tone-4">Aylık Net Nakit Yakma:</span>
                <span className="text-neg">{fmtTL(currentRunway.monthlyBurnRate)}/ay</span>
              </div>
              <div className="flex justify-between">
                <span className="text-tone-4">Günlük Burn Rate:</span>
                <span className="text-tone-2">{fmtTL(currentRunway.dailyBurnRate)}/gün</span>
              </div>
              <div className="flex justify-between">
                <span className="text-tone-4">Efektif Nakit Tamponu:</span>
                <span className="text-pos">{fmtTL(currentRunway.effectiveCashBuffer)}</span>
              </div>
            </div>
          </div>

          <div className="flex flex-col justify-center items-center p-4 bg-surface-2 rounded border border-line text-center">
            <div className="font-mono text-[11px] uppercase tracking-wider text-tone-3">Kasanın Sıfırlandığı Gün (Cash-Out Day)</div>
            <div className="mt-2 font-mono text-2xl font-bold tracking-tight text-neg">
              {currentRunway.cashOutDate}
            </div>
            <div className="mt-1 font-mono text-xs text-tone-2">
              Kalan Dayanıklılık: <span className="font-bold text-tone-1">{currentRunway.runwayDays} Gün</span> ({currentRunway.runwayMonths} Ay)
            </div>
            {currentRunway.cashOutDateWithCredit && (
              <div className="mt-2 text-[10px] font-mono text-accent">
                Kredi limitleri çekilirse: {currentRunway.cashOutDateWithCredit} (+{currentRunway.runwayWithCreditDays} gün)
              </div>
            )}
          </div>

          <div className="space-y-2 pl-2">
            <div className="font-mono text-xs font-semibold text-tone-2">CFO Aksiyon Tavsiyeleri:</div>
            <ul className="space-y-1.5 text-xs text-tone-3 list-disc pl-4">
              {currentRunway.mitigationActions.map((act, idx) => (
                <li key={idx}>{act}</li>
              ))}
            </ul>
          </div>
        </div>
      </Panel>

      {/* ── 4. BÖLÜM: DİNAMİK İSKONTO VE ERKEN ÖDEME ARBİTRAJI ── */}
      <Panel
        title="2. Dinamik İskonto & Erken Ödeme Arbitraj Masası"
        subtitle="Tedarikçi erken ödeme iskontolarının yıllık bileşik getirisini (APR) şirketin kredi maliyetiyle kıyaslar."
        right={
          <div className="flex items-center gap-2 font-mono text-xs">
            <span className="text-tone-3">Şirket Fonlama Faizi:</span>
            <input
              type="number"
              value={borrowingCost}
              onChange={(e) => handleRecalculateArbitrage(Number(e.target.value))}
              className="w-16 px-1.5 py-0.5 bg-surface-2 border border-line rounded text-right font-mono"
            />
            <span className="text-tone-4">%</span>
          </div>
        }
      >
        <div className="overflow-x-auto">
          <table className="w-full text-left font-mono text-xs">
            <thead>
              <tr className="border-b border-line text-tone-4 uppercase text-[10px]">
                <th className="py-2">Tedarikçi</th>
                <th className="py-2 text-right">Fatura Tutarı</th>
                <th className="py-2 text-right">İskonto Oranı</th>
                <th className="py-2 text-right">Kazanılan Gün</th>
                <th className="py-2 text-right">Yıllık Getiri (APR)</th>
                <th className="py-2 text-right">Net Arbitraj Kârı</th>
                <th className="py-2 text-center">CFO Kararı</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line-faint">
              {arbitrageReport.results.map((res) => (
                <tr key={res.invoiceId} className="hover:bg-surface-2/50 transition-colors">
                  <td className="py-2.5 font-medium text-tone-1">{res.counterpartyName}</td>
                  <td className="py-2.5 text-right">{fmtTL(res.invoiceAmount)}</td>
                  <td className="py-2.5 text-right text-accent">%{res.discountPercent}</td>
                  <td className="py-2.5 text-right">{res.daysSaved} gün</td>
                  <td className="py-2.5 text-right font-bold text-pos">%{res.annualizedReturnAPR}</td>
                  <td className="py-2.5 text-right font-bold text-pos">
                    {res.netArbitrageProfitTL > 0 ? `+${fmtTL(res.netArbitrageProfitTL)}` : fmtTL(res.netArbitrageProfitTL)}
                  </td>
                  <td className="py-2.5 text-center">
                    <span
                      className={`inline-block px-2 py-0.5 rounded text-[10px] uppercase font-bold ${
                        res.decision === "PAY_EARLY"
                          ? "bg-pos/20 text-pos border border-pos/40"
                          : res.decision === "HOLD_LIQUIDITY"
                          ? "bg-warn/20 text-warn border border-warn/40"
                          : "bg-surface-3 text-tone-3"
                      }`}
                    >
                      {res.decision === "PAY_EARLY" ? "Erken Öde (Kazan)" : res.decision === "HOLD_LIQUIDITY" ? "Nakit Koru" : "Vadede Öde"}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>

      {/* ── 5. BÖLÜM: DÖVİZ AÇIK POZİSYON VE DOĞAL HEDGE ── */}
      <Panel
        title="3. Net Açık Döviz Pozisyonu & Doğal Hedge Termometresi"
        subtitle="Döviz giriş ve çıkışlarının birbirini karşılama oranı ve devalüasyon stres testi."
      >
        <div className="grid gap-3 md:grid-cols-3">
          {initialFx.currencies.map((c) => (
            <div key={c.currency} className="p-3 border border-line rounded bg-surface-2 space-y-2">
              <div className="flex items-center justify-between">
                <span className="font-mono text-sm font-bold text-tone-1">{c.currency} / TRY</span>
                <span
                  className={`font-mono text-[10px] px-1.5 py-0.5 rounded font-semibold ${
                    c.positionType === "NET_LONG" ? "bg-pos/20 text-pos" : c.positionType === "NET_SHORT" ? "bg-neg/20 text-neg" : "bg-surface-3 text-tone-3"
                  }`}
                >
                  {c.positionType === "NET_LONG" ? "NET UZUN (LONG)" : c.positionType === "NET_SHORT" ? "NET KISA (AÇIK)" : "DENGELİ"}
                </span>
              </div>

              <div className="font-mono text-xs space-y-1 pt-1 border-t border-line-faint">
                <div className="flex justify-between text-tone-3">
                  <span>Döviz Alacak/Nakit:</span>
                  <span className="text-tone-1">{c.inflowFX.toLocaleString("tr-TR")} {c.currency}</span>
                </div>
                <div className="flex justify-between text-tone-3">
                  <span>Döviz Borç/Yükümlülük:</span>
                  <span className="text-tone-1">{c.outflowFX.toLocaleString("tr-TR")} {c.currency}</span>
                </div>
                <div className="flex justify-between text-tone-3 font-semibold">
                  <span>Net Pozisyon:</span>
                  <span className={c.netExposureFX >= 0 ? "text-pos" : "text-neg"}>
                    {c.netExposureFX.toLocaleString("tr-TR")} {c.currency} ({fmtTL(c.netExposureTRY)})
                  </span>
                </div>
              </div>

              {/* Doğal Hedge Progress Bar */}
              <div className="pt-2">
                <div className="flex justify-between font-mono text-[10px] text-tone-4 mb-1">
                  <span>Doğal Koruma Oranı:</span>
                  <span className="font-bold text-tone-2">%{c.naturalHedgeRatio}</span>
                </div>
                <div className="w-full bg-surface-3 rounded-full h-1.5 overflow-hidden">
                  <div
                    className={`h-full ${c.naturalHedgeRatio >= 80 ? "bg-pos" : c.naturalHedgeRatio >= 50 ? "bg-warn" : "bg-neg"}`}
                    style={{ width: `${Math.min(100, c.naturalHedgeRatio)}%` }}
                  />
                </div>
              </div>

              {/* Şok Testi Tablosu */}
              <div className="pt-2 border-t border-line-faint font-mono text-[11px] space-y-0.5">
                <div className="text-[10px] text-tone-4 uppercase">Kur Artışı Şok Testi (TL Kâr/Zarar):</div>
                <div className="flex justify-between">
                  <span className="text-tone-3">+%10 Kur Artışı:</span>
                  <span className={c.stressTest.shock10PctDeltaTRY >= 0 ? "text-pos" : "text-neg"}>{fmtTL(c.stressTest.shock10PctDeltaTRY)}</span>
                </div>
                <div className="flex justify-between font-bold">
                  <span className="text-tone-2">+%20 Devalüasyon:</span>
                  <span className={c.stressTest.shock20PctDeltaTRY >= 0 ? "text-pos" : "text-neg"}>{fmtTL(c.stressTest.shock20PctDeltaTRY)}</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      </Panel>

      {/* ── 6. BÖLÜM: "WHAT-IF" FİNANSAL KUM HAVUZU SİMÜLATÖRÜ ── */}
      <Panel
        title="4. İnteraktif 'What-If' Finansal Kum Havuzu (Canlı 13 Haftalık Simülatör)"
        subtitle="Veritabanına dokunmadan tamamen hafızada nakit akışı senaryolarını test edin."
      >
        <div className="grid gap-6 md:grid-cols-4">
          <div className="space-y-4 md:col-span-1 p-3 bg-surface-2 rounded border border-line font-mono text-xs">
            <div className="font-semibold text-tone-1 border-b border-line pb-1">Senaryo Parametreleri:</div>

            <div className="space-y-1">
              <div className="flex justify-between text-tone-3">
                <span>Satış Gelir Şoku:</span>
                <span className="text-neg font-bold">%{revenueShock}</span>
              </div>
              <input
                type="range"
                min="-40"
                max="0"
                step="5"
                value={revenueShock}
                onChange={(e) => setRevenueShock(Number(e.target.value))}
                className="w-full"
              />
            </div>

            <div className="space-y-1">
              <div className="flex justify-between text-tone-3">
                <span>Gider Enflasyonu:</span>
                <span className="text-warn font-bold">+%{expenseInflation}</span>
              </div>
              <input
                type="range"
                min="0"
                max="30"
                step="5"
                value={expenseInflation}
                onChange={(e) => setExpenseInflation(Number(e.target.value))}
                className="w-full"
              />
            </div>

            <div className="space-y-1">
              <div className="text-tone-3">Makine / CAPEX Yatırımı (TL):</div>
              <input
                type="number"
                step="50000"
                value={capexAmount}
                onChange={(e) => setCapexAmount(Number(e.target.value))}
                placeholder="Örn: 500000"
                className="w-full px-2 py-1 bg-surface-1 border border-line rounded text-right font-mono"
              />
            </div>

            <div className="space-y-1">
              <div className="text-tone-3">Yatırım Çıkış Haftası:</div>
              <select
                value={capexWeek}
                onChange={(e) => setCapexWeek(Number(e.target.value))}
                className="w-full px-2 py-1 bg-surface-1 border border-line rounded font-mono"
              >
                {[...Array(13)].map((_, i) => (
                  <option key={i + 1} value={i + 1}>
                    Hafta {i + 1}
                  </option>
                ))}
              </select>
            </div>

            <button
              onClick={handleRunSimulation}
              disabled={isSimulating}
              className="w-full button-accent py-2 font-mono text-xs font-bold uppercase tracking-wider"
            >
              {isSimulating ? "Hesaplanıyor..." : "Simülasyonu Çalıştır"}
            </button>
          </div>

          <div className="space-y-3 md:col-span-3">
            <div className="p-3 bg-surface-2 rounded border border-line font-mono text-xs flex items-center justify-between">
              <div>
                <span className="text-tone-4">Simülasyon Değerlendirmesi: </span>
                <span className={`font-bold ${simReport.deficitOccurs ? "text-neg" : "text-pos"}`}>
                  {simReport.cfoExecutiveVerdict}
                </span>
              </div>
              {simReport.deficitOccurs && (
                <div className="text-right">
                  <div className="text-[10px] text-tone-4">Gereken Kredi Tamponu:</div>
                  <div className="font-bold text-neg">{fmtTL(simReport.maxDeficitAmount)}</div>
                </div>
              )}
            </div>

            {/* 13 Haftalık Simülasyon Çizelgesi */}
            <div className="overflow-x-auto border border-line rounded">
              <table className="w-full text-left font-mono text-[11px]">
                <thead>
                  <tr className="border-b border-line bg-surface-2 text-tone-4 uppercase text-[10px]">
                    <th className="py-2 px-2">Hafta</th>
                    <th className="py-2 px-2 text-right">Baz Giriş</th>
                    <th className="py-2 px-2 text-right">Baz Çıkış</th>
                    <th className="py-2 px-2 text-right">Simüle Giriş</th>
                    <th className="py-2 px-2 text-right">Simüle Çıkış</th>
                    <th className="py-2 px-2 text-right">Simüle Bakiye</th>
                    <th className="py-2 px-2 text-center">Durum</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-line-faint">
                  {simReport.weeklyTimeline.slice(0, 8).map((w) => (
                    <tr
                      key={w.weekIndex}
                      className={w.isDeficit ? "bg-neg/10 text-tone-1" : "hover:bg-surface-2/40"}
                    >
                      <td className="py-1.5 px-2 font-semibold">Hafta {w.weekIndex} ({w.weekStartDate.slice(5)})</td>
                      <td className="py-1.5 px-2 text-right text-tone-3">{fmtTL(w.baselineInflow)}</td>
                      <td className="py-1.5 px-2 text-right text-tone-3">{fmtTL(w.baselineOutflow)}</td>
                      <td className="py-1.5 px-2 text-right">{fmtTL(w.simulatedInflow)}</td>
                      <td className="py-1.5 px-2 text-right">{fmtTL(w.simulatedOutflow)}</td>
                      <td className={`py-1.5 px-2 text-right font-bold ${w.simulatedClosingBalance < 100000 ? "text-neg" : "text-tone-1"}`}>
                        {fmtTL(w.simulatedClosingBalance)}
                      </td>
                      <td className="py-1.5 px-2 text-center">
                        {w.isDeficit ? (
                          <span className="text-[9px] px-1 py-0.5 bg-neg text-white rounded font-bold">AÇIK (-{fmtTL(w.deficitAmount)})</span>
                        ) : (
                          <span className="text-[9px] text-pos font-bold">GÜVENLİ</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </Panel>

      {/* ── 7. BÖLÜM: HOLDİNG İÇİ MAHSUPLAŞMA & DENETİM İZİ ── */}
      <div className="grid gap-4 md:grid-cols-2">
        <Panel
          title="5. Holding İçi Nakit Havuzlama & Mahsuplaşma (Netting)"
          subtitle="Grup şirketleri arası ikili mahsuplaşma ve faiz arbitrajı."
        >
          <div className="space-y-3 font-mono text-xs">
            <p className="text-tone-3">{initialPooling.executiveSummary}</p>
            <div className="grid grid-cols-2 gap-2 pt-2 border-t border-line">
              <div className="p-2 bg-surface-2 rounded">
                <div className="text-[10px] text-tone-4">Önlenen Dış Kredi:</div>
                <div className="font-bold text-pos text-sm">{fmtTL(initialPooling.externalBorrowingAvoidedTRY)}</div>
              </div>
              <div className="p-2 bg-surface-2 rounded">
                <div className="text-[10px] text-tone-4">Yıllık Faiz Tasarrufu:</div>
                <div className="font-bold text-accent text-sm">{fmtTL(initialPooling.estimatedAnnualInterestSavingsTRY)}</div>
              </div>
            </div>
            {initialPooling.sweepInstructions.length > 0 && (
              <div className="space-y-1 pt-1">
                <div className="font-semibold text-tone-2 text-[11px]">Önerilen Fon Aktarım Talimatı:</div>
                {initialPooling.sweepInstructions.map((ins, i) => (
                  <div key={i} className="p-2 bg-surface-2 border border-line rounded text-[11px]">
                    <div className="font-bold text-tone-1">{ins.sourceEntityName} ➔ {ins.targetEntityName}</div>
                    <div className="text-accent">{fmtTL(ins.sweepAmountTRY)} (Yıllık Kazanç: {fmtTL(ins.annualInterestSavingsTRY)})</div>
                    <div className="text-[9px] text-tone-4 mt-0.5">{ins.taxComplianceNote}</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </Panel>

        <Panel
          title="6. Kriptografik Denetim Zinciri Bütünlüğü (SHA-256 Merkle)"
          subtitle="Geriye dönük tahrifat ve silinmelere karşı matematiksel denetim güvencesi."
        >
          <div className="space-y-3 font-mono text-xs">
            <div className={`p-3 rounded border ${auditResult.isValid ? "bg-pos/10 border-pos/30 text-pos" : "bg-neg/10 border-neg/30 text-neg"}`}>
              <div className="font-bold text-sm">{auditResult.verdictMessage}</div>
              <div className="text-[11px] mt-1 text-tone-3">
                Doğrulanan Toplam İşlem Sayısı: <span className="font-bold text-tone-1">{auditResult.verifiedCount}</span>
              </div>
            </div>
            <div className="text-xs text-tone-3 space-y-1">
              <div>• Her log bir önceki satırın SHA-256 özetiyle birbirine zincirlenmiştir.</div>
              <div>• Veritabanı yöneticisi dahi geriye dönük tutar değiştiremez veya kayıt silemez.</div>
              <div>• Bağımsız denetçiler ve düzenleyici kurumlar (SPK/BDDK) için kanıt niteliğindedir.</div>
            </div>
          </div>
        </Panel>
      </div>
    </div>
  );
}
