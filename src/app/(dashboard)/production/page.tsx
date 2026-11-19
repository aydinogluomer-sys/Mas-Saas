import Link from "@/components/ui/app-link";
import { Badge } from "@/components/ui/badge";
import {
  AgingBucketsBarSvg,
  EditorialDonutChartSvg,
  type AgingBucketItem,
  type DonutSlice,
} from "@/components/charts/editorial-cockpit-charts";
import { fmtTL, Panel } from "@/components/ui/panel";
import { EmptyState, KeyStat, KpiCard, PageHeader, TableShell } from "@/components/ui/shell";
import { SubmitButton } from "@/components/ui/submit-button";
import { getRequestUser } from "@/lib/auth";
import { can } from "@/lib/authz/matrix";
import { requireRouteAccess } from "@/lib/authz/route-guard";
import { getPool } from "@/lib/db";
import { decimal, money } from "@/lib/money";
import {
  fmtSignedPct,
  fmtSignedTlPerMin,
  fmtTlPerMin,
  loadActualCostBridge,
} from "@/lib/production/actual-cost-bridge";
import {
  loadCostModels,
  loadMachineRoiAggregate,
  loadPartProfitability,
  loadProductionParts,
} from "@/lib/production/engine";
import {
  INVENTORY_ITEM_TYPES,
  INVENTORY_MOVEMENT_TYPES,
  ITEM_TYPE_LABEL,
  loadActivePartiesForProduction,
  loadBomSummaries,
  loadCustomerRateCards,
  loadInventoryOverview,
  loadWorkCenters,
  loadWorkOrdersAndOee,
  MOVEMENT_TYPE_LABEL,
  OPERATION_TYPE_LABEL,
  TDHP_INVENTORY_ACCOUNTS,
  WORK_CENTER_OPERATION_TYPES,
  WORK_ORDER_STATUS_LABEL,
} from "@/lib/production/erp-lite";
import { loadSourceRevenueSummary } from "@/lib/production/source-revenue";
import {
  addBomLineAction,
  createWorkOrderAction,
  deleteBomLineAction,
  recordInventoryMovementAction,
  toggleCustomerRateCardAction,
  toggleWorkCenterActiveAction,
  transitionWorkOrderStatusAction,
  upsertCapacityParameterAction,
  upsertCustomerRateCardAction,
  upsertInventoryItemAction,
  upsertWorkCenterAction,
} from "./actions";

export const dynamic = "force-dynamic";

type ProdTab = "overview" | "stations" | "inventory" | "bom" | "workorders" | "rates";

const TAB_ITEMS: Array<{ key: ProdTab; label: string }> = [
  { key: "overview", label: "Genel Bakış & 7xx Köprüsü" },
  { key: "stations", label: "İş İstasyonları" },
  { key: "inventory", label: "Stok (150/151/152) & DIO/CCC" },
  { key: "bom", label: "Ürün Ağacı (BOM 710)" },
  { key: "workorders", label: "İş Emirleri & Canlı OEE" },
  { key: "rates", label: "Müşteri Tarife Kartları" },
];

export default async function ProductionSummary({
  searchParams,
}: {
  searchParams?: Promise<{ error?: string; result?: string; tab?: string }>;
}) {
  const denied = await requireRouteAccess("/production");
  if (denied) return denied;
  const session = await getRequestUser();
  const role = session?.role ?? "viewer";
  const canEditCapacity = can(role, "capacity_models", "insert");
  const canEditWorkCenters = can(role, "work_centers", "insert");
  const canEditInventoryItems = can(role, "inventory_items", "insert");
  const canRecordMovements = can(role, "inventory_movements", "insert");
  const canEditBom = can(role, "bom_headers", "insert");
  const canDeleteBom = can(role, "bom_lines", "delete");
  const canCreateWorkOrders = can(role, "work_orders", "insert");
  const canUpdateWorkOrders = can(role, "work_orders", "update");
  const canEditRateCards = can(role, "customer_rate_cards", "insert");

  const sp = searchParams ? await searchParams : {};
  const activeTab: ProdTab = TAB_ITEMS.some((t) => t.key === sp.tab)
    ? (sp.tab as ProdTab)
    : "overview";

  const p = getPool();
  const [
    costs,
    parts,
    allParts,
    roi,
    revSummary,
    bridge,
    workCenters,
    inventory,
    bomOverview,
    woOverview,
    rateCards,
    parties,
  ] = await Promise.all([
    loadCostModels(p),
    loadPartProfitability(p, 5),
    loadProductionParts(p, 250),
    loadMachineRoiAggregate(p),
    loadSourceRevenueSummary(p),
    loadActualCostBridge(p),
    loadWorkCenters(p),
    loadInventoryOverview(p),
    loadBomSummaries(p),
    loadWorkOrdersAndOee(p),
    loadCustomerRateCards(p),
    loadActivePartiesForProduction(p),
  ]);

  const lowest = parts[0];
  const normalModel = costs.find((x) => x.scenario === "normal");
  const hasErosionAlert =
    bridge.hiddenErosionRateCount > 0 || bridge.hiddenErosionPartCount > 0;
  const roiTone =
    roi?.net !== null && roi?.net !== undefined && roi.net < 0 ? "neg" : "pos";

  const plantOee = woOverview.plantOee;
  const wcMetrics = inventory.workingCapital;

  // ABC Dakika Başabaş Maliyeti (TL/dk) vs Müşteri Teklif / Hedef Dakika Geliri
  const abcBreakEvenTlPerMin =
    bridge.abcShopFloorTlPerMin ??
    bridge.actualFullBreakEvenTlPerMin ??
    normalModel?.breakEven ??
    null;

  const activeTryRates = rateCards.cards.filter(
    (rc) => rc.isActive && rc.ratePerMinuteTry !== null && Number.isFinite(rc.ratePerMinuteTry),
  );
  const avgCustomerRateTlPerMin =
    activeTryRates.length > 0
      ? Number(
          activeTryRates
            .reduce((acc, rc) => acc.plus(rc.ratePerMinuteTry ?? 0), decimal(0))
            .div(activeTryRates.length)
            .round(2)
            .toFixed(2),
        )
      : (normalModel?.akonFreze ?? normalModel?.akonTorna ?? null);

  // Left Visual: Kapasite & Maliyet Kompozisyonu (EditorialDonutChartSvg)
  const hasCapacityMinutes = workCenters.totalTargetEffectiveMinutes > 0;
  let productionDonutSlices: DonutSlice[] = [];
  let donutCenterLabel = "ETKİN KAPASİTE";
  let donutCenterValue = "—";
  let donutCenterSubtext = `${workCenters.activeCount} aktif istasyon`;

  if (hasCapacityMinutes) {
    const runMin = plantOee.totalActualRunMinutes;
    const scheduledOpenMin = Math.max(
      0,
      money(decimal(plantOee.totalPlannedMinutes).minus(plantOee.totalActualRunMinutes)),
    );
    const downtimeMin = plantOee.totalDowntimeMinutes;
    const engagedMin = money(decimal(runMin).plus(scheduledOpenMin).plus(downtimeMin));
    const idleEffectiveMin = Math.max(
      0,
      money(decimal(workCenters.totalTargetEffectiveMinutes).minus(engagedMin)),
    );
    const oeeBufferMin = Math.max(
      0,
      money(
        decimal(workCenters.totalGrossMonthlyMinutes).minus(workCenters.totalTargetEffectiveMinutes),
      ),
    );

    productionDonutSlices = [
      {
        key: "cap-run",
        label: "Fiili Üretim (Run)",
        value: runMin,
        formattedValue: `${Math.round(runMin).toLocaleString("tr-TR")} dk`,
        sublabel: `${plantOee.activeOrCompletedOrders} aktif/tamamlanan emir`,
        tone: "pos",
      },
      {
        key: "cap-scheduled",
        label: "Planlı Açık İş Yükü",
        value: scheduledOpenMin,
        formattedValue: `${Math.round(scheduledOpenMin).toLocaleString("tr-TR")} dk`,
        sublabel: `${plantOee.totalOrders} iş emri`,
        tone: "info",
      },
      {
        key: "cap-idle",
        label: "Boş (Atıl) Kapasite",
        value: idleEffectiveMin,
        formattedValue: `${Math.round(idleEffectiveMin).toLocaleString("tr-TR")} dk`,
        sublabel: "Siparişe açık etkin süre",
        tone: "accent",
      },
      {
        key: "cap-downtime",
        label: "Duruş & Arıza",
        value: downtimeMin,
        formattedValue: `${Math.round(downtimeMin).toLocaleString("tr-TR")} dk`,
        sublabel: plantOee.bottleneckWorkCenterCode
          ? `Darboğaz: ${plantOee.bottleneckWorkCenterCode}`
          : "Kayıtlı duruş süresi",
        tone: "neg",
      },
      {
        key: "cap-buffer",
        label: "OEE Hazırlık Tamponu",
        value: oeeBufferMin,
        formattedValue: `${Math.round(oeeBufferMin).toLocaleString("tr-TR")} dk`,
        sublabel: "Planlı bakım & hazırlık",
        tone: "neutral",
      },
    ];
    donutCenterLabel = "ETKİN KAPASİTE";
    donutCenterValue = `${Math.round(workCenters.totalTargetEffectiveMinutes).toLocaleString("tr-TR")} dk`;
    donutCenterSubtext =
      plantOee.oeePct != null
        ? `Canlı OEE %${plantOee.oeePct.toFixed(1)}`
        : `${workCenters.activeCount} aktif istasyon`;
  } else {
    const matVal =
      bridge.avgMonthlyDirectMaterial710Try != null && bridge.avgMonthlyDirectMaterial710Try > 0
        ? bridge.avgMonthlyDirectMaterial710Try
        : inventory.tdhp150RawTry;
    const shopVal =
      bridge.avgMonthlyShopFloor720_730Try != null && bridge.avgMonthlyShopFloor720_730Try > 0
        ? bridge.avgMonthlyShopFloor720_730Try
        : (normalModel?.monthlyCost ?? 0);
    const opexVal = bridge.avgMonthlyOpex760_770ExclDaTry ?? 0;
    const wipFinVal = money(decimal(inventory.tdhp151WipTry).plus(inventory.tdhp152FinishedTry));
    const mixTotal = money(decimal(matVal).plus(shopVal).plus(opexVal).plus(wipFinVal));

    productionDonutSlices = [
      {
        key: "mix-mat",
        label: "150 / 710 İlk Madde",
        value: matVal,
        formattedValue: fmtTL(matVal),
        sublabel: "Hammadde & direkt malzeme",
        tone: "info",
      },
      {
        key: "mix-shop",
        label: "720+730 İşçilik & Atölye",
        value: shopVal,
        formattedValue: fmtTL(shopVal),
        sublabel: "Tezgâh dönüşüm havuzu",
        tone: "pos",
      },
      {
        key: "mix-opex",
        label: "760+770 Genel Gider",
        value: opexVal,
        formattedValue: fmtTL(opexVal),
        sublabel: "Faaliyet gideri (D&A hariç)",
        tone: "warn",
      },
      {
        key: "mix-wip",
        label: "151+152 Yarı Mamul & Mamul",
        value: wipFinVal,
        formattedValue: fmtTL(wipFinVal),
        sublabel: "Üretimdeki & mamul stok",
        tone: "accent",
      },
    ];
    donutCenterLabel = "MALİYET & STOK";
    donutCenterValue = fmtTL(mixTotal);
    donutCenterSubtext = "TDHP 150 · 710 · 720 · 730";
  }

  // Right Visual: Tezgâh / İş Merkezi veya TDHP Maliyet Kalemi Sütunları (AgingBucketsBarSvg)
  const activeStations = workCenters.items.filter((w) => w.isActive);
  const stationById = new Map(woOverview.stationOee.map((s) => [s.workCenterId, s]));

  const comparisonBuckets: AgingBucketItem[] =
    activeStations.length >= 2
      ? activeStations.slice(0, 6).map((wc, idx) => {
          const st = stationById.get(wc.id);
          return {
            key: `wc-${wc.id}`,
            label: `${wc.code} ${OPERATION_TYPE_LABEL[wc.operationType].split(" ")[0]}`,
            amount: wc.targetEffectiveMinutes,
            formattedAmount: `${Math.round(wc.targetEffectiveMinutes).toLocaleString("tr-TR")} dk`,
            count: st?.orderCount,
            tone: st?.isBottleneck
              ? "neg"
              : (st?.orderCount ?? 0) > 0
                ? "pos"
                : idx % 2 === 0
                  ? "info"
                  : "accent",
          };
        })
      : [
          {
            key: "col-150",
            label: "150 Hammadde",
            amount: inventory.tdhp150RawTry,
            formattedAmount: fmtTL(inventory.tdhp150RawTry),
            tone: "info",
          },
          {
            key: "col-151-152",
            label: "151/152 Mamul",
            amount: money(decimal(inventory.tdhp151WipTry).plus(inventory.tdhp152FinishedTry)),
            formattedAmount: fmtTL(
              money(decimal(inventory.tdhp151WipTry).plus(inventory.tdhp152FinishedTry)),
            ),
            tone: "pos",
          },
          {
            key: "col-710",
            label: "710 Direkt Malz.",
            amount: bridge.avgMonthlyDirectMaterial710Try ?? 0,
            formattedAmount:
              bridge.avgMonthlyDirectMaterial710Try != null
                ? fmtTL(bridge.avgMonthlyDirectMaterial710Try)
                : "—",
            tone: "accent",
          },
          {
            key: "col-720-730",
            label: "720+730 Atölye",
            amount: bridge.avgMonthlyShopFloor720_730Try ?? normalModel?.monthlyCost ?? 0,
            formattedAmount:
              bridge.avgMonthlyShopFloor720_730Try != null
                ? fmtTL(bridge.avgMonthlyShopFloor720_730Try)
                : normalModel?.monthlyCost != null
                  ? fmtTL(normalModel.monthlyCost)
                  : "—",
            tone: "warn",
          },
          {
            key: "col-760-da",
            label: "760+770 & D&A",
            amount: money(
              decimal(bridge.avgMonthlyOpex760_770ExclDaTry ?? 0).plus(
                bridge.avgMonthlyDepreciationDaTry ?? 0,
              ),
            ),
            formattedAmount:
              bridge.avgMonthlyOpex760_770ExclDaTry != null ||
              bridge.avgMonthlyDepreciationDaTry != null
                ? fmtTL(
                    money(
                      decimal(bridge.avgMonthlyOpex760_770ExclDaTry ?? 0).plus(
                        bridge.avgMonthlyDepreciationDaTry ?? 0,
                      ),
                    ),
                  )
                : "—",
            tone: hasErosionAlert ? "neg" : "neutral",
          },
        ];

  return (
    <>
      <PageHeader
        title="Üretim Operasyonları (ERP-Lite · BOM · Stok · İş Emirleri · OEE)"
        subtitle="İş istasyonları, TDHP 150/151/152 stok & DIO/CCC, çok satırlı BOM reçetesi, iş emirleri canlı OEE ve çoklu müşteri tarife kartları"
        meta={
          <Badge tone={hasErosionAlert ? "red" : "blue"} dot>
            {hasErosionAlert
              ? `${bridge.hiddenErosionPartCount} parça / ${bridge.hiddenErosionRateCount} tarife erimesi`
              : `${workCenters.activeCount} istasyon · ${rateCards.activeCount} tarife`}
          </Badge>
        }
        action={
          <div className="flex flex-wrap items-center gap-2">
            <Link href="/production/costs" className="button-ghost px-2.5 py-1.5 text-xs">
              ABC Maliyet &amp; 7xx →
            </Link>
            <Link href="/production/kiosk" className="button-accent px-3 py-1.5 text-xs font-semibold">
              Atölye Kiosk (QR) →
            </Link>
          </div>
        }
      />

      {sp.error ? (
        <div
          className="mb-3 rounded border p-2 text-xs"
          style={{
            borderColor: "color-mix(in srgb, var(--neg) 40%, var(--line))",
            background: "color-mix(in srgb, var(--neg) 10%, var(--surface-1))",
            color: "var(--neg)",
          }}
        >
          {sp.error}
        </div>
      ) : null}
      {sp.result ? (
        <div
          className="mb-3 rounded border p-2 text-xs"
          style={{
            borderColor: "color-mix(in srgb, var(--pos) 40%, var(--line))",
            background: "color-mix(in srgb, var(--pos) 10%, var(--surface-1))",
            color: "var(--pos)",
          }}
        >
          {sp.result}
        </div>
      ) : null}

      {/* Row 1: Compact 4-Card KPI Strip */}
      <div className="mb-3 grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCard
          label="Tesis Canlı OEE"
          value={plantOee.oeePct != null ? `%${plantOee.oeePct.toFixed(1)}` : "—"}
          tone={plantOee.oeePct == null ? "neutral" : plantOee.oeePct >= 75 ? "pos" : "warn"}
          note={
            plantOee.oeePct != null
              ? `A:%${plantOee.availabilityPct?.toFixed(0)} · P:%${plantOee.performancePct?.toFixed(0)} · Q:%${plantOee.qualityPct?.toFixed(0)}`
              : `${plantOee.totalOrders} iş emri · ${workCenters.activeCount} aktif istasyon`
          }
        />
        <KpiCard
          label="ABC Atölye Başabaş"
          value={fmtTlPerMin(abcBreakEvenTlPerMin)}
          tone={roiTone}
          note={`Hedef tarife: ${fmtTlPerMin(avgCustomerRateTlPerMin)} · En düşük marj: ${lowest?.margin == null ? "—" : fmtTL(lowest.margin)}`}
        />
        <KpiCard
          label="TDHP 150/151/152 Stok"
          value={fmtTL(inventory.totalValuationTry)}
          tone={inventory.lowStockCount > 0 ? "warn" : "info"}
          note={
            inventory.lowStockCount > 0
              ? `${inventory.lowStockCount} kalem kritik stokta`
              : `${inventory.items.length} stok kartı`
          }
        />
        <KpiCard
          label="Stok Gün (DIO) & CCC"
          value={wcMetrics.dioDays != null ? `${wcMetrics.dioDays.toFixed(1)} gün` : "—"}
          tone="info"
          note={
            wcMetrics.cashConversionCycleDays != null
              ? `CCC: ${wcMetrics.cashConversionCycleDays.toFixed(1)} gün`
              : "Nakit dönüşüm döngüsü"
          }
        />
      </div>

      {/* Row 2: 2-Column Visual Cockpit Above the Fold */}
      <div className="mb-3.5 grid gap-3.5 xl:grid-cols-12">
        <div className="min-w-0 xl:col-span-6">
          <Panel
            title="Kapasite & Maliyet Kompozisyonu"
            subtitle={
              hasCapacityMinutes
                ? "Fiili çalışma, planlı açık iş yükü, duruş ve boş etkin kapasite dağılımı (Dk/Ay)"
                : "TDHP 150/151/152 stok ve 710/720/730/760 üretim maliyet kompozisyonu"
            }
            right={
              <Link
                href="/production/capacity"
                className="text-[11px] font-semibold text-info hover:underline"
              >
                Kapasite Detayı →
              </Link>
            }
          >
            <EditorialDonutChartSvg
              size={152}
              slices={productionDonutSlices}
              centerLabel={donutCenterLabel}
              centerValue={donutCenterValue}
              centerSubtext={donutCenterSubtext}
              ariaLabel="Atölye kapasite kullanımı ve TDHP üretim maliyet kompozisyonu"
            />
          </Panel>
        </div>

        <div className="min-w-0 xl:col-span-6">
          <Panel
            title={
              activeStations.length >= 2
                ? "Tezgâh & İş Merkezi Kapasite Karşılaştırması"
                : "TDHP Stok & Maliyet Kalemi Karşılaştırması"
            }
            subtitle={
              activeStations.length >= 2
                ? "Aktif iş istasyonlarının aylık hedef etkin dakika kapasitesi ve iş emri yükü"
                : "TDHP 150/151/152 stok bakiyeleri ile 7xx aylık maliyet havuzlarının ölçek karşılaştırması"
            }
            right={
              <span className="tnum font-mono text-[11px] text-tone-2">
                ABC: <strong>{fmtTlPerMin(abcBreakEvenTlPerMin)}</strong> vs Hedef:{" "}
                <strong>{fmtTlPerMin(avgCustomerRateTlPerMin)}</strong>
              </span>
            }
          >
            <AgingBucketsBarSvg
              buckets={comparisonBuckets}
              ariaLabel={
                activeStations.length >= 2
                  ? "Aktif iş istasyonları aylık etkin dakika kapasite sütunları"
                  : "TDHP stok ve üretim maliyet kalemleri karşılaştırma sütunları"
              }
            />
          </Panel>
        </div>
      </div>

      <nav
        aria-label="Üretim çalışma görünümü seçici"
        className="segmented-view-pills mb-3 inline-flex max-w-full flex-wrap items-center gap-1 rounded-[var(--radius-md)] border border-line bg-surface-2 p-1 text-xs"
      >
        {TAB_ITEMS.map((t) => {
          const isCurrent = activeTab === t.key;
          const countHint =
            t.key === "stations"
              ? workCenters.activeCount
              : t.key === "inventory"
                ? inventory.items.length
                : t.key === "bom"
                  ? bomOverview.boms.length
                  : t.key === "workorders"
                    ? woOverview.orders.length
                    : t.key === "rates"
                      ? rateCards.activeCount
                      : null;
          return (
            <Link
              key={t.key}
              href={t.key === "overview" ? "/production" : `/production?tab=${t.key}`}
              aria-current={isCurrent ? "page" : undefined}
              className="inline-flex items-center gap-1.5 rounded-[var(--radius-control)] px-2.5 py-1 text-[12px] transition-colors"
              style={{
                background: isCurrent ? "var(--surface-1)" : "transparent",
                color: isCurrent ? "var(--text-1)" : "var(--text-2)",
                fontWeight: isCurrent ? 600 : 500,
                boxShadow: isCurrent ? "var(--shadow-card)" : "none",
              }}
            >
              <span>{t.label}</span>
              {countHint != null ? (
                <span className="tnum rounded-full border border-line-faint bg-surface-0 px-1.5 py-0.2 font-mono text-[10px] text-tone-3">
                  {countHint}
                </span>
              ) : null}
            </Link>
          );
        })}
      </nav>

      {activeTab === "stations" ? (
        <Panel
          title="İŞ İSTASYONLARI VE TEZGÂH GRUPLARI (WORK CENTERS)"
          subtitle="Operasyon tipi, makine sayısı, vardiya rejimi, hedef OEE %, enerji tüketimi (kW) ve standart TL/dk maliyet"
          right={<Badge tone="blue">{workCenters.activeCount} aktif istasyon</Badge>}
        >
          <div className="space-y-3">
            {canEditWorkCenters ? (
              <form
                action={upsertWorkCenterAction}
                className="grid grid-cols-1 gap-2 rounded border p-3 text-xs sm:grid-cols-5"
                style={{ borderColor: "var(--line-faint)", background: "var(--surface-2)" }}
              >
                <input type="hidden" name="backTo" value="/production?tab=stations" />
                <input
                  name="code"
                  required
                  placeholder="İstasyon kodu (örn. WC-TRN-01)"
                  className="rounded border px-2 py-1.5"
                  style={{ borderColor: "var(--line)", background: "var(--surface-1)", color: "var(--text-1)" }}
                />
                <input
                  name="name"
                  required
                  placeholder="İstasyon adı (örn. CNC Torna Hattı)"
                  className="rounded border px-2 py-1.5 sm:col-span-2"
                  style={{ borderColor: "var(--line)", background: "var(--surface-1)", color: "var(--text-1)" }}
                />
                <select
                  name="operationType"
                  defaultValue="torna"
                  className="rounded border px-2 py-1.5"
                  style={{ borderColor: "var(--line)", background: "var(--surface-1)", color: "var(--text-1)" }}
                >
                  {WORK_CENTER_OPERATION_TYPES.map((op) => (
                    <option key={op} value={op}>
                      {OPERATION_TYPE_LABEL[op]}
                    </option>
                  ))}
                </select>
                <input
                  name="machineCount"
                  type="number"
                  step="1"
                  min="1"
                  defaultValue="2"
                  required
                  placeholder="Tezgâh adedi"
                  className="rounded border px-2 py-1.5"
                  style={{ borderColor: "var(--line)", background: "var(--surface-1)", color: "var(--text-1)" }}
                />
                <input
                  name="shiftsPerDay"
                  type="number"
                  min="1"
                  max="3"
                  defaultValue="2"
                  required
                  placeholder="Vardiya / gün (1-3)"
                  className="rounded border px-2 py-1.5"
                  style={{ borderColor: "var(--line)", background: "var(--surface-1)", color: "var(--text-1)" }}
                />
                <input
                  name="shiftMinutes"
                  type="number"
                  min="60"
                  max="720"
                  defaultValue="480"
                  required
                  placeholder="Vardiya süresi (dk)"
                  className="rounded border px-2 py-1.5"
                  style={{ borderColor: "var(--line)", background: "var(--surface-1)", color: "var(--text-1)" }}
                />
                <input
                  name="workingDaysPerMonth"
                  type="number"
                  min="1"
                  max="31"
                  defaultValue="22"
                  required
                  placeholder="Çalışma günü / ay"
                  className="rounded border px-2 py-1.5"
                  style={{ borderColor: "var(--line)", background: "var(--surface-1)", color: "var(--text-1)" }}
                />
                <input
                  name="targetOeePct"
                  type="number"
                  step="0.5"
                  min="1"
                  max="100"
                  defaultValue="80"
                  required
                  placeholder="Hedef OEE % (örn. 80)"
                  className="rounded border px-2 py-1.5"
                  style={{ borderColor: "var(--line)", background: "var(--surface-1)", color: "var(--text-1)" }}
                />
                <input
                  name="hourlyPowerKw"
                  type="number"
                  step="0.1"
                  min="0"
                  placeholder="Saatlik güç (kW)"
                  className="rounded border px-2 py-1.5"
                  style={{ borderColor: "var(--line)", background: "var(--surface-1)", color: "var(--text-1)" }}
                />
                <input
                  name="standardRatePerMinTry"
                  type="number"
                  step="0.01"
                  min="0"
                  placeholder="Standart tarife (TL/dk)"
                  className="rounded border px-2 py-1.5 sm:col-span-2"
                  style={{ borderColor: "var(--line)", background: "var(--surface-1)", color: "var(--text-1)" }}
                />
                <SubmitButton
                  pendingLabel="Kaydediliyor…"
                  className="rounded border px-3 py-1.5 font-mono text-xs font-semibold sm:col-span-3"
                  style={{ borderColor: "var(--line)", background: "var(--surface-1)", color: "var(--text-1)" }}
                >
                  İş İstasyonu Ekle / Güncelle
                </SubmitButton>
              </form>
            ) : null}

            {workCenters.items.length === 0 ? (
              <EmptyState>
                Henüz iş istasyonu tanımlanmamış. Yukarıdaki formdan CNC Torna, CNC Freze, Taşlama, Lazer vb. istasyonları tanımlayın.
              </EmptyState>
            ) : (
              <TableShell>
                <table className="w-full border-collapse text-left text-xs">
                  <thead>
                    <tr
                      className="border-b font-mono text-[10px] uppercase"
                      style={{ borderColor: "var(--line)", color: "var(--text-3)" }}
                    >
                      <th className="py-2 pr-2">Kod & İstasyon</th>
                      <th className="py-2 px-2">Operasyon</th>
                      <th className="py-2 px-2 text-right">Tezgâh × Vardiya</th>
                      <th className="py-2 px-2 text-right">Hedef OEE</th>
                      <th className="py-2 px-2 text-right">Etkin Dk/Ay</th>
                      <th className="py-2 px-2 text-right">Enerji (kWh/Ay)</th>
                      <th className="py-2 px-2 text-right">Std. TL/dk</th>
                      <th className="py-2 px-2 text-right">Teorik Gelir/Ay</th>
                      <th className="py-2 pl-2 text-right">Durum</th>
                    </tr>
                  </thead>
                  <tbody>
                    {workCenters.items.map((wc) => (
                      <tr
                        key={wc.id}
                        className="border-b"
                        style={{ borderColor: "var(--line-faint)", color: "var(--text-1)" }}
                      >
                        <td className="py-2 pr-2 font-mono">
                          <b>{wc.code}</b> · {wc.name}
                        </td>
                        <td className="py-2 px-2">{OPERATION_TYPE_LABEL[wc.operationType]}</td>
                        <td className="py-2 px-2 text-right font-mono tabular-nums">
                          {wc.machineCount} × {wc.shiftsPerDay}V ({wc.shiftMinutes} dk · {wc.workingDaysPerMonth}g)
                        </td>
                        <td className="py-2 px-2 text-right font-mono tabular-nums">%{wc.targetOeePct.toFixed(1)}</td>
                        <td className="py-2 px-2 text-right font-mono font-semibold tabular-nums">
                          {wc.targetEffectiveMinutes.toLocaleString("tr-TR")}
                        </td>
                        <td className="py-2 px-2 text-right font-mono tabular-nums">
                          {wc.estimatedMonthlyEnergyKwh != null
                            ? wc.estimatedMonthlyEnergyKwh.toLocaleString("tr-TR")
                            : "—"}
                        </td>
                        <td className="py-2 px-2 text-right font-mono tabular-nums">
                          {fmtTlPerMin(wc.standardRatePerMinTry)}
                        </td>
                        <td className="py-2 px-2 text-right font-mono tabular-nums">
                          {wc.theoreticalMonthlyRevenueTry != null ? fmtTL(wc.theoreticalMonthlyRevenueTry) : "—"}
                        </td>
                        <td className="py-2 pl-2 text-right">
                          {canEditWorkCenters ? (
                            <form action={toggleWorkCenterActiveAction} className="inline">
                              <input type="hidden" name="backTo" value="/production?tab=stations" />
                              <input type="hidden" name="id" value={wc.id} />
                              <input type="hidden" name="isActive" value={wc.isActive ? "false" : "true"} />
                              <button
                                type="submit"
                                className="rounded border px-2 py-0.5 font-mono text-[10px]"
                                style={{
                                  borderColor: "var(--line)",
                                  background: "var(--surface-2)",
                                  color: wc.isActive ? "var(--pos)" : "var(--text-3)",
                                }}
                              >
                                {wc.isActive ? "Aktif" : "Pasif"}
                              </button>
                            </form>
                          ) : (
                            <Badge tone={wc.isActive ? "green" : "neutral"}>{wc.isActive ? "Aktif" : "Pasif"}</Badge>
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
      ) : null}

      {activeTab === "inventory" ? (
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2 lg:grid-cols-5">
            <KpiCard label="150 İlk Madde & Malzeme" value={fmtTL(inventory.tdhp150RawTry)} tone="info" />
            <KpiCard label="151 Yarı Mamul (Üretim)" value={fmtTL(inventory.tdhp151WipTry)} />
            <KpiCard label="152 Mamul Stok" value={fmtTL(inventory.tdhp152FinishedTry)} tone="pos" />
            <KpiCard
              label="Stokta Kalma Süresi (DIO)"
              value={wcMetrics.dioDays != null ? `${wcMetrics.dioDays.toFixed(1)} gün` : "—"}
              note="working_capital_metrics canlı görünüm"
            />
            <KpiCard
              label="Nakit Dönüşüm Döngüsü (CCC)"
              value={wcMetrics.cashConversionCycleDays != null ? `${wcMetrics.cashConversionCycleDays.toFixed(1)} gün` : "—"}
              tone="info"
              note={`DSO: ${wcMetrics.dsoDays ?? "—"}g · DPO: ${wcMetrics.dpoDays ?? "—"}g`}
            />
          </div>

          <Panel
            title="TDHP 150 / 151 / 152 STOK KARTLARI VE STOK HAREKET GİRİŞİ"
            subtitle="Stok girişi, üretime sevk (150→710), mamul girişi ve sevkiyat hareketleri anında stok bakiyesini ve canlı DIO/CCC metriklerini günceller"
          >
            <div className="space-y-3">
              {canEditInventoryItems ? (
                <details className="rounded border p-2.5" style={{ borderColor: "var(--line-faint)", background: "var(--surface-2)" }}>
                  <summary className="cursor-pointer font-mono text-xs font-semibold" style={{ color: "var(--text-1)" }}>
                    + Yeni TDHP Stok Kartı (150 Hammadde / 151 Yarı Mamul / 152 Mamul) Tanımla
                  </summary>
                  <form action={upsertInventoryItemAction} className="mt-2 grid grid-cols-1 gap-2 text-xs sm:grid-cols-5">
                    <input type="hidden" name="backTo" value="/production?tab=inventory" />
                    <input
                      name="sku"
                      required
                      placeholder="Stok Kodu SKU (örn. HM-4140-50)"
                      className="rounded border px-2 py-1.5"
                      style={{ borderColor: "var(--line)", background: "var(--surface-1)", color: "var(--text-1)" }}
                    />
                    <input
                      name="name"
                      required
                      placeholder="Stok kalemi adı (örn. Çelik Mil Ø50)"
                      className="rounded border px-2 py-1.5 sm:col-span-2"
                      style={{ borderColor: "var(--line)", background: "var(--surface-1)", color: "var(--text-1)" }}
                    />
                    <select
                      name="itemType"
                      defaultValue="raw_material"
                      className="rounded border px-2 py-1.5"
                      style={{ borderColor: "var(--line)", background: "var(--surface-1)", color: "var(--text-1)" }}
                    >
                      {INVENTORY_ITEM_TYPES.map((it) => (
                        <option key={it} value={it}>
                          {ITEM_TYPE_LABEL[it]}
                        </option>
                      ))}
                    </select>
                    <select
                      name="tdhpAccountCode"
                      defaultValue="150"
                      className="rounded border px-2 py-1.5"
                      style={{ borderColor: "var(--line)", background: "var(--surface-1)", color: "var(--text-1)" }}
                    >
                      {TDHP_INVENTORY_ACCOUNTS.map((acc) => (
                        <option key={acc} value={acc}>
                          TDHP {acc}
                        </option>
                      ))}
                    </select>
                    <input
                      name="unit"
                      defaultValue="kg"
                      required
                      placeholder="Birim (kg, adet, mt)"
                      className="rounded border px-2 py-1.5"
                      style={{ borderColor: "var(--line)", background: "var(--surface-1)", color: "var(--text-1)" }}
                    />
                    <div className="flex gap-1">
                      <input
                        name="standardUnitCost"
                        type="number"
                        step="0.0001"
                        min="0"
                        required
                        placeholder="Std. Birim Maliyet"
                        className="w-full rounded border px-2 py-1.5"
                        style={{ borderColor: "var(--line)", background: "var(--surface-1)", color: "var(--text-1)" }}
                      />
                      <select
                        name="currency"
                        defaultValue="TRY"
                        className="rounded border px-2 py-1.5"
                        style={{ borderColor: "var(--line)", background: "var(--surface-1)", color: "var(--text-1)" }}
                      >
                        <option value="TRY">TRY</option>
                        <option value="USD">USD</option>
                        <option value="EUR">EUR</option>
                      </select>
                    </div>
                    <input
                      name="onHandQty"
                      type="number"
                      step="0.01"
                      min="0"
                      defaultValue="0"
                      placeholder="Açılış stok miktarı"
                      className="rounded border px-2 py-1.5"
                      style={{ borderColor: "var(--line)", background: "var(--surface-1)", color: "var(--text-1)" }}
                    />
                    <input
                      name="reorderPoint"
                      type="number"
                      step="0.01"
                      min="0"
                      defaultValue="0"
                      placeholder="Kritik stok eşiği"
                      className="rounded border px-2 py-1.5"
                      style={{ borderColor: "var(--line)", background: "var(--surface-1)", color: "var(--text-1)" }}
                    />
                    <SubmitButton
                      pendingLabel="Kaydediliyor…"
                      className="rounded border px-3 py-1.5 font-mono text-xs font-semibold"
                      style={{ borderColor: "var(--line)", background: "var(--surface-1)", color: "var(--text-1)" }}
                    >
                      Stok Kartını Kaydet
                    </SubmitButton>
                  </form>
                </details>
              ) : null}

              {canRecordMovements && inventory.items.length > 0 ? (
                <form
                  action={recordInventoryMovementAction}
                  className="grid grid-cols-1 gap-2 rounded border p-3 text-xs sm:grid-cols-6"
                  style={{ borderColor: "var(--line)", background: "var(--surface-2)" }}
                >
                  <input type="hidden" name="backTo" value="/production?tab=inventory" />
                  <select
                    name="itemId"
                    required
                    defaultValue=""
                    className="rounded border px-2 py-1.5 sm:col-span-2"
                    style={{ borderColor: "var(--line)", background: "var(--surface-1)", color: "var(--text-1)" }}
                  >
                    <option value="" disabled>
                      Stok kalemi seçin
                    </option>
                    {inventory.items.map((it) => (
                      <option key={it.id} value={it.id}>
                        [{it.tdhpAccountCode}] {it.sku} · {it.name} (Mevcut: {it.onHandQty} {it.unit})
                      </option>
                    ))}
                  </select>
                  <select
                    name="movementType"
                    defaultValue="receipt"
                    className="rounded border px-2 py-1.5"
                    style={{ borderColor: "var(--line)", background: "var(--surface-1)", color: "var(--text-1)" }}
                  >
                    {INVENTORY_MOVEMENT_TYPES.map((mt) => (
                      <option key={mt} value={mt}>
                        {MOVEMENT_TYPE_LABEL[mt]}
                      </option>
                    ))}
                  </select>
                  <input
                    name="qty"
                    type="number"
                    step="0.0001"
                    required
                    placeholder="Miktar"
                    className="rounded border px-2 py-1.5"
                    style={{ borderColor: "var(--line)", background: "var(--surface-1)", color: "var(--text-1)" }}
                  />
                  <input
                    name="unitCost"
                    type="number"
                    step="0.0001"
                    min="0"
                    placeholder="Birim fiyat (boşsa std)"
                    className="rounded border px-2 py-1.5"
                    style={{ borderColor: "var(--line)", background: "var(--surface-1)", color: "var(--text-1)" }}
                  />
                  <SubmitButton
                    pendingLabel="İşleniyor…"
                    className="rounded border px-3 py-1.5 font-mono text-xs font-semibold"
                    style={{ borderColor: "var(--line)", background: "var(--surface-1)", color: "var(--text-1)" }}
                  >
                    Stok Hareketini İşle
                  </SubmitButton>
                </form>
              ) : null}

              {inventory.items.length === 0 ? (
                <EmptyState>Henüz TDHP stok kartı bulunmuyor.</EmptyState>
              ) : (
                <TableShell>
                  <table className="w-full border-collapse text-left text-xs">
                    <thead>
                      <tr
                        className="border-b font-mono text-[10px] uppercase"
                        style={{ borderColor: "var(--line)", color: "var(--text-3)" }}
                      >
                        <th className="py-2 pr-2">TDHP / SKU</th>
                        <th className="py-2 px-2">Kalem Adı</th>
                        <th className="py-2 px-2 text-right">Eldeki Miktar</th>
                        <th className="py-2 px-2 text-right">Birim Maliyet</th>
                        <th className="py-2 px-2 text-right">Toplam Değer (TL)</th>
                        <th className="py-2 pl-2">Stok Durumu</th>
                      </tr>
                    </thead>
                    <tbody>
                      {inventory.items.map((it) => (
                        <tr
                          key={it.id}
                          className="border-b"
                          style={{ borderColor: "var(--line-faint)", color: "var(--text-1)" }}
                        >
                          <td className="py-1.5 pr-2 font-mono">
                            <Badge tone="neutral">{it.tdhpAccountCode}</Badge> {it.sku}
                          </td>
                          <td className="py-1.5 px-2">{it.name}</td>
                          <td className="py-1.5 px-2 text-right font-mono tabular-nums">
                            {it.onHandQty.toLocaleString("tr-TR")} {it.unit}
                          </td>
                          <td className="py-1.5 px-2 text-right font-mono tabular-nums">
                            {it.standardUnitCost.toLocaleString("tr-TR", { minimumFractionDigits: 2 })}{" "}
                            {it.currency}
                          </td>
                          <td className="py-1.5 px-2 text-right font-mono font-semibold tabular-nums">
                            {it.stockValueTry != null ? fmtTL(it.stockValueTry) : "Kur eksik"}
                          </td>
                          <td className="py-1.5 pl-2">
                            {it.belowReorderPoint ? (
                              <Badge tone="red">Kritik Eşik ({it.reorderPoint} {it.unit})</Badge>
                            ) : (
                              <Badge tone="green">Yeterli</Badge>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableShell>
              )}

              {inventory.recentMovements.length > 0 ? (
                <div className="pt-2">
                  <div className="mb-1.5 font-mono text-xs font-semibold" style={{ color: "var(--text-2)" }}>
                    SON STOK HAREKETLERİ ({inventory.recentMovements.length})
                  </div>
                  <TableShell>
                    <table className="w-full border-collapse text-left text-xs">
                      <thead>
                        <tr
                          className="border-b font-mono text-[10px] uppercase"
                          style={{ borderColor: "var(--line)", color: "var(--text-3)" }}
                        >
                          <th className="py-1.5 pr-2">Tarih</th>
                          <th className="py-1.5 px-2">SKU · Kalem</th>
                          <th className="py-1.5 px-2">Hareket Tipi</th>
                          <th className="py-1.5 px-2 text-right">Net Değişim</th>
                          <th className="py-1.5 pl-2 text-right">Tutar (TL)</th>
                        </tr>
                      </thead>
                      <tbody>
                        {inventory.recentMovements.slice(0, 15).map((mv) => (
                          <tr
                            key={mv.id}
                            className="border-b"
                            style={{ borderColor: "var(--line-faint)", color: "var(--text-1)" }}
                          >
                            <td className="py-1.5 pr-2 font-mono">{mv.occurredOn}</td>
                            <td className="py-1.5 px-2">
                              <span className="font-mono">{mv.sku}</span> · {mv.itemName}
                            </td>
                            <td className="py-1.5 px-2">{MOVEMENT_TYPE_LABEL[mv.movementType]}</td>
                            <td
                              className="py-1.5 px-2 text-right font-mono tabular-nums"
                              style={{ color: mv.signedQtyDelta >= 0 ? "var(--pos)" : "var(--neg)" }}
                            >
                              {mv.signedQtyDelta > 0 ? `+${mv.signedQtyDelta}` : mv.signedQtyDelta}
                            </td>
                            <td className="py-1.5 pl-2 text-right font-mono tabular-nums">
                              {fmtTL(mv.valueTry)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </TableShell>
                </div>
              ) : null}
            </div>
          </Panel>
        </div>
      ) : null}

      {activeTab === "bom" ? (
        <Panel
          title="ÜRÜN AĞACI VE REÇETE YÖNETİMİ (BOM · TDHP 710 DİREKT İLK MADDE)"
          subtitle="Parça başına hammadde sarfiyatı, fire yüzdesi (scrap_pct), fason maliyet ve ithal girdi kur hassasiyeti"
          right={<Badge tone="blue">{bomOverview.boms.length} aktif BOM</Badge>}
        >
          <div className="space-y-3">
            {canEditBom ? (
              <form
                action={addBomLineAction}
                className="grid grid-cols-1 gap-2 rounded border p-3 text-xs sm:grid-cols-5"
                style={{ borderColor: "var(--line-faint)", background: "var(--surface-2)" }}
              >
                <input type="hidden" name="backTo" value="/production?tab=bom" />
                <select
                  name="partId"
                  required
                  defaultValue=""
                  className="rounded border px-2 py-1.5 sm:col-span-2"
                  style={{ borderColor: "var(--line)", background: "var(--surface-1)", color: "var(--text-1)" }}
                >
                  <option value="" disabled>
                    Üretim parçası seçin
                  </option>
                  {allParts.map((pt) => (
                    <option key={pt.id} value={pt.id}>
                      {pt.partCode ? `${pt.partCode} · ` : ""}{pt.partName}
                    </option>
                  ))}
                </select>
                <select
                  name="rawMaterialItemId"
                  defaultValue=""
                  className="rounded border px-2 py-1.5 sm:col-span-2"
                  style={{ borderColor: "var(--line)", background: "var(--surface-1)", color: "var(--text-1)" }}
                >
                  <option value="">Stok kartından seçin (opsiyonel)</option>
                  {inventory.items.map((it) => (
                    <option key={it.id} value={it.id}>
                      {it.sku} · {it.name} ({it.standardUnitCost} {it.currency}/{it.unit})
                    </option>
                  ))}
                </select>
                <input
                  name="versionCode"
                  defaultValue="V1"
                  placeholder="Versiyon (V1)"
                  className="rounded border px-2 py-1.5"
                  style={{ borderColor: "var(--line)", background: "var(--surface-1)", color: "var(--text-1)" }}
                />
                <input
                  name="materialLabel"
                  required
                  placeholder="Malzeme / operasyon açıklaması"
                  className="rounded border px-2 py-1.5 sm:col-span-2"
                  style={{ borderColor: "var(--line)", background: "var(--surface-1)", color: "var(--text-1)" }}
                />
                <input
                  name="qtyPerUnit"
                  type="number"
                  step="0.0001"
                  min="0.0001"
                  required
                  placeholder="Net sarf / adet"
                  className="rounded border px-2 py-1.5"
                  style={{ borderColor: "var(--line)", background: "var(--surface-1)", color: "var(--text-1)" }}
                />
                <input
                  name="scrapPct"
                  type="number"
                  step="0.1"
                  min="0"
                  max="99"
                  defaultValue="5"
                  placeholder="Fire % (örn. 5)"
                  className="rounded border px-2 py-1.5"
                  style={{ borderColor: "var(--line)", background: "var(--surface-1)", color: "var(--text-1)" }}
                />
                <div className="flex gap-1">
                  <input
                    name="unitCostOverride"
                    type="number"
                    step="0.0001"
                    min="0"
                    placeholder="Birim fiyat (ops.)"
                    className="w-full rounded border px-2 py-1.5"
                    style={{ borderColor: "var(--line)", background: "var(--surface-1)", color: "var(--text-1)" }}
                  />
                  <select
                    name="currency"
                    defaultValue="TRY"
                    className="rounded border px-2 py-1.5"
                    style={{ borderColor: "var(--line)", background: "var(--surface-1)", color: "var(--text-1)" }}
                  >
                    <option value="TRY">TRY</option>
                    <option value="USD">USD</option>
                    <option value="EUR">EUR</option>
                  </select>
                </div>
                <select
                  name="workCenterId"
                  defaultValue=""
                  className="rounded border px-2 py-1.5"
                  style={{ borderColor: "var(--line)", background: "var(--surface-1)", color: "var(--text-1)" }}
                >
                  <option value="">İstasyon (opsiyonel)</option>
                  {workCenters.items.map((wc) => (
                    <option key={wc.id} value={wc.id}>
                      {wc.code} · {wc.name}
                    </option>
                  ))}
                </select>
                <input
                  name="stdSetupMinutes"
                  type="number"
                  step="0.1"
                  min="0"
                  defaultValue="0"
                  placeholder="Hazırlık (Setup) dk"
                  className="rounded border px-2 py-1.5"
                  style={{ borderColor: "var(--line)", background: "var(--surface-1)", color: "var(--text-1)" }}
                />
                <input
                  name="stdRunMinutes"
                  type="number"
                  step="0.1"
                  min="0"
                  defaultValue="0"
                  placeholder="Birim işleme dk"
                  className="rounded border px-2 py-1.5"
                  style={{ borderColor: "var(--line)", background: "var(--surface-1)", color: "var(--text-1)" }}
                />
                <input
                  name="subcontractCostPerUnit"
                  type="number"
                  step="0.01"
                  min="0"
                  defaultValue="0"
                  placeholder="Fason / adet (TL)"
                  className="rounded border px-2 py-1.5"
                  style={{ borderColor: "var(--line)", background: "var(--surface-1)", color: "var(--text-1)" }}
                />
                <SubmitButton
                  pendingLabel="Ekleniyor…"
                  className="rounded border px-3 py-1.5 font-mono text-xs font-semibold"
                  style={{ borderColor: "var(--line)", background: "var(--surface-1)", color: "var(--text-1)" }}
                >
                  BOM Satırını Kaydet
                </SubmitButton>
              </form>
            ) : null}

            {bomOverview.boms.length === 0 ? (
              <EmptyState>
                Henüz reçete (BOM) tanımlanmamış. Parçalarınıza hammadde kalemlerini ve fire yüzdesini ekleyerek TDHP 710 birim malzeme maliyetini otomatik hesaplatabilirsiniz.
              </EmptyState>
            ) : (
              bomOverview.boms.map((b) => (
                <div
                  key={b.id}
                  className="rounded border p-3 text-xs"
                  style={{ borderColor: "var(--line)", background: "var(--surface-1)" }}
                >
                  <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <b className="font-mono">
                        {b.partCode ? `${b.partCode} · ` : ""}{b.partName}
                      </b>{" "}
                      <Badge tone="neutral">{b.versionCode}</Badge>
                    </div>
                    <div className="flex flex-wrap items-center gap-2 font-mono">
                      <span>710 Toplam/Adet: <b>{fmtTL(b.totalBom710PerUnitTry)}</b></span>
                      {b.fxSensitivePerUnitTry > 0 ? (
                        <Badge tone="amber">Döviz Duyarlı: {fmtTL(b.fxSensitivePerUnitTry)}/adet</Badge>
                      ) : null}
                    </div>
                  </div>
                  <TableShell>
                    <table className="w-full border-collapse text-left text-xs">
                      <thead>
                        <tr
                          className="border-b font-mono text-[10px] uppercase"
                          style={{ borderColor: "var(--line-faint)", color: "var(--text-3)" }}
                        >
                          <th className="py-1 pr-2">#</th>
                          <th className="py-1 px-2">Malzeme / Operasyon</th>
                          <th className="py-1 px-2 text-right">Net × (1+Fire%)</th>
                          <th className="py-1 px-2 text-right">Birim Fiyat</th>
                          <th className="py-1 px-2 text-right">710 Satır Tutarı (TL)</th>
                          <th className="py-1 px-2 text-right">Std. Dk/Adet</th>
                          {canDeleteBom ? <th className="py-1 pl-2 text-right">Sil</th> : null}
                        </tr>
                      </thead>
                      <tbody>
                        {b.lines.map((ln) => (
                          <tr key={ln.id ?? `${b.id}-${ln.lineNo}`} className="border-b" style={{ borderColor: "var(--line-faint)" }}>
                            <td className="py-1 pr-2 font-mono">{ln.lineNo}</td>
                            <td className="py-1 px-2">
                              {ln.materialLabel}
                              {ln.workCenterCode ? ` (${ln.workCenterCode})` : ""}
                            </td>
                            <td className="py-1 px-2 text-right font-mono tabular-nums">
                              {ln.qtyPerUnit} (+%{ln.scrapPct}) = {ln.grossQtyPerUnit.toFixed(3)}
                            </td>
                            <td className="py-1 px-2 text-right font-mono tabular-nums">
                              {ln.effectiveUnitCostNative != null
                                ? `${ln.effectiveUnitCostNative.toFixed(2)} ${ln.currency}`
                                : "—"}
                            </td>
                            <td className="py-1 px-2 text-right font-mono font-semibold tabular-nums">
                              {fmtTL(ln.lineMaterialCostTry)}
                            </td>
                            <td className="py-1 px-2 text-right font-mono tabular-nums">
                              {ln.effectiveMinutesPerUnit.toFixed(2)} dk
                            </td>
                            {canDeleteBom && ln.id ? (
                              <td className="py-1 pl-2 text-right">
                                <form action={deleteBomLineAction} className="inline">
                                  <input type="hidden" name="backTo" value="/production?tab=bom" />
                                  <input type="hidden" name="lineId" value={ln.id} />
                                  <button
                                    type="submit"
                                    className="font-mono text-[10px] underline"
                                    style={{ color: "var(--neg)" }}
                                  >
                                    Sil
                                  </button>
                                </form>
                              </td>
                            ) : null}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </TableShell>
                </div>
              ))
            )}
          </div>
        </Panel>
      ) : null}

      {activeTab === "workorders" ? (
        <Panel
          title="İŞ EMİRLERİ VE CANLI OEE (AVAILABILITY × PERFORMANCE × QUALITY)"
          subtitle="İş emri planlama, başlatma, tamamlama, duruş (downtime) kaydı ve istasyon bazlı canlı OEE takibi"
          right={
            <Badge tone={plantOee.oeePct != null && plantOee.oeePct >= 75 ? "green" : "amber"}>
              Tesis OEE: {plantOee.oeePct != null ? `%${plantOee.oeePct.toFixed(1)}` : "—"}
            </Badge>
          }
        >
          <div className="space-y-3">
            {canCreateWorkOrders && workCenters.items.length > 0 ? (
              <form
                action={createWorkOrderAction}
                className="grid grid-cols-1 gap-2 rounded border p-3 text-xs sm:grid-cols-6"
                style={{ borderColor: "var(--line-faint)", background: "var(--surface-2)" }}
              >
                <input type="hidden" name="backTo" value="/production?tab=workorders" />
                <input
                  name="orderNo"
                  required
                  placeholder="İş Emri No (örn. WO-2026-001)"
                  className="rounded border px-2 py-1.5"
                  style={{ borderColor: "var(--line)", background: "var(--surface-1)", color: "var(--text-1)" }}
                />
                <select
                  name="workCenterId"
                  required
                  defaultValue=""
                  className="rounded border px-2 py-1.5"
                  style={{ borderColor: "var(--line)", background: "var(--surface-1)", color: "var(--text-1)" }}
                >
                  <option value="" disabled>
                    İstasyon seçin
                  </option>
                  {workCenters.items.filter((w) => w.isActive).map((wc) => (
                    <option key={wc.id} value={wc.id}>
                      {wc.code} · {wc.name}
                    </option>
                  ))}
                </select>
                <select
                  name="partId"
                  defaultValue=""
                  className="rounded border px-2 py-1.5"
                  style={{ borderColor: "var(--line)", background: "var(--surface-1)", color: "var(--text-1)" }}
                >
                  <option value="">Parça seçin (ops.)</option>
                  {allParts.map((pt) => (
                    <option key={pt.id} value={pt.id}>
                      {pt.partCode ? `${pt.partCode} · ` : ""}{pt.partName}
                    </option>
                  ))}
                </select>
                <input
                  name="plannedQty"
                  type="number"
                  step="1"
                  min="1"
                  required
                  placeholder="Planlanan Adet"
                  className="rounded border px-2 py-1.5"
                  style={{ borderColor: "var(--line)", background: "var(--surface-1)", color: "var(--text-1)" }}
                />
                <input
                  name="plannedMinutes"
                  type="number"
                  step="1"
                  min="1"
                  required
                  placeholder="Planlanan Süre (Dk)"
                  className="rounded border px-2 py-1.5"
                  style={{ borderColor: "var(--line)", background: "var(--surface-1)", color: "var(--text-1)" }}
                />
                <SubmitButton
                  pendingLabel="Açılıyor…"
                  className="rounded border px-3 py-1.5 font-mono text-xs font-semibold"
                  style={{ borderColor: "var(--line)", background: "var(--surface-1)", color: "var(--text-1)" }}
                >
                  İş Emri Aç
                </SubmitButton>
              </form>
            ) : null}

            {woOverview.orders.length === 0 ? (
              <EmptyState>
                Henüz kayıtlı iş emri bulunmuyor. Önce iş istasyonu tanımlayıp ardından iş emri açarak canlı OEE takibini başlatabilirsiniz.
              </EmptyState>
            ) : (
              <TableShell>
                <table className="w-full border-collapse text-left text-xs">
                  <thead>
                    <tr
                      className="border-b font-mono text-[10px] uppercase"
                      style={{ borderColor: "var(--line)", color: "var(--text-3)" }}
                    >
                      <th className="py-2 pr-2">İş Emri</th>
                      <th className="py-2 px-2">İstasyon / Parça</th>
                      <th className="py-2 px-2 text-right">Plan / Sağlam / Fire</th>
                      <th className="py-2 px-2 text-right">Plan / Fiili / Duruş Dk</th>
                      <th className="py-2 px-2 text-right">OEE (A×P×Q)</th>
                      <th className="py-2 px-2">Durum</th>
                      {canUpdateWorkOrders ? <th className="py-2 pl-2">Üretim Güncelle</th> : null}
                    </tr>
                  </thead>
                  <tbody>
                    {woOverview.orders.map((wo) => (
                      <tr
                        key={wo.id}
                        className="border-b"
                        style={{ borderColor: "var(--line-faint)", color: "var(--text-1)" }}
                      >
                        <td className="py-2 pr-2 font-mono font-semibold">{wo.orderNo}</td>
                        <td className="py-2 px-2">
                          <span className="font-mono">{wo.workCenterCode}</span>
                          {wo.partName ? ` · ${wo.partName}` : ""}
                        </td>
                        <td className="py-2 px-2 text-right font-mono tabular-nums">
                          {wo.plannedQty} / <span style={{ color: "var(--pos)" }}>{wo.goodQty}</span> /{" "}
                          <span style={{ color: wo.scrapQty > 0 ? "var(--neg)" : "var(--text-3)" }}>{wo.scrapQty}</span>
                        </td>
                        <td className="py-2 px-2 text-right font-mono tabular-nums">
                          {wo.plannedMinutes} / {wo.actualRunMinutes} / {wo.downtimeMinutes} dk
                        </td>
                        <td className="py-2 px-2 text-right font-mono font-semibold tabular-nums">
                          {wo.oeePct != null ? `%${wo.oeePct.toFixed(1)}` : "—"}
                        </td>
                        <td className="py-2 px-2">
                          <Badge
                            tone={
                              wo.status === "completed"
                                ? "green"
                                : wo.status === "in_progress"
                                  ? "blue"
                                  : wo.status === "cancelled"
                                    ? "red"
                                    : "amber"
                            }
                          >
                            {WORK_ORDER_STATUS_LABEL[wo.status]}
                          </Badge>
                        </td>
                        {canUpdateWorkOrders ? (
                          <td className="py-2 pl-2">
                            {wo.status === "planned" || wo.status === "in_progress" ? (
                              <form action={transitionWorkOrderStatusAction} className="flex flex-wrap items-center gap-1">
                                <input type="hidden" name="backTo" value="/production?tab=workorders" />
                                <input type="hidden" name="workOrderId" value={wo.id} />
                                <input
                                  name="goodQty"
                                  type="number"
                                  min="0"
                                  defaultValue={wo.goodQty || wo.plannedQty}
                                  placeholder="Sağlam"
                                  className="w-16 rounded border px-1 py-0.5 font-mono text-[11px]"
                                  style={{ borderColor: "var(--line)", background: "var(--surface-1)", color: "var(--text-1)" }}
                                />
                                <input
                                  name="scrapQty"
                                  type="number"
                                  min="0"
                                  defaultValue={wo.scrapQty}
                                  placeholder="Fire"
                                  className="w-14 rounded border px-1 py-0.5 font-mono text-[11px]"
                                  style={{ borderColor: "var(--line)", background: "var(--surface-1)", color: "var(--text-1)" }}
                                />
                                <input
                                  name="actualRunMinutes"
                                  type="number"
                                  min="0"
                                  defaultValue={wo.actualRunMinutes || wo.plannedMinutes}
                                  placeholder="Fiili dk"
                                  className="w-16 rounded border px-1 py-0.5 font-mono text-[11px]"
                                  style={{ borderColor: "var(--line)", background: "var(--surface-1)", color: "var(--text-1)" }}
                                />
                                <input
                                  name="downtimeMinutes"
                                  type="number"
                                  min="0"
                                  defaultValue={wo.downtimeMinutes}
                                  placeholder="Duruş dk"
                                  className="w-16 rounded border px-1 py-0.5 font-mono text-[11px]"
                                  style={{ borderColor: "var(--line)", background: "var(--surface-1)", color: "var(--text-1)" }}
                                />
                                <select
                                  name="nextStatus"
                                  defaultValue={wo.status === "planned" ? "in_progress" : "completed"}
                                  className="rounded border px-1 py-0.5 font-mono text-[11px]"
                                  style={{ borderColor: "var(--line)", background: "var(--surface-1)", color: "var(--text-1)" }}
                                >
                                  {wo.status === "planned" ? <option value="in_progress">Başlat</option> : null}
                                  <option value="completed">Tamamla</option>
                                  <option value="cancelled">İptal</option>
                                </select>
                                <button
                                  type="submit"
                                  className="rounded border px-2 py-0.5 font-mono text-[11px]"
                                  style={{ borderColor: "var(--line)", background: "var(--surface-2)", color: "var(--text-1)" }}
                                >
                                  Uygula
                                </button>
                              </form>
                            ) : (
                              <span className="font-mono text-[11px]" style={{ color: "var(--text-3)" }}>
                                Kapandı
                              </span>
                            )}
                          </td>
                        ) : null}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableShell>
            )}
          </div>
        </Panel>
      ) : null}

      {activeTab === "rates" ? (
        <Panel
          title="MÜŞTERİ TARİFE KARTLARI (MULTI-CUSTOMER · MULTI-CURRENCY RATE CARDS)"
          subtitle="Müşteri, operasyon ve iş istasyonu bazında TRY / USD / EUR dakika satış tarifeleri ve TCMB TL karşılıkları"
          right={<Badge tone="blue">{rateCards.activeCount} aktif tarife</Badge>}
        >
          <div className="space-y-3">
            {canEditRateCards ? (
              <form
                action={upsertCustomerRateCardAction}
                className="grid grid-cols-1 gap-2 rounded border p-3 text-xs sm:grid-cols-6"
                style={{ borderColor: "var(--line-faint)", background: "var(--surface-2)" }}
              >
                <input type="hidden" name="backTo" value="/production?tab=rates" />
                <select
                  name="partyId"
                  defaultValue=""
                  className="rounded border px-2 py-1.5"
                  style={{ borderColor: "var(--line)", background: "var(--surface-1)", color: "var(--text-1)" }}
                >
                  <option value="">Cari seçin (ops.)</option>
                  {parties.map((pa) => (
                    <option key={pa.id} value={pa.id}>
                      {pa.name}
                    </option>
                  ))}
                </select>
                <input
                  name="customerLabel"
                  required
                  placeholder="Müşteri / Kontrat etiketi"
                  className="rounded border px-2 py-1.5"
                  style={{ borderColor: "var(--line)", background: "var(--surface-1)", color: "var(--text-1)" }}
                />
                <select
                  name="operationType"
                  defaultValue="torna"
                  className="rounded border px-2 py-1.5"
                  style={{ borderColor: "var(--line)", background: "var(--surface-1)", color: "var(--text-1)" }}
                >
                  {WORK_CENTER_OPERATION_TYPES.map((op) => (
                    <option key={op} value={op}>
                      {OPERATION_TYPE_LABEL[op]}
                    </option>
                  ))}
                </select>
                <div className="flex gap-1">
                  <input
                    name="ratePerMinute"
                    type="number"
                    step="0.0001"
                    min="0.0001"
                    required
                    placeholder="Tarife / dk"
                    className="w-full rounded border px-2 py-1.5"
                    style={{ borderColor: "var(--line)", background: "var(--surface-1)", color: "var(--text-1)" }}
                  />
                  <select
                    name="currency"
                    defaultValue="TRY"
                    className="rounded border px-2 py-1.5"
                    style={{ borderColor: "var(--line)", background: "var(--surface-1)", color: "var(--text-1)" }}
                  >
                    <option value="TRY">TRY</option>
                    <option value="USD">USD</option>
                    <option value="EUR">EUR</option>
                  </select>
                </div>
                <input
                  name="validFrom"
                  type="date"
                  defaultValue={new Date().toISOString().slice(0, 10)}
                  className="rounded border px-2 py-1.5"
                  style={{ borderColor: "var(--line)", background: "var(--surface-1)", color: "var(--text-1)" }}
                />
                <SubmitButton
                  pendingLabel="Kaydediliyor…"
                  className="rounded border px-3 py-1.5 font-mono text-xs font-semibold"
                  style={{ borderColor: "var(--line)", background: "var(--surface-1)", color: "var(--text-1)" }}
                >
                  Tarife Ekle
                </SubmitButton>
              </form>
            ) : null}

            {rateCards.cards.length === 0 ? (
              <EmptyState>Henüz müşteri tarife kartı tanımlanmamış.</EmptyState>
            ) : (
              <TableShell>
                <table className="w-full border-collapse text-left text-xs">
                  <thead>
                    <tr
                      className="border-b font-mono text-[10px] uppercase"
                      style={{ borderColor: "var(--line)", color: "var(--text-3)" }}
                    >
                      <th className="py-2 pr-2">Müşteri / Kontrat</th>
                      <th className="py-2 px-2">Operasyon</th>
                      <th className="py-2 px-2 text-right">Döviz Tarifesi</th>
                      <th className="py-2 px-2 text-right">TL/dk (TCMB)</th>
                      <th className="py-2 px-2">Geçerlilik</th>
                      <th className="py-2 pl-2 text-right">Durum</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rateCards.cards.map((rc) => (
                      <tr key={rc.id} className="border-b" style={{ borderColor: "var(--line-faint)" }}>
                        <td className="py-1.5 pr-2 font-medium">{rc.displayCustomerName}</td>
                        <td className="py-1.5 px-2">{OPERATION_TYPE_LABEL[rc.operationType]}</td>
                        <td className="py-1.5 px-2 text-right font-mono tabular-nums">
                          {rc.ratePerMinute.toFixed(2)} {rc.currency}/dk
                        </td>
                        <td className="py-1.5 px-2 text-right font-mono font-semibold tabular-nums">
                          {rc.ratePerMinuteTry != null ? fmtTlPerMin(rc.ratePerMinuteTry) : "Kur eksik"}
                        </td>
                        <td className="py-1.5 px-2 font-mono text-[11px]" style={{ color: "var(--text-3)" }}>
                          {rc.validFrom}
                        </td>
                        <td className="py-1.5 pl-2 text-right">
                          {canEditRateCards ? (
                            <form action={toggleCustomerRateCardAction} className="inline">
                              <input type="hidden" name="backTo" value="/production?tab=rates" />
                              <input type="hidden" name="id" value={rc.id} />
                              <input type="hidden" name="isActive" value={rc.isActive ? "false" : "true"} />
                              <button
                                type="submit"
                                className="rounded border px-2 py-0.5 font-mono text-[10px]"
                                style={{
                                  borderColor: "var(--line)",
                                  background: "var(--surface-2)",
                                  color: rc.isActive ? "var(--pos)" : "var(--text-3)",
                                }}
                              >
                                {rc.isActive ? "Aktif" : "Pasif"}
                              </button>
                            </form>
                          ) : (
                            <Badge tone={rc.isActive ? "green" : "neutral"}>{rc.isActive ? "Aktif" : "Pasif"}</Badge>
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
      ) : null}

      {activeTab === "overview" ? (
        <>
          <Panel
            title="TDHP 7xx Fiili Gider ↔ Tezgâh Dakika (TL/dk) Canlı Başabaş Köprüsü"
            subtitle="Yönetim defterindeki kesinleşmiş 7xx giderlerinden tezgâh dakikası başına ABC dönüşüm, nakit ve tam başabaş özeti"
            accent={
              bridge.status !== "ready"
                ? "warn"
                : hasErosionAlert
                  ? "neg"
                  : "pos"
            }
            right={
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge tone="amber">ABC + Canlı 7xx Köprüsü</Badge>
                <Link
                  href="/production/costs"
                  className="font-mono text-[11px] underline"
                  style={{ color: "var(--text-1)" }}
                >
                  Maliyet Detayı →
                </Link>
              </div>
            }
          >
            {bridge.status === "insufficient_ledger_actuals" ? (
              <EmptyState>
                Fiili 7xx yönetim defteri verisi yetersiz — ölçülemez (son {bridge.lookbackMonths} ayda kesinleşmiş 710–770 gider tahakkuku yok; boş veri asla 0,00 TL/dk olarak gösterilmez).
              </EmptyState>
            ) : bridge.status === "unknown_effective_minutes" ? (
              <EmptyState>
                Fiili 7xx yönetim defteri verisi yetersiz — ölçülemez: aylık tam 7xx gideri ({fmtTL(bridge.avgMonthlyFull7xxInclDaTry)}) mevcut ancak etkin tezgâh dakikası tanımlı olmadığı için TL/dk başabaş hesaplanamıyor.
              </EmptyState>
            ) : (
              <div className="space-y-2.5">
                <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
                  <KpiCard
                    label="ABC Atölye Dönüşüm (720+730)"
                    value={fmtTlPerMin(bridge.abcShopFloorTlPerMin ?? bridge.bookBreakEvenTlPerMin)}
                    tone="info"
                    note={`710 Hammadde hariç saf tezgâh TL/dk`}
                  />
                  <KpiCard
                    label="Kitabi (Model) Başabaş"
                    value={fmtTlPerMin(bridge.bookBreakEvenTlPerMin)}
                    note={`Senaryo: ${bridge.primaryScenario ?? "—"}`}
                  />
                  <KpiCard
                    label="Fiili Tam (7xx + Amortisman)"
                    value={fmtTlPerMin(bridge.actualFullBreakEvenTlPerMin)}
                    tone={hasErosionAlert ? "warn" : "neutral"}
                    note={`D&A dahil ${fmtTL(bridge.avgMonthlyFull7xxInclDaTry)}/ay`}
                  />
                  <KpiCard
                    label="Sapma (Δ TL/dk)"
                    value={fmtSignedTlPerMin(bridge.rateDriftTlPerMin)}
                    tone={
                      bridge.rateDriftTlPerMin !== null && bridge.rateDriftTlPerMin > 0
                        ? "neg"
                        : bridge.rateDriftTlPerMin !== null && bridge.rateDriftTlPerMin < 0
                          ? "pos"
                          : "neutral"
                    }
                    note={`${fmtSignedPct(bridge.rateDriftPct)} · Gizli erime: ${bridge.hiddenErosionPartCount} parça / ${bridge.hiddenErosionRateCount} tarife`}
                  />
                </div>

                {hasErosionAlert ? (
                  <div
                    className="flex flex-wrap items-center justify-between gap-2 border px-3 py-2 text-xs"
                    style={{
                      background: "var(--surface-2)",
                      borderColor: "color-mix(in srgb, var(--neg) 45%, var(--line))",
                      borderRadius: "var(--radius)",
                      color: "var(--text-1)",
                    }}
                  >
                    <span className="font-mono">
                      <b style={{ color: "var(--neg)" }}>Gizli Marj Erimesi:</b>{" "}
                      Kitabi başabaşta kârlı görünen{" "}
                      <b>{bridge.hiddenErosionRateCount}</b> müşteri tarifesi ve{" "}
                      <b>{bridge.hiddenErosionPartCount}</b> parça fiili 7xx tam başabaşı altında zarara dönüyor.
                    </span>
                    <Link
                      href="/production/costs"
                      className="font-mono text-[11px] underline"
                      style={{ color: "var(--neg)" }}
                    >
                      Eriyen parçaları incele →
                    </Link>
                  </div>
                ) : null}
              </div>
            )}
          </Panel>

          {canEditCapacity ? (
            <Panel title="KAPASİTE PARAMETRESİ GÜNCELLE">
              <details className="rounded border p-2" style={{ borderColor: "var(--line-faint)" }}>
                <summary className="cursor-pointer font-mono text-xs font-semibold" style={{ color: "var(--text-1)" }}>
                  + Kapasite / vardiya parametresi ekle
                </summary>
                <form action={upsertCapacityParameterAction} className="mt-2 grid grid-cols-1 gap-2 text-xs sm:grid-cols-4">
                  <input type="hidden" name="backTo" value="/production" />
                  <input
                    name="name"
                    required
                    placeholder="Model adı (örn. 2026 Normal Atölye)"
                    className="rounded border bg-transparent px-2 py-1 sm:col-span-2"
                    style={{ borderColor: "var(--line-faint)", color: "var(--text-1)" }}
                  />
                  <select
                    name="scenarioType"
                    defaultValue="normal"
                    className="rounded border bg-transparent px-2 py-1"
                    style={{ borderColor: "var(--line-faint)", color: "var(--text-1)" }}
                  >
                    <option value="normal">normal</option>
                    <option value="overtime">overtime (mesaili)</option>
                    <option value="custom">custom</option>
                  </select>
                  <input
                    name="rateYear"
                    type="number"
                    min="2000"
                    max="2100"
                    defaultValue={new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Istanbul", year: "numeric" }).format(new Date())}
                    placeholder="Tarife yılı"
                    className="rounded border bg-transparent px-2 py-1"
                    style={{ borderColor: "var(--line-faint)", color: "var(--text-1)" }}
                  />
                  <input
                    name="workDaysPerMonth"
                    type="number"
                    min="1"
                    max="31"
                    defaultValue="22"
                    required
                    placeholder="Çalışma günü/ay"
                    className="rounded border bg-transparent px-2 py-1"
                    style={{ borderColor: "var(--line-faint)", color: "var(--text-1)" }}
                  />
                  <input
                    name="hoursPerDay"
                    type="number"
                    step="0.5"
                    min="1"
                    max="24"
                    defaultValue="8"
                    required
                    placeholder="Saat/gün"
                    className="rounded border bg-transparent px-2 py-1"
                    style={{ borderColor: "var(--line-faint)", color: "var(--text-1)" }}
                  />
                  <input
                    name="efficiencyRate"
                    type="number"
                    step="0.01"
                    min="0.05"
                    max="2"
                    defaultValue="0.85"
                    required
                    placeholder="Verim (0.85 = %85)"
                    className="rounded border bg-transparent px-2 py-1"
                    style={{ borderColor: "var(--line-faint)", color: "var(--text-1)" }}
                  />
                  <input
                    name="tornaRateTLPerMin"
                    type="number"
                    step="0.01"
                    min="0"
                    placeholder="Torna TL/dk"
                    className="rounded border bg-transparent px-2 py-1"
                    style={{ borderColor: "var(--line-faint)", color: "var(--text-1)" }}
                  />
                  <input
                    name="frezeRateTLPerMin"
                    type="number"
                    step="0.01"
                    min="0"
                    placeholder="Freze TL/dk"
                    className="rounded border bg-transparent px-2 py-1"
                    style={{ borderColor: "var(--line-faint)", color: "var(--text-1)" }}
                  />
                  <input
                    name="notes"
                    placeholder="Not (opsiyonel)"
                    className="rounded border bg-transparent px-2 py-1 sm:col-span-2"
                    style={{ borderColor: "var(--line-faint)", color: "var(--text-1)" }}
                  />
                  <SubmitButton
                    pendingLabel="Kaydediliyor…"
                    className="rounded border px-2 py-1 disabled:opacity-60"
                    style={{
                      borderColor: "var(--line)",
                      background: "var(--surface-2)",
                      color: "var(--text-1)",
                    }}
                  >
                    Parametreyi kaydet
                  </SubmitButton>
                </form>
              </details>
            </Panel>
          ) : null}

          <details className="parchment-disclosure" open={revSummary.totalPartCount > 0 && revSummary.totalPartCount <= 8}>
            <summary>
              <div className="flex items-center gap-2.5">
                <span className="parchment-disclosure-chevron" aria-hidden="true">
                  ▸
                </span>
                <div>
                  <div className="text-[13.5px] font-semibold text-tone-1">
                    KAYNAK GELİR DAĞILIMI (TCMB SPOT KUR ÇEVRİMLİ)
                  </div>
                  <div className="text-[11.5px] text-tone-3">
                    Kapasite ve V2 sözleşme satırlarından okunan parça bazlı kaynak gelir özeti
                  </div>
                </div>
              </div>
              <Badge tone={revSummary.unknownRevenueCount > 0 ? "amber" : "neutral"}>
                {revSummary.totalPartCount} parça
              </Badge>
            </summary>
            <div className="parchment-disclosure-body">
              {revSummary.totalPartCount === 0 ? (
                <EmptyState>
                  Henüz kaynak gelir verisi içeren üretim parçası yok — kapasite çalışma kitabı içe aktarıldığında V2 ve klasik gelir dağılımı burada gösterilir.
                </EmptyState>
              ) : (
                <div className="space-y-3">
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                    <KeyStat
                      label="Toplam Bilinen Kaynak Gelir"
                      value={fmtTL(revSummary.totalKnownRevenueTry)}
                      tone="pos"
                    />
                    <KeyStat
                      label="V2 Sözleşme Geliri"
                      value={fmtTL(revSummary.v2RevenueTry)}
                      sub={`${revSummary.v2Count} parça (satis_fiyati × adet)`}
                      tone="info"
                    />
                    <KeyStat
                      label="Klasik Kapasite Geliri"
                      value={fmtTL(revSummary.legacyRevenueTry)}
                      sub={`${revSummary.legacyCount} parça (I sütunu)`}
                      tone="neutral"
                    />
                    <KeyStat
                      label="Geliri Bilinmeyen Parça"
                      value={`${revSummary.unknownRevenueCount} / ${revSummary.totalPartCount}`}
                      tone={revSummary.unknownRevenueCount > 0 ? "warn" : "pos"}
                    />
                  </div>
                  {revSummary.topParts.length > 0 ? (
                    <TableShell>
                      <table className="w-full text-xs">
                        <thead>
                          <tr>
                            <th>Parça Kodu</th>
                            <th>Parça Adı</th>
                            <th className="text-right">Adet</th>
                            <th>Kaynak Biçimi</th>
                            <th className="text-right">Kaynak Gelir (TRY)</th>
                          </tr>
                        </thead>
                        <tbody>
                          {revSummary.topParts.map((pt) => (
                            <tr key={pt.partId}>
                              <td className="font-mono text-xs">{pt.partCode ?? "—"}</td>
                              <td className="text-xs">{pt.partName}</td>
                              <td className="text-right font-mono text-xs">{pt.quantity ?? "—"}</td>
                              <td>
                                <Badge tone={pt.source === "v2" ? "blue" : pt.source === "legacy" ? "green" : "neutral"}>
                                  {pt.source}
                                </Badge>
                              </td>
                              <td className="text-right font-mono text-xs">{fmtTL(pt.revenue)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </TableShell>
                  ) : null}
                </div>
              )}
            </div>
          </details>

          <Panel title="Analiz alanları">
            <div className="grid gap-2 sm:grid-cols-2">
              {[
                ["/production/capacity", "Kapasite & Canlı OEE", "Vardiya rejimi seçimi, teorik vs fiili iş emri geliri ve darboğaz analizi"],
                ["/production/costs", "ABC Maliyet & Başabaş", "710 BOM malzeme, 720-730 atölye ve 760-770 faaliyet kâr köprüsü"],
                ["/production/profitability", "Parça Kârlılığı (TCMB)", "İhracat kur çevrimli ve tekilleştirilmiş parça marjları"],
                ["/production/roi", "Makine CAPEX (NPV / IRR)", "253/257 amortisman vergi kalkanı, NPV, IRR ve iskontolu geri ödeme"],
              ].map((x) => (
                <Link
                  key={x[0]}
                  href={x[0]}
                  className="border p-3"
                  style={{ borderColor: "var(--line)", color: "var(--text-1)" }}
                >
                  <b>{x[1]}</b>
                  <p className="mt-1 text-xs" style={{ color: "var(--text-3)" }}>
                    {x[2]}
                  </p>
                </Link>
              ))}
            </div>
          </Panel>
        </>
      ) : null}
    </>
  );
}
