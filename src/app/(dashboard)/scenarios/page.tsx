import Link from "@/components/ui/app-link";
import {
  CashflowWaterfallSvg,
  ScenarioFanComparisonSvg,
  type ScenarioFanPoint,
  type WaterfallStep,
} from "@/components/charts/editorial-cockpit-charts";
import { requireRouteAccess } from "@/lib/authz/route-guard";
import { Badge } from "@/components/ui/badge";
import { Panel, fmtTL } from "@/components/ui/panel";
import { EmptyState, KeyStat, KpiCard, PageHeader, TableShell } from "@/components/ui/shell";
import { loadCashMonths } from "@/lib/cashflow/engine";
import { getPool } from "@/lib/db";
import { decimal, money } from "@/lib/money";
import { buildProjection } from "@/lib/radar/rules";
import { istanbulDateISO } from "@/lib/reports/rules";
import {
  loadAndSolveBreakevenLevers,
  type GoalSeekHorizon,
} from "@/lib/scenarios/breakeven-goalseek";
import { loadScenarioExternalBaseline } from "@/lib/scenarios/engine";
import {
  formatNativeFx,
  formatTcmbRate,
  loadFxStressOverlay,
  type NaturalHedgeStatus,
} from "@/lib/scenarios/fx-stress";
import { applyScenario, compareScenarioToBaseline } from "@/lib/scenarios/rules";
import { runScenarioAction, runUnifiedScenarioAction } from "./actions";

export const dynamic = "force-dynamic";

function signedFmtTL(n: number | null | undefined): string {
  if (n == null) return "TUTAR EKSİK";
  return n > 0 ? `+${fmtTL(n)}` : fmtTL(n);
}

function renderHedgeBadge(status: NaturalHedgeStatus, ratio: number | null) {
  if (status === "unknown_cash_opening") {
    return <Badge tone="amber">Açılış Eksik (FIN-03)</Badge>;
  }
  if (status === "no_liability") {
    return <Badge tone="blue">Döviz Borcu Yok</Badge>;
  }
  const pctText = ratio == null ? "" : ` (%${(ratio * 100).toFixed(0)})`;
  if (status === "naturally_hedged") {
    return <Badge tone="green">{`Doğal Hedgeli${pctText}`}</Badge>;
  }
  if (status === "partial_hedge") {
    return <Badge tone="amber">{`Kısmi Hedge${pctText}`}</Badge>;
  }
  return <Badge tone="red">{`Açık Döviz Riski${pctText}`}</Badge>;
}

const presets = [
  { n: "Gelir %10 düşerse", r: "-10", e: "" },
  { n: "Gider %10 artarsa", r: "", e: "10" },
  { n: "Gelir %10 artarsa", r: "10", e: "" },
];

export default async function NewScenarioPage({
  searchParams,
}: {
  searchParams?: Promise<{ horizon?: string }>;
}) {
  const denied = await requireRouteAccess("/scenarios");
  if (denied) return denied;

  const sp = (await searchParams) ?? {};
  const horizon: GoalSeekHorizon =
    sp.horizon === "14d" || sp.horizon === "12m" ? sp.horizon : "13w";
  const today = istanbulDateISO();
  const pool = getPool();

  const [months, goalSeek, fxStress, externalBaseline] = await Promise.all([
    loadCashMonths(pool),
    loadAndSolveBreakevenLevers(pool, {
      horizon,
      asOfDate: today,
      currency: "TRY",
    }),
    loadFxStressOverlay(pool, { asOfDate: today }),
    loadScenarioExternalBaseline(pool),
  ]);

  const band10 = fxStress.shockBands.find((b) => b.shockPct === 10) ?? fxStress.shockBands[0];
  const band20 = fxStress.shockBands.find((b) => b.shockPct === 20) ?? fxStress.shockBands[1];
  const band30 = fxStress.shockBands.find((b) => b.shockPct === 30) ?? fxStress.shockBands[2];

  // Deterministic Baz vs İyimser (+%10/-%10) vs Stres (-%10/+%10) comparison using @/lib/money decimal (R10: null never coerced to 0)
  const baseProjection = months.length > 0 ? buildProjection(months) : null;
  const referenceStressMonths =
    months.length > 0 ? applyScenario(months, { revenuePct: -0.1, expensePct: 0.1 }) : [];
  const referenceOptimisticMonths =
    months.length > 0 ? applyScenario(months, { revenuePct: 0.1, expensePct: -0.1 }) : [];
  const referenceRevOnlyMonths =
    months.length > 0 ? applyScenario(months, { revenuePct: -0.1, expensePct: 0 }) : [];

  const referenceStressComparison =
    referenceStressMonths.length > 0 ? compareScenarioToBaseline(referenceStressMonths) : null;
  const referenceOptimisticComparison =
    referenceOptimisticMonths.length > 0
      ? compareScenarioToBaseline(referenceOptimisticMonths)
      : null;
  const referenceRevOnlyComparison =
    referenceRevOnlyMonths.length > 0 ? compareScenarioToBaseline(referenceRevOnlyMonths) : null;

  const monthlyFanPoints: ScenarioFanPoint[] = referenceStressMonths.flatMap((m, idx) => {
    if (m.baselineClosing == null || m.scenarioClosing == null) return [];
    const optMonth = referenceOptimisticMonths[idx];
    return [
      {
        label: m.monthStart.slice(0, 7),
        baseValue: m.baselineClosing,
        stressValue: m.scenarioClosing,
        optimisticValue: optMonth?.scenarioClosing ?? undefined,
      },
    ];
  });

  const arPoolTry = goalSeek.levers.collectionDsoAcceleration.totalEligibleFutureReceivables;
  const expPoolTry = goalSeek.levers.discretionaryExpenseCut.discretionaryPoolAmount;
  const liveFxDownside10 =
    fxStress.status === "ok" &&
    band10?.netWorthShockDeltaTry != null &&
    band10.netWorthShockDeltaTry < 0
      ? band10.netWorthShockDeltaTry
      : 0;

  let fanPoints: ScenarioFanPoint[] = monthlyFanPoints;
  if (
    fanPoints.length === 0 &&
    goalSeek.openingCash != null &&
    goalSeek.worstProjectedCash != null
  ) {
    const openVal = goalSeek.openingCash;
    const endBase = goalSeek.worstProjectedCash;
    const revDeltaNeg10 = money(decimal(arPoolTry).times(-0.1));
    const expDeltaPos10 = money(decimal(expPoolTry).times(-0.1));
    const totalDownside = money(
      decimal(revDeltaNeg10).plus(expDeltaPos10).plus(liveFxDownside10),
    );
    const totalUpside = money(
      decimal(arPoolTry).times(0.1).plus(decimal(expPoolTry).times(0.1)),
    );

    const midBase = money(decimal(openVal).plus(endBase).div(2));
    const midStress = money(decimal(midBase).plus(decimal(totalDownside).div(2)));
    const midOpt = money(decimal(midBase).plus(decimal(totalUpside).div(2)));

    const endStress = money(decimal(endBase).plus(totalDownside));
    const endOpt = money(decimal(endBase).plus(totalUpside));

    fanPoints = [
      {
        label: goalSeek.asOfDate.slice(5),
        baseValue: openVal,
        stressValue: openVal,
        optimisticValue: openVal,
      },
      {
        label: "Orta Ufuk",
        baseValue: midBase,
        stressValue: midStress,
        optimisticValue: midOpt,
      },
      {
        label: (goalSeek.worstDate ?? goalSeek.horizonEndDate).slice(5),
        baseValue: endBase,
        stressValue: endStress,
        optimisticValue: endOpt,
      },
    ];
  }

  let baseLowPoint: number | null = null;
  let scenarioLowPoint: number | null = null;
  let optimisticLowPoint: number | null = null;
  let waterfallSteps: WaterfallStep[] = [];

  if (months.length > 0) {
    baseLowPoint = baseProjection?.worstBalance ?? null;
    scenarioLowPoint = referenceStressComparison?.worstBalance ?? null;
    optimisticLowPoint = referenceOptimisticComparison?.worstBalance ?? null;

    if (baseLowPoint != null && scenarioLowPoint != null) {
      const revShockStep =
        referenceRevOnlyComparison?.worstBalance != null
          ? money(decimal(referenceRevOnlyComparison.worstBalance).minus(baseLowPoint))
          : money(decimal(scenarioLowPoint).minus(baseLowPoint));
      const expShockStep = money(
        decimal(scenarioLowPoint).minus(baseLowPoint).minus(revShockStep),
      );
      waterfallSteps = [
        {
          key: "step-base-low",
          label: "Baz En Düşük Nakit",
          amount: baseLowPoint,
          formattedAmount: fmtTL(baseLowPoint),
          isTotal: true,
          tone: baseLowPoint < 0 ? "neg" : "info",
        },
        {
          key: "step-rev-shock",
          label: "Gelir Şoku (-%10)",
          amount: revShockStep,
          formattedAmount: signedFmtTL(revShockStep),
          tone: revShockStep < 0 ? "neg" : "pos",
        },
        {
          key: "step-exp-shock",
          label: "Gider Şoku (+%10)",
          amount: expShockStep,
          formattedAmount: signedFmtTL(expShockStep),
          tone: expShockStep < 0 ? "warn" : "pos",
        },
        {
          key: "step-stress-low",
          label: "Stres Dip Noktası",
          amount: scenarioLowPoint,
          formattedAmount: fmtTL(scenarioLowPoint),
          isTotal: true,
          tone: scenarioLowPoint < 0 ? "neg" : "pos",
        },
      ];
    }
  } else if (goalSeek.worstProjectedCash != null) {
    baseLowPoint = goalSeek.worstProjectedCash;
    const revShockStep = money(decimal(arPoolTry).times(-0.1));
    const expAndFxStep = money(decimal(expPoolTry).times(-0.1).plus(liveFxDownside10));
    scenarioLowPoint = money(
      decimal(baseLowPoint).plus(revShockStep).plus(expAndFxStep),
    );
    optimisticLowPoint = money(
      decimal(baseLowPoint)
        .plus(decimal(arPoolTry).times(0.1))
        .plus(decimal(expPoolTry).times(0.1)),
    );
    waterfallSteps = [
      {
        key: "step-base-low",
        label: "Baz En Düşük Nakit",
        amount: baseLowPoint,
        formattedAmount: fmtTL(baseLowPoint),
        isTotal: true,
        tone: baseLowPoint < 0 ? "neg" : "info",
      },
      {
        key: "step-rev-shock",
        label: "Gelir Şoku (-%10)",
        amount: revShockStep,
        formattedAmount: signedFmtTL(revShockStep),
        tone: revShockStep < 0 ? "neg" : "info",
      },
      {
        key: "step-exp-shock",
        label: liveFxDownside10 < 0 ? "Gider & Kur Şoku" : "Gider Şoku (+%10)",
        amount: expAndFxStep,
        formattedAmount: signedFmtTL(expAndFxStep),
        tone: expAndFxStep < 0 ? "warn" : "info",
      },
      {
        key: "step-stress-low",
        label: "Stres Dip Noktası",
        amount: scenarioLowPoint,
        formattedAmount: fmtTL(scenarioLowPoint),
        isTotal: true,
        tone: scenarioLowPoint < 0 ? "neg" : "pos",
      },
    ];
  }

  const lowPointDelta: number | null =
    baseLowPoint != null && scenarioLowPoint != null
      ? money(decimal(scenarioLowPoint).minus(baseLowPoint))
      : null;

  const field = "field-control mt-1 w-full p-2";

  const unifiedPresets = [
    {
      label: "+%20 Kur Şoku + 15g Tahsilat Gecikmesi",
      fxShockPct: "20",
      collectionDelayDays: "15",
      paymentDelayDays: "0",
      revenueDeltaPct: "0",
      passThroughPct: "40",
    },
    {
      label: "Stagflasyon: -%15 Satış + %15 Maliyet Artışı",
      fxShockPct: "10",
      collectionDelayDays: "10",
      paymentDelayDays: "0",
      revenueDeltaPct: "-15",
      passThroughPct: "25",
    },
    {
      label: "Tedarikçi Vade Uzatma (+20g DPO Koruma)",
      fxShockPct: "15",
      collectionDelayDays: "7",
      paymentDelayDays: "20",
      revenueDeltaPct: "0",
      passThroughPct: "50",
    },
  ];

  return (
    <>
      <PageHeader
        title="Yeni Senaryo ve Başabaş Kaldıraç Çözücü"
        subtitle="Kaynak kayıtlarını değiştirmeyen what-if çalışması ve deterministik başabaş (Goal-Seek) analizi"
        meta={<span className="text-xs text-warn">Tahmindir; muhasebe gerçeği değildir.</span>}
        action={
          <div className="flex flex-wrap items-center gap-2">
            <Link href="/scenarios/compare" className="button-ghost px-3 py-1.5 text-xs">
              Senaryoları Karşılaştır
            </Link>
            <Link href="/scenarios/optimization" className="button-accent px-3 py-1.5 text-xs">
              Nakit Optimizasyonu →
            </Link>
          </div>
        }
      />

      {/* Row 1: 2-Column First-Screen Simulation Cockpit (Fan Chart + Stress Bridge) */}
      <div className="grid gap-3.5 xl:grid-cols-12">
        <div className="min-w-0 xl:col-span-7">
          <Panel
            title="Baz, İyimser ve Stres Nakit Ufku Yelpazesi"
            subtitle="Kaynak defteri değiştirmeyen deterministik ±%10 gelir/gider şok koridoru"
            right={<Badge tone="amber">Varsayım (Model Sabiti)</Badge>}
          >
            <div className="space-y-3">
              <ScenarioFanComparisonSvg
                points={fanPoints}
                zeroLine
                ariaLabel="Baz, iyimser (+%10/-%10) ve stres (-%10/+%10) nakit ufku yelpaze grafiği"
              />

              <div className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-md)] border border-line-faint bg-surface-0 px-3 py-2 text-xs">
                <div className="tnum flex flex-wrap items-center gap-x-4 gap-y-1">
                  <span className="text-tone-2">
                    Baz Dip:{" "}
                    <strong
                      className={
                        baseLowPoint == null
                          ? "text-warn"
                          : baseLowPoint < 0
                            ? "text-neg"
                            : "text-tone-1"
                      }
                    >
                      {fmtTL(baseLowPoint)}
                    </strong>
                  </span>
                  <span className="text-tone-2">
                    Stres Dip:{" "}
                    <strong
                      className={
                        scenarioLowPoint == null
                          ? "text-warn"
                          : scenarioLowPoint < 0
                            ? "text-neg"
                            : "text-pos"
                      }
                    >
                      {fmtTL(scenarioLowPoint)}
                    </strong>
                  </span>
                  <span className="text-tone-2">
                    İyimser Dip:{" "}
                    <strong
                      className={
                        optimisticLowPoint == null
                          ? "text-warn"
                          : optimisticLowPoint < 0
                            ? "text-neg"
                            : "text-pos"
                      }
                    >
                      {fmtTL(optimisticLowPoint)}
                    </strong>
                  </span>
                </div>
                <span className="font-mono text-[11px] text-tone-3">
                  Bilinmeyen kalemler sıfır sayılmaz (R10)
                </span>
              </div>
            </div>
          </Panel>
        </div>

        <div className="min-w-0 xl:col-span-5">
          <Panel
            title="Stres Etkisi Şelalesi (Baz → Stres)"
            subtitle="Baz en düşük nakitten stres senaryosu dip noktasına geçiş"
            right={
              lowPointDelta != null ? (
                <Badge tone={lowPointDelta < 0 ? "red" : "green"}>
                  {signedFmtTL(lowPointDelta)}
                </Badge>
              ) : (
                <Badge tone="amber">TUTAR EKSİK</Badge>
              )
            }
          >
            <div className="space-y-3">
              <CashflowWaterfallSvg
                steps={waterfallSteps}
                height={212}
                ariaLabel="Baz en düşük nakitten gelir ve gider şoku etkisiyle stres dip noktasına geçiş köprüsü"
              />

              <div className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius-md)] border border-line-faint bg-surface-0 px-3 py-2 text-xs">
                <span className="tnum text-tone-2">
                  Şok Etkisi:{" "}
                  <strong
                    className={
                      lowPointDelta == null
                        ? "text-warn"
                        : lowPointDelta < 0
                          ? "text-neg"
                          : "text-pos"
                    }
                  >
                    {signedFmtTL(lowPointDelta)}
                  </strong>
                </span>
                <Link
                  href="/scenarios/history"
                  className="font-mono text-[11px] font-semibold text-info hover:underline"
                >
                  Kayıtlı Koşular →
                </Link>
              </div>
            </div>
          </Panel>
        </div>
      </div>

      {/* Row 2: Goal-Seek 4-Lever Solver Cards */}
      <Panel
        title="BAŞABAŞ KALDIRAÇ ÇÖZÜCÜ (GOAL-SEEK — 14 GÜN / 13 HAFTA / 12 AY)"
        subtitle="İlk eksi kasa veya kasa tabanı ihlalini sıfırlamak için tek başına yeterli olan 4 deterministik kaldıraç"
        right={
          <form method="get" className="flex items-center gap-2 text-xs">
            <select
              name="horizon"
              defaultValue={horizon}
              className="field-control w-auto px-2 py-1 text-xs"
            >
              <option value="14d">14 Günlük Ufuk</option>
              <option value="13w">13 Haftalık Ufuk</option>
              <option value="12m">12 Aylık Ufuk</option>
            </select>
            <button type="submit" className="button-ghost px-2.5 py-1 text-xs">
              Ufku Hesapla
            </button>
          </form>
        }
      >
        <div className="space-y-3">
          <div
            className="tnum flex flex-wrap items-center justify-between gap-2 text-xs"
            style={{ color: "var(--text-2)" }}
          >
            <div>
              Ufuk: <strong className="font-mono">{goalSeek.asOfDate}</strong> →{" "}
              <strong className="font-mono">{goalSeek.horizonEndDate}</strong> · Kasa Tabanı:{" "}
              <strong>{fmtTL(goalSeek.targetFloor)}</strong> · Kapatılması Gereken Açık:{" "}
              <strong>
                {goalSeek.requiredShortfall == null ? "—" : fmtTL(goalSeek.requiredShortfall)}
              </strong>
            </div>
            <Badge
              tone={
                goalSeek.status === "no_deficit"
                  ? "green"
                  : goalSeek.status === "unknown_opening_balance"
                    ? "amber"
                    : "red"
              }
              dot
            >
              {goalSeek.status === "no_deficit"
                ? "Açık Yok (Taban Korunuyor)"
                : goalSeek.status === "unknown_opening_balance"
                  ? "Açılış Bakiyesi Eksik"
                  : `İlk İhlal: ${goalSeek.firstBreachDate ?? "—"}`}
            </Badge>
          </div>

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <KeyStat
              label="① Tahsilat Hızlandırma (DSO)"
              value={
                goalSeek.levers.collectionDsoAcceleration.requiredDaysAcceleration == null
                  ? "Yetersiz"
                  : `-${goalSeek.levers.collectionDsoAcceleration.requiredDaysAcceleration} gün DSO`
              }
              sub={goalSeek.levers.collectionDsoAcceleration.summary}
              tone={goalSeek.levers.collectionDsoAcceleration.feasible ? "pos" : "warn"}
            />
            <KeyStat
              label="② İhtiyari Gider Kesintisi"
              value={
                goalSeek.levers.discretionaryExpenseCut.requiredCutPct == null
                  ? "—"
                  : `-%${goalSeek.levers.discretionaryExpenseCut.requiredCutPct.toFixed(1)}`
              }
              sub={goalSeek.levers.discretionaryExpenseCut.summary}
              tone={goalSeek.levers.discretionaryExpenseCut.feasible ? "pos" : "warn"}
            />
            <KeyStat
              label="③ Rotatif Kredi Çekimi"
              value={fmtTL(goalSeek.levers.revolvingCreditDrawdown.requiredDrawdownAmount)}
              sub={goalSeek.levers.revolvingCreditDrawdown.summary}
              tone={goalSeek.levers.revolvingCreditDrawdown.feasible ? "pos" : "neg"}
            />
            <KeyStat
              label="④ Üretim Başabaş Tabanı (TL/dk)"
              value={
                goalSeek.levers.productionFloorRate.cashGapAdjustedBreakevenTlPerMin == null
                  ? "—"
                  : `${goalSeek.levers.productionFloorRate.cashGapAdjustedBreakevenTlPerMin.toFixed(2)} TL/dk`
              }
              sub={goalSeek.levers.productionFloorRate.summary}
              tone="info"
            />
          </div>

          <div
            className="flex flex-wrap items-center gap-2 border px-3 py-2 text-xs"
            style={{
              background: "var(--surface-2)",
              borderColor: "var(--line-faint)",
              borderRadius: "var(--radius)",
              color: "var(--text-3)",
            }}
          >
            <Badge tone="amber">Varsayım (Model Sabiti)</Badge>
            <span className="max-w-[68ch] leading-[1.45]">
              Başabaş ve senaryo/optimizasyon motoru deterministik model sabitleri kullanır (DSO hızlandırma arama tavanı:
              180 gün, ihtiyari gider havuzu: düşük/normal öncelikli çıkışlar, hazır stres şokları: ±%10); defter kaydı
              değil simülasyon varsayımıdır.
            </span>
          </div>
        </div>
      </Panel>

      {/* Row 3: Unified 13-Week Dynamic Scenario Builder Form */}
      <Panel
        title="13 HAFTALIK BİRLEŞİK DİNAMİK SENARYO MOTORU (KUR ŞOKU + VADE KAYMASI + OTOMATİK BCH + DSCR)"
        subtitle="Canlı 13H nakit akışı, BOM YP hammadde geçişi, ufuk sonu buharlaşmayan devir alacak, otomatik BCH rotatif kredi çekimi, ek 780 faiz+BSMV+KKDF ve DSCR kovenant testi (Excel yüklemesi gerektirmez)"
        right={
          <div className="flex items-center gap-2">
            <Badge tone="green" dot>
              Birleşik Dinamik Motor
            </Badge>
            <Link href="/scenarios/compare" className="button-ghost px-2.5 py-1 text-xs">
              Senaryoları Karşılaştır →
            </Link>
          </div>
        }
      >
        <div className="mb-3 flex flex-wrap gap-2">
          {unifiedPresets.map((up) => (
            <form key={up.label} action={runUnifiedScenarioAction}>
              <input type="hidden" name="name" value={up.label} />
              <input type="hidden" name="fxShockPct" value={up.fxShockPct} />
              <input type="hidden" name="collectionDelayDays" value={up.collectionDelayDays} />
              <input type="hidden" name="paymentDelayDays" value={up.paymentDelayDays} />
              <input type="hidden" name="revenueDeltaPct" value={up.revenueDeltaPct} />
              <input type="hidden" name="passThroughPct" value={up.passThroughPct} />
              <input type="hidden" name="autoDrawFacility" value="on" />
              <input type="hidden" name="useExternalAssumptions" value="on" />
              <button type="submit" className="button-ghost px-3 py-1.5 text-xs font-medium">
                ⚡ {up.label}
              </button>
            </form>
          ))}
        </div>

        <form action={runUnifiedScenarioAction} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="text-xs sm:col-span-2">
            Senaryo Adı
            <input
              required
              name="name"
              defaultValue={`13H Dinamik Stres (${today})`}
              className={field}
            />
          </label>
          <label className="text-xs sm:col-span-2">
            Açıklama / Not (opsiyonel)
            <input
              name="description"
              placeholder="Yönetim kurulu stres testi / banka kovenant simülasyonu"
              className={field}
            />
          </label>
          <label className="text-xs">
            TCMB Döviz Kur Şoku (%)
            <input name="fxShockPct" type="number" step="0.5" defaultValue="15" className={field} />
          </label>
          <label className="text-xs">
            Tahsilat Gecikmesi — DSO (Gün)
            <input
              name="collectionDelayDays"
              type="number"
              min="0"
              max="180"
              defaultValue="14"
              className={field}
            />
          </label>
          <label className="text-xs">
            Ödeme Ertelemesi — DPO (Gün)
            <input
              name="paymentDelayDays"
              type="number"
              min="0"
              max="180"
              defaultValue="0"
              className={field}
            />
          </label>
          <label className="text-xs">
            Satış Hacim Değişimi (%)
            <input
              name="revenueDeltaPct"
              type="number"
              step="0.5"
              defaultValue="0"
              className={field}
            />
          </label>
          <label className="text-xs">
            BOM/Kur Maliyet Fiyat Geçişi (%)
            <input
              name="passThroughPct"
              type="number"
              min="0"
              max="100"
              step="1"
              defaultValue="50"
              className={field}
            />
          </label>
          <label className="text-xs">
            Ek İşletme Gideri Değişimi (%)
            <input
              name="expenseDeltaPct"
              type="number"
              step="0.5"
              placeholder="Boşsa /data/assumptions"
              className={field}
            />
          </label>
          <label className="text-xs">
            Asgari Kasa Tamponu (TRY)
            <input
              name="minCashBufferTry"
              type="number"
              min="0"
              step="1000"
              placeholder={fmtTL(goalSeek.targetFloor)}
              className={field}
            />
          </label>
          <div className="flex flex-col justify-end gap-2 text-xs">
            <label className="flex items-center gap-2">
              <input type="hidden" name="autoDrawFacility" value="false" />
              <input name="autoDrawFacility" type="checkbox" value="on" defaultChecked />
              Tampon altında otomatik BCH kredi çekimi + 780 faiz/BSMV/KKDF
            </label>
            <label className="flex items-center gap-2">
              <input type="hidden" name="useExternalAssumptions" value="false" />
              <input name="useExternalAssumptions" type="checkbox" value="on" defaultChecked />
              Onaylı dış varsayımları baz girdi olarak uygula
            </label>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 pt-1 sm:col-span-2 lg:col-span-4">
            <button type="submit" className="button-accent px-4 py-2 text-xs font-semibold">
              13 Haftalık Birleşik Senaryoyu Çalıştır &amp; Kaydet
            </button>
            <span className="max-w-[68ch] text-xs text-tone-3">
              13. hafta dışına kayan alacaklar silinmez; <b>Ufuk Sonu Devreden Alacak</b> olarak raporlanır.
            </span>
          </div>
        </form>
      </Panel>

      <Panel
        title="TCMB Kur Şoku (+%10 / +%20 / +%30), Doğal Hedge ve Kovenant Kırılma Stres Katmanı"
        subtitle="Orijinal döviz pozisyonları birbirine karıştırılmadan listelenir; TL çevrimi yalnız resmi TCMB kuru ile stres simülasyonunda yapılır"
        right={<Badge tone="amber">Varsayım (Model Sabiti)</Badge>}
      >
        {fxStress.status === "no_fx_exposure" ? (
          <div className="space-y-3">
            <EmptyState>
              Yabancı para açık pozisyon yok — aktif döviz kasa/banka, fatura, çek veya kredi yükümlülüğü bulunmuyor.
            </EmptyState>
            <div
              className="flex flex-wrap items-center gap-2 border px-3 py-2 text-xs"
              style={{
                background: "var(--surface-2)",
                borderColor: "var(--line-faint)",
                borderRadius: "var(--radius)",
                color: "var(--text-3)",
              }}
            >
              <Badge tone="amber">Varsayım (Model Sabiti)</Badge>
              <span className="max-w-[68ch] leading-[1.45]">
                TCMB kur şoku stres bantları (+%10 / +%20 / +%30) deterministik model sabitleridir; kayıtlı yabancı para
                varlık/yükümlülük oluştuğunda resmi kur üzerinden otomatik simüle edilir.
              </span>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            {fxStress.status === "missing_fx_rates" ? (
              <div
                className="flex flex-wrap items-center justify-between gap-2 border px-3 py-2 text-xs"
                style={{
                  background: "var(--surface-2)",
                  borderColor: "var(--line)",
                  borderRadius: "var(--radius)",
                  color: "var(--text-1)",
                }}
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone="red" dot>
                    TCMB kuru eksik — hesaplanamadı
                  </Badge>
                  <span className="max-w-[68ch] leading-[1.45]">
                    {`Açık pozisyonu bulunan döviz(ler) için resmi TCMB kuru bulunamadı: ${fxStress.missingFxCurrencies.join(", ")}. Sahte 1,00 veya 0,00 kur ikame edilmez.`}
                  </span>
                </div>
              </div>
            ) : null}

            {fxStress.hasUnknownCashOpening ? (
              <div
                className="flex flex-wrap items-center gap-2 border px-3 py-2 text-xs"
                style={{
                  background: "var(--surface-2)",
                  borderColor: "var(--line-faint)",
                  borderRadius: "var(--radius)",
                  color: "var(--text-3)",
                }}
              >
                <Badge tone="amber" dot>
                  Açılış bakiyesi eksik (FIN-03)
                </Badge>
                <span className="max-w-[68ch] leading-[1.45]">
                  Bilinmeyen açılış bakiyesi sıfır sayılmaz; ilgili likidite tamponu ve döviz varlık toplamı dürüstçe
                  belirsiz bırakılır.
                </span>
              </div>
            ) : null}

            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
              <KpiCard
                label="Konsolide Net Döviz Pozisyonu (TL)"
                value={
                  fxStress.status === "missing_fx_rates"
                    ? "TCMB kuru eksik — hesaplanamadı"
                    : fmtTL(fxStress.consolidatedNetOpenTry)
                }
                tone={
                  fxStress.consolidatedNetOpenTry == null
                    ? "warn"
                    : fxStress.consolidatedNetOpenTry < 0
                      ? "neg"
                      : "pos"
                }
                note={`Baz 12 Ay Nakit DSCR (Spot FX): ${fxStress.baseForward12mDscrWithSpotFx == null ? "—" : `${fxStress.baseForward12mDscrWithSpotFx.toFixed(2)}x`}`}
              />
              <KpiCard
                label="+%10 Kur Şoku Farkı"
                badge={<Badge tone="amber">Varsayım (Model Sabiti)</Badge>}
                value={
                  fxStress.status === "missing_fx_rates"
                    ? "TCMB kuru eksik — hesaplanamadı"
                    : signedFmtTL(band10?.netWorthShockDeltaTry)
                }
                tone={
                  band10?.netWorthShockDeltaTry == null
                    ? "warn"
                    : band10.netWorthShockDeltaTry < 0
                      ? "neg"
                      : "pos"
                }
                note={`Şok Sonrası Likidite: ${fmtTL(band10?.postShockLiquidityBufferTry)}`}
              />
              <KpiCard
                label="+%20 Kur Şoku Farkı"
                badge={<Badge tone="amber">Varsayım (Model Sabiti)</Badge>}
                value={
                  fxStress.status === "missing_fx_rates"
                    ? "TCMB kuru eksik — hesaplanamadı"
                    : signedFmtTL(band20?.netWorthShockDeltaTry)
                }
                tone={
                  band20?.netWorthShockDeltaTry == null
                    ? "warn"
                    : band20.netWorthShockDeltaTry < 0
                      ? "neg"
                      : "pos"
                }
                note={`Şok Sonrası Likidite: ${fmtTL(band20?.postShockLiquidityBufferTry)}`}
              />
              <KpiCard
                label="+%30 Kur Şoku & Kovenant"
                badge={<Badge tone="amber">Varsayım (Model Sabiti)</Badge>}
                value={
                  fxStress.status === "missing_fx_rates"
                    ? "TCMB kuru eksik — hesaplanamadı"
                    : signedFmtTL(band30?.netWorthShockDeltaTry)
                }
                tone={
                  band30?.covenantBreachTriggered
                    ? "neg"
                    : band30?.netWorthShockDeltaTry == null
                      ? "warn"
                      : band30.netWorthShockDeltaTry < 0
                        ? "neg"
                        : "pos"
                }
                note={
                  band30?.covenantBreachTriggered
                    ? `Kovenant ihlali tetiklendi (${band30.newlyBreachedCovenantCount} kovenant)`
                    : `12 Ay DSCR: ${band30?.postShockForward12mDscr == null ? "—" : `${band30.postShockForward12mDscr.toFixed(2)}x`}`
                }
              />
            </div>

            <TableShell>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase text-tone-3">
                    <th className="py-1.5">Döviz</th>
                    <th className="text-right">Döviz Varlık (Kasa + Alacak + Çek)</th>
                    <th className="text-right">Döviz Yükümlülük (Borç + Kredi + Çek)</th>
                    <th className="text-right">Net Orijinal Pozisyon</th>
                    <th>Doğal Hedge</th>
                    <th className="text-right">TCMB Baz Kur</th>
                    <th className="text-right">Baz TL Karşılığı</th>
                  </tr>
                </thead>
                <tbody>
                  {fxStress.currencies.map((c) => (
                    <tr
                      key={`fx-bucket-${c.currency}`}
                      className="border-t border-line-faint text-tone-1"
                    >
                      <td className="py-2 font-mono font-semibold">{c.currency}</td>
                      <td className="text-right tabular-nums">
                        {c.hasUnknownCashOpening
                          ? "— (açılış bakiyesi eksik)"
                          : formatNativeFx(c.fxAssets, c.currency)}
                      </td>
                      <td className="text-right tabular-nums">
                        {formatNativeFx(c.fxLiabilities, c.currency)}
                      </td>
                      <td
                        className="text-right font-semibold tabular-nums"
                        style={{
                          color:
                            c.netNativePosition == null
                              ? "var(--warn)"
                              : c.netNativePosition < 0
                                ? "var(--neg)"
                                : "var(--pos)",
                        }}
                      >
                        {c.netNativePosition == null
                          ? "TUTAR EKSİK"
                          : formatNativeFx(c.netNativePosition, c.currency)}
                      </td>
                      <td className="py-2">{renderHedgeBadge(c.hedgeStatus, c.naturalHedgeRatio)}</td>
                      <td className="text-right font-mono tabular-nums text-tone-3">
                        {formatTcmbRate(c.tcmbBaseRate)}
                      </td>
                      <td className="text-right font-semibold tabular-nums">
                        {c.hasMissingRate ? "TCMB kuru eksik" : fmtTL(c.baseNetValueTry)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableShell>

            <TableShell>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase text-tone-3">
                    <th className="py-1.5">Stres Şok Bandı</th>
                    <th className="text-right">Kur Farkı Etkisi (TL)</th>
                    <th className="text-right">Şok Sonrası Likidite Tamponu</th>
                    <th className="text-right">Şoklu 12 Ay YP Borç Servisi</th>
                    <th className="text-right">Şok Sonrası 12 Ay DSCR</th>
                    <th>Kovenant Kırılma Durumu</th>
                  </tr>
                </thead>
                <tbody>
                  {fxStress.shockBands.map((band) => (
                    <tr
                      key={`fx-band-${band.shockPct}`}
                      className="border-t border-line-faint text-tone-1"
                    >
                      <td className="py-2">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="font-mono font-semibold tabular-nums">{band.label}</span>
                          <Badge tone="amber">Varsayım (Model Sabiti)</Badge>
                        </div>
                      </td>
                      <td
                        className="text-right font-semibold tabular-nums"
                        style={{
                          color:
                            band.netWorthShockDeltaTry == null
                              ? "var(--warn)"
                              : band.netWorthShockDeltaTry < 0
                                ? "var(--neg)"
                                : "var(--pos)",
                        }}
                      >
                        {fxStress.status === "missing_fx_rates"
                          ? "TCMB kuru eksik — hesaplanamadı"
                          : signedFmtTL(band.netWorthShockDeltaTry)}
                      </td>
                      <td className="text-right tabular-nums">
                        {fxStress.status === "missing_fx_rates"
                          ? "—"
                          : fmtTL(band.postShockLiquidityBufferTry)}
                      </td>
                      <td className="text-right tabular-nums text-tone-3">
                        {band.shockedFxNext12mDebtServiceTry == null
                          ? "—"
                          : fmtTL(band.shockedFxNext12mDebtServiceTry)}
                      </td>
                      <td className="text-right font-mono tabular-nums">
                        {band.postShockForward12mDscr == null
                          ? "—"
                          : `${band.postShockForward12mDscr.toFixed(2)}x`}
                      </td>
                      <td className="py-2">
                        {fxStress.status === "missing_fx_rates" ? (
                          <Badge tone="amber">Kur Eksik — Test Edilemedi</Badge>
                        ) : band.covenantBreachTriggered ? (
                          <Badge tone="red" dot>
                            {`Kovenant İhlali Tetiklendi (${band.newlyBreachedCovenantCount})`}
                          </Badge>
                        ) : band.breachedCovenantCount > 0 ? (
                          <Badge tone="amber">Mevcut İhlal Sürüyor</Badge>
                        ) : band.covenantEvaluations.length === 0 ? (
                          <Badge tone="neutral">Tanımlı Kovenant Yok</Badge>
                        ) : (
                          <Badge tone="green">Kovenant Korunuyor</Badge>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableShell>

            <div
              className="flex flex-wrap items-center gap-2 border px-3 py-2 text-xs"
              style={{
                background: "var(--surface-2)",
                borderColor: "var(--line-faint)",
                borderRadius: "var(--radius)",
                color: "var(--text-3)",
              }}
            >
              <Badge tone="amber">Varsayım (Model Sabiti)</Badge>
              <span className="max-w-[68ch] leading-[1.45]">
                +%10 / +%20 / +%30 kur şoku bantları model sabitidir; her yabancı para kendi orijinal biriminde tutulur ve
                yalnız <code className="font-mono text-[11px]">fx_rate_snapshots</code> tablosundaki resmi TCMB kuru üzerinden simüle edilir. Defter kayıtları
                değiştirilmez.
              </span>
            </div>
          </div>
        )}
      </Panel>

      <Panel
        title="AKTİF DIŞ VARSAYIM BAZ GİRDİLERİ (/DATA/ASSUMPTIONS)"
        subtitle="Onaylı makro/piyasa varsayımları senaryo çalıştırılırken aksi belirtilmedikçe baz girdi olarak uygulanır"
        right={
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={externalBaseline.approved.length > 0 ? "green" : "neutral"}>
              {externalBaseline.approved.length} onaylı varsayım
            </Badge>
            <Link href="/data/assumptions" className="button-ghost px-2.5 py-1 text-xs">
              Varsayımları Yönet →
            </Link>
          </div>
        }
      >
        {externalBaseline.approved.length === 0 ? (
          <EmptyState>
            Onaylı dış varsayım kaydı bulunmuyor.{" "}
            <Link href="/data/assumptions" className="underline">
              /data/assumptions
            </Link>{" "}
            üzerinden enflasyon, faiz, döviz kuru veya maliyet varsayımı onayladığınızda senaryo motoruna otomatik baz girdi olarak akar.
          </EmptyState>
        ) : (
          <div className="space-y-2">
            <TableShell>
              <table className="w-full border-collapse text-left text-xs">
                <thead>
                  <tr className="border-b border-line text-[11px] uppercase text-tone-3">
                    <th className="py-2 pr-2">Tür</th>
                    <th className="py-2 px-2">Varsayım Etiketi</th>
                    <th className="py-2 px-2 text-right">Değer</th>
                    <th className="py-2 px-2">Senaryo Baz Etkisi</th>
                    <th className="py-2 pl-2 text-right">Kaynak / Tarih</th>
                  </tr>
                </thead>
                <tbody>
                  {externalBaseline.approved.map((ext) => (
                    <tr key={ext.id} className="border-b border-line-faint text-tone-1">
                      <td className="py-1.5 pr-2">
                        <Badge tone="blue">{ext.assumptionType}</Badge>
                      </td>
                      <td className="py-1.5 px-2 font-medium">{ext.label}</td>
                      <td className="py-1.5 px-2 text-right font-semibold tabular-nums">
                        {ext.value.toLocaleString("tr-TR")} {ext.unit}
                      </td>
                      <td className="py-1.5 px-2 text-tone-2">{ext.mappingSummary}</td>
                      <td className="py-1.5 pl-2 text-right font-mono tabular-nums text-tone-3">
                        {ext.sourceName} · {ext.sourceDate}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableShell>
            <div
              className="border px-3 py-2 text-xs"
              style={{
                background: "var(--surface-2)",
                borderColor: "var(--line-faint)",
                borderRadius: "var(--radius)",
                color: "var(--text-2)",
              }}
            >
              <span className="max-w-[68ch] leading-[1.45]">
                Aşağıdaki senaryo formunda ilgili alanı (örn. <b>Gider değişimi %</b> veya <b>Faktoring maliyeti %</b>) boş bıraktığınızda onaylı dış varsayım baz değer olarak kullanılır; açık bir değer girerseniz senaryo parametresi dış varsayımı ezer.
              </span>
            </div>
          </div>
        )}
      </Panel>

      <Panel title="Hazır senaryolar (Tarihsel Aylık Nakit Akışı)">
        <div className="flex flex-wrap gap-2">
          {presets.map((p) => (
            <form key={p.n} action={runScenarioAction}>
              <input type="hidden" name="name" value={p.n} />
              <input type="hidden" name="revenuePct" value={p.r} />
              <input type="hidden" name="expensePct" value={p.e} />
              <button className="button-ghost px-3 py-2" disabled={!months.length}>
                {p.n}
              </button>
            </form>
          ))}
        </div>
      </Panel>

      <Panel title="Gelişmiş varsayımlar" right={<Badge tone="amber">Varsayım (Model Sabiti)</Badge>}>
        <form action={runScenarioAction} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <label className="text-xs">
            Senaryo adı
            <input required name="name" className={field} />
          </label>
          <label className="text-xs">
            Gelir değişimi %
            <input
              name="revenuePct"
              type="number"
              step="0.1"
              placeholder={
                externalBaseline.defaultAssumptions.revenuePct != null
                  ? `Baz: %${(externalBaseline.defaultAssumptions.revenuePct * 100).toFixed(1)}`
                  : undefined
              }
              className={field}
            />
          </label>
          <label className="text-xs">
            Gider değişimi %
            <input
              name="expensePct"
              type="number"
              step="0.1"
              placeholder={
                externalBaseline.defaultAssumptions.expensePct != null
                  ? `Baz: %${(externalBaseline.defaultAssumptions.expensePct * 100).toFixed(1)}`
                  : undefined
              }
              className={field}
            />
          </label>
          <label className="text-xs">
            Genel müşteri gecikmesi (ay)
            <input
              name="customerDelayMonths"
              type="number"
              min="0"
              placeholder={
                externalBaseline.defaultAssumptions.customerDelayMonths != null
                  ? `Baz: ${externalBaseline.defaultAssumptions.customerDelayMonths} ay`
                  : undefined
              }
              className={field}
            />
          </label>
          <label className="text-xs">
            Hedef tahsilat etiketi
            <input name="targetIncomeLabel" placeholder="Hpt" className={field} />
          </label>
          <label className="text-xs">
            Tahsilat gecikmesi (ay)
            <input name="targetIncomeDelayMonths" type="number" min="0" className={field} />
          </label>
          <label className="text-xs">
            Hedef ödeme etiketi
            <input name="targetOutflowLabel" placeholder="Çağdaş" className={field} />
          </label>
          <label className="text-xs">
            Ödeme ertelemesi (ay)
            <input name="targetOutflowDelayMonths" type="number" min="0" className={field} />
          </label>
          <label className="text-xs">
            Faktoring tahsilat etiketi
            <input name="factoringIncomeLabel" placeholder="Hpt" className={field} />
          </label>
          <label className="text-xs">
            Faktoring öne çekme ayı
            <input name="factoringAdvanceMonth" type="month" className={field} />
          </label>
          <label className="text-xs">
            Faktoring maliyeti %
            <input
              name="factoringFeePct"
              type="number"
              min="0"
              step="0.01"
              placeholder={
                externalBaseline.defaultAssumptions.factoringFeePct != null
                  ? `Baz: %${(externalBaseline.defaultAssumptions.factoringFeePct * 100).toFixed(2)}`
                  : undefined
              }
              className={field}
            />
          </label>
          <label className="text-xs">
            Kapasite kullanımı %
            <input name="capacityUtilizationPct" type="number" min="0" step="0.1" className={field} />
          </label>
          <label className="text-xs">
            Verim değişimi %
            <input name="efficiencyPct" type="number" step="0.1" className={field} />
          </label>
          <label className="flex items-center gap-2 text-xs">
            <input name="includeDebtService" type="checkbox" />
            Borç servisini giderlere ekle
          </label>
          <label className="flex items-center gap-2 text-xs">
            <input type="hidden" name="useExternalAssumptions" value="false" />
            <input name="useExternalAssumptions" type="checkbox" value="on" defaultChecked />
            Onaylı dış varsayımları (/data/assumptions) baz girdi olarak uygula
          </label>
          <div className="lg:col-span-3">
            <button className="button-accent px-3 py-2" disabled={!months.length}>
              Senaryoyu çalıştır
            </button>
            <p className="mt-2 max-w-[68ch] text-xs leading-[1.45] text-tone-3">
              Bilinmeyen tutarlar sıfır sayılmaz. Onaylı dış varsayımlar boş bırakılan senaryo alanlarına baz değer olarak uygulanır ve kayıt altına alınır.
            </p>
          </div>
        </form>
      </Panel>
    </>
  );
}
