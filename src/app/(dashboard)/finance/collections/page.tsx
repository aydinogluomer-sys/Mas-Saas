// Faz 23, Faz 47 (D1) & Faz 48 (D2) — Tahsilat Riski, Ödeme Önceliği ve Ödeme Çalıştırma Paketi (`payment_runs`).

import { getPool } from "@/lib/db";
import { loadBankableAccounts } from "@/lib/bank/engine";
import {
  loadCollectionProfiles, loadPaymentCalendar, loadPaymentSchedule, loadReceivableRisk,
} from "@/lib/collections/engine";
import { isReportingCurrency } from "@/lib/currency-policy";
import { loadCanonicalReceivablesKpi, loadCanonicalTreasuryCashKpi } from "@/lib/metrics/canonical-kpis";
import { formatForeignCurrencyBadges, formatMoney } from "@/lib/money-format";
import { loadPayableRunCandidates, loadPaymentRuns } from "@/lib/payments/payment-runs";
import { istanbulDateISO } from "@/lib/reports/rules";
import { Badge, type Tone } from "@/components/ui/badge";
import { Panel, fmtTL } from "@/components/ui/panel";
import { PageHeader } from "@/components/ui/shell";
import {
  cancelPaymentRunAction,
  clearBadDebtAction,
  createPaymentRunAction,
  markBadDebtAction,
  submitPaymentRunAction,
} from "./actions";
import { requireRouteAccess } from "@/lib/authz/route-guard";

export const dynamic = "force-dynamic";

const SEVERITY_TONE: Record<string, Tone> = {
  "yok": "green", "izle": "amber", "yüksek": "amber", "kritik": "red",
};
const BAND_TONE: Record<string, Tone> = {
  "yüksek": "green", "orta": "amber", "düşük": "red", "çok düşük": "red",
};
const RUN_STATUS_TONE: Record<string, Tone> = {
  draft: "neutral",
  pending_approval: "amber",
  approved: "blue",
  exported: "violet",
  settled: "green",
  cancelled: "red",
};
const RUN_STATUS_TR: Record<string, string> = {
  draft: "taslak",
  pending_approval: "onay bekliyor",
  approved: "onaylandı",
  exported: "talimat indirildi",
  settled: "bankada kapandı",
  cancelled: "iptal",
};
const EXPECTED_BASIS_TR: Record<string, string> = {
  promise: "ödeme sözü",
  party_dbt_median: "cari DBT medyanı",
  party_dbt_p75: "cari DBT P75",
  party_history: "cari geçmişi",
  due_date: "vade tarihi",
  issue_date_fallback: "fatura tarihi varsayımı",
};
const SCHEDULE_KIND_TR: Record<string, string> = {
  payment_instance: "ödeme kalemi",
  invoice: "fatura",
  check: "çek",
  loan_installment: "kredi taksiti",
};

function addDays(iso: string, n: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
}

export default async function CollectionsPage({
  searchParams,
}: { searchParams: Promise<{ error?: string; result?: string }> }) {
  const denied = await requireRouteAccess("/finance/collections");
  if (denied) return denied;
  const sp = await searchParams;
  const pool = getPool();
  const today = istanbulDateISO();

  const [treasuryCash, canonicalRec] = await Promise.all([
    loadCanonicalTreasuryCashKpi(pool),
    loadCanonicalReceivablesKpi(pool),
  ]);
  const scheduleAvailableCash = Math.max(0, treasuryCash.availableNowTry ?? 0);

  const [risks, schedule, profiles, calendar, runCandidates, paymentRuns, bankAccounts] = await Promise.all([
    loadReceivableRisk(pool, today, 100),
    loadPaymentSchedule(pool, scheduleAvailableCash, 100),
    loadCollectionProfiles(pool, 30),
    loadPaymentCalendar(pool, today, addDays(today, 30)),
    loadPayableRunCandidates(pool, "TRY", 40),
    loadPaymentRuns(pool, 15),
    loadBankableAccounts(pool),
  ]);

  const sourceBankAccounts = bankAccounts.filter(
    (a) => a.has_bank_profile && Boolean(a.iban_normalized) && a.currency === "TRY",
  );

  const critical = risks.filter((r) => r.severity === "kritik");
  const flagged = risks.filter((r) => r.badDebtFlagged);
  // Expected collections weighted by probability — strictly TRY-only so USD/EUR invoices are never mixed.
  const tryRisks = risks.filter((r) => isReportingCurrency(r.currency));
  const weightedTry = Math.round(tryRisks.reduce((n, r) => n + r.openAmount * r.probability, 0) * 100) / 100;
  const foreignBadges = formatForeignCurrencyBadges(canonicalRec.foreignBuckets);

  return (
    <>
      <PageHeader
        title="Tahsilat Riski ve Ödeme Önceliği"
        subtitle="Deterministik risk sezgisi, beklenen tahsilat tarihi, 14g kasa simülasyonlu ödeme paketi ve EFT/pain.001 ihracı"
        meta={
          <Badge tone={critical.length > 0 ? "red" : schedule.shortfall > 0 ? "amber" : "green"} dot>
            {critical.length > 0 ? `${critical.length} kritik alacak`
              : schedule.shortfall > 0 ? `${fmtTL(schedule.shortfall)} nakit açığı`
              : `${canonicalRec.totalCount} açık alacak`}
          </Badge>
        }
      />

      {sp.error && <div className="mb-3 rounded border border-neg/40 bg-neg/10 p-2 text-sm text-neg">{sp.error}</div>}
      {sp.result && <div className="mb-3 rounded border border-pos/40 bg-pos/10 p-2 text-sm text-pos">{sp.result}</div>}

      <div className="mb-4 grid grid-cols-2 gap-2 lg:grid-cols-4">
        <Panel title="AÇIK ALACAK (TRY)" subtitle={foreignBadges ?? undefined}>
          <b className="font-mono text-lg">{formatMoney(canonicalRec.tryTotal, "TRY")}</b>
        </Panel>
        <Panel title="OLASILIKLA AĞIRLIKLI (TRY)">
          <b className="font-mono text-lg text-tone-3">{formatMoney(weightedTry, "TRY")}</b>
          <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[10px] text-tone-3">
            <Badge tone="amber">Varsayım (Model Sabiti)</Badge>
            <span>kural tabanlı olasılık katsayıları (ilk 100 TRY kayıt)</span>
          </div>
        </Panel>
        <Panel title="ŞÜPHELİ ALACAK"><b className="font-mono text-lg text-neg">{flagged.length}</b></Panel>
        <Panel title="NAKİT AÇIĞI">
          <b className={`font-mono text-lg ${schedule.shortfall > 0 ? "text-neg" : "text-pos"}`}>
            {treasuryCash.availableNowTry == null ? "—" : fmtTL(schedule.shortfall)}
          </b>
          {treasuryCash.availableNowTry == null && (
            <div className="text-[10px] text-warn">açılış bakiyesi eksik ({treasuryCash.unknownOpeningCountTry} hesap)</div>
          )}
        </Panel>
      </div>

      <div
        className="mb-4 flex flex-wrap items-center gap-2 border px-3 py-2 text-xs"
        style={{
          background: "var(--surface-2)",
          borderColor: "var(--line-faint)",
          borderRadius: "var(--radius)",
          color: "var(--text-3)",
        }}
      >
        <Badge tone="amber">Varsayım (Model Sabiti)</Badge>
        <span>
          Alacak tahsilat olasılık katsayıları (taban %95; vade aşımı, cari gecikme oranı &gt;%40, kısmi tahsilat ve
          şüpheli alacak düzeltmeleri) ile nakde duyarlı ödeme önceliği puanlama ağırlıkları (esneklik sınıfı 0/100/200,
          öncelik kademesi 0–30 ve vade günü farkı) deterministik model sabitleridir; muhasebe defteri gerçeği değil
          karar destek varsayımıdır.
        </span>
      </div>

      <Panel
        title={`TAHSİLAT RİSKİ — ${risks.length}${canonicalRec.totalCount > risks.length ? ` / ${canonicalRec.totalCount}` : ""}`}
        right={<Badge tone="amber">Varsayım (Model Sabiti)</Badge>}
      >
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
                    <td className="text-right font-mono tabular-nums">{formatMoney(r.openAmount, r.currency)}</td>
                    <td className="text-right tabular-nums">
                      {r.daysOverdue == null ? "—" : r.daysOverdue > 0 ? `${r.daysOverdue} gün` : "—"}
                    </td>
                    <td className="text-xs">
                      <span className="font-mono">{r.expectedDate ?? "—"}</span>
                      <span className="ml-1 text-[10px] text-tone-3">{EXPECTED_BASIS_TR[r.expectedBasis] ?? r.expectedBasis}</span>
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
        <Panel title={`ÖDEME ÇALIŞTIRMA PAKETİ (PAYMENT RUN) & 14 GÜNLÜK KASA SİMÜLASYONU — ${paymentRuns.length} paket`}>
          <p className="mb-3 text-xs text-tone-3">
            Seçilen borç kalemleri oluşturulurken <b>14 günlük asgari kasa tamponu</b> (<code>treasury_policies</code>)
            otomatik simüle edilir. Paket <b>maker-checker</b> onayı almadan ve tüm alacaklı IBAN&apos;lar
            (BEC dolandırıcılık kalkanı + TR <code>MOD-97</code>) doğrulanmadan banka ödeme talimatı indirilemez.
          </p>

          <form action={createPaymentRunAction} className="mb-4 rounded border border-line-faint p-3 text-sm">
            <input type="hidden" name="currency" value="TRY" />
            <div className="mb-3 grid grid-cols-1 gap-2 md:grid-cols-4">
              <select
                name="sourceBankAccountId"
                required
                className="rounded border border-line-faint bg-transparent px-2 py-1 text-xs"
              >
                <option value="">Çıkış yapılacak TRY banka hesabı…</option>
                {sourceBankAccounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} ({a.iban_normalized})
                  </option>
                ))}
              </select>
              <input
                type="date"
                name="plannedExecutionDate"
                defaultValue={today}
                required
                className="rounded border border-line-faint bg-transparent px-2 py-1 font-mono text-xs"
              />
              <input
                name="notes"
                placeholder="Paket açıklaması (isteğe bağlı)"
                className="rounded border border-line-faint bg-transparent px-2 py-1 text-xs"
              />
              <button
                disabled={sourceBankAccounts.length === 0 || runCandidates.length === 0}
                className="rounded border border-line-faint px-3 py-1 text-xs font-medium hover:bg-white/5 disabled:opacity-40"
              >
                Ödeme paketi oluştur
              </button>
            </div>

            {sourceBankAccounts.length === 0 && (
              <p className="mb-2 text-xs text-warn">
                IBAN tanımlı aktif TRY banka hesabı yok — önce Banka Merkezi&apos;nde kaynak hesap IBAN bilgisi tanımlayın.
              </p>
            )}

            {runCandidates.length === 0 ? (
              <p className="text-xs text-tone-3">Pakete eklenebilecek açık TRY borç/ödeme kalemi bulunmuyor.</p>
            ) : (
              <div className="max-h-64 overflow-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left text-tone-3">
                      <th className="w-6">Seç</th>
                      <th>Tür</th>
                      <th>Kalem</th>
                      <th>Alacaklı</th>
                      <th>IBAN / BEC Kalkanı</th>
                      <th>Onay</th>
                      <th>Vade</th>
                      <th className="text-right">Açık Tutar</th>
                    </tr>
                  </thead>
                  <tbody>
                    {runCandidates.map((c) => {
                      const token = `${c.targetType}:${c.targetId}`;
                      return (
                        <tr key={token} className="border-t border-line-faint">
                          <td className="py-1">
                            <input
                              type="checkbox"
                              name="selectedTargets"
                              value={token}
                              disabled={!c.eligibleForRun}
                            />
                          </td>
                          <td className="text-tone-3">{SCHEDULE_KIND_TR[c.targetType] ?? c.targetType}</td>
                          <td className="font-mono">{c.referenceLabel}</td>
                          <td>{c.partyName}</td>
                          <td>
                            {c.ibanVerified ? (
                              <Badge tone="green">IBAN onaylı</Badge>
                            ) : c.beneficiaryIban ? (
                              <Badge tone="amber">BEC onayı bekliyor</Badge>
                            ) : (
                              <Badge tone="red">IBAN eksik</Badge>
                            )}
                          </td>
                          <td>
                            {c.approvalStatus === "pending_approval" ? (
                              <Badge tone="amber">onay bekliyor</Badge>
                            ) : c.approvalStatus === "rejected" ? (
                              <Badge tone="red">reddedildi</Badge>
                            ) : (
                              <Badge tone="green">hazır</Badge>
                            )}
                          </td>
                          <td className="font-mono">{c.dueDate ?? "—"}</td>
                          <td className="text-right font-mono tabular-nums">
                            {formatMoney(c.openAmount, c.currency)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </form>

          {paymentRuns.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-tone-3">
                    <th>Paket</th>
                    <th>Tarih</th>
                    <th>Kaynak Banka</th>
                    <th className="text-right">Kalem</th>
                    <th className="text-right">Toplam</th>
                    <th className="text-right">14g Min Kasa</th>
                    <th>Durum</th>
                    <th>Banka Talimat Dosyası / İşlem</th>
                  </tr>
                </thead>
                <tbody>
                  {paymentRuns.map((run) => {
                    const canExport =
                      ["approved", "exported", "settled"].includes(run.status) &&
                      run.unverifiedIbanCount === 0;
                    return (
                      <tr key={run.id} className="border-t border-line-faint align-top">
                        <td className="py-2 font-mono font-medium">{run.runCode}</td>
                        <td className="py-2 font-mono">{run.plannedExecutionDate}</td>
                        <td className="py-2">{run.sourceBankName}</td>
                        <td className="py-2 text-right font-mono tabular-nums">
                          {run.settledItemCount}/{run.itemCount}
                        </td>
                        <td className="py-2 text-right font-mono tabular-nums">
                          {formatMoney(run.totalAmount, run.currency)}
                        </td>
                        <td className="py-2 text-right font-mono tabular-nums">
                          {run.projected14dMinCash == null
                            ? "—"
                            : formatMoney(run.projected14dMinCash, run.currency)}
                          {run.breachesCashFloor && (
                            <div className="mt-0.5">
                              <Badge tone="red">taban aşımı</Badge>
                            </div>
                          )}
                        </td>
                        <td className="py-2">
                          <Badge tone={RUN_STATUS_TONE[run.status] ?? "neutral"}>
                            {RUN_STATUS_TR[run.status] ?? run.status}
                          </Badge>
                          {run.unverifiedIbanCount > 0 && (
                            <div className="mt-0.5 text-[10px] text-warn">
                              {run.unverifiedIbanCount} IBAN BEC onayı bekliyor
                            </div>
                          )}
                        </td>
                        <td className="py-2">
                          <div className="flex flex-wrap items-center gap-1.5">
                            {run.status === "draft" && (
                              <form action={submitPaymentRunAction} className="inline">
                                <input type="hidden" name="runId" value={run.id} />
                                <button className="rounded border border-line-faint px-2 py-0.5 text-info hover:bg-white/5">
                                  Onaya gönder
                                </button>
                              </form>
                            )}

                            {canExport && (
                              <>
                                <a
                                  href={`/api/payments/runs/${run.id}/export?format=pain001`}
                                  className="rounded border border-line-faint px-1.5 py-0.5 font-mono text-[11px] text-pos hover:bg-white/5"
                                >
                                  pain.001 XML
                                </a>
                                <a
                                  href={`/api/payments/runs/${run.id}/export?format=garanti_xlsx`}
                                  className="rounded border border-line-faint px-1.5 py-0.5 font-mono text-[11px] hover:bg-white/5"
                                >
                                  Garanti XLSX
                                </a>
                                <a
                                  href={`/api/payments/runs/${run.id}/export?format=isbank_csv`}
                                  className="rounded border border-line-faint px-1.5 py-0.5 font-mono text-[11px] hover:bg-white/5"
                                >
                                  İşBank CSV
                                </a>
                                <a
                                  href={`/api/payments/runs/${run.id}/export?format=yapikredi_csv`}
                                  className="rounded border border-line-faint px-1.5 py-0.5 font-mono text-[11px] hover:bg-white/5"
                                >
                                  YKredi CSV
                                </a>
                                <a
                                  href={`/api/payments/runs/${run.id}/export?format=akbank_csv`}
                                  className="rounded border border-line-faint px-1.5 py-0.5 font-mono text-[11px] hover:bg-white/5"
                                >
                                  Akbank CSV
                                </a>
                              </>
                            )}

                            {["draft", "pending_approval", "approved", "exported"].includes(run.status) && (
                              <form action={cancelPaymentRunAction} className="inline-flex items-center gap-1">
                                <input type="hidden" name="runId" value={run.id} />
                                <input
                                  name="reason"
                                  required
                                  minLength={3}
                                  placeholder="iptal gerekçesi"
                                  className="w-28 rounded border border-line-faint bg-transparent px-1 py-0.5 text-[11px]"
                                />
                                <button className="text-neg hover:underline">Paketi iptal et</button>
                              </form>
                            )}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>

      <div className="mt-4">
        <Panel
          title={`NAKDE DUYARLI ÖDEME SIRASI — ${schedule.items.length}`}
          right={<Badge tone="amber">Varsayım (Model Sabiti)</Badge>}
        >
          <p className="mb-2 text-xs text-tone-3">
            Kullanılabilir hazine nakdi (TRY):{" "}
            <b>
              {treasuryCash.availableNowTry == null
                ? "Bilinmiyor (açılış bakiyesi eksik)"
                : formatMoney(treasuryCash.availableNowTry, "TRY")}
            </b>.{" "}
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
                      <td className="text-xs text-tone-3">{SCHEDULE_KIND_TR[i.kind] ?? i.kind}</td>
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
                  {d.unknownAmountCount > 0 && <span className="text-warn"> · {d.unknownAmountCount} tutar eksik</span>}
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
                <span className="text-xs text-tone-3">{p.openCount} açık</span>
                <span className="font-mono text-xs text-tone-3">
                  {p.avgDaysToSettle == null ? "—" : `${p.avgDaysToSettle}g`}
                </span>
                <span className={`font-mono text-xs ${(p.lateRatio ?? 0) > 0.5 ? "text-neg" : "text-tone-3"}`}>
                  {p.lateRatio == null ? "—" : `%${Math.round(p.lateRatio * 100)} geç`}
                </span>
              </div>
            ))
          )}
        </Panel>
      </div>
    </>
  );
}
