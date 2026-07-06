import Link from "next/link";
import { notFound } from "next/navigation";
import { getPool } from "@/lib/db";
import { loadReport } from "@/lib/reports/engine";
import { Badge } from "@/components/ui/badge";
import { Panel } from "@/components/ui/panel";

export const dynamic = "force-dynamic";

const TYPE_LABEL: Record<string, string> = { daily: "Günlük", weekly: "Haftalık", monthly: "Aylık", strategic: "Stratejik", data_quality: "Veri Kalitesi" };

export default async function ReportDetailPage({
  params,
}: {
  params: Promise<{ reportId: string }>;
}) {
  const { reportId } = await params;
  const pool = getPool();
  const r = await loadReport(pool, reportId);
  if (!r) notFound();
  const prompt = (r.meta && typeof r.meta.commentary_prompt === "string" ? r.meta.commentary_prompt : null) as string | null;

  return (
    <>
      <Panel
        title={`${TYPE_LABEL[r.report_type] ?? r.report_type} RAPOR — ${r.period_start}${r.period_end !== r.period_start ? ` → ${r.period_end}` : ""}`}
        right={
          <span className="flex items-center gap-2">
            <Badge tone="green">salt-okunur</Badge>
            <Link href="/reports" className="font-mono text-[10px] uppercase text-zinc-400 underline underline-offset-2">
              ← raporlar
            </Link>
          </span>
        }
      >
        <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-[12px] leading-relaxed text-zinc-200">
          {r.body_md}
        </pre>
        <div className="mt-2 font-mono text-[10px] text-zinc-600">üretim: {r.created_at} (Europe/Istanbul)</div>
      </Panel>

      {prompt && (
        <Panel title="AI YORUM PROMPTU (model çağrılmadı)">
          <p className="mb-2 font-mono text-[10px] text-amber-400">
            Bu yalnızca bir prompt taslağıdır. AI yorum katmanı devreye girerse yalnız aşağıdaki deterministik
            gerçekleri açıklar — hiçbir değeri değiştiremez, &quot;ödendi&quot; işaretleyemez, yeniden hesaplayamaz.
          </p>
          <pre className="overflow-x-auto whitespace-pre-wrap border border-zinc-800 bg-black/40 p-2 font-mono text-[11px] text-zinc-400">
            {prompt}
          </pre>
        </Panel>
      )}
    </>
  );
}
