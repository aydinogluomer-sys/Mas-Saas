// Faz 21 — Fatura Merkezi.
//
// Open items with ageing first (that is what an operator chases), then the two data-quality
// surfaces this phase adds — duplicate suspects and header/line mismatches — then the invoice
// list and a draft form.
//
// Both data-quality panels REPORT rather than block, and say so on screen. That is the repo's
// standing posture for judgement calls (cashflow identity, Faz 19's unresolved counterparties,
// Faz 20's match conflicts): compute it, surface it, let a person decide.

import { getPool } from "@/lib/db";
import {
  listInvoices, loadDuplicateSuspects, loadInvoiceParties,
  loadLineMismatches, loadOpenItems,
} from "@/lib/invoices/engine";
import { Badge, type Tone } from "@/components/ui/badge";
import { Panel, fmtTL } from "@/components/ui/panel";
import { PageHeader } from "@/components/ui/shell";
import {
  cancelInvoiceAction, changeStatusAction, createInvoiceAction, recordPaymentAction,
} from "./actions";

export const dynamic = "force-dynamic";

const STATUS_TONE: Record<string, Tone> = {
  draft: "neutral", open: "blue", partial: "amber", paid: "green",
  closed: "neutral", cancelled: "red",
};
const AGE_TONE: Record<string, Tone> = {
  "tarihsiz": "neutral", "vadesi gelmemiş": "green", "1-30 gün": "amber",
  "31-60 gün": "amber", "61-90 gün": "red", "90+ gün": "red",
};

export default async function InvoicesPage({
  searchParams,
}: { searchParams: Promise<{ error?: string; result?: string }> }) {
  const sp = await searchParams;
  const pool = getPool();
  const [openItems, duplicates, mismatches, invoices, parties] = await Promise.all([
    loadOpenItems(pool, 60),
    loadDuplicateSuspects(pool, 20),
    loadLineMismatches(pool, 20),
    listInvoices(pool, { limit: 60 }),
    loadInvoiceParties(pool),
  ]);

  const overdue = openItems.filter((i) => (i.daysOverdue ?? 0) > 0);
  const receivable = openItems.filter((i) => i.direction === "sales").reduce((n, i) => n + i.remaining, 0);
  const payable = openItems.filter((i) => i.direction === "purchase").reduce((n, i) => n + i.remaining, 0);

  return (
    <>
      <PageHeader
        title="Fatura Merkezi"
        subtitle="Açık kalemler, vade yaşlandırma, duplicate tespiti ve iptal/reversal"
        meta={
          <Badge tone={duplicates.length > 0 || mismatches.length > 0 ? "amber" : overdue.length > 0 ? "red" : "green"} dot>
            {duplicates.length > 0
              ? `${duplicates.length} duplicate şüphesi`
              : overdue.length > 0 ? `${overdue.length} vadesi geçmiş` : `${openItems.length} açık kalem`}
          </Badge>
        }
      />

      {sp.error && <div className="mb-3 rounded border border-neg/40 bg-neg/10 p-2 text-sm text-neg">{sp.error}</div>}
      {sp.result && <div className="mb-3 rounded border border-pos/40 bg-pos/10 p-2 text-sm text-pos">{sp.result}</div>}

      <div className="mb-4 grid grid-cols-2 gap-2 lg:grid-cols-4">
        <Panel title="AÇIK ALACAK"><b className="font-mono text-lg text-pos">{fmtTL(receivable)}</b></Panel>
        <Panel title="AÇIK BORÇ"><b className="font-mono text-lg text-neg">{fmtTL(payable)}</b></Panel>
        <Panel title="VADESİ GEÇMİŞ"><b className="font-mono text-lg">{overdue.length}</b></Panel>
        <Panel title="AÇIK KALEM"><b className="font-mono text-lg">{openItems.length}</b></Panel>
      </div>

      <Panel title={`AÇIK KALEMLER — ${openItems.length}`}>
        {openItems.length === 0 ? (
          <p className="py-2 text-sm text-tone-3">Açık fatura yok.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-tone-3">
                  <th>No</th><th>Karşı taraf</th><th>Yön</th><th>Vade</th>
                  <th className="text-right">Tutar</th><th className="text-right">Ödenen</th>
                  <th className="text-right">Kalan</th><th>Yaşlandırma</th><th>Durum</th><th />
                </tr>
              </thead>
              <tbody>
                {openItems.map((i) => (
                  <tr key={i.id} className="border-t border-line-faint">
                    <td className="py-2 font-mono text-xs">{i.invoiceNo}</td>
                    <td>{i.partyName}</td>
                    <td className="text-xs text-tone-3">{i.direction === "sales" ? "satış" : "alış"}</td>
                    <td className="font-mono text-xs">{i.dueDate ?? "—"}</td>
                    <td className="text-right font-mono tabular-nums">{fmtTL(i.grossAmount)}</td>
                    <td className="text-right font-mono tabular-nums">{fmtTL(i.paidAmount)}</td>
                    <td className={`text-right font-mono tabular-nums ${i.remaining < 0 ? "text-warn" : ""}`}>
                      {fmtTL(i.remaining)}
                    </td>
                    <td><Badge tone={AGE_TONE[i.ageingBucket] ?? "neutral"}>{i.ageingBucket}</Badge></td>
                    <td><Badge tone={STATUS_TONE[i.status] ?? "neutral"}>{i.status}</Badge></td>
                    <td>
                      <form action={recordPaymentAction} className="flex items-center gap-1">
                        <input type="hidden" name="invoiceId" value={i.id} />
                        <input
                          name="amount" type="number" step="0.01" min="0.01" placeholder="tutar"
                          className="w-20 rounded border border-line-faint bg-transparent px-1 py-0.5 text-xs"
                        />
                        <button className="text-xs text-pos hover:underline">tahsil</button>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Panel title={`DUPLICATE ŞÜPHESİ — ${duplicates.length}`}>
          <p className="mb-2 text-xs text-tone-3">
            Karşı taraf + numara + tutar + tarih sezgisi. <b>Engellenmez, bildirilir</b> — iki
            satır anlamlı şekilde farklı olabilir; kararı insan verir. İptal edilen fatura bu
            listeden düşer.
          </p>
          {duplicates.length === 0 ? (
            <p className="py-2 text-sm text-tone-3">Şüpheli fatura yok.</p>
          ) : (
            duplicates.map((d) => (
              <div key={`${d.invoiceId}-${d.otherInvoiceId}`} className="border-b border-line-faint py-2 text-sm">
                <div className="flex items-baseline justify-between gap-2">
                  <span>
                    <b>{d.invoiceNo}</b>
                    <span className="mx-1 text-tone-3">↔</span>
                    <b>{d.otherInvoiceNo}</b>
                    <span className="ml-2 text-xs text-tone-3">{d.partyName}</span>
                  </span>
                  <span className="font-mono tabular-nums">{fmtTL(d.grossAmount)}</span>
                </div>
                <span className="text-[11px] text-tone-3">
                  <Badge tone={d.signal === "same_number" ? "red" : "amber"}>{d.signal}</Badge>
                  {" "}{d.issueDate} / {d.otherIssueDate} · {d.dateGapDays} gün fark
                </span>
              </div>
            ))
          )}
        </Panel>

        <Panel title={`BAŞLIK / KALEM UYUŞMAZLIĞI — ${mismatches.length}`}>
          <p className="mb-2 text-xs text-tone-3">
            Başlık tutarı kalemlerin toplamıyla uyuşmuyor. Trigger ile engellenmedi çünkü
            kalemler başlıktan SONRA yazılır; nakit-akış kimlik kontrolüyle aynı yaklaşım —
            hesapla, göster, insan karar versin.
          </p>
          {mismatches.length === 0 ? (
            <p className="py-2 text-sm text-tone-3">Uyuşmazlık yok.</p>
          ) : (
            mismatches.map((m) => (
              <div key={m.invoiceId} className="grid grid-cols-[1fr_auto_auto] gap-2 border-b border-line-faint py-1 text-sm">
                <span className="font-mono text-xs">{m.invoiceNo}</span>
                <span className="text-xs text-tone-3">{m.lineCount} kalem</span>
                <span className="font-mono tabular-nums text-neg">{fmtTL(m.difference)}</span>
              </div>
            ))
          )}
        </Panel>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Panel title={`SON FATURALAR — ${invoices.length}`}>
            {invoices.length === 0 ? (
              <p className="py-2 text-sm text-tone-3">Henüz fatura yok.</p>
            ) : (
              invoices.map((i) => (
                <div key={i.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-line-faint py-2 text-sm">
                  <span className="flex flex-wrap items-baseline gap-2">
                    <span className="font-mono text-xs">{i.invoiceNo}</span>
                    <b>{i.partyName}</b>
                    <span className="text-xs text-tone-3">{i.issueDate} · {i.lineCount} kalem</span>
                    <Badge tone={STATUS_TONE[i.status] ?? "neutral"}>{i.status}</Badge>
                  </span>
                  <span className="flex items-center gap-2">
                    <span className="font-mono tabular-nums">{fmtTL(i.grossAmount)}</span>
                    {i.status === "draft" && (
                      <form action={changeStatusAction} className="inline">
                        <input type="hidden" name="invoiceId" value={i.id} />
                        <input type="hidden" name="status" value="open" />
                        <button className="text-xs text-info hover:underline">düzenle (issue)</button>
                      </form>
                    )}
                    {i.status !== "cancelled" && i.status !== "closed" && (
                      <form action={cancelInvoiceAction} className="inline-flex items-center gap-1">
                        <input type="hidden" name="invoiceId" value={i.id} />
                        <input
                          name="reason" required minLength={3} placeholder="iptal gerekçesi"
                          className="w-32 rounded border border-line-faint bg-transparent px-1 py-0.5 text-[11px]"
                        />
                        <button className="text-xs text-neg hover:underline">iptal</button>
                      </form>
                    )}
                  </span>
                </div>
              ))
            )}
          </Panel>
        </div>

        <Panel title="YENİ FATURA (TASLAK)">
          <p className="mb-2 text-xs text-tone-3">
            Fatura her zaman <b>taslak</b> olarak açılır — düzenlenmiş bir faturanın içeriği
            değiştirilemez, düzeltme iptal+yeniden düzenlemeyle yapılır.
          </p>
          <form action={createInvoiceAction} className="grid gap-2 text-sm">
            <select name="direction" required className="rounded border border-line-faint bg-transparent px-2 py-1">
              <option value="sales">satış</option>
              <option value="purchase">alış</option>
            </select>
            <select name="partyId" required className="rounded border border-line-faint bg-transparent px-2 py-1">
              <option value="">Karşı taraf…</option>
              {parties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
            <input name="invoiceNo" required placeholder="Fatura no" className="rounded border border-line-faint bg-transparent px-2 py-1" />
            <input name="issueDate" type="date" required className="rounded border border-line-faint bg-transparent px-2 py-1" />
            <input name="dueDate" type="date" className="rounded border border-line-faint bg-transparent px-2 py-1" />
            <div className="mt-1 border-t border-line-faint pt-2 text-[11px] text-tone-3">Kalem</div>
            <input name="lineDescription" required placeholder="Açıklama" className="rounded border border-line-faint bg-transparent px-2 py-1" />
            <div className="grid grid-cols-3 gap-1">
              <input name="lineQuantity" type="number" step="0.0001" defaultValue="1" required placeholder="Miktar" className="rounded border border-line-faint bg-transparent px-1 py-1" />
              <input name="lineUnitPrice" type="number" step="0.0001" required placeholder="Birim fiyat" className="rounded border border-line-faint bg-transparent px-1 py-1" />
              <input name="lineTaxRate" type="number" step="0.01" defaultValue="0.20" placeholder="KDV" className="rounded border border-line-faint bg-transparent px-1 py-1" />
            </div>
            <button className="rounded border border-line-faint px-2 py-1 hover:bg-white/5">Taslak oluştur</button>
          </form>
        </Panel>
      </div>
    </>
  );
}
