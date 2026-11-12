import { requireRouteAccess } from "@/lib/authz/route-guard";
import { Badge } from "@/components/ui/badge";
import { Panel, fmtTL } from "@/components/ui/panel";
import { EmptyState, KeyStat, KpiCard, PageHeader, TableShell } from "@/components/ui/shell";
import { loadCashMonths } from "@/lib/cashflow/engine";
import { getPool } from "@/lib/db";
import { istanbulDateISO } from "@/lib/reports/rules";
import {
  loadAndSolveBreakevenLevers,
  type GoalSeekHorizon,
} from "@/lib/scenarios/breakeven-goalseek";
import {
  formatNativeFx,
  formatTcmbRate,
  loadFxStressOverlay,
  type NaturalHedgeStatus,
} from "@/lib/scenarios/fx-stress";
import { runScenarioAction } from "./actions";

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

  const [months, goalSeek, fxStress] = await Promise.all([
    loadCashMonths(pool),
    loadAndSolveBreakevenLevers(pool, {
      horizon,
      asOfDate: today,
      currency: "TRY",
    }),
    loadFxStressOverlay(pool, { asOfDate: today }),
  ]);

  const band10 = fxStress.shockBands.find((b) => b.shockPct === 10) ?? fxStress.shockBands[0];
  const band20 = fxStress.shockBands.find((b) => b.shockPct === 20) ?? fxStress.shockBands[1];
  const band30 = fxStress.shockBands.find((b) => b.shockPct === 30) ?? fxStress.shockBands[2];

  const field = "mt-1 w-full border border-line bg-transparent p-2";

  return (
    <>
      <PageHeader
        title="Yeni Senaryo ve Başabaş Kaldıraç Çözücü"
        subtitle="Kaynak kayıtlarını değiştirmeyen what-if çalışması ve deterministik başabaş (Goal-Seek) analizi"
        meta={<span className="text-xs text-warn">Tahmindir; muhasebe gerçeği değildir.</span>}
      />

      <Panel
        title="BAŞABAŞ KALDIRAÇ ÇÖZÜCÜ (GOAL-SEEK — 14 GÜN / 13 HAFTA / 12 AY)"
        subtitle="İlk eksi kasa veya kasa tabanı ihlalini sıfırlamak için tek başına yeterli olan 4 deterministik kaldıraç"
        right={
          <form method="get" className="flex items-center gap-2 text-xs">
            <select
              name="horizon"
              defaultValue={horizon}
              className="border px-2 py-1 text-xs"
              style={{
                borderColor: "var(--line)",
                background: "var(--surface-2)",
                color: "var(--text-1)",
                borderRadius: "var(--radius)",
              }}
            >
              <option value="14d">14 Günlük Ufuk</option>
              <option value="13w">13 Haftalık Ufuk</option>
              <option value="12m">12 Aylık Ufuk</option>
            </select>
            <button
              type="submit"
              className="button-ghost px-2.5 py-1 text-xs"
            >
              Ufku Hesapla
            </button>
          </form>
        }
      >
        <div className="space-y-3">
          <div
            className="flex flex-wrap items-center justify-between gap-2 text-xs"
            style={{ color: "var(--text-2)" }}
          >
            <div>
              Ufuk: <strong>{goalSeek.asOfDate}</strong> → <strong>{goalSeek.horizonEndDate}</strong> · Kasa Tabanı:{" "}
              <strong>{fmtTL(goalSeek.targetFloor)}</strong> · Kapatılması Gereken Açık:{" "}
              <strong>{goalSeek.requiredShortfall == null ? "—" : fmtTL(goalSeek.requiredShortfall)}</strong>
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
            <span>
              Başabaş ve senaryo/optimizasyon motoru deterministik model sabitleri kullanır (DSO hızlandırma arama tavanı:
              180 gün, ihtiyari gider havuzu: düşük/normal öncelikli çıkışlar, hazır stres şokları: ±%10); defter kaydı
              değil simülasyon varsayımıdır.
            </span>
          </div>
        </div>
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
              <span>
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
                  <span>
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
                <span>
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
                  <tr
                    className="text-left text-xs uppercase"
                    style={{ color: "var(--text-3)" }}
                  >
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
                      className="border-t"
                      style={{ borderColor: "var(--line-faint)", color: "var(--text-1)" }}
                    >
                      <td className="py-2 font-mono font-semibold">{c.currency}</td>
                      <td className="text-right font-mono tabular-nums">
                        {c.hasUnknownCashOpening
                          ? "— (açılış bakiyesi eksik)"
                          : formatNativeFx(c.fxAssets, c.currency)}
                      </td>
                      <td className="text-right font-mono tabular-nums">
                        {formatNativeFx(c.fxLiabilities, c.currency)}
                      </td>
                      <td
                        className="text-right font-mono tabular-nums"
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
                      <td className="text-right font-mono tabular-nums" style={{ color: "var(--text-3)" }}>
                        {formatTcmbRate(c.tcmbBaseRate)}
                      </td>
                      <td className="text-right font-mono tabular-nums">
                        {c.hasMissingRate
                          ? "TCMB kuru eksik"
                          : fmtTL(c.baseNetValueTry)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableShell>

            <TableShell>
              <table className="w-full text-sm">
                <thead>
                  <tr
                    className="text-left text-xs uppercase"
                    style={{ color: "var(--text-3)" }}
                  >
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
                      className="border-t"
                      style={{ borderColor: "var(--line-faint)", color: "var(--text-1)" }}
                    >
                      <td className="py-2">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="font-mono font-semibold">{band.label}</span>
                          <Badge tone="amber">Varsayım (Model Sabiti)</Badge>
                        </div>
                      </td>
                      <td
                        className="text-right font-mono tabular-nums"
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
                      <td className="text-right font-mono tabular-nums">
                        {fxStress.status === "missing_fx_rates"
                          ? "—"
                          : fmtTL(band.postShockLiquidityBufferTry)}
                      </td>
                      <td className="text-right font-mono tabular-nums" style={{ color: "var(--text-3)" }}>
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
              <span>
                +%10 / +%20 / +%30 kur şoku bantları model sabitidir; her yabancı para kendi orijinal biriminde tutulur ve
                yalnız `fx_rate_snapshots` tablosundaki resmi TCMB kuru üzerinden simüle edilir. Defter kayıtları
                değiştirilmez.
              </span>
            </div>
          </div>
        )}
      </Panel>

      <Panel title="Hazır senaryolar">
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
            <input name="revenuePct" type="number" step="0.1" className={field} />
          </label>
          <label className="text-xs">
            Gider değişimi %
            <input name="expensePct" type="number" step="0.1" className={field} />
          </label>
          <label className="text-xs">
            Genel müşteri gecikmesi (ay)
            <input name="customerDelayMonths" type="number" min="0" className={field} />
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
            <input name="factoringFeePct" type="number" min="0" step="0.1" className={field} />
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
          <div className="lg:col-span-3">
            <button className="button-accent px-3 py-2" disabled={!months.length}>
              Senaryoyu çalıştır
            </button>
            <p className="mt-2 text-xs text-tone-3">
              Bilinmeyen tutarlar sıfır sayılmaz. Onaylı dış varsayımlar bağlam olarak kaydedilir.
            </p>
          </div>
        </form>
      </Panel>
    </>
  );
}
