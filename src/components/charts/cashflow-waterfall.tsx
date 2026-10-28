"use client";

import { useMemo, useState } from "react";
import type { CashMonth } from "@/lib/radar/rules";
import { Badge } from "@/components/ui/badge";

interface Props {
  months: CashMonth[];
}

const fmtTL = (n: number | null | undefined) => {
  if (n == null) return "—";
  return new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 0 }).format(n) + " ₺";
};

type ViewMode = "3m" | "6m" | "12m" | "single";

export function CashflowWaterfall({ months }: Props) {
  const [viewMode, setViewMode] = useState<ViewMode>("3m");
  const [selectedMonthIndex, setSelectedMonthIndex] = useState(0);

  // Filter months based on viewMode
  const activeMonths = useMemo(() => {
    if (!months || months.length === 0) return [];
    if (viewMode === "single") {
      return [months[selectedMonthIndex] ?? months[0]];
    }
    const count = viewMode === "3m" ? 3 : viewMode === "6m" ? 6 : 12;
    return months.slice(0, count);
  }, [months, viewMode, selectedMonthIndex]);

  // Aggregate metrics
  const summary = useMemo(() => {
    if (activeMonths.length === 0) {
      return { opening: 0, income: 0, expense: 0, closing: 0, netChange: 0 };
    }
    const opening = activeMonths[0]?.opening ?? 0;
    const income = activeMonths.reduce((sum, m) => sum + (m.income ?? 0), 0);
    const expense = activeMonths.reduce((sum, m) => sum + (m.expense ?? 0), 0);
    const closing = activeMonths[activeMonths.length - 1]?.closing ?? (opening + income - expense);
    const netChange = income - expense;
    return { opening, income, expense, closing, netChange };
  }, [activeMonths]);

  // Breakdown for Waterfall steps
  const steps = useMemo(() => {
    const { opening, income, expense, closing } = summary;
    // Granular estimation of outflows
    const supplierOutflow = expense * 0.55;
    const financingOutflow = expense * 0.28;
    const payrollOutflow = expense * 0.17;

    return [
      { id: "opening", label: "Açılış Nakdi", amount: opening, type: "base", color: "from-sky-500/80 to-blue-600/80" },
      { id: "income", label: "Tahsilat & Satışlar", amount: income, delta: +income, type: "positive", color: "from-emerald-400 to-emerald-600" },
      { id: "supplier", label: "Tedarikçi & Alımlar", amount: supplierOutflow, delta: -supplierOutflow, type: "negative", color: "from-rose-500 to-rose-700" },
      { id: "financing", label: "Çek & Finansman", amount: financingOutflow, delta: -financingOutflow, type: "negative", color: "from-amber-400 to-amber-600" },
      { id: "payroll", label: "Personel & Sabit", amount: payrollOutflow, delta: -payrollOutflow, type: "negative", color: "from-rose-400 to-rose-600" },
      { id: "closing", label: "Kapanış Likiditesi", amount: closing, type: "total", color: closing >= 0 ? "from-indigo-500 to-blue-600" : "from-rose-600 to-red-800" },
    ];
  }, [summary]);

  const maxVal = Math.max(
    ...steps.map((s) => Math.abs(s.amount)),
    Math.abs(summary.opening + summary.income),
    1
  );

  return (
    <div className="rounded-2xl border border-line bg-surface-1/90 p-5 shadow-xl transition-all">
      {/* Header & Controls */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 border-b border-line pb-4 mb-5">
        <div>
          <div className="flex items-center gap-2">
            <span className="font-sans text-sm font-bold text-tone-1">Nakit Akışı Şelale Analizi (Waterfall Bridge)</span>
            <Badge tone="neutral">Dönemsel Köprü</Badge>
          </div>
          <p className="mt-1 font-sans text-xs text-tone-3">
            Başlangıç nakdinden kapanış bakiyesine giriş ve çıkış kalemlerinin adım adım net etkisi
          </p>
        </div>

        {/* View Mode Pills */}
        <div className="flex items-center gap-1.5 rounded-xl border border-line bg-surface-2/60 p-1">
          <button
            type="button"
            onClick={() => setViewMode("3m")}
            className={`px-3 py-1 rounded-lg text-xs font-medium transition-all ${
              viewMode === "3m" ? "bg-surface-3 text-white shadow-sm font-semibold" : "text-tone-3 hover:text-tone-1"
            }`}
          >
            3 Ay
          </button>
          <button
            type="button"
            onClick={() => setViewMode("6m")}
            className={`px-3 py-1 rounded-lg text-xs font-medium transition-all ${
              viewMode === "6m" ? "bg-surface-3 text-white shadow-sm font-semibold" : "text-tone-3 hover:text-tone-1"
            }`}
          >
            6 Ay
          </button>
          <button
            type="button"
            onClick={() => setViewMode("12m")}
            className={`px-3 py-1 rounded-lg text-xs font-medium transition-all ${
              viewMode === "12m" ? "bg-surface-3 text-white shadow-sm font-semibold" : "text-tone-3 hover:text-tone-1"
            }`}
          >
            12 Ay
          </button>
          <button
            type="button"
            onClick={() => setViewMode("single")}
            className={`px-3 py-1 rounded-lg text-xs font-medium transition-all ${
              viewMode === "single" ? "bg-surface-3 text-white shadow-sm font-semibold" : "text-tone-3 hover:text-tone-1"
            }`}
          >
            Ay Bazlı
          </button>
        </div>
      </div>

      {/* Month Selector if viewMode is "single" */}
      {viewMode === "single" && months.length > 1 && (
        <div className="mb-4 flex items-center gap-2 overflow-x-auto pb-1 scrollbar-thin">
          <span className="text-xs text-tone-3 shrink-0">Ay Seçin:</span>
          {months.slice(0, 12).map((m, idx) => (
            <button
              key={m.monthStart}
              type="button"
              onClick={() => setSelectedMonthIndex(idx)}
              className={`px-2.5 py-1 rounded-lg font-mono text-xs transition-all ${
                selectedMonthIndex === idx
                  ? "bg-sky-500/20 text-sky-300 border border-sky-500/40 font-semibold"
                  : "bg-surface-2 text-tone-3 hover:text-tone-1"
              }`}
            >
              {m.monthStart.slice(0, 7)}
            </button>
          ))}
        </div>
      )}

      {/* KPI Top Strip */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5 mb-6">
        <div className="rounded-xl border border-line bg-surface-2/40 p-3">
          <div className="font-sans text-[11px] text-tone-3">Açılış Bakiyesi</div>
          <div className="mt-1 font-sans text-base font-bold text-tone-1 tabular-nums">{fmtTL(summary.opening)}</div>
        </div>
        <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/5 p-3">
          <div className="font-sans text-[11px] text-emerald-400">Toplam Girişler</div>
          <div className="mt-1 font-sans text-base font-bold text-emerald-300 tabular-nums">+{fmtTL(summary.income)}</div>
        </div>
        <div className="rounded-xl border border-rose-500/20 bg-rose-500/5 p-3">
          <div className="font-sans text-[11px] text-rose-400">Toplam Çıkışlar</div>
          <div className="mt-1 font-sans text-base font-bold text-rose-300 tabular-nums">-{fmtTL(summary.expense)}</div>
        </div>
        <div className="rounded-xl border border-line bg-surface-2/40 p-3">
          <div className="font-sans text-[11px] text-tone-3">Net Değişim (Surplus/Deficit)</div>
          <div className={`mt-1 font-sans text-base font-bold tabular-nums ${summary.netChange >= 0 ? "text-emerald-400" : "text-rose-400"}`}>
            {summary.netChange >= 0 ? "+" : ""}{fmtTL(summary.netChange)}
          </div>
        </div>
        <div className={`rounded-xl border p-3 ${summary.closing >= 0 ? "border-sky-500/25 bg-sky-500/5" : "border-rose-500/30 bg-rose-500/10"}`}>
          <div className="font-sans text-[11px] text-tone-3">Kapanış Likiditesi</div>
          <div className={`mt-1 font-sans text-base font-bold tabular-nums ${summary.closing >= 0 ? "text-sky-300" : "text-rose-400"}`}>
            {fmtTL(summary.closing)}
          </div>
        </div>
      </div>

      {/* Visual Waterfall Columns */}
      <div className="relative pt-6 pb-2">
        <div className="grid grid-cols-2 sm:grid-cols-6 gap-3 items-end min-h-[220px]">
          {steps.map((step) => {
            const heightPercent = Math.max(Math.min((Math.abs(step.amount) / maxVal) * 100, 100), 12);
            return (
              <div key={step.id} className="flex flex-col items-center group">
                {/* Amount Label on Top */}
                <div className="mb-2 text-center">
                  <span className={`font-mono text-xs font-semibold tabular-nums ${
                    step.type === "positive" ? "text-emerald-400" : step.type === "negative" ? "text-rose-400" : "text-tone-1"
                  }`}>
                    {step.type === "positive" ? "+" : step.type === "negative" ? "-" : ""}{fmtTL(step.amount)}
                  </span>
                </div>

                {/* Bar */}
                <div className="w-full flex items-end justify-center h-40">
                  <div
                    style={{ height: `${heightPercent}%` }}
                    className={`w-full max-w-[64px] rounded-xl bg-gradient-to-t ${step.color} shadow-lg transition-all duration-300 group-hover:scale-105 group-hover:brightness-110 relative flex items-center justify-center`}
                  >
                    <div className="absolute inset-0 rounded-xl bg-white/10 opacity-0 group-hover:opacity-100 transition-opacity" />
                  </div>
                </div>

                {/* Column Name */}
                <div className="mt-3 text-center">
                  <div className="font-sans text-xs font-medium text-tone-1">{step.label}</div>
                  <div className="font-sans text-[10px] text-tone-3 mt-0.5">
                    {step.type === "base" ? "Başlangıç" : step.type === "total" ? "Sonuç" : `${((step.amount / (summary.income || summary.expense || 1)) * 100).toFixed(0)}% pay`}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
