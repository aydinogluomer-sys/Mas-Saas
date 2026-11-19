// Faz 63 (M-58) — Yönetim Kurulu & Banka Finansal Paketi (Board & Bank Pack):
// 1. Yönetici Özeti (Executive Summary)
// 2. TDHP Gelir Tablosu (management_income_statement_v)
// 3. TDHP Bilanço (management_balance_sheet_v)
// 4. 13 Haftalık Likidite Özeti (Haftalık giriş/çıkış/kümülatif kasa)
// 5. Alacak / Borç Yaşlandırma (AR / AP Ageing)
// 6. Kredi Limitleri & Kovenant Marjı (Debt & Covenant Headroom)
//
// Çok sekmeli `.xlsx` (`exceljs`), yazdırılabilir HTML/PDF görünümü ve CSV ihracı üretir.
// Deterministik `Big.js` (`@/lib/money`); hiçbir finansal kaydı değiştirmez.

import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type {
  FinancialReportSnapshotContract,
  MonetaryEpistemicBasis,
  ReportConfidenceGrade,
} from "@/lib/contracts/remediation-contracts";
import { decimal, money, moneyOrNull, rateOrNull } from "@/lib/money";

export const REPORT_CALCULATION_VERSION = "mas-reports-v2.1";
export const WORKBOOK_STALE_THRESHOLD_DAYS = 45;

export interface ReportProvenance {
  snapshotId: string;
  asOfDate: string;
  asOfAt: string;
  schemaVersion: string | null;
  migrationCount: number | null;
  lastWorkbookImportAt: string | null;
  lastWorkbookFilename: string | null;
  workbookStaleDays: number | null;
  lastBankTxAt: string | null;
  contentSha256: string;
  /** Contract E (`FinancialReportSnapshotContract`) provenance & confidence metadata */
  calculationVersion: string;
  sourceFreshnessDays?: number | null;
  monetaryBasisByMetric: Record<string, MonetaryEpistemicBasis>;
  missingMaterialInputs: string[];
  reconciliationAligned?: boolean;
  controlAlertsOpenCount?: number;
  confidenceGrade: ReportConfidenceGrade;
}

export interface BoardIncomeStatementLine {
  code: string;
  label: string;
  amountTry: number | null;
  isSubtotal?: boolean;
}

export interface BoardBalanceSheetRow {
  accountCode: string;
  accountName: string;
  tdhpRootCode: string;
  section: "asset" | "liability" | "equity";
  amountTry: number;
  isDynamicNetIncome: boolean;
}

export interface BoardLiquidityWeekRow {
  weekNo: number;
  weekStart: string;
  weekEnd: string;
  openingCashTry: number | null;
  inflowTry: number;
  outflowTry: number;
  netFlowTry: number;
  closingCashTry: number | null;
}

export interface BoardAgeingBucketRow {
  bucket: string;
  arTry: number;
  apTry: number;
  netTry: number;
  arCount: number;
  apCount: number;
}

export interface BoardFacilityRow {
  name: string;
  facilityType: string;
  currency: string;
  totalLimitTry: number;
  drawnTry: number;
  availableTry: number;
}

export interface BoardCovenantRow {
  facilityName: string;
  metricName: string;
  operator: string;
  thresholdValue: number;
  observedValue: number | null;
  headroom: number | null;
  status: string;
  nextTestDate: string | null;
}

export interface BoardFinancialPackage {
  asOf: string;
  generatedAtISO: string;
  fxRatesAsOf: string | null;
  unknownOpeningAccountCount?: number;
  provenance?: ReportProvenance;
  executiveSummary: {
    consolidatedCashTry: number | null;
    netSalesTry: number | null;
    managementEbitdaTry: number | null;
    netIncomeTry: number | null;
    openArTry: number;
    openApTry: number;
    dsoDays: number | null;
    dioDays: number | null;
    dpoDays: number | null;
    cccDays: number | null;
    creditDrawnTry: number;
    creditAvailableTry: number;
    worst13WeekCashTry: number | null;
    covenantBreachCount: number;
  };
  incomeStatement: BoardIncomeStatementLine[];
  balanceSheet: {
    rows: BoardBalanceSheetRow[];
    totalAssetsTry: number;
    totalLiabilitiesTry: number;
    totalEquityTry: number;
    balanced: boolean;
    diffTry: number;
  };
  liquidity13Week: BoardLiquidityWeekRow[];
  ageing: BoardAgeingBucketRow[];
  facilities: BoardFacilityRow[];
  covenants: BoardCovenantRow[];
}

export function isBoardFinancialPackage(val: unknown): val is BoardFinancialPackage {
  if (!val || typeof val !== "object") return false;
  const candidate = val as Record<string, unknown>;
  return (
    typeof candidate.asOf === "string" &&
    candidate.executiveSummary !== null &&
    typeof candidate.executiveSummary === "object" &&
    Array.isArray(candidate.incomeStatement) &&
    candidate.balanceSheet !== null &&
    typeof candidate.balanceSheet === "object" &&
    Array.isArray(candidate.liquidity13Week) &&
    Array.isArray(candidate.ageing)
  );
}

export function computeContentSha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function isIgnorableProvenanceError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code;
  return code === "42P01" || code === "42703" || code === "42883" || code === "42501";
}

export interface EvaluateContractEInput {
  unknownOpeningAccountCount: number | null;
  knownOpeningAccountCount: number | null;
  hasVerifiedBankFeed: boolean;
  workbookStaleDays: number | null;
  hasValidWorkbookImport: boolean;
  missingPaymentAmountCount?: number;
  reconciliationAligned?: boolean;
  controlAlertsOpenCount?: number;
}

export function evaluateReportContractE(input: EvaluateContractEInput): {
  calculationVersion: string;
  monetaryBasisByMetric: Record<string, MonetaryEpistemicBasis>;
  missingMaterialInputs: string[];
  reconciliationAligned: boolean;
  controlAlertsOpenCount: number;
  confidenceGrade: ReportConfidenceGrade;
} {
  const unknownOpenings = input.unknownOpeningAccountCount;
  const knownOpenings = input.knownOpeningAccountCount;
  const availableBankCashBasis: MonetaryEpistemicBasis =
    unknownOpenings != null && unknownOpenings === 0 && (knownOpenings ?? 0) > 0
      ? "ACTUAL"
      : "UNKNOWN";
  const bankReconciledFlowsBasis: MonetaryEpistemicBasis = input.hasVerifiedBankFeed
    ? "RECONCILED"
    : "UNKNOWN";

  const monetaryBasisByMetric: Record<string, MonetaryEpistemicBasis> = {
    availableBankCash: availableBankCashBasis,
    scheduledOutflows: "PLANNED",
    workbookMonthlyCash: "FORECAST",
    bankReconciledFlows: bankReconciledFlowsBasis,
  };

  const missingMaterialInputs: string[] = [];
  if (unknownOpenings != null && unknownOpenings > 0) {
    missingMaterialInputs.push(
      `FIN-03: Nakit hesap açılış bakiyesi eksik (${unknownOpenings} aktif hesap)`,
    );
  } else if (availableBankCashBasis === "UNKNOWN") {
    missingMaterialInputs.push("FIN-03: Nakit hesap açılış bakiyesi doğrulanamadı");
  }

  if (!input.hasVerifiedBankFeed) {
    missingMaterialInputs.push("Banka ekstresi hareketi yok");
  }

  if (!input.hasValidWorkbookImport) {
    missingMaterialInputs.push("Geçerli çalışma kitabı içe aktarımı yok");
  } else if (
    input.workbookStaleDays != null &&
    input.workbookStaleDays > WORKBOOK_STALE_THRESHOLD_DAYS
  ) {
    missingMaterialInputs.push(
      `Çalışma kitabı > ${WORKBOOK_STALE_THRESHOLD_DAYS} gün eski (${input.workbookStaleDays} gün)`,
    );
  }

  if ((input.missingPaymentAmountCount ?? 0) > 0) {
    missingMaterialInputs.push(
      `Tutarı eksik açık yükümlülük var (${input.missingPaymentAmountCount} kalem)`,
    );
  }

  const reconciliationAligned = input.reconciliationAligned ?? true;
  if (!reconciliationAligned) {
    missingMaterialInputs.push("Finansal mutabakat farkı mevcut");
  }

  const isStaleSource =
    input.workbookStaleDays != null && input.workbookStaleDays > WORKBOOK_STALE_THRESHOLD_DAYS;

  let confidenceGrade: ReportConfidenceGrade;
  if (availableBankCashBasis === "UNKNOWN") {
    confidenceGrade = "UNVERIFIED_CASH_BASIS";
  } else if (isStaleSource) {
    confidenceGrade = "STALE_SOURCE_WARNING";
  } else if (missingMaterialInputs.length > 0 || !reconciliationAligned) {
    confidenceGrade = "PARTIAL_MISSING_INPUTS";
  } else {
    confidenceGrade = "VERIFIED_COMPLETE";
  }

  return {
    calculationVersion: REPORT_CALCULATION_VERSION,
    monetaryBasisByMetric,
    missingMaterialInputs,
    reconciliationAligned,
    controlAlertsOpenCount: Math.max(0, input.controlAlertsOpenCount ?? 0),
    confidenceGrade,
  };
}

export function toFinancialReportSnapshotContract(
  provenance: ReportProvenance,
): FinancialReportSnapshotContract {
  return {
    snapshotId: provenance.snapshotId,
    businessDateISO: provenance.asOfDate,
    snapshotCreatedAtISO: provenance.asOfAt,
    schemaVersion: provenance.schemaVersion ?? "unknown",
    calculationVersion: provenance.calculationVersion,
    sourceFreshnessDays: provenance.workbookStaleDays,
    monetaryBasisByMetric: provenance.monetaryBasisByMetric,
    missingMaterialInputs: provenance.missingMaterialInputs,
    reconciliationAligned: provenance.reconciliationAligned ?? true,
    controlAlertsOpenCount: provenance.controlAlertsOpenCount ?? 0,
    confidenceGrade: provenance.confidenceGrade,
    contentSha256: provenance.contentSha256,
  };
}

export interface LoadReportProvenanceOptions {
  snapshotId?: string;
  contentForHash?: string;
  asOfAt?: string;
  unknownOpeningAccountCount?: number;
  knownOpeningAccountCount?: number;
  missingPaymentAmountCount?: number;
  reconciliationAligned?: boolean;
  controlAlertsOpenCount?: number;
}

export async function loadReportProvenance(
  pool: Pick<Pool, "query"> | Pick<PoolClient, "query">,
  asOfDateISO: string,
  options: LoadReportProvenanceOptions = {},
): Promise<ReportProvenance> {
  const snapshotId = options.snapshotId ?? randomUUID();
  const asOfAt = options.asOfAt ?? new Date().toISOString();
  const contentSha256 = computeContentSha256(options.contentForHash ?? `${snapshotId}:${asOfDateISO}:${asOfAt}`);

  if (!pool || typeof pool.query !== "function") {
    const evaluated = evaluateReportContractE({
      unknownOpeningAccountCount: options.unknownOpeningAccountCount ?? null,
      knownOpeningAccountCount: options.knownOpeningAccountCount ?? null,
      hasVerifiedBankFeed: false,
      workbookStaleDays: null,
      hasValidWorkbookImport: false,
      missingPaymentAmountCount: options.missingPaymentAmountCount,
      reconciliationAligned: options.reconciliationAligned,
      controlAlertsOpenCount: options.controlAlertsOpenCount,
    });
    return {
      snapshotId,
      asOfDate: asOfDateISO,
      asOfAt,
      schemaVersion: null,
      migrationCount: null,
      lastWorkbookImportAt: null,
      lastWorkbookFilename: null,
      workbookStaleDays: null,
      lastBankTxAt: null,
      contentSha256,
      sourceFreshnessDays: null,
      ...evaluated,
    };
  }

  const needCashAccountsProbe =
    options.unknownOpeningAccountCount === undefined &&
    options.knownOpeningAccountCount === undefined;

  const [schemaRes, wbRes, btRes, cashDiagRes] = await Promise.all([
    pool
      .query<{ migration_count: number | string | null; latest_version: string | null }>(
        `select migration_count::int as migration_count, latest_version::text as latest_version
           from public.get_schema_ledger_summary()
          limit 1`,
      )
      .catch(async (err: unknown) => {
        if (!isIgnorableProvenanceError(err)) throw err;
        return pool
          .query<{ migration_count: number | string | null; latest_version: string | null }>(
            `select count(*)::int as migration_count, max(version)::text as latest_version
               from public.schema_migrations`,
          )
          .catch(() => ({ rows: [] as Array<{ migration_count: number | string | null; latest_version: string | null }> }));
      }),
    pool
      .query<{ last_wb_at: string | null; last_wb_date: string | null; last_wb_name: string | null }>(
        `select to_char(imported_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as last_wb_at,
                to_char((imported_at at time zone 'Europe/Istanbul')::date, 'YYYY-MM-DD') as last_wb_date,
                original_filename as last_wb_name
           from public.valid_workbook_imports
          order by imported_at desc nulls last
          limit 1`,
      )
      .catch(async (err: unknown) => {
        if (!isIgnorableProvenanceError(err)) throw err;
        return pool
          .query<{ last_wb_at: string | null; last_wb_date: string | null; last_wb_name: string | null }>(
            `select to_char(sw.imported_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as last_wb_at,
                    to_char((sw.imported_at at time zone 'Europe/Istanbul')::date, 'YYYY-MM-DD') as last_wb_date,
                    sw.original_filename as last_wb_name
               from public.source_workbooks sw
              where sw.status in ('parsed', 'mapped')
                and exists (
                  select 1
                    from public.import_rows ir
                   where ir.workbook_id = sw.id
                )
              order by sw.imported_at desc nulls last
              limit 1`,
          )
          .catch((fallbackErr: unknown) => {
            if (isIgnorableProvenanceError(fallbackErr)) {
              return { rows: [] as Array<{ last_wb_at: string | null; last_wb_date: string | null; last_wb_name: string | null }> };
            }
            throw fallbackErr;
          });
      }),
    pool
      .query<{ last_bt_at: string | null }>(
        `select to_char(max(txn_date), 'YYYY-MM-DD') as last_bt_at
           from public.bank_transactions
          where status <> 'ignored'
            and txn_date <= $1::date`,
        [asOfDateISO],
      )
      .catch((err: unknown) => {
        if (isIgnorableProvenanceError(err)) return { rows: [] as Array<{ last_bt_at: string | null }> };
        throw err;
      }),
    needCashAccountsProbe
      ? pool
          .query<{ unknown_opening_n?: number | string | null; known_opening_n?: number | string | null }>(
            `select count(*) filter (where opening_balance is null)::int as unknown_opening_n,
                    count(*) filter (where opening_balance is not null)::int as known_opening_n
               from public.cash_accounts
              where is_active = true
                and archived_at is null`,
          )
          .catch((err: unknown) => {
            if (isIgnorableProvenanceError(err)) {
              return { rows: [] as Array<{ unknown_opening_n?: number | string | null; known_opening_n?: number | string | null }> };
            }
            throw err;
          })
      : Promise.resolve({ rows: [] as Array<{ unknown_opening_n?: number | string | null; known_opening_n?: number | string | null }> }),
  ]);

  const schemaRow = schemaRes?.rows?.[0];
  const wbRow = wbRes?.rows?.[0];
  const btRow = btRes?.rows?.[0];
  const cashDiagRow = cashDiagRes?.rows?.[0];

  const migrationCount =
    schemaRow?.migration_count != null && Number.isFinite(Number(schemaRow.migration_count))
      ? Number(schemaRow.migration_count)
      : null;
  const schemaVersion =
    typeof schemaRow?.latest_version === "string" && schemaRow.latest_version.length > 0
      ? schemaRow.latest_version
      : null;
  const lastWorkbookImportAt =
    typeof wbRow?.last_wb_at === "string" && wbRow.last_wb_at.length > 0 ? wbRow.last_wb_at : null;
  const lastWorkbookFilename =
    typeof wbRow?.last_wb_name === "string" && wbRow.last_wb_name.length > 0 ? wbRow.last_wb_name : null;
  const lastWbDate =
    typeof wbRow?.last_wb_date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(wbRow.last_wb_date)
      ? wbRow.last_wb_date
      : null;

  let workbookStaleDays: number | null = null;
  if (lastWbDate && /^\d{4}-\d{2}-\d{2}$/.test(asOfDateISO)) {
    const diffMs = Date.parse(`${asOfDateISO}T00:00:00Z`) - Date.parse(`${lastWbDate}T00:00:00Z`);
    if (Number.isFinite(diffMs)) {
      workbookStaleDays = Math.max(0, Math.round(diffMs / 86_400_000));
    }
  }

  const lastBankTxAt =
    typeof btRow?.last_bt_at === "string" && btRow.last_bt_at.length > 0 ? btRow.last_bt_at : null;

  const resolvedUnknownOpeningCount =
    options.unknownOpeningAccountCount !== undefined
      ? options.unknownOpeningAccountCount
      : cashDiagRow && (cashDiagRow.unknown_opening_n !== undefined || cashDiagRow.known_opening_n !== undefined)
        ? Number(cashDiagRow.unknown_opening_n ?? 0)
        : null;
  const resolvedKnownOpeningCount =
    options.knownOpeningAccountCount !== undefined
      ? options.knownOpeningAccountCount
      : cashDiagRow && (cashDiagRow.unknown_opening_n !== undefined || cashDiagRow.known_opening_n !== undefined)
        ? Number(cashDiagRow.known_opening_n ?? 0)
        : options.unknownOpeningAccountCount === 0
          ? 1
          : null;

  const evaluated = evaluateReportContractE({
    unknownOpeningAccountCount: resolvedUnknownOpeningCount,
    knownOpeningAccountCount: resolvedKnownOpeningCount,
    hasVerifiedBankFeed: lastBankTxAt !== null,
    workbookStaleDays,
    hasValidWorkbookImport: lastWorkbookImportAt !== null,
    missingPaymentAmountCount: options.missingPaymentAmountCount,
    reconciliationAligned: options.reconciliationAligned,
    controlAlertsOpenCount: options.controlAlertsOpenCount,
  });

  return {
    snapshotId,
    asOfDate: asOfDateISO,
    asOfAt,
    schemaVersion,
    migrationCount,
    lastWorkbookImportAt,
    lastWorkbookFilename,
    workbookStaleDays,
    lastBankTxAt,
    contentSha256,
    sourceFreshnessDays: workbookStaleDays,
    ...evaluated,
  };
}

function isMissingRelation(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const code = (err as { code?: unknown }).code;
  return code === "42P01" || code === "42703";
}

function addDaysISO(iso: string, days: number): string {
  const ms = Date.parse(`${iso}T00:00:00Z`) + days * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

function fmtTl(val: number | null | undefined): string {
  if (val == null || !Number.isFinite(val)) return "—";
  return `${new Intl.NumberFormat("tr-TR", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(val)} TL`;
}

function escapeHtml(raw: string): string {
  return raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export async function loadBoardFinancialPackage(
  pool: Pool,
  asOf: string,
): Promise<BoardFinancialPackage> {
  const horizonEnd = addDaysISO(asOf, 91);

  const [fxRes, cashRes, isRes, bsRes, wcRes, liqRes, invRes, facRes, covRes] =
    await Promise.all([
      pool
        .query<{ base_currency: string; rate: string; rate_date: string }>(
          `select distinct on (base_currency)
                  base_currency,
                  rate::text as rate,
                  to_char(rate_date, 'YYYY-MM-DD') as rate_date
             from public.fx_rate_snapshots
            where quote_currency = 'TRY' and rate_date <= $1::date
            order by base_currency, rate_date desc, id desc`,
          [asOf],
        )
        .catch((err: unknown) => {
          if (isMissingRelation(err)) return { rows: [] };
          throw err;
        }),
      pool
        .query<{ currency: string; bal: string | null; known_n: number; unknown_opening_n: number }>(
          `select ca.currency,
                  count(*) filter (where ca.opening_balance is not null)::int as known_n,
                  count(*) filter (where ca.opening_balance is null)::int as unknown_opening_n,
                  case
                    when ca.opening_balance is null then null::text
                    else (ca.opening_balance + coalesce((
                      select sum(bt.amount)
                        from public.bank_transactions bt
                        join public.bank_accounts ba on ba.cash_account_id = ca.id and bt.bank_account_id = ba.cash_account_id
                       where bt.status <> 'ignored'
                         and bt.txn_date <= $1::date
                         and coalesce(bt.currency, ca.currency) = ca.currency
                    ), 0))::text
                  end as bal
             from public.cash_accounts ca
            where ca.is_active = true and ca.archived_at is null
            group by ca.id, ca.currency, ca.opening_balance`,
          [asOf],
        )
        .catch((err: unknown) => {
          if (isMissingRelation(err)) {
            return { rows: [] as Array<{ currency: string; bal: string | null; known_n: number; unknown_opening_n: number }> };
          }
          throw err;
        }),
      pool
        .query<{
          gross_sales_try: string | null;
          sales_discounts_try: string | null;
          net_sales_try: string | null;
          cogs_try: string | null;
          gross_profit_try: string | null;
          opex_total_try: string | null;
          da_addback_try: string | null;
          ebit_try: string | null;
          management_ebitda_try: string | null;
          financing_expense_try: string | null;
          tax_expense_try: string | null;
          net_income_try: string | null;
        }>(`select * from public.management_income_statement_v limit 1`)
        .catch((err: unknown) => {
          if (isMissingRelation(err)) return { rows: [] };
          throw err;
        }),
      pool
        .query<{
          account_code: string;
          account_name: string;
          tdhp_root_code: string;
          section: "asset" | "liability" | "equity";
          amount_try: string;
          is_dynamic_net_income: boolean;
        }>(
          `select account_code, account_name, tdhp_root_code, section,
                  amount_try::text as amount_try, is_dynamic_net_income
             from public.management_balance_sheet_v
            order by account_code`,
        )
        .catch((err: unknown) => {
          if (isMissingRelation(err)) return { rows: [] };
          throw err;
        }),
      pool
        .query<{
          dso_days: string | null;
          dio_days: string | null;
          dpo_days: string | null;
          cash_conversion_cycle_days: string | null;
          cash_cycle_excluding_inventory: string | null;
        }>(
          `select dso_days::text, dio_days::text, dpo_days::text,
                  cash_conversion_cycle_days::text, cash_cycle_excluding_inventory::text
             from public.working_capital_metrics limit 1`,
        )
        .catch((err: unknown) => {
          if (isMissingRelation(err)) return { rows: [] };
          throw err;
        }),
      pool
        .query<{ due_date: string; direction: string; currency: string; amt: string }>(
          `select * from (
             select to_char(pi.due_date, 'YYYY-MM-DD') as due_date,
                    coalesce(pi.direction, 'outflow') as direction,
                    pi.currency,
                    greatest(0, coalesce(pi.amount, 0) - coalesce(pi.paid_amount, 0))::text as amt
               from public.payment_instances pi
               left join public.payments p on p.id = pi.payment_id
              where pi.status in ('planned', 'unpaid', 'partial', 'late')
                and (p.id is null or (p.status = 'active' and p.archived_at is null))
                and pi.due_date >= $1::date and pi.due_date < $2::date
                and pi.amount is not null
             union all
             select to_char(v.due_date, 'YYYY-MM-DD') as due_date,
                    case when v.direction = 'sales' then 'inflow' else 'outflow' end as direction,
                    v.currency,
                    greatest(0, coalesce(v.payable_amount, v.gross_amount) - greatest(coalesce(v.allocated_amount, 0), coalesce(v.paid_amount, 0)))::text as amt
               from public.invoices v
              where v.status in ('open', 'partial')
                and v.archived_at is null
                and v.bad_debt_at is null
                and v.settled_by_check_id is null
                and (v.issue_date is null or v.issue_date <= $1::date)
                and v.due_date >= $1::date and v.due_date < $2::date
             union all
             select to_char(c.maturity_date, 'YYYY-MM-DD') as due_date,
                    c.direction,
                    c.currency,
                    abs(c.amount)::text as amt
               from public.checks c
              where c.archived_at is null
                and c.status in ('planned', 'issued_to_vendor', 'portfolio', 'in_bank_collection')
                and c.maturity_date >= $1::date and c.maturity_date < $2::date
             union all
             select to_char(li.due_date, 'YYYY-MM-DD') as due_date,
                    'outflow'::text as direction,
                    l.currency,
                    li.amount::text as amt
               from public.loan_installments li
               join public.loans l on l.id = li.loan_id
              where l.archived_at is null
                and li.status in ('planned', 'unpaid', 'partial', 'late')
                and li.due_date >= $1::date and li.due_date < $2::date
           ) f`,
          [asOf, horizonEnd],
        )
        .catch((err: unknown) => {
          if (isMissingRelation(err)) return { rows: [] };
          throw err;
        }),
      pool
        .query<{ direction: string; currency: string; due_date: string | null; rem: string }>(
          `select v.direction,
                  v.currency,
                  to_char(v.due_date, 'YYYY-MM-DD') as due_date,
                  greatest(0, coalesce(v.payable_amount, v.gross_amount) - greatest(coalesce(v.allocated_amount, 0), coalesce(v.paid_amount, 0)))::text as rem
             from public.invoices v
            where v.status in ('open', 'partial')
              and v.archived_at is null
              and v.bad_debt_at is null
              and v.settled_by_check_id is null
              and (v.issue_date is null or v.issue_date <= $1::date)`,
          [asOf],
        )
        .catch((err: unknown) => {
          if (isMissingRelation(err)) return { rows: [] };
          throw err;
        }),
      pool
        .query<{
          name: string;
          facility_type: string;
          currency: string;
          total_limit: string | null;
          drawn_amount: string | null;
          available_amount: string | null;
        }>(
          `select name, facility_type, currency,
                  total_limit::text, drawn_amount::text, available_amount::text
             from public.credit_facility_utilization
            where status = 'active'
            order by name`,
        )
        .catch((err: unknown) => {
          if (isMissingRelation(err)) return { rows: [] };
          throw err;
        }),
      pool
        .query<{
          facility_name: string | null;
          metric_name: string;
          operator: string;
          threshold_value: string;
          observed_value: string | null;
          status: string;
          next_test_date: string | null;
        }>(
          `select coalesce(cf.name, l.name) as facility_name,
                  coalesce(nullif(btrim(cr.description), ''), cr.covenant_type) as metric_name,
                  cr.comparison as operator,
                  cr.threshold_value::text,
                  cr.last_test_value::text as observed_value,
                  coalesce(cr.last_test_result, cr.status) as status,
                  to_char(cr.last_test_date, 'YYYY-MM-DD') as next_test_date
             from public.covenant_records cr
             left join public.credit_facilities cf on cf.id = cr.facility_id
             left join public.loans l on l.id = cr.loan_id
            where cr.status = 'active'
            order by cr.last_test_date desc nulls last, cr.covenant_type`,
        )
        .catch((err: unknown) => {
          if (isMissingRelation(err)) return { rows: [] };
          throw err;
        }),
    ]);

  const fxMap = new Map<string, number>([["TRY", 1]]);
  let fxRatesAsOf: string | null = null;
  for (const r of fxRes.rows) {
    const parsed = rateOrNull(r.rate);
    if (parsed != null && parsed > 0) {
      fxMap.set(r.base_currency.toUpperCase(), parsed);
      if (!fxRatesAsOf || r.rate_date > fxRatesAsOf) fxRatesAsOf = r.rate_date;
    }
  }

  const unknownOpeningAccountCount = cashRes.rows.reduce(
    (sum, c) => sum + Number(c.unknown_opening_n ?? 0),
    0,
  );
  const knownOpeningAccountCount = cashRes.rows.reduce(
    (sum, c) => sum + Number(c.known_n ?? 0),
    0,
  );
  let cashKnown = false;
  let cashDec = decimal(0);
  if (unknownOpeningAccountCount === 0) {
    for (const c of cashRes.rows) {
      if (c.known_n === 0) continue;
      const rate = fxMap.get(c.currency.toUpperCase());
      if (!rate || c.bal == null) {
        cashKnown = false;
        break;
      }
      cashKnown = true;
      cashDec = cashDec.plus(decimal(c.bal).times(decimal(rate)));
    }
  }
  const consolidatedCashTry =
    unknownOpeningAccountCount > 0 || !cashKnown ? null : money(cashDec.toString());

  const isRow = isRes.rows[0];
  const incomeStatement: BoardIncomeStatementLine[] = [
    { code: "600", label: "Brüt Satışlar", amountTry: moneyOrNull(isRow?.gross_sales_try) },
    { code: "610-612", label: "Satıştan İadeler ve İskontolar (-)", amountTry: moneyOrNull(isRow?.sales_discounts_try) },
    { code: "NET_SALES", label: "Net Satışlar", amountTry: moneyOrNull(isRow?.net_sales_try), isSubtotal: true },
    { code: "620-622", label: "Satılan Malın / Hizmetin Maliyeti (-)", amountTry: moneyOrNull(isRow?.cogs_try) },
    { code: "GROSS_PROFIT", label: "Brüt Satış Kârı / Zararı", amountTry: moneyOrNull(isRow?.gross_profit_try), isSubtotal: true },
    { code: "630-632", label: "Faaliyet Giderleri (OPEX) (-)", amountTry: moneyOrNull(isRow?.opex_total_try) },
    { code: "EBIT", label: "Faaliyet Kârı (EBIT)", amountTry: moneyOrNull(isRow?.ebit_try), isSubtotal: true },
    { code: "DA", label: "Amortisman ve İtfa Payları (+)", amountTry: moneyOrNull(isRow?.da_addback_try) },
    { code: "EBITDA", label: "Yönetim FAVÖK (Management EBITDA)", amountTry: moneyOrNull(isRow?.management_ebitda_try), isSubtotal: true },
    { code: "660-661", label: "Finansman Giderleri (-)", amountTry: moneyOrNull(isRow?.financing_expense_try) },
    { code: "691", label: "Dönem Vergi ve Yasal Yükümlülük Karşılıkları (-)", amountTry: moneyOrNull(isRow?.tax_expense_try) },
    { code: "692", label: "Dönem Net Kârı / Zararı", amountTry: moneyOrNull(isRow?.net_income_try), isSubtotal: true },
  ];

  let assetsDec = decimal(0);
  let liabDec = decimal(0);
  let eqDec = decimal(0);
  const bsRows: BoardBalanceSheetRow[] = bsRes.rows.map((r) => {
    const amt = moneyOrNull(r.amount_try) ?? 0;
    if (r.section === "asset") assetsDec = assetsDec.plus(decimal(amt));
    else if (r.section === "liability") liabDec = liabDec.plus(decimal(amt));
    else eqDec = eqDec.plus(decimal(amt));
    return {
      accountCode: r.account_code,
      accountName: r.account_name,
      tdhpRootCode: r.tdhp_root_code,
      section: r.section,
      amountTry: amt,
      isDynamicNetIncome: Boolean(r.is_dynamic_net_income),
    };
  });
  const totalAssetsTry = money(assetsDec.toString());
  const totalLiabilitiesTry = money(liabDec.toString());
  const totalEquityTry = money(eqDec.toString());
  const bsDiffDec = assetsDec.minus(liabDec.plus(eqDec));
  const bsBalanced = bsDiffDec.abs().lte(decimal("0.05"));

  // 13-week liquidity
  const liquidity13Week: BoardLiquidityWeekRow[] = [];
  let runningCashDec = consolidatedCashTry != null ? decimal(consolidatedCashTry) : null;
  let worst13Dec = runningCashDec;

  for (let w = 0; w < 13; w++) {
    const wStart = addDaysISO(asOf, w * 7);
    const wEnd = addDaysISO(asOf, w * 7 + 6);
    const wEndExcl = addDaysISO(asOf, (w + 1) * 7);
    let inDec = decimal(0);
    let outDec = decimal(0);

    for (const f of liqRes.rows) {
      if (f.due_date < wStart || f.due_date >= wEndExcl) continue;
      const rate = fxMap.get(f.currency.toUpperCase());
      const amt = moneyOrNull(f.amt);
      if (!rate || amt == null || amt <= 0) continue;
      const tryVal = decimal(amt).times(decimal(rate));
      if (f.direction === "inflow") inDec = inDec.plus(tryVal);
      else outDec = outDec.plus(tryVal);
    }

    const netDec = inDec.minus(outDec);
    const openTry = runningCashDec ? money(runningCashDec.toString()) : null;
    if (runningCashDec) {
      runningCashDec = runningCashDec.plus(netDec);
      if (!worst13Dec || runningCashDec.lt(worst13Dec)) worst13Dec = runningCashDec;
    }
    const closeTry = runningCashDec ? money(runningCashDec.toString()) : null;

    liquidity13Week.push({
      weekNo: w + 1,
      weekStart: wStart,
      weekEnd: wEnd,
      openingCashTry: openTry,
      inflowTry: money(inDec.toString()),
      outflowTry: money(outDec.toString()),
      netFlowTry: money(netDec.toString()),
      closingCashTry: closeTry,
    });
  }

  // AR/AP Ageing
  const bucketDefs = [
    { key: "current", label: "Güncel (Vadesi Gelmemiş)" },
    { key: "1_30", label: "1–30 Gün Gecikmiş" },
    { key: "31_60", label: "31–60 Gün Gecikmiş" },
    { key: "61_90", label: "61–90 Gün Gecikmiş" },
    { key: "90_plus", label: "90+ Gün Gecikmiş" },
  ];
  const ageingMap = new Map(
    bucketDefs.map((b) => [
      b.key,
      { label: b.label, arDec: decimal(0), apDec: decimal(0), arCount: 0, apCount: 0 },
    ]),
  );
  let openArDec = decimal(0);
  let openApDec = decimal(0);

  for (const inv of invRes.rows) {
    const rate = fxMap.get(inv.currency.toUpperCase());
    const rem = moneyOrNull(inv.rem);
    if (!rate || rem == null || rem <= 0) continue;
    const tryAmt = decimal(rem).times(decimal(rate));
    const daysPastDue = inv.due_date
      ? Math.round((Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${inv.due_date}T00:00:00Z`)) / 86_400_000)
      : 0;
    const bKey =
      daysPastDue <= 0
        ? "current"
        : daysPastDue <= 30
          ? "1_30"
          : daysPastDue <= 60
            ? "31_60"
            : daysPastDue <= 90
              ? "61_90"
              : "90_plus";
    const bucket = ageingMap.get(bKey)!;
    if (inv.direction === "sales") {
      bucket.arDec = bucket.arDec.plus(tryAmt);
      bucket.arCount += 1;
      openArDec = openArDec.plus(tryAmt);
    } else {
      bucket.apDec = bucket.apDec.plus(tryAmt);
      bucket.apCount += 1;
      openApDec = openApDec.plus(tryAmt);
    }
  }

  const ageing: BoardAgeingBucketRow[] = bucketDefs.map((b) => {
    const item = ageingMap.get(b.key)!;
    return {
      bucket: item.label,
      arTry: money(item.arDec.toString()),
      apTry: money(item.apDec.toString()),
      netTry: money(item.arDec.minus(item.apDec).toString()),
      arCount: item.arCount,
      apCount: item.apCount,
    };
  });

  // Facilities & Covenants
  let creditDrawnDec = decimal(0);
  let creditAvailDec = decimal(0);
  const facilities: BoardFacilityRow[] = facRes.rows.map((f) => {
    const rate = fxMap.get(f.currency.toUpperCase()) ?? 1;
    const limTry = money(decimal(moneyOrNull(f.total_limit) ?? 0).times(decimal(rate)).toString());
    const drwTry = money(decimal(moneyOrNull(f.drawn_amount) ?? 0).times(decimal(rate)).toString());
    const avlTry = money(decimal(moneyOrNull(f.available_amount) ?? 0).times(decimal(rate)).toString());
    creditDrawnDec = creditDrawnDec.plus(decimal(drwTry));
    creditAvailDec = creditAvailDec.plus(decimal(avlTry));
    return {
      name: f.name,
      facilityType: f.facility_type,
      currency: f.currency,
      totalLimitTry: limTry,
      drawnTry: drwTry,
      availableTry: avlTry,
    };
  });

  let covenantBreachCount = 0;
  const covenants: BoardCovenantRow[] = covRes.rows.map((c) => {
    const thr = rateOrNull(c.threshold_value) ?? 0;
    const obs = rateOrNull(c.observed_value);
    if (c.status === "breach" || c.status === "breached") covenantBreachCount += 1;
    const headroom =
      obs == null
        ? null
        : c.operator.includes("<")
          ? Number(decimal(thr).minus(decimal(obs)).toFixed(2))
          : Number(decimal(obs).minus(decimal(thr)).toFixed(2));
    return {
      facilityName: c.facility_name ?? "Genel Kurumsal Kovenant",
      metricName: c.metric_name,
      operator: c.operator,
      thresholdValue: thr,
      observedValue: obs,
      headroom,
      status: c.status,
      nextTestDate: c.next_test_date,
    };
  });

  const wc = wcRes.rows[0];
  const generatedAtISO = new Date().toISOString();
  const basePackage: BoardFinancialPackage = {
    asOf,
    generatedAtISO,
    fxRatesAsOf,
    unknownOpeningAccountCount,
    executiveSummary: {
      consolidatedCashTry,
      netSalesTry: moneyOrNull(isRow?.net_sales_try),
      managementEbitdaTry: moneyOrNull(isRow?.management_ebitda_try),
      netIncomeTry: moneyOrNull(isRow?.net_income_try),
      openArTry: money(openArDec.toString()),
      openApTry: money(openApDec.toString()),
      dsoDays: rateOrNull(wc?.dso_days),
      dioDays: rateOrNull(wc?.dio_days),
      dpoDays: rateOrNull(wc?.dpo_days),
      cccDays:
        rateOrNull(wc?.cash_conversion_cycle_days) ??
        rateOrNull(wc?.cash_cycle_excluding_inventory),
      creditDrawnTry: money(creditDrawnDec.toString()),
      creditAvailableTry: money(creditAvailDec.toString()),
      worst13WeekCashTry: worst13Dec ? money(worst13Dec.toString()) : null,
      covenantBreachCount,
    },
    incomeStatement,
    balanceSheet: {
      rows: bsRows,
      totalAssetsTry,
      totalLiabilitiesTry,
      totalEquityTry,
      balanced: bsBalanced,
      diffTry: money(bsDiffDec.toString()),
    },
    liquidity13Week,
    ageing,
    facilities,
    covenants,
  };

  const provenance = await loadReportProvenance(pool, asOf, {
    asOfAt: generatedAtISO,
    unknownOpeningAccountCount,
    knownOpeningAccountCount,
    reconciliationAligned: bsBalanced,
    controlAlertsOpenCount: covenantBreachCount,
    contentForHash: JSON.stringify({
      asOf,
      executiveSummary: basePackage.executiveSummary,
      balanceSheet: {
        totalAssetsTry,
        totalLiabilitiesTry,
        totalEquityTry,
      },
    }),
  });

  return {
    ...basePackage,
    provenance,
  };
}

function fmtCashOrFin03(val: number | null | undefined, unknownOpeningCount?: number): string {
  if (val == null) {
    return (unknownOpeningCount ?? 0) > 0 ? "Bilinmiyor (FIN-03 açılış eksik)" : "—";
  }
  return fmtTl(val);
}

export function renderBoardPackMarkdown(pack: BoardFinancialPackage): string {
  const s = pack.executiveSummary;
  const prov = pack.provenance;
  const lines: string[] = [];
  lines.push(`# YÖNETİM KURULU VE BANKA FİNANSAL PAKETİ — ${pack.asOf}`);
  lines.push(`TCMB Kur Bazı: ${pack.fxRatesAsOf ?? "Yerel TRY"}`);
  if (prov) {
    const staleNote =
      prov.workbookStaleDays != null
        ? `${prov.workbookStaleDays} gün eski`
        : "yok";
    lines.push(
      `Veri Kaynağı Kanıtı: snapshot=${prov.snapshotId.slice(0, 8)} · şema=${prov.schemaVersion ?? "—"} · sürüm=${prov.calculationVersion} · güven=${prov.confidenceGrade} · son Excel=${staleNote} · son ekstre=${prov.lastBankTxAt ?? "yok"}`,
    );
    if (prov.missingMaterialInputs.length > 0) {
      lines.push(`Veri Kısıtları: ${prov.missingMaterialInputs.join(" · ")}`);
    }
  }
  lines.push("");
  lines.push("## 1. YÖNETİCİ ÖZETİ (EXECUTIVE SUMMARY)");
  lines.push(
    `- Konsolide Hazır Değerler (Kasa + Banka) [${s.consolidatedCashTry == null ? "UNKNOWN" : "ACTUAL"}]: ${fmtCashOrFin03(s.consolidatedCashTry, pack.unknownOpeningAccountCount)}`,
  );
  lines.push(
    `- 13 Haftalık En Düşük Kasa Projeksiyonu [${s.worst13WeekCashTry == null ? "UNKNOWN" : "FORECAST"}]: ${fmtCashOrFin03(s.worst13WeekCashTry, pack.unknownOpeningAccountCount)}`,
  );
  lines.push(`- TDHP Net Satışlar: ${fmtTl(s.netSalesTry)}`);
  lines.push(`- Yönetim FAVÖK (EBITDA): ${fmtTl(s.managementEbitdaTry)}`);
  lines.push(`- Dönem Net Kârı / Zararı: ${fmtTl(s.netIncomeTry)}`);
  lines.push(`- Açık Ticari Alacaklar (120): ${fmtTl(s.openArTry)} · Açık Ticari Borçlar (320): ${fmtTl(s.openApTry)}`);
  lines.push(
    `- İşletme Sermayesi Döngüsü: DSO ${s.dsoDays ?? "—"}g · DIO ${s.dioDays ?? "—"}g · DPO ${s.dpoDays ?? "—"}g · CCC ${s.cccDays ?? "—"}g`,
  );
  lines.push(
    `- Aktif Kredi Kullanımı: ${fmtTl(s.creditDrawnTry)} · Kullanılabilir Boş Kredi Limiti: ${fmtTl(s.creditAvailableTry)}`,
  );
  lines.push(`- Kovenant İhlal Sayısı: ${s.covenantBreachCount}`);
  lines.push("");

  lines.push("## 2. TDHP ÖZET GELİR TABLOSU");
  for (const row of pack.incomeStatement) {
    lines.push(`${row.isSubtotal ? "**" : "- "}${row.code} ${row.label}: ${fmtTl(row.amountTry)}${row.isSubtotal ? "**" : ""}`);
  }
  lines.push("");

  lines.push("## 3. TDHP BİLANÇO DENGESİ");
  lines.push(`- Toplam Aktifler (Varlıklar): ${fmtTl(pack.balanceSheet.totalAssetsTry)}`);
  lines.push(`- Toplam Yabancı Kaynaklar (Borçlar): ${fmtTl(pack.balanceSheet.totalLiabilitiesTry)}`);
  lines.push(`- Toplam Özkaynaklar: ${fmtTl(pack.balanceSheet.totalEquityTry)}`);
  lines.push(
    `- Aktif = Pasif Dengesi: ${pack.balanceSheet.balanced ? "TAM MUTABIK" : `Fark: ${fmtTl(pack.balanceSheet.diffTry)}`}`,
  );
  lines.push("");

  lines.push("## 4. 13 HAFTALIK LİKİDİTE PROJEKSİYONU");
  for (const w of pack.liquidity13Week) {
    lines.push(
      `- H${String(w.weekNo).padStart(2, "0")} (${w.weekStart}..${w.weekEnd}): Giriş ${fmtTl(w.inflowTry)} | Çıkış ${fmtTl(w.outflowTry)} | Net ${fmtTl(w.netFlowTry)} | Kapanış ${fmtTl(w.closingCashTry)}`,
    );
  }
  lines.push("");

  lines.push("## 5. ALACAK VE BORÇ YAŞLANDIRMA (AR / AP AGEING)");
  for (const a of pack.ageing) {
    lines.push(
      `- ${a.bucket}: Alacak ${fmtTl(a.arTry)} (${a.arCount} ad.) | Borç ${fmtTl(a.apTry)} (${a.apCount} ad.) | Net ${fmtTl(a.netTry)}`,
    );
  }
  lines.push("");

  lines.push("## 6. KREDİ LİMİTLERİ VE KOVENANT MARJI (HEADROOM)");
  if (pack.facilities.length === 0) {
    lines.push("- Aktif kredi limiti kaydı bulunmuyor.");
  } else {
    for (const f of pack.facilities) {
      lines.push(
        `- ${f.name} (${f.facilityType} / ${f.currency}): Limit ${fmtTl(f.totalLimitTry)} | Kullanılan ${fmtTl(f.drawnTry)} | Boş Limit ${fmtTl(f.availableTry)}`,
      );
    }
  }
  if (pack.covenants.length > 0) {
    for (const c of pack.covenants) {
      lines.push(
        `- Kovenant [${c.facilityName}] ${c.metricName} (${c.operator} ${c.thresholdValue}): Gözlenen ${c.observedValue ?? "—"} | Marj ${c.headroom ?? "—"} | Durum: ${c.status.toUpperCase()}`,
      );
    }
  }

  return lines.join("\n");
}

export async function buildBoardPackExcelBuffer(
  reportMeta: { id: string; report_type: string; period_start: string; period_end: string; body_md: string },
  pack: BoardFinancialPackage,
): Promise<Buffer> {
  const ExcelJSImport = await import("exceljs");
  const ExcelJS = ExcelJSImport.default ?? ExcelJSImport;
  const wb = new ExcelJS.Workbook();
  wb.creator = "MAS Finansal İşletim Sistemi";
  wb.created = new Date();

  const numFmt = "#,##0.00";

  // 1. Özet
  const wsOzet = wb.addWorksheet("Özet");
  wsOzet.columns = [
    { header: "Gösterge", key: "metric", width: 44 },
    { header: "Değer", key: "val", width: 24 },
    { header: "Birim / Not", key: "note", width: 38 },
  ];
  wsOzet.getRow(1).font = { bold: true };
  const s = pack.executiveSummary;
  const summaryRows: Array<{ metric: string; val: number | string | null; note: string }> = [
    { metric: "Rapor Tarihi (As-Of)", val: pack.asOf, note: `Rapor Tipi: ${reportMeta.report_type}` },
    ...(pack.provenance
      ? [
          {
            metric: "Anlık Görüntü Kimliği (Snapshot ID)",
            val: pack.provenance.snapshotId,
            note: `Şema: ${pack.provenance.schemaVersion ?? "—"} · Üretim: ${pack.provenance.asOfAt}`,
          },
          {
            metric: "Son Çalışma Kitabı İthalatı",
            val: pack.provenance.lastWorkbookImportAt ?? "Yok",
            note:
              pack.provenance.workbookStaleDays != null
                ? `${pack.provenance.workbookStaleDays} gün eski`
                : "İthalat kaydı yok",
          },
          {
            metric: "Son Banka Hareketi Tarihi",
            val: pack.provenance.lastBankTxAt ?? "Ekstre yok",
            note: `SHA-256: ${pack.provenance.contentSha256.slice(0, 16)}`,
          },
          {
            metric: "Güven Derecesi (Confidence Grade)",
            val: pack.provenance.confidenceGrade,
            note: `Sürüm: ${pack.provenance.calculationVersion}`,
          },
        ]
      : []),
    {
      metric: "Konsolide Hazır Değerler (Kasa + Banka)",
      val:
        s.consolidatedCashTry ??
        ((pack.unknownOpeningAccountCount ?? 0) > 0 ? "Bilinmiyor (FIN-03)" : "—"),
      note: `TCMB Kur: ${pack.fxRatesAsOf ?? "TRY"}`,
    },
    {
      metric: "13 Haftalık En Düşük Kasa Projeksiyonu",
      val:
        s.worst13WeekCashTry ??
        ((pack.unknownOpeningAccountCount ?? 0) > 0 ? "Bilinmiyor (FIN-03)" : "—"),
      note: "TRY Karşılığı",
    },
    { metric: "TDHP Net Satışlar", val: s.netSalesTry, note: "TRY" },
    { metric: "Yönetim FAVÖK (EBITDA)", val: s.managementEbitdaTry, note: "TRY" },
    { metric: "Dönem Net Kârı / Zararı", val: s.netIncomeTry, note: "TRY" },
    { metric: "Açık Ticari Alacaklar (120)", val: s.openArTry, note: "TRY Karşılığı" },
    { metric: "Açık Ticari Borçlar (320)", val: s.openApTry, note: "TRY Karşılığı" },
    { metric: "Alacak Tahsil Süresi (DSO)", val: s.dsoDays, note: "Gün" },
    { metric: "Stok Devir Süresi (DIO)", val: s.dioDays, note: "Gün" },
    { metric: "Borç Ödeme Süresi (DPO)", val: s.dpoDays, note: "Gün" },
    { metric: "Nakit Dönüşüm Döngüsü (CCC)", val: s.cccDays, note: "Gün" },
    { metric: "Kullanılan Kredi Bakiyesi", val: s.creditDrawnTry, note: "TRY Karşılığı" },
    { metric: "Kullanılabilir Boş Kredi Limiti", val: s.creditAvailableTry, note: "TRY Karşılığı" },
    { metric: "Kovenant İhlal Sayısı", val: s.covenantBreachCount, note: "Adet" },
  ];
  for (const r of summaryRows) {
    const added = wsOzet.addRow({ metric: r.metric, val: r.val ?? "—", note: r.note });
    if (typeof r.val === "number") added.getCell("val").numFmt = numFmt;
  }

  // 2. Gelir Tablosu
  const wsIs = wb.addWorksheet("Gelir Tablosu");
  wsIs.columns = [
    { header: "TDHP Kodu", key: "code", width: 16 },
    { header: "Gelir Tablosu Kalemi", key: "label", width: 46 },
    { header: "Tutar (TRY)", key: "amount", width: 24 },
  ];
  wsIs.getRow(1).font = { bold: true };
  for (const r of pack.incomeStatement) {
    const row = wsIs.addRow({ code: r.code, label: r.label, amount: r.amountTry ?? "—" });
    if (typeof r.amountTry === "number") row.getCell("amount").numFmt = numFmt;
    if (r.isSubtotal) row.font = { bold: true };
  }

  // 3. Bilanço
  const wsBs = wb.addWorksheet("Bilanço");
  wsBs.columns = [
    { header: "Bölüm", key: "section", width: 18 },
    { header: "Hesap Kodu", key: "code", width: 16 },
    { header: "Hesap Adı", key: "name", width: 46 },
    { header: "Bakiye (TRY)", key: "amount", width: 24 },
  ];
  wsBs.getRow(1).font = { bold: true };
  const secLabel: Record<string, string> = {
    asset: "AKTİF (VARLIK)",
    liability: "YABANCI KAYNAK",
    equity: "ÖZKAYNAK",
  };
  for (const r of pack.balanceSheet.rows) {
    const row = wsBs.addRow({
      section: secLabel[r.section] ?? r.section,
      code: r.accountCode,
      name: r.accountName,
      amount: r.amountTry,
    });
    row.getCell("amount").numFmt = numFmt;
  }
  const totAssetRow = wsBs.addRow({
    section: "TOPLAM",
    code: "AKTİF",
    name: "Toplam Aktifler",
    amount: pack.balanceSheet.totalAssetsTry,
  });
  totAssetRow.font = { bold: true };
  totAssetRow.getCell("amount").numFmt = numFmt;

  const totPasifRow = wsBs.addRow({
    section: "TOPLAM",
    code: "PASİF",
    name: "Toplam Yabancı Kaynak + Özkaynak",
    amount: money(
      decimal(pack.balanceSheet.totalLiabilitiesTry)
        .plus(decimal(pack.balanceSheet.totalEquityTry))
        .toString(),
    ),
  });
  totPasifRow.font = { bold: true };
  totPasifRow.getCell("amount").numFmt = numFmt;

  // 4. 13 Hafta Likidite
  const wsLiq = wb.addWorksheet("13 Hafta Likidite");
  wsLiq.columns = [
    { header: "Hafta", key: "week", width: 10 },
    { header: "Başlangıç", key: "start", width: 14 },
    { header: "Bitiş", key: "end", width: 14 },
    { header: "Açılış Kasası (TRY)", key: "open", width: 22 },
    { header: "Beklenen Giriş (TRY)", key: "inflow", width: 22 },
    { header: "Beklenen Çıkış (TRY)", key: "outflow", width: 22 },
    { header: "Net Akış (TRY)", key: "net", width: 20 },
    { header: "Kapanış Kasası (TRY)", key: "close", width: 22 },
  ];
  wsLiq.getRow(1).font = { bold: true };
  for (const w of pack.liquidity13Week) {
    const fin03Label =
      (pack.unknownOpeningAccountCount ?? 0) > 0 ? "Bilinmiyor (FIN-03)" : "—";
    const row = wsLiq.addRow({
      week: `H${w.weekNo}`,
      start: w.weekStart,
      end: w.weekEnd,
      open: w.openingCashTry ?? fin03Label,
      inflow: w.inflowTry,
      outflow: w.outflowTry,
      net: w.netFlowTry,
      close: w.closingCashTry ?? fin03Label,
    });
    for (const col of ["open", "inflow", "outflow", "net", "close"]) {
      const cell = row.getCell(col);
      if (typeof cell.value === "number") cell.numFmt = numFmt;
    }
  }

  // 5. Yaşlandırma & Kovenant
  const wsAge = wb.addWorksheet("Yaşlandırma & Kovenant");
  wsAge.columns = [
    { header: "Kategori / Vade Kovası", key: "c1", width: 34 },
    { header: "Alacak / Limit (TRY)", key: "c2", width: 22 },
    { header: "Borç / Kullanılan (TRY)", key: "c3", width: 22 },
    { header: "Net / Boş Limit (TRY)", key: "c4", width: 22 },
    { header: "Detay / Kovenant Durumu", key: "c5", width: 34 },
  ];
  wsAge.getRow(1).font = { bold: true };
  for (const a of pack.ageing) {
    const row = wsAge.addRow({
      c1: a.bucket,
      c2: a.arTry,
      c3: a.apTry,
      c4: a.netTry,
      c5: `AR: ${a.arCount} fatura · AP: ${a.apCount} fatura`,
    });
    row.getCell("c2").numFmt = numFmt;
    row.getCell("c3").numFmt = numFmt;
    row.getCell("c4").numFmt = numFmt;
  }
  wsAge.addRow({});
  const facHeader = wsAge.addRow({
    c1: "KREDİ LİMİTLERİ",
    c2: "Toplam Limit (TRY)",
    c3: "Kullanılan (TRY)",
    c4: "Boş Limit (TRY)",
    c5: "Tür / Döviz",
  });
  facHeader.font = { bold: true };
  for (const f of pack.facilities) {
    const row = wsAge.addRow({
      c1: f.name,
      c2: f.totalLimitTry,
      c3: f.drawnTry,
      c4: f.availableTry,
      c5: `${f.facilityType} (${f.currency})`,
    });
    row.getCell("c2").numFmt = numFmt;
    row.getCell("c3").numFmt = numFmt;
    row.getCell("c4").numFmt = numFmt;
  }
  if (pack.covenants.length > 0) {
    wsAge.addRow({});
    const covHeader = wsAge.addRow({
      c1: "FİNANSAL KOVENANTLAR",
      c2: "Eşik Değer",
      c3: "Gözlenen",
      c4: "Headroom (Marj)",
      c5: "Durum / Sonraki Test",
    });
    covHeader.font = { bold: true };
    for (const c of pack.covenants) {
      wsAge.addRow({
        c1: `${c.facilityName} — ${c.metricName} (${c.operator})`,
        c2: c.thresholdValue,
        c3: c.observedValue ?? "—",
        c4: c.headroom ?? "—",
        c5: `${c.status.toUpperCase()}${c.nextTestDate ? ` · Test: ${c.nextTestDate}` : ""}`,
      });
    }
  }

  const arrayBuffer = await wb.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer);
}

export function renderExecutiveReportHtml(
  report: { id: string; report_type: string; period_start: string; period_end: string; body_md: string; created_at: string },
  pack: BoardFinancialPackage,
  autoPrint = false,
): string {
  const s = pack.executiveSummary;
  const isRowsHtml = pack.incomeStatement
    .map(
      (r) =>
        `<tr class="${r.isSubtotal ? "sub" : ""}"><td>${escapeHtml(r.code)}</td><td>${escapeHtml(r.label)}</td><td class="num">${escapeHtml(fmtTl(r.amountTry))}</td></tr>`,
    )
    .join("");
  const liqRowsHtml = pack.liquidity13Week
    .map(
      (w) =>
        `<tr><td>H${w.weekNo}</td><td>${w.weekStart} → ${w.weekEnd}</td><td class="num">${escapeHtml(fmtTl(w.inflowTry))}</td><td class="num">${escapeHtml(fmtTl(w.outflowTry))}</td><td class="num">${escapeHtml(fmtTl(w.netFlowTry))}</td><td class="num">${escapeHtml(fmtTl(w.closingCashTry))}</td></tr>`,
    )
    .join("");
  const ageRowsHtml = pack.ageing
    .map(
      (a) =>
        `<tr><td>${escapeHtml(a.bucket)}</td><td class="num">${escapeHtml(fmtTl(a.arTry))}</td><td class="num">${escapeHtml(fmtTl(a.apTry))}</td><td class="num">${escapeHtml(fmtTl(a.netTry))}</td></tr>`,
    )
    .join("");

  return `<!DOCTYPE html>
<html lang="tr">
<head>
  <meta charset="utf-8" />
  <title>Yönetim Kurulu & Banka Finansal Paketi — ${escapeHtml(pack.asOf)}</title>
  <style>
    :root { color-scheme: light; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #141210; background: #faf8f5; margin: 0; padding: 32px; font-size: 12px; line-height: 1.45; }
    .toolbar { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; padding: 10px 14px; background: #f2ede4; border: 1px solid #d8d0c4; }
    .btn { background: #141210; color: #faf8f5; border: none; padding: 8px 14px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.06em; cursor: pointer; text-decoration: none; }
    h1 { font-size: 20px; margin: 0 0 4px 0; letter-spacing: -0.01em; }
    h2 { font-size: 13px; text-transform: uppercase; letter-spacing: 0.06em; border-bottom: 2px solid #141210; padding-bottom: 4px; margin: 24px 0 10px 0; }
    .meta { color: #5c554d; font-family: monospace; font-size: 11px; margin-bottom: 18px; }
    .kpis { display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-bottom: 18px; }
    .kpi { background: #ffffff; border: 1px solid #d8d0c4; padding: 10px 12px; }
    .kpi .lbl { font-size: 10px; text-transform: uppercase; color: #6e675f; }
    .kpi .val { font-size: 15px; font-weight: 700; font-family: monospace; margin-top: 4px; }
    table { width: 100%; border-collapse: collapse; background: #ffffff; margin-bottom: 14px; }
    th, td { border: 1px solid #dfd8cd; padding: 6px 8px; text-align: left; }
    th { background: #f2ede4; font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em; }
    td.num, th.num { text-align: right; font-family: monospace; }
    tr.sub td { font-weight: 700; background: #f7f4ee; }
    pre.raw { background: #ffffff; border: 1px solid #dfd8cd; padding: 12px; white-space: pre-wrap; font-size: 11px; }
    .sigs { display: grid; grid-template-columns: 1fr 1fr; gap: 40px; margin-top: 36px; page-break-inside: avoid; }
    .sig { border-top: 1px solid #141210; padding-top: 8px; font-size: 11px; color: #5c554d; }
    @media print {
      body { background: #ffffff; padding: 12mm; }
      .toolbar { display: none; }
    }
  </style>
</head>
<body>
  <div class="toolbar">
    <span><strong>MAS Finansal İşletim Sistemi</strong> · Yazdırılabilir Yönetim Kurulu & Banka Paketi</span>
    <button class="btn" onclick="window.print()">PDF Olarak Yazdır / Kaydet</button>
  </div>
  <h1>YÖNETİM KURULU VE BANKA FİNANSAL PAKETİ</h1>
  <div class="meta">Dönem: ${escapeHtml(report.period_start)} → ${escapeHtml(report.period_end)} · Üretim: ${escapeHtml(report.created_at)} · TCMB Kur Bazı: ${escapeHtml(pack.fxRatesAsOf ?? "TRY")}${pack.provenance ? ` · Snapshot: ${escapeHtml(pack.provenance.snapshotId.slice(0, 8))} · Şema: ${escapeHtml(pack.provenance.schemaVersion ?? "—")} · Son Excel: ${escapeHtml(pack.provenance.workbookStaleDays != null ? `${pack.provenance.workbookStaleDays} gün eski` : "yok")}` : ""}</div>

  <div class="kpis">
    <div class="kpi"><div class="lbl">Konsolide Hazır Değerler</div><div class="val">${escapeHtml(fmtCashOrFin03(s.consolidatedCashTry, pack.unknownOpeningAccountCount))}</div></div>
    <div class="kpi"><div class="lbl">Yönetim FAVÖK (EBITDA)</div><div class="val">${escapeHtml(fmtTl(s.managementEbitdaTry))}</div></div>
    <div class="kpi"><div class="lbl">13H En Düşük Kasa</div><div class="val">${escapeHtml(fmtCashOrFin03(s.worst13WeekCashTry, pack.unknownOpeningAccountCount))}</div></div>
    <div class="kpi"><div class="lbl">Boş Kredi Limiti</div><div class="val">${escapeHtml(fmtTl(s.creditAvailableTry))}</div></div>
  </div>

  <h2>1. TDHP Gelir Tablosu Özeti</h2>
  <table>
    <thead><tr><th>Kod</th><th>Kalem</th><th class="num">Tutar (TRY)</th></tr></thead>
    <tbody>${isRowsHtml}</tbody>
  </table>

  <h2>2. TDHP Bilanço Özeti</h2>
  <table>
    <thead><tr><th>Bilanço Dengesi</th><th class="num">Aktif Toplamı</th><th class="num">Yabancı Kaynak</th><th class="num">Özkaynak</th></tr></thead>
    <tbody>
      <tr class="sub">
        <td>${pack.balanceSheet.balanced ? "AKTİF = PASİF TAM MUTABIK" : "FARK MEVCUT"}</td>
        <td class="num">${escapeHtml(fmtTl(pack.balanceSheet.totalAssetsTry))}</td>
        <td class="num">${escapeHtml(fmtTl(pack.balanceSheet.totalLiabilitiesTry))}</td>
        <td class="num">${escapeHtml(fmtTl(pack.balanceSheet.totalEquityTry))}</td>
      </tr>
    </tbody>
  </table>

  <h2>3. 13 Haftalık Nakit ve Likidite Projeksiyonu</h2>
  <table>
    <thead><tr><th>Hafta</th><th>Tarih Aralığı</th><th class="num">Giriş</th><th class="num">Çıkış</th><th class="num">Net Akış</th><th class="num">Kapanış Kasası</th></tr></thead>
    <tbody>${liqRowsHtml}</tbody>
  </table>

  <h2>4. Ticari Alacak & Borç Yaşlandırma</h2>
  <table>
    <thead><tr><th>Vade Kovası</th><th class="num">Alacak (120)</th><th class="num">Borç (320)</th><th class="num">Net Pozisyon</th></tr></thead>
    <tbody>${ageRowsHtml}</tbody>
  </table>

  <h2>5. Rapor Metni & Denetim Özeti</h2>
  <pre class="raw">${escapeHtml(report.body_md)}</pre>

  <div class="sigs">
    <div class="sig"><strong>Finans Direktörü (CFO)</strong><br/>İmza / Tarih</div>
    <div class="sig"><strong>Yönetim Kurulu Onayı</strong><br/>İmza / Tarih</div>
  </div>
  ${autoPrint ? "<script>window.addEventListener('load', () => setTimeout(() => window.print(), 250));</script>" : ""}
</body>
</html>`;
}

export function renderReportCsv(pack: BoardFinancialPackage): string {
  const rows: string[][] = [
    ["Bolum", "Kod_Veya_Anahtar", "Aciklama", "Tutar_TRY", "Ek_Bilgi"],
    ...(pack.provenance
      ? [
          ["PROVENANCE", "SNAPSHOT_ID", "Anlik Goruntu Kimligi", pack.provenance.snapshotId, `as_of:${pack.provenance.asOfAt}`],
          ["PROVENANCE", "SCHEMA_VERSION", "Sema Surumu", pack.provenance.schemaVersion ?? "", `mig:${pack.provenance.migrationCount ?? ""}`],
          ["PROVENANCE", "WORKBOOK_STALE_DAYS", "Son Excel Ithalati Yasi (Gun)", String(pack.provenance.workbookStaleDays ?? ""), pack.provenance.lastWorkbookImportAt ?? ""],
          ["PROVENANCE", "CONFIDENCE_GRADE", "Guven Derecesi", pack.provenance.confidenceGrade, pack.provenance.calculationVersion],
        ]
      : []),
    ["OZET", "CASH", "Konsolide Hazir Degerler", pack.executiveSummary.consolidatedCashTry == null ? ((pack.unknownOpeningAccountCount ?? 0) > 0 ? "BILINMIYOR_FIN03" : "") : String(pack.executiveSummary.consolidatedCashTry), pack.fxRatesAsOf ?? "TRY"],
    ["OZET", "EBITDA", "Yonetim FAVOK", String(pack.executiveSummary.managementEbitdaTry ?? ""), "TRY"],
    ["OZET", "NET_INCOME", "Donem Net Kari", String(pack.executiveSummary.netIncomeTry ?? ""), "TRY"],
    ["OZET", "AR_OPEN", "Acik Alacaklar", String(pack.executiveSummary.openArTry), "TRY"],
    ["OZET", "AP_OPEN", "Acik Borclar", String(pack.executiveSummary.openApTry), "TRY"],
  ];
  for (const r of pack.incomeStatement) {
    rows.push(["GELIR_TABLOSU", r.code, r.label, String(r.amountTry ?? ""), r.isSubtotal ? "ARA_TOPLAM" : "DETAY"]);
  }
  for (const b of pack.balanceSheet.rows) {
    rows.push(["BILANCO", b.accountCode, b.accountName, String(b.amountTry), b.section]);
  }
  for (const w of pack.liquidity13Week) {
    rows.push(["LIKIDITE_13H", `H${w.weekNo}`, `${w.weekStart}..${w.weekEnd}`, String(w.closingCashTry ?? ""), `Net:${w.netFlowTry}`]);
  }
  for (const a of pack.ageing) {
    rows.push(["YASLANDIRMA", a.bucket, "Net AR-AP", String(a.netTry), `AR:${a.arTry}|AP:${a.apTry}`]);
  }
  const esc = (v: string) => `"${v.replace(/"/g, '""')}"`;
  return "\uFEFF" + rows.map((r) => r.map(esc).join(",")).join("\r\n");
}
