// Multi-Dimensional Pure-SVG Financial Visualization Suite for MAS Nakit Radar.
//
// 100% React Server Component (RSC) compatible:
//   - Zero "use client" directive, zero React hooks, zero external JS chart bundle weight
//   - Deterministic FNV-1a SVG <defs> IDs (SSR/RSC hydration-safe across multiple instances)
//   - Strict NaN / Infinity / empty-array / division-by-zero immunity
//   - Warm Archival Cotton-Ledger palette (FT / Mercury / Ramp editorial aesthetic)

export type EditorialChartTone =
  | "pos"
  | "neg"
  | "warn"
  | "info"
  | "accent"
  | "neutral";

const TONE_HEX: Record<EditorialChartTone, string> = {
  pos: "#11694E", // Archival Banknote Emerald
  neg: "#A92419", // Vermilion Wax Seal
  warn: "#A84608", // Burnt Raw Ochre
  info: "#1E478A", // Prussian Ledger Blue
  accent: "#8C6229", // Burnished Brass
  neutral: "#64615A", // Calm Architectural Stone
};

const TONE_SOFT_BG: Record<EditorialChartTone, string> = {
  pos: "color-mix(in srgb, var(--pos) 10%, var(--surface-1))",
  neg: "color-mix(in srgb, var(--neg) 10%, var(--surface-1))",
  warn: "color-mix(in srgb, var(--warn) 10%, var(--surface-1))",
  info: "color-mix(in srgb, var(--info) 9%, var(--surface-1))",
  accent: "color-mix(in srgb, #8C6229 10%, var(--surface-1))",
  neutral: "var(--surface-2)",
};

const TONE_SOFT_BORDER: Record<EditorialChartTone, string> = {
  pos: "color-mix(in srgb, var(--pos) 26%, var(--line))",
  neg: "color-mix(in srgb, var(--neg) 26%, var(--line))",
  warn: "color-mix(in srgb, var(--warn) 26%, var(--line))",
  info: "color-mix(in srgb, var(--info) 24%, var(--line))",
  accent: "color-mix(in srgb, #8C6229 26%, var(--line))",
  neutral: "var(--line-strong)",
};

const DEFAULT_SLICE_TONES: readonly EditorialChartTone[] = [
  "info",
  "pos",
  "accent",
  "warn",
  "neg",
  "neutral",
];

/* ── Deterministic Pure Helpers (Zero NaN / Infinity Guarantees) ──────────── */

function fnv1aHash(input: string): string {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

function finiteOr(value: number | undefined | null, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function coord(value: number, fallback = 0): number {
  if (!Number.isFinite(value)) return fallback;
  return Number(value.toFixed(2));
}

function polarToCartesian(cx: number, cy: number, r: number, angleDeg: number) {
  const rad = (angleDeg * Math.PI) / 180;
  return {
    x: coord(cx + r * Math.cos(rad), cx),
    y: coord(cy + r * Math.sin(rad), cy),
  };
}

function describeRingArc(
  cx: number,
  cy: number,
  r: number,
  startAngleDeg: number,
  endAngleDeg: number,
): string {
  const clampedSweep = Math.max(0.1, Math.min(359.6, endAngleDeg - startAngleDeg));
  const safeEnd = startAngleDeg + clampedSweep;
  const start = polarToCartesian(cx, cy, r, startAngleDeg);
  const end = polarToCartesian(cx, cy, r, safeEnd);
  const largeArcFlag = clampedSweep > 180 ? 1 : 0;
  return `M ${start.x} ${start.y} A ${coord(r)} ${coord(r)} 0 ${largeArcFlag} 1 ${end.x} ${end.y}`;
}

const TR_DEC_1 = new Intl.NumberFormat("tr-TR", {
  minimumFractionDigits: 1,
  maximumFractionDigits: 1,
});

const TR_INT_0 = new Intl.NumberFormat("tr-TR", {
  maximumFractionDigits: 0,
});

function formatSharePercent(sharePct: number): string {
  const safe = finiteOr(sharePct, 0);
  if (safe <= 0) return "%0,0";
  if (safe < 0.1) return "<%0,1";
  return `%${TR_DEC_1.format(safe)}`;
}

function truncateText(text: string, maxChars: number): string {
  const clean = text.trim();
  if (clean.length <= maxChars) return clean;
  return `${clean.slice(0, Math.max(1, maxChars - 1)).trimEnd()}…`;
}

function splitTwoLineLabel(
  raw: string,
  maxLineChars: number,
): [string, string | null] {
  const text = raw.trim();
  if (text.length <= maxLineChars) return [text, null];

  const words = text.split(/\s+/);
  if (words.length === 1) {
    return [truncateText(text, maxLineChars), null];
  }

  let line1 = "";
  let splitIdx = 0;
  for (let i = 0; i < words.length; i++) {
    const candidate = line1 ? `${line1} ${words[i]}` : words[i];
    if (candidate.length <= maxLineChars || i === 0) {
      line1 = truncateText(candidate, maxLineChars);
      splitIdx = i + 1;
    } else {
      break;
    }
  }

  const rest = words.slice(splitIdx).join(" ").trim();
  if (!rest) return [line1, null];
  return [line1, truncateText(rest, maxLineChars + 1)];
}

function compactFormattedMoney(formatted: string, maxChars: number): string {
  const clean = formatted.trim();
  if (clean.length <= maxChars) return clean;
  // Preserve exact integer digits & currency code by stripping trailing ",00" first
  const withoutZeroCents = clean.replace(/,00(\s|$)/, "$1");
  if (withoutZeroCents.length <= maxChars) return withoutZeroCents;
  return truncateText(withoutZeroCents, maxChars);
}

function defaultScenarioFormatValue(value: number): string {
  const safe = finiteOr(value, 0);
  const abs = Math.abs(safe);
  const sign = safe < 0 ? "−" : "";
  if (abs >= 1_000_000_000) {
    return `${sign}${TR_DEC_1.format(abs / 1_000_000_000)} Mr ₺`;
  }
  if (abs >= 1_000_000) {
    return `${sign}${TR_DEC_1.format(abs / 1_000_000)} Mn ₺`;
  }
  if (abs >= 1_000) {
    return `${sign}${TR_INT_0.format(Math.round(abs / 1_000))} B ₺`;
  }
  return `${sign}${TR_INT_0.format(Math.round(abs))} ₺`;
}

/* ═══════════════════════════════════════════════════════════════════════════
   1. EditorialDonutChartSvg — Architectural Compass Ring + Ranked Legend
   ═══════════════════════════════════════════════════════════════════════════ */

export interface DonutSlice {
  key: string;
  label: string;
  value: number; // >= 0
  formattedValue: string;
  sublabel?: string;
  tone?: "pos" | "neg" | "warn" | "info" | "accent" | "neutral";
}

export interface EditorialDonutChartProps {
  slices: DonutSlice[];
  centerLabel: string;
  centerValue: string;
  centerSubtext?: string;
  ariaLabel: string;
  size?: number; // default 168
  className?: string;
}

export function EditorialDonutChartSvg({
  slices,
  centerLabel,
  centerValue,
  centerSubtext,
  ariaLabel,
  size = 168,
  className = "",
}: EditorialDonutChartProps) {
  const safeSize = Math.max(120, Math.min(280, finiteOr(size, 168)));
  const cx = 90;
  const cy = 90;
  const ringRadius = 64; // strokeWidth=20 => inner r=54, outer r=74
  const strokeWidth = 20;

  const normalizedSlices = slices.map((slice, idx) => {
    const safeValue = Math.max(0, finiteOr(slice.value, 0));
    const resolvedTone: EditorialChartTone =
      slice.tone ?? DEFAULT_SLICE_TONES[idx % DEFAULT_SLICE_TONES.length];
    return {
      ...slice,
      safeValue,
      resolvedTone,
      hex: TONE_HEX[resolvedTone],
      softBg: TONE_SOFT_BG[resolvedTone],
      softBorder: TONE_SOFT_BORDER[resolvedTone],
      originalIndex: idx,
    };
  });

  const total = normalizedSlices.reduce((acc, s) => acc + s.safeValue, 0);
  const activeSlices = normalizedSlices.filter((s) => s.safeValue > 0);

  // Allocate angular sweeps with 1.5° crisp architectural gaps and minimum sliver visibility
  const arcSegments: Array<{
    key: string;
    label: string;
    formattedValue: string;
    hex: string;
    startDeg: number;
    endDeg: number;
    isFullCircle: boolean;
  }> = [];

  if (total > 0 && activeSlices.length === 1) {
    const only = activeSlices[0];
    arcSegments.push({
      key: only.key,
      label: only.label,
      formattedValue: only.formattedValue,
      hex: only.hex,
      startDeg: -90,
      endDeg: 270,
      isFullCircle: true,
    });
  } else if (total > 0 && activeSlices.length >= 2) {
    const n = activeSlices.length;
    const gapDeg = Math.min(1.5, 36 / n);
    const usableDeg = Math.max(12, 360 - gapDeg * n);
    const minSliceDeg = Math.min(2.2, usableDeg / n);

    const sweeps = activeSlices.map((s) => (s.safeValue / total) * usableDeg);
    // Two-pass water-filling so tiny positive slices remain crisp & non-zero
    for (let pass = 0; pass < 2; pass++) {
      let lockedSum = 0;
      let freeWeightSum = 0;
      const locked = sweeps.map((sw, i) => {
        if (sw < minSliceDeg) {
          lockedSum += minSliceDeg;
          return true;
        }
        freeWeightSum += activeSlices[i].safeValue;
        return false;
      });
      const remainingDeg = Math.max(0, usableDeg - lockedSum);
      if (freeWeightSum > 0) {
        for (let i = 0; i < sweeps.length; i++) {
          sweeps[i] = locked[i]
            ? minSliceDeg
            : (activeSlices[i].safeValue / freeWeightSum) * remainingDeg;
        }
      }
    }

    let cursorDeg = -90;
    activeSlices.forEach((s, idx) => {
      const sweep = Math.max(0.8, sweeps[idx]);
      arcSegments.push({
        key: s.key,
        label: s.label,
        formattedValue: s.formattedValue,
        hex: s.hex,
        startDeg: cursorDeg,
        endDeg: cursorDeg + sweep,
        isFullCircle: false,
      });
      cursorDeg += sweep + gapDeg;
    });
  }

  // Ranked legend rows (descending by value when total > 0, preserving order on ties)
  const rankedLegend = [...normalizedSlices]
    .sort((a, b) => {
      if (total > 0 && b.safeValue !== a.safeValue) {
        return b.safeValue - a.safeValue;
      }
      return a.originalIndex - b.originalIndex;
    })
    .map((item) => ({
      ...item,
      sharePct: total > 0 ? (item.safeValue / total) * 100 : 0,
    }));

  // 24 compass ticks around r=82..87 (every 15°) for burnished brass/sepia instrument craft
  const compassTicks = Array.from({ length: 24 }, (_, idx) => {
    const deg = idx * 15 - 90;
    const isCardinal = idx % 6 === 0;
    const isMajor = idx % 2 === 0;
    const innerR = isCardinal ? 80.5 : isMajor ? 82.2 : 83.4;
    const outerR = isCardinal ? 87.5 : isMajor ? 86.4 : 85.8;
    return {
      idx,
      p1: polarToCartesian(cx, cy, innerR, deg),
      p2: polarToCartesian(cx, cy, outerR, deg),
      isCardinal,
      isMajor,
    };
  });

  const valueFontSize =
    centerValue.length > 14 ? 11.5 : centerValue.length > 11 ? 13.5 : 16;

  return (
    <div
      className={`flex flex-col sm:flex-row items-center gap-4 min-w-0 ${className}`.trim()}
    >
      <svg
        width={safeSize}
        height={safeSize}
        viewBox="0 0 180 180"
        role="img"
        aria-label={ariaLabel}
        className="shrink-0 overflow-visible"
      >
        {/* Outer architectural compass bezel */}
        <circle
          cx={cx}
          cy={cy}
          r={84.5}
          fill="none"
          stroke="var(--line)"
          strokeWidth={0.75}
          strokeOpacity={0.9}
        />
        {compassTicks.map((tick) => (
          <line
            key={tick.idx}
            x1={tick.p1.x}
            y1={tick.p1.y}
            x2={tick.p2.x}
            y2={tick.p2.y}
            stroke={tick.isCardinal ? "var(--text-4)" : "var(--line-strong)"}
            strokeWidth={tick.isCardinal ? 1.2 : tick.isMajor ? 0.85 : 0.65}
            strokeOpacity={tick.isCardinal ? 0.85 : 0.65}
            strokeLinecap="round"
          />
        ))}

        {/* Base donut track */}
        <circle
          cx={cx}
          cy={cy}
          r={ringRadius}
          fill="none"
          stroke="var(--surface-2)"
          strokeWidth={strokeWidth}
        />

        {total <= 0 ? (
          /* Graceful empty / zero-total dashed ring */
          <circle
            cx={cx}
            cy={cy}
            r={ringRadius}
            fill="none"
            stroke="var(--line-strong)"
            strokeWidth={1.6}
            strokeDasharray="4 4"
          />
        ) : (
          arcSegments.map((seg) =>
            seg.isFullCircle ? (
              <circle
                key={seg.key}
                cx={cx}
                cy={cy}
                r={ringRadius}
                fill="none"
                stroke={seg.hex}
                strokeWidth={strokeWidth}
              >
                <title>{`${seg.label}: ${seg.formattedValue}`}</title>
              </circle>
            ) : (
              <path
                key={seg.key}
                d={describeRingArc(cx, cy, ringRadius, seg.startDeg, seg.endDeg)}
                fill="none"
                stroke={seg.hex}
                strokeWidth={strokeWidth}
                strokeLinecap="butt"
              >
                <title>{`${seg.label}: ${seg.formattedValue}`}</title>
              </path>
            ),
          )
        )}

        {/* Crisp outer & inner architectural ring rims */}
        <circle
          cx={cx}
          cy={cy}
          r={74}
          fill="none"
          stroke="var(--line-card)"
          strokeWidth={0.75}
        />
        <circle
          cx={cx}
          cy={cy}
          r={54}
          fill="none"
          stroke="var(--line-card)"
          strokeWidth={0.75}
        />

        {/* Inner theme-aware center dial */}
        <circle
          cx={cx}
          cy={cy}
          r={49.5}
          fill="var(--surface-1)"
          stroke="var(--line)"
          strokeWidth={0.9}
        />

        {/* Center Readout */}
        <text
          x={cx}
          y={centerSubtext ? 74 : 79}
          textAnchor="middle"
          fill="var(--text-3)"
          fontSize="9.5"
          fontWeight="700"
          letterSpacing="0.08em"
          style={{ fontFamily: "var(--font-mono), ui-monospace, monospace" }}
        >
          {truncateText(centerLabel.toLocaleUpperCase("tr-TR"), 15)}
        </text>
        <text
          x={cx}
          y={centerSubtext ? 93 : 98}
          textAnchor="middle"
          fill="var(--text-1)"
          fontSize={valueFontSize}
          fontWeight="700"
          style={{ fontVariantNumeric: "tabular-nums" }}
        >
          {truncateText(centerValue, 16)}
        </text>
        {centerSubtext ? (
          <text
            x={cx}
            y={109}
            textAnchor="middle"
            fill="var(--text-4)"
            fontSize="10"
            fontWeight="500"
            style={{ fontVariantNumeric: "tabular-nums" }}
          >
            {truncateText(centerSubtext, 17)}
          </text>
        ) : null}
      </svg>

      {/* Right: Ranked Legend Table */}
      <div className="w-full min-w-0 flex-1 space-y-1.5">
        {rankedLegend.length === 0 ? (
          <div className="rounded-[5px] border border-line-faint bg-surface-0 px-3 py-2 text-[11.5px] text-tone-4">
            Dağılım kalemi bulunmuyor
          </div>
        ) : (
          rankedLegend.map((item) => (
            <div
              key={item.key}
              className="flex items-center justify-between gap-2.5 rounded-[5px] border border-line-faint bg-surface-0 px-2.5 py-1.5"
            >
              <div className="flex min-w-0 items-center gap-2">
                <span
                  className="inline-block h-2.5 w-2.5 shrink-0 rounded-[2.5px]"
                  style={{
                    backgroundColor: item.hex,
                    boxShadow: "inset 0 0 0 1px rgba(29, 24, 19, 0.14)",
                  }}
                  aria-hidden
                />
                <div className="min-w-0">
                  <div className="truncate text-[12px] font-medium leading-tight text-tone-1">
                    {item.label}
                  </div>
                  {item.sublabel ? (
                    <div className="tnum truncate text-[10.5px] leading-tight text-tone-3">
                      {item.sublabel}
                    </div>
                  ) : null}
                </div>
              </div>

              <div className="flex shrink-0 items-center gap-2">
                <span
                  className="tnum rounded-[4px] px-1.5 py-0.5 font-mono text-[10px] font-semibold leading-none"
                  style={{
                    backgroundColor: item.softBg,
                    border: `1px solid ${item.softBorder}`,
                    color: item.hex,
                  }}
                >
                  {formatSharePercent(item.sharePct)}
                </span>
                <span className="tnum text-right text-[12px] font-semibold text-tone-1">
                  {item.formattedValue}
                </span>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   2. CashflowWaterfallSvg — CFO Cash Bridge / Cumulative Step Waterfall
   ═══════════════════════════════════════════════════════════════════════════ */

export interface WaterfallStep {
  key: string;
  label: string;
  amount: number; // signed (+ inflow, - outflow) or total when isTotal=true
  formattedAmount: string;
  isTotal?: boolean;
  tone?: "pos" | "neg" | "warn" | "info" | "accent";
}

export interface CashflowWaterfallProps {
  steps: WaterfallStep[];
  ariaLabel: string;
  zeroLineLabel?: string;
  height?: number; // default 220
  className?: string;
}

export function CashflowWaterfallSvg({
  steps,
  ariaLabel,
  zeroLineLabel = "0 ₺",
  height = 220,
  className = "",
}: CashflowWaterfallProps) {
  const vbWidth = 560;
  const vbHeight = Math.max(180, Math.min(360, finiteOr(height, 220)));
  const hatchId = `wf-hatch-${fnv1aHash(`${ariaLabel}:${steps.map((s) => s.key).join("|")}`)}`;

  if (steps.length === 0) {
    return (
      <svg
        viewBox={`0 0 ${vbWidth} ${vbHeight}`}
        role="img"
        aria-label={ariaLabel}
        className={`w-full h-auto block ${className}`.trim()}
      >
        <rect
          x={12}
          y={12}
          width={vbWidth - 24}
          height={vbHeight - 24}
          rx={6}
          fill="var(--surface-1)"
          stroke="var(--line-strong)"
          strokeDasharray="4 4"
        />
        <text
          x={vbWidth / 2}
          y={vbHeight / 2 + 4}
          textAnchor="middle"
          fill="var(--text-3)"
          fontSize="11.5"
          fontWeight="500"
        >
          Nakit köprüsü adımı bulunmuyor
        </text>
      </svg>
    );
  }

  // Compute running cumulative start/end per waterfall column
  let runningCum = 0;
  const computedSteps = steps.map((step) => {
    const safeAmount = finiteOr(step.amount, 0);
    const isTotal = Boolean(step.isTotal);
    let startVal: number;
    let endVal: number;

    if (isTotal) {
      startVal = 0;
      endVal = safeAmount;
      runningCum = safeAmount;
    } else {
      startVal = runningCum;
      endVal = runningCum + safeAmount;
      runningCum = endVal;
    }

    const resolvedTone: EditorialChartTone =
      step.tone ??
      (isTotal
        ? safeAmount < 0
          ? "neg"
          : "info"
        : safeAmount >= 0
          ? "pos"
          : "neg");

    return {
      ...step,
      safeAmount,
      isTotal,
      startVal,
      endVal,
      resolvedTone,
      hex: TONE_HEX[resolvedTone],
    };
  });

  const allValues = [
    0,
    ...computedSteps.flatMap((s) => [s.startVal, s.endVal]),
  ];
  const rawMin = Math.min(...allValues);
  const rawMax = Math.max(...allValues);
  const allZero = rawMin === 0 && rawMax === 0;

  const domainMin = allZero ? -0.35 : rawMin;
  const domainMax = allZero ? 1 : rawMax;
  const span = Math.max(domainMax - domainMin, 1e-6);

  const padLeft = 46;
  const padRight = 14;
  const plotTop = 28;
  const plotBottom = vbHeight - 44;
  const plotW = vbWidth - padLeft - padRight;
  const plotH = Math.max(48, plotBottom - plotTop);

  const toY = (val: number): number => {
    const ratio = (finiteOr(val, 0) - domainMin) / span;
    return coord(plotBottom - ratio * plotH, plotBottom);
  };

  const zeroY = toY(0);
  const gridRatios = [0, 0.25, 0.5, 0.75, 1];

  const count = computedSteps.length;
  const slotW = plotW / count;
  const barW = coord(Math.min(58, Math.max(18, slotW * 0.58)), 32);
  const maxLabelChars = count >= 8 ? 9 : count >= 6 ? 12 : 14;
  const maxAmountChars = count >= 8 ? 10 : count >= 6 ? 13 : 16;
  const valueFontSize = count >= 8 ? 9.2 : count >= 6 ? 9.8 : 10.5;

  const geometry = computedSteps.map((step, idx) => {
    const centerX = coord(padLeft + slotW * idx + slotW / 2);
    const barX = coord(centerX - barW / 2);
    const yStart = toY(step.startVal);
    const yEnd = toY(step.endVal);
    const rawTop = Math.min(yStart, yEnd);
    const rawBot = Math.max(yStart, yEnd);
    const barH = coord(Math.max(2.6, rawBot - rawTop), 2.6);
    const barY = coord(
      rawBot - rawTop < 2.6 ? rawTop - (2.6 - (rawBot - rawTop)) / 2 : rawTop,
    );

    const movesDown = step.isTotal
      ? step.safeAmount < 0
      : step.safeAmount < 0;
    const canPlaceBelow = movesDown && barY + barH + 14 < plotBottom;
    const calloutY = canPlaceBelow
      ? coord(barY + barH + 11.5)
      : coord(Math.max(13, barY - 6));

    const [line1, line2] = splitTwoLineLabel(step.label, maxLabelChars);
    const displayAmount = compactFormattedMoney(
      step.formattedAmount,
      maxAmountChars,
    );

    return {
      ...step,
      centerX,
      barX,
      barY,
      barH,
      yEnd,
      calloutY,
      line1,
      line2,
      displayAmount,
    };
  });

  return (
    <svg
      viewBox={`0 0 ${vbWidth} ${vbHeight}`}
      role="img"
      aria-label={ariaLabel}
      className={`w-full h-auto block ${className}`.trim()}
    >
      <defs>
        <pattern
          id={hatchId}
          width={6}
          height={6}
          patternTransform="rotate(45 0 0)"
          patternUnits="userSpaceOnUse"
        >
          <line
            x1={0}
            y1={0}
            x2={0}
            y2={6}
            stroke="var(--surface-1)"
            strokeWidth={1.6}
            strokeOpacity={0.34}
          />
        </pattern>
      </defs>

      {/* Subtle horizontal dashed ledger gridlines */}
      {gridRatios.map((r) => {
        const gy = coord(plotBottom - r * plotH);
        if (Math.abs(gy - zeroY) < 4) return null;
        return (
          <line
            key={r}
            x1={padLeft}
            y1={gy}
            x2={vbWidth - padRight}
            y2={gy}
            stroke="var(--line)"
            strokeWidth={0.75}
            strokeDasharray="2.5 3.5"
            strokeOpacity={0.85}
          />
        );
      })}

      {/* Crisp 0 ₺ baseline rule + marginalia tag */}
      <line
        x1={padLeft - 4}
        y1={zeroY}
        x2={vbWidth - padRight}
        y2={zeroY}
        stroke="var(--line-strong)"
        strokeWidth={1.15}
        strokeOpacity={0.9}
      />
      <text
        x={padLeft - 8}
        y={coord(zeroY + 3.5)}
        textAnchor="end"
        fill="var(--text-3)"
        fontSize="9.5"
        fontWeight="700"
        style={{
          fontFamily: "var(--font-mono), ui-monospace, monospace",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {truncateText(zeroLineLabel, 7)}
      </text>

      {/* Horizontal dashed bridge lines connecting cumulative levels */}
      {geometry.slice(0, -1).map((curr, idx) => {
        const next = geometry[idx + 1];
        const x1 = coord(curr.barX + barW);
        const x2 = coord(next.barX);
        if (x2 <= x1) return null;
        return (
          <line
            key={`bridge-${curr.key}-${next.key}`}
            x1={x1}
            y1={curr.yEnd}
            x2={x2}
            y2={curr.yEnd}
            stroke="var(--text-4)"
            strokeWidth={1.05}
            strokeDasharray="3 2.5"
            strokeOpacity={0.75}
          />
        );
      })}

      {/* Waterfall columns, total cross-hatching, compact value callouts & X-axis labels */}
      {geometry.map((col) => (
        <g key={col.key}>
          <title>{`${col.label}: ${col.formattedAmount}`}</title>

          {/* Main column body */}
          <rect
            x={col.barX}
            y={col.barY}
            width={barW}
            height={col.barH}
            rx={2.5}
            fill={col.hex}
            fillOpacity={col.isTotal ? 0.92 : 0.86}
            stroke={col.hex}
            strokeWidth={col.isTotal ? 1.25 : 0.8}
          />

          {/* Cross-hatched + framed architectural emphasis for isTotal columns */}
          {col.isTotal && col.barH > 4 ? (
            <>
              <rect
                x={col.barX}
                y={col.barY}
                width={barW}
                height={col.barH}
                rx={2.5}
                fill={`url(#${hatchId})`}
              />
              <line
                x1={coord(col.barX - 1.5)}
                y1={col.barY}
                x2={coord(col.barX + barW + 1.5)}
                y2={col.barY}
                stroke="var(--text-1)"
                strokeWidth={1.6}
                strokeOpacity={0.7}
              />
            </>
          ) : null}

          {/* Formatted amount callout */}
          <text
            x={col.centerX}
            y={col.calloutY}
            textAnchor="middle"
            fill={
              col.isTotal
                ? "var(--text-1)"
                : col.resolvedTone === "neg"
                  ? "var(--neg)"
                  : col.resolvedTone === "pos"
                    ? "var(--pos)"
                    : "var(--text-1)"
            }
            fontSize={valueFontSize}
            fontWeight="700"
            style={{ fontVariantNumeric: "tabular-nums" }}
          >
            {col.displayAmount}
          </text>

          {/* Bottom X-axis 1-or-2-line label */}
          <text
            x={col.centerX}
            y={coord(plotBottom + 16)}
            textAnchor="middle"
            fill={col.isTotal ? "var(--text-1)" : "var(--text-2)"}
            fontSize="10.5"
            fontWeight={col.isTotal ? "700" : "500"}
          >
            {col.line1}
          </text>
          {col.line2 ? (
            <text
              x={col.centerX}
              y={coord(plotBottom + 28.5)}
              textAnchor="middle"
              fill={col.isTotal ? "var(--text-2)" : "var(--text-3)"}
              fontSize="9.8"
              fontWeight={col.isTotal ? "600" : "500"}
            >
              {col.line2}
            </text>
          ) : null}
        </g>
      ))}
    </svg>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   3. PaymentHeatmapStripSvg — Liquidity Pressure Calendar Matrix (5-Stop)
   ═══════════════════════════════════════════════════════════════════════════ */

export interface HeatmapDayCell {
  dateIso: string; // YYYY-MM-DD
  dayLabel: string; // e.g. "16 Kas" or "17"
  weekdayShort?: string; // e.g. "Pzt"
  amount: number; // >= 0 TRY outflow
  formattedAmount: string;
  itemCount: number;
  isRisky?: boolean;
  isToday?: boolean;
}

export interface PaymentHeatmapStripProps {
  days: HeatmapDayCell[]; // 14 to 30 days
  ariaLabel: string;
  peakLabel?: string;
  className?: string;
}

interface HeatmapStopPalette {
  fill: string;
  border: string;
  dayColor: string;
  amountColor: string;
  metaColor: string;
  barColor: string;
  showRiskDot: boolean;
}

const HEATMAP_STOPS: readonly HeatmapStopPalette[] = [
  // Stop 0: 0 outflow — Pale Emerald-Vellum
  {
    fill: "#EEF5EE",
    border: "#C5DCC9",
    dayColor: "#2C5840",
    amountColor: "#1F563B",
    metaColor: "#4C755E",
    barColor: "#9BC4A7",
    showRiskDot: false,
  },
  // Stop 1: Low (>0..33%) — Calm Alabaster Sand
  {
    fill: "#F4EFE2",
    border: "#D8CEB8",
    dayColor: "var(--text-2)",
    amountColor: "#5C4318",
    metaColor: "var(--text-3)",
    barColor: "#C09A58",
    showRiskDot: false,
  },
  // Stop 2: Medium (33%..66%) — Ochre Amber
  {
    fill: "#F4DEC0",
    border: "#D39B5E",
    dayColor: "#5B2C09",
    amountColor: "#8F3B06",
    metaColor: "#7A421A",
    barColor: "#B9671B",
    showRiskDot: false,
  },
  // Stop 3: Elevated (66%..88%) — Terracotta Amber
  {
    fill: "#F5D4C3",
    border: "#CE7856",
    dayColor: "#6D2313",
    amountColor: "#962915",
    metaColor: "#7E3524",
    barColor: "#B84329",
    showRiskDot: false,
  },
  // Stop 4: High / Peak / isRisky — Vermilion Seal Tint
  {
    fill: "#F6D7D3",
    border: "#C85A4F",
    dayColor: "#6E1610",
    amountColor: "#921B12",
    metaColor: "#822820",
    barColor: "#A92419",
    showRiskDot: true,
  },
];

export function PaymentHeatmapStripSvg({
  days,
  ariaLabel,
  peakLabel,
  className = "",
}: PaymentHeatmapStripProps) {
  if (days.length === 0) {
    return (
      <div className={`min-w-0 ${className}`.trim()}>
        <svg
          viewBox="0 0 560 72"
          role="img"
          aria-label={ariaLabel}
          className="w-full h-auto block"
        >
          <rect
            x={4}
            y={4}
            width={552}
            height={64}
            rx={6}
            fill="var(--surface-1)"
            stroke="var(--line-strong)"
            strokeDasharray="4 4"
          />
          <text
            x={280}
            y={40}
            textAnchor="middle"
            fill="var(--text-3)"
            fontSize="11.5"
            fontWeight="500"
          >
            Takvim penceresinde ödeme günü verisi bulunmuyor
          </text>
        </svg>
      </div>
    );
  }

  const sanitizedDays = days.map((day) => ({
    ...day,
    safeAmount: Math.max(0, finiteOr(day.amount, 0)),
    safeCount: Math.max(0, Math.round(finiteOr(day.itemCount, 0))),
  }));

  const maxAmount = sanitizedDays.reduce(
    (max, d) => (d.safeAmount > max ? d.safeAmount : max),
    0,
  );
  const peakDay =
    maxAmount > 0
      ? sanitizedDays.find((d) => d.safeAmount === maxAmount)
      : undefined;

  const cols = 7;
  const rows = Math.max(1, Math.ceil(sanitizedDays.length / cols));
  const vbWidth = 560;
  const padX = 4;
  const padY = 4;
  const gap = 6;
  const cellW = coord((vbWidth - padX * 2 - gap * (cols - 1)) / cols, 74);
  const cellH = 48;
  const vbHeight = coord(padY * 2 + rows * cellH + (rows - 1) * gap, 56);

  const hasAnyToday = sanitizedDays.some((d) => Boolean(d.isToday));
  const resolvedPeakSummary =
    peakLabel ??
    (peakDay
      ? `Zirve: ${peakDay.dayLabel} · ${peakDay.formattedAmount}`
      : undefined);

  return (
    <div className={`min-w-0 space-y-2 ${className}`.trim()}>
      <svg
        viewBox={`0 0 ${vbWidth} ${vbHeight}`}
        role="img"
        aria-label={ariaLabel}
        className="w-full h-auto block"
      >
        {sanitizedDays.map((day, idx) => {
          const col = idx % cols;
          const row = Math.floor(idx / cols);
          const x = coord(padX + col * (cellW + gap));
          const y = coord(padY + row * (cellH + gap));

          const ratio = maxAmount > 0 ? day.safeAmount / maxAmount : 0;
          let stopIdx = 0;
          if (day.isRisky) {
            stopIdx = 4;
          } else if (day.safeAmount <= 0) {
            stopIdx = 0;
          } else if (ratio <= 0.33) {
            stopIdx = 1;
          } else if (ratio <= 0.66) {
            stopIdx = 2;
          } else if (ratio <= 0.88) {
            stopIdx = 3;
          } else {
            stopIdx = 4;
          }

          const palette = HEATMAP_STOPS[stopIdx];
          const displayAmount =
            day.safeAmount <= 0
              ? "Ödeme yok"
              : compactFormattedMoney(day.formattedAmount, 12);
          const amountFontSize =
            displayAmount.length > 11 ? 8.6 : displayAmount.length > 9 ? 9.2 : 9.8;
          const barInnerMax = Math.max(8, cellW - 12);
          const barFillW =
            day.safeAmount <= 0
              ? 0
              : coord(Math.max(4, ratio * barInnerMax), 4);

          const tooltipParts = [
            `${day.dayLabel}${day.weekdayShort ? ` (${day.weekdayShort})` : ""}`,
            day.safeAmount > 0 ? day.formattedAmount : "Ödeme yok",
            day.safeCount > 0 ? `${day.safeCount} kalem` : "0 kalem",
            day.isRisky ? "Kritik çıkış kümesi" : null,
            day.isToday ? "Bugün" : null,
          ]
            .filter(Boolean)
            .join(" · ");

          return (
            <g key={`${day.dateIso}-${idx}`}>
              <title>{tooltipParts}</title>

              {/* Day cell tile */}
              <rect
                x={x}
                y={y}
                width={cellW}
                height={cellH}
                rx={5}
                fill={palette.fill}
                stroke={day.isToday ? "#1E478A" : palette.border}
                strokeWidth={day.isToday ? 1.8 : 1}
              />

              {/* Crisp Prussian Blue inner second ring when isToday */}
              {day.isToday ? (
                <rect
                  x={coord(x + 2.4)}
                  y={coord(y + 2.4)}
                  width={coord(cellW - 4.8)}
                  height={coord(cellH - 4.8)}
                  rx={3.2}
                  fill="none"
                  stroke="#1E478A"
                  strokeWidth={0.85}
                  strokeOpacity={0.8}
                />
              ) : null}

              {/* Top row: Day label + weekday / corner risk dot */}
              <text
                x={coord(x + 6)}
                y={coord(y + 12.5)}
                fill={day.isToday ? "#1E478A" : palette.dayColor}
                fontSize="9"
                fontWeight="700"
                style={{ fontVariantNumeric: "tabular-nums" }}
              >
                {truncateText(day.dayLabel, 8)}
              </text>

              {day.weekdayShort ? (
                <text
                  x={coord(
                    x + cellW - (palette.showRiskDot ? 13.5 : 6),
                  )}
                  y={coord(y + 12)}
                  textAnchor="end"
                  fill={palette.metaColor}
                  fontSize="8"
                  fontWeight="600"
                  style={{
                    fontFamily: "var(--font-mono), ui-monospace, monospace",
                  }}
                >
                  {truncateText(day.weekdayShort, 4)}
                </text>
              ) : null}

              {/* Corner risk seal dot on high/risky outflow days */}
              {palette.showRiskDot ? (
                <>
                  <circle
                    cx={coord(x + cellW - 7.5)}
                    cy={coord(y + 9)}
                    r={4.2}
                    fill="#A92419"
                    fillOpacity={0.18}
                  />
                  <circle
                    cx={coord(x + cellW - 7.5)}
                    cy={coord(y + 9)}
                    r={2.5}
                    fill="#A92419"
                  />
                </>
              ) : null}

              {/* Middle row: Outflow amount or calm "Ödeme yok" */}
              <text
                x={coord(x + 6)}
                y={coord(y + 27)}
                fill={palette.amountColor}
                fontSize={amountFontSize}
                fontWeight={day.safeAmount > 0 ? "700" : "600"}
                style={{ fontVariantNumeric: "tabular-nums" }}
              >
                {displayAmount}
              </text>

              {/* Bottom row: Item count + proportional micro intensity strip */}
              <text
                x={coord(x + 6)}
                y={coord(y + 38.5)}
                fill={palette.metaColor}
                fontSize="8"
                fontWeight="500"
                style={{ fontVariantNumeric: "tabular-nums" }}
              >
                {day.safeCount > 0 ? `${day.safeCount} kalem` : "Serbest"}
              </text>

              <rect
                x={coord(x + 6)}
                y={coord(y + cellH - 5.2)}
                width={barInnerMax}
                height={2.2}
                rx={1.1}
                fill={palette.border}
                fillOpacity={0.45}
              />
              {barFillW > 0 ? (
                <rect
                  x={coord(x + 6)}
                  y={coord(y + cellH - 5.2)}
                  width={barFillW}
                  height={2.2}
                  rx={1.1}
                  fill={palette.barColor}
                />
              ) : null}
            </g>
          );
        })}
      </svg>

      {/* Compact Intensity Legend Bar + Peak Summary */}
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-[11px] text-tone-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="font-medium text-tone-2">Serbest Gün</span>
          <span className="inline-flex items-center gap-1" aria-hidden>
            {HEATMAP_STOPS.map((stop, idx) => (
              <span
                key={idx}
                className="inline-block h-2.5 w-3.5 rounded-[2.5px]"
                style={{
                  backgroundColor: stop.fill,
                  border: `1px solid ${stop.border}`,
                }}
              />
            ))}
          </span>
          <span className="text-tone-3">→ Orta Yük →</span>
          <span className="inline-flex items-center gap-1 font-semibold text-neg">
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{ backgroundColor: "#A92419" }}
              aria-hidden
            />
            Kritik Çıkış Kümesi
          </span>
          {hasAnyToday ? (
            <span className="ml-1 inline-flex items-center gap-1 font-medium text-info">
              <span
                className="inline-block h-2.5 w-2.5 rounded-[2px]"
                style={{
                  border: "1.5px solid #1E478A",
                  boxShadow: "inset 0 0 0 1px #1E478A",
                }}
                aria-hidden
              />
              Bugün
            </span>
          ) : null}
        </div>

        {resolvedPeakSummary ? (
          <div className="tnum font-semibold text-tone-1">
            {resolvedPeakSummary}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   4. AgingBucketsBarSvg — Vertical Architectural Maturity / Aging Columns
   ═══════════════════════════════════════════════════════════════════════════ */

export interface AgingBucketItem {
  key: string;
  label: string; // e.g. "Gecikmiş 30+g", "1-30 Gün", "0-3 Ay", "3-12 Ay"
  amount: number;
  formattedAmount: string;
  count?: number;
  tone: "pos" | "neg" | "warn" | "info" | "accent" | "neutral";
}

export interface AgingBucketsBarProps {
  buckets: AgingBucketItem[];
  ariaLabel: string;
  className?: string;
}

export function AgingBucketsBarSvg({
  buckets,
  ariaLabel,
  className = "",
}: AgingBucketsBarProps) {
  const vbWidth = 520;
  const vbHeight = 196;

  if (buckets.length === 0) {
    return (
      <svg
        viewBox={`0 0 ${vbWidth} ${vbHeight}`}
        role="img"
        aria-label={ariaLabel}
        className={`w-full h-auto block ${className}`.trim()}
      >
        <rect
          x={12}
          y={12}
          width={vbWidth - 24}
          height={vbHeight - 24}
          rx={6}
          fill="var(--surface-1)"
          stroke="var(--line-strong)"
          strokeDasharray="4 4"
        />
        <text
          x={vbWidth / 2}
          y={vbHeight / 2 + 4}
          textAnchor="middle"
          fill="var(--text-3)"
          fontSize="11.5"
          fontWeight="500"
        >
          Vade dilimi verisi bulunmuyor
        </text>
      </svg>
    );
  }

  const sanitized = buckets.map((b) => {
    const safeAmount = Math.max(0, finiteOr(b.amount, 0));
    const safeCount =
      b.count !== undefined && Number.isFinite(b.count)
        ? Math.max(0, Math.round(b.count))
        : undefined;
    return {
      ...b,
      safeAmount,
      safeCount,
      hex: TONE_HEX[b.tone],
      softBg: TONE_SOFT_BG[b.tone],
      softBorder: TONE_SOFT_BORDER[b.tone],
    };
  });

  const totalAmount = sanitized.reduce((sum, b) => sum + b.safeAmount, 0);
  const maxAmount = sanitized.reduce(
    (max, b) => (b.safeAmount > max ? b.safeAmount : max),
    0,
  );
  const domainMax = Math.max(maxAmount, 1);

  const padLeft = 18;
  const padRight = 18;
  const plotTop = 44;
  const plotBottom = 148;
  const plotW = vbWidth - padLeft - padRight;
  const plotH = plotBottom - plotTop; // 104px

  const n = sanitized.length;
  const slotW = plotW / n;
  const barW = coord(Math.min(72, Math.max(24, slotW * 0.56)), 44);
  const maxLabelChars = n >= 6 ? 10 : n >= 5 ? 12 : 15;
  const maxAmountChars = n >= 6 ? 11 : n >= 5 ? 13 : 16;
  const amountFontSize = n >= 6 ? 9.5 : 10.5;

  const gridRatios = [0.25, 0.5, 0.75, 1];

  return (
    <svg
      viewBox={`0 0 ${vbWidth} ${vbHeight}`}
      role="img"
      aria-label={ariaLabel}
      className={`w-full h-auto block ${className}`.trim()}
    >
      {/* Ruled ledger gridlines */}
      {gridRatios.map((r) => {
        const gy = coord(plotBottom - r * plotH);
        return (
          <line
            key={r}
            x1={padLeft}
            y1={gy}
            x2={vbWidth - padRight}
            y2={gy}
            stroke="var(--line)"
            strokeWidth={0.75}
            strokeDasharray="2.5 3.5"
            strokeOpacity={0.85}
          />
        );
      })}

      {/* Architectural baseline */}
      <line
        x1={padLeft - 2}
        y1={plotBottom}
        x2={vbWidth - padRight + 2}
        y2={plotBottom}
        stroke="var(--line-strong)"
        strokeWidth={1.15}
        strokeOpacity={0.9}
      />

      {sanitized.map((bucket, idx) => {
        const centerX = coord(padLeft + slotW * idx + slotW / 2);
        const barX = coord(centerX - barW / 2);
        const rawBarH =
          maxAmount > 0 ? (bucket.safeAmount / domainMax) * plotH : 0;
        const barH = coord(
          bucket.safeAmount > 0 ? Math.max(5, rawBarH) : 2.5,
          2.5,
        );
        const barY = coord(plotBottom - barH);

        const sharePct =
          totalAmount > 0 ? (bucket.safeAmount / totalAmount) * 100 : 0;
        const shareText = formatSharePercent(sharePct);
        const pillW = Math.min(barW - 4, 42);
        const pillInside = barH >= 26 && barW >= 36;
        const pillY = pillInside ? coord(barY + 6) : coord(barY - 34);
        const amountY = coord(barY - 7);

        const [line1, line2] = splitTwoLineLabel(bucket.label, maxLabelChars);
        const displayAmount = compactFormattedMoney(
          bucket.formattedAmount,
          maxAmountChars,
        );

        return (
          <g key={bucket.key}>
            <title>
              {`${bucket.label}: ${bucket.formattedAmount} (${shareText}${bucket.safeCount !== undefined ? ` · ${bucket.safeCount} kalem` : ""})`}
            </title>

            {/* Faint recessed guide column */}
            <rect
              x={barX}
              y={plotTop}
              width={barW}
              height={plotH}
              rx={3.5}
              fill="var(--surface-2)"
              fillOpacity={0.45}
            />

            {/* Column body */}
            <rect
              x={barX}
              y={barY}
              width={barW}
              height={barH}
              rx={3}
              fill={bucket.hex}
              fillOpacity={bucket.safeAmount > 0 ? 0.84 : 0.35}
              stroke={bucket.hex}
              strokeWidth={0.85}
            />

            {/* Subtle top highlight cap */}
            {bucket.safeAmount > 0 ? (
              <rect
                x={barX}
                y={barY}
                width={barW}
                height={Math.min(3.5, barH)}
                rx={1.5}
                fill={bucket.hex}
              />
            ) : null}

            {/* Formatted amount above bar */}
            <text
              x={centerX}
              y={amountY}
              textAnchor="middle"
              fill="var(--text-1)"
              fontSize={amountFontSize}
              fontWeight="700"
              style={{ fontVariantNumeric: "tabular-nums" }}
            >
              {displayAmount}
            </text>

            {/* % share pill inside tall bars or neatly stacked above short bars */}
            <rect
              x={coord(centerX - Math.max(36, pillW) / 2)}
              y={pillY}
              width={coord(Math.max(36, pillW))}
              height={14}
              rx={3.5}
              fill={pillInside ? "var(--surface-1)" : "var(--surface-2)"}
              fillOpacity={pillInside ? 0.95 : 1}
              stroke="var(--line)"
              strokeWidth={0.75}
            />
            <text
              x={centerX}
              y={coord(pillY + 10)}
              textAnchor="middle"
              fill={bucket.hex}
              fontSize="9"
              fontWeight="700"
              style={{
                fontFamily: "var(--font-mono), ui-monospace, monospace",
                fontVariantNumeric: "tabular-nums",
              }}
            >
              {shareText}
            </text>

            {/* Bottom X-axis bucket label + optional count subtitle */}
            <text
              x={centerX}
              y={coord(plotBottom + 15)}
              textAnchor="middle"
              fill="var(--text-1)"
              fontSize="10.5"
              fontWeight="600"
            >
              {line1}
            </text>
            {line2 ? (
              <text
                x={centerX}
                y={coord(plotBottom + 26.5)}
                textAnchor="middle"
                fill="var(--text-2)"
                fontSize="9.8"
                fontWeight="500"
              >
                {line2}
              </text>
            ) : null}
            {bucket.safeCount !== undefined ? (
              <text
                x={centerX}
                y={coord(plotBottom + (line2 ? 38 : 28))}
                textAnchor="middle"
                fill="var(--text-3)"
                fontSize="9.5"
                fontWeight="500"
                style={{ fontVariantNumeric: "tabular-nums" }}
              >
                {`${TR_INT_0.format(bucket.safeCount)} kalem`}
              </text>
            ) : null}
          </g>
        );
      })}
    </svg>
  );
}

/* ═══════════════════════════════════════════════════════════════════════════
   5. ScenarioFanComparisonSvg — Base vs Stress vs Optimistic Trajectory Fan
   ═══════════════════════════════════════════════════════════════════════════ */

export interface ScenarioFanPoint {
  label: string; // e.g. "H1", "H4", "2026-12"
  baseValue: number;
  stressValue: number;
  optimisticValue?: number;
}

export interface ScenarioFanComparisonProps {
  points: ScenarioFanPoint[];
  ariaLabel: string;
  formatValue?: (v: number) => string;
  zeroLine?: boolean;
  className?: string;
}

export function ScenarioFanComparisonSvg({
  points,
  ariaLabel,
  formatValue = defaultScenarioFormatValue,
  zeroLine,
  className = "",
}: ScenarioFanComparisonProps) {
  const vbWidth = 560;
  const vbHeight = 210;
  const corridorGradId = `fan-risk-${fnv1aHash(`${ariaLabel}:${points.length}`)}`;
  const upsideGradId = `fan-opt-${fnv1aHash(`${ariaLabel}:${points.length}`)}`;

  if (points.length === 0) {
    return (
      <svg
        viewBox={`0 0 ${vbWidth} ${vbHeight}`}
        role="img"
        aria-label={ariaLabel}
        className={`w-full h-auto block ${className}`.trim()}
      >
        <rect
          x={12}
          y={12}
          width={vbWidth - 24}
          height={vbHeight - 24}
          rx={6}
          fill="var(--surface-1)"
          stroke="var(--line-strong)"
          strokeDasharray="4 4"
        />
        <text
          x={vbWidth / 2}
          y={vbHeight / 2 + 4}
          textAnchor="middle"
          fill="var(--text-3)"
          fontSize="11.5"
          fontWeight="500"
        >
          Senaryo ufku projeksiyon verisi bulunmuyor
        </text>
      </svg>
    );
  }

  const hasOptimistic = points.some(
    (p) => p.optimisticValue !== undefined && Number.isFinite(p.optimisticValue),
  );

  const sanitized = points.map((p) => {
    const base = finiteOr(p.baseValue, 0);
    const stress = finiteOr(p.stressValue, base);
    const opt =
      p.optimisticValue !== undefined && Number.isFinite(p.optimisticValue)
        ? p.optimisticValue
        : base;
    return {
      label: p.label,
      base,
      stress,
      opt,
      upper: hasOptimistic ? opt : base,
    };
  });

  const rawValues = sanitized.flatMap((p) =>
    hasOptimistic ? [p.base, p.stress, p.opt] : [p.base, p.stress],
  );
  const rawMin = Math.min(...rawValues);
  const rawMax = Math.max(...rawValues);
  const rawSpan = Math.max(rawMax - rawMin, 1);

  const crossesOrNearZero =
    (rawMin < 0 && rawMax > 0) ||
    (rawMin >= 0 && rawMin <= rawSpan * 0.28) ||
    (rawMax <= 0 && Math.abs(rawMax) <= rawSpan * 0.28) ||
    (rawMin === 0 && rawMax === 0);

  const showZeroFloor =
    zeroLine !== undefined ? zeroLine : crossesOrNearZero;

  const domainBaseMin = showZeroFloor ? Math.min(0, rawMin) : rawMin;
  const domainBaseMax = showZeroFloor ? Math.max(0, rawMax) : rawMax;
  const padDomain =
    domainBaseMax === domainBaseMin
      ? Math.max(Math.abs(domainBaseMax) * 0.2, 100)
      : (domainBaseMax - domainBaseMin) * 0.08;

  const domainMin = domainBaseMin - padDomain;
  const domainMax = domainBaseMax + padDomain;
  const domainSpan = Math.max(domainMax - domainMin, 1e-6);

  const plotLeft = 66;
  const plotRight = 478;
  const plotTop = 34;
  const plotBottom = 178;
  const plotW = plotRight - plotLeft;
  const plotH = plotBottom - plotTop;

  const count = sanitized.length;
  const toX = (idx: number): number => {
    if (count <= 1) return coord(plotLeft + plotW / 2);
    return coord(plotLeft + (idx / (count - 1)) * plotW);
  };
  const toY = (val: number): number => {
    const ratio = (finiteOr(val, 0) - domainMin) / domainSpan;
    return coord(plotBottom - ratio * plotH, plotBottom);
  };

  const coords = sanitized.map((p, idx) => ({
    ...p,
    x: toX(idx),
    yBase: toY(p.base),
    yStress: toY(p.stress),
    yOpt: toY(p.opt),
    yUpper: toY(p.upper),
  }));

  // Build corridor polygon & stroke paths (including 1-point graceful band)
  let riskCorridorPath = "";
  let upsideCorridorPath = "";
  let baseStrokePath = "";
  let stressStrokePath = "";
  let optStrokePath = "";

  if (coords.length === 1) {
    const c = coords[0];
    const xL = coord(c.x - 36);
    const xR = coord(c.x + 36);
    riskCorridorPath = `M ${xL} ${c.yBase} L ${xR} ${c.yBase} L ${xR} ${c.yStress} L ${xL} ${c.yStress} Z`;
    if (hasOptimistic) {
      upsideCorridorPath = `M ${xL} ${c.yOpt} L ${xR} ${c.yOpt} L ${xR} ${c.yBase} L ${xL} ${c.yBase} Z`;
      optStrokePath = `M ${xL} ${c.yOpt} L ${xR} ${c.yOpt}`;
    }
    baseStrokePath = `M ${xL} ${c.yBase} L ${xR} ${c.yBase}`;
    stressStrokePath = `M ${xL} ${c.yStress} L ${xR} ${c.yStress}`;
  } else {
    const forwardBase = coords.map((c) => `${c.x} ${c.yBase}`).join(" L ");
    const backwardStress = [...coords]
      .reverse()
      .map((c) => `${c.x} ${c.yStress}`)
      .join(" L ");
    riskCorridorPath = `M ${forwardBase} L ${backwardStress} Z`;

    if (hasOptimistic) {
      const forwardOpt = coords.map((c) => `${c.x} ${c.yOpt}`).join(" L ");
      const backwardBase = [...coords]
        .reverse()
        .map((c) => `${c.x} ${c.yBase}`)
        .join(" L ");
      upsideCorridorPath = `M ${forwardOpt} L ${backwardBase} Z`;
      optStrokePath = `M ${forwardOpt}`;
    }

    baseStrokePath = `M ${forwardBase}`;
    stressStrokePath = `M ${coords.map((c) => `${c.x} ${c.yStress}`).join(" L ")}`;
  }

  const zeroY = toY(0);
  const zeroVisible =
    showZeroFloor && zeroY >= plotTop - 2 && zeroY <= plotBottom + 2;

  // Y-axis reference ticks (top, mid, bottom)
  const yTicks = [
    { val: domainBaseMax, y: toY(domainBaseMax) },
    {
      val: (domainBaseMax + domainBaseMin) / 2,
      y: toY((domainBaseMax + domainBaseMin) / 2),
    },
    { val: domainBaseMin, y: toY(domainBaseMin) },
  ];

  // De-collide terminal endpoint labels on the right margin
  const last = coords[coords.length - 1];
  const rawEndpoints: Array<{
    key: string;
    y: number;
    adjustedY: number;
    color: string;
    text: string;
  }> = [
    ...(hasOptimistic
      ? [
          {
            key: "opt",
            y: last.yOpt,
            adjustedY: last.yOpt,
            color: TONE_HEX.pos,
            text: formatValue(last.opt),
          },
        ]
      : []),
    {
      key: "base",
      y: last.yBase,
      adjustedY: last.yBase,
      color: TONE_HEX.info,
      text: formatValue(last.base),
    },
    {
      key: "stress",
      y: last.yStress,
      adjustedY: last.yStress,
      color: TONE_HEX.neg,
      text: formatValue(last.stress),
    },
  ].sort((a, b) => a.y - b.y);

  const minEndpointGap = 13;
  for (let i = 1; i < rawEndpoints.length; i++) {
    if (rawEndpoints[i].adjustedY - rawEndpoints[i - 1].adjustedY < minEndpointGap) {
      rawEndpoints[i].adjustedY = coord(
        rawEndpoints[i - 1].adjustedY + minEndpointGap,
      );
    }
  }
  if (
    rawEndpoints.length > 0 &&
    rawEndpoints[rawEndpoints.length - 1].adjustedY > plotBottom + 2
  ) {
    const overflow =
      rawEndpoints[rawEndpoints.length - 1].adjustedY - (plotBottom + 2);
    for (let i = rawEndpoints.length - 1; i >= 0; i--) {
      rawEndpoints[i].adjustedY = coord(
        Math.max(plotTop - 2, rawEndpoints[i].adjustedY - overflow),
      );
    }
  }

  const labelStep = count <= 8 ? 1 : Math.ceil(count / 7);
  const showAllDots = count <= 14;

  return (
    <svg
      viewBox={`0 0 ${vbWidth} ${vbHeight}`}
      role="img"
      aria-label={ariaLabel}
      className={`w-full h-auto block ${className}`.trim()}
    >
      <defs>
        <linearGradient id={corridorGradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#A84608" stopOpacity="0.13" />
          <stop offset="100%" stopColor="#A92419" stopOpacity="0.22" />
        </linearGradient>
        <linearGradient id={upsideGradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#11694E" stopOpacity="0.16" />
          <stop offset="100%" stopColor="#1E478A" stopOpacity="0.05" />
        </linearGradient>
      </defs>

      {/* Inline Editorial Legend Strip */}
      <g transform={`translate(${plotLeft}, 15)`}>
        {/* Baz Ufuk */}
        <line
          x1={0}
          y1={0}
          x2={16}
          y2={0}
          stroke={TONE_HEX.info}
          strokeWidth={2.2}
          strokeLinecap="round"
        />
        <circle cx={8} cy={0} r={2.4} fill={TONE_HEX.info} />
        <text x={21} y={3.5} fill="var(--text-1)" fontSize="10" fontWeight="600">
          Baz Ufuk
        </text>

        {/* Stres Şoku */}
        <g transform="translate(88, 0)">
          <line
            x1={0}
            y1={0}
            x2={16}
            y2={0}
            stroke={TONE_HEX.neg}
            strokeWidth={2}
            strokeLinecap="round"
          />
          <circle cx={8} cy={0} r={2.4} fill={TONE_HEX.neg} />
          <text x={21} y={3.5} fill="var(--text-1)" fontSize="10" fontWeight="600">
            Stres Şoku
          </text>
        </g>

        {/* İyimser Band */}
        {hasOptimistic ? (
          <g transform="translate(186, 0)">
            <line
              x1={0}
              y1={0}
              x2={16}
              y2={0}
              stroke={TONE_HEX.pos}
              strokeWidth={1.8}
              strokeDasharray="3.5 2.5"
              strokeLinecap="round"
            />
            <text x={21} y={3.5} fill="var(--text-1)" fontSize="10" fontWeight="600">
              İyimser Band
            </text>
          </g>
        ) : null}

        {/* Risk Corridor Swatch */}
        <g transform={`translate(${hasOptimistic ? 294 : 186}, 0)`}>
          <rect
            x={0}
            y={-4.5}
            width={12}
            height={9}
            rx={2}
            fill={`url(#${corridorGradId})`}
            stroke="#C85A4F"
            strokeWidth={0.7}
          />
          <text x={16} y={3.5} fill="var(--text-3)" fontSize="9.5" fontWeight="500">
            Risk Koridoru
          </text>
        </g>
      </g>

      {/* Ruled Y-axis gridlines & left marginalia values */}
      {yTicks.map((tick, idx) => {
        if (zeroVisible && Math.abs(tick.y - zeroY) < 9) return null;
        return (
          <g key={idx}>
            <line
              x1={plotLeft}
              y1={tick.y}
              x2={plotRight}
              y2={tick.y}
              stroke="var(--line)"
              strokeWidth={0.75}
              strokeDasharray="2.5 3.5"
              strokeOpacity={0.85}
            />
            <text
              x={plotLeft - 7}
              y={coord(tick.y + 3.2)}
              textAnchor="end"
              fill="var(--text-3)"
              fontSize="9"
              fontWeight="500"
              style={{ fontVariantNumeric: "tabular-nums" }}
            >
              {truncateText(formatValue(tick.val), 11)}
            </text>
          </g>
        );
      })}

      {/* Shaded Upside Band (Optimistic to Base) */}
      {hasOptimistic && upsideCorridorPath ? (
        <path d={upsideCorridorPath} fill={`url(#${upsideGradId})`} />
      ) : null}

      {/* Shaded Downside Risk Corridor (Base to Stress) */}
      <path d={riskCorridorPath} fill={`url(#${corridorGradId})`} />

      {/* Dashed 0 ₺ Liquidity Floor Reference Line */}
      {zeroVisible ? (
        <g>
          <line
            x1={plotLeft - 3}
            y1={zeroY}
            x2={plotRight + 3}
            y2={zeroY}
            stroke="#A92419"
            strokeWidth={1.2}
            strokeDasharray="4.5 3"
            strokeOpacity={0.88}
          />
          <text
            x={plotLeft - 7}
            y={coord(zeroY + 3.2)}
            textAnchor="end"
            fill="#A92419"
            fontSize="9.5"
            fontWeight="700"
            style={{
              fontFamily: "var(--font-mono), ui-monospace, monospace",
              fontVariantNumeric: "tabular-nums",
            }}
          >
            0 ₺
          </text>
        </g>
      ) : null}

      {/* Optimistic Dashed Trajectory */}
      {hasOptimistic && optStrokePath ? (
        <path
          d={optStrokePath}
          fill="none"
          stroke={TONE_HEX.pos}
          strokeWidth={1.8}
          strokeDasharray="4 3"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ) : null}

      {/* Stress Solid Trajectory */}
      <path
        d={stressStrokePath}
        fill="none"
        stroke={TONE_HEX.neg}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />

      {/* Base Horizon Solid Trajectory */}
      <path
        d={baseStrokePath}
        fill="none"
        stroke={TONE_HEX.info}
        strokeWidth={2.2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />

      {/* Trajectory Nodes + Endpoint Markers */}
      {coords.map((c, idx) => {
        const isTerminal = idx === 0 || idx === count - 1;
        if (!isTerminal && !showAllDots) return null;
        const r = isTerminal ? 3.3 : 2;
        return (
          <g key={`nodes-${c.label}-${idx}`}>
            <title>
              {`${c.label} — Baz: ${formatValue(c.base)} · Stres: ${formatValue(c.stress)}${hasOptimistic ? ` · İyimser: ${formatValue(c.opt)}` : ""}`}
            </title>
            {hasOptimistic ? (
              <circle
                cx={c.x}
                cy={c.yOpt}
                r={isTerminal ? 2.8 : 1.7}
                fill="var(--surface-1)"
                stroke={TONE_HEX.pos}
                strokeWidth={1.5}
              />
            ) : null}
            <circle
              cx={c.x}
              cy={c.yStress}
              r={r}
              fill={isTerminal ? TONE_HEX.neg : "var(--surface-1)"}
              stroke={TONE_HEX.neg}
              strokeWidth={1.5}
            />
            <circle
              cx={c.x}
              cy={c.yBase}
              r={r}
              fill={isTerminal ? TONE_HEX.info : "var(--surface-1)"}
              stroke={TONE_HEX.info}
              strokeWidth={1.6}
            />
          </g>
        );
      })}

      {/* Right-Margin Terminal Endpoint Callouts */}
      {rawEndpoints.map((ep) => {
        const anchorX = count === 1 ? coord(last.x + 36) : last.x;
        return (
          <g key={ep.key}>
            <line
              x1={coord(anchorX + 4)}
              y1={ep.y}
              x2={coord(plotRight + 7)}
              y2={ep.adjustedY}
              stroke={ep.color}
              strokeWidth={0.85}
              strokeOpacity={0.65}
            />
            <text
              x={coord(plotRight + 10)}
              y={coord(ep.adjustedY + 3.3)}
              fill={ep.color}
              fontSize="9.5"
              fontWeight="700"
              style={{ fontVariantNumeric: "tabular-nums" }}
            >
              {truncateText(ep.text, 12)}
            </text>
          </g>
        );
      })}

      {/* X-Axis Baseline & Horizon Labels */}
      <line
        x1={plotLeft}
        y1={plotBottom}
        x2={plotRight}
        y2={plotBottom}
        stroke="var(--line-strong)"
        strokeWidth={0.9}
      />
      {coords.map((c, idx) => {
        const shouldShow =
          idx === 0 ||
          idx === count - 1 ||
          (idx % labelStep === 0 && count - 1 - idx >= Math.ceil(labelStep / 2));
        if (!shouldShow) return null;
        return (
          <g key={`xlab-${c.label}-${idx}`}>
            <line
              x1={c.x}
              y1={plotBottom}
              x2={c.x}
              y2={coord(plotBottom + 3.5)}
              stroke="var(--line-strong)"
              strokeWidth={0.9}
            />
            <text
              x={c.x}
              y={coord(plotBottom + 15.5)}
              textAnchor="middle"
              fill="var(--text-2)"
              fontSize="10"
              fontWeight="600"
              style={{ fontVariantNumeric: "tabular-nums" }}
            >
              {truncateText(c.label, 10)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
