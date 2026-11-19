"use client";

import { useMemo, useRef, useState } from "react";
import { Download, FileCode2, FileSpreadsheet, ImageDown, Printer } from "lucide-react";
import type { HeatmapModel, TreemapModel, WaterfallModel } from "@/lib/analytics/chart-types";
import { formatMetric } from "@/lib/analytics/analyses";
import type { MetricFormat } from "@/lib/analytics/registry";
import type { ChartFormat, ChartTone } from "@/lib/analytics/chart";

const COLORS: Record<ChartTone, string> = {
  positive: "var(--pos)",
  negative: "var(--neg)",
  warning: "var(--warn)",
  info: "var(--info)",
  neutral: "var(--text-3)",
  scenario: "var(--accent)",
};

const asMetricFormat = (f: ChartFormat): MetricFormat =>
  f === "currency" ? "currency" : f === "percent" ? "percent" : f === "count" || f === "minutes" ? "count" : "ratio";

function resolveSvgCssVariables(sourceSvg: SVGSVGElement): string {
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
    const token = el.getAttribute("data-token");
    if (token && !el.getAttribute("fill")?.startsWith("#")) {
      const val = computed.getPropertyValue(token).trim();
      if (val) el.setAttribute("fill", val);
    }
    for (const attr of ["fill", "stroke", "stop-color", "color", "style"]) {
      const val = el.getAttribute(attr);
      const next = replaceVars(val);
      if (next && next !== val) el.setAttribute(attr, next);
    }
  }
  clone.style.background = "#FFFFFF";
  return new XMLSerializer().serializeToString(clone);
}

function useSvgDownload() {
  const ref = useRef<SVGSVGElement | null>(null);

  const saveBlob = (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const downloadSvg = (name: string) => {
    if (!ref.current) return;
    const text = resolveSvgCssVariables(ref.current);
    saveBlob(new Blob([text], { type: "image/svg+xml;charset=utf-8" }), `${name}.svg`);
  };

  const downloadPng = (name: string) => {
    if (!ref.current) return;
    const text = resolveSvgCssVariables(ref.current);
    const vb = ref.current.viewBox.baseVal;
    const width = vb?.width || 920;
    const height = vb?.height || 380;
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(width * 2));
      canvas.height = Math.max(1, Math.round(height * 2));
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.fillStyle = "#FFFFFF";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      canvas.toBlob((blob) => {
        if (blob) saveBlob(blob, `${name}.png`);
      }, "image/png");
    };
    img.src = "data:image/svg+xml;base64," + btoa(unescape(encodeURIComponent(text)));
  };

  return { ref, downloadSvg, downloadPng };
}

function ExportBar({ name, onSvg, onPng }: { name: string; onSvg: () => void; onPng: () => void }) {
  return (
    <span className="flex flex-wrap items-center gap-1">
      <button type="button" onClick={onPng} className="button-ghost px-2 py-1 text-[11px]">
        <ImageDown size={13} strokeWidth={1.75} aria-hidden />
        <span>PNG</span>
      </button>
      <button type="button" onClick={onSvg} className="button-ghost px-2 py-1 text-[11px]">
        <FileCode2 size={13} strokeWidth={1.75} aria-hidden />
        <span>SVG</span>
      </button>
      <a
        href={`/api/analytics/export?analysis=${encodeURIComponent(name)}&format=xlsx`}
        download
        data-no-nav-skeleton="true"
        className="button-ghost px-2 py-1 text-[11px]"
      >
        <FileSpreadsheet size={13} strokeWidth={1.75} aria-hidden />
        <span>Excel</span>
      </a>
      <a
        href={`/api/analytics/export?analysis=${encodeURIComponent(name)}&format=csv`}
        download
        data-no-nav-skeleton="true"
        className="button-ghost px-2 py-1 text-[11px]"
      >
        <Download size={13} strokeWidth={1.75} aria-hidden />
        <span>CSV</span>
      </a>
      <button type="button" onClick={() => window.print()} className="button-ghost px-2 py-1 text-[11px]">
        <Printer size={13} strokeWidth={1.75} aria-hidden />
        <span>PDF</span>
      </button>
    </span>
  );
}

const Footer = ({ source, asOf, unknown }: { source: string; asOf: string; unknown: number }) => (
  <p className="mt-2.5 text-[11px]" style={{ color: "var(--text-3)" }}>
    Kaynak: {source} · <span className="font-mono">{asOf}</span> itibarıyla
    {unknown > 0 ? ` · ${unknown} bilinmeyen değer hesaba katılmadı` : ""}
  </p>
);

const compactNumber = (n: number) =>
  new Intl.NumberFormat("tr-TR", { notation: "compact", maximumFractionDigits: 1 }).format(n);

/* ── 1. WaterfallChart: True CFO Cash & Variance Bridge (M-04) ─────────────────────────── */

export function WaterfallChart({ model, exportKey }: { model: WaterfallModel; exportKey: string }) {
  const { ref, downloadSvg, downloadPng } = useSvgDownload();
  const [hoveredKey, setHoveredKey] = useState<string | null>(null);

  const W = 920;
  const H = 370;
  const PL = 72;
  const PR = 20;
  const PT = 30;
  const PB = 66;
  const plotW = W - PL - PR;
  const plotH = H - PT - PB;

  const rawMin = Math.min(0, model.min, ...model.bars.flatMap((b) => [b.from, b.to]));
  const rawMax = Math.max(0, model.max, ...model.bars.flatMap((b) => [b.from, b.to]));
  const domainMax = rawMax > 0 ? rawMax * 1.18 : 1;
  const domainMin = rawMin < 0 ? rawMin * 1.18 : 0;
  const span = Math.max(domainMax - domainMin, 1e-9);

  const yOf = (v: number) => PT + plotH - ((v - domainMin) / span) * plotH;
  const zeroY = yOf(0);
  const step = model.bars.length ? plotW / model.bars.length : 0;
  const barW = Math.max(12, Math.min(64, step * 0.6));
  const fmt = asMetricFormat(model.format);

  const hoveredBar = useMemo(() => model.bars.find((b) => b.key === hoveredKey) ?? null, [model.bars, hoveredKey]);

  return (
    <div className="relative">
      <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
        <span className="text-[12.5px]" style={{ color: "var(--text-2)" }}>
          {model.description}
        </span>
        <ExportBar name={exportKey} onSvg={() => downloadSvg(exportKey)} onPng={() => downloadPng(exportKey)} />
      </div>

      {/* Legend pills */}
      <div className="mb-2 flex flex-wrap items-center gap-3 text-[11px]" style={{ color: "var(--text-3)" }}>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-[2px]" style={{ background: "var(--info)" }} aria-hidden />
          <span>Açılış / Net Kapanış Sütunu</span>
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-[2px]" style={{ background: "var(--pos)" }} aria-hidden />
          <span>Pozitif Katkı / Nakit Girişi</span>
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-[2px]" style={{ background: "var(--neg)" }} aria-hidden />
          <span>Negatif Sapma / Nakit Çıkışı</span>
        </span>
      </div>

      <div className="overflow-x-auto">
        <svg
          ref={ref}
          viewBox={`0 0 ${W} ${H}`}
          className="block w-full min-w-[520px]"
          role="img"
          aria-label={`${model.title} şelale grafiği`}
        >
          {/* Y-axis ticks & gridlines */}
          {[0, 0.25, 0.5, 0.75, 1].map((tick) => {
            const val = domainMax - span * tick;
            const yy = PT + plotH * tick;
            return (
              <g key={tick}>
                <line x1={PL} y1={yy} x2={W - PR} y2={yy} stroke="var(--line-faint)" strokeWidth={1} />
                <text x={PL - 8} y={yy + 3.5} textAnchor="end" fontSize={11} fontWeight={500} fill="var(--text-3)">
                  {compactNumber(val)}
                </text>
              </g>
            );
          })}

          {/* Explicit y = 0 axis */}
          <line x1={PL} y1={zeroY} x2={W - PR} y2={zeroY} stroke="var(--line-strong)" strokeWidth={1.3} />

          {/* Dashed step-connector lines between consecutive waterfall bars */}
          {model.bars.map((bar, i) => {
            const next = model.bars[i + 1];
            if (!next) return null;
            const x1 = PL + i * step + step / 2 + barW / 2;
            const x2 = PL + (i + 1) * step + step / 2 - barW / 2;
            const connectorY = yOf(bar.to);
            return (
              <line
                key={`conn-${bar.key}`}
                x1={x1}
                y1={connectorY}
                x2={x2}
                y2={connectorY}
                stroke="var(--text-4)"
                strokeWidth={1.15}
                strokeDasharray="3 3"
              />
            );
          })}

          {/* Floating Cumulative & Anchor Bars */}
          {model.bars.map((bar, i) => {
            const cx = PL + i * step + step / 2;
            const isAnchor = bar.kind === "start" || bar.kind === "end";
            const baseFrom = isAnchor ? 0 : bar.from;
            const yA = yOf(baseFrom);
            const yB = yOf(bar.to);
            const yTop = Math.min(yA, yB);
            const yBot = Math.max(yA, yB);
            const h = Math.max(2.5, yBot - yTop);
            const fillColor = isAnchor ? "var(--info)" : COLORS[bar.tone];
            const isDecrease = !isAnchor && (bar.kind === "decrease" || (bar.value ?? 0) < 0);
            const labelY = isDecrease ? Math.min(H - PB - 4, yBot + 14) : Math.max(14, yTop - 6);
            const signPrefix =
              !isAnchor && bar.value != null && bar.value > 0 ? "+" : "";

            return (
              <g
                key={bar.key}
                className="cursor-pointer"
                onPointerEnter={() => setHoveredKey(bar.key)}
                onPointerLeave={() => setHoveredKey((cur) => (cur === bar.key ? null : cur))}
              >
                <rect
                  x={cx - barW / 2}
                  y={yTop}
                  width={barW}
                  height={h}
                  rx={2.5}
                  fill={fillColor}
                  fillOpacity={hoveredKey === bar.key ? 1 : isAnchor ? 0.92 : 0.86}
                  stroke={isAnchor ? "var(--text-1)" : fillColor}
                  strokeWidth={hoveredKey === bar.key ? 1.5 : 0.6}
                />
                <text
                  x={cx}
                  y={labelY}
                  textAnchor="middle"
                  fontSize={10.5}
                  fontWeight={650}
                  fill={isAnchor ? "var(--info)" : isDecrease ? "var(--neg)" : "var(--pos)"}
                >
                  {signPrefix}
                  {formatMetric(bar.value, fmt)}
                </text>
                <text
                  x={cx}
                  y={H - PB + 18}
                  textAnchor="middle"
                  fontSize={11}
                  fontWeight={isAnchor ? 700 : 500}
                  fill={isAnchor ? "var(--text-1)" : "var(--text-2)"}
                >
                  {bar.label.length > 15 ? bar.label.slice(0, 14) + "…" : bar.label}
                </text>
                {isAnchor && (
                  <text x={cx} y={H - PB + 32} textAnchor="middle" fontSize={9.5} fill="var(--text-3)">
                    {bar.kind === "start" ? "Açılış" : "Kapanış"}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
      </div>

      {/* Hover Detail Card */}
      {hoveredBar && (
        <div
          className="mt-2 flex flex-wrap items-center justify-between gap-3 border px-3 py-2 text-[12px]"
          style={{
            background: "var(--surface-2)",
            borderColor: "var(--line)",
            borderRadius: "var(--radius-md)",
          }}
          role="status"
        >
          <div className="flex items-center gap-2">
            <strong style={{ color: "var(--text-1)" }}>{hoveredBar.label}</strong>
            <span style={{ color: "var(--text-3)" }}>
              ({hoveredBar.kind === "start" ? "Açılış Bakiyesi" : hoveredBar.kind === "end" ? "Net Kapanış" : "Dönem Değişimi"})
            </span>
          </div>
          <div className="flex flex-wrap items-center gap-4 tabular-nums">
            <span>
              Etki: <b style={{ color: COLORS[hoveredBar.tone] }}>{formatMetric(hoveredBar.value, fmt)}</b>
            </span>
            <span>
              Kümülatif Bakiye: <b style={{ color: "var(--text-1)" }}>{formatMetric(hoveredBar.to, fmt)}</b>
            </span>
          </div>
        </div>
      )}

      <Footer source={model.sourceLabel} asOf={model.asOf} unknown={model.unknownCount} />
    </div>
  );
}

/* ── 2. HeatmapChart: Cream-to-Amber-to-Crimson Ageing Matrix with Row/Col Totals (M-06) ── */

function heatmapCellStyle(intensity: number, isSevereCol: boolean): { fill: string; text: string } {
  if (isSevereCol && intensity > 0.15) {
    return intensity >= 0.5
      ? { fill: "#B42318", text: "#FFFFFF" }
      : { fill: "#F9D7D4", text: "#7A160E" };
  }
  if (intensity >= 0.78) return { fill: "#B42318", text: "#FFFFFF" };
  if (intensity >= 0.54) return { fill: "#C2510A", text: "#FFFFFF" };
  if (intensity >= 0.3) return { fill: "#F6D58E", text: "#141210" };
  if (intensity > 0.02) return { fill: "#FBF0D4", text: "#141210" };
  return { fill: "#FAF8F3", text: "#6E675F" };
}

export function HeatmapChart({ model, exportKey }: { model: HeatmapModel; exportKey: string }) {
  const { ref, downloadSvg, downloadPng } = useSvgDownload();
  const [hoveredCell, setHoveredCell] = useState<{ row: string; col: string; val: number | null } | null>(null);

  const fmt = asMetricFormat(model.format);
  const hasTotals = model.rows.length > 0 && model.columns.length > 0;
  const totalColsCount = model.columns.length + (hasTotals ? 1 : 0);
  const totalRowsCount = model.rows.length + (hasTotals ? 1 : 0);

  const W = 940;
  const PL = 168;
  const PR = 18;
  const PT = 36;
  const PB = 20;
  const ch = 42;
  const H = PT + PB + Math.max(1, totalRowsCount) * ch;
  const cw = totalColsCount ? (W - PL - PR) / totalColsCount : 0;

  const rowTotals = useMemo(() => {
    const map = new Map<string, number>();
    for (const r of model.rows) {
      const sum = model.cells
        .filter((c) => c.rowKey === r.key && c.value != null)
        .reduce((acc, c) => acc + (c.value ?? 0), 0);
      map.set(r.key, sum);
    }
    return map;
  }, [model.rows, model.cells]);

  const colTotals = useMemo(() => {
    const map = new Map<string, number>();
    for (const col of model.columns) {
      const sum = model.cells
        .filter((c) => c.columnKey === col.key && c.value != null)
        .reduce((acc, c) => acc + (c.value ?? 0), 0);
      map.set(col.key, sum);
    }
    return map;
  }, [model.columns, model.cells]);

  const grandTotal = useMemo(() => {
    let total = 0;
    for (const v of rowTotals.values()) total += v;
    return total;
  }, [rowTotals]);

  return (
    <div>
      <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
        <span className="text-[12.5px]" style={{ color: "var(--text-2)" }}>
          {model.description}
        </span>
        <ExportBar name={exportKey} onSvg={() => downloadSvg(exportKey)} onPng={() => downloadPng(exportKey)} />
      </div>

      {/* Color Scale Legend */}
      <div className="mb-2 flex flex-wrap items-center gap-3 text-[11px]" style={{ color: "var(--text-3)" }}>
        <span>Yoğunluk skalası:</span>
        <span className="inline-flex items-center gap-1">
          <span className="h-3 w-4 rounded-[2px] border" style={{ background: "#FAF8F3", borderColor: "var(--line)" }} />
          <span>Düşük</span>
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="h-3 w-4 rounded-[2px]" style={{ background: "#F6D58E" }} />
          <span>Orta</span>
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="h-3 w-4 rounded-[2px]" style={{ background: "#C2510A" }} />
          <span>Yüksek</span>
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="h-3 w-4 rounded-[2px]" style={{ background: "#B42318" }} />
          <span>Kritik / 90+ Gün</span>
        </span>
      </div>

      <div className="overflow-x-auto">
        <svg
          ref={ref}
          viewBox={`0 0 ${W} ${H}`}
          className="block w-full min-w-[580px]"
          role="img"
          aria-label={`${model.title} ısı haritası`}
        >
          {/* Column Headers */}
          {model.columns.map((c, ci) => (
            <text
              key={c.key}
              x={PL + ci * cw + cw / 2}
              y={PT - 11}
              textAnchor="middle"
              fontSize={11}
              fontWeight={600}
              fill="var(--text-2)"
            >
              {c.label.slice(0, 18)}
            </text>
          ))}
          {hasTotals && (
            <text
              x={PL + model.columns.length * cw + cw / 2}
              y={PT - 11}
              textAnchor="middle"
              fontSize={11}
              fontWeight={700}
              fill="var(--text-1)"
            >
              Toplam
            </text>
          )}

          {/* Matrix Rows */}
          {model.rows.map((r, ri) => {
            const y = PT + ri * ch;
            const rTotal = rowTotals.get(r.key) ?? 0;
            return (
              <g key={r.key}>
                <text
                  x={PL - 10}
                  y={y + ch / 2 + 4}
                  textAnchor="end"
                  fontSize={11.5}
                  fontWeight={600}
                  fill="var(--text-1)"
                >
                  {r.label.length > 23 ? r.label.slice(0, 22) + "…" : r.label}
                </text>
                {model.columns.map((c, ci) => {
                  const cell = model.cells.find((x) => x.rowKey === r.key && x.columnKey === c.key);
                  const x = PL + ci * cw;
                  const isSevereCol = /90\+|90|gecik|vadesi/i.test(`${c.key} ${c.label}`);
                  if (!cell || cell.intensity == null) {
                    return (
                      <g key={c.key}>
                        <rect
                          x={x + 1}
                          y={y + 1}
                          width={Math.max(0, cw - 2)}
                          height={ch - 2}
                          rx={3}
                          fill="#FAF8F3"
                          stroke="var(--line)"
                          strokeDasharray="3 3"
                        />
                        <text x={x + cw / 2} y={y + ch / 2 + 4} textAnchor="middle" fontSize={11} fill="var(--text-3)">
                          —
                        </text>
                      </g>
                    );
                  }
                  const { fill, text } = heatmapCellStyle(cell.intensity, isSevereCol);
                  return (
                    <g
                      key={c.key}
                      className="cursor-pointer"
                      onPointerEnter={() => setHoveredCell({ row: r.label, col: c.label, val: cell.value })}
                      onPointerLeave={() => setHoveredCell(null)}
                    >
                      <rect
                        x={x + 1}
                        y={y + 1}
                        width={Math.max(0, cw - 2)}
                        height={ch - 2}
                        rx={3}
                        fill={fill}
                        stroke="#FFFFFF"
                        strokeWidth={1}
                      />
                      <text
                        x={x + cw / 2}
                        y={y + ch / 2 + 4}
                        textAnchor="middle"
                        fontSize={11}
                        fontWeight={600}
                        fill={text}
                      >
                        {formatMetric(cell.value, fmt)}
                      </text>
                    </g>
                  );
                })}

                {/* Row Total Cell */}
                {hasTotals && (
                  <g>
                    <rect
                      x={PL + model.columns.length * cw + 1}
                      y={y + 1}
                      width={Math.max(0, cw - 2)}
                      height={ch - 2}
                      rx={3}
                      fill="#F0ECE3"
                    />
                    <text
                      x={PL + model.columns.length * cw + cw / 2}
                      y={y + ch / 2 + 4}
                      textAnchor="middle"
                      fontSize={11}
                      fontWeight={700}
                      fill="#141210"
                    >
                      {formatMetric(rTotal, fmt)}
                    </text>
                  </g>
                )}
              </g>
            );
          })}

          {/* Column Totals Footer Row */}
          {hasTotals && (
            <g>
              <text
                x={PL - 10}
                y={PT + model.rows.length * ch + ch / 2 + 4}
                textAnchor="end"
                fontSize={11.5}
                fontWeight={700}
                fill="var(--text-1)"
              >
                Toplam
              </text>
              {model.columns.map((c, ci) => {
                const x = PL + ci * cw;
                const y = PT + model.rows.length * ch;
                const cTotal = colTotals.get(c.key) ?? 0;
                return (
                  <g key={`tot-${c.key}`}>
                    <rect x={x + 1} y={y + 1} width={Math.max(0, cw - 2)} height={ch - 2} rx={3} fill="#F0ECE3" />
                    <text x={x + cw / 2} y={y + ch / 2 + 4} textAnchor="middle" fontSize={11} fontWeight={700} fill="#141210">
                      {formatMetric(cTotal, fmt)}
                    </text>
                  </g>
                );
              })}
              <g>
                <rect
                  x={PL + model.columns.length * cw + 1}
                  y={PT + model.rows.length * ch + 1}
                  width={Math.max(0, cw - 2)}
                  height={ch - 2}
                  rx={3}
                  fill="#E4DEC9"
                />
                <text
                  x={PL + model.columns.length * cw + cw / 2}
                  y={PT + model.rows.length * ch + ch / 2 + 4}
                  textAnchor="middle"
                  fontSize={11}
                  fontWeight={700}
                  fill="#141210"
                >
                  {formatMetric(grandTotal, fmt)}
                </text>
              </g>
            </g>
          )}
        </svg>
      </div>

      {hoveredCell && (
        <div
          className="mt-2 flex flex-wrap items-center justify-between gap-2 border px-3 py-1.5 text-[12px]"
          style={{ background: "var(--surface-2)", borderColor: "var(--line)", borderRadius: "var(--radius-md)" }}
          role="status"
        >
          <span>
            <strong style={{ color: "var(--text-1)" }}>{hoveredCell.row}</strong> · {hoveredCell.col}
          </span>
          <strong className="tabular-nums" style={{ color: "var(--text-1)" }}>
            {formatMetric(hoveredCell.val, fmt)}
          </strong>
        </div>
      )}

      <Footer source={model.sourceLabel} asOf={model.asOf} unknown={model.unknownCount} />
    </div>
  );
}

/* ── 3. TreemapChart: True Squarified Treemap Algorithm (aspect ratio -> 1) (M-05) ──────── */

interface SquarifiedTile {
  tile: TreemapModel["tiles"][number];
  px: number;
  py: number;
  pw: number;
  ph: number;
}

function computeSquarifiedLayout(tiles: TreemapModel["tiles"], width: number, height: number): SquarifiedTile[] {
  const positive = tiles
    .map((tile) => ({
      tile,
      weight: Math.max(0, tile.value ?? tile.share * 100),
    }))
    .filter((item) => item.weight > 0)
    .sort((a, b) => b.weight - a.weight);

  if (positive.length === 0) return [];
  const totalWeight = positive.reduce((s, x) => s + x.weight, 0);
  const totalArea = width * height;
  const scaled = positive.map((item) => ({
    tile: item.tile,
    area: (item.weight / totalWeight) * totalArea,
  }));

  const out: SquarifiedTile[] = [];
  let rx = 0;
  let ry = 0;
  let rw = width;
  let rh = height;

  const worstAspect = (row: typeof scaled, side: number): number => {
    if (row.length === 0 || side <= 0) return Infinity;
    let sum = 0;
    let maxA = -Infinity;
    let minA = Infinity;
    for (const r of row) {
      sum += r.area;
      if (r.area > maxA) maxA = r.area;
      if (r.area < minA) minA = r.area;
    }
    if (sum <= 0 || minA <= 0) return Infinity;
    const s2 = sum * sum;
    const w2 = side * side;
    return Math.max((w2 * maxA) / s2, s2 / (w2 * minA));
  };

  const flushRow = (row: typeof scaled) => {
    if (row.length === 0) return;
    const rowArea = row.reduce((s, r) => s + r.area, 0);
    if (rw >= rh) {
      const stripW = rh > 0 ? rowArea / rh : 0;
      let cy = ry;
      for (const r of row) {
        const itemH = stripW > 0 ? r.area / stripW : 0;
        out.push({ tile: r.tile, px: rx, py: cy, pw: stripW, ph: itemH });
        cy += itemH;
      }
      rx += stripW;
      rw = Math.max(0, rw - stripW);
    } else {
      const stripH = rw > 0 ? rowArea / rw : 0;
      let cx = rx;
      for (const r of row) {
        const itemW = stripH > 0 ? r.area / stripH : 0;
        out.push({ tile: r.tile, px: cx, py: ry, pw: itemW, ph: stripH });
        cx += itemW;
      }
      ry += stripH;
      rh = Math.max(0, rh - stripH);
    }
  };

  let currentRow: typeof scaled = [];
  for (const item of scaled) {
    const shorterSide = Math.max(1, Math.min(rw, rh));
    if (
      currentRow.length === 0 ||
      worstAspect([...currentRow, item], shorterSide) <= worstAspect(currentRow, shorterSide)
    ) {
      currentRow.push(item);
    } else {
      flushRow(currentRow);
      currentRow = [item];
    }
  }
  flushRow(currentRow);
  return out;
}

const TREEMAP_PALETTE: Record<ChartTone, { bg: string; border: string; fg: string; sub: string }> = {
  positive: { bg: "#DCEEE8", border: "#0F6E56", fg: "#094838", sub: "#0F6E56" },
  negative: { bg: "#F9DEDC", border: "#B42318", fg: "#7A160E", sub: "#B42318" },
  warning: { bg: "#FBF0D4", border: "#B54708", fg: "#732D05", sub: "#9A3B07" },
  info: { bg: "#DFEAFC", border: "#1D4ED8", fg: "#13328E", sub: "#1D4ED8" },
  neutral: { bg: "#EDE8DD", border: "#8A8278", fg: "#141210", sub: "#4A453E" },
  scenario: { bg: "#E4ECFD", border: "#1D4ED8", fg: "#13328E", sub: "#1D4ED8" },
};

export function TreemapChart({ model, exportKey }: { model: TreemapModel; exportKey: string }) {
  const { ref, downloadSvg, downloadPng } = useSvgDownload();
  const [hoveredTile, setHoveredTile] = useState<TreemapModel["tiles"][number] | null>(null);

  const W = 920;
  const H = 380;
  const fmt = asMetricFormat(model.format);

  const squarified = useMemo(() => computeSquarifiedLayout(model.tiles, W, H), [model.tiles]);

  return (
    <div>
      <div className="mb-2.5 flex flex-wrap items-center justify-between gap-2">
        <span className="text-[12.5px]" style={{ color: "var(--text-2)" }}>
          {model.description}
        </span>
        <ExportBar name={exportKey} onSvg={() => downloadSvg(exportKey)} onPng={() => downloadPng(exportKey)} />
      </div>

      <div className="overflow-x-auto">
        <svg
          ref={ref}
          viewBox={`0 0 ${W} ${H}`}
          className="block w-full min-w-[500px]"
          role="img"
          aria-label={`${model.title} ağaç haritası`}
        >
          {squarified.map(({ tile: t, px, py, pw, ph }) => {
            const pad = 2;
            const x = px + pad;
            const y = py + pad;
            const w = Math.max(1, pw - pad * 2);
            const h = Math.max(1, ph - pad * 2);
            const pal = TREEMAP_PALETTE[t.tone] ?? TREEMAP_PALETTE.info;
            const isHovered = hoveredTile?.key === t.key;
            return (
              <g
                key={t.key}
                className="cursor-pointer"
                onPointerEnter={() => setHoveredTile(t)}
                onPointerLeave={() => setHoveredTile((cur) => (cur?.key === t.key ? null : cur))}
              >
                <rect
                  x={x}
                  y={y}
                  width={w}
                  height={h}
                  rx={4}
                  fill={pal.bg}
                  stroke={isHovered ? pal.border : "#FFFFFF"}
                  strokeWidth={isHovered ? 2 : 1.5}
                />
                <rect x={x} y={y} width={Math.min(3.5, w)} height={h} rx={1.5} fill={pal.border} opacity={0.85} />
                {w > 64 && h > 34 && (
                  <>
                    <text x={x + 10} y={y + 18} fontSize={12} fontWeight={700} fill={pal.fg}>
                      {t.label.slice(0, Math.max(4, Math.floor((w - 16) / 7)))}
                    </text>
                    <text x={x + 10} y={y + 34} fontSize={11} fontWeight={600} fill={pal.sub}>
                      {formatMetric(t.value, fmt)} · %{(t.share * 100).toFixed(1).replace(".0", "")}
                    </text>
                  </>
                )}
              </g>
            );
          })}
        </svg>
      </div>

      {hoveredTile && (
        <div
          className="mt-2 flex flex-wrap items-center justify-between gap-2 border px-3 py-1.5 text-[12px]"
          style={{ background: "var(--surface-2)", borderColor: "var(--line)", borderRadius: "var(--radius-md)" }}
          role="status"
        >
          <strong style={{ color: "var(--text-1)" }}>{hoveredTile.label}</strong>
          <span className="tabular-nums" style={{ color: "var(--text-2)" }}>
            <b>{formatMetric(hoveredTile.value, fmt)}</b> · Toplam pay: <b>%{(hoveredTile.share * 100).toFixed(1)}</b>
          </span>
        </div>
      )}

      <Footer source={model.sourceLabel} asOf={model.asOf} unknown={model.unknownCount} />
    </div>
  );
}
