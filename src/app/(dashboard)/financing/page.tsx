import Link from "next/link";
import { getPool } from "@/lib/db";
import { istanbulDateISO } from "@/lib/reports/rules";
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
import { DetailsDisclosure, ModuleEmptyState, PageHeader } from "@/components/ui/shell";

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
      <>
        <PageHeader
          title="Finansman"
          subtitle="Çek vadeleri · kredi taksitleri · banka ve karşı taraf yoğunlaşması"
          meta={<Badge tone="amber">veri bekliyor</Badge>}
        />
        <ModuleEmptyState
          eyebrow="Çek / kredi hazır değil"
          title="Çek ve krediler aktarılınca bu ekran vade radarı olur."
          body="Excel ham kaynağı korunur; açık veya reddedilmiş incelemeli satırlar (çift-kayıt adayları dâhil) sessizce içeri alınmaz. Önce workbook detayından çek/kredi aktarımını çalıştırın; vade pencereleri, borç servisi ve banka yoğunlaşması burada görünür."
          primaryHref="/imports"
          primaryLabel="içe aktarımı aç"
          secondaryHref="/data-quality"
          secondaryLabel="review durumuna bak"
          steps={[
            "Workbook detayına girip “çek/kredi aktar” komutunu çalıştır.",
            "Açık veya ret incelemeleri veri kalite merkezinde kapat.",
            "Aktarım sonrası vade riski ve borç servisi bu ekranda izlenir.",
          ]}
        />
      </>
    );
  }

  const today = istanbulDateISO();
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
      <PageHeader
        title="Finansman Radarı"
        subtitle="Çek defteri · kredi + taksit planı · vade takvimi · banka exposure"
        meta={
          <>
            <Badge tone="violet" dot>{checks.length} çek</Badge>
            <Badge tone="amber">{loans.length} kredi</Badge>
            {totalRemainingDebt > 0 && <Badge tone="neutral">kalan borç {fmt0(totalRemainingDebt)}</Badge>}
          </>
        }
        action={
          <Link
            href="/scenarios?from=financing"
            className="border px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider"
            style={{ color: "var(--accent)", borderColor: "var(--accent)", borderRadius: "var(--radius)", background: "color-mix(in srgb, var(--accent) 10%, transparent)" }}
          >
            borç-servisi senaryosu →
          </Link>
        }
      />

      {sp.checks != null && (
        <Panel title="AKTARIM SONUCU" accent="pos">
          <p className="text-sm" style={{ color: "var(--text-2)" }}>
            <Num>{sp.checks}</Num> çek · <Num>{sp.loans}</Num> kredi · <Num>{sp.installments}</Num> taksit
            aktarıldı (tekrar güvenli; çift-kayıt/açık incelemeler hariç).
          </p>
        </Panel>
      )}

      {/* horizon windows */}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        {windows.map((w) => (
          <div key={w.days} className="border border-line bg-surface-0 p-2">
            <div className="font-mono text-[10px] uppercase tracking-wider text-tone-3">
              ÖNÜMÜZDEKİ {w.days} GÜN
            </div>
            <div className="mt-1 font-mono text-sm tabular-nums text-neg">
              {fmtTL(w.knownOutflow)} <span className="text-[10px] text-tone-3">ödenecek</span>
            </div>
            {w.knownInflow > 0 && (
              <div className="font-mono text-xs tabular-nums text-pos">
                +{fmt0(w.knownInflow)} tahsil
              </div>
            )}
            <div className="mt-1 font-mono text-[9px] text-tone-3">
              <Num>{w.count}</Num> vade{w.missingCount > 0 ? ` · ${w.missingCount} tutar eksik` : ""}
            </div>
          </div>
        ))}
      </div>

      {/* loans */}
      {loans.length > 0 && (
        <Panel
          title={`KREDİLER — ${loans.length}`}
          right={
            <span className="font-mono text-[10px] text-tone-2">
              kalan borç {fmt0(totalRemainingDebt)} · finansman maliyeti {fmt0(totalFinanceCost)}
            </span>
          }
        >
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {loans.map((l) => (
              <div key={l.id} className="border border-line bg-black/40 p-3">
                <div className="flex items-center justify-between">
                  <Link
                    href={`/finance/loans/${l.id}`}
                    className="font-mono text-xs underline decoration-line-strong underline-offset-2 hover:text-tone-1"
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
                <tr className="border-b border-line text-left font-mono text-[10px] uppercase tracking-wider text-tone-3">
                  <th className="py-1 pr-2">ay</th>
                  <th className="py-1 pr-2 text-right">vade adedi</th>
                  <th className="py-1 pr-2 text-right">ödenecek</th>
                  <th className="py-1 pr-2 text-right">tahsil</th>
                  <th className="py-1 text-right">tutar eksik</th>
                </tr>
              </thead>
              <tbody>
                {debt.map((d) => (
                  <tr key={d.monthStart} className="border-b border-line-faint">
                    <td className="py-1 pr-2 font-mono text-xs">{AYK(d.monthStart)}</td>
                    <td className="py-1 pr-2 text-right font-mono tabular-nums">{d.count}</td>
                    <td className="py-1 pr-2 text-right font-mono tabular-nums text-neg">{fmt0(d.knownOutflow)}</td>
                    <td className="py-1 pr-2 text-right font-mono tabular-nums text-pos">
                      {d.knownInflow > 0 ? fmt0(d.knownInflow) : "—"}
                    </td>
                    <td className="py-1 text-right font-mono tabular-nums text-warn">
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

      {/* maturity calendar (weeks) — detail, collapsed */}
      {weekGroups.length > 0 && (
        <DetailsDisclosure label="Vade takvimi — ilk 12 hafta">
          <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
            {weekGroups.map((w) => (
              <div key={w.key} className="flex items-center justify-between border border-line-faint bg-black/30 px-2 py-1">
                <span className="font-mono text-[11px] text-tone-2">
                  {w.key} <span className="text-tone-4">({w.from.slice(5)}–{w.to.slice(5)})</span>
                </span>
                <span className="flex items-center gap-2 font-mono text-[11px] tabular-nums">
                  <span className="text-tone-3">{w.count} vade</span>
                  {w.knownOutflow > 0 && <span className="text-neg">−{fmt0(w.knownOutflow)}</span>}
                  {w.knownInflow > 0 && <span className="text-pos">+{fmt0(w.knownInflow)}</span>}
                  {w.missingCount > 0 && <Badge tone="amber">{w.missingCount} eksik</Badge>}
                </span>
              </div>
            ))}
          </div>
        </DetailsDisclosure>
      )}

      {/* checks ledger — detail with source-trace links, collapsed */}
      {checks.length > 0 && (
        <DetailsDisclosure label={`Çek defteri — ${checks.length} çek (kaynak kayıt)`}>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-line text-left font-mono text-[10px] uppercase tracking-wider text-tone-3">
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
                  <tr key={c.id} className="border-b border-line-faint">
                    <td className="py-1 pr-2 font-mono text-xs">{c.maturityDate}</td>
                    <td className="py-1 pr-2">
                      <Badge tone={DIR_TONE[c.direction]}>{DIR_LABEL[c.direction]}</Badge>
                    </td>
                    <td className="py-1 pr-2 text-xs">{c.payee ?? c.payer ?? "—"}</td>
                    <td className="py-1 pr-2 text-xs text-tone-2">{c.bank ?? "—"}</td>
                    <td className="py-1 pr-2 font-mono text-[11px] text-tone-3">{c.serial ?? "—"}</td>
                    <td className={`py-1 pr-2 text-right font-mono tabular-nums ${c.direction === "outflow" ? "text-neg" : c.direction === "inflow" ? "text-pos" : ""}`}>
                      {c.amount != null ? fmt0(c.amount) : <Badge tone="amber">TUTAR EKSİK</Badge>}
                    </td>
                    <td className="py-1 font-mono text-[10px] text-tone-4">
                      {c.sourceWorkbookId && c.sourceSheetId ? (
                        <Link
                          className="underline decoration-line-strong underline-offset-2"
                          href={`/data/imports/${c.sourceWorkbookId}/sheets/${c.sourceSheetId}`}
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
          <p className="mt-2 text-[11px]" style={{ color: "var(--text-4)" }}>
            Negatif işaretli tutar = ödeme yükümlülüğü (anomali değil, yön). Toplam {monthGroups.length} ayda dağılıyor.
          </p>
        </DetailsDisclosure>
      )}
    </>
  );
}

function Field({ k, v, tone }: { k: string; v: string; tone?: "red" }) {
  return (
    <div>
      <div className="font-mono text-[9px] uppercase tracking-wider text-tone-3">{k}</div>
      <div className={`font-mono tabular-nums ${tone === "red" ? "text-neg" : "text-tone-1"}`}>{v}</div>
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
  if (entries.length === 0) return <p className="text-xs text-tone-3">Bilinen tutarlı çek yok.</p>;
  const max = entries[0]?.total ?? 1;
  return (
    <div className="space-y-1">
      {entries.map((e) => (
        <div key={e.key}>
          <div className="flex items-center justify-between font-mono text-[11px]">
            <span className={e.flagged ? "text-neg" : "text-tone-2"}>
              {e.key} {e.flagged && <Badge tone="red">%{(e.ratio * 100).toFixed(0)}</Badge>}
            </span>
            <span className="tabular-nums text-tone-2">{fmt0(e.total)}</span>
          </div>
          <div className="mt-0.5 h-1 bg-surface-2">
            <div
              className="h-1"
              style={{ width: `${Math.max(2, (e.total / max) * 100)}%`, background: e.flagged ? "var(--neg)" : "var(--text-4)" }}
            />
          </div>
        </div>
      ))}
      <div className="pt-1 font-mono text-[10px] text-tone-4">
        bilinen toplam {fmt0(knownTotal)}
        {unknownCount > 0 ? ` · ${unknownCount} tutar eksik (orana katılmadı)` : ""}
      </div>
    </div>
  );
}
