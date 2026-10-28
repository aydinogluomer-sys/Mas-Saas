// Wave 0 / S3 — "no fabricated figure on any screen", asserted against the SOURCE.
//
// The unreviewed layer 46541d8 added two screens (/finance/cockpit, /finance/chains), the engines
// behind them and four widgets mounted on reviewed pages. Their numbers did not come from stored
// data. Chain queries named columns the schema does not have and swallowed the error into
// hardcoded TL amounts; other engines injected demo invoices, fixed FX rates, a fixed 55/28/17
// expense split and synthetic weeks; an "audit hash chain" verified the chain it had just built
// from the same rows, so it was always "Kusursuz". By code reading an EMPTY database would have
// shown a health score, a fraud incident, a cash balance and a runway. They were removed, not
// repaired: there was no stored data to repair them with.
//
// This file keeps them removed and keeps four older spots (R10) from showing an unknown value as
// a number again. Same method as tests/security/write-gates.test.ts: no database, no network, the
// TypeScript parser reads the code, so a word in a comment can neither satisfy a rule nor trip
// one. The pure rules behind R10 are unit-tested next to them (home/cockpit, briefing/rules,
// analytics/analyses); what is asserted here is the WIRING — that the pages still call them. A
// page restored wholesale from an older commit would silently drop that wiring while every unit
// test stayed green.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { SOURCE_SCAN_TEST_TIMEOUT_MS } from "./setup/test-timeouts";

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const isTest = (rel: string) => /\.test\.(ts|tsx)$/.test(rel);

function walk(relDir: string, accept: (rel: string) => boolean): string[] {
  const abs = path.join(ROOT, relDir);
  if (!existsSync(abs)) return [];
  return readdirSync(abs, { withFileTypes: true }).flatMap((entry) => {
    const childRel = `${relDir}/${entry.name}`;
    if (entry.isDirectory()) return walk(childRel, accept);
    return accept(childRel) ? [childRel] : [];
  });
}

function parse(rel: string): ts.SourceFile {
  return ts.createSourceFile(
    rel, read(rel), ts.ScriptTarget.Latest, true,
    rel.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

/** Text a user can be shown: string and template literals plus JSX text. Comments are not nodes. */
function visibleTextOf(sf: ts.SourceFile): string[] {
  const out: string[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n) || ts.isJsxText(n)) out.push(n.text);
    else if (ts.isTemplateExpression(n)) out.push(n.head.text, ...n.templateSpans.map((s) => s.literal.text));
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** The left operand of every `x ?? 0` — the shape that turned "unknown" into "zero". */
function nullishZeroOperands(sf: ts.SourceFile): string[] {
  const out: string[] = [];
  const visit = (n: ts.Node): void => {
    if (
      ts.isBinaryExpression(n)
      && n.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
      && ts.isNumericLiteral(n.right) && Number(n.right.text) === 0
    ) {
      out.push(n.left.getText(sf));
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

function calls(sf: ts.SourceFile, name: string): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === name) {
      found = true;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

describe("kaldırılan uydurma-rakam yüzeyleri kaldırılmış kalır", () => {
  // The cockpit page, /api/chains and the copilot route are asserted gone in
  // tests/security/write-gates.test.ts with the other removed write surfaces.
  const REMOVED = [
    "src/lib/chains",
    "src/app/(dashboard)/finance/chains",
    "src/components/finance/nervous-system-hub.tsx",
    "scripts/test-live-chains.ts",
    "src/lib/finance",
    "src/lib/simulations",
    "src/lib/treasury/cash-pooling.ts",
    "src/lib/treasury/headroom-engine.ts",
    "src/lib/budget/guardrail.ts",
    "src/lib/audit/hash-chain.ts",
    "src/lib/security/fraud-guard.ts",
    "src/lib/reconciliation/auto-matcher.ts",
    "src/lib/collections/discipline-engine.ts",
    "src/components/charts/cashflow-waterfall.tsx",
    "src/components/scenarios/scenario-interactive-sandbox.tsx",
    "src/components/finance/counterparty-dso-radar.tsx",
    "src/components/briefing/briefing-executive-view.tsx",
    "src/lib/ai/copilot-engine.ts",
    "src/lib/ai/guardrails.ts",
    "src/components/ai/cfo-copilot-widget.tsx",
    "src/lib/controls/gatekeeper.ts",
  ];
  for (const rel of REMOVED) {
    it(`${rel} yok`, () => {
      expect(existsSync(path.join(ROOT, rel))).toBe(false);
    });
  }

  // Parses every file under src and scripts: its time is the size of the tree, not the rule
  // (3.8 s alone, 7.8 s in the parallel suite). The class ceiling: tests/setup/test-timeouts.ts.
  it("hiçbir kaynak ya da betik kaldırılan modüllere bağlanmaz", () => {
    // Path fragments, so an import specifier, a route string and an allowlist entry
    // ("lib/ai/copilot-engine.ts" in scripts/boundary-verify.ts) are all caught.
    const needles = [
      "lib/chains", "/finance/chains", "lib/finance/", "lib/simulations/", "audit/hash-chain",
      "cash-pooling", "headroom-engine", "budget/guardrail", "fraud-guard", "auto-matcher",
      "discipline-engine", "cashflow-waterfall", "scenario-interactive-sandbox",
      "counterparty-dso-radar", "briefing-executive-view", "nervous-system-hub",
      "copilot-engine", "ai/guardrails", "cfo-copilot-widget", "controls/gatekeeper",
    ];
    const files = [
      ...walk("src", (rel) => /\.(ts|tsx)$/.test(rel) && !isTest(rel)),
      ...walk("scripts", (rel) => rel.endsWith(".ts")),
    ];
    expect(files.length).toBeGreaterThan(100);
    const hits: string[] = [];
    for (const rel of files) {
      const sf = parse(rel);
      const specifiers = sf.statements
        .filter((s): s is ts.ImportDeclaration => ts.isImportDeclaration(s) && ts.isStringLiteral(s.moduleSpecifier))
        .map((s) => (s.moduleSpecifier as ts.StringLiteral).text);
      for (const s of [...specifiers, ...visibleTextOf(sf)]) {
        for (const n of needles) if (s.includes(n)) hits.push(`${rel}: ${n}`);
      }
    }
    expect(hits).toEqual([]);
  }, SOURCE_SCAN_TEST_TIMEOUT_MS);
});

describe("R10 — bilinmeyen değer ekranda sayı olarak gösterilmez (sayfa bağlantısı)", () => {
  it("Ana Ekran 12 aylık kasa eğilimi closingTrend() ile çizilir; `closing ?? 0` yok", () => {
    const sf = parse("src/app/(dashboard)/page.tsx");
    expect(calls(sf, "closingTrend")).toBe(true);
    expect(nullishZeroOperands(sf).filter((t) => /\bclosing\b/.test(t))).toEqual([]);
  });

  it("nakit köprüsü bilinmeyen açılışı 0 TL'den başlatmaz (`start ?? 0` yok)", () => {
    const sf = parse("src/lib/analytics/engine.ts");
    expect(calls(sf, "cashBridge")).toBe(true);
    expect(nullishZeroOperands(sf).filter((t) => /\bstart\b/.test(t))).toEqual([]);
  });

  it("brifing rozeti briefingStatus() ile; `liquidityGap7 ?? 0` yok", () => {
    const sf = parse("src/app/(dashboard)/insights/briefing/page.tsx");
    expect(calls(sf, "briefingStatus")).toBe(true);
    expect(nullishZeroOperands(sf).filter((t) => t.includes("liquidityGap7"))).toEqual([]);
  });

  it("yönetim kokpiti nakit kutusu bilinmeyen tabanı 0 saymaz (`minCashFloor ?? 0` yok)", () => {
    const sf = parse("src/lib/home/cockpit.ts");
    expect(nullishZeroOperands(sf).filter((t) => t.includes("minCashFloor"))).toEqual([]);
  });
});

describe("ekranda dayanaksız iddia yok", () => {
  // Parses every file under src (1.75 s alone); same class ceiling as above.
  it("kriptografik denetim zinciri ya da %100 güvence iddiası hiçbir ekranda yok", () => {
    // audit_logs has no stored hash column (0002); there is no chain to vouch for. The checks on
    // /payments/missing cover the current month only; "%100" was not something it measured.
    // ("kusursuz" is deliberately NOT a needle: /system/controls says an untriaged control does
    // not look flawless — the honest use of the word.)
    const needles = ["kriptografik", "hash zinciri", "%100 güvenle"];
    const hits: string[] = [];
    for (const rel of walk("src", (r) => /\.(ts|tsx)$/.test(r) && !isTest(r))) {
      for (const text of visibleTextOf(parse(rel))) {
        const lower = text.toLocaleLowerCase("tr-TR");
        for (const n of needles) if (lower.includes(n)) hits.push(`${rel}: ${n}`);
      }
    }
    expect(hits).toEqual([]);
  }, SOURCE_SCAN_TEST_TIMEOUT_MS);

  it("/system veritabanı durumunu gerçekten yoklar (sabit 'çalışıyor' yok)", () => {
    const sf = parse("src/app/(dashboard)/system/page.tsx");
    expect(visibleTextOf(sf)).toContain("select 1");
    let hardcoded = false;
    const visit = (n: ts.Node): void => {
      if (ts.isVariableDeclaration(n) && n.initializer && ts.isStringLiteral(n.initializer)
        && n.initializer.text === "çalışıyor") hardcoded = true;
      ts.forEachChild(n, visit);
    };
    visit(sf);
    expect(hardcoded).toBe(false);
  });

  it("⌘K paleti yalnız /api/search sonucunu gösterir (istemcide sabit rota listesi yok)", () => {
    // Faz 35 contract: the palette renders what the role-scoped search returns and nothing else.
    // The layer added a static list rendered for every role, with a dead link to a removed screen.
    const routes = visibleTextOf(parse("src/components/search/command-palette.tsx"))
      .filter((s) => s.startsWith("/"));
    expect(routes).toEqual(["/api/search?q="]);
  });
});
