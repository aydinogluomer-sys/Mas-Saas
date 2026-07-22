"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  aggregateChartGranularity,
  chartDomain,
  chartSummary,
  chartToCsv,
  filterChartPeriod,
  formatChartValue,
  type AnalyticsPeriod,
  type ChartGranularity,
  type ChartModel,
  type ChartSeries,
  type ChartTone,
} from "@/lib/analytics/chart";

const COLORS: Record<ChartTone, string> = {
  positive: "var(--pos)", negative: "var(--neg)", warning: "var(--warn)",
  info: "var(--info)", neutral: "var(--text-3)", scenario: "var(--accent)",
};
const PERIODS: Array<[AnalyticsPeriod, string]> = [["3m", "3A"], ["6m", "6A"], ["12m", "12A"], ["24m", "24A"], ["all", "Tümü"]];
const GRANULARITIES: Array<[ChartGranularity, string]> = [["day", "Günlük"], ["week", "Haftalık"], ["month", "Aylık"]];

export function AnalyticsChart({ model, kind = "line", defaultPeriod = "12m" }: { model: ChartModel; kind?: "line" | "bar"; defaultPeriod?: AnalyticsPeriod }) {
  const periodOptions = useMemo(() => model.timeDirection === "categorical" ? PERIODS.filter(([value]) => value === "all") : PERIODS, [model.timeDirection]);
  const granularityOptions = useMemo<ChartGranularity[]>(() => model.availableGranularities ?? ["day", "week", "month"], [model.availableGranularities]);
  const [period, setPeriod] = useState<AnalyticsPeriod>(model.timeDirection === "categorical" ? "all" : defaultPeriod);
  const [granularity, setGranularity] = useState<ChartGranularity>(model.defaultGranularityByPeriod?.[defaultPeriod] ?? "day");
  const [hidden, setHidden] = useState<string[]>([]);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState(0);
  const [focus, setFocus] = useState(false);
  const [tip, setTip] = useState<string | null>(null);
  const hydrated = useRef(false);

  const normalizeGranularity = (nextPeriod: AnalyticsPeriod, fallback?: ChartGranularity): ChartGranularity => {
    const preferred = model.defaultGranularityByPeriod?.[nextPeriod];
    if (preferred && granularityOptions.includes(preferred)) return preferred;
    if (fallback && granularityOptions.includes(fallback)) return fallback;
    return granularityOptions[0] ?? "day";
  };

  useEffect(() => {
    const params = new URL(window.location.href).searchParams;
    const requestedPeriod = params.get("chartPeriod") as AnalyticsPeriod | null;
    const requestedGranularity = params.get("chartGranularity") as ChartGranularity | null;
    if (periodOptions.some(([value]) => value === requestedPeriod)) setPeriod(requestedPeriod!);
    if (requestedGranularity && granularityOptions.includes(requestedGranularity)) setGranularity(requestedGranularity);
    const requestedHidden = params.get("chartHidden")?.split(",").filter(Boolean) ?? [];
    if (requestedHidden.length < model.series.length) setHidden(requestedHidden);
    hydrated.current = true;
  }, [granularityOptions, model.series.length, periodOptions]);

  useEffect(() => {
    if (model.timeDirection === "categorical" && period !== "all") setPeriod("all");
  }, [model.timeDirection, period]);

  useEffect(() => {
    const next = normalizeGranularity(period, granularity);
    if (next !== granularity) setGranularity(next);
  }, [period, granularity, granularityOptions, model.defaultGranularityByPeriod]);

  const periodView = useMemo(() => filterChartPeriod(model, period, granularity), [model, period, granularity]);
  const granularView = useMemo(() => aggregateChartGranularity(periodView, granularity), [periodView, granularity]);
  const allKeys = useMemo(() => [...new Set(granularView.series.flatMap((series) => series.points.map((point) => point.key)))].sort(), [granularView]);
  const windowSize = Math.max(2, Math.ceil(allKeys.length / zoom));
  const maxOffset = Math.max(0, allKeys.length - windowSize);
  const start = Math.min(offset, maxOffset);
  const view = useMemo(() => {
    const visible = new Set(allKeys.slice(start, start + windowSize));
    return { ...granularView, series: granularView.series.map((series) => ({ ...series, points: series.points.filter((point) => visible.has(point.key)) })) };
  }, [granularView, allKeys, start, windowSize]);
  const shown = view.series.filter((series) => !hidden.includes(series.id));
  const domain = chartDomain({ ...view, series: shown });
  const keys = [...new Set(shown.flatMap((series) => series.points.map((point) => point.key)))].sort();
  const W = 900, H = focus ? 540 : 380, left = 68, right = 20, top = 30, bottom = 52;
  const x = (index: number) => left + ((index + 0.5) / Math.max(keys.length, 1)) * (W - left - right);
  const y = (value: number) => top + (1 - (value - domain.min) / (domain.max - domain.min)) * (H - top - bottom);
  const zero = y(0);

  useEffect(() => {
    if (!hydrated.current) return;
    const url = new URL(window.location.href);
    url.searchParams.set("chartPeriod", period);
    url.searchParams.set("chartGranularity", granularity);
    url.searchParams.set("chartZoom", String(zoom));
    url.searchParams.set("chartOffset", String(start));
    if (hidden.length) url.searchParams.set("chartHidden", hidden.join(","));
    else url.searchParams.delete("chartHidden");
    window.history.replaceState(window.history.state, "", url);
  }, [period, granularity, zoom, start, hidden]);

  useEffect(() => {
    if (!focus) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape") setFocus(false); };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [focus]);

  const changePeriod = (next: AnalyticsPeriod) => {
    setPeriod(next);
    setGranularity(normalizeGranularity(next, granularity));
    setZoom(1);
    setOffset(0);
  };
  const toggleSeries = (id: string) => setHidden((current) => {
    if (current.includes(id)) return current.filter((item) => item !== id);
    return view.series.length - current.length <= 1 ? current : [...current, id];
  });
  const downloadCsv = () => {
    const blob = new Blob([chartToCsv({ ...view, series: shown })], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${model.title.toLocaleLowerCase("tr-TR").replaceAll(/[^a-z0-9çğıöşü]+/gi, "-")}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  };
  const downloadExcel = async () => {
    const XLSX = await import("xlsx");
    const exportKeys = [...new Set(shown.flatMap((series) => series.points.map((point) => point.key)))].sort();
    const rows = [["Tarih", "Dönem", ...shown.map((series) => series.label)], ...exportKeys.map((key) => [
      key,
      shown.flatMap((series) => series.points).find((point) => point.key === key)?.label ?? key,
      ...shown.map((series) => series.points.find((point) => point.key === key)?.value ?? null),
    ])];
    const sheet = XLSX.utils.aoa_to_sheet(rows);
    sheet["!cols"] = [{ wch: 14 }, { wch: 20 }, ...shown.map(() => ({ wch: 18 }))];
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, "Ödeme Baskısı");
    XLSX.writeFile(workbook, `${model.title.toLocaleLowerCase("tr-TR").replaceAll(/[^a-z0-9çğıöşü]+/gi, "-")}.xlsx`);
  };
  const emptySeries = view.series.filter((series) => series.points.every((point) => point.value == null || point.value === 0));

  // Selected-period readout: totals for flow series, endpoint for balance series.
  // Computed over the full selected window (period + granularity), independent of zoom pan.
  const periodSummary = useMemo(() => {
    if (!model.summaryMode) return null;
    const visible = granularView.series.filter((series) => !hidden.includes(series.id));
    const rows = visible.map((series) => {
      const nums = series.points.map((point) => point.value).filter((value): value is number => value != null);
      const value = model.summaryMode === "sum"
        ? (nums.length ? nums.reduce((total, current) => total + current, 0) : null)
        : ([...series.points].reverse().find((point) => point.value != null)?.value ?? null);
      return { id: series.id, label: series.label, tone: series.tone, value, format: series.format };
    });
    const grandTotal = model.summaryMode === "sum" && model.preferredView === "stacked" && visible.length > 1
      ? rows.reduce((total, row) => total + (row.value ?? 0), 0)
      : null;
    return { rows, grandTotal, format: visible[0]?.format ?? ("currency" as const) };
  }, [granularView, hidden, model.summaryMode, model.preferredView]);

  return <section className={`analytics-chart ${focus ? "chart-focus-mode" : ""}`} aria-label={model.title} role={focus ? "dialog" : undefined} aria-modal={focus || undefined}>
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><h3 className="text-sm font-semibold">{model.title}</h3><p className="max-w-2xl text-xs text-tone-3">{model.description}</p></div>
      <div className="chart-toolbar flex flex-wrap gap-1" aria-label="Grafik araçları">
        {periodOptions.map(([value, label]) => <button key={value} type="button" onClick={() => changePeriod(value)} aria-pressed={period === value} className={period === value ? "button-accent px-2 py-1" : "button-ghost px-2 py-1"}>{label}</button>)}
        <span className="mx-1 hidden h-6 border-l border-line sm:block" aria-hidden />
        <button type="button" onClick={() => setZoom((value) => Math.min(12, value + 1))} className="button-ghost px-2 py-1" aria-label="Grafiği yakınlaştır">Yakınlaştır +</button>
        <button type="button" onClick={() => setZoom((value) => Math.max(1, value - 1))} className="button-ghost px-2 py-1" aria-label="Grafiği uzaklaştır">Uzaklaştır −</button>
        <button type="button" onClick={() => { setZoom(1); setOffset(0); }} className="button-ghost px-2 py-1">Sıfırla</button>
        <button type="button" onClick={() => setFocus((value) => !value)} className="button-ghost px-2 py-1">{focus ? "Odak modunu kapat" : "Odak modu"}</button>
        <button type="button" onClick={downloadCsv} className="button-ghost px-2 py-1">CSV</button>
        <button type="button" onClick={downloadExcel} className="button-ghost px-2 py-1">Excel</button>
      </div>
    </div>
    {model.availableGranularities && <div className="mt-3 flex flex-wrap items-center gap-1" aria-label="Zaman çözünürlüğü">
      <span className="mr-1 text-[10px] uppercase tracking-wider text-tone-3">Çözünürlük</span>
      {GRANULARITIES.filter(([value]) => granularityOptions.includes(value)).map(([value, label]) => <button key={value} type="button" onClick={() => { setGranularity(value); setZoom(1); setOffset(0); }} aria-pressed={granularity === value} className={granularity === value ? "button-accent px-2 py-1" : "button-ghost px-2 py-1"}>{label}</button>)}
    </div>}
    {periodSummary && periodSummary.rows.length > 0 && <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 border px-3 py-2 text-xs" style={{ background: "var(--surface-2)", borderColor: "var(--line)", borderRadius: "var(--radius-md)" }} aria-label="Seçili dönem özeti">
      <span className="text-[10px] uppercase tracking-wider text-tone-3">{model.summaryMode === "sum" ? "Seçili dönem toplamı" : "Seçili dönem sonu"}</span>
      {periodSummary.rows.map((row) => <span key={row.id} className="font-mono tabular-nums text-tone-2">{row.label}: <b style={{ color: COLORS[row.tone] }}>{formatChartValue(row.value, row.format)}</b></span>)}
      {periodSummary.grandTotal != null && <span className="font-mono tabular-nums text-tone-2">Toplam ödeme: <b style={{ color: "var(--neg)" }}>{formatChartValue(periodSummary.grandTotal, periodSummary.format)}</b></span>}
    </div>}
    <div className="mt-3 flex flex-wrap gap-2" aria-label="Grafik serileri">
      {view.series.map((series) => <button type="button" key={series.id} onDoubleClick={() => setHidden(view.series.filter((item) => item.id !== series.id).map((item) => item.id))} onClick={() => toggleSeries(series.id)} aria-pressed={!hidden.includes(series.id)} className="button-ghost px-2 py-1">
        <span className="mr-1 inline-block h-2.5 w-2.5 border" style={{ background: COLORS[series.tone], borderColor: series.id === "partial" ? "white" : COLORS[series.tone], borderRadius: series.id === "partial" ? "50%" : 0 }} aria-hidden />
        {series.label}{emptySeries.some((item) => item.id === series.id) && <span className="ml-1 text-tone-3">· bu dönemde kayıt yok</span>}
      </button>)}
    </div>
    <p className="sr-only">{chartSummary(view)}</p>
    {shown.length === 0 || keys.length === 0
      ? <div className="mt-3 border border-dashed border-line p-6 text-center text-sm text-tone-3">Seçilen dönemde gösterilecek kayıt yok.</div>
      : <div className="relative mt-2 overflow-x-auto">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full min-w-[720px]" role="img" aria-label={chartSummary(view)}>
          <defs><pattern id="unknown-hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="6" stroke="var(--text-3)" strokeWidth="2" /></pattern></defs>
          {[0, .25, .5, .75, 1].map((tick) => { const value = domain.max - (domain.max - domain.min) * tick; const yy = top + (H - top - bottom) * tick; return <g key={tick}><line x1={left} x2={W - right} y1={yy} y2={yy} stroke="var(--line-faint)" /><text x={left - 8} y={yy + 3} textAnchor="end" fontSize="10" fill="var(--text-4)">{new Intl.NumberFormat("tr-TR", { notation: "compact", maximumFractionDigits: 1 }).format(value)}</text></g>; })}
          {kind === "bar" && model.preferredView === "stacked"
            ? <StackedBars series={shown} keys={keys} x={x} y={y} onTip={setTip} annotations={model.annotations} />
            : shown.map((series, index) => kind === "line" ? <LineSeries key={series.id} series={series} keys={keys} x={x} y={y} onTip={setTip} /> : <GroupedBars key={series.id} series={series} keys={keys} seriesIndex={index} seriesCount={shown.length} x={x} y={y} zero={zero} onTip={setTip} />)}
          {keys.map((key, index) => index % Math.max(1, Math.ceil(keys.length / 9)) === 0 ? <text key={key} x={x(index)} y={H - 16} textAnchor="middle" fontSize="10" fill="var(--text-4)">{shown.flatMap((series) => series.points).find((point) => point.key === key)?.label ?? key}</text> : null)}
        </svg>
        {tip && <div className="chart-tooltip" role="status">{tip}</div>}
      </div>}
    {zoom > 1 && allKeys.length > 2 && <div className="mt-2 flex items-center gap-2"><button type="button" className="button-ghost px-2 py-1" onClick={() => setOffset((value) => Math.max(0, value - 1))} disabled={start === 0}>←</button><input aria-label="Grafik görünür aralığı" type="range" min="0" max={maxOffset} value={start} onChange={(event) => setOffset(Number(event.target.value))} className="min-w-0 flex-1" /><button type="button" className="button-ghost px-2 py-1" onClick={() => setOffset((value) => Math.min(maxOffset, value + 1))} disabled={start === maxOffset}>→</button></div>}
    {model.unknownCount > 0 && <p className="mt-2 text-xs text-warn">▧ {model.unknownCount} tutarı bilinmeyen kayıt sıfır kabul edilmedi.</p>}
    <details className="mt-3"><summary className="cursor-pointer text-xs text-info">Erişilebilir veri tablosu</summary><AccessibleChartTable model={{ ...view, series: shown }} /></details>
    <p className="mt-2 text-[10px] text-tone-3">Kaynak: {model.sourceLabel} · itibarıyla {model.asOf}</p>
  </section>;
}

function tooltipText(series: ChartSeries, point: ChartSeries["points"][number]) {
  const meta = point.meta ?? {};
  const count = Number(meta.overdueCount ?? 0) + Number(meta.partialCount ?? 0) + Number(meta.plannedCount ?? 0);
  const extras = [count ? `${count} kayıt` : null, meta.criticalCount ? `${meta.criticalCount} kritik` : null, meta.unknownAmountCount ? `${meta.unknownAmountCount} tutar eksik` : null, meta.foreignCurrencyCount ? `${meta.foreignCurrencyCount} dövizli` : null].filter(Boolean).join(" · ");
  return `${point.label} · ${series.label}: ${formatChartValue(point.value, series.format)}${extras ? ` · ${extras}` : ""}${point.statusReason ? ` · ${point.statusReason}` : ""}`;
}

function StackedBars({ series, keys, x, y, onTip, annotations }: { series: ChartSeries[]; keys: string[]; x: (index: number) => number; y: (value: number) => number; onTip: (tip: string | null) => void; annotations: ChartModel["annotations"] }) {
  const width = Math.max(5, Math.min(38, 680 / Math.max(keys.length, 1)));
  return <g>{keys.map((key, index) => {
    let cumulative = 0;
    const points = series.map((item) => ({ series: item, point: item.points.find((point) => point.key === key) }));
    const unknown = points.some(({ point }) => point?.value == null && Number(point?.meta?.unknownAmountCount ?? 0) > 0);
    const annotation = annotations.find((item) => item.pointKey === key);
    return <g key={key}>{points.map(({ series: item, point }) => {
      if (point?.value == null || point.value <= 0) return null;
      const from = cumulative; cumulative += point.value;
      const yy = y(cumulative), base = y(from), title = tooltipText(item, point);
      return <a key={item.id} href={point.href} tabIndex={0} aria-label={title} onMouseEnter={() => onTip(title)} onMouseLeave={() => onTip(null)} onFocus={() => onTip(title)} onBlur={() => onTip(null)}><rect x={x(index) - width / 2} y={yy} width={width} height={Math.max(2, base - yy)} fill={COLORS[item.tone]} stroke={item.id === "partial" ? "white" : "none"} strokeWidth={item.id === "partial" ? 1 : 0}><title>{title}</title></rect></a>;
    })}{unknown && <rect x={x(index) - width / 2} y={Math.max(8, y(cumulative) - 9)} width={width} height="7" fill="url(#unknown-hatch)"><title>Tutarı bilinmeyen kayıt var</title></rect>}{annotation && <a href={annotation.href}><path d={`M ${x(index)} ${Math.max(9, y(cumulative) - 13)} l -5 -8 h 10 z`} fill="var(--neg)"><title>{annotation.label}</title></path></a>}</g>;
  })}</g>;
}

function LineSeries({ series, keys, x, y, onTip }: { series: ChartSeries; keys: string[]; x: (index: number) => number; y: (value: number) => number; onTip: (tip: string | null) => void }) {
  const points = keys.map((key, index) => { const point = series.points.find((item) => item.key === key); return point?.value == null ? null : `${x(index)},${y(point.value)}`; });
  return <g><polyline points={points.filter(Boolean).join(" ")} fill="none" stroke={COLORS[series.tone]} strokeWidth="2.5" strokeDasharray={series.dashed ? "6 4" : undefined} />{keys.map((key, index) => { const point = series.points.find((item) => item.key === key); if (point?.value == null) return null; const title = tooltipText(series, point); return <a key={key} href={point.href} tabIndex={0} aria-label={title} onMouseEnter={() => onTip(title)} onMouseLeave={() => onTip(null)} onFocus={() => onTip(title)} onBlur={() => onTip(null)}><circle cx={x(index)} cy={y(point.value)} r="5" fill={COLORS[series.tone]}><title>{title}</title></circle></a>; })}</g>;
}

function GroupedBars({ series, keys, seriesIndex, seriesCount, x, y, zero, onTip }: { series: ChartSeries; keys: string[]; seriesIndex: number; seriesCount: number; x: (index: number) => number; y: (value: number) => number; zero: number; onTip: (tip: string | null) => void }) {
  const width = Math.max(4, Math.min(28, 650 / Math.max(keys.length, 1) / seriesCount));
  return <g>{keys.map((key, index) => { const point = series.points.find((item) => item.key === key); if (point?.value == null) return null; const yy = y(point.value), title = tooltipText(series, point); return <a key={key} href={point.href} tabIndex={0} aria-label={title} onMouseEnter={() => onTip(title)} onMouseLeave={() => onTip(null)} onFocus={() => onTip(title)} onBlur={() => onTip(null)}><rect x={x(index) - (seriesCount * width) / 2 + seriesIndex * width} y={Math.min(yy, zero)} width={Math.max(4, width - 2)} height={Math.max(Math.abs(zero - yy), point.value === 0 ? 0 : 2)} fill={COLORS[series.tone]}><title>{title}</title></rect></a>; })}</g>;
}

function AccessibleChartTable({ model }: { model: ChartModel }) {
  const keys = [...new Set(model.series.flatMap((series) => series.points.map((point) => point.key)))].sort();
  return <div className="mt-2 overflow-x-auto"><table className="w-full text-xs"><thead><tr><th>Dönem</th>{model.series.map((series) => <th key={series.id} className="text-right">{series.label}</th>)}</tr></thead><tbody>{keys.map((key) => <tr key={key} className="border-t border-line-faint"><td className="py-1">{model.series.flatMap((series) => series.points).find((point) => point.key === key)?.label ?? key}</td>{model.series.map((series) => { const point = series.points.find((item) => item.key === key); return <td key={series.id} className="text-right">{formatChartValue(point?.value ?? null, series.format)}{Number(point?.meta?.unknownAmountCount ?? 0) > 0 ? " · tutar eksik" : ""}</td>; })}</tr>)}</tbody></table></div>;
}
