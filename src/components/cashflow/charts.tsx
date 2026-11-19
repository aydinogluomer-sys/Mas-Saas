import type { CashMonth, ConcentrationEntry } from "@/lib/radar/rules";

const W = 860;

function scaleY(v: number, min: number, max: number, pt: number, plotH: number): number {
  if (max === min) return pt + plotH / 2;
  return pt + (1 - (v - min) / (max - min)) * plotH;
}

const kFmt = (n: number) =>
  Math.abs(n) >= 1e6
    ? (n / 1e6).toFixed(1).replace(".0", "") + "M ₺"
    : Math.abs(n) >= 1e3
      ? Math.round(n / 1e3) + "B ₺"
      : `${Math.round(n)} ₺`;

export function CashTrendChart({
  months,
  firstNegative,
  worstMonth,
}: {
  months: CashMonth[];
  firstNegative: string | null;
  worstMonth: string | null;
}) {
  const H = 240;
  const PL = 64;
  const PR = 18;
  const PT = 20;
  const PB = 30;
  const plotW = W - PL - PR;
  const plotH = H - PT - PB;

  const vals = months.map((m) => m.closing).filter((v): v is number => v != null);
  if (vals.length === 0) {
    return (
      <p className="text-[13px]" style={{ color: "var(--text-3)" }}>
        Kasa verisi yok.
      </p>
    );
  }
  const rawMin = Math.min(...vals, 0);
  const rawMax = Math.max(...vals, 0);
  const min = rawMin < 0 ? rawMin * 1.15 : 0;
  const max = rawMax > 0 ? rawMax * 1.15 : 1;

  const x = (i: number) => PL + (i / Math.max(months.length - 1, 1)) * plotW;
  const zeroY = scaleY(0, min, max, PT, plotH);

  const segments: string[] = [];
  let cur: string[] = [];
  months.forEach((m, i) => {
    if (m.closing == null) {
      if (cur.length > 1) segments.push(cur.join(" "));
      cur = [];
      return;
    }
    cur.push(`${x(i)},${scaleY(m.closing, min, max, PT, plotH)}`);
  });
  if (cur.length > 1) segments.push(cur.join(" "));

  const midVal = (min + max) / 2;
  const midY = scaleY(midVal, min, max, PT, plotH);

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="block w-full" role="img" aria-label="Kasa trend grafiği">
      <defs>
        <linearGradient id="cashflow-trend-grad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--info)" stopOpacity="0.16" />
          <stop offset="100%" stopColor="var(--info)" stopOpacity="0.01" />
        </linearGradient>
      </defs>
      <rect
        x={PL}
        y={zeroY}
        width={plotW}
        height={Math.max(scaleY(min, min, max, PT, plotH) - zeroY, 0)}
        fill="var(--neg)"
        opacity="0.07"
      />
      <line x1={PL} x2={W - PR} y1={PT} y2={PT} stroke="var(--line-faint)" strokeWidth="1" />
      <line x1={PL} x2={W - PR} y1={midY} y2={midY} stroke="var(--line-faint)" strokeWidth="1" />
      <line x1={PL} x2={W - PR} y1={zeroY} y2={zeroY} stroke="var(--line-strong)" strokeWidth="1.2" />

      {segments.map((pts, i) => (
        <polyline
          key={i}
          points={pts}
          fill="none"
          stroke="var(--info)"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}

      {months.map((m, i) => {
        const step = Math.max(1, Math.ceil(months.length / 8));
        if (i % step !== 0) return null;
        return (
          <text key={`x${m.monthStart}`} x={x(i)} y={H - 8} textAnchor="middle" fontSize="10.5" fill="var(--text-3)">
            {m.monthStart.slice(0, 7)}
          </text>
        );
      })}

      {months.map((m, i) => {
        if (m.closing == null) return null;
        const isFN = m.monthStart === firstNegative;
        const isW = m.monthStart === worstMonth;
        if (!isFN && !isW) return null;
        const anchor = x(i) > W - 100 ? "end" : x(i) < PL + 70 ? "start" : "middle";
        const cy = scaleY(m.closing, min, max, PT, plotH);
        return (
          <g key={m.monthStart}>
            <circle cx={x(i)} cy={cy} r="4.5" fill={isW ? "var(--neg)" : "var(--warn)"} stroke="var(--surface-1)" strokeWidth="1.5" />
            <text
              x={x(i)}
              y={Math.max(PT + 10, cy - 8)}
              fontSize="10.5"
              fontWeight="600"
              fill={isW ? "var(--neg)" : "var(--warn)"}
              textAnchor={anchor}
            >
              {isW ? `En düşük: ${kFmt(m.closing)}` : "İlk negatif"}
            </text>
          </g>
        );
      })}

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
  );
}

export function IncomeExpenseChart({ months }: { months: CashMonth[] }) {
  const H = 220;
  const PL = 64;
  const PR = 18;
  const PT = 22;
  const PB = 28;
  const plotW = W - PL - PR;
  const plotH = H - PT - PB;

  const vals = months.flatMap((m) => [m.income, m.expense]).filter((v): v is number => v != null);
  if (vals.length === 0) {
    return (
      <p className="text-[13px]" style={{ color: "var(--text-3)" }}>
        Gelir/gider verisi yok.
      </p>
    );
  }
  const max = Math.max(...vals, 1) * 1.15;
  const slot = plotW / months.length;
  const bw = Math.max(slot * 0.34, 2.5);
  const midY = PT + plotH / 2;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="block w-full" role="img" aria-label="Aylık gelir gider grafiği">
      <line x1={PL} x2={W - PR} y1={PT} y2={PT} stroke="var(--line-faint)" strokeWidth="1" />
      <line x1={PL} x2={W - PR} y1={midY} y2={midY} stroke="var(--line-faint)" strokeWidth="1" />
      <line x1={PL} x2={W - PR} y1={PT + plotH} y2={PT + plotH} stroke="var(--line-strong)" strokeWidth="1.15" />

      <text x={PL - 8} y={PT + 4} textAnchor="end" fontSize="10.5" fill="var(--text-3)">
        {kFmt(max)}
      </text>
      <text x={PL - 8} y={midY + 3.5} textAnchor="end" fontSize="10.5" fill="var(--text-3)">
        {kFmt(max / 2)}
      </text>

      {months.map((m, i) => {
        const x0 = PL + i * slot + slot * 0.12;
        const ih = m.income != null ? (m.income / max) * plotH : 0;
        const eh = m.expense != null ? (m.expense / max) * plotH : 0;
        const step = Math.max(1, Math.ceil(months.length / 8));
        return (
          <g key={m.monthStart}>
            {m.income != null && <rect x={x0} y={PT + plotH - ih} width={bw} height={ih} rx={1.5} fill="var(--pos)" />}
            {m.expense != null && (
              <rect x={x0 + bw + 1.5} y={PT + plotH - eh} width={bw} height={eh} rx={1.5} fill="var(--neg)" />
            )}
            {i % step === 0 && (
              <text x={x0 + bw} y={H - 8} textAnchor="middle" fontSize="10.5" fill="var(--text-3)">
                {m.monthStart.slice(0, 7)}
              </text>
            )}
          </g>
        );
      })}
      <text x={W - PR - 56} y={14} fontSize="11" fontWeight="600" fill="var(--pos)" textAnchor="end">
        ● Gelir
      </text>
      <text x={W - PR} y={14} fontSize="11" fontWeight="600" fill="var(--neg)" textAnchor="end">
        ● Gider
      </text>
    </svg>
  );
}

/**
 * Editorial Precision v2 — Counterparty / Bank Concentration Bars (M-07).
 * Warm-cream track (no dark `bg-black/60`), 25% & 40% risk threshold markers,
 * TRY + % readout, and automatic "Diğerleri" slice when entries > 6.
 */
export function ConcentrationBars({
  entries,
  unknownCount,
}: {
  entries: ConcentrationEntry[];
  unknownCount: number;
}) {
  const top = entries.slice(0, 6);
  if (top.length === 0) {
    return (
      <p className="text-[13px]" style={{ color: "var(--text-3)" }}>
        Veri yok.
      </p>
    );
  }

  const remainderEntries = entries.slice(6);
  const remainderSum = remainderEntries.reduce((s, e) => s + e.sum, 0);
  const remainderRatio = remainderEntries.reduce((s, e) => s + e.ratio, 0);

  const rows: Array<ConcentrationEntry & { isOther?: boolean }> =
    remainderEntries.length > 0 && remainderRatio > 0.002
      ? [
          ...top,
          {
            key: `Diğerleri (${remainderEntries.length} karşı taraf)`,
            sum: remainderSum,
            ratio: remainderRatio,
            flagged: false,
            isOther: true,
          },
        ]
      : top;

  const fmtTL = (n: number) => `${new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 0 }).format(n)} TL`;

  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]" style={{ color: "var(--text-3)" }}>
        <span>Pay dağılımı ve tekil karşı taraf yoğunlaşma eşikleri</span>
        <span className="inline-flex items-center gap-3">
          <span>
            <b style={{ color: "var(--warn)" }}>%25</b> İzleme
          </span>
          <span>
            <b style={{ color: "var(--neg)" }}>%40</b> Kritik Yoğunlaşma
          </span>
        </span>
      </div>

      {rows.map((e) => {
        const pct = e.ratio * 100;
        const isWarn = !e.isOther && !e.flagged && pct >= 25;
        const barColor = e.isOther
          ? "var(--text-4)"
          : e.flagged || pct >= 40
            ? "var(--neg)"
            : isWarn
              ? "var(--warn)"
              : "var(--info)";

        return (
          <div key={e.key} className="space-y-1">
            <div className="flex items-center justify-between gap-2 text-[12.5px]">
              <span
                className="flex min-w-0 items-center gap-1.5 font-medium"
                style={{ color: e.flagged ? "var(--neg)" : "var(--text-1)" }}
              >
                <span className="truncate">{e.key}</span>
                {e.flagged && (
                  <span
                    className="shrink-0 rounded border px-1.5 py-0.2 text-[10px] font-semibold"
                    style={{
                      borderColor: "color-mix(in srgb, var(--neg) 35%, var(--line))",
                      background: "color-mix(in srgb, var(--neg) 8%, var(--surface-1))",
                      color: "var(--neg)",
                    }}
                  >
                    &gt;%40 yoğunlaşma
                  </span>
                )}
                {isWarn && (
                  <span
                    className="shrink-0 rounded border px-1.5 py-0.2 text-[10px] font-semibold"
                    style={{
                      borderColor: "color-mix(in srgb, var(--warn) 35%, var(--line))",
                      background: "color-mix(in srgb, var(--warn) 8%, var(--surface-1))",
                      color: "var(--warn)",
                    }}
                  >
                    &gt;%25 izleme
                  </span>
                )}
              </span>
              <span className="shrink-0 font-semibold tabular-nums" style={{ color: "var(--text-2)" }}>
                {fmtTL(e.sum)} · %{pct.toFixed(1).replace(".", ",")}
              </span>
            </div>

            {/* Warm-cream stone track with 25% and 40% threshold ticks */}
            <div
              className="relative h-2 w-full overflow-hidden rounded-full border"
              style={{
                background: "var(--surface-2)",
                borderColor: "var(--line)",
              }}
            >
              <div
                className="h-full rounded-full transition-all"
                style={{
                  width: `${Math.min(pct, 100)}%`,
                  background: barColor,
                }}
              />
              {/* 25% watch tick */}
              <span
                aria-hidden
                className="pointer-events-none absolute bottom-0 top-0 w-px"
                style={{ left: "25%", background: "color-mix(in srgb, var(--warn) 55%, transparent)" }}
              />
              {/* 40% critical tick */}
              <span
                aria-hidden
                className="pointer-events-none absolute bottom-0 top-0 w-px"
                style={{ left: "40%", background: "color-mix(in srgb, var(--neg) 65%, transparent)" }}
              />
            </div>
          </div>
        );
      })}

      {unknownCount > 0 && (
        <p className="pt-1 text-[11.5px] font-medium" style={{ color: "var(--warn)" }}>
          +{unknownCount} satır tutarsız — orana dahil değil, karar verirken hesaba katın.
        </p>
      )}
    </div>
  );
}
