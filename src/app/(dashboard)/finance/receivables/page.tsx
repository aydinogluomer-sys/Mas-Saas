// Faz 22 — Alacak / Borç ve Cari Hesap.
//
// Ageing first (that is the collection worklist), then the current-account cards, then the
// money that has arrived but belongs to no invoice yet. That last panel matters more than its
// size suggests: since 0048 caps allocations at the invoice total, an over-receipt no longer
// hides inside a paid_amount — it sits there until somebody decides where it belongs.

import { getPool } from "@/lib/db";
import {
  loadCurrentAccounts, loadDsoDpo, loadPayableTotals, loadReceivables,
  loadReceivableTotals, loadSettlementSpeed, loadUnallocatedSettlements,
} from "@/lib/receivables/engine";
import { COLLECTION_BUCKETS } from "@/lib/receivables/rules";
import { istanbulDateISO } from "@/lib/reports/rules";
import { Badge, type Tone } from "@/components/ui/badge";
import { Panel, fmtTL } from "@/components/ui/panel";
import { PageHeader } from "@/components/ui/shell";
import { allocateAction } from "./actions";
import { requireRouteAccess } from "@/lib/authz/route-guard";

export const dynamic = "force-dynamic";

const BUCKET_TONE: Record<string, Tone> = {
  "vadesi gelmemiş": "green", "1-7 gün": "amber", "8-30 gün": "amber",
  "31-60 gün": "red", "60+ gün": "red", "tarihsiz": "neutral",
};

/**
 * Çalışma kuyruğu listesinin satır sınırı.
 *
 * Yalnız LİSTEYİ sınırlar; sayfanın finansal toplamları limitsiz aggregate'ten gelir. Bu sayıyı
 * değiştirmek hiçbir KPI'ı değiştirmemeli — testin doğruladığı invariant budur.
 */
const LIST_LIMIT = 75;

export default async function ReceivablesPage({
  searchParams,
}: { searchParams: Promise<{ error?: string; result?: string }> }) {
  // Faz 17-38 denetimi — sayfa seviyesi rol kapisi. Navigasyonun kullandigi AYNI karar
  // (canSeeRoute); ikinci bir liste, ikinci bir fikir ve kacinilmaz bir kayma demekti.
  const denied = await requireRouteAccess("/finance/receivables");
  if (denied) return denied;
  const sp = await searchParams;
  const pool = getPool();
  const today = istanbulDateISO();
  // LİSTE SINIRLI, TOPLAMLAR DEĞİL.
  //
  // Bu iki şeyin ayrılması bu ekranın tek önemli kuralı. Liste bir çalışma kuyruğudur ve
  // sınırlı olması meşrudur; ama "AÇIK ALACAK" bir KARAR SAYISIDIR ve listeye bağlı olamaz.
  // Öncesinde her ikisi de `loadReceivables(pool, 75)`'ten geliyordu, yani ekrandaki toplam
  // aslında "en büyük 75 alacağın toplamı"ydı ve bunu söyleyen hiçbir şey yoktu.
  //
  // Toplamlar artık aynı view üzerinden, LİMİTSİZ bir aggregate'ten geliyor (bkz.
  // loadOpenTotals). Liste limiti değiştiğinde toplamlar değişmez — testin de doğruladığı şey bu.
  // `loadPayables` ARTIK ÇAĞRILMIYOR: bu ekran borç LİSTESİ göstermiyor, yalnız borç
  // TOPLAMINI ve yaşlandırmasını gösteriyor — ikisi de artık limitsiz aggregate'ten geliyor.
  // Satırları çekip atmak, sonucu kullanılmayan bir sorgu demekti.
  const [receivables, recTotals, payTotals, accounts, dsoDpo, unallocated, speed] = await Promise.all([
    loadReceivables(pool, LIST_LIMIT),
    loadReceivableTotals(pool, today),
    loadPayableTotals(pool, today),
    loadCurrentAccounts(pool, 20),
    loadDsoDpo(pool, 365),
    loadUnallocatedSettlements(pool, 10),
    loadSettlementSpeed(pool, 10),
  ]);

  const recAgeing = recTotals.ageing;
  const payAgeing = payTotals.ageing;
  const recTotal = recTotals.totalOpenAmount;
  const payTotal = payTotals.totalOpenAmount;
  const overdueCount = recTotals.overdueCount;
  // Liste kırpıldı mı? Kırpıldıysa kullanıcı bunu EKRANDA görmeli: kırpılmış bir listeyi tam
  // sanmak, üstteki toplamla listedeki satırların toplamı arasındaki farkı hataya yormaya yol açar.
  const recTruncated = recTotals.itemCount > receivables.length;

  return (
    <>
      <PageHeader
        title="Alacak / Borç ve Cari Hesap"
        subtitle="Yaşlandırma, dağıtım (allocation), cari hesap kartı ve DSO/DPO"
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
        <Panel title="AÇIK ALACAK"><b className="font-mono text-lg text-pos">{fmtTL(recTotal)}</b><div className="text-xs text-tone-3">{recTotals.itemCount} kayıt</div></Panel>
        <Panel title="AÇIK BORÇ"><b className="font-mono text-lg text-neg">{fmtTL(payTotal)}</b><div className="text-xs text-tone-3">{payTotals.itemCount} kayıt</div></Panel>
        <Panel title="DSO (365g)">
          {/* null means "no sales in the period" — reporting 0 would claim customers pay
              instantly at a company that sold nothing. */}
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
                {/* Every bucket is rendered, including empty ones: an absent row and a zero row
                    read very differently to someone scanning for problems. */}
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
                      <td className="text-right font-mono tabular-nums">{fmtTL(r.grossAmount)}</td>
                      <td className="text-right font-mono tabular-nums text-tone-3">{fmtTL(r.allocatedAmount)}</td>
                      <td className="text-right font-mono tabular-nums">{fmtTL(r.openAmount)}</td>
                      <td><Badge tone={BUCKET_TONE[r.ageingBucket] ?? "neutral"}>{r.ageingBucket}</Badge></td>
                      <td>
                        {/* Capped at the open amount client-side for convenience; 0048's trigger
                            is what actually guarantees it. */}
                        <form action={allocateAction} className="flex items-center gap-1">
                          <input type="hidden" name="invoiceId" value={r.invoiceId} />
                          <input type="hidden" name="sourceTable" value="manual" />
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
                      <td className="text-xs text-tone-3">{a.partyType}</td>
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
