// Faz 53 (E3) — 12 Kök Nedenli Otomatik Yönetim Defteri ↔ Mali Müşavir Yasal Mizan Mutabakat Köprüsü
// ve 3 Sekmeli "Mali Müşavir Mutabakat Paketi (.xlsx)" Üreticisi.
//
// Değişmez Kural:
//   Hiçbir yönetim yevmiye fişini veya yasal mizan satırını otomatik değiştirmez
//   ("Bayrakla, asla sessiz düzeltme").

import type { Pool, PoolClient } from "pg";
import { audit } from "@/lib/audit";
import { DomainError } from "@/lib/domain-error";
import { decimal, money } from "@/lib/money";

export type ReconciliationRootCauseCode =
  | "MATCHED"
  | "CASH_100_INFLATION"
  | "CHECK_ENDORSEMENT_OR_CLEARING_LAG"
  | "UNBOOKED_BANK_TXN_OR_FX"
  | "ISSUED_CHECK_NOT_DELIVERED_TO_CPA"
  | "CUTOFF_UNBILLED_OR_UNALLOCATED_CASH"
  | "PARTNER_ACCOUNT_PLUG"
  | "VAT_TAHAKKUK_UNCLOSED"
  | "LOAN_PRINCIPAL_VS_GROSS_INSTALLMENT"
  | "MISSING_PURCHASE_INVOICE"
  | "PAYROLL_ADVANCE_OR_EXPENSE_GAP"
  | "UNPAID_OR_RESTRUCTURED_TAX_DEBT"
  | "MANAGEMENT_EBITDA_TO_STATUTORY_690_BRIDGE"
  | "OTHER_TDHP_TIMING_GAP";

export type ReconciliationSeverity = "match" | "info" | "warning" | "critical";

export interface CandidateEvidenceRecord {
  entityTable: string;
  entityId: string;
  docRef: string;
  docDate: string;
  amountTry: number;
  summary: string;
}

export interface EbitdaTo690BridgeBreakdown {
  managementEbitdaTry: number;
  lessManagementDepreciationTry: number;
  managementEbitTry: number;
  lessManagementFinancingTry: number;
  plusManagementOtherNetTry: number;
  management690EbtTry: number;
  statutoryNetSalesTry: number;
  statutoryCogsAndOpexTry: number;
  statutoryFinancingTry: number;
  statutoryOtherNetTry: number;
  statutory690EbtTry: number;
  revenueTimingGapTry: number;
  expenseTimingGapTry: number;
  financingTimingGapTry: number;
  unexplainedBridgeResidualTry: number;
}

export interface ReconciliationItemRow {
  id: string;
  runId: string;
  tdhpGroupCode: string;
  tdhpGroupName: string;
  managementNetTry: number;
  statutoryNetTry: number;
  deltaTry: number;
  rootCauseCode: ReconciliationRootCauseCode;
  severity: ReconciliationSeverity;
  explanation: string;
  candidateEvidence: CandidateEvidenceRecord[];
  actionItemId: string | null;
}

export interface ReconciliationRunSummary {
  runId: string;
  statutoryTrialBalanceId: string;
  asOfDate: string;
  periodLabel: string;
  sourceSoftware: string | null;
  originalFilename: string;
  isSelfBalanced: boolean;
  managementTotalDebitTry: number;
  managementTotalCreditTry: number;
  statutoryTotalDebitTry: number;
  statutoryTotalCreditTry: number;
  managementEbitdaTry: number;
  statutory690EbtTry: number;
  ebitdaTo690Bridge: EbitdaTo690BridgeBreakdown;
  matchedGroupCount: number;
  discrepancyGroupCount: number;
  items: ReconciliationItemRow[];
  createdAt: string;
}

interface TdhpGroupSpec {
  groupCode: string;
  groupName: string;
  rootCodes: string[];
  normalSign: "debit_minus_credit" | "credit_minus_debit";
  defaultRootCause: ReconciliationRootCauseCode;
  criticalThresholdTry: number;
  warningThresholdTry: number;
  describeGap: (mgmt: number, stat: number, delta: number) => string;
}

const TDHP_BRIDGE_GROUPS: TdhpGroupSpec[] = [
  {
    groupCode: "100",
    groupName: "100 Kasa",
    rootCodes: ["100"],
    normalSign: "debit_minus_credit",
    defaultRootCause: "CASH_100_INFLATION",
    criticalThresholdTry: 50000,
    warningThresholdTry: 5000,
    describeGap: (mgmt, stat, delta) =>
      stat > mgmt
        ? `Yasal mizanda 100 Kasa bakiyesi MAS gerçek kasasından ${Math.abs(delta).toFixed(2)} TRY daha yüksek — faturasız çıkışlar veya ortak çekimleri yüzünden kasa şişkinliği (adat faizi / vergi inceleme riski).`
        : `MAS gerçek kasa bakiyesi yasal mizandan ${Math.abs(delta).toFixed(2)} TRY farklı — müşavire teslim edilmemiş tahsilat/tediye makbuzları.`,
  },
  {
    groupCode: "101",
    groupName: "101 Alınan Çekler (Portföy / Tahsil / Ciro)",
    rootCodes: ["101"],
    normalSign: "debit_minus_credit",
    defaultRootCause: "CHECK_ENDORSEMENT_OR_CLEARING_LAG",
    criticalThresholdTry: 50000,
    warningThresholdTry: 5000,
    describeGap: (_mgmt, _stat, delta) =>
      `Müşteri çekleri (101) bakiyesinde ${Math.abs(delta).toFixed(2)} TRY fark — tedarikçiye ciro edilen çek bordrosunun müşavire gitmemesi veya banka tahsil valör farkı.`,
  },
  {
    groupCode: "102",
    groupName: "102 Bankalar",
    rootCodes: ["102"],
    normalSign: "debit_minus_credit",
    defaultRootCause: "UNBOOKED_BANK_TXN_OR_FX",
    criticalThresholdTry: 25000,
    warningThresholdTry: 1000,
    describeGap: (_mgmt, _stat, delta) =>
      `Banka hesapları (102) bakiyesinde ${Math.abs(delta).toFixed(2)} TRY fark — müşavire henüz işlenmemiş banka ekstresi, EFT/POS komisyonu veya dönem sonu döviz kur değerleme farkı.`,
  },
  {
    groupCode: "103",
    groupName: "103 Verilen Çekler ve Ödeme Emirleri (-)",
    rootCodes: ["103"],
    normalSign: "credit_minus_debit",
    defaultRootCause: "ISSUED_CHECK_NOT_DELIVERED_TO_CPA",
    criticalThresholdTry: 50000,
    warningThresholdTry: 5000,
    describeGap: (_mgmt, _stat, delta) =>
      `Verilen çekler (103) bakiyesinde ${Math.abs(delta).toFixed(2)} TRY fark — MAS'ta keşide edilen tedarikçi çek bordrosunun / koçanının mali müşavire bildirilmemesi.`,
  },
  {
    groupCode: "120",
    groupName: "120 Alıcılar (Ticari Alacaklar)",
    rootCodes: ["120"],
    normalSign: "debit_minus_credit",
    defaultRootCause: "CUTOFF_UNBILLED_OR_UNALLOCATED_CASH",
    criticalThresholdTry: 50000,
    warningThresholdTry: 5000,
    describeGap: (_mgmt, _stat, delta) =>
      `Alıcılar (120) hesabında ${Math.abs(delta).toFixed(2)} TRY fark — dönem sonu e-Fatura kesim kayması (cutoff) veya banka tahsilatının yasal defterde cariye henüz mahsup edilmemesi.`,
  },
  {
    groupCode: "131/331",
    groupName: "131 / 331 Ortaklardan Alacaklar & Ortaklara Borçlar (Net)",
    rootCodes: ["131", "331"],
    normalSign: "debit_minus_credit",
    defaultRootCause: "PARTNER_ACCOUNT_PLUG",
    criticalThresholdTry: 50000,
    warningThresholdTry: 5000,
    describeGap: (_mgmt, _stat, delta) =>
      `Ortaklar cari (131/331) net bakiyesinde ${Math.abs(delta).toFixed(2)} TRY fark — müşavirin belgesi eksik banka giriş/çıkışlarını geçici olarak 131/331 hesabına virmanlaması (plug).`,
  },
  {
    groupCode: "190/191/391",
    groupName: "190 / 191 / 391 KDV Hesapları (Devreden / İndirilecek / Hesaplanan Net)",
    rootCodes: ["190", "191", "391"],
    normalSign: "debit_minus_credit",
    defaultRootCause: "VAT_TAHAKKUK_UNCLOSED",
    criticalThresholdTry: 30000,
    warningThresholdTry: 2500,
    describeGap: (_mgmt, _stat, delta) =>
      `KDV hesaplarında (190+191-391) ${Math.abs(delta).toFixed(2)} TRY fark — ay sonu KDV tahakkuk/mahsup fişinin henüz kesilmemiş olması veya basit gider fişi KDV ayrımı eksikliği.`,
  },
  {
    groupCode: "300/400",
    groupName: "300 / 400 Banka Kredileri (Kısa + Uzun Vadeli Anapara)",
    rootCodes: ["300", "400"],
    normalSign: "credit_minus_debit",
    defaultRootCause: "LOAN_PRINCIPAL_VS_GROSS_INSTALLMENT",
    criticalThresholdTry: 50000,
    warningThresholdTry: 5000,
    describeGap: (_mgmt, _stat, delta) =>
      `Banka kredileri (300/400) bakiyesinde ${Math.abs(delta).toFixed(2)} TRY fark — ödenen kredi taksitinde anapara (300) ile faiz+BSMV+KKDF (780) ayrımının yasal mizanda brüt düşülmesi veya tahakkuk farkı.`,
  },
  {
    groupCode: "320",
    groupName: "320 Satıcılar (Ticari Borçlar)",
    rootCodes: ["320"],
    normalSign: "credit_minus_debit",
    defaultRootCause: "MISSING_PURCHASE_INVOICE",
    criticalThresholdTry: 50000,
    warningThresholdTry: 5000,
    describeGap: (_mgmt, _stat, delta) =>
      `Satıcılar (320) hesabında ${Math.abs(delta).toFixed(2)} TRY fark — ödemesi bankadan çıkmış veya MAS'a girilmiş ancak e-Faturası mali müşavire henüz ulaşmamış tedarikçi alımı.`,
  },
  {
    groupCode: "335",
    groupName: "335 Personele Borçlar & İş Avansları (195 Net)",
    rootCodes: ["335", "195"],
    normalSign: "credit_minus_debit",
    defaultRootCause: "PAYROLL_ADVANCE_OR_EXPENSE_GAP",
    criticalThresholdTry: 25000,
    warningThresholdTry: 2500,
    describeGap: (_mgmt, _stat, delta) =>
      `Personel ve iş avansı (335/195) hesaplarında ${Math.abs(delta).toFixed(2)} TRY fark — maaş tahakkuk bordrosu, çalışan cebinden yapılan harcama (spender) fişi veya iş avansı kapama farkı.`,
  },
  {
    groupCode: "360/361",
    groupName: "360 / 361 Ödenecek Vergi, Stopaj, KDV Tevkifatı ve SGK Primleri",
    rootCodes: ["360", "361"],
    normalSign: "credit_minus_debit",
    defaultRootCause: "UNPAID_OR_RESTRUCTURED_TAX_DEBT",
    criticalThresholdTry: 35000,
    warningThresholdTry: 2500,
    describeGap: (_mgmt, _stat, delta) =>
      `Vergi ve SGK (360/361) hesaplarında ${Math.abs(delta).toFixed(2)} TRY fark — KDV/Muhtasar/SGK tahakkuku, tevkifat mahsubu veya yapılandırma/tecil taksit farkı.`,
  },
];

async function findCandidateEvidenceForGroup(
  client: PoolClient,
  groupCode: string,
  asOfDate: string,
): Promise<CandidateEvidenceRecord[]> {
  const out: CandidateEvidenceRecord[] = [];

  if (groupCode === "120" || groupCode === "190/191/391") {
    const invRes = await client.query<{
      id: string;
      invoice_no: string;
      issue_date: string;
      gross_amount: string;
      party_name: string | null;
      has_je: boolean;
    }>(
      `select i.id::text,
              i.invoice_no,
              to_char(i.issue_date, 'YYYY-MM-DD') as issue_date,
              i.gross_amount::text,
              p.name as party_name,
              exists (
                select 1 from public.management_journal_entries je
                 where je.source_type = 'invoice' and je.source_id = i.id and je.status = 'posted'
              ) as has_je
         from public.invoices i
         left join public.parties p on p.id = i.party_id
        where i.direction = 'sales'
          and i.status not in ('cancelled')
          and i.issue_date <= $1::date
        order by
          (i.issue_date >= date_trunc('month', $1::date)::date) desc,
          has_je asc,
          i.gross_amount desc,
          i.issue_date desc
        limit 5`,
      [asOfDate],
    );
    for (const r of invRes.rows) {
      out.push({
        entityTable: "invoices",
        entityId: r.id,
        docRef: r.invoice_no,
        docDate: r.issue_date,
        amountTry: money(r.gross_amount),
        summary: `${r.has_je ? "Kesim/Cutoff adayı" : "Yevmiyesiz fatura"} (${r.party_name ?? "Müşteri"}): ${r.invoice_no}`,
      });
    }
  } else if (groupCode === "320" || groupCode === "335") {
    const invRes = await client.query<{
      id: string;
      invoice_no: string;
      issue_date: string;
      gross_amount: string;
      spender_employee_name: string | null;
      party_name: string | null;
      has_je: boolean;
    }>(
      `select i.id::text,
              i.invoice_no,
              to_char(i.issue_date, 'YYYY-MM-DD') as issue_date,
              i.gross_amount::text,
              i.spender_employee_name,
              p.name as party_name,
              exists (
                select 1 from public.management_journal_entries je
                 where je.source_type = 'invoice' and je.source_id = i.id and je.status = 'posted'
              ) as has_je
         from public.invoices i
         left join public.parties p on p.id = i.party_id
        where i.direction = 'purchase'
          and i.status not in ('cancelled')
          and i.issue_date <= $1::date
        order by
          (i.issue_date >= date_trunc('month', $1::date)::date) desc,
          has_je asc,
          i.gross_amount desc,
          i.issue_date desc
        limit 5`,
      [asOfDate],
    );
    for (const r of invRes.rows) {
      out.push({
        entityTable: "invoices",
        entityId: r.id,
        docRef: r.invoice_no,
        docDate: r.issue_date,
        amountTry: money(r.gross_amount),
        summary: r.spender_employee_name
          ? `Çalışan harcama fişi (${r.spender_employee_name}): ${r.invoice_no}`
          : `${r.has_je ? "Dönem sonu alış faturası" : "Yevmiyesiz alış faturası"} (${r.party_name ?? "Tedarikçi"}): ${r.invoice_no}`,
      });
    }
  } else if (groupCode === "101" || groupCode === "103") {
    const brdRes = await client.query<{
      id: string;
      bordro_no: string;
      bordro_type: string;
      bordro_date: string;
      total_amount: string;
    }>(
      `select id::text,
              bordro_no,
              bordro_type,
              to_char(bordro_date, 'YYYY-MM-DD') as bordro_date,
              total_amount::text
         from public.check_bordros
        where bordro_date <= $1::date
        order by (bordro_date >= date_trunc('month', $1::date)::date) desc, bordro_date desc
        limit 5`,
      [asOfDate],
    );
    for (const r of brdRes.rows) {
      out.push({
        entityTable: "check_bordros",
        entityId: r.id,
        docRef: r.bordro_no,
        docDate: r.bordro_date,
        amountTry: money(r.total_amount),
        summary: `Çek bordrosu (${r.bordro_type}): ${r.bordro_no}`,
      });
    }
  } else if (groupCode === "102") {
    const btRes = await client.query<{
      id: string;
      tx_date: string;
      amount: string;
      description: string | null;
      reference_no: string | null;
      status: string;
    }>(
      `select id::text,
              to_char(txn_date, 'YYYY-MM-DD') as tx_date,
              abs(amount)::numeric(16,2)::text as amount,
              description,
              reference_no,
              status
         from public.bank_transactions
        where txn_date <= $1::date
          and status <> 'ignored'
        order by
          (status in ('unmatched', 'suggested')) desc,
          (txn_date >= date_trunc('month', $1::date)::date) desc,
          txn_date desc
        limit 5`,
      [asOfDate],
    );
    for (const r of btRes.rows) {
      out.push({
        entityTable: "bank_transactions",
        entityId: r.id,
        docRef: r.reference_no ?? r.id.slice(0, 8),
        docDate: r.tx_date,
        amountTry: money(r.amount),
        summary: `Banka hareketi [${r.status}]: ${r.description ?? "Ekstre satırı"}`,
      });
    }
  } else if (groupCode === "300/400") {
    const liRes = await client.query<{
      id: string;
      due_date: string;
      amount: string;
      principal_component: string | null;
      interest_component: string | null;
      tax_component: string | null;
      loan_name: string;
    }>(
      `select li.id::text,
              to_char(li.due_date, 'YYYY-MM-DD') as due_date,
              li.amount::text,
              li.principal_component::text,
              li.interest_component::text,
              li.tax_component::text,
              l.name as loan_name
         from public.loan_installments li
         join public.loans l on l.id = li.loan_id
        where li.due_date <= $1::date
        order by li.due_date desc
        limit 5`,
      [asOfDate],
    );
    for (const r of liRes.rows) {
      out.push({
        entityTable: "loan_installments",
        entityId: r.id,
        docRef: r.loan_name,
        docDate: r.due_date,
        amountTry: money(r.amount),
        summary: `Kredi taksiti (${r.loan_name}) — Anapara: ${r.principal_component ?? "0"} / Faiz+Vergi: ${Number(r.interest_component ?? 0) + Number(r.tax_component ?? 0)}`,
      });
    }
  } else {
    const jeRes = await client.query<{
      id: string;
      entry_no: string;
      entry_date: string;
      description: string;
      amount_try: string;
    }>(
      `select je.id::text,
              je.entry_no::text,
              to_char(je.entry_date, 'YYYY-MM-DD') as entry_date,
              je.description,
              coalesce(sum(jl.debit_try), 0)::numeric(16,2)::text as amount_try
         from public.management_journal_entries je
         join public.management_journal_lines jl on jl.entry_id = je.id
         join public.management_accounts ma on ma.id = jl.account_id
        where je.status in ('posted', 'reversed')
          and je.entry_date <= $1::date
          and ma.tdhp_root_code = any($2::text[])
        group by je.id
        order by je.entry_date desc
        limit 5`,
      [asOfDate, groupCode.split("/")],
    );
    for (const r of jeRes.rows) {
      out.push({
        entityTable: "management_journal_entries",
        entityId: r.id,
        docRef: `YEV-${r.entry_no}`,
        docDate: r.entry_date,
        amountTry: money(r.amount_try),
        summary: r.description,
      });
    }
  }

  return out;
}

/**
 * Runs a deterministic 12-root-cause reconciliation between the MAS Management Ledger (`0105`)
 * as of `statutory_trial_balances.as_of_date` and the imported Statutory CPA Mizan (`0106`).
 *
 * Invariant: Never modifies any management journal entry or statutory mizan line.
 */
export async function reconcileTrialBalance(
  poolOrClient: Pool | PoolClient,
  statutoryTrialBalanceId: string,
  actorId: string,
): Promise<ReconciliationRunSummary> {
  const isPool = "connect" in poolOrClient && typeof poolOrClient.connect === "function";
  const client = isPool
    ? await (poolOrClient as Pool).connect()
    : (poolOrClient as PoolClient);

  try {
    if (isPool) await client.query("begin");

    const tbRes = await client.query<{
      id: string;
      as_of_date: string;
      period_label: string;
      source_software: string | null;
      original_filename: string;
      total_debit_try: string;
      total_credit_try: string;
      is_self_balanced: boolean;
    }>(
      `select id::text,
              to_char(as_of_date, 'YYYY-MM-DD') as as_of_date,
              period_label,
              source_software,
              original_filename,
              total_debit_try::text,
              total_credit_try::text,
              is_self_balanced
         from public.statutory_trial_balances
        where id = $1`,
      [statutoryTrialBalanceId],
    );
    const tb = tbRes.rows[0];
    if (!tb) {
      throw new DomainError(
        "NOT_FOUND",
        `Yasal mizan kaydı bulunamadı: ${statutoryTrialBalanceId}`,
      );
    }

    // 1. Load MAS Management Ledger balances up to tb.as_of_date grouped by tdhp_root_code & ebitda_bucket
    const mgmtRes = await client.query<{
      tdhp_root_code: string;
      ebitda_bucket: string;
      debit_try: string;
      credit_try: string;
    }>(
      `select ma.tdhp_root_code,
              ma.ebitda_bucket,
              coalesce(sum(jl.debit_try), 0)::numeric(16,2)::text as debit_try,
              coalesce(sum(jl.credit_try), 0)::numeric(16,2)::text as credit_try
         from public.management_accounts ma
         left join public.management_journal_lines jl on jl.account_id = ma.id
         left join public.management_journal_entries je
           on je.id = jl.entry_id
          and je.status in ('posted', 'reversed')
          and je.entry_date <= $1::date
        group by ma.tdhp_root_code, ma.ebitda_bucket`,
      [tb.as_of_date],
    );

    const mgmtByRoot = new Map<string, { debit: number; credit: number }>();
    let mgmtTotalDebit = decimal(0);
    let mgmtTotalCredit = decimal(0);
    let mgmtRevenue = decimal(0);
    let mgmtCogs = decimal(0);
    let mgmtOpexCash = decimal(0);
    let mgmtDaAddback = decimal(0);
    let mgmtFinancing = decimal(0);
    let mgmtOtherNet = decimal(0);

    for (const r of mgmtRes.rows) {
      const d = money(r.debit_try);
      const c = money(r.credit_try);
      mgmtTotalDebit = mgmtTotalDebit.plus(d);
      mgmtTotalCredit = mgmtTotalCredit.plus(c);

      const prev = mgmtByRoot.get(r.tdhp_root_code) ?? { debit: 0, credit: 0 };
      mgmtByRoot.set(r.tdhp_root_code, {
        debit: Number(decimal(prev.debit).plus(d).round(2).toFixed(2)),
        credit: Number(decimal(prev.credit).plus(c).round(2).toFixed(2)),
      });

      if (r.ebitda_bucket === "revenue") {
        mgmtRevenue = mgmtRevenue.plus(decimal(c).minus(d));
      } else if (r.ebitda_bucket === "cogs") {
        mgmtCogs = mgmtCogs.plus(decimal(d).minus(c));
      } else if (r.ebitda_bucket === "opex") {
        mgmtOpexCash = mgmtOpexCash.plus(decimal(d).minus(c));
      } else if (r.ebitda_bucket === "da_addback") {
        mgmtDaAddback = mgmtDaAddback.plus(decimal(d).minus(c));
      } else if (r.ebitda_bucket === "financing" || r.ebitda_bucket === "interest_financing") {
        mgmtFinancing = mgmtFinancing.plus(decimal(d).minus(c));
      } else if (r.ebitda_bucket === "non_operating") {
        mgmtOtherNet = mgmtOtherNet.plus(decimal(c).minus(d));
      }
    }

    const mgmtGrossProfit = mgmtRevenue.minus(mgmtCogs);
    const mgmtEbit = mgmtGrossProfit.minus(mgmtOpexCash).minus(mgmtDaAddback);
    const mgmtEbitda = mgmtEbit.plus(mgmtDaAddback);
    const mgmt690Ebt = mgmtEbit.plus(mgmtOtherNet).minus(mgmtFinancing);

    // 2. Load Statutory Mizan LEAF lines grouped by tdhp_root_code
    const statRes = await client.query<{
      tdhp_root_code: string;
      debit_try: string;
      credit_try: string;
    }>(
      `select tdhp_root_code,
              coalesce(sum(debit_total_try), 0)::numeric(16,2)::text as debit_try,
              coalesce(sum(credit_total_try), 0)::numeric(16,2)::text as credit_try
         from public.statutory_trial_balance_lines
        where trial_balance_id = $1
          and is_leaf = true
        group by tdhp_root_code`,
      [statutoryTrialBalanceId],
    );

    const statByRoot = new Map<string, { debit: number; credit: number }>();
    let statRevenue = decimal(0);
    let statCogsAndOpex = decimal(0);
    let statFinancing = decimal(0);
    let statOtherNet = decimal(0);
    let explicitStat690: number | null = null;

    for (const r of statRes.rows) {
      const d = money(r.debit_try);
      const c = money(r.credit_try);
      statByRoot.set(r.tdhp_root_code, { debit: d, credit: c });

      const rootNum = Number(r.tdhp_root_code);
      if (r.tdhp_root_code === "690") {
        explicitStat690 = Number(decimal(c).minus(d).round(2).toFixed(2));
      } else if (rootNum >= 600 && rootNum <= 619) {
        statRevenue = statRevenue.plus(decimal(c).minus(d));
      } else if (
        (rootNum >= 620 && rootNum <= 639) ||
        (rootNum >= 710 && rootNum <= 779)
      ) {
        statCogsAndOpex = statCogsAndOpex.plus(decimal(d).minus(c));
      } else if (rootNum === 660 || rootNum === 661 || rootNum === 780) {
        statFinancing = statFinancing.plus(decimal(d).minus(c));
      } else if (rootNum >= 640 && rootNum <= 689) {
        statOtherNet = statOtherNet.plus(decimal(c).minus(d));
      }
    }

    const derivedStat690 = statRevenue
      .minus(statCogsAndOpex)
      .plus(statOtherNet)
      .minus(statFinancing);
    const statutory690EbtTry =
      explicitStat690 !== null && Math.abs(explicitStat690) > 0.005
        ? explicitStat690
        : Number(derivedStat690.round(2).toFixed(2));

    const managementEbitdaTry = Number(mgmtEbitda.round(2).toFixed(2));
    const lessManagementDepreciationTry = Number(mgmtDaAddback.round(2).toFixed(2));
    const managementEbitTry = Number(mgmtEbit.round(2).toFixed(2));
    const lessManagementFinancingTry = Number(mgmtFinancing.round(2).toFixed(2));
    const plusManagementOtherNetTry = Number(mgmtOtherNet.round(2).toFixed(2));
    const management690EbtTry = Number(mgmt690Ebt.round(2).toFixed(2));

    const statutoryNetSalesTry = Number(statRevenue.round(2).toFixed(2));
    const statutoryCogsAndOpexTry = Number(statCogsAndOpex.round(2).toFixed(2));
    const statutoryFinancingTry = Number(statFinancing.round(2).toFixed(2));
    const statutoryOtherNetTry = Number(statOtherNet.round(2).toFixed(2));

    const revenueTimingGapTry = Number(
      statRevenue.minus(mgmtRevenue).round(2).toFixed(2),
    );
    const expenseTimingGapTry = Number(
      mgmtCogs
        .plus(mgmtOpexCash)
        .plus(mgmtDaAddback)
        .minus(statCogsAndOpex)
        .round(2)
        .toFixed(2),
    );
    const financingTimingGapTry = Number(
      mgmtFinancing.minus(statFinancing).round(2).toFixed(2),
    );
    const unexplainedBridgeResidualTry = Number(
      decimal(statutory690EbtTry)
        .minus(
          decimal(management690EbtTry)
            .plus(revenueTimingGapTry)
            .plus(expenseTimingGapTry)
            .plus(financingTimingGapTry),
        )
        .round(2)
        .toFixed(2),
    );

    const ebitdaTo690Bridge: EbitdaTo690BridgeBreakdown = {
      managementEbitdaTry,
      lessManagementDepreciationTry,
      managementEbitTry,
      lessManagementFinancingTry,
      plusManagementOtherNetTry,
      management690EbtTry,
      statutoryNetSalesTry,
      statutoryCogsAndOpexTry,
      statutoryFinancingTry,
      statutoryOtherNetTry,
      statutory690EbtTry,
      revenueTimingGapTry,
      expenseTimingGapTry,
      financingTimingGapTry,
      unexplainedBridgeResidualTry,
    };

    // 3. Evaluate each of the 11 Balance Sheet TDHP groups + 12th EBITDA <-> 690 Bridge row
    const computedItems: Array<Omit<ReconciliationItemRow, "id" | "runId">> = [];
    let matchedGroupCount = 0;
    let discrepancyGroupCount = 0;

    for (const spec of TDHP_BRIDGE_GROUPS) {
      let mDebit = decimal(0);
      let mCredit = decimal(0);
      let sDebit = decimal(0);
      let sCredit = decimal(0);

      for (const rc of spec.rootCodes) {
        const m = mgmtByRoot.get(rc);
        if (m) {
          mDebit = mDebit.plus(m.debit);
          mCredit = mCredit.plus(m.credit);
        }
        const s = statByRoot.get(rc);
        if (s) {
          sDebit = sDebit.plus(s.debit);
          sCredit = sCredit.plus(s.credit);
        }
      }

      const mgmtNet =
        spec.normalSign === "debit_minus_credit"
          ? Number(mDebit.minus(mCredit).round(2).toFixed(2))
          : Number(mCredit.minus(mDebit).round(2).toFixed(2));
      const statNet =
        spec.normalSign === "debit_minus_credit"
          ? Number(sDebit.minus(sCredit).round(2).toFixed(2))
          : Number(sCredit.minus(sDebit).round(2).toFixed(2));

      const deltaTry = Number(decimal(mgmtNet).minus(statNet).round(2).toFixed(2));
      const absDelta = Math.abs(deltaTry);

      if (absDelta < 0.005) {
        matchedGroupCount += 1;
        computedItems.push({
          tdhpGroupCode: spec.groupCode,
          tdhpGroupName: spec.groupName,
          managementNetTry: mgmtNet,
          statutoryNetTry: statNet,
          deltaTry: 0,
          rootCauseCode: "MATCHED",
          severity: "match",
          explanation: `${spec.groupName} yönetim defteri ile mali müşavir yasal mizanı arasında kuruşu kuruşuna mutabıktır (Fark: 0,00 TRY).`,
          candidateEvidence: [],
          actionItemId: null,
        });
      } else {
        discrepancyGroupCount += 1;
        const severity: ReconciliationSeverity =
          absDelta >= spec.criticalThresholdTry
            ? "critical"
            : absDelta >= spec.warningThresholdTry
              ? "warning"
              : "info";
        const evidence = await findCandidateEvidenceForGroup(
          client,
          spec.groupCode,
          tb.as_of_date,
        );
        computedItems.push({
          tdhpGroupCode: spec.groupCode,
          tdhpGroupName: spec.groupName,
          managementNetTry: mgmtNet,
          statutoryNetTry: statNet,
          deltaTry,
          rootCauseCode: spec.defaultRootCause,
          severity,
          explanation: spec.describeGap(mgmtNet, statNet, deltaTry),
          candidateEvidence: evidence,
          actionItemId: null,
        });
      }
    }

    // 12th item: MANAGEMENT_EBITDA_TO_STATUTORY_690_BRIDGE
    const ebitdaDeltaTry = Number(
      decimal(managementEbitdaTry).minus(statutory690EbtTry).round(2).toFixed(2),
    );
    const ebtGapAbs = Math.abs(management690EbtTry - statutory690EbtTry);
    const bridgeSeverity: ReconciliationSeverity =
      ebtGapAbs < 0.005 ? "info" : ebtGapAbs >= 50000 ? "critical" : "warning";
    if (ebtGapAbs < 0.005) {
      matchedGroupCount += 1;
    } else {
      discrepancyGroupCount += 1;
    }

    computedItems.push({
      tdhpGroupCode: "EBITDA_690",
      tdhpGroupName: "600–780 Yönetim EBITDA ↔ Yasal 690 Dönem Kâr/Zararı Köprüsü",
      managementNetTry: managementEbitdaTry,
      statutoryNetTry: statutory690EbtTry,
      deltaTry: ebitdaDeltaTry,
      rootCauseCode: "MANAGEMENT_EBITDA_TO_STATUTORY_690_BRIDGE",
      severity: bridgeSeverity,
      explanation: `Yönetim EBITDA (${managementEbitdaTry.toFixed(2)} TRY) - Amortisman (${lessManagementDepreciationTry.toFixed(2)} TRY) - Finansman (${lessManagementFinancingTry.toFixed(2)} TRY) = Yönetim 690 (${management690EbtTry.toFixed(2)} TRY) vs Yasal 690 (${statutory690EbtTry.toFixed(2)} TRY); Gelir/Gider dönemsellik farkı: ${(statutory690EbtTry - management690EbtTry).toFixed(2)} TRY.`,
      candidateEvidence: [],
      actionItemId: null,
    });

    const mgmtTotalDebitTry = Number(mgmtTotalDebit.round(2).toFixed(2));
    const mgmtTotalCreditTry = Number(mgmtTotalCredit.round(2).toFixed(2));
    const statTotalDebitTry = money(tb.total_debit_try);
    const statTotalCreditTry = money(tb.total_credit_try);

    const runRes = await client.query<{ id: string; created_at: string }>(
      `insert into public.trial_balance_reconciliation_runs
         (statutory_trial_balance_id, as_of_date,
          management_total_debit_try, management_total_credit_try,
          statutory_total_debit_try, statutory_total_credit_try,
          management_ebitda_try, statutory_690_ebt_try, ebitda_to_690_bridge_json,
          matched_group_count, discrepancy_group_count, created_by)
       values ($1, $2::date, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12)
       returning id::text, created_at::text`,
      [
        statutoryTrialBalanceId,
        tb.as_of_date,
        mgmtTotalDebitTry.toFixed(2),
        mgmtTotalCreditTry.toFixed(2),
        statTotalDebitTry.toFixed(2),
        statTotalCreditTry.toFixed(2),
        managementEbitdaTry.toFixed(2),
        statutory690EbtTry.toFixed(2),
        JSON.stringify(ebitdaTo690Bridge),
        matchedGroupCount,
        discrepancyGroupCount,
        actorId,
      ],
    );
    const runId = runRes.rows[0].id;
    const createdAt = runRes.rows[0].created_at;

    const savedItems: ReconciliationItemRow[] = [];
    for (const item of computedItems) {
      const itemRes = await client.query<{ id: string }>(
        `insert into public.trial_balance_reconciliation_items
           (run_id, tdhp_group_code, tdhp_group_name,
            management_net_try, statutory_net_try, delta_try,
            root_cause_code, severity, explanation, candidate_evidence_json)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb)
         returning id::text`,
        [
          runId,
          item.tdhpGroupCode,
          item.tdhpGroupName,
          item.managementNetTry.toFixed(2),
          item.statutoryNetTry.toFixed(2),
          item.deltaTry.toFixed(2),
          item.rootCauseCode,
          item.severity,
          item.explanation,
          JSON.stringify(item.candidateEvidence),
        ],
      );
      savedItems.push({
        id: itemRes.rows[0].id,
        runId,
        ...item,
      });
    }

    await audit(client, {
      actor: actorId,
      action: "trial_balance_reconciled",
      entityTable: "trial_balance_reconciliation_runs",
      entityId: runId,
      after: {
        statutoryTrialBalanceId,
        asOfDate: tb.as_of_date,
        matchedGroupCount,
        discrepancyGroupCount,
        managementEbitdaTry,
        statutory690EbtTry,
      },
    });

    if (isPool) await client.query("commit");

    return {
      runId,
      statutoryTrialBalanceId,
      asOfDate: tb.as_of_date,
      periodLabel: tb.period_label,
      sourceSoftware: tb.source_software,
      originalFilename: tb.original_filename,
      isSelfBalanced: tb.is_self_balanced,
      managementTotalDebitTry: mgmtTotalDebitTry,
      managementTotalCreditTry: mgmtTotalCreditTry,
      statutoryTotalDebitTry: statTotalDebitTry,
      statutoryTotalCreditTry: statTotalCreditTry,
      managementEbitdaTry,
      statutory690EbtTry,
      ebitdaTo690Bridge,
      matchedGroupCount,
      discrepancyGroupCount,
      items: savedItems,
      createdAt,
    };
  } catch (err) {
    if (isPool) await client.query("rollback");
    throw err;
  } finally {
    if (isPool) client.release();
  }
}

/**
 * Loads an existing reconciliation run by ID (or the latest run if `runId` is omitted).
 */
export async function loadReconciliationRun(
  pool: Pool,
  runId?: string | null,
): Promise<ReconciliationRunSummary | null> {
  const runRes = await pool.query<{
    id: string;
    statutory_trial_balance_id: string;
    as_of_date: string;
    period_label: string;
    source_software: string | null;
    original_filename: string;
    is_self_balanced: boolean;
    management_total_debit_try: string;
    management_total_credit_try: string;
    statutory_total_debit_try: string;
    statutory_total_credit_try: string;
    management_ebitda_try: string;
    statutory_690_ebt_try: string;
    ebitda_to_690_bridge_json: EbitdaTo690BridgeBreakdown;
    matched_group_count: number;
    discrepancy_group_count: number;
    created_at: string;
  }>(
    runId
      ? `select r.id::text,
                r.statutory_trial_balance_id::text,
                to_char(r.as_of_date, 'YYYY-MM-DD') as as_of_date,
                tb.period_label,
                tb.source_software,
                tb.original_filename,
                tb.is_self_balanced,
                r.management_total_debit_try::text,
                r.management_total_credit_try::text,
                r.statutory_total_debit_try::text,
                r.statutory_total_credit_try::text,
                r.management_ebitda_try::text,
                r.statutory_690_ebt_try::text,
                r.ebitda_to_690_bridge_json,
                r.matched_group_count,
                r.discrepancy_group_count,
                r.created_at::text
           from public.trial_balance_reconciliation_runs r
           join public.statutory_trial_balances tb on tb.id = r.statutory_trial_balance_id
          where r.id = $1`
      : `select r.id::text,
                r.statutory_trial_balance_id::text,
                to_char(r.as_of_date, 'YYYY-MM-DD') as as_of_date,
                tb.period_label,
                tb.source_software,
                tb.original_filename,
                tb.is_self_balanced,
                r.management_total_debit_try::text,
                r.management_total_credit_try::text,
                r.statutory_total_debit_try::text,
                r.statutory_total_credit_try::text,
                r.management_ebitda_try::text,
                r.statutory_690_ebt_try::text,
                r.ebitda_to_690_bridge_json,
                r.matched_group_count,
                r.discrepancy_group_count,
                r.created_at::text
           from public.trial_balance_reconciliation_runs r
           join public.statutory_trial_balances tb on tb.id = r.statutory_trial_balance_id
          order by r.created_at desc
          limit 1`,
    runId ? [runId] : [],
  );

  const r = runRes.rows[0];
  if (!r) return null;

  const itemsRes = await pool.query<{
    id: string;
    run_id: string;
    tdhp_group_code: string;
    tdhp_group_name: string;
    management_net_try: string;
    statutory_net_try: string;
    delta_try: string;
    root_cause_code: ReconciliationRootCauseCode;
    severity: ReconciliationSeverity;
    explanation: string;
    candidate_evidence_json: CandidateEvidenceRecord[];
    action_item_id: string | null;
  }>(
    `select id::text,
            run_id::text,
            tdhp_group_code,
            tdhp_group_name,
            management_net_try::text,
            statutory_net_try::text,
            delta_try::text,
            root_cause_code,
            severity,
            explanation,
            candidate_evidence_json,
            action_item_id::text
       from public.trial_balance_reconciliation_items
      where run_id = $1
      order by tdhp_group_code asc`,
    [r.id],
  );

  return {
    runId: r.id,
    statutoryTrialBalanceId: r.statutory_trial_balance_id,
    asOfDate: r.as_of_date,
    periodLabel: r.period_label,
    sourceSoftware: r.source_software,
    originalFilename: r.original_filename,
    isSelfBalanced: r.is_self_balanced,
    managementTotalDebitTry: money(r.management_total_debit_try),
    managementTotalCreditTry: money(r.management_total_credit_try),
    statutoryTotalDebitTry: money(r.statutory_total_debit_try),
    statutoryTotalCreditTry: money(r.statutory_total_credit_try),
    managementEbitdaTry: money(r.management_ebitda_try),
    statutory690EbtTry: money(r.statutory_690_ebt_try),
    ebitdaTo690Bridge: r.ebitda_to_690_bridge_json,
    matchedGroupCount: r.matched_group_count,
    discrepancyGroupCount: r.discrepancy_group_count,
    items: itemsRes.rows.map((it) => ({
      id: it.id,
      runId: it.run_id,
      tdhpGroupCode: it.tdhp_group_code,
      tdhpGroupName: it.tdhp_group_name,
      managementNetTry: money(it.management_net_try),
      statutoryNetTry: money(it.statutory_net_try),
      deltaTry: money(it.delta_try),
      rootCauseCode: it.root_cause_code,
      severity: it.severity,
      explanation: it.explanation,
      candidateEvidence: Array.isArray(it.candidate_evidence_json)
        ? it.candidate_evidence_json
        : [],
      actionItemId: it.action_item_id,
    })),
    createdAt: r.created_at,
  };
}

/**
 * Creates a follow-up `action_items` task from a trial balance reconciliation discrepancy row.
 */
export async function createActionFromReconciliationItem(
  pool: Pool,
  reconciliationItemId: string,
  actorId: string,
): Promise<{ actionItemId: string }> {
  const client = await pool.connect();
  try {
    await client.query("begin");

    const itemRes = await client.query<{
      id: string;
      tdhp_group_code: string;
      tdhp_group_name: string;
      delta_try: string;
      root_cause_code: string;
      severity: string;
      explanation: string;
      action_item_id: string | null;
    }>(
      `select id::text,
              tdhp_group_code,
              tdhp_group_name,
              delta_try::text,
              root_cause_code,
              severity,
              explanation,
              action_item_id::text
         from public.trial_balance_reconciliation_items
        where id = $1
        for update`,
      [reconciliationItemId],
    );
    const it = itemRes.rows[0];
    if (!it) {
      throw new DomainError("NOT_FOUND", "Mutabakat fark kalemi bulunamadı.");
    }
    if (it.action_item_id) {
      await client.query("commit");
      return { actionItemId: it.action_item_id };
    }

    const taskSeverity =
      it.severity === "critical" ? "critical" : it.severity === "warning" ? "high" : "medium";
    const title = `[Mizan Köprüsü ${it.tdhp_group_code}] ${it.root_cause_code} (${it.delta_try} TRY)`;

    const actRes = await client.query<{ id: string }>(
      `insert into public.action_items
         (title, note, severity, status, source_type, related_entity_table, related_entity_id, created_by)
       values ($1, $2, $3, 'open', 'control', 'trial_balance_reconciliation_items', $4::uuid, $5)
       returning id::text`,
      [title, it.explanation, taskSeverity, reconciliationItemId, actorId],
    );
    const actionItemId = actRes.rows[0].id;

    await client.query(
      `update public.trial_balance_reconciliation_items
          set action_item_id = $1
        where id = $2`,
      [actionItemId, reconciliationItemId],
    );

    await audit(client, {
      actor: actorId,
      action: "trial_balance_reconciliation_task_created",
      entityTable: "trial_balance_reconciliation_items",
      entityId: reconciliationItemId,
      after: { actionItemId, tdhpGroupCode: it.tdhp_group_code, rootCauseCode: it.root_cause_code },
    });

    await client.query("commit");
    return { actionItemId };
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Generates the 3-sheet ExcelJS workbook buffer for the CPA ("Mali Müşavir Mutabakat Paketi (.xlsx)"):
 *   - `1_Ozet_Fark_Tablosu`
 *   - `2_Eksik_Belge_Kanit_Listesi`
 *   - `3_EBITDA_690_Koprusu`
 */
export async function buildCpaReconciliationPackBuffer(
  summary: ReconciliationRunSummary,
): Promise<Buffer> {
  const ExcelJSImport = await import("exceljs");
  const ExcelJS = ExcelJSImport.default ?? ExcelJSImport;
  const wb = new ExcelJS.Workbook();
  wb.creator = "MAS Nakit Radar";
  wb.created = new Date();

  // Sheet 1: 1_Ozet_Fark_Tablosu
  const ws1 = wb.addWorksheet("1_Ozet_Fark_Tablosu");
  ws1.columns = [
    { header: "TDHP Grup Kodu", key: "code", width: 16 },
    { header: "TDHP Hesap Grubu", key: "name", width: 42 },
    { header: "MAS Yönetim Defteri Net (TRY)", key: "mgmt", width: 24 },
    { header: "SMMM Yasal Mizan Net (TRY)", key: "stat", width: 24 },
    { header: "Fark (MAS - Yasal TRY)", key: "delta", width: 22 },
    { header: "Kök Neden Kodu (12 Sınıf)", key: "rootCause", width: 36 },
    { header: "Önem Derecesi", key: "severity", width: 14 },
    { header: "Teşhis ve Mutabakat Açıklaması", key: "explanation", width: 70 },
  ];
  for (const item of summary.items) {
    ws1.addRow({
      code: item.tdhpGroupCode,
      name: item.tdhpGroupName,
      mgmt: item.managementNetTry,
      stat: item.statutoryNetTry,
      delta: item.deltaTry,
      rootCause: item.rootCauseCode,
      severity: item.severity,
      explanation: item.explanation,
    });
  }

  // Sheet 2: 2_Eksik_Belge_Kanit_Listesi
  const ws2 = wb.addWorksheet("2_Eksik_Belge_Kanit_Listesi");
  ws2.columns = [
    { header: "TDHP Grubu", key: "groupCode", width: 16 },
    { header: "Kök Neden Kodu", key: "rootCause", width: 34 },
    { header: "MAS Kaynak Tablo", key: "entityTable", width: 24 },
    { header: "Belge / Bordro Referansı", key: "docRef", width: 24 },
    { header: "Belge Tarihi", key: "docDate", width: 16 },
    { header: "Tutar (TRY)", key: "amountTry", width: 18 },
    { header: "Açıklama", key: "summary", width: 55 },
  ];
  for (const item of summary.items) {
    for (const ev of item.candidateEvidence) {
      ws2.addRow({
        groupCode: item.tdhpGroupCode,
        rootCause: item.rootCauseCode,
        entityTable: ev.entityTable,
        docRef: ev.docRef,
        docDate: ev.docDate,
        amountTry: ev.amountTry,
        summary: ev.summary,
      });
    }
  }

  // Sheet 3: 3_EBITDA_690_Koprusu
  const ws3 = wb.addWorksheet("3_EBITDA_690_Koprusu");
  ws3.columns = [
    { header: "Köprü Adımı", key: "step", width: 52 },
    { header: "Tutar (TRY)", key: "amount", width: 22 },
  ];
  const b = summary.ebitdaTo690Bridge;
  ws3.addRow({ step: "1. MAS Yönetim EBITDA (Faaliyet Kârı + Amortisman)", amount: b.managementEbitdaTry });
  ws3.addRow({ step: "2. (-) MAS Amortisman ve İtfa Payları (770.99 / 257)", amount: -b.lessManagementDepreciationTry });
  ws3.addRow({ step: "3. (=) MAS Faaliyet Kârı (EBIT)", amount: b.managementEbitTry });
  ws3.addRow({ step: "4. (-) MAS Finansman Giderleri (780 Faiz + BSMV + KKDF)", amount: -b.lessManagementFinancingTry });
  ws3.addRow({ step: "5. (+) MAS Diğer Olağan Gelir / Gider Net (642-656)", amount: b.plusManagementOtherNetTry });
  ws3.addRow({ step: "6. (=) MAS Yönetim Vergi Öncesi Kârı (690 EBT)", amount: b.management690EbtTry });
  ws3.addRow({ step: "7. (+/-) Satış Gelirleri Dönemsellik / Kesim Farkı (600-619)", amount: b.revenueTimingGapTry });
  ws3.addRow({ step: "8. (+/-) Maliyet ve Faaliyet Giderleri Belge / Tahakkuk Farkı", amount: b.expenseTimingGapTry });
  ws3.addRow({ step: "9. (+/-) Finansman Gideri Kayıt Farkı (780)", amount: b.financingTimingGapTry });
  ws3.addRow({ step: "10. (+/-) Diğer Gelir/Gider & Yuvarlama Farkı", amount: b.unexplainedBridgeResidualTry });
  ws3.addRow({ step: "11. (=) SMMM Yasal Mizan 690 Dönem Kâr / Zararı", amount: b.statutory690EbtTry });

  const arrayBuffer = await wb.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer);
}

export interface SubAccountVknBridgeRow {
  accountCode: string;
  accountName: string;
  tdhpRootCode: "120" | "320";
  statutoryNetTry: number;
  matchedPartyId: string | null;
  matchedPartyName: string | null;
  matchedVkn: string | null;
  matchMethod: "vkn" | "name" | "unmatched";
  masOpenNetTry: number;
  deltaTry: number;
  aligned: boolean;
}

/**
 * M-63: Sub-account (`120.xx` / `320.xx`) ↔ Counterparty VKN & Normalized Name Reconciliation.
 * Matches leaf sub-accounts in the statutory CPA mizan against MAS `parties` + `counterparty_profiles.tax_number`
 * and compares statutory sub-account balance against MAS open TRY receivables/payables as of `asOfDate`.
 */
export async function loadSubAccountCounterpartyBridge(
  pool: Pool,
  statutoryTrialBalanceId: string,
  asOfDate: string,
): Promise<SubAccountVknBridgeRow[]> {
  const [linesRes, partiesRes] = await Promise.all([
    pool.query<{
      account_code: string;
      account_name: string;
      tdhp_root_code: "120" | "320";
      debit_total_try: string;
      credit_total_try: string;
    }>(
      `select account_code, account_name, tdhp_root_code::text as tdhp_root_code,
              debit_total_try::text, credit_total_try::text
         from public.statutory_trial_balance_lines
        where trial_balance_id = $1::uuid
          and is_leaf = true
          and tdhp_root_code in ('120', '320')
        order by account_code asc
        limit 250`,
      [statutoryTrialBalanceId],
    ),
    pool.query<{
      party_id: string;
      name: string;
      normalized_name: string;
      tax_number: string | null;
      open_ar_try: string;
      open_ap_try: string;
    }>(
      `select p.id::text as party_id,
              p.name,
              p.normalized_name,
              cp.tax_number,
              coalesce((
                select sum(greatest(coalesce(i.payable_amount, i.gross_amount) - i.allocated_amount, 0))
                  from public.invoices i
                 where i.party_id = p.id
                   and i.direction = 'sales'
                   and i.status in ('open', 'partial')
                   and i.currency = 'TRY'
                   and i.issue_date <= $1::date
              ), 0)::numeric(16,2)::text as open_ar_try,
              coalesce((
                select sum(greatest(coalesce(i.payable_amount, i.gross_amount) - i.allocated_amount, 0))
                  from public.invoices i
                 where i.party_id = p.id
                   and i.direction = 'purchase'
                   and i.status in ('open', 'partial')
                   and i.currency = 'TRY'
                   and i.issue_date <= $1::date
              ), 0)::numeric(16,2)::text as open_ap_try
         from public.parties p
         left join public.counterparty_profiles cp on cp.party_id = p.id
        where p.is_active = true`,
      [asOfDate],
    ),
  ]);

  const parties = partiesRes.rows.map((p) => ({
    partyId: p.party_id,
    name: p.name,
    norm: p.normalized_name,
    vkn: p.tax_number ? p.tax_number.replace(/\D+/g, "") : null,
    openArTry: money(p.open_ar_try),
    openApTry: money(p.open_ap_try),
  }));

  return linesRes.rows.map((line) => {
    const dr = money(line.debit_total_try);
    const cr = money(line.credit_total_try);
    const statutoryNetTry =
      line.tdhp_root_code === "120"
        ? Number(decimal(dr).minus(cr).round(2).toFixed(2))
        : Number(decimal(cr).minus(dr).round(2).toFixed(2));

    const combinedText = `${line.account_code} ${line.account_name}`;
    const vknCandidate = combinedText.match(/\b(\d{10,11})\b/)?.[1] ?? null;
    const normAccountName = line.account_name
      .toLocaleLowerCase("tr-TR")
      .replace(/\b(alıcılar|alicilar|satıcılar|saticilar|hesabı|hesabi|tic\.?|ltd\.?|şti\.?|a\.?ş\.?)\b/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    let matched = vknCandidate
      ? parties.find((p) => p.vkn && p.vkn === vknCandidate) ?? null
      : null;
    let matchMethod: "vkn" | "name" | "unmatched" = matched ? "vkn" : "unmatched";

    if (!matched && normAccountName.length >= 3) {
      matched =
        parties.find(
          (p) =>
            p.norm === normAccountName ||
            p.norm.includes(normAccountName) ||
            normAccountName.includes(p.norm),
        ) ?? null;
      if (matched) matchMethod = "name";
    }

    const masOpenNetTry = matched
      ? line.tdhp_root_code === "120"
        ? matched.openArTry
        : matched.openApTry
      : 0;
    const deltaTry = Number(decimal(masOpenNetTry).minus(statutoryNetTry).round(2).toFixed(2));

    return {
      accountCode: line.account_code,
      accountName: line.account_name,
      tdhpRootCode: line.tdhp_root_code,
      statutoryNetTry,
      matchedPartyId: matched?.partyId ?? null,
      matchedPartyName: matched?.name ?? null,
      matchedVkn: matched?.vkn ?? vknCandidate,
      matchMethod,
      masOpenNetTry,
      deltaTry,
      aligned: matched !== null && Math.abs(deltaTry) < 1,
    };
  });
}
