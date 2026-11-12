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
import { SubmitButton } from "@/components/ui/submit-button";
import { getPool } from "@/lib/db";
import { intOrNull, moneyOrNull } from "@/lib/money";
import { formatMoney } from "@/lib/money-format";
import {
  addManual13WeekOverrideAction,
  freeze13WeekSnapshotAction,
  refreshAutoSeeded13WeekAction,
} from "./actions";

export const dynamic = "force-dynamic";

const CURRENCIES = ["TRY", "USD", "EUR"] as const;

function istanbulDateISO(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Istanbul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

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
  const todayISO = istanbulDateISO();

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

  const [waterfall, varianceViewRes] = selectedSnapshot
    ? await Promise.all([
        compute13wVarianceWaterfall(pool, {
          snapshotId: selectedSnapshot.id,
          weekStart: selectedWeekStart,
        }),
        pool.query<{
          snapshot_id: string;
          snapshot_week_start: string;
          as_of_date: string;
          currency: string;
          opening_cash: string | null;
          unknown_opening_count: number;
          week_index: number;
          week_start: string;
          week_end: string;
          forecast_inflow: string;
          forecast_outflow: string;
          forecast_net: string;
          forecast_line_count: number;
          actual_inflow: string;
          actual_outflow: string;
          actual_net: string;
          net_variance: string;
        }>(
          `select snapshot_id::text,
                  to_char(snapshot_week_start, 'YYYY-MM-DD') as snapshot_week_start,
                  to_char(as_of_date, 'YYYY-MM-DD') as as_of_date,
                  currency,
                  opening_cash::text,
                  unknown_opening_count,
                  week_index,
                  to_char(week_start, 'YYYY-MM-DD') as week_start,
                  to_char(week_end, 'YYYY-MM-DD') as week_end,
                  forecast_inflow::text,
                  forecast_outflow::text,
                  forecast_net::text,
                  forecast_line_count,
                  actual_inflow::text,
                  actual_outflow::text,
                  actual_net::text,
                  net_variance::text
             from public.forecast_13w_variance_v
            where snapshot_id = $1::uuid
            order by week_index asc`,
          [selectedSnapshot.id],
        ),
      ])
    : [null, null];

  const frozenVarianceRows = (varianceViewRes?.rows ?? []).map((r) => ({
    snapshotId: r.snapshot_id,
    snapshotWeekStart: r.snapshot_week_start,
    asOfDate: r.as_of_date,
    currency: r.currency || currency,
    openingCash: moneyOrNull(r.opening_cash),
    unknownOpeningCount: intOrNull(r.unknown_opening_count) ?? 0,
    weekIndex: intOrNull(r.week_index) ?? 0,
    weekStart: r.week_start,
    weekEnd: r.week_end,
    forecastInflow: moneyOrNull(r.forecast_inflow) ?? 0,
    forecastOutflow: moneyOrNull(r.forecast_outflow) ?? 0,
    forecastNet: moneyOrNull(r.forecast_net) ?? 0,
    forecastLineCount: intOrNull(r.forecast_line_count) ?? 0,
    actualInflow: moneyOrNull(r.actual_inflow) ?? 0,
    actualOutflow: moneyOrNull(r.actual_outflow) ?? 0,
    actualNet: moneyOrNull(r.actual_net) ?? 0,
    netVariance: moneyOrNull(r.net_variance) ?? 0,
  }));

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
                    ? "border-sky-600 bg-sky-50 text-sky-900"
                    : "border-[var(--line)] bg-[var(--surface-1)] text-[var(--text-2)] hover:text-[var(--text-1)]"
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
        <div className="rounded border border-red-300 bg-red-50 px-3 py-2 text-xs text-red-800">
          {sp.error}
        </div>
      ) : null}
      {sp.result ? (
        <div className="rounded border border-emerald-300 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
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
        <div className="rounded border border-amber-300 bg-amber-50 px-3.5 py-2.5 text-xs text-amber-900">
          <div className="font-semibold">
            Takvime Bağlanmamış Gecikmiş Alacak Uyarısı ({forecast.overdueUnscheduledCount} fatura ·{" "}
            {formatMoney(forecast.overdueUnscheduledAmount, currency)})
          </div>
          <p className="mt-0.5 text-amber-800">
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
            <label className="text-xs text-[var(--text-2)]">
              Tahsilat Davranış Modu
              <select
                name="dbtMode"
                defaultValue={dbtMode}
                className="mt-1 block rounded border border-[var(--line)] bg-[var(--surface-1)] px-2.5 py-1.5 text-xs text-[var(--text-1)]"
              >
                <option value="median">Medyan DBT (P50)</option>
                <option value="p75">İhtiyatlı DBT (P75)</option>
              </select>
            </label>
            <SubmitButton
              pendingLabel="Yenileniyor…"
              className="rounded bg-sky-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-sky-800 disabled:opacity-60"
            >
              Açık Kayıtlardan Otomatik Yenile
            </SubmitButton>
          </form>

          {canFreeze ? (
            <form action={freeze13WeekSnapshotAction} className="flex items-end gap-2">
              <input type="hidden" name="currency" value={currency} />
              <input type="hidden" name="dbtMode" value={dbtMode} />
              <input type="hidden" name="asOfDate" value={todayISO} />
              <SubmitButton
                pendingLabel="Donduruluyor…"
                className="rounded bg-emerald-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-800 disabled:opacity-60"
              >
                Haftalık Tahmin Anlık Görüntüsünü Dondur ({forecast.snapshotWeekStart})
              </SubmitButton>
            </form>
          ) : null}
        </div>

        {canAddOverride ? (
          <form
            action={addManual13WeekOverrideAction}
            className="mt-3 grid grid-cols-1 gap-2 border-t border-[var(--line)] pt-3 sm:grid-cols-5"
          >
            <input type="hidden" name="currency" value={currency} />
            <input type="hidden" name="dbtMode" value={dbtMode} />
            <label className="text-xs text-[var(--text-2)]">
              Hafta Başlangıcı (Pazartesi)
              <select
                name="weekStart"
                defaultValue={forecast.snapshotWeekStart}
                className="mt-1 block w-full rounded border border-[var(--line)] bg-[var(--surface-1)] px-2 py-1.5 text-xs text-[var(--text-1)]"
              >
                {forecast.weeks.map((w) => (
                  <option key={w.weekStart} value={w.weekStart}>
                    H{w.weekIndex}: {w.weekStart} .. {w.weekEnd}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs text-[var(--text-2)]">
              Yön
              <select
                name="direction"
                defaultValue="outflow"
                className="mt-1 block w-full rounded border border-[var(--line)] bg-[var(--surface-1)] px-2 py-1.5 text-xs text-[var(--text-1)]"
              >
                <option value="inflow">Giriş (+)</option>
                <option value="outflow">Çıkış (-)</option>
              </select>
            </label>
            <label className="text-xs text-[var(--text-2)]">
              Tutar ({currency})
              <input
                type="number"
                step="0.01"
                min="0.01"
                name="amount"
                required
                placeholder="50000"
                className="mt-1 block w-full rounded border border-[var(--line)] bg-[var(--surface-1)] px-2 py-1.5 text-xs text-[var(--text-1)]"
              />
            </label>
            <label className="text-xs text-[var(--text-2)]">
              Açıklama
              <input
                type="text"
                name="notes"
                required
                placeholder="Ek ekipman / tahsilat düzeltmesi"
                className="mt-1 block w-full rounded border border-[var(--line)] bg-[var(--surface-1)] px-2 py-1.5 text-xs text-[var(--text-1)]"
              />
            </label>
            <div className="flex items-end">
              <SubmitButton
                pendingLabel="Ekleniyor…"
                className="w-full rounded border border-[var(--line)] bg-[var(--surface-2)] px-3 py-1.5 text-xs font-medium text-[var(--text-1)] hover:opacity-90 disabled:opacity-60"
              >
                Manuel Tahmin Satırı Ekle
              </SubmitButton>
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
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-[var(--line)] text-left text-[11px] uppercase tracking-wider text-[var(--text-2)]">
                <th className="px-2 py-2">Hafta</th>
                <th className="px-2 py-2">Tarih Aralığı</th>
                <th className="px-2 py-2 text-right">Açılış</th>
                <th className="px-2 py-2 text-right">Alacak (AR)</th>
                <th className="px-2 py-2 text-right">Borç &amp; Planlı</th>
                <th className="px-2 py-2 text-right">Çek &amp; Kredi</th>
                <th className="px-2 py-2 text-right">Vergi/SGK &amp; Manuel</th>
                <th className="px-2 py-2 text-right">Net Akış</th>
                <th className="px-2 py-2 text-right">Kapanış</th>
                <th className="px-2 py-2 text-right">Taban Farkı</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--line)] text-xs">
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
                    className={w.breachesFloor ? "bg-red-50/80" : undefined}
                  >
                    <td className="px-2 py-2 font-semibold text-[var(--text-1)]">H{w.weekIndex}</td>
                    <td className="px-2 py-2 text-[var(--text-2)]">
                      {w.weekStart} → {w.weekEnd}
                      <span className="ml-1.5 text-[11px] text-[var(--text-3)]">({w.lines.length} kayıt)</span>
                    </td>
                    <td className="px-2 py-2 text-right font-mono text-[var(--text-1)]">
                      {fmt(w.openingBalance)}
                    </td>
                    <td className="px-2 py-2 text-right font-mono text-emerald-700">
                      +{formatMoney(arIn, currency)}
                    </td>
                    <td className="px-2 py-2 text-right font-mono text-red-700">
                      -{formatMoney(apOut, currency)}
                    </td>
                    <td className="px-2 py-2 text-right font-mono text-[var(--text-2)]">
                      {formatMoney(checkLoanNet, currency)}
                    </td>
                    <td className="px-2 py-2 text-right font-mono text-[var(--text-2)]">
                      {formatMoney(taxManualNet, currency)}
                    </td>
                    <td
                      className={`px-2 py-2 text-right font-mono font-medium ${
                        w.netFlow >= 0 ? "text-emerald-700" : "text-red-700"
                      }`}
                    >
                      {formatMoney(w.netFlow, currency)}
                    </td>
                    <td className="px-2 py-2 text-right font-mono font-semibold text-[var(--text-1)]">
                      {fmt(w.closingBalance)}
                    </td>
                    <td className="px-2 py-2 text-right font-mono">
                      {w.floorHeadroom === null ? (
                        <Badge tone="amber">FIN-03</Badge>
                      ) : w.breachesFloor ? (
                        <Badge tone="red">{formatMoney(w.floorHeadroom, currency)}</Badge>
                      ) : (
                        <span className="text-emerald-700">
                          +{formatMoney(w.floorHeadroom, currency)}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </TableShell>

        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
          {ALL_CATEGORIES.map((cat) => {
            const catIn = forecast.weeks.reduce((s, w) => s + w.inflowByCategory[cat], 0);
            const catOut = forecast.weeks.reduce((s, w) => s + w.outflowByCategory[cat], 0);
            return (
              <div
                key={cat}
                className="rounded border border-[var(--line)] bg-[var(--surface-2)] px-2.5 py-2 text-xs"
              >
                <div className="font-medium text-[var(--text-1)]">{CATEGORY_BUCKET_LABELS[cat]}</div>
                <div className="mt-1 flex items-center justify-between font-mono text-[11px]">
                  <span className="text-emerald-700">+{formatMoney(catIn, currency)}</span>
                  <span className="text-red-700">-{formatMoney(catOut, currency)}</span>
                </div>
              </div>
            );
          })}
        </div>
      </Panel>

      {/* Frozen Forecast vs Actual Variance View (forecast_13w_variance_v) */}
      <Panel
        title="Dondurulmuş Tahmin vs. Fiili Sapma"
        subtitle="Dondurulmuş 13 haftalık anlık görüntünün tüm haftalarında tahmin edilen giriş/çıkış ile gerçekleşen banka hareketlerinin (`own_transfer` hariç) karşılaştırması"
        right={
          snapshots.length > 1 ? (
            <div className="flex flex-wrap items-center gap-1 text-xs">
              {snapshots.slice(0, 4).map((snap) => {
                const active = selectedSnapshot?.id === snap.id;
                return (
                  <Link
                    key={snap.id}
                    href={`/cashflow/13-week?currency=${currency}&dbtMode=${dbtMode}&snapshotId=${snap.id}`}
                    className="rounded border px-2 py-0.5 font-mono text-[11px]"
                    style={{
                      background: active ? "var(--surface-2)" : "var(--surface-1)",
                      borderColor: "var(--line)",
                      color: active ? "var(--text-1)" : "var(--text-2)",
                      fontWeight: active ? 600 : 400,
                    }}
                  >
                    {snap.snapshotWeekStart}
                  </Link>
                );
              })}
            </div>
          ) : undefined
        }
      >
        {!selectedSnapshot || frozenVarianceRows.length === 0 ? (
          <EmptyState>
            Henüz dondurulmuş 13 haftalık anlık görüntü bulunmuyor. Pazartesi tahminini dondurduğunuzda 13 haftalık tahmini vs. fiili sapma tablosu burada listelenir.
          </EmptyState>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr
                  className="border-b text-left text-[11px] uppercase tracking-wider"
                  style={{ borderColor: "var(--line)", color: "var(--text-2)" }}
                >
                  <th className="px-2 py-2">Hafta</th>
                  <th className="px-2 py-2">Tarih Aralığı</th>
                  <th className="px-2 py-2 text-right">Tahmin Giriş</th>
                  <th className="px-2 py-2 text-right">Tahmin Çıkış</th>
                  <th className="px-2 py-2 text-right">Tahmin Net</th>
                  <th className="px-2 py-2 text-right">Fiili Giriş</th>
                  <th className="px-2 py-2 text-right">Fiili Çıkış</th>
                  <th className="px-2 py-2 text-right">Fiili Net</th>
                  <th className="px-2 py-2 text-right">Net Sapma</th>
                  <th className="px-2 py-2 text-right">Şelale</th>
                </tr>
              </thead>
              <tbody>
                {frozenVarianceRows.map((v) => {
                  const isSelectedWeek = v.weekStart === selectedWeekStart;
                  return (
                    <tr
                      key={`${v.snapshotId}-${v.weekIndex}`}
                      className="border-t"
                      style={{
                        borderColor: "var(--line)",
                        background: isSelectedWeek ? "var(--surface-2)" : "var(--surface-1)",
                        color: "var(--text-1)",
                      }}
                    >
                      <td className="px-2 py-2 font-mono font-semibold">H{v.weekIndex}</td>
                      <td className="px-2 py-2 font-mono" style={{ color: "var(--text-2)" }}>
                        {v.weekStart} → {v.weekEnd}
                        <span className="ml-1 text-[10px]">({v.forecastLineCount} satır)</span>
                      </td>
                      <td className="px-2 py-2 text-right font-mono tabular-nums text-pos">
                        +{formatMoney(v.forecastInflow, v.currency)}
                      </td>
                      <td className="px-2 py-2 text-right font-mono tabular-nums text-neg">
                        -{formatMoney(v.forecastOutflow, v.currency)}
                      </td>
                      <td className="px-2 py-2 text-right font-mono tabular-nums">
                        {formatMoney(v.forecastNet, v.currency)}
                      </td>
                      <td className="px-2 py-2 text-right font-mono tabular-nums text-pos">
                        +{formatMoney(v.actualInflow, v.currency)}
                      </td>
                      <td className="px-2 py-2 text-right font-mono tabular-nums text-neg">
                        -{formatMoney(v.actualOutflow, v.currency)}
                      </td>
                      <td className="px-2 py-2 text-right font-mono tabular-nums">
                        {formatMoney(v.actualNet, v.currency)}
                      </td>
                      <td
                        className={`px-2 py-2 text-right font-mono font-semibold tabular-nums ${
                          v.netVariance < 0 ? "text-neg" : v.netVariance > 0 ? "text-pos" : ""
                        }`}
                      >
                        {v.netVariance > 0 ? "+" : ""}
                        {formatMoney(v.netVariance, v.currency)}
                      </td>
                      <td className="px-2 py-2 text-right font-mono">
                        <Link
                          href={`/cashflow/13-week?currency=${currency}&dbtMode=${dbtMode}&snapshotId=${v.snapshotId}&weekStart=${v.weekStart}`}
                          className="hover:underline"
                          style={{ color: "var(--text-2)" }}
                        >
                          {isSelectedWeek ? "Seçili" : "İncele →"}
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
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
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-[var(--text-2)]">
              <div>
                Anlık Görüntü Haftası: <strong className="text-[var(--text-1)]">{selectedSnapshot.snapshotWeekStart}</strong> · İncelenen Hafta:{" "}
                <strong className="text-[var(--text-1)]">
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
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-[var(--line)] text-left text-[11px] uppercase tracking-wider text-[var(--text-2)]">
                      <th className="px-2 py-2">Kalem</th>
                      <th className="px-2 py-2">Sınıflandırma</th>
                      <th className="px-2 py-2 text-right">Tahmin (Net)</th>
                      <th className="px-2 py-2 text-right">Gerçekleşen</th>
                      <th className="px-2 py-2 text-right">Zamanlama Kayması</th>
                      <th className="px-2 py-2 text-right">Kalıcı Sapma</th>
                      <th className="px-2 py-2">Açıklama</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[var(--line)] text-xs">
                    {waterfall.details.map((d, idx) => {
                      const permTotal =
                        d.permanentInflowVarianceSigned + d.permanentOutflowVarianceSigned;
                      return (
                        <tr key={`${d.sourceEntityId ?? d.bankTransactionId ?? idx}-${idx}`}>
                          <td className="px-2 py-2 font-medium text-[var(--text-1)]">{d.label}</td>
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
                          <td className="px-2 py-2 text-right font-mono text-[var(--text-2)]">
                            {formatMoney(d.forecastSignedAmount, currency)}
                          </td>
                          <td className="px-2 py-2 text-right font-mono text-[var(--text-1)]">
                            {formatMoney(d.actualSignedAmount, currency)}
                          </td>
                          <td className="px-2 py-2 text-right font-mono text-amber-700">
                            {formatMoney(d.timingSlipSignedAmount, currency)}
                          </td>
                          <td className="px-2 py-2 text-right font-mono text-red-700">
                            {formatMoney(permTotal, currency)}
                          </td>
                          <td className="px-2 py-2 text-[var(--text-2)]">{d.explanation}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </TableShell>
            ) : null}
          </div>
        )}
      </Panel>
    </div>
  );
}
