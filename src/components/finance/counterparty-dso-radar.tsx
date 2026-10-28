"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { fmtTL } from "@/components/ui/panel";

export interface CounterpartyItem {
  partyId: string;
  partyName: string;
  partyType: string;
  itemCount: number;
  unknownAmountCount: number;
  checkAmount: number;
  checkCount: number;
  loanAmount: number;
  loanInstallmentCount: number;
  paymentAmount: number;
  paymentCount: number;
  earliestDueDate: string | null;
  totalExposure: number;
  exposureRatio: number | null;
  creditLimit: number | null;
  creditLimitUtilization: number | null;
  overCreditLimit: boolean | null;
  creditLimitComparable: boolean;
  creditLimitCurrency: string | null;
  foreignCurrencyCount: number;
  activeIbanCount: number;
}

interface CounterpartyDsoRadarProps {
  items: CounterpartyItem[];
}

type FilterMode = "all" | "over_limit" | "high_concentration" | "checks";

export function CounterpartyDsoRadar({ items }: CounterpartyDsoRadarProps) {
  const [filterMode, setFilterMode] = useState<FilterMode>("all");
  const [searchQuery, setSearchQuery] = useState("");

  const scoredItems = useMemo(() => {
    return items.map((item) => {
      let score: "A" | "B" | "C" | "D" = "A";
      let recommendation = "Standart Tahsilat";
      let tone: "green" | "amber" | "red" | "neutral" = "green";

      if (item.overCreditLimit) {
        score = "D";
        recommendation = "Kritik Risk: Teminat & Erken Tahsilat";
        tone = "red";
      } else if ((item.exposureRatio ?? 0) > 0.3) {
        score = "C";
        recommendation = "Yoğunlaşma: Faktoringe Uygun";
        tone = "amber";
      } else if ((item.creditLimitUtilization ?? 0) > 0.8 || (item.exposureRatio ?? 0) > 0.15) {
        score = "B";
        recommendation = "Yakın İzleme & Mutabakat";
        tone = "amber";
      } else {
        score = "A";
        recommendation = "Güvenli Cari Portföyü";
        tone = "green";
      }

      return {
        ...item,
        score,
        recommendation,
        scoreTone: tone,
      };
    });
  }, [items]);

  const filteredItems = useMemo(() => {
    return scoredItems.filter((item) => {
      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        if (!item.partyName.toLowerCase().includes(q)) return false;
      }
      if (filterMode === "over_limit") return item.overCreditLimit === true;
      if (filterMode === "high_concentration") return (item.exposureRatio ?? 0) > 0.2;
      if (filterMode === "checks") return item.checkCount > 0;
      return true;
    });
  }, [scoredItems, searchQuery, filterMode]);

  const stats = useMemo(() => {
    const totalExp = items.reduce((sum, i) => sum + i.totalExposure, 0);
    const overLimitCount = items.filter((i) => i.overCreditLimit === true).length;
    const highConcCount = items.filter((i) => (i.exposureRatio ?? 0) > 0.2).length;
    const maxRatio = Math.max(...items.map((i) => i.exposureRatio ?? 0), 0);

    return {
      totalExp,
      overLimitCount,
      highConcCount,
      maxRatioPct: (maxRatio * 100).toFixed(1),
    };
  }, [items]);

  return (
    <div className="flex flex-col gap-4">
      {/* Top Metric Strip */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div className="rounded-xl border border-line bg-surface-1 p-4 shadow-sm">
          <span className="text-xs font-semibold uppercase tracking-wider text-tone-3">
            Toplam Cari Maruziyeti
          </span>
          <div className="mt-2 font-mono text-2xl font-bold tracking-tight text-tone-1">
            {fmtTL(stats.totalExp)}
          </div>
          <p className="mt-1 text-[11px] text-tone-3">
            {items.length} aktif cari hesap
          </p>
        </div>

        <div className="rounded-xl border border-line bg-surface-1 p-4 shadow-sm">
          <span className="text-xs font-semibold uppercase tracking-wider text-tone-3">
            Limit Aşımındaki Cariler
          </span>
          <div
            className={`mt-2 font-mono text-2xl font-bold tracking-tight ${
              stats.overLimitCount > 0 ? "text-red-400" : "text-emerald-400"
            }`}
          >
            {stats.overLimitCount}
          </div>
          <p className="mt-1 text-[11px] text-tone-3">
            {stats.overLimitCount > 0 ? "Kredi limiti yetersiz" : "Limit aşımı yok"}
          </p>
        </div>

        <div className="rounded-xl border border-line bg-surface-1 p-4 shadow-sm">
          <span className="text-xs font-semibold uppercase tracking-wider text-tone-3">
            En Yüksek Konsantrasyon
          </span>
          <div className="mt-2 font-mono text-2xl font-bold tracking-tight text-amber-400">
            %{stats.maxRatioPct}
          </div>
          <p className="mt-1 text-[11px] text-tone-3">
            Tek cariye ait en yüksek portföy payı
          </p>
        </div>

        <div className="rounded-xl border border-line bg-surface-1 p-4 shadow-sm">
          <span className="text-xs font-semibold uppercase tracking-wider text-tone-3">
            Yüksek Yoğunlaşma (&gt;%20)
          </span>
          <div className="mt-2 font-mono text-2xl font-bold tracking-tight text-tone-1">
            {stats.highConcCount} cari
          </div>
          <p className="mt-1 text-[11px] text-tone-3">
            Çeşitlendirme gerektiren portföy
          </p>
        </div>
      </div>

      {/* Filter and Search Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-surface-1 p-3">
        <div className="flex items-center gap-1.5 overflow-x-auto">
          <button
            type="button"
            onClick={() => setFilterMode("all")}
            className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
              filterMode === "all"
                ? "bg-accent text-white shadow-sm"
                : "text-tone-3 hover:text-tone-1 hover:bg-surface-2"
            }`}
          >
            Tümü ({items.length})
          </button>
          <button
            type="button"
            onClick={() => setFilterMode("over_limit")}
            className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
              filterMode === "over_limit"
                ? "bg-red-600 text-white shadow-sm"
                : "text-tone-3 hover:text-tone-1 hover:bg-surface-2"
            }`}
          >
            Limit Aşımı ({items.filter((i) => i.overCreditLimit).length})
          </button>
          <button
            type="button"
            onClick={() => setFilterMode("high_concentration")}
            className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
              filterMode === "high_concentration"
                ? "bg-amber-600 text-white shadow-sm"
                : "text-tone-3 hover:text-tone-1 hover:bg-surface-2"
            }`}
          >
            Yoğunlaşma &gt;%20 ({stats.highConcCount})
          </button>
          <button
            type="button"
            onClick={() => setFilterMode("checks")}
            className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${
              filterMode === "checks"
                ? "bg-accent text-white shadow-sm"
                : "text-tone-3 hover:text-tone-1 hover:bg-surface-2"
            }`}
          >
            Çek Taşıyanlar ({items.filter((i) => i.checkCount > 0).length})
          </button>
        </div>

        <div className="w-full sm:w-64">
          <input
            type="text"
            placeholder="Cari adı ile ara..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full rounded-lg border border-line bg-surface-2 px-3 py-1.5 text-xs text-tone-1 placeholder-tone-4 focus:border-accent focus:outline-none"
          />
        </div>
      </div>

      {/* Counterparty Risk Table */}
      <div className="rounded-xl border border-line bg-surface-1 overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-line bg-surface-2/60 text-left font-semibold text-tone-3 uppercase tracking-wider">
                <th className="py-2.5 px-3">Cari / Karşı Taraf</th>
                <th className="py-2.5 px-3">Skor</th>
                <th className="py-2.5 px-3 text-right">Açık Risk</th>
                <th className="py-2.5 px-3 text-right">Portföy Payı</th>
                <th className="py-2.5 px-3 text-right">Kredi Limiti</th>
                <th className="py-2.5 px-3">En Erken Vade</th>
                <th className="py-2.5 px-3">Tavsiye & Aksiyon</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line-faint">
              {filteredItems.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-6 text-center text-tone-3">
                    Arama kriterine uygun cari bulunamadı.
                  </td>
                </tr>
              ) : (
                filteredItems.map((item) => (
                  <tr key={item.partyId} className="hover:bg-surface-2/40 transition-colors">
                    <td className="py-2.5 px-3 font-medium text-tone-1">
                      <div className="flex items-center gap-2">
                        <span>{item.partyName}</span>
                        {item.unknownAmountCount > 0 && (
                          <span className="text-[10px] text-amber-400 font-mono">
                            ⚠ {item.unknownAmountCount} eksik tutar
                          </span>
                        )}
                        {item.foreignCurrencyCount > 0 && (
                          <span className="text-[10px] text-tone-4 font-mono">
                            ({item.foreignCurrencyCount} dövizli)
                          </span>
                        )}
                      </div>
                      <div className="text-[10px] text-tone-4">
                        {item.partyType} · {item.checkCount} çek, {item.paymentCount} ödeme
                      </div>
                    </td>

                    <td className="py-2.5 px-3">
                      <span
                        className={`inline-flex items-center justify-center h-6 w-6 rounded-full font-mono font-bold text-xs ${
                          item.score === "D"
                            ? "bg-red-500/20 text-red-400 border border-red-500/30"
                            : item.score === "C"
                            ? "bg-amber-500/20 text-amber-400 border border-amber-500/30"
                            : item.score === "B"
                            ? "bg-blue-500/20 text-blue-400 border border-blue-500/30"
                            : "bg-emerald-500/20 text-emerald-400 border border-emerald-500/30"
                        }`}
                      >
                        {item.score}
                      </span>
                    </td>

                    <td className="py-2.5 px-3 text-right font-mono font-semibold text-tone-1">
                      {fmtTL(item.totalExposure)}
                    </td>

                    <td className="py-2.5 px-3 text-right font-mono">
                      {item.exposureRatio != null ? (
                        <span
                          className={
                            (item.exposureRatio ?? 0) > 0.25
                              ? "font-bold text-amber-400"
                              : "text-tone-2"
                          }
                        >
                          %{(item.exposureRatio * 100).toFixed(1)}
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>

                    <td className="py-2.5 px-3 text-right font-mono text-tone-3">
                      {item.creditLimit != null && item.creditLimitComparable ? (
                        <span className={item.overCreditLimit ? "text-red-400 font-bold" : "text-tone-2"}>
                          {fmtTL(item.creditLimit)}
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>

                    <td className="py-2.5 px-3 font-mono text-tone-3">
                      {item.earliestDueDate ?? "Yok"}
                    </td>

                    <td className="py-2.5 px-3">
                      <Badge tone={item.scoreTone}>{item.recommendation}</Badge>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
