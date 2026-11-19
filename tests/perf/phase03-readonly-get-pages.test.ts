import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { SOURCE_SCAN_TEST_TIMEOUT_MS } from "../setup/test-timeouts";

const h = vi.hoisted(() => {
  const sqlCalls: string[] = [];
  const fakePool = {
    query: async (sql: string) => {
      sqlCalls.push(sql);
      if (sql.includes("from public.cashflow_months")) {
        return {
          rows: [
            {
              id: "m1",
              month_start: "2026-01-01",
              opening: "500.00",
              income: "700.00",
              expense: "200.00",
              closing: "1000.00",
              status: "draft",
              sheetId: "s1",
              workbookId: "w1",
            },
            {
              id: "m2",
              month_start: "2026-02-01",
              opening: "800.00", // continuity break: 1000 != 800
              income: "300.00",
              expense: "100.00",
              closing: "1000.00",
              status: "draft",
              sheetId: "s2",
              workbookId: "w1",
            },
            {
              id: "m4",
              month_start: "2026-04-01", // month gap: 2026-03 missing
              opening: "1000.00",
              income: null,
              expense: "100.00",
              closing: null,
              status: "draft",
              sheetId: "s4",
              workbookId: "w1",
            },
          ],
        };
      }
      if (sql.includes("from public.mapping_reviews")) {
        return { rows: [] };
      }
      if (sql.includes("from public.budget_variance_summary")) {
        return { rows: [] };
      }
      throw new Error(`Beklenmeyen SQL sorgusu: ${sql}`);
    },
    connect: async () => {
      throw new Error("GET sayfası transaction/connect() açmamalı!");
    },
  };
  return { sqlCalls, fakePool };
});

vi.mock("@/lib/db", () => ({ getPool: () => h.fakePool }));
vi.mock("@/lib/authz/route-guard", () => ({ requireRouteAccess: async () => null }));

import CashflowControls from "@/app/(dashboard)/cashflow/controls/page";

const ROOT = path.resolve(__dirname, "../..");

function walkAppGetFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkAppGetFiles(rel));
    else if (entry.name === "page.tsx" || entry.name === "layout.tsx") out.push(rel);
  }
  return out;
}

const FORBIDDEN_GET_CALLS = new Set([
  "ensureWindow",
  "generateInstancesForMonth",
  "generateWindow",
  "refreshRiskFlags",
  "validateContinuity",
  "writeSnapshots",
  "refreshMetricSnapshots",
  "audit",
]);

const FORBIDDEN_SQL_MUTATION = /^\s*(insert\s+into|update\s+|delete\s+from|truncate\s+|alter\s+|drop\s+)/i;

describe("Faz 3 — GET sayfalarında veritabanına yazma işlemleri sıfırlandı", () => {
  it(
    "hiçbir page.tsx veya layout.tsx GET render yolunda yazıcı/bakım fonksiyonu veya mutasyon SQL'i çağırmaz",
    () => {
      const violations: string[] = [];

      for (const rel of walkAppGetFiles("src/app")) {
        const text = readFileSync(path.join(ROOT, rel), "utf8");
        const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

        const visit = (node: ts.Node) => {
          if (ts.isCallExpression(node)) {
            if (ts.isIdentifier(node.expression) && FORBIDDEN_GET_CALLS.has(node.expression.text)) {
              violations.push(`${rel}: yasaklı GET yazıcısı ${node.expression.text}()`);
            }
            for (const arg of node.arguments) {
              if ((ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) && FORBIDDEN_SQL_MUTATION.test(arg.text)) {
                violations.push(`${rel}: satır içi mutasyon SQL'i "${arg.text.slice(0, 40)}"`);
              }
            }
          }
          ts.forEachChild(node, visit);
        };
        visit(sf);
      }

      expect(violations).toEqual([]);
    },
    SOURCE_SCAN_TEST_TIMEOUT_MS,
  );

  it("CashflowControls GET render'ı devir kırığını ve ay boşluğunu sıfır DB yazmasıyla hesaplar", async () => {
    h.sqlCalls.length = 0;
    const tree = await CashflowControls({});
    const serialized = JSON.stringify(tree);

    // 1 devir kırığı + 1 ay boşluğu = "2 zincir sorunu"
    expect(serialized).toContain("2");
    expect(h.sqlCalls).toHaveLength(7);
    expect(h.sqlCalls.every((sql) => /^\s*select\b/i.test(sql))).toBe(true);
  });

  it("bakım yazmaları yalnız başlangıç (prepare-runtime.ts) ve onaylı yazma eylemlerinde (imports/v2/actions.ts) bağlıdır", () => {
    const prepareSrc = readFileSync(path.join(ROOT, "scripts/prepare-runtime.ts"), "utf8");
    const v2ActionsSrc = readFileSync(path.join(ROOT, "src/app/(dashboard)/data/imports/v2/actions.ts"), "utf8");

    expect(prepareSrc).toContain("ensureWindow");
    expect(prepareSrc).toContain("validateContinuity");
    expect(v2ActionsSrc).toContain("ensureWindow");
    expect(v2ActionsSrc).toContain("validateContinuity");
  });
});

