import { PageHeader } from "@/components/ui/shell";

export default function PaymentsLoading() {
  return <>
    <PageHeader title="Ödemeler özeti" subtitle="Ödeme görünümü yükleniyor…" />
    <div className="grid grid-cols-2 gap-2 lg:grid-cols-4" aria-label="Ödeme özeti yükleniyor">
      {Array.from({ length: 4 }, (_, index) => <div key={index} className="h-24 animate-pulse border border-line-faint bg-surface-2" />)}
    </div>
    <div className="mt-3 h-72 animate-pulse border border-line-faint bg-surface-2" />
  </>;
}
