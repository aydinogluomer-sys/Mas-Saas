// Server-rendered SVG charts for /cashflow. No client JS, no chart deps —
// deterministic, testable, fast. Null values leave gaps (never drawn as 0).
import type { CashMonth, ConcentrationEntry } from "@/lib/radar/rules";

const W = 800;

function scaleY(v: number, min: number, max: number, h: number, pad: number): number {
  if (max === min) return h / 2;
  return pad + (1 - (v - min) / (max - min)) * (h - 2 * pad);
}

const kFmt = (n: number) =>
  Math.abs(n) >= 1e6 ? (n / 1e6).toFixed(1).replace(".0", "") + "M"
  : Math.abs(n) >= 1e3 ? Math.round(n / 1e3) + "k" : String(Math.round(n));

export function CashTrendChart({ months, firstNegative, worstMonth }: {
  months: CashMonth[]; firstNegative: string | null; worstMonth: string | null;
}) {
  const H = 220, pad = 16;
  const vals = months.map((m) => m.closing).filter((v): v is number => v != null);
  if (vals.length === 0) return <p className="text-sm text-tone-3">Kasa verisi yok.</p>;
  const min = Math.min(...vals, 0), max = Math.max(...vals, 0);
  const x = (i: number) => pad + (i / Math.max(months.length - 1, 1)) * (W - 2 * pad);
  const zeroY = scaleY(0, min, max, H, pad);

  // segments: break the line at nulls (gap, not zero)
  const segments: string[] = [];
  let cur: string[] = [];
  months.forEach((m, i) => {
    if (m.closing == null) { if (cur.length > 1) segments.push(cur.join(" ")); cur = []; return; }
    cur.push(`${x(i)},${scaleY(m.closing, min, max, H, pad)}`);
  });
  if (cur.length > 1) segments.push(cur.join(" "));

  const midVal = (min + max) / 2;
  const midY = scaleY(midVal, min, max, H, pad);
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="block w-full" role="img" aria-label="Kasa trend grafiği">
      <rect x={pad} y={zeroY} width={W - 2 * pad} height={Math.max(scaleY(min, min, max, H, pad) - zeroY, 0)} fill="var(--neg)" opacity="0.08" />
      <line x1={pad} x2={W - pad} y1={midY} y2={midY} stroke="var(--line)" strokeWidth="1" />
      <line x1={pad} x2={W - pad} y1={zeroY} y2={zeroY} stroke="var(--text-4)" strokeWidth="1" strokeDasharray="4 4" />
      {segments.map((pts, i) => (
        <polyline key={i} points={pts} fill="none" stroke="var(--info)" strokeWidth="2" />
      ))}
      {months.map((m, i) =>
        i % 6 === 0 ? (
          <text key={`x${m.monthStart}`} x={x(i)} y={H - 4} fontSize="8" fill="var(--text-4)" fontFamily="var(--font-mono)">
            {m.monthStart.slice(2, 7)}
          </text>
        ) : null,
      )}
      {months.map((m, i) => {
        if (m.closing == null) return null;
        const isFN = m.monthStart === firstNegative;
        const isW = m.monthStart === worstMonth;
        if (!isFN && !isW) return null;
        const anchor = x(i) > W - 90 ? "end" : x(i) < 90 ? "start" : "middle";
        return (
          <g key={m.monthStart}>
            <circle cx={x(i)} cy={scaleY(m.closing, min, max, H, pad)} r="4" fill={isW ? "var(--neg)" : "var(--warn)"} />
            <text x={x(i)} y={scaleY(m.closing, min, max, H, pad) - 8} fontSize="10" fill={isW ? "var(--neg)" : "var(--warn)"}
              textAnchor={anchor} fontFamily="var(--font-mono)">
              {isW ? `en kötü ${kFmt(m.closing)}` : "ilk negatif"}
            </text>
          </g>
        );
      })}
      <text x={pad} y={12} fontSize="10" fill="var(--text-4)" fontFamily="var(--font-mono)">{kFmt(max)}</text>
      <text x={pad} y={midY - 4} fontSize="9" fill="var(--text-4)" fontFamily="var(--font-mono)">{kFmt(midVal)}</text>
      <text x={pad} y={H - 14} fontSize="10" fill="var(--text-4)" fontFamily="var(--font-mono)">{kFmt(min)}</text>
    </svg>
  );
}

export function IncomeExpenseChart({ months }: { months: CashMonth[] }) {
  const H = 200, pad = 16;
  const vals = months.flatMap((m) => [m.income, m.expense]).filter((v): v is number => v != null);
  if (vals.length === 0) return <p className="text-sm text-tone-3">Gelir/gider verisi yok.</p>;
  const max = Math.max(...vals, 1);
  const slot = (W - 2 * pad) / months.length;
  const bw = Math.max(slot * 0.32, 2);
  const midY = H - pad - (H - 2 * pad) / 2;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="block w-full" role="img" aria-label="Aylık gelir gider grafiği">
      <line x1={pad} x2={W - pad} y1={midY} y2={midY} stroke="var(--line)" strokeWidth="1" />
      <text x={pad} y={midY - 4} fontSize="9" fill="var(--text-4)" fontFamily="var(--font-mono)">{kFmt(max / 2)}</text>
      {months.map((m, i) => {
        const x0 = pad + i * slot;
        const ih = m.income != null ? (m.income / max) * (H - 2 * pad) : 0;
        const eh = m.expense != null ? (m.expense / max) * (H - 2 * pad) : 0;
        return (
          <g key={m.monthStart}>
            {m.income != null && <rect x={x0} y={H - pad - ih} width={bw} height={ih} fill="var(--pos)" />}
            {m.expense != null && <rect x={x0 + bw + 1} y={H - pad - eh} width={bw} height={eh} fill="var(--neg)" />}
            {i % 6 === 0 && (
              <text x={x0} y={H - 3} fontSize="8" fill="var(--text-4)" fontFamily="var(--font-mono)">
                {m.monthStart.slice(2, 7)}
              </text>
            )}
          </g>
        );
      })}
      <text x={W - pad} y={12} fontSize="10" fill="var(--pos)" textAnchor="end" fontFamily="var(--font-mono)">gelir</text>
      <text x={W - pad} y={24} fontSize="10" fill="var(--neg)" textAnchor="end" fontFamily="var(--font-mono)">gider</text>
    </svg>
  );
}

export function ConcentrationBars({ entries, unknownCount }: {
  entries: ConcentrationEntry[]; unknownCount: number;
}) {
  const top = entries.slice(0, 6);
  if (top.length === 0) return <p className="text-sm text-tone-3">Veri yok.</p>;
  return (
    <div>
      {top.map((e) => (
        <div key={e.key} className="mb-2">
          <div className="flex items-center justify-between text-xs">
            <span className={e.flagged ? "text-neg" : "text-tone-2"}>
              {e.key}
              {e.flagged && <span className="ml-2 border border-neg px-1 font-mono text-[9px] uppercase text-neg">&gt;%40 yoğunlaşma</span>}
            </span>
            <span className="font-mono tabular-nums text-tone-2">
              {new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 0 }).format(e.sum)} · %{(e.ratio * 100).toFixed(1)}
            </span>
          </div>
          <div className="mt-1 h-1.5 bg-black/60">
            <div className={`h-1.5 ${e.flagged ? "bg-neg" : "bg-info"}`} style={{ width: `${Math.min(e.ratio * 100, 100)}%` }} />
          </div>
        </div>
      ))}
      {unknownCount > 0 && (
        <p className="mt-1 font-mono text-[10px] text-warn">
          +{unknownCount} satır tutarsız — orana dahil değil, karar verirken hesaba katın.
        </p>
      )}
    </div>
  );
}
