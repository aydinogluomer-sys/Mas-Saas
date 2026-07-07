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

export default async function DataQualityPage() {
  const data = await loadDataQualityCenter(getPool());

  return (
    <>
      <PageHeader
        title="Veri Kalite Merkezi"
        subtitle="Karari engelleyen sorunlar / gorevler / kaynak izleri"
        meta={<Badge tone={data.highOpenCount > 0 ? "red" : data.openReviewCount > 0 ? "amber" : "green"} dot>{data.openReviewCount} acik</Badge>}
      />

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        <KeyStat label="Acik inceleme" value={data.openReviewCount} tone={data.openReviewCount > 0 ? "warn" : "pos"} href="/imports" />
        <KeyStat label="Yuksek/acil" value={data.highOpenCount} tone={data.highOpenCount > 0 ? "neg" : "pos"} href="/data-quality" />
        <KeyStat label="Acik gorev" value={data.actionOpenCount} tone={data.actionOpenCount > 0 ? "warn" : "neutral"} href="/data-quality" />
        <KeyStat label="Dis review" value={data.externalPendingCount} tone={data.externalPendingCount > 0 ? "warn" : "pos"} href="/assumptions" />
        <KeyStat label="Ozel sekme" value={data.specialSheets.length} tone={data.specialSheets.length > 0 ? "info" : "neutral"} href="/data-quality" />
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
                  <button type="submit" className="border px-2 py-1 font-mono text-[10px] uppercase tracking-wider" style={{ borderColor: "var(--accent)", color: "var(--accent)", borderRadius: "var(--radius)" }}>
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
                      {(["in_progress", "blocked", "done", "cancelled"] as const).map((s) => (
                        <form key={s} action={setActionStatusAction}>
                          <input type="hidden" name="id" value={a.id} />
                          <input type="hidden" name="status" value={s} />
                          <input type="hidden" name="backTo" value="/data-quality" />
                          <button type="submit" className="border px-1.5 py-0.5 font-mono text-[9px] uppercase" style={{ borderColor: "var(--line-faint)", color: "var(--text-3)" }}>
                            {s === "in_progress" ? "basla" : s === "blocked" ? "blok" : s === "done" ? "bitti" : "iptal"}
                          </button>
                        </form>
                      ))}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Panel>

        <Panel title="MANUEL GOREV">
          <form action={createManualActionAction} className="space-y-2">
            <input name="title" required placeholder="gorev basligi" className="w-full border bg-black/30 px-2 py-1.5 text-sm outline-none" style={{ borderColor: "var(--line)", borderRadius: "var(--radius)", color: "var(--text-1)" }} />
            <div className="grid grid-cols-2 gap-2">
              <select name="severity" className="border bg-black/30 px-2 py-1.5 text-sm outline-none" style={{ borderColor: "var(--line)", borderRadius: "var(--radius)", color: "var(--text-1)" }} defaultValue="medium">
                <option value="critical">critical</option>
                <option value="high">high</option>
                <option value="medium">medium</option>
                <option value="low">low</option>
              </select>
              <input name="dueDate" type="date" className="border bg-black/30 px-2 py-1.5 text-sm outline-none" style={{ borderColor: "var(--line)", borderRadius: "var(--radius)", color: "var(--text-1)" }} />
            </div>
            <input name="owner" placeholder="owner" className="w-full border bg-black/30 px-2 py-1.5 text-sm outline-none" style={{ borderColor: "var(--line)", borderRadius: "var(--radius)", color: "var(--text-1)" }} />
            <textarea name="note" rows={3} placeholder="not" className="w-full border bg-black/30 px-2 py-1.5 text-sm outline-none" style={{ borderColor: "var(--line)", borderRadius: "var(--radius)", color: "var(--text-1)" }} />
            <button type="submit" className="border px-3 py-2 font-mono text-[10px] uppercase tracking-wider" style={{ borderColor: "var(--accent)", color: "var(--accent)", borderRadius: "var(--radius)" }}>
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
    </>
  );
}
