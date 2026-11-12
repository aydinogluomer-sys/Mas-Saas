import { fmtTL, Panel } from "@/components/ui/panel";
import { KpiCard, PageHeader } from "@/components/ui/shell";
import { getRequestUser } from "@/lib/auth";
import { can } from "@/lib/authz/matrix";
import { requireRouteAccess } from "@/lib/authz/route-guard";
import { getPool } from "@/lib/db";
import { loadFinanceCostAllocations, loadMachineRoi, loadMachineRoiAggregate } from "@/lib/production/engine";
import { upsertMachineRoiParameterAction } from "../actions";

export const dynamic = "force-dynamic";

export default async function RoiPage({
  searchParams,
}: { searchParams?: Promise<{ error?: string; result?: string }> }) {
  const denied = await requireRouteAccess("/production/roi");
  if (denied) return denied;
  const session = await getRequestUser();
  const canEditMachines = can(session?.role ?? "viewer", "machine_assets", "insert");
  const sp = searchParams ? await searchParams : {};

  const p = getPool();
  const [machines, total, finance] = await Promise.all([
    loadMachineRoi(p),
    loadMachineRoiAggregate(p),
    loadFinanceCostAllocations(p),
  ]);

  return (
    <>
      <PageHeader
        title="Makine ve ROI"
        subtitle="Makine yatırımı, net sonuç ve finansman maliyeti tahsisi"
        meta={<span className="text-xs text-warn">Analitik tahmin</span>}
      />

      {sp.error ? <div className="mb-3 rounded border border-neg/40 bg-neg/10 p-2 text-xs text-neg">{sp.error}</div> : null}
      {sp.result ? <div className="mb-3 rounded border border-pos/40 bg-pos/10 p-2 text-xs text-pos">{sp.result}</div> : null}

      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <KpiCard label="Yıl" value={total?.snapshot_year ?? "—"} />
        <KpiCard label="Gelir" value={fmtTL(total?.revenue)} tone="pos" />
        <KpiCard label="Maliyet" value={fmtTL(total?.cost)} tone="neg" />
        <KpiCard label="Vergi sonrası net" value={fmtTL(total?.net)} tone={(total?.net ?? 0) < 0 ? "neg" : "pos"} />
      </div>

      {canEditMachines ? (
        <Panel title="MAKİNE YATIRIMI VE ROI PARAMETRESİ GÜNCELLE">
          <details className="rounded border border-line-faint p-2">
            <summary className="cursor-pointer font-mono text-xs font-semibold">+ Makine / yıllık ROI kaydı ekle veya güncelle</summary>
            <form action={upsertMachineRoiParameterAction} className="mt-2 grid grid-cols-1 gap-2 text-xs sm:grid-cols-4">
              <input type="hidden" name="backTo" value="/production/roi" />
              <input name="name" required placeholder="Makine adı (örn. Awea)" className="rounded border border-line-faint bg-transparent px-2 py-1" />
              <input name="machineCode" placeholder="Makine kodu (örn. FR-01)" className="rounded border border-line-faint bg-transparent px-2 py-1" />
              <input name="purchaseDate" type="date" className="rounded border border-line-faint bg-transparent px-2 py-1" />
              <input name="purchaseCost" type="number" step="0.01" min="0" placeholder="Alış bedeli (TL)" className="rounded border border-line-faint bg-transparent px-2 py-1" />
              <input name="monthlyRevenue" type="number" step="0.01" min="0" placeholder="Aylık gelir (TL)" className="rounded border border-line-faint bg-transparent px-2 py-1" />
              <input name="monthlyOperatingCost" type="number" step="0.01" min="0" placeholder="Aylık op. maliyeti (TL)" className="rounded border border-line-faint bg-transparent px-2 py-1" />
              <input name="usefulLifeMonths" type="number" min="1" placeholder="Faydalı ömür (ay)" className="rounded border border-line-faint bg-transparent px-2 py-1" />
              <input name="snapshotYear" type="number" min="2000" max="2100" defaultValue={new Date().getFullYear()} placeholder="ROI yılı" className="rounded border border-line-faint bg-transparent px-2 py-1" />
              <input name="annualRevenue" type="number" step="0.01" min="0" placeholder="Yıllık gelir (TL)" className="rounded border border-line-faint bg-transparent px-2 py-1" />
              <input name="annualCost" type="number" step="0.01" min="0" placeholder="Yıllık maliyet (TL)" className="rounded border border-line-faint bg-transparent px-2 py-1" />
              <input name="notes" placeholder="Not (opsiyonel)" className="rounded border border-line-faint bg-transparent px-2 py-1" />
              <button className="rounded border border-line-faint px-2 py-1 hover:bg-white/5">
                Makineyi kaydet
              </button>
            </form>
          </details>
        </Panel>
      ) : null}

      <Panel title="Makine sonuçları">
        {machines.length === 0 ? (
          <p className="py-2 text-sm text-tone-3">Kayıtlı makine yok.</p>
        ) : (
          machines.map((m, i) => (
            <div key={`${m.name}-${i}`} className="grid grid-cols-2 gap-2 border-b border-line-faint py-2 text-sm sm:grid-cols-5">
              <b>{m.name}</b>
              <span>Alım {fmtTL(m.purchase_cost)}</span>
              <span>Gelir {fmtTL(m.revenue)}</span>
              <span>Maliyet {fmtTL(m.cost)}</span>
              <span className={(m.net ?? 0) < 0 ? "text-neg" : "text-pos"}>Net {fmtTL(m.net)}</span>
            </div>
          ))
        )}
      </Panel>

      <Panel title="Finansman tahsisi">
        {finance.length === 0 ? (
          <p className="py-2 text-sm text-tone-3">Finansman tahsis kaydı yok.</p>
        ) : (
          finance.map((r, i) => (
            <div key={`${r.loan_name}-${r.operation_type}-${i}`} className="grid grid-cols-2 gap-2 border-b border-line-faint py-2 text-sm sm:grid-cols-4">
              <b>{r.loan_name}</b>
              <span>{r.operation_type}</span>
              <span>{fmtTL(r.allocated_finance_cost)}</span>
              <span>{r.finance_cost_per_minute == null ? "—" : `${r.finance_cost_per_minute.toFixed(2)} TL/dk`}</span>
            </div>
          ))
        )}
      </Panel>
    </>
  );
}
