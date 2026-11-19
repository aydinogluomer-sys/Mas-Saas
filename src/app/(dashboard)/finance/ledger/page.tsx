import Link from "@/components/ui/app-link";
import { StackedRibbonSvg, type StackedRibbonSegment } from "@/components/charts/folio-visuals";
import { MultiLineJournalForm } from "@/components/finance/multi-line-journal-form";
import { Badge } from "@/components/ui/badge";
import { Panel } from "@/components/ui/panel";
import { EmptyState, KeyStat, TableShell } from "@/components/ui/shell";
import { SubmitButton } from "@/components/ui/submit-button";
import { getRequestUser } from "@/lib/auth";
import { can } from "@/lib/authz/matrix";
import { requireRouteAccess } from "@/lib/authz/route-guard";
import { getPool } from "@/lib/db";
import { isMissingSchemaError, loadManagementAccounts } from "@/lib/ledger/accounts";
import {
  detectIntercompanyPairs,
  listIntercompanyEliminationRuns,
  normalizeTaxVkn,
} from "@/lib/ledger/intercompany-elimination";
import { loadDateFilteredLedgerReport } from "@/lib/ledger/reports";
import { decimal, formatMoney, money } from "@/lib/money";
import {
  approveDraftEntryAction,
  createManagementSubAccountAction,
  discardDraftEntryAction,
  postPeriodClosingAction,
  revalueProvisionalFxAction,
  reverseEntryAction,
  reverseIntercompanyEliminationAction,
  runIntercompanyEliminationAction,
  syncManagementLedgerAction,
} from "./actions";

export const dynamic = "force-dynamic";

function istanbulDateISO(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Istanbul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

export default async function ManagementLedgerPage({
  searchParams,
}: {
  searchParams?: Promise<{ result?: string; error?: string; from?: string; to?: string }>;
}) {
  const denied = await requireRouteAccess("/finance/ledger");
  if (denied) return denied;
  const session = await getRequestUser();
  const sp = (await searchParams) ?? {};
  const pool = getPool();
  const todayISO = istanbulDateISO();
  const yearStartISO = `${todayISO.slice(0, 4)}-01-01`;

  const canPost = session ? can(session.role, "management_journal_entries", "insert") : false;
  const canApprove = session ? can(session.role, "management_journal_entries", "update") : false;
  const canReverse = session ? can(session.role, "management_journal_entries", "delete") : false;
  const canAddAccount = session ? can(session.role, "management_accounts", "insert") : false;
  const canRunElimination = session
    ? can(session.role, "intercompany_elimination_runs", "insert")
    : false;
  const canReverseElimination = session
    ? can(session.role, "intercompany_elimination_runs", "update")
    : false;

  const currentPeriodYm = todayISO.slice(0, 7);
  const [curYearStr, curMonthStr] = currentPeriodYm.split("-");
  const curMonthLastDay = new Date(
    Date.UTC(Number(curYearStr), Number(curMonthStr), 0),
  ).getUTCDate();
  const previewStart = sp.from ?? `${currentPeriodYm}-01`;
  const previewEnd = sp.to ?? `${currentPeriodYm}-${String(curMonthLastDay).padStart(2, "0")}`;

  const [
    report,
    accounts,
    costCentersRes,
    recentEntriesRes,
    eliminationRuns,
    icEntitiesRes,
    icPartiesRes,
    icInvoicesRes,
  ] = await Promise.all([
    loadDateFilteredLedgerReport(pool, { from: sp.from ?? null, to: sp.to ?? null }),
    loadManagementAccounts(pool),
    pool
      .query<{ id: string; code: string | null; name: string }>(
        `select id::text as id, code, name
           from public.cost_centers
          where is_active = true
          order by name asc`,
      )
      .catch(() => ({ rows: [] })),
    pool
      .query<{
        id: string;
        entry_no: string;
        entry_date: string;
        source_type: string;
        status: string;
        needs_tax_split_review: boolean;
        description: string;
        reversal_of_entry_id: string | null;
        reversed_by_entry_id: string | null;
        debit_total_try: string | null;
        credit_total_try: string | null;
        line_count: number;
      }>(
        `select
           je.id::text,
           je.entry_no::text,
           to_char(je.entry_date, 'YYYY-MM-DD') as entry_date,
           je.source_type,
           je.status,
           je.needs_tax_split_review,
           je.description,
           je.reversal_of_entry_id::text,
           je.reversed_by_entry_id::text,
           sum(jl.debit_try)::numeric(16,2)::text as debit_total_try,
           sum(jl.credit_try)::numeric(16,2)::text as credit_total_try,
           count(jl.id)::int as line_count
         from public.management_journal_entries je
         left join public.management_journal_lines jl on jl.entry_id = je.id
         where ($1::date is null or je.entry_date >= $1::date)
           and ($2::date is null or je.entry_date <= $2::date)
         group by je.id
         order by je.entry_date desc, je.entry_no desc
         limit 50`,
        [sp.from ?? null, sp.to ?? null],
      )
      .catch((err: unknown) => {
        if (isMissingSchemaError(err)) return { rows: [], rowCount: 0 };
        throw err;
      }),
    listIntercompanyEliminationRuns(pool, 20).catch((err: unknown) => {
      if (isMissingSchemaError(err)) return [];
      throw err;
    }),
    pool
      .query<{ id: string; code: string; name: string; tax_id_vkn: string | null }>(
        `select id::text, code, name, tax_id_vkn
           from public.legal_entities
          where is_active = true
          order by is_default desc, code asc`,
      )
      .catch((err: unknown) => {
        if (isMissingSchemaError(err)) return { rows: [], rowCount: 0 };
        throw err;
      }),
    pool
      .query<{ id: string; name: string; tax_number: string | null }>(
        `select p.id::text, p.name, cp.tax_number
           from public.parties p
           left join public.counterparty_profiles cp on cp.party_id = p.id
          where p.archived_at is null`,
      )
      .catch((err: unknown) => {
        if (isMissingSchemaError(err)) return { rows: [], rowCount: 0 };
        throw err;
      }),
    pool
      .query<{
        id: string;
        invoice_no: string;
        direction: "sales" | "purchase";
        legal_entity_id: string | null;
        party_id: string | null;
        issue_date: string;
        currency: string;
        net_amount: string | null;
        gross_amount: string | null;
        payable_amount: string | null;
        paid_amount: string | null;
        allocated_amount: string | null;
        status: string;
        fx_rate_to_try: string | null;
      }>(
        `select i.id::text,
                coalesce(i.invoice_no, '') as invoice_no,
                i.direction,
                i.legal_entity_id::text,
                i.party_id::text,
                to_char(i.issue_date, 'YYYY-MM-DD') as issue_date,
                coalesce(i.currency, 'TRY') as currency,
                i.net_amount::text,
                i.gross_amount::text,
                i.payable_amount::text,
                i.paid_amount::text,
                (
                  select coalesce(sum(ia.allocated_amount), 0)::text
                    from public.invoice_allocations ia
                   where ia.invoice_id = i.id
                ) as allocated_amount,
                i.status,
                case
                  when coalesce(i.currency, 'TRY') = 'TRY' then '1'
                  else (
                    select fr.rate::text
                      from public.fx_rate_snapshots fr
                     where fr.base_currency = upper(btrim(i.currency))
                       and fr.quote_currency = 'TRY'
                       and fr.rate_date <= i.issue_date
                     order by fr.rate_date desc
                     limit 1
                  )
                end as fx_rate_to_try
           from public.invoices i
          where i.archived_at is null
            and i.status in ('open', 'partial', 'paid')
            and i.issue_date between $1::date and $2::date
          order by i.issue_date asc, i.id asc`,
        [previewStart, previewEnd],
      )
      .catch((err: unknown) => {
        if (isMissingSchemaError(err)) return { rows: [], rowCount: 0 };
        throw err;
      }),
  ]);

  const { incomeStatement: isSum } = report;
  const trialDiff = Number(decimal(report.totalDebitTry).minus(report.totalCreditTry).toFixed(2));
  const bsDiff = Number(
    decimal(report.totalAssetsTry).minus(report.totalLiabilitiesAndEquityTry).toFixed(2),
  );
  const hasOpeningSplit = Boolean(report.fromDate);

  // TDHP Mizan Dağılımı (Toplam Borç vs Alacak & 1xx / 3xx / 6xx / 7xx Hesap Sınıfları)
  const debitCreditSegments: StackedRibbonSegment[] = [
    {
      key: "total-debit",
      label: "Toplam Borç",
      value: report.totalDebitTry,
      formattedValue: `${formatMoney(report.totalDebitTry)} TRY`,
      tone: "info",
    },
    {
      key: "total-credit",
      label: "Toplam Alacak",
      value: report.totalCreditTry,
      formattedValue: `${formatMoney(report.totalCreditTry)} TRY`,
      tone: "pos",
    },
  ];

  let class1xx = decimal(0);
  let class3xx = decimal(0);
  let class6xx = decimal(0);
  let class7xx = decimal(0);
  for (const row of report.trialBalance) {
    const code = row.accountCode.trim();
    const classTurnover = decimal(row.debitTotalTry).plus(row.creditTotalTry);
    if (code.startsWith("1")) class1xx = class1xx.plus(classTurnover);
    else if (code.startsWith("3")) class3xx = class3xx.plus(classTurnover);
    else if (code.startsWith("6")) class6xx = class6xx.plus(classTurnover);
    else if (code.startsWith("7")) class7xx = class7xx.plus(classTurnover);
  }
  const class1xxTry = money(class1xx);
  const class3xxTry = money(class3xx);
  const class6xxTry = money(class6xx);
  const class7xxTry = money(class7xx);

  const accountClassSegments: StackedRibbonSegment[] = [
    {
      key: "tdhp-1xx",
      label: "1xx Dönen Varlıklar",
      value: class1xxTry,
      formattedValue: `${formatMoney(class1xxTry)} TRY`,
      tone: "info",
    },
    {
      key: "tdhp-3xx",
      label: "3xx Kısa Vadeli Yabancı Kaynaklar",
      value: class3xxTry,
      formattedValue: `${formatMoney(class3xxTry)} TRY`,
      tone: "warn",
    },
    {
      key: "tdhp-6xx",
      label: "6xx Gelir Tablosu",
      value: class6xxTry,
      formattedValue: `${formatMoney(class6xxTry)} TRY`,
      tone: "pos",
    },
    {
      key: "tdhp-7xx",
      label: "7xx Maliyet Hesapları",
      value: class7xxTry,
      formattedValue: `${formatMoney(class7xxTry)} TRY`,
      tone: "neg",
    },
  ];

  // Grup İçi (Intercompany) VKN Eşleşme Ön İzlemesi
  const vknEntityCount = icEntitiesRes.rows.filter((e) => normalizeTaxVkn(e.tax_id_vkn) !== null).length;
  const icPreview = detectIntercompanyPairs({
    legalEntities: icEntitiesRes.rows.map((r) => ({
      id: r.id,
      code: r.code,
      name: r.name,
      taxIdVkn: r.tax_id_vkn,
    })),
    parties: icPartiesRes.rows.map((r) => ({
      id: r.id,
      name: r.name,
      taxNumber: r.tax_number,
    })),
    invoices: icInvoicesRes.rows.map((r) => ({
      id: r.id,
      invoiceNo: r.invoice_no,
      direction: r.direction,
      legalEntityId: r.legal_entity_id,
      partyId: r.party_id,
      issueDate: r.issue_date,
      currency: r.currency,
      fxRateToTry: r.fx_rate_to_try,
      netAmount: r.net_amount,
      grossAmount: r.gross_amount,
      payableAmount: r.payable_amount,
      paidAmount: r.paid_amount,
      allocatedAmount: r.allocated_amount,
      status: r.status,
    })),
    periodStart: previewStart,
    periodEnd: previewEnd,
  });

  return (
    <div className="space-y-6">
      {sp.error ? (
        <div
          className="rounded border px-4 py-2.5 text-xs"
          style={{
            borderColor: "color-mix(in oklab, var(--neg) 35%, var(--line))",
            background: "var(--neg-soft)",
            color: "var(--neg)",
          }}
        >
          {sp.error}
        </div>
      ) : null}
      {sp.result ? (
        <div
          className="rounded border px-4 py-2.5 text-xs"
          style={{
            borderColor: "color-mix(in oklab, var(--pos) 35%, var(--line))",
            background: "var(--pos-soft)",
            color: "var(--pos)",
          }}
        >
          İşlem tamamlandı: {sp.result}
        </div>
      ) : null}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <KeyStat
          label="Yönetim EBITDA"
          value={`${formatMoney(isSum.managementEbitdaTry)} TRY`}
          sub={`EBIT ${formatMoney(isSum.ebitTry)} + Amortisman ${formatMoney(isSum.daAddbackTry)}`}
          tone={isSum.managementEbitdaTry >= 0 ? "pos" : "neg"}
        />
        <KeyStat
          label="Net Satışlar (600-610)"
          value={`${formatMoney(isSum.netSalesTry)} TRY`}
          sub={`Brüt Kâr: ${formatMoney(isSum.grossProfitTry)} TRY`}
          tone="info"
        />
        <KeyStat
          label="Dönem Net Kârı / (Zararı)"
          value={`${formatMoney(isSum.netIncomeTry)} TRY`}
          sub={`Finansman Gideri (780): ${formatMoney(isSum.financingExpenseTry)} TRY`}
          tone={isSum.netIncomeTry >= 0 ? "pos" : "warn"}
        />
        <KeyStat
          label="Mizan Borç = Alacak"
          value={`${formatMoney(report.totalDebitTry)} TRY`}
          sub={trialDiff === 0 ? "Kuruş farkı: 0,00 TRY (Dengeli)" : `Fark: ${formatMoney(trialDiff)} TRY`}
          tone={trialDiff === 0 ? "pos" : "neg"}
        />
        <KeyStat
          label="Bilanço Aktif = Pasif"
          value={`${formatMoney(report.totalAssetsTry)} TRY`}
          sub={bsDiff === 0 ? "Aktif = Yabancı Kaynak + Özkaynak (0,00)" : `Fark: ${formatMoney(bsDiff)} TRY`}
          tone={bsDiff === 0 ? "pos" : "neg"}
        />
      </div>

      {/* Görsel Mizan Dengesi & TDHP Hesap Sınıfı Dağılımı */}
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
        <Panel
          title="Toplam Borç vs Toplam Alacak Dengesi"
          subtitle="Çift taraflı yevmiye mizanında borç/alacak simetrisi (TRY)"
        >
          <StackedRibbonSvg
            title="Genel Mizan Borç / Alacak Payı"
            segments={debitCreditSegments}
            emptyLabel="Henüz yevmiye hareketi bulunmuyor"
          />
        </Panel>
        <Panel
          title="TDHP Hesap Sınıfı Dağılımı (1xx · 3xx · 6xx · 7xx)"
          subtitle="Dönen varlıklar, kısa vadeli yabancı kaynaklar, gelir tablosu ve maliyet hesapları hacmi"
        >
          <StackedRibbonSvg
            title="Hesap Sınıfları İşlem Hacmi Kompozisyonu"
            segments={accountClassSegments}
            emptyLabel="TDHP hesap sınıfı hareketi bekleniyor"
          />
        </Panel>
      </div>

      {/* Üst Eylem Çubuğu + Tarih Aralığı Filtresi + Dönem Sonu Yansıtma/Kapanış Sihirbazı */}
      <Panel
        title="ÇİFT TARAFLI YÖNETİM DEFTERİ KONTROL MERKEZİ & DÖNEM FİLTRESİ (TDHP)"
        subtitle="Tarih aralıklı açılış/dönem/kapanış mizanı, idempotent operasyonel senkronizasyon ve 7xx → 7x1 → 6xx → 690 → 590/591 dönem sonu yansıtma sihirbazı."
      >
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <form method="get" action="/finance/ledger" className="flex flex-wrap items-end gap-2 text-xs">
              <label className="font-medium text-tone-2">
                Başlangıç
                <input
                  type="date"
                  name="from"
                  defaultValue={report.fromDate ?? ""}
                  className="field-control ml-1.5 px-2 py-1"
                />
              </label>
              <label className="font-medium text-tone-2">
                Bitiş
                <input
                  type="date"
                  name="to"
                  defaultValue={report.toDate ?? ""}
                  className="field-control ml-1.5 px-2 py-1"
                />
              </label>
              <button type="submit" className="button-accent px-3 py-1 text-xs">
                Mizan & Gelir Tablosunu Filtrele
              </button>
              {report.fromDate || report.toDate ? (
                <Link href="/finance/ledger" className="button-ghost px-2.5 py-1 text-xs">
                  Tüm Dönemler
                </Link>
              ) : null}
            </form>

            <div className="flex flex-wrap items-center gap-2">
              {canPost ? (
                <form action={syncManagementLedgerAction}>
                  <SubmitButton
                    pendingLabel="Senkronlanıyor…"
                    className="button-accent px-3 py-1.5 text-xs font-medium disabled:opacity-60"
                  >
                    Operasyonel Kayıtlardan Defteri Senkronla
                  </SubmitButton>
                </form>
              ) : null}
              {canApprove ? (
                <form action={revalueProvisionalFxAction}>
                  <SubmitButton
                    pendingLabel="Değerleniyor…"
                    className="button-ghost px-3 py-1.5 text-xs font-medium disabled:opacity-60"
                  >
                    Geçici Kur Fişlerini Değerle (TCMB)
                  </SubmitButton>
                </form>
              ) : null}
            </div>
          </div>

          <div className="grid gap-3 pt-2 lg:grid-cols-2" style={{ borderTop: "1px solid var(--line)" }}>
            {canAddAccount ? (
              <form action={createManagementSubAccountAction} className="flex flex-wrap items-center gap-2 text-xs">
                <input
                  name="code"
                  required
                  placeholder="Alt Hesap Kodu (ör. 120.01)"
                  className="field-control px-2 py-1"
                />
                <input
                  name="name"
                  required
                  placeholder="Hesap Adı (ör. Yurtiçi Alıcılar - A Grubu)"
                  className="field-control flex-1 px-2 py-1"
                />
                <SubmitButton pendingLabel="Açılıyor…" className="button-ghost px-2.5 py-1 font-medium">
                  TDHP Alt Hesap Aç
                </SubmitButton>
              </form>
            ) : null}

            {canPost ? (
              <form action={postPeriodClosingAction} className="flex flex-wrap items-center gap-2 text-xs">
                <span className="font-mono text-[11px] font-semibold uppercase text-tone-2">
                  7xx→7x1→6xx→690 Kapanış:
                </span>
                <input
                  type="date"
                  name="fromDate"
                  required
                  defaultValue={report.fromDate ?? yearStartISO}
                  className="field-control px-2 py-1"
                />
                <input
                  type="date"
                  name="toDate"
                  required
                  defaultValue={report.toDate ?? todayISO}
                  className="field-control px-2 py-1"
                />
                <SubmitButton
                  pendingLabel="Kapatılıyor…"
                  className="button-ghost px-2.5 py-1 font-medium text-pos"
                >
                  Dönem Sonu Yansıtma & Kapanış Fişi Üret
                </SubmitButton>
              </form>
            ) : null}
          </div>
        </div>
      </Panel>

      {/* Grup İçi (Intercompany) Otomatik Eliminasyon Merkezi (120 ↔ 320 & 600 ↔ 7xx) */}
      <Panel
        title="Grup İçi (Intercompany) Otomatik Eliminasyon Merkezi (120 ↔ 320 & 600 ↔ 7xx)"
        subtitle="Solo tüzel kişilik defterlerine dokunmadan VKN bazlı grup içi alacak/borç (120 ↔ 320) ve gelir/maliyet (600 ↔ 770/730) konsolidasyon eliminasyonunu çalıştırır."
      >
        <div className="space-y-4">
          <div className="grid gap-3 rounded-[var(--radius-md)] border border-line bg-surface-2 p-3 sm:grid-cols-4">
            <div>
              <div className="font-mono text-[10.5px] uppercase tracking-[0.06em] text-tone-3">
                Aktif Grup Şirketi (VKN)
              </div>
              <div className="tnum mt-0.5 text-sm font-semibold text-tone-1">
                {icEntitiesRes.rows.length} şirket · {vknEntityCount} VKN tanımlı
              </div>
            </div>
            <div>
              <div className="font-mono text-[10.5px] uppercase tracking-[0.06em] text-tone-3">
                Algılanan Grup İçi Çift ({previewStart} – {previewEnd})
              </div>
              <div className="tnum mt-0.5 text-sm font-semibold text-info">
                {icPreview.matchedPairCount} eşleşme
                {icPreview.skippedUnknownCount > 0
                  ? ` (${icPreview.skippedUnknownCount} kur/tutar bekliyor)`
                  : ""}
              </div>
            </div>
            <div>
              <div className="font-mono text-[10.5px] uppercase tracking-[0.06em] text-tone-3">
                Ön İzleme 120 ↔ 320 Cari
              </div>
              <div className="tnum mt-0.5 font-mono text-sm font-semibold text-tone-1">
                {formatMoney(icPreview.eliminatedArApTry)} TRY
              </div>
            </div>
            <div>
              <div className="font-mono text-[10.5px] uppercase tracking-[0.06em] text-tone-3">
                Ön İzleme 600 ↔ 7xx Ciro/Gider
              </div>
              <div className="tnum mt-0.5 font-mono text-sm font-semibold text-tone-1">
                {formatMoney(icPreview.eliminatedRevExpTry)} TRY
              </div>
            </div>
          </div>

          {icPreview.pairs.length > 0 ? (
            <div className="rounded-[var(--radius-md)] border border-line-faint bg-surface-0 p-2.5 text-xs">
              <div className="mb-1.5 font-mono text-[10.5px] font-semibold uppercase tracking-[0.06em] text-tone-2">
                Tespit Edilen Grup İçi VKN Fatura Çiftleri (İlk 6)
              </div>
              <div className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
                {icPreview.pairs.slice(0, 6).map((pair) => (
                  <div
                    key={pair.pairKey}
                    className="rounded border border-line bg-surface-1 px-2.5 py-1.5"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold text-tone-1">
                        {pair.sellerEntityName} → {pair.buyerEntityName}
                      </span>
                      <Badge tone={pair.matchMode === "bilateral_mirror" ? "green" : "amber"}>
                        {pair.matchMode === "bilateral_mirror" ? "Çift Taraflı" : "Tek Taraflı VKN"}
                      </Badge>
                    </div>
                    <div className="tnum mt-0.5 font-mono text-[11px] text-tone-3">
                      #{pair.invoiceNo} · 120/320: {formatMoney(pair.eliminatedArApTry)} TRY · 600/
                      {pair.expenseAccountCode}: {formatMoney(pair.eliminatedRevExpTry)} TRY
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {canRunElimination ? (
            <form
              action={runIntercompanyEliminationAction}
              className="flex flex-wrap items-end gap-2.5 rounded-[var(--radius-md)] border border-line bg-surface-0 p-3 text-xs"
            >
              <label className="flex flex-col gap-1 font-medium text-tone-2">
                <span>Konsolidasyon Dönemi (YYYY-AA)</span>
                <input
                  type="month"
                  name="periodCode"
                  required
                  defaultValue={report.fromDate ? report.fromDate.slice(0, 7) : currentPeriodYm}
                  className="field-control px-2.5 py-1.5 text-base sm:text-xs"
                />
              </label>
              <label className="flex min-w-[220px] flex-1 flex-col gap-1 font-medium text-tone-2">
                <span>Eliminasyon Notu (İsteğe Bağlı)</span>
                <input
                  type="text"
                  name="notes"
                  maxLength={500}
                  placeholder="Ör. Aylık holding grup içi 120/320 ve 600/770 eliminasyonu"
                  className="field-control px-2.5 py-1.5 text-base sm:text-xs"
                />
              </label>
              <SubmitButton
                pendingLabel="Eliminasyon Çalıştırılıyor…"
                className="button-accent px-3.5 py-2 text-xs font-semibold disabled:opacity-60"
              >
                Grup İçi Eliminasyon Çalıştır
              </SubmitButton>
            </form>
          ) : null}

          {eliminationRuns.length === 0 ? (
            <EmptyState>
              Henüz kaydedilmiş grup içi konsolidasyon eliminasyon çalıştırması yok.
            </EmptyState>
          ) : (
            <TableShell>
              <table className="w-full text-xs">
                <thead>
                  <tr>
                    <th>Dönem</th>
                    <th>Durum</th>
                    <th className="text-right">Eşleşen Çift</th>
                    <th className="text-right">120 ↔ 320 Cari Eliminasyon (TRY)</th>
                    <th className="text-right">600 ↔ 7xx Gelir/Gider Eliminasyon (TRY)</th>
                    <th>Oluşturulma</th>
                    <th>Not / İşlem</th>
                  </tr>
                </thead>
                <tbody>
                  {eliminationRuns.map((run) => {
                    const periodCode = run.periodStart.slice(0, 7);
                    return (
                      <tr key={run.id}>
                        <td className="font-mono font-semibold">
                          {periodCode}
                          <div className="text-[10.5px] font-normal text-tone-3">
                            {run.periodStart} → {run.periodEnd}
                          </div>
                        </td>
                        <td>
                          <Badge
                            tone={
                              run.status === "posted"
                                ? "green"
                                : run.status === "reversed"
                                  ? "neutral"
                                  : "amber"
                            }
                          >
                            {run.status === "posted"
                              ? "Kesinleşti (Posted)"
                              : run.status === "reversed"
                                ? "Ters Kayıt (İptal)"
                                : "Taslak"}
                          </Badge>
                        </td>
                        <td className="tnum text-right font-mono">{run.matchedPairCount}</td>
                        <td className="tnum text-right font-mono font-medium text-info">
                          {formatMoney(run.eliminatedArApTry)}
                        </td>
                        <td className="tnum text-right font-mono font-medium text-pos">
                          {formatMoney(run.eliminatedRevExpTry)}
                        </td>
                        <td className="tnum font-mono text-[11px] text-tone-2">
                          {run.createdAt.slice(0, 16).replace("T", " ")}
                        </td>
                        <td>
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="text-[11.5px] text-tone-2">{run.notes ?? "—"}</span>
                            {run.status !== "reversed" && canReverseElimination ? (
                              <form
                                action={reverseIntercompanyEliminationAction}
                                className="flex items-center gap-1.5"
                              >
                                <input type="hidden" name="runId" value={run.id} />
                                <input
                                  type="text"
                                  name="reason"
                                  required
                                  defaultValue="Dönem revizyonu nedeniyle iptal"
                                  aria-label="Ters kayıt gerekçesi"
                                  className="field-control w-40 px-2 py-1 text-base sm:text-[11px]"
                                />
                                <SubmitButton
                                  pendingLabel="İptal Ediliyor…"
                                  className="button-ghost px-2.5 py-1 text-[11px] font-semibold text-neg disabled:opacity-60"
                                >
                                  Ters Kayıt (İptal)
                                </SubmitButton>
                              </form>
                            ) : null}
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </TableShell>
          )}
        </div>
      </Panel>

      {/* 102.99 Eşleşmemiş Banka Geçici Mutabakat Kalemleri Uyarısı */}
      {report.suspense10299Items.length > 0 || report.suspense10299NetTry !== 0 ? (
        <Panel
          title={`102.99 EŞLEŞMEMİŞ BANKA GEÇİCİ MUTABAKAT HESABI (NET: ${formatMoney(report.suspense10299NetTry)} TRY)`}
          subtitle="Karşı hesabı (120/320/7xx) henüz eşleştirilmemiş banka ekstre satırları mizan dengesini bozmamak için 102.99 geçici hesabında izlenir."
          right={
            <Link href="/finance/bank" className="button-ghost px-2.5 py-1 text-xs">
              Banka Mutabakatına Git →
            </Link>
          }
        >
          <TableShell>
            <table className="w-full text-xs">
              <thead>
                <tr>
                  <th>Fiş No</th>
                  <th>Tarih</th>
                  <th>Açıklama</th>
                  <th>Döviz</th>
                  <th className="text-right">102.99 Borç (TRY)</th>
                  <th className="text-right">102.99 Alacak (TRY)</th>
                </tr>
              </thead>
              <tbody>
                {report.suspense10299Items.slice(0, 15).map((item) => (
                  <tr key={`${item.entryId}:${item.bankTransactionId ?? "na"}`}>
                    <td className="font-mono">#{item.entryNo}</td>
                    <td className="font-mono">{item.entryDate}</td>
                    <td>{item.description}</td>
                    <td className="font-mono">{item.currency}</td>
                    <td className="text-right font-mono">{formatMoney(item.debitTry)}</td>
                    <td className="text-right font-mono">{formatMoney(item.creditTry)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableShell>
        </Panel>
      ) : null}

      {/* ① YÖNETİM MİZANI */}
      <Panel
        title="① YÖNETİM MİZANI (TDHP HESAP PLANI VE BAKİYELER)"
        subtitle={
          report.fromDate || report.toDate
            ? `Seçili Dönem: ${report.fromDate ?? "Başlangıç"} – ${report.toDate ?? "Bugün"} (Açılış devri + dönem içi hareket + kapanış bakiyesi)`
            : "Tüm kesinleşmiş (posted/reversed) yevmiye fişlerinden canlı üretilir."
        }
      >
        {report.trialBalance.length === 0 ? (
          <EmptyState>
            Henüz yönetim mizanı kaydı yok — hesap planı ve fişler oluştuğunda TDHP mizanı burada listelenir.
          </EmptyState>
        ) : (
          <TableShell>
            <table className="w-full text-xs">
              <thead>
                <tr>
                  <th>Hesap Kodu</th>
                  <th>Hesap Adı</th>
                  <th>Sınıf</th>
                  <th>EBITDA Kovası</th>
                  <th className="text-right">Fiş</th>
                  {hasOpeningSplit ? (
                    <>
                      <th className="text-right">Açılış Borç</th>
                      <th className="text-right">Açılış Alacak</th>
                      <th className="text-right">Dönem Borç</th>
                      <th className="text-right">Dönem Alacak</th>
                    </>
                  ) : (
                    <>
                      <th className="text-right">Borç Toplamı (TRY)</th>
                      <th className="text-right">Alacak Toplamı (TRY)</th>
                    </>
                  )}
                  <th className="text-right">Borç Bakiyesi (TRY)</th>
                  <th className="text-right">Alacak Bakiyesi (TRY)</th>
                </tr>
              </thead>
              <tbody>
                {report.trialBalance.map((row) => (
                  <tr key={row.accountCode}>
                    <td className="font-mono text-xs font-semibold">{row.accountCode}</td>
                    <td>{row.accountName}</td>
                    <td className="font-mono text-xs text-tone-3">{row.accountClass}</td>
                    <td>
                      <Badge tone="neutral">{row.ebitdaBucket}</Badge>
                    </td>
                    <td className="text-right font-mono text-xs">{row.entryCount}</td>
                    {hasOpeningSplit ? (
                      <>
                        <td className="text-right font-mono text-xs text-tone-3">
                          {formatMoney(row.openingDebitTry)}
                        </td>
                        <td className="text-right font-mono text-xs text-tone-3">
                          {formatMoney(row.openingCreditTry)}
                        </td>
                        <td className="text-right font-mono text-xs">{formatMoney(row.periodDebitTry)}</td>
                        <td className="text-right font-mono text-xs">{formatMoney(row.periodCreditTry)}</td>
                      </>
                    ) : (
                      <>
                        <td className="text-right font-mono text-xs">{formatMoney(row.debitTotalTry)}</td>
                        <td className="text-right font-mono text-xs">{formatMoney(row.creditTotalTry)}</td>
                      </>
                    )}
                    <td className="text-right font-mono text-xs font-medium text-info">
                      {formatMoney(row.debitBalanceTry)}
                    </td>
                    <td className="text-right font-mono text-xs font-medium text-warn">
                      {formatMoney(row.creditBalanceTry)}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-line font-semibold">
                  <td colSpan={5}>GENEL MİZAN TOPLAMI</td>
                  {hasOpeningSplit ? (
                    <>
                      <td className="text-right font-mono">{formatMoney(report.totalOpeningDebitTry)}</td>
                      <td className="text-right font-mono">{formatMoney(report.totalOpeningCreditTry)}</td>
                      <td className="text-right font-mono">{formatMoney(report.totalPeriodDebitTry)}</td>
                      <td className="text-right font-mono">{formatMoney(report.totalPeriodCreditTry)}</td>
                    </>
                  ) : (
                    <>
                      <td className="text-right font-mono">{formatMoney(report.totalDebitTry)}</td>
                      <td className="text-right font-mono">{formatMoney(report.totalCreditTry)}</td>
                    </>
                  )}
                  <td className="text-right font-mono text-info">{formatMoney(report.totalDebitBalanceTry)}</td>
                  <td className="text-right font-mono text-warn">{formatMoney(report.totalCreditBalanceTry)}</td>
                </tr>
              </tfoot>
            </table>
          </TableShell>
        )}
      </Panel>

      {/* ② GELİR TABLOSU & YÖNETİM EBITDA ŞELALESİ ve ③ YÖNETİM BİLANÇOSU */}
      <div className="grid gap-4 lg:grid-cols-2">
        <Panel
          title="② GELİR TABLOSU VE YÖNETİM EBITDA ŞELALESİ"
          subtitle="Net Satışlar → Brüt Kâr → Faaliyet Giderleri → EBIT + Amortisman (770.99) = Yönetim EBITDA → Finansman (780) → Vergi Öncesi Kâr."
        >
          <TableShell>
            <table className="w-full text-xs">
              <thead>
                <tr>
                  <th>Gelir Tablosu / EBITDA Kalemi</th>
                  <th className="text-right">Tutar (TRY)</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>Brüt Satışlar (`600`–`602`)</td>
                  <td className="text-right font-mono">{formatMoney(isSum.grossSalesTry)}</td>
                </tr>
                <tr>
                  <td>Satış İndirimleri ve İadeler (`610`–`611`) (-)</td>
                  <td className="text-right font-mono text-neg">-{formatMoney(isSum.salesDiscountsTry)}</td>
                </tr>
                <tr className="font-semibold">
                  <td>NET SATIŞLAR</td>
                  <td className="text-right font-mono">{formatMoney(isSum.netSalesTry)}</td>
                </tr>
                <tr>
                  <td>Satışların Maliyeti (`620`–`622`, `730`) (-)</td>
                  <td className="text-right font-mono text-neg">-{formatMoney(isSum.cogsTry)}</td>
                </tr>
                <tr className="font-semibold">
                  <td>BRÜT KÂR / (ZARAR)</td>
                  <td className="text-right font-mono">{formatMoney(isSum.grossProfitTry)}</td>
                </tr>
                <tr>
                  <td>Nakit Faaliyet Giderleri (`630`–`632`, `770` D&amp;A hariç) (-)</td>
                  <td className="text-right font-mono text-neg">-{formatMoney(isSum.opexCashTry)}</td>
                </tr>
                <tr>
                  <td>Amortisman ve İtfa Payları (`770.99` D&amp;A) (-)</td>
                  <td className="text-right font-mono text-warn">-{formatMoney(isSum.daAddbackTry)}</td>
                </tr>
                <tr className="font-semibold">
                  <td>FAALİYET KÂRI (EBIT)</td>
                  <td className="text-right font-mono">{formatMoney(isSum.ebitTry)}</td>
                </tr>
                <tr style={{ background: "var(--pos-soft)", color: "var(--pos)" }} className="font-bold">
                  <td>YÖNETİM EBITDA (EBIT + Amortisman Geri Eklemesi)</td>
                  <td className="text-right font-mono">{formatMoney(isSum.managementEbitdaTry)}</td>
                </tr>
                <tr>
                  <td>Diğer Olağan Gelir ve Kârlar / Giderler Net (`642`–`656`)</td>
                  <td className="text-right font-mono">{formatMoney(isSum.otherNetIncomeTry)}</td>
                </tr>
                <tr>
                  <td>Finansman Giderleri (`660`, `780` Faiz + BSMV/KKDF + Komisyon) (-)</td>
                  <td className="text-right font-mono text-neg">-{formatMoney(isSum.financingExpenseTry)}</td>
                </tr>
                <tr className="font-semibold">
                  <td>VERGİ ÖNCESİ YÖNETİM KÂRI / (ZARARI) (`690`)</td>
                  <td className="text-right font-mono">{formatMoney(isSum.ebtTry)}</td>
                </tr>
                <tr>
                  <td>Dönem Vergi Karşılığı (`691`) (-)</td>
                  <td className="text-right font-mono text-neg">-{formatMoney(isSum.taxExpenseTry)}</td>
                </tr>
                <tr className="border-t border-line font-bold">
                  <td>DÖNEM NET KÂRI / (ZARARI) (`590` / `591`)</td>
                  <td className="text-right font-mono">{formatMoney(isSum.netIncomeTry)}</td>
                </tr>
              </tbody>
            </table>
          </TableShell>
        </Panel>

        <Panel
          title="③ YÖNETİM BİLANÇOSU (AKTİF = YABANCI KAYNAK + ÖZKAYNAK)"
          subtitle="Cari dönem net kâr/zararı otomatik olarak 590/591 özkaynak satırına yansıtılır; Aktif = Pasif kuruşu kuruşuna korunur."
        >
          {report.balanceSheet.length === 0 ? (
            <EmptyState>Henüz yönetim bilançosu kaydı yok.</EmptyState>
          ) : (
            <TableShell>
              <table className="w-full text-xs">
                <thead>
                  <tr>
                    <th>Kod</th>
                    <th>Bilanço Kalemi</th>
                    <th>Grup</th>
                    <th className="text-right">Tutar (TRY)</th>
                  </tr>
                </thead>
                <tbody>
                  {report.balanceSheet.map((item) => (
                    <tr key={`${item.section}:${item.accountCode}`}>
                      <td className="font-mono text-xs">{item.accountCode}</td>
                      <td>{item.accountName}</td>
                      <td>
                        <Badge
                          tone={
                            item.section === "asset"
                              ? "blue"
                              : item.section === "liability"
                                ? "amber"
                                : "green"
                          }
                        >
                          {item.section === "asset"
                            ? "Aktif (Varlık)"
                            : item.section === "liability"
                              ? "Yabancı Kaynak"
                              : "Özkaynak"}
                        </Badge>
                      </td>
                      <td className="text-right font-mono text-xs">{formatMoney(item.amountTry)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t border-line font-semibold">
                    <td colSpan={3}>AKTİF (VARLIKLAR) TOPLAMI</td>
                    <td className="text-right font-mono text-info">{formatMoney(report.totalAssetsTry)}</td>
                  </tr>
                  <tr className="font-semibold">
                    <td colSpan={3}>PASİF (YABANCI KAYNAK + ÖZKAYNAK) TOPLAMI</td>
                    <td className="text-right font-mono text-pos">
                      {formatMoney(report.totalLiabilitiesAndEquityTry)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </TableShell>
          )}
        </Panel>
      </div>

      {/* ④ YEVMİYE FİŞLERİ VE ÇOK SATIRLI MANUEL TAHAKKUK / TERS KAYIT */}
      <Panel
        title="④ ÇOK SATIRLI YEVMİYE FİŞİ, MASRAF MERKEZİ DAĞITIMI VE TERS KAYIT (STORNO)"
        subtitle="Kesinleşmiş (posted) fişler veritabanı tetikleyicisiyle değiştirilemez ve silinemez; yalnız ters kayıt (reversal) açılarak düzeltilebilir."
      >
        {canPost ? (
          <MultiLineJournalForm
            accounts={accounts.map((a) => ({ code: a.code, name: a.name }))}
            costCenters={costCentersRes.rows}
            defaultDate={todayISO}
          />
        ) : null}

        {recentEntriesRes.rows.length > 0 ? (
          <TableShell>
            <table className="w-full text-xs">
              <thead>
                <tr>
                  <th>Fiş No</th>
                  <th>Tarih</th>
                  <th>Kaynak</th>
                  <th>Açıklama</th>
                  <th>Durum</th>
                  <th className="text-right">Borç (TRY)</th>
                  <th className="text-right">Alacak (TRY)</th>
                  <th>İşlem</th>
                </tr>
              </thead>
              <tbody>
                {recentEntriesRes.rows.map((je) => (
                  <tr key={je.id}>
                    <td className="font-mono text-xs">#{je.entry_no}</td>
                    <td className="font-mono text-xs">{je.entry_date}</td>
                    <td className="font-mono text-xs">{je.source_type}</td>
                    <td className="text-xs">
                      {je.description}
                      {je.needs_tax_split_review ? (
                        <span className="ml-2 rounded border border-line bg-surface-2 px-1.5 py-0.5 text-[10px] text-warn">
                          KDV Ayrımı İnceleme Bekliyor
                        </span>
                      ) : null}
                    </td>
                    <td>
                      <Badge
                        tone={
                          je.status === "posted"
                            ? "green"
                            : je.status === "provisional_fx"
                              ? "amber"
                              : je.status === "reversed"
                                ? "neutral"
                                : "blue"
                        }
                      >
                        {je.status}
                      </Badge>
                    </td>
                    <td className="text-right font-mono text-xs">
                      {je.debit_total_try ? formatMoney(je.debit_total_try) : "Kur Bekliyor"}
                    </td>
                    <td className="text-right font-mono text-xs">
                      {je.credit_total_try ? formatMoney(je.credit_total_try) : "Kur Bekliyor"}
                    </td>
                    <td>
                      <div className="flex items-center gap-1.5">
                        {je.status === "draft" && canApprove ? (
                          <form action={approveDraftEntryAction}>
                            <input type="hidden" name="entryId" value={je.id} />
                            <SubmitButton
                              pendingLabel="Onaylanıyor…"
                              className="button-accent px-2 py-1 text-[11px] disabled:opacity-60"
                            >
                              Onayla (Post)
                            </SubmitButton>
                          </form>
                        ) : null}
                        {je.status === "draft" && canReverse ? (
                          <form action={discardDraftEntryAction}>
                            <input type="hidden" name="entryId" value={je.id} />
                            <SubmitButton
                              pendingLabel="Siliniyor…"
                              className="button-ghost px-2 py-1 text-[11px] font-medium text-neg disabled:opacity-60"
                            >
                              Taslağı Sil
                            </SubmitButton>
                          </form>
                        ) : null}
                        {je.status === "posted" && canReverse ? (
                          <form action={reverseEntryAction} className="flex items-center gap-1">
                            <input type="hidden" name="entryId" value={je.id} />
                            <input
                              name="reason"
                              defaultValue="Yönetim ters kaydı (storno)"
                              className="field-control w-32 px-1.5 py-0.5 text-[11px]"
                            />
                            <SubmitButton
                              pendingLabel="İşleniyor…"
                              className="button-ghost px-2 py-0.5 text-[11px] font-medium text-neg disabled:opacity-60"
                            >
                              Ters Kayıt (Storno)
                            </SubmitButton>
                          </form>
                        ) : null}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </TableShell>
        ) : (
          <EmptyState>
            Henüz yönetim yevmiye fişi yok — yukarıdan operasyonel senkronizasyonu çalıştırabilir veya manuel tahakkuk fişi girebilirsiniz.
          </EmptyState>
        )}
      </Panel>
    </div>
  );
}
