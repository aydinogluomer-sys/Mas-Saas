// Faz 21 & Faz 47 (D1) + Faz 61 (M-32) — Fatura Merkezi (Çoklu satır + İskonto/Stopaj + Banka/Kasa atomik tahsilat + 646/656 kur farkı).

import { Suspense } from "react";
import Link from "@/components/ui/app-link";
import { getCurrentUser } from "@/lib/auth";
import { getPool, withReadConnection } from "@/lib/db";
import { documentsForEntity } from "@/lib/documents/engine";
import {
  countInvoices, listInvoices, loadDuplicateSuspects, loadInvoiceParties,
  loadLineMismatches, loadOpenItems,
} from "@/lib/invoices/engine";
import { loadCanonicalPayablesKpi, loadCanonicalReceivablesKpi } from "@/lib/metrics/canonical-kpis";
import { moneyOrNull } from "@/lib/money";
import { formatForeignCurrencyBadges, formatMoney } from "@/lib/money-format";
import { MultiLineInvoiceForm } from "@/components/finance/multi-line-invoice-form";
import { Badge, type Tone } from "@/components/ui/badge";
import { PaginationBar, parsePageParam } from "@/components/ui/pagination-bar";
import { Panel } from "@/components/ui/panel";
import { PanelSkeleton } from "@/components/ui/panel-skeleton";
import { SavedViewsBar } from "@/components/ui/saved-views-bar";
import { PageHeader } from "@/components/ui/shell";
import { parseFilters } from "@/lib/ui/filters";
import { listSavedViews } from "@/lib/ui/saved-views";
import {
  cancelInvoiceAction, changeStatusAction, recordPaymentAction,
} from "./actions";
import { requireRouteAccess } from "@/lib/authz/route-guard";

export const dynamic = "force-dynamic";

const STATUS_TONE: Record<string, Tone> = {
  draft: "neutral", open: "blue", partial: "amber", paid: "green",
  settled: "green", closed: "neutral", cancelled: "red",
};
const STATUS_LABEL_TR: Record<string, string> = {
  draft: "taslak",
  open: "açık",
  partial: "kısmi",
  paid: "ödendi",
  settled: "kapandı",
  closed: "kapalı",
  cancelled: "iptal",
};
const DUPLICATE_SIGNAL_TR: Record<string, string> = {
  same_number: "aynı fatura no",
  same_amount_near_date: "aynı tutar · yakın tarih",
};
const AGE_TONE: Record<string, Tone> = {
  "tarihsiz": "neutral", "vadesi gelmemiş": "green", "1-30 gün": "amber",
  "31-60 gün": "amber", "61-90 gün": "red", "90+ gün": "red",
};

export default async function InvoicesPage({
  searchParams,
}: { searchParams: Promise<Record<string, string | undefined>> }) {
  const denied = await requireRouteAccess("/finance/invoices");
  if (denied) return denied;
  const sp = await searchParams;
  const currentFilters = parseFilters(sp);
  const { page } = parsePageParam(sp.page, 50);
  const pool = getPool();
  const user = await getCurrentUser();
  const [rawOpenItems, canonicalRec, canonicalPay, savedViews, overpaidRes, cashAccountsRes] = await Promise.all([
    loadOpenItems(pool, 50),
    loadCanonicalReceivablesKpi(pool),
    loadCanonicalPayablesKpi(pool),
    listSavedViews(pool, "invoices", user?.id ?? null).catch(() => []),
    pool.query<{
      id: string;
      invoice_no: string;
      party_id: string;
      party_name: string;
      gross_amount: string;
      paid_amount: string;
      overpaid_by: string;
      status: string;
      currency: string;
    }>(
      `select io.id::text,
              io.invoice_no,
              io.party_id::text,
              io.party_name,
              io.gross_amount::text,
              io.paid_amount::text,
              io.overpaid_by::text,
              io.status,
              coalesce(inv.currency, 'TRY') as currency
         from public.invoice_overpaid io
         left join public.invoices inv on inv.id = io.id
        order by io.overpaid_by desc
        limit 25`,
    ),
    pool.query<{ id: string; name: string; currency: string; account_type: string }>(
      `select id::text, name, currency, account_type
         from public.cash_accounts
        where is_active = true
        order by name`,
    ),
  ]);
  const cashAccounts = cashAccountsRes.rows;
  const overpaidInvoices = overpaidRes.rows.map((r) => ({
    id: r.id,
    invoiceNo: r.invoice_no,
    partyId: r.party_id,
    partyName: r.party_name,
    grossAmount: moneyOrNull(r.gross_amount) ?? 0,
    paidAmount: moneyOrNull(r.paid_amount) ?? 0,
    overpaidBy: moneyOrNull(r.overpaid_by) ?? 0,
    status: r.status,
    currency: r.currency || "TRY",
  }));
  const qLower = currentFilters.q.trim().toLowerCase();
  const openItems = rawOpenItems.filter((item) => {
    if (currentFilters.currency && item.currency !== currentFilters.currency) return false;
    if (
      qLower &&
      !item.invoiceNo.toLowerCase().includes(qLower) &&
      !item.partyName.toLowerCase().includes(qLower)
    ) {
      return false;
    }
    return true;
  });
  const todayISO = new Date().toISOString().slice(0, 10);

  const totalOverdue = canonicalRec.overdueCount + canonicalPay.overdueCount;
  const totalOpenCount = canonicalRec.totalCount + canonicalPay.totalCount;
  const recForeignText = formatForeignCurrencyBadges(canonicalRec.foreignBuckets);
  const payForeignText = formatForeignCurrencyBadges(canonicalPay.foreignBuckets);

  return (
    <>
      <PageHeader
        title="Fatura Merkezi"
        subtitle="Çok kalemli faturalama (iskonto/stopaj), banka/kasa atomik tahsilat (100/102 ↔ 120/320 + 646/656 kur farkı) ve iptal/ters kayıt"
        meta={
          <Badge tone={totalOverdue > 0 ? "red" : "green"} dot>
            {totalOverdue > 0 ? `${totalOverdue} vadesi geçmiş` : `${totalOpenCount} açık kalem`}
          </Badge>
        }
      />

      <SavedViewsBar
        moduleKey="invoices"
        basePath="/finance/invoices"
        views={savedViews}
        currentFilters={currentFilters}
        todayISO={todayISO}
        totalRows={openItems.length}
      />

      {sp.error && <div className="mb-3 rounded border border-neg/40 bg-neg/10 p-2 text-sm text-neg">{sp.error}</div>}
      {sp.result && <div className="mb-3 rounded border border-pos/40 bg-pos/10 p-2 text-sm text-pos">{sp.result}</div>}

      {overpaidInvoices.length > 0 ? (
        <div
          role="alert"
          className="mb-4 rounded border p-3 text-xs"
          style={{
            background: "var(--surface-2)",
            borderColor: "var(--line)",
            color: "var(--text-1)",
          }}
        >
          <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2 font-semibold">
              <Badge tone="red" dot>İç Kontrol Uyarısı</Badge>
              <span>Fazla Ödenmiş Faturalar Tespit Edildi ({overpaidInvoices.length} kayıt)</span>
            </div>
            <Link
              href="/finance/receivables"
              className="font-mono hover:underline"
              style={{ color: "var(--text-2)" }}
            >
              Tahsisleri İncele →
            </Link>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left" style={{ color: "var(--text-2)" }}>
                  <th className="py-1">Fatura No</th>
                  <th>Karşı Taraf</th>
                  <th className="text-right">Brüt Tutar</th>
                  <th className="text-right">Ödenen</th>
                  <th className="text-right">Fazla Ödeme</th>
                  <th>Durum</th>
                </tr>
              </thead>
              <tbody>
                {overpaidInvoices.map((op) => (
                  <tr key={op.id} className="border-t" style={{ borderColor: "var(--line)" }}>
                    <td className="py-1 font-mono">{op.invoiceNo}</td>
                    <td>{op.partyName}</td>
                    <td className="text-right font-mono tabular-nums">
                      {formatMoney(op.grossAmount, op.currency)}
                    </td>
                    <td className="text-right font-mono tabular-nums">
                      {formatMoney(op.paidAmount, op.currency)}
                    </td>
                    <td className="text-right font-mono font-semibold tabular-nums text-neg">
                      +{formatMoney(op.overpaidBy, op.currency)}
                    </td>
                    <td>
                      <Badge tone={STATUS_TONE[op.status] ?? "neutral"}>
                        {STATUS_LABEL_TR[op.status] ?? op.status}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      <div className="mb-4 grid grid-cols-2 gap-2 lg:grid-cols-4">
        <Panel title="AÇIK ALACAK (TRY)" subtitle={recForeignText ?? undefined}>
          <b className="font-mono text-lg text-pos">{formatMoney(canonicalRec.tryTotal, "TRY")}</b>
        </Panel>
        <Panel title="AÇIK BORÇ (TRY)" subtitle={payForeignText ?? undefined}>
          <b className="font-mono text-lg text-neg">{formatMoney(canonicalPay.tryTotal, "TRY")}</b>
        </Panel>
        <Panel title="VADESİ GEÇMİŞ"><b className="font-mono text-lg">{totalOverdue}</b></Panel>
        <Panel title="AÇIK KALEM"><b className="font-mono text-lg">{totalOpenCount}</b></Panel>
      </div>

      <Panel title={`AÇIK KALEMLER — ${openItems.length}${totalOpenCount > openItems.length ? ` / ${totalOpenCount}` : ""}`}>
        {openItems.length === 0 ? (
          <p className="py-2 text-sm text-tone-3">Açık fatura yok.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-tone-3">
                  <th>No</th><th>Karşı taraf</th><th>Yön</th><th>Vade</th>
                  <th className="text-right">Tutar</th><th className="text-right">Ödenen</th>
                  <th className="text-right">Kalan</th><th>Yaşlandırma</th><th>Durum</th><th>Hızlı Kapama (100/102)</th>
                </tr>
              </thead>
              <tbody>
                {openItems.map((i) => {
                  const matchingAccounts = cashAccounts.filter((ca) => ca.currency === i.currency);
                  return (
                    <tr key={i.id} className="border-t border-line-faint">
                      <td className="py-2 font-mono text-xs">{i.invoiceNo}</td>
                      <td>{i.partyName}</td>
                      <td className="text-xs text-tone-3">{i.direction === "sales" ? "satış" : "alış"}</td>
                      <td className="font-mono text-xs">{i.dueDate ?? "—"}</td>
                      <td className="text-right font-mono tabular-nums">{formatMoney(i.grossAmount, i.currency)}</td>
                      <td className="text-right font-mono tabular-nums">{formatMoney(i.paidAmount, i.currency)}</td>
                      <td className={`text-right font-mono tabular-nums ${i.remaining < 0 ? "text-warn" : ""}`}>
                        {formatMoney(i.remaining, i.currency)}
                      </td>
                      <td><Badge tone={AGE_TONE[i.ageingBucket] ?? "neutral"}>{i.ageingBucket}</Badge></td>
                      <td><Badge tone={STATUS_TONE[i.status] ?? "neutral"}>{STATUS_LABEL_TR[i.status] ?? i.status}</Badge></td>
                      <td>
                        <form action={recordPaymentAction} className="flex flex-wrap items-center gap-1">
                          <input type="hidden" name="invoiceId" value={i.id} />
                          <select
                            name="cashAccountId"
                            defaultValue=""
                            className="max-w-[130px] rounded border border-line bg-surface px-1 py-0.5 text-[11px] text-tone-1"
                          >
                            <option value="">Cari mahsup (hesapsız)</option>
                            {matchingAccounts.map((ca) => (
                              <option key={ca.id} value={ca.id}>
                                {ca.name} ({ca.currency})
                              </option>
                            ))}
                          </select>
                          <input
                            name="amount" type="number" step="0.01" min="0.01" placeholder="tutar"
                            required
                            className="w-20 rounded border border-line bg-surface px-1 py-0.5 font-mono text-xs text-tone-1"
                          />
                          <button className="rounded border border-line px-1.5 py-0.5 text-xs font-medium text-pos hover:bg-elev">
                            {i.direction === "sales" ? "tahsil" : "ödeme"}
                          </button>
                        </form>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Suspense
        fallback={
          <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
            <PanelSkeleton title="MÜKERRER FATURA ŞÜPHESİ" rows={3} />
            <PanelSkeleton title="BAŞLIK / KALEM UYUŞMAZLIĞI" rows={3} />
          </div>
        }
      >
        <InvoicesQualityPanels />
      </Suspense>

      <Suspense
        fallback={
          <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
            <PanelSkeleton title="SON FATURALAR" rows={4} className="lg:col-span-2" />
            <PanelSkeleton title="YENİ FATURA (TASLAK)" rows={4} />
          </div>
        }
      >
        <InvoicesBottomSection page={page} />
      </Suspense>
    </>
  );
}

async function InvoicesQualityPanels() {
  const [duplicates, mismatches] = await withReadConnection(getPool(), (db) =>
    Promise.all([loadDuplicateSuspects(db, 20), loadLineMismatches(db, 20)]),
  );

  return (
    <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
      <Panel title={`MÜKERRER FATURA ŞÜPHESİ — ${duplicates.length}`}>
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
                <span className="font-mono tabular-nums">{formatMoney(d.grossAmount, d.currency)}</span>
              </div>
              <span className="text-[11px] text-tone-3">
                <Badge tone={d.signal === "same_number" ? "red" : "amber"}>{DUPLICATE_SIGNAL_TR[d.signal] ?? d.signal}</Badge>
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
              <span className="font-mono tabular-nums text-neg">{formatMoney(m.difference, m.currency)}</span>
            </div>
          ))
        )}
      </Panel>
    </div>
  );
}

async function InvoicesBottomSection({ page }: { page: number }) {
  const { limit, offset } = parsePageParam(String(page), 50);
  const pool = getPool();
  const [invoices, totalInvoices, parties, projects, costCenters, departments, openPiRes] = await withReadConnection(pool, (db) =>
    Promise.all([
      listInvoices(db, { limit, offset }),
      countInvoices(db),
      loadInvoiceParties(db),
      db.query<{ id: string; code: string; name: string }>(`select id::text, code, name from public.projects where is_active order by code limit 200`),
      db.query<{ id: string; code: string; name: string }>(`select id::text, code, name from public.cost_centers where is_active order by code limit 200`),
      db.query<{ id: string; code: string; name: string }>(`select id::text, code, name from public.departments where is_active order by code limit 200`),
      db
        .query<{ id: string; label: string }>(
          `select pi.id::text,
                  (p.name || ' · ' || coalesce(to_char(pi.due_date, 'YYYY-MM-DD'), to_char(pi.instance_month, 'YYYY-MM')) || ' · ' || coalesce(pi.expected_amount::text, '0') || ' ' || p.currency) as label
             from public.payment_instances pi
             join public.payments p on p.id = pi.payment_id
            where pi.status in ('planned', 'unpaid', 'partial', 'late')
              and pi.linked_invoice_id is null
              and p.archived_at is null
            order by pi.due_date nulls last
            limit 80`,
        )
        .catch(() => ({ rows: [] as { id: string; label: string }[] })),
    ]),
  );

  const docTargetInvoices = invoices.slice(0, 25);
  const docEntries = await Promise.all(
    docTargetInvoices.map(async (inv) => [inv.id, await documentsForEntity(pool, "invoices", inv.id)] as const),
  );
  const docsByInvoiceId = new Map(docEntries);

  return (
    <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-3">
      <div className="lg:col-span-2">
        <Panel
          title={`SON FATURALAR — ${totalInvoices}`}
          right={
            <Link
              href="/data/documents"
              className="font-mono text-xs hover:underline"
              style={{ color: "var(--text-2)" }}
            >
              Belge Merkezi →
            </Link>
          }
        >
          {invoices.length === 0 ? (
            <p className="py-2 text-sm text-tone-3">Henüz fatura yok.</p>
          ) : (
            <>
              {invoices.map((i) => {
                const attachedDocs = docsByInvoiceId.get(i.id);
                return (
                <div key={i.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-line-faint py-2 text-sm">
                  <span className="flex flex-wrap items-baseline gap-2">
                    <span className="font-mono text-xs">{i.invoiceNo}</span>
                    <b>{i.partyName}</b>
                    <span className="text-xs text-tone-3">{i.issueDate} · {i.lineCount} kalem</span>
                    <Badge tone={STATUS_TONE[i.status] ?? "neutral"}>{STATUS_LABEL_TR[i.status] ?? i.status}</Badge>
                    {attachedDocs ? (
                      attachedDocs.length > 0 ? (
                        <Link href="/data/documents" title={attachedDocs.map((d) => d.title).join(", ")}>
                          <Badge tone="green">{attachedDocs.length} kanıt belgesi</Badge>
                        </Link>
                      ) : (
                        <Link
                          href="/data/documents"
                          className="font-mono text-[11px] hover:underline"
                          style={{ color: "var(--text-2)" }}
                        >
                          + belge bağla
                        </Link>
                      )
                    ) : null}
                  </span>
                  <span className="flex items-center gap-2">
                    <span className="font-mono tabular-nums">{formatMoney(i.grossAmount, i.currency)}</span>
                    {i.status === "draft" && (
                      <form action={changeStatusAction} className="inline">
                        <input type="hidden" name="invoiceId" value={i.id} />
                        <input type="hidden" name="status" value="open" />
                        <button className="text-xs text-info hover:underline">düzenle (onayla)</button>
                      </form>
                    )}
                    {i.status !== "cancelled" && i.status !== "closed" && (
                      <form action={cancelInvoiceAction} className="inline-flex items-center gap-1">
                        <input type="hidden" name="invoiceId" value={i.id} />
                        <input
                          name="reason" required minLength={3} placeholder="iptal gerekçesi"
                          className="w-32 rounded border border-line bg-surface px-1 py-0.5 text-[11px] text-tone-1"
                        />
                        <button className="text-xs text-neg hover:underline">iptal</button>
                      </form>
                    )}
                  </span>
                </div>
                );
              })}
              <PaginationBar
                basePath="/finance/invoices"
                page={page}
                pageSize={limit}
                totalCount={totalInvoices}
              />
            </>
          )}
        </Panel>
      </div>

      <Panel title="YENİ FATURA (ÇOK KALEMLİ TASLAK)">
        <p className="mb-2 text-xs text-tone-3">
          Fatura her zaman <b>taslak</b> olarak açılır; N adet kalem, satır bazlı iskonto, KDV ve GV stopaj kesintisi desteklenir.
        </p>
        <MultiLineInvoiceForm
          parties={parties.map((p) => ({ id: p.id, label: p.name }))}
          projects={projects.rows.map((p) => ({ id: p.id, label: `${p.code} · ${p.name}` }))}
          costCenters={costCenters.rows.map((c) => ({ id: c.id, label: `${c.code} · ${c.name}` }))}
          departments={departments.rows.map((d) => ({ id: d.id, label: `${d.code} · ${d.name}` }))}
          openPaymentInstances={openPiRes.rows}
        />
      </Panel>
    </div>
  );
}
