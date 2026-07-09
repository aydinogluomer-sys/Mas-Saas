import Link from "next/link";
import { getPool } from "@/lib/db";
import { loadDataQualityCenter } from "@/lib/data-quality/engine";
import { Badge, SEVERITY_TONE, type Tone } from "@/components/ui/badge";
import { Panel } from "@/components/ui/panel";
import { KeyStat, PageHeader } from "@/components/ui/shell";
import { createActionFromReviewAction, createManualActionAction, setActionStatusAction } from "./actions";

export const dynamic = "force-dynamic";

const ACTION_STATUS_TONE: Record<string, Tone> = {
  open: "amber",
  in_progress: "blue",
  blocked: "red",
  done: "green",
  cancelled: "neutral",
};

const fmt0 = (v: number | null) =>
  v != null ? new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 0 }).format(v) : "—";

export default async function DataQualityPage() {
  const data = await loadDataQualityCenter(getPool());

  return (
    <>
      <PageHeader
        title="Veri Kalite Merkezi"
        subtitle="Karari engelleyen sorunlar / gorevler / kaynak izleri"
        meta={<Badge tone={data.highOpenCount > 0 ? "red" : data.openReviewCount > 0 ? "amber" : "green"} dot>{data.openReviewCount} acik</Badge>}
      />

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-6">
        <KeyStat label="Karar guveni" value={`%${data.decisionConfidence}`} tone={data.decisionConfidence >= 80 ? "pos" : data.decisionConfidence >= 55 ? "warn" : "neg"} href="/data-quality" />
        <KeyStat label="Acik inceleme" value={data.openReviewCount} tone={data.openReviewCount > 0 ? "warn" : "pos"} href="/imports" />
        <KeyStat label="Yuksek/acil" value={data.highOpenCount} tone={data.highOpenCount > 0 ? "neg" : "pos"} href="/data-quality" />
        <KeyStat label="Acik gorev" value={data.actionOpenCount} tone={data.actionOpenCount > 0 ? "warn" : "neutral"} href="/data-quality" />
        <KeyStat label="Dis review" value={data.externalPendingCount} tone={data.externalPendingCount > 0 ? "warn" : "pos"} href="/assumptions" />
        <KeyStat label="Ozel sekme" value={data.specialSheets.length} tone={data.specialSheets.length > 0 ? "info" : "neutral"} href="/data-quality" />
      </div>

      <Panel title="KARAR GUVENI" accent={data.decisionConfidence >= 80 ? "pos" : data.decisionConfidence >= 55 ? "warn" : "neg"}>
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone={data.decisionConfidence >= 80 ? "green" : data.decisionConfidence >= 55 ? "amber" : "red"}>
            %{data.decisionConfidence} / {data.decisionConfidenceLabel}
          </Badge>
          <Badge tone={data.highOpenCount > 0 ? "red" : "green"}>yuksek/acil review: {data.highOpenCount}</Badge>
          <Badge tone={data.reconciliationSignalCount > 0 ? "red" : "green"}>mutabakat sinyali: {data.reconciliationSignalCount}</Badge>
          <Badge tone={data.missingAmountCount > 0 ? "amber" : "green"}>eksik tutar: {data.missingAmountCount}</Badge>
          <Badge tone={data.staleProductionRateCount > 0 ? "amber" : "green"}>stale uretim: {data.staleProductionRateCount}</Badge>
        </div>
        <p className="mt-2 text-[11px]" style={{ color: "var(--text-4)" }}>
          Skor yalniz karar guveni sinyalidir; ham Excel veya finansal kaynak kayitlarini degistirmez.
        </p>
      </Panel>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <div id="ab-diff">
        <Panel title="EXCEL SURUM FARKI (A VS B)">
          {!data.workbookDiff.ready ? (
            <p className="text-sm" style={{ color: "var(--text-3)" }}>
              Karsilastirma icin en az 2 workbook gerekiyor.
            </p>
          ) : (
            <>
              <div className="mt-2 grid grid-cols-1 gap-1.5">
                {[data.workbookDiff.a, data.workbookDiff.b].filter(Boolean).map((w, i) => (
                  <div key={w!.workbook_id} className="border px-2 py-1.5" style={{ borderColor: "var(--line)", borderRadius: "var(--radius)", background: "var(--surface-2)" }}>
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-mono text-[11px]" style={{ color: "var(--text-3)" }}>{i === 0 ? "Workbook A" : "Workbook B"}</span>
                      <Badge tone="neutral">{w!.imported_at}</Badge>
                    </div>
                    <div className="mt-0.5 text-sm" style={{ color: "var(--text-1)" }}>{w!.original_filename}</div>
                    <div className="mt-0.5 font-mono text-[10px]" style={{ color: "var(--text-4)" }}>
                      sekme {w!.sheet_count} · satir {fmt0(w!.row_count)} · hucre {fmt0(w!.cell_count)} · formul {fmt0(w!.formula_count)}
                    </div>
                  </div>
                ))}
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Badge tone="neutral">degisen sekme: {data.workbookDiff.changedSheets.length}</Badge>
                <Badge tone="neutral">aylik nakit sekmesi A: {data.workbookDiff.a?.monthly_sheet_count ?? 0}</Badge>
                <Badge tone="neutral">B: {data.workbookDiff.b?.monthly_sheet_count ?? 0}</Badge>
                <Badge tone={data.workbookDiff.changedSheets.some((s) => s.impact === "critical" || s.impact === "high") ? "amber" : "green"}>
                  son import {data.workbookDiff.changedSheets.some((s) => s.impact === "critical" || s.impact === "high") ? "kontrol ister" : "dusuk risk"}
                </Badge>
              </div>
              {data.workbookDiff.changedSheets.length > 0 && (
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {data.workbookDiff.changedSheets.slice(0, 8).map((s) => (
                    <Badge key={`${s.sheet_name}-${s.side}`} tone={s.impact === "critical" ? "red" : s.impact === "high" ? "amber" : s.impact === "medium" ? "blue" : "neutral"}>
                      {s.sheet_name} / {s.area} / {s.side}
                    </Badge>
                  ))}
                </div>
              )}
            </>
          )}
        </Panel>
        </div>

        <div id="dashboard-mutabakat">
        <Panel title="EXCEL DASHBOARD MUTABAKATI">
          <p className="text-sm" style={{ color: "var(--text-3)" }}>01_DASHBOARD / 02_AYLIK OZET / 00_REHBER varligi ve aylik cashflow baslik mutabakati.</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Badge tone={data.specialSheets.length > 0 ? "green" : "amber"}>ozel sekme: {data.specialSheets.length}</Badge>
            <Badge tone={data.reconciliationSignalCount > 0 ? "red" : "green"}>acik mutabakat sinyali: {data.reconciliationSignalCount}</Badge>
          </div>
          {data.reconciliationSignalCount > 0 && (
            <form action={createManualActionAction} className="mt-2">
              <input type="hidden" name="title" value="Excel dashboard/cashflow mutabakat farkini incele" />
              <input type="hidden" name="severity" value="high" />
              <input type="hidden" name="note" value="Veri kalite merkezi mutabakat sinyali urettigi icin olusturuldu." />
              <button type="submit" className="button-accent px-2 py-1">
                mutabakat gorevi olustur
              </button>
            </form>
          )}
          <div className="mt-2 overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b" style={{ borderColor: "var(--line-faint)", color: "var(--text-4)" }}>
                  <th className="py-1 pr-2 text-left">ay</th>
                  <th className="py-1 pr-2 text-right">devir diff</th>
                  <th className="py-1 pr-2 text-right">kasa diff</th>
                </tr>
              </thead>
              <tbody>
                {data.cashflowReconciliation.slice(0, 12).map((r) => (
                  <tr key={r.month_start} className="border-b" style={{ borderColor: "var(--line-faint)" }}>
                    <td className="py-1 pr-2 font-mono" style={{ color: "var(--text-2)" }}>{r.month_start.slice(0, 7)}</td>
                    <td className="py-1 pr-2 text-right font-mono" style={{ color: (r.opening_diff ?? 0) === 0 ? "var(--text-3)" : "var(--neg)" }}>{fmt0(r.opening_diff)}</td>
                    <td className="py-1 pr-2 text-right font-mono" style={{ color: (r.closing_diff ?? 0) === 0 ? "var(--text-3)" : "var(--neg)" }}>{fmt0(r.closing_diff)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Panel>
        </div>
      </div>

      <Panel title="KARAR ALMAYI ENGELLEYEN 5 VERI SORUNU">
        {data.blockers.length === 0 ? (
          <p className="text-sm" style={{ color: "var(--text-3)" }}>Acik veya reddedilmis kritik veri sorunu yok.</p>
        ) : (
          <div className="space-y-2">
            {data.blockers.map((b) => (
              <div key={b.id} className="grid grid-cols-1 gap-2 border p-2.5 sm:grid-cols-[1fr_auto]" style={{ borderColor: "var(--line)", borderRadius: "var(--radius)", background: "var(--surface-2)" }}>
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge tone={SEVERITY_TONE[b.severity]}>{b.severity}</Badge>
                    <Badge tone={b.status === "rejected" ? "red" : "amber"}>{b.status}</Badge>
                    <span className="font-mono text-[11px]" style={{ color: "var(--text-3)" }}>{b.issue_type}</span>
                  </div>
                  <Link href={b.source_href} className="mt-1 block text-sm underline underline-offset-2" style={{ color: "var(--text-1)" }}>
                    {b.sheet_name ?? b.workbook_name}{b.row_index != null ? ` / r${b.row_index}` : ""}
                  </Link>
                  <p className="mt-1 text-[12px]" style={{ color: "var(--text-3)" }}>{b.message}</p>
                </div>
                <form action={createActionFromReviewAction} className="self-start">
                  <input type="hidden" name="reviewId" value={b.id} />
                  <input type="hidden" name="backTo" value="/data-quality" />
                  <button type="submit" className="button-accent px-2 py-1">
                    gorevlestir
                  </button>
                </form>
              </div>
            ))}
          </div>
        )}
      </Panel>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-[1fr_360px]">
        <Panel title={`ACIK GOREVLER - ${data.actions.length}`}>
          {data.actions.length === 0 ? (
            <p className="text-sm" style={{ color: "var(--text-3)" }}>Acik gorev yok.</p>
          ) : (
            <div className="space-y-2">
              {data.actions.map((a) => (
                <div key={a.id} className="border p-2.5" style={{ borderColor: "var(--line)", borderRadius: "var(--radius)", background: "var(--surface-2)" }}>
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Badge tone={SEVERITY_TONE[a.severity]}>{a.severity}</Badge>
                        <Badge tone={ACTION_STATUS_TONE[a.status] ?? "neutral"}>{a.status}</Badge>
                        <span className="font-mono text-[10px]" style={{ color: "var(--text-4)" }}>{a.source_type}</span>
                      </div>
                      {a.source_href ? (
                        <Link href={a.source_href} className="mt-1 block text-sm underline underline-offset-2" style={{ color: "var(--text-1)" }}>{a.title}</Link>
                      ) : (
                        <div className="mt-1 text-sm" style={{ color: "var(--text-1)" }}>{a.title}</div>
                      )}
                      <div className="mt-1 font-mono text-[10px]" style={{ color: "var(--text-4)" }}>
                        {a.owner ? `owner ${a.owner} / ` : ""}{a.due_date ? `due ${a.due_date} / ` : ""}created {a.created_at}
                      </div>
                      {a.note && <p className="mt-1 text-[11px]" style={{ color: "var(--text-3)" }}>{a.note}</p>}
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {(["in_progress", "blocked", "cancelled"] as const).map((s) => (
                        <form key={s} action={setActionStatusAction}>
                          <input type="hidden" name="id" value={a.id} />
                          <input type="hidden" name="status" value={s} />
                          <input type="hidden" name="backTo" value="/data-quality" />
                          <button type="submit" className="button-ghost px-1.5 py-0.5 text-[9px]">
                            {s === "in_progress" ? "basla" : s === "blocked" ? "blok" : "iptal"}
                          </button>
                        </form>
                      ))}
                      <form action={setActionStatusAction} className="flex flex-wrap gap-1">
                        <input type="hidden" name="id" value={a.id} />
                        <input type="hidden" name="status" value="done" />
                        <input type="hidden" name="backTo" value="/data-quality" />
                        <input name="completionNote" placeholder="kapanis notu" className="field-control w-32 px-1.5 py-0.5 font-mono text-[9px]" />
                        <button type="submit" className="button-ghost px-1.5 py-0.5 text-[9px]">
                          bitti
                        </button>
                      </form>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Panel>

        <Panel title="MANUEL GOREV">
          <form action={createManualActionAction} className="space-y-2">
            <input name="title" required placeholder="gorev basligi" className="field-control px-2 py-1.5 text-sm" />
            <div className="grid grid-cols-2 gap-2">
              <select name="severity" className="field-control px-2 py-1.5 text-sm" defaultValue="medium">
                <option value="critical">critical</option>
                <option value="high">high</option>
                <option value="medium">medium</option>
                <option value="low">low</option>
              </select>
              <input name="dueDate" type="date" aria-label="due date" className="field-control px-2 py-1.5 text-sm" />
            </div>
            <input name="owner" placeholder="owner" className="field-control px-2 py-1.5 text-sm" />
            <textarea name="note" rows={3} placeholder="not" className="field-control px-2 py-1.5 text-sm" />
            <button type="submit" className="button-accent px-3 py-2">
              olustur
            </button>
          </form>
        </Panel>
      </div>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <Panel title="SORUN DAGILIMI">
          {data.issueCounts.length === 0 ? (
            <p className="text-sm" style={{ color: "var(--text-3)" }}>Sorun kaydi yok.</p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-800 text-left font-mono text-[10px] uppercase tracking-wider text-zinc-500">
                  <th className="py-1 pr-2">tip</th>
                  <th className="py-1 pr-2 text-right">acik</th>
                  <th className="py-1 text-right">toplam</th>
                </tr>
              </thead>
              <tbody>
                {data.issueCounts.map((r) => (
                  <tr key={r.issue_type} className="border-b border-zinc-900">
                    <td className="py-1.5 pr-2 font-mono text-xs">{r.issue_type}</td>
                    <td className="py-1.5 pr-2 text-right font-mono tabular-nums">{r.open_n}</td>
                    <td className="py-1.5 text-right font-mono tabular-nums">{r.n}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Panel>

        <Panel title="OZEL EXCEL SEKMELERI">
          {data.specialSheets.length === 0 ? (
            <p className="text-sm" style={{ color: "var(--text-3)" }}>01_DASHBOARD, 02_AYLIK OZET veya 00_REHBER sekmesi bulunmadi.</p>
          ) : (
            <div className="space-y-1.5">
              {data.specialSheets.map((s, i) => (
                <div key={`${s.workbook_name}-${s.sheet_name}-${i}`} className="border px-2 py-1.5" style={{ borderColor: "var(--line)", borderRadius: "var(--radius)", background: "var(--surface-2)" }}>
                  <div className="text-sm" style={{ color: "var(--text-1)" }}>{s.sheet_name}</div>
                  <div className="font-mono text-[10px]" style={{ color: "var(--text-4)" }}>{s.workbook_name} / {s.detected_type ?? "unknown"} / {s.parse_confidence}</div>
                </div>
              ))}
            </div>
          )}
        </Panel>
      </div>

      <Panel title="HAM VERI KANIT IZI">
        {data.auditTrail.length === 0 ? (
          <p className="text-sm" style={{ color: "var(--text-3)" }}>Audit kaydi yok.</p>
        ) : (
          <div className="space-y-1.5">
            {data.auditTrail.map((a, i) => (
              <div key={`${a.action}-${a.entity_id}-${i}`} className="flex flex-wrap items-center justify-between gap-2 border px-2 py-1.5" style={{ borderColor: "var(--line-faint)", borderRadius: "var(--radius)", background: "var(--surface-2)" }}>
                <span className="font-mono text-[10px]" style={{ color: "var(--text-3)" }}>{a.created_at}</span>
                <span className="text-sm" style={{ color: "var(--text-1)" }}>{a.action}</span>
                <Badge tone="neutral">{a.entity_table}</Badge>
              </div>
            ))}
          </div>
        )}
      </Panel>
    </>
  );
}
