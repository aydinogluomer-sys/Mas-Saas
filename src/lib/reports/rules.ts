// Report domain rules (Phase 6A & Faz 46 C3). Pure & deterministic — sources:
// docs/calculation-rules.md + .claude/skills/mas-report-writer. Reports are
// decision-oriented summaries over ALREADY-MAPPED data. They NEVER mutate financial
// records and AI is commentary-only (buildCommentaryPrompt returns a prompt string,
// no API call, no mutation). Null amount stays "TUTAR EKSİK", never 0.

import {
  computeObligationAmounts,
  type MonetaryEpistemicBasis,
  type ReportConfidenceGrade,
  type SourceCompletenessStatus,
} from "@/lib/contracts/remediation-contracts";
import { addDaysISO } from "@/lib/financing/rules";
import { decimal, money } from "@/lib/money";

/* ── timezone: "today" for reports is Europe/Istanbul (calculation-rules §status) ──
 * Re-exported from the shared time module (src/lib/time/istanbul.ts) — kept here so
 * existing callers importing from this file don't need to change. New payment-domain
 * code should import istanbulDateISO from "@/lib/time/istanbul" directly. */

export { istanbulDateISO } from "@/lib/time/istanbul";
import { foreignNote, isReportingCurrency, sumKnownReporting } from "@/lib/currency-policy";

/* ── shared shapes (plain data so builders stay unit-testable without a DB) ── */

export interface ReportInstance {
  name: string;
  dueDate: string; // ISO
  amount: number | null;
  originalAmount?: number | null;
  paidAmount?: number | null;
  paid_amount?: number | null;
  allocatedPaidAmount?: number | null;
  outstandingAmount?: number | null;
  status: string;
  riskLevel: string;
  riskReasons: string[];
  /** PHASE 2.2 (#10): `null` = bilinmiyor; TRY-dışı/bilinmeyen kalem toplama girmez, sayılır. */
  currency?: string | null;
}

export interface ReportMaturity {
  label: string;
  dueDate: string;
  amount: number | null;
  direction: "inflow" | "outflow" | "unknown";
  kind: "check" | "loan_installment";
}

const OPEN = new Set(["unpaid", "partial", "planned", "late"]);
const CLOSED = new Set(["cancelled", "paid", "cleared", "collected"]);
const isOpen = (s: string) => OPEN.has(s.trim().toLowerCase());
const isClosed = (s: string) => CLOSED.has(s.trim().toLowerCase());
const isCancelled = (s: string) => s.trim().toLowerCase() === "cancelled";
const REPORT_STALE_THRESHOLD_DAYS = 45;

function isUnverifiedReportCashStatus(status?: SourceCompletenessStatus | null): boolean {
  return (
    status === "PARTIAL_MISSING_OPENING" ||
    status === "LEGACY_UNVERIFIED" ||
    status === "SCHEMA_INCOMPATIBLE" ||
    status === "SOURCE_UNAVAILABLE"
  );
}

function buildReportStaleWatermark(
  sourceFreshnessDays: number | null | undefined,
  sourceId?: string | null,
): string | null {
  const srcSuffix = sourceId ? ` · source_id=${sourceId}` : "";
  if (sourceFreshnessDays === null || sourceFreshnessDays === undefined || !Number.isFinite(sourceFreshnessDays)) {
    return `[STALE DATA WATERMARK · STALE_SOURCE_WARNING] Geçerli çalışma kitabı içe aktarımı yok (sourceFreshnessDays=null${srcSuffix}) — kaynak tazeliği doğrulanamadı.`;
  }
  if (sourceFreshnessDays > REPORT_STALE_THRESHOLD_DAYS) {
    return `[STALE DATA WATERMARK · STALE_SOURCE_WARNING] Son geçerli çalışma kitabı içe aktarımı ${sourceFreshnessDays} gün eski (> ${REPORT_STALE_THRESHOLD_DAYS} gün eşiği${srcSuffix}) — projeksiyon verisi bayattır.`;
  }
  return null;
}

/**
 * Contract A (`I-012`) pure helper resolving `{ orig, paid, rem }` for a `ReportInstance`.
 * - `null` original amount stays `null` (`BLANK != ZERO`).
 * - Partially paid obligations expose `rem` (`outstandingAmount`) rather than overstating
 *   unpaid/overdue exposure by the already-paid portion.
 */
export function resolveReportInstanceAmounts(i: ReportInstance): {
  orig: number | null;
  paid: number | null;
  rem: number | null;
} {
  const rawPaid = i.paidAmount ?? i.allocatedPaidAmount ?? i.paid_amount ?? null;
  const rawOrig = i.originalAmount !== undefined ? i.originalAmount : i.amount;
  const computed = computeObligationAmounts({
    originalAmount: rawOrig,
    paidAmount: rawPaid,
    status: i.status,
  });
  const orig = computed.originalAmount;
  if (orig == null) {
    return { orig: null, paid: computed.allocatedPaidAmount, rem: null };
  }
  const paid = rawPaid != null && Number.isFinite(rawPaid) ? rawPaid : null;
  const statusNorm = i.status.trim().toLowerCase();
  const rem =
    i.outstandingAmount != null && Number.isFinite(i.outstandingAmount)
      ? i.outstandingAmount
      : orig != null && paid != null && statusNorm === "partial"
        ? Math.max(0, Math.round((orig - paid) * 100) / 100)
        : statusNorm === "cancelled" || statusNorm === "paid"
          ? computed.outstandingAmount
          : orig;
  return { orig, paid, rem };
}

// PHASE 2.2 (#10): para birimi alanı taşıyan kalemlerde yalnız TRY toplanır; alanı olmayan
// (çek/taksit — yapısal TRY) kalemler eskisi gibi toplanır. `foreign` = toplamda olmayan kalem.
function sumKnown(items: Array<{ amount: number | null; currency?: string | null }>): { total: number; missing: number; foreign: number } {
  const k = sumKnownReporting(items, (i) => i.amount, { positiveOnly: true });
  return { total: k.total, missing: k.missing, foreign: k.foreignCount };
}

function sumKnownInstances(items: ReportInstance[]): { total: number; missing: number; foreign: number } {
  const k = sumKnownReporting(items, (i) => resolveReportInstanceAmounts(i).rem, { positiveOnly: true });
  return { total: k.total, missing: k.missing, foreign: k.foreignCount };
}

const fmtTL = (n: number | null): string =>
  n == null
    ? "TUTAR EKSİK"
    : new Intl.NumberFormat("tr-TR", { minimumFractionDigits: 0, maximumFractionDigits: 2 }).format(n) + " TL";

function formatReportInstanceAmount(i: ReportInstance): string {
  const { orig, paid, rem } = resolveReportInstanceAmounts(i);
  if (orig == null) return fmtTL(null);
  const statusNorm = i.status.trim().toLowerCase();
  if (statusNorm === "partial" && (paid != null || rem !== orig)) {
    const effectiveRem = rem ?? orig;
    const effectivePaid = paid ?? Math.max(0, Math.round((orig - effectiveRem) * 100) / 100);
    return `kalan ${fmtTL(effectiveRem)} (asıl: ${fmtTL(orig)} · ödenen: ${fmtTL(effectivePaid)})`;
  }
  if (statusNorm === "paid") {
    return fmtTL(orig);
  }
  return fmtTL(rem);
}

/* ── shared bank/cash & provenance lineage shapes ── */

export type ReportReconciliationState = "ALIGNED" | "MISMATCH" | "UNVERIFIED";

export interface ReportActualBankCashStatus {
  availableCashTry: number | null;
  unknownOpeningCount: number;
  hasVerifiedBankFeed: boolean;
  reconciledTxCount: number;
  unmatchedTxCount: number;
  cashSourceStatus?: SourceCompletenessStatus;
}

export type MonthlyActualBankCashStatus = ReportActualBankCashStatus;

export interface ReportProvenanceBadge {
  snapshotId?: string | null;
  asOfDate?: string | null;
  businessDateISO?: string | null;
  confidenceGrade?: ReportConfidenceGrade;
  workbookStaleDays?: number | null;
  sourceFreshnessDays?: number | null;
  sourceWorkbookId?: string | null;
  source_id?: string | null;
  lastWorkbookImportAt?: string | null;
  latestValidImportAt?: string | null;
  lastWorkbookFilename?: string | null;
  lastBankTxAt?: string | null;
  reconciliationAligned?: boolean;
  reconciliationStatus?: ReportReconciliationState;
  monetaryBasisByMetric?: Readonly<Record<string, MonetaryEpistemicBasis>>;
  missingMaterialInputs?: readonly string[];
  staleDataWatermark?: string | null;
}

export type MonthlyProvenanceBadge = ReportProvenanceBadge;

function evaluateReportCashAndLineage(
  asOf: string,
  act?: ReportActualBankCashStatus | null,
  prov?: ReportProvenanceBadge | null,
) {
  const unverifiedCashStatus = isUnverifiedReportCashStatus(act?.cashSourceStatus);
  const availableBankCashBasis: MonetaryEpistemicBasis =
    act == null ||
    unverifiedCashStatus ||
    act.unknownOpeningCount > 0 ||
    act.availableCashTry == null ||
    !Number.isFinite(act.availableCashTry) ||
    (!act.hasVerifiedBankFeed &&
      act.availableCashTry === 0 &&
      act.cashSourceStatus !== "NO_ACTIVE_ACCOUNTS_VERIFIED")
      ? (act == null && prov?.monetaryBasisByMetric?.availableBankCash
          ? prov.monetaryBasisByMetric.availableBankCash
          : "UNKNOWN")
      : "ACTUAL";

  const bankReconciledBasis: MonetaryEpistemicBasis =
    act == null || !act.hasVerifiedBankFeed || act.cashSourceStatus === "SCHEMA_INCOMPATIBLE"
      ? (act == null && prov?.monetaryBasisByMetric?.bankReconciledFlows
          ? prov.monetaryBasisByMetric.bankReconciledFlows
          : "UNKNOWN")
      : "RECONCILED";

  const monetaryBasisByMetric: Record<string, MonetaryEpistemicBasis> = {
    availableBankCash: availableBankCashBasis,
    scheduledOutflows: prov?.monetaryBasisByMetric?.scheduledOutflows ?? "PLANNED",
    workbookMonthlyCash: prov?.monetaryBasisByMetric?.workbookMonthlyCash ?? "FORECAST",
    bankReconciledFlows: bankReconciledBasis,
  };

  const sourceFreshnessDays =
    prov?.sourceFreshnessDays !== undefined
      ? prov.sourceFreshnessDays
      : (prov?.workbookStaleDays ?? null);
  const sourceWorkbookId = prov?.source_id ?? prov?.sourceWorkbookId ?? null;
  const latestValidImportAt = prov?.latestValidImportAt ?? prov?.lastWorkbookImportAt ?? null;
  const businessDateISO = prov?.businessDateISO ?? prov?.asOfDate ?? asOf;
  const reconciliationAligned = prov?.reconciliationAligned ?? true;
  const reconciliationStatus: ReportReconciliationState =
    prov?.reconciliationStatus ??
    (!reconciliationAligned
      ? "MISMATCH"
      : availableBankCashBasis === "UNKNOWN" || bankReconciledBasis === "UNKNOWN"
        ? "UNVERIFIED"
        : "ALIGNED");

  const confidenceGrade: ReportConfidenceGrade =
    prov?.confidenceGrade ??
    (availableBankCashBasis === "UNKNOWN"
      ? "UNVERIFIED_CASH_BASIS"
      : sourceFreshnessDays != null && sourceFreshnessDays > REPORT_STALE_THRESHOLD_DAYS
        ? "STALE_SOURCE_WARNING"
        : !reconciliationAligned || bankReconciledBasis === "UNKNOWN" || sourceFreshnessDays === null
          ? "PARTIAL_MISSING_INPUTS"
          : "VERIFIED_COMPLETE");

  const staleDataWatermark =
    prov?.staleDataWatermark !== undefined
      ? prov.staleDataWatermark
      : prov != null
        ? buildReportStaleWatermark(
            sourceFreshnessDays,
            sourceWorkbookId ?? prov.lastWorkbookFilename ?? null,
          )
        : null;

  const actualCashText =
    act == null
      ? null
      : availableBankCashBasis === "UNKNOWN"
        ? `[UNKNOWN] Bilinmiyor (${
            act.unknownOpeningCount > 0
              ? `FIN-03: ${act.unknownOpeningCount} aktif hesapta açılış bakiyesi tanımsız`
              : act.cashSourceStatus === "SCHEMA_INCOMPATIBLE"
                ? "SCHEMA_INCOMPATIBLE: finansal kaynak şeması uyumsuz"
                : act.cashSourceStatus === "LEGACY_UNVERIFIED"
                  ? "LEGACY_UNVERIFIED: açılış bütünlüğü doğrulanamadı"
                  : "doğrulanmış banka/kasa bakiyesi yok"
          })`
        : `[ACTUAL] ${fmtTL(act.availableCashTry)}`;

  const bankReconText =
    act == null
      ? null
      : bankReconciledBasis === "UNKNOWN"
        ? act.cashSourceStatus === "SCHEMA_INCOMPATIBLE"
          ? "[UNKNOWN] Bilinmiyor (SCHEMA_INCOMPATIBLE — banka ekstresi şeması uyumsuz)"
          : "[UNKNOWN] Bilinmiyor (banka ekstresi hareketi yok)"
        : `[RECONCILED] ${act.reconciledTxCount} mutabık · ${act.unmatchedTxCount} eşleşmemiş banka hareketi`;

  const lineageSummaryLine =
    prov != null
      ? `Kaynak izi (lineage): as_of=${businessDateISO} · source_id=${sourceWorkbookId ?? "yok"} · latest_valid_import_at=${latestValidImportAt ?? "yok"} · source_freshness_days=${sourceFreshnessDays ?? "null"} · mutabakat=${reconciliationStatus} (aligned=${String(reconciliationAligned)})`
      : null;

  return {
    asOf: businessDateISO,
    businessDateISO,
    monetaryBasisByMetric,
    confidenceGrade,
    sourceFreshnessDays,
    latestValidImportAt,
    source_id: sourceWorkbookId,
    sourceWorkbookId,
    reconciliationAligned,
    reconciliationStatus,
    staleDataWatermark,
    actualCashText,
    bankReconText,
    lineageSummaryLine,
  };
}

/* ── 1) daily report ── */

export interface DailyReportInput {
  dueSoon: ReportInstance[]; // open instances due in [today, today+7]
  overdue: ReportInstance[]; // open instances due < today
  maturities: ReportMaturity[]; // checks + installments due in [today, today+7]
  criticalThreshold: number;
  cancelled?: ReportInstance[];
  cancelledCount?: number;
  cancelledKnownTotal?: number;
  actualBankCashStatus?: ReportActualBankCashStatus | null;
  provenance?: ReportProvenanceBadge | null;
}

export interface DailyReport {
  date: string;
  asOf: string;
  businessDateISO: string;
  dueToday: ReportInstance[];
  dueTomorrow: ReportInstance[];
  next7KnownTotal: number;
  next7MissingCount: number;
  overdueCount: number;
  overdueKnownTotal: number;
  cancelledCount: number;
  cancelledKnownTotal: number;
  checksNext7: ReportMaturity[];
  criticalItems: ReportInstance[];
  actions: string[];
  monetaryBasisByMetric: Record<string, MonetaryEpistemicBasis>;
  confidenceGrade: ReportConfidenceGrade;
  sourceFreshnessDays: number | null;
  latestValidImportAt: string | null;
  source_id: string | null;
  sourceWorkbookId: string | null;
  reconciliationAligned: boolean;
  reconciliationStatus: ReportReconciliationState;
  staleDataWatermark: string | null;
  bodyMd: string;
}

export function buildDailyReport(input: DailyReportInput, todayISO: string): DailyReport {
  const tomorrow = addDaysISO(todayISO, 1);
  const cancelledFromLists = [
    ...input.dueSoon.filter((i) => isCancelled(i.status)),
    ...input.overdue.filter((i) => isCancelled(i.status)),
    ...(input.cancelled ?? []),
  ];
  const cancelledSum = sumKnownReporting(
    cancelledFromLists,
    (i) => resolveReportInstanceAmounts(i).orig,
    { positiveOnly: true },
  );
  const cancelledCount = cancelledFromLists.length + (input.cancelledCount ?? 0);
  const cancelledKnownTotal = money(
    decimal(cancelledSum.total).plus(decimal(input.cancelledKnownTotal ?? 0)),
  );

  const openDueSoon = input.dueSoon.filter((i) => !isClosed(i.status));
  const openOverdue = input.overdue.filter((i) => !isClosed(i.status));

  const dueToday = openDueSoon.filter((i) => i.dueDate === todayISO);
  const dueTomorrow = openDueSoon.filter((i) => i.dueDate === tomorrow);
  const { total: next7KnownTotal, missing: next7MissingCount, foreign: next7ForeignCount } =
    sumKnownInstances(openDueSoon);
  const overdueKnown = sumKnownInstances(openOverdue);
  const checksNext7 = input.maturities.filter((m) => m.kind === "check" && m.direction === "outflow");
  // Eşik TRY (`critical_payment_threshold_try`): TRY-dışı kalem eşikle tartılmaz (Tier 1 kuralı).
  const criticalItems = openDueSoon.filter((i) => {
    const { rem } = resolveReportInstanceAmounts(i);
    return (
      rem != null &&
      (i.currency === undefined || isReportingCurrency(i.currency)) &&
      rem >= input.criticalThreshold &&
      isOpen(i.status)
    );
  });

  const lineage = evaluateReportCashAndLineage(
    todayISO,
    input.actualBankCashStatus,
    input.provenance,
  );

  const actions: string[] = [];
  if (dueToday.length) actions.push(`Bugün ${dueToday.length} ödeme — nakit hazırla`);
  if (openOverdue.length) actions.push(`${openOverdue.length} geciken kalem — acil kontrol`);
  if (next7MissingCount) actions.push(`${next7MissingCount} kalemde tutar eksik — kaynağı doğrula`);
  if (next7ForeignCount) actions.push(`${next7ForeignCount} kalem TRY-dışı — toplamda yok, ayrıca değerlendir`);
  if (criticalItems.length) actions.push(`${criticalItems.length} kritik ödeme (≥${fmtTL(input.criticalThreshold)}) — öncelik ver`);
  if (checksNext7.length) actions.push(`${checksNext7.length} çek 7 gün içinde vadesinde`);
  if (actions.length === 0) actions.push("Kritik aksiyon yok — rutin kontrol yeterli");

  const line = (i: ReportInstance) =>
    `- ${i.dueDate} · ${i.name} · ${formatReportInstanceAmount(i)}${i.riskLevel !== "none" ? ` · ⚠ ${i.riskLevel}` : ""}`;
  const bodyMd = [
    `# Günlük Rapor — ${todayISO}`,
    ...(lineage.staleDataWatermark ? [``, `> ${lineage.staleDataWatermark}`] : []),
    ...(input.actualBankCashStatus
      ? [
          ``,
          `## Fiili Kasa & Banka Mutabakat Durumu (ACTUAL / RECONCILED / UNKNOWN)`,
          `- fiili kullanılabilir kasa: ${lineage.actualCashText}`,
          `- banka ekstresi ve mutabakat: ${lineage.bankReconText}`,
        ]
      : []),
    ``,
    `## Bugün (${dueToday.length})`,
    ...(dueToday.length ? dueToday.map(line) : ["- yok"]),
    ``,
    `## Yarın (${dueTomorrow.length})`,
    ...(dueTomorrow.length ? dueTomorrow.map(line) : ["- yok"]),
    ``,
    `## 7 gün bilinen toplam: ${fmtTL(next7KnownTotal)}${next7MissingCount ? ` · ${next7MissingCount} kalem tutar eksik` : ""}${next7ForeignCount ? ` · ${foreignNote(next7ForeignCount)}` : ""}`,
    ...(cancelledCount > 0
      ? [`- İptal edilen (toplam dışı): ${cancelledCount} kalem · ${fmtTL(cancelledKnownTotal)}`]
      : []),
    ``,
    `## Geciken (${openOverdue.length}) — bilinen ${fmtTL(overdueKnown.total)}${overdueKnown.foreign ? ` · ${foreignNote(overdueKnown.foreign)}` : ""}`,
    ...(openOverdue.length ? openOverdue.slice(0, 10).map(line) : ["- yok"]),
    ``,
    `## 7 gün içindeki çekler (${checksNext7.length})`,
    ...(checksNext7.length ? checksNext7.map((m) => `- ${m.dueDate} · ${m.label} · ${fmtTL(m.amount)}`) : ["- yok"]),
    ...(input.provenance
      ? [
          ``,
          `## Veri kaynağı ve güven derecesi`,
          `- Güven derecesi: ${lineage.confidenceGrade}`,
          ...(lineage.lineageSummaryLine ? [`- ${lineage.lineageSummaryLine}`] : []),
          ...(input.provenance.missingMaterialInputs?.length
            ? input.provenance.missingMaterialInputs.map((m) => `- ${m}`)
            : []),
        ]
      : []),
    ``,
    `## Aksiyon listesi`,
    ...actions.map((a) => `- [ ] ${a}`),
  ].join("\n");

  return {
    date: todayISO,
    asOf: lineage.asOf,
    businessDateISO: lineage.businessDateISO,
    dueToday,
    dueTomorrow,
    next7KnownTotal,
    next7MissingCount,
    overdueCount: openOverdue.length,
    overdueKnownTotal: overdueKnown.total,
    cancelledCount,
    cancelledKnownTotal,
    checksNext7,
    criticalItems,
    actions,
    monetaryBasisByMetric: lineage.monetaryBasisByMetric,
    confidenceGrade: lineage.confidenceGrade,
    sourceFreshnessDays: lineage.sourceFreshnessDays,
    latestValidImportAt: lineage.latestValidImportAt,
    source_id: lineage.source_id,
    sourceWorkbookId: lineage.sourceWorkbookId,
    reconciliationAligned: lineage.reconciliationAligned,
    reconciliationStatus: lineage.reconciliationStatus,
    staleDataWatermark: lineage.staleDataWatermark,
    bodyMd,
  };
}

/* ── 2) weekly report (rolling 7 days) ── */

export interface WeeklyReportInput {
  weekInstances: ReportInstance[]; // open instances due in [today, today+7]
  maturitiesWeek: ReportMaturity[]; // checks + installments in [today, today+7]
  installmentsMonth: ReportMaturity[]; // loan installments due in current month
  riskDays: Array<{ date: string; cluster: boolean; critical: boolean; large: boolean; knownSum: number; count: number }>;
  largeThreshold: number;
  actualBankCashStatus?: ReportActualBankCashStatus | null;
  provenance?: ReportProvenanceBadge | null;
}

export interface WeeklyReport {
  from: string;
  to: string;
  asOf: string;
  businessDateISO: string;
  knownTotal: number;
  missingCount: number;
  largest: ReportInstance[];
  checkLoad: number;
  installmentLoadWeek: number;
  installmentLoadMonth: number;
  riskDays: WeeklyReportInput["riskDays"];
  actions: string[];
  monetaryBasisByMetric: Record<string, MonetaryEpistemicBasis>;
  confidenceGrade: ReportConfidenceGrade;
  sourceFreshnessDays: number | null;
  latestValidImportAt: string | null;
  source_id: string | null;
  sourceWorkbookId: string | null;
  reconciliationAligned: boolean;
  reconciliationStatus: ReportReconciliationState;
  staleDataWatermark: string | null;
  bodyMd: string;
}

export function buildWeeklyReport(input: WeeklyReportInput, todayISO: string): WeeklyReport {
  const to = addDaysISO(todayISO, 7);
  const openWeekInstances = input.weekInstances.filter((i) => !isClosed(i.status));
  const { total: knownTotal, missing: missingCount } = sumKnownInstances(openWeekInstances);
  const largest = [...openWeekInstances]
    .filter((i) => {
      const { rem } = resolveReportInstanceAmounts(i);
      return (
        rem != null &&
        (i.currency === undefined || isReportingCurrency(i.currency)) &&
        rem >= input.largeThreshold
      );
    })
    .sort((a, b) => (resolveReportInstanceAmounts(b).rem ?? 0) - (resolveReportInstanceAmounts(a).rem ?? 0))
    .slice(0, 5);
  // Faz 46 (C3): Only outflow checks belong in weekly check debt load (never customer inflow checks).
  const checkLoad = sumKnown(
    input.maturitiesWeek.filter((m) => m.kind === "check" && m.direction === "outflow"),
  ).total;
  const installmentLoadWeek = sumKnown(
    input.maturitiesWeek.filter((m) => m.kind === "loan_installment" && m.direction !== "inflow"),
  ).total;
  const installmentLoadMonth = sumKnown(
    input.installmentsMonth.filter((m) => m.direction !== "inflow"),
  ).total;

  const lineage = evaluateReportCashAndLineage(
    todayISO,
    input.actualBankCashStatus,
    input.provenance,
  );

  const actions: string[] = [];
  if (input.riskDays.length) actions.push(`${input.riskDays.length} riskli gün — yığılma/kritik kontrol`);
  if (missingCount) actions.push(`${missingCount} kalemde tutar eksik`);
  if (installmentLoadMonth > 0) actions.push(`Bu ay kredi taksit yükü ${fmtTL(installmentLoadMonth)}`);
  if (checkLoad > 0) actions.push(`Bu hafta çek yükü ${fmtTL(checkLoad)}`);
  if (actions.length === 0) actions.push("Hafta sakin — rutin hazırlık");

  const bodyMd = [
    `# Haftalık Rapor — ${todayISO} → ${to}`,
    ...(lineage.staleDataWatermark ? [``, `> ${lineage.staleDataWatermark}`] : []),
    ...(input.actualBankCashStatus
      ? [
          ``,
          `## Fiili Kasa & Banka Mutabakat Durumu (ACTUAL / RECONCILED / UNKNOWN)`,
          `- fiili kullanılabilir kasa: ${lineage.actualCashText}`,
          `- banka ekstresi ve mutabakat: ${lineage.bankReconText}`,
        ]
      : []),
    ``,
    `## Bilinen ödeme yükü: ${fmtTL(knownTotal)}${missingCount ? ` · ${missingCount} eksik` : ""}`,
    `- çek yükü (hafta): ${fmtTL(checkLoad)}`,
    `- kredi taksiti (hafta): ${fmtTL(installmentLoadWeek)}`,
    `- kredi taksiti (ay): ${fmtTL(installmentLoadMonth)}`,
    ``,
    `## En büyük ödemeler`,
    ...(largest.length ? largest.map((i) => `- ${i.dueDate} · ${i.name} · ${formatReportInstanceAmount(i)}`) : ["- yok"]),
    ``,
    `## Riskli günler (${input.riskDays.length})`,
    ...(input.riskDays.length
      ? input.riskDays.map((d) => `- ${d.date} · ${d.count} kalem · ${fmtTL(d.knownSum)}${d.critical ? " · KRİTİK" : ""}${d.cluster ? " · yığılma" : ""}`)
      : ["- yok"]),
    ...(input.provenance
      ? [
          ``,
          `## Veri kaynağı ve güven derecesi`,
          `- Güven derecesi: ${lineage.confidenceGrade}`,
          ...(lineage.lineageSummaryLine ? [`- ${lineage.lineageSummaryLine}`] : []),
          ...(input.provenance.missingMaterialInputs?.length
            ? input.provenance.missingMaterialInputs.map((m) => `- ${m}`)
            : []),
        ]
      : []),
    ``,
    `## Hazırlık aksiyonları`,
    ...actions.map((a) => `- [ ] ${a}`),
  ].join("\n");

  return {
    from: todayISO,
    to,
    asOf: lineage.asOf,
    businessDateISO: lineage.businessDateISO,
    knownTotal,
    missingCount,
    largest,
    checkLoad,
    installmentLoadWeek,
    installmentLoadMonth,
    riskDays: input.riskDays,
    actions,
    monetaryBasisByMetric: lineage.monetaryBasisByMetric,
    confidenceGrade: lineage.confidenceGrade,
    sourceFreshnessDays: lineage.sourceFreshnessDays,
    latestValidImportAt: lineage.latestValidImportAt,
    source_id: lineage.source_id,
    sourceWorkbookId: lineage.sourceWorkbookId,
    reconciliationAligned: lineage.reconciliationAligned,
    reconciliationStatus: lineage.reconciliationStatus,
    staleDataWatermark: lineage.staleDataWatermark,
    bodyMd,
  };
}

/* ── 3) monthly report ── */

export interface ConcentrationRow { key: string; amount: number }
export interface MonthlyReportInput {
  monthStart: string;
  knownTotal: number;
  knownRemaining: number;
  paidKnown: number;
  missingCount: number;
  totalCount: number;
  cancelledCount?: number;
  cancelledKnownTotal?: number;
  settlementAdjustmentTry?: number;
  overpaymentAdjustmentTry?: number;
  foreignCount?: number;
  topPayments: ReportInstance[]; // pre-sorted desc by amount, top 10
  providerDist: ConcentrationRow[];
  categoryDist: ConcentrationRow[];
  ownerDist: ConcentrationRow[];
  checksInMonth: ReportMaturity[];
  installmentsInMonth: ReportMaturity[];
  cashMonth: { opening: number | null; income: number | null; expense: number | null; closing: number | null } | null;
  actualBankCashStatus?: MonthlyActualBankCashStatus | null;
  provenance?: MonthlyProvenanceBadge | null;
  dataQualityIssues: string[];
}

export interface MonthlyReport {
  monthStart: string;
  asOf: string;
  businessDateISO: string;
  paidUnpaidSplit: { paid: number; remaining: number };
  debtServiceKnown: number;
  monetaryBasisByMetric: Record<string, MonetaryEpistemicBasis>;
  confidenceGrade: ReportConfidenceGrade;
  sourceFreshnessDays: number | null;
  latestValidImportAt: string | null;
  source_id: string | null;
  sourceWorkbookId: string | null;
  reconciliationAligned: boolean;
  reconciliationStatus: ReportReconciliationState;
  staleDataWatermark: string | null;
  bodyMd: string;
}

export function buildMonthlyReport(input: MonthlyReportInput): MonthlyReport {
  // Faz 46 (C3): Exclude customer inflow checks from debt service and sum via Big.js (`money`).
  const checksOutflow = sumKnown(
    input.checksInMonth.filter((m) => m.direction === "outflow"),
  ).total;
  const installmentsOutflow = sumKnown(
    input.installmentsInMonth.filter((m) => m.direction !== "inflow"),
  ).total;
  const debtServiceKnown = money(decimal(checksOutflow).plus(decimal(installmentsOutflow)));
  const cm = input.cashMonth;
  const act = input.actualBankCashStatus;
  const prov = input.provenance;
  const cancelledCount = input.cancelledCount ?? 0;
  const cancelledKnownTotal = input.cancelledKnownTotal ?? 0;
  const settlementAdjustmentTry = input.settlementAdjustmentTry ?? 0;
  const overpaymentAdjustmentTry = input.overpaymentAdjustmentTry ?? 0;
  const foreignCount = input.foreignCount ?? 0;
  const distBlock = (title: string, rows: ConcentrationRow[]) =>
    [`### ${title}`, ...(rows.length ? rows.slice(0, 5).map((r) => `- ${r.key}: ${fmtTL(r.amount)}`) : ["- yok"])];

  const lineage = evaluateReportCashAndLineage(input.monthStart, act, prov);
  const availableBankCashBasis = lineage.monetaryBasisByMetric.availableBankCash;

  const qualityLines: string[] = [...input.dataQualityIssues];
  if (prov) {
    qualityLines.push(`Güven derecesi: ${lineage.confidenceGrade}`);
    if (lineage.lineageSummaryLine) {
      qualityLines.push(lineage.lineageSummaryLine);
    }
    if (prov.missingMaterialInputs?.length) {
      for (const m of prov.missingMaterialInputs) {
        if (!qualityLines.includes(m)) qualityLines.push(m);
      }
    }
  }

  const bodyMd = [
    `# Aylık Rapor — ${input.monthStart.slice(0, 7)}`,
    ...(lineage.staleDataWatermark ? [``, `> ${lineage.staleDataWatermark}`] : []),
    ``,
    ...(act
      ? [
          `## Fiili Kasa & Banka Mutabakat Durumu (ACTUAL / RECONCILED / UNKNOWN)`,
          `- fiili kullanılabilir kasa: ${lineage.actualCashText}`,
          `- banka ekstresi ve mutabakat: ${lineage.bankReconText}`,
          ``,
        ]
      : []),
    ...(cm
      ? [
          `## Tahmini Nakit Akışı ([FORECAST] — Çalışma Kitabı Projeksiyonu, Fiili Banka Bakiyesi Değildir)`,
          `- devir: ${fmtTL(cm.opening)} · gelir: ${fmtTL(cm.income)} · gider: ${fmtTL(cm.expense)} · kasa ([FORECAST]): ${fmtTL(cm.closing)}`,
          ...(act && availableBankCashBasis === "UNKNOWN" && cm.closing != null
            ? [
                `- ⚠ Epistemik ayrım: Çalışma kitabı tahmini kapanışı (${fmtTL(cm.closing)}) yalnızca [FORECAST] projeksiyondur; fiili banka kasası [UNKNOWN] durumdadır.`,
              ]
            : []),
          ``,
        ]
      : []),
    `## Ödeme yükü (PLANNED / ACTUAL)`,
    `- bilinen toplam: ${fmtTL(input.knownTotal)} [PLANNED]`,
    `- ödenen (bilinen): ${fmtTL(input.paidKnown)} [ACTUAL] · kalan (bilinen): ${fmtTL(input.knownRemaining)} [PLANNED]`,
    ...(settlementAdjustmentTry !== 0
      ? [`- kapama farkı / iskonto düzeltmesi: ${fmtTL(settlementAdjustmentTry)}`]
      : []),
    ...(overpaymentAdjustmentTry !== 0
      ? [`- fazla ödeme düzeltmesi: ${fmtTL(overpaymentAdjustmentTry)}`]
      : []),
    ...(cancelledCount > 0
      ? [`- İptal edilen (toplam dışı): ${cancelledCount} kalem · ${fmtTL(cancelledKnownTotal)}`]
      : []),
    `- kalem: ${input.totalCount} · tutar eksik: ${input.missingCount}${foreignCount > 0 ? ` · ${foreignNote(foreignCount)}` : ""}`,
    `- borç servisi (çek+taksit, bilinen): ${fmtTL(debtServiceKnown)} [PLANNED]`,
    ``,
    `## En büyük 10 ödeme`,
    ...(input.topPayments.length
      ? input.topPayments.map(
          (i) => `- ${i.name} · ${formatReportInstanceAmount(i)}${i.status === "paid" ? " · ✓ödendi" : ""}`,
        )
      : ["- yok"]),
    ``,
    ...distBlock("Sağlayıcı dağılımı", input.providerDist),
    ``,
    ...distBlock("Kategori dağılımı", input.categoryDist),
    ``,
    ...distBlock("Sahip (owner) dağılımı", input.ownerDist),
    ``,
    `## Veri kalitesi`,
    ...(qualityLines.length ? qualityLines.map((d) => `- ${d}`) : ["- sorun yok"]),
  ].join("\n");

  return {
    monthStart: input.monthStart,
    asOf: lineage.asOf,
    businessDateISO: lineage.businessDateISO,
    paidUnpaidSplit: { paid: input.paidKnown, remaining: input.knownRemaining },
    debtServiceKnown,
    monetaryBasisByMetric: lineage.monetaryBasisByMetric,
    confidenceGrade: lineage.confidenceGrade,
    sourceFreshnessDays: lineage.sourceFreshnessDays,
    latestValidImportAt: lineage.latestValidImportAt,
    source_id: lineage.source_id,
    sourceWorkbookId: lineage.sourceWorkbookId,
    reconciliationAligned: lineage.reconciliationAligned,
    reconciliationStatus: lineage.reconciliationStatus,
    staleDataWatermark: lineage.staleDataWatermark,
    bodyMd,
  };
}

/* ── 4) debt-service × cashflow overlay ("eklensin") ── */

export interface CashMonthLite { monthStart: string; closing: number | null }
export interface DebtMonthLite { monthStart: string; knownOutflow: number; count: number; missingCount: number }

export interface OverlayRow {
  monthStart: string;
  closing: number | null;
  debtOutflow: number;
  debtCount: number;
  debtMissingCount: number;
  pressure: "none" | "watch" | "high";
}

/**
 * Overlays Phase-5 debt service (checks + installments due in a month) onto the
 * Phase-4 projected closing balance.
 *
 * Faz 46 (C3) fixed threshold ladder:
 * - `high`: `closing < 0` with debt present, OR positive `closing` where `debtOutflow > closing * criticalRatio`.
 * - `watch`: `closing == null` or `closing == 0` with debt present, OR `missingCount > 0` (`BLANK ≠ ZERO`),
 *   OR `debtOutflow > closing * watchRatio`.
 * - `none`: healthy (`closing > 0`, `missingCount === 0`, and `debtOutflow <= closing * watchRatio`) or no debt.
 */
export function overlayDebtService(
  months: CashMonthLite[],
  debt: DebtMonthLite[],
  watchRatio = 0.25,
  criticalRatio = 0.75,
): OverlayRow[] {
  const debtBy = new Map(debt.map((d) => [d.monthStart, d]));
  const watchBig = decimal(watchRatio);
  const criticalBig = decimal(criticalRatio);

  return [...months]
    .sort((a, b) => (a.monthStart < b.monthStart ? -1 : 1))
    .map((m) => {
      const d = debtBy.get(m.monthStart);
      const debtOutflow = d?.knownOutflow ?? 0;
      const debtMissingCount = d?.missingCount ?? 0;
      let pressure: OverlayRow["pressure"] = "none";

      if (debtOutflow > 0 || debtMissingCount > 0) {
        if (
          m.closing != null &&
          (m.closing < 0 ||
            (m.closing > 0 && decimal(debtOutflow).gt(decimal(m.closing).times(criticalBig))))
        ) {
          pressure = "high";
        } else if (
          m.closing == null ||
          m.closing === 0 ||
          debtMissingCount > 0 ||
          decimal(debtOutflow).gt(decimal(m.closing).times(watchBig))
        ) {
          pressure = "watch";
        } else {
          pressure = "none";
        }
      }

      return {
        monthStart: m.monthStart,
        closing: m.closing,
        debtOutflow,
        debtCount: d?.count ?? 0,
        debtMissingCount,
        pressure,
      };
    });
}

/* ── 5) AI commentary prompt (template only — NO API call, NO mutation) ── */

export interface CommentaryFacts {
  scope: "daily" | "weekly" | "monthly";
  period: string;
  deterministicFacts: string[]; // already-computed numbers only
}

/**
 * Returns a PROMPT STRING for an AI narrative layer. AI may explain these
 * pre-computed facts; it is explicitly forbidden from changing any value, marking
 * paid, or recomputing. This function never calls a model and never mutates.
 */
export function buildCommentaryPrompt(facts: CommentaryFacts): string {
  return [
    `Sen MAS Nakit Radar'ın yorum katmanısın. Aşağıdaki DETERMİNİSTİK gerçekleri`,
    `Türkçe, kısa ve operasyonel biçimde yorumla. KESİN KURAL: hiçbir değeri değiştirme,`,
    `yeniden hesaplama, "ödendi" işaretleme veya kayıt silme. Yalnızca zaten hesaplanmış`,
    `sayıları açıkla ve "sırada ne kontrol edilmeli" öner. Kaynak-of-truth veritabanıdır.`,
    ``,
    `Kapsam: ${facts.scope} · Dönem: ${facts.period}`,
    `Gerçekler:`,
    ...facts.deterministicFacts.map((f) => `- ${f}`),
  ].join("\n");
}

export { fmtTL as reportFmtTL };
