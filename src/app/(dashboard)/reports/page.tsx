import Link from "next/link";
import { getPool } from "@/lib/db";
import { listReports } from "@/lib/reports/engine";
import { Badge, type Tone } from "@/components/ui/badge";
import { Panel } from "@/components/ui/panel";
import { PageHeader } from "@/components/ui/shell";
import { generateReportAction } from "./actions";

export const dynamic = "force-dynamic";

const TYPE_TONE: Record<string, Tone> = { daily: "green", weekly: "blue", monthly: "violet", strategic: "amber", data_quality: "neutral" };
const TYPE_LABEL: Record<string, string> = { daily: "Günlük", weekly: "Haftalık", monthly: "Aylık", strategic: "Stratejik", data_quality: "Veri Kalitesi" };

export default async function ReportsPage() {
  const pool = getPool();
  const reports = await listReports(pool);

  const GenButton = ({ type, label }: { type: string; label: string }) => (
    <form action={generateReportAction}>
      <input type="hidden" name="type" value={type} />
      <button
        type="submit"
        className="border border-zinc-700 bg-zinc-900 px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-zinc-200 hover:bg-zinc-800"
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

      <Panel title="RAPOR ÜRET">
        <div className="flex flex-wrap gap-2">
          <GenButton type="daily" label="Günlük" />
          <GenButton type="weekly" label="Haftalık" />
          <GenButton type="monthly" label="Aylık" />
        </div>
        <p className="mt-2 font-mono text-[10px] text-zinc-500">
          Raporlar salt-okunur özetlerdir (Europe/Istanbul). Hiçbir mali kaydı değiştirmez; AI yalnız yorum
          promptu üretir, model çağrılmaz.
        </p>
      </Panel>

      <Panel title={`GEÇMİŞ RAPORLAR — ${reports.length}`}>
        {reports.length === 0 ? (
          <p className="text-sm text-zinc-500">Henüz rapor üretilmedi. Yukarıdan başlayın.</p>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-800 text-left font-mono text-[10px] uppercase tracking-wider text-zinc-500">
                <th className="py-1 pr-2">tip</th>
                <th className="py-1 pr-2">dönem</th>
                <th className="py-1">üretim</th>
              </tr>
            </thead>
            <tbody>
              {reports.map((r) => (
                <tr key={r.id} className="border-b border-zinc-900">
                  <td className="py-1.5 pr-2">
                    <Link href={`/reports/${r.id}`}>
                      <Badge tone={TYPE_TONE[r.report_type] ?? "neutral"}>{TYPE_LABEL[r.report_type] ?? r.report_type}</Badge>
                    </Link>
                  </td>
                  <td className="py-1.5 pr-2 font-mono text-xs text-zinc-400">
                    {r.period_start === r.period_end ? r.period_start : `${r.period_start} → ${r.period_end}`}
                  </td>
                  <td className="py-1.5 font-mono text-xs text-zinc-500">
                    <Link className="underline decoration-zinc-700 underline-offset-2" href={`/reports/${r.id}`}>
                      {r.created_at} →
                    </Link>
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
