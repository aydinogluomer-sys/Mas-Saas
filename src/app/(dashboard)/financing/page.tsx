import Link from "next/link";
import { getPool } from "@/lib/db";
import {
  loadChecks,
  loadLoans,
  loadMaturityItems,
} from "@/lib/financing/engine";
import {
  debtServiceByMonth,
  exposureBy,
  groupMaturities,
  maturityWindows,
  type CheckDirection,
} from "@/lib/financing/rules";
import { Badge, type Tone } from "@/components/ui/badge";
import { Num, Panel, fmtTL } from "@/components/ui/panel";

export const dynamic = "force-dynamic";

const AYK = (iso: string | null) => (iso ? iso.slice(0, 7) : "—");
const fmt0 = (v: number | null) =>
  v != null ? new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 0 }).format(v) : "—";

const DIR_TONE: Record<CheckDirection, Tone> = { outflow: "red", inflow: "green", unknown: "amber" };
const DIR_LABEL: Record<CheckDirection, string> = { outflow: "ÖDENECEK", inflow: "TAHSİL", unknown: "YÖN?" };

export default async function FinancingPage({
  searchParams,
}: {
  searchParams: Promise<{ checks?: string; loans?: string; installments?: string }>;
}) {
  const sp = await searchParams;
  const pool = getPool();
  const [checks, loans, maturities] = await Promise.all([
    loadChecks(pool),
    loadLoans(pool),
    loadMaturityItems(pool),
  ]);

  if (checks.length === 0 && loans.length === 0) {
    return (
      <Panel title="ÇEK / KREDİ">
        <p className="text-sm text-zinc-500">
          Henüz çek veya kredi yok.{" "}
          <Link className="underline underline-offset-2" href="/imports">
            İçe aktarım
          </Link>{" "}
          sayfasından workbook detayına girip &quot;çek/kredi aktar&quot; ile başlayın. Açık/ret incelemeli
          satırlar (çift-kayıt adayları dâhil) aktarılmaz.
        </p>
      </Panel>
    );
  }

  const today = new Date().toISOString().slice(0, 10);
  const windows = maturityWindows(maturities, today);
  const monthGroups = groupMaturities(maturities, "month");
  const weekGroups = groupMaturities(maturities, "week").slice(0, 12);
  const debt = debtServiceByMonth(maturities);
  const bankExposure = exposureBy(
    checks.map((c) => ({ key: c.bank, amount: c.amount, direction: c.direction })),
  );
  const counterpartyExposure = exposureBy(
    checks.map((c) => ({ key: c.payee ?? c.payer, amount: c.amount, direction: c.direction })),
  );

  const totalRemainingDebt = loans.reduce((s, l) => s + (l.remainingAmount ?? 0), 0);
  const totalFinanceCost = loans.reduce((s, l) => s + (l.totalFinanceCost ?? 0), 0);

  return (
    <>
      {sp.checks != null && (
        <Panel title="AKTARIM SONUCU">
          <p className="text-sm">
            <Num>{sp.checks}</Num> çek · <Num>{sp.loans}</Num> kredi · <Num>{sp.installments}</Num> taksit
            aktarıldı (tekrar güvenli; çift-kayıt/açık incelemeler hariç).
          </p>
        </Panel>
      )}

      {/* horizon windows */}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        {windows.map((w) => (
          <div key={w.days} className="border border-zinc-800 bg-zinc-950 p-2">
            <div className="font-mono text-[10px] uppercase tracking-wider text-zinc-500">
              ÖNÜMÜZDEKİ {w.days} GÜN
            </div>
            <div className="mt-1 font-mono text-sm tabular-nums text-red-400">
              {fmtTL(w.knownOutflow)} <span className="text-[10px] text-zinc-500">ödenecek</span>
            </div>
            {w.knownInflow > 0 && (
              <div className="font-mono text-xs tabular-nums text-emerald-400">
                +{fmt0(w.knownInflow)} tahsil
              </div>
            )}
            <div className="mt-1 font-mono text-[9px] text-zinc-500">
              <Num>{w.count}</Num> vade{w.missingCount > 0 ? ` · ${w.missingCount} tutar eksik` : ""}
            </div>
          </div>
        ))}
      </div>

      <div className="flex justify-end">
        <Link href="/scenarios?from=financing" className="border border-violet-800 bg-violet-950/30 px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider text-violet-300">
          borç-servisi overlay ile senaryo üret →
        </Link>
      </div>

      {/* loans */}
      {loans.length > 0 && (
        <Panel
          title={`KREDİLER — ${loans.length}`}
          right={
            <span className="font-mono text-[10px] text-zinc-400">
              kalan borç {fmt0(totalRemainingDebt)} · finansman maliyeti {fmt0(totalFinanceCost)}
            </span>
          }
        >
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {loans.map((l) => (
              <div key={l.id} className="border border-zinc-800 bg-black/40 p-3">
                <div className="flex items-center justify-between">
                  <Link
                    href={`/financing/loans/${l.id}`}
                    className="font-mono text-xs underline decoration-zinc-700 underline-offset-2 hover:text-white"
                  >
                    {l.name}
                  </Link>
                  <Badge tone="amber">{l.remainingCount}/{l.installmentsLoaded} kalan</Badge>
                </div>
                <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
                  <Field k="anapara" v={fmt0(l.principal)} />
                  <Field k="toplam ödeme" v={fmt0(l.totalPayment)} />
                  <Field k="finansman maliyeti" v={fmt0(l.totalFinanceCost)} tone="red" />
                  <Field k="taksit" v={fmt0(l.installmentAmount)} />
                  <Field k="vade" v={`${l.termMonths ?? "—"} ay`} />
                  <Field k="ilk ödeme" v={l.firstPaymentDate ?? "—"} />
                  <Field k="aylık maliyet %" v={l.monthlyCostRate != null ? l.monthlyCostRate.toString() : "—"} />
                  <Field k="kalan tutar" v={fmt0(l.remainingAmount)} tone="red" />
                </div>
                {l.installmentsLoaded !== l.termMonths && l.termMonths != null && (
                  <div className="mt-2">
                    <Badge tone="amber">
                      taksit satırı {l.installmentsLoaded} ≠ vade {l.termMonths}
                    </Badge>
                  </div>
                )}
              </div>
            ))}
          </div>
        </Panel>
      )}

      {/* debt-service monthly load */}
      {debt.length > 0 && (
        <Panel title={`AYLIK BORÇ SERVİSİ (çek + taksit) — ${debt.length} ay`}>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-800 text-left font-mono text-[10px] uppercase tracking-wider text-zinc-500">
                  <th className="py-1 pr-2">ay</th>
                  <th className="py-1 pr-2 text-right">vade adedi</th>
                  <th className="py-1 pr-2 text-right">ödenecek</th>
                  <th className="py-1 pr-2 text-right">tahsil</th>
                  <th className="py-1 text-right">tutar eksik</th>
                </tr>
              </thead>
              <tbody>
                {debt.map((d) => (
                  <tr key={d.monthStart} className="border-b border-zinc-900">
                    <td className="py-1 pr-2 font-mono text-xs">{AYK(d.monthStart)}</td>
                    <td className="py-1 pr-2 text-right font-mono tabular-nums">{d.count}</td>
                    <td className="py-1 pr-2 text-right font-mono tabular-nums text-red-400">{fmt0(d.knownOutflow)}</td>
                    <td className="py-1 pr-2 text-right font-mono tabular-nums text-emerald-400">
                      {d.knownInflow > 0 ? fmt0(d.knownInflow) : "—"}
                    </td>
                    <td className="py-1 text-right font-mono tabular-nums text-amber-400">
                      {d.missingCount > 0 ? d.missingCount : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
      )}

      {/* exposure */}
      {checks.length > 0 && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Panel
            title="BANKA EXPOSURE"
            right={
              bankExposure.entries.some((e) => e.flagged) ? (
                <Badge tone="red">yoğunlaşma &gt;%40</Badge>
              ) : undefined
            }
          >
            <ExposureList
              entries={bankExposure.entries}
              knownTotal={bankExposure.knownTotal}
              unknownCount={bankExposure.unknownCount}
            />
          </Panel>
          <Panel title="KARŞI TARAF (kime/kimden) EXPOSURE">
            <ExposureList
              entries={counterpartyExposure.entries}
              knownTotal={counterpartyExposure.knownTotal}
              unknownCount={counterpartyExposure.unknownCount}
            />
          </Panel>
        </div>
      )}

      {/* maturity calendar (weeks) */}
      {weekGroups.length > 0 && (
        <Panel title="VADE TAKVİMİ — İLK 12 HAFTA">
          <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
            {weekGroups.map((w) => (
              <div key={w.key} className="flex items-center justify-between border border-zinc-900 bg-black/30 px-2 py-1">
                <span className="font-mono text-[11px] text-zinc-400">
                  {w.key} <span className="text-zinc-600">({w.from.slice(5)}–{w.to.slice(5)})</span>
                </span>
                <span className="flex items-center gap-2 font-mono text-[11px] tabular-nums">
                  <span className="text-zinc-500">{w.count} vade</span>
                  {w.knownOutflow > 0 && <span className="text-red-400">−{fmt0(w.knownOutflow)}</span>}
                  {w.knownInflow > 0 && <span className="text-emerald-400">+{fmt0(w.knownInflow)}</span>}
                  {w.missingCount > 0 && <Badge tone="amber">{w.missingCount} eksik</Badge>}
                </span>
              </div>
            ))}
          </div>
        </Panel>
      )}

      {/* checks ledger */}
      {checks.length > 0 && (
        <Panel title={`ÇEK DEFTERİ — ${checks.length}`}>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-800 text-left font-mono text-[10px] uppercase tracking-wider text-zinc-500">
                  <th className="py-1 pr-2">vade</th>
                  <th className="py-1 pr-2">yön</th>
                  <th className="py-1 pr-2">kime</th>
                  <th className="py-1 pr-2">banka</th>
                  <th className="py-1 pr-2">seri</th>
                  <th className="py-1 pr-2 text-right">tutar</th>
                  <th className="py-1">kaynak</th>
                </tr>
              </thead>
              <tbody>
                {checks.map((c) => (
                  <tr key={c.id} className="border-b border-zinc-900">
                    <td className="py-1 pr-2 font-mono text-xs">{c.maturityDate}</td>
                    <td className="py-1 pr-2">
                      <Badge tone={DIR_TONE[c.direction]}>{DIR_LABEL[c.direction]}</Badge>
                    </td>
                    <td className="py-1 pr-2 text-xs">{c.payee ?? c.payer ?? "—"}</td>
                    <td className="py-1 pr-2 text-xs text-zinc-400">{c.bank ?? "—"}</td>
                    <td className="py-1 pr-2 font-mono text-[11px] text-zinc-500">{c.serial ?? "—"}</td>
                    <td className={`py-1 pr-2 text-right font-mono tabular-nums ${c.direction === "outflow" ? "text-red-400" : c.direction === "inflow" ? "text-emerald-400" : ""}`}>
                      {c.amount != null ? fmt0(c.amount) : <Badge tone="amber">TUTAR EKSİK</Badge>}
                    </td>
                    <td className="py-1 font-mono text-[10px] text-zinc-600">
                      {c.sourceWorkbookId && c.sourceSheetId ? (
                        <Link
                          className="underline decoration-zinc-800 underline-offset-2"
                          href={`/imports/${c.sourceWorkbookId}/sheets/${c.sourceSheetId}`}
                        >
                          {c.rowIndex != null ? `r${c.rowIndex}` : "kaynak"} →
                        </Link>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="mt-2 font-mono text-[10px] text-zinc-600">
            Negatif işaretli tutar = ödeme yükümlülüğü (anomali değil, yön). Toplam {monthGroups.length} ayda dağılıyor.
          </p>
        </Panel>
      )}
    </>
  );
}

function Field({ k, v, tone }: { k: string; v: string; tone?: "red" }) {
  return (
    <div>
      <div className="font-mono text-[9px] uppercase tracking-wider text-zinc-500">{k}</div>
      <div className={`font-mono tabular-nums ${tone === "red" ? "text-red-400" : "text-zinc-200"}`}>{v}</div>
    </div>
  );
}

function ExposureList({
  entries,
  knownTotal,
  unknownCount,
}: {
  entries: ReturnType<typeof exposureBy>["entries"];
  knownTotal: number;
  unknownCount: number;
}) {
  if (entries.length === 0) return <p className="text-xs text-zinc-500">Bilinen tutarlı çek yok.</p>;
  const max = entries[0]?.total ?? 1;
  return (
    <div className="space-y-1">
      {entries.map((e) => (
        <div key={e.key}>
          <div className="flex items-center justify-between font-mono text-[11px]">
            <span className={e.flagged ? "text-red-400" : "text-zinc-300"}>
              {e.key} {e.flagged && <Badge tone="red">%{(e.ratio * 100).toFixed(0)}</Badge>}
            </span>
            <span className="tabular-nums text-zinc-400">{fmt0(e.total)}</span>
          </div>
          <div className="mt-0.5 h-1 bg-zinc-900">
            <div
              className={`h-1 ${e.flagged ? "bg-red-700" : "bg-zinc-600"}`}
              style={{ width: `${Math.max(2, (e.total / max) * 100)}%` }}
            />
          </div>
        </div>
      ))}
      <div className="pt-1 font-mono text-[10px] text-zinc-600">
        bilinen toplam {fmt0(knownTotal)}
        {unknownCount > 0 ? ` · ${unknownCount} tutar eksik (orana katılmadı)` : ""}
      </div>
    </div>
  );
}
