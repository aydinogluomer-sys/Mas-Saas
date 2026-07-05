import Link from "next/link";
import { getPool } from "@/lib/db";
import { ensureWindow, loadThresholds } from "@/lib/radar/engine";
import {
  daylessPayments,
  instancesBetween,
  instancesOn,
  missingAmountInstances,
  monthSummary,
  overdueOpen,
  riskyDays,
} from "@/lib/radar/queries";
import { Badge } from "@/components/ui/badge";
import { Num, Panel, fmtTL } from "@/components/ui/panel";
import { InstanceRowView } from "@/components/radar/instance-row";

export const dynamic = "force-dynamic";

const fmtDay = (iso: string) => `${iso.slice(8)}.${iso.slice(5, 7)}`;

export default async function RadarPage() {
  const pool = getPool();
  const today = new Date().toISOString().slice(0, 10);
  const monthStart = today.slice(0, 7) + "-01";
  await ensureWindow(pool, today); // idempotent: generate window + refresh risk

  const tomorrow = new Date(Date.parse(today) + 86400000).toISOString().slice(0, 10);
  const weekEnd = new Date(Date.parse(today) + 6 * 86400000).toISOString().slice(0, 10);

  const [tToday, tTomorrow, tWeek, overdue, summary, missing, dayless, t] = await Promise.all([
    instancesOn(pool, today),
    instancesOn(pool, tomorrow),
    instancesBetween(pool, today, weekEnd),
    overdueOpen(pool, today),
    monthSummary(pool, monthStart),
    missingAmountInstances(pool, monthStart),
    daylessPayments(pool),
    loadThresholds(pool),
  ]);
  const risky = await riskyDays(pool, today, 30, t);

  const openCount = (rows: typeof tToday) => rows.filter((r) => r.status !== "paid").length;

  return (
    <>
      {(missing.length > 0 || dayless.length > 0) && (
        <Panel title="EKSİK VERİ — ANALİZDEN ÖNCE TAMAMLAYIN" right={<Badge tone="red">{missing.length + dayless.length}</Badge>}>
          <p className="mb-2 text-xs text-zinc-500">
            Eksik tutarlar toplamlara girmez ve asla 0 sayılmaz. Aşağıdan bu aya özel tutar girebilirsiniz.
          </p>
          {missing.map((r) => (
            <InstanceRowView key={r.id} r={r} backTo="/radar" showDate />
          ))}
          {dayless.length > 0 && (
            <div className="mt-2 border-t border-zinc-900 pt-2 text-xs">
              <span className="font-mono text-[10px] uppercase text-amber-400">günsüz kalemler (takvime giremez): </span>
              {dayless.map((p, i) => (
                <span key={p.id}>
                  {i > 0 && " · "}
                  <Link className="underline decoration-zinc-700 underline-offset-2" href={`/payments/${p.id}/edit`}>{p.name}</Link>
                </span>
              ))}
            </div>
          )}
        </Panel>
      )}

      {overdue.length > 0 && (
        <Panel title={`GECİKEN — ${overdue.length}`} right={<Badge tone="red">ÖDENDİ Mİ?</Badge>}>
          {overdue.map((r) => <InstanceRowView key={r.id} r={r} backTo="/radar" showDate />)}
        </Panel>
      )}

      <Panel title={`BUGÜN — ${fmtDay(today)}`} right={<Num>{openCount(tToday)}</Num>}>
        {tToday.length === 0 ? <p className="text-sm text-zinc-500">Bugün ödeme yok.</p>
          : tToday.map((r) => <InstanceRowView key={r.id} r={r} backTo="/radar" />)}
      </Panel>

      <Panel title="YARIN" right={<Num>{openCount(tTomorrow)}</Num>}>
        {tTomorrow.length === 0 ? <p className="text-sm text-zinc-500">Yarın ödeme yok.</p>
          : tTomorrow.map((r) => <InstanceRowView key={r.id} r={r} backTo="/radar" />)}
      </Panel>

      <Panel title="ÖNÜMÜZDEKİ 7 GÜN" right={<Num>{openCount(tWeek)}</Num>}>
        {tWeek.length === 0 ? <p className="text-sm text-zinc-500">Bu hafta ödeme yok.</p>
          : tWeek.map((r) => <InstanceRowView key={r.id} r={r} backTo="/radar" showDate />)}
      </Panel>

      <Panel title={`AY ÖZETİ — ${monthStart.slice(0, 7)}`}
        right={summary.missing_count > 0 ? <Badge tone="amber">{summary.missing_count} TUTAR EKSİK</Badge> : undefined}>
        <div className="grid grid-cols-3 gap-2">
          {([["KALAN (bilinen)", summary.known_remaining], ["ÖDENEN (bilinen)", summary.paid_known], ["TOPLAM (bilinen)", summary.known_total]] as const).map(([k, v]) => (
            <div key={k} className="border border-zinc-800 bg-black/40 p-2">
              <div className="font-mono text-[9px] uppercase tracking-wider text-zinc-500">{k}</div>
              <div className="font-mono text-sm tabular-nums">{fmtTL(v)}</div>
            </div>
          ))}
        </div>
      </Panel>

      {risky.length > 0 && (
        <Panel title="RİSKLİ GÜNLER — 30 GÜN UFKU">
          {risky.map((d) => (
            <div key={d.date} className="flex items-center gap-2 border-b border-zinc-900 py-1.5 text-sm">
              <span className="w-12 font-mono text-xs">{fmtDay(d.date)}</span>
              <span className="flex-1 text-zinc-400">
                <Num>{d.count}</Num> ödeme · <span className="font-mono tabular-nums">{fmtTL(d.knownSum)}</span>
              </span>
              <span className="flex gap-1">
                {d.critical && <Badge tone="red">kritik</Badge>}
                {d.cluster && <Badge tone="violet">yığılma</Badge>}
                {!d.critical && d.large && <Badge tone="amber">büyük</Badge>}
              </span>
            </div>
          ))}
        </Panel>
      )}
    </>
  );
}
