import { getPool } from "@/lib/db";
import {
  loadCashPositions, loadLiquidityGap, loadPolicies, loadPositionSummary, loadReconciliation,
} from "@/lib/treasury/engine";
import { RECONCILIATION_LABEL, type ReconciliationStatus } from "@/lib/treasury/rules";
import { istanbulDateISO } from "@/lib/reports/rules";
import { Badge, type Tone } from "@/components/ui/badge";
import { Panel, fmtTL } from "@/components/ui/panel";
import { EmptyState, KeyStat, PageHeader, TableShell } from "@/components/ui/shell";
import { updatePolicyAction } from "./actions";
import { requireRouteAccess } from "@/lib/authz/route-guard";

export const dynamic = "force-dynamic";

const RECON_TONE: Record<ReconciliationStatus, Tone> = {
  aligned: "green",
  divergent: "red",
  cashflow_missing: "neutral",
  no_bank_movement: "neutral",
};

export default async function TreasuryPage({
  searchParams,
}: { searchParams: Promise<{ error?: string; result?: string }> }) {
  // Faz 17-38 denetimi — sayfa seviyesi rol kapisi. Navigasyonun kullandigi AYNI karar
  // (canSeeRoute); ikinci bir liste, ikinci bir fikir ve kacinilmaz bir kayma demekti.
  const denied = await requireRouteAccess("/finance/treasury");
  if (denied) return denied;
  const sp = await searchParams;
  const pool = getPool();
  const [positions, summary, gaps, recon, policies] = await Promise.all([
    loadCashPositions(pool),
    loadPositionSummary(pool),
    loadLiquidityGap(pool),
    loadReconciliation(pool),
    loadPolicies(pool),
  ]);

  const today = istanbulDateISO();
  const divergent = recon.filter((r) => r.status === "divergent");
  const breaches = gaps.filter((g) => g.breachesFloor);
  const gapAccounts = positions.filter(
    (p) => p.statedMinusDerived != null && Math.abs(p.statedMinusDerived) > 0.01);

  return (
    <>
      <PageHeader
        title="Hazine / Likidite"
        subtitle={`Nakit pozisyonu, 7/30/90 gün likidite ve nakit tabanı — ${today}`}
        meta={<Badge tone={breaches.length > 0 ? "red" : "green"} dot>
          {breaches.length > 0 ? `${breaches.length} ufukta taban altı` : "taban korunuyor"}
        </Badge>}
      />

      {sp.error ? (
        <div className="rounded border border-amber-700/50 bg-amber-950/30 px-3 py-2 text-sm text-amber-200">{sp.error}</div>
      ) : null}

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        {summary.map((s) => (
          <KeyStat key={`avail-${s.currency}`} label={`Kullanılabilir (${s.currency})`}
            value={fmtTL(s.availableNow)} tone={(s.availableNow ?? 0) > 0 ? "pos" : "neg"} />
        ))}
        <KeyStat label="Taban altı ufuk" value={breaches.length} tone={breaches.length > 0 ? "neg" : "pos"} />
        <KeyStat label="Mutabakat sapması" value={divergent.length} tone={divergent.length > 0 ? "warn" : "pos"} />
        <KeyStat label="Bakiye farkı olan hesap" value={gapAccounts.length}
          tone={gapAccounts.length > 0 ? "warn" : "pos"} />
      </div>

      <Panel title="LİKİDİTE UFUKLARI" subtitle="7 / 30 / 90 gün — sözleşmeli akış üzerinden yargılanır">
        {gaps.length === 0 ? (
          <EmptyState>Likidite verisi yok.</EmptyState>
        ) : (
          <TableShell>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase text-neutral-500">
                  <th className="py-1">Ufuk</th><th>Kur</th>
                  <th className="text-right">Bugün</th>
                  <th className="text-right">Sözleşmeli akış</th>
                  <th className="text-right">Projeksiyon (sözleşmeli)</th>
                  <th className="text-right">Projeksiyon (beklenen)</th>
                  <th className="text-right">Taban</th>
                  <th className="text-right">Finansman ihtiyacı</th>
                </tr>
              </thead>
              <tbody>
                {gaps.map((g) => (
                  <tr key={`${g.currency}-${g.horizonDays}`} className="border-t border-neutral-800">
                    <td className="py-2">{g.horizonDays} gün</td>
                    <td className="text-xs">{g.currency}</td>
                    <td className="text-right tabular-nums">{fmtTL(g.availableNow)}</td>
                    <td className="text-right tabular-nums">{fmtTL(g.contractedNetFlow)}</td>
                    <td className={`text-right tabular-nums ${g.breachesFloor ? "text-red-400" : ""}`}>
                      {fmtTL(g.projectedContracted)}
                    </td>
                    {/* Shown beside it, never instead of it: the optimistic figure believes
                        customer promises and must not be what clears an alarm. */}
                    <td className="text-right tabular-nums text-neutral-500">{fmtTL(g.projectedExpected)}</td>
                    <td className="text-right tabular-nums text-neutral-500">{fmtTL(g.minCashFloor)}</td>
                    <td className="text-right tabular-nums">
                      {(g.financingNeed ?? 0) > 0
                        ? <span className="text-red-400">{fmtTL(g.financingNeed)}</span>
                        : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableShell>
        )}
      </Panel>

      <Panel title="BANKA / HESAP POZİSYONU" subtitle="banka beyanı ile hareketlerden türetilen bakiye yan yana">
        {positions.length === 0 ? (
          <EmptyState>Aktif hesap yok.</EmptyState>
        ) : (
          <TableShell>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase text-neutral-500">
                  <th className="py-1">Hesap</th><th>Banka</th><th>Kur</th>
                  <th className="text-right">Banka beyanı</th>
                  <th className="text-right">Hareketlerden</th>
                  <th className="text-right">Fark</th>
                  <th className="text-right">Bloke</th>
                </tr>
              </thead>
              <tbody>
                {positions.map((p) => (
                  <tr key={p.cashAccountId} className="border-t border-neutral-800">
                    <td className="py-2">{p.accountName}
                      <span className="block text-xs text-neutral-600">{p.movementCount} hareket</span>
                    </td>
                    <td className="text-xs">{p.bankName ?? "—"}</td>
                    <td className="text-xs">{p.currency}</td>
                    <td className="text-right tabular-nums">{p.statedBalance == null ? "—" : fmtTL(p.statedBalance)}</td>
                    <td className="text-right tabular-nums">{fmtTL(p.derivedBalance)}</td>
                    {/* The gap is information, not an error to be hidden: neither source is
                        silently preferred. */}
                    <td className="text-right tabular-nums">
                      {p.statedMinusDerived == null
                        ? <span className="text-neutral-600">beyan yok</span>
                        : Math.abs(p.statedMinusDerived) > 0.01
                          ? <span className="text-amber-400">{fmtTL(p.statedMinusDerived)}</span>
                          : "—"}
                    </td>
                    <td className="text-right tabular-nums text-neutral-500">
                      {p.blockedBalance == null ? "—" : fmtTL(p.blockedBalance)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableShell>
        )}
      </Panel>

      <Panel
        title="NAKİT AKIŞI MUTABAKATI"
        subtitle="hazine pozisyonu ile cashflow_months kapanış bakiyesi — fark varsa gizlenmez"
      >
        {recon.length === 0 ? (
          <EmptyState>Karşılaştırılacak nakit akış ayı yok.</EmptyState>
        ) : (
          <TableShell>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase text-neutral-500">
                  <th className="py-1">Ay</th>
                  <th className="text-right">Nakit akışı (kapanış)</th>
                  <th className="text-right">Hazine (türetilen)</th>
                  <th className="text-right">Fark</th>
                  <th>Durum</th>
                </tr>
              </thead>
              <tbody>
                {recon.map((r) => (
                  <tr key={r.monthStart} className="border-t border-neutral-800">
                    <td className="py-2 tabular-nums">{r.monthStart.slice(0, 7)}</td>
                    <td className="text-right tabular-nums">{r.cashflowClosing == null ? "—" : fmtTL(r.cashflowClosing)}</td>
                    <td className="text-right tabular-nums">{r.treasuryClosing == null ? "—" : fmtTL(r.treasuryClosing)}</td>
                    <td className="text-right tabular-nums">{r.difference == null ? "—" : fmtTL(r.difference)}</td>
                    <td><Badge tone={RECON_TONE[r.status]}>{RECONCILIATION_LABEL[r.status]}</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableShell>
        )}
      </Panel>

      <Panel title="HAZİNE POLİTİKALARI" subtitle="nakit tabanı yapılandırması — yalnız yönetici değiştirir">
        <TableShell>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase text-neutral-500">
                <th className="py-1">Politika</th><th>Tür</th><th>Kur</th>
                <th className="text-right">Eşik</th><th>Durum</th><th>Değiştir</th>
              </tr>
            </thead>
            <tbody>
              {policies.map((p) => (
                <tr key={p.id} className="border-t border-neutral-800">
                  <td className="py-2">{p.description}
                    <span className="block text-xs text-neutral-600">{p.code}</span>
                  </td>
                  <td className="text-xs">{p.policyKind === "min_cash" ? "asgari kasa" : "tampon gün"}</td>
                  <td className="text-xs">{p.currency}</td>
                  <td className="text-right tabular-nums">
                    {p.policyKind === "min_cash" ? fmtTL(p.thresholdAmount) : `${p.thresholdDays ?? "—"} gün`}
                  </td>
                  <td><Badge tone={p.isActive ? "green" : "neutral"}>{p.isActive ? "aktif" : "pasif"}</Badge></td>
                  <td className="py-2">
                    <form action={updatePolicyAction} className="flex flex-wrap items-center gap-1">
                      <input type="hidden" name="code" value={p.code} />
                      {p.policyKind === "min_cash" ? (
                        <input name="thresholdAmount" type="number" step="0.01" min="0"
                          defaultValue={p.thresholdAmount ?? 0}
                          className="field-control w-24 px-1 py-0.5 text-[11px]" />
                      ) : (
                        <input name="thresholdDays" type="number" min="1"
                          defaultValue={p.thresholdDays ?? 30}
                          className="field-control w-16 px-1 py-0.5 text-[11px]" />
                      )}
                      <label className="flex items-center gap-1 text-[11px] text-neutral-400">
                        <input type="checkbox" name="isActive" defaultChecked={p.isActive} /> aktif
                      </label>
                      <button className="button-ghost px-2 py-1 text-xs">kaydet</button>
                    </form>
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
