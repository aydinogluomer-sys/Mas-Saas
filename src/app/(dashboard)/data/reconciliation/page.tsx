import { getPool } from "@/lib/db";
import { loadDataQualityCenter } from "@/lib/data-quality/engine";
import { Panel } from "@/components/ui/panel";
import { PageHeader } from "@/components/ui/shell";
import { ReconciliationTable, type ReconRow } from "@/components/data/reconciliation-table";

export const dynamic = "force-dynamic";

export default async function ReconciliationPage() {
  const d = await loadDataQualityCenter(getPool());
  const rows: ReconRow[] = d.cashflowReconciliation.map((r) => ({
    month: r.month_start.slice(0, 7),
    app_opening: r.app_opening,
    source_opening: r.source_opening,
    app_closing: r.app_closing,
    source_closing: r.source_closing,
  }));
  return (
    <>
      <PageHeader title="Mutabakat" subtitle="Excel sürüm farkı ve uygulama nakit değerlerinin kaynakla karşılaştırması" />
      <Panel title="Excel sürüm farkı">
        <p className="text-sm">Karşılaştırma: {d.workbookDiff.ready ? "hazır" : "en az iki çalışma kitabı gerekli"}</p>
        {d.workbookDiff.changedSheets.map((s) => (
          <div key={`${s.sheet_name}-${s.side}`} className="border-t border-line-faint py-2 text-sm">{s.sheet_name} · {s.side} · {s.impact}</div>
        ))}
      </Panel>
      <Panel title="Nakit akışı mutabakatı" subtitle="En büyük uygulama-kaynak farkı üstte">
        <ReconciliationTable rows={rows} />
      </Panel>
    </>
  );
}
