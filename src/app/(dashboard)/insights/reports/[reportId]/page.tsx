import Link from "@/components/ui/app-link";
import { notFound } from "next/navigation";
import { getPool } from "@/lib/db";
import { loadAiResponse, listAiResponses } from "@/lib/ai/engine";
import { loadReport } from "@/lib/reports/engine";
import type { BoardFinancialPackage } from "@/lib/reports/board-pack";
import { generateReportCommentaryAction } from "@/app/(dashboard)/insights/reports/actions";
import { createActionFromAiResponseAction, createActionFromReportAction } from "@/app/(dashboard)/data/quality/actions";
import { Badge } from "@/components/ui/badge";
import {
  SourceProofDisclosure,
  aggregateConfidence,
  confidenceLabel,
  confidenceTone,
  type ProofItem,
} from "@/components/facts/source-proof";
import { Panel, fmtTL } from "@/components/ui/panel";
import { KeyStat, TableShell } from "@/components/ui/shell";
import { loadDecisionFacts } from "@/lib/facts/engine";
import { requireRouteAccess } from "@/lib/authz/route-guard";

export const dynamic = "force-dynamic";

const TYPE_LABEL: Record<string, string> = {
  daily: "Günlük",
  weekly: "Haftalık",
  monthly: "Aylık",
  strategic: "Yönetim Kurulu & Banka Paketi",
  data_quality: "Veri Kalitesi",
  cfo_briefing: "CFO Brifingi",
};

export default async function ReportDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ reportId: string }>;
  searchParams: Promise<{ ai?: string }>;
}) {
  const denied = await requireRouteAccess("/insights/reports/[reportId]");
  if (denied) return denied;
  const { reportId } = await params;
  const { ai } = await searchParams;
  const pool = getPool();
  const [r, selectedAi, aiHistory, facts] = await Promise.all([
    loadReport(pool, reportId),
    ai ? loadAiResponse(pool, ai) : Promise.resolve(undefined),
    listAiResponses(pool, 5, reportId),
    loadDecisionFacts(pool),
  ]);
  if (!r) notFound();
  const prompt = (r.meta && typeof r.meta.commentary_prompt === "string"
    ? r.meta.commentary_prompt
    : null) as string | null;
  const boardSnapshot =
    r.meta && r.meta.packageKind === "board_pack" && r.meta.snapshot
      ? (r.meta.snapshot as BoardFinancialPackage)
      : null;

  const selectedProofs: ProofItem[] = selectedAi
    ? selectedAi.source_fact_keys.map((key) => {
        const fact = facts.find((f) => f.key === key);
        return fact
          ? {
              key: fact.key,
              title: fact.title,
              value: fact.value,
              confidence: fact.confidence,
              freshness: fact.freshness,
              explanation: fact.explanation,
              sourceHref: fact.sourceHref,
            }
          : { key, title: key, confidence: "unknown", sourceHref: selectedAi.source_hrefs[0] };
      })
    : [];
  const selectedConfidence = aggregateConfidence(selectedProofs);

  return (
    <>
      <Panel
        title={`${TYPE_LABEL[r.report_type] ?? r.report_type} — ${r.period_start}${r.period_end !== r.period_start ? ` → ${r.period_end}` : ""}`}
        right={
          <span className="flex flex-wrap items-center gap-2">
            <Badge tone="green">salt-okunur</Badge>
            <a
              href={`/api/reports/${reportId}/export?format=xlsx`}
              className="button-accent px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider"
            >
              Excel (.xlsx) İndir
            </a>
            <a
              href={`/api/reports/${reportId}/export?format=html&print=1`}
              target="_blank"
              rel="noreferrer"
              style={{
                borderColor: "var(--line)",
                background: "var(--surface-2)",
                color: "var(--text-1)",
                borderRadius: "var(--radius)",
              }}
              className="border px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider"
            >
              PDF / Yazdır
            </a>
            <a
              href={`/api/reports/${reportId}/export?format=csv`}
              style={{
                borderColor: "var(--line)",
                background: "var(--surface-2)",
                color: "var(--text-2)",
                borderRadius: "var(--radius)",
              }}
              className="border px-2 py-1 font-mono text-[10px] uppercase tracking-wider"
            >
              .CSV
            </a>
            <form action={createActionFromReportAction}>
              <input type="hidden" name="reportId" value={reportId} />
              <input type="hidden" name="backTo" value={`/insights/reports/${reportId}`} />
              <button
                type="submit"
                className="border px-2 py-1 font-mono text-[10px] uppercase tracking-wider"
                style={{
                  borderColor: "var(--line-faint)",
                  color: "var(--text-3)",
                  borderRadius: "var(--radius)",
                }}
              >
                Görev Oluştur
              </button>
            </form>
            <Link
              href="/insights/reports"
              className="font-mono text-[10px] uppercase text-tone-2 underline underline-offset-2"
            >
              {"←"} raporlar
            </Link>
          </span>
        }
      >
        {boardSnapshot ? (
          <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <KeyStat
              label="Konsolide Kasa"
              value={
                boardSnapshot.executiveSummary.consolidatedCashTry == null
                  ? "—"
                  : fmtTL(boardSnapshot.executiveSummary.consolidatedCashTry)
              }
              tone="pos"
              sub={`TCMB Kur: ${boardSnapshot.fxRatesAsOf ?? "TRY"}`}
            />
            <KeyStat
              label="TDHP Yönetim FAVÖK"
              value={
                boardSnapshot.executiveSummary.managementEbitdaTry == null
                  ? "—"
                  : fmtTL(boardSnapshot.executiveSummary.managementEbitdaTry)
              }
              tone="neutral"
              sub={`Net Satış: ${boardSnapshot.executiveSummary.netSalesTry == null ? "—" : fmtTL(boardSnapshot.executiveSummary.netSalesTry)}`}
            />
            <KeyStat
              label="13H En Düşük Kasa"
              value={
                boardSnapshot.executiveSummary.worst13WeekCashTry == null
                  ? "—"
                  : fmtTL(boardSnapshot.executiveSummary.worst13WeekCashTry)
              }
              tone={(boardSnapshot.executiveSummary.worst13WeekCashTry ?? 0) < 0 ? "neg" : "pos"}
              sub={`CCC: ${boardSnapshot.executiveSummary.cccDays ?? "—"} gün`}
            />
            <KeyStat
              label="Boş Kredi Limiti & Kovenant"
              value={fmtTL(boardSnapshot.executiveSummary.creditAvailableTry)}
              tone={boardSnapshot.executiveSummary.covenantBreachCount > 0 ? "neg" : "pos"}
              sub={`Kovenant İhlali: ${boardSnapshot.executiveSummary.covenantBreachCount}`}
            />
          </div>
        ) : null}

        {boardSnapshot ? (
          <div className="mb-4 grid grid-cols-1 gap-3 lg:grid-cols-2">
            <TableShell>
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left font-mono text-[10px] uppercase text-tone-4">
                    <th className="py-1">Kod</th>
                    <th>TDHP Gelir Tablosu</th>
                    <th className="text-right">Tutar (TL)</th>
                  </tr>
                </thead>
                <tbody>
                  {boardSnapshot.incomeStatement.map((row) => (
                    <tr
                      key={row.code}
                      className={`border-t border-line-faint ${row.isSubtotal ? "font-semibold" : ""}`}
                    >
                      <td className="py-1 font-mono text-tone-3">{row.code}</td>
                      <td>{row.label}</td>
                      <td className="text-right font-mono">
                        {row.amountTry == null ? "—" : fmtTL(row.amountTry)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableShell>
            <TableShell>
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left font-mono text-[10px] uppercase text-tone-4">
                    <th className="py-1">Vade Kovası</th>
                    <th className="text-right">Alacak (120)</th>
                    <th className="text-right">Borç (320)</th>
                    <th className="text-right">Net</th>
                  </tr>
                </thead>
                <tbody>
                  {boardSnapshot.ageing.map((a) => (
                    <tr key={a.bucket} className="border-t border-line-faint">
                      <td className="py-1">{a.bucket}</td>
                      <td className="text-right font-mono">{fmtTL(a.arTry)}</td>
                      <td className="text-right font-mono">{fmtTL(a.apTry)}</td>
                      <td className="text-right font-mono font-semibold">{fmtTL(a.netTry)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableShell>
          </div>
        ) : null}

        <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-[12px] leading-relaxed text-tone-1">
          {r.body_md}
        </pre>
        <div className="mt-2 font-mono text-[10px] text-tone-4">
          üretim: {r.created_at} (Europe/Istanbul)
        </div>
      </Panel>

      {prompt && (
        <Panel
          title="AI RAPOR YORUMU"
          right={
            <span className="flex items-center gap-2">
              {selectedAi && (
                <Badge tone={confidenceTone(selectedConfidence)}>
                  {confidenceLabel(selectedConfidence)}
                </Badge>
              )}
              {selectedAi && (
                <form action={createActionFromAiResponseAction}>
                  <input type="hidden" name="aiResponseId" value={selectedAi.id} />
                  <input
                    type="hidden"
                    name="backTo"
                    value={`/insights/reports/${reportId}?ai=${selectedAi.id}`}
                  />
                  <button
                    type="submit"
                    className="border px-2 py-1 font-mono text-[10px] uppercase tracking-wider"
                    style={{
                      borderColor: "var(--line-faint)",
                      color: "var(--text-3)",
                      borderRadius: "var(--radius)",
                    }}
                  >
                    görev
                  </button>
                </form>
              )}
              <form action={generateReportCommentaryAction}>
                <input type="hidden" name="reportId" value={reportId} />
                <button
                  type="submit"
                  className="border px-2 py-1 font-mono text-[10px] uppercase tracking-wider"
                  style={{
                    borderColor: "var(--accent)",
                    color: "var(--accent)",
                    borderRadius: "var(--radius)",
                  }}
                >
                  yorum üret
                </button>
              </form>
            </span>
          }
        >
          <p className="mb-2 font-mono text-[10px] text-warn">
            Yorum yalnız deterministik facts ve rapor promptunu açıklar; finansal kayıt değiştirmez.
          </p>
          {selectedAi ? (
            <>
              <pre
                className="overflow-x-auto whitespace-pre-wrap border p-2 font-mono text-[11px]"
                style={{
                  borderColor: "var(--line)",
                  color: "var(--text-1)",
                  background: "var(--surface-2)",
                }}
              >
                {selectedAi.answer_md}
              </pre>
              <div className="mt-3">
                <SourceProofDisclosure label="yorumun kanıt paketi" items={selectedProofs} defaultOpen />
              </div>
            </>
          ) : (
            <pre
              className="overflow-x-auto whitespace-pre-wrap border p-2 font-mono text-[11px]"
              style={{
                borderColor: "var(--line)",
                color: "var(--text-4)",
                background: "var(--surface-2)",
              }}
            >
              {prompt}
            </pre>
          )}
          {aiHistory.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {aiHistory.map((a) => (
                <Link
                  key={a.id}
                  href={`/insights/reports/${reportId}?ai=${a.id}`}
                  className="font-mono text-[10px] underline underline-offset-2"
                  style={{ color: "var(--accent)" }}
                >
                  {a.created_at} / {a.response_mode}
                </Link>
              ))}
            </div>
          )}
        </Panel>
      )}
    </>
  );
}
