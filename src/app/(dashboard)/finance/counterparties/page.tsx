// Faz 19 — counterparty (cari hesap) overview.
//
// Dense and read-first, matching the rest of this dashboard: exposure ranking, the unresolved
// labels an import could not match, and the one form that creates a counterparty. The form is
// the point — it is the "explicit UI/action" the never-silently-create rule requires, and the
// unresolved list sitting beside it is what makes resolving a label a deliberate act rather
// than something a migration did quietly.

import { getPool } from "@/lib/db";
import {
  loadCounterpartyExposure,
  loadPartyCandidates,
  loadUnresolvedCounterparties,
} from "@/lib/counterparties/engine";
import { assessExposure, suggestCounterparties } from "@/lib/counterparties/rules";
import { Badge, type Tone } from "@/components/ui/badge";
import { Panel, fmtTL } from "@/components/ui/panel";
import { PageHeader } from "@/components/ui/shell";
import { createCounterpartyAction, linkCounterpartyAction } from "./actions";

export const dynamic = "force-dynamic";

const BAND_TONE: Record<string, Tone> = {
  none: "neutral", low: "green", watch: "amber", high: "amber", over_limit: "red",
};
const BAND_LABEL: Record<string, string> = {
  none: "risk yok", low: "düşük", watch: "izle", high: "yoğunlaşma", over_limit: "limit aşımı",
};

export default async function CounterpartiesPage({
  searchParams,
}: { searchParams: Promise<{ error?: string; warn?: string; result?: string }> }) {
  const sp = await searchParams;
  const pool = getPool();
  const [exposure, unresolved, candidates] = await Promise.all([
    loadCounterpartyExposure(pool, { withExposureOnly: false, limit: 100 }),
    loadUnresolvedCounterparties(pool, 50),
    loadPartyCandidates(pool),
  ]);

  const withExposure = exposure.filter((e) => e.itemCount > 0);
  // `overCreditLimit === null` = limit TRY değil, karşılaştırılamadı — aşım sayılmaz, ayrı sayılır.
  const overLimit = withExposure.filter((e) => e.overCreditLimit === true).length;
  const limitNotComparable = withExposure.filter((e) => e.creditLimit != null && !e.creditLimitComparable).length;
  const foreignItems = withExposure.reduce((n, e) => n + e.foreignCurrencyCount, 0);

  return (
    <>
      <PageHeader
        title="Karşı taraflar (cari hesap)"
        subtitle="Risk yoğunlaşması, banka hesapları ve eşleşmemiş kaynak etiketleri"
        meta={
          <Badge tone={overLimit > 0 ? "red" : unresolved.length > 0 ? "amber" : "green"} dot>
            {overLimit > 0 ? `${overLimit} limit aşımı` : `${unresolved.length} eşleşmemiş etiket`}
          </Badge>
        }
      />

      {sp.error && <div className="mb-3 rounded border border-neg/40 bg-neg/10 p-2 text-sm text-neg">{sp.error}</div>}
      {sp.warn && <div className="mb-3 rounded border border-warn/40 bg-warn/10 p-2 text-sm text-warn">{sp.warn}</div>}

      <Panel title={`RİSK YOĞUNLAŞMASI — ${withExposure.length} karşı taraf`}>
        {/* PHASE 2.2 / plan §2.3: TRY-dışı kalem toplama girmez ve bu sessizce olmaz. */}
        {(foreignItems > 0 || limitNotComparable > 0) && (
          <p className="mb-2 font-mono text-[11px] text-warn">
            {foreignItems > 0 && `${foreignItems} kalem TRY-dışı — toplamda yok. `}
            {limitNotComparable > 0 && `${limitNotComparable} karşı tarafın limiti TRY değil — limit aşımı hesaplanmadı.`}
          </p>
        )}
        {withExposure.length === 0 ? (
          <p className="py-2 text-sm text-tone-3">Açık kalem taşıyan karşı taraf yok.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-tone-3">
                  <th>Karşı taraf</th><th>Tip</th>
                  <th className="text-right">Risk</th>
                  <th className="text-right">Pay</th>
                  <th className="text-right">Çek</th>
                  <th className="text-right">Taksit</th>
                  <th className="text-right">Ödeme</th>
                  <th className="text-right">Limit</th>
                  <th>Durum</th>
                </tr>
              </thead>
              <tbody>
                {withExposure.map((e) => {
                  const a = assessExposure({
                    totalExposure: e.totalExposure,
                    // Limit TRY değilse bandlamaya girmez: TRY maruziyet ile USD limit kıyaslanamaz.
                    creditLimit: e.creditLimitComparable ? e.creditLimit : null,
                    exposureRatio: e.exposureRatio,
                    unknownAmountCount: e.unknownAmountCount,
                  });
                  return (
                    <tr key={e.partyId} className="border-t border-line-faint">
                      <td className="py-2">
                        {e.partyName}
                        {/* Unknown amounts are disclosed, never silently summed as zero. */}
                        {e.unknownAmountCount > 0 && (
                          <span className="ml-2 text-[10px] text-warn">{e.unknownAmountCount} TUTAR EKSİK</span>
                        )}
                        {e.foreignCurrencyCount > 0 && (
                          <span className="ml-2 text-[10px] text-warn">{e.foreignCurrencyCount} TRY-DIŞI · TOPLAMDA YOK</span>
                        )}
                      </td>
                      <td className="text-tone-3">{e.partyType}</td>
                      <td className="text-right font-mono tabular-nums">{fmtTL(e.totalExposure)}</td>
                      <td className="text-right tabular-nums">
                        {e.exposureRatio == null ? "—" : `%${(e.exposureRatio * 100).toFixed(1)}`}
                      </td>
                      <td className="text-right tabular-nums">{e.checkCount || "—"}</td>
                      <td className="text-right tabular-nums">{e.loanInstallmentCount || "—"}</td>
                      <td className="text-right tabular-nums">{e.paymentCount || "—"}</td>
                      <td className="text-right font-mono tabular-nums">
                        {e.creditLimit == null
                          ? "—"
                          : e.creditLimitComparable
                            ? fmtTL(e.creditLimit)
                            : <span title="Limit TRY değil; TRY maruziyetle karşılaştırılamaz">{`${e.creditLimit} ${e.creditLimitCurrency ?? ""} · kıyaslanamaz`}</span>}
                      </td>
                      <td>
                        <Badge tone={BAND_TONE[a.band] ?? "neutral"}>{BAND_LABEL[a.band] ?? a.band}</Badge>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Panel title={`EŞLEŞMEMİŞ KAYNAK ETİKETLERİ — ${unresolved.length}`}>
          <p className="mb-2 text-xs text-tone-3">
            İçe aktarma bu satırları bir karşı tarafa bağlayamadı ve ham metni korudu. Otomatik
            geri-doldurma YAPILMAZ — eşleştirme incelenmiş, açık bir işlemdir.
          </p>
          {unresolved.length === 0 ? (
            <p className="py-2 text-sm text-tone-3">Eşleşmemiş etiket yok.</p>
          ) : (
            unresolved.map((u) => {
              const hints = suggestCounterparties(u.rawLabel, candidates, 0.5, 3);
              return (
                <div key={`${u.source}-${u.sourceId}`} className="border-b border-line-faint py-2 text-sm">
                  <div className="flex items-baseline justify-between gap-2">
                    <span>
                      <b>{u.rawLabel}</b>
                      <span className="ml-2 text-[10px] text-tone-3">{u.source}</span>
                    </span>
                    <span className="font-mono tabular-nums">{fmtTL(u.amount)}</span>
                  </div>
                  {/* Suggestions are choices, never an automatic link — the check is only
                      offered for `check` rows because linking a loan's lender is a different
                      column and is not part of this phase's action surface. */}
                  {u.source === "check" && hints.length > 0 && (
                    <form action={linkCounterpartyAction} className="mt-1 flex flex-wrap items-center gap-2">
                      <input type="hidden" name="checkId" value={u.sourceId} />
                      <input type="hidden" name="role" value="payee" />
                      <select name="partyId" className="rounded border border-line-faint bg-transparent px-1 py-0.5 text-xs">
                        {hints.map((h) => (
                          <option key={h.partyId} value={h.partyId}>
                            {h.name} (%{Math.round(h.score * 100)})
                          </option>
                        ))}
                      </select>
                      <button className="rounded border border-line-faint px-2 py-0.5 text-xs hover:bg-white/5">
                        eşleştir
                      </button>
                    </form>
                  )}
                  {u.source === "check" && hints.length === 0 && (
                    <span className="text-[11px] text-tone-3">Yeterince benzeyen kayıtlı karşı taraf yok.</span>
                  )}
                  {u.source === "loan" && (
                    <span className="text-[11px] text-tone-3">
                      Kredide ham karşı taraf alanı yok; bu yalnız kredinin kendi adı — insan kararı gerektirir.
                    </span>
                  )}
                </div>
              );
            })
          )}
        </Panel>

        <Panel title="YENİ KARŞI TARAF">
          <p className="mb-2 text-xs text-tone-3">
            Karşı taraf yalnız buradan yaratılır. İçe aktarma hiçbir koşulda sessizce kayıt açmaz.
          </p>
          <form action={createCounterpartyAction} className="grid grid-cols-2 gap-2 text-sm">
            <input name="name" required placeholder="Ünvan" className="col-span-2 rounded border border-line-faint bg-transparent px-2 py-1" />
            <select name="partyType" className="rounded border border-line-faint bg-transparent px-2 py-1">
              {["vendor", "customer", "bank", "company", "person", "provider", "internal_owner", "unknown"].map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
            <input name="taxNumber" placeholder="Vergi no" className="rounded border border-line-faint bg-transparent px-2 py-1" />
            <input name="taxOffice" placeholder="Vergi dairesi" className="rounded border border-line-faint bg-transparent px-2 py-1" />
            <input name="city" placeholder="Şehir" className="rounded border border-line-faint bg-transparent px-2 py-1" />
            <input name="addressLine" placeholder="Adres" className="col-span-2 rounded border border-line-faint bg-transparent px-2 py-1" />
            <input name="creditLimit" type="number" step="0.01" min="0" placeholder="Kredi limiti (TL)" className="rounded border border-line-faint bg-transparent px-2 py-1" />
            <input name="paymentTermsDays" type="number" min="0" placeholder="Vade (gün)" className="rounded border border-line-faint bg-transparent px-2 py-1" />
            <button className="col-span-2 rounded border border-line-faint px-2 py-1 hover:bg-white/5">Karşı taraf ekle</button>
          </form>
        </Panel>
      </div>
    </>
  );
}
