import { getPool } from "@/lib/db";
import {
  loadAllocationRules, loadCostCenterProfitability, loadDepartmentProfitability,
  loadMachineProfitability, loadPartyProfitability, loadProjectProfitability,
  loadWorkingCapital, loadWorkingCapitalTrend,
} from "@/lib/costing/engine";
import {
  BASIS_LABEL, COST_KIND_LABEL, CYCLE_VERDICT_LABEL,
  type AllocationBasis, type CostKind,
} from "@/lib/costing/rules";
import { Badge, type Tone } from "@/components/ui/badge";
import { Panel, fmtTL } from "@/components/ui/panel";
import { EmptyState, KeyStat, PageHeader, TableShell } from "@/components/ui/shell";

export const dynamic = "force-dynamic";

const VERDICT_TONE: Record<string, Tone> = {
  strong: "green", normal: "green", stretched: "amber", unknown: "neutral",
};

function marginCell(margin: number | null, rate: number | null) {
  // Unknown stays visibly unknown — a 0 here would be indistinguishable from a real break-even.
  if (margin == null) return <span className="text-amber-400">hesaplanamıyor</span>;
  return (
    <>
      <span className={margin < 0 ? "text-red-400" : ""}>{fmtTL(margin)}</span>
      {rate != null ? <span className="block text-[10px] text-neutral-600">%{(rate * 100).toFixed(1)}</span> : null}
    </>
  );
}

export default async function ProfitabilityPage() {
  const pool = getPool();
  const [centers, projects, parties, departments, machines, wc, trend, rules] = await Promise.all([
    loadCostCenterProfitability(pool),
    loadProjectProfitability(pool),
    loadPartyProfitability(pool, 30),
    loadDepartmentProfitability(pool),
    loadMachineProfitability(pool),
    loadWorkingCapital(pool),
    loadWorkingCapitalTrend(pool),
    loadAllocationRules(pool),
  ]);

  const losing = centers.filter((c) => c.margin != null && c.margin < 0);
  const unmeasured = centers.filter((c) => c.margin == null);

  return (
    <>
      <PageHeader
        title="Kârlılık ve İşletme Sermayesi"
        subtitle="Maliyet merkezi, proje, cari ve makine kârlılığı · DSO/DPO ve nakit döngüsü"
        meta={<Badge tone={losing.length > 0 ? "red" : "green"} dot>
          {losing.length > 0 ? `${losing.length} merkez zararda` : "zarar eden merkez yok"}
        </Badge>}
      />

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <KeyStat label="DSO" value={wc?.dsoDays == null ? "—" : `${wc.dsoDays} gün`}
          tone={wc?.dsoDays == null ? "neutral" : "info"} />
        <KeyStat label="DPO" value={wc?.dpoDays == null ? "—" : `${wc.dpoDays} gün`}
          tone={wc?.dpoDays == null ? "neutral" : "info"} />
        {/* Named for what it excludes — this is NOT the cash conversion cycle. */}
        <KeyStat label="Döngü (envanter hariç)"
          value={wc?.cycleExcludingInventory == null ? "—" : `${wc.cycleExcludingInventory} gün`}
          tone={wc == null ? "neutral" : VERDICT_TONE[wc.verdict] === "amber" ? "warn" : "pos"} />
        <KeyStat label="Ölçülemeyen merkez" value={unmeasured.length}
          tone={unmeasured.length > 0 ? "warn" : "pos"} />
      </div>

      <Panel title="İŞLETME SERMAYESİ" subtitle="Faz 22/23/26 read-model'lerinden türetilir — yeni kaynak veri yok">
        {wc == null ? (
          <EmptyState>İşletme sermayesi verisi yok.</EmptyState>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1 text-sm">
              <div className="flex justify-between"><span className="text-neutral-400">Açık alacak</span>
                <span className="tabular-nums">{fmtTL(wc.receivablesOpen)}</span></div>
              <div className="flex justify-between"><span className="text-neutral-400">Açık borç</span>
                <span className="tabular-nums">{fmtTL(wc.payablesOpen)}</span></div>
              <div className="flex justify-between"><span className="text-neutral-400">DSO</span>
                <span className="tabular-nums">{wc.dsoDays ?? "—"} gün</span></div>
              <div className="flex justify-between"><span className="text-neutral-400">DPO</span>
                <span className="tabular-nums">{wc.dpoDays ?? "—"} gün</span></div>
            </div>
            <div className="space-y-1 text-sm">
              {/* The honest gap, said out loud rather than shown as a blank or a zero. */}
              <div className="flex justify-between">
                <span className="text-neutral-400">DIO (envanter)</span>
                <span className="text-amber-400">ölçülemiyor</span>
              </div>
              <div className="text-[11px] text-neutral-600">
                Bu sistemde envanter kaydı yok. DIO&apos;yu sıfır saymak nakit döngüsünü malzeme
                tutulan gün kadar kısaltır — yani olduğundan <strong>iyi</strong> gösterirdi.
              </div>
              <div className="flex justify-between">
                <span className="text-neutral-400">Nakit dönüşüm döngüsü (CCC)</span>
                <span className="text-amber-400">hesaplanamıyor</span>
              </div>
              <div className="flex justify-between">
                <span className="text-neutral-400">Döngü (envanter hariç)</span>
                <span className="tabular-nums">
                  {wc.cycleExcludingInventory ?? "—"} gün{" "}
                  <Badge tone={VERDICT_TONE[wc.verdict] ?? "neutral"}>
                    {CYCLE_VERDICT_LABEL[wc.verdict]}
                  </Badge>
                </span>
              </div>
            </div>
          </div>
        )}
      </Panel>

      {trend.length > 0 ? (
        <Panel title="DSO / DPO TRENDİ" subtitle="aylık, 365 günlük kayan payda">
          <TableShell>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase text-neutral-500">
                  <th className="py-1">Ay</th><th className="text-right">Açık alacak</th>
                  <th className="text-right">Açık borç</th><th className="text-right">DSO</th>
                  <th className="text-right">DPO</th><th className="text-right">Döngü (env. hariç)</th>
                </tr>
              </thead>
              <tbody>
                {trend.map((t) => (
                  <tr key={t.periodStart} className="border-t border-neutral-800">
                    <td className="py-2 tabular-nums">{t.periodStart.slice(0, 7)}</td>
                    <td className="text-right tabular-nums">{fmtTL(t.receivablesOpen)}</td>
                    <td className="text-right tabular-nums">{fmtTL(t.payablesOpen)}</td>
                    <td className="text-right tabular-nums">{t.dsoDays ?? "—"}</td>
                    <td className="text-right tabular-nums">{t.dpoDays ?? "—"}</td>
                    <td className="text-right tabular-nums">{t.cycleExcludingInventory ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableShell>
        </Panel>
      ) : null}

      <Panel title="MALİYET MERKEZİ KÂRLILIĞI" subtitle="ciro ve maliyet yalnız faturalardan — çift sayma yok">
        {centers.length === 0 ? (
          <EmptyState>Tanımlı maliyet merkezi yok.</EmptyState>
        ) : (
          <TableShell>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase text-neutral-500">
                  <th className="py-1">Merkez</th><th className="text-right">Ciro</th>
                  <th className="text-right">Doğrudan maliyet</th><th className="text-right">Marj</th>
                  <th>Güven</th>
                </tr>
              </thead>
              <tbody>
                {centers.map((c) => (
                  <tr key={c.costCenterId} className="border-t border-neutral-800">
                    <td className="py-2">{c.name}
                      <span className="block text-xs text-neutral-600">{c.code}</span>
                    </td>
                    <td className="text-right tabular-nums">{c.revenue == null ? "—" : fmtTL(c.revenue)}</td>
                    <td className="text-right tabular-nums">{c.directCost == null ? "—" : fmtTL(c.directCost)}</td>
                    <td className="text-right tabular-nums">{marginCell(c.margin, c.marginRate)}</td>
                    <td><Badge tone={c.confidence === "estimated" ? "green" : "amber"}>{c.confidence}</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableShell>
        )}
      </Panel>

      <Panel title="CARİ KÂRLILIĞI" subtitle="rol, veri neyi gösteriyorsa o — type kolonunun iddiası değil">
        {parties.length === 0 ? (
          <EmptyState>Hareketi olan cari yok.</EmptyState>
        ) : (
          <TableShell>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase text-neutral-500">
                  <th className="py-1">Cari</th><th>Gözlemlenen rol</th>
                  <th className="text-right">Bizden alışı (ciro)</th>
                  <th className="text-right">Bize satışı (maliyet)</th>
                  <th className="text-right">Net katkı</th>
                </tr>
              </thead>
              <tbody>
                {parties.map((p) => (
                  <tr key={p.partyId} className="border-t border-neutral-800">
                    <td className="py-2">{p.name}</td>
                    <td><Badge tone={p.observedRole === "both" ? "violet" : "neutral"}>{p.observedRole}</Badge></td>
                    <td className="text-right tabular-nums">{p.revenue == null ? "—" : fmtTL(p.revenue)}</td>
                    <td className="text-right tabular-nums">{p.cost == null ? "—" : fmtTL(p.cost)}</td>
                    <td className="text-right tabular-nums">
                      {p.netContribution == null
                        ? <span className="text-amber-400">hesaplanamıyor</span>
                        : <span className={p.netContribution < 0 ? "text-red-400" : ""}>{fmtTL(p.netContribution)}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableShell>
        )}
      </Panel>

      {projects.length > 0 ? (
        <Panel title="PROJE KÂRLILIĞI">
          <TableShell>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase text-neutral-500">
                  <th className="py-1">Proje</th><th className="text-right">Ciro</th>
                  <th className="text-right">Maliyet</th><th className="text-right">Marj</th>
                </tr>
              </thead>
              <tbody>
                {projects.map((p) => (
                  <tr key={p.projectId} className="border-t border-neutral-800">
                    <td className="py-2">{p.name}<span className="block text-xs text-neutral-600">{p.code}</span></td>
                    <td className="text-right tabular-nums">{p.revenue == null ? "—" : fmtTL(p.revenue)}</td>
                    <td className="text-right tabular-nums">{p.directCost == null ? "—" : fmtTL(p.directCost)}</td>
                    <td className="text-right tabular-nums">{marginCell(p.margin, p.marginRate)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableShell>
        </Panel>
      ) : null}

      {machines.length > 0 ? (
        <Panel title="MAKİNE KÂRLILIĞI" subtitle="machine_roi_snapshots üzerinden — mevcut kârlılık emsali">
          <TableShell>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase text-neutral-500">
                  <th className="py-1">Makine</th><th className="text-right">Yıl</th>
                  <th className="text-right">Ciro</th><th className="text-right">Maliyet</th>
                  <th className="text-right">Marj</th><th className="text-right">ROI</th>
                </tr>
              </thead>
              <tbody>
                {machines.map((m, i) => (
                  <tr key={`${m.machineId}-${m.snapshotYear ?? i}`} className="border-t border-neutral-800">
                    <td className="py-2">{m.name}<span className="block text-xs text-neutral-600">{m.machineType}</span></td>
                    <td className="text-right tabular-nums">{m.snapshotYear ?? "—"}</td>
                    <td className="text-right tabular-nums">{m.revenue == null ? "—" : fmtTL(m.revenue)}</td>
                    <td className="text-right tabular-nums">{m.cost == null ? "—" : fmtTL(m.cost)}</td>
                    <td className="text-right tabular-nums">{marginCell(m.margin, m.marginRate)}</td>
                    <td className="text-right tabular-nums">
                      {m.roiRate == null ? "—" : `%${(m.roiRate * 100).toFixed(1)}`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableShell>
        </Panel>
      ) : null}

      {departments.length > 0 ? (
        <Panel title="DEPARTMAN KÂRLILIĞI" subtitle="ölçülemiyor — ve nedeni yazılı">
          <TableShell>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase text-neutral-500">
                  <th className="py-1">Departman</th><th>Durum</th><th>Neden</th>
                </tr>
              </thead>
              <tbody>
                {departments.map((d) => (
                  <tr key={d.departmentId} className="border-t border-neutral-800">
                    <td className="py-2">{d.name}<span className="block text-xs text-neutral-600">{d.code}</span></td>
                    <td><Badge tone="neutral">ölçülemiyor</Badge></td>
                    {/* The reason travels with the row so nobody reads the blank as "zero profit". */}
                    <td className="text-xs text-neutral-500">{d.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableShell>
        </Panel>
      ) : null}

      <Panel title="MASRAF DAĞITIM KURALLARI" subtitle="veri olarak yapılandırılır — yalnız yönetici değiştirir">
        <TableShell>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase text-neutral-500">
                <th className="py-1">Kural</th><th>Gider türü</th><th>Dağıtım tabanı</th>
                <th className="text-right">Sabit pay</th><th>Durum</th>
              </tr>
            </thead>
            <tbody>
              {rules.map((r) => (
                <tr key={r.id} className="border-t border-neutral-800">
                  <td className="py-2">{r.description}
                    <span className="block text-xs text-neutral-600">{r.code}</span>
                  </td>
                  <td className="text-xs">{COST_KIND_LABEL[r.costKind as CostKind] ?? r.costKind}</td>
                  <td className="text-xs">{BASIS_LABEL[r.allocationBasis as AllocationBasis] ?? r.allocationBasis}</td>
                  <td className="text-right tabular-nums">
                    {r.fixedPercent == null ? "—" : `%${(r.fixedPercent * 100).toFixed(1)}`}
                  </td>
                  <td><Badge tone={r.isActive ? "green" : "neutral"}>{r.isActive ? "aktif" : "pasif"}</Badge></td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableShell>
      </Panel>
    </>
  );
}
