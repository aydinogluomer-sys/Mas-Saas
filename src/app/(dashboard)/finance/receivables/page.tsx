// Faz 22 & Faz 47 (D1) — Alacak / Borç ve Cari Hesap.
//
// Sayfalanmamış kanonik açık alacak/borç KPI toplamları + döviz rozetleri + döviz-duyarlı `formatMoney`.

import Link from "@/components/ui/app-link";
import { getRequestUser } from "@/lib/auth";
import { can } from "@/lib/authz/matrix";
import { getPool } from "@/lib/db";
import { loadCanonicalPayablesKpi, loadCanonicalReceivablesKpi } from "@/lib/metrics/canonical-kpis";
import { intOrNull, moneyOrNull } from "@/lib/money";
import { formatForeignCurrencyBadges, formatMoney } from "@/lib/money-format";
import {
  listRecentActiveAllocations,
  loadCurrentAccounts,
  loadDsoDpo,
  loadPayableTotals,
  loadReceivables,
  loadReceivableTotals,
  loadSettlementSpeed,
  loadUnallocatedSettlements,
  proposeAllocation,
} from "@/lib/receivables/engine";
import { COLLECTION_BUCKETS } from "@/lib/receivables/rules";
import { istanbulDateISO } from "@/lib/reports/rules";
import { Badge, type Tone } from "@/components/ui/badge";
import { Panel, fmtTL } from "@/components/ui/panel";
import { PageHeader } from "@/components/ui/shell";
import { allocateAction, applyFifoAllocationAction, reverseAllocationAction } from "./actions";
import { requireRouteAccess } from "@/lib/authz/route-guard";

export const dynamic = "force-dynamic";

const BUCKET_TONE: Record<string, Tone> = {
  "vadesi gelmemiş": "green", "1-7 gün": "amber", "8-30 gün": "amber",
  "31-60 gün": "red", "60+ gün": "red", "tarihsiz": "neutral",
};

const PARTY_TYPE_TR: Record<string, string> = {
  customer: "müşteri",
  supplier: "tedarikçi",
  vendor: "tedarikçi",
  both: "müşteri + tedarikçi",
  bank: "banka",
  lender: "finansör",
  tax: "vergi/kurum",
  other: "diğer",
};

const LIST_LIMIT = 75;

export default async function ReceivablesPage({
  searchParams,
}: {
  searchParams: Promise<{
    error?: string;
    result?: string;
    fifoParty?: string;
    fifoDirection?: string;
    fifoCurrency?: string;
    fifoAmount?: string;
  }>;
}) {
  const denied = await requireRouteAccess("/finance/receivables");
  if (denied) return denied;
  const sp = await searchParams;
  const session = await getRequestUser();
  const canAllocate = session ? can(session.role, "invoice_allocations", "insert") : false;
  const pool = getPool();
  const today = istanbulDateISO();

  const [
    receivables,
    recTotals,
    payTotals,
    canonicalRec,
    canonicalPay,
    accounts,
    dsoDpo,
    unallocated,
    speed,
    recentAllocations,
    partySummariesRes,
    collectionAllocsRes,
    partiesListRes,
  ] = await Promise.all([
    loadReceivables(pool, LIST_LIMIT),
    loadReceivableTotals(pool, today),
    loadPayableTotals(pool, today),
    loadCanonicalReceivablesKpi(pool),
    loadCanonicalPayablesKpi(pool),
    loadCurrentAccounts(pool, 20),
    loadDsoDpo(pool, 365),
    loadUnallocatedSettlements(pool, 25),
    loadSettlementSpeed(pool, 10),
    listRecentActiveAllocations(pool, 20),
    pool.query<{
      party_id: string;
      party_name: string;
      sales_count: string;
      purchase_count: string;
      receivable_open: string;
      receivable_paid: string;
      payable_open: string;
      payable_paid: string;
      cancelled_count: string;
      earliest_due_date: string | null;
      foreign_currency_count: string;
    }>(
      `select party_id::text,
              party_name,
              sales_count::text,
              purchase_count::text,
              receivable_open::text,
              receivable_paid::text,
              payable_open::text,
              payable_paid::text,
              cancelled_count::text,
              to_char(earliest_due_date, 'YYYY-MM-DD') as earliest_due_date,
              foreign_currency_count::text
         from public.invoice_party_summary
        where sales_count > 0 or purchase_count > 0
        order by (receivable_open + payable_open) desc, party_name
        limit 40`,
    ),
    pool.query<{
      id: string;
      invoice_id: string;
      invoice_no: string;
      party_id: string;
      party_name: string;
      currency: string;
      source_table: string;
      allocated_amount: string;
      allocated_on: string;
      is_reversed: boolean;
      reversed_reason: string | null;
      notes: string | null;
    }>(
      `select ca.id::text,
              ca.invoice_id::text,
              ca.invoice_no,
              ca.party_id::text,
              p.name as party_name,
              ca.currency,
              ca.source_table,
              ca.allocated_amount::text,
              to_char(ca.allocated_on, 'YYYY-MM-DD') as allocated_on,
              (ca.reversed_at is not null) as is_reversed,
              ca.reversed_reason,
              ca.notes
         from public.collection_allocations ca
         join public.parties p on p.id = ca.party_id
        order by ca.allocated_on desc, ca.created_at desc
        limit 30`,
    ),
    pool.query<{ id: string; name: string }>(
      `select distinct p.id::text, p.name
         from public.parties p
         join public.invoices i on i.party_id = p.id
        where i.status in ('open', 'partial')
          and i.gross_amount > i.allocated_amount
        order by p.name
        limit 200`,
    ),
  ]);

  const partySummaries = partySummariesRes.rows.map((r) => ({
    partyId: r.party_id,
    partyName: r.party_name,
    salesCount: intOrNull(r.sales_count) ?? 0,
    purchaseCount: intOrNull(r.purchase_count) ?? 0,
    receivableOpen: moneyOrNull(r.receivable_open) ?? 0,
    receivablePaid: moneyOrNull(r.receivable_paid) ?? 0,
    payableOpen: moneyOrNull(r.payable_open) ?? 0,
    payablePaid: moneyOrNull(r.payable_paid) ?? 0,
    cancelledCount: intOrNull(r.cancelled_count) ?? 0,
    earliestDueDate: r.earliest_due_date,
    foreignCurrencyCount: intOrNull(r.foreign_currency_count) ?? 0,
  }));

  const collectionAllocations = collectionAllocsRes.rows.map((c) => ({
    id: c.id,
    invoiceId: c.invoice_id,
    invoiceNo: c.invoice_no,
    partyId: c.party_id,
    partyName: c.party_name,
    currency: c.currency || "TRY",
    sourceTable: c.source_table,
    allocatedAmount: moneyOrNull(c.allocated_amount) ?? 0,
    allocatedOn: c.allocated_on,
    isReversed: Boolean(c.is_reversed),
    reversedReason: c.reversed_reason,
    notes: c.notes,
  }));

  const fifoDirection: "sales" | "purchase" = sp.fifoDirection === "purchase" ? "purchase" : "sales";
  const rawFifoCurrency = (sp.fifoCurrency ?? "TRY").trim().toUpperCase();
  const fifoCurrency = ["TRY", "USD", "EUR", "GBP"].includes(rawFifoCurrency) ? rawFifoCurrency : "TRY";
  const fifoParty =
    sp.fifoParty && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(sp.fifoParty)
      ? sp.fifoParty
      : "";
  const fifoAmountNum = sp.fifoAmount ? Number(sp.fifoAmount) : 0;
  const hasValidFifoQuery = Boolean(fifoParty && Number.isFinite(fifoAmountNum) && fifoAmountNum > 0);

  let fifoPreview: {
    lines: Array<{
      invoiceId: string;
      invoiceNo: string;
      dueDate: string | null;
      issueDate: string | null;
      currency: string;
      openAmount: number;
      proposedAmount: number;
      currencyMatches: boolean;
    }>;
    allocated: number;
    unallocated: number;
    matchingAllocated: number;
  } | null = null;

  if (hasValidFifoQuery) {
    const rawPlan = await proposeAllocation(pool, fifoParty, fifoDirection, fifoAmountNum);
    const ids = rawPlan.lines.map((l) => l.invoiceId);
    const metaRes =
      ids.length > 0
        ? await pool.query<{
            id: string;
            invoice_no: string;
            currency: string;
            due_date: string | null;
            issue_date: string | null;
            open_amount: string;
          }>(
            `select id::text,
                    invoice_no,
                    currency,
                    to_char(due_date, 'YYYY-MM-DD') as due_date,
                    to_char(issue_date, 'YYYY-MM-DD') as issue_date,
                    (gross_amount - allocated_amount)::text as open_amount
               from public.invoices
              where id = any($1::uuid[])`,
            [ids],
          )
        : { rows: [] };
    const metaMap = new Map(metaRes.rows.map((m) => [m.id, m]));
    const enriched = rawPlan.lines.map((l) => {
      const meta = metaMap.get(l.invoiceId);
      const invCurrency = meta?.currency ?? "TRY";
      return {
        invoiceId: l.invoiceId,
        invoiceNo: meta?.invoice_no ?? l.invoiceId.slice(0, 8),
        dueDate: meta?.due_date ?? null,
        issueDate: meta?.issue_date ?? null,
        currency: invCurrency,
        openAmount: moneyOrNull(meta?.open_amount ?? null) ?? l.amount,
        proposedAmount: l.amount,
        currencyMatches: invCurrency === fifoCurrency,
      };
    });
    const matchingAllocated = enriched
      .filter((x) => x.currencyMatches)
      .reduce((sum, x) => sum + x.proposedAmount, 0);
    fifoPreview = {
      lines: enriched,
      allocated: rawPlan.allocated,
      unallocated: rawPlan.unallocated,
      matchingAllocated,
    };
  }

  const unallocatedInflows = unallocated.filter((u) => u.direction === "inflow");
  const unallocatedOutflows = unallocated.filter((u) => u.direction === "outflow");
  const fifoSettlementPool = fifoDirection === "sales" ? unallocatedInflows : unallocatedOutflows;

  const recAgeing = recTotals.ageing;
  const payAgeing = payTotals.ageing;
  const recTotal = recTotals.totalOpenAmount;
  const payTotal = payTotals.totalOpenAmount;
  const overdueCount = recTotals.overdueCount;
  const recTruncated = recTotals.itemCount > receivables.length;
  const recForeignText = formatForeignCurrencyBadges(canonicalRec.foreignBuckets);
  const payForeignText = formatForeignCurrencyBadges(canonicalPay.foreignBuckets);

  return (
    <>
      <PageHeader
        title="Alacak / Borç ve Cari Hesap"
        subtitle="Yaşlandırma, tahsis (dağıtım), cari hesap kartı ve DSO/DPO"
        meta={
          <Badge tone={overdueCount > 0 ? "red" : unallocated.length > 0 ? "amber" : "green"} dot>
            {overdueCount > 0 ? `${overdueCount} vadesi geçmiş alacak`
              : unallocated.length > 0 ? `${unallocated.length} dağıtılmamış tahsilat`
              : `${recTotals.itemCount} açık alacak`}
          </Badge>
        }
      />

      {sp.error && <div className="mb-3 rounded border border-neg/40 bg-neg/10 p-2 text-sm text-neg">{sp.error}</div>}
      {sp.result && <div className="mb-3 rounded border border-pos/40 bg-pos/10 p-2 text-sm text-pos">{sp.result}</div>}

      <div className="mb-4 grid grid-cols-2 gap-2 lg:grid-cols-4">
        <Panel title="AÇIK ALACAK (TRY)" subtitle={recForeignText ?? undefined}>
          <b className="font-mono text-lg text-pos">{formatMoney(recTotal, "TRY")}</b>
          <div className="text-xs text-tone-3">{recTotals.itemCount} kayıt</div>
        </Panel>
        <Panel title="AÇIK BORÇ (TRY)" subtitle={payForeignText ?? undefined}>
          <b className="font-mono text-lg text-neg">{formatMoney(payTotal, "TRY")}</b>
          <div className="text-xs text-tone-3">{payTotals.itemCount} kayıt</div>
        </Panel>
        <Panel title="DSO (365g)">
          <b className="font-mono text-lg">{dsoDpo.dso == null ? "—" : `${dsoDpo.dso} gün`}</b>
        </Panel>
        <Panel title="DPO (365g)">
          <b className="font-mono text-lg">{dsoDpo.dpo == null ? "—" : `${dsoDpo.dpo} gün`}</b>
        </Panel>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {([["ALACAK YAŞLANDIRMA", recAgeing], ["BORÇ YAŞLANDIRMA", payAgeing]] as const).map(([title, buckets]) => (
          <Panel key={title} title={title}>
            <table className="w-full text-sm">
              <tbody>
                {COLLECTION_BUCKETS.map((b) => {
                  const row = buckets.find((x) => x.bucket === b)!;
                  return (
                    <tr key={b} className="border-b border-line-faint">
                      <td className="py-1"><Badge tone={BUCKET_TONE[b] ?? "neutral"}>{b}</Badge></td>
                      <td className="py-1 text-right tabular-nums text-tone-3">{row.count}</td>
                      <td className="py-1 text-right font-mono tabular-nums">{fmtTL(row.amount)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </Panel>
        ))}
      </div>

      <div className="mt-4">
        <Panel title={`AÇIK ALACAKLAR — ${recTruncated ? `${receivables.length} / ${recTotals.itemCount}` : receivables.length}`}
          subtitle={recTruncated
            ? `En yüksek tutarlı ${LIST_LIMIT} kayıt listeleniyor; yukarıdaki toplamlar ${recTotals.itemCount} kaydın tamamını kapsıyor.`
            : undefined}>
          {receivables.length === 0 ? (
            <p className="py-2 text-sm text-tone-3">Açık alacak yok.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-tone-3">
                    <th>Fatura</th><th>Karşı taraf</th><th>Vade</th>
                    <th className="text-right">Tutar</th><th className="text-right">Dağıtılan</th>
                    <th className="text-right">Açık</th><th>Yaşlandırma</th><th>Dağıt</th>
                  </tr>
                </thead>
                <tbody>
                  {receivables.map((r) => (
                    <tr key={r.invoiceId} className="border-t border-line-faint">
                      <td className="py-2 font-mono text-xs">{r.invoiceNo}</td>
                      <td>{r.partyName}</td>
                      <td className="font-mono text-xs">{r.dueDate ?? "—"}</td>
                      <td className="text-right font-mono tabular-nums">{formatMoney(r.grossAmount, r.currency)}</td>
                      <td className="text-right font-mono tabular-nums text-tone-3">{formatMoney(r.allocatedAmount, r.currency)}</td>
                      <td className="text-right font-mono tabular-nums">{formatMoney(r.openAmount, r.currency)}</td>
                      <td><Badge tone={BUCKET_TONE[r.ageingBucket] ?? "neutral"}>{r.ageingBucket}</Badge></td>
                      <td>
                        <form action={allocateAction} className="flex flex-wrap items-center gap-1">
                          <input type="hidden" name="invoiceId" value={r.invoiceId} />
                          <select
                            name="settlementSource"
                            defaultValue="manual"
                            className="max-w-44 rounded border border-line-faint bg-transparent px-1 py-0.5 text-xs"
                          >
                            <option value="manual">Manuel tahsilat</option>
                            {unallocatedInflows.map((u) => (
                              <option key={`${u.sourceTable}:${u.sourceId}`} value={`${u.sourceTable}:${u.sourceId}`}>
                                {(u.description || u.sourceTable).slice(0, 24)} · {fmtTL(u.unallocatedAmount)}
                              </option>
                            ))}
                          </select>
                          <input
                            name="amount" type="number" step="0.01" min="0.01" max={r.openAmount}
                            placeholder="tutar"
                            className="w-20 rounded border border-line-faint bg-transparent px-1 py-0.5 text-xs"
                          />
                          <button className="text-xs text-pos hover:underline">dağıt</button>
                        </form>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Panel title={`DAĞITILMAMIŞ TAHSİLAT — ${unallocated.length}`}>
          <p className="mb-2 text-xs text-tone-3">
            Hesaba giren ama hiçbir faturaya bağlanmamış para. Dağıtım toplamı fatura tutarını
            aşamadığı için (0048) fazla tahsilat burada görünür — kaybolmaz.
          </p>
          {unallocated.length === 0 ? (
            <p className="py-2 text-sm text-tone-3">Dağıtılmamış tahsilat yok.</p>
          ) : (
            unallocated.map((u) => (
              <div key={u.sourceId} className="grid grid-cols-[1fr_auto_auto] gap-2 border-b border-line-faint py-1 text-sm">
                <span className="truncate">{u.description || u.sourceTable}</span>
                <span className="font-mono text-xs text-tone-3">{u.sourceDate}</span>
                <span className="font-mono tabular-nums text-warn">{fmtTL(u.unallocatedAmount)}</span>
              </div>
            ))
          )}
        </Panel>

        <Panel title="ORTALAMA TAHSİLAT/ÖDEME SÜRESİ">
          <p className="mb-2 text-xs text-tone-3">
            Gerçekleşmiş süre — yalnız tahsil edilmiş faturalar sayılır. Ödenmemiş bir faturanın
            süresi yoktur; sıfır saymak karşı tarafı olmadığı kadar iyi gösterirdi.
          </p>
          {speed.length === 0 ? (
            <p className="py-2 text-sm text-tone-3">Henüz tahsil edilmiş fatura yok.</p>
          ) : (
            speed.map((s) => (
              <div key={`${s.partyId}-${s.direction}`} className="grid grid-cols-[1fr_auto_auto] gap-2 border-b border-line-faint py-1 text-sm">
                <span>{s.partyName}</span>
                <span className="text-xs text-tone-3">{s.direction === "sales" ? "tahsilat" : "ödeme"}</span>
                <span className="font-mono tabular-nums">{s.avgDaysToSettle ?? "—"} gün</span>
              </div>
            ))
          )}
        </Panel>
      </div>

      <div className="mt-4">
        <Panel title={`SON TAHSİSLER VE GERİ ALMA — ${recentAllocations.length}`}>
          <p className="mb-2 text-xs text-tone-3">
            Tahsis silinmez; gerekçesiyle geri alınır (`reversed_at`) ve fatura bakiyesi veritabanı tetikleyicisiyle yeniden hesaplanır.
          </p>
          {recentAllocations.length === 0 ? (
            <p className="py-2 text-sm text-tone-3">Aktif tahsis kaydı yok.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-tone-3">
                    <th>Fatura</th><th>Karşı taraf</th><th>Kaynak</th><th>Tarih</th>
                    <th className="text-right">Tutar</th><th>Geri al</th>
                  </tr>
                </thead>
                <tbody>
                  {recentAllocations.map((ia) => (
                    <tr key={ia.id} className="border-t border-line-faint">
                      <td className="py-1.5 font-mono text-xs">{ia.invoiceNo}</td>
                      <td>{ia.partyName}</td>
                      <td className="font-mono text-xs text-tone-3">{ia.sourceTable}</td>
                      <td className="font-mono text-xs">{ia.allocatedOn}</td>
                      <td className="text-right font-mono tabular-nums">{formatMoney(ia.allocatedAmount, ia.currency)}</td>
                      <td>
                        <form action={reverseAllocationAction} className="flex items-center gap-1">
                          <input type="hidden" name="allocationId" value={ia.id} />
                          <input
                            name="reason"
                            required
                            minLength={3}
                            placeholder="gerekçe"
                            className="w-28 rounded border border-line-faint bg-transparent px-1 py-0.5 text-xs"
                          />
                          <button className="text-xs text-neg hover:underline">Geri al</button>
                        </form>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>

      <div id="fifo-oneri" className="mt-4">
        <Panel
          title="OTOMATİK FIFO DAĞITIM ÖNERİSİ"
          subtitle="En eski vadeli açık faturalardan başlayarak deterministik FIFO tahsis önerisi üretir; onaysız yazma yapmaz"
        >
          <form method="get" action="/finance/receivables" className="grid grid-cols-1 gap-2 text-xs sm:grid-cols-5">
            <label className="flex flex-col gap-1" style={{ color: "var(--text-2)" }}>
              <span>Karşı Taraf</span>
              <select
                name="fifoParty"
                defaultValue={fifoParty}
                required
                className="rounded border px-2 py-1.5"
                style={{
                  background: "var(--surface-1)",
                  borderColor: "var(--line)",
                  color: "var(--text-1)",
                }}
              >
                <option value="">Cari seçin…</option>
                {partiesListRes.rows.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1" style={{ color: "var(--text-2)" }}>
              <span>Yön</span>
              <select
                name="fifoDirection"
                defaultValue={fifoDirection}
                className="rounded border px-2 py-1.5"
                style={{
                  background: "var(--surface-1)",
                  borderColor: "var(--line)",
                  color: "var(--text-1)",
                }}
              >
                <option value="sales">Satış Tahsilatı (Alacak)</option>
                <option value="purchase">Tedarikçi Ödemesi (Borç)</option>
              </select>
            </label>
            <label className="flex flex-col gap-1" style={{ color: "var(--text-2)" }}>
              <span>Para Birimi</span>
              <select
                name="fifoCurrency"
                defaultValue={fifoCurrency}
                className="rounded border px-2 py-1.5"
                style={{
                  background: "var(--surface-1)",
                  borderColor: "var(--line)",
                  color: "var(--text-1)",
                }}
              >
                {["TRY", "USD", "EUR", "GBP"].map((cur) => (
                  <option key={cur} value={cur}>
                    {cur}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1" style={{ color: "var(--text-2)" }}>
              <span>Dağıtılacak Tutar</span>
              <input
                name="fifoAmount"
                type="number"
                step="0.01"
                min="0.01"
                defaultValue={fifoAmountNum > 0 ? String(fifoAmountNum) : ""}
                required
                placeholder="Örn. 50000"
                className="rounded border px-2 py-1.5 font-mono"
                style={{
                  background: "var(--surface-1)",
                  borderColor: "var(--line)",
                  color: "var(--text-1)",
                }}
              />
            </label>
            <div className="flex items-end">
              <button
                type="submit"
                className="w-full rounded border px-3 py-1.5 font-medium"
                style={{
                  background: "var(--surface-2)",
                  borderColor: "var(--line)",
                  color: "var(--text-1)",
                }}
              >
                FIFO Dağıtım Önerisi Hesapla
              </button>
            </div>
          </form>

          {fifoPreview ? (
            <div
              className="mt-3 rounded border p-3 text-xs"
              style={{
                background: "var(--surface-2)",
                borderColor: "var(--line)",
                color: "var(--text-1)",
              }}
            >
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={fifoPreview.lines.length > 0 ? "green" : "amber"}>
                    {fifoPreview.lines.length} fatura önerildi
                  </Badge>
                  <span>
                    Uygulanabilir ({fifoCurrency}):{" "}
                    <b className="font-mono">{formatMoney(fifoPreview.matchingAllocated, fifoCurrency)}</b>
                  </span>
                  {fifoPreview.unallocated > 0 ? (
                    <span className="text-warn">
                      Açıkta kalan tutar: <b className="font-mono">{formatMoney(fifoPreview.unallocated, fifoCurrency)}</b>
                    </span>
                  ) : null}
                </div>
              </div>

              {fifoPreview.lines.length === 0 ? (
                <p style={{ color: "var(--text-2)" }}>Seçili cari ve yön için açık/kısmi fatura bulunamadı.</p>
              ) : (
                <>
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="text-left" style={{ color: "var(--text-2)" }}>
                          <th className="py-1">Fatura No</th>
                          <th>Düzenleme</th>
                          <th>Vade</th>
                          <th>Döviz</th>
                          <th className="text-right">Mevcut Açık</th>
                          <th className="text-right">FIFO Önerilen Tahsis</th>
                          <th>Durum</th>
                        </tr>
                      </thead>
                      <tbody>
                        {fifoPreview.lines.map((line) => (
                          <tr
                            key={line.invoiceId}
                            className="border-t"
                            style={{ borderColor: "var(--line)" }}
                          >
                            <td className="py-1.5 font-mono">{line.invoiceNo}</td>
                            <td className="font-mono">{line.issueDate ?? "—"}</td>
                            <td className="font-mono">{line.dueDate ?? "—"}</td>
                            <td className="font-mono">{line.currency}</td>
                            <td className="text-right font-mono tabular-nums">
                              {formatMoney(line.openAmount, line.currency)}
                            </td>
                            <td className="text-right font-mono font-semibold tabular-nums">
                              {formatMoney(line.proposedAmount, line.currency)}
                            </td>
                            <td>
                              {line.currencyMatches ? (
                                <Badge tone="green">Uygulanabilir</Badge>
                              ) : (
                                <Badge tone="amber">Farklı döviz — atlanır</Badge>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  {canAllocate && fifoPreview.matchingAllocated > 0 ? (
                    <form
                      action={applyFifoAllocationAction}
                      className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t pt-2"
                      style={{ borderColor: "var(--line)" }}
                    >
                      <input type="hidden" name="partyId" value={fifoParty} />
                      <input type="hidden" name="direction" value={fifoDirection} />
                      <input type="hidden" name="currency" value={fifoCurrency} />
                      <input type="hidden" name="amount" value={String(fifoAmountNum)} />
                      <div className="flex flex-wrap items-center gap-2">
                        <select
                          name="settlementSource"
                          defaultValue="manual"
                          className="rounded border px-2 py-1 text-xs"
                          style={{
                            background: "var(--surface-1)",
                            borderColor: "var(--line)",
                            color: "var(--text-1)",
                          }}
                        >
                          <option value="manual">Manuel tahsilat/ödeme</option>
                          {fifoSettlementPool.map((u) => (
                            <option key={`${u.sourceTable}:${u.sourceId}`} value={`${u.sourceTable}:${u.sourceId}`}>
                              {(u.description || u.sourceTable).slice(0, 28)} · {fmtTL(u.unallocatedAmount)}
                            </option>
                          ))}
                        </select>
                        <input
                          name="notes"
                          placeholder="Tahsis notu (opsiyonel)"
                          className="rounded border px-2 py-1 text-xs"
                          style={{
                            background: "var(--surface-1)",
                            borderColor: "var(--line)",
                            color: "var(--text-1)",
                          }}
                        />
                      </div>
                      <button
                        type="submit"
                        className="button-accent px-3 py-1.5 text-xs font-medium"
                      >
                        FIFO Dağıtım Önerisini Tek Tıkla Uygula ({formatMoney(fifoPreview.matchingAllocated, fifoCurrency)})
                      </button>
                    </form>
                  ) : null}
                </>
              )}
            </div>
          ) : null}
        </Panel>
      </div>

      <div className="mt-4">
        <Panel title={`CARİ HESAP KARTLARI — ${accounts.length}`}>
          <p className="mb-2 text-xs text-tone-3">
            Alacak ve borç <b>netleştirilmez</b>: mahsup iki taraf arasında hukuki bir işlemdir,
            aritmetik bir işlem değil — burada netlemek var olmayan bir anlaşmayı varsaymak olurdu.
          </p>
          {accounts.length === 0 ? (
            <p className="py-2 text-sm text-tone-3">Hareketli cari hesap yok.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-tone-3">
                    <th>Karşı taraf</th><th>Tip</th>
                    <th className="text-right">Açık alacak</th><th className="text-right">Açık borç</th>
                    <th className="text-right">Vadesi geçen</th><th>En yakın vade</th><th className="text-right">Ekstre</th>
                  </tr>
                </thead>
                <tbody>
                  {accounts.map((a) => (
                    <tr key={a.partyId} className="border-t border-line-faint">
                      <td className="py-2">{a.partyName}</td>
                      <td className="text-xs text-tone-3">{PARTY_TYPE_TR[a.partyType] ?? a.partyType}</td>
                      <td className="text-right font-mono tabular-nums text-pos">{fmtTL(a.receivableOpen)}</td>
                      <td className="text-right font-mono tabular-nums text-neg">{fmtTL(a.payableOpen)}</td>
                      <td className={`text-right tabular-nums ${a.overdueCount > 0 ? "text-warn" : "text-tone-3"}`}>
                        {a.overdueCount || "—"}
                      </td>
                      <td className="font-mono text-xs">{a.earliestDueDate ?? "—"}</td>
                      <td className="text-right text-xs">
                        <Link
                          href={`/finance/counterparties?ledgerParty=${a.partyId}#cari-ekstre`}
                          className="hover:underline"
                          style={{ color: "var(--text-2)" }}
                        >
                          Ekstre →
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>

      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Panel
          title={`CARİ BAZLI FATURA POZİSYON ÖZETİ — ${partySummaries.length}`}
          subtitle="Satış/alış fatura adedi, açık ve tahsil edilmiş/ödenmiş TRY bakiyeleri ve dövizli fatura uyarısı"
        >
          {partySummaries.length === 0 ? (
            <p className="py-2 text-sm text-tone-3">Kayıtlı fatura pozisyonu yok.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left" style={{ color: "var(--text-2)" }}>
                    <th className="py-1">Karşı Taraf</th>
                    <th className="text-right">Satış / Alış</th>
                    <th className="text-right">Açık Alacak</th>
                    <th className="text-right">Açık Borç</th>
                    <th>İlk Vade</th>
                    <th className="text-right">İşlem</th>
                  </tr>
                </thead>
                <tbody>
                  {partySummaries.map((ps) => (
                    <tr
                      key={ps.partyId}
                      className="border-t"
                      style={{ borderColor: "var(--line)" }}
                    >
                      <td className="py-1.5">
                        <span className="font-medium" style={{ color: "var(--text-1)" }}>
                          {ps.partyName}
                        </span>
                        {ps.foreignCurrencyCount > 0 ? (
                          <span className="ml-1.5 font-mono text-[10px] text-warn">
                            +{ps.foreignCurrencyCount} dövizli
                          </span>
                        ) : null}
                      </td>
                      <td className="text-right font-mono tabular-nums" style={{ color: "var(--text-2)" }}>
                        {ps.salesCount} / {ps.purchaseCount}
                      </td>
                      <td className="text-right font-mono tabular-nums text-pos">
                        {fmtTL(ps.receivableOpen)}
                      </td>
                      <td className="text-right font-mono tabular-nums text-neg">
                        {fmtTL(ps.payableOpen)}
                      </td>
                      <td className="font-mono">{ps.earliestDueDate ?? "—"}</td>
                      <td className="text-right">
                        {ps.receivableOpen > 0 ? (
                          <Link
                            href={`/finance/receivables?fifoParty=${ps.partyId}&fifoDirection=sales&fifoCurrency=TRY&fifoAmount=${ps.receivableOpen}#fifo-oneri`}
                            className="font-mono hover:underline"
                            style={{ color: "var(--text-2)" }}
                          >
                            FIFO Öner
                          </Link>
                        ) : (
                          <Link
                            href={`/finance/counterparties?ledgerParty=${ps.partyId}#cari-ekstre`}
                            className="font-mono hover:underline"
                            style={{ color: "var(--text-2)" }}
                          >
                            Ekstre
                          </Link>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        <Panel
          title={`SATIŞ TAHSİLAT DAĞITIM İZİ — ${collectionAllocations.length}`}
          subtitle="Satış faturalarına bağlanan aktif ve geri alınmış (ters kayıtlı) tahsilat tahsislerinin denetim izi"
        >
          {collectionAllocations.length === 0 ? (
            <p className="py-2 text-sm text-tone-3">Henüz satış tahsilat tahsisi yok.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left" style={{ color: "var(--text-2)" }}>
                    <th className="py-1">Fatura</th>
                    <th>Müşteri</th>
                    <th>Kaynak</th>
                    <th>Tarih</th>
                    <th className="text-right">Tutar</th>
                    <th>Durum</th>
                  </tr>
                </thead>
                <tbody>
                  {collectionAllocations.map((ca) => (
                    <tr
                      key={ca.id}
                      className="border-t"
                      style={{ borderColor: "var(--line)" }}
                    >
                      <td className="py-1.5 font-mono">{ca.invoiceNo}</td>
                      <td>{ca.partyName}</td>
                      <td className="font-mono" style={{ color: "var(--text-2)" }}>
                        {ca.sourceTable}
                      </td>
                      <td className="font-mono">{ca.allocatedOn}</td>
                      <td className="text-right font-mono tabular-nums">
                        {formatMoney(ca.allocatedAmount, ca.currency)}
                      </td>
                      <td>
                        {ca.isReversed ? (
                          <span title={ca.reversedReason ?? undefined}>
                            <Badge tone="neutral">geri alındı</Badge>
                          </span>
                        ) : (
                          <Badge tone="green">aktif</Badge>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>
    </>
  );
}
