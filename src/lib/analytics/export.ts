// Faz 34 — chart and analysis export: SVG, CSV, XLSX (server) and PNG/PDF (browser).
//
// ═══ WHY PNG AND PDF ARE PRODUCED IN THE BROWSER ═══
//
// SVG, CSV and XLSX are generated here, server-side, from data this process already has. PNG and
// PDF are NOT: rasterising or printing server-side needs a headless browser (puppeteer/playwright
// as a RUNTIME dependency) or a native canvas build. Both are large, platform-specific
// dependencies added purely to convert a picture the browser is already displaying.
//
// The charts are SVG in the DOM. The browser can rasterise that SVG to PNG with the canvas API it
// already has, and produce PDF through its own print pipeline — see `svgToPngDataUrl` in
// export-client.ts. Same picture, no new dependency, and the conversion happens on the machine
// that asked for the file.
//
// Stated rather than hidden, because "PNG export" that quietly means "screenshot it yourself" is
// the kind of half-delivery this project keeps refusing to make.
//
// Pure: no database, no LLM. Everything takes a model and returns bytes or a string.

import * as XLSX from "xlsx";
import type { ChartFormat } from "./chart";
import type { HeatmapModel, TreemapModel, WaterfallModel } from "./chart-types";
import { formatMetric } from "./analyses";
import type { ReproducibilityStamp } from "./reproducibility";
import { describeStamp } from "./reproducibility";
import type { MetricFormat } from "./registry";

/** ChartFormat and MetricFormat overlap but are not identical; mapped once, explicitly. */
function asMetricFormat(format: ChartFormat): MetricFormat {
  switch (format) {
    case "currency": return "currency";
    case "percent": return "percent";
    case "count": return "count";
    case "minutes": return "count";
    case "decimal":
    default: return "ratio";
  }
}

const escapeXml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&apos;");

const TONE_FILL: Record<string, string> = {
  positive: "#2f855a", negative: "#c53030", warning: "#b7791f",
  info: "#2b6cb0", neutral: "#4a5568", scenario: "#6b46c1",
};

/* ── SVG ────────────────────────────────────────────────────────────────────────────────── */

const SVG_W = 900, SVG_H = 420, PAD_L = 60, PAD_R = 20, PAD_T = 48, PAD_B = 70;

/**
 * Standalone SVG for a waterfall.
 *
 * Self-contained on purpose — no external CSS, no font files, explicit colours. An exported chart
 * that only renders correctly inside the app is not an export.
 */
export function waterfallToSvg(model: WaterfallModel): string {
  const plotW = SVG_W - PAD_L - PAD_R, plotH = SVG_H - PAD_T - PAD_B;
  const span = model.max - model.min || 1;
  const yOf = (v: number) => PAD_T + plotH - ((v - model.min) / span) * plotH;
  const barW = model.bars.length ? Math.max(6, (plotW / model.bars.length) * 0.62) : 0;
  const stepX = model.bars.length ? plotW / model.bars.length : 0;

  const parts: string[] = [];
  parts.push(`<rect width="${SVG_W}" height="${SVG_H}" fill="#ffffff"/>`);
  parts.push(`<text x="${PAD_L}" y="26" font-family="sans-serif" font-size="16" fill="#1a202c">${escapeXml(model.title)}</text>`);
  // Zero line, always drawn: a waterfall without a visible baseline hides which bars are negative.
  const zeroY = yOf(0);
  parts.push(`<line x1="${PAD_L}" y1="${zeroY}" x2="${SVG_W - PAD_R}" y2="${zeroY}" stroke="#cbd5e0" stroke-width="1"/>`);

  model.bars.forEach((bar, i) => {
    const cx = PAD_L + i * stepX + stepX / 2;
    const x = cx - barW / 2;
    const yTop = yOf(bar.to), yBottom = yOf(bar.from);
    const h = Math.max(1, yBottom - yTop);
    parts.push(`<rect x="${x.toFixed(1)}" y="${yTop.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" fill="${TONE_FILL[bar.tone] ?? TONE_FILL.neutral}"/>`);
    if (i > 0) {
      const prev = model.bars[i - 1];
      const connectorY = yOf(prev.kind === "start" || prev.kind === "end" ? prev.value : prev.to === prev.from ? prev.to : (bar.kind === "increase" ? bar.from : bar.to));
      const px = PAD_L + (i - 1) * stepX + stepX / 2 + barW / 2;
      parts.push(`<line x1="${px.toFixed(1)}" y1="${connectorY.toFixed(1)}" x2="${x.toFixed(1)}" y2="${connectorY.toFixed(1)}" stroke="#a0aec0" stroke-width="1" stroke-dasharray="3 3"/>`);
    }
    parts.push(`<text x="${cx.toFixed(1)}" y="${(SVG_H - PAD_B + 16).toFixed(1)}" font-family="sans-serif" font-size="10" fill="#4a5568" text-anchor="middle">${escapeXml(bar.label.slice(0, 16))}</text>`);
    parts.push(`<text x="${cx.toFixed(1)}" y="${(yTop - 4).toFixed(1)}" font-family="sans-serif" font-size="10" fill="#1a202c" text-anchor="middle">${escapeXml(formatMetric(bar.value, asMetricFormat(model.format)))}</text>`);
  });

  parts.push(footerSvg(model.sourceLabel, model.asOf, model.unknownCount));
  return svgWrap(parts.join(""));
}

export function heatmapToSvg(model: HeatmapModel): string {
  const plotW = SVG_W - PAD_L - PAD_R, plotH = SVG_H - PAD_T - PAD_B;
  const cw = model.columns.length ? plotW / model.columns.length : plotW;
  const ch = model.rows.length ? plotH / model.rows.length : plotH;
  const parts: string[] = [];
  parts.push(`<rect width="${SVG_W}" height="${SVG_H}" fill="#ffffff"/>`);
  parts.push(`<text x="${PAD_L}" y="26" font-family="sans-serif" font-size="16" fill="#1a202c">${escapeXml(model.title)}</text>`);

  model.rows.forEach((row, ri) => {
    model.columns.forEach((col, ci) => {
      const cell = model.cells.find((c) => c.rowKey === row.key && c.columnKey === col.key);
      const x = PAD_L + ci * cw, y = PAD_T + ri * ch;
      if (!cell || cell.intensity == null) {
        // Unknown is hatched, never the coldest colour — see chart-types.ts.
        parts.push(`<rect x="${x}" y="${y}" width="${cw}" height="${ch}" fill="#ffffff" stroke="#e2e8f0"/>`);
        parts.push(`<text x="${x + cw / 2}" y="${y + ch / 2 + 4}" font-family="sans-serif" font-size="11" fill="#a0aec0" text-anchor="middle">—</text>`);
      } else {
        const alpha = 0.12 + cell.intensity * 0.78;
        parts.push(`<rect x="${x}" y="${y}" width="${cw}" height="${ch}" fill="rgba(43,108,176,${alpha.toFixed(3)})" stroke="#ffffff"/>`);
        parts.push(`<text x="${x + cw / 2}" y="${y + ch / 2 + 4}" font-family="sans-serif" font-size="10" fill="${cell.intensity > 0.55 ? "#ffffff" : "#1a202c"}" text-anchor="middle">${escapeXml(formatMetric(cell.value, asMetricFormat(model.format)))}</text>`);
      }
    });
    parts.push(`<text x="${PAD_L - 6}" y="${PAD_T + ri * ch + ch / 2 + 4}" font-family="sans-serif" font-size="10" fill="#4a5568" text-anchor="end">${escapeXml(row.label.slice(0, 14))}</text>`);
  });
  model.columns.forEach((col, ci) => {
    parts.push(`<text x="${PAD_L + ci * cw + cw / 2}" y="${SVG_H - PAD_B + 16}" font-family="sans-serif" font-size="10" fill="#4a5568" text-anchor="middle">${escapeXml(col.label.slice(0, 14))}</text>`);
  });

  parts.push(footerSvg(model.sourceLabel, model.asOf, model.unknownCount));
  return svgWrap(parts.join(""));
}

export function treemapToSvg(model: TreemapModel): string {
  const plotW = SVG_W - PAD_L - PAD_R, plotH = SVG_H - PAD_T - PAD_B;
  const parts: string[] = [];
  parts.push(`<rect width="${SVG_W}" height="${SVG_H}" fill="#ffffff"/>`);
  parts.push(`<text x="${PAD_L}" y="26" font-family="sans-serif" font-size="16" fill="#1a202c">${escapeXml(model.title)}</text>`);

  for (const tile of model.tiles) {
    const x = PAD_L + tile.x * plotW, y = PAD_T + tile.y * plotH;
    const w = tile.width * plotW, h = tile.height * plotH;
    parts.push(`<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" fill="${TONE_FILL[tile.tone] ?? TONE_FILL.info}" fill-opacity="${(0.35 + tile.share * 0.6).toFixed(2)}" stroke="#ffffff" stroke-width="2"/>`);
    // Labels only where they fit — an unreadable label is worse than none.
    if (w > 64 && h > 30) {
      parts.push(`<text x="${(x + 6).toFixed(1)}" y="${(y + 16).toFixed(1)}" font-family="sans-serif" font-size="11" fill="#1a202c">${escapeXml(tile.label.slice(0, Math.floor(w / 7)))}</text>`);
      parts.push(`<text x="${(x + 6).toFixed(1)}" y="${(y + 30).toFixed(1)}" font-family="sans-serif" font-size="10" fill="#2d3748">${escapeXml(formatMetric(tile.value, asMetricFormat(model.format)))} · %${Math.round(tile.share * 100)}</text>`);
    }
  }

  parts.push(footerSvg(model.sourceLabel, model.asOf, model.unknownCount));
  return svgWrap(parts.join(""));
}

function footerSvg(sourceLabel: string, asOf: string, unknownCount: number): string {
  // The unknown count travels with the picture. An exported chart that drops it turns
  // "we could not measure 12 rows" into silence the moment it leaves the app.
  const note = unknownCount > 0 ? ` · ${unknownCount} bilinmeyen değer hesaba katılmadı` : "";
  return `<text x="${PAD_L}" y="${SVG_H - 12}" font-family="sans-serif" font-size="10" fill="#718096">${escapeXml(`Kaynak: ${sourceLabel} · ${asOf} itibarıyla${note}`)}</text>`;
}

function svgWrap(inner: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SVG_W}" height="${SVG_H}" viewBox="0 0 ${SVG_W} ${SVG_H}" role="img">${inner}</svg>`;
}

/* ── tabular exports ────────────────────────────────────────────────────────────────────── */

export interface SheetSpec {
  name: string;
  /** First row is the header. */
  rows: (string | number | null)[][];
}

/** CSV with the Turkish-Excel-friendly separator, quoting anything risky. */
export function rowsToCsv(rows: readonly (string | number | null)[][]): string {
  const cell = (v: string | number | null) => {
    if (v == null) return "";
    const s = String(v);
    return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return rows.map((r) => r.map(cell).join(";")).join("\n");
}

/**
 * XLSX workbook from one or more sheets, plus a provenance sheet.
 *
 * The stamp sheet is not optional. A spreadsheet outlives the screen it came from and gets mailed
 * around; without the version fingerprint and input snapshot travelling with it, nobody can tell
 * six months later which formula produced the numbers.
 */
export function toXlsxBuffer(sheets: readonly SheetSpec[], stamp?: ReproducibilityStamp): Buffer {
  const wb = XLSX.utils.book_new();
  // Sheet names must be UNIQUE, and SheetJS throws rather than warning when they collide. Two
  // charts sharing a title is entirely normal (a waterfall and its table, two periods of the same
  // analysis), so the names are deduplicated here instead of leaving a crash for the day it
  // happens — the gate hit exactly this with three models called "t".
  const used = new Set<string>();
  for (const sheet of sheets) {
    const ws = XLSX.utils.aoa_to_sheet(sheet.rows as unknown[][]);
    // Excel sheet names cap at 31 chars and forbid []:*?/\
    const base = sheet.name.replace(/[[\]:*?/\\]/g, " ").slice(0, 31).trim() || "Sayfa";
    let name = base;
    let n = 2;
    while (used.has(name.toLowerCase())) {
      const suffix = ` (${n++})`;
      name = base.slice(0, 31 - suffix.length) + suffix;
    }
    used.add(name.toLowerCase());
    XLSX.utils.book_append_sheet(wb, ws, name);
  }
  if (stamp) {
    const rows: (string | number | null)[][] = [
      ["Alan", "Değer"],
      ["Analiz", stamp.analysisId],
      ["Hesap sürümü", stamp.versionFingerprint],
      ["Kaynak tablolar", stamp.lineage.join(", ")],
      ["İtibar tarihi", stamp.input.asOf],
      ["Kaynak kesme zamanı", stamp.input.sourceCutoff ?? "—"],
      ["Hesaplanma zamanı", stamp.computedAt],
      ["Özet (digest)", stamp.digest],
      [],
      ["Girdi tablosu", "Satır sayısı"],
      ...Object.entries(stamp.input.rowCounts)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([t, n]) => [t, n] as (string | number)[]),
    ];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows as unknown[][]), "Kaynak");
  }
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

/** Flatten a waterfall into sheet rows. */
export function waterfallToSheet(model: WaterfallModel): SheetSpec {
  return {
    name: model.title,
    rows: [
      ["Adım", "Tür", "Değer", "Kümülatif"],
      ...model.bars.map((b) => [b.label, b.kind, b.value, b.to] as (string | number)[]),
    ],
  };
}

export function heatmapToSheet(model: HeatmapModel): SheetSpec {
  return {
    name: model.title,
    rows: [
      ["", ...model.columns.map((c) => c.label)],
      ...model.rows.map((r) => [
        r.label,
        // Unknown exports as an empty cell, NOT as 0 — a spreadsheet full of fake zeroes is worse
        // than one with gaps, because SUM() happily adds them up.
        ...model.columns.map((c) => model.cells.find((x) => x.rowKey === r.key && x.columnKey === c.key)?.value ?? null),
      ]),
    ],
  };
}

export function treemapToSheet(model: TreemapModel): SheetSpec {
  return {
    name: model.title,
    rows: [
      ["Kalem", "Değer", "Pay"],
      ...model.tiles.map((t) => [t.label, t.value, t.share] as (string | number)[]),
    ],
  };
}

/** A plain-text provenance line for anything that can only carry a string. */
export function stampLine(stamp: ReproducibilityStamp): string {
  return describeStamp(stamp);
}
