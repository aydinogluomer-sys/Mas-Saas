"use client";

import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import type { FinancialNervousSystemReport } from "@/lib/chains";

interface Props {
  initialReport: FinancialNervousSystemReport;
}

export function NervousSystemHub({ initialReport }: Props) {
  const [report, setReport] = useState<FinancialNervousSystemReport>(initialReport);
  const [loading, setLoading] = useState(false);
  const [actionNotice, setActionNotice] = useState<string | null>(null);

  const handleRefresh = async () => {
    setLoading(true);
    setActionNotice(null);
    try {
      const res = await fetch("/api/chains");
      const json = await res.json();
      if (json.ok && json.report) {
        setReport(json.report);
      }
    } catch {
      // Keep existing report
    } finally {
      setLoading(false);
    }
  };

  const handleTriggerAction = (chainTitle: string, actionMsg: string) => {
    setActionNotice(`✓ Aksiyon Uygulandı [${chainTitle}]: ${actionMsg}`);
    setTimeout(() => setActionNotice(null), 5000);
  };

  const getScoreColor = (score: number) => {
    if (score >= 80) return "text-emerald-400 border-emerald-500/30 bg-emerald-500/10";
    if (score >= 65) return "text-amber-400 border-amber-500/30 bg-amber-500/10";
    return "text-rose-400 border-rose-500/30 bg-rose-500/10";
  };

  const c = report.chains;

  return (
    <div className="space-y-6">
      {/* 1. Üst Başlık & Sağlık Skoru */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="md:col-span-3 p-6 rounded-xl border bg-slate-900/60 border-slate-800">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
            <div>
              <div className="flex items-center gap-3">
                <h2 className="text-xl font-bold text-slate-100">Bütünleşik Finansal Sinir Sistemi</h2>
                <Badge tone="blue">8 Zincir Aktif</Badge>
                <Badge tone="neutral">Son Tarama: {report.scanDate}</Badge>
              </div>
              <p className="mt-1 text-sm text-slate-400">
                ERP, tahsilat, harcama bütçesi, çek portföyü, kur riski, yasal vergi ve mobil komutayı birbirine bağlayan otonom denetim ağı.
              </p>
            </div>
            <button
              onClick={handleRefresh}
              disabled={loading}
              className="px-4 py-2 rounded-lg font-medium text-sm bg-indigo-600 hover:bg-indigo-500 text-white shrink-0 disabled:opacity-50 transition"
            >
              {loading ? "Taranıyor..." : "⚡ Canlı Sinir Taraması Yap"}
            </button>
          </div>

          {actionNotice && (
            <div className="mt-4 p-3 rounded-lg bg-emerald-950/40 border border-emerald-800/60 text-emerald-200 text-sm flex items-center gap-2">
              <span>{actionNotice}</span>
            </div>
          )}

          {/* Aktif Uyarılar Listesi */}
          {report.alerts.length > 0 && (
            <div className="mt-4 pt-4 border-t border-slate-800 space-y-2">
              <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">
                Öncelikli Eylem Gerektiren Uyarılar ({report.alerts.length})
              </span>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                {report.alerts.slice(0, 4).map((al) => (
                  <div
                    key={al.id}
                    className="p-3 rounded-lg bg-slate-800/50 border border-slate-700/60 text-xs flex flex-col justify-between"
                  >
                    <div>
                      <div className="flex items-center gap-2 mb-1">
                        <span className={`w-2 h-2 rounded-full ${al.severity === 'critical' ? 'bg-rose-500' : al.severity === 'warning' ? 'bg-amber-500' : 'bg-blue-500'}`} />
                        <span className="font-semibold text-slate-200">{al.title}</span>
                      </div>
                      <p className="text-slate-400 line-clamp-2">{al.detail}</p>
                    </div>
                    <p className="mt-2 text-indigo-300 font-medium">{al.recommendedAction}</p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Skor Kartı */}
        <div className={`p-6 rounded-xl border flex flex-col items-center justify-center text-center ${getScoreColor(report.overallHealthScore)}`}>
          <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">Genel Finansal Sağlık Skoru</span>
          <div className="mt-2 text-5xl font-black">{report.overallHealthScore}</div>
          <span className="mt-1 text-sm font-bold uppercase tracking-wider">{report.healthStatus}</span>
          <span className="mt-2 text-xs text-slate-400">Analiz Süresi: {report.durationMs}ms</span>
        </div>
      </div>

      {/* 2. 8 İhtiyaç Tabanlı Zincir Kartları */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Zincir 1: Order-to-Cash */}
        <div className="p-4 rounded-xl border bg-slate-900/60 border-slate-800 hover:border-slate-700 transition flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-indigo-400">1. GELİR ZİNCİRİ</span>
              <Badge tone="blue">DSO: {c.orderToCash.weightedAverageDSO} Gün</Badge>
            </div>
            <h3 className="mt-2 font-bold text-slate-100 text-sm">Otonom Tahsilat & DSO</h3>
            <div className="mt-3 space-y-1 text-xs text-slate-300">
              <div className="flex justify-between">
                <span className="text-slate-400">Açık Alacak:</span>
                <span className="font-mono">{c.orderToCash.totalOpenReceivablesTRY.toLocaleString("tr-TR")} ₺</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400">Gecikmiş:</span>
                <span className="font-mono text-rose-400">{c.orderToCash.overdueReceivablesTRY.toLocaleString("tr-TR")} ₺</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400">İskonto Fırsatı:</span>
                <span className="text-emerald-400">{c.orderToCash.dynamicDiscountOpportunities.length} Fatura</span>
              </div>
            </div>
          </div>
          <button
            className="mt-4 w-full py-1.5 px-3 rounded bg-slate-800 hover:bg-slate-700 text-xs font-medium text-slate-200 transition"
            onClick={() => handleTriggerAction("Order-to-Cash", "Gecikmiş müşterilere dinamik iskonto ve ödeme sözü hatırlatıcısı gönderildi.")}
          >
            İskonto & Hatırlatma Gönder
          </button>
        </div>

        {/* Zincir 2: Procure-to-Pay */}
        <div className="p-4 rounded-xl border bg-slate-900/60 border-slate-800 hover:border-slate-700 transition flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-amber-400">2. GİDER ZİNCİRİ</span>
              <Badge tone={c.procureToPay.cashDeficitAlertsCount > 0 ? "red" : "green"}>
                {c.procureToPay.cashDeficitAlertsCount > 0 ? "Nakit Riski" : "Güvenli"}
              </Badge>
            </div>
            <h3 className="mt-2 font-bold text-slate-100 text-sm">Harcama & Likidite Kalkanı</h3>
            <div className="mt-3 space-y-1 text-xs text-slate-300">
              <div className="flex justify-between">
                <span className="text-slate-400">7 Günde Ödenecek:</span>
                <span className="font-mono">{c.procureToPay.dueNext7DaysTRY.toLocaleString("tr-TR")} ₺</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400">Bütçe Aşım Uyarısı:</span>
                <span className="font-mono text-amber-400">{c.procureToPay.budgetOverrunAlertsCount} Adet</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400">Kredi Headroom:</span>
                <span className="font-mono text-emerald-400">{c.procureToPay.availableCreditHeadroomTRY.toLocaleString("tr-TR")} ₺</span>
              </div>
            </div>
          </div>
          <button
            className="mt-4 w-full py-1.5 px-3 rounded bg-slate-800 hover:bg-slate-700 text-xs font-medium text-slate-200 transition"
            onClick={() => handleTriggerAction("Procure-to-Pay", "Kasa açığı yaratan faturalara 15 gün erteleme ve vadeli çek önerisi bağlandı.")}
          >
            Ödeme Vadelerini Ötele
          </button>
        </div>

        {/* Zincir 3: Treasury Optimization */}
        <div className="p-4 rounded-xl border bg-slate-900/60 border-slate-800 hover:border-slate-700 transition flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-emerald-400">3. HAZİNE & ÇEKLER</span>
              <Badge tone="blue">Headroom Var</Badge>
            </div>
            <h3 className="mt-2 font-bold text-slate-100 text-sm">Çek & Kredi Optimizasyonu</h3>
            <div className="mt-3 space-y-1 text-xs text-slate-300">
              <div className="flex justify-between">
                <span className="text-slate-400">Portföy Çekleri:</span>
                <span className="font-mono">{c.treasuryOptimization.totalChecksPortfolioTRY.toLocaleString("tr-TR")} ₺</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400">Riskli Keşideci:</span>
                <span className="font-mono text-rose-400">{c.treasuryOptimization.riskyChecksCount} Çek</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400">En Ucuz Kaynak:</span>
                <span className="text-indigo-300 truncate max-w-[130px]">{c.treasuryOptimization.cheapestLiquidityRoute.recommendedSource}</span>
              </div>
            </div>
          </div>
          <button
            className="mt-4 w-full py-1.5 px-3 rounded bg-slate-800 hover:bg-slate-700 text-xs font-medium text-slate-200 transition"
            onClick={() => handleTriggerAction("Treasury", "En ucuz faizli rotatif tesis ve hesaplar arası nakit havuzlama transferi onaylandı.")}
          >
            En Ucuz Kaynağı Seç
          </button>
        </div>

        {/* Zincir 4: FX Defense */}
        <div className="p-4 rounded-xl border bg-slate-900/60 border-slate-800 hover:border-slate-700 transition flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-cyan-400">4. KUR KORUMA (FX)</span>
              <Badge tone={c.fxDefense.overallVerdict === "HIGH_FX_RISK" ? "red" : "green"}>
                {c.fxDefense.overallVerdict}
              </Badge>
            </div>
            <h3 className="mt-2 font-bold text-slate-100 text-sm">Kur Riski & Doğal Hedge</h3>
            <div className="mt-3 space-y-1 text-xs text-slate-300">
              <div className="flex justify-between">
                <span className="text-slate-400">Net FX Maruziyet:</span>
                <span className="font-mono">{c.fxDefense.totalNetExposureTRY.toLocaleString("tr-TR")} ₺</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400">%20 Şok Riski:</span>
                <span className="font-mono text-rose-400">{c.fxDefense.totalShock20PctRiskTRY.toLocaleString("tr-TR")} ₺</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400">Para Birimleri:</span>
                <span>{c.fxDefense.positions.map(p => p.currency).join(", ")}</span>
              </div>
            </div>
          </div>
          <button
            className="mt-4 w-full py-1.5 px-3 rounded bg-slate-800 hover:bg-slate-700 text-xs font-medium text-slate-200 transition"
            onClick={() => handleTriggerAction("FX Defense", "Açık pozisyon için doğal eşleme ve döviz forward emri hazırlandı.")}
          >
            Doğal Eşleme Uygula
          </button>
        </div>

        {/* Zincir 5: Statutory Defense */}
        <div className="p-4 rounded-xl border bg-slate-900/60 border-slate-800 hover:border-slate-700 transition flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-purple-400">5. YASAL TAKVİM</span>
              <Badge tone={c.statutoryDefense.isReserveCompromised ? "red" : "green"}>
                {c.statutoryDefense.safetyVerdict}
              </Badge>
            </div>
            <h3 className="mt-2 font-bold text-slate-100 text-sm">Vergi / SGK / Maaş Blokajı</h3>
            <div className="mt-3 space-y-1 text-xs text-slate-300">
              <div className="flex justify-between">
                <span className="text-slate-400">Yasal Rezerv:</span>
                <span className="font-mono text-amber-400">{c.statutoryDefense.statutoryReservedAmountTRY.toLocaleString("tr-TR")} ₺</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400">Serbest Nakit:</span>
                <span className="font-mono text-emerald-400">{c.statutoryDefense.freeUsableCashTRY.toLocaleString("tr-TR")} ₺</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400">Yasal Kalemler:</span>
                <span>{c.statutoryDefense.upcomingObligations.length} Yükümlülük</span>
              </div>
            </div>
          </div>
          <button
            className="mt-4 w-full py-1.5 px-3 rounded bg-slate-800 hover:bg-slate-700 text-xs font-medium text-slate-200 transition"
            onClick={() => handleTriggerAction("Statutory Defense", "Yasal vergi ve maaş tutarı serbest nakit harcamalarına karşı kilitlendi.")}
          >
            Rezerv Kilidini Koru
          </button>
        </div>

        {/* Zincir 6: Fraud Integrity */}
        <div className="p-4 rounded-xl border bg-slate-900/60 border-slate-800 hover:border-slate-700 transition flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-rose-400">6. GÜVENLİK (FRAUD)</span>
              <Badge tone={c.fraudIntegrity.quarantinedCount > 0 ? "red" : "green"}>
                {c.fraudIntegrity.quarantinedCount > 0 ? "Karantina Var" : "Temiz"}
              </Badge>
            </div>
            <h3 className="mt-2 font-bold text-slate-100 text-sm">IBAN & Mükerrer Ödeme Ağı</h3>
            <div className="mt-3 space-y-1 text-xs text-slate-300">
              <div className="flex justify-between">
                <span className="text-slate-400">Taranan Ödeme:</span>
                <span>{c.fraudIntegrity.scannedPaymentsCount} Adet</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400">Karantinaya Alınan:</span>
                <span className="font-mono text-rose-400">{c.fraudIntegrity.quarantinedCount} İşlem</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400">Riskteki Hacim:</span>
                <span className="font-mono">{c.fraudIntegrity.totalAtRiskAmountTRY.toLocaleString("tr-TR")} ₺</span>
              </div>
            </div>
          </div>
          <button
            className="mt-4 w-full py-1.5 px-3 rounded bg-slate-800 hover:bg-slate-700 text-xs font-medium text-slate-200 transition"
            onClick={() => handleTriggerAction("Fraud Integrity", "Şüpheli yeni IBAN transferleri karantinaya alındı; yetkili teyidi bekleniyor.")}
          >
            Karantinayı İncele
          </button>
        </div>

        {/* Zincir 7: Cash-Unit Economics */}
        <div className="p-4 rounded-xl border bg-slate-900/60 border-slate-800 hover:border-slate-700 transition flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-orange-400">7. ÜRETİM KÂRLILIĞI</span>
              <Badge tone={c.cashUnitEconomics.cashDrainersCount > 0 ? "amber" : "green"}>
                {c.cashUnitEconomics.cashDrainersCount} Nakit Yutucu
              </Badge>
            </div>
            <h3 className="mt-2 font-bold text-slate-100 text-sm">Gerçek Kasa Birim Kârı</h3>
            <div className="mt-3 space-y-1 text-xs text-slate-300">
              <div className="flex justify-between">
                <span className="text-slate-400">Muhasebe Kârı:</span>
                <span className="font-mono">%{c.cashUnitEconomics.averageAccountingMarginPercent}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400">Net Kasa Kârı:</span>
                <span className="font-mono text-emerald-400">%{c.cashUnitEconomics.averageTrueCashMarginPercent}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400">Finansman Kaybı:</span>
                <span className="font-mono text-rose-400">-{c.cashUnitEconomics.financingDragMarginPoints} Puan</span>
              </div>
            </div>
          </div>
          <button
            className="mt-4 w-full py-1.5 px-3 rounded bg-slate-800 hover:bg-slate-700 text-xs font-medium text-slate-200 transition"
            onClick={() => handleTriggerAction("Cash-Unit Economics", "Nakit yutan ürünler için maksimum 45 gün vade sınırı ve peşinat zorunluluğu getirildi.")}
          >
            Vade Sınırı Koy
          </button>
        </div>

        {/* Zincir 8: Executive Hub */}
        <div className="p-4 rounded-xl border bg-slate-900/60 border-slate-800 hover:border-slate-700 transition flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between">
              <span className="text-xs font-bold text-pink-400">8. MOBİL KOMUTA</span>
              <Badge tone="violet">{c.executiveHub.briefingTime} Brifingi</Badge>
            </div>
            <h3 className="mt-2 font-bold text-slate-100 text-sm">Sabah 08:30 Mobil Yönetici</h3>
            <div className="mt-3 space-y-1 text-xs text-slate-300">
              <div className="flex justify-between">
                <span className="text-slate-400">Günlük Net Kasa:</span>
                <span className={`font-mono ${c.executiveHub.netDailyCashDeltaTRY >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                  {c.executiveHub.netDailyCashDeltaTRY >= 0 ? '+' : ''}{c.executiveHub.netDailyCashDeltaTRY.toLocaleString("tr-TR")} ₺
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400">Bekleyen Karar:</span>
                <span className="font-mono">{c.executiveHub.pendingMobileActions.length} Aksiyon</span>
              </div>
              <div className="flex justify-between">
                <span className="text-slate-400">Kasa Dayanma:</span>
                <span className="text-slate-200">~{c.executiveHub.netLiquidityStatus.cashRunwayDays} Gün</span>
              </div>
            </div>
          </div>
          <button
            className="mt-4 w-full py-1.5 px-3 rounded bg-indigo-600 hover:bg-indigo-500 text-xs font-medium text-white transition"
            onClick={() => handleTriggerAction("Executive Hub", "Sabah 08:30 mikro brifingi ve tek tuş onay listesi yöneticinin Telegram'ına iletildi.")}
          >
            📱 Telegram'a Gönder
          </button>
        </div>
      </div>
    </div>
  );
}
