import Link from "next/link";
import { getPool } from "@/lib/db";
import { generateInstancesForMonth, loadThresholds, refreshRiskFlags } from "@/lib/radar/engine";
import { addMonths, monthInstances } from "@/lib/radar/queries";
import { dayFlags, daysInMonth } from "@/lib/radar/rules";
import { Panel } from "@/components/ui/panel";
import { InstanceRowView } from "@/components/radar/instance-row";

export const dynamic = "force-dynamic";

const AY = ["Ocak","Şubat","Mart","Nisan","Mayıs","Haziran","Temmuz","Ağustos","Eylül","Ekim","Kasım","Aralık"];
const GUN = ["Pzt","Sal","Çar","Per","Cum","Cmt","Paz"];

export default async function CalendarPage({
  searchParams,
}: { searchParams: Promise<{ ym?: string; day?: string }> }) {
  const sp = await searchParams;
  const today = new Date().toISOString().slice(0, 10);
  const ym = /^\d{4}-\d{2}$/.test(sp.ym ?? "") ? sp.ym! : today.slice(0, 7);
  const monthStart = ym + "-01";
  const selDay = sp.day && /^\d{1,2}$/.test(sp.day) ? Number(sp.day) : null;

  const pool = getPool();
  await generateInstancesForMonth(pool, monthStart); // idempotent
  await refreshRiskFlags(pool, today);
  const [rows, t] = await Promise.all([monthInstances(pool, monthStart), loadThresholds(pool)]);

  const [y, m] = ym.split("-").map(Number);
  const dim = daysInMonth(y, m);
  const firstDow = (new Date(Date.UTC(y, m - 1, 1)).getUTCDay() + 6) % 7;
  const byDay = new Map<number, typeof rows>();
  for (const r of rows) {
    const d = Number(r.due_date.slice(8));
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d)!.push(r);
  }
  const kFmt = (n: number) => (n >= 1e6 ? (n / 1e6).toFixed(1).replace(".0", "") + "M" : n >= 1e3 ? Math.round(n / 1e3) + "k" : String(n));
  const cells: Array<number | null> = [...Array(firstDow).fill(null), ...Array.from({ length: dim }, (_, i) => i + 1)];
  const nav = (delta: number) => `/calendar?ym=${addMonths(monthStart, delta).slice(0, 7)}`;
  const isCurrent = ym === today.slice(0, 7);
  const todayD = Number(today.slice(8));

  return (
    <>
      <Panel title="ÖDEME TAKVİMİ"
        right={
          <span className="flex items-center gap-1">
            <Link href={nav(-1)} className="border border-zinc-700 px-2 py-1 font-mono text-xs">‹</Link>
            <span className="px-2 font-mono text-xs uppercase tracking-wider">{AY[m - 1]} {y}</span>
            <Link href={nav(1)} className="border border-zinc-700 px-2 py-1 font-mono text-xs">›</Link>
          </span>
        }>
        <div className="grid grid-cols-7 gap-1">
          {GUN.map((g) => (
            <div key={g} className="py-0.5 text-center font-mono text-[9px] uppercase text-zinc-600">{g}</div>
          ))}
          {cells.map((d, i) => {
            if (d == null) return <div key={`e${i}`} />;
            const list = byDay.get(d) ?? [];
            const f = dayFlags(list.map((x) => ({ id: x.id, dueDate: x.due_date, amount: x.amount, status: x.status })), t);
            const allPaid = list.length > 0 && list.every((x) => x.status === "paid");
            const border = allPaid ? "border-emerald-800" : f.critical ? "border-red-800" : f.cluster || f.large ? "border-amber-800" : list.length ? "border-sky-900" : "border-zinc-900";
            const isToday = isCurrent && d === todayD;
            return (
              <Link key={d} href={`/calendar?ym=${ym}&day=${d}`}
                className={`min-h-14 border ${border} ${isToday ? "bg-zinc-800/60" : "bg-zinc-950"} p-1 hover:bg-zinc-900`}>
                <div className={`font-mono text-[11px] ${isToday ? "font-bold text-white" : "text-zinc-500"}`}>{d}</div>
                {list.length > 0 && (
                  <>
                    <div className={`font-mono text-[10px] ${allPaid ? "text-emerald-400" : "text-zinc-300"}`}>{list.length}×</div>
                    {f.knownSum > 0 && <div className="font-mono text-[9px] text-zinc-500">{kFmt(f.knownSum)}</div>}
                  </>
                )}
              </Link>
            );
          })}
        </div>
        <div className="mt-2 flex flex-wrap gap-3 text-[10px] text-zinc-500">
          <span className="flex items-center gap-1"><span className="inline-block h-2 w-2 border border-red-800" /> kritik</span>
          <span className="flex items-center gap-1"><span className="inline-block h-2 w-2 border border-amber-800" /> yığılma/büyük</span>
          <span className="flex items-center gap-1"><span className="inline-block h-2 w-2 border border-sky-900" /> ödeme var</span>
          <span className="flex items-center gap-1"><span className="inline-block h-2 w-2 border border-emerald-800" /> tamamı ödendi</span>
        </div>
      </Panel>

      {selDay != null && (
        <Panel title={`${selDay} ${AY[m - 1].toUpperCase()} — ${(byDay.get(selDay) ?? []).length} ÖDEME`}
          right={<Link href={`/calendar?ym=${ym}`} className="font-mono text-[10px] uppercase text-zinc-400 underline underline-offset-2">kapat</Link>}>
          {(byDay.get(selDay) ?? []).length === 0
            ? <p className="text-sm text-zinc-500">Bu güne ödeme yok.</p>
            : (byDay.get(selDay) ?? []).map((r) => (
                <InstanceRowView key={r.id} r={r} backTo={`/calendar?ym=${ym}&day=${selDay}`} />
              ))}
        </Panel>
      )}
    </>
  );
}
