import Link from "next/link";
import { getPool } from "@/lib/db";
import { paymentHistoryEvents } from "@/lib/radar/queries";
import { Badge } from "@/components/ui/badge";
import { fmtTL, Panel } from "@/components/ui/panel";
import { PageHeader } from "@/components/ui/shell";

export const dynamic = "force-dynamic";
const TABS = [["", "Tümü"], ["paid", "Ödenen"], ["partial", "Kısmi"], ["reopened", "Geri açılan"], ["cancelled", "İptal edilen"]] as const;
const LABEL: Record<string, string> = { paid: "Ödendi", partial: "Kısmi", reopened: "Geri açıldı", cancelled: "İptal edildi" };

export default async function PaymentHistoryPage({ searchParams }: { searchParams: Promise<{ status?: string; q?: string; from?: string; to?: string }> }) {
  const sp = await searchParams;
  const pool = getPool();
  const [rows, allRows] = await Promise.all([paymentHistoryEvents(pool, sp), paymentHistoryEvents(pool, { limit: 1000 })]);
  const counts = Object.fromEntries(TABS.map(([status]) => [status, status ? allRows.filter((row) => row.eventType === status).length : allRows.length]));
  const activeStatus = TABS.some(([status]) => status === (sp.status ?? "")) ? (sp.status ?? "") : "";
  const hasDetailedFilter = Boolean(sp.q || sp.from || sp.to);
  const emptyMessage = hasDetailedFilter
    ? "Seçtiğiniz ödeme adı ve tarih aralığında ödeme hareketi bulunamadı."
    : activeStatus
      ? `${TABS.find(([status]) => status === activeStatus)?.[1]} ödeme hareketi bulunmuyor.`
      : "Henüz ödeme hareketi kaydedilmemiş.";

  return <>
    <PageHeader title="Ödeme geçmişi" subtitle="Ödenen, kısmi, geri açılan ve iptal edilen işlemlerin denetim izli kaydı." action={<Link href="/payments/new" className="button-accent px-3 py-2">Ödeme ekle</Link>} meta={<Badge tone={rows.length ? "green" : "neutral"} dot={rows.length > 0}>{rows.length} olay</Badge>} />
    <nav className="flex flex-wrap gap-2" aria-label="Ödeme geçmişi durumları">{TABS.map(([value, label]) => <Link key={value} href={`/payments/history${value ? `?status=${value}` : ""}`} aria-current={activeStatus === value ? "page" : undefined} className={activeStatus === value ? "button-accent px-3 py-2" : "button-ghost px-3 py-2"}>{label}<span className="ml-2 font-mono text-[10px]">{counts[value]}</span></Link>)}</nav>
    <Panel title="Filtreler"><form className="grid gap-2 sm:grid-cols-[1fr_auto_auto_auto]"><input type="hidden" name="status" value={activeStatus} /><input name="q" defaultValue={sp.q} placeholder="Ödeme ara" className="field-control p-2" /><input name="from" type="date" defaultValue={sp.from} aria-label="Başlangıç tarihi" className="field-control p-2" /><input name="to" type="date" defaultValue={sp.to} aria-label="Bitiş tarihi" className="field-control p-2" /><div className="flex gap-1"><button className="button-accent px-3 py-2">Uygula</button><Link href={activeStatus ? `/payments/history?status=${activeStatus}` : "/payments/history"} className="button-ghost px-3 py-2">Temizle</Link></div></form></Panel>
    <Panel title="İşlem zaman çizgisi">{rows.length ? <div className="space-y-2">{rows.map((row) => <article key={row.id} className="grid gap-2 border-b border-line-faint py-3 sm:grid-cols-[1fr_auto_auto]">
      <div><div className="flex flex-wrap items-center gap-2"><strong>{row.paymentName}</strong><Badge tone={row.eventType === "paid" ? "green" : row.eventType === "cancelled" ? "red" : row.eventType === "partial" ? "amber" : "blue"}>{LABEL[row.eventType]}</Badge>{row.sourceLinked && <Badge tone="blue">Excel</Badge>}</div><p className="mt-1 text-xs text-tone-3">{row.previousStatus ?? "—"} → {row.nextStatus} · {row.occurredAt}</p></div>
      <div className="text-right text-xs"><div>İşlem: {fmtTL(row.paidAmount)}</div><div className="text-tone-3">Kalan: {fmtTL(row.remainingAmount)}</div></div>
      <Link href={`/payments/calendar?instance=${row.instanceId}`} className="button-ghost px-2 py-1">Takvimde aç</Link>
    </article>)}</div> : <div className="border border-dashed border-line p-8 text-center"><p className="text-sm text-tone-3">{emptyMessage}</p><div className="mt-3 flex flex-wrap justify-center gap-2">{(hasDetailedFilter || activeStatus) && <Link href="/payments/history" className="button-ghost px-3 py-2">Tüm hareketleri göster</Link>}<Link href="/payments/calendar" className="button-ghost px-3 py-2">Takvime dön</Link><Link href="/payments/new" className="button-accent px-3 py-2">Ödeme ekle</Link></div></div>}</Panel>
  </>;
}
