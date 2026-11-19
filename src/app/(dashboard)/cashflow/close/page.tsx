import Link from "@/components/ui/app-link";
import { ActionFeedback } from "@/components/ui/action-feedback";
import { Badge } from "@/components/ui/badge";
import { Panel } from "@/components/ui/panel";
import { KpiCard, PageHeader, TableShell } from "@/components/ui/shell";
import { getRequestUser } from "@/lib/auth";
import { canManagePeriodLock } from "@/lib/authz/matrix";
import { requireRouteAccess } from "@/lib/authz/route-guard";
import {
  evaluatePeriodCloseReadiness,
  listAccountingPeriodsOverview,
} from "@/lib/cashflow/period-lock";
import { getPool } from "@/lib/db";
import { istanbulDateISO } from "@/lib/reports/rules";
import { lockCashflowPeriodAction, reopenCashflowPeriodAction } from "../actions";

export const dynamic = "force-dynamic";

export default async function CashflowClosePage({
  searchParams,
}: {
  searchParams?: Promise<{ ym?: string; error?: string; notice?: string }>;
}) {
  const denied = await requireRouteAccess("/cashflow/close");
  if (denied) return denied;

  const sp = (await searchParams) ?? {};
  const today = istanbulDateISO();
  const defaultYm = today.slice(0, 7);
  const selectedYm = /^\d{4}-(0[1-9]|1[0-2])$/.test(sp.ym ?? "") ? sp.ym! : defaultYm;

  const pool = getPool();
  const user = await getRequestUser();
  const canLock = user != null && canManagePeriodLock(user.role);

  const [readiness, periods] = await Promise.all([
    evaluatePeriodCloseReadiness(pool, selectedYm),
    listAccountingPeriodsOverview(pool, today),
  ]);

  const lockedCount = periods.filter((p) => p.status === "locked").length;
  const returnTo = `/cashflow/close?ym=${encodeURIComponent(selectedYm)}`;

  return (
    <>
      <PageHeader
        title="Muhasebe ve nakit dönem kapanışı"
        subtitle="Excel içe aktarımı olmasa dahi her takvim ayını (YYYY-AA) bağımsız olarak denetleyin, kilitleyin veya gerekçeli olarak yeniden açın."
        meta={
          <Badge tone={readiness.status === "locked" ? "green" : "neutral"} dot>
            {selectedYm} · {readiness.status === "locked" ? "Kilitli" : readiness.status}
          </Badge>
        }
      />

      <ActionFeedback error={sp.error} success={sp.notice} />

      <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
        <KpiCard
          label="Seçili dönem"
          value={selectedYm}
          tone={readiness.status === "locked" ? "pos" : readiness.blockerCount > 0 ? "neg" : "info"}
          note={`Durum: ${readiness.status}`}
        />
        <KpiCard
          label="Eşleşmemiş banka"
          value={readiness.unmatchedBankTxCount}
          tone={readiness.unmatchedBankTxCount > 0 ? "warn" : "pos"}
          note="Banka mutabakat bekleyen"
        />
        <KpiCard
          label="Geçici kur (provisional FX)"
          value={readiness.provisionalFxEntryCount}
          tone={readiness.provisionalFxEntryCount > 0 ? "warn" : "pos"}
          note="Kesin TCMB kuru bekleyen fiş"
        />
        <KpiCard
          label="Taslak fatura / Eksik ödeme"
          value={`${readiness.draftInvoiceCount} / ${readiness.missingAmountPaymentCount}`}
          tone={readiness.blockerCount > 0 ? "neg" : "pos"}
          note={`Toplam ${lockedCount} kilitli dönem`}
        />
      </div>

      <Panel
        title={`DÖNEM KAPANIŞ KONTROLÜ — ${selectedYm}`}
        subtitle="public.accounting_periods birincil otoritesi (varsa cashflow_months ile atomik senkron)"
        right={
          <form action="/cashflow/close" className="flex items-center gap-2">
            <input
              type="month"
              name="ym"
              defaultValue={selectedYm}
              aria-label="Kapanış dönemi seç"
              className="field-control px-2 py-1 font-mono text-xs"
            />
            <button type="submit" className="button-ghost px-2.5 py-1 text-xs">
              Dönemi Yükle
            </button>
          </form>
        }
      >
        <div className="space-y-3">
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
            {readiness.items.map((item) => (
              <div
                key={item.code}
                className="flex items-start justify-between gap-3 border border-line bg-surface-2 p-2.5 text-xs"
              >
                <div>
                  <div className="font-medium text-tone-1">{item.label}</div>
                  <div className="mt-0.5 text-[11px] text-tone-3">{item.detail}</div>
                </div>
                <Badge
                  tone={
                    item.severity === "blocker" ? "red" : item.severity === "warning" ? "amber" : "green"
                  }
                >
                  {item.severity === "blocker"
                    ? `ENGEL (${item.count})`
                    : item.severity === "warning"
                      ? `UYARI (${item.count})`
                      : "TAMAM"}
                </Badge>
              </div>
            ))}
          </div>

          {readiness.lockedAt && (
            <div className="font-mono text-[11px] text-tone-3">
              Son kilitleme: {readiness.lockedAt}
              {readiness.lockedByName ? ` · ${readiness.lockedByName}` : ""}
              {readiness.lockFingerprint ? ` · SHA-256: ${readiness.lockFingerprint}` : ""}
            </div>
          )}

          {readiness.reopenedAt && (
            <div className="font-mono text-[11px] text-warn">
              Son kilit açma: {readiness.reopenedAt}
              {readiness.reopenedByName ? ` · ${readiness.reopenedByName}` : ""}
              {readiness.reopenReason ? ` · Gerekçe: "${readiness.reopenReason}"` : ""}
            </div>
          )}

          {canLock && readiness.status !== "locked" && (
            <form
              action={lockCashflowPeriodAction}
              className="flex flex-wrap items-end gap-2 border-t border-line pt-3"
            >
              <input type="hidden" name="monthId" value={selectedYm} />
              <input type="hidden" name="returnTo" value={returnTo} />
              <label className="flex min-w-60 flex-1 flex-col gap-1">
                <span className="font-mono text-[10px] uppercase tracking-wider text-tone-3">
                  Kapanış notu (isteğe bağlı)
                </span>
                <input
                  type="text"
                  name="notes"
                  maxLength={500}
                  placeholder="Ay sonu banka, KDV ve yevmiye mutabakatı tamamlandı"
                  className="field-control px-2 py-1.5 text-xs"
                />
              </label>
              <button
                type="submit"
                disabled={!readiness.readyToLock}
                className="button-primary px-3 py-1.5 text-xs disabled:cursor-not-allowed disabled:opacity-50"
              >
                {selectedYm} Dönemini Kilitle
              </button>
            </form>
          )}

          {canLock && readiness.status === "locked" && (
            <form
              action={reopenCashflowPeriodAction}
              className="flex flex-wrap items-end gap-2 border-t border-line pt-3"
            >
              <input type="hidden" name="monthId" value={selectedYm} />
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
                  placeholder="Örn: Geç ulaşan e-Fatura kaydının ilgili aya işlenmesi"
                  className="field-control px-2 py-1.5 text-xs"
                />
              </label>
              <button type="submit" className="button-ghost px-3 py-1.5 text-xs text-warn">
                Kilidi Gerekçeyle Aç
              </button>
            </form>
          )}

          {!canLock && (
            <div className="border-t border-line pt-2 font-mono text-[11px] text-tone-3">
              Dönem kilitleme ve kilit açma yetkisi yalnız Finans Yöneticisi veya Yöneticiye aittir.
            </div>
          )}
        </div>
      </Panel>

      <Panel
        title="TÜM MUHASEBE DÖNEMLERİ ÖZETİ (SON 12 + İLERİ 4 AY)"
        subtitle="Herhangi bir takvim ayına tıklayarak kapanış öncesi tanılamayı açabilirsiniz"
      >
        <TableShell>
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left font-mono text-[10px] uppercase text-tone-4">
                <th className="py-1">Dönem</th>
                <th>Durum</th>
                <th className="text-right">Taslak Fatura</th>
                <th className="text-right">Eksik Ödeme</th>
                <th className="text-right">Eşleşmemiş Banka</th>
                <th className="text-right">Provisional FX</th>
                <th>Son İşlem / Parmak İzi</th>
                <th className="text-right">Detay</th>
              </tr>
            </thead>
            <tbody>
              {periods.map((p) => (
                <tr key={p.ym} className="border-t border-line-faint">
                  <td className="py-1.5 font-mono font-semibold">
                    <Link href={`/cashflow/close?ym=${p.ym}`} className="underline underline-offset-2">
                      {p.ym}
                    </Link>
                  </td>
                  <td>
                    <Badge
                      tone={
                        p.status === "locked"
                          ? "green"
                          : p.status === "reviewed"
                            ? "amber"
                            : "neutral"
                      }
                    >
                      {p.status}
                    </Badge>
                  </td>
                  <td className={`text-right font-mono ${p.draftInvoiceCount > 0 ? "text-neg" : "text-tone-3"}`}>
                    {p.draftInvoiceCount}
                  </td>
                  <td className={`text-right font-mono ${p.missingAmountPaymentCount > 0 ? "text-neg" : "text-tone-3"}`}>
                    {p.missingAmountPaymentCount}
                  </td>
                  <td className={`text-right font-mono ${p.unmatchedBankTxCount > 0 ? "text-warn" : "text-tone-3"}`}>
                    {p.unmatchedBankTxCount}
                  </td>
                  <td className={`text-right font-mono ${p.provisionalFxEntryCount > 0 ? "text-warn" : "text-tone-3"}`}>
                    {p.provisionalFxEntryCount}
                  </td>
                  <td className="font-mono text-[11px] text-tone-3">
                    {p.lockedAt ? `${p.lockedAt}${p.lockFingerprint ? ` · #${p.lockFingerprint.slice(0, 8)}` : ""}` : "—"}
                  </td>
                  <td className="text-right">
                    <Link href={`/cashflow/${p.ym}`} className="button-ghost px-2 py-0.5 text-xs">
                      Ay detayı
                    </Link>
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
