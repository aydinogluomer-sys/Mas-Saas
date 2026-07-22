// Baseline vs scenario closing-balance chart. Server-rendered SVG, no deps.
// Null closings leave gaps (never drawn as 0).

export interface ScenarioLine {
  month_start: string;
  base_close: number | null;
  scen_close: number | null;
}

const W = 800;
const kFmt = (n: number) =>
  Math.abs(n) >= 1e6 ? (n / 1e6).toFixed(1).replace(".0", "") + "M"
  : Math.abs(n) >= 1e3 ? Math.round(n / 1e3) + "k" : String(Math.round(n));

export function ScenarioChart({ lines }: { lines: ScenarioLine[] }) {
  const H = 240, pad = 18;
  const vals = lines.flatMap((l) => [l.base_close, l.scen_close]).filter((v): v is number => v != null);
  if (vals.length === 0) return <p className="text-sm text-tone-3">Kasa verisi yok.</p>;
  const min = Math.min(...vals, 0), max = Math.max(...vals, 0);
  const x = (i: number) => pad + (i / Math.max(lines.length - 1, 1)) * (W - 2 * pad);
  const y = (v: number) => (max === min ? H / 2 : pad + (1 - (v - min) / (max - min)) * (H - 2 * pad));
  const zeroY = y(0);

  const path = (pick: (l: ScenarioLine) => number | null): string[] => {
    const segs: string[] = [];
    let cur: string[] = [];
    lines.forEach((l, i) => {
      const v = pick(l);
      if (v == null) { if (cur.length > 1) segs.push(cur.join(" ")); cur = []; return; }
      cur.push(`${x(i)},${y(v)}`);
    });
    if (cur.length > 1) segs.push(cur.join(" "));
    return segs;
  };

  const midVal = (min + max) / 2;
  const midY = y(midVal);
  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="block w-full" role="img" aria-label="Baz vs senaryo kasa grafiği">
        <rect x={pad} y={zeroY} width={W - 2 * pad} height={Math.max(y(min) - zeroY, 0)} fill="var(--neg)" opacity="0.08" />
        <line x1={pad} x2={W - pad} y1={midY} y2={midY} stroke="var(--line)" strokeWidth="1" />
        <line x1={pad} x2={W - pad} y1={zeroY} y2={zeroY} stroke="var(--text-4)" strokeWidth="1" strokeDasharray="4 4" />
        {lines.map((l, i) =>
          i % 6 === 0 ? (
            <text key={`x${l.month_start}`} x={x(i)} y={H - 4} fontSize="8" fill="var(--text-4)" fontFamily="var(--font-mono)">
              {l.month_start.slice(2, 7)}
            </text>
          ) : null,
        )}
        {path((l) => l.base_close).map((pts, i) => (
          <polyline key={`b${i}`} points={pts} fill="none" stroke="var(--text-4)" strokeWidth="2" strokeDasharray="5 4" />
        ))}
        {path((l) => l.scen_close).map((pts, i) => (
          <polyline key={`s${i}`} points={pts} fill="none" stroke="var(--info)" strokeWidth="2.5" />
        ))}
        <text x={pad} y={12} fontSize="10" fill="var(--text-4)" fontFamily="var(--font-mono)">{kFmt(max)}</text>
        <text x={pad} y={midY - 4} fontSize="9" fill="var(--text-4)" fontFamily="var(--font-mono)">{kFmt(midVal)}</text>
        <text x={pad} y={H - 14} fontSize="10" fill="var(--text-4)" fontFamily="var(--font-mono)">{kFmt(min)}</text>
      </svg>
      <div className="mt-1 flex gap-4 font-mono text-[10px] text-tone-3">
        <span>— — baz senaryo</span>
        <span className="text-info">—— senaryo</span>
      </div>
    </div>
  );
}
