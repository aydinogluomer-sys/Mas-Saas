"use client";

import { useEffect, useRef, useState } from "react";
import type { ChartModel } from "@/lib/analytics/chart";
import { AnalyticsChart } from "./analytics-chart";

export function PaymentsChartLazy() {
  const [model, setModel] = useState<ChartModel | null>(null);
  const [failed, setFailed] = useState(false);
  const [shouldLoad, setShouldLoad] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const element = rootRef.current;
    if (!element) return;
    if (!("IntersectionObserver" in window)) { setShouldLoad(true); return; }
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting) return;
      setShouldLoad(true);
      observer.disconnect();
    }, { rootMargin: "100px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!shouldLoad) return;
    const controller = new AbortController();
    fetch("/api/payments/dashboard-chart", { signal: controller.signal, credentials: "same-origin" })
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json() as Promise<ChartModel>;
      })
      .then(setModel)
      .catch((error: unknown) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setFailed(true);
      });
    return () => controller.abort();
  }, [shouldLoad]);

  if (failed) return <div ref={rootRef} className="border border-warn p-4 text-sm text-warn">Ödeme grafiği yüklenemedi. Sayfayı yenileyerek tekrar deneyin.</div>;
  if (!model) return <div ref={rootRef} className="h-72 animate-pulse border border-line-faint bg-surface-2" aria-label="Ödeme grafiği yükleniyor" />;
  return <div ref={rootRef}><AnalyticsChart model={model} kind="bar" defaultPeriod="3m" /></div>;
}
