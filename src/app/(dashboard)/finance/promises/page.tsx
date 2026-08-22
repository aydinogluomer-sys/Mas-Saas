import { getPool } from "@/lib/db";
import {
  loadCollectionActions, loadCollectionScores, loadOpenPromises,
} from "@/lib/collections/promises-engine";
import { BAND_LABEL, SCORE_REASON_LABEL, type ScoreBand } from "@/lib/collections/promises";
import { Badge, type Tone } from "@/components/ui/badge";
import { Panel, fmtTL } from "@/components/ui/panel";
import { EmptyState, KeyStat, PageHeader, TableShell } from "@/components/ui/shell";
import { createPromiseAction, detectBrokenAction, resolvePromiseAction } from "./actions";

export const dynamic = "force-dynamic";

const BAND_TONE: Record<ScoreBand, Tone> = {
  good: "green", watch: "amber", risk: "amber", critical: "red",
};
const CHANNEL_LABEL: Record<string, string> = {
  phone: "telefon", email: "e-posta", meeting: "görüşme", message: "mesaj", other: "diğer",
};

export default async function PromisesPage({
  searchParams,
}: { searchParams: Promise<{ error?: string; result?: string; n?: string }> }) {
  const sp = await searchParams;
  const pool = getPool();
  const [open, scores, actions, parties] = await Promise.all([
    loadOpenPromises(pool),
    loadCollectionScores(pool, 50),
    loadCollectionActions(pool, 50),
    pool.query(`select id, name from public.parties where party_type in ('customer','both') order by name limit 500`),
  ]);

  const overdue = open.filter((p) => p.isOverdue);
  // Unknown amounts are excluded from the total rather than counted as zero, and the count of
  // them is shown separately — a total that silently swallowed them would understate exposure.
  const knownTotal = open.reduce((sum, p) => sum + (p.promisedAmount ?? 0), 0);
  const unknownCount = open.filter((p) => p.promisedAmount == null).length;

  return (
    <>
      <PageHeader
        title="Ödeme Sözleri"
        subtitle="Müşterinin söylediği ile gerçekleşen arasındaki fark"
        meta={<Badge tone={overdue.length > 0 ? "amber" : "green"} dot>{overdue.length} vadesi geçmiş</Badge>}
      />

      {sp.error ? (
        <div className="rounded border border-amber-700/50 bg-amber-950/30 px-3 py-2 text-sm text-amber-200">{sp.error}</div>
      ) : null}
      {sp.result === "detected" ? (
        <div className="rounded border border-neutral-700 bg-neutral-900/60 px-3 py-2 text-sm text-neutral-300">
          Tespit çalıştı: {sp.n ?? 0} söz kırılmış olarak işaretlendi.
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <KeyStat label="Açık söz" value={open.length} tone={open.length > 0 ? "info" : "neutral"} />
        <KeyStat label="Vadesi geçmiş" value={overdue.length} tone={overdue.length > 0 ? "warn" : "pos"} />
        <KeyStat label="Bilinen tutar" value={fmtTL(knownTotal)} tone="info" />
        <KeyStat label="Tutarı belirsiz" value={unknownCount} tone={unknownCount > 0 ? "warn" : "neutral"} />
      </div>

      <Panel
        title="AÇIK SÖZLER"
        subtitle="söz verilen tarihe göre"
        right={
          <form action={detectBrokenAction}>
            <button className="button-ghost px-2 py-1 text-xs">Kırılan sözleri tespit et</button>
          </form>
        }
      >
        {open.length === 0 ? (
          <EmptyState>Açık ödeme sözü yok.</EmptyState>
        ) : (
          <TableShell>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase text-neutral-500">
                  <th className="py-1">Cari</th><th>Söz tarihi</th><th className="text-right">Tutar</th>
                  <th>Kanal</th><th>Durum</th><th>Karar</th>
                </tr>
              </thead>
              <tbody>
                {open.map((p) => (
                  <tr key={p.promiseId} className="border-t border-neutral-800 align-top">
                    <td className="py-2">
                      {p.partyName}
                      {p.note ? <span className="block text-xs text-neutral-600">{p.note}</span> : null}
                    </td>
                    <td className="tabular-nums">{p.promisedDate}</td>
                    <td className="text-right tabular-nums">
                      {/* Never rendered as 0,00 TL: an unstated figure is a different fact. */}
                      {p.promisedAmount == null
                        ? <span className="text-amber-400">tutar belirtilmedi</span>
                        : fmtTL(p.promisedAmount)}
                    </td>
                    <td className="text-xs">{CHANNEL_LABEL[p.channel] ?? p.channel}</td>
                    <td>
                      <Badge tone={p.isOverdue ? "amber" : "neutral"}>
                        {p.isOverdue ? `${p.daysLate} gün geçti` : `${Math.abs(p.daysLate)} gün kaldı`}
                      </Badge>
                    </td>
                    <td className="py-2">
                      <form action={resolvePromiseAction} className="flex flex-wrap items-center gap-1">
                        <input type="hidden" name="promiseId" value={p.promiseId} />
                        <button name="status" value="kept" className="rounded bg-emerald-800 px-2 py-1 text-xs">Tutuldu</button>
                        <button name="status" value="broken" className="rounded bg-amber-800 px-2 py-1 text-xs">Kırıldı</button>
                        <button name="status" value="cancelled" className="rounded bg-neutral-700 px-2 py-1 text-xs">İptal</button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableShell>
        )}
      </Panel>

      <Panel title="YENİ SÖZ KAYDI">
        <form action={createPromiseAction} className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <label className="flex flex-col gap-1">
            <span className="font-mono text-[10px] uppercase tracking-wider text-tone-3">Cari</span>
            <select required name="partyId" className="field-control px-2 py-1.5 text-xs">
              {parties.rows.map((p: { id: string; name: string }) => (
                <option key={p.id} value={p.id}>{p.name}</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="font-mono text-[10px] uppercase tracking-wider text-tone-3">Söz verilen tarih</span>
            <input required type="date" name="promisedDate" className="field-control px-2 py-1.5 text-xs" />
          </label>
          <label className="flex flex-col gap-1">
            <span className="font-mono text-[10px] uppercase tracking-wider text-tone-3">Tutar (boş = belirtilmedi)</span>
            <input type="number" step="0.01" min="0" name="promisedAmount" placeholder="belirtilmediyse boş bırakın"
              className="field-control px-2 py-1.5 text-xs" />
          </label>
          <label className="flex flex-col gap-1">
            <span className="font-mono text-[10px] uppercase tracking-wider text-tone-3">Kanal</span>
            <select name="channel" defaultValue="phone" className="field-control px-2 py-1.5 text-xs">
              {Object.entries(CHANNEL_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1 sm:col-span-2">
            <span className="font-mono text-[10px] uppercase tracking-wider text-tone-3">Not</span>
            <input name="note" placeholder="ör. muhasebe müdürü 15'inde havale sözü verdi"
              className="field-control px-2 py-1.5 text-xs" />
          </label>
          <div className="sm:col-span-3">
            <button className="button-ghost px-3 py-1.5 text-xs">Sözü kaydet</button>
          </div>
        </form>
      </Panel>

      <Panel title="MÜŞTERİ TAHSİLAT PUANI" subtitle="en düşük puan önce — liste yukarıdan çalışılır">
        {scores.length === 0 ? (
          <EmptyState>Puanlanacak cari yok.</EmptyState>
        ) : (
          <TableShell>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase text-neutral-500">
                  <th className="py-1">Cari</th><th className="text-right">Puan</th><th>Bant</th>
                  <th className="text-right">Gecikmiş</th><th>Söz (açık/kırık)</th><th>Gerekçe</th>
                </tr>
              </thead>
              <tbody>
                {scores.map((s) => (
                  <tr key={s.partyId} className="border-t border-neutral-800">
                    <td className="py-2">{s.partyName}</td>
                    <td className="text-right tabular-nums">{s.collectionScore}</td>
                    <td>
                      <Badge tone={BAND_TONE[s.scoreBand as ScoreBand] ?? "neutral"}>
                        {BAND_LABEL[s.scoreBand as ScoreBand] ?? s.scoreBand}
                      </Badge>
                    </td>
                    <td className="text-right tabular-nums">{s.overdueAmount == null ? "—" : fmtTL(s.overdueAmount)}</td>
                    <td className="tabular-nums text-xs">{s.promisePendingCount} / {s.promiseBrokenCount}</td>
                    <td className="text-xs text-neutral-400">
                      {/* The score always travels with the named rules that produced it. */}
                      {s.scoreReasons.length === 0
                        ? "—"
                        : s.scoreReasons.map((r) => SCORE_REASON_LABEL[r] ?? r).join(" · ")}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableShell>
        )}
      </Panel>

      <Panel title="TAHSİLAT TAKİP GEÇMİŞİ" subtitle="mevcut görev modeli (action_items) üzerinden">
        {actions.length === 0 ? (
          <EmptyState>Tahsilat takip kaydı yok.</EmptyState>
        ) : (
          <TableShell>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase text-neutral-500">
                  <th className="py-1">Başlık</th><th>Önem</th><th>Durum</th><th>Not</th>
                </tr>
              </thead>
              <tbody>
                {actions.map((a: { id: string; title: string; severity: string; status: string; note: string | null }) => (
                  <tr key={a.id} className="border-t border-neutral-800">
                    <td className="py-2">{a.title}</td>
                    <td><Badge tone={a.severity === "critical" ? "red" : a.severity === "high" ? "amber" : "neutral"}>{a.severity}</Badge></td>
                    <td className="text-xs">{a.status}</td>
                    <td className="text-xs text-neutral-400">{a.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableShell>
        )}
      </Panel>
    </>
  );
}
