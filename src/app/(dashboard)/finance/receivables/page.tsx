// Faz 22 & Faz 47 (D1) — Alacak / Borç ve Cari Hesap.
//
// Sayfalanmamış kanonik açık alacak/borç KPI toplamları + döviz rozetleri + döviz-duyarlı `formatMoney`.

import { getPool } from "@/lib/db";
import { loadCanonicalPayablesKpi, loadCanonicalReceivablesKpi } from "@/lib/metrics/canonical-kpis";
import { formatForeignCurrencyBadges, formatMoney } from "@/lib/money-format";
import {
  listRecentActiveAllocations, loadCurrentAccounts, loadDsoDpo, loadPayableTotals, loadReceivables,
  loadReceivableTotals, loadSettlementSpeed, loadUnallocatedSettlements,
} from "@/lib/receivables/engine";
import { COLLECTION_BUCKETS } from "@/lib/receivables/rules";
import { istanbulDateISO } from "@/lib/reports/rules";
import { Badge, type Tone } from "@/components/ui/badge";
import { Panel, fmtTL } from "@/components/ui/panel";
import { PageHeader } from "@/components/ui/shell";
import { allocateAction, reverseAllocationAction } from "./actions";
import { requireRouteAccess } from "@/lib/authz/route-guard";

export const dynamic = "force-dynamic";

const BUCKET_TONE: Record<string, Tone> = {
  "vadesi gelmemiş": "green", "1-7 gün": "amber", "8-30 gün": "amber",
  "31-60 gün": "red", "60+ gün": "red", "tarihsiz": "neutral",
};

const PARTY_TYPE_TR: Record<string, string> = {
  customer: "müşteri",
  supplier: "tedarikçi",
  vendor: "tedarikçi",
  both: "müşteri + tedarikçi",
  bank: "banka",
  lender: "finansör",
  tax: "vergi/kurum",
  other: "diğer",
};

const LIST_LIMIT = 75;

export default async function ReceivablesPage({
  searchParams,
}: { searchParams: Promise<{ error?: string; result?: string }> }) {
  const denied = await requireRouteAccess("/finance/receivables");
  if (denied) return denied;
  const sp = await searchParams;
  const pool = getPool();
  const today = istanbulDateISO();
  const [receivables, recTotals, payTotals, canonicalRec, canonicalPay, accounts, dsoDpo, unallocated, speed, recentAllocations] = await Promise.all([
    loadReceivables(pool, LIST_LIMIT),
    loadReceivableTotals(pool, today),
    loadPayableTotals(pool, today),
    loadCanonicalReceivablesKpi(pool),
    loadCanonicalPayablesKpi(pool),
    loadCurrentAccounts(pool, 20),
    loadDsoDpo(pool, 365),
    loadUnallocatedSettlements(pool, 25),
    loadSettlementSpeed(pool, 10),
    listRecentActiveAllocations(pool, 20),
  ]);
  const unallocatedInflows = unallocated.filter((u) => u.direction === "inflow");

  const recAgeing = recTotals.ageing;
  const payAgeing = payTotals.ageing;
  const recTotal = recTotals.totalOpenAmount;
  const payTotal = payTotals.totalOpenAmount;
  const overdueCount = recTotals.overdueCount;
  const recTruncated = recTotals.itemCount > receivables.length;
  const recForeignText = formatForeignCurrencyBadges(canonicalRec.foreignBuckets);
  const payForeignText = formatForeignCurrencyBadges(canonicalPay.foreignBuckets);

  return (
    <>
      <PageHeader
        title="Alacak / Borç ve Cari Hesap"
        subtitle="Yaşlandırma, tahsis (dağıtım), cari hesap kartı ve DSO/DPO"
        meta={
          <Badge tone={overdueCount > 0 ? "red" : unallocated.length > 0 ? "amber" : "green"} dot>
            {overdueCount > 0 ? `${overdueCount} vadesi geçmiş alacak`
              : unallocated.length > 0 ? `${unallocated.length} dağıtılmamış tahsilat`
              : `${recTotals.itemCount} açık alacak`}
          </Badge>
        }
      />

      {sp.error && <div className="mb-3 rounded border border-neg/40 bg-neg/10 p-2 text-sm text-neg">{sp.error}</div>}
      {sp.result && <div className="mb-3 rounded border border-pos/40 bg-pos/10 p-2 text-sm text-pos">{sp.result}</div>}

      <div className="mb-4 grid grid-cols-2 gap-2 lg:grid-cols-4">
        <Panel title="AÇIK ALACAK (TRY)" subtitle={recForeignText ?? undefined}>
          <b className="font-mono text-lg text-pos">{formatMoney(recTotal, "TRY")}</b>
          <div className="text-xs text-tone-3">{recTotals.itemCount} kayıt</div>
        </Panel>
        <Panel title="AÇIK BORÇ (TRY)" subtitle={payForeignText ?? undefined}>
          <b className="font-mono text-lg text-neg">{formatMoney(payTotal, "TRY")}</b>
          <div className="text-xs text-tone-3">{payTotals.itemCount} kayıt</div>
        </Panel>
        <Panel title="DSO (365g)">
          <b className="font-mono text-lg">{dsoDpo.dso == null ? "—" : `${dsoDpo.dso} gün`}</b>
        </Panel>
        <Panel title="DPO (365g)">
          <b className="font-mono text-lg">{dsoDpo.dpo == null ? "—" : `${dsoDpo.dpo} gün`}</b>
        </Panel>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {([["ALACAK YAŞLANDIRMA", recAgeing], ["BORÇ YAŞLANDIRMA", payAgeing]] as const).map(([title, buckets]) => (
          <Panel key={title} title={title}>
            <table className="w-full text-sm">
              <tbody>
                {COLLECTION_BUCKETS.map((b) => {
                  const row = buckets.find((x) => x.bucket === b)!;
                  return (
                    <tr key={b} className="border-b border-line-faint">
                      <td className="py-1"><Badge tone={BUCKET_TONE[b] ?? "neutral"}>{b}</Badge></td>
                      <td className="py-1 text-right tabular-nums text-tone-3">{row.count}</td>
                      <td className="py-1 text-right font-mono tabular-nums">{fmtTL(row.amount)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Panel>
        ))}
      </div>

      <div className="mt-4">
        <Panel title={`AÇIK ALACAKLAR — ${recTruncated ? `${receivables.length} / ${recTotals.itemCount}` : receivables.length}`}
          subtitle={recTruncated
            ? `En yüksek tutarlı ${LIST_LIMIT} kayıt listeleniyor; yukarıdaki toplamlar ${recTotals.itemCount} kaydın tamamını kapsıyor.`
            : undefined}>
          {receivables.length === 0 ? (
            <p className="py-2 text-sm text-tone-3">Açık alacak yok.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-tone-3">
                    <th>Fatura</th><th>Karşı taraf</th><th>Vade</th>
                    <th className="text-right">Tutar</th><th className="text-right">Dağıtılan</th>
                    <th className="text-right">Açık</th><th>Yaşlandırma</th><th>Dağıt</th>
                  </tr>
                </thead>
                <tbody>
                  {receivables.map((r) => (
                    <tr key={r.invoiceId} className="border-t border-line-faint">
                      <td className="py-2 font-mono text-xs">{r.invoiceNo}</td>
                      <td>{r.partyName}</td>
                      <td className="font-mono text-xs">{r.dueDate ?? "—"}</td>
                      <td className="text-right font-mono tabular-nums">{formatMoney(r.grossAmount, r.currency)}</td>
                      <td className="text-right font-mono tabular-nums text-tone-3">{formatMoney(r.allocatedAmount, r.currency)}</td>
                      <td className="text-right font-mono tabular-nums">{formatMoney(r.openAmount, r.currency)}</td>
                      <td><Badge tone={BUCKET_TONE[r.ageingBucket] ?? "neutral"}>{r.ageingBucket}</Badge></td>
                      <td>
                        <form action={allocateAction} className="flex flex-wrap items-center gap-1">
                          <input type="hidden" name="invoiceId" value={r.invoiceId} />
                          <select
                            name="settlementSource"
                            defaultValue="manual"
                            className="max-w-44 rounded border border-line-faint bg-transparent px-1 py-0.5 text-xs"
                          >
                            <option value="manual">Manuel tahsilat</option>
                            {unallocatedInflows.map((u) => (
                              <option key={`${u.sourceTable}:${u.sourceId}`} value={`${u.sourceTable}:${u.sourceId}`}>
                                {(u.description || u.sourceTable).slice(0, 24)} · {fmtTL(u.unallocatedAmount)}
                              </option>
                            ))}
                          </select>
                          <input
                            name="amount" type="number" step="0.01" min="0.01" max={r.openAmount}
                            placeholder="tutar"
                            className="w-20 rounded border border-line-faint bg-transparent px-1 py-0.5 text-xs"
                          />
                          <button className="text-xs text-pos hover:underline">dağıt</button>
                        </form>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Panel title={`DAĞITILMAMIŞ TAHSİLAT — ${unallocated.length}`}>
          <p className="mb-2 text-xs text-tone-3">
            Hesaba giren ama hiçbir faturaya bağlanmamış para. Dağıtım toplamı fatura tutarını
            aşamadığı için (0048) fazla tahsilat burada görünür — kaybolmaz.
          </p>
          {unallocated.length === 0 ? (
            <p className="py-2 text-sm text-tone-3">Dağıtılmamış tahsilat yok.</p>
          ) : (
            unallocated.map((u) => (
              <div key={u.sourceId} className="grid grid-cols-[1fr_auto_auto] gap-2 border-b border-line-faint py-1 text-sm">
                <span className="truncate">{u.description || u.sourceTable}</span>
                <span className="font-mono text-xs text-tone-3">{u.sourceDate}</span>
                <span className="font-mono tabular-nums text-warn">{fmtTL(u.unallocatedAmount)}</span>
              </div>
            ))
          )}
        </Panel>

        <Panel title="ORTALAMA TAHSİLAT/ÖDEME SÜRESİ">
          <p className="mb-2 text-xs text-tone-3">
            Gerçekleşmiş süre — yalnız tahsil edilmiş faturalar sayılır. Ödenmemiş bir faturanın
            süresi yoktur; sıfır saymak karşı tarafı olmadığı kadar iyi gösterirdi.
          </p>
          {speed.length === 0 ? (
            <p className="py-2 text-sm text-tone-3">Henüz tahsil edilmiş fatura yok.</p>
          ) : (
            speed.map((s) => (
              <div key={`${s.partyId}-${s.direction}`} className="grid grid-cols-[1fr_auto_auto] gap-2 border-b border-line-faint py-1 text-sm">
                <span>{s.partyName}</span>
                <span className="text-xs text-tone-3">{s.direction === "sales" ? "tahsilat" : "ödeme"}</span>
                <span className="font-mono tabular-nums">{s.avgDaysToSettle ?? "—"} gün</span>
              </div>
            ))
          )}
        </Panel>
      </div>

      <div className="mt-4">
        <Panel title={`SON TAHSİSLER VE GERİ ALMA — ${recentAllocations.length}`}>
          <p className="mb-2 text-xs text-tone-3">
            Tahsis silinmez; gerekçesiyle geri alınır (`reversed_at`) ve fatura bakiyesi veritabanı tetikleyicisiyle yeniden hesaplanır.
          </p>
          {recentAllocations.length === 0 ? (
            <p className="py-2 text-sm text-tone-3">Aktif tahsis kaydı yok.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-tone-3">
                    <th>Fatura</th><th>Karşı taraf</th><th>Kaynak</th><th>Tarih</th>
                    <th className="text-right">Tutar</th><th>Geri al</th>
                  </tr>
                </thead>
                <tbody>
                  {recentAllocations.map((ia) => (
                    <tr key={ia.id} className="border-t border-line-faint">
                      <td className="py-1.5 font-mono text-xs">{ia.invoiceNo}</td>
                      <td>{ia.partyName}</td>
                      <td className="font-mono text-xs text-tone-3">{ia.sourceTable}</td>
                      <td className="font-mono text-xs">{ia.allocatedOn}</td>
                      <td className="text-right font-mono tabular-nums">{formatMoney(ia.allocatedAmount, ia.currency)}</td>
                      <td>
                        <form action={reverseAllocationAction} className="flex items-center gap-1">
                          <input type="hidden" name="allocationId" value={ia.id} />
                          <input
                            name="reason"
                            required
                            minLength={3}
                            placeholder="gerekçe"
                            className="w-28 rounded border border-line-faint bg-transparent px-1 py-0.5 text-xs"
                          />
                          <button className="text-xs text-neg hover:underline">Geri al</button>
                        </form>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>

      <div className="mt-4">
        <Panel title={`CARİ HESAP KARTLARI — ${accounts.length}`}>
          <p className="mb-2 text-xs text-tone-3">
            Alacak ve borç <b>netleştirilmez</b>: mahsup iki taraf arasında hukuki bir işlemdir,
            aritmetik bir işlem değil — burada netlemek var olmayan bir anlaşmayı varsaymak olurdu.
          </p>
          {accounts.length === 0 ? (
            <p className="py-2 text-sm text-tone-3">Hareketli cari hesap yok.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-tone-3">
                    <th>Karşı taraf</th><th>Tip</th>
                    <th className="text-right">Açık alacak</th><th className="text-right">Açık borç</th>
                    <th className="text-right">Vadesi geçen</th><th>En yakın vade</th>
                  </tr>
                </thead>
                <tbody>
                  {accounts.map((a) => (
                    <tr key={a.partyId} className="border-t border-line-faint">
                      <td className="py-2">{a.partyName}</td>
                      <td className="text-xs text-tone-3">{PARTY_TYPE_TR[a.partyType] ?? a.partyType}</td>
                      <td className="text-right font-mono tabular-nums text-pos">{fmtTL(a.receivableOpen)}</td>
                      <td className="text-right font-mono tabular-nums text-neg">{fmtTL(a.payableOpen)}</td>
                      <td className={`text-right tabular-nums ${a.overdueCount > 0 ? "text-warn" : "text-tone-3"}`}>
                        {a.overdueCount || "—"}
                      </td>
                      <td className="font-mono text-xs">{a.earliestDueDate ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>
    </>
  );
}
