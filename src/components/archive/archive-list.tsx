import { restoreRecordAction } from "@/app/(dashboard)/system/archive/actions";
import type { ArchiveRecord } from "@/lib/archive/engine";
import { Badge } from "@/components/ui/badge";

const LABEL: Record<string, string> = {
  payments: "Ödeme",
  checks: "Çek / Senet",
  loans: "Kredi",
  invoices: "Fatura",
  credit_facilities: "Kredi Limiti",
  parties: "Cari",
  cash_accounts: "Kasa / Banka Hesabı",
  documents: "Belge / Doküman",
  scenario_runs: "Senaryo",
  external_assumptions: "Varsayım",
  action_items: "Görev",
};

export function ArchiveList({ rows, backTo }: { rows: ArchiveRecord[]; backTo: string }) {
  if (!rows.length) {
    return (
      <div className="rounded border border-dashed border-line p-8 text-center text-sm text-tone-3">
        Arşiv şu anda boş. Bir kaydı “Arşivle” işlemiyle buraya taşıyabilir, yetkili onay ile daha sonra geri yükleyebilirsiniz.
      </div>
    );
  }
  return (
    <div className="space-y-2">
      {rows.map((row) => (
        <article
          key={`${row.entityTable}:${row.id}`}
          className="flex flex-col gap-3 rounded border border-line bg-surface p-3 sm:flex-row sm:items-center sm:justify-between"
        >
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <strong className="text-tone-1">{row.label}</strong>
              <Badge tone="neutral">{LABEL[row.entityTable] ?? row.entityTable}</Badge>
              {row.sourceLinked ? <Badge tone="blue">Kaynak bağlantılı</Badge> : null}
            </div>
            <p className="mt-1 text-xs text-tone-3">
              {row.archivedAt}
              {row.reason ? ` · ${row.reason}` : ""}
            </p>
          </div>
          <form action={restoreRecordAction}>
            <input type="hidden" name="entity" value={row.entityTable} />
            <input type="hidden" name="id" value={row.id} />
            <input type="hidden" name="backTo" value={backTo} />
            <button className="button-accent px-3 py-1.5 text-xs">Geri yükle</button>
          </form>
        </article>
      ))}
    </div>
  );
}
