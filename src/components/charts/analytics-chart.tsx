"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  ArrowUpRight,
  Download,
  FileCode2,
  FileSpreadsheet,
  ImageDown,
  Maximize2,
  Minimize2,
  RotateCcw,
  Scaling,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import Link from "@/components/ui/app-link";
import {
  aggregateChartGranularity,
  chartDomain,
  chartSummary,
  chartToCsv,
  extractOverdueSummary,
  filterChartPeriod,
  formatChartValue,
  type AnalyticsPeriod,
  type ChartGranularity,
  type ChartModel,
  type ChartPoint,
  type ChartScaleMode,
  type ChartSeries,
  type ChartTone,
} from "@/lib/analytics/chart";

const COLORS: Record<ChartTone, string> = {
  positive: "var(--pos)",
  negative: "var(--neg)",
  warning: "var(--warn)",
  info: "var(--info)",
  neutral: "var(--text-3)",
  scenario: "var(--accent)",
};

const FALLBACK_HEX: Record<ChartTone, string> = {
  positive: "#0F6E56",
  negative: "#B42318",
  warning: "#B54708",
  info: "#1D4ED8",
  neutral: "#6E675F",
  scenario: "#1D4ED8",
};

const PERIODS: Array<[AnalyticsPeriod, string]> = [
  ["3m", "3A"],
  ["6m", "6A"],
  ["12m", "12A"],
  ["24m", "24A"],
  ["all", "Tümü"],
];

const GRANULARITIES: Array<[ChartGranularity, string]> = [
  ["day", "Günlük"],
  ["week", "Haftalık"],
  ["month", "Aylık"],
];

function resolveCssVarsInSvg(sourceSvg: SVGSVGElement): string {
  const clone = sourceSvg.cloneNode(true) as SVGSVGElement;
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  const computed = getComputedStyle(document.documentElement);

  const replaceVars = (raw: string | null): string | null => {
    if (!raw || !raw.includes("var(")) return raw;
    return raw.replace(/var\(\s*(--[a-zA-Z0-9-_]+)\s*(?:,\s*([^)]+))?\)/g, (_m, token: string, fb?: string) => {
      const resolved = computed.getPropertyValue(token).trim();
      return resolved || (fb ? fb.trim() : "#141210");
    });
  };

  const elements = [clone, ...Array.from(clone.querySelectorAll<SVGElement>("*"))];
  for (const el of elements) {
    for (const attr of ["fill", "stroke", "stop-color", "color", "style"]) {
      const val = el.getAttribute(attr);
      const next = replaceVars(val);
      if (next && next !== val) el.setAttribute(attr, next);
    }
  }
  clone.style.background = "#FFFFFF";
  return new XMLSerializer().serializeToString(clone);
}

export function AnalyticsChart({
  model,
  kind = "line",
  defaultPeriod = "12m",
  height,
}: {
  model: ChartModel;
  kind?: "line" | "bar";
  defaultPeriod?: AnalyticsPeriod;
  height?: number;
}) {
  const router = useRouter();
  const periodOptions = useMemo(
    () => (model.timeDirection === "categorical" ? PERIODS.filter(([value]) => value === "all") : PERIODS),
    [model.timeDirection],
  );
  const granularityOptions = useMemo<ChartGranularity[]>(
    () => model.availableGranularities ?? ["day", "week", "month"],
    [model.availableGranularities],
  );

  const pickDefaultGranularity = useCallback(
    (targetPeriod: AnalyticsPeriod): ChartGranularity => {
      const preferred = model.defaultGranularityByPeriod?.[targetPeriod];
      if (preferred && granularityOptions.includes(preferred)) return preferred;
      return granularityOptions[0] ?? "day";
    },
    [granularityOptions, model.defaultGranularityByPeriod],
  );

  const initialPeriod: AnalyticsPeriod = model.timeDirection === "categorical" ? "all" : defaultPeriod;
  const [period, setPeriod] = useState<AnalyticsPeriod>(initialPeriod);
  const [granularity, setGranularity] = useState<ChartGranularity>(() => pickDefaultGranularity(initialPeriod));
  const [userPinnedGranularity, setUserPinnedGranularity] = useState(false);
  const [scaleMode, setScaleMode] = useState<ChartScaleMode>("window");
  const [includeOverdueInAxis, setIncludeOverdueInAxis] = useState(false);
  const [hidden, setHidden] = useState<string[]>([]);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState(0);
  const [focus, setFocus] = useState(false);
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const [pointerX, setPointerX] = useState<number>(0);
  const [containerWidth, setContainerWidth] = useState<number>(880);

  const hydrated = useRef(false);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);

  // Sync URL query params on mount and browser back/forward (popstate)
  const syncFromUrl = useCallback(() => {
    if (typeof window === "undefined") return;
    const params = new URL(window.location.href).searchParams;
    const requestedPeriod = params.get("chartPeriod") as AnalyticsPeriod | null;
    const requestedGranularity = params.get("chartGranularity") as ChartGranularity | null;
    const requestedScale = params.get("chartScale") as ChartScaleMode | null;

    if (requestedPeriod && periodOptions.some(([value]) => value === requestedPeriod)) {
      setPeriod(requestedPeriod);
    }
    if (requestedGranularity && granularityOptions.includes(requestedGranularity)) {
      setGranularity(requestedGranularity);
      setUserPinnedGranularity(true);
    }
    if (requestedScale === "window" || requestedScale === "global") {
      setScaleMode(requestedScale);
    }
    const requestedHidden = params.get("chartHidden")?.split(",").filter(Boolean) ?? [];
    if (requestedHidden.length > 0 && requestedHidden.length < model.series.length) {
      setHidden(requestedHidden);
    }
  }, [granularityOptions, model.series.length, periodOptions]);

  useEffect(() => {
    syncFromUrl();
    window.addEventListener("popstate", syncFromUrl);
    return () => window.removeEventListener("popstate", syncFromUrl);
  }, [syncFromUrl]);

  useEffect(() => {
    if (model.timeDirection === "categorical" && period !== "all") {
      setPeriod("all");
    }
  }, [model.timeDirection, period]);

  // Keep granularity valid if model.availableGranularities changes, WITHOUT overwriting valid user clicks!
  useEffect(() => {
    if (!granularityOptions.includes(granularity)) {
      setGranularity(pickDefaultGranularity(period));
    }
  }, [granularity, granularityOptions, period, pickDefaultGranularity]);

  // ResizeObserver for crisp responsive SVG typography (360px..1120px) with zero scroll-loop layout reads
  useEffect(() => {
    const node = viewportRef.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const nextW = Math.max(360, Math.min(1120, Math.round(entry.contentRect.width)));
      setContainerWidth((prev) => (Math.abs(prev - nextW) >= 4 ? nextW : prev));
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const overdueSummary = useMemo(() => extractOverdueSummary(model), [model]);
  const isolateOverdue = Boolean(overdueSummary && period !== "all" && !includeOverdueInAxis);

  // Global aggregated model (computed lazily only for "Tüm Ufuk Ölçeği" comparison mode)
  const globalGranularView = useMemo(() => {
    if (scaleMode !== "global") return undefined;
    const allPeriod = filterChartPeriod(model, "all", granularity, { excludeOverdue: isolateOverdue });
    const agg = aggregateChartGranularity(allPeriod, granularity);
    return {
      ...agg,
      series: agg.series.filter((s) => !hidden.includes(s.id)),
    };
  }, [scaleMode, model, granularity, isolateOverdue, hidden]);

  const periodView = useMemo(
    () => filterChartPeriod(model, period, granularity, { excludeOverdue: isolateOverdue }),
    [model, period, granularity, isolateOverdue],
  );
  const granularView = useMemo(() => aggregateChartGranularity(periodView, granularity), [periodView, granularity]);

  const allKeys = useMemo(
    () => [...new Set(granularView.series.flatMap((series) => series.points.map((point) => point.key)))].sort(),
    [granularView],
  );
  const windowSize = Math.max(2, Math.ceil(allKeys.length / zoom));
  const maxOffset = Math.max(0, allKeys.length - windowSize);
  const start = Math.min(offset, maxOffset);

  const view = useMemo(() => {
    const visible = new Set(allKeys.slice(start, start + windowSize));
    return {
      ...granularView,
      series: granularView.series.map((series) => ({
        ...series,
        points: series.points.filter((point) => visible.has(point.key)),
      })),
    };
  }, [granularView, allKeys, start, windowSize]);

  const shown = useMemo(() => view.series.filter((series) => !hidden.includes(series.id)), [view.series, hidden]);

  const domain = useMemo(
    () =>
      chartDomain(
        { ...view, series: shown },
        {
          scaleMode,
          globalModel: globalGranularView,
          headroomPct: 0.15,
          excludeOverdue: isolateOverdue,
        },
      ),
    [view, shown, scaleMode, globalGranularView, isolateOverdue],
  );

  const keys = useMemo(
    () => [...new Set(shown.flatMap((series) => series.points.map((point) => point.key)))].sort(),
    [shown],
  );

  const W = focus ? 1040 : containerWidth;
  const H = focus ? 520 : containerWidth < 520 ? Math.min(height ?? 300, 300) : (height ?? 360);
  const left = containerWidth < 520 ? 54 : 68;
  const right = 18;
  const top = 24;
  const bottom = 44;
  const plotW = Math.max(120, W - left - right);
  const plotH = Math.max(120, H - top - bottom);

  const x = useCallback(
    (index: number) => left + ((index + 0.5) / Math.max(keys.length, 1)) * plotW,
    [keys.length, left, plotW],
  );
  const y = useCallback(
    (value: number) => top + (1 - (value - domain.min) / Math.max(domain.max - domain.min, 1e-9)) * plotH,
    [domain.max, domain.min, plotH],
  );
  const zero = y(0);

  useEffect(() => {
    if (!hydrated.current) {
      hydrated.current = true;
      return;
    }
    const timer = window.setTimeout(() => {
      const url = new URL(window.location.href);
      url.searchParams.set("chartPeriod", period);
      url.searchParams.set("chartGranularity", granularity);
      url.searchParams.set("chartScale", scaleMode);
      if (zoom > 1) url.searchParams.set("chartZoom", String(zoom));
      else url.searchParams.delete("chartZoom");
      if (start > 0) url.searchParams.set("chartOffset", String(start));
      else url.searchParams.delete("chartOffset");
      if (hidden.length) url.searchParams.set("chartHidden", hidden.join(","));
      else url.searchParams.delete("chartHidden");
      window.history.replaceState(window.history.state, "", url);
    }, 600);
    return () => window.clearTimeout(timer);
  }, [period, granularity, scaleMode, zoom, start, hidden]);

  useEffect(() => {
    if (!focus) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") setFocus(false);
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [focus]);

  const changePeriod = (next: AnalyticsPeriod) => {
    setPeriod(next);
    if (!userPinnedGranularity) {
      setGranularity(pickDefaultGranularity(next));
    }
    setZoom(1);
    setOffset(0);
    setHoverIdx(null);
  };

  const changeGranularity = (next: ChartGranularity) => {
    setGranularity(next);
    setUserPinnedGranularity(true);
    setZoom(1);
    setOffset(0);
    setHoverIdx(null);
  };

  const toggleSeries = (id: string) =>
    setHidden((current) => {
      if (current.includes(id)) return current.filter((item) => item !== id);
      return view.series.length - current.length <= 1 ? current : [...current, id];
    });

  const slugName = useMemo(
    () => model.title.toLocaleLowerCase("tr-TR").replaceAll(/[^a-z0-9çğıöşü]+/gi, "-") || "grafik",
    [model.title],
  );

  const saveBlob = (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const downloadCsv = () => {
    saveBlob(new Blob([`\ufeff${chartToCsv({ ...view, series: shown })}`], { type: "text/csv;charset=utf-8" }), `${slugName}.csv`);
  };

  const downloadSvg = () => {
    if (!svgRef.current) return;
    const text = resolveCssVarsInSvg(svgRef.current);
    saveBlob(new Blob([text], { type: "image/svg+xml;charset=utf-8" }), `${slugName}.svg`);
  };

  const downloadPng = () => {
    if (!svgRef.current) return;
    const text = resolveCssVarsInSvg(svgRef.current);
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(W * 2));
      canvas.height = Math.max(1, Math.round(H * 2));
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.fillStyle = "#FFFFFF";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      canvas.toBlob((blob) => {
        if (blob) saveBlob(blob, `${slugName}.png`);
      }, "image/png");
    };
    img.src = "data:image/svg+xml;base64," + btoa(unescape(encodeURIComponent(text)));
  };

  const downloadExcel = async () => {
    const exportKeys = [...new Set(shown.flatMap((series) => series.points.map((point) => point.key)))].sort();
    const rows: (string | number | null)[][] = [
      ["Tarih", "Dönem", ...shown.map((series) => series.label)],
      ...exportKeys.map((key) => [
        key,
        shown.flatMap((series) => series.points).find((point) => point.key === key)?.label ?? key,
        ...shown.map((series) => series.points.find((point) => point.key === key)?.value ?? null),
      ]),
    ];
    const response = await fetch("/api/analytics/export", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ filename: slugName, sheets: [{ name: "Veri", rows }] }),
    });
    if (!response.ok) return;
    const blob = await response.blob();
    saveBlob(blob, `${slugName}.xlsx`);
  };

  const emptySeries = view.series.filter((series) => series.points.every((point) => point.value == null || point.value === 0));

  const hasProjectedData = useMemo(
    () =>
      shown.some(
        (s) =>
          s.projectionKind === "projected" ||
          s.dashed ||
          s.points.some((p) => p.projectionKind === "projected" || Number(p.meta?.projectedAmount ?? 0) > 0),
      ),
    [shown],
  );

  const periodSummary = useMemo(() => {
    if (!model.summaryMode) return null;
    const visible = granularView.series.filter((series) => !hidden.includes(series.id));
    const rows = visible.map((series) => {
      const nums = series.points.map((point) => point.value).filter((value): value is number => value != null);
      const value =
        model.summaryMode === "sum"
          ? nums.length
            ? nums.reduce((total, current) => total + current, 0)
            : null
          : ([...series.points].reverse().find((point) => point.value != null)?.value ?? null);
      return { id: series.id, label: series.label, tone: series.tone, value, format: series.format };
    });
    const grandTotal =
      model.summaryMode === "sum" && model.preferredView === "stacked" && visible.length > 1
        ? rows.reduce((total, row) => total + (row.value ?? 0), 0)
        : null;
    return { rows, grandTotal, format: visible[0]?.format ?? ("currency" as const) };
  }, [granularView, hidden, model.summaryMode, model.preferredView]);

  // O(1) magnetic crosshair calculation using offsetX — zero getBoundingClientRect() in pointermove!
  const handleSvgPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (keys.length === 0) return;
    const offsetPx = e.nativeEvent.offsetX;
    const svgX = (offsetPx / Math.max(containerWidth, 1)) * W;
    if (svgX < left - 12 || svgX > W - right + 12) {
      setHoverIdx(null);
      return;
    }
    const ratio = (svgX - left) / plotW;
    const idx = Math.max(0, Math.min(keys.length - 1, Math.floor(ratio * keys.length)));
    setHoverIdx(idx);
    setPointerX(offsetPx);
  };

  const handleSvgClick = () => {
    if (hoverIdx == null) return;
    const activeKey = keys[hoverIdx];
    if (!activeKey) return;
    for (const s of shown) {
      const pt = s.points.find((p) => p.key === activeKey);
      if (pt?.href && (pt.value ?? 0) !== 0) {
        router.push(pt.href);
        return;
      }
    }
  };

  const hoveredKey = hoverIdx != null ? keys[hoverIdx] : null;
  const hoveredLabel = useMemo(() => {
    if (!hoveredKey) return null;
    return shown.flatMap((s) => s.points).find((p) => p.key === hoveredKey)?.label ?? hoveredKey;
  }, [hoveredKey, shown]);

  const hoveredRows = useMemo(() => {
    if (!hoveredKey) return [];
    return shown
      .map((s) => {
        const pt = s.points.find((p) => p.key === hoveredKey);
        if (!pt || pt.value == null) return null;
        const isProj = pt.projectionKind === "projected" || s.projectionKind === "projected" || Boolean(s.dashed);
        return {
          id: s.id,
          label: s.label,
          tone: s.tone,
          value: pt.value,
          format: s.format,
          href: pt.href,
          isProjected: isProj,
          statusReason: pt.statusReason,
          meta: pt.meta,
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);
  }, [hoveredKey, shown]);

  const maxXTicks = containerWidth < 480 ? 4 : containerWidth < 760 ? 6 : 9;

  return (
    <section
      className={`analytics-chart ${focus ? "chart-focus-mode" : ""}`}
      aria-label={model.title}
      role={focus ? "dialog" : undefined}
      aria-modal={focus || undefined}
    >
      {/* Header + Primary Period & Export Toolbar */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="text-[14px] font-semibold tracking-[-0.01em]" style={{ color: "var(--text-1)" }}>
            {model.title}
          </h3>
          {model.description && (
            <p className="mt-0.5 max-w-2xl text-[12px] leading-snug" style={{ color: "var(--text-3)" }}>
              {model.description}
            </p>
          )}
        </div>

        <div className="chart-toolbar flex flex-wrap items-center gap-1" aria-label="Grafik araçları">
          <div
            className="inline-flex items-center rounded-[var(--radius-sm)] border p-0.5"
            style={{ background: "var(--surface-2)", borderColor: "var(--line)" }}
          >
            {periodOptions.map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => changePeriod(value)}
                aria-pressed={period === value}
                className="min-h-[28px] rounded-[4px] px-2.5 py-1 text-[11.5px] font-semibold transition-colors"
                style={
                  period === value
                    ? {
                        background: "var(--surface-1)",
                        color: "var(--info)",
                        boxShadow: "var(--shadow-card)",
                      }
                    : { color: "var(--text-2)" }
                }
              >
                {label}
              </button>
            ))}
          </div>

          {period !== "all" && model.timeDirection !== "categorical" && (
            <button
              type="button"
              onClick={() => setScaleMode((m) => (m === "window" ? "global" : "window"))}
              aria-pressed={scaleMode === "global"}
              className={scaleMode === "global" ? "button-accent px-2.5 py-1" : "button-ghost px-2.5 py-1"}
              title={
                scaleMode === "window"
                  ? "Aktif: Pencere Ölçeği (seçili döneme göre dinamik Y-ekseni). Tüm ufuk ölçeğine geçmek için tıklayın."
                  : "Aktif: Tüm Ufuk Ölçeği (24A sabit Y-ekseni). Pencere ölçeğine dönmek için tıklayın."
              }
            >
              <Scaling size={13.5} strokeWidth={1.75} aria-hidden />
              <span className="hidden sm:inline">{scaleMode === "window" ? "Pencere Ölçeği" : "Tüm Ufuk Ölçeği"}</span>
            </button>
          )}

          <button
            type="button"
            onClick={() => setZoom((value) => Math.min(12, value + 1))}
            className="button-ghost px-2 py-1"
            aria-label="Grafiği yakınlaştır"
            title="Yakınlaştır"
          >
            <ZoomIn size={14} strokeWidth={1.75} aria-hidden />
          </button>
          <button
            type="button"
            onClick={() => setZoom((value) => Math.max(1, value - 1))}
            className="button-ghost px-2 py-1"
            aria-label="Grafiği uzaklaştır"
            title="Uzaklaştır"
          >
            <ZoomOut size={14} strokeWidth={1.75} aria-hidden />
          </button>
          {(zoom > 1 || offset > 0) && (
            <button
              type="button"
              onClick={() => {
                setZoom(1);
                setOffset(0);
              }}
              className="button-ghost px-2 py-1"
              title="Görünümü sıfırla"
            >
              <RotateCcw size={13.5} strokeWidth={1.75} aria-hidden />
            </button>
          )}
          <button
            type="button"
            onClick={() => setFocus((value) => !value)}
            className="button-ghost px-2 py-1"
            aria-label={focus ? "Odak modunu kapat" : "Odak modu"}
            title={focus ? "Odak modunu kapat (Esc)" : "Tam ekran odak modu"}
          >
            {focus ? <Minimize2 size={14} strokeWidth={1.75} aria-hidden /> : <Maximize2 size={14} strokeWidth={1.75} aria-hidden />}
          </button>
          <button type="button" onClick={downloadPng} className="button-ghost px-2 py-1" title="Yüksek çözünürlüklü PNG indir">
            <ImageDown size={13.5} strokeWidth={1.75} aria-hidden />
            <span>PNG</span>
          </button>
          <button type="button" onClick={downloadSvg} className="button-ghost px-2 py-1" title="Vektörel SVG indir">
            <FileCode2 size={13.5} strokeWidth={1.75} aria-hidden />
            <span>SVG</span>
          </button>
          <button type="button" onClick={downloadCsv} className="button-ghost px-2 py-1" title="CSV indir">
            <Download size={13.5} strokeWidth={1.75} aria-hidden />
            <span>CSV</span>
          </button>
          <button type="button" onClick={downloadExcel} className="button-ghost px-2 py-1" title="Excel (.xlsx) indir">
            <FileSpreadsheet size={13.5} strokeWidth={1.75} aria-hidden />
            <span>Excel</span>
          </button>
        </div>
      </div>

      {/* Granularity Bar (Günlük / Haftalık / Aylık) */}
      {(model.availableGranularities || model.timeDirection !== "categorical") && granularityOptions.length > 1 && (
        <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-1" role="group" aria-label="Zaman çözünürlüğü">
            <span className="mr-1 text-[11px] font-semibold uppercase tracking-[0.06em]" style={{ color: "var(--text-3)" }}>
              Çözünürlük
            </span>
            {GRANULARITIES.filter(([value]) => granularityOptions.includes(value)).map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => changeGranularity(value)}
                aria-pressed={granularity === value}
                className={granularity === value ? "button-accent px-2.5 py-1" : "button-ghost px-2.5 py-1"}
              >
                {label}
              </button>
            ))}
          </div>

          {hasProjectedData && (
            <div className="flex flex-wrap items-center gap-3 text-[11px]" style={{ color: "var(--text-3)" }}>
              <span className="inline-flex items-center gap-1.5">
                <span className="inline-block h-2.5 w-3 rounded-[2px]" style={{ background: "var(--info)" }} aria-hidden />
                <span>Kesinleşmiş Kayıt</span>
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span
                  className="inline-block h-2.5 w-3 rounded-[2px] border border-dashed"
                  style={{
                    borderColor: "var(--info)",
                    background:
                      "repeating-linear-gradient(45deg, rgba(29,78,216,0.28), rgba(29,78,216,0.28) 2px, transparent 2px, transparent 4px)",
                  }}
                  aria-hidden
                />
                <span>Şablon / Projeksiyon</span>
              </span>
            </div>
          )}
        </div>
      )}

      {/* Dedicated High-Visibility Overdue Callout Bar (M-02 / M-03) */}
      {overdueSummary && period !== "all" && (
        <div
          className="mt-2.5 flex flex-wrap items-center justify-between gap-2 border px-3 py-2"
          style={{
            background: "color-mix(in srgb, var(--neg) 6%, var(--surface-1))",
            borderColor: "color-mix(in srgb, var(--neg) 28%, var(--line))",
            borderRadius: "var(--radius-md)",
          }}
          role="region"
          aria-label="Vadesi geçmiş yük özeti"
        >
          <div className="flex flex-wrap items-center gap-2 text-[12.5px]">
            <span className="inline-flex items-center gap-1.5 font-semibold" style={{ color: "var(--neg)" }}>
              <AlertTriangle size={14} strokeWidth={1.85} aria-hidden />
              <span>Vadesi Geçmiş Yük:</span>
            </span>
            <strong className="font-bold tabular-nums" style={{ color: "var(--neg)" }}>
              {formatChartValue(overdueSummary.total, "currency", model.currencyCode)}
            </strong>
            <span className="text-[11.5px]" style={{ color: "var(--text-2)" }}>
              ({overdueSummary.count} gecikmiş kalem — ileri dönem Y-eksenini dondurmamak için ayrı gösteriliyor)
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setIncludeOverdueInAxis((v) => !v)}
              aria-pressed={includeOverdueInAxis}
              className="button-ghost px-2 py-0.5 text-[11px]"
            >
              {includeOverdueInAxis ? "Eksenden ayır" : "Eksene dahil et"}
            </button>
            <Link
              href={overdueSummary.href}
              className="inline-flex items-center gap-1 text-[12px] font-semibold hover:underline"
              style={{ color: "var(--neg)" }}
            >
              <span>Kalemleri aç</span>
              <ArrowUpRight size={13} strokeWidth={1.75} aria-hidden />
            </Link>
          </div>
        </div>
      )}

      {/* Period Totals / Closing Summary Strip */}
      {periodSummary && periodSummary.rows.length > 0 && (
        <div
          className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1 border px-3 py-2 text-[12px]"
          style={{
            background: "var(--surface-2)",
            borderColor: "var(--line)",
            borderRadius: "var(--radius-md)",
          }}
          aria-label="Seçili dönem özeti"
        >
          <span className="text-[11px] font-semibold uppercase tracking-[0.06em]" style={{ color: "var(--text-3)" }}>
            {model.summaryMode === "sum" ? "Seçili dönem toplamı" : "Seçili dönem sonu"}
          </span>
          {periodSummary.rows.map((row) => (
            <span key={row.id} className="tabular-nums" style={{ color: "var(--text-2)" }}>
              {row.label}:{" "}
              <b className="font-bold" style={{ color: COLORS[row.tone] }}>
                {formatChartValue(row.value, row.format, model.currencyCode)}
              </b>
            </span>
          ))}
          {periodSummary.grandTotal != null && (
            <span className="tabular-nums" style={{ color: "var(--text-1)" }}>
              Toplam yük:{" "}
              <b className="font-bold" style={{ color: "var(--neg)" }}>
                {formatChartValue(periodSummary.grandTotal, periodSummary.format, model.currencyCode)}
              </b>
            </span>
          )}
        </div>
      )}

      {/* Interactive Series Filter Chips */}
      <div className="mt-2.5 flex flex-wrap gap-1.5" aria-label="Grafik serileri">
        {view.series.map((series) => {
          const isVisible = !hidden.includes(series.id);
          const isSeriesProjected = series.projectionKind === "projected" || Boolean(series.dashed);
          return (
            <button
              type="button"
              key={series.id}
              onDoubleClick={() => setHidden(view.series.filter((item) => item.id !== series.id).map((item) => item.id))}
              onClick={() => toggleSeries(series.id)}
              aria-pressed={isVisible}
              className="button-ghost px-2.5 py-1 text-[11.5px]"
              style={!isVisible ? { opacity: 0.48 } : undefined}
            >
              <span
                className="mr-1 inline-block h-2.5 w-2.5 rounded-[2px] border"
                style={{
                  background: isSeriesProjected ? "transparent" : COLORS[series.tone],
                  borderColor: COLORS[series.tone],
                  borderStyle: isSeriesProjected ? "dashed" : "solid",
                }}
                aria-hidden
              />
              <span>{series.label}</span>
              {emptySeries.some((item) => item.id === series.id) && (
                <span className="ml-1 text-[11px]" style={{ color: "var(--text-3)" }}>
                  · kayıt yok
                </span>
              )}
            </button>
          );
        })}
      </div>

      <p className="sr-only">{chartSummary(view)}</p>

      {/* Main Responsive SVG Canvas */}
      {shown.length === 0 || keys.length === 0 ? (
        <div
          className="mt-3 border border-dashed p-6 text-center text-[13px]"
          style={{ borderColor: "var(--line-strong)", borderRadius: "var(--radius-md)", color: "var(--text-3)" }}
        >
          Seçilen dönemde gösterilecek kayıt yok.
        </div>
      ) : (
        <div ref={viewportRef} className="relative mt-2.5 w-full select-none">
          <svg
            ref={svgRef}
            viewBox={`0 0 ${W} ${H}`}
            className="block w-full cursor-crosshair"
            role="img"
            aria-label={chartSummary(view)}
            onPointerMove={handleSvgPointerMove}
            onPointerLeave={() => setHoverIdx(null)}
            onClick={handleSvgClick}
          >
            <defs>
              <pattern id="unknown-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                <line x1="0" y1="0" x2="0" y2="6" stroke="var(--text-3)" strokeWidth="2" />
              </pattern>
              <pattern id="projected-hatch" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                <rect width="7" height="7" fill="var(--info)" fillOpacity="0.14" />
                <line x1="0" y1="0" x2="0" y2="7" stroke="var(--info)" strokeWidth="2" strokeOpacity="0.65" />
              </pattern>
              {(Object.keys(COLORS) as ChartTone[]).map((tone) => (
                <pattern
                  key={tone}
                  id={`projected-hatch-${tone}`}
                  width="7"
                  height="7"
                  patternUnits="userSpaceOnUse"
                  patternTransform="rotate(45)"
                >
                  <rect width="7" height="7" fill={COLORS[tone]} fillOpacity="0.15" />
                  <line x1="0" y1="0" x2="0" y2="7" stroke={COLORS[tone]} strokeWidth="2" strokeOpacity="0.72" />
                </pattern>
              ))}
              {(Object.keys(COLORS) as ChartTone[]).map((tone) => (
                <linearGradient key={`grad-${tone}`} id={`area-grad-${tone}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={COLORS[tone]} stopOpacity="0.18" />
                  <stop offset="100%" stopColor={COLORS[tone]} stopOpacity="0.01" />
                </linearGradient>
              ))}
            </defs>

            {/* Horizontal Y-Axis Ticks & Gridlines */}
            {[0, 0.25, 0.5, 0.75, 1].map((tick) => {
              const value = domain.max - (domain.max - domain.min) * tick;
              const yy = top + plotH * tick;
              return (
                <g key={tick}>
                  <line x1={left} x2={W - right} y1={yy} y2={yy} stroke="var(--line-faint)" strokeWidth="1" />
                  <text
                    x={left - 8}
                    y={yy + 3.5}
                    textAnchor="end"
                    fontSize="11"
                    fontWeight="500"
                    fill="var(--text-3)"
                  >
                    {new Intl.NumberFormat("tr-TR", { notation: "compact", maximumFractionDigits: 1 }).format(value)}
                  </text>
                </g>
              );
            })}

            {/* Explicit y = 0 Baseline */}
            {domain.min <= 0 && domain.max >= 0 && (
              <line x1={left} x2={W - right} y1={zero} y2={zero} stroke="var(--line-strong)" strokeWidth="1.25" />
            )}

            {/* Critical Threshold Reference Line */}
            {model.criticalThreshold != null &&
              model.criticalThreshold > domain.min &&
              model.criticalThreshold < domain.max && (
                <g>
                  <line
                    x1={left}
                    x2={W - right}
                    y1={y(model.criticalThreshold)}
                    y2={y(model.criticalThreshold)}
                    stroke="var(--warn)"
                    strokeWidth="1.25"
                    strokeDasharray="5 4"
                  />
                  <text
                    x={W - right - 4}
                    y={Math.max(top + 10, y(model.criticalThreshold) - 4)}
                    textAnchor="end"
                    fontSize="10.5"
                    fontWeight="600"
                    fill="var(--warn)"
                  >
                    Kritik eşik: {new Intl.NumberFormat("tr-TR", { notation: "compact", maximumFractionDigits: 1 }).format(model.criticalThreshold)}
                  </text>
                </g>
              )}

            {/* Magnetic Vertical Crosshair */}
            {hoverIdx != null && keys[hoverIdx] != null && (
              <line
                x1={x(hoverIdx)}
                x2={x(hoverIdx)}
                y1={top}
                y2={H - bottom}
                stroke="var(--info)"
                strokeOpacity="0.45"
                strokeWidth="1.25"
                strokeDasharray="3 3"
              />
            )}

            {/* Data Series Renderers */}
            {kind === "bar" && model.preferredView === "stacked" ? (
              <StackedBars
                series={shown}
                keys={keys}
                x={x}
                y={y}
                plotW={plotW}
                annotations={model.annotations ?? []}
                currencyCode={model.currencyCode}
              />
            ) : (
              shown.map((series, index) =>
                kind === "line" ? (
                  <LineSeries
                    key={series.id}
                    series={series}
                    keys={keys}
                    x={x}
                    y={y}
                    zero={zero}
                    showArea={shown.length === 1}
                    hoverIdx={hoverIdx}
                    currencyCode={model.currencyCode}
                  />
                ) : (
                  <GroupedBars
                    key={series.id}
                    series={series}
                    keys={keys}
                    seriesIndex={index}
                    seriesCount={shown.length}
                    x={x}
                    y={y}
                    zero={zero}
                    plotW={plotW}
                    currencyCode={model.currencyCode}
                  />
                ),
              )
            )}

            {/* X-Axis Labels */}
            {keys.map((key, index) => {
              const step = Math.max(1, Math.ceil(keys.length / maxXTicks));
              if (index % step !== 0 && index !== keys.length - 1) return null;
              if (index === keys.length - 1 && keys.length > 3 && (keys.length - 1) % step < step * 0.45) return null;
              const rawLabel = shown.flatMap((series) => series.points).find((point) => point.key === key)?.label ?? key;
              return (
                <text
                  key={key}
                  x={x(index)}
                  y={H - 14}
                  textAnchor="middle"
                  fontSize="11"
                  fontWeight="500"
                  fill="var(--text-3)"
                >
                  {rawLabel.length > 14 ? rawLabel.slice(0, 12) + "…" : rawLabel}
                </text>
              );
            })}
          </svg>

          {/* GPU-Positioned Rich Glassmorphic Hover Card */}
          {hoverIdx != null && hoveredRows.length > 0 && (
            <div
              className="chart-tooltip pointer-events-none absolute top-3 z-20 w-64"
              style={{
                left: 0,
                transform: `translate3d(${
                  pointerX > containerWidth - 280 ? Math.max(8, pointerX - 268) : Math.min(containerWidth - 264, pointerX + 14)
                }px, 0, 0)`,
              }}
              role="status"
            >
              <div className="mb-1.5 flex items-center justify-between gap-2 border-b pb-1" style={{ borderColor: "var(--line)" }}>
                <strong className="truncate text-[12px] font-bold" style={{ color: "var(--text-1)" }}>
                  {hoveredLabel}
                </strong>
                {hoveredRows.some((r) => r.href) && (
                  <span className="text-[10px] font-semibold" style={{ color: "var(--info)" }}>
                    Tıkla → Detay
                  </span>
                )}
              </div>
              <div className="space-y-1">
                {hoveredRows.map((row) => (
                  <div key={row.id} className="flex items-center justify-between gap-2 text-[12px]">
                    <span className="flex min-w-0 items-center gap-1.5" style={{ color: "var(--text-2)" }}>
                      <span
                        className="h-2 w-2 shrink-0 rounded-[2px]"
                        style={{ background: FALLBACK_HEX[row.tone] }}
                        aria-hidden
                      />
                      <span className="truncate">{row.label}</span>
                      {row.isProjected && (
                        <span
                          className="rounded px-1 py-0.2 text-[9.5px] font-semibold"
                          style={{ background: "var(--surface-2)", color: "var(--text-3)" }}
                        >
                          Proj.
                        </span>
                      )}
                    </span>
                    <strong className="shrink-0 font-bold tabular-nums" style={{ color: COLORS[row.tone] }}>
                      {formatChartValue(row.value, row.format, model.currencyCode)}
                    </strong>
                  </div>
                ))}
              </div>
              {hoveredRows[0]?.statusReason && (
                <div className="mt-1.5 border-t pt-1 text-[10.5px]" style={{ borderColor: "var(--line-faint)", color: "var(--text-3)" }}>
                  {hoveredRows[0].statusReason}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Horizontal Pan Scrubber when Zoomed */}
      {zoom > 1 && allKeys.length > 2 && (
        <div className="mt-2 flex items-center gap-2">
          <button
            type="button"
            className="button-ghost px-2 py-1"
            onClick={() => setOffset((value) => Math.max(0, value - 1))}
            disabled={start === 0}
          >
            ←
          </button>
          <input
            aria-label="Grafik görünür aralığı"
            type="range"
            min="0"
            max={maxOffset}
            value={start}
            onChange={(event) => setOffset(Number(event.target.value))}
            className="min-w-0 flex-1 accent-[var(--info)]"
          />
          <button
            type="button"
            className="button-ghost px-2 py-1"
            onClick={() => setOffset((value) => Math.min(maxOffset, value + 1))}
            disabled={start === maxOffset}
          >
            →
          </button>
        </div>
      )}

      {(model.unknownCount ?? 0) > 0 && (
        <p className="mt-2 text-[12px] font-medium" style={{ color: "var(--warn)" }}>
          ▧ {model.unknownCount ?? 0} tutarı bilinmeyen kayıt sıfır kabul edilmedi.
        </p>
      )}

      <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2">
        <details>
          <summary className="cursor-pointer text-[12px] font-semibold" style={{ color: "var(--info)" }}>
            Erişilebilir veri tablosu
          </summary>
          <AccessibleChartTable model={{ ...view, series: shown }} currencyCode={model.currencyCode} />
        </details>
        <p className="text-[11px]" style={{ color: "var(--text-3)" }}>
          Kaynak: {model.sourceLabel} · itibarıyla <span className="font-mono">{model.asOf}</span>
        </p>
      </div>
    </section>
  );
}

function tooltipText(series: ChartSeries, point: ChartPoint, currencyCode?: ChartModel["currencyCode"]) {
  const meta = point.meta ?? {};
  const count = Number(meta.overdueCount ?? 0) + Number(meta.partialCount ?? 0) + Number(meta.plannedCount ?? 0);
  const isProj = point.projectionKind === "projected" || series.projectionKind === "projected" || Boolean(series.dashed);
  const extras = [
    isProj ? "Şablon projeksiyonu" : null,
    count ? `${count} kayıt` : null,
    meta.criticalCount ? `${meta.criticalCount} kritik` : null,
    meta.unknownAmountCount ? `${meta.unknownAmountCount} tutar eksik` : null,
    meta.foreignCurrencyCount ? `${meta.foreignCurrencyCount} dövizli` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return `${point.label} · ${series.label}: ${formatChartValue(point.value, series.format, currencyCode)}${extras ? ` · ${extras}` : ""}${point.statusReason ? ` · ${point.statusReason}` : ""}`;
}

function StackedBars({
  series,
  keys,
  x,
  y,
  plotW,
  annotations,
  currencyCode,
}: {
  series: ChartSeries[];
  keys: string[];
  x: (index: number) => number;
  y: (value: number) => number;
  plotW: number;
  annotations: ChartModel["annotations"];
  currencyCode?: ChartModel["currencyCode"];
}) {
  const width = Math.max(5, Math.min(36, (plotW * 0.72) / Math.max(keys.length, 1)));
  return (
    <g>
      {keys.map((key, index) => {
        let cumulative = 0;
        const points = series.map((item) => ({ series: item, point: item.points.find((point) => point.key === key) }));
        const unknown = points.some(({ point }) => point?.value == null && Number(point?.meta?.unknownAmountCount ?? 0) > 0);
        const annotation = annotations?.find((item) => item.pointKey === key);
        return (
          <g key={key}>
            {points.map(({ series: item, point }) => {
              if (point?.value == null || point.value <= 0) return null;
              const from = cumulative;
              cumulative += point.value;
              const yy = y(cumulative);
              const base = y(from);
              const title = tooltipText(item, point, currencyCode);
              const isProjected =
                point.projectionKind === "projected" || item.projectionKind === "projected" || Boolean(item.dashed);
              const barH = Math.max(2, base - yy);
              return (
                <a key={item.id} href={point.href} tabIndex={0} aria-label={title}>
                  <rect
                    x={x(index) - width / 2}
                    y={yy}
                    width={width}
                    height={barH}
                    rx={1.5}
                    fill={isProjected ? `url(#projected-hatch-${item.tone})` : COLORS[item.tone]}
                    stroke={isProjected ? COLORS[item.tone] : item.id === "partial" ? "var(--surface-1)" : "none"}
                    strokeWidth={isProjected ? 1.15 : item.id === "partial" ? 1 : 0}
                    strokeDasharray={isProjected ? "3 2" : undefined}
                  >
                    <title>{title}</title>
                  </rect>
                </a>
              );
            })}
            {unknown && (
              <rect
                x={x(index) - width / 2}
                y={Math.max(8, y(cumulative) - 9)}
                width={width}
                height="7"
                fill="url(#unknown-hatch)"
              >
                <title>Tutarı bilinmeyen kayıt var</title>
              </rect>
            )}
            {annotation && (
              <a href={annotation.href}>
                <path d={`M ${x(index)} ${Math.max(9, y(cumulative) - 13)} l -5 -8 h 10 z`} fill="var(--neg)">
                  <title>{annotation.label}</title>
                </path>
              </a>
            )}
          </g>
        );
      })}
    </g>
  );
}

function LineSeries({
  series,
  keys,
  x,
  y,
  zero,
  showArea,
  hoverIdx,
  currencyCode,
}: {
  series: ChartSeries;
  keys: string[];
  x: (index: number) => number;
  y: (value: number) => number;
  zero: number;
  showArea: boolean;
  hoverIdx: number | null;
  currencyCode?: ChartModel["currencyCode"];
}) {
  const validCoords: Array<{ idx: number; px: number; py: number; point: ChartPoint }> = [];
  keys.forEach((key, index) => {
    const point = series.points.find((item) => item.key === key);
    if (point?.value != null) {
      validCoords.push({ idx: index, px: x(index), py: y(point.value), point });
    }
  });

  const isSeriesProjected = series.projectionKind === "projected" || Boolean(series.dashed);
  const polyPoints = validCoords.map((c) => `${c.px},${c.py}`).join(" ");
  const areaPath =
    showArea && validCoords.length >= 2
      ? `M ${validCoords[0].px} ${zero} ` +
        validCoords.map((c) => `L ${c.px} ${c.py}`).join(" ") +
        ` L ${validCoords[validCoords.length - 1].px} ${zero} Z`
      : null;

  return (
    <g>
      {areaPath && (
        <path
          d={areaPath}
          fill={isSeriesProjected ? `url(#projected-hatch-${series.tone})` : `url(#area-grad-${series.tone})`}
        />
      )}
      {validCoords.length >= 2 && (
        <polyline
          points={polyPoints}
          fill="none"
          stroke={COLORS[series.tone]}
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeDasharray={isSeriesProjected ? "6 4" : undefined}
        />
      )}
      {validCoords.map(({ idx, px, py, point }) => {
        const title = tooltipText(series, point, currencyCode);
        const isPointProjected = point.projectionKind === "projected" || isSeriesProjected;
        const isHovered = hoverIdx === idx;
        return (
          <a key={point.key} href={point.href} tabIndex={0} aria-label={title}>
            <circle
              cx={px}
              cy={py}
              r={isHovered ? 5.5 : validCoords.length > 36 ? 2.8 : 4}
              fill={isPointProjected ? "var(--surface-1)" : COLORS[series.tone]}
              stroke={COLORS[series.tone]}
              strokeWidth={isPointProjected || isHovered ? 2 : 0}
            >
              <title>{title}</title>
            </circle>
          </a>
        );
      })}
    </g>
  );
}

function GroupedBars({
  series,
  keys,
  seriesIndex,
  seriesCount,
  x,
  y,
  zero,
  plotW,
  currencyCode,
}: {
  series: ChartSeries;
  keys: string[];
  seriesIndex: number;
  seriesCount: number;
  x: (index: number) => number;
  y: (value: number) => number;
  zero: number;
  plotW: number;
  currencyCode?: ChartModel["currencyCode"];
}) {
  const width = Math.max(4, Math.min(28, (plotW * 0.72) / Math.max(keys.length, 1) / Math.max(seriesCount, 1)));
  return (
    <g>
      {keys.map((key, index) => {
        const point = series.points.find((item) => item.key === key);
        if (point?.value == null) return null;
        const yy = y(point.value);
        const title = tooltipText(series, point, currencyCode);
        const isProjected =
          point.projectionKind === "projected" || series.projectionKind === "projected" || Boolean(series.dashed);
        return (
          <a key={key} href={point.href} tabIndex={0} aria-label={title}>
            <rect
              x={x(index) - (seriesCount * width) / 2 + seriesIndex * width}
              y={Math.min(yy, zero)}
              width={Math.max(3.5, width - 2)}
              height={Math.max(Math.abs(zero - yy), point.value === 0 ? 0 : 2)}
              rx={1.5}
              fill={isProjected ? `url(#projected-hatch-${series.tone})` : COLORS[series.tone]}
              stroke={isProjected ? COLORS[series.tone] : "none"}
              strokeWidth={isProjected ? 1.15 : 0}
              strokeDasharray={isProjected ? "3 2" : undefined}
            >
              <title>{title}</title>
            </rect>
          </a>
        );
      })}
    </g>
  );
}

function AccessibleChartTable({
  model,
  currencyCode,
}: {
  model: ChartModel;
  currencyCode?: ChartModel["currencyCode"];
}) {
  const keys = [...new Set(model.series.flatMap((series) => series.points.map((point) => point.key)))].sort();
  return (
    <div className="mt-2 overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr>
            <th>Dönem</th>
            {model.series.map((series) => (
              <th key={series.id} className="text-right">
                {series.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {keys.map((key) => (
            <tr key={key} className="border-t border-line-faint">
              <td className="py-1.5">
                {model.series.flatMap((series) => series.points).find((point) => point.key === key)?.label ?? key}
              </td>
              {model.series.map((series) => {
                const point = series.points.find((item) => item.key === key);
                return (
                  <td key={series.id} className="text-right tabular-nums">
                    {formatChartValue(point?.value ?? null, series.format, currencyCode)}
                    {Number(point?.meta?.unknownAmountCount ?? 0) > 0 ? " · tutar eksik" : ""}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
