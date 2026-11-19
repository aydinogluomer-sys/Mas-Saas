"use client";

import { useState, type PointerEvent as ReactPointerEvent } from "react";

export interface ScenarioLine {
  month_start: string;
  base_close: number | null;
  scen_close: number | null;
  optimistic_close?: number | null;
  stress_close?: number | null;
}

const W = 860;

const kFmt = (n: number) =>
  Math.abs(n) >= 1e6
    ? (n / 1e6).toFixed(1).replace(".0", "") + "M ₺"
    : Math.abs(n) >= 1e3
      ? Math.round(n / 1e3) + "B ₺"
      : `${Math.round(n)} ₺`;

/**
 * Editorial Precision v2 — Multi-Trajectory Scenario & Liquidity Runway Chart (M-07).
 * - Cobalt (`var(--info)`) baseline / primary trajectory
 * - Emerald (`var(--pos)`) optimistic / upside scenario
 * - Crimson (`var(--neg)`) stress / downside trajectory
 * - Amber (`var(--warn)`) dashed `minCashBuffer` threshold + shaded breach zone + interactive crosshair
 */
export function ScenarioChart({
  lines,
  minCashBuffer = null,
}: {
  lines: ScenarioLine[];
  minCashBuffer?: number | null;
}) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const H = 260;
  const PL = 66;
  const PR = 20;
  const PT = 22;
  const PB = 34;
  const plotW = W - PL - PR;
  const plotH = H - PT - PB;

  const vals = lines
    .flatMap((l) => [l.base_close, l.scen_close, l.optimistic_close ?? null, l.stress_close ?? null])
    .filter((v): v is number => v != null);

  if (vals.length === 0) {
    return (
      <p className="text-[13px]" style={{ color: "var(--text-3)" }}>
        Kasa verisi yok.
      </p>
    );
  }

  const extraVals = minCashBuffer != null ? [...vals, minCashBuffer, 0] : [...vals, 0];
  const rawMin = Math.min(...extraVals);
  const rawMax = Math.max(...extraVals);
  const min = rawMin < 0 ? rawMin * 1.15 : 0;
  const max = rawMax > 0 ? rawMax * 1.15 : 1;

  const x = (i: number) => PL + (i / Math.max(lines.length - 1, 1)) * plotW;
  const y = (v: number) => (max === min ? H / 2 : PT + (1 - (v - min) / (max - min)) * plotH);
  const zeroY = y(0);
  const bufferY = minCashBuffer != null ? y(minCashBuffer) : null;

  const buildSegments = (pick: (l: ScenarioLine) => number | null): string[] => {
    const segs: string[] = [];
    let cur: string[] = [];
    lines.forEach((l, i) => {
      const v = pick(l);
      if (v == null) {
        if (cur.length > 1) segs.push(cur.join(" "));
        cur = [];
        return;
      }
      cur.push(`${x(i)},${y(v)}`);
    });
    if (cur.length > 1) segs.push(cur.join(" "));
    return segs;
  };

  const hasOptimistic = lines.some((l) => l.optimistic_close != null);
  const hasStress = lines.some((l) => l.stress_close != null);

  const avgBase =
    lines.reduce((s, l) => s + (l.base_close ?? 0), 0) / Math.max(1, lines.filter((l) => l.base_close != null).length);
  const avgScen =
    lines.reduce((s, l) => s + (l.scen_close ?? 0), 0) / Math.max(1, lines.filter((l) => l.scen_close != null).length);
  const scenStroke = avgScen < avgBase ? "var(--neg)" : "var(--pos)";

  const handleMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    const rectW = e.currentTarget.clientWidth || W;
    const svgX = (e.nativeEvent.offsetX / rectW) * W;
    if (svgX < PL - 8 || svgX > W - PR + 8) {
      setHoverIdx(null);
      return;
    }
    const idx = Math.max(0, Math.min(lines.length - 1, Math.round(((svgX - PL) / plotW) * Math.max(lines.length - 1, 1))));
    setHoverIdx(idx);
  };

  const midVal = (min + max) / 2;
  const midY = y(midVal);
  const hovered = hoverIdx != null ? lines[hoverIdx] : null;

  return (
    <div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        className="block w-full cursor-crosshair"
        role="img"
        aria-label="Baz vs senaryo kasa grafiği"
        onPointerMove={handleMove}
        onPointerLeave={() => setHoverIdx(null)}
      >
        {/* Shaded Breach Zone below minCashBuffer or 0 */}
        {bufferY != null ? (
          <rect
            x={PL}
            y={bufferY}
            width={plotW}
            height={Math.max(0, H - PB - bufferY)}
            fill="var(--warn)"
            opacity="0.08"
          />
        ) : (
          <rect
            x={PL}
            y={zeroY}
            width={plotW}
            height={Math.max(y(min) - zeroY, 0)}
            fill="var(--neg)"
            opacity="0.08"
          />
        )}

        {/* Gridlines & Zero Line */}
        <line x1={PL} x2={W - PR} y1={PT} y2={PT} stroke="var(--line-faint)" strokeWidth="1" />
        <line x1={PL} x2={W - PR} y1={midY} y2={midY} stroke="var(--line-faint)" strokeWidth="1" />
        <line x1={PL} x2={W - PR} y1={zeroY} y2={zeroY} stroke="var(--line-strong)" strokeWidth="1.2" />

        {/* Amber Minimum Cash Buffer Threshold */}
        {bufferY != null && minCashBuffer != null && (
          <g>
            <line
              x1={PL}
              x2={W - PR}
              y1={bufferY}
              y2={bufferY}
              stroke="var(--warn)"
              strokeWidth="1.4"
              strokeDasharray="5 4"
            />
            <text x={W - PR - 4} y={Math.max(PT + 11, bufferY - 5)} textAnchor="end" fontSize="10.5" fontWeight="600" fill="var(--warn)">
              Asgari nakit tamponu: {kFmt(minCashBuffer)}
            </text>
          </g>
        )}

        {/* Hover Crosshair */}
        {hoverIdx != null && (
          <line
            x1={x(hoverIdx)}
            x2={x(hoverIdx)}
            y1={PT}
            y2={H - PB}
            stroke="var(--info)"
            strokeOpacity="0.45"
            strokeWidth="1.2"
            strokeDasharray="3 3"
          />
        )}

        {/* X-Axis Ticks */}
        {lines.map((l, i) => {
          const step = Math.max(1, Math.ceil(lines.length / 8));
          if (i % step !== 0) return null;
          return (
            <text key={`x${l.month_start}`} x={x(i)} y={H - 10} textAnchor="middle" fontSize="10.5" fill="var(--text-3)">
              {l.month_start.slice(0, 7)}
            </text>
          );
        })}

        {/* Cobalt Baseline Curve */}
        {buildSegments((l) => l.base_close).map((pts, i) => (
          <polyline
            key={`b${i}`}
            points={pts}
            fill="none"
            stroke="var(--info)"
            strokeWidth="2.2"
            strokeDasharray="6 4"
            strokeLinecap="round"
          />
        ))}

        {/* Active Scenario Curve (Emerald if upside, Crimson if stress) */}
        {buildSegments((l) => l.scen_close).map((pts, i) => (
          <polyline
            key={`s${i}`}
            points={pts}
            fill="none"
            stroke={scenStroke}
            strokeWidth="2.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ))}

        {/* Optional Explicit Optimistic & Stress Curves */}
        {hasOptimistic &&
          buildSegments((l) => l.optimistic_close ?? null).map((pts, i) => (
            <polyline key={`opt${i}`} points={pts} fill="none" stroke="var(--pos)" strokeWidth="2" strokeLinecap="round" />
          ))}
        {hasStress &&
          buildSegments((l) => l.stress_close ?? null).map((pts, i) => (
            <polyline key={`str${i}`} points={pts} fill="none" stroke="var(--neg)" strokeWidth="2" strokeLinecap="round" />
          ))}

        {/* Y-Axis Labels */}
        <text x={PL - 8} y={PT + 4} textAnchor="end" fontSize="10.5" fill="var(--text-3)">
          {kFmt(max)}
        </text>
        <text x={PL - 8} y={midY + 3.5} textAnchor="end" fontSize="10.5" fill="var(--text-3)">
          {kFmt(midVal)}
        </text>
        <text x={PL - 8} y={H - PB + 3} textAnchor="end" fontSize="10.5" fill="var(--text-3)">
          {kFmt(min)}
        </text>
      </svg>

      {/* Legend & Interactive Readout */}
      <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-[11.5px]" style={{ color: "var(--text-2)" }}>
        <div className="flex flex-wrap items-center gap-4">
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block h-0.5 w-4 border-t-2 border-dashed" style={{ borderColor: "var(--info)" }} />
            <span>Baz Projeksiyon</span>
          </span>
          <span className="inline-flex items-center gap-1.5 font-semibold" style={{ color: scenStroke }}>
            <span className="inline-block h-2 w-3 rounded-[2px]" style={{ background: scenStroke }} />
            <span>Seçili Senaryo</span>
          </span>
          {hasOptimistic && (
            <span className="inline-flex items-center gap-1.5" style={{ color: "var(--pos)" }}>
              <span className="inline-block h-2 w-3 rounded-[2px]" style={{ background: "var(--pos)" }} />
              <span>İyimser</span>
            </span>
          )}
          {hasStress && (
            <span className="inline-flex items-center gap-1.5" style={{ color: "var(--neg)" }}>
              <span className="inline-block h-2 w-3 rounded-[2px]" style={{ background: "var(--neg)" }} />
              <span>Stres</span>
            </span>
          )}
        </div>

        {hovered && (
          <div className="flex flex-wrap items-center gap-3 tabular-nums">
            <span className="font-mono text-[11px]" style={{ color: "var(--text-3)" }}>
              {hovered.month_start}
            </span>
            {hovered.base_close != null && (
              <span>
                Baz: <b style={{ color: "var(--info)" }}>{kFmt(hovered.base_close)}</b>
              </span>
            )}
            {hovered.scen_close != null && (
              <span>
                Senaryo: <b style={{ color: scenStroke }}>{kFmt(hovered.scen_close)}</b>
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
