import Link from "@/components/ui/app-link";
import { getPool } from "@/lib/db";
import { listReports } from "@/lib/reports/engine";
import { Badge, type Tone } from "@/components/ui/badge";
import { Panel } from "@/components/ui/panel";
import { EmptyState, PageHeader } from "@/components/ui/shell";
import { dispatchBriefingAction, generateReportAction } from "./actions";
import { requireRouteAccess } from "@/lib/authz/route-guard";

export const dynamic = "force-dynamic";

const TYPE_TONE: Record<string, Tone> = {
  daily: "green",
  weekly: "blue",
  monthly: "violet",
  strategic: "amber",
  data_quality: "neutral",
  cfo_briefing: "blue",
};
const TYPE_LABEL: Record<string, string> = {
  daily: "Günlük",
  weekly: "Haftalık",
  monthly: "Aylık",
  strategic: "Stratejik",
  data_quality: "Veri Kalitesi",
  cfo_briefing: "CFO Brifingi",
};

interface ReportsPageProps {
  searchParams?: Promise<{ dispatched?: string; dispatchError?: string }>;
}

export default async function ReportsPage({ searchParams }: ReportsPageProps) {
  const denied = await requireRouteAccess("/insights/reports");
  if (denied) return denied;
  const sp = (await searchParams) ?? {};
  const pool = getPool();
  const reports = await listReports(pool);

  const GenButton = ({ type, label }: { type: string; label: string }) => (
    <form action={generateReportAction}>
      <input type="hidden" name="type" value={type} />
      <button
        type="submit"
        className="border border-line-strong bg-surface-2 px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-tone-1 hover:bg-surface-3"
      >
        {label} üret →
      </button>
    </form>
  );

  return (
    <>
      <PageHeader
        title="Raporlar"
        subtitle="Günlük · haftalık · aylık salt-okunur özetler (Europe/Istanbul)"
        meta={<Badge tone="neutral" dot>{reports.length} rapor</Badge>}
      />

      {sp.dispatched ? (
        <div
          role="status"
          style={{
            background: "var(--surface-2)",
            border: "1px solid var(--line)",
            color: "var(--text-1)",
          }}
          className="flex flex-wrap items-center gap-2 px-3 py-2 text-xs"
        >
          <Badge tone="green" dot>Gönderildi</Badge>
          <span>
            {`CFO brifingi ${sp.dispatched === "email" ? "E-posta" : "Telegram"} kanalına başarıyla iletildi ve denetim izine kaydedildi.`}
          </span>
        </div>
      ) : null}

      {sp.dispatchError ? (
        <div
          role="alert"
          style={{
            background: "var(--surface-2)",
            border: "1px solid var(--line)",
            color: "var(--text-1)",
          }}
          className="flex flex-wrap items-center gap-2 px-3 py-2 text-xs"
        >
          <Badge tone="amber" dot>Kanal Uyarısı</Badge>
          <span>{sp.dispatchError}</span>
        </div>
      ) : null}

      <Panel title="RAPOR ÜRET VE KANALLARA İLET">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap gap-2">
            <GenButton type="daily" label="Günlük" />
            <GenButton type="weekly" label="Haftalık" />
            <GenButton type="monthly" label="Aylık" />
          </div>
          <form action={dispatchBriefingAction} className="flex flex-wrap items-center gap-2">
            <select
              name="channel"
              defaultValue="telegram"
              aria-label="Gönderim kanalı"
              style={{
                background: "var(--surface-1)",
                border: "1px solid var(--line)",
                color: "var(--text-1)",
              }}
              className="px-2.5 py-2 font-mono text-[10px] uppercase tracking-wider"
            >
              <option value="telegram">Telegram</option>
              <option value="email">E-posta</option>
            </select>
            <button
              type="submit"
              className="button-accent px-3 py-2 font-mono text-[10px] uppercase tracking-wider"
            >
              Brifingi Kanallara Gönder
            </button>
          </form>
        </div>
        <p className="mt-2 font-mono text-[10px] text-tone-3">
          Raporlar salt-okunur özetlerdir (Europe/Istanbul). Hiçbir mali kaydı değiştirmez; AI yalnız yorum
          istemini üretir, model çağrılmaz.
        </p>
      </Panel>

      <Panel title={`GEÇMİŞ RAPORLAR — ${reports.length}`}>
        {reports.length === 0 ? (
          <EmptyState>
            Henüz rapor üretilmedi. Yukarıdaki günlük / haftalık / aylık komutlarından biriyle başlayın —
            raporlar salt-okunurdur, hiçbir mali kaydı değiştirmez.
          </EmptyState>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left font-mono text-[10px] uppercase tracking-wider text-tone-3">
                <th className="py-1 pr-2">tip</th>
                <th className="py-1 pr-2">dönem</th>
                <th className="py-1 pr-2">üretim</th>
                <th className="py-1 text-right">kanal iletimi</th>
              </tr>
            </thead>
            <tbody>
              {reports.map((r) => (
                <tr key={r.id} className="border-b border-line-faint">
                  <td className="py-1.5 pr-2">
                    <Link href={`/insights/reports/${r.id}`}>
                      <Badge tone={TYPE_TONE[r.report_type] ?? "neutral"}>{TYPE_LABEL[r.report_type] ?? r.report_type}</Badge>
                    </Link>
                  </td>
                  <td className="py-1.5 pr-2 font-mono text-xs text-tone-2">
                    {r.period_start === r.period_end ? r.period_start : `${r.period_start} → ${r.period_end}`}
                  </td>
                  <td className="py-1.5 pr-2 font-mono text-xs text-tone-3">
                    <Link className="underline decoration-line-strong underline-offset-2" href={`/insights/reports/${r.id}`}>
                      {r.created_at} →
                    </Link>
                  </td>
                  <td className="py-1.5 text-right">
                    <form action={dispatchBriefingAction} className="inline-flex items-center gap-1.5">
                      <input type="hidden" name="reportId" value={r.id} />
                      <input type="hidden" name="channel" value="telegram" />
                      <button
                        type="submit"
                        style={{
                          background: "var(--surface-2)",
                          border: "1px solid var(--line)",
                          color: "var(--text-2)",
                        }}
                        className="px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider hover:opacity-80"
                      >
                        Telegram&apos;a ilet
                      </button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Panel>
    </>
  );
}
