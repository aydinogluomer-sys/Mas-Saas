import Link from "@/components/ui/app-link";
import { getPool } from "@/lib/db";
import { istanbulDateISO } from "@/lib/reports/rules";
import { loadThresholds } from "@/lib/radar/engine";
import { addMonths, monthInstances, overdueOpen, toRiskInput } from "@/lib/radar/queries";
import { dayFlags, daysInMonth } from "@/lib/radar/rules";
import { getTurkishHoliday } from "@/lib/calendar/tr-holidays";
import { generateTrStatutoryObligations, type TrStatutoryObligation } from "@/lib/calendar/tr-tax-calendar";
import { Badge } from "@/components/ui/badge";
import { Panel } from "@/components/ui/panel";
import { TableShell } from "@/components/ui/shell";
import { InstanceRowView } from "@/components/radar/instance-row";
import { requireSession } from "@/lib/auth";
import { can } from "@/lib/authz/matrix";
import { ActionFeedback } from "@/components/ui/action-feedback";

export const dynamic = "force-dynamic";

const AY = ["Ocak","Şubat","Mart","Nisan","Mayıs","Haziran","Temmuz","Ağustos","Eylül","Ekim","Kasım","Aralık"];
const GUN = ["Pzt","Sal","Çar","Per","Cum","Cmt","Paz"];

export default async function CalendarPage({
  searchParams,
}: { searchParams: Promise<{ ym?: string; day?: string; date?: string; instance?: string; age?: string; error?: string }> }) {
  const session = await requireSession();
  const sp = await searchParams;
  const today = istanbulDateISO();
  const pool = getPool();
  const instanceDate = sp.instance && /^[0-9a-f-]{36}$/i.test(sp.instance)
    ? (await pool.query<{due_date:string}>("select to_char(due_date,'YYYY-MM-DD') due_date from public.payment_instances where id=$1", [sp.instance])).rows[0]?.due_date
    : null;
  const explicitDate = /^\d{4}-\d{2}-\d{2}$/.test(sp.date ?? "") ? sp.date : instanceDate;
  const ym = /^\d{4}-\d{2}$/.test(sp.ym ?? "") ? sp.ym! : explicitDate?.slice(0, 7) ?? today.slice(0, 7);
  const monthStart = ym + "-01";
  const selDay = sp.day && /^\d{1,2}$/.test(sp.day) ? Number(sp.day) : explicitDate ? Number(explicitDate.slice(8)) : null;

  // Faz 3: GET render salt-okunurdur; pencere ve risk bayrakları yazma/bakım yollarında yenilenir.
  const [rows, t] = await Promise.all([monthInstances(pool, monthStart), loadThresholds(pool)]);

  const [y, m] = ym.split("-").map(Number);
  const dim = daysInMonth(y, m);
  const monthEnd = `${ym}-${String(dim).padStart(2, "0")}`;
  const firstDow = (new Date(Date.UTC(y, m - 1, 1)).getUTCDay() + 6) % 7;
  const byDay = new Map<number, typeof rows>();
  for (const r of rows) {
    const d = Number(r.due_date.slice(8));
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d)!.push(r);
  }
  const taxObligations = generateTrStatutoryObligations(monthStart, monthEnd);
  const taxByDay = new Map<number, TrStatutoryObligation[]>();
  for (const ob of taxObligations) {
    if (ob.effectiveDueDate.startsWith(ym)) {
      const d = Number(ob.effectiveDueDate.slice(8));
      if (!taxByDay.has(d)) taxByDay.set(d, []);
      taxByDay.get(d)!.push(ob);
    }
  }
  const holidayByDay = new Map<number, NonNullable<ReturnType<typeof getTurkishHoliday>>>();
  for (let d = 1; d <= dim; d++) {
    const iso = `${ym}-${String(d).padStart(2, "0")}`;
    const h = getTurkishHoliday(iso);
    if (h) holidayByDay.set(d, h);
  }
  const kFmt = (n: number) => (n >= 1e6 ? (n / 1e6).toFixed(1).replace(".0", "") + "M" : n >= 1e3 ? Math.round(n / 1e3) + "k" : String(n));
  const cells: Array<number | null> = [...Array(firstDow).fill(null), ...Array.from({ length: dim }, (_, i) => i + 1)];
  const canMutate = can(session.role, "payment_instances", "update");
  const nav = (delta: number) => `/payments/calendar?ym=${addMonths(monthStart, delta).slice(0, 7)}`;
  const isCurrent = ym === today.slice(0, 7);
  const todayD = Number(today.slice(8));

  return (
    <>
      {/* Reddedilen mutasyonlar buraya `?error=` ile döner (payments/actions.ts → backTo). */}
      <ActionFeedback error={sp.error} />
      <Panel title="ÖDEME TAKVİMİ"
        right={
          <span className="flex flex-wrap items-center justify-end gap-1">
            <Link href={nav(-12)} className="border border-line-strong px-2 py-1 font-mono text-xs" aria-label="Bir yıl geri">−1y</Link>
            <Link href={nav(-1)} className="border border-line-strong px-2 py-1 font-mono text-xs">‹</Link>
            <span className="px-2 font-mono text-xs uppercase tracking-wider">{AY[m - 1]} {y}</span>
            <Link href={nav(1)} className="border border-line-strong px-2 py-1 font-mono text-xs">›</Link>
            <Link href={nav(12)} className="border border-line-strong px-2 py-1 font-mono text-xs" aria-label="Bir yıl ileri">+1y</Link>
          </span>
        }>
        <form action="/payments/calendar" className="mb-3 flex flex-wrap items-end gap-2">
          <label className="text-[10px] uppercase tracking-wider text-tone-3">Ay ve yıl<input type="month" name="ym" defaultValue={ym} className="field-control mt-1 block p-2" /></label>
          <button className="button-accent px-3 py-2">Aya git</button>
          <Link href="/payments/calendar" className="button-ghost px-3 py-2">Bugün</Link>
          <Link href="/payments/new" className="button-ghost px-3 py-2">Ödeme ekle</Link>
        </form>
        <div className="grid grid-cols-7 gap-1">
          {GUN.map((g) => (
            <div key={g} className="py-0.5 text-center font-mono text-[9px] uppercase text-tone-4">{g}</div>
          ))}
          {cells.map((d, i) => {
            if (d == null) return <div key={`e${i}`} />;
            const list = byDay.get(d) ?? [];
            const taxes = taxByDay.get(d) ?? [];
            const holiday = holidayByDay.get(d);
            const f = dayFlags(list.map(toRiskInput), t);
            const allPaid = list.length > 0 && list.every((x) => x.status === "paid");
            const border = allPaid ? "border-pos" : f.critical ? "border-neg" : f.cluster || f.large || taxes.length > 0 ? "border-warn" : list.length ? "border-info" : "border-line-faint";
            const isToday = isCurrent && d === todayD;
            return (
              <Link key={d} href={`/payments/calendar?ym=${ym}&day=${d}`}
                title={holiday ? `${holiday.name}${holiday.halfDay ? " (Yarım gün)" : ""}` : undefined}
                className={`min-h-14 border ${border} ${isToday ? "bg-surface-3" : "bg-surface-0"} p-1 hover:bg-surface-2`}>
                <div className="flex items-center justify-between gap-1">
                  <span className={`font-mono text-[11px] ${isToday ? "font-bold text-tone-1" : "text-tone-3"}`}>{d}</span>
                  {holiday && <span className="font-mono text-[8px] uppercase text-warn">{holiday.halfDay ? "Arife" : "Tatil"}</span>}
                </div>
                {list.length > 0 && (
                  <>
                    <div className={`font-mono text-[10px] ${allPaid ? "text-pos" : "text-tone-2"}`}>{list.length}×</div>
                    {f.knownSum > 0 && <div className="font-mono text-[9px] text-tone-3">{kFmt(f.knownSum)}</div>}
                    {f.foreignCount > 0 && <div className="font-mono text-[9px] text-warn">{f.foreignCount} TRY-dışı</div>}
                  </>
                )}
                {taxes.length > 0 && (
                  <div className="mt-0.5 truncate font-mono text-[8px] uppercase text-info">
                    {taxes.map((tx) => tx.code.replace("_", "-")).join(", ")}
                  </div>
                )}
              </Link>
            );
          })}
        </div>
        <div className="mt-2 flex flex-wrap gap-3 text-[10px] text-tone-3">
          <span className="flex items-center gap-1"><span className="inline-block h-2 w-2 border border-neg" /> kritik</span>
          <span className="flex items-center gap-1"><span className="inline-block h-2 w-2 border border-warn" /> yığılma / büyük / vergi-SGK günü</span>
          <span className="flex items-center gap-1"><span className="inline-block h-2 w-2 border border-info" /> ödeme var</span>
          <span className="flex items-center gap-1"><span className="inline-block h-2 w-2 border border-pos" /> tamamı ödendi</span>
        </div>
      </Panel>

      {selDay != null && (
        <Panel title={`${selDay} ${AY[m - 1].toUpperCase()} — ${(byDay.get(selDay) ?? []).length} ÖDEME${(taxByDay.get(selDay) ?? []).length ? ` · ${(taxByDay.get(selDay) ?? []).length} YASAL YÜKÜMLÜLÜK` : ""}`}
          right={<Link href={`/payments/calendar?ym=${ym}`} className="font-mono text-[10px] uppercase text-tone-2 underline underline-offset-2">kapat</Link>}>
          {holidayByDay.get(selDay) && (
            <div className="mb-2 border border-warn p-2 text-xs text-warn">
              Resmî tatil: <strong>{holidayByDay.get(selDay)!.name}</strong>
              {holidayByDay.get(selDay)!.halfDay ? " (Yarım gün — VUK Md. 18 kapsamında tam iş günü sayılır)" : " — VUK Md. 18 uyarınca yasal vadeler takip eden ilk iş gününe devreder."}
            </div>
          )}
          {(taxByDay.get(selDay) ?? []).length > 0 && (
            <div className="mb-2 space-y-1">
              {(taxByDay.get(selDay) ?? []).map((tx) => (
                <div key={tx.id} className="flex flex-wrap items-center justify-between gap-2 border border-line-faint bg-surface-2 px-2.5 py-1.5 text-xs">
                  <span><Badge tone="blue">{tx.authority}</Badge> <strong className="ml-1">{tx.label}</strong></span>
                  <span className="font-mono text-[11px] text-tone-3">
                    Son gün: {tx.effectiveDueDate}
                    {tx.shiftedFrom ? ` (nominal ${tx.shiftedFrom} → ${tx.shiftReason})` : ""}
                  </span>
                </div>
              ))}
            </div>
          )}
          {(byDay.get(selDay) ?? []).length === 0
            ? <p className="text-sm text-tone-3">Bu güne kayıtlı şirket ödemesi yok.</p>
            : (byDay.get(selDay) ?? []).map((r) => (
                <InstanceRowView canMutate={canMutate} key={r.id} r={r} backTo={`/payments/calendar?ym=${ym}&day=${selDay}`} />
              ))}
        </Panel>
      )}

      <Panel
        title="RESMİ VERGİ / SGK TAKVİMİ VE VUK MD. 18 TATİL KAYDIRMALARI"
        subtitle={`${AY[m - 1]} ${y} dönemindeki yasal GİB / SGK beyan ve ödeme son günleri (hafta sonu ve 2429 sayılı Kanun resmi tatillerinde VUK Md. 18 uyarınca ilk iş gününe kaydırılır)`}
        right={<Badge tone="neutral">{taxObligations.length} yükümlülük</Badge>}
      >
        <TableShell>
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left font-mono text-[10px] uppercase text-tone-4">
                <th className="py-1">Kurum</th>
                <th>Kod</th>
                <th>Yükümlülük</th>
                <th>Vergi Dönemi</th>
                <th>Nominal Vade</th>
                <th>VUK Md. 18 Son Gün</th>
                <th>Kaydırma Nedeni</th>
              </tr>
            </thead>
            <tbody>
              {taxObligations.map((ob) => (
                <tr key={ob.id} className="border-t border-line-faint">
                  <td className="py-1.5"><Badge tone={ob.authority === "GIB" ? "blue" : "amber"}>{ob.authority}</Badge></td>
                  <td className="font-mono">{ob.code}</td>
                  <td>{ob.label}</td>
                  <td className="font-mono text-tone-3">{ob.taxPeriod}</td>
                  <td className="font-mono text-tone-3">{ob.statutoryNominalDate}</td>
                  <td className="font-mono font-semibold">{ob.effectiveDueDate}</td>
                  <td className="text-tone-3">{ob.shiftReason ?? "Tam iş günü (kaydırma yok)"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableShell>
      </Panel>
      {sp.age && <AgeingDetail age={sp.age} today={today} rows={await overdueOpen(pool, today)} canMutate={canMutate} />}
    </>
  );
}

function AgeingDetail({age,today,rows,canMutate}:{age:string;today:string;rows:Awaited<ReturnType<typeof overdueOpen>>;canMutate:boolean}) {
  const bounds:Record<string,[number,number,string]>={"1-30":[1,30,"1–30 gün gecikmiş"],"31-90":[31,90,"31–90 gün gecikmiş"],"91+":[91,Infinity,"91+ gün gecikmiş"]};
  const selected=bounds[age]; if(!selected)return null;
  const filtered=rows.filter((row)=>{const days=Math.floor((Date.parse(today)-Date.parse(row.due_date))/86400000);return days>=selected[0]&&days<=selected[1]});
  return <Panel title={selected[2]} right={<Link href="/payments" className="button-ghost px-2 py-1">Özete dön</Link>}>{filtered.length===0?<p className="text-sm text-tone-3">Bu gecikme aralığında ödeme bulunmuyor.</p>:filtered.map((row)=><InstanceRowView canMutate={canMutate} key={row.id} r={row} backTo={`/payments/calendar?age=${encodeURIComponent(age)}`}/>)}</Panel>;
}
