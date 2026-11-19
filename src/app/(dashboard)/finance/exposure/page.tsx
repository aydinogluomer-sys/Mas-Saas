import Link from "@/components/ui/app-link";
import { Badge } from "@/components/ui/badge";
import { fmtTL, Panel } from "@/components/ui/panel";
import { EmptyState, KeyStat, PageHeader, TableShell } from "@/components/ui/shell";
import { requireRouteAccess } from "@/lib/authz/route-guard";
import { getPool } from "@/lib/db";
import { loadExposureMatrixWorkspace } from "@/lib/financing/fx-consolidation";
import { formatMoney } from "@/lib/money-format";
import { istanbulDateISO } from "@/lib/reports/rules";

export const dynamic = "force-dynamic";

export default async function ExposurePage() {
  const denied = await requireRouteAccess("/finance/exposure");
  if (denied) return denied;

  const pool = getPool();
  const today = istanbulDateISO();
  const ws = await loadExposureMatrixWorkspace(pool, today);

  return (
    <>
      <PageHeader
        title="Karşı Taraf, Banka & Döviz Konsantrasyon Matrisi"
        subtitle="Fatura, çek/senet, banka nakdi, vadeli mevduat, kredi borcu, BCH limit boşluğu ve teminat mektuplarını kapsayan tam açık risk görünümü"
        action={
          <div className="flex flex-wrap items-center gap-2">
            <Link href="/finance/counterparties" className="button-ghost px-3 py-1.5 text-xs">
              Cari Hesap Ekstreleri
            </Link>
            <Link href="/finance/fx" className="button-ghost px-3 py-1.5 text-xs">
              Kur Riski &amp; Hedge
            </Link>
          </div>
        }
      />

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <KeyStat
          label="Toplam Alacak + Çek Riski"
          value={fmtTL(ws.totals.totalReceivablesTry)}
          tone="pos"
          sub={
            ws.totals.topCounterpartyConcentrationPct != null
              ? `En yüksek müşteri payı: %${ws.totals.topCounterpartyConcentrationPct.toFixed(1)}`
              : undefined
          }
        />
        <KeyStat
          label="Toplam Ticari Borç + Çek"
          value={fmtTL(ws.totals.totalPayablesTry)}
          tone="neg"
        />
        <KeyStat
          label="Banka Nakit + Vadeli"
          value={fmtTL(ws.totals.totalBankCashTry)}
          tone="pos"
        />
        <KeyStat
          label="Banka Kredi + BCH Borcu"
          value={fmtTL(ws.totals.totalBankDebtTry)}
          tone="neg"
          sub={`Boş limit: ${fmtTL(ws.totals.totalFacilityHeadroomTry)}`}
        />
        <KeyStat
          label="Teminat Mektupları (910)"
          value={fmtTL(ws.totals.totalGuaranteesTry)}
          tone="neutral"
        />
        <KeyStat
          label="Kredi Limiti Aşan Cari"
          value={ws.totals.overLimitCounterpartyCount}
          tone={ws.totals.overLimitCounterpartyCount > 0 ? "neg" : "pos"}
          sub={`Net döviz pozisyonu: ${fmtTL(ws.totals.netFxOpenTry)}`}
        />
      </div>

      <Panel
        title="Banka Konsantrasyon & Net Pozisyon Matrisi"
        subtitle="Vadesiz kasa/banka, 102.05 vadeli mevduat, kredi anapara/faiz bakiyesi, kredi limit kullanımı/boşluğu ve 910 teminat mektupları (TCMB son kur ile TL karşılığı)"
      >
        {ws.banks.length === 0 ? (
          <EmptyState>Aktif banka nakdi, kredi veya limit kaydı bulunmuyor.</EmptyState>
        ) : (
          <TableShell>
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left uppercase" style={{ color: "var(--text-2)" }}>
                  <th className="py-1.5">Banka / Kurum</th>
                  <th className="text-right">Vadesiz Nakit</th>
                  <th className="text-right">Vadeli Mevduat</th>
                  <th className="text-right">Kredi Borcu</th>
                  <th className="text-right">BCH Kullanılan</th>
                  <th className="text-right">Boş Kredi Limiti</th>
                  <th className="text-right">Teminat Mektubu</th>
                  <th className="text-right">Net Pozisyon (TL)</th>
                </tr>
              </thead>
              <tbody>
                {ws.banks.map((b) => (
                  <tr
                    key={b.bankName}
                    className="border-t"
                    style={{ borderColor: "var(--line)", color: "var(--text-1)" }}
                  >
                    <td className="py-2 font-medium">
                      {b.bankName}
                      {b.missingFxCurrencies.length > 0 ? (
                        <span className="ml-1.5 font-mono text-[10px] text-warn">
                          ({b.missingFxCurrencies.join(",")} kur bekliyor)
                        </span>
                      ) : null}
                    </td>
                    <td className="text-right font-mono tabular-nums text-pos">
                      {fmtTL(b.cashTryEquivalent)}
                    </td>
                    <td className="text-right font-mono tabular-nums text-pos">
                      {fmtTL(b.termDepositTryEquivalent)}
                    </td>
                    <td className="text-right font-mono tabular-nums text-neg">
                      {fmtTL(b.loanDebtTryEquivalent)}
                    </td>
                    <td className="text-right font-mono tabular-nums text-neg">
                      {fmtTL(b.facilityDrawnTryEquivalent)}
                    </td>
                    <td className="text-right font-mono tabular-nums">
                      {fmtTL(b.facilityHeadroomTryEquivalent)}
                    </td>
                    <td className="text-right font-mono tabular-nums" style={{ color: "var(--text-2)" }}>
                      {fmtTL(b.guaranteeLettersTryEquivalent)}
                    </td>
                    <td
                      className={`text-right font-mono font-semibold tabular-nums ${
                        b.netPositionTry < 0 ? "text-neg" : "text-pos"
                      }`}
                    >
                      {fmtTL(b.netPositionTry)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableShell>
        )}
      </Panel>

      <Panel
        title="Karşı Taraf Açık Risk & Kredi Limiti Matrisi"
        subtitle="Açık satış/alış faturaları ve portföydeki/cirolu/verilen çek-senetler ile tanımlı cari kredi limiti aşım kontrolü (%40 yoğunlaşma eşiği)"
      >
        {ws.counterparties.length === 0 ? (
          <EmptyState>Açık fatura veya çek/senet riski taşıyan karşı taraf bulunmuyor.</EmptyState>
        ) : (
          <TableShell>
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left uppercase" style={{ color: "var(--text-2)" }}>
                  <th className="py-1.5">Karşı Taraf</th>
                  <th>Döviz</th>
                  <th className="text-right">Açık Alacak</th>
                  <th className="text-right">Gecikmiş Alacak</th>
                  <th className="text-right">Alacak Çeki</th>
                  <th className="text-right">Açık Borç + Çek</th>
                  <th className="text-right">Kredi Limiti</th>
                  <th className="text-right">Alacak Payı</th>
                  <th>Risk Durumu</th>
                </tr>
              </thead>
              <tbody>
                {ws.counterparties.map((cp) => {
                  const apTotal = cp.payableOpen + cp.checksOutflowOpen;
                  const highConcentration = (cp.shareOfReceivablesPct ?? 0) > 40;
                  return (
                    <tr
                      key={`${cp.partyId}-${cp.currency}`}
                      className="border-t"
                      style={{ borderColor: "var(--line)", color: "var(--text-1)" }}
                    >
                      <td className="py-2 font-medium">{cp.partyName}</td>
                      <td className="font-mono">{cp.currency}</td>
                      <td className="text-right font-mono tabular-nums text-pos">
                        {formatMoney(cp.receivableOpen, cp.currency)}
                      </td>
                      <td className="text-right font-mono tabular-nums text-neg">
                        {cp.receivableOverdue > 0
                          ? formatMoney(cp.receivableOverdue, cp.currency)
                          : "—"}
                      </td>
                      <td className="text-right font-mono tabular-nums">
                        {cp.checksInflowOpen > 0
                          ? formatMoney(cp.checksInflowOpen, cp.currency)
                          : "—"}
                      </td>
                      <td className="text-right font-mono tabular-nums text-neg">
                        {apTotal > 0 ? formatMoney(apTotal, cp.currency) : "—"}
                      </td>
                      <td className="text-right font-mono tabular-nums">
                        {cp.creditLimit != null ? formatMoney(cp.creditLimit, cp.currency) : "—"}
                      </td>
                      <td
                        className={`text-right font-mono tabular-nums ${
                          highConcentration ? "font-semibold text-neg" : ""
                        }`}
                      >
                        {cp.shareOfReceivablesPct != null
                          ? `%${cp.shareOfReceivablesPct.toFixed(1)}`
                          : "—"}
                      </td>
                      <td>
                        {cp.overCreditLimit ? (
                          <Badge tone="red">Limit Aşımı</Badge>
                        ) : highConcentration ? (
                          <Badge tone="amber">%40+ Yoğunlaşma</Badge>
                        ) : (
                          <Badge tone="green">Normal</Badge>
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

      {ws.fxRows.length > 0 ? (
        <Panel
          title="Döviz Açık Pozisyon & +%10 / +%20 Şok Özeti"
          subtitle="Para birimi bazında net döviz pozisyonu ve olası kur şoku kâr/zarar etkisi"
        >
          <TableShell>
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left uppercase" style={{ color: "var(--text-2)" }}>
                  <th className="py-1.5">Döviz</th>
                  <th className="text-right">Net Orijinal Pozisyon</th>
                  <th className="text-right">TCMB Kur</th>
                  <th className="text-right">Net TL Karşılığı</th>
                  <th className="text-right">+%10 Şok Etkisi</th>
                  <th className="text-right">+%20 Şok Etkisi</th>
                </tr>
              </thead>
              <tbody>
                {ws.fxRows.map((fx) => (
                  <tr
                    key={fx.currency}
                    className="border-t"
                    style={{ borderColor: "var(--line)", color: "var(--text-1)" }}
                  >
                    <td className="py-1.5 font-mono font-semibold">{fx.currency}</td>
                    <td className="text-right font-mono tabular-nums">
                      {formatMoney(fx.netFxPosition, fx.currency)}
                    </td>
                    <td className="text-right font-mono tabular-nums">
                      {fx.latestTcmbRate != null ? fx.latestTcmbRate.toFixed(4) : "—"}
                    </td>
                    <td className="text-right font-mono tabular-nums">
                      {fx.netTryEquivalent != null ? fmtTL(fx.netTryEquivalent) : "—"}
                    </td>
                    <td
                      className={`text-right font-mono tabular-nums ${
                        (fx.shock10PctPnlTry ?? 0) < 0 ? "text-neg" : "text-pos"
                      }`}
                    >
                      {fx.shock10PctPnlTry != null ? fmtTL(fx.shock10PctPnlTry) : "—"}
                    </td>
                    <td
                      className={`text-right font-mono tabular-nums ${
                        (fx.shock20PctPnlTry ?? 0) < 0 ? "text-neg" : "text-pos"
                      }`}
                    >
                      {fx.shock20PctPnlTry != null ? fmtTL(fx.shock20PctPnlTry) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableShell>
        </Panel>
      ) : null}
    </>
  );
}
