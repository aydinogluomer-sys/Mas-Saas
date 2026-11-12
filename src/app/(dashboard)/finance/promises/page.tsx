import { getPool } from "@/lib/db";
import {
  loadBrokenPromises, loadCollectionActions, loadCollectionScores, loadOpenPromises,
} from "@/lib/collections/promises-engine";
import { BAND_LABEL, SCORE_REASON_LABEL, type ScoreBand } from "@/lib/collections/promises";
import { formatMoney } from "@/lib/money-format";
import { Badge, type Tone } from "@/components/ui/badge";
import { Panel, fmtTL } from "@/components/ui/panel";
import { sumKnownReporting } from "@/lib/currency-policy";
import { EmptyState, KeyStat, PageHeader, TableShell } from "@/components/ui/shell";
import { SubmitButton } from "@/components/ui/submit-button";
import { requireRouteAccess } from "@/lib/authz/route-guard";
import { createPromiseAction, detectBrokenAction, resolvePromiseAction } from "./actions";

export const dynamic = "force-dynamic";

const BAND_TONE: Record<ScoreBand, Tone> = {
  good: "green", watch: "amber", risk: "amber", critical: "red",
};
const CHANNEL_LABEL: Record<string, string> = {
  phone: "telefon", email: "e-posta", meeting: "görüşme", message: "mesaj", other: "diğer",
};
const ACTION_SEVERITY_TR: Record<string, string> = {
  critical: "kritik",
  high: "yüksek",
  medium: "orta",
  low: "düşük",
};
const ACTION_STATUS_TR: Record<string, string> = {
  open: "açık",
  in_progress: "devam ediyor",
  blocked: "engelli",
  done: "tamamlandı",
  cancelled: "iptal",
};

export default async function PromisesPage({
  searchParams,
}: { searchParams: Promise<{ error?: string; result?: string; n?: string }> }) {
  const denied = await requireRouteAccess("/finance/promises");
  if (denied) return denied;
  const sp = await searchParams;
  const pool = getPool();
  const [open, broken, scores, actions, parties, openSalesInvoices] = await Promise.all([
    loadOpenPromises(pool),
    loadBrokenPromises(pool, 100),
    loadCollectionScores(pool, 50),
    loadCollectionActions(pool, 50),
    pool.query<{ id: string; name: string }>(
      `select id::text, name
         from public.parties
        where is_active and party_type in ('customer', 'both', 'company')
        order by name limit 500`,
    ),
    pool.query<{ id: string; invoice_no: string; party_name: string; open_amount: string; currency: string }>(
      `select i.id::text, i.invoice_no, p.name as party_name,
              (i.gross_amount - i.allocated_amount)::text as open_amount, i.currency
         from public.invoices i
         join public.parties p on p.id = i.party_id
        where i.direction = 'sales'
          and i.status in ('open', 'partial')
          and i.gross_amount > i.allocated_amount
        order by i.due_date nulls last, i.issue_date desc
        limit 200`,
    ),
  ]);

  const overdue = open.filter((p) => p.isOverdue);
  const known = sumKnownReporting(open, (p) => p.promisedAmount);
  const knownTotal = known.total;
  const unknownCount = known.missing;
  const foreignCount = known.foreignCount;

  return (
    <>
      <PageHeader
        title="Ödeme Sözleri"
        subtitle="Müşterinin söylediği ile gerçekleşen arasındaki fark"
        meta={<Badge tone={overdue.length > 0 ? "amber" : "green"} dot>{overdue.length} vadesi geçmiş</Badge>}
      />

      {sp.error ? (
        <div className="mb-3 rounded border border-neg/40 bg-neg/10 px-3 py-2 text-sm text-neg">{sp.error}</div>
      ) : null}
      {sp.result === "detected" ? (
        <div className="mb-3 rounded border border-pos/40 bg-pos/10 px-3 py-2 text-sm text-pos">
          Tespit çalıştı: {sp.n ?? 0} söz kırılmış olarak işaretlendi.
        </div>
      ) : sp.result === "resolved" ? (
        <div className="mb-3 rounded border border-pos/40 bg-pos/10 px-3 py-2 text-sm text-pos">
          Ödeme sözü durumu güncellendi.
        </div>
      ) : sp.result === "created" ? (
        <div className="mb-3 rounded border border-pos/40 bg-pos/10 px-3 py-2 text-sm text-pos">
          Yeni ödeme sözü kaydedildi.
        </div>
      ) : null}

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <KeyStat label="Açık söz" value={open.length} tone={open.length > 0 ? "info" : "neutral"} />
        <KeyStat label="Vadesi geçmiş" value={overdue.length} tone={overdue.length > 0 ? "warn" : "pos"} />
        <KeyStat label="Bilinen tutar (TRY)" value={fmtTL(knownTotal)} tone="info"
          sub={foreignCount > 0 ? `${foreignCount} söz TRY-dışı — toplamda yok` : undefined} />
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
                <tr className="text-left text-xs uppercase text-tone-3">
                  <th className="py-1">Cari</th><th>Söz tarihi</th><th className="text-right">Tutar</th>
                  <th>Kanal</th><th>Durum</th><th>Karar</th>
                </tr>
              </thead>
              <tbody>
                {open.map((p) => (
                  <tr key={p.promiseId} className="border-t border-line-faint align-top">
                    <td className="py-2">
                      {p.partyName}
                      {p.note ? <span className="block text-xs text-tone-3">{p.note}</span> : null}
                    </td>
                    <td className="tabular-nums">{p.promisedDate}</td>
                    <td className="text-right font-mono tabular-nums">
                      {p.promisedAmount == null
                        ? <span className="text-warn">tutar belirtilmedi</span>
                        : formatMoney(p.promisedAmount, p.currency)}
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
                        <button name="status" value="kept" className="button-ghost px-2 py-1 text-xs text-pos">Tutuldu</button>
                        <button name="status" value="broken" className="button-ghost px-2 py-1 text-xs text-warn">Kırıldı</button>
                        <button name="status" value="cancelled" className="button-ghost px-2 py-1 text-xs text-tone-3">İptal</button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableShell>
        )}
      </Panel>

      <Panel
        title={`KIRILAN SÖZLER (GECİKMELİ TAHSİLAT KAPANIŞI) — ${broken.length}`}
        subtitle="gecikmeli ödeme geldiğinde sözü tutuldu olarak işaretleyip takip görevini kapatın"
      >
        {broken.length === 0 ? (
          <EmptyState>Kırılmış ödeme sözü kaydı yok.</EmptyState>
        ) : (
          <TableShell>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs uppercase text-tone-3">
                  <th className="py-1">Cari</th>
                  <th>Söz tarihi</th>
                  <th className="text-right">Tutar</th>
                  <th>Kanal</th>
                  <th>Gecikmeli Tahsilat Kararı</th>
                </tr>
              </thead>
              <tbody>
                {broken.map((b) => (
                  <tr key={b.promiseId} className="border-t border-line-faint align-top">
                    <td className="py-2">
                      {b.partyName}
                      {b.note ? <span className="block text-xs text-tone-3">{b.note}</span> : null}
                    </td>
                    <td className="font-mono text-xs tabular-nums">{b.promisedDate}</td>
                    <td className="text-right font-mono tabular-nums">
                      {b.promisedAmount == null ? (
                        <span className="text-warn">tutar belirtilmedi</span>
                      ) : (
                        formatMoney(b.promisedAmount, b.currency)
                      )}
                    </td>
                    <td className="text-xs">{CHANNEL_LABEL[b.channel] ?? b.channel}</td>
                    <td className="py-1.5">
                      <form action={resolvePromiseAction} className="flex flex-wrap items-center gap-1.5">
                        <input type="hidden" name="promiseId" value={b.promiseId} />
                        <input type="hidden" name="status" value="kept" />
                        <input
                          name="note"
                          placeholder="Gecikmeli tahsilat notu (opsiyonel)"
                          className="field-control w-52 px-2 py-1 text-xs"
                        />
                        <SubmitButton pendingText="Güncelleniyor…" className="button-ghost px-2.5 py-1 text-xs text-pos">
                          Tutuldu Olarak İşaretle
                        </SubmitButton>
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
            <span className="font-mono text-[10px] uppercase tracking-wider text-tone-3">Açık satış faturası (opsiyonel)</span>
            <select name="invoiceId" defaultValue="" className="field-control px-2 py-1.5 text-xs">
              <option value="">Faturaya bağlama (cari geneli)</option>
              {openSalesInvoices.rows.map((inv) => (
                <option key={inv.id} value={inv.id}>
                  {inv.invoice_no} · {inv.party_name} ({formatMoney(Number(inv.open_amount), inv.currency)})
                </option>
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
            <span className="font-mono text-[10px] uppercase tracking-wider text-tone-3">Para birimi</span>
            <select name="currency" defaultValue="TRY" className="field-control px-2 py-1.5 text-xs">
              {["TRY", "USD", "EUR", "GBP"].map((cur) => <option key={cur} value={cur}>{cur}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="font-mono text-[10px] uppercase tracking-wider text-tone-3">Kanal</span>
            <select name="channel" defaultValue="phone" className="field-control px-2 py-1.5 text-xs">
              {Object.entries(CHANNEL_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </label>
          <label className="flex flex-col gap-1 sm:col-span-3">
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
                <tr className="text-left text-xs uppercase text-tone-3">
                  <th className="py-1">Cari</th><th className="text-right">Puan</th><th>Bant</th>
                  <th className="text-right">Gecikmiş (TRY)</th><th>Söz (açık/kırık)</th><th>Gerekçe</th>
                </tr>
              </thead>
              <tbody>
                {scores.map((s) => (
                  <tr key={s.partyId} className="border-t border-line-faint">
                    <td className="py-2">{s.partyName}</td>
                    <td className="text-right tabular-nums">{s.collectionScore}</td>
                    <td>
                      <Badge tone={BAND_TONE[s.scoreBand as ScoreBand] ?? "neutral"}>
                        {BAND_LABEL[s.scoreBand as ScoreBand] ?? s.scoreBand}
                      </Badge>
                    </td>
                    <td className="text-right tabular-nums">{s.overdueAmount == null ? "—" : fmtTL(s.overdueAmount)}</td>
                    <td className="tabular-nums text-xs">{s.promisePendingCount} / {s.promiseBrokenCount}</td>
                    <td className="text-xs text-tone-2">
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
                <tr className="text-left text-xs uppercase text-tone-3">
                  <th className="py-1">Başlık</th><th>Önem</th><th>Durum</th><th>Not</th>
                </tr>
              </thead>
              <tbody>
                {actions.map((a: { id: string; title: string; severity: string; status: string; note: string | null }) => (
                  <tr key={a.id} className="border-t border-line-faint">
                    <td className="py-2">{a.title}</td>
                    <td><Badge tone={a.severity === "critical" ? "red" : a.severity === "high" ? "amber" : "neutral"}>{ACTION_SEVERITY_TR[a.severity] ?? a.severity}</Badge></td>
                    <td className="text-xs">{ACTION_STATUS_TR[a.status] ?? a.status}</td>
                    <td className="text-xs text-tone-2">{a.note}</td>
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
