import { getPool } from "@/lib/db";
import { loadCalendar, loadCalendarDaily } from "@/lib/briefing/engine";
import { istanbulDateISO } from "@/lib/reports/rules";
import { Badge, type Tone } from "@/components/ui/badge";
import { Panel, fmtTL } from "@/components/ui/panel";
import { EmptyState, KeyStat, PageHeader, TableShell } from "@/components/ui/shell";

export const dynamic = "force-dynamic";

const KIND_LABEL: Record<string, string> = {
  payment_instance: "Ödeme", loan_installment: "Kredi taksiti", check: "Çek",
  invoice: "Fatura", promise_to_pay: "Ödeme sözü", facility_expiry: "Limit vadesi",
};
const CERTAINTY_LABEL: Record<string, string> = {
  contracted: "sözleşmeli", expected: "beklenen", renewal: "yenileme",
};
const CERTAINTY_TONE: Record<string, Tone> = {
  contracted: "neutral", expected: "amber", renewal: "blue",
};

export default async function FinancialCalendarPage({
  searchParams,
}: { searchParams: Promise<{ days?: string }> }) {
  const sp = await searchParams;
  const days = [30, 60, 90].includes(Number(sp.days)) ? Number(sp.days) : 30;
  const pool = getPool();
  const today = istanbulDateISO();
  const end = new Date(Date.parse(today) + days * 86400000).toISOString().slice(0, 10);

  const [rows, daily] = await Promise.all([
    loadCalendar(pool, today, end),
    loadCalendarDaily(pool, today, end),
  ]);

  const contracted = daily.reduce((s, d) => s + d.netContracted, 0);
  const expected = daily.reduce((s, d) => s + d.netExpected, 0);
  const renewals = daily.reduce((s, d) => s + d.renewalCount, 0);
  const worst = [...daily].sort((a, b) => a.netContracted - b.netContracted || a.eventDate.localeCompare(b.eventDate))[0];

  return (
    <>
      <PageHeader
        title="Finansal Takvim"
        subtitle="Ödeme, kredi taksiti, çek, fatura, ödeme sözü ve limit vadesi — tek takvimde"
        meta={<Badge tone={contracted < 0 ? "amber" : "green"} dot>{days} günlük görünüm</Badge>}
        action={
          <span className="flex gap-1">
            {[30, 60, 90].map((d) => (
              <a key={d} href={`/finance/calendar?days=${d}`}
                className={`border px-2 py-1 font-mono text-xs ${d === days ? "border-accent" : "border-line-strong"}`}>
                {d}g
              </a>
            ))}
          </span>
        }
      />

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <KeyStat label="Sözleşmeli net akış" value={fmtTL(contracted)} tone={contracted < 0 ? "warn" : "pos"}
          sub="İmzalı yükümlülükler" />
        {/* Reported beside the contracted figure, never blended into it: a promise is not a contract. */}
        <KeyStat label="Beklenen (ödeme sözü)" value={fmtTL(expected)} tone="neutral"
          sub="Söz verilmiş, taahhüt değil" />
        <KeyStat label="En kötü gün" value={worst ? fmtTL(worst.netContracted) : "—"} tone={worst && worst.netContracted < 0 ? "neg" : "neutral"}
          sub={worst?.eventDate ?? "veri yok"} />
        <KeyStat label="Limit yenilemesi" value={String(renewals)} tone={renewals > 0 ? "warn" : "neutral"}
          sub="Nakit hareketi değil" />
      </div>

      <Panel title="GÜN GÜN AKIŞ">
        {daily.length === 0 ? (
          <EmptyState>Seçilen dönemde takvim kaydı yok.</EmptyState>
        ) : (
          <TableShell>
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left font-mono text-[10px] uppercase text-tone-4">
                  <th className="py-1">Tarih</th><th>Kalem</th><th className="text-right">Giriş</th>
                  <th className="text-right">Çıkış</th><th className="text-right">Sözleşmeli net</th>
                  <th className="text-right">Beklenen</th><th className="text-right">Yenileme</th>
                </tr>
              </thead>
              <tbody>
                {daily.map((d) => (
                  <tr key={`${d.eventDate}-${d.currency}`} className="border-t border-line-faint">
                    <td className="py-1 font-mono">{d.eventDate}</td>
                    <td className="font-mono text-tone-3">{d.eventCount}</td>
                    <td className="text-right font-mono text-pos">{d.inflowContracted ? fmtTL(d.inflowContracted) : "—"}</td>
                    <td className="text-right font-mono text-neg">{d.outflowContracted ? fmtTL(d.outflowContracted) : "—"}</td>
                    <td className={`text-right font-mono ${d.netContracted < 0 ? "text-neg" : ""}`}>{fmtTL(d.netContracted)}</td>
                    <td className="text-right font-mono text-tone-3">{d.netExpected ? fmtTL(d.netExpected) : "—"}</td>
                    <td className="text-right font-mono text-tone-3">{d.renewalCount || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableShell>
        )}
      </Panel>

      <Panel title="KALEMLER" right={<span className="font-mono text-[10px] uppercase text-tone-4">{rows.length} kayıt</span>}>
        {rows.length === 0 ? (
          <EmptyState>Seçilen dönemde kalem yok.</EmptyState>
        ) : (
          <TableShell>
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left font-mono text-[10px] uppercase text-tone-4">
                  <th className="py-1">Tarih</th><th>Tür</th><th>Açıklama</th><th>Karşı taraf</th>
                  <th className="text-right">Tutar</th><th>Kesinlik</th>
                </tr>
              </thead>
              <tbody>
                {rows.slice(0, 300).map((r) => (
                  <tr key={`${r.sourceKind}-${r.sourceId}`} className="border-t border-line-faint">
                    <td className="py-1 font-mono">{r.eventDate}</td>
                    <td className="text-tone-2">{KIND_LABEL[r.sourceKind] ?? r.sourceKind}</td>
                    <td className="max-w-[18rem] truncate">{r.label}</td>
                    <td className="max-w-[12rem] truncate text-tone-3">{r.counterpartyName ?? "—"}</td>
                    {/* A facility renewal has no amount. Rendered as a dash and a reason, never 0 TL. */}
                    <td className={`text-right font-mono ${r.amountSigned != null && r.amountSigned < 0 ? "text-neg" : ""}`}>
                      {r.amountSigned == null ? "—" : fmtTL(r.amountSigned)}
                    </td>
                    <td><Badge tone={CERTAINTY_TONE[r.certainty] ?? "neutral"}>{CERTAINTY_LABEL[r.certainty] ?? r.certainty}</Badge></td>
                  </tr>
                ))}
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
