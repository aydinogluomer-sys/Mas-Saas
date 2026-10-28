import { getPool } from "@/lib/db";
import { getErpIntegrationSummary } from "@/lib/erp/engine";
import { ErpBridgeHub } from "@/components/erp/erp-bridge-hub";
import { KpiCard, PageHeader } from "@/components/ui/shell";

export const dynamic = "force-dynamic";

export default async function ErpIntegrationPage() {
  const pool = getPool();
  const summary = await getErpIntegrationSummary(pool);
  const connectedCount = summary.vendors.filter((v) => v.status === "connected").length;

  return (
    <>
      <PageHeader
        title="ERP & Muhasebe Entegrasyon Köprüsü"
        subtitle="Logo, Mikro, Zirve, Paraşüt ve Luca yazılımlarından otomatik cari ve fatura aktarımı."
      />

      <div className="mb-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard
          label="Sistemdeki ERP Faturaları"
          value={`${summary.totalInvoices} Adet`}
          note="Otomatik senkronize"
          tone="info"
        />
        <KpiCard
          label="Desteklenen / Aktif ERP"
          value={`${connectedCount} / ${summary.vendors.length}`}
          note="Logo, Mikro, Zirve, Paraşüt, Luca"
          tone={connectedCount > 0 ? "pos" : "neutral"}
        />
        <KpiCard
          label="Veri Akış Türü"
          value="Gerçek Zamanlı"
          note="Webhook & Yerel Ajan"
          tone="pos"
        />
        <KpiCard
          label="Doğrulama ve Güvenlik"
          value="Dedupe & RLS"
          note="Çift aktarım koruması aktif"
          tone="pos"
        />
      </div>

      <ErpBridgeHub
        initialVendors={summary.vendors}
        recentLogs={summary.recentLogs}
      />
    </>
  );
}
