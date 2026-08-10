import Link from "next/link";
import { getPool } from "@/lib/db";
import { istanbulDateISO } from "@/lib/reports/rules";
import { ensureWindow, loadThresholds } from "@/lib/radar/engine";
import {
  daylessPayments,
  instancesBetween,
  instancesOn,
  missingAmountInstances,
  monthInstances,
  paidInstances,
  monthSummary,
  overdueOpen,
  riskyDays,
} from "@/lib/radar/queries";
import { Badge } from "@/components/ui/badge";
import { Num, Panel, fmtTL } from "@/components/ui/panel";
import { KpiCard, PageHeader } from "@/components/ui/shell";
import { InstanceRowView } from "@/components/radar/instance-row";
import { requireSession } from "@/lib/auth";

export const dynamic = "force-dynamic";

const fmtDay = (iso: string) => `${iso.slice(8)}.${iso.slice(5, 7)}`;

export default async function RadarPage({ searchParams }: { searchParams?: Promise<{ view?: string }> }) {
  const session = await requireSession();
  const view = (await searchParams)?.view;
  const pool = getPool();
  const today = istanbulDateISO();
  const monthStart = today.slice(0, 7) + "-01";
  await ensureWindow(pool, today, session.id); // idempotent: generate window + refresh risk

  const tomorrow = new Date(Date.parse(today) + 86400000).toISOString().slice(0, 10);
  const weekEnd = new Date(Date.parse(today) + 6 * 86400000).toISOString().slice(0, 10);

  const [tToday, tTomorrow, tWeek, overdue, summary, missing, dayless, historyRows, t] = await Promise.all([
    instancesOn(pool, today),
    instancesOn(pool, tomorrow),
    instancesBetween(pool, today, weekEnd),
    overdueOpen(pool, today),
    monthSummary(pool, monthStart),
    missingAmountInstances(pool, monthStart),
    daylessPayments(pool),
    view === "history" ? paidInstances(pool) : monthInstances(pool, monthStart),
    loadThresholds(pool),
  ]);
  const risky = await riskyDays(pool, today, 30, t);

  const openCount = (rows: typeof tToday) => rows.filter((r) => r.status !== "paid").length;

  const next7Open = openCount(tWeek);
  return (
    <>
      <PageHeader
        title="Ödeme Radarı"
        subtitle="Bugün, yarın ve önümüzdeki 7 gün · geciken · eksik tutar · riskli günler"
        meta={
          <>
            <Badge tone="neutral" dot>bugün {fmtDay(today)}</Badge>
            {overdue.length > 0 && <Badge tone="red">{overdue.length} geciken</Badge>}
            {summary.missing_count > 0 && <Badge tone="amber">{summary.missing_count} tutar eksik</Badge>}
            <Badge tone="neutral">7 günde {next7Open} açık</Badge>
          </>
        }
      />

      {view === "history" && (
        <Panel title="ÖDEME GEÇMİŞİ" right={<Badge tone="green">{historyRows.length} ödendi</Badge>}>
          {historyRows.filter((r) => r.status === "paid").length === 0 ? (
            <p className="text-sm text-tone-3">Bu ay ödenmiş işlem yok.</p>
          ) : historyRows.filter((r) => r.status === "paid").map((r) => (
            <InstanceRowView key={r.id} r={r} backTo="/payments?view=history" showDate />
          ))}
        </Panel>
      )}

      {(missing.length > 0 || dayless.length > 0) && (
        <Panel title="EKSİK VERİ — ANALİZDEN ÖNCE TAMAMLAYIN" right={<Badge tone="red">{missing.length + dayless.length}</Badge>}>
          <p className="mb-2 text-xs text-tone-3">
            Eksik tutarlar toplamlara girmez ve asla 0 sayılmaz. Aşağıdan bu aya özel tutar girebilirsiniz.
          </p>
          {missing.map((r) => (
            <InstanceRowView key={r.id} r={r} backTo="/radar" showDate />
          ))}
          {dayless.length > 0 && (
            <div className="mt-2 border-t border-line-faint pt-2 text-xs">
              <span className="font-mono text-[10px] uppercase text-warn">günsüz kalemler (takvime giremez): </span>
              {dayless.map((p, i) => (
                <span key={p.id}>
                  {i > 0 && " · "}
                  <Link className="underline decoration-line-strong underline-offset-2" href={`/payments/${p.id}/edit`}>{p.name}</Link>
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
        {tToday.length === 0 ? <p className="text-sm text-tone-3">Bugün ödeme yok.</p>
          : tToday.map((r) => <InstanceRowView key={r.id} r={r} backTo="/radar" />)}
      </Panel>

      <Panel title="YARIN" right={<Num>{openCount(tTomorrow)}</Num>}>
        {tTomorrow.length === 0 ? <p className="text-sm text-tone-3">Yarın ödeme yok.</p>
          : tTomorrow.map((r) => <InstanceRowView key={r.id} r={r} backTo="/radar" />)}
      </Panel>

      <Panel title="ÖNÜMÜZDEKİ 7 GÜN" right={<Num>{openCount(tWeek)}</Num>}>
        {tWeek.length === 0 ? <p className="text-sm text-tone-3">Bu hafta ödeme yok.</p>
          : tWeek.map((r) => <InstanceRowView key={r.id} r={r} backTo="/radar" showDate />)}
      </Panel>

      <Panel title={`AY ÖZETİ — ${monthStart.slice(0, 7)}`}
        right={summary.missing_count > 0 ? <Badge tone="amber">{summary.missing_count} TUTAR EKSİK</Badge> : undefined}>
        <div className="grid grid-cols-3 gap-2">
          <KpiCard label="Kalan (bilinen)" value={fmtTL(summary.known_remaining)} tone={summary.known_remaining > 0 ? "warn" : "neutral"} />
          <KpiCard label="Ödenen (bilinen)" value={fmtTL(summary.paid_known)} tone="pos" />
          <KpiCard label="Toplam (bilinen)" value={fmtTL(summary.known_total)} />
        </div>
      </Panel>

      {risky.length > 0 && (
        <Panel title="RİSKLİ GÜNLER — 30 GÜN UFKU">
          {risky.map((d) => (
            <div key={d.date} className="row-hover flex items-center gap-2 border-b border-line-faint px-1 py-1.5 text-sm">
              <span className="w-12 font-mono text-xs">{fmtDay(d.date)}</span>
              <span className="flex-1 text-tone-2">
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
