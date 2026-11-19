"use client";

import { useState } from "react";
import { ArrowUpRight, BarChart3, Coins, TrendingUp } from "lucide-react";
import Link from "@/components/ui/app-link";
import { AnalyticsChart } from "@/components/charts/analytics-chart";
import type {
  OverviewChartCurrency,
  OverviewCurrencyChartBundle,
} from "@/lib/home/overview-snapshot";

interface OverviewCashChartProps {
  chartsByCurrency: Record<OverviewChartCurrency, OverviewCurrencyChartBundle>;
  fxRateSummary: string | null;
}

const CURRENCY_TABS: Array<{ key: OverviewChartCurrency; label: string; short: string }> = [
  { key: "CONSOLIDATED", label: "Konsolide ₺", short: "TCMB" },
  { key: "TRY", label: "TRY ₺", short: "TL" },
  { key: "USD", label: "USD $", short: "USD" },
  { key: "EUR", label: "EUR €", short: "EUR" },
];

export function OverviewCashChart({ chartsByCurrency, fxRateSummary }: OverviewCashChartProps) {
  const [currency, setCurrency] = useState<OverviewChartCurrency>("CONSOLIDATED");
  const [lens, setLens] = useState<"pressure" | "balance">("pressure");

  const bundle = chartsByCurrency[currency] ?? chartsByCurrency.CONSOLIDATED;
  const activeModel = lens === "pressure" ? bundle.pressureChart : bundle.balanceChart;

  return (
    <div
      className="border"
      style={{
        borderColor: "var(--line)",
        borderRadius: "var(--radius-lg)",
        background: "var(--surface-1)",
        boxShadow: "var(--shadow-card)",
      }}
    >
      <div
        className="flex flex-wrap items-center justify-between gap-2.5 border-b px-4 py-3"
        style={{ borderColor: "var(--line-faint)", background: "var(--surface-2)" }}
      >
        <div className="flex flex-wrap items-center gap-1.5" role="tablist" aria-label="Grafik görünümü">
          <button
            type="button"
            role="tab"
            aria-selected={lens === "pressure"}
            onClick={() => setLens("pressure")}
            className="inline-flex items-center gap-1.5 rounded-[7px] border px-2.5 py-1.5 text-[12px] font-semibold transition-[background-color,color,border-color] duration-75"
            style={{
              borderColor: lens === "pressure" ? "var(--line-strong)" : "transparent",
              background: lens === "pressure" ? "var(--surface-1)" : "transparent",
              color: lens === "pressure" ? "var(--text-1)" : "var(--text-3)",
              boxShadow: lens === "pressure" ? "0 1px 2px rgba(20,18,16,0.05)" : "none",
            }}
          >
            <BarChart3 size={14} strokeWidth={1.75} />
            Ödeme & Vade Baskısı
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={lens === "balance"}
            onClick={() => setLens("balance")}
            className="inline-flex items-center gap-1.5 rounded-[7px] border px-2.5 py-1.5 text-[12px] font-semibold transition-[background-color,color,border-color] duration-75"
            style={{
              borderColor: lens === "balance" ? "var(--line-strong)" : "transparent",
              background: lens === "balance" ? "var(--surface-1)" : "transparent",
              color: lens === "balance" ? "var(--text-1)" : "var(--text-3)",
              boxShadow: lens === "balance" ? "0 1px 2px rgba(20,18,16,0.05)" : "none",
            }}
          >
            <TrendingUp size={14} strokeWidth={1.75} />
            13H Kümülatif Kasa Ufku
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {currency === "CONSOLIDATED" && fxRateSummary && (
            <span
              className="hidden items-center gap-1 rounded-[6px] border px-2 py-1 font-mono text-[11px] tabular-nums sm:inline-flex"
              style={{
                borderColor: "var(--line)",
                background: "var(--surface-1)",
                color: "var(--text-3)",
              }}
              title="TCMB döviz kurlarıyla TL konsolidasyonu"
            >
              <Coins size={12} strokeWidth={1.75} />
              TCMB: {fxRateSummary}
            </span>
          )}

          <div
            className="inline-flex items-center rounded-[8px] border p-0.5"
            style={{ borderColor: "var(--line)", background: "var(--surface-1)" }}
            role="group"
            aria-label="Para birimi seçimi"
          >
            {CURRENCY_TABS.map((tab) => {
              const active = currency === tab.key;
              return (
                <button
                  key={tab.key}
                  type="button"
                  onClick={() => setCurrency(tab.key)}
                  aria-pressed={active}
                  className="rounded-[6px] px-2.5 py-1 text-[11.5px] font-semibold transition-[background-color,color] duration-75"
                  style={{
                    background: active ? "var(--accent)" : "transparent",
                    color: active ? "#FFFFFF" : "var(--text-2)",
                  }}
                >
                  {tab.label}
                </button>
              );
            })}
          </div>

          <Link
            href={lens === "pressure" ? "/payments" : "/cashflow"}
            className="inline-flex items-center gap-1 rounded-[7px] border px-2.5 py-1 text-[11.5px] font-medium transition-colors duration-75 hover:bg-[var(--surface-1)]"
            style={{ borderColor: "var(--line)", color: "var(--text-2)" }}
          >
            Detay
            <ArrowUpRight size={13} strokeWidth={1.75} />
          </Link>
        </div>
      </div>

      <div className="p-3.5 sm:p-4">
        <AnalyticsChart
          key={`${lens}-${currency}`}
          model={activeModel}
          kind={lens === "pressure" ? "bar" : "line"}
          defaultPeriod="3m"
          height={292}
        />
      </div>
    </div>
  );
}
