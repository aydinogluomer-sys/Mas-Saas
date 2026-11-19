import Link from "@/components/ui/app-link";
import { WaterfallChart } from "@/components/charts/advanced-charts";
import { Badge } from "@/components/ui/badge";
import { Panel } from "@/components/ui/panel";
import { EmptyState, KeyStat, PageHeader, TableShell } from "@/components/ui/shell";
import { SubmitButton } from "@/components/ui/submit-button";
import { waterfallModel } from "@/lib/analytics/chart-types";
import { getRequestUser } from "@/lib/auth";
import { can } from "@/lib/authz/matrix";
import { requireRouteAccess } from "@/lib/authz/route-guard";
import {
  ALL_CATEGORIES,
  buildAutoSeeded13WeekForecast,
  buildConsolidated13WeekForecast,
  CATEGORY_BUCKET_LABELS,
  compute13wVarianceWaterfall,
  listFrozen13wSnapshots,
  load13wOperationalInputs,
} from "@/lib/cashflow/rolling-13w-engine";
import { getPool } from "@/lib/db";
import { decimal, intOrNull, money, moneyOrNull } from "@/lib/money";
import { formatMoney } from "@/lib/money-format";
import {
  addManual13WeekOverrideAction,
  freeze13WeekSnapshotAction,
  recordCorporateCardStatementAction,
  recordPayrollTaxAccrualAction,
  recordPosSettlementBatchAction,
  refreshAutoSeeded13WeekAction,
} from "./actions";

export const dynamic = "force-dynamic";

const CURRENCY_TABS = [
  { key: "TRY", label: "TRY" },
  { key: "USD", label: "USD" },
  { key: "EUR", label: "EUR" },
  { key: "CONSOLIDATED", label: "Konsolide TRY" },
] as const;

type CurrencyTabKey = (typeof CURRENCY_TABS)[number]["key"];

const OBLIGATION_LABELS: Record<string, string> = {
  NET_MAAS: "Net Maaş",
  MPHB_STOPAJ: "MPHB Stopaj (26'sı)",
  SGK_4A: "SGK 4/A Prim (Ay Sonu)",
  DAMGA_VERGISI: "Damga Vergisi",
  KURUMLAR_GECICI_VERGI: "Kurumlar Geçici Vergi",
};

const INPUT_STYLE = {
  background: "var(--surface-1)",
  borderColor: "var(--line)",
  color: "var(--text-1)",
} as const;

const CARD_STYLE = {
  background: "var(--surface-2)",
  borderColor: "var(--line)",
  color: "var(--text-1)",
} as const;

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
  const currencyTab: CurrencyTabKey = CURRENCY_TABS.some((t) => t.key === rawCurrency)
    ? (rawCurrency as CurrencyTabKey)
    : "TRY";
  const isConsolidated = currencyTab === "CONSOLIDATED";
  const displayCurrency: "TRY" | "USD" | "EUR" = isConsolidated ? "TRY" : currencyTab;
  const dbtMode = sp.dbtMode === "p75" ? "p75" : "median";

  const session = await getRequestUser();
  const canFreeze = session ? can(session.role, "forecast_snapshot_13w_lines", "delete") : false;
  const canAddOverride = session ? can(session.role, "forecast_lines", "insert") : false;
  const canEnterTax = session ? can(session.role, "payroll_tax_accruals", "insert") : false;
  const canEnterPos = session ? can(session.role, "pos_settlement_batches", "insert") : false;
  const canEnterCard = session ? can(session.role, "corporate_card_statements", "insert") : false;

  const pool = getPool();
  const todayISO = istanbulDateISO();
  const currentYm = todayISO.slice(0, 7);

  const [forecastOrCons, snapshots, ops] = await Promise.all([
    isConsolidated
      ? buildConsolidated13WeekForecast(pool, { asOfDate: todayISO, dbtMode })
      : buildAutoSeeded13WeekForecast(pool, {
          asOfDate: todayISO,
          currency: displayCurrency,
          dbtMode,
        }).then((forecast) => ({
          forecast,
          fxRatesUsed: {} as Record<string, { rate: number; rateDate: string }>,
          unconvertibleFx: [] as Array<{
            currency: string;
            openingCash: number | null;
            totalInflow: number;
            totalOutflow: number;
            unknownOpeningCount: number;
          }>,
        })),
    listFrozen13wSnapshots(pool, displayCurrency, 12),
    load13wOperationalInputs(pool),
  ]);

  const { forecast, fxRatesUsed, unconvertibleFx } = forecastOrCons;

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
        pool
          .query<{
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
          )
          .catch(() => ({ rows: [] })),
      ])
    : [null, null];

  const frozenVarianceRows = (varianceViewRes?.rows ?? []).map((r) => ({
    snapshotId: r.snapshot_id,
    snapshotWeekStart: r.snapshot_week_start,
    asOfDate: r.as_of_date,
    currency: r.currency || displayCurrency,
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
    val === null ? "Bilinmiyor (FIN-03)" : formatMoney(val, displayCurrency);

  // Sum category totals with exact decimal arithmetic for 13W Liquidity Bridge Waterfall
  const sumCat = (side: "inflowByCategory" | "outflowByCategory", cat: (typeof ALL_CATEGORIES)[number]) =>
    money(
      forecast.weeks
        .reduce((acc, w) => acc.plus(decimal(w[side][cat])), decimal(0))
        .toString(),
    );

  const arAndPosInflow = money(
    decimal(sumCat("inflowByCategory", "contracted_ar"))
      .plus(decimal(sumCat("inflowByCategory", "behavioral_ar")))
      .toString(),
  );
  const apScheduledCardOutflow = money(
    decimal(sumCat("outflowByCategory", "open_ap"))
      .plus(decimal(sumCat("outflowByCategory", "scheduled_payment")))
      .toString(),
  );
  const checkAndLoanNet = money(
    decimal(sumCat("inflowByCategory", "check_maturity"))
      .minus(decimal(sumCat("outflowByCategory", "check_maturity")))
      .minus(decimal(sumCat("outflowByCategory", "loan_installment")))
      .toString(),
  );
  const taxAndManualNet = money(
    decimal(sumCat("inflowByCategory", "manual_override"))
      .minus(decimal(sumCat("outflowByCategory", "statutory_tax_sgk")))
      .minus(decimal(sumCat("outflowByCategory", "manual_override")))
      .toString(),
  );

  const liquidityBridgeModel =
    forecast.openingCash !== null && forecast.endingCash !== null
      ? waterfallModel({
          title: `13 Haftalık Nakit Köprüsü (${isConsolidated ? "Konsolide TRY" : displayCurrency})`,
          description:
            "Açılış kasa/banka bakiyesinden 13. hafta sonu kapanış nakdine geçiş (Alacak & POS, Borç & Kurumsal Kart, Çek & Kredi, Vergi/SGK/Bordro)",
          format: "currency",
          asOf: forecast.asOfDate,
          sourceLabel: "13 Haftalık Doğrudan Likidite Motoru",
          unknownCount: forecast.unknownOpeningCount,
          steps: [
            { key: "opening", label: "Açılış Kasa", value: forecast.openingCash, kind: "start" },
            {
              key: "ar_pos",
              label: "Alacak & POS (+)",
              value: arAndPosInflow,
              kind: "increase",
            },
            {
              key: "ap_card",
              label: "Borç, Planlı & Kart (-)",
              value: -apScheduledCardOutflow,
              kind: "decrease",
            },
            {
              key: "check_loan",
              label: "Çek & Kredi (Net)",
              value: checkAndLoanNet,
              kind: checkAndLoanNet >= 0 ? "increase" : "decrease",
            },
            {
              key: "tax_manual",
              label: "Vergi/SGK & Manuel",
              value: taxAndManualNet,
              kind: taxAndManualNet >= 0 ? "increase" : "decrease",
            },
            { key: "closing", label: "13.H Kapanış", value: forecast.endingCash, kind: "end" },
          ],
        })
      : null;

  const varianceWaterfallChartModel = waterfall
    ? waterfallModel({
        title: `H${waterfall.weekIndex} Tahmin vs. Fiili Varyans Şelalesi (${waterfall.currency})`,
        description: `Dondurulmuş Pazartesi tahmini (${selectedSnapshot?.snapshotWeekStart ?? ""}) ile gerçekleşen banka hareketleri arasındaki Zamanlama Kayması vs. Kalıcı Sapma köprüsü`,
        format: "currency",
        asOf: waterfall.weekEnd,
        sourceLabel: "forecast_snapshots_13w × bank_transactions",
        steps: [
          { key: "fc_net", label: "1. Tahmin Net", value: waterfall.forecastNet, kind: "start" },
          {
            key: "timing_slip",
            label: "2. Zamanlama Kayması",
            value: waterfall.timingSlipAmount,
            kind: waterfall.timingSlipAmount >= 0 ? "increase" : "decrease",
          },
          {
            key: "perm_in",
            label: "3. Kalıcı Giriş Farkı",
            value: waterfall.permanentInflowVarianceAmount,
            kind: waterfall.permanentInflowVarianceAmount >= 0 ? "increase" : "decrease",
          },
          {
            key: "perm_out",
            label: "4. Kalıcı Çıkış Farkı",
            value: waterfall.permanentOutflowVarianceAmount,
            kind: waterfall.permanentOutflowVarianceAmount >= 0 ? "increase" : "decrease",
          },
          {
            key: "actual_net",
            label: "5. Fiili Banka Net",
            value: waterfall.actualBankNetMovement,
            kind: "end",
          },
        ],
      })
    : null;

  return (
    <div className="space-y-4">
      <PageHeader
        title="13 Haftalık Doğrudan Nakit Tahmini & Varyans Şelalesi"
        subtitle="Açık alacaklar (V2 DBT), POS valör blokajları, tedarikçi faturaları, kurumsal kart ekstreleri, çek/kredi vadeleri, 190 Devreden KDV mahsuplu GİB/SGK ve bordro tahakkuklarından beslenen 13 haftalık nakit ufku"
        meta={
          <div className="flex flex-wrap items-center gap-2">
            {CURRENCY_TABS.map((tab) => (
              <Link
                key={tab.key}
                href={`/cashflow/13-week?currency=${tab.key}&dbtMode=${dbtMode}`}
                className="rounded border px-2.5 py-1 text-xs font-medium"
                style={{
                  background: currencyTab === tab.key ? "var(--surface-2)" : "var(--surface-1)",
                  borderColor: currencyTab === tab.key ? "var(--info)" : "var(--line)",
                  color: currencyTab === tab.key ? "var(--info)" : "var(--text-2)",
                }}
              >
                {tab.label}
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
        <div className="rounded border border-neg/40 bg-neg/10 px-3 py-2 text-xs text-neg">
          {sp.error}
        </div>
      ) : null}
      {sp.result ? (
        <div className="rounded border border-pos/40 bg-pos/10 px-3 py-2 text-xs text-pos">
          İşlem tamamlandı: {sp.result}
        </div>
      ) : null}

      {/* Consolidated FX Status & Unconvertible FX Guardrail */}
      {isConsolidated ? (
        <div
          className="rounded border px-3.5 py-2.5 text-xs"
          style={{
            background: unconvertibleFx.length > 0 ? "var(--surface-2)" : "var(--surface-1)",
            borderColor: unconvertibleFx.length > 0 ? "var(--warn)" : "var(--line)",
            color: "var(--text-1)",
          }}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-semibold">
              Konsolide TRY Karşılığı Görünümü (`fx_rate_snapshots`)
            </span>
            <div className="flex flex-wrap items-center gap-1.5 font-mono text-[11px]">
              {Object.entries(fxRatesUsed).length > 0 ? (
                Object.entries(fxRatesUsed).map(([cur, r]) => (
                  <Badge key={cur} tone="blue">
                    1 {cur} = {r.rate.toFixed(4)} TRY ({r.rateDate})
                  </Badge>
                ))
              ) : (
                <span style={{ color: "var(--text-2)" }}>Aktif döviz kuru dönüşümü gerekmedi</span>
              )}
            </div>
          </div>
          {unconvertibleFx.length > 0 ? (
            <p className="mt-1.5 text-warn">
              <strong>Dönüştürülemeyen Döviz Uyarısı (`unconvertible_fx`):</strong>{" "}
              {unconvertibleFx
                .map(
                  (u) =>
                    `${u.currency} (Giriş: +${formatMoney(u.totalInflow, u.currency)}, Çıkış: -${formatMoney(u.totalOutflow, u.currency)})`,
                )
                .join(" · ")}{" "}
              için `fx_rate_snapshots` tablosunda güncel TCMB kuru bulunamadı; 1:1 varsayım yapılmamış ve konsolide TRY toplamına sessizce katılmamıştır.
            </p>
          ) : null}
        </div>
      ) : null}

      {/* Top KPI Summary */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        <KeyStat
          label={`Açılış Kasa/Banka (${isConsolidated ? "Konsolide TRY" : displayCurrency})`}
          value={fmt(forecast.openingCash)}
          tone={forecast.openingCash === null ? "warn" : "info"}
          sub={
            forecast.unknownOpeningCount > 0
              ? `${forecast.unknownOpeningCount} aktif hesapta açılış bakiyesi NULL`
              : `Referans: ${forecast.asOfDate}`
          }
        />
        <KeyStat
          label={`13H Toplam Giriş (${displayCurrency})`}
          value={formatMoney(forecast.totalInflow, displayCurrency)}
          tone="pos"
          sub={
            (forecast.posBatchInflowTotal ?? 0) > 0
              ? `POS Valör Dahil: +${formatMoney(forecast.posBatchInflowTotal ?? 0, displayCurrency)}`
              : `Mod: ${dbtMode === "p75" ? "İhtiyatlı (P75 DBT)" : "Standart (Medyan DBT)"}`
          }
        />
        <KeyStat
          label={`13H Toplam Çıkış (${displayCurrency})`}
          value={formatMoney(forecast.totalOutflow, displayCurrency)}
          tone="neg"
          sub={
            (forecast.vatCarryforward190Applied ?? 0) > 0
              ? `190 KDV Mahsubu: -${formatMoney(forecast.vatCarryforward190Applied ?? 0, "TRY")}`
              : `${forecast.statutoryDeadlines.length} yasal vergi/SGK günü`
          }
        />
        <KeyStat
          label={`13. Hafta Sonu Kapanış (${displayCurrency})`}
          value={fmt(forecast.endingCash)}
          tone={
            forecast.endingCash === null
              ? "warn"
              : forecast.endingCash < 0
                ? "neg"
                : "pos"
          }
          sub={
            (forecast.corporateCardOutflowTotal ?? 0) > 0
              ? `Kart Ekstresi: -${formatMoney(forecast.corporateCardOutflowTotal ?? 0, displayCurrency)}`
              : undefined
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
              ? `Politika Tabanı: ${formatMoney(forecast.minCashFloor, displayCurrency)}`
              : "Politika tabanı: 0,00"
          }
        />
      </div>

      {/* Statutory VAT Carryforward (190) + POS Valor + Card + Payroll Summary Strip */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <div className="rounded border px-3 py-2 text-xs" style={CARD_STYLE}>
          <div style={{ color: "var(--text-2)" }}>190 Devreden KDV Mahsubu</div>
          <div className="mt-0.5 font-mono text-sm font-semibold text-pos">
            {formatMoney(forecast.vatCarryforward190Applied ?? 0, "TRY")}
          </div>
          <div className="text-[11px]" style={{ color: "var(--text-3)" }}>
            Açılış 190 Bakiyesi: {formatMoney(forecast.vatCarryforward190Opening ?? 0, "TRY")}
          </div>
        </div>
        <div className="rounded border px-3 py-2 text-xs" style={CARD_STYLE}>
          <div style={{ color: "var(--text-2)" }}>Bekleyen POS Valör Girişi</div>
          <div className="mt-0.5 font-mono text-sm font-semibold text-pos">
            +{formatMoney(forecast.posBatchInflowTotal ?? 0, displayCurrency)}
          </div>
          <div className="text-[11px]" style={{ color: "var(--text-3)" }}>
            {ops.posBatches.length} açık POS partisi
          </div>
        </div>
        <div className="rounded border px-3 py-2 text-xs" style={CARD_STYLE}>
          <div style={{ color: "var(--text-2)" }}>Kurumsal Kart Ekstre Çıkışı</div>
          <div className="mt-0.5 font-mono text-sm font-semibold text-neg">
            -{formatMoney(forecast.corporateCardOutflowTotal ?? 0, displayCurrency)}
          </div>
          <div className="text-[11px]" style={{ color: "var(--text-3)" }}>
            {ops.cardStatements.length} açık kart ekstresi
          </div>
        </div>
        <div className="rounded border px-3 py-2 text-xs" style={CARD_STYLE}>
          <div style={{ color: "var(--text-2)" }}>Bordro / MPHB / SGK Tahakkuku</div>
          <div className="mt-0.5 font-mono text-sm font-semibold text-neg">
            -{formatMoney(forecast.payrollTaxAccrualOutflowTotal ?? 0, displayCurrency)}
          </div>
          <div className="text-[11px]" style={{ color: "var(--text-3)" }}>
            {ops.payrollTaxAccruals.length} açık tahakkuk
          </div>
        </div>
      </div>

      {/* Zero Today-Cliff Banner: Overdue Unscheduled Receivables */}
      {forecast.overdueUnscheduledCount > 0 ? (
        <div className="rounded border border-warn/40 bg-warn/10 px-3.5 py-2.5 text-xs" style={{ color: "var(--text-1)" }}>
          <div className="font-semibold text-warn">
            Takvime Bağlanmamış Gecikmiş Alacak Uyarısı ({forecast.overdueUnscheduledCount} fatura ·{" "}
            {formatMoney(forecast.overdueUnscheduledAmount, displayCurrency)})
          </div>
          <p className="mt-0.5" style={{ color: "var(--text-2)" }}>
            Vadesi geçmiş ve aktif ödeme sözü (`promise_to_pay`) bulunmayan bu alacaklar, 1. haftada sahte nakit
            bolluğu yaratmamak için 13 haftalık nakit girişine <strong>dahil edilmemiştir</strong>. Tahsilat
            tarihi netleştiğinde ödeme sözü girerek haftalık projeksiyona dahil edebilirsiniz.
          </p>
        </div>
      ) : null}

      {/* 13W Liquidity Bridge Waterfall Chart */}
      {liquidityBridgeModel ? (
        <Panel
          title="13 Haftalık Nakit Köprüsü Şelalesi (Waterfall)"
          subtitle="Açılış kasasından 13. hafta sonu kapanış nakdine kategori bazlı kümülatif geçiş"
        >
          <WaterfallChart model={liquidityBridgeModel} exportKey="nakit_koprusu_13h" />
        </Panel>
      ) : null}

      {/* Controls Bar: Refresh + Freeze Snapshot + Manual Override */}
      <Panel
        title="13 Haftalık Tahmin Kontrolleri"
        subtitle="Açık kayıtlardan yeniden hesapla, Pazartesi anlık görüntüsünü dondur veya manuel CFO düzeltme satırı ekle"
      >
        <div className="flex flex-wrap items-end gap-3">
          <form action={refreshAutoSeeded13WeekAction} className="flex flex-wrap items-end gap-2">
            <input type="hidden" name="currency" value={currencyTab} />
            <label className="text-xs" style={{ color: "var(--text-2)" }}>
              Tahsilat Davranış Modu
              <select
                name="dbtMode"
                defaultValue={dbtMode}
                className="mt-1 block rounded border px-2.5 py-1.5 text-xs"
                style={INPUT_STYLE}
              >
                <option value="median">Medyan DBT (P50)</option>
                <option value="p75">İhtiyatlı DBT (P75)</option>
              </select>
            </label>
            <SubmitButton
              pendingLabel="Yenileniyor…"
              className="button-accent rounded px-3 py-1.5 text-xs font-medium disabled:opacity-60"
            >
              Açık Kayıtlardan Otomatik Yenile
            </SubmitButton>
          </form>

          {canFreeze ? (
            <form action={freeze13WeekSnapshotAction} className="flex items-end gap-2">
              <input type="hidden" name="currency" value={currencyTab} />
              <input type="hidden" name="entityCurrency" value={displayCurrency} />
              <input type="hidden" name="dbtMode" value={dbtMode} />
              <input type="hidden" name="asOfDate" value={todayISO} />
              <SubmitButton
                pendingLabel="Donduruluyor…"
                className="rounded border px-3 py-1.5 text-xs font-medium disabled:opacity-60"
                style={CARD_STYLE}
              >
                Haftalık Tahmin Anlık Görüntüsünü Dondur ({displayCurrency} · {forecast.snapshotWeekStart})
              </SubmitButton>
            </form>
          ) : null}
        </div>

        {canAddOverride ? (
          <form
            action={addManual13WeekOverrideAction}
            className="mt-3 grid grid-cols-1 gap-2 border-t pt-3 sm:grid-cols-5"
            style={{ borderColor: "var(--line)" }}
          >
            <input type="hidden" name="currency" value={currencyTab} />
            <input type="hidden" name="entityCurrency" value={displayCurrency} />
            <input type="hidden" name="dbtMode" value={dbtMode} />
            <label className="text-xs" style={{ color: "var(--text-2)" }}>
              Hafta Başlangıcı (Pazartesi)
              <select
                name="weekStart"
                defaultValue={forecast.snapshotWeekStart}
                className="mt-1 block w-full rounded border px-2 py-1.5 text-xs"
                style={INPUT_STYLE}
              >
                {forecast.weeks.map((w) => (
                  <option key={w.weekStart} value={w.weekStart}>
                    H{w.weekIndex}: {w.weekStart} .. {w.weekEnd}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs" style={{ color: "var(--text-2)" }}>
              Yön
              <select
                name="direction"
                defaultValue="outflow"
                className="mt-1 block w-full rounded border px-2 py-1.5 text-xs"
                style={INPUT_STYLE}
              >
                <option value="inflow">Giriş (+)</option>
                <option value="outflow">Çıkış (-)</option>
              </select>
            </label>
            <label className="text-xs" style={{ color: "var(--text-2)" }}>
              Tutar ({displayCurrency})
              <input
                type="number"
                step="0.01"
                min="0.01"
                name="amount"
                required
                placeholder="50000"
                className="mt-1 block w-full rounded border px-2 py-1.5 text-xs"
                style={INPUT_STYLE}
              />
            </label>
            <label className="text-xs" style={{ color: "var(--text-2)" }}>
              Açıklama
              <input
                type="text"
                name="notes"
                required
                placeholder="Ek ekipman / tahsilat düzeltmesi"
                className="mt-1 block w-full rounded border px-2 py-1.5 text-xs"
                style={INPUT_STYLE}
              />
            </label>
            <div className="flex items-end">
              <SubmitButton
                pendingLabel="Ekleniyor…"
                className="w-full rounded border px-3 py-1.5 text-xs font-medium hover:opacity-90 disabled:opacity-60"
                style={CARD_STYLE}
              >
                Manuel Tahmin Satırı Ekle
              </SubmitButton>
            </div>
          </form>
        ) : null}
      </Panel>

      {/* CFO Operational Inputs: Tax/SGK/Payroll Accruals, POS Valor & Corporate Cards */}
      {canEnterTax || canEnterPos || canEnterCard ? (
        <Panel
          title="Vergi/SGK Tahakkuku, POS Valör ve Kurumsal Kart Ekstresi Girişi"
          subtitle="MPHB (26'sı), SGK 4/A (ay sonu), personel maaşı, POS valör dönüşleri ve kredi kartı ekstre son ödeme tarihlerini doğrudan 13 haftalık projeksiyona işleyin"
        >
          <div className="grid gap-3 lg:grid-cols-3">
            {canEnterTax ? (
              <form action={recordPayrollTaxAccrualAction} className="space-y-2 rounded border p-3 text-xs" style={CARD_STYLE}>
                <div className="font-semibold" style={{ color: "var(--text-1)" }}>
                  1. Vergi / SGK / Bordro Tahakkuku
                </div>
                <input type="hidden" name="viewCurrency" value={currencyTab} />
                <input type="hidden" name="dbtMode" value={dbtMode} />
                <div className="grid grid-cols-2 gap-2">
                  <label style={{ color: "var(--text-2)" }}>
                    Dönem (YYYY-AA)
                    <input
                      type="month"
                      name="periodMonth"
                      defaultValue={currentYm}
                      required
                      className="mt-1 block w-full rounded border px-2 py-1"
                      style={INPUT_STYLE}
                    />
                  </label>
                  <label style={{ color: "var(--text-2)" }}>
                    Yükümlülük Türü
                    <select name="obligationKind" className="mt-1 block w-full rounded border px-2 py-1" style={INPUT_STYLE}>
                      <option value="MPHB_STOPAJ">MPHB Stopaj (26&apos;sı)</option>
                      <option value="SGK_4A">SGK 4/A Prim (Ay Sonu)</option>
                      <option value="NET_MAAS">Personel Net Maaş</option>
                      <option value="DAMGA_VERGISI">Damga Vergisi</option>
                      <option value="KURUMLAR_GECICI_VERGI">Kurumlar Geçici Vergi</option>
                    </select>
                  </label>
                  <label style={{ color: "var(--text-2)" }}>
                    Son Ödeme Tarihi
                    <input
                      type="date"
                      name="dueDate"
                      defaultValue={`${currentYm}-26`}
                      required
                      className="mt-1 block w-full rounded border px-2 py-1"
                      style={INPUT_STYLE}
                    />
                  </label>
                  <label style={{ color: "var(--text-2)" }}>
                    Tahakkuk Tutarı (TRY)
                    <input
                      type="number"
                      step="0.01"
                      min="0.01"
                      name="accruedAmount"
                      required
                      placeholder="185000"
                      className="mt-1 block w-full rounded border px-2 py-1"
                      style={INPUT_STYLE}
                    />
                  </label>
                </div>
                <input type="hidden" name="currency" value="TRY" />
                <input
                  type="text"
                  name="notes"
                  placeholder="Not (opsiyonel, ör. Merkez + Fabrika bordrosu)"
                  className="block w-full rounded border px-2 py-1"
                  style={INPUT_STYLE}
                />
                <SubmitButton pendingLabel="Kaydediliyor…" className="button-accent w-full rounded px-2.5 py-1.5 font-medium">
                  Tahakkuku Kaydet / Güncelle
                </SubmitButton>
              </form>
            ) : null}

            {canEnterPos ? (
              <form action={recordPosSettlementBatchAction} className="space-y-2 rounded border p-3 text-xs" style={CARD_STYLE}>
                <div className="font-semibold" style={{ color: "var(--text-1)" }}>
                  2. POS Valör Tahsilat Partisi
                </div>
                <input type="hidden" name="viewCurrency" value={currencyTab} />
                <input type="hidden" name="dbtMode" value={dbtMode} />
                <label className="block" style={{ color: "var(--text-2)" }}>
                  Geçeceği Banka Hesabı
                  <select
                    name="cashAccountId"
                    required
                    className="mt-1 block w-full rounded border px-2 py-1"
                    style={INPUT_STYLE}
                  >
                    {ops.accounts.length === 0 ? (
                      <option value="">Önce aktif kasa/banka hesabı tanımlayın</option>
                    ) : (
                      ops.accounts.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name} ({a.currency})
                        </option>
                      ))
                    )}
                  </select>
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <label style={{ color: "var(--text-2)" }}>
                    POS Etiketi
                    <input
                      type="text"
                      name="posTerminalLabel"
                      required
                      placeholder="Garanti Sanal POS"
                      className="mt-1 block w-full rounded border px-2 py-1"
                      style={INPUT_STYLE}
                    />
                  </label>
                  <label style={{ color: "var(--text-2)" }}>
                    Komisyon (%)
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      max="100"
                      name="commissionRatePct"
                      defaultValue="2.49"
                      className="mt-1 block w-full rounded border px-2 py-1"
                      style={INPUT_STYLE}
                    />
                  </label>
                  <label style={{ color: "var(--text-2)" }}>
                    Satış Tarihi
                    <input
                      type="date"
                      name="saleDate"
                      defaultValue={todayISO}
                      required
                      className="mt-1 block w-full rounded border px-2 py-1"
                      style={INPUT_STYLE}
                    />
                  </label>
                  <label style={{ color: "var(--text-2)" }}>
                    Valör (Hesaba Geçiş)
                    <input
                      type="date"
                      name="expectedValueDate"
                      defaultValue={todayISO}
                      required
                      className="mt-1 block w-full rounded border px-2 py-1"
                      style={INPUT_STYLE}
                    />
                  </label>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <input
                    type="number"
                    step="0.01"
                    min="0.01"
                    name="grossAmount"
                    required
                    placeholder="Brüt Tutar"
                    className="rounded border px-2 py-1"
                    style={INPUT_STYLE}
                  />
                  <select name="currency" defaultValue={displayCurrency} className="rounded border px-2 py-1" style={INPUT_STYLE}>
                    <option value="TRY">TRY</option>
                    <option value="USD">USD</option>
                    <option value="EUR">EUR</option>
                  </select>
                </div>
                <SubmitButton
                  pendingLabel="Kaydediliyor…"
                  disabled={ops.accounts.length === 0}
                  className="button-accent w-full rounded px-2.5 py-1.5 font-medium disabled:opacity-50"
                >
                  POS Valör Partisini Ekle
                </SubmitButton>
              </form>
            ) : null}

            {canEnterCard ? (
              <form action={recordCorporateCardStatementAction} className="space-y-2 rounded border p-3 text-xs" style={CARD_STYLE}>
                <div className="font-semibold" style={{ color: "var(--text-1)" }}>
                  3. Kurumsal Kart Ekstresi
                </div>
                <input type="hidden" name="viewCurrency" value={currencyTab} />
                <input type="hidden" name="dbtMode" value={dbtMode} />
                <label className="block" style={{ color: "var(--text-2)" }}>
                  Kart / Banka Hesabı
                  <select
                    name="cardAccountId"
                    required
                    className="mt-1 block w-full rounded border px-2 py-1"
                    style={INPUT_STYLE}
                  >
                    {ops.accounts.length === 0 ? (
                      <option value="">Önce aktif hesap tanımlayın</option>
                    ) : (
                      ops.accounts.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name} ({a.currency})
                        </option>
                      ))
                    )}
                  </select>
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <label style={{ color: "var(--text-2)" }}>
                    Ekstre Dönemi
                    <input
                      type="month"
                      name="statementMonth"
                      defaultValue={currentYm}
                      required
                      className="mt-1 block w-full rounded border px-2 py-1"
                      style={INPUT_STYLE}
                    />
                  </label>
                  <label style={{ color: "var(--text-2)" }}>
                    Hesap Kesim
                    <input
                      type="date"
                      name="cutoffDate"
                      defaultValue={todayISO}
                      required
                      className="mt-1 block w-full rounded border px-2 py-1"
                      style={INPUT_STYLE}
                    />
                  </label>
                  <label style={{ color: "var(--text-2)" }}>
                    Son Ödeme Tarihi
                    <input
                      type="date"
                      name="dueDate"
                      defaultValue={todayISO}
                      required
                      className="mt-1 block w-full rounded border px-2 py-1"
                      style={INPUT_STYLE}
                    />
                  </label>
                  <label style={{ color: "var(--text-2)" }}>
                    Ekstre Tutarı
                    <input
                      type="number"
                      step="0.01"
                      min="0.01"
                      name="statementAmount"
                      required
                      placeholder="75000"
                      className="mt-1 block w-full rounded border px-2 py-1"
                      style={INPUT_STYLE}
                    />
                  </label>
                </div>
                <select name="currency" defaultValue={displayCurrency} className="block w-full rounded border px-2 py-1" style={INPUT_STYLE}>
                  <option value="TRY">TRY</option>
                  <option value="USD">USD</option>
                  <option value="EUR">EUR</option>
                </select>
                <SubmitButton
                  pendingLabel="Kaydediliyor…"
                  disabled={ops.accounts.length === 0}
                  className="button-accent w-full rounded px-2.5 py-1.5 font-medium disabled:opacity-50"
                >
                  Kart Ekstresini Kaydet
                </SubmitButton>
              </form>
            ) : null}
          </div>

          {ops.payrollTaxAccruals.length > 0 || ops.posBatches.length > 0 || ops.cardStatements.length > 0 ? (
            <div className="mt-3 grid gap-3 border-t pt-3 lg:grid-cols-3" style={{ borderColor: "var(--line)" }}>
              <div className="text-xs">
                <div className="mb-1 font-medium" style={{ color: "var(--text-2)" }}>
                  Açık Vergi / SGK / Bordro ({ops.payrollTaxAccruals.length})
                </div>
                {ops.payrollTaxAccruals.length === 0 ? (
                  <p style={{ color: "var(--text-3)" }}>Kayıt yok.</p>
                ) : (
                  <ul className="space-y-1">
                    {ops.payrollTaxAccruals.slice(0, 5).map((r) => (
                      <li key={r.id} className="flex items-center justify-between rounded border px-2 py-1" style={INPUT_STYLE}>
                        <span>
                          {OBLIGATION_LABELS[r.obligationKind] ?? r.obligationKind} · {r.dueDate}
                        </span>
                        <span className="font-mono text-neg">
                          -{formatMoney(r.accruedAmount - r.paidAmount, r.currency)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div className="text-xs">
                <div className="mb-1 font-medium" style={{ color: "var(--text-2)" }}>
                  Bekleyen POS Valör ({ops.posBatches.length})
                </div>
                {ops.posBatches.length === 0 ? (
                  <p style={{ color: "var(--text-3)" }}>Kayıt yok.</p>
                ) : (
                  <ul className="space-y-1">
                    {ops.posBatches.slice(0, 5).map((r) => (
                      <li key={r.id} className="flex items-center justify-between rounded border px-2 py-1" style={INPUT_STYLE}>
                        <span>
                          {r.posTerminalLabel} · {r.expectedValueDate}
                        </span>
                        <span className="font-mono text-pos">
                          +{formatMoney(r.netSettlementAmount, r.currency)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div className="text-xs">
                <div className="mb-1 font-medium" style={{ color: "var(--text-2)" }}>
                  Açık Kurumsal Kart ({ops.cardStatements.length})
                </div>
                {ops.cardStatements.length === 0 ? (
                  <p style={{ color: "var(--text-3)" }}>Kayıt yok.</p>
                ) : (
                  <ul className="space-y-1">
                    {ops.cardStatements.slice(0, 5).map((r) => (
                      <li key={r.id} className="flex items-center justify-between rounded border px-2 py-1" style={INPUT_STYLE}>
                        <span>
                          {r.cardName ?? "Kart"} · Son Öd: {r.dueDate}
                        </span>
                        <span className="font-mono text-neg">
                          -{formatMoney(r.statementAmount - r.paidAmount, r.currency)}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          ) : null}
        </Panel>
      ) : null}

      {/* 13-Week Direct Rolling Matrix */}
      <Panel
        title={`13 Haftalık Nakit Akışı Matrisi (${isConsolidated ? "Konsolide TRY" : displayCurrency})`}
        subtitle="Haftalık açılış → kaynak bazlı giriş/çıkış → net akış → kapanış → minimum nakit tamponu farkı"
      >
        <TableShell>
          <table className="w-full text-xs">
            <thead>
              <tr
                className="border-b text-left text-[11px] uppercase tracking-wider"
                style={{ borderColor: "var(--line)", color: "var(--text-2)" }}
              >
                <th className="px-2 py-2">Hafta</th>
                <th className="px-2 py-2">Tarih Aralığı</th>
                <th className="px-2 py-2 text-right">Açılış</th>
                <th className="px-2 py-2 text-right">Alacak &amp; POS</th>
                <th className="px-2 py-2 text-right">Borç, Planlı &amp; Kart</th>
                <th className="px-2 py-2 text-right">Çek &amp; Kredi</th>
                <th className="px-2 py-2 text-right">Vergi/SGK &amp; Manuel</th>
                <th className="px-2 py-2 text-right">Net Akış</th>
                <th className="px-2 py-2 text-right">Kapanış</th>
                <th className="px-2 py-2 text-right">Taban Farkı</th>
              </tr>
            </thead>
            <tbody className="divide-y text-xs" style={{ borderColor: "var(--line)" }}>
              {forecast.weeks.map((w) => {
                const arIn = money(
                  decimal(w.inflowByCategory.contracted_ar)
                    .plus(decimal(w.inflowByCategory.behavioral_ar))
                    .toString(),
                );
                const apOut = money(
                  decimal(w.outflowByCategory.open_ap)
                    .plus(decimal(w.outflowByCategory.scheduled_payment))
                    .toString(),
                );
                const checkLoanNet = money(
                  decimal(w.inflowByCategory.check_maturity)
                    .minus(decimal(w.outflowByCategory.check_maturity))
                    .minus(decimal(w.outflowByCategory.loan_installment))
                    .toString(),
                );
                const taxManualNet = money(
                  decimal(w.inflowByCategory.manual_override)
                    .minus(decimal(w.outflowByCategory.statutory_tax_sgk))
                    .minus(decimal(w.outflowByCategory.manual_override))
                    .toString(),
                );

                return (
                  <tr
                    key={w.weekIndex}
                    className={w.breachesFloor ? "bg-neg/10" : undefined}
                  >
                    <td className="px-2 py-2 font-semibold" style={{ color: "var(--text-1)" }}>
                      H{w.weekIndex}
                    </td>
                    <td className="px-2 py-2" style={{ color: "var(--text-2)" }}>
                      {w.weekStart} → {w.weekEnd}
                      <span className="ml-1.5 text-[11px]" style={{ color: "var(--text-3)" }}>
                        ({w.lines.length} kayıt)
                      </span>
                    </td>
                    <td className="px-2 py-2 text-right font-mono" style={{ color: "var(--text-1)" }}>
                      {fmt(w.openingBalance)}
                    </td>
                    <td className="px-2 py-2 text-right font-mono text-pos">
                      +{formatMoney(arIn, displayCurrency)}
                    </td>
                    <td className="px-2 py-2 text-right font-mono text-neg">
                      -{formatMoney(apOut, displayCurrency)}
                    </td>
                    <td className="px-2 py-2 text-right font-mono" style={{ color: "var(--text-2)" }}>
                      {formatMoney(checkLoanNet, displayCurrency)}
                    </td>
                    <td className="px-2 py-2 text-right font-mono" style={{ color: "var(--text-2)" }}>
                      {formatMoney(taxManualNet, displayCurrency)}
                    </td>
                    <td
                      className={`px-2 py-2 text-right font-mono font-medium ${
                        w.netFlow >= 0 ? "text-pos" : "text-neg"
                      }`}
                    >
                      {formatMoney(w.netFlow, displayCurrency)}
                    </td>
                    <td className="px-2 py-2 text-right font-mono font-semibold" style={{ color: "var(--text-1)" }}>
                      {fmt(w.closingBalance)}
                    </td>
                    <td className="px-2 py-2 text-right font-mono">
                      {w.floorHeadroom === null ? (
                        <Badge tone="amber">FIN-03</Badge>
                      ) : w.breachesFloor ? (
                        <Badge tone="red">{formatMoney(w.floorHeadroom, displayCurrency)}</Badge>
                      ) : (
                        <span className="text-pos">
                          +{formatMoney(w.floorHeadroom, displayCurrency)}
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
            const catIn = sumCat("inflowByCategory", cat);
            const catOut = sumCat("outflowByCategory", cat);
            return (
              <div
                key={cat}
                className="rounded border px-2.5 py-2 text-xs"
                style={CARD_STYLE}
              >
                <div className="font-medium" style={{ color: "var(--text-1)" }}>
                  {CATEGORY_BUCKET_LABELS[cat]}
                </div>
                <div className="mt-1 flex items-center justify-between font-mono text-[11px]">
                  <span className="text-pos">+{formatMoney(catIn, displayCurrency)}</span>
                  <span className="text-neg">-{formatMoney(catOut, displayCurrency)}</span>
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
                    href={`/cashflow/13-week?currency=${currencyTab}&dbtMode=${dbtMode}&snapshotId=${snap.id}`}
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
                          href={`/cashflow/13-week?currency=${currencyTab}&dbtMode=${dbtMode}&snapshotId=${v.snapshotId}&weekStart=${v.weekStart}`}
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
          <div className="space-y-4">
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs" style={{ color: "var(--text-2)" }}>
              <div>
                Anlık Görüntü Haftası: <strong style={{ color: "var(--text-1)" }}>{selectedSnapshot.snapshotWeekStart}</strong> · İncelenen Hafta:{" "}
                <strong style={{ color: "var(--text-1)" }}>
                  H{waterfall.weekIndex} ({waterfall.weekStart} → {waterfall.weekEnd})
                </strong>
              </div>
              <Badge tone={waterfall.identityBalanced ? "green" : "red"} dot>
                {waterfall.identityBalanced
                  ? "Şelale Özdeşliği Doğrulandı (0,00 fark)"
                  : `Şelale Farkı: ${formatMoney(waterfall.identityDiff, waterfall.currency)}`}
              </Badge>
            </div>

            {varianceWaterfallChartModel ? (
              <WaterfallChart
                model={varianceWaterfallChartModel}
                exportKey={`varyans_selalesi_h${waterfall.weekIndex}`}
              />
            ) : null}

            <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
              <KeyStat
                label="1. Dondurulmuş Tahmin Net"
                value={formatMoney(waterfall.forecastNet, waterfall.currency)}
                tone="info"
                sub={`+${formatMoney(waterfall.forecastInflow, waterfall.currency)} / -${formatMoney(waterfall.forecastOutflow, waterfall.currency)}`}
              />
              <KeyStat
                label="2. Zamanlama Kayması (Timing Slip)"
                value={formatMoney(waterfall.timingSlipAmount, waterfall.currency)}
                tone={waterfall.timingSlipAmount < 0 ? "warn" : "neutral"}
                sub="Kayıt hâlâ açık veya başka haftada kapandı"
              />
              <KeyStat
                label="3. Kalıcı Giriş Sapması"
                value={formatMoney(waterfall.permanentInflowVarianceAmount, waterfall.currency)}
                tone={waterfall.permanentInflowVarianceAmount >= 0 ? "pos" : "neg"}
                sub="Plansız tahsilat veya tahsilat tutar farkı"
              />
              <KeyStat
                label="4. Kalıcı Çıkış Sapması"
                value={formatMoney(waterfall.permanentOutflowVarianceAmount, waterfall.currency)}
                tone={waterfall.permanentOutflowVarianceAmount >= 0 ? "pos" : "neg"}
                sub="Bütçe dışı ödeme veya ödeme tutar farkı"
              />
              <KeyStat
                label="5. Gerçekleşen Banka Net"
                value={formatMoney(waterfall.actualBankNetMovement, waterfall.currency)}
                tone={waterfall.actualBankNetMovement >= 0 ? "pos" : "neg"}
                sub={`+${formatMoney(waterfall.actualBankInflow, waterfall.currency)} / -${formatMoney(waterfall.actualBankOutflow, waterfall.currency)}`}
              />
            </div>

            {waterfall.details.length > 0 ? (
              <TableShell>
                <table className="w-full text-xs">
                  <thead>
                    <tr
                      className="border-b text-left text-[11px] uppercase tracking-wider"
                      style={{ borderColor: "var(--line)", color: "var(--text-2)" }}
                    >
                      <th className="px-2 py-2">Kalem</th>
                      <th className="px-2 py-2">Sınıflandırma</th>
                      <th className="px-2 py-2 text-right">Tahmin (Net)</th>
                      <th className="px-2 py-2 text-right">Gerçekleşen</th>
                      <th className="px-2 py-2 text-right">Zamanlama Kayması</th>
                      <th className="px-2 py-2 text-right">Kalıcı Sapma</th>
                      <th className="px-2 py-2">Açıklama</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y text-xs" style={{ borderColor: "var(--line)" }}>
                    {waterfall.details.map((d, idx) => {
                      const permTotal = money(
                        decimal(d.permanentInflowVarianceSigned)
                          .plus(decimal(d.permanentOutflowVarianceSigned))
                          .toString(),
                      );
                      return (
                        <tr key={`${d.sourceEntityId ?? d.bankTransactionId ?? idx}-${idx}`}>
                          <td className="px-2 py-2 font-medium" style={{ color: "var(--text-1)" }}>
                            {d.label}
                          </td>
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
                          <td className="px-2 py-2 text-right font-mono" style={{ color: "var(--text-2)" }}>
                            {formatMoney(d.forecastSignedAmount, waterfall.currency)}
                          </td>
                          <td className="px-2 py-2 text-right font-mono" style={{ color: "var(--text-1)" }}>
                            {formatMoney(d.actualSignedAmount, waterfall.currency)}
                          </td>
                          <td className="px-2 py-2 text-right font-mono text-warn">
                            {formatMoney(d.timingSlipSignedAmount, waterfall.currency)}
                          </td>
                          <td className="px-2 py-2 text-right font-mono text-neg">
                            {formatMoney(permTotal, waterfall.currency)}
                          </td>
                          <td className="px-2 py-2" style={{ color: "var(--text-2)" }}>
                            {d.explanation}
                          </td>
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
