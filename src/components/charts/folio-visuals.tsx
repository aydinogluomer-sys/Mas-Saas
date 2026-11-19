// Pure-SVG Editorial & Financial Micro-Visualization Suite (DESIGN.md Section 5).
//
// 100% React Server Component (RSC) safe: zero client JS, zero hooks, deterministic SVG IDs,
// strict tabular-nums, WCAG-accessible role="img" + aria-label, and R10 financial honesty
// (null is NEVER coerced to 0).

import Link from "@/components/ui/app-link";
import { LIFECYCLE_STAGES, type LifecycleStep } from "@/lib/navigation/module-framing";
import {
  JTBD_WORKFLOW_CARDS,
  OPERATIONAL_INTENTS,
  type JobToBeDoneCardSpec,
} from "@/lib/navigation/intent-index";

export type FolioVisualTone = "info" | "accent" | "pos" | "warn" | "neg" | "neutral";

const TONE_COLOR: Record<FolioVisualTone, string> = {
  info: "var(--info)",
  accent: "var(--accent)",
  pos: "var(--pos)",
  warn: "var(--warn)",
  neg: "var(--neg)",
  neutral: "var(--text-3)",
};

function deterministicHash(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function polarToCartesian(cx: number, cy: number, r: number, angleDeg: number) {
  const rad = (angleDeg * Math.PI) / 180;
  return {
    x: Number((cx + r * Math.cos(rad)).toFixed(2)),
    y: Number((cy + r * Math.sin(rad)).toFixed(2)),
  };
}

function describeArc(cx: number, cy: number, r: number, startAngle: number, endAngle: number): string {
  const start = polarToCartesian(cx, cy, r, startAngle);
  const end = polarToCartesian(cx, cy, r, endAngle);
  const largeArcFlag = endAngle - startAngle > 180 ? 1 : 0;
  return `M ${start.x} ${start.y} A ${r} ${r} 0 ${largeArcFlag} 1 ${end.x} ${end.y}`;
}

function formatTrPercent(val: number): string {
  return `%${val.toLocaleString("tr-TR", { maximumFractionDigits: 1 })}`;
}

/* ── 1. RadialMeterSvg: 240° Archival Open-Arc Gauge ───────────────────────── */

export interface RadialMeterSvgProps {
  percent: number | null;
  label: string;
  sublabel?: string;
  targetPercent?: number;
  size?: "sm" | "md";
  className?: string;
}

export function RadialMeterSvg({
  percent,
  label,
  sublabel,
  targetPercent = 80,
  size = "md",
  className = "",
}: RadialMeterSvgProps) {
  const cx = 44;
  const cy = 39;
  const r = 27;
  const startAngle = -210;
  const totalSweep = 240;
  const endAngle = startAngle + totalSweep; // +30°

  const hasValue = percent !== null && Number.isFinite(percent);
  const clamped = hasValue ? Math.max(0, Math.min(100, percent)) : 0;
  const valueEndAngle = startAngle + (clamped / 100) * totalSweep;

  const semanticColor = !hasValue
    ? "var(--text-4)"
    : percent >= targetPercent
      ? "var(--pos)"
      : percent >= 55
        ? "var(--warn)"
        : "var(--neg)";

  const targetClamped = Math.max(0, Math.min(100, targetPercent));
  const targetAngle = startAngle + (targetClamped / 100) * totalSweep;
  const tickInner = polarToCartesian(cx, cy, r - 4.2, targetAngle);
  const tickOuter = polarToCartesian(cx, cy, r + 4.2, targetAngle);

  const svgWidth = size === "sm" ? 74 : 88;
  const svgHeight = size === "sm" ? 54 : 64;

  const ariaLabel = hasValue
    ? `${label}: ${formatTrPercent(Math.round(percent * 10) / 10)} (hedef ${formatTrPercent(targetPercent)})`
    : `${label}: veri yok`;

  return (
    <div className={`inline-flex items-center gap-3 ${className}`}>
      <svg
        width={svgWidth}
        height={svgHeight}
        viewBox="0 0 88 64"
        role="img"
        aria-label={ariaLabel}
        className="shrink-0 overflow-visible"
      >
        {/* Background track */}
        <path
          d={describeArc(cx, cy, r, startAngle, endAngle)}
          fill="none"
          stroke="var(--surface-3)"
          strokeWidth={5}
          strokeLinecap="round"
        />

        {/* Value arc (only when finite non-null percent > 0) */}
        {hasValue && clamped > 0.4 && (
          <path
            d={describeArc(cx, cy, r, startAngle, valueEndAngle)}
            fill="none"
            stroke={semanticColor}
            strokeWidth={5}
            strokeLinecap="round"
          />
        )}

        {/* Target threshold tick */}
        <line
          x1={tickInner.x}
          y1={tickInner.y}
          x2={tickOuter.x}
          y2={tickOuter.y}
          stroke="var(--text-2)"
          strokeWidth={1.25}
          strokeLinecap="round"
        />

        {/* Central readout (R10: null renders VERİ YOK, never 0%) */}
        {hasValue ? (
          <text
            x={cx}
            y={cy + 3}
            textAnchor="middle"
            fill="var(--text-1)"
            fontSize="14.5"
            fontWeight="700"
            style={{ fontVariantNumeric: "tabular-nums" }}
          >
            %{Math.round(percent)}
          </text>
        ) : (
          <text
            x={cx}
            y={cy + 2}
            textAnchor="middle"
            fill="var(--text-4)"
            fontSize="8.5"
            fontWeight="600"
            letterSpacing="0.06em"
          >
            VERİ YOK
          </text>
        )}
      </svg>

      <div className="min-w-0">
        <div className="text-[12.5px] font-semibold leading-snug text-tone-1">
          {label}
        </div>
        {sublabel ? (
          <div className="tnum mt-0.5 text-[11.5px] leading-snug text-tone-3">
            {sublabel}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/* ── 2. StackedRibbonSvg: 100% Proportional Segmented Bar ──────────────────── */

export interface StackedRibbonSegment {
  key: string;
  label: string;
  value: number;
  formattedValue?: string;
  tone?: FolioVisualTone;
}

export interface StackedRibbonSvgProps {
  segments: readonly StackedRibbonSegment[];
  title?: string;
  emptyLabel?: string;
  showLegend?: boolean;
  className?: string;
}

const DEFAULT_RIBBON_TONES: readonly FolioVisualTone[] = [
  "info",
  "accent",
  "pos",
  "warn",
  "neg",
  "neutral",
];

export function StackedRibbonSvg({
  segments,
  title,
  emptyLabel = "Dağılım verisi yok",
  showLegend = true,
  className = "",
}: StackedRibbonSvgProps) {
  const validSegments = segments.filter(
    (seg) => Number.isFinite(seg.value) && seg.value > 0,
  );
  const total = validSegments.reduce((acc, seg) => acc + seg.value, 0);

  if (validSegments.length === 0 || total <= 0) {
    return (
      <div className={`min-w-0 ${className}`}>
        {title && (
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-[0.055em] text-tone-3">
            {title}
          </div>
        )}
        <svg
          width="100%"
          height="10"
          viewBox="0 0 320 10"
          preserveAspectRatio="none"
          role="img"
          aria-label={`${title ? `${title}: ` : ""}${emptyLabel}`}
          className="block w-full"
        >
          <rect
            x="0"
            y="0"
            width="320"
            height="10"
            rx="3"
            fill="var(--surface-2)"
          />
        </svg>
        <div className="mt-1 text-[11px] text-tone-4">{emptyLabel}</div>
      </div>
    );
  }

  const totalWidth = 320;
  const gap = validSegments.length > 1 ? 1.8 : 0;
  const usableWidth = totalWidth - gap * (validSegments.length - 1);

  let cursor = 0;
  const computed = validSegments.map((seg, idx) => {
    const share = seg.value / total;
    const rawW = Math.max(3, share * usableWidth);
    const x = cursor;
    cursor += rawW + gap;
    const tone = seg.tone ?? DEFAULT_RIBBON_TONES[idx % DEFAULT_RIBBON_TONES.length];
    return {
      ...seg,
      x: Number(x.toFixed(2)),
      w: Number(Math.max(2, Math.min(rawW, totalWidth - x)).toFixed(2)),
      sharePct: share * 100,
      color: TONE_COLOR[tone],
    };
  });

  const summaryAria = computed
    .map((c) => `${c.label} ${formatTrPercent(c.sharePct)}`)
    .join(", ");

  return (
    <div className={`min-w-0 ${className}`}>
      {title && (
        <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.055em] text-tone-3">
          {title}
        </div>
      )}
      <svg
        width="100%"
        height="10"
        viewBox="0 0 320 10"
        preserveAspectRatio="none"
        role="img"
        aria-label={title ? `${title}: ${summaryAria}` : summaryAria}
        className="block w-full"
      >
        {computed.map((seg) => (
          <rect
            key={seg.key}
            x={seg.x}
            y={0}
            width={seg.w}
            height={10}
            rx={2.5}
            fill={seg.color}
          />
        ))}
      </svg>

      {showLegend && (
        <div className="tnum mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11.5px] text-tone-2">
          {computed.map((seg) => (
            <span key={seg.key} className="inline-flex items-center gap-1.5">
              <span
                className="inline-block h-2 w-2 shrink-0 rounded-[2px]"
                style={{ background: seg.color }}
                aria-hidden
              />
              <span className="font-medium text-tone-2">{seg.label}</span>
              <span className="font-semibold text-tone-1">
                {formatTrPercent(seg.sharePct)}
              </span>
              {seg.formattedValue && (
                <span className="text-tone-3">({seg.formattedValue})</span>
              )}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── 3. BulletBarSvg: Tufte Inline Actual-vs-Target Cell Meter ─────────────── */

export interface BulletBarSvgProps {
  actual: number | null;
  target: number | null;
  max?: number;
  label?: string;
  status?: "pos" | "info" | "warn" | "neg";
  width?: number;
  className?: string;
}

export function BulletBarSvg({
  actual,
  target,
  max,
  label = "Gerçekleşen vs hedef",
  status,
  width = 96,
  className = "",
}: BulletBarSvgProps) {
  if (actual === null || !Number.isFinite(actual)) {
    return (
      <span
        className={`tnum inline-flex items-center font-mono text-[10.5px] text-tone-4 ${className}`}
        role="img"
        aria-label={`${label}: veri yok`}
      >
        VERİ YOK
      </span>
    );
  }

  const absActual = Math.abs(actual);
  const absTarget = target !== null && Number.isFinite(target) ? Math.abs(target) : 0;
  const domainMax = Math.max(
    1,
    max && Number.isFinite(max) && max > 0 ? max : Math.max(absActual, absTarget) * 1.18,
  );

  const actualW = Math.min(width, Math.max(2, (absActual / domainMax) * width));
  const hasTarget = target !== null && Number.isFinite(target);
  const targetX = hasTarget
    ? Math.min(width - 1.5, Math.max(1.5, (absTarget / domainMax) * width))
    : null;

  const resolvedStatus: "pos" | "info" | "warn" | "neg" =
    status ??
    (!hasTarget
      ? "info"
      : absTarget === 0
        ? absActual === 0
          ? "pos"
          : "warn"
        : Math.abs(actual - target) / absTarget <= 0.02
          ? "pos"
          : Math.abs(actual - target) / absTarget <= 0.1
            ? "warn"
            : "neg");

  const barColor = TONE_COLOR[resolvedStatus];
  const ariaLabel = hasTarget
    ? `${label}: gerçekleşen ${actual.toLocaleString("tr-TR")}, hedef ${target.toLocaleString("tr-TR")}`
    : `${label}: gerçekleşen ${actual.toLocaleString("tr-TR")}`;

  return (
    <svg
      width={width}
      height={14}
      viewBox={`0 0 ${width} 14`}
      role="img"
      aria-label={ariaLabel}
      className={`inline-block shrink-0 align-middle ${className}`}
    >
      {/* Qualitative background range */}
      <rect
        x={0}
        y={1}
        width={width}
        height={12}
        rx={2.5}
        fill="var(--surface-2)"
      />
      {targetX !== null && (
        <rect
          x={0}
          y={1}
          width={Number(targetX.toFixed(2))}
          height={12}
          rx={2.5}
          fill="var(--surface-3)"
          opacity={0.65}
        />
      )}
      {/* 6px actual measure bar */}
      <rect
        x={0}
        y={4}
        width={Number(actualW.toFixed(2))}
        height={6}
        rx={1.5}
        fill={barColor}
      />
      {/* 2px target benchmark tick */}
      {targetX !== null && (
        <line
          x1={Number(targetX.toFixed(2))}
          y1={0.5}
          x2={Number(targetX.toFixed(2))}
          y2={13.5}
          stroke="var(--text-1)"
          strokeWidth={2}
        />
      )}
    </svg>
  );
}

/* ── 4. CccTimelineBridgeSvg: DIO + DSO − DPO = CCC Span Bridge ────────────── */

export interface CccTimelineBridgeSvgProps {
  dioDays: number | null;
  dsoDays: number | null;
  dpoDays: number | null;
  cccDays: number | null;
  className?: string;
}

export function CccTimelineBridgeSvg({
  dioDays,
  dsoDays,
  dpoDays,
  cccDays,
  className = "",
}: CccTimelineBridgeSvgProps) {
  const hasAny =
    (dioDays !== null && Number.isFinite(dioDays)) ||
    (dsoDays !== null && Number.isFinite(dsoDays)) ||
    (dpoDays !== null && Number.isFinite(dpoDays)) ||
    (cccDays !== null && Number.isFinite(cccDays));

  if (!hasAny) {
    return (
      <div
        className={`rounded-[var(--radius-control)] border border-line-faint bg-surface-2 px-3 py-2 text-[11.5px] text-tone-4 ${className}`}
        role="img"
        aria-label="Nakit dönüşüm döngüsü: veri yok"
      >
        DIO / DSO / DPO döngüsü için stok ve fatura verisi bekleniyor (VERİ YOK)
      </div>
    );
  }

  const safeDio = dioDays !== null && Number.isFinite(dioDays) ? Math.max(0, dioDays) : 0;
  const safeDso = dsoDays !== null && Number.isFinite(dsoDays) ? Math.max(0, dsoDays) : 0;
  const safeDpo = dpoDays !== null && Number.isFinite(dpoDays) ? Math.max(0, dpoDays) : 0;
  const operatingCycle = safeDio + safeDso;
  const resolvedCcc =
    cccDays !== null && Number.isFinite(cccDays)
      ? cccDays
      : operatingCycle - safeDpo;

  const spanDomain = Math.max(30, operatingCycle, safeDpo, Math.abs(resolvedCcc));
  const plotW = 312;
  const x0 = 4;

  const dioW = (safeDio / spanDomain) * plotW;
  const dsoW = (safeDso / spanDomain) * plotW;
  const dpoW = Math.min(plotW, (safeDpo / spanDomain) * plotW);
  const cccStart = Math.min(plotW + x0, x0 + dpoW);
  const cccW = Math.max(0, x0 + dioW + dsoW - cccStart);

  const cccTone = resolvedCcc > 45 ? "var(--warn)" : "var(--pos)";

  const fmtDay = (v: number | null) =>
    v !== null && Number.isFinite(v) ? `${Math.round(v)}g` : "—";

  const ariaLabel = `Nakit dönüşüm döngüsü: Stok (DIO) ${fmtDay(dioDays)}, Alacak (DSO) ${fmtDay(dsoDays)}, Borç (DPO) ${fmtDay(dpoDays)}, Net CCC ${fmtDay(resolvedCcc)}`;

  return (
    <div className={`min-w-0 ${className}`}>
      <svg
        width="100%"
        height="46"
        viewBox="0 0 320 46"
        role="img"
        aria-label={ariaLabel}
        className="block w-full"
      >
        {/* Top bar: DIO (inventory) + DSO (receivables) */}
        <rect
          x={x0}
          y={4}
          width={plotW}
          height={12}
          rx={3}
          fill="var(--surface-2)"
        />
        {dioW > 0.5 && (
          <rect
            x={x0}
            y={4}
            width={Number(dioW.toFixed(2))}
            height={12}
            rx={2.5}
            fill="var(--surface-3)"
            stroke="var(--line-strong)"
            strokeWidth={0.75}
          />
        )}
        {dsoW > 0.5 && (
          <rect
            x={Number((x0 + dioW).toFixed(2))}
            y={4}
            width={Number(dsoW.toFixed(2))}
            height={12}
            rx={2.5}
            fill="var(--info)"
          />
        )}

        {/* Dashed alignment connector from Operating Cycle end */}
        <line
          x1={Number((x0 + dioW + dsoW).toFixed(2))}
          y1={4}
          x2={Number((x0 + dioW + dsoW).toFixed(2))}
          y2={36}
          stroke="var(--line-strong)"
          strokeWidth={1}
          strokeDasharray="2 2"
        />

        {/* Bottom bar: DPO (payables financing) + Net CCC cash gap */}
        <rect
          x={x0}
          y={24}
          width={plotW}
          height={12}
          rx={3}
          fill="var(--surface-2)"
        />
        {dpoW > 0.5 && (
          <rect
            x={x0}
            y={24}
            width={Number(dpoW.toFixed(2))}
            height={12}
            rx={2.5}
            fill="var(--pos)"
          />
        )}
        {cccW > 1 && (
          <rect
            x={Number(cccStart.toFixed(2))}
            y={24}
            width={Number(cccW.toFixed(2))}
            height={12}
            rx={2.5}
            fill={cccTone}
            opacity={0.88}
          />
        )}
      </svg>

      <div className="tnum mt-1 flex flex-wrap items-center justify-between gap-x-2.5 gap-y-0.5 text-[11px] text-tone-3">
        <span>
          DIO <strong className="text-tone-1">{fmtDay(dioDays)}</strong> + DSO{" "}
          <strong className="text-info">{fmtDay(dsoDays)}</strong> − DPO{" "}
          <strong className="text-pos">{fmtDay(dpoDays)}</strong>
        </span>
        <span className="font-semibold" style={{ color: cccTone }}>
          Net CCC: {fmtDay(cccDays !== null ? cccDays : resolvedCcc)}
        </span>
      </div>
    </div>
  );
}

/* ── 5. SparklineDeltaSvg: 12-Point Horizon Polyline + Zero Line ───────────── */

export interface SparklineDeltaSvgProps {
  values: readonly (number | null)[];
  referenceValue?: number;
  tone?: "info" | "pos" | "warn" | "neg";
  width?: number;
  height?: number;
  label?: string;
  className?: string;
}

export function SparklineDeltaSvg({
  values,
  referenceValue = 0,
  tone,
  width = 140,
  height = 36,
  label = "Eğilim grafiği",
  className = "",
}: SparklineDeltaSvgProps) {
  const finitePoints: Array<{ idx: number; val: number }> = [];
  values.forEach((v, idx) => {
    if (v !== null && Number.isFinite(v)) {
      finitePoints.push({ idx, val: v });
    }
  });

  if (finitePoints.length < 2) {
    return (
      <div
        className={`inline-flex items-center font-mono text-[10.5px] text-tone-4 ${className}`}
        style={{ width, height }}
        role="img"
        aria-label={`${label}: yeterli dönem verisi yok`}
      >
        Eğilim verisi yok
      </div>
    );
  }

  const rawVals = finitePoints.map((p) => p.val);
  const minVal = Math.min(...rawVals, referenceValue);
  const maxVal = Math.max(...rawVals, referenceValue);
  const range = maxVal - minVal || 1;

  const padX = 4;
  const padY = 4;
  const innerW = width - padX * 2;
  const innerH = height - padY * 2;

  const totalCount = Math.max(2, values.length);
  const toX = (i: number) => padX + (i / (totalCount - 1)) * innerW;
  const toY = (v: number) => padY + innerH - ((v - minVal) / range) * innerH;

  const coords = finitePoints.map((p) => ({
    x: Number(toX(p.idx).toFixed(2)),
    y: Number(toY(p.val).toFixed(2)),
    val: p.val,
  }));

  const first = coords[0];
  const last = coords[coords.length - 1];
  const dipsBelowRef = rawVals.some((v) => v < referenceValue);

  const resolvedTone: "info" | "pos" | "warn" | "neg" =
    tone ?? (dipsBelowRef ? "neg" : last.val > first.val ? "pos" : "info");
  const strokeColor = TONE_COLOR[resolvedTone];

  const polylinePoints = coords.map((c) => `${c.x},${c.y}`).join(" ");
  const refY = Number(toY(referenceValue).toFixed(2));
  const areaPath = `M ${first.x} ${height - 2} L ${coords.map((c) => `${c.x} ${c.y}`).join(" L ")} L ${last.x} ${height - 2} Z`;

  const gradId = `folio-spark-${deterministicHash(`${label}:${polylinePoints}:${resolvedTone}`).toString(36)}`;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`${label}: başlangıç ${first.val.toLocaleString("tr-TR")}, son ${last.val.toLocaleString("tr-TR")}`}
      className={`inline-block shrink-0 overflow-visible ${className}`}
    >
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={strokeColor} stopOpacity="0.18" />
          <stop offset="100%" stopColor={strokeColor} stopOpacity="0.01" />
        </linearGradient>
      </defs>

      {/* Dashed reference / zero line */}
      <line
        x1={padX}
        y1={refY}
        x2={width - padX}
        y2={refY}
        stroke="var(--line-strong)"
        strokeWidth={1}
        strokeDasharray="2.5 2.5"
      />

      {/* 14% vertical gradient wash */}
      <path d={areaPath} fill={`url(#${gradId})`} />

      {/* 1.8px trajectory polyline */}
      <polyline
        points={polylinePoints}
        fill="none"
        stroke={strokeColor}
        strokeWidth={1.8}
        strokeLinecap="round"
        strokeLinejoin="round"
      />

      {/* 3px terminal focal dot */}
      <circle cx={last.x} cy={last.y} r={3} fill={strokeColor} />
    </svg>
  );
}

/* ── 6. IntentCompassSection: "Bugün ne yapmak istiyorsunuz?" Task Compass ── */

export interface IntentCompassSectionProps {
  activeStageStep?: LifecycleStep;
  canSeeHref?: (href: string) => boolean;
  cards?: readonly JobToBeDoneCardSpec[];
  className?: string;
}

export function IntentCompassSection({
  activeStageStep = 3,
  canSeeHref,
  cards = JTBD_WORKFLOW_CARDS,
  className = "",
}: IntentCompassSectionProps) {
  const allow = canSeeHref ?? (() => true);
  const visibleCards = cards.filter((card) => allow(card.href));
  const visibleIntents = OPERATIONAL_INTENTS.filter((intent) => allow(intent.primaryHref));

  return (
    <section
      aria-label="Bugün ne yapmak istiyorsunuz?"
      className={`folio-corner-mark rounded-[var(--radius-lg)] border border-line bg-surface-1 p-4 shadow-[var(--shadow-card)] ${className}`}
    >
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line-faint pb-3">
        <div>
          <div className="font-mono text-[10px] font-semibold uppercase tracking-[0.10em] text-info">
            GÖREV PUSULASI · KAPALI ÇEVRİM İŞ AKIŞI
          </div>
          <h2 className="mt-0.5 text-[15px] font-bold tracking-[-0.015em] text-tone-1">
            Bugün ne yapmak istiyorsunuz?
          </h2>
          <p className="mt-0.5 max-w-[68ch] text-[12.5px] leading-[1.45] text-tone-2">
            Veri aktarımından 4-yönlü TDHP mutabakatına, günlük ödeme icrasından 13 haftalık stres testine kadar doğrudan ilgili masaya geçin.
          </p>
        </div>

        {/* 4 Operational Intent quick pills */}
        <div className="flex flex-wrap items-center gap-1.5">
          {visibleIntents.map((intent) => (
            <Link
              key={intent.key}
              href={intent.primaryHref}
              className="inline-flex items-center gap-1.5 rounded-[var(--radius-control)] border border-line bg-surface-0 px-2.5 py-1 text-[11.5px] font-semibold text-tone-2 transition-colors hover:border-line-strong hover:bg-surface-2 hover:text-tone-1"
            >
              <span className="tnum font-mono text-[10px] text-info">
                {intent.stepBadge}
              </span>
              <span>{intent.shortLabel}</span>
            </Link>
          ))}
        </div>
      </div>

      {/* 5-Stage Lifecycle Pipeline Strip */}
      <div
        className="mt-3 flex flex-wrap items-center gap-1.5 rounded-[var(--radius-md)] border border-line-faint bg-surface-0 px-3 py-2"
        role="list"
        aria-label="5 aşamalı finansal yaşam döngüsü"
      >
        {LIFECYCLE_STAGES.filter((st) => allow(st.href)).map((stage, idx, arr) => {
          const isActive = stage.step === activeStageStep;
          return (
            <span key={stage.step} className="inline-flex items-center gap-1.5" role="listitem">
              <Link
                href={stage.href}
                aria-current={isActive ? "step" : undefined}
                title={stage.description}
                className="tnum inline-flex items-center gap-1.5 rounded-[var(--radius-sm)] border px-2 py-0.5 text-[11.5px] transition-colors"
                style={{
                  borderColor: isActive
                    ? "color-mix(in srgb, var(--info) 42%, var(--line-strong))"
                    : "var(--line)",
                  background: isActive
                    ? "color-mix(in srgb, var(--info) 9%, var(--surface-1))"
                    : "var(--surface-1)",
                  color: isActive ? "var(--info)" : "var(--text-2)",
                  fontWeight: isActive ? 600 : 500,
                }}
              >
                {stage.shortLabel}
              </Link>
              {idx < arr.length - 1 && (
                <span className="font-mono text-[10px] text-tone-4" aria-hidden>
                  →
                </span>
              )}
            </span>
          );
        })}
      </div>

      {/* 6 Concrete Job-to-be-Done Workflow Cards */}
      <div className="mt-3 grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
        {visibleCards.map((card) => (
          <Link
            key={card.id}
            href={card.href}
            className="card-hover group flex flex-col justify-between rounded-[var(--radius-md)] border border-edge bg-surface-0 p-3 transition-colors hover:bg-surface-hover"
          >
            <div>
              <div className="tnum font-mono text-[10px] font-semibold uppercase tracking-[0.06em] text-tone-3">
                {card.eyebrow}
              </div>
              <div className="mt-1 text-[13.5px] font-semibold leading-snug text-tone-1 group-hover:text-info">
                {card.title}
              </div>
              <p className="mt-1 max-w-[68ch] text-[12px] leading-[1.45] text-tone-2">
                {card.description}
              </p>
            </div>
            <div className="mt-2.5 flex items-center justify-between border-t border-line-faint pt-2 text-[11.5px] font-semibold text-info">
              <span>{card.ctaLabel}</span>
              <span className="font-mono text-xs" aria-hidden>
                →
              </span>
            </div>
          </Link>
        ))}
      </div>
    </section>
  );
}

/* ── 7. FolioQrBadgeSvg: Deterministic Pure-SVG 21×21 Shop-Floor QR Matrix ─── */

export interface FolioQrBadgeSvgProps {
  code: string;
  size?: number;
  caption?: string;
  className?: string;
}

function isFinderModule(row: number, col: number): boolean | null {
  const checkCorner = (r0: number, c0: number): boolean | null => {
    const dr = row - r0;
    const dc = col - c0;
    if (dr >= -1 && dr <= 7 && dc >= -1 && dc <= 7) {
      // 1-module quiet separator around 7x7 finder
      if (dr === -1 || dr === 7 || dc === -1 || dc === 7) return false;
      // Outer 7x7 ring
      if (dr === 0 || dr === 6 || dc === 0 || dc === 6) return true;
      // Inner 3x3 solid square
      if (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4) return true;
      return false;
    }
    return null;
  };

  return (
    checkCorner(0, 0) ??
    checkCorner(0, 14) ??
    checkCorner(14, 0)
  );
}

export function FolioQrBadgeSvg({
  code,
  size = 84,
  caption,
  className = "",
}: FolioQrBadgeSvgProps) {
  const grid = 21;
  let state = deterministicHash(`MAS-QR-V1:${code}`) || 0x9e3779b9;

  const nextBit = (): boolean => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return ((state >>> 0) & 1) === 1;
  };

  const darkCells: Array<{ r: number; c: number }> = [];
  for (let r = 0; r < grid; r++) {
    for (let c = 0; c < grid; c++) {
      const finder = isFinderModule(r, c);
      let isDark: boolean;
      if (finder !== null) {
        isDark = finder;
      } else if (r === 6) {
        isDark = c % 2 === 0;
      } else if (c === 6) {
        isDark = r % 2 === 0;
      } else if (r === 13 && c === 8) {
        isDark = true;
      } else {
        isDark = nextBit();
      }
      if (isDark) {
        darkCells.push({ r, c });
      }
    }
  }

  return (
    <div
      className={`inline-flex flex-col items-center rounded-[var(--radius-md)] border border-line bg-surface-1 p-2 shadow-[var(--shadow-card)] ${className}`}
    >
      <svg
        width={size}
        height={size}
        viewBox="0 0 25 25"
        shapeRendering="crispEdges"
        role="img"
        aria-label={`İş emri karekodu: ${code}${caption ? ` (${caption})` : ""}`}
      >
        <rect x="0" y="0" width="25" height="25" fill="var(--surface-1)" />
        {darkCells.map((cell) => (
          <rect
            key={`${cell.r}-${cell.c}`}
            x={cell.c + 2}
            y={cell.r + 2}
            width={1}
            height={1}
            fill="var(--text-1)"
          />
        ))}
      </svg>
      <div className="tnum mt-1 max-w-full truncate font-mono text-[10.5px] font-semibold text-tone-1">
        {code}
      </div>
      {caption ? (
        <div className="max-w-full truncate text-[10px] text-tone-3">
          {caption}
        </div>
      ) : null}
    </div>
  );
}
