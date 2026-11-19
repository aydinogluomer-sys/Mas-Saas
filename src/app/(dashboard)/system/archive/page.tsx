import { ArchiveList } from "@/components/archive/archive-list";
import { Panel } from "@/components/ui/panel";
import { PageHeader } from "@/components/ui/shell";
import { listArchive, type ArchiveEntity } from "@/lib/archive/engine";
import { requireRouteAccess } from "@/lib/authz/route-guard";
import { getPool } from "@/lib/db";

export const dynamic = "force-dynamic";

export default async function SystemArchive({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; type?: ArchiveEntity }>;
}) {
  const denied = await requireRouteAccess("/system/archive");
  if (denied) return denied;

  const sp = await searchParams;
  const rows = await listArchive(getPool(), sp.type, sp.q ?? "");

  return (
    <div className="space-y-4">
      <PageHeader
        title="Arşiv Merkezi"
        subtitle="Ödemeler, faturalar, çekler, krediler, kredi limitleri, cariler, banka/kasa hesapları, dokümanlar ve senaryolarda arşivlenen kayıtları arayın ve yetki kapısıyla geri yükleyin."
      />
      <Panel title={`${rows.length} arşiv kaydı`}>
        <form className="mb-4 flex flex-wrap gap-2">
          <input
            name="q"
            defaultValue={sp.q}
            placeholder="Kayıt ara (etiket, arşiv gerekçesi…)"
            className="field-control min-w-52 flex-1 p-2 text-xs"
          />
          <select
            name="type"
            defaultValue={sp.type ?? ""}
            className="field-control p-2 text-xs"
          >
            <option value="">Tüm varlık türleri (11 tablo)</option>
            <option value="payments">Ödemeler</option>
            <option value="invoices">Faturalar</option>
            <option value="checks">Çek / Senet</option>
            <option value="loans">Krediler</option>
            <option value="credit_facilities">Kredi Limitleri</option>
            <option value="parties">Cariler (Müşteri / Tedarikçi)</option>
            <option value="cash_accounts">Banka &amp; Kasa Hesapları</option>
            <option value="documents">Dokümanlar</option>
            <option value="scenario_runs">Senaryolar</option>
            <option value="external_assumptions">Dış Varsayımlar</option>
            <option value="action_items">Görevler</option>
          </select>
          <button className="button-accent px-3 py-2 text-xs font-medium">Filtrele</button>
        </form>
        <ArchiveList rows={rows} backTo="/system/archive" />
      </Panel>
    </div>
  );
}
