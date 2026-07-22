import { getPool } from "@/lib/db";
import { istanbulDateISO } from "@/lib/reports/rules";
import { loadThresholds } from "@/lib/radar/engine";
import { paymentOverviewInstances } from "@/lib/radar/queries";
import { dayFlags } from "@/lib/radar/rules";
import { Badge } from "@/components/ui/badge";
import { fmtTL, Panel } from "@/components/ui/panel";
import { KpiCard, PageHeader } from "@/components/ui/shell";
import Link from "next/link";
import { AnalyticsChart } from "@/components/charts/analytics-chart";
import { analyzePaymentPressure, paymentPressureModel, prioritizePayments } from "@/lib/analytics/models";

export const dynamic = "force-dynamic";

export default async function PaymentsOverviewPage() {
  const pool = getPool();
  const today = istanbulDateISO();
  const tomorrow = new Date(Date.parse(today) + 86400000).toISOString().slice(0, 10);
  const weekEnd = new Date(Date.parse(today) + 6 * 86400000).toISOString().slice(0, 10);
  const anchor = new Date(`${today}T00:00:00Z`);
  const futureEnd = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + 24, anchor.getUTCDate())).toISOString().slice(0, 10);
  const [overviewRows, thresholds] = await Promise.all([
    paymentOverviewInstances(pool, today, futureEnd),
    loadThresholds(pool),
  ]);
  const todayRows = overviewRows.filter((row) => row.due_date === today);
  const tomorrowRows = overviewRows.filter((row) => row.due_date === tomorrow);
  const weekRows = overviewRows.filter((row) => row.due_date >= today && row.due_date <= weekEnd);
  const futureRows = overviewRows.filter((row) => row.due_date >= today);
  const overdue = overviewRows.filter((row) => row.due_date < today && ["unpaid", "partial", "planned", "late"].includes(row.status));
  const riskEnd = new Date(Date.parse(today) + 30 * 86400000).toISOString().slice(0, 10);
  const riskBuckets = new Map<string, typeof overviewRows>();
  for (const row of overviewRows) {
    if (row.due_date < today || row.due_date > riskEnd) continue;
    const bucket = riskBuckets.get(row.due_date) ?? [];
    bucket.push(row);
    riskBuckets.set(row.due_date, bucket);
  }
  const risky = [...riskBuckets.entries()].filter(([, rows]) => {
    const flags = dayFlags(rows.map((row) => ({ id: row.id, dueDate: row.due_date, amount: row.amount, status: row.status })), thresholds);
    return flags.cluster || flags.critical || flags.large;
  });
  const open = (rows: typeof todayRows) => rows.filter((row) => row.status !== "paid");
  const sum = (rows: typeof todayRows) => rows.reduce((total, row) => total + (row.amount == null ? 0 : Math.max(0, row.amount - (row.paid_amount ?? 0))), 0);
  const priorities = prioritizePayments([...overdue, ...todayRows, ...tomorrowRows], today);
  const pressureRows = [...overdue, ...futureRows];
  const pressure = analyzePaymentPressure(pressureRows, today);
  const pct = (value:number) => `%${new Intl.NumberFormat("tr-TR",{maximumFractionDigits:1}).format(value*100)}`;
  return <>
    <PageHeader title="Ödemeler özeti" subtitle="Bugün, yarın ve yedi günlük ödeme yükünün karar görünümü." action={<Link href="/payments/new" className="button-accent px-3 py-2">Ödeme ekle</Link>} meta={<Badge tone={overdue.length ? "red" : "green"} dot>{overdue.length} geciken</Badge>} />
    <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
      <KpiCard label="Bugün" value={open(todayRows).length ? fmtTL(sum(open(todayRows))) : "Ödeme yok"} tone={open(todayRows).length ? "warn" : "pos"} />
      <KpiCard label="Yarın" value={open(tomorrowRows).length ? fmtTL(sum(open(tomorrowRows))) : "Ödeme yok"} tone={open(tomorrowRows).length ? "info" : "pos"} />
      <KpiCard label="7 günlük çıkış" value={fmtTL(sum(open(weekRows)))} />
      <KpiCard label="Riskli gün" value={risky.length} tone={risky.length ? "neg" : "pos"} />
    </div>
    <Panel title="STRATEJİK ÖDEME UFKU" subtitle="Gecikmiş portföy ve bugünden ileri 24 aylık bilinen yük">
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-5">
        {pressure.horizons.map((horizon) => <Link key={horizon.id} href={`/payments?chartPeriod=${horizon.id === "overdue" || horizon.id === "0-3" ? "3m" : horizon.id === "4-6" ? "6m" : horizon.id === "7-12" ? "12m" : "24m"}`} className="row-hover border border-line-faint p-3" style={{borderRadius:"var(--radius-md)"}}>
          <div className="text-[10px] uppercase tracking-wider text-tone-3">{horizon.label}</div>
          <div className="mt-2 font-mono text-lg">{fmtTL(horizon.knownAmount)}</div>
          <div className="mt-1 flex flex-wrap gap-1 text-[10px] text-tone-3"><span>{horizon.count} kayıt</span><span>· {pct(horizon.share)}</span>{horizon.unknownCount > 0 && <Badge tone="amber">{horizon.unknownCount} tutar eksik</Badge>}</div>
          <div className="mt-2 text-[10px] text-tone-3">En yoğun gün: {horizon.peakDate ?? "—"}</div>
        </Link>)}
      </div>
    </Panel>
    <AnalyticsChart model={paymentPressureModel(pressureRows, today, {criticalThreshold:thresholds.critical})} kind="bar" defaultPeriod="3m" />
    <div className="grid gap-3 xl:grid-cols-2">
      <Panel title="GECİKME YAŞLANDIRMASI" subtitle={`${overdue.length} açık gecikmiş kayıt · ${fmtTL(pressure.horizons[0]?.knownAmount ?? 0)}`} accent={overdue.length ? "neg" : "pos"}>
        <div className="grid gap-2 sm:grid-cols-3">
          {pressure.ageing.filter((bucket) => bucket.count > 0).map((bucket) => <Link key={bucket.id} href={`/payments/calendar?age=${encodeURIComponent(bucket.id)}`} className="row-hover border border-line-faint p-3" style={{borderRadius:"var(--radius-md)"}}>
            <div className="text-xs font-semibold">{bucket.label}</div><div className="mt-2 font-mono text-base">{fmtTL(bucket.knownAmount)}</div>
            <div className="mt-1 text-[10px] text-tone-3">{bucket.count} kayıt · {pct(bucket.share)}</div><div className="mt-1 text-[10px] text-tone-3">En eski: {bucket.oldestDueDate ?? "—"}</div>
          </Link>)}
        </div>
      </Panel>
      <Panel title="ESNEKLİK VE KRİTİKLİK" subtitle="Yalnız açık kaynak öncelikleri kullanılır; sistem tahmin üretmez">
        <div className="space-y-2">{pressure.flexibility.filter((group) => group.count > 0).map((group) => <div key={group.id} className="grid grid-cols-[1fr_auto] items-center gap-3 border-b border-line-faint py-2">
          <div><Badge tone={group.id === "critical" ? "red" : group.id === "optional" ? "green" : group.id === "flexible" ? "blue" : "neutral"}>{group.label}</Badge><span className="ml-2 text-xs text-tone-3">{group.templateCount} ödeme kalemi</span></div>
          <div className="text-right font-mono text-sm">{fmtTL(group.knownAmount)}{group.unknownCount > 0 && <div className="text-[10px] text-warn">{group.unknownCount} tutar eksik</div>}</div>
        </div>)}</div>
        {pressure.flexibility.some((group) => group.id === "unclassified" && group.count > 0) && <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border border-warn p-3 text-xs"><span>Bu kalemlerin kaynak dosyasında esneklik bilgisi yok. Yanlış karar üretmemek için sistem otomatik tahmin yapmadı.</span><Link href="/payments/items" className="button-accent px-3 py-2">Kalemleri sınıflandır</Link></div>}
      </Panel>
    </div>
    <Panel title="KRİTİK ÖDEME İZLEME LİSTESİ" subtitle="Gecikme, kritiklik, kalan tutar ve vade önceliğine göre sıralı" right={<Link href="/payments/items" className="button-ghost px-2 py-1">Tüm kalemler</Link>}>
      <div className="overflow-x-auto"><table className="w-full min-w-[820px] text-xs"><thead><tr><th>Ödeme</th><th>Kategori</th><th>Vade</th><th>Durum</th><th>Döviz</th><th className="text-right">Kalan</th><th>Esneklik</th><th>Önerilen işlem</th></tr></thead><tbody>{pressure.watchList.map((row) => <tr key={row.id} className="border-t border-line-faint">
        <td className="py-2"><Link className="underline underline-offset-2" href={`/payments/calendar?date=${row.due_date}`}>{row.name}</Link></td><td>{row.category ?? "—"}</td><td className="font-mono">{row.due_date}</td><td>{row.daysOverdue > 0 ? <Badge tone="red">{row.daysOverdue} gün gecikti</Badge> : <Badge tone="blue">Planlı</Badge>}</td><td>{row.currency ?? "TRY"}</td><td className="text-right font-mono">{fmtTL(row.remaining)}</td><td><Badge tone={row.decisionFlexibility === "critical" ? "red" : row.decisionFlexibility === "optional" ? "green" : row.decisionFlexibility === "flexible" ? "blue" : "neutral"}>{row.decisionFlexibility === "critical" ? "Kritik" : row.decisionFlexibility === "optional" ? "İsteğe bağlı" : row.decisionFlexibility === "flexible" ? "Esnek" : "Sınıflandırılmadı"}</Badge></td><td>{row.daysOverdue > 0 ? "Ödeme veya müzakere kararı" : row.decisionFlexibility === "critical" ? "Nakit karşılığını doğrula" : "Vade planını izle"}</td>
      </tr>)}</tbody></table></div>
    </Panel>
    <Panel title="ÖNCELİKLİ ÖDEMELER" subtitle="Açık gecikmişler önce; ardından bugün ve yarın. Aynı tarihte kritik/riskli ve yüksek kalan tutar öne çıkar." right={<Link href="/payments/calendar" className="button-accent px-3 py-2">Takvimi aç</Link>}>
      {priorities.length === 0 ? <p className="text-sm text-tone-3">Bugün için öncelikli ödeme bulunmuyor.</p> : priorities.map((row) =>
        <div key={row.id} className="row-hover flex items-center justify-between gap-3 border-b border-line-faint py-2">
          <div><div className="text-sm">{row.name}</div><div className="font-mono text-[10px] text-tone-3">{row.due_date}</div></div>
          <div className="text-right"><div className="font-mono text-sm">{fmtTL(row.amount)}</div><Badge tone={row.due_date < today ? "red" : "amber"}>{row.due_date < today ? "gecikti" : "yaklaşıyor"}</Badge></div>
        </div>)}
    </Panel>
  </>;
}
