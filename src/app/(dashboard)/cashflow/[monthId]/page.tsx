import Link from "@/components/ui/app-link";
import { notFound } from "next/navigation";
import { AnalyticsChart } from "@/components/charts/analytics-chart";
import { ActionFeedback } from "@/components/ui/action-feedback";
import { Badge } from "@/components/ui/badge";
import { fmtTL, Panel } from "@/components/ui/panel";
import { TableShell } from "@/components/ui/shell";
import { getRequestUser } from "@/lib/auth";
import { canManagePeriodLock } from "@/lib/authz/matrix";
import { requireRouteAccess } from "@/lib/authz/route-guard";
import { loadHybridMonthDetail } from "@/lib/cashflow/live-hybrid";
import { evaluatePeriodCloseReadiness } from "@/lib/cashflow/period-lock";
import { getPool } from "@/lib/db";
import { add, decimal, sub } from "@/lib/money";
import { formatMoney } from "@/lib/money-format";
import { istanbulDateISO } from "@/lib/reports/rules";
import { lockCashflowPeriodAction, reopenCashflowPeriodAction } from "../actions";

export const dynamic = "force-dynamic";

const GROUPS: Array<[string, string]> = [
  ["customer_income", "MÜŞTERİ GELİRLERİ"],
  ["vendor_payment", "CARİ ÖDEMELER"],
  ["operational_cost", "İŞLETME GİDERLERİ (personel · genel)"],
  ["tax", "VERGİ / SGK"],
  ["loan_payment", "KREDİ / FİNANSMAN"],
  ["bank_balance", "BANKA / HESAP BAKİYELERİ"],
  ["adjustment", "YAN TAKİP (adjustment)"],
];

const TMS7_LABEL = {
  operating: "İşletme",
  investing: "Yatırım (CAPEX)",
  financing: "Finansman",
} as const;

export default async function CashflowMonthPage({
  params,
  searchParams,
}: {
  params: Promise<{ monthId: string }>;
  searchParams?: Promise<{ error?: string; notice?: string }>;
}) {
  const denied = await requireRouteAccess("/cashflow/[monthId]");
  if (denied) return denied;
  const { monthId } = await params;
  const sp = (await searchParams) ?? {};
  const today = istanbulDateISO();
  const [pool, user] = [getPool(), await getRequestUser()];
  const canLock = user != null && canManagePeriodLock(user.role);

  const m = await loadHybridMonthDetail(pool, monthId, today);
  if (!m) notFound();

  const readiness = await evaluatePeriodCloseReadiness(pool, m.cashflowMonthId ?? m.accountingPeriodId ?? m.ym);

  const identity =
    m.opening != null && m.income != null && m.expense != null && m.closing != null
      ? sub(sub(add(m.opening, m.income), m.expense), m.closing).abs().lte(decimal(1))
      : null;

  const head: Array<[string, number | null]> = [
    ["DEVİR", m.opening],
    ["GELİR", m.income],
    ["GİDER", m.expense],
    ["FARK", m.delta],
    ["KASA", m.closing],
  ];
  const fmt = (v: number | null) =>
    v != null ? new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 0 }).format(v) : "—";

  const others = m.importedLines.filter((l) => !GROUPS.some(([t]) => t === l.line_type));
  const returnTo = `/cashflow/${encodeURIComponent(monthId)}`;

  return (
    <>
      <ActionFeedback error={sp.error} success={sp.notice} />

      <Panel
        title={`NAKİT AKIŞ — ${m.ym}`}
        right={
          <span className="flex flex-wrap items-center gap-2">
            {readiness.status === "locked" ? (
              <Badge tone="green">DÖNEM KİLİTLİ 🔒</Badge>
            ) : (
              <Badge tone="neutral">{readiness.status}</Badge>
            )}
            {identity == null ? (
              <Badge tone="amber">kimlik doğrulanamadı</Badge>
            ) : identity ? (
              <Badge tone="green">kasa = devir + gelir − gider ✓</Badge>
            ) : (
              <Badge tone="red">kimlik UYUŞMUYOR</Badge>
            )}
            <Link href="/cashflow/monthly" className="font-mono text-[10px] uppercase text-tone-2 underline underline-offset-2">
              ← aylık görünüm
            </Link>
          </span>
        }
      >
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
          {head.map(([k, v]) => (
            <div key={k} className="border border-line bg-surface-2 p-2">
              <div className="font-mono text-[9px] uppercase tracking-wider text-tone-3">{k}</div>
              <div className={`font-mono text-sm tabular-nums ${v != null && v < 0 ? "text-neg" : "text-tone-1"}`}>
                {fmt(v)}
              </div>
            </div>
          ))}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-3 font-mono text-[10px] text-tone-3">
          <span>durum: {readiness.status} · kaynak: {m.confidence}</span>
          {m.source_workbook_id && m.source_sheet_id && (
            <Link
              className="underline decoration-line-strong underline-offset-2"
              href={`/data/imports/${m.source_workbook_id}/sheets/${m.source_sheet_id}`}
            >
              kaynak sekme: {m.sheet_name} →
            </Link>
          )}
        </div>
      </Panel>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <div className="border border-line bg-surface-1 p-3">
          <div className="font-mono text-[10px] uppercase tracking-wider text-tone-3">TMS 7 İşletme (Operating)</div>
          <div className={`mt-1 font-mono text-sm tabular-nums ${m.tms7.operatingNet < 0 ? "text-neg" : "text-pos"}`}>
            {fmtTL(m.tms7.operatingNet)}
          </div>
          <div className="font-mono text-[11px] text-tone-3">
            +{fmtTL(m.tms7.operatingInflow)} / −{fmtTL(m.tms7.operatingOutflow)}
          </div>
        </div>
        <div className="border border-line bg-surface-1 p-3">
          <div className="font-mono text-[10px] uppercase tracking-wider text-tone-3">TMS 7 Yatırım (Investing)</div>
          <div className={`mt-1 font-mono text-sm tabular-nums ${m.tms7.investingNet < 0 ? "text-neg" : "text-tone-1"}`}>
            {fmtTL(m.tms7.investingNet)}
          </div>
          <div className="font-mono text-[11px] text-tone-3">
            +{fmtTL(m.tms7.investingInflow)} / −{fmtTL(m.tms7.investingOutflow)}
          </div>
        </div>
        <div className="border border-line bg-surface-1 p-3">
          <div className="font-mono text-[10px] uppercase tracking-wider text-tone-3">TMS 7 Finansman (Financing)</div>
          <div className={`mt-1 font-mono text-sm tabular-nums ${m.tms7.financingNet < 0 ? "text-neg" : "text-tone-1"}`}>
            {fmtTL(m.tms7.financingNet)}
          </div>
          <div className="font-mono text-[11px] text-tone-3">
            +{fmtTL(m.tms7.financingInflow)} / −{fmtTL(m.tms7.financingOutflow)}
          </div>
        </div>
      </div>

      <AnalyticsChart model={m.dailyChartModel} kind="bar" defaultPeriod="3m" />

      <Panel
        title="DÖNEM KAPANIŞ KONTROL LİSTESİ & DÖNEM KİLİDİ"
        subtitle="PostgreSQL BEFORE tetikleyicisi kilitli döneme geçmişe dönük yazma/silmeyi doğrudan reddeder"
        right={
          readiness.status === "locked" ? (
            <Badge tone="green">
              kilitli{readiness.lockFingerprint ? ` · #${readiness.lockFingerprint.slice(0, 10)}` : ""}
            </Badge>
          ) : readiness.blockerCount > 0 ? (
            <Badge tone="red">{readiness.blockerCount} engelleyici</Badge>
          ) : readiness.warningCount > 0 ? (
            <Badge tone="amber">{readiness.warningCount} uyarı · kapatılabilir</Badge>
          ) : (
            <Badge tone="green">kapatmaya hazır</Badge>
          )
        }
      >
        <div className="space-y-2">
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
            {readiness.items.map((item) => (
              <div key={item.code} className="flex items-start justify-between gap-3 border border-line bg-surface-2 p-2.5 text-xs">
                <div>
                  <div className="font-medium text-tone-1">{item.label}</div>
                  <div className="mt-0.5 text-[11px] text-tone-3">{item.detail}</div>
                </div>
                <Badge
                  tone={
                    item.severity === "blocker" ? "red" : item.severity === "warning" ? "amber" : "green"
                  }
                >
                  {item.severity === "blocker" ? `ENGEL (${item.count})` : item.severity === "warning" ? `UYARI (${item.count})` : "TAMAM"}
                </Badge>
              </div>
            ))}
          </div>

          {readiness.lockedAt ? (
            <div className="font-mono text-[11px] text-tone-3">
              son kilitleme: {readiness.lockedAt}
              {readiness.lockedByName ? ` · ${readiness.lockedByName}` : ""}
              {readiness.lockFingerprint ? ` · parmak izi: ${readiness.lockFingerprint}` : ""}
            </div>
          ) : null}

          {readiness.reopenedAt ? (
            <div className="font-mono text-[11px] text-warn">
              son kilit açma: {readiness.reopenedAt}
              {readiness.reopenedByName ? ` · ${readiness.reopenedByName}` : ""}
              {readiness.reopenReason ? ` · gerekçe: "${readiness.reopenReason}"` : ""}
            </div>
          ) : null}

          {canLock && readiness.status !== "locked" ? (
            <form action={lockCashflowPeriodAction} className="mt-2 flex flex-wrap items-end gap-2 border-t border-line pt-2.5">
              <input type="hidden" name="monthId" value={m.cashflowMonthId ?? m.accountingPeriodId ?? m.ym} />
              <input type="hidden" name="returnTo" value={returnTo} />
              <label className="flex min-w-60 flex-1 flex-col gap-1">
                <span className="font-mono text-[10px] uppercase tracking-wider text-tone-3">
                  Kapanış notu (isteğe bağlı)
                </span>
                <input
                  type="text"
                  name="notes"
                  maxLength={500}
                  placeholder="Ay sonu mutabakatı tamamlandı"
                  className="field-control px-2 py-1.5 text-xs"
                />
              </label>
              <button
                type="submit"
                disabled={!readiness.readyToLock}
                title={
                  readiness.readyToLock
                    ? "Dönemi veritabanı seviyesinde kilitle"
                    : "Engelleyici maddeler çözülmeden dönem kilitlenemez"
                }
                className="button-ghost px-3 py-1.5 text-xs disabled:cursor-not-allowed disabled:opacity-50"
              >
                Dönemi kilitle
              </button>
            </form>
          ) : null}

          {canLock && readiness.status === "locked" ? (
            <details className="mt-2 border border-warn bg-surface-2 p-2.5">
              <summary className="cursor-pointer font-mono text-xs text-warn">
                Kilidi yeniden aç
              </summary>
              <form action={reopenCashflowPeriodAction} className="mt-2.5 flex flex-wrap items-end gap-2">
                <input type="hidden" name="monthId" value={m.cashflowMonthId ?? m.accountingPeriodId ?? m.ym} />
                <input type="hidden" name="returnTo" value={returnTo} />
                <label className="flex min-w-70 flex-1 flex-col gap-1">
                  <span className="font-mono text-[10px] uppercase tracking-wider text-warn">
                    Zorunlu yeniden açma gerekçesi (en az 10 karakter)
                  </span>
                  <input
                    required
                    minLength={10}
                    maxLength={500}
                    type="text"
                    name="reason"
                    placeholder="Örn: Geç gelen tedarikçi faturası düzeltmesi için"
                    className="field-control px-2 py-1.5 text-xs"
                  />
                </label>
                <button type="submit" className="button-ghost px-3 py-1.5 text-xs text-warn">
                  Kilidi aç
                </button>
              </form>
            </details>
          ) : null}

          {!canLock ? (
            <div className="border-t border-line pt-2 font-mono text-[11px] text-tone-3">
              Dönem kilitleme ve yeniden açma işlemleri yalnız Finans Yöneticisi veya Yönetici yetkisiyle yapılabilir.
            </div>
          ) : null}
        </div>
      </Panel>

      {m.liveLines.length > 0 && (
        <Panel
          title={`CANLI BANKA & AÇIK VADE HAREKETLERİ — ${m.liveLines.length}`}
          subtitle="Banka ekstrelerinden gerçekleşen işlemler ve ay içindeki açık tahsilat/ödeme vadeleri"
        >
          <TableShell>
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left font-mono text-[10px] uppercase text-tone-4">
                  <th className="py-1">Tarih</th>
                  <th>Kaynak</th>
                  <th>TMS 7</th>
                  <th>Açıklama / Karşı Taraf</th>
                  <th className="text-right">Tutar</th>
                </tr>
              </thead>
              <tbody>
                {m.liveLines.map((line) => (
                  <tr key={line.id} className="border-t border-line-faint">
                    <td className="py-1.5 font-mono">{line.date}</td>
                    <td>
                      <Badge tone={line.origin === "bank_actual" ? "green" : "blue"}>
                        {line.origin === "bank_actual" ? "Fiili Banka" : "Açık Vade"}
                      </Badge>
                    </td>
                    <td>
                      <Badge tone="neutral">{TMS7_LABEL[line.tms7]}</Badge>
                    </td>
                    <td>
                      {line.label}
                      {line.counterparty && <span className="ml-2 text-tone-3">· {line.counterparty}</span>}
                    </td>
                    <td className={`text-right font-mono tabular-nums ${line.amountSigned < 0 ? "text-neg" : "text-pos"}`}>
                      {line.amountSigned < 0 ? "−" : "+"}
                      {formatMoney(Math.abs(line.amountSigned), line.currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableShell>
        </Panel>
      )}

      {GROUPS.map(([type, title]) => {
        const list = m.importedLines.filter((l) => l.line_type === type);
        if (list.length === 0) return null;
        return (
          <Panel key={type} title={`${title} (EXCEL) — ${list.length}`}>
            <table className="w-full text-sm">
              <tbody>
                {list.map((l) => (
                  <tr key={l.id} className="border-b border-line-faint">
                    <td className="w-10 py-1 pr-2 font-mono text-xs text-tone-3">
                      {l.row_index != null ? `r${l.row_index}` : "—"}
                    </td>
                    <td className="py-1 pr-2">
                      {l.label}
                      {l.party && <span className="ml-2 font-mono text-[10px] text-info">↔ {l.party}</span>}
                    </td>
                    <td className={`py-1 text-right font-mono tabular-nums ${l.amount != null && l.amount < 0 ? "text-neg" : ""}`}>
                      {l.amount != null ? fmt(l.amount) : <Badge tone="amber">TUTAR EKSİK</Badge>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Panel>
        );
      })}

      {others.length > 0 && (
        <Panel title={`DİĞER SATIRLAR — ${others.length}`}>
          <table className="w-full text-sm">
            <tbody>
              {others.map((l) => (
                <tr key={l.id} className="border-b border-line-faint">
                  <td className="w-24 py-1 pr-2 font-mono text-[10px] text-tone-3">{l.line_type}</td>
                  <td className="py-1 pr-2">{l.label}</td>
                  <td className={`py-1 text-right font-mono tabular-nums ${l.amount != null && l.amount < 0 ? "text-neg" : ""}`}>
                    {l.amount != null ? fmt(l.amount) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Panel>
      )}
    </>
  );
}
