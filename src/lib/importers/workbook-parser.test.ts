import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as XLSX from "xlsx";
import {
  classifySheetName,
  isMonthlyCashflowName,
  listSheets,
  normalizeTr,
  safeParseWorkbook,
} from "./workbook-parser";

describe("normalizeTr", () => {
  it("handles Turkish dotted/dotless I correctly", () => {
    expect(normalizeTr("ARALIK 2026")).toBe("aralık 2026");
    expect(normalizeTr("EKİM 2028")).toBe("ekim 2028");
    expect(normalizeTr("ŞUBAT 2028")).toBe("şubat 2028");
    expect(normalizeTr("İNTERNET")).toBe("internet");
    expect(normalizeTr("KASIM 2028")).toBe("kasım 2028");
  });
});

describe("classifySheetName — every real sheet family from the workbook", () => {
  const cases: Array<[string, string, string]> = [
    // [sheet name as it appears, expected type, expected confidence]
    ["faiz hesaplama", "loan_calculation", "high"],
    ["kapasite", "capacity", "high"],
    ["tablo", "machine_roi", "medium"],
    ["ödeme tablosu", "payment_day_matrix", "high"],
    ["ÇEKLER", "checks", "high"],
    ["maliyet-mastechnicmesaili", "cost_model_overtime", "high"],
    ["maliyet-mastechnic", "cost_model_normal", "high"],
    // monthly sheets incl. every mixed-casing variant present in the file
    ["mayıs 2026", "monthly_cashflow", "high"],
    ["haziran 2026", "monthly_cashflow", "high"],
    ["ARALIK 2026", "monthly_cashflow", "high"],
    ["OCAK 2027", "monthly_cashflow", "high"],
    ["ŞUBAT 2028", "monthly_cashflow", "high"],
    ["EKİM 2028", "monthly_cashflow", "high"],
    ["KASIM 2028", "monthly_cashflow", "high"],
    ["ARALIK 2028", "monthly_cashflow", "high"],
    ["mart 2029", "monthly_cashflow", "high"],
    // sheet added by the earlier cleanup pass — must be kept, listed, unknown
    ["DEĞİŞİKLİK NOTLARI", "unknown", "unknown"],
  ];
  it.each(cases)("%s → %s (%s)", (name, type, conf) => {
    const r = classifySheetName(name);
    expect(r.detectedType).toBe(type);
    expect(r.parseConfidence).toBe(conf);
  });

  it("ödeme tablosu must not be shadowed by generic 'tablo'", () => {
    expect(classifySheetName("ödeme tablosu").detectedType).toBe("payment_day_matrix");
  });

  it("month name without a year is NOT monthly_cashflow", () => {
    expect(isMonthlyCashflowName(normalizeTr("mart"))).toBe(false);
    expect(classifySheetName("mart").detectedType).toBe("unknown");
  });
});

describe("safeParseWorkbook", () => {
  const dir = mkdtempSync(join(tmpdir(), "spike-"));

  it("rejects an all-zero-bytes file with a documented signature error", () => {
    const p = join(dir, "corrupt.xlsx");
    writeFileSync(p, Buffer.alloc(512, 0));
    const r = safeParseWorkbook(p);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/no valid XLSX\/ZIP signature/);
      expect(r.error).toMatch(/0x00000000/);
    }
  });

  it("rejects an empty file", () => {
    const p = join(dir, "empty.xlsx");
    writeFileSync(p, Buffer.alloc(0));
    const r = safeParseWorkbook(p);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/empty file/);
  });

  it("parses a real workbook and lists every sheet (no silent discard)", () => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet([["Kredi Tutarı", 1500000]]),
      "faiz hesaplama",
    );
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet([["devir", 0, "gelir"]]),
      "mayıs 2026",
    );
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([["?"]]), "NOT DEFTERİ");
    const p = join(dir, "valid.xlsx");
    XLSX.writeFile(wb, p);

    const r = safeParseWorkbook(p);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const sheets = listSheets(r.workbook);
      expect(sheets).toHaveLength(3);
      expect(sheets.map((s) => s.detectedType)).toEqual([
        "loan_calculation",
        "monthly_cashflow",
        "unknown",
      ]);
      // unknown is listed, not dropped — the no-discard rule
      expect(sheets[2].sheetName).toBe("NOT DEFTERİ");
      expect(sheets[0].rowCount).toBeGreaterThan(0);
    }
  });
});
