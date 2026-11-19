"use client";

import { useEffect, useRef, useState } from "react";
import { Coins } from "lucide-react";
import type { ChartModel } from "@/lib/analytics/chart";
import { AnalyticsChart } from "./analytics-chart";

export type PaymentChartCurrency = "CONSOLIDATED" | "TRY" | "USD" | "EUR";

const CURRENCY_OPTIONS: Array<{ value: PaymentChartCurrency; label: string }> = [
  { value: "CONSOLIDATED", label: "Konsolide ₺" },
  { value: "TRY", label: "TRY" },
  { value: "USD", label: "USD" },
  { value: "EUR", label: "EUR" },
];

export function PaymentsChartLazy({
  initialCurrency = "CONSOLIDATED",
}: {
  initialCurrency?: PaymentChartCurrency;
} = {}) {
  const [currency, setCurrency] = useState<PaymentChartCurrency>(initialCurrency);
  const [model, setModel] = useState<ChartModel | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [shouldLoad, setShouldLoad] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = rootRef.current;
    if (!element) return;
    if (!("IntersectionObserver" in window)) {
      setShouldLoad(true);
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
        setShouldLoad(true);
        observer.disconnect();
      },
      { rootMargin: "120px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!shouldLoad) return;
    const controller = new AbortController();
    setLoading(true);
    setFailed(false);

    const queryParam = currency === "CONSOLIDATED" ? "consolidated" : currency;
    fetch(`/api/payments/dashboard-chart?currency=${encodeURIComponent(queryParam)}`, {
      signal: controller.signal,
      credentials: "same-origin",
    })
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json() as Promise<ChartModel>;
      })
      .then((nextModel) => {
        setModel({
          ...nextModel,
          currencyCode: currency === "CONSOLIDATED" ? "CONSOLIDATED" : currency,
        });
        setLoading(false);
      })
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setLoading(false);
        setFailed(true);
      });
    return () => controller.abort();
  }, [shouldLoad, currency]);

  return (
    <div ref={rootRef} className="space-y-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div
          className="inline-flex items-center gap-1 rounded-[var(--radius-md)] border p-0.5"
          style={{ background: "var(--surface-2)", borderColor: "var(--line)" }}
          role="group"
          aria-label="Ödeme grafiği para birimi"
        >
          <span className="inline-flex items-center gap-1 px-2 text-[11px] font-semibold" style={{ color: "var(--text-3)" }}>
            <Coins size={13} strokeWidth={1.75} aria-hidden />
            <span>Para Birimi</span>
          </span>
          {CURRENCY_OPTIONS.map((opt) => {
            const active = currency === opt.value;
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => setCurrency(opt.value)}
                aria-pressed={active}
                className="rounded-[5px] px-2.5 py-1 text-[11.5px] font-semibold transition-colors"
                style={
                  active
                    ? {
                        background: "var(--surface-1)",
                        color: "var(--info)",
                        boxShadow: "var(--shadow-card)",
                      }
                    : { color: "var(--text-2)" }
                }
              >
                {opt.label}
              </button>
            );
          })}
        </div>
        {loading && model && (
          <span className="text-[11.5px] font-medium" style={{ color: "var(--text-3)" }}>
            Kur güncelleniyor…
          </span>
        )}
      </div>

      {failed ? (
        <div
          className="border p-4 text-[13px]"
          style={{
            borderColor: "color-mix(in srgb, var(--warn) 38%, var(--line))",
            background: "color-mix(in srgb, var(--warn) 6%, var(--surface-1))",
            borderRadius: "var(--radius-md)",
            color: "var(--warn)",
          }}
        >
          Ödeme grafiği yüklenemedi. Sayfayı yenileyerek tekrar deneyin.
        </div>
      ) : !model ? (
        <div
          className="h-72 animate-pulse border"
          style={{
            borderColor: "var(--line-faint)",
            background: "var(--surface-2)",
            borderRadius: "var(--radius-md)",
          }}
          aria-label="Ödeme grafiği yükleniyor"
        />
      ) : (
        <AnalyticsChart model={model} kind="bar" defaultPeriod="3m" />
      )}
    </div>
  );
}
