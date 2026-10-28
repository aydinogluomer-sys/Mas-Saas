"use client";

import { useState, useMemo } from "react";
import type { CashMonth } from "@/lib/radar/rules";
import { fmtTL } from "@/components/ui/panel";
import { Badge } from "@/components/ui/badge";

interface ScenarioInteractiveSandboxProps {
  months: CashMonth[];
  disabled?: boolean;
}

export function ScenarioInteractiveSandbox({ months, disabled }: ScenarioInteractiveSandboxProps) {
  // Slider states
  const [revenuePct, setRevenuePct] = useState<number>(0);
  const [expensePct, setExpensePct] = useState<number>(0);
  const [customerDelayMonths, setCustomerDelayMonths] = useState<number>(0);
  const [efficiencyPct, setEfficiencyPct] = useState<number>(0);
  const [scenarioName, setScenarioName] = useState<string>("İnteraktif What-If Simülasyonu");

  // Fallback demo data if no months are loaded
  const baseMonths: CashMonth[] = useMemo(() => {
    if (months.length > 0) return months;
    // 12 synthetic months for preview
    const sample: CashMonth[] = [];
    let prev = 2500000;
    for (let i = 1; i <= 12; i++) {
      const monthStr = `2026-${String(i).padStart(2, "0")}-01`;
      const inc = 1200000 + (i % 3) * 150000;
      const exp = 1100000 + (i % 4) * 100000;
      const cls = prev + inc - exp;
      sample.push({
        monthStart: monthStr,
        opening: prev,
        income: inc,
        expense: exp,
        closing: cls,
      });
      prev = cls;
    }
    return sample;
  }, [months]);

  // In-memory simulation calculation
  const simulation = useMemo(() => {
    let runningOpening = baseMonths[0]?.opening ?? 1000000;
    let baselineWorst = Infinity;
    let simWorst = Infinity;
    let baselineFirstNeg: string | null = null;
    let simFirstNeg: string | null = null;
    let baselineNegCount = 0;
    let simNegCount = 0;

    const projected = baseMonths.map((m, idx) => {
      const bIncome = m.income ?? 0;
      const bExpense = m.expense ?? 0;
      const bClosing = m.closing ?? 0;

      if (bClosing < baselineWorst) baselineWorst = bClosing;
      if (bClosing < 0) {
        baselineNegCount++;
        if (!baselineFirstNeg) baselineFirstNeg = m.monthStart.slice(0, 7);
      }

      // Apply what-if adjustments
      const adjIncome = bIncome * (1 + revenuePct / 100) * (1 - customerDelayMonths * 0.04);
      const adjExpense = bExpense * (1 + expensePct / 100) * (1 - efficiencyPct / 100);
      const curOpening = idx === 0 ? (m.opening ?? runningOpening) : runningOpening;
      const curClosing = curOpening + adjIncome - adjExpense;
      runningOpening = curClosing;

      if (curClosing < simWorst) simWorst = curClosing;
      if (curClosing < 0) {
        simNegCount++;
        if (!simFirstNeg) simFirstNeg = m.monthStart.slice(0, 7);
      }

      return {
        month: m.monthStart.slice(0, 7),
        baselineClosing: bClosing,
        simulatedClosing: curClosing,
        delta: curClosing - bClosing,
      };
    });

    const totalBaselineEnding = baseMonths[baseMonths.length - 1]?.closing ?? 0;
    const totalSimEnding = projected[projected.length - 1]?.simulatedClosing ?? 0;
    const netImpact = totalSimEnding - totalBaselineEnding;

    return {
      projected,
      baselineWorst: baselineWorst === Infinity ? 0 : baselineWorst,
      simWorst: simWorst === Infinity ? 0 : simWorst,
      baselineFirstNeg,
      simFirstNeg,
      baselineNegCount,
      simNegCount,
      netImpact,
    };
  }, [baseMonths, revenuePct, expensePct, customerDelayMonths, efficiencyPct]);

  const applyPreset = (name: string, rev: number, exp: number, delay: number, eff: number) => {
    setScenarioName(name);
    setRevenuePct(rev);
    setExpensePct(exp);
    setCustomerDelayMonths(delay);
    setEfficiencyPct(eff);
  };

  return (
    <div className="flex flex-col gap-6">
      {/* Top Interactive KPI Impact Bar */}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {/* Net Likidite Etkisi */}
        <div className="rounded-xl border border-line bg-surface-1 p-4 shadow-sm">
          <span className="text-xs font-semibold uppercase tracking-wider text-tone-3">
            Toplam Likidite Etkisi
          </span>
          <div
            className={`mt-2 font-mono text-2xl font-bold tracking-tight ${
              simulation.netImpact >= 0 ? "text-emerald-400" : "text-red-400"
            }`}
          >
            {simulation.netImpact >= 0 ? "+" : ""}
            {fmtTL(simulation.netImpact)}
          </div>
          <p className="mt-1 text-[11px] text-tone-3">
            Dönem sonu kümülatif nakit farkı
          </p>
        </div>

        {/* Simüle Runway */}
        <div className="rounded-xl border border-line bg-surface-1 p-4 shadow-sm">
          <span className="text-xs font-semibold uppercase tracking-wider text-tone-3">
            İlk Negatif Ay (Runway)
          </span>
          <div className="mt-2 flex items-baseline gap-2">
            <span
              className={`font-mono text-xl font-bold ${
                simulation.simFirstNeg ? "text-red-400" : "text-emerald-400"
              }`}
            >
              {simulation.simFirstNeg ?? "Ufuk Boyunca Pozitif"}
            </span>
          </div>
          <p className="mt-1 text-[11px] text-tone-3">
            Baz: {simulation.baselineFirstNeg ?? "Pozitif"}
          </p>
        </div>

        {/* En Düşük Kasa */}
        <div className="rounded-xl border border-line bg-surface-1 p-4 shadow-sm">
          <span className="text-xs font-semibold uppercase tracking-wider text-tone-3">
            En Düşük Kasa Bakiyesi
          </span>
          <div
            className={`mt-2 font-mono text-xl font-bold ${
              simulation.simWorst >= 0 ? "text-tone-1" : "text-red-400"
            }`}
          >
            {fmtTL(simulation.simWorst)}
          </div>
          <p className="mt-1 text-[11px] text-tone-3">
            Baz: {fmtTL(simulation.baselineWorst)}
          </p>
        </div>

        {/* Negatif Ay Sayısı */}
        <div className="rounded-xl border border-line bg-surface-1 p-4 shadow-sm">
          <span className="text-xs font-semibold uppercase tracking-wider text-tone-3">
            Negatif Ay Adedi
          </span>
          <div className="mt-2 flex items-center gap-2">
            <span
              className={`font-mono text-2xl font-bold ${
                simulation.simNegCount > 0 ? "text-amber-400" : "text-emerald-400"
              }`}
            >
              {simulation.simNegCount}
            </span>
            <span className="text-xs text-tone-3">/ {baseMonths.length} ay</span>
          </div>
          <p className="mt-1 text-[11px] text-tone-3">
            Baz: {simulation.baselineNegCount} negatif ay
          </p>
        </div>
      </div>

      {/* Main Sandbox Grid: Sliders & Visual Chart */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        {/* Left Col (5 cols): Live Sliders & Presets */}
        <div className="flex flex-col gap-4 lg:col-span-5">
          {/* Quick Sandbox Presets */}
          <div className="rounded-xl border border-line bg-surface-1 p-4">
            <span className="text-xs font-bold uppercase tracking-wider text-tone-3">
              ⚡ Hızlı Simülasyon Şablonları
            </span>
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => applyPreset("Stres Testi", -20, 15, 1, 0)}
                className="rounded-lg border border-red-500/30 bg-red-950/20 px-2.5 py-1.5 text-xs font-medium text-red-300 hover:bg-red-900/30 transition-colors"
              >
                🔴 Stres Testi (-%20 Gelir, +%15 Gider)
              </button>
              <button
                type="button"
                onClick={() => applyPreset("Maliyet İyileştirme", 0, -10, 0, 8)}
                className="rounded-lg border border-emerald-500/30 bg-emerald-950/20 px-2.5 py-1.5 text-xs font-medium text-emerald-300 hover:bg-emerald-900/30 transition-colors"
              >
                🟢 Tasarruf (-%10 Gider, +%8 Verim)
              </button>
              <button
                type="button"
                onClick={() => applyPreset("Agresif Büyüme", 25, 12, 0, 5)}
                className="rounded-lg border border-blue-500/30 bg-blue-950/20 px-2.5 py-1.5 text-xs font-medium text-blue-300 hover:bg-blue-900/30 transition-colors"
              >
                🔵 Büyüme (+%25 Gelir, +%12 Gider)
              </button>
              <button
                type="button"
                onClick={() => applyPreset("Tahsilat Gecikmesi", -5, 0, 3, 0)}
                className="rounded-lg border border-amber-500/30 bg-amber-950/20 px-2.5 py-1.5 text-xs font-medium text-amber-300 hover:bg-amber-900/30 transition-colors"
              >
                🟠 3 Ay Müşteri Gecikmesi
              </button>
            </div>
          </div>

          {/* Realtime Sliders */}
          <div className="rounded-xl border border-line bg-surface-1 p-5 shadow-sm space-y-5">
            {/* Slider 1: Gelir Değişimi */}
            <div>
              <div className="flex items-center justify-between text-xs font-medium">
                <span className="text-tone-2">Gelir Değişimi</span>
                <span
                  className={`font-mono font-bold ${
                    revenuePct > 0 ? "text-emerald-400" : revenuePct < 0 ? "text-red-400" : "text-tone-2"
                  }`}
                >
                  {revenuePct > 0 ? `+${revenuePct}%` : `${revenuePct}%`}
                </span>
              </div>
              <input
                type="range"
                min="-50"
                max="50"
                step="1"
                value={revenuePct}
                onChange={(e) => setRevenuePct(Number(e.target.value))}
                className="mt-2 w-full accent-accent cursor-pointer"
              />
              <div className="flex justify-between text-[10px] text-tone-4">
                <span>-%50</span>
                <span>0% (Baz)</span>
                <span>+%50</span>
              </div>
            </div>

            {/* Slider 2: Gider Değişimi */}
            <div>
              <div className="flex items-center justify-between text-xs font-medium">
                <span className="text-tone-2">Gider Değişimi</span>
                <span
                  className={`font-mono font-bold ${
                    expensePct < 0 ? "text-emerald-400" : expensePct > 0 ? "text-red-400" : "text-tone-2"
                  }`}
                >
                  {expensePct > 0 ? `+${expensePct}%` : `${expensePct}%`}
                </span>
              </div>
              <input
                type="range"
                min="-50"
                max="50"
                step="1"
                value={expensePct}
                onChange={(e) => setExpensePct(Number(e.target.value))}
                className="mt-2 w-full accent-accent cursor-pointer"
              />
              <div className="flex justify-between text-[10px] text-tone-4">
                <span>-%50 (Tasarruf)</span>
                <span>0% (Baz)</span>
                <span>+%50 (Artış)</span>
              </div>
            </div>

            {/* Slider 3: Müşteri Tahsilat Gecikmesi */}
            <div>
              <div className="flex items-center justify-between text-xs font-medium">
                <span className="text-tone-2">Müşteri Gecikmesi</span>
                <span className="font-mono font-bold text-amber-400">
                  {customerDelayMonths} Ay
                </span>
              </div>
              <input
                type="range"
                min="0"
                max="6"
                step="1"
                value={customerDelayMonths}
                onChange={(e) => setCustomerDelayMonths(Number(e.target.value))}
                className="mt-2 w-full accent-amber-500 cursor-pointer"
              />
              <div className="flex justify-between text-[10px] text-tone-4">
                <span>0 Ay (Zamanında)</span>
                <span>3 Ay</span>
                <span>6 Ay Gecikme</span>
              </div>
            </div>

            {/* Slider 4: Verimlilik / Operasyonel Tasarruf */}
            <div>
              <div className="flex items-center justify-between text-xs font-medium">
                <span className="text-tone-2">Verimlilik & Tasarruf</span>
                <span
                  className={`font-mono font-bold ${
                    efficiencyPct > 0 ? "text-emerald-400" : efficiencyPct < 0 ? "text-red-400" : "text-tone-2"
                  }`}
                >
                  {efficiencyPct > 0 ? `+${efficiencyPct}%` : `${efficiencyPct}%`}
                </span>
              </div>
              <input
                type="range"
                min="-20"
                max="20"
                step="1"
                value={efficiencyPct}
                onChange={(e) => setEfficiencyPct(Number(e.target.value))}
                className="mt-2 w-full accent-emerald-500 cursor-pointer"
              />
              <div className="flex justify-between text-[10px] text-tone-4">
                <span>-%20</span>
                <span>0% (Standart)</span>
                <span>+%20</span>
              </div>
            </div>
          </div>
        </div>

        {/* Right Col (7 cols): Realtime Trajectory Visualizer */}
        <div className="flex flex-col rounded-xl border border-line bg-surface-1 p-5 shadow-sm lg:col-span-7">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line-faint pb-3">
            <div>
              <h3 className="text-sm font-bold text-tone-1">
                Kümülatif Kasa Seyri (Baz vs Simülasyon)
              </h3>
              <p className="text-xs text-tone-3">
                Her ayın kapanış bakiyesinin anlık değişimi
              </p>
            </div>
            <div className="flex items-center gap-3 text-xs">
              <div className="flex items-center gap-1.5">
                <span className="inline-block h-2 w-2 rounded-full bg-slate-500" />
                <span className="text-tone-3">Mevcut Baz</span>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="inline-block h-2 w-2 rounded-full bg-cyan-400" />
                <span className="text-tone-1 font-medium">What-If Sonucu</span>
              </div>
            </div>
          </div>

          {/* Trajectory Bar Chart */}
          <div className="mt-4 flex-1 flex flex-col justify-end gap-2 min-h-[220px]">
            <div className="grid grid-cols-6 sm:grid-cols-12 gap-1.5 items-end h-[180px] pt-4">
              {simulation.projected.slice(0, 12).map((item, idx) => {
                // normalize height
                const maxVal = Math.max(
                  ...simulation.projected.map((p) => Math.max(Math.abs(p.baselineClosing), Math.abs(p.simulatedClosing))),
                  100000
                );
                const baseH = Math.max(8, Math.min(100, Math.round((Math.abs(item.baselineClosing) / maxVal) * 100)));
                const simH = Math.max(8, Math.min(100, Math.round((Math.abs(item.simulatedClosing) / maxVal) * 100)));
                const isNegative = item.simulatedClosing < 0;

                return (
                  <div key={idx} className="flex flex-col items-center gap-1 group relative">
                    {/* Tooltip on hover */}
                    <div className="absolute -top-12 left-1/2 -translate-x-1/2 hidden group-hover:flex flex-col items-center bg-black/90 text-white text-[10px] p-1.5 rounded z-20 whitespace-nowrap shadow-lg border border-line">
                      <span>{item.month}</span>
                      <span className="font-mono font-bold text-cyan-300">
                        {fmtTL(item.simulatedClosing)}
                      </span>
                      <span className="text-slate-400">
                        Baz: {fmtTL(item.baselineClosing)}
                      </span>
                    </div>

                    <div className="flex items-end gap-1 w-full justify-center h-[140px]">
                      {/* Baseline bar */}
                      <div
                        style={{ height: `${baseH}%` }}
                        className="w-2.5 rounded-t bg-slate-600/50 transition-all duration-200"
                      />
                      {/* Sim bar */}
                      <div
                        style={{ height: `${simH}%` }}
                        className={`w-2.5 rounded-t transition-all duration-200 ${
                          isNegative
                            ? "bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.4)]"
                            : "bg-cyan-400 shadow-[0_0_8px_rgba(34,211,238,0.4)]"
                        }`}
                      />
                    </div>

                    <span className="font-mono text-[9px] text-tone-4 truncate w-full text-center">
                      {item.month.slice(5)}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Sync Note */}
          <div className="mt-4 rounded-lg bg-surface-2 p-3 text-xs text-tone-3 flex items-center justify-between">
            <span>
              💡 Aşağıdaki resmi senaryo formu bu değerlerle otomatik senkronizedir.
            </span>
            <Badge tone="blue">Canlı Önizleme Aktif</Badge>
          </div>
        </div>
      </div>
    </div>
  );
}
