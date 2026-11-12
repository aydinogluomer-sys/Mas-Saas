// Wave 0 & Faz 42 (B2) — "zero unauthenticated write paths", asserted against the SOURCE.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";
import { SOURCE_SCAN_TEST_TIMEOUT_MS } from "../setup/test-timeouts";

const ROOT = process.cwd();

const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

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
    rel,
    read(rel),
    ts.ScriptTarget.Latest,
    true,
    rel.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
}

const isTest = (rel: string) => /\.test\.(ts|tsx)$/.test(rel);

function isExported(node: ts.Node): boolean {
  return ts.canHaveModifiers(node)
    && (ts.getModifiers(node) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
}

interface Fn { name: string; body: ts.ConciseBody | undefined; exported: boolean }

/** Top-level functions: declarations and `const x = (async) () => …` / function expressions. */
function functionsOf(sf: ts.SourceFile): Fn[] {
  const out: Fn[] = [];
  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name) {
      out.push({ name: stmt.name.text, body: stmt.body, exported: isExported(stmt) });
    } else if (ts.isVariableStatement(stmt)) {
      for (const d of stmt.declarationList.declarations) {
        const init = d.initializer;
        if (ts.isIdentifier(d.name) && init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
          out.push({ name: d.name.text, body: init.body, exported: isExported(stmt) });
        }
      }
    }
  }
  return out;
}

/** Names a module exports, including `export { handler as POST }`. */
function exportedNames(sf: ts.SourceFile): string[] {
  const names = functionsOf(sf).filter((f) => f.exported).map((f) => f.name);
  for (const stmt of sf.statements) {
    if (ts.isExportDeclaration(stmt) && stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
      for (const el of stmt.exportClause.elements) names.push(el.name.text);
    }
  }
  return names;
}

/** True when `node` contains a call to one of `names` (a bare identifier callee). */
function callsAny(node: ts.Node | undefined, names: ReadonlySet<string>): boolean {
  if (!node) return false;
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && names.has(n.expression.text)) {
      found = true;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return found;
}

/** Every identifier in code (comments are not nodes, so they never count). */
function referencesIdentifier(sf: ts.SourceFile, name: string): boolean {
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (ts.isIdentifier(n) && n.text === name) {
      found = true;
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

interface Import { from: string; names: string[]; typeOnly: boolean }

function importsOf(sf: ts.SourceFile): Import[] {
  const out: Import[] = [];
  for (const stmt of sf.statements) {
    if (!ts.isImportDeclaration(stmt) || !ts.isStringLiteral(stmt.moduleSpecifier)) continue;
    const clause = stmt.importClause;
    const names: string[] = [];
    if (clause?.name) names.push(clause.name.text);
    if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const el of clause.namedBindings.elements) names.push((el.propertyName ?? el.name).text);
    }
    out.push({ from: stmt.moduleSpecifier.text, names, typeOnly: Boolean(clause?.isTypeOnly) });
  }
  return out;
}

/** Text of every string and template literal — where SQL lives. */
function stringsOf(sf: ts.SourceFile): string[] {
  const out: string[] = [];
  const visit = (n: ts.Node): void => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) out.push(n.text);
    else if (ts.isTemplateExpression(n)) {
      out.push(n.head.text, ...n.templateSpans.map((s) => s.literal.text));
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

function firstStatement(body: ts.ConciseBody | undefined): ts.Node | undefined {
  if (!body) return undefined;
  return ts.isBlock(body) ? body.statements[0] : body;
}

// ── The exceptions, each with its reason ──────────────────────────────────────────────────────

/** Faz 42 (B2): ZERO machine-auth HTTP routes remain (`src/app/api/telegram/assistant/route.ts` retired). */
const MACHINE_AUTH = new Set<string>();

/** Probes the matcher keeps public; they read no financial data and write nothing. */
const PUBLIC_PROBES = new Set(["src/app/health/route.ts", "src/app/ready/route.ts", "src/app/version/route.ts"]);

/** The authentication surface itself; requiring it to authenticate first would be circular. */
const PRE_AUTH_ACTIONS = new Set(["src/app/login/actions.ts"]);

const HTTP_METHODS = new Set(["GET", "HEAD", "OPTIONS", "POST", "PUT", "PATCH", "DELETE"]);
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

const routeFiles = walk("src/app", (rel) => rel.endsWith("/route.ts"));
const actionFiles = walk("src", (rel) => /\.(ts|tsx)$/.test(rel) && !isTest(rel))
  .filter((rel) => /^\s*["']use server["']/m.test(read(rel)));

describe("yapısal kapı — tarama gerçekten bir şey buldu", () => {
  it("route ve server-action dosyaları bulundu (boş tarama geçmiş sayılmaz)", () => {
    expect(routeFiles.length).toBeGreaterThan(5);
    expect(actionFiles.length).toBeGreaterThan(20);
  });
});

describe("route handler'lar", () => {
  it("her MUTASYON yapan route handler checkOrigin() ve requireApiSession() çağırır", () => {
    const missing: string[] = [];
    for (const rel of routeFiles) {
      if (MACHINE_AUTH.has(rel)) continue;
      const sf = parse(rel);
      for (const fn of functionsOf(sf).filter((f) => f.exported && MUTATING.has(f.name))) {
        if (!callsAny(fn.body, new Set(["checkOrigin"]))) missing.push(`${rel} ${fn.name}: checkOrigin yok`);
        if (!callsAny(fn.body, new Set(["requireApiSession"]))) missing.push(`${rel} ${fn.name}: requireApiSession yok`);
      }
      const reexported = exportedNames(sf).filter((n) => MUTATING.has(n))
        .filter((n) => !functionsOf(sf).some((f) => f.exported && f.name === n));
      if (reexported.length > 0) missing.push(`${rel}: ${reexported.join(", ")} yeniden-dışa-aktarım ile denetimden kaçıyor`);
    }
    expect(missing).toEqual([]);
  });

  it("her JSON route handler oturumu requireApiSession() ile doğrular (getCurrentUser/requireSession değil)", () => {
    const wrong: string[] = [];
    for (const rel of routeFiles) {
      if (MACHINE_AUTH.has(rel) || PUBLIC_PROBES.has(rel)) continue;
      const sf = parse(rel);
      for (const fn of functionsOf(sf).filter((f) => f.exported && HTTP_METHODS.has(f.name))) {
        if (!callsAny(fn.body, new Set(["requireApiSession"]))) wrong.push(`${rel} ${fn.name}: requireApiSession yok`);
      }
      if (callsAny(sf, new Set(["getCurrentUser", "requireSession", "requireAdmin"]))) {
        wrong.push(`${rel}: getCurrentUser/requireSession/requireAdmin doğrudan çağrılıyor`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("TypeScript Telegram işçisi (scripts/ops/telegram-assistant-worker.ts) yalnız runAsReadOnlySystem (mas_radar_viewer) kullanır", () => {
    const workerRel = "scripts/ops/telegram-assistant-worker.ts";
    expect(existsSync(path.join(ROOT, workerRel))).toBe(true);
    const sf = parse(workerRel);
    expect(callsAny(sf, new Set(["runAsReadOnlySystem"]))).toBe(true);
    expect(referencesIdentifier(sf, "runAsSystem")).toBe(false);
    expect(referencesIdentifier(sf, "runAsUser")).toBe(false);

    const mutation = /\b(insert\s+into|update\s+[\w.]+\s+set|delete\s+from)\b/i;
    const offending = stringsOf(sf).filter((s) => mutation.test(s));
    expect(offending).toEqual([]);
  });

  it("src/app altındaki hiçbir kod runAsSystem (finance_manager iş kimliği) kullanmaz", () => {
    const users = walk("src/app", (rel) => /\.(ts|tsx)$/.test(rel) && !isTest(rel))
      .filter((rel) => referencesIdentifier(parse(rel), "runAsSystem"));
    expect(users).toEqual([]);
  }, SOURCE_SCAN_TEST_TIMEOUT_MS);

  it("runAsUser (başkası adına katman) yalnız asenkron önizleme koşucusunda kullanılır", () => {
    const callers = [
      ...walk("src", (rel) => /\.(ts|tsx)$/.test(rel) && !isTest(rel)),
      ...walk("scripts", (rel) => rel.endsWith(".ts")),
    ].filter((rel) => rel !== "src/lib/db.ts" && referencesIdentifier(parse(rel), "runAsUser"));
    expect(callers).toEqual(["src/lib/importers/v2/async-runner.ts"]);
  }, SOURCE_SCAN_TEST_TIMEOUT_MS);
});

describe("server action'lar", () => {
  it("dışa aktarılan her server action İLK ifadesinde oturum/rol kapısını çağırır", () => {
    const GLOBAL_GATES = new Set(["requireSession", "requireAdmin", "requireActionPermission"]);
    const offenders: string[] = [];
    for (const rel of actionFiles) {
      if (PRE_AUTH_ACTIONS.has(rel)) continue;
      const fns = functionsOf(parse(rel));
      const gates = new Set(GLOBAL_GATES);
      for (const fn of fns) if (!fn.exported && callsAny(firstStatement(fn.body), GLOBAL_GATES)) gates.add(fn.name);

      for (const fn of fns.filter((f) => f.exported)) {
        if (!callsAny(firstStatement(fn.body), gates)) offenders.push(`${rel} ${fn.name}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("kaldırılan yüzeyler kaldırılmış kalır", () => {
  const REMOVED = [
    // Faz 42 (B2): Python yan süreçleri ve çerezsiz Telegram HTTP köprüsü tamamen kaldırıldı.
    "bot.py",
    "bot.requirements.txt",
    "scripts/qa/browser_crawl.py",
    "src/app/api/telegram/assistant",
    "src/app/api/telegram/assistant/route.ts",
    // Wave 0 kaldırılan yüzeyler:
    "src/app/api/erp",
    "src/lib/erp",
    "src/components/erp",
    "src/app/(dashboard)/data/erp",
    "src/app/telegram",
    "src/app/api/telegram/miniapp",
    "src/app/api/telegram/webhook",
    "src/lib/telegram/miniapp.ts",
    "src/lib/telegram/cfo-bot.ts",
    "scripts/ops/verify-miniapp-pwa.ts",
    "src/app/api/ai/cfo-chat",
    "src/app/api/chains",
    "src/app/(dashboard)/finance/cockpit",
    "scripts/ops/measure-routes.ts",
    "scripts/ops/measure-auth-routes.ts",
    "scripts/ops/run-lighthouse.ts",
  ];
  for (const rel of REMOVED) {
    it(`${rel} yok`, () => {
      expect(existsSync(path.join(ROOT, rel))).toBe(false);
    });
  }

  it("hiçbir dosya kaldırılan ERP / mini-app / webhook / kokpit / copilot / telegram-http yollarına bağlanmaz", () => {
    const needles = [
      "/api/erp/", "/data/erp", "/telegram/miniapp", "/api/telegram/webhook", "@/lib/erp", "@/lib/telegram/cfo-bot",
      "/api/ai/cfo-chat", "/api/chains", "/finance/cockpit", "/api/telegram/assistant",
    ];
    const hits: string[] = [];
    for (const rel of walk("src", (r) => /\.(ts|tsx)$/.test(r))) {
      if (rel === "src/middleware.test.ts") continue;
      for (const s of stringsOf(parse(rel))) {
        for (const n of needles) if (s.includes(n)) hits.push(`${rel}: ${n}`);
      }
    }
    expect(hits).toEqual([]);
  }, SOURCE_SCAN_TEST_TIMEOUT_MS);
});

describe("sır ve derleme güvenliği", () => {
  it("bilinen varsayılan sırlar hiçbir izlenen kaynakta yok", () => {
    const needles = ["erp_mas_" + "default", "mas-radar-" + "default-secret"];
    const files = [
      ...walk("src", () => true),
      ...walk("tests", () => true),
      ...walk("scripts", () => true),
      ...walk("public", () => true),
      ".env.example",
      "next.config.ts",
    ];
    const hits = files.filter((rel) => {
      const text = read(rel);
      return needles.some((n) => text.includes(n));
    });
    expect(hits).toEqual([]);
  });

  it("env.ts hiçbir anahtar/sır/token alanına kaynakta varsayılan değer vermez", () => {
    const sf = parse("src/lib/env.ts");
    const defaults: string[] = [];
    const visit = (n: ts.Node): void => {
      if (ts.isPropertyAssignment(n) && /key|secret|token|password/i.test(n.name.getText(sf))) {
        const init = n.initializer;
        if (
          ts.isBinaryExpression(init)
          && (init.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken || init.operatorToken.kind === ts.SyntaxKind.BarBarToken)
          && (ts.isStringLiteral(init.right) || ts.isNoSubstitutionTemplateLiteral(init.right))
        ) {
          defaults.push(n.name.getText(sf));
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
    expect(defaults).toEqual([]);
  });

  it("next.config.ts tip hatalarını derlemede kapatmaz", () => {
    const sf = parse("next.config.ts");
    let bypass = false;
    const visit = (n: ts.Node): void => {
      if (ts.isPropertyAssignment(n) && n.name.getText(sf) === "ignoreBuildErrors") bypass = true;
      ts.forEachChild(n, visit);
    };
    visit(sf);
    expect(bypass).toBe(false);
  });

  it("db.ts rol geçişi hatasını yutmaz (applyRole/prepare içinde try/catch yok)", () => {
    const sf = parse("src/lib/db.ts");
    for (const fn of functionsOf(sf).filter((f) => f.name === "applyRole" || f.name === "prepare")) {
      let swallow = false;
      const visit = (n: ts.Node): void => {
        if (ts.isTryStatement(n)) swallow = true;
        ts.forEachChild(n, visit);
      };
      if (fn.body) visit(fn.body);
      expect(swallow, fn.name).toBe(false);
    }
    expect(functionsOf(sf).filter((f) => f.name === "applyRole" || f.name === "prepare")).toHaveLength(2);
  });
});

describe("Telegram yüzeyi salt-okunur", () => {
  const files = walk("src/lib/telegram", (rel) => rel.endsWith(".ts") && !isTest(rel));

  it("src/lib/telegram yalnız okuyucu fonksiyonları içe aktarır", () => {
    expect(files.length).toBeGreaterThan(0);
    for (const rel of files) {
      for (const imp of importsOf(parse(rel))) {
        if (imp.from === "pg") {
          expect(imp.typeOnly, `${rel}: pg yalnız tip olarak`).toBe(true);
        } else if (imp.from === "@/lib/ai/rules") {
          expect(imp.names, rel).toEqual(["mutationIntent"]);
        } else if (imp.from === "@/lib/receivables/engine") {
          for (const name of imp.names) expect(name, `${rel}: ${name}`).toMatch(/^load[A-Z]/);
        } else {
          throw new Error(`${rel}: izin listesinde olmayan modül ${imp.from}`);
        }
      }
    }
  });

  it("src/lib/telegram hiçbir SQL mutasyonu içermez", () => {
    const mutation = /\b(insert\s+into|update\s+[\w.]+\s+set|delete\s+from)\b/i;
    for (const rel of files) {
      const offending = stringsOf(parse(rel)).filter((s) => mutation.test(s));
      expect(offending, rel).toEqual([]);
    }
  });
});
