"use client";

// Faz 34 — waterfall, heatmap and treemap renderers.
//
// These components DRAW; they do not compute. Every coordinate arrives already laid out by
// src/lib/analytics/chart-types.ts, which is why the geometry has unit tests — a treemap whose
// tiles overlap fails in vitest rather than being noticed by someone squinting at a screen.
//
// All three render inline SVG, so the same markup that appears on screen is what the export path
// rasterises to PNG. One picture, one source.

import { useRef } from "react";
import type { HeatmapModel, TreemapModel, WaterfallModel } from "@/lib/analytics/chart-types";
import { formatMetric } from "@/lib/analytics/analyses";
import type { MetricFormat } from "@/lib/analytics/registry";
import type { ChartFormat, ChartTone } from "@/lib/analytics/chart";

const COLORS: Record<ChartTone, string> = {
  positive: "var(--pos)", negative: "var(--neg)", warning: "var(--warn)",
  info: "var(--info)", neutral: "var(--text-3)", scenario: "var(--accent)",
};

const asMetricFormat = (f: ChartFormat): MetricFormat =>
  f === "currency" ? "currency" : f === "percent" ? "percent"
    : f === "count" || f === "minutes" ? "count" : "ratio";

/**
 * Download the rendered SVG as PNG or SVG.
 *
 * PNG is produced HERE, in the browser, from the SVG already on the page — see
 * src/lib/analytics/export.ts for why that is not done server-side. PDF is left to the browser's
 * own print pipeline (window.print), which is the same reason: no headless-browser dependency to
 * convert a picture the browser is already displaying.
 */
function useSvgDownload() {
  const ref = useRef<SVGSVGElement | null>(null);

  const svgText = () => {
    if (!ref.current) return null;
    const clone = ref.current.cloneNode(true) as SVGSVGElement;
    clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
    // CSS custom properties do not survive serialisation; resolve them to literal colours so the
    // exported file looks the same outside the app.
    const computed = getComputedStyle(document.documentElement);
    clone.querySelectorAll<SVGElement>("[data-token]").forEach((el) => {
      const token = el.getAttribute("data-token");
      if (token) el.setAttribute("fill", computed.getPropertyValue(token).trim() || "#4a5568");
    });
    clone.style.background = "#ffffff";
    return new XMLSerializer().serializeToString(clone);
  };

  const saveBlob = (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    URL.revokeObjectURL(url);
  };

  const downloadSvg = (name: string) => {
    const text = svgText();
    if (text) saveBlob(new Blob([text], { type: "image/svg+xml" }), `${name}.svg`);
  };

  const downloadPng = (name: string) => {
    const text = svgText();
    if (!text || !ref.current) return;
    const { width, height } = ref.current.getBoundingClientRect();
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      // 2x for a readable raster on high-DPI screens and in printed decks.
      canvas.width = Math.max(1, Math.round(width * 2));
      canvas.height = Math.max(1, Math.round(height * 2));
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      canvas.toBlob((blob) => { if (blob) saveBlob(blob, `${name}.png`); }, "image/png");
    };
    img.src = "data:image/svg+xml;base64," + btoa(unescape(encodeURIComponent(text)));
  };

  return { ref, downloadSvg, downloadPng };
}

function ExportBar({ name, onSvg, onPng }: { name: string; onSvg: () => void; onPng: () => void }) {
  return (
    <span className="flex flex-wrap items-center gap-1">
      <button onClick={onPng} className="border border-line-strong px-2 py-1 font-mono text-[10px] uppercase">png</button>
      <button onClick={onSvg} className="border border-line-strong px-2 py-1 font-mono text-[10px] uppercase">svg</button>
      <a href={`/api/analytics/export?analysis=${encodeURIComponent(name)}&format=xlsx`}
         className="border border-line-strong px-2 py-1 font-mono text-[10px] uppercase">xlsx</a>
      <a href={`/api/analytics/export?analysis=${encodeURIComponent(name)}&format=csv`}
         className="border border-line-strong px-2 py-1 font-mono text-[10px] uppercase">csv</a>
      <button onClick={() => window.print()} className="border border-line-strong px-2 py-1 font-mono text-[10px] uppercase">pdf</button>
    </span>
  );
}

const Footer = ({ source, asOf, unknown }: { source: string; asOf: string; unknown: number }) => (
  <p className="mt-2 font-mono text-[10px] text-tone-4">
    Kaynak: {source} · {asOf} itibarıyla
    {/* The unknown count travels with the picture — dropping it turns "12 rows could not be
        measured" into silence. */}
    {unknown > 0 ? ` · ${unknown} bilinmeyen değer hesaba katılmadı` : ""}
  </p>
);

/* ── waterfall ──────────────────────────────────────────────────────────────────────────── */

export function WaterfallChart({ model, exportKey }: { model: WaterfallModel; exportKey: string }) {
  const { ref, downloadSvg, downloadPng } = useSvgDownload();
  const W = 900, H = 340, PL = 64, PR = 16, PT = 16, PB = 64;
  const plotW = W - PL - PR, plotH = H - PT - PB;
  const span = model.max - model.min || 1;
  const yOf = (v: number) => PT + plotH - ((v - model.min) / span) * plotH;
  const step = model.bars.length ? plotW / model.bars.length : 0;
  const barW = Math.max(6, step * 0.62);
  const fmt = asMetricFormat(model.format);

  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="font-mono text-[10px] uppercase tracking-wider text-tone-3">{model.description}</span>
        <ExportBar name={exportKey} onSvg={() => downloadSvg(exportKey)} onPng={() => downloadPng(exportKey)} />
      </div>
      <div className="overflow-x-auto">
        <svg ref={ref} viewBox={`0 0 ${W} ${H}`} className="w-full min-w-[560px]" role="img"
             aria-label={`${model.title} şelale grafiği`}>
          <line x1={PL} y1={yOf(0)} x2={W - PR} y2={yOf(0)} stroke="var(--line)" strokeWidth={1} data-token="--line" />
          {model.bars.map((bar, i) => {
            const cx = PL + i * step + step / 2;
            const yTop = yOf(bar.to), h = Math.max(1, yOf(bar.from) - yTop);
            return (
              <g key={bar.key}>
                <rect x={cx - barW / 2} y={yTop} width={barW} height={h}
                      fill={COLORS[bar.tone]} data-token={`--${bar.tone === "positive" ? "pos" : bar.tone === "negative" ? "neg" : "info"}`} />
                <text x={cx} y={yTop - 4} textAnchor="middle" className="fill-tone-1 font-mono" fontSize={9}>
                  {formatMetric(bar.value, fmt)}
                </text>
                <text x={cx} y={H - PB + 14} textAnchor="middle" className="fill-tone-3 font-mono" fontSize={9}>
                  {bar.label.slice(0, 14)}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
      <Footer source={model.sourceLabel} asOf={model.asOf} unknown={model.unknownCount} />
    </div>
  );
}

/* ── heatmap ────────────────────────────────────────────────────────────────────────────── */

export function HeatmapChart({ model, exportKey }: { model: HeatmapModel; exportKey: string }) {
  const { ref, downloadSvg, downloadPng } = useSvgDownload();
  const W = 900, H = 60 + model.rows.length * 46, PL = 140, PR = 16, PT = 30, PB = 30;
  const cw = model.columns.length ? (W - PL - PR) / model.columns.length : 0;
  const ch = model.rows.length ? (H - PT - PB) / model.rows.length : 0;
  const fmt = asMetricFormat(model.format);

  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="font-mono text-[10px] uppercase tracking-wider text-tone-3">{model.description}</span>
        <ExportBar name={exportKey} onSvg={() => downloadSvg(exportKey)} onPng={() => downloadPng(exportKey)} />
      </div>
      <div className="overflow-x-auto">
        <svg ref={ref} viewBox={`0 0 ${W} ${H}`} className="w-full min-w-[560px]" role="img"
             aria-label={`${model.title} ısı haritası`}>
          {model.columns.map((c, ci) => (
            <text key={c.key} x={PL + ci * cw + cw / 2} y={PT - 10} textAnchor="middle"
                  className="fill-tone-3 font-mono" fontSize={9}>{c.label.slice(0, 16)}</text>
          ))}
          {model.rows.map((r, ri) => (
            <g key={r.key}>
              <text x={PL - 8} y={PT + ri * ch + ch / 2 + 4} textAnchor="end"
                    className="fill-tone-3 font-mono" fontSize={9}>{r.label.slice(0, 22)}</text>
              {model.columns.map((c, ci) => {
                const cell = model.cells.find((x) => x.rowKey === r.key && x.columnKey === c.key);
                const x = PL + ci * cw, y = PT + ri * ch;
                if (!cell || cell.intensity == null) {
                  // Unknown: outlined and dashed, never the coldest colour.
                  return (
                    <g key={c.key}>
                      <rect x={x} y={y} width={cw} height={ch} fill="transparent"
                            stroke="var(--line-faint)" strokeDasharray="3 3" />
                      <text x={x + cw / 2} y={y + ch / 2 + 4} textAnchor="middle"
                            className="fill-tone-4 font-mono" fontSize={10}>—</text>
                    </g>
                  );
                }
                return (
                  <g key={c.key}>
                    <rect x={x} y={y} width={cw} height={ch}
                          fill="var(--info)" fillOpacity={0.12 + cell.intensity * 0.75}
                          stroke="var(--surface-1)" data-token="--info" />
                    <text x={x + cw / 2} y={y + ch / 2 + 4} textAnchor="middle"
                          className="fill-tone-1 font-mono" fontSize={9}>
                      {formatMetric(cell.value, fmt)}
                    </text>
                  </g>
                );
              })}
            </g>
          ))}
        </svg>
      </div>
      <Footer source={model.sourceLabel} asOf={model.asOf} unknown={model.unknownCount} />
    </div>
  );
}

/* ── treemap ────────────────────────────────────────────────────────────────────────────── */

export function TreemapChart({ model, exportKey }: { model: TreemapModel; exportKey: string }) {
  const { ref, downloadSvg, downloadPng } = useSvgDownload();
  const W = 900, H = 380;
  const fmt = asMetricFormat(model.format);

  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="font-mono text-[10px] uppercase tracking-wider text-tone-3">{model.description}</span>
        <ExportBar name={exportKey} onSvg={() => downloadSvg(exportKey)} onPng={() => downloadPng(exportKey)} />
      </div>
      <div className="overflow-x-auto">
        <svg ref={ref} viewBox={`0 0 ${W} ${H}`} className="w-full min-w-[560px]" role="img"
             aria-label={`${model.title} ağaç haritası`}>
          {model.tiles.map((t) => {
            const x = t.x * W, y = t.y * H, w = t.width * W, h = t.height * H;
            return (
              <g key={t.key}>
                <rect x={x} y={y} width={w} height={h} fill={COLORS[t.tone]}
                      fillOpacity={0.3 + t.share * 0.6} stroke="var(--surface-1)" strokeWidth={2}
                      data-token="--info" />
                {w > 70 && h > 32 && (
                  <>
                    <text x={x + 6} y={y + 16} className="fill-tone-1 font-mono" fontSize={10}>
                      {t.label.slice(0, Math.floor(w / 7))}
                    </text>
                    <text x={x + 6} y={y + 30} className="fill-tone-2 font-mono" fontSize={9}>
                      {formatMetric(t.value, fmt)} · %{Math.round(t.share * 100)}
                    </text>
                  </>
                )}
              </g>
            );
          })}
        </svg>
      </div>
      <Footer source={model.sourceLabel} asOf={model.asOf} unknown={model.unknownCount} />
    </div>
  );
}
