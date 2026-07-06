import { describe, it, expect } from "vitest";
import * as XLSX from "xlsx";
import {
  asNumber,
  cellsToMap,
  cellsToRows,
  hashRow,
  monthSheetNameToISO,
  serialToISO,
  sheetCells,
  type CellVal,
  type SheetRow,
} from "./row-utils";
import {
  extractChecks,
  extractLoan,
  extractMonthlyCashflow,
  extractPaymentMatrix,
} from "./extractors";

const C = (v: string | number, t: CellVal["t"] = typeof v === "number" ? "n" : "s"): CellVal => ({ v, t });
const row = (rowIndex: number, cells: Record<string, CellVal>): SheetRow => ({ rowIndex, cells });

describe("row-utils", () => {
  it("sheetCells + cellsToRows preserve every populated cell (no silent discard)", () => {
    const ws = XLSX.utils.aoa_to_sheet([
      ["ad", null, 3],
      [null, "x"],
    ]);
    const cells = sheetCells(ws);
    expect(cells).toHaveLength(3);
    const rows = cellsToRows(cells);
    expect(rows).toHaveLength(2);
    expect(rows[0].cells["A"].v).toBe("ad");
    expect(rows[0].cells["C"].v).toBe(3);
    expect(rows[1].cells["B"].v).toBe("x");
    expect(Object.keys(cellsToMap(cells))).toEqual(["A1", "C1", "B2"]);
  });

  it("hashRow is stable and content-sensitive", () => {
    const a = { A: C("KİRA"), K: C(35000) };
    expect(hashRow(a)).toBe(hashRow({ A: C("KİRA"), K: C(35000) }));
    expect(hashRow(a)).not.toBe(hashRow({ A: C("KİRA"), K: C(36000) }));
  });

  it("monthSheetNameToISO handles all TR casing variants", () => {
    expect(monthSheetNameToISO("mayıs 2026")).toBe("2026-05-01");
    expect(monthSheetNameToISO("ŞUBAT 2028")).toBe("2028-02-01");
    expect(monthSheetNameToISO("EKİM 2028")).toBe("2028-10-01");
    expect(monthSheetNameToISO("ARALIK 2026")).toBe("2026-12-01");
    expect(monthSheetNameToISO("KASIM 2028")).toBe("2028-11-01");
    expect(monthSheetNameToISO("faiz hesaplama")).toBeNull();
  });

  it("serialToISO matches the workbook's known date (45583 → 2024-10-18)", () => {
    expect(serialToISO(45583)).toBe("2024-10-18");
  });

  it("asNumber parses TR-formatted strings", () => {
    expect(asNumber(C("1.500.000"))).toBe(1500000);
    expect(asNumber(C("3,63"))).toBe(3.63);
    expect(asNumber(C(-60000))).toBe(-60000);
    expect(asNumber(undefined)).toBeNull();
  });
});

describe("extractPaymentMatrix — import-mapping §1 rules on real-shaped fixtures", () => {
  // Day columns: B=1 ... AF=31. AG = amount candidate.
  const rows: SheetRow[] = [
    row(3, { A: C("MAS ELEKTRİK"), D: C("X") }), // day 3, no amount
    row(6, { A: C("MAS ALARM-PRONET") }), // no marker
    row(16, { A: C("MAS TELEFON TİJEN"), W: C("x"), AG: C(-60000) }), // day 22, negative
    row(17, { A: C("MAS TELEFON ÖMER"), AA: C("X"), AG: C(90000) }), // alignment doubt
    row(21, { A: C("garanti kredi"), Q: C("X"), AG: C(190000) }), // day 16, plain amount
    row(23, { A: C("KİRA"), K: C(35000) }), // numeric-in-day-cell: day 10 AND amount
    row(25, { AG: C(120000) }), // unlabeled amount
  ];
  const { candidates, issues } = extractPaymentMatrix(rows);
  const byName = Object.fromEntries(candidates.filter((c) => c.name).map((c) => [c.name, c]));
  const types = issues.map((i) => i.issue_type);

  it("X marker → correct due day (D→3, Q→16, W→22, AA→26)", () => {
    expect(byName["MAS ELEKTRİK"].dueDay).toBe(3);
    expect(byName["garanti kredi"].dueDay).toBe(16);
    expect(byName["MAS TELEFON TİJEN"].dueDay).toBe(22);
    expect(byName["MAS TELEFON ÖMER"].dueDay).toBe(26);
  });

  it("KİRA: numeric in day cell K = day 10 AND amount 35000 (source: day_cell)", () => {
    expect(byName["KİRA"].dueDay).toBe(10);
    expect(byName["KİRA"].amountCandidate).toBe(35000);
    expect(byName["KİRA"].amountSource).toBe("day_cell");
    expect(byName["garanti kredi"].amountSource).toBe("ag");
  });

  it("missing due day flagged (PRONET)", () => {
    expect(byName["MAS ALARM-PRONET"].dueDay).toBeNull();
    expect(byName["MAS ALARM-PRONET"].flags).toContain("missing_due_day");
    expect(types).toContain("missing_due_day");
  });

  it("negative amount flagged (TİJEN −60000)", () => {
    expect(byName["MAS TELEFON TİJEN"].flags).toContain("negative_amount");
  });

  it("telefon ≥45k AG alignment doubt flagged, plain kredi amount NOT flagged", () => {
    expect(byName["MAS TELEFON ÖMER"].flags).toContain("amount_alignment");
    expect(byName["garanti kredi"].flags).not.toContain("amount_alignment");
  });

  it("unlabeled AG25 amount becomes high-severity review item, still preserved", () => {
    const unl = issues.find((i) => i.issue_type === "unlabeled_amount");
    expect(unl?.severity).toBe("high");
    expect(candidates.some((c) => c.name === null && c.amountCandidate === 120000)).toBe(true);
  });
});

describe("extractMonthlyCashflow — anchors + regions + identity", () => {
  const map = {
    A1: C("devir"), B1: C(100000),
    C1: C("gelir"), D1: C(1500000),
    E1: C("gider"), F1: C(1400000),
    G1: C("fark aylık"), H1: C(100000),
    I1: C("kasa"), J1: C(200000),
    A3: C("akon"), B3: C(800000),
    A4: C("metsan"), B4: C(700000),
    F3: C("CARİ ÖDEMELER"),
    F4: C("elit"), G4: C(250000),
    J3: C("bankalar"),
    J4: C("HESAP halk"), K4: C(-135000),
    J17: C("vakıf-3850000"), K17: C(3850000),
    K18: C(410000), // unlabeled side tracker value
    O5: C(125000), // orphan
  };

  const p = extractMonthlyCashflow("ŞUBAT 2028", map as Record<string, CellVal>);

  it("month + header anchors read correctly", () => {
    expect(p.monthStart).toBe("2028-02-01");
    expect(p.opening).toBe(100000);
    expect(p.closing).toBe(200000);
    expect(p.identityHolds).toBe(true);
  });

  it("regions typed: income inflow, vendor outflow, bank balance (negative allowed)", () => {
    const income = p.lines.filter((l) => l.line_type === "customer_income");
    expect(income.map((l) => l.label)).toEqual(["akon", "metsan"]);
    const vendor = p.lines.find((l) => l.label === "elit");
    expect(vendor?.direction).toBe("outflow");
    const bank = p.lines.find((l) => l.label === "HESAP halk");
    expect(bank?.line_type).toBe("bank_balance");
    expect(bank?.amount).toBe(-135000); // negative balance is NOT an anomaly
    expect(p.issues.map((i) => i.issue_type)).not.toContain("negative_amount");
  });

  it("block titles are not lines; side trackers and orphans become issues", () => {
    expect(p.lines.some((l) => l.label === "CARİ ÖDEMELER")).toBe(false);
    expect(p.lines.some((l) => l.label === "bankalar")).toBe(false);
    const types = p.issues.map((i) => i.issue_type);
    expect(types).toContain("unlabeled_side_tracker");
    expect(types).toContain("orphan_amount");
  });

  it("identity mismatch produces a high-severity issue", () => {
    const bad = extractMonthlyCashflow("mart 2029", {
      ...map,
      J1: C(999999),
    } as Record<string, CellVal>);
    expect(bad.identityHolds).toBe(false);
    expect(bad.issues.some((i) => i.issue_type === "cashflow_identity_mismatch")).toBe(true);
  });
});

describe("extractChecks — signed direction, header detect, duplicates", () => {
  const rows: SheetRow[] = [
    row(1, { A: C("TARİH"), B: C("SERİ"), C: C("KİME"), D: C("KİMDEN"), E: C("HALK"), F: C("DENİZ"), G: C("VİNOV") }),
    row(2, { A: C(46234), C: C("AKR"), E: C(-45000) }), // KİMDEN empty (real sheet shape)
    row(3, { A: C(46235), C: C("akr"), E: C(-45000) }), // duplicate-looking (+1 day, case variant)
    row(4, { A: C(46265), C: C("Y AŞ"), D: C("çağdaş"), F: C(-100000) }),
    row(5, { A: C(46284), C: C("MAS"), D: C("müşteri"), G: C(75000) }), // inflow
    row(6, { C: C("tarih yok"), D: C("Z"), E: C(-5000) }), // unparsed date
  ];
  const { candidates, issues } = extractChecks(rows);

  it("negative signed = outflow with bank from column; positive = inflow (not anomalies)", () => {
    const akr = candidates.find((c) => c.rowIndex === 2)!;
    expect(akr.direction).toBe("outflow");
    expect(akr.bank).toBe("HALK");
    expect(akr.maturityDate).toBe("2026-07-31");
    const inflow = candidates.find((c) => c.rowIndex === 5)!;
    expect(inflow.direction).toBe("inflow");
    expect(inflow.bank).toBe("VINOV");
    expect(issues.map((i) => i.issue_type)).not.toContain("negative_amount");
  });

  it("duplicate-looking pair flagged for review, both preserved", () => {
    expect(candidates.filter((c) => c.flags.includes("duplicate_check"))).toHaveLength(2);
    expect(issues.some((i) => i.issue_type === "duplicate_check")).toBe(true);
    expect(candidates).toHaveLength(5); // nothing dropped
  });

  it("row with amount but unparsable date → unparsed_row (high)", () => {
    const bad = issues.find((i) => i.issue_type === "unparsed_row");
    expect(bad?.severity).toBe("high");
  });

  it("missing header short-circuits with critical issue", () => {
    const r = extractChecks([row(1, { A: C("hiç") })]);
    expect(r.candidates).toHaveLength(0);
    expect(r.issues[0].issue_type).toBe("checks_header_not_found");
  });
});

describe("extractLoan — faiz hesaplama anchors + amortization (import-mapping §3)", () => {
  // Real anchor values from the workbook; 3-row amortization for the fixture.
  const base: Record<string, CellVal> = {
    D1: C("kredi taksit sayısı"), F1: C(25),
    A4: C("Kredi Tutarı"), B4: C(1500000), D4: C("kredi ilk ödeme tarihi"), F4: C(45583),
    A5: C("Kredi Vadesi"), B5: C(3), D5: C("kredi basit faiz oranı"), F5: C(3.63),
    A6: C("Kredi Faizi"), B6: C(3.14), D6: C("uygulanan faiz oranı"), F6: C(3.63),
    A7: C("BSMV"), B7: C(10), D7: C("aylık maliyet oranı"), F7: C(4.80116),
    A8: C("KKDF"), B8: C(10), D8: C("yıllık maliyet oranı"),
    A9: C("Taksit Tutarı"), B9: C(71744.11624119806),
    A10: C("toplam ödeme"), B10: C(215232.34872359418),
    A11: C("fark"), B11: C(-1284767.6512764059),
    B12: C(215232.34872359418),
    A13: C("Dönem Sayısı"), B13: C("Taksit Tutarı"), C13: C("Anapara"), D13: C("Faiz"), E13: C("KKDF"), F13: C("BSMV"),
    A14: C(1), B14: C(71744.11624119806), C14: C(15224.12), D14: C(47100), E14: C(4710), F14: C(4710),
    A15: C(2), B15: C(71744.11624119806), C15: C(15797.76), D15: C(46621.96), E15: C(6993.29), F15: C(2331.1),
    A16: C(3), B16: C(71744.11624119806), C16: C(16393.02), D16: C(46125.91), E16: C(6918.89), F16: C(2306.3),
    A17: C(""), // formula past term caches "" — must terminate the loop, not become no=0
  };

  it("maps every anchor; F4 serial → 2024-10-18; empty-string A cell stops rows", () => {
    const { loan } = extractLoan(base);
    expect(loan.principal).toBe(1500000);
    expect(loan.termMonths).toBe(3);
    expect(loan.simpleRate).toBe(3.14);
    expect(loan.bsmvRate).toBe(10);
    expect(loan.kkdfRate).toBe(10);
    expect(loan.installmentAmount).toBeCloseTo(71744.12, 2);
    expect(loan.totalPayment).toBeCloseTo(215232.35, 2);
    expect(loan.totalFinanceCost).toBeCloseTo(-1284767.65, 2);
    expect(loan.installmentSum).toBeCloseTo(215232.35, 2);
    expect(loan.firstPaymentDate).toBe("2024-10-18");
    expect(loan.appliedRate).toBe(3.63);
    expect(loan.monthlyCostRate).toBe(4.80116);
    expect(loan.annualCostRate).toBeNull(); // F8 empty in source — stays null
    expect(loan.installments).toHaveLength(3);
    expect(loan.installments[0]).toMatchObject({ no: 1, rowIndex: 14, amount: 71744.11624119806, interest: 47100 });
    expect(loan.installments[2].kkdf).toBe(6918.89);
  });

  it("F1 ≠ B5 → loan_field_ambiguous (low), human decides", () => {
    const { issues } = extractLoan(base);
    const amb = issues.find((i) => i.issue_type === "loan_field_ambiguous");
    expect(amb?.severity).toBe("low");
    expect(amb?.message).toContain("25");
  });

  it("term/rows mismatch flagged (medium)", () => {
    const { issues } = extractLoan({ ...base, B5: C(48) });
    expect(issues.some((i) => i.issue_type === "loan_term_mismatch")).toBe(true);
  });

  it("missing F4 → loan_missing_first_date (high); missing B4 → critical", () => {
    const noDate = { ...base };
    delete noDate.F4;
    expect(extractLoan(noDate).issues.some((i) => i.issue_type === "loan_missing_first_date")).toBe(true);
    const noPrincipal = { ...base };
    delete noPrincipal.B4;
    const critical = extractLoan(noPrincipal).issues.find((i) => i.issue_type === "loan_header_missing");
    expect(critical?.severity).toBe("critical");
    expect(extractLoan(noPrincipal).loan.principal).toBeNull(); // null stays null
  });

  it("installment row with missing amount flagged, not zeroed", () => {
    const holed = { ...base };
    delete holed.B15;
    const { loan, issues } = extractLoan(holed);
    expect(loan.installments[1].amount).toBeNull();
    expect(issues.some((i) => i.issue_type === "loan_installment_missing_amount")).toBe(true);
  });
});
