import Link from "@/components/ui/app-link";
import { getRequestUser } from "@/lib/auth";
import { can } from "@/lib/authz/matrix";
import { requireRouteAccess } from "@/lib/authz/route-guard";
import {
  ALL_CATEGORIES,
  buildAutoSeeded13WeekForecast,
  CATEGORY_BUCKET_LABELS,
  compute13wVarianceWaterfall,
  listFrozen13wSnapshots,
} from "@/lib/cashflow/rolling-13w-engine";
import { Badge } from "@/components/ui/badge";
import { Panel } from "@/components/ui/panel";
import { EmptyState, KeyStat, PageHeader, TableShell } from "@/components/ui/shell";
import { getPool } from "@/lib/db";
import { formatMoney } from "@/lib/money-format";
import {
  addManual13WeekOverrideAction,
  freeze13WeekSnapshotAction,
  refreshAutoSeeded13WeekAction,
} from "./actions";

export const dynamic = "force-dynamic";

const CURRENCIES = ["TRY", "USD", "EUR"] as const;

export default async function Rolling13WeekForecastPage({
  searchParams,
}: {
  searchParams?: Promise<{
    currency?: string;
    dbtMode?: string;
    snapshotId?: string;
    weekStart?: string;
    error?: string;
    result?: string;
  }>;
}) {
  const denied = await requireRouteAccess("/cashflow/13-week");
  if (denied) return denied;

  const sp = (await searchParams) ?? {};
  const rawCurrency = (sp.currency ?? "TRY").trim().toUpperCase();
  const currency = CURRENCIES.includes(rawCurrency as (typeof CURRENCIES)[number])
    ? (rawCurrency as (typeof CURRENCIES)[number])
    : "TRY";
  const dbtMode = sp.dbtMode === "p75" ? "p75" : "median";

  const session = await getRequestUser();
  const canFreeze = session ? can(session.role, "forecast_snapshots_13w", "insert") : false;
  const canAddOverride = session ? can(session.role, "forecast_lines", "insert") : false;

  const pool = getPool();
  const todayISO = new Date().toISOString().slice(0, 10);

  const [forecast, snapshots] = await Promise.all([
    buildAutoSeeded13WeekForecast(pool, { asOfDate: todayISO, currency, dbtMode }),
    listFrozen13wSnapshots(pool, currency, 12),
  ]);

  const selectedSnapshot =
    (sp.snapshotId ? snapshots.find((s) => s.id === sp.snapshotId) : undefined) ?? snapshots[0] ?? null;

  const selectedWeekStart =
    sp.weekStart && /^\d{4}-\d{2}-\d{2}$/.test(sp.weekStart)
      ? sp.weekStart
      : selectedSnapshot?.snapshotWeekStart ?? forecast.snapshotWeekStart;

  const waterfall = selectedSnapshot
    ? await compute13wVarianceWaterfall(pool, {
        snapshotId: selectedSnapshot.id,
        weekStart: selectedWeekStart,
      })
    : null;

  const fmt = (val: number | null) =>
    val === null ? "Bilinmiyor (FIN-03)" : formatMoney(val, currency);

  return (
    <div className="space-y-4">
      <PageHeader
        title="13 Haftalık Doğrudan Nakit Tahmini & Varyans Şelalesi"
        subtitle="Açık alacaklar (V2 DBT), planlı ödemeler, tedarikçi faturaları, çek/senet vadeleri, kredi taksitleri ve GİB/SGK takviminden otomatik tohumlanan 13 haftalık nakit ufku"
        meta={
          <div className="flex flex-wrap items-center gap-2">
            {CURRENCIES.map((cur) => (
              <Link
                key={cur}
                href={`/cashflow/13-week?currency=${cur}&dbtMode=${dbtMode}`}
                className={`rounded border px-2.5 py-1 text-xs font-medium ${
                  currency === cur
                    ? "border-sky-500 bg-sky-950/70 text-sky-200"
                    : "border-slate-800 bg-slate-900/60 text-slate-400 hover:text-slate-200"
                }`}
              >
                {cur}
              </Link>
            ))}
            <Badge tone={forecast.firstFloorBreachWeekStart ? "red" : "green"} dot>
              {forecast.unknownOpeningCount > 0
                ? `${forecast.unknownOpeningCount} hesapta açılış bakiyesi bilinmiyor`
                : forecast.firstFloorBreachWeekStart
                  ? `İlk taban ihlali: ${forecast.firstFloorBreachWeekStart}`
                  : "13 hafta boyunca kasa tabanı korunuyor"}
            </Badge>
          </div>
        }
      />

      {sp.error ? (
        <div className="rounded border border-red-800 bg-red-950/60 px-3 py-2 text-xs text-red-200">
          {sp.error}
        </div>
      ) : null}
      {sp.result ? (
        <div className="rounded border border-emerald-800 bg-emerald-950/50 px-3 py-2 text-xs text-emerald-200">
          İşlem tamamlandı: {sp.result}
        </div>
      ) : null}

      {/* Top KPI Summary */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        <KeyStat
          label={`Açılış Kasa/Banka (${currency})`}
          value={fmt(forecast.openingCash)}
          tone={forecast.openingCash === null ? "warn" : "info"}
          sub={
            forecast.unknownOpeningCount > 0
              ? `${forecast.unknownOpeningCount} aktif hesapta açılış bakiyesi NULL`
              : `Referans: ${forecast.asOfDate}`
          }
        />
        <KeyStat
          label={`13H Toplam Giriş (${currency})`}
          value={formatMoney(forecast.totalInflow, currency)}
          tone="pos"
          sub={`Mod: ${dbtMode === "p75" ? "İhtiyatlı (P75 DBT)" : "Standart (Medyan DBT)"}`}
        />
        <KeyStat
          label={`13H Toplam Çıkış (${currency})`}
          value={formatMoney(forecast.totalOutflow, currency)}
          tone="neg"
          sub={`${forecast.statutoryDeadlines.length} yasal vergi/SGK günü`}
        />
        <KeyStat
          label={`13. Hafta Sonu Kapanış (${currency})`}
          value={fmt(forecast.endingCash)}
          tone={
            forecast.endingCash === null
              ? "warn"
              : forecast.endingCash < 0
                ? "neg"
                : "pos"
          }
        />
        <KeyStat
          label={`En Düşük Hafta (${forecast.worstWeekStart ?? "—"})`}
          value={fmt(forecast.worstClosingBalance)}
          tone={
            forecast.worstClosingBalance === null
              ? "warn"
              : forecast.worstClosingBalance < (forecast.minCashFloor ?? 0)
                ? "neg"
                : "pos"
          }
          sub={
            forecast.minCashFloor !== null
              ? `Politika Tabanı: ${formatMoney(forecast.minCashFloor, currency)}`
              : "Politika tabanı: 0,00"
          }
        />
      </div>

      {/* Zero Today-Cliff Banner: Overdue Unscheduled Receivables */}
      {forecast.overdueUnscheduledCount > 0 ? (
        <div className="rounded border border-amber-700/70 bg-amber-950/40 px-3.5 py-2.5 text-xs text-amber-200">
          <div className="font-semibold">
            Takvime Bağlanmamış Gecikmiş Alacak Uyarısı ({forecast.overdueUnscheduledCount} fatura ·{" "}
            {formatMoney(forecast.overdueUnscheduledAmount, currency)})
          </div>
          <p className="mt-0.5 text-amber-300/90">
            Vadesi geçmiş ve aktif ödeme sözü (`promise_to_pay`) bulunmayan bu alacaklar, 1. haftada sahte nakit
            bolluğu yaratmamak için 13 haftalık nakit girişine <strong>dahil edilmemiştir</strong>. Tahsilat
            tarihi netleştiğinde ödeme sözü girerek haftalık projeksiyona dahil edebilirsiniz.
          </p>
        </div>
      ) : null}

      {/* Controls Bar: Refresh + Freeze Snapshot + Manual Override */}
      <Panel
        title="13 Haftalık Tahmin Kontrolleri"
        subtitle="Açık kayıtlardan yeniden hesapla, Pazartesi anlık görüntüsünü dondur veya manuel CFO düzeltme satırı ekle"
      >
        <div className="flex flex-wrap items-end gap-3">
          <form action={refreshAutoSeeded13WeekAction} className="flex flex-wrap items-end gap-2">
            <input type="hidden" name="currency" value={currency} />
            <label className="text-xs text-slate-300">
              Tahsilat Davranış Modu
              <select
                name="dbtMode"
                defaultValue={dbtMode}
                className="mt-1 block rounded border border-slate-700 bg-slate-900 px-2.5 py-1.5 text-xs text-slate-100"
              >
                <option value="median">Medyan DBT (P50)</option>
                <option value="p75">İhtiyatlı DBT (P75)</option>
              </select>
            </label>
            <button
              type="submit"
              className="rounded border border-sky-600 bg-sky-900/60 px-3 py-1.5 text-xs font-medium text-sky-100 hover:bg-sky-800/70"
            >
              Açık Kayıtlardan Otomatik Yenile
            </button>
          </form>

          {canFreeze ? (
            <form action={freeze13WeekSnapshotAction} className="flex items-end gap-2">
              <input type="hidden" name="currency" value={currency} />
              <input type="hidden" name="dbtMode" value={dbtMode} />
              <input type="hidden" name="asOfDate" value={todayISO} />
              <button
                type="submit"
                className="rounded border border-emerald-600 bg-emerald-900/60 px-3 py-1.5 text-xs font-medium text-emerald-100 hover:bg-emerald-800/70"
              >
                Haftalık Tahmin Anlık Görüntüsünü Dondur ({forecast.snapshotWeekStart})
              </button>
            </form>
          ) : null}
        </div>

        {canAddOverride ? (
          <form
            action={addManual13WeekOverrideAction}
            className="mt-3 grid grid-cols-1 gap-2 border-t border-slate-800 pt-3 sm:grid-cols-5"
          >
            <input type="hidden" name="currency" value={currency} />
            <input type="hidden" name="dbtMode" value={dbtMode} />
            <label className="text-xs text-slate-300">
              Hafta Başlangıcı (Pazartesi)
              <select
                name="weekStart"
                defaultValue={forecast.snapshotWeekStart}
                className="mt-1 block w-full rounded border border-slate-700 bg-slate-900 px-2 py-1.5 text-xs text-slate-100"
              >
                {forecast.weeks.map((w) => (
                  <option key={w.weekStart} value={w.weekStart}>
                    H{w.weekIndex}: {w.weekStart} .. {w.weekEnd}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs text-slate-300">
              Yön
              <select
                name="direction"
                defaultValue="outflow"
                className="mt-1 block w-full rounded border border-slate-700 bg-slate-900 px-2 py-1.5 text-xs text-slate-100"
              >
                <option value="inflow">Giriş (+)</option>
                <option value="outflow">Çıkış (-)</option>
              </select>
            </label>
            <label className="text-xs text-slate-300">
              Tutar ({currency})
              <input
                type="number"
                step="0.01"
                min="0.01"
                name="amount"
                required
                placeholder="50000"
                className="mt-1 block w-full rounded border border-slate-700 bg-slate-900 px-2 py-1.5 text-xs text-slate-100"
              />
            </label>
            <label className="text-xs text-slate-300">
              Açıklama
              <input
                type="text"
                name="notes"
                required
                placeholder="Ek ekipman / tahsilat düzeltmesi"
                className="mt-1 block w-full rounded border border-slate-700 bg-slate-900 px-2 py-1.5 text-xs text-slate-100"
              />
            </label>
            <div className="flex items-end">
              <button
                type="submit"
                className="w-full rounded border border-slate-600 bg-slate-800 px-3 py-1.5 text-xs font-medium text-slate-100 hover:bg-slate-700"
              >
                Manuel Tahmin Satırı Ekle
              </button>
            </div>
          </form>
        ) : null}
      </Panel>

      {/* 13-Week Direct Rolling Matrix */}
      <Panel
        title={`13 Haftalık Nakit Akışı Matrisi (${currency})`}
        subtitle="Haftalık açılış → kaynak bazlı giriş/çıkış → net akış → kapanış → minimum nakit tamponu farkı"
      >
        <TableShell>
          <thead>
            <tr className="border-b border-slate-800 text-left text-[11px] uppercase tracking-wider text-slate-400">
              <th className="px-2 py-2">Hafta</th>
              <th className="px-2 py-2">Tarih Aralığı</th>
              <th className="px-2 py-2 text-right">Açılış</th>
              <th className="px-2 py-2 text-right">Alacak (AR)</th>
              <th className="px-2 py-2 text-right">Borç & Planlı</th>
              <th className="px-2 py-2 text-right">Çek & Kredi</th>
              <th className="px-2 py-2 text-right">Vergi/SGK & Manuel</th>
              <th className="px-2 py-2 text-right">Net Akış</th>
              <th className="px-2 py-2 text-right">Kapanış</th>
              <th className="px-2 py-2 text-right">Taban Farkı</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/70 text-xs">
            {forecast.weeks.map((w) => {
              const arIn = w.inflowByCategory.contracted_ar + w.inflowByCategory.behavioral_ar;
              const apOut = w.outflowByCategory.open_ap + w.outflowByCategory.scheduled_payment;
              const checkLoanNet =
                w.inflowByCategory.check_maturity -
                (w.outflowByCategory.check_maturity + w.outflowByCategory.loan_installment);
              const taxManualNet =
                w.inflowByCategory.manual_override -
                (w.outflowByCategory.statutory_tax_sgk + w.outflowByCategory.manual_override);

              return (
                <tr
                  key={w.weekIndex}
                  className={w.breachesFloor ? "bg-red-950/25" : undefined}
                >
                  <td className="px-2 py-2 font-semibold text-slate-200">H{w.weekIndex}</td>
                  <td className="px-2 py-2 text-slate-300">
                    {w.weekStart} → {w.weekEnd}
                    <span className="ml-1.5 text-[11px] text-slate-500">({w.lines.length} kayıt)</span>
                  </td>
                  <td className="px-2 py-2 text-right font-mono text-slate-300">
                    {fmt(w.openingBalance)}
                  </td>
                  <td className="px-2 py-2 text-right font-mono text-emerald-300">
                    +{formatMoney(arIn, currency)}
                  </td>
                  <td className="px-2 py-2 text-right font-mono text-rose-300">
                    -{formatMoney(apOut, currency)}
                  </td>
                  <td className="px-2 py-2 text-right font-mono text-slate-300">
                    {formatMoney(checkLoanNet, currency)}
                  </td>
                  <td className="px-2 py-2 text-right font-mono text-slate-300">
                    {formatMoney(taxManualNet, currency)}
                  </td>
                  <td
                    className={`px-2 py-2 text-right font-mono font-medium ${
                      w.netFlow >= 0 ? "text-emerald-300" : "text-rose-300"
                    }`}
                  >
                    {formatMoney(w.netFlow, currency)}
                  </td>
                  <td className="px-2 py-2 text-right font-mono font-semibold text-slate-100">
                    {fmt(w.closingBalance)}
                  </td>
                  <td className="px-2 py-2 text-right font-mono">
                    {w.floorHeadroom === null ? (
                      <Badge tone="amber">FIN-03</Badge>
                    ) : w.breachesFloor ? (
                      <Badge tone="red">{formatMoney(w.floorHeadroom, currency)}</Badge>
                    ) : (
                      <span className="text-emerald-300">
                        +{formatMoney(w.floorHeadroom, currency)}
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </TableShell>

        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {ALL_CATEGORIES.map((cat) => {
            const catIn = forecast.weeks.reduce((s, w) => s + w.inflowByCategory[cat], 0);
            const catOut = forecast.weeks.reduce((s, w) => s + w.outflowByCategory[cat], 0);
            return (
              <div
                key={cat}
                className="rounded border border-slate-800 bg-slate-900/50 px-2.5 py-2 text-xs"
              >
                <div className="font-medium text-slate-300">{CATEGORY_BUCKET_LABELS[cat]}</div>
                <div className="mt-1 flex items-center justify-between font-mono text-[11px]">
                  <span className="text-emerald-300">+{formatMoney(catIn, currency)}</span>
                  <span className="text-rose-300">-{formatMoney(catOut, currency)}</span>
                </div>
              </div>
            );
          })}
        </div>
      </Panel>

      {/* Timing Slip vs. Permanent Variance Waterfall Panel */}
      <Panel
        title="Tahmin vs. Gerçekleşen Varyans Şelalesi (Zamanlama Kayması vs. Kalıcı Sapma)"
        subtitle="Dondurulmuş haftalık tahmin anlık görüntüsünü gerçekleşen banka hareketleriyle (`own_transfer` hariç) kaynak kimliği üzerinden karşılaştırır"
      >
        {!selectedSnapshot || !waterfall ? (
          <EmptyState>
            Henüz dondurulmuş 13 haftalık tahmin anlık görüntüsü yok. Üstteki &ldquo;Haftalık Tahmin Anlık Görüntüsünü Dondur&rdquo; düğmesiyle Pazartesi baz çizgisini dondurduğunuzda Zamanlama Kayması vs. Kalıcı Sapma şelalesi burada hesaplanır.
          </EmptyState>
        ) : (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-300">
              <div>
                Anlık Görüntü Haftası: <strong>{selectedSnapshot.snapshotWeekStart}</strong> · İncelenen Hafta:{" "}
                <strong>
                  H{waterfall.weekIndex} ({waterfall.weekStart} → {waterfall.weekEnd})
                </strong>
              </div>
              <Badge tone={waterfall.identityBalanced ? "green" : "red"} dot>
                {waterfall.identityBalanced
                  ? "Şelale Özdeşliği Doğrulandı (0,00 fark)"
                  : `Şelale Farkı: ${formatMoney(waterfall.identityDiff, currency)}`}
              </Badge>
            </div>

            <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
              <KeyStat
                label="1. Dondurulmuş Tahmin Net"
                value={formatMoney(waterfall.forecastNet, currency)}
                tone="info"
                sub={`+${formatMoney(waterfall.forecastInflow, currency)} / -${formatMoney(waterfall.forecastOutflow, currency)}`}
              />
              <KeyStat
                label="2. Zamanlama Kayması (Timing Slip)"
                value={formatMoney(waterfall.timingSlipAmount, currency)}
                tone={waterfall.timingSlipAmount < 0 ? "warn" : "neutral"}
                sub="Kayıt hâlâ açık veya başka haftada kapandı"
              />
              <KeyStat
                label="3. Kalıcı Giriş Sapması"
                value={formatMoney(waterfall.permanentInflowVarianceAmount, currency)}
                tone={waterfall.permanentInflowVarianceAmount >= 0 ? "pos" : "neg"}
                sub="Plansız tahsilat veya tahsilat tutar farkı"
              />
              <KeyStat
                label="4. Kalıcı Çıkış Sapması"
                value={formatMoney(waterfall.permanentOutflowVarianceAmount, currency)}
                tone={waterfall.permanentOutflowVarianceAmount >= 0 ? "pos" : "neg"}
                sub="Bütçe dışı ödeme veya ödeme tutar farkı"
              />
              <KeyStat
                label="5. Gerçekleşen Banka Net"
                value={formatMoney(waterfall.actualBankNetMovement, currency)}
                tone={waterfall.actualBankNetMovement >= 0 ? "pos" : "neg"}
                sub={`+${formatMoney(waterfall.actualBankInflow, currency)} / -${formatMoney(waterfall.actualBankOutflow, currency)}`}
              />
            </div>

            {waterfall.details.length > 0 ? (
              <TableShell>
                <thead>
                  <tr className="border-b border-slate-800 text-left text-[11px] uppercase tracking-wider text-slate-400">
                    <th className="px-2 py-2">Kalem</th>
                    <th className="px-2 py-2">Sınıflandırma</th>
                    <th className="px-2 py-2 text-right">Tahmin (Net)</th>
                    <th className="px-2 py-2 text-right">Gerçekleşen</th>
                    <th className="px-2 py-2 text-right">Zamanlama Kayması</th>
                    <th className="px-2 py-2 text-right">Kalıcı Sapma</th>
                    <th className="px-2 py-2">Açıklama</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/70 text-xs">
                  {waterfall.details.map((d, idx) => {
                    const permTotal =
                      d.permanentInflowVarianceSigned + d.permanentOutflowVarianceSigned;
                    return (
                      <tr key={`${d.sourceEntityId ?? d.bankTransactionId ?? idx}-${idx}`}>
                        <td className="px-2 py-2 font-medium text-slate-200">{d.label}</td>
                        <td className="px-2 py-2">
                          <Badge
                            tone={
                              d.kind === "matched_settled"
                                ? "green"
                                : d.kind === "timing_slip"
                                  ? "amber"
                                  : "red"
                            }
                          >
                            {d.kind === "matched_settled"
                              ? "Gerçekleşti"
                              : d.kind === "timing_slip"
                                ? "Zamanlama Kayması"
                                : d.kind === "unplanned_bank_movement"
                                  ? "Plansız Banka Hareketi"
                                  : "Kalıcı İptal/Fark"}
                          </Badge>
                        </td>
                        <td className="px-2 py-2 text-right font-mono text-slate-300">
                          {formatMoney(d.forecastSignedAmount, currency)}
                        </td>
                        <td className="px-2 py-2 text-right font-mono text-slate-200">
                          {formatMoney(d.actualSignedAmount, currency)}
                        </td>
                        <td className="px-2 py-2 text-right font-mono text-amber-300">
                          {formatMoney(d.timingSlipSignedAmount, currency)}
                        </td>
                        <td className="px-2 py-2 text-right font-mono text-rose-300">
                          {formatMoney(permTotal, currency)}
                        </td>
                        <td className="px-2 py-2 text-slate-400">{d.explanation}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </TableShell>
            ) : null}
          </div>
        )}
      </Panel>
    </div>
  );
}
