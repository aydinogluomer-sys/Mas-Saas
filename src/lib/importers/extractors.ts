// Extraction previews (Phase 2). Pure functions: staging candidates + review issues.
// Rules source: docs/import-mapping.md. These NEVER write domain tables —
// they produce previews and mapping_review issues only.

import * as XLSX from "xlsx";
import {
  asNumber,
  asText,
  monthSheetNameToISO,
  serialToISO,
  type CellVal,
  type SheetRow,
} from "./row-utils";
import { normalizeTr } from "./workbook-parser";

export interface ReviewIssue {
  rowIndex: number | null;
  issue_type: string;
  severity: "low" | "medium" | "high" | "critical";
  message: string;
}

/* ───────────────── 1) ödeme tablosu — payment day matrix ───────────────── */

export interface PaymentCandidate {
  rowIndex: number;
  name: string | null;
  dueDay: number | null;
  amountCandidate: number | null;
  amountSource: "day_cell" | "ag" | null;
  flags: string[];
}

const DAY_COL_FIRST = 1; // column B (0-based col 1) = day 1
const DAY_COL_LAST = 31; // column AF = day 31
const AMOUNT_COL = "AG";
const AMOUNT_ALIGNMENT_DOUBT_MIN = 45_000; // import-mapping §1: telefon 45k/90k şüphesi

export function extractPaymentMatrix(rows: SheetRow[]): {
  candidates: PaymentCandidate[];
  issues: ReviewIssue[];
} {
  const candidates: PaymentCandidate[] = [];
  const issues: ReviewIssue[] = [];

  for (const row of rows) {
    if (row.rowIndex < 2) continue; // header band
    const name = asText(row.cells["A"]);
    const amountCell = row.cells[AMOUNT_COL];
    const amountCandidate = asNumber(amountCell);

    let dueDay: number | null = null;
    let dayCellAmount: number | null = null;
    let markerCount = 0;
    for (let day = DAY_COL_FIRST; day <= DAY_COL_LAST; day++) {
      const col = XLSX.utils.encode_col(day); // B..AF
      const c = row.cells[col];
      if (!c) continue;
      const txt = typeof c.v === "string" ? c.v.trim().toLowerCase() : null;
      if (txt === "x") {
        markerCount++;
        if (dueDay == null) dueDay = day;
      } else if (typeof c.v === "number" && c.v !== 0) {
        markerCount++;
        if (dueDay == null) dueDay = day;
        dayCellAmount = c.v; // import-mapping: numeric-in-day-cell = day AND amount (KİRA)
      }
    }

    const isNameRow = !!name;
    const finalAmount = dayCellAmount ?? amountCandidate;
    const amountSource: "day_cell" | "ag" | null =
      dayCellAmount != null ? "day_cell" : amountCandidate != null ? "ag" : null;

    if (!isNameRow && finalAmount != null) {
      issues.push({
        rowIndex: row.rowIndex,
        issue_type: "unlabeled_amount",
        severity: "high",
        message: `Etiketsiz tutar: satır ${row.rowIndex}, ${finalAmount}`,
      });
      candidates.push({
        rowIndex: row.rowIndex,
        name: null,
        dueDay,
        amountCandidate: finalAmount,
        amountSource,
        flags: ["unlabeled_amount"],
      });
      continue;
    }
    if (!isNameRow) continue; // truly empty row

    const flags: string[] = [];
    if (dueDay == null) {
      flags.push("missing_due_day");
      issues.push({
        rowIndex: row.rowIndex,
        issue_type: "missing_due_day",
        severity: "high",
        message: `"${name}" satırında gün işareti yok`,
      });
    }
    if (markerCount > 1) {
      flags.push("multiple_day_markers");
      issues.push({
        rowIndex: row.rowIndex,
        issue_type: "multiple_day_markers",
        severity: "medium",
        message: `"${name}" satırında ${markerCount} gün işareti var`,
      });
    }
    if (finalAmount != null && finalAmount < 0) {
      flags.push("negative_amount");
      issues.push({
        rowIndex: row.rowIndex,
        issue_type: "negative_amount",
        severity: "high",
        message: `"${name}" tutarı negatif: ${finalAmount}`,
      });
    }
    if (
      dayCellAmount == null &&
      amountCandidate != null &&
      amountCandidate >= AMOUNT_ALIGNMENT_DOUBT_MIN &&
      normalizeTr(name).includes("telefon")
    ) {
      flags.push("amount_alignment");
      issues.push({
        rowIndex: row.rowIndex,
        issue_type: "amount_alignment",
        severity: "high",
        message: `"${name}" için AG hizalama şüphesi: ${amountCandidate}`,
      });
    }
    candidates.push({ rowIndex: row.rowIndex, name, dueDay, amountCandidate: finalAmount, amountSource, flags });
  }
  return { candidates, issues };
}

/* ───────────────── 2) monthly cash-flow sheet ───────────────── */

export interface CashflowLinePreview {
  rowIndex: number;
  line_type:
    | "customer_income"
    | "vendor_payment"
    | "bank_balance"
    | "adjustment"
    | "unknown";
  direction: "inflow" | "outflow" | "balance" | "unknown";
  label: string;
  amount: number | null;
}

export interface MonthlyCashflowPreview {
  monthStart: string | null;
  opening: number | null; // B1 devir
  income: number | null; // D1 gelir
  expense: number | null; // F1 gider
  delta: number | null; // H1 fark aylık
  closing: number | null; // J1 kasa
  identityHolds: boolean | null; // closing == opening + income - expense (±1)
  lines: CashflowLinePreview[];
  issues: ReviewIssue[];
}

export function extractMonthlyCashflow(
  sheetName: string,
  map: Record<string, CellVal>,
): MonthlyCashflowPreview {
  const monthStart = monthSheetNameToISO(sheetName);
  const opening = asNumber(map["B1"]);
  const income = asNumber(map["D1"]);
  const expense = asNumber(map["F1"]);
  const delta = asNumber(map["H1"]);
  const closing = asNumber(map["J1"]);

  const issues: ReviewIssue[] = [];
  let identityHolds: boolean | null = null;
  if (opening != null && income != null && expense != null && closing != null) {
    identityHolds = Math.abs(opening + income - expense - closing) <= 1;
    if (!identityHolds) {
      issues.push({
        rowIndex: 1,
        issue_type: "cashflow_identity_mismatch",
        severity: "high",
        message: `kasa ≠ devir+gelir−gider (${closing} vs ${opening + income - expense})`,
      });
    }
  } else {
    issues.push({
      rowIndex: 1,
      issue_type: "cashflow_header_missing",
      severity: "high",
      message: "Başlık hücrelerinden biri boş (B1/D1/F1/H1/J1)",
    });
  }

  const lines: CashflowLinePreview[] = [];
  for (let r = 3; r <= 16; r++) {
    const incomeLabel = asText(map[`A${r}`]);
    if (incomeLabel) {
      lines.push({
        rowIndex: r,
        line_type: "customer_income",
        direction: "inflow",
        label: incomeLabel,
        amount: asNumber(map[`B${r}`]),
      });
    }
    const vendorLabel = asText(map[`F${r}`]);
    if (vendorLabel && r >= 4) {
      // F3 is the block title "CARİ ÖDEMELER"
      lines.push({
        rowIndex: r,
        line_type: "vendor_payment",
        direction: "outflow",
        label: vendorLabel,
        amount: asNumber(map[`G${r}`]),
      });
    }
    const bankLabel = asText(map[`J${r}`]);
    if (bankLabel && r >= 4) {
      // J3 is the block title "bankalar"
      lines.push({
        rowIndex: r,
        line_type: "bank_balance",
        direction: "balance",
        label: bankLabel,
        amount: asNumber(map[`K${r}`]),
      });
    }
  }
  // side trackers rows 17-21 (import-mapping §4) → adjustment, note only
  for (let r = 17; r <= 21; r++) {
    const label = asText(map[`J${r}`]);
    const amount = asNumber(map[`K${r}`]);
    if (label || amount != null) {
      lines.push({
        rowIndex: r,
        line_type: "adjustment",
        direction: "unknown",
        label: label ?? "(etiketsiz yan takip)",
        amount,
      });
      if (!label && amount != null) {
        issues.push({
          rowIndex: r,
          issue_type: "unlabeled_side_tracker",
          severity: "medium",
          message: `Satır ${r}: etiketsiz yan takip değeri ${amount}`,
        });
      }
    }
  }
  // stray O-column amounts (orphans)
  for (let r = 3; r <= 16; r++) {
    const orphan = asNumber(map[`O${r}`]);
    if (orphan != null && orphan !== 0) {
      issues.push({
        rowIndex: r,
        issue_type: "orphan_amount",
        severity: "medium",
        message: `O${r} başıboş tutar: ${orphan}`,
      });
    }
  }
  return { monthStart, opening, income, expense, delta, closing, identityHolds, lines, issues };
}

/* ───────────────── 3) ÇEKLER — checks ───────────────── */

export interface CheckCandidate {
  rowIndex: number;
  maturityDate: string | null;
  serial: string | null;
  payee: string | null; // kime
  payer: string | null; // kimden
  bank: string | null;
  signedAmount: number | null;
  direction: "inflow" | "outflow" | "unknown";
  flags: string[];
}

const BANK_TOKENS = ["halk", "deniz", "vinov"];

export function extractChecks(rows: SheetRow[]): {
  candidates: CheckCandidate[];
  issues: ReviewIssue[];
} {
  const issues: ReviewIssue[] = [];
  // 1) header detection: first row containing "tarih"
  let headerRow: SheetRow | undefined;
  for (const r of rows) {
    for (const c of Object.values(r.cells)) {
      if (typeof c.v === "string" && normalizeTr(c.v) === "tarih") {
        headerRow = r;
        break;
      }
    }
    if (headerRow) break;
  }
  if (!headerRow) {
    return {
      candidates: [],
      issues: [
        {
          rowIndex: null,
          issue_type: "checks_header_not_found",
          severity: "critical",
          message: "ÇEKLER başlık satırı (tarih) bulunamadı",
        },
      ],
    };
  }
  const colOf: Record<string, string> = {};
  const bankCols: Array<{ col: string; bank: string }> = [];
  for (const [col, c] of Object.entries(headerRow.cells)) {
    if (typeof c.v !== "string") continue;
    const n = normalizeTr(c.v);
    if (n === "tarih") colOf.tarih = col;
    else if (n.startsWith("seri") || n === "no") colOf.seri = col;
    else if (n === "kime") colOf.kime = col;
    else if (n === "kimden") colOf.kimden = col;
    else if (n.includes("tutar")) colOf.tutar = col;
    else {
      const bank = BANK_TOKENS.find((b) => n.includes(b));
      if (bank) bankCols.push({ col, bank: bank.toUpperCase() });
    }
  }

  const candidates: CheckCandidate[] = [];
  for (const r of rows) {
    if (r.rowIndex <= headerRow.rowIndex) continue;
    const dateCell = colOf.tarih ? r.cells[colOf.tarih] : undefined;
    let maturityDate: string | null = null;
    if (dateCell) {
      if (typeof dateCell.v === "number") maturityDate = serialToISO(dateCell.v);
      else if (typeof dateCell.v === "string" && /\d{1,2}[./]\d{1,2}[./]\d{2,4}/.test(dateCell.v)) {
        const [d, m, y] = dateCell.v.split(/[./]/).map(Number);
        maturityDate = `${y < 100 ? 2000 + y : y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
      }
    }

    let bank: string | null = null;
    let signedAmount: number | null = null;
    for (const bc of bankCols) {
      const n = asNumber(r.cells[bc.col]);
      if (n != null && n !== 0) {
        bank = bc.bank;
        signedAmount = n;
        break;
      }
    }
    if (signedAmount == null && colOf.tutar) signedAmount = asNumber(r.cells[colOf.tutar]);

    const payee = colOf.kime ? asText(r.cells[colOf.kime]) : null;
    const payer = colOf.kimden ? asText(r.cells[colOf.kimden]) : null;
    const serial = colOf.seri ? asText(r.cells[colOf.seri]) : null;

    const hasAny = maturityDate || payee || payer || signedAmount != null;
    if (!hasAny) continue;

    const flags: string[] = [];
    if (!maturityDate && signedAmount != null) {
      flags.push("unparsed_row");
      issues.push({
        rowIndex: r.rowIndex,
        issue_type: "unparsed_row",
        severity: "high",
        message: `Satır ${r.rowIndex}: tutar var ama vade tarihi çözülemedi`,
      });
    }
    candidates.push({
      rowIndex: r.rowIndex,
      maturityDate,
      serial,
      payee,
      payer,
      bank,
      signedAmount,
      direction: signedAmount == null ? "unknown" : signedAmount < 0 ? "outflow" : "inflow",
      flags,
    });
  }

  // duplicate suspicion: same counterparty + |amount| within ±3 days (calculation-rules)
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const a = candidates[i];
      const b = candidates[j];
      const keyA = normalizeTr(a.payer ?? a.payee ?? "");
      const keyB = normalizeTr(b.payer ?? b.payee ?? "");
      if (
        keyA !== "" &&
        keyA === keyB &&
        a.signedAmount != null &&
        b.signedAmount != null &&
        Math.abs(a.signedAmount) === Math.abs(b.signedAmount) &&
        a.maturityDate &&
        b.maturityDate &&
        Math.abs(Date.parse(a.maturityDate) - Date.parse(b.maturityDate)) <= 3 * 86400000
      ) {
        if (!a.flags.includes("duplicate_check")) a.flags.push("duplicate_check");
        if (!b.flags.includes("duplicate_check")) b.flags.push("duplicate_check");
        issues.push({
          rowIndex: b.rowIndex,
          issue_type: "duplicate_check",
          severity: "medium",
          message: `Olası çift kayıt: satır ${a.rowIndex} ↔ ${b.rowIndex} (${keyA}, ${Math.abs(b.signedAmount)})`,
        });
      }
    }
  }
  return { candidates, issues };
}

/* ───────────────── 4) faiz hesaplama — loan + amortization ───────────────── */
// Anchor map: docs/import-mapping.md §3. Amortization rows start at 14; the source
// A-column formula yields "" past the term, and asNumber("") is 0 → loop guards no<1.

export interface LoanInstallmentCandidate {
  no: number;
  rowIndex: number;
  amount: number | null; // B — taksit
  principal: number | null; // C — anapara
  interest: number | null; // D — faiz
  kkdf: number | null; // E
  bsmv: number | null; // F
}

export interface LoanCandidate {
  principal: number | null; // B4
  termMonths: number | null; // B5
  simpleRate: number | null; // B6
  bsmvRate: number | null; // B7
  kkdfRate: number | null; // B8
  installmentAmount: number | null; // B9
  totalPayment: number | null; // B10
  totalFinanceCost: number | null; // B11
  installmentSum: number | null; // B12 = SUM(B14:B105) — reconciliation source
  firstPaymentDate: string | null; // F4
  appliedRate: number | null; // F6
  monthlyCostRate: number | null; // F7
  annualCostRate: number | null; // F8
  headerInstallmentCount: number | null; // F1 "kredi taksit sayısı" — anlamı belirsiz
  installments: LoanInstallmentCandidate[];
}

const LOAN_AMORT_FIRST_ROW = 14;
const LOAN_AMORT_MAX_ROW = 500; // hard stop; real sheet ends ~105

export function extractLoan(map: Record<string, CellVal>): {
  loan: LoanCandidate;
  issues: ReviewIssue[];
} {
  const issues: ReviewIssue[] = [];

  const f4 = map["F4"];
  let firstPaymentDate: string | null = null;
  if (f4 && typeof f4.v === "number") firstPaymentDate = serialToISO(f4.v);
  else if (f4 && typeof f4.v === "string" && /\d{1,2}[./]\d{1,2}[./]\d{2,4}/.test(f4.v)) {
    const [d, m, y] = f4.v.split(/[./]/).map(Number);
    firstPaymentDate = `${y < 100 ? 2000 + y : y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }

  const installments: LoanInstallmentCandidate[] = [];
  for (let r = LOAN_AMORT_FIRST_ROW; r <= LOAN_AMORT_MAX_ROW; r++) {
    const no = asNumber(map[`A${r}`]);
    if (no == null || no < 1) break; // "" cached formula value → 0 → stop
    installments.push({
      no,
      rowIndex: r,
      amount: asNumber(map[`B${r}`]),
      principal: asNumber(map[`C${r}`]),
      interest: asNumber(map[`D${r}`]),
      kkdf: asNumber(map[`E${r}`]),
      bsmv: asNumber(map[`F${r}`]),
    });
  }

  const loan: LoanCandidate = {
    principal: asNumber(map["B4"]),
    termMonths: asNumber(map["B5"]),
    simpleRate: asNumber(map["B6"]),
    bsmvRate: asNumber(map["B7"]),
    kkdfRate: asNumber(map["B8"]),
    installmentAmount: asNumber(map["B9"]),
    totalPayment: asNumber(map["B10"]),
    totalFinanceCost: asNumber(map["B11"]),
    installmentSum: asNumber(map["B12"]),
    firstPaymentDate,
    appliedRate: asNumber(map["F6"]),
    monthlyCostRate: asNumber(map["F7"]),
    annualCostRate: asNumber(map["F8"]),
    headerInstallmentCount: asNumber(map["F1"]),
    installments,
  };

  if (loan.principal == null) {
    issues.push({
      rowIndex: 4,
      issue_type: "loan_header_missing",
      severity: "critical",
      message: "Kredi tutarı (B4) kaynakta yok — kredi aktarılamaz",
    });
  }
  if (firstPaymentDate == null) {
    issues.push({
      rowIndex: 4,
      issue_type: "loan_missing_first_date",
      severity: "high",
      message: "İlk ödeme tarihi (F4) çözülemedi — taksit vadeleri türetilemez",
    });
  }
  if (loan.termMonths != null && installments.length !== loan.termMonths) {
    issues.push({
      rowIndex: 13,
      issue_type: "loan_term_mismatch",
      severity: "medium",
      message: `Amortisman satırı ${installments.length} ≠ vade ${loan.termMonths}`,
    });
  }
  if (
    loan.headerInstallmentCount != null &&
    loan.termMonths != null &&
    loan.headerInstallmentCount !== loan.termMonths
  ) {
    issues.push({
      rowIndex: 1,
      issue_type: "loan_field_ambiguous",
      severity: "low",
      message: `F1 "kredi taksit sayısı"=${loan.headerInstallmentCount} ≠ B5 vade=${loan.termMonths} — anlamı belirsiz, insan kararı gerekli`,
    });
  }
  const missingAmounts = installments.filter((i) => i.amount == null);
  if (missingAmounts.length > 0) {
    issues.push({
      rowIndex: missingAmounts[0].rowIndex,
      issue_type: "loan_installment_missing_amount",
      severity: "high",
      message: `${missingAmounts.length} taksit satırında tutar yok (ilk: satır ${missingAmounts[0].rowIndex})`,
    });
  }
  return { loan, issues };
}

/* ───────────────── 5) kapasite — capacity model + parts ───────────────── */
// Anchors (docs/data-map.md + real audit): C1 freze TL/dk (2023 stale), C2 torna,
// B3 verim, I8 total theoretical revenue, K8 monthly theoretical. Parts rows 10..66:
// A code, B name, C qty, D torna-min/unit, E freze-min/unit, I FİYAT.

export interface CapacityPartCandidate {
  rowIndex: number;
  code: string | null;
  name: string | null;
  quantity: number | null;
  tornaMinutes: number | null;
  frezeMinutes: number | null;
  revenue: number | null;
  missingOperationTime: boolean;
}

export interface CapacityCandidate {
  frezeRateTLPerMin: number | null; // C1
  tornaRateTLPerMin: number | null; // C2
  efficiency: number | null; // B3
  rateYear: number | null; // from "2023 TL/DK ..." label
  theoreticalTotalRevenue: number | null; // I8
  theoreticalMonthlyRevenue: number | null; // K8
  minutesPerHour: number | null; // L2
  workDaysPerMonth: number | null; // M2
  hoursPerDay: number | null; // N2
  parts: CapacityPartCandidate[];
}

const CAP_PART_FIRST_ROW = 10;
const CAP_PART_MAX_ROW = 400;
const CAP_PART_END_GAP = 20; // consecutive non-part rows that end the parts region

export function extractCapacity(map: Record<string, CellVal>): {
  capacity: CapacityCandidate;
  issues: ReviewIssue[];
} {
  const issues: ReviewIssue[] = [];
  const label = asText(map["B1"]) ?? "";
  const yearMatch = label.match(/\b(20\d{2})\b/);
  const rateYear = yearMatch ? Number(yearMatch[1]) : null;

  // A PART row carries a quantity (C). Rows with only a label (A/B text, no qty) are
  // group headers (ARS14000, TEKNOPAR…) and are skipped WITHOUT ending the block —
  // gaps mid-block must not silently drop later parts. The region ends only after a
  // long run of empty rows.
  const parts: CapacityPartCandidate[] = [];
  let missingCount = 0;
  let started = false;
  let gap = 0;
  for (let r = CAP_PART_FIRST_ROW; r <= CAP_PART_MAX_ROW; r++) {
    const code = asText(map[`A${r}`]);
    const name = asText(map[`B${r}`]);
    const quantity = asNumber(map[`C${r}`]);
    if (quantity == null) {
      // label or empty row: skip; only terminate after a long empty run once started
      if (started && !code && !name) {
        if (++gap >= CAP_PART_END_GAP) break;
      }
      continue;
    }
    gap = 0;
    started = true;
    const torna = asNumber(map[`D${r}`]);
    const freze = asNumber(map[`E${r}`]);
    const missing = torna == null && freze == null;
    if (missing) missingCount++;
    parts.push({
      rowIndex: r,
      code,
      name,
      quantity,
      tornaMinutes: torna,
      frezeMinutes: freze,
      revenue: asNumber(map[`I${r}`]),
      missingOperationTime: missing,
    });
  }

  const capacity: CapacityCandidate = {
    frezeRateTLPerMin: asNumber(map["C1"]),
    tornaRateTLPerMin: asNumber(map["C2"]),
    efficiency: asNumber(map["B3"]),
    rateYear,
    theoreticalTotalRevenue: asNumber(map["I8"]),
    theoreticalMonthlyRevenue: asNumber(map["K8"]),
    minutesPerHour: asNumber(map["L2"]),
    workDaysPerMonth: asNumber(map["M2"]),
    hoursPerDay: asNumber(map["N2"]),
    parts,
  };

  // stale-rate flag (calculation-rules §Capacity): 2023 tariff is stale
  if (rateYear != null && rateYear < new Date().getFullYear()) {
    issues.push({
      rowIndex: 1,
      issue_type: "stale_rate",
      severity: "medium",
      message: `Kapasite TL/dk oranları ${rateYear} tarifesi — güncel değil (stale_rate)`,
    });
  }
  if (missingCount > 0) {
    issues.push({
      rowIndex: CAP_PART_FIRST_ROW,
      issue_type: "missing_operation_time",
      severity: "medium",
      message: `${missingCount} parçada torna+freze süresi eksik — parça maliyeti güveni düşük`,
    });
  }
  if (capacity.frezeRateTLPerMin == null && capacity.tornaRateTLPerMin == null) {
    issues.push({
      rowIndex: 1,
      issue_type: "capacity_rate_missing",
      severity: "high",
      message: "Kapasite TL/dk oranları (C1/C2) okunamadı",
    });
  }
  return { capacity, issues };
}

/* ───────────────── 6) maliyet-mastechnic(mesaili) — cost model ───────────────── */
// Anchors: A2 monthly minutes/machine, A6 machine count, B6 personel, C6 çırak,
// E6 efficiency, F6 effective minutes, G6 break-even TL/dk, B7 monthly cost.
// Reconciliation: F6 ≈ A6×A2×E6 and G6 ≈ B7÷F6 (flagged if diverging).

export interface CostModelCandidate {
  scenario: "normal" | "overtime";
  monthlyMinutesPerMachine: number | null; // A2
  monthlyHours: number | null; // B2
  machineCount: number | null; // A6
  staffCount: number | null; // B6
  apprenticeCount: number | null; // C6
  efficiency: number | null; // E6
  effectiveMonthlyMinutes: number | null; // F6
  breakEvenTLPerMin: number | null; // G6
  monthlyCost: number | null; // B7
  foodDailyCost: number | null; // E1
  healthInsuranceCost: number | null; // H1
  machineInsuranceCost: number | null; // H2
}

export function extractCostModel(
  map: Record<string, CellVal>,
  scenario: "normal" | "overtime",
): { cost: CostModelCandidate; issues: ReviewIssue[] } {
  const issues: ReviewIssue[] = [];
  const cost: CostModelCandidate = {
    scenario,
    monthlyMinutesPerMachine: asNumber(map["A2"]),
    monthlyHours: asNumber(map["B2"]),
    machineCount: asNumber(map["A6"]),
    staffCount: asNumber(map["B6"]),
    apprenticeCount: asNumber(map["C6"]),
    efficiency: asNumber(map["E6"]),
    effectiveMonthlyMinutes: asNumber(map["F6"]),
    breakEvenTLPerMin: asNumber(map["G6"]),
    monthlyCost: asNumber(map["B7"]),
    foodDailyCost: asNumber(map["E1"]),
    healthInsuranceCost: asNumber(map["H1"]),
    machineInsuranceCost: asNumber(map["H2"]),
  };

  // reconcile effective minutes = machines × minutes × efficiency (±1 dk)
  if (cost.machineCount != null && cost.monthlyMinutesPerMachine != null && cost.efficiency != null && cost.effectiveMonthlyMinutes != null) {
    const derived = cost.machineCount * cost.monthlyMinutesPerMachine * cost.efficiency;
    if (Math.abs(derived - cost.effectiveMonthlyMinutes) > 1) {
      issues.push({
        rowIndex: 6,
        issue_type: "capacity_minutes_reconciliation",
        severity: "medium",
        message: `Etkin dakika ${cost.effectiveMonthlyMinutes} ≠ makine×dk×verim ${derived.toFixed(0)} (${scenario})`,
      });
    }
  }
  // reconcile break-even = monthly cost ÷ effective minutes (±0.1 TL/dk)
  if (cost.monthlyCost != null && cost.effectiveMonthlyMinutes != null && cost.effectiveMonthlyMinutes !== 0 && cost.breakEvenTLPerMin != null) {
    const derived = cost.monthlyCost / cost.effectiveMonthlyMinutes;
    if (Math.abs(derived - cost.breakEvenTLPerMin) > 0.1) {
      issues.push({
        rowIndex: 6,
        issue_type: "break_even_reconciliation",
        severity: "medium",
        message: `Başabaş ${cost.breakEvenTLPerMin} ≠ maliyet÷dakika ${derived.toFixed(4)} (${scenario})`,
      });
    }
  }
  if (cost.breakEvenTLPerMin == null && cost.monthlyCost == null) {
    issues.push({
      rowIndex: 6,
      issue_type: "cost_model_missing",
      severity: "high",
      message: `Maliyet modeli çapaları (B7/G6) okunamadı (${scenario})`,
    });
  }
  return { cost, issues };
}
