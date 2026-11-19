import { getPool } from "@/lib/db";
import {
  loadAllocationRules,
  loadCostCenterProfitability,
  loadDepartmentProfitability,
  loadMachineProfitability,
  loadPartyProfitability,
  loadProjectProfitability,
  loadWorkingCapital,
  loadWorkingCapitalTrend,
} from "@/lib/costing/engine";
import {
  BASIS_LABEL,
  COST_KIND_LABEL,
  CYCLE_VERDICT_LABEL,
  type AllocationBasis,
  type CostKind,
} from "@/lib/costing/rules";
import { Badge, type Tone } from "@/components/ui/badge";
import { Panel, fmtTL } from "@/components/ui/panel";
import { EmptyState, KeyStat, PageHeader, TableShell } from "@/components/ui/shell";
import { getRequestUser } from "@/lib/auth";
import { can } from "@/lib/authz/matrix";
import { requireRouteAccess } from "@/lib/authz/route-guard";
import { moneyOrNull } from "@/lib/money";
import { updateAllocationRuleAction } from "./actions";

export const dynamic = "force-dynamic";

const VERDICT_TONE: Record<string, Tone> = {
  strong: "green",
  normal: "green",
  stretched: "amber",
  unknown: "neutral",
};

const CONFIDENCE_LABEL_TR: Record<string, string> = {
  source: "kaynak",
  calculated: "hesaplandı",
  estimated: "hesaplandı",
  needs_review: "inceleme gerekli",
  unknown: "bilinmiyor",
};

const OBSERVED_ROLE_TR: Record<string, string> = {
  customer: "müşteri",
  supplier: "tedarikçi",
  vendor: "tedarikçi",
  both: "müşteri + tedarikçi",
  none: "hareketsiz",
};

function marginCell(margin: number | null, rate: number | null) {
  if (margin == null) return <span className="text-warn">hesaplanamıyor</span>;
  return (
    <>
      <span className={margin < 0 ? "font-medium text-neg" : "text-tone-1"}>{fmtTL(margin)}</span>
      {rate != null ? (
        <span className="block text-[10px] text-tone-3">%{(rate * 100).toFixed(1)}</span>
      ) : null}
    </>
  );
}

async function loadInventoryAndOverheadSnapshot(pool: ReturnType<typeof getPool>) {
  const [invRes, ovhRes] = await Promise.all([
    pool
      .query<{ item_count: number; inventory_value_try: string | null }>(
        `select count(*)::int as item_count,
                sum(case when on_hand_qty > 0 then on_hand_qty * standard_unit_cost else 0 end)::text as inventory_value_try
           from public.inventory_items
          where is_active = true`,
      )
      .catch(() => ({ rows: [{ item_count: 0, inventory_value_try: null }] })),
    pool
      .query<{ indirect_pool_try: string | null }>(
        `select coalesce(sum(coalesce(jl.debit_try, 0) - coalesce(jl.credit_try, 0)), 0)::text as indirect_pool_try
           from public.management_journal_lines jl
           join public.management_journal_entries je on je.id = jl.entry_id
           join public.management_accounts la on la.id = jl.account_id
          where je.status = 'posted'
            and jl.cost_center_id is null
            and (la.code like '730%' or la.code like '760%' or la.code like '770%')`,
      )
      .catch(() => ({ rows: [{ indirect_pool_try: "0" }] })),
  ]);

  return {
    inventoryItemCount: Number(invRes.rows[0]?.item_count ?? 0),
    inventoryValueTry: moneyOrNull(invRes.rows[0]?.inventory_value_try ?? null) ?? 0,
    indirectOverheadPoolTry: Math.max(0, moneyOrNull(ovhRes.rows[0]?.indirect_pool_try ?? null) ?? 0),
  };
}

export default async function ProfitabilityPage({
  searchParams,
}: {
  searchParams?: Promise<{ error?: string; result?: string }>;
}) {
  const denied = await requireRouteAccess("/finance/profitability");
  if (denied) return denied;
  const session = await getRequestUser();
  const canUpdateRules = can(session?.role ?? "viewer", "cost_allocation_rules", "update");
  const sp = searchParams ? await searchParams : {};
  const pool = getPool();
  const [centers, projects, parties, departments, machines, wc, trend, rules, extra] =
    await Promise.all([
      loadCostCenterProfitability(pool),
      loadProjectProfitability(pool),
      loadPartyProfitability(pool, 30),
      loadDepartmentProfitability(pool),
      loadMachineProfitability(pool),
      loadWorkingCapital(pool),
      loadWorkingCapitalTrend(pool),
      loadAllocationRules(pool),
      loadInventoryAndOverheadSnapshot(pool),
    ]);

  const losing = centers.filter((c) => c.margin != null && c.margin < 0);
  const unmeasured = centers.filter((c) => c.margin == null);

  // Active allocation rule basis for distributing shared 730/760/770 overhead pool across centers
  const primaryRule = rules.find((r) => r.isActive) ?? null;
  const totalRevenue = centers.reduce((s, c) => s + Math.max(0, c.revenue ?? 0), 0);
  const totalDirectCost = centers.reduce((s, c) => s + Math.max(0, c.directCost ?? 0), 0);
  const centerCount = Math.max(1, centers.length);

  const centersWithOverhead = centers.map((c) => {
    let share = 0;
    if (extra.indirectOverheadPoolTry > 0 && primaryRule) {
      if (primaryRule.allocationBasis === "revenue_share" && totalRevenue > 0) {
        share = (Math.max(0, c.revenue ?? 0) / totalRevenue) * extra.indirectOverheadPoolTry;
      } else if (primaryRule.allocationBasis === "direct_cost" && totalDirectCost > 0) {
        share = (Math.max(0, c.directCost ?? 0) / totalDirectCost) * extra.indirectOverheadPoolTry;
      } else if (primaryRule.allocationBasis === "fixed_percent" && primaryRule.fixedPercent != null) {
        share = primaryRule.fixedPercent * extra.indirectOverheadPoolTry;
      } else {
        share = extra.indirectOverheadPoolTry / centerCount;
      }
    }
    const allocatedOverhead = Math.round(share * 100) / 100;
    const fullMargin = c.margin == null ? null : Math.round((c.margin - allocatedOverhead) * 100) / 100;
    const fullMarginRate =
      fullMargin != null && c.revenue != null && c.revenue > 0 ? fullMargin / c.revenue : null;
    return { ...c, allocatedOverhead, fullMargin, fullMarginRate };
  });

  return (
    <>
      <PageHeader
        title="Kârlılık ve İşletme Sermayesi"
        subtitle="Maliyet merkezi (ABC 730/760/770 dağıtımlı), proje, cari ve makine kârlılığı · Canlı DSO / DIO / DPO ve CCC"
        meta={
          <Badge tone={losing.length > 0 ? "red" : "green"} dot>
            {losing.length > 0 ? `${losing.length} merkez zararda` : "zarar eden merkez yok"}
          </Badge>
        }
      />

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        <KeyStat
          label="DSO (Tahsilat)"
          value={wc?.dsoDays == null ? "—" : `${wc.dsoDays} gün`}
          tone={wc?.dsoDays == null ? "neutral" : "info"}
        />
        <KeyStat
          label="DIO (Stok Devir)"
          value={wc?.dioDays == null ? "Stok bekliyor" : `${wc.dioDays} gün`}
          sub={extra.inventoryItemCount > 0 ? `${extra.inventoryItemCount} stok kalemi (${fmtTL(extra.inventoryValueTry)})` : "TDHP 150/151/152"}
          tone={wc?.dioDays == null ? "neutral" : "info"}
        />
        <KeyStat
          label="DPO (Borç Ödeme)"
          value={wc?.dpoDays == null ? "—" : `${wc.dpoDays} gün`}
          tone={wc?.dpoDays == null ? "neutral" : "info"}
        />
        <KeyStat
          label="Tam Nakit Döngüsü (CCC)"
          value={
            wc?.cashConversionCycleDays != null
              ? `${wc.cashConversionCycleDays} gün`
              : wc?.cycleExcludingInventory != null
                ? `${wc.cycleExcludingInventory} gün (env. hariç)`
                : "—"
          }
          tone={wc == null ? "neutral" : VERDICT_TONE[wc.verdict] === "amber" ? "warn" : "pos"}
        />
        <KeyStat
          label="Ölçülemeyen Merkez"
          value={unmeasured.length}
          tone={unmeasured.length > 0 ? "warn" : "pos"}
        />
      </div>

      <Panel
        title="İŞLETME SERMAYESİ & NAKİT DÖNÜŞÜM DÖNGÜSÜ (CCC = DSO + DIO - DPO)"
        subtitle="Alacak, borç ve TDHP 150/151/152 envanter bakiyelerinden canlı hesaplanır"
      >
        {wc == null ? (
          <EmptyState>İşletme sermayesi verisi yok.</EmptyState>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-1.5 rounded border border-line-faint bg-elev/40 p-3 text-sm">
              <div className="flex justify-between">
                <span className="text-tone-2">Açık Alacak (120)</span>
                <span className="font-mono tabular-nums text-tone-1">{fmtTL(wc.receivablesOpen)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-tone-2">Açık Ticari Borç (320)</span>
                <span className="font-mono tabular-nums text-tone-1">{fmtTL(wc.payablesOpen)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-tone-2">Aktif Stok Değeri (150/151/152)</span>
                <span className="font-mono tabular-nums text-tone-1">
                  {extra.inventoryItemCount > 0 ? fmtTL(extra.inventoryValueTry) : "Kayıtlı stok yok"}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-tone-2">DSO / DPO</span>
                <span className="font-mono tabular-nums text-tone-1">
                  {wc.dsoDays ?? "—"} gün / {wc.dpoDays ?? "—"} gün
                </span>
              </div>
            </div>
            <div className="space-y-1.5 rounded border border-line-faint bg-elev/40 p-3 text-sm">
              <div className="flex justify-between">
                <span className="text-tone-2">DIO (Stok Tutma Süresi)</span>
                {wc.dioDays != null ? (
                  <span className="font-mono font-medium tabular-nums text-tone-1">{wc.dioDays} gün</span>
                ) : (
                  <span className="text-xs font-medium text-warn">
                    {wc.dioUnmeasurableReason === "no_inventory_data"
                      ? "Stok kartı girildiğinde otomatik açılır"
                      : "Alım paydası bekleniyor"}
                  </span>
                )}
              </div>
              <div className="flex justify-between">
                <span className="text-tone-2">Tam Nakit Dönüşüm Döngüsü (CCC)</span>
                {wc.cashConversionCycleDays != null ? (
                  <span className="font-mono font-semibold tabular-nums text-tone-1">
                    {wc.cashConversionCycleDays} gün
                  </span>
                ) : (
                  <span className="text-xs font-medium text-warn">DIO verisi bekleniyor</span>
                )}
              </div>
              <div className="flex justify-between">
                <span className="text-tone-2">Ticari Döngü (DSO - DPO)</span>
                <span className="font-mono tabular-nums text-tone-1">
                  {wc.cycleExcludingInventory ?? "—"} gün{" "}
                  <Badge tone={VERDICT_TONE[wc.verdict] ?? "neutral"}>
                    {CYCLE_VERDICT_LABEL[wc.verdict]}
                  </Badge>
                </span>
              </div>
              <p className="pt-1 text-[11px] text-tone-3">
                Üretim &gt; Stok &amp; Reçete ekranından girilen 150/151/152 stok bakiyeleri DIO ve CCC hesabına anında yansır; stok yoksa sıfır varsayılmaz.
              </p>
            </div>
          </div>
        )}
      </Panel>

      {trend.length > 0 ? (
        <Panel title="DSO / DIO / DPO AYLIK TRENDİ" subtitle="365 günlük kayan ciro ve satınalma paydası">
          <TableShell>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase text-tone-3">
                  <th className="py-1.5">Ay</th>
                  <th className="text-right">Açık Alacak</th>
                  <th className="text-right">Açık Borç</th>
                  <th className="text-right">DSO</th>
                  <th className="text-right">DIO</th>
                  <th className="text-right">DPO</th>
                  <th className="text-right">Döngü (DSO-DPO)</th>
                </tr>
              </thead>
              <tbody>
                {trend.map((t) => (
                  <tr key={t.periodStart} className="border-t border-line-faint hover:bg-elev/50">
                    <td className="py-2 font-mono tabular-nums text-tone-1">{t.periodStart.slice(0, 7)}</td>
                    <td className="text-right font-mono tabular-nums">{fmtTL(t.receivablesOpen)}</td>
                    <td className="text-right font-mono tabular-nums">{fmtTL(t.payablesOpen)}</td>
                    <td className="text-right font-mono tabular-nums">{t.dsoDays ?? "—"}</td>
                    <td className="text-right font-mono tabular-nums">{t.dioDays ?? "—"}</td>
                    <td className="text-right font-mono tabular-nums">{t.dpoDays ?? "—"}</td>
                    <td className="text-right font-mono tabular-nums">{t.cycleExcludingInventory ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableShell>
        </Panel>
      ) : null}

      <Panel
        title="MALİYET MERKEZİ KÂRLILIĞI (ABC TAM MALİYET KÖPRÜSÜ)"
        subtitle={
          primaryRule
            ? `Doğrudan fatura marjı + aktif kural (${primaryRule.code} · ${BASIS_LABEL[primaryRule.allocationBasis as AllocationBasis] ?? primaryRule.allocationBasis}) ile dağıtılan ortak 730/760/770 havuzu (${fmtTL(extra.indirectOverheadPoolTry)})`
            : "Faturalanan satış hacmi ve doğrudan maliyet (çift sayma yok)"
        }
      >
        {centersWithOverhead.length === 0 ? (
          <EmptyState>Tanımlı maliyet merkezi yok.</EmptyState>
        ) : (
          <TableShell>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase text-tone-3">
                  <th className="py-1.5">Merkez</th>
                  <th className="text-right">Faturalanan Satış</th>
                  <th className="text-right">Doğrudan Maliyet</th>
                  <th className="text-right">Brüt Marj</th>
                  <th className="text-right">Dağıtılan Genel Gider</th>
                  <th className="text-right">Tam Maliyet Net Marj</th>
                  <th>Güven</th>
                </tr>
              </thead>
              <tbody>
                {centersWithOverhead.map((c) => (
                  <tr key={c.costCenterId} className="border-t border-line-faint hover:bg-elev/50">
                    <td className="py-2 text-tone-1">
                      {c.name}
                      <span className="block font-mono text-xs text-tone-3">{c.code}</span>
                    </td>
                    <td className="text-right font-mono tabular-nums">
                      {c.revenue == null ? "—" : fmtTL(c.revenue)}
                    </td>
                    <td className="text-right font-mono tabular-nums">
                      {c.directCost == null ? "—" : fmtTL(c.directCost)}
                    </td>
                    <td className="text-right font-mono tabular-nums">
                      {marginCell(c.margin, c.marginRate)}
                    </td>
                    <td className="text-right font-mono tabular-nums text-tone-2">
                      {fmtTL(c.allocatedOverhead)}
                    </td>
                    <td className="text-right font-mono tabular-nums">
                      {marginCell(c.fullMargin, c.fullMarginRate)}
                    </td>
                    <td>
                      <Badge tone={c.confidence === "estimated" ? "green" : "amber"}>
                        {CONFIDENCE_LABEL_TR[c.confidence] ?? c.confidence}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableShell>
        )}
      </Panel>

      <Panel
        title="CARİ KÂRLILIĞI"
        subtitle="Rol, gerçekleşen fatura yönünden türetilir — etiket kolonunun iddiası değil"
      >
        {parties.length === 0 ? (
          <EmptyState>Hareketi olan cari yok.</EmptyState>
        ) : (
          <TableShell>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase text-tone-3">
                  <th className="py-1.5">Cari</th>
                  <th>Gözlemlenen Rol</th>
                  <th className="text-right">Faturalanan Satış Hacmi</th>
                  <th className="text-right">Faturalanan Alış Maliyeti</th>
                  <th className="text-right">Net Katkı</th>
                </tr>
              </thead>
              <tbody>
                {parties.map((p) => (
                  <tr key={p.partyId} className="border-t border-line-faint hover:bg-elev/50">
                    <td className="py-2 text-tone-1">{p.name}</td>
                    <td>
                      <Badge tone={p.observedRole === "both" ? "violet" : "neutral"}>
                        {OBSERVED_ROLE_TR[p.observedRole] ?? p.observedRole}
                      </Badge>
                    </td>
                    <td className="text-right font-mono tabular-nums">
                      {p.revenue == null ? "—" : fmtTL(p.revenue)}
                    </td>
                    <td className="text-right font-mono tabular-nums">
                      {p.cost == null ? "—" : fmtTL(p.cost)}
                    </td>
                    <td className="text-right font-mono tabular-nums">
                      {p.netContribution == null ? (
                        <span className="text-warn">hesaplanamıyor</span>
                      ) : (
                        <span className={p.netContribution < 0 ? "font-medium text-neg" : "text-tone-1"}>
                          {fmtTL(p.netContribution)}
                        </span>
                      )}
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
                <tr className="text-left text-xs uppercase text-tone-3">
                  <th className="py-1.5">Proje</th>
                  <th className="text-right">Faturalanan Satış Hacmi</th>
                  <th className="text-right">Maliyet</th>
                  <th className="text-right">Marj</th>
                </tr>
              </thead>
              <tbody>
                {projects.map((p) => (
                  <tr key={p.projectId} className="border-t border-line-faint hover:bg-elev/50">
                    <td className="py-2 text-tone-1">
                      {p.name}
                      <span className="block font-mono text-xs text-tone-3">{p.code}</span>
                    </td>
                    <td className="text-right font-mono tabular-nums">
                      {p.revenue == null ? "—" : fmtTL(p.revenue)}
                    </td>
                    <td className="text-right font-mono tabular-nums">
                      {p.directCost == null ? "—" : fmtTL(p.directCost)}
                    </td>
                    <td className="text-right font-mono tabular-nums">
                      {marginCell(p.margin, p.marginRate)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableShell>
        </Panel>
      ) : null}

      {machines.length > 0 ? (
        <Panel title="MAKİNE KÂRLILIĞI" subtitle="machine_roi_snapshots üzerinden yatırım ve marj takibi">
          <TableShell>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase text-tone-3">
                  <th className="py-1.5">Makine</th>
                  <th className="text-right">Yıl</th>
                  <th className="text-right">Faturalanan Satış Hacmi</th>
                  <th className="text-right">Maliyet</th>
                  <th className="text-right">Marj</th>
                  <th className="text-right">ROI</th>
                </tr>
              </thead>
              <tbody>
                {machines.map((m, i) => (
                  <tr
                    key={`${m.machineId}-${m.snapshotYear ?? i}`}
                    className="border-t border-line-faint hover:bg-elev/50"
                  >
                    <td className="py-2 text-tone-1">
                      {m.name}
                      <span className="block text-xs text-tone-3">{m.machineType}</span>
                    </td>
                    <td className="text-right font-mono tabular-nums">{m.snapshotYear ?? "—"}</td>
                    <td className="text-right font-mono tabular-nums">
                      {m.revenue == null ? "—" : fmtTL(m.revenue)}
                    </td>
                    <td className="text-right font-mono tabular-nums">
                      {m.cost == null ? "—" : fmtTL(m.cost)}
                    </td>
                    <td className="text-right font-mono tabular-nums">
                      {marginCell(m.margin, m.marginRate)}
                    </td>
                    <td className="text-right font-mono tabular-nums">
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
        <Panel
          title="DEPARTMAN KÂRLILIĞI"
          subtitle="Departman etiketli TRY faturalar veya açık ölçülemezlik gerekçesi"
        >
          <TableShell>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase text-tone-3">
                  <th className="py-1.5">Departman</th>
                  <th className="text-right">Faturalanan Satış</th>
                  <th className="text-right">Doğrudan Maliyet</th>
                  <th className="text-right">Marj</th>
                  <th>Durum / Neden</th>
                </tr>
              </thead>
              <tbody>
                {departments.map((d) => (
                  <tr key={d.departmentId} className="border-t border-line-faint hover:bg-elev/50">
                    <td className="py-2 text-tone-1">
                      {d.name}
                      <span className="block font-mono text-xs text-tone-3">{d.code}</span>
                    </td>
                    <td className="text-right font-mono tabular-nums">
                      {d.revenue == null ? "—" : fmtTL(d.revenue)}
                    </td>
                    <td className="text-right font-mono tabular-nums">
                      {d.directCost == null ? "—" : fmtTL(d.directCost)}
                    </td>
                    <td className="text-right font-mono tabular-nums">
                      {d.unmeasurableReason == null ? marginCell(d.margin, null) : "—"}
                    </td>
                    <td className="text-xs text-tone-2">
                      <Badge tone={d.unmeasurableReason == null ? "green" : "neutral"}>
                        {d.unmeasurableReason == null ? "ölçüldü" : "ölçülemiyor"}
                      </Badge>{" "}
                      <span>{d.note}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableShell>
        </Panel>
      ) : null}

      <Panel
        title="MASRAF DAĞITIM KURALLARI"
        subtitle="Veri olarak yapılandırılır — yalnız yetkili yönetici değiştirir, denetim izine yazılır"
      >
        {sp.error ? (
          <div className="mb-2 rounded border border-neg/40 bg-neg/10 p-2 text-xs text-neg">{sp.error}</div>
        ) : null}
        {sp.result ? (
          <div className="mb-2 rounded border border-pos/40 bg-pos/10 p-2 text-xs text-pos">{sp.result}</div>
        ) : null}
        {canUpdateRules && rules.length > 0 ? (
          <details className="mb-3 rounded border border-line-faint bg-elev/30 p-2.5">
            <summary className="cursor-pointer font-mono text-xs font-semibold text-tone-1">
              Dağıtım kuralı güncelle
            </summary>
            <form action={updateAllocationRuleAction} className="mt-2 grid grid-cols-1 gap-2 text-xs sm:grid-cols-5">
              <select name="code" required className="rounded border border-line bg-surface px-2 py-1.5 text-tone-1">
                {rules.map((r) => (
                  <option key={r.code} value={r.code}>
                    {r.code} · {r.description}
                  </option>
                ))}
              </select>
              <select
                name="allocationBasis"
                required
                className="rounded border border-line bg-surface px-2 py-1.5 text-tone-1"
              >
                {(Object.keys(BASIS_LABEL) as AllocationBasis[]).map((b) => (
                  <option key={b} value={b}>
                    {BASIS_LABEL[b]}
                  </option>
                ))}
              </select>
              <input
                name="fixedPercentPct"
                type="number"
                step="0.1"
                min="0"
                max="100"
                placeholder="Sabit pay % (0-100)"
                className="rounded border border-line bg-surface px-2 py-1.5 text-tone-1"
              />
              <select
                name="isActive"
                defaultValue="true"
                className="rounded border border-line bg-surface px-2 py-1.5 text-tone-1"
              >
                <option value="true">aktif</option>
                <option value="false">pasif</option>
              </select>
              <button className="button-accent px-3 py-1.5 text-xs">Kuralı kaydet</button>
            </form>
          </details>
        ) : null}
        <TableShell>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase text-tone-3">
                <th className="py-1.5">Kural</th>
                <th>Gider Türü</th>
                <th>Dağıtım Tabanı</th>
                <th className="text-right">Sabit Pay</th>
                <th>Durum</th>
              </tr>
            </thead>
            <tbody>
              {rules.map((r) => (
                <tr key={r.id} className="border-t border-line-faint hover:bg-elev/50">
                  <td className="py-2 text-tone-1">
                    {r.description}
                    <span className="block font-mono text-xs text-tone-3">{r.code}</span>
                  </td>
                  <td className="text-xs text-tone-2">{COST_KIND_LABEL[r.costKind as CostKind] ?? r.costKind}</td>
                  <td className="text-xs text-tone-2">
                    {BASIS_LABEL[r.allocationBasis as AllocationBasis] ?? r.allocationBasis}
                  </td>
                  <td className="text-right font-mono tabular-nums">
                    {r.fixedPercent == null ? "—" : `%${(r.fixedPercent * 100).toFixed(1)}`}
                  </td>
                  <td>
                    <Badge tone={r.isActive ? "green" : "neutral"}>{r.isActive ? "aktif" : "pasif"}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableShell>
      </Panel>
    </>
  );
}
