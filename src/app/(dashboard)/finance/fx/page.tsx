import { Badge } from "@/components/ui/badge";
import { fmtTL, Panel } from "@/components/ui/panel";
import { EmptyState, KeyStat, PageHeader, TableShell } from "@/components/ui/shell";
import { requireRouteAccess } from "@/lib/authz/route-guard";
import { getPool } from "@/lib/db";
import { loadLiveFxExposureWorkspace } from "@/lib/financing/fx-ops";
import { loadExposureSummary, loadLatestRates } from "@/lib/fx/engine";
import { STRESS_BANDS } from "@/lib/fx/rules";
import { decimal } from "@/lib/money";
import { formatMoney } from "@/lib/money-format";
import { istanbulDateISO } from "@/lib/reports/rules";
import {
  closeFxPositionAction,
  createFxPositionAction,
  recordRateAction,
  runPeriodEndVuk280RevaluationAction,
} from "./actions";

export const dynamic = "force-dynamic";

export default async function FxPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; result?: string }>;
}) {
  const denied = await requireRouteAccess("/finance/fx");
  if (denied) return denied;
  const sp = await searchParams;
  const pool = getPool();
  const today = istanbulDateISO();

  const [liveWorkspace, summary, rates] = await Promise.all([
    loadLiveFxExposureWorkspace(pool),
    loadExposureSummary(pool),
    loadLatestRates(pool),
  ]);

  const unpriced =
    liveWorkspace.missingRateCurrencies.length +
    summary.reduce((s, r) => s + r.positionsWithoutRate, 0);
  const shock20TotalTry = Number(
    liveWorkspace.liveRows
      .reduce((acc, r) => acc.plus(r.netPositionTry != null ? decimal(r.netPositionTry).times("0.20") : 0), decimal(0))
      .round(2)
      .toFixed(2),
  );

  return (
    <>
      <PageHeader
        title="Kur Riski, Canlı Döviz Pozisyonu & VUK 280 Değerleme"
        subtitle={`Kasa/banka, açık faturalar, çek/senet, krediler ve forward kontratlardan türeyen canlı döviz pozisyonu + ±%${STRESS_BANDS.join("/")} stres testi`}
        meta={
          <Badge tone={unpriced > 0 ? "amber" : "green"} dot>
            {unpriced > 0 ? `${unpriced} kur eksikliği` : "tüm döviz kurları güncel"}
          </Badge>
        }
      />

      {sp.error ? (
        <div
          className="rounded border px-3 py-2 text-sm"
          style={{
            background: "var(--surface-2)",
            borderColor: "var(--warn)",
            color: "var(--text-1)",
          }}
        >
          {sp.error}
        </div>
      ) : null}

      {sp.result ? (
        <div
          className="rounded border px-3 py-2 text-sm"
          style={{
            background: "var(--surface-2)",
            borderColor: "var(--pos)",
            color: "var(--text-1)",
          }}
        >
          {sp.result}
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <KeyStat
          label="Canlı Net Döviz Pozisyonu (TL)"
          value={fmtTL(liveWorkspace.totalNetPositionTry)}
          tone={liveWorkspace.totalNetPositionTry < 0 ? "neg" : "pos"}
          sub={`${liveWorkspace.liveRows.length} aktif yabancı para`}
        />
        <KeyStat
          label="+%20 Kur Artışı P&L Etkisi"
          value={fmtTL(shock20TotalTry)}
          tone={shock20TotalTry < 0 ? "neg" : "pos"}
          sub="Kısa pozisyonda kur artışı kambiyo zararı üretir"
        />
        <KeyStat
          label="Aktif Forward / Hedge"
          value={liveWorkspace.hedgePositions.filter((h) => h.isActive).length}
          tone="info"
          sub={`Toplam ${liveWorkspace.hedgePositions.length} türev kayıt`}
        />
        <KeyStat
          label="Geçici Kurlu Fiş (provisional_fx)"
          value={liveWorkspace.provisionalJournalCount}
          tone={liveWorkspace.provisionalJournalCount > 0 ? "warn" : "pos"}
          sub="VUK 280 çalıştırıldığında kesinleşir"
        />
      </div>

      <Panel
        title="Canlı Konsolide Döviz Maruziyeti (live_fx_exposure_v)"
        subtitle="100/102 kasa-banka, 120/320 açık faturalar, 101/103/121/321 çek-senet, 300/400 kredi borçları ve forward kontratlar — para birimleri birbirine karıştırılmaz"
      >
        {liveWorkspace.liveRows.length === 0 ? (
          <EmptyState>Aktif yabancı para varlık veya yükümlülük bulunmuyor.</EmptyState>
        ) : (
          <TableShell>
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left uppercase" style={{ color: "var(--text-2)" }}>
                  <th className="py-1.5">Döviz</th>
                  <th className="text-right">Kasa/Banka</th>
                  <th className="text-right">Açık Alacak + Çek</th>
                  <th className="text-right">Açık Borç + Çek</th>
                  <th className="text-right">Kredi Borcu</th>
                  <th className="text-right">Forward / Hedge</th>
                  <th className="text-right">Net Orijinal</th>
                  <th className="text-right">TCMB Kur</th>
                  <th className="text-right">Net TL Karşılığı</th>
                  <th className="text-right">+%10 Şok</th>
                  <th className="text-right">+%20 Şok</th>
                </tr>
              </thead>
              <tbody>
                {liveWorkspace.liveRows.map((row) => {
                  const arPlusChk = Number(
                    decimal(row.receivablesNative).plus(row.checksReceivableNative).round(2).toFixed(2),
                  );
                  const apPlusChk = Number(
                    decimal(row.payablesNative).plus(row.checksPayableNative).round(2).toFixed(2),
                  );
                  const shock10 =
                    row.netPositionTry != null
                      ? Number(decimal(row.netPositionTry).times("0.10").round(2).toFixed(2))
                      : null;
                  const shock20 =
                    row.netPositionTry != null
                      ? Number(decimal(row.netPositionTry).times("0.20").round(2).toFixed(2))
                      : null;
                  return (
                    <tr
                      key={row.currency}
                      className="border-t"
                      style={{ borderColor: "var(--line)", color: "var(--text-1)" }}
                    >
                      <td className="py-2 font-mono font-semibold">
                        <Badge tone="neutral">{row.currency}</Badge>
                      </td>
                      <td className="text-right font-mono tabular-nums">
                        {formatMoney(row.cashBankNative, row.currency)}
                      </td>
                      <td className="text-right font-mono tabular-nums text-pos">
                        {formatMoney(arPlusChk, row.currency)}
                      </td>
                      <td className="text-right font-mono tabular-nums text-neg">
                        {formatMoney(apPlusChk, row.currency)}
                      </td>
                      <td className="text-right font-mono tabular-nums text-neg">
                        {formatMoney(row.loanDebtNative, row.currency)}
                      </td>
                      <td className="text-right font-mono tabular-nums">
                        {formatMoney(row.hedgeNative, row.currency)}
                      </td>
                      <td
                        className={`text-right font-mono font-semibold tabular-nums ${
                          row.netPositionNative < 0 ? "text-neg" : "text-pos"
                        }`}
                      >
                        {formatMoney(row.netPositionNative, row.currency)}
                      </td>
                      <td className="text-right font-mono tabular-nums" style={{ color: "var(--text-2)" }}>
                        {row.spotRateToTry != null ? row.spotRateToTry.toFixed(4) : "Kur Yok"}
                      </td>
                      <td
                        className={`text-right font-mono font-semibold tabular-nums ${
                          (row.netPositionTry ?? 0) < 0 ? "text-neg" : "text-pos"
                        }`}
                      >
                        {row.netPositionTry != null ? fmtTL(row.netPositionTry) : "—"}
                      </td>
                      <td
                        className={`text-right font-mono tabular-nums ${
                          (shock10 ?? 0) < 0 ? "text-neg" : "text-pos"
                        }`}
                      >
                        {shock10 != null ? fmtTL(shock10) : "—"}
                      </td>
                      <td
                        className={`text-right font-mono tabular-nums ${
                          (shock20 ?? 0) < 0 ? "text-neg" : "text-pos"
                        }`}
                      >
                        {shock20 != null ? fmtTL(shock20) : "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </TableShell>
        )}
      </Panel>

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
        <Panel
          title="Forward / Opsiyon / Swap Döviz Hedge Kayıtları (fx_positions)"
          subtitle="Türev ve vadeli döviz alım/satım sözleşmeleri canlı döviz maruziyetini dengeler"
        >
          <div className="space-y-3">
            <form
              action={createFxPositionAction}
              className="grid grid-cols-1 gap-2 rounded border p-3 text-xs sm:grid-cols-3"
              style={{ background: "var(--surface-2)", borderColor: "var(--line)" }}
            >
              <select name="currency" defaultValue="USD" className="field-control px-2 py-1.5 font-mono text-xs">
                <option value="USD">USD</option>
                <option value="EUR">EUR</option>
                <option value="GBP">GBP</option>
                <option value="CHF">CHF</option>
              </select>
              <select name="instrumentSubtype" defaultValue="forward" className="field-control px-2 py-1.5 text-xs">
                <option value="forward">Forward Sözleşmesi</option>
                <option value="option">Döviz Opsiyonu</option>
                <option value="swap">Döviz Swap</option>
                <option value="manual">Manuel Hedge</option>
              </select>
              <select name="direction" defaultValue="long" className="field-control px-2 py-1.5 text-xs">
                <option value="long">Uzun / Alım (+)</option>
                <option value="short">Kısa / Satım (−)</option>
              </select>
              <input
                name="amount"
                type="number"
                step="0.01"
                min="0.01"
                required
                placeholder="Kontrat büyüklüğü"
                className="field-control px-2 py-1.5 font-mono text-xs"
              />
              <input
                name="entryRate"
                type="number"
                step="0.0001"
                min="0.0001"
                placeholder="Forward / uzlaşı kuru"
                className="field-control px-2 py-1.5 font-mono text-xs"
              />
              <input
                name="asOfDate"
                type="date"
                required
                defaultValue={today}
                className="field-control px-2 py-1.5 font-mono text-xs"
              />
              <select name="counterpartyPartyId" className="field-control px-2 py-1.5 text-xs">
                <option value="">Banka / Karşı taraf (opsiyonel)</option>
                {liveWorkspace.bankCounterparties.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
              <input
                name="sourceNote"
                placeholder="Sözleşme referansı / not"
                className="field-control px-2 py-1.5 text-xs"
              />
              <button type="submit" className="button-primary px-3 py-1.5 text-xs">
                Hedge kontratı ekle
              </button>
            </form>

            {liveWorkspace.hedgePositions.length === 0 ? (
              <EmptyState>Kayıtlı forward veya türev hedge pozisyonu yok.</EmptyState>
            ) : (
              <TableShell>
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left uppercase" style={{ color: "var(--text-2)" }}>
                      <th className="py-1">Döviz / Tür</th>
                      <th className="text-right">Tutar</th>
                      <th className="text-right">Giriş / Spot</th>
                      <th className="text-right">Gerçekleşmemiş K/Z</th>
                      <th>Durum</th>
                    </tr>
                  </thead>
                  <tbody>
                    {liveWorkspace.hedgePositions.map((hp) => (
                      <tr
                        key={hp.id}
                        className="border-t"
                        style={{ borderColor: "var(--line)", color: "var(--text-1)" }}
                      >
                        <td className="py-1.5">
                          <div className="font-mono font-semibold">
                            {hp.currency} · {hp.positionKind}
                          </div>
                          <div className="text-[11px]" style={{ color: "var(--text-2)" }}>
                            {hp.counterpartyName ?? hp.sourceNote ?? hp.asOfDate}
                          </div>
                        </td>
                        <td className="text-right font-mono tabular-nums">
                          {formatMoney(hp.amount, hp.currency)}
                        </td>
                        <td className="text-right font-mono text-[11px] tabular-nums">
                          {hp.entryRate != null ? hp.entryRate.toFixed(4) : "—"} /{" "}
                          {hp.spotRate != null ? hp.spotRate.toFixed(4) : "—"}
                        </td>
                        <td
                          className={`text-right font-mono tabular-nums ${
                            (hp.unrealizedPnlTry ?? 0) < 0 ? "text-neg" : "text-pos"
                          }`}
                        >
                          {hp.unrealizedPnlTry != null ? fmtTL(hp.unrealizedPnlTry) : "—"}
                        </td>
                        <td>
                          {hp.isActive ? (
                            <form action={closeFxPositionAction}>
                              <input type="hidden" name="positionId" value={hp.id} />
                              <button type="submit" className="button-ghost px-2 py-0.5 text-[11px]">
                                Kapat
                              </button>
                            </form>
                          ) : (
                            <Badge tone="neutral">Kapalı</Badge>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableShell>
            )}
          </div>
        </Panel>

        <Panel
          title="Dönem Sonu VUK 280 Kur Değerleme (646 Kambiyo Kârları / 656 Kambiyo Zararları)"
          subtitle="100, 101, 102, 120, 121, 128, 300, 301, 309, 320, 321 dövizli parasal hesapların TCMB kuru ile değerlemesi"
        >
          <div className="space-y-3">
            <form
              action={runPeriodEndVuk280RevaluationAction}
              className="flex flex-wrap items-end gap-2 rounded border p-3 text-xs"
              style={{ background: "var(--surface-2)", borderColor: "var(--line)" }}
            >
              <label className="flex flex-col gap-1">
                <span className="font-mono text-[10px] uppercase tracking-wider text-tone-3">
                  Değerleme Tarihi
                </span>
                <input
                  type="date"
                  name="asOfDate"
                  required
                  defaultValue={today}
                  className="field-control px-2.5 py-1.5 font-mono text-xs"
                />
              </label>
              <button type="submit" className="button-accent px-3 py-1.5 text-xs">
                VUK 280 Kur Değerleme Fişi Üret
              </button>
            </form>

            {liveWorkspace.recentRevaluations.length === 0 ? (
              <EmptyState>Henüz oluşturulmuş dönem sonu VUK 280 kur değerleme fişi bulunmuyor.</EmptyState>
            ) : (
              <TableShell>
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left uppercase" style={{ color: "var(--text-2)" }}>
                      <th className="py-1">Fiş No</th>
                      <th>Tarih</th>
                      <th>Açıklama</th>
                      <th className="text-right">Toplam Değerleme Hacmi</th>
                    </tr>
                  </thead>
                  <tbody>
                    {liveWorkspace.recentRevaluations.map((ev) => (
                      <tr
                        key={ev.id}
                        className="border-t"
                        style={{ borderColor: "var(--line)", color: "var(--text-1)" }}
                      >
                        <td className="py-1.5 font-mono">#{ev.entryNo}</td>
                        <td className="font-mono">{ev.entryDate}</td>
                        <td>{ev.description}</td>
                        <td className="text-right font-mono tabular-nums">{fmtTL(ev.totalDebitTry)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableShell>
            )}
          </div>
        </Panel>
      </div>

      <Panel title="TCMB / Manuel Döviz Kurları" subtitle="TCMB bülteni veya banka gişe kurları anlık görüntü tablosu">
        <form action={recordRateAction} className="mb-3 grid grid-cols-1 gap-3 sm:grid-cols-5">
          <label className="flex flex-col gap-1">
            <span className="font-mono text-[10px] uppercase tracking-wider text-tone-3">Para birimi</span>
            <input
              required
              name="baseCurrency"
              maxLength={3}
              placeholder="USD"
              className="field-control px-2 py-1.5 text-xs uppercase"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="font-mono text-[10px] uppercase tracking-wider text-tone-3">Tarih</span>
            <input
              required
              type="date"
              name="rateDate"
              defaultValue={today}
              className="field-control px-2 py-1.5 font-mono text-xs"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="font-mono text-[10px] uppercase tracking-wider text-tone-3">Kur (TRY)</span>
            <input
              required
              type="number"
              step="0.0001"
              min="0.0001"
              name="rate"
              className="field-control px-2 py-1.5 font-mono text-xs"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="font-mono text-[10px] uppercase tracking-wider text-tone-3">Kaynak</span>
            <select name="source" defaultValue="tcmb" className="field-control px-2 py-1.5 text-xs">
              <option value="tcmb">TCMB</option>
              <option value="manual">manuel</option>
              <option value="bank">banka</option>
              <option value="other">diğer</option>
            </select>
          </label>
          <div className="flex items-end">
            <button type="submit" className="button-primary px-3 py-1.5 text-xs">
              Kuru kaydet
            </button>
          </div>
        </form>

        {rates.length === 0 ? (
          <EmptyState>Kayıtlı kur yok.</EmptyState>
        ) : (
          <TableShell>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase" style={{ color: "var(--text-2)" }}>
                  <th className="py-1">Parite</th>
                  <th className="text-right">Kur</th>
                  <th>Tarih</th>
                  <th>Kaynak</th>
                </tr>
              </thead>
              <tbody>
                {rates.map((r) => (
                  <tr
                    key={`${r.baseCurrency}-${r.quoteCurrency}`}
                    className="border-t"
                    style={{ borderColor: "var(--line)", color: "var(--text-1)" }}
                  >
                    <td className="py-2 font-mono">
                      {r.baseCurrency}/{r.quoteCurrency}
                    </td>
                    <td className="text-right font-mono tabular-nums">{r.rate?.toFixed(4) ?? "—"}</td>
                    <td className="font-mono text-xs tabular-nums">{r.rateDate}</td>
                    <td>
                      <Badge tone={r.source === "tcmb" ? "green" : "neutral"}>{r.source}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableShell>
        )}
      </Panel>
    </>
  );
}
