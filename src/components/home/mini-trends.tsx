import { useId } from "react";
import { ArrowUpRight } from "lucide-react";
import Link from "@/components/ui/app-link";

const WINDOW_POINTS = 12;

function normalizeUniformWindow(values: number[], targetPoints = WINDOW_POINTS): number[] {
  const clean = values.filter((v) => Number.isFinite(v));
  if (clean.length === 0) return [];
  if (clean.length === targetPoints) return clean;
  if (clean.length > targetPoints) {
    return Array.from({ length: targetPoints }, (_, idx) => {
      const pos = Math.round((idx / (targetPoints - 1)) * (clean.length - 1));
      return clean[pos];
    });
  }
  if (clean.length === 1) return [clean[0], clean[0]];
  return clean;
}

function buildGeometry(values: number[], w = 300, h = 72) {
  const padTop = 8;
  const padBottom = 8;
  const innerH = h - padTop - padBottom;
  if (values.length < 2) {
    return { linePath: "", areaPath: "", lastX: 0, lastY: h / 2, minIdx: 0, maxIdx: 0, coords: [] as Array<{ x: number; y: number }> };
  }
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || Math.max(Math.abs(max) * 0.15, 1);

  const coords = values.map((v, i) => ({
    x: (i / (values.length - 1)) * w,
    y: padTop + (1 - (v - min) / range) * innerH,
  }));

  const linePath = coords.map((c, i) => `${i === 0 ? "M" : "L"} ${c.x.toFixed(1)} ${c.y.toFixed(1)}`).join(" ");
  const areaPath = `${linePath} L ${coords[coords.length - 1].x.toFixed(1)} ${(h - 2).toFixed(1)} L ${coords[0].x.toFixed(1)} ${(h - 2).toFixed(1)} Z`;

  let minIdx = 0;
  let maxIdx = 0;
  values.forEach((v, i) => {
    if (v < values[minIdx]) minIdx = i;
    if (v > values[maxIdx]) maxIdx = i;
  });

  return {
    linePath,
    areaPath,
    lastX: coords[coords.length - 1].x,
    lastY: coords[coords.length - 1].y,
    minIdx,
    maxIdx,
    coords,
  };
}

/**
 * Editorial Precision v2 — MiniTrend sparkline card (M-07).
 * Uniform 12-point / 30-day window, subtle gradient area fill, endpoint dot, and delta badge.
 */
export function MiniTrend({
  title,
  subtitle,
  values,
  href,
  tone = "var(--info)",
  compact = false,
}: {
  title?: string;
  subtitle?: string;
  values: number[];
  href?: string;
  tone?: string;
  compact?: boolean;
}) {
  const rawId = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const gradId = `mini-trend-grad-${rawId}`;
  const normalized = normalizeUniformWindow(values);
  const w = 300;
  const h = compact ? 48 : 72;
  const geom = buildGeometry(normalized, w, h);

  const first = normalized[0] ?? 0;
  const last = normalized[normalized.length - 1] ?? 0;
  const deltaPct =
    normalized.length >= 2 && Math.abs(first) > 1e-6 ? ((last - first) / Math.abs(first)) * 100 : null;
  const deltaLabel =
    deltaPct != null
      ? `${deltaPct >= 0 ? "+" : ""}%${deltaPct.toFixed(1).replace(".", ",")}`
      : null;

  const sparkSvg = (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      className={compact ? "h-11 w-full" : "mt-2.5 h-[72px] w-full"}
      role="img"
      aria-label={`${title ?? "Trend"}: ${normalized.length} dönem`}
    >
      <defs>
        <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={tone} stopOpacity="0.22" />
          <stop offset="100%" stopColor={tone} stopOpacity="0.01" />
        </linearGradient>
      </defs>
      <line x1="0" x2={w} y1={h - 1.5} y2={h - 1.5} stroke="var(--line-faint)" strokeWidth="1" />
      {geom.areaPath && <path d={geom.areaPath} fill={`url(#${gradId})`} />}
      {geom.linePath && (
        <path
          d={geom.linePath}
          fill="none"
          stroke={tone}
          strokeWidth="2.25"
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      )}
      {geom.coords.length >= 2 && (
        <circle cx={geom.lastX} cy={geom.lastY} r="3.5" fill="var(--surface-1)" stroke={tone} strokeWidth="2" />
      )}
    </svg>
  );

  if (compact && !title) {
    return sparkSvg;
  }

  const content = (
    <div
      className="card-hover block h-full border p-3.5"
      style={{
        background: "var(--surface-1)",
        borderColor: "var(--line-card)",
        borderRadius: "var(--radius-md)",
        boxShadow: "var(--shadow-card)",
      }}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          {title && (
            <h3 className="truncate text-[13px] font-semibold tracking-[-0.01em]" style={{ color: "var(--text-1)" }}>
              {title}
            </h3>
          )}
          {subtitle && (
            <p className="mt-0.5 truncate text-[11.5px]" style={{ color: "var(--text-3)" }}>
              {subtitle}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          {deltaLabel && (
            <span
              className="rounded px-1.5 py-0.5 text-[10.5px] font-semibold tabular-nums"
              style={{
                background: "var(--surface-2)",
                color: "var(--text-2)",
                border: "1px solid var(--line)",
              }}
            >
              {deltaLabel}
            </span>
          )}
          {href && (
            <span className="inline-flex items-center gap-0.5 text-[11.5px] font-semibold" style={{ color: "var(--info)" }}>
              <span>Detay</span>
              <ArrowUpRight size={13} strokeWidth={1.75} aria-hidden />
            </span>
          )}
        </div>
      </div>
      {sparkSvg}
    </div>
  );

  return href ? (
    <Link href={href} className="block h-full">
      {content}
    </Link>
  ) : (
    content
  );
}
