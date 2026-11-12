// Dalga 1 #5 — Nakit köprüsü (`cashBridge` / `runCashBridge`) BLANK ≠ ZERO garantisi.
//
// `projected_income = null` veya `projected_expense = null` olan bir ayda bilinmeyen akış ASLA
// `?? 0` ile sıfıra zorlanarak sahte mutabakat ("evet" / "0 TL fark" ya da uydurma sapma) üretmez.

import { readFileSync } from "node:fs";
import path from "node:path";
import type { Pool } from "pg";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { cashBridge } from "@/lib/analytics/analyses";
import { runCashBridge } from "@/lib/analytics/engine";

function nullishZeroOperandsInFile(relPath: string): string[] {
  const abs = path.join(process.cwd(), relPath);
  const sf = ts.createSourceFile(relPath, readFileSync(abs, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const hits: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken &&
      ts.isNumericLiteral(node.right) &&
      Number(node.right.text) === 0
    ) {
      hits.push(node.left.getText(sf));
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

describe("nakit köprüsü — BLANK ≠ ZERO (Dalga 1 #5)", () => {
  it("null gelir satırı 0 sayılmaz; kapanış tutsa bile sahte 'mutabık' hükmü üretmez", () => {
    // Eğer `null` gelir `?? 0` ile 0 sayılsaydı: 100.000 + 0 - 25.000 = 75.000 === reportedEndValue
    // olup sahte `reconciles: true` ("reconciled", difference: 0) dönerdi.
    const out = cashBridge({
      startLabel: "2026-05 açılış",
      startValue: 100_000,
      endLabel: "2026-05 kapanış",
      reportedEndValue: 75_000,
      movements: [
        { key: "2026-05-in", label: "2026-05 gelir", value: null },
        { key: "2026-05-out", label: "2026-05 gider", value: -25_000 },
      ],
    });

    expect(out.unknownCount).toBe(1);
    expect(out.reconciles).toBeNull();
    expect(out.difference).toBeNull();
    expect(out.reconciliationStatus).toBe("incomplete_unknown_lines");
    expect(out.unmeasurableReason).toContain("bilinmiyor");
    expect(out.unmeasurableReason).toContain("0 sayılmaz");
    expect(out.rows.some((s) => s.key === "2026-05-in")).toBe(false);
  });

  it("null gider satırı 0 sayılmaz; kapanış tutsa bile sahte 'mutabık' veya sahte fark üretmez", () => {
    // Eğer `null` gider `?? 0` ile 0 sayılsaydı: 100.000 + 40.000 - 0 = 140.000 === reportedEndValue
    // olup sahte `reconciles: true` dönerdi.
    const out = cashBridge({
      startLabel: "2026-06 açılış",
      startValue: 100_000,
      endLabel: "2026-06 kapanış",
      reportedEndValue: 140_000,
      movements: [
        { key: "2026-06-in", label: "2026-06 gelir", value: 40_000 },
        { key: "2026-06-out", label: "2026-06 gider", value: null },
      ],
    });

    expect(out.unknownCount).toBe(1);
    expect(out.reconciles).toBeNull();
    expect(out.difference).toBeNull();
    expect(out.reconciliationStatus).toBe("incomplete_unknown_lines");
    expect(out.unmeasurableReason).not.toBeNull();
    expect(out.rows.some((s) => s.key === "2026-06-out")).toBe(false);
  });

  it("tüm gelir ve gider satırları null ise 0 hareketli düz köprü çizmez; ölçülemez döner", () => {
    const out = cashBridge({
      startLabel: "2026-07 açılış",
      startValue: 100_000,
      endLabel: "2026-07 kapanış",
      reportedEndValue: 100_000,
      movements: [
        { key: "2026-07-in", label: "2026-07 gelir", value: null },
        { key: "2026-07-out", label: "2026-07 gider", value: null },
      ],
    });

    expect(out.rows).toEqual([]);
    expect(out.computedEnd).toBeNull();
    expect(out.unknownCount).toBe(2);
    expect(out.reconciles).toBeNull();
    expect(out.difference).toBeNull();
    expect(out.reconciliationStatus).toBe("incomplete_unknown_lines");
    expect(out.unmeasurableReason).toContain("0 sayılmaz");
  });

  it("açıkça 0 olan gelir ve gider bilinmeyen değildir — tam mutabakat üretir", () => {
    const out = cashBridge({
      startLabel: "2026-08 açılış",
      startValue: 100_000,
      endLabel: "2026-08 kapanış",
      reportedEndValue: 100_000,
      movements: [
        { key: "2026-08-in", label: "2026-08 gelir", value: 0 },
        { key: "2026-08-out", label: "2026-08 gider", value: 0 },
      ],
    });

    expect(out.unknownCount).toBe(0);
    expect(out.computedEnd).toBe(100_000);
    expect(out.reconciles).toBe(true);
    expect(out.difference).toBe(0);
    expect(out.reconciliationStatus).toBe("reconciled");
    expect(out.unmeasurableReason).toBeNull();
  });

  it("runCashBridge veritabanından gelen null projected_income / projected_expense alanlarını 0'a zorlamaz", async () => {
    const mockPool = {
      query: vi.fn(async () => ({
        rowCount: 1,
        rows: [
          {
            month: "2026-09",
            opening_balance: "250000.00",
            closing_balance: "210000.00",
            projected_income: null,
            projected_expense: "40000.00",
          },
        ],
      })),
    } as unknown as Pool;

    const stamped = await runCashBridge(mockPool, "2026-09", "2026-09", "2026-09-30");

    expect(stamped.result.unknownCount).toBe(1);
    expect(stamped.reconciles).toBeNull();
    expect(stamped.difference).toBeNull();
    expect(stamped.reconciliationStatus).toBe("incomplete_unknown_lines");
    expect(stamped.result.unmeasurableReason).toContain("0 sayılmaz");
  });

  it("src/lib/analytics/analyses.ts içinde hiçbir `?? 0` zorlaması bulunmaz", () => {
    expect(nullishZeroOperandsInFile("src/lib/analytics/analyses.ts")).toEqual([]);
  });
});
