// Faz 23 — Tahsilat Riski ve Ödeme Önceliği.
//
// The collection worklist first, then the cash-aware payment queue, then the counterparty
// scorecard. Every risk number on this page shows the named signals that produced it: a score
// an operator cannot interrogate is a score they should not act on, which is why this phase
// uses a rule table rather than a model.
//
// The bad-debt control is a form with a mandatory reason and nothing else. There is no bulk
// action and no automation anywhere on this page.

import { getPool } from "@/lib/db";
import {
  loadCollectionProfiles, loadPaymentCalendar, loadPaymentSchedule, loadReceivableRisk,
} from "@/lib/collections/engine";
import { loadCashMonths } from "@/lib/cashflow/engine";
import { istanbulDateISO } from "@/lib/reports/rules";
import { Badge, type Tone } from "@/components/ui/badge";
import { Panel, fmtTL } from "@/components/ui/panel";
import { PageHeader } from "@/components/ui/shell";
import { clearBadDebtAction, markBadDebtAction } from "./actions";

export const dynamic = "force-dynamic";

const SEVERITY_TONE: Record<string, Tone> = {
  "yok": "green", "izle": "amber", "yüksek": "amber", "kritik": "red",
};
const BAND_TONE: Record<string, Tone> = {
  "yüksek": "green", "orta": "amber", "düşük": "red", "çok düşük": "red",
};

function addDays(iso: string, n: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
}

export default async function CollectionsPage({
  searchParams,
}: { searchParams: Promise<{ error?: string; result?: string }> }) {
  const sp = await searchParams;
  const pool = getPool();
  const today = istanbulDateISO();

  const months = await loadCashMonths(pool);
  // Available cash for the scheduling cutoff: the most recent known closing balance. Null
  // closings are skipped rather than read as zero — an unknown balance is not "no money".
  const knownClosings = months.filter((m) => m.closing != null);
  const availableCash = knownClosings.length ? (knownClosings[knownClosings.length - 1].closing as number) : 0;

  const [risks, schedule, profiles, calendar] = await Promise.all([
    loadReceivableRisk(pool, today, 100),
    loadPaymentSchedule(pool, availableCash, 100),
    loadCollectionProfiles(pool, 30),
    loadPaymentCalendar(pool, today, addDays(today, 30)),
  ]);

  const critical = risks.filter((r) => r.severity === "kritik");
  const flagged = risks.filter((r) => r.badDebtFlagged);
  const totalOpen = risks.reduce((n, r) => n + r.openAmount, 0);
  // Expected collections weighted by probability — an estimate, labelled as one.
  const weighted = Math.round(risks.reduce((n, r) => n + r.openAmount * r.probability, 0) * 100) / 100;

  return (
    <>
      <PageHeader
        title="Tahsilat Riski ve Ödeme Önceliği"
        subtitle="Deterministik risk sezgisi, beklenen tahsilat tarihi ve nakde duyarlı ödeme sıralaması"
        meta={
          <Badge tone={critical.length > 0 ? "red" : schedule.shortfall > 0 ? "amber" : "green"} dot>
            {critical.length > 0 ? `${critical.length} kritik alacak`
              : schedule.shortfall > 0 ? `${fmtTL(schedule.shortfall)} nakit açığı`
              : `${risks.length} açık alacak`}
          </Badge>
        }
      />

      {sp.error && <div className="mb-3 rounded border border-neg/40 bg-neg/10 p-2 text-sm text-neg">{sp.error}</div>}
      {sp.result && <div className="mb-3 rounded border border-pos/40 bg-pos/10 p-2 text-sm text-pos">{sp.result}</div>}

      <div className="mb-4 grid grid-cols-2 gap-2 lg:grid-cols-4">
        <Panel title="AÇIK ALACAK"><b className="font-mono text-lg">{fmtTL(totalOpen)}</b></Panel>
        <Panel title="OLASILIKLA AĞIRLIKLI">
          <b className="font-mono text-lg text-tone-3">{fmtTL(weighted)}</b>
          <div className="text-[10px] text-tone-3">tahmin — kural tabanlı</div>
        </Panel>
        <Panel title="ŞÜPHELİ ALACAK"><b className="font-mono text-lg text-neg">{flagged.length}</b></Panel>
        <Panel title="NAKİT AÇIĞI">
          <b className={`font-mono text-lg ${schedule.shortfall > 0 ? "text-neg" : "text-pos"}`}>
            {fmtTL(schedule.shortfall)}
          </b>
        </Panel>
      </div>

      <Panel title={`TAHSİLAT RİSKİ — ${risks.length}`}>
        <p className="mb-2 text-xs text-tone-3">
          Her skor, onu üreten <b>adlandırılmış sinyalleri</b> yanında taşır. Model değil, kural
          tablosu: yanlış bir sonuç kuralı düzelterek düzeltilir. Hiçbir skor kendiliğinden bir
          şey işaretlemez.
        </p>
        {risks.length === 0 ? (
          <p className="py-2 text-sm text-tone-3">Açık alacak yok.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-tone-3">
                  <th>Fatura</th><th>Karşı taraf</th><th>Vade</th>
                  <th className="text-right">Açık</th><th className="text-right">Gecikme</th>
                  <th>Beklenen tahsilat</th><th className="text-right">Olasılık</th>
                  <th>Risk</th><th>Şüpheli alacak</th>
                </tr>
              </thead>
              <tbody>
                {risks.map((r) => (
                  <tr key={r.invoiceId} className="border-t border-line-faint align-top">
                    <td className="py-2 font-mono text-xs">{r.invoiceNo}</td>
                    <td>{r.partyName}</td>
                    <td className="font-mono text-xs">{r.dueDate ?? "—"}</td>
                    <td className="text-right font-mono tabular-nums">{fmtTL(r.openAmount)}</td>
                    <td className="text-right tabular-nums">
                      {r.daysOverdue == null ? "—" : r.daysOverdue > 0 ? `${r.daysOverdue} gün` : "—"}
                    </td>
                    <td className="text-xs">
                      <span className="font-mono">{r.expectedDate ?? "—"}</span>
                      {/* The basis is shown, not just the date: "party_history" and
                          "issue_date_fallback" are very different claims. */}
                      <span className="ml-1 text-[10px] text-tone-3">{r.expectedBasis}</span>
                    </td>
                    <td className="text-right">
                      <Badge tone={BAND_TONE[r.probabilityBand] ?? "neutral"}>
                        %{Math.round(r.probability * 100)}
                      </Badge>
                      <div className="text-[10px] text-tone-3">{r.probabilitySignals.join(", ")}</div>
                    </td>
                    <td>
                      <Badge tone={SEVERITY_TONE[r.severity] ?? "neutral"}>{r.severity}</Badge>
                      {r.riskFlags.length > 0 && (
                        <div className="text-[10px] text-tone-3">{r.riskFlags.join(", ")}</div>
                      )}
                    </td>
                    <td>
                      {r.badDebtFlagged ? (
                        <form action={clearBadDebtAction} className="flex flex-col gap-1">
                          <span className="text-[10px] text-neg">{r.badDebtReason}</span>
                          <input type="hidden" name="invoiceId" value={r.invoiceId} />
                          <input
                            name="reason" required minLength={5} placeholder="kaldırma gerekçesi"
                            className="w-32 rounded border border-line-faint bg-transparent px-1 py-0.5 text-[11px]"
                          />
                          <button className="text-left text-xs text-pos hover:underline">işareti kaldır</button>
                        </form>
                      ) : (
                        <form action={markBadDebtAction} className="flex flex-col gap-1">
                          <input type="hidden" name="invoiceId" value={r.invoiceId} />
                          <input
                            name="reason" required minLength={10} placeholder="gerekçe (en az 10 karakter)"
                            className="w-32 rounded border border-line-faint bg-transparent px-1 py-0.5 text-[11px]"
                          />
                          <button className="text-left text-xs text-neg hover:underline">şüpheli işaretle</button>
                        </form>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <div className="mt-4">
        <Panel title={`NAKDE DUYARLI ÖDEME SIRASI — ${schedule.items.length}`}>
          <p className="mb-2 text-xs text-tone-3">
            Kullanılabilir nakit <b>{fmtTL(availableCash)}</b> (son bilinen kasa).
            Karşılanamayan kalemler <b>gizlenmez</b> — listeden düşürmek sorunu değil yalnız
            görüntüsünü ortadan kaldırırdı.
            {schedule.unknownCount > 0 && (
              <> {schedule.unknownCount} kalemin tutarı bilinmiyor; sıfır sayılmadılar.</>
            )}
          </p>
          {schedule.items.length === 0 ? (
            <p className="py-2 text-sm text-tone-3">Bekleyen ödeme yok.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-tone-3">
                    <th>Vade</th><th>Tür</th><th>Kalem</th>
                    <th className="text-right">Tutar</th><th className="text-right">Kümülatif</th>
                    <th>Durum</th><th>Esneklik</th>
                  </tr>
                </thead>
                <tbody>
                  {schedule.items.map((i) => (
                    <tr key={`${i.kind}-${i.entityId}`} className="border-t border-line-faint">
                      <td className="py-1 font-mono text-xs">{i.dueDate}</td>
                      <td className="text-xs text-tone-3">{i.kind}</td>
                      <td className="truncate">{i.label}</td>
                      <td className="text-right font-mono tabular-nums">
                        {i.amount == null ? <span className="text-warn">TUTAR EKSİK</span> : fmtTL(i.amount)}
                      </td>
                      <td className="text-right font-mono tabular-nums text-tone-3">{fmtTL(i.cumulative)}</td>
                      <td>
                        <Badge tone={i.covered ? "green" : "red"}>
                          {i.covered ? "karşılanıyor" : "karşılanmıyor"}
                        </Badge>
                      </td>
                      <td className="text-xs text-tone-3">
                        {i.deferrable ? "ertelenebilir" : "ertelenemez"}
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
        <Panel title="ÖDEME TAKVİMİ (30 GÜN)">
          {calendar.length === 0 ? (
            <p className="py-2 text-sm text-tone-3">Önümüzdeki 30 günde yükümlülük yok.</p>
          ) : (
            calendar.map((d) => (
              <div key={d.dueDate} className="grid grid-cols-[auto_1fr_auto] gap-2 border-b border-line-faint py-1 text-sm">
                <span className={`font-mono text-xs ${d.hasOverdue ? "text-neg" : ""}`}>{d.dueDate}</span>
                <span className="text-xs text-tone-3">
                  {d.itemCount} kalem
                  {d.unknownAmountCount > 0 && <span className="text-warn"> · {d.unknownAmountCount} tutarsız</span>}
                </span>
                <span className="font-mono tabular-nums">{fmtTL(d.knownTotal)}</span>
              </div>
            ))
          )}
        </Panel>

        <Panel title="KARŞI TARAF TAHSİLAT KARNESİ">
          <p className="mb-2 text-xs text-tone-3">
            Yalnız gerçekleşmiş davranış: sayımlar ve ortalamalar, tahmin değil.
          </p>
          {profiles.length === 0 ? (
            <p className="py-2 text-sm text-tone-3">Açık alacaklı karşı taraf yok.</p>
          ) : (
            profiles.map((p) => (
              <div key={p.partyId} className="grid grid-cols-[1fr_auto_auto_auto] gap-2 border-b border-line-faint py-1 text-sm">
                <span className="truncate">{p.partyName}</span>
                <span className="text-xs text-tone-3">
                  {p.lateRatio == null ? "geçmiş yok" : `%${Math.round(p.lateRatio * 100)} geç`}
                </span>
                <span className="text-xs text-tone-3">
                  {p.avgDaysToSettle == null ? "—" : `${p.avgDaysToSettle} gün`}
                </span>
                <span className={`font-mono tabular-nums ${p.overdueAmount > 0 ? "text-neg" : ""}`}>
                  {fmtTL(p.openAmount)}
                </span>
              </div>
            ))
          )}
        </Panel>
      </div>
    </>
  );
}
