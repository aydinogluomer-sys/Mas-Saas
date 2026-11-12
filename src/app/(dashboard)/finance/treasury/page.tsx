import { getPool } from "@/lib/db";
import {
  loadCashPositions,
  loadDailyCashMovements,
  loadEditableCashAndBankAccounts,
  loadLiquidityGap,
  loadPolicies,
  loadPositionSummary,
  loadReconciliation,
} from "@/lib/treasury/engine";
import { RECONCILIATION_LABEL, type ReconciliationStatus } from "@/lib/treasury/rules";
import { istanbulDateISO } from "@/lib/reports/rules";
import { formatMoney } from "@/lib/money-format";
import { Badge, type Tone } from "@/components/ui/badge";
import { Panel, fmtTL } from "@/components/ui/panel";
import { EmptyState, KeyStat, KpiCard, PageHeader, TableShell } from "@/components/ui/shell";
import { updatePolicyAction, upsertTreasuryAccountAction } from "./actions";
import { loadCovenantAndDscrRadar } from "@/lib/financing/covenants-and-dscr";
import {
  formatNativeFx,
  formatTcmbRate,
  loadFxStressOverlay,
  type NaturalHedgeStatus,
} from "@/lib/scenarios/fx-stress";
import { requireRouteAccess } from "@/lib/authz/route-guard";

export const dynamic = "force-dynamic";

function signedFmtTL(n: number | null | undefined): string {
  if (n == null) return "TUTAR EKSİK";
  return n > 0 ? `+${fmtTL(n)}` : fmtTL(n);
}

function renderTreasuryHedgeBadge(status: NaturalHedgeStatus, ratio: number | null) {
  if (status === "unknown_cash_opening") {
    return <Badge tone="amber">Açılış Eksik</Badge>;
  }
  if (status === "no_liability") {
    return <Badge tone="blue">Borç Yok</Badge>;
  }
  const pct = ratio == null ? "" : ` %${(ratio * 100).toFixed(0)}`;
  if (status === "naturally_hedged") {
    return <Badge tone="green">{`Doğal Hedgeli${pct}`}</Badge>;
  }
  if (status === "partial_hedge") {
    return <Badge tone="amber">{`Kısmi Hedge${pct}`}</Badge>;
  }
  return <Badge tone="red">{`Açık Risk${pct}`}</Badge>;
}

const RECON_TONE: Record<ReconciliationStatus, Tone> = {
  aligned: "green",
  divergent: "red",
  cashflow_missing: "neutral",
  no_bank_movement: "neutral",
  incomplete_opening_balance: "amber",
};

const ACCOUNT_TYPE_TR: Record<string, string> = {
  cash: "Kasa (100)",
  bank_account: "Banka (102)",
  credit_card: "Kredili / Kart",
  loan: "Kredi Hesabı",
  check_account: "Çek Hesabı",
  other: "POS / Diğer",
  unknown: "Tanımsız",
};

export default async function TreasuryPage({
  searchParams,
}: { searchParams: Promise<{ error?: string; result?: string }> }) {
  const denied = await requireRouteAccess("/finance/treasury");
  if (denied) return denied;
  const sp = await searchParams;
  const pool = getPool();
  const today = istanbulDateISO();
  const dscrRadarPromise = loadCovenantAndDscrRadar(pool, { asOfDate: today, currency: "TRY" });
  const [
    positions,
    summary,
    gaps,
    recon,
    policies,
    dscrRadar,
    fxStress,
    editableAccounts,
    dailyMovements,
  ] = await Promise.all([
    loadCashPositions(pool),
    loadPositionSummary(pool),
    loadLiquidityGap(pool),
    loadReconciliation(pool),
    loadPolicies(pool),
    dscrRadarPromise,
    loadFxStressOverlay(pool, { asOfDate: today, dscrRadar: dscrRadarPromise }),
    loadEditableCashAndBankAccounts(pool),
    loadDailyCashMovements(pool, 30),
  ]);
  const fxBand20 = fxStress.shockBands.find((b) => b.shockPct === 20) ?? fxStress.shockBands[1];
  const divergent = recon.filter((r) => r.status === "divergent");
  const breaches = gaps.filter((g) => g.breachesFloor === true);
  const unknownHorizons = gaps.filter((g) => g.status === "unknown_opening_balance");
  const gapAccounts = positions.filter(
    (p) => p.statedMinusDerived != null && Math.abs(p.statedMinusDerived) > 0.01,
  );

  return (
    <>
      <PageHeader
        title="Hazine / Likidite"
        subtitle={`Nakit pozisyonu, Kasa/Banka açılış yönetimi (FIN-03), günlük nakit hareketi ve 7/30/90 gün likidite — ${today}`}
        meta={
          breaches.length > 0 ? (
            <Badge tone="red" dot>{`${breaches.length} ufukta taban altı`}</Badge>
          ) : unknownHorizons.length > 0 ? (
            <Badge tone="amber" dot>açılış bakiyesi eksik</Badge>
          ) : (
            <Badge tone="green" dot>taban korunuyor</Badge>
          )
        }
      />

      {sp.error ? (
        <div
          className="mb-3 rounded border px-3 py-2 text-sm"
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
          className="mb-3 rounded border px-3 py-2 text-sm"
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
        {summary.map((s) => {
          const openingMissing = s.unknownOpeningCount > 0 || s.availableNow == null;
          return (
            <KeyStat
              key={`avail-${s.currency}`}
              label={`Kullanılabilir (${s.currency})`}
              value={
                openingMissing
                  ? `— (açılış bakiyesi eksik: ${s.unknownOpeningCount} hesap)`
                  : formatMoney(s.availableNow ?? 0, s.currency)
              }
              sub={
                openingMissing
                  ? `Hareket bazlı net değişim: ${formatMoney(s.movementDelta, s.currency)}`
                  : undefined
              }
              tone={openingMissing ? "warn" : (s.availableNow ?? 0) > 0 ? "pos" : "neg"}
            />
          );
        })}
        <KeyStat label="Taban altı ufuk" value={breaches.length} tone={breaches.length > 0 ? "neg" : "pos"} />
        <KeyStat label="Mutabakat sapması" value={divergent.length} tone={divergent.length > 0 ? "warn" : "pos"} />
        <KeyStat
          label="Bakiye farkı olan hesap"
          value={gapAccounts.length}
          tone={gapAccounts.length > 0 ? "warn" : "pos"}
        />
        <KeyStat
          label="Nakit DSCR (12 Ay) / Kovenant"
          value={dscrRadar.dscrWindows.forward12m.dscr == null ? "—" : `${dscrRadar.dscrWindows.forward12m.dscr.toFixed(2)}x`}
          sub={`${dscrRadar.breachedCount} ihlal · ${dscrRadar.warningCount} erken uyarı`}
          tone={dscrRadar.breachedCount > 0 ? "neg" : dscrRadar.warningCount > 0 ? "warn" : "pos"}
          href="/finance/facilities"
        />
      </div>

      <Panel
        title="Kasa / Banka Hesabı & Açılış Bakiyesi Yönetimi (FIN-03 · 500.99 Yönetim Defteri)"
        subtitle="Yeni kasa veya banka hesabı (IBAN dahil) açın ya da mevcut hesapların açılış bakiyesini güncelleyin; sıfır dışı açılış tutarları yönetim defterinde otomatik 100/102 ↔ 500.99 fişi üretir"
      >
        <div className="space-y-4">
          <form
            action={upsertTreasuryAccountAction}
            className="grid grid-cols-1 gap-2 rounded border p-3 text-xs md:grid-cols-8"
            style={{
              background: "var(--surface-2)",
              borderColor: "var(--line)",
              color: "var(--text-1)",
            }}
          >
            <input
              name="name"
              required
              placeholder="Hesap adı (ör. Merkez TL Kasa / Garanti Ticari)"
              className="field-control px-2 py-1.5 text-xs md:col-span-2"
            />
            <select name="kind" defaultValue="bank" className="field-control px-2 py-1.5 text-xs">
              <option value="bank">Banka Hesabı (102)</option>
              <option value="cash">Nakit Kasa (100)</option>
              <option value="pos">POS / Ödeme Kuruluşu</option>
              <option value="credit_line">Kredili Hesap / KMH</option>
            </select>
            <select name="currency" defaultValue="TRY" className="field-control px-2 py-1.5 font-mono text-xs">
              <option value="TRY">TRY</option>
              <option value="USD">USD</option>
              <option value="EUR">EUR</option>
              <option value="GBP">GBP</option>
            </select>
            <input
              name="openingBalance"
              type="number"
              step="0.01"
              placeholder="Açılış bakiyesi"
              className="field-control px-2 py-1.5 font-mono text-xs"
            />
            <input
              name="openingBalanceDate"
              type="date"
              defaultValue={today}
              className="field-control px-2 py-1.5 font-mono text-xs"
            />
            <input
              name="iban"
              placeholder="TR IBAN (banka için)"
              className="field-control px-2 py-1.5 font-mono text-xs"
            />
            <div className="flex items-center gap-1.5">
              <input
                name="bankName"
                placeholder="Banka adı"
                className="field-control min-w-0 flex-1 px-2 py-1.5 text-xs"
              />
              <button type="submit" className="button-primary shrink-0 px-3 py-1.5 text-xs">
                Hesap ekle
              </button>
            </div>
          </form>

          {editableAccounts.length === 0 ? (
            <EmptyState>Henüz tanımlı kasa veya banka hesabı yok.</EmptyState>
          ) : (
            <TableShell>
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left uppercase" style={{ color: "var(--text-2)" }}>
                    <th className="py-1.5">Hesap / Tür</th>
                    <th>Kur</th>
                    <th>IBAN / Banka</th>
                    <th>Açılış Bakiyesi &amp; Tarih</th>
                    <th>500.99 Fişi</th>
                    <th>Güncelle</th>
                  </tr>
                </thead>
                <tbody>
                  {editableAccounts.map((acct) => (
                    <tr
                      key={`edit-acct-${acct.id}`}
                      className="border-t align-middle"
                      style={{ borderColor: "var(--line)", color: "var(--text-1)" }}
                    >
                      <td className="py-2 pr-2">
                        <div className="font-medium">{acct.name}</div>
                        <div className="text-[11px]" style={{ color: "var(--text-2)" }}>
                          {ACCOUNT_TYPE_TR[acct.accountType] ?? acct.accountType}
                          {!acct.isActive ? " · pasif" : ""}
                        </div>
                      </td>
                      <td className="py-2 pr-2 font-mono">{acct.currency}</td>
                      <td className="py-2 pr-2 font-mono text-[11px]" style={{ color: "var(--text-2)" }}>
                        {acct.ibanNormalized ?? acct.iban ?? "—"}
                        {acct.bankName ? <span className="block font-sans">{acct.bankName}</span> : null}
                      </td>
                      <td className="py-2 pr-2 font-mono tabular-nums">
                        {acct.openingBalance == null ? (
                          <Badge tone="amber">Açılış Eksik (FIN-03)</Badge>
                        ) : (
                          <span>
                            {formatMoney(acct.openingBalance, acct.currency)}
                            {acct.openingBalanceDate ? (
                              <span className="ml-1 text-[11px]" style={{ color: "var(--text-2)" }}>
                                ({acct.openingBalanceDate})
                              </span>
                            ) : null}
                          </span>
                        )}
                      </td>
                      <td className="py-2 pr-2">
                        {acct.openingJournalEntryId ? (
                          <Badge tone="green">500.99 İşli</Badge>
                        ) : acct.openingBalance === 0 ? (
                          <Badge tone="neutral">0,00 Açılış</Badge>
                        ) : (
                          <Badge tone="amber">Fiş Yok</Badge>
                        )}
                      </td>
                      <td className="py-2">
                        <form action={upsertTreasuryAccountAction} className="flex flex-wrap items-center gap-1.5">
                          <input type="hidden" name="cashAccountId" value={acct.id} />
                          <input type="hidden" name="hasIsActiveField" value="1" />
                          <input
                            name="openingBalance"
                            type="number"
                            step="0.01"
                            defaultValue={acct.openingBalance ?? ""}
                            placeholder="Açılış tutarı"
                            className="field-control w-28 px-1.5 py-1 font-mono text-[11px]"
                          />
                          <input
                            name="openingBalanceDate"
                            type="date"
                            defaultValue={acct.openingBalanceDate ?? today}
                            className="field-control w-32 px-1.5 py-1 font-mono text-[11px]"
                          />
                          <input
                            name="iban"
                            defaultValue={acct.ibanNormalized ?? acct.iban ?? ""}
                            placeholder="IBAN"
                            className="field-control w-40 px-1.5 py-1 font-mono text-[11px]"
                          />
                          <label
                            className="flex items-center gap-1 text-[11px]"
                            style={{ color: "var(--text-2)" }}
                          >
                            <input type="checkbox" name="isActive" defaultChecked={acct.isActive} /> aktif
                          </label>
                          <button type="submit" className="button-ghost px-2 py-1 text-[11px]">
                            Kaydet
                          </button>
                        </form>
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
        title="Döviz Açık Pozisyonu & Doğal Hedge Özeti (TCMB Kur Şoku Duyarlılığı)"
        subtitle="Orijinal para birimi bazında açık pozisyon, doğal hedge karşılama oranı ve +%20 kur şoku likidite/DSCR etkisi"
        right={<Badge tone="amber">Varsayım (Model Sabiti)</Badge>}
      >
        {fxStress.status === "no_fx_exposure" ? (
          <EmptyState>Yabancı para açık pozisyon yok</EmptyState>
        ) : (
          <div className="space-y-3">
            {fxStress.status === "missing_fx_rates" ? (
              <div
                className="flex flex-wrap items-center gap-2 border px-3 py-2 text-xs"
                style={{
                  background: "var(--surface-2)",
                  borderColor: "var(--line)",
                  borderRadius: "var(--radius)",
                  color: "var(--text-1)",
                }}
              >
                <Badge tone="red" dot>
                  TCMB kuru eksik — hesaplanamadı
                </Badge>
                <span>
                  {`Resmi TCMB kuru bulunmayan aktif döviz(ler): ${fxStress.missingFxCurrencies.join(", ")}. Sahte 1,00 kur kullanılmaz; yalnız orijinal döviz bakiyeleri gösterilir.`}
                </span>
              </div>
            ) : null}

            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
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
                note="Orijinal dövizler yalnız stres katmanında resmi TCMB kuruyla TL'ye çevrilir"
              />
              <KpiCard
                label="+%20 Kur Şoku Likidite Etkisi"
                badge={<Badge tone="amber">Varsayım (Model Sabiti)</Badge>}
                value={
                  fxStress.status === "missing_fx_rates"
                    ? "TCMB kuru eksik — hesaplanamadı"
                    : signedFmtTL(fxBand20?.netWorthShockDeltaTry)
                }
                tone={
                  fxBand20?.netWorthShockDeltaTry == null
                    ? "warn"
                    : fxBand20.netWorthShockDeltaTry < 0
                      ? "neg"
                      : "pos"
                }
                note={`Şok Sonrası TL Likidite Tamponu: ${fmtTL(fxBand20?.postShockLiquidityBufferTry)}`}
              />
              <KpiCard
                label="+%20 Kur Şoku 12 Ay DSCR"
                badge={<Badge tone="amber">Varsayım (Model Sabiti)</Badge>}
                value={
                  fxStress.status === "missing_fx_rates"
                    ? "TCMB kuru eksik — hesaplanamadı"
                    : fxBand20?.postShockForward12mDscr == null
                      ? "—"
                      : `${fxBand20.postShockForward12mDscr.toFixed(2)}x`
                }
                tone={
                  fxBand20?.covenantBreachTriggered
                    ? "neg"
                    : fxBand20?.postShockForward12mDscr == null
                      ? "neutral"
                      : "pos"
                }
                note={
                  fxBand20?.covenantBreachTriggered
                    ? `Kovenant ihlali tetiklendi (${fxBand20.newlyBreachedCovenantCount} kovenant)`
                    : "Detaylı +%10 / +%20 / +%30 matrisi için /scenarios ekranını açın"
                }
              />
            </div>

            <TableShell>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs uppercase" style={{ color: "var(--text-2)" }}>
                    <th className="py-1">Kur</th>
                    <th className="text-right">Döviz Varlık</th>
                    <th className="text-right">Döviz Yükümlülük</th>
                    <th className="text-right">Net Orijinal Pozisyon</th>
                    <th>Doğal Hedge</th>
                    <th className="text-right">TCMB Kur</th>
                    <th className="text-right">+%20 Şok TL Etkisi</th>
                  </tr>
                </thead>
                <tbody>
                  {fxStress.currencies.map((c) => (
                    <tr
                      key={`treasury-fx-${c.currency}`}
                      className="border-t"
                      style={{ borderColor: "var(--line)", color: "var(--text-1)" }}
                    >
                      <td className="py-2 font-mono font-semibold">{c.currency}</td>
                      <td className="text-right font-mono tabular-nums">
                        {c.hasUnknownCashOpening
                          ? "— (açılış eksik)"
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
                      <td className="py-2">{renderTreasuryHedgeBadge(c.hedgeStatus, c.naturalHedgeRatio)}</td>
                      <td className="text-right font-mono tabular-nums" style={{ color: "var(--text-2)" }}>
                        {formatTcmbRate(c.tcmbBaseRate)}
                      </td>
                      <td
                        className="text-right font-mono tabular-nums"
                        style={{
                          color:
                            c.shockDeltasByBand[20] == null
                              ? "var(--warn)"
                              : c.shockDeltasByBand[20] < 0
                                ? "var(--neg)"
                                : "var(--pos)",
                        }}
                      >
                        {c.hasMissingRate
                          ? "TCMB kuru eksik — hesaplanamadı"
                          : signedFmtTL(c.shockDeltasByBand[20])}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableShell>
          </div>
        )}
      </Panel>

      <Panel title="LİKİDİTE UFUKLARI" subtitle="7 / 30 / 90 gün — sözleşmeli akış üzerinden yargılanır">
        {gaps.length === 0 ? (
          <EmptyState>Likidite verisi yok.</EmptyState>
        ) : (
          <TableShell>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase" style={{ color: "var(--text-2)" }}>
                  <th className="py-1">Ufuk</th>
                  <th>Kur</th>
                  <th className="text-right">Bugün</th>
                  <th className="text-right">Sözleşmeli akış</th>
                  <th className="text-right">Projeksiyon (sözleşmeli)</th>
                  <th className="text-right">Projeksiyon (beklenen)</th>
                  <th className="text-right">Taban</th>
                  <th className="text-right">Finansman ihtiyacı</th>
                </tr>
              </thead>
              <tbody>
                {gaps.map((g) => {
                  const openingMissing = g.status === "unknown_opening_balance" || g.availableNow == null;
                  return (
                    <tr
                      key={`${g.currency}-${g.horizonDays}`}
                      className="border-t"
                      style={{ borderColor: "var(--line)", color: "var(--text-1)" }}
                    >
                      <td className="py-2">{g.horizonDays} gün</td>
                      <td className="text-xs font-mono">{g.currency}</td>
                      <td className="text-right tabular-nums">
                        {openingMissing ? (
                          <span style={{ color: "var(--warn)" }}>
                            {`— (açılış bakiyesi eksik: ${g.unknownOpeningCount} hesap)`}
                          </span>
                        ) : (
                          formatMoney(g.availableNow ?? 0, g.currency)
                        )}
                      </td>
                      <td className="text-right tabular-nums">{formatMoney(g.contractedNetFlow ?? 0, g.currency)}</td>
                      <td
                        className="text-right tabular-nums"
                        style={g.breachesFloor === true ? { color: "var(--neg)" } : undefined}
                      >
                        {openingMissing ? "—" : formatMoney(g.projectedContracted ?? 0, g.currency)}
                      </td>
                      <td className="text-right tabular-nums" style={{ color: "var(--text-2)" }}>
                        {openingMissing ? "—" : formatMoney(g.projectedExpected ?? 0, g.currency)}
                      </td>
                      <td className="text-right tabular-nums" style={{ color: "var(--text-2)" }}>
                        {formatMoney(g.minCashFloor ?? 0, g.currency)}
                      </td>
                      <td className="text-right tabular-nums">
                        {openingMissing ? (
                          <span className="text-xs" style={{ color: "var(--warn)" }}>
                            açılış eksik
                          </span>
                        ) : (g.financingNeed ?? 0) > 0 ? (
                          <span style={{ color: "var(--neg)" }}>
                            {formatMoney(g.financingNeed ?? 0, g.currency)}
                          </span>
                        ) : (
                          "—"
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </TableShell>
        )}
      </Panel>

      <Panel title="BANKA / HESAP POZİSYONU" subtitle="banka beyanı ile hareketlerden türetilen bakiye yan yana">
        {positions.length === 0 ? (
          <EmptyState>Aktif hesap yok.</EmptyState>
        ) : (
          <TableShell>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase" style={{ color: "var(--text-2)" }}>
                  <th className="py-1">Hesap</th>
                  <th>Banka</th>
                  <th>Kur</th>
                  <th className="text-right">Banka beyanı</th>
                  <th className="text-right">Hareketlerden</th>
                  <th className="text-right">Fark</th>
                  <th className="text-right">Bloke</th>
                </tr>
              </thead>
              <tbody>
                {positions.map((p) => (
                  <tr
                    key={p.cashAccountId}
                    className="border-t"
                    style={{ borderColor: "var(--line)", color: "var(--text-1)" }}
                  >
                    <td className="py-2">
                      {p.accountName}
                      <span className="block text-xs" style={{ color: "var(--text-2)" }}>
                        {p.movementCount} hareket
                      </span>
                    </td>
                    <td className="text-xs">{p.bankName ?? "—"}</td>
                    <td className="text-xs font-mono">{p.currency}</td>
                    <td className="text-right tabular-nums">
                      {p.statedBalance == null ? "—" : formatMoney(p.statedBalance, p.currency)}
                    </td>
                    <td className="text-right tabular-nums">
                      {!p.openingKnown || p.derivedBalance == null ? (
                        <div>
                          <span style={{ color: "var(--warn)" }}>— (açılış bakiyesi eksik)</span>
                          <span className="block text-xs" style={{ color: "var(--text-2)" }}>
                            {`Hareket net değişimi: ${formatMoney(p.movementNet, p.currency)}`}
                          </span>
                        </div>
                      ) : (
                        formatMoney(p.derivedBalance, p.currency)
                      )}
                    </td>
                    <td className="text-right tabular-nums">
                      {!p.openingKnown ? (
                        <span style={{ color: "var(--text-2)" }}>açılış eksik</span>
                      ) : p.statedMinusDerived == null ? (
                        <span style={{ color: "var(--text-2)" }}>beyan yok</span>
                      ) : Math.abs(p.statedMinusDerived) > 0.01 ? (
                        <span style={{ color: "var(--warn)" }}>
                          {formatMoney(p.statedMinusDerived, p.currency)}
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="text-right tabular-nums" style={{ color: "var(--text-2)" }}>
                      {p.blockedBalance == null ? "—" : formatMoney(p.blockedBalance, p.currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableShell>
        )}
      </Panel>

      <Panel
        title="Günlük Nakit Hareket Özeti"
        subtitle="Para birimi bazında gerçekleşen günlük giriş, çıkış, net hareket ve kümülatif akış (son 30 gün)"
      >
        {dailyMovements.length === 0 ? (
          <EmptyState>Henüz gerçekleşmiş günlük nakit hareketi bulunmuyor.</EmptyState>
        ) : (
          <TableShell>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase" style={{ color: "var(--text-2)" }}>
                  <th className="py-1">Tarih</th>
                  <th>Kur</th>
                  <th className="text-right">Giriş</th>
                  <th className="text-right">Çıkış</th>
                  <th className="text-right">Günlük Net</th>
                  <th className="text-right">Kümülatif Net</th>
                  <th className="text-right">İşlem Adedi</th>
                </tr>
              </thead>
              <tbody>
                {dailyMovements.map((dm) => (
                  <tr
                    key={`${dm.txnDate}-${dm.currency}`}
                    className="border-t"
                    style={{ borderColor: "var(--line)", color: "var(--text-1)" }}
                  >
                    <td className="py-2 font-mono text-xs tabular-nums">{dm.txnDate}</td>
                    <td className="font-mono text-xs">{dm.currency}</td>
                    <td className="text-right font-mono tabular-nums" style={{ color: "var(--pos)" }}>
                      {formatMoney(dm.inflow, dm.currency)}
                    </td>
                    <td className="text-right font-mono tabular-nums" style={{ color: "var(--neg)" }}>
                      {formatMoney(dm.outflow, dm.currency)}
                    </td>
                    <td
                      className="text-right font-mono tabular-nums"
                      style={{ color: dm.netMovement < 0 ? "var(--neg)" : "var(--pos)" }}
                    >
                      {formatMoney(dm.netMovement, dm.currency)}
                    </td>
                    <td className="text-right font-mono tabular-nums">
                      {formatMoney(dm.runningNet, dm.currency)}
                    </td>
                    <td className="text-right font-mono text-xs tabular-nums" style={{ color: "var(--text-2)" }}>
                      {dm.movementCount}
                      {dm.foreignTxnCount > 0 ? ` (${dm.foreignTxnCount} YP)` : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableShell>
        )}
      </Panel>

      <Panel
        title="NAKİT AKIŞI MUTABAKATI"
        subtitle="hazine pozisyonu ile cashflow_months kapanış bakiyesi — fark varsa gizlenmez"
      >
        {recon.length === 0 ? (
          <EmptyState>Karşılaştırılacak nakit akış ayı yok.</EmptyState>
        ) : (
          <TableShell>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase" style={{ color: "var(--text-2)" }}>
                  <th className="py-1">Ay</th>
                  <th className="text-right">Nakit akışı (kapanış)</th>
                  <th className="text-right">Hazine (türetilen)</th>
                  <th className="text-right">Fark</th>
                  <th>Durum</th>
                </tr>
              </thead>
              <tbody>
                {recon.map((r) => (
                  <tr
                    key={`${r.monthStart}-${r.currency}`}
                    className="border-t"
                    style={{ borderColor: "var(--line)", color: "var(--text-1)" }}
                  >
                    <td className="py-2 font-mono tabular-nums">
                      {r.monthStart.slice(0, 7)} ({r.currency})
                    </td>
                    <td className="text-right tabular-nums">
                      {r.cashflowClosing == null ? "—" : formatMoney(r.cashflowClosing, r.currency)}
                    </td>
                    <td className="text-right tabular-nums">
                      {r.treasuryClosing == null ? "—" : formatMoney(r.treasuryClosing, r.currency)}
                    </td>
                    <td className="text-right tabular-nums">
                      {r.difference == null ? "—" : formatMoney(r.difference, r.currency)}
                    </td>
                    <td>
                      <Badge tone={RECON_TONE[r.status]}>{RECONCILIATION_LABEL[r.status]}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableShell>
        )}
      </Panel>

      <Panel title="HAZİNE POLİTİKALARI" subtitle="nakit tabanı yapılandırması — yalnız yönetici değiştirir">
        <TableShell>
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase" style={{ color: "var(--text-2)" }}>
                <th className="py-1">Politika</th>
                <th>Tür</th>
                <th>Kur</th>
                <th className="text-right">Eşik</th>
                <th>Durum</th>
                <th>Değiştir</th>
              </tr>
            </thead>
            <tbody>
              {policies.map((p) => (
                <tr
                  key={p.id}
                  className="border-t"
                  style={{ borderColor: "var(--line)", color: "var(--text-1)" }}
                >
                  <td className="py-2">
                    {p.description}
                    <span className="block text-xs" style={{ color: "var(--text-2)" }}>
                      {p.code}
                    </span>
                  </td>
                  <td className="text-xs">{p.policyKind === "min_cash" ? "asgari kasa" : "tampon gün"}</td>
                  <td className="text-xs font-mono">{p.currency}</td>
                  <td className="text-right tabular-nums">
                    {p.policyKind === "min_cash"
                      ? formatMoney(p.thresholdAmount ?? 0, p.currency)
                      : `${p.thresholdDays ?? "—"} gün`}
                  </td>
                  <td>
                    <Badge tone={p.isActive ? "green" : "neutral"}>{p.isActive ? "aktif" : "pasif"}</Badge>
                  </td>
                  <td className="py-2">
                    <form action={updatePolicyAction} className="flex flex-wrap items-center gap-1">
                      <input type="hidden" name="code" value={p.code} />
                      {p.policyKind === "min_cash" ? (
                        <input
                          name="thresholdAmount"
                          type="number"
                          step="0.01"
                          min="0"
                          defaultValue={p.thresholdAmount ?? 0}
                          className="field-control w-24 px-1 py-0.5 text-[11px]"
                        />
                      ) : (
                        <input
                          name="thresholdDays"
                          type="number"
                          min="1"
                          defaultValue={p.thresholdDays ?? 30}
                          className="field-control w-16 px-1 py-0.5 text-[11px]"
                        />
                      )}
                      <label className="flex items-center gap-1 text-[11px]" style={{ color: "var(--text-2)" }}>
                        <input type="checkbox" name="isActive" defaultChecked={p.isActive} /> aktif
                      </label>
                      <button className="button-ghost px-2 py-1 text-xs">kaydet</button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableShell>
      </Panel>
    </>
  );
}
