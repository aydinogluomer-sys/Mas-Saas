import { getPool } from "@/lib/db";
import { istanbulDateISO } from "@/lib/reports/rules";
import { loadThresholds } from "@/lib/radar/engine";
import { loadPaymentDashboard, type PaymentDashboardBucket } from "@/lib/radar/queries";
import { Badge } from "@/components/ui/badge";
import { fmtTL, Panel } from "@/components/ui/panel";
import { KpiCard, PageHeader } from "@/components/ui/shell";
import Link from "next/link";
import { PaymentsChartLazy } from "@/components/charts/payments-chart-lazy";
import { Suspense } from "react";

export const dynamic = "force-dynamic";

const DAY_MS = 86400000;
const addDays = (iso: string, days: number) => new Date(Date.parse(iso) + days * DAY_MS).toISOString().slice(0, 10);
const bucketTotal = (rows: PaymentDashboardBucket[]) => rows.reduce((sum, row) => sum + row.knownAmount, 0);
const bucketCount = (rows: PaymentDashboardBucket[]) => rows.reduce((sum, row) => sum + row.count, 0);

async function PaymentsDashboardContent() {
  const pool = getPool();
  const today = istanbulDateISO();
  const tomorrow = addDays(today, 1);
  const weekEnd = addDays(today, 6);
  const anchor = new Date(`${today}T00:00:00Z`);
  const futureEnd = new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + 24, anchor.getUTCDate())).toISOString().slice(0, 10);
  const [{ buckets, flexibility: rawFlexibility, watchList, priorities }, thresholds] = await Promise.all([
    loadPaymentDashboard(pool, today, futureEnd),
    loadThresholds(pool),
  ]);
  const todayRows = buckets.filter((row) => row.dueDate === today);
  const tomorrowRows = buckets.filter((row) => row.dueDate === tomorrow);
  const weekRows = buckets.filter((row) => row.dueDate >= today && row.dueDate <= weekEnd);
  const overdueRows = buckets.filter((row) => row.status === "overdue");
  const overdueCount = bucketCount(overdueRows);
  const riskEnd = addDays(today, 30);
  const riskDates = [...new Set(buckets.filter((row) => row.dueDate >= today && row.dueDate <= riskEnd).map((row) => row.dueDate))];
  const risky = riskDates.filter((date) => {
    const rows = buckets.filter((row) => row.dueDate === date);
    return bucketCount(rows) >= thresholds.clusterCount || rows.some((row) => (row.maxAmount ?? 0) >= thresholds.large) || bucketTotal(rows) >= thresholds.critical;
  });
  const horizonDefs = [
    ["overdue", "Gecikmiş", (date: string) => date < today],
    ["0-3", "0–3 ay", (date: string) => date >= today && date < new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + 3, anchor.getUTCDate())).toISOString().slice(0, 10)],
    ["4-6", "4–6 ay", (date: string) => date >= new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + 3, anchor.getUTCDate())).toISOString().slice(0, 10) && date < new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + 6, anchor.getUTCDate())).toISOString().slice(0, 10)],
    ["7-12", "7–12 ay", (date: string) => date >= new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + 6, anchor.getUTCDate())).toISOString().slice(0, 10) && date < new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + 12, anchor.getUTCDate())).toISOString().slice(0, 10)],
    ["13-24", "13–24 ay", (date: string) => date >= new Date(Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth() + 12, anchor.getUTCDate())).toISOString().slice(0, 10)],
  ] as const;
  const knownTotal = bucketTotal(buckets);
  const horizons = horizonDefs.map(([id, label, match]) => {
    const rows = buckets.filter((row) => match(row.dueDate));
    const perDate = new Map<string, number>();
    for (const row of rows) perDate.set(row.dueDate, (perDate.get(row.dueDate) ?? 0) + row.knownAmount);
    const peakDate = [...perDate].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
    const knownAmount = bucketTotal(rows);
    return { id, label, count: bucketCount(rows), knownAmount, unknownCount: rows.reduce((sum, row) => sum + row.unknownCount, 0), share: knownTotal ? knownAmount / knownTotal : 0, peakDate };
  });
  const overdueKnown = bucketTotal(overdueRows);
  const ageingDefs = [["1-30", "1–30 gün", 1, 30], ["31-90", "31–90 gün", 31, 90], ["91+", "91+ gün", 91, Infinity]] as const;
  const ageing = ageingDefs.map(([id, label, min, max]) => {
    const rows = overdueRows.filter((row) => { const days = Math.floor((Date.parse(today) - Date.parse(row.dueDate)) / DAY_MS); return days >= min && days <= max; });
    const knownAmount = bucketTotal(rows);
    return { id, label, count: bucketCount(rows), knownAmount, share: overdueKnown ? knownAmount / overdueKnown : 0, oldestDueDate: rows.map((row) => row.dueDate).sort()[0] ?? null };
  });
  const flexLabels = { critical: "Kritik", flexible: "Esnek", optional: "İsteğe bağlı", unclassified: "Sınıflandırılmadı" } as const;
  const flexibility = (["critical", "flexible", "optional", "unclassified"] as const).map((id) => ({ id, label: flexLabels[id], count: 0, templateCount: 0, knownAmount: 0, unknownCount: 0, ...rawFlexibility.find((row) => row.id === id) }));
  const pct = (value:number) => `%${new Intl.NumberFormat("tr-TR",{maximumFractionDigits:1}).format(value*100)}`;
  return <>
    <div className="flex justify-end"><Badge tone={overdueCount ? "red" : "green"} dot>{overdueCount} geciken</Badge></div>
    <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
      <KpiCard label="Bugün" value={bucketCount(todayRows) ? fmtTL(bucketTotal(todayRows)) : "Ödeme yok"} tone={bucketCount(todayRows) ? "warn" : "pos"} />
      <KpiCard label="Yarın" value={bucketCount(tomorrowRows) ? fmtTL(bucketTotal(tomorrowRows)) : "Ödeme yok"} tone={bucketCount(tomorrowRows) ? "info" : "pos"} />
      <KpiCard label="7 günlük çıkış" value={fmtTL(bucketTotal(weekRows))} />
      <KpiCard label="Riskli gün" value={risky.length} tone={risky.length ? "neg" : "pos"} />
    </div>
    <Panel title="STRATEJİK ÖDEME UFKU" subtitle="Gecikmiş portföy ve bugünden ileri 24 aylık bilinen yük">
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-5">
        {horizons.map((horizon) => <Link key={horizon.id} href={`/payments?chartPeriod=${horizon.id === "overdue" || horizon.id === "0-3" ? "3m" : horizon.id === "4-6" ? "6m" : horizon.id === "7-12" ? "12m" : "24m"}`} className="row-hover border border-line-faint p-3" style={{borderRadius:"var(--radius-md)"}}>
          <div className="text-[10px] uppercase tracking-wider text-tone-3">{horizon.label}</div>
          <div className="mt-2 font-mono text-lg">{fmtTL(horizon.knownAmount)}</div>
          <div className="mt-1 flex flex-wrap gap-1 text-[10px] text-tone-3"><span>{horizon.count} kayıt</span><span>· {pct(horizon.share)}</span>{horizon.unknownCount > 0 && <Badge tone="amber">{horizon.unknownCount} tutar eksik</Badge>}</div>
          <div className="mt-2 text-[10px] text-tone-3">En yoğun gün: {horizon.peakDate ?? "—"}</div>
        </Link>)}
      </div>
    </Panel>
    <div className="grid gap-3 xl:grid-cols-2">
      <Panel title="GECİKME YAŞLANDIRMASI" subtitle={`${overdueCount} açık gecikmiş kayıt · ${fmtTL(horizons[0]?.knownAmount ?? 0)}`} accent={overdueCount ? "neg" : "pos"}>
        <div className="grid gap-2 sm:grid-cols-3">
          {ageing.filter((bucket) => bucket.count > 0).map((bucket) => <Link key={bucket.id} href={`/payments/calendar?age=${encodeURIComponent(bucket.id)}`} className="row-hover border border-line-faint p-3" style={{borderRadius:"var(--radius-md)"}}>
            <div className="text-xs font-semibold">{bucket.label}</div><div className="mt-2 font-mono text-base">{fmtTL(bucket.knownAmount)}</div>
            <div className="mt-1 text-[10px] text-tone-3">{bucket.count} kayıt · {pct(bucket.share)}</div><div className="mt-1 text-[10px] text-tone-3">En eski: {bucket.oldestDueDate ?? "—"}</div>
          </Link>)}
        </div>
      </Panel>
      <Panel title="ESNEKLİK VE KRİTİKLİK" subtitle="Yalnız açık kaynak öncelikleri kullanılır; sistem tahmin üretmez">
        <div className="space-y-2">{flexibility.filter((group) => group.count > 0).map((group) => <div key={group.id} className="grid grid-cols-[1fr_auto] items-center gap-3 border-b border-line-faint py-2">
          <div><Badge tone={group.id === "critical" ? "red" : group.id === "optional" ? "green" : group.id === "flexible" ? "blue" : "neutral"}>{group.label}</Badge><span className="ml-2 text-xs text-tone-3">{group.templateCount} ödeme kalemi</span></div>
          <div className="text-right font-mono text-sm">{fmtTL(group.knownAmount)}{group.unknownCount > 0 && <div className="text-[10px] text-warn">{group.unknownCount} tutar eksik</div>}</div>
        </div>)}</div>
        {flexibility.some((group) => group.id === "unclassified" && group.count > 0) && <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border border-warn p-3 text-xs"><span>Bu kalemlerin kaynak dosyasında esneklik bilgisi yok. Yanlış karar üretmemek için sistem otomatik tahmin yapmadı.</span><Link href="/payments/items" className="button-accent px-3 py-2">Kalemleri sınıflandır</Link></div>}
      </Panel>
    </div>
    <Panel title="KRİTİK ÖDEME İZLEME LİSTESİ" subtitle="Gecikme, kritiklik, kalan tutar ve vade önceliğine göre sıralı" right={<Link href="/payments/items" className="button-ghost px-2 py-1">Tüm kalemler</Link>}>
      <div className="overflow-x-auto"><table className="w-full min-w-[820px] text-xs"><thead><tr><th>Ödeme</th><th>Kategori</th><th>Vade</th><th>Durum</th><th>Döviz</th><th className="text-right">Kalan</th><th>Esneklik</th><th>Önerilen işlem</th></tr></thead><tbody>{watchList.map((row) => <tr key={row.id} className="border-t border-line-faint">
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
    <PaymentsChartLazy />
  </>;
}

export default function PaymentsOverviewPage() {
  return <>
    <PageHeader title="Ödemeler özeti" subtitle="Bugün, yarın ve yedi günlük ödeme yükünün karar görünümü." action={<Link href="/payments/new" className="button-accent px-3 py-2">Ödeme ekle</Link>} />
    <Suspense fallback={<div className="min-h-32 animate-pulse border border-line-faint bg-surface-2" aria-label="Ödeme özeti yükleniyor" />}>
      <PaymentsDashboardContent />
    </Suspense>
  </>;
}
