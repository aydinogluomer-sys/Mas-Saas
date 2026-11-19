import Link from "@/components/ui/app-link";
import { Badge, type Tone } from "@/components/ui/badge";
import { fmtTL, Panel } from "@/components/ui/panel";
import { EmptyState, KeyStat, PageHeader, TableShell } from "@/components/ui/shell";
import { requireRouteAccess } from "@/lib/authz/route-guard";
import { loadCalendar, loadCalendarDaily } from "@/lib/briefing/engine";
import { getTurkishHoliday } from "@/lib/calendar/tr-holidays";
import { generateTrStatutoryObligations } from "@/lib/calendar/tr-tax-calendar";
import { isReportingCurrency } from "@/lib/currency-policy";
import { getPool } from "@/lib/db";
import { isMissingSchemaError } from "@/lib/ledger/accounts";
import { moneyOrNull } from "@/lib/money";
import { formatMoney } from "@/lib/money-format";
import { istanbulDateISO } from "@/lib/reports/rules";

export const dynamic = "force-dynamic";

const KIND_LABEL: Record<string, string> = {
  payment_instance: "Ödeme",
  loan_installment: "Kredi taksiti",
  check: "Çek / Senet",
  invoice: "Fatura",
  promise_to_pay: "Ödeme sözü",
  facility_expiry: "Limit vadesi",
};
const CERTAINTY_LABEL: Record<string, string> = {
  contracted: "sözleşmeli",
  expected: "beklenen",
  renewal: "yenileme",
};
const CERTAINTY_TONE: Record<string, Tone> = {
  contracted: "neutral",
  expected: "amber",
  renewal: "blue",
};

const OBLIGATION_KIND_LABEL: Record<string, string> = {
  NET_MAAS: "Net Maaş Ödemesi (335)",
  MPHB_STOPAJ: "Muhtasar & Prim Hizmet Stopajı (360)",
  SGK_4A: "SGK 4A İşveren/İşçi Primi (361)",
  DAMGA_VERGISI: "Damga Vergisi (360)",
  KURUMLAR_GECICI_VERGI: "Kurumlar / Geçici Vergi (370)",
};

export default async function FinancialCalendarPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>;
}) {
  const denied = await requireRouteAccess("/finance/calendar");
  if (denied) return denied;
  const sp = await searchParams;
  const days = [30, 60, 90].includes(Number(sp.days)) ? Number(sp.days) : 30;
  const pool = getPool();
  const today = istanbulDateISO();
  const end = new Date(Date.parse(today) + days * 86400000).toISOString().slice(0, 10);

  const [rows, daily, taxAccrualsRes] = await Promise.all([
    loadCalendar(pool, today, end),
    loadCalendarDaily(pool, today, end),
    pool
      .query<{
        id: string;
        period_month: string;
        obligation_kind: string;
        due_date: string;
        accrued_amount: string;
        paid_amount: string;
        currency: string;
        is_paid: boolean;
      }>(
        `select id::text as id,
                to_char(period_month, 'YYYY-MM') as period_month,
                obligation_kind,
                to_char(due_date, 'YYYY-MM-DD') as due_date,
                accrued_amount::text,
                paid_amount::text,
                currency,
                is_paid
           from public.payroll_tax_accruals
          where due_date >= $1::date
            and due_date <= $2::date
          order by due_date asc, obligation_kind asc`,
        [today, end],
      )
      .catch((err: unknown) => {
        if (isMissingSchemaError(err)) return { rows: [], rowCount: 0 };
        throw err;
      }),
  ]);

  const statutoryObligations = generateTrStatutoryObligations(today, end);
  const taxAccruals = taxAccrualsRes.rows.map((r) => ({
    id: r.id,
    periodMonth: r.period_month,
    obligationKind: r.obligation_kind,
    dueDate: r.due_date,
    accruedAmount: moneyOrNull(r.accrued_amount) ?? 0,
    paidAmount: moneyOrNull(r.paid_amount) ?? 0,
    currency: r.currency || "TRY",
    isPaid: Boolean(r.is_paid),
  }));

  const dailyTry = daily.filter((d) => isReportingCurrency(d.currency));
  const foreignDays = daily.length - dailyTry.length;
  const contracted = dailyTry.reduce((s, d) => s + d.netContracted, 0);
  const expected = dailyTry.reduce((s, d) => s + d.netExpected, 0);
  const renewals = daily.reduce((s, d) => s + d.renewalCount, 0);
  const worst = [...dailyTry].sort(
    (a, b) => a.netContracted - b.netContracted || a.eventDate.localeCompare(b.eventDate),
  )[0];

  return (
    <>
      <PageHeader
        title="Finansal Takvim"
        subtitle="Ödeme, kredi taksiti, çek/senet, fatura, ödeme sözü, limit vadesi ve tahakkuk etmiş vergi/SGK/maaş yükümlülükleri — para birimi korunarak tek görünümde"
        meta={
          <Badge tone={contracted < 0 ? "amber" : "green"} dot>
            {days} günlük görünüm
          </Badge>
        }
        action={
          <span className="flex gap-1">
            {[30, 60, 90].map((d) => (
              <Link
                key={d}
                href={`/finance/calendar?days=${d}`}
                className={`border px-2.5 py-1 font-mono text-xs transition-colors ${
                  d === days ? "border-accent bg-surface-2 font-semibold" : "border-line-strong"
                }`}
              >
                {d}g
              </Link>
            ))}
          </span>
        }
      />

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <KeyStat
          label="Sözleşmeli net akış (TRY)"
          value={fmtTL(contracted)}
          tone={contracted < 0 ? "warn" : "pos"}
          sub={
            foreignDays > 0
              ? `İmzalı yükümlülükler · ${foreignDays} dövizli gün satırı kendi para biriminde listelenir`
              : "İmzalı yükümlülükler"
          }
        />
        <KeyStat
          label="Beklenen (ödeme sözü)"
          value={fmtTL(expected)}
          tone="neutral"
          sub="Söz verilmiş, taahhüt değil"
        />
        <KeyStat
          label="En kötü gün (TRY)"
          value={worst ? fmtTL(worst.netContracted) : "—"}
          tone={worst && worst.netContracted < 0 ? "neg" : "neutral"}
          sub={worst?.eventDate ?? "veri yok"}
        />
        <KeyStat
          label="Limit yenilemesi"
          value={String(renewals)}
          tone={renewals > 0 ? "warn" : "neutral"}
          sub="Nakit hareketi değil"
        />
      </div>

      <Panel title="GÜN GÜN AKIŞ (PARA BİRİMİ KORUMALI)">
        {daily.length === 0 ? (
          <EmptyState>Seçilen dönemde takvim kaydı yok.</EmptyState>
        ) : (
          <TableShell>
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left font-mono text-[10px] uppercase text-tone-4">
                  <th className="py-1">Tarih</th>
                  <th>Döviz</th>
                  <th>Kalem</th>
                  <th className="text-right">Giriş</th>
                  <th className="text-right">Çıkış</th>
                  <th className="text-right">Sözleşmeli net</th>
                  <th className="text-right">Beklenen</th>
                  <th className="text-right">Yenileme</th>
                </tr>
              </thead>
              <tbody>
                {daily.map((d) => {
                  const holiday = getTurkishHoliday(d.eventDate);
                  const ccy = d.currency || "TRY";
                  return (
                    <tr key={`${d.eventDate}-${ccy}`} className="border-t border-line-faint">
                      <td className="py-1 font-mono">
                        {d.eventDate}
                        {holiday ? (
                          <span className="ml-1.5 font-mono text-[9px] text-warn">
                            ({holiday.name})
                          </span>
                        ) : null}
                      </td>
                      <td className="font-mono font-semibold">{ccy}</td>
                      <td className="font-mono text-tone-3">{d.eventCount}</td>
                      <td className="text-right font-mono tabular-nums text-pos">
                        {d.inflowContracted ? formatMoney(d.inflowContracted, ccy) : "—"}
                      </td>
                      <td className="text-right font-mono tabular-nums text-neg">
                        {d.outflowContracted ? formatMoney(d.outflowContracted, ccy) : "—"}
                      </td>
                      <td
                        className={`text-right font-mono tabular-nums ${
                          d.netContracted < 0 ? "text-neg" : ""
                        }`}
                      >
                        {formatMoney(d.netContracted, ccy)}
                      </td>
                      <td className="text-right font-mono tabular-nums text-tone-3">
                        {d.netExpected ? formatMoney(d.netExpected, ccy) : "—"}
                      </td>
                      <td className="text-right font-mono text-tone-3">{d.renewalCount || "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </TableShell>
        )}
      </Panel>

      <Panel
        title="YASAL VERGİ / SGK & BORDRO TAHAKKUK TAKVİMİ (VUK MD. 18)"
        subtitle={`Önümüzdeki ${days} gün içindeki GİB/SGK yasal son günleri ve tahakkuk etmiş vergi/prim/maaş tutarları`}
        right={
          <Badge tone="neutral">
            {statutoryObligations.length} yasal gün · {taxAccruals.length} tahakkuk
          </Badge>
        }
      >
        <div className="space-y-3">
          {taxAccruals.length > 0 ? (
            <TableShell>
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left font-mono text-[10px] uppercase text-tone-4">
                    <th className="py-1">Son Ödeme</th>
                    <th>Dönem</th>
                    <th>Tahakkuk Kalemi</th>
                    <th className="text-right">Tahakkuk Tutarı</th>
                    <th className="text-right">Ödenen</th>
                    <th>Durum</th>
                  </tr>
                </thead>
                <tbody>
                  {taxAccruals.map((ta) => (
                    <tr key={ta.id} className="border-t border-line-faint">
                      <td className="py-1.5 font-mono font-semibold">{ta.dueDate}</td>
                      <td className="font-mono">{ta.periodMonth}</td>
                      <td>{OBLIGATION_KIND_LABEL[ta.obligationKind] ?? ta.obligationKind}</td>
                      <td className="text-right font-mono tabular-nums text-neg">
                        {formatMoney(ta.accruedAmount, ta.currency)}
                      </td>
                      <td className="text-right font-mono tabular-nums text-pos">
                        {ta.paidAmount > 0 ? formatMoney(ta.paidAmount, ta.currency) : "—"}
                      </td>
                      <td>
                        <Badge tone={ta.isPaid ? "green" : "amber"}>
                          {ta.isPaid ? "Ödendi" : "Açık Tahakkuk"}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableShell>
          ) : null}

          {statutoryObligations.length === 0 ? (
            <EmptyState>Bu ufukta yasal vergi/SGK vadesi yok.</EmptyState>
          ) : (
            <TableShell>
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left font-mono text-[10px] uppercase text-tone-4">
                    <th className="py-1">Son Gün (VUK Md. 18)</th>
                    <th>Kurum</th>
                    <th>Kod</th>
                    <th>Yükümlülük</th>
                    <th>Nominal Tarih</th>
                    <th>Kaydırma</th>
                  </tr>
                </thead>
                <tbody>
                  {statutoryObligations.map((ob) => (
                    <tr key={ob.id} className="border-t border-line-faint">
                      <td className="py-1 font-mono font-semibold">{ob.effectiveDueDate}</td>
                      <td>
                        <Badge tone={ob.authority === "GIB" ? "blue" : "amber"}>{ob.authority}</Badge>
                      </td>
                      <td className="font-mono">{ob.code}</td>
                      <td>{ob.label}</td>
                      <td className="font-mono text-tone-3">{ob.statutoryNominalDate}</td>
                      <td className="text-tone-3">{ob.shiftReason ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableShell>
          )}
        </div>
      </Panel>

      <Panel
        title="KALEMLER"
        right={<span className="font-mono text-[10px] uppercase text-tone-4">{rows.length} kayıt</span>}
      >
        {rows.length === 0 ? (
          <EmptyState>Seçilen dönemde kalem yok.</EmptyState>
        ) : (
          <TableShell>
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left font-mono text-[10px] uppercase text-tone-4">
                  <th className="py-1">Tarih</th>
                  <th>Tür</th>
                  <th>Açıklama</th>
                  <th>Karşı taraf</th>
                  <th>Döviz</th>
                  <th className="text-right">Tutar</th>
                  <th>Kesinlik</th>
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, 300).map((r) => {
                  const ccy = r.currency || "TRY";
                  return (
                    <tr key={`${r.sourceKind}-${r.sourceId}`} className="border-t border-line-faint">
                      <td className="py-1 font-mono">{r.eventDate}</td>
                      <td className="text-tone-2">{KIND_LABEL[r.sourceKind] ?? r.sourceKind}</td>
                      <td className="max-w-72 truncate">{r.label}</td>
                      <td className="max-w-48 truncate text-tone-3">{r.counterpartyName ?? "—"}</td>
                      <td className="font-mono">{ccy}</td>
                      <td
                        className={`text-right font-mono tabular-nums ${
                          r.amountSigned != null && r.amountSigned < 0 ? "text-neg" : ""
                        }`}
                      >
                        {r.amountSigned == null ? "—" : formatMoney(r.amountSigned, ccy)}
                      </td>
                      <td>
                        <Badge tone={CERTAINTY_TONE[r.certainty] ?? "neutral"}>
                          {CERTAINTY_LABEL[r.certainty] ?? r.certainty}
                        </Badge>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </TableShell>
        )}
        <p className="mt-2 font-mono text-[10px] text-tone-4">
          Limit vadesi bir tarihtir, nakit hareketi değildir — tutarı boş bırakılır ve günlük nete
          eklenmez. Ödeme sözü &ldquo;beklenen&rdquo; sayılır; sözleşmeli akışla toplanmaz.
        </p>
      </Panel>
    </>
  );
}
