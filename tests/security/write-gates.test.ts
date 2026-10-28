// Wave 0 — "zero unauthenticated write paths", asserted against the SOURCE.
//
// A runtime test proves a handler behaves when it is called; it cannot prove that the NEXT route or
// server action someone adds calls the gate at all. That is a property of the file, so it is
// asserted on the file — the reasoning of the structural block in src/lib/authz/route-access.test.ts
// and of scripts/boundary-verify.ts. No database, no network: the TypeScript parser reads the code,
// so a word in a comment can neither satisfy a rule nor trip one.
//
// The unreviewed layer this wave quarantines is the case study. Every rule below fails on 46541d8:
// an ERP sync route that wrote invoices with no authentication, a Telegram mini-app whose "auth"
// accepted any User-Agent containing "Telegram" and wrote payments as finance_manager, a webhook
// that executed approvals signed with a committed default secret, JSON routes that served users
// under a forced password change, a hardcoded default API key in the env module.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

const read =(rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

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

/** Answered without a browser session; authenticates the caller itself (shared secret + chat id). */
const MACHINE_AUTH = new Set(["src/app/api/telegram/assistant/route.ts"]);

/** Probes the matcher keeps public; they read no financial data and write nothing. */
const PUBLIC_PROBES = new Set(["src/app/health/route.ts", "src/app/ready/route.ts", "src/app/version/route.ts"]);

/** Measurement endpoint: 404 unless MAS_PERF_PROBE=1 (never in production), GET only, no database. */
const MEASUREMENT = new Set(["src/app/api/perf-probe/route.ts"]);

/** The authentication surface itself; requiring it to authenticate first would be circular. */
const PRE_AUTH_ACTIONS = new Set(["src/app/login/actions.ts"]);

/**
 * Layer files that a LATER Wave 0 step removes outright (CFO copilot, financial chains, cockpit).
 * They are skipped while they exist and the list may only shrink: the test below fails as soon as
 * one of them is gone, so whoever deletes the file also deletes its entry here, and a file re-added
 * at the same path is checked like any other.
 */
const PENDING_QUARANTINE = new Set([
  "src/app/api/ai/cfo-chat/route.ts",
  "src/app/api/chains/route.ts",
  "src/app/(dashboard)/finance/cockpit/actions.ts",
]);

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

  it("bekleyen karantina listesi yalnız hâlâ var olan dosyaları içerir (liste yalnız küçülür)", () => {
    const gone = [...PENDING_QUARANTINE].filter((rel) => !existsSync(path.join(ROOT, rel)));
    expect(gone, "silinen dosyayı PENDING_QUARANTINE'dan da çıkarın").toEqual([]);
  });
});

describe("route handler'lar", () => {
  it("her MUTASYON yapan route handler checkOrigin() ve requireApiSession() çağırır", () => {
    const missing: string[] = [];
    for (const rel of routeFiles) {
      if (MACHINE_AUTH.has(rel) || PENDING_QUARANTINE.has(rel)) continue;
      const sf = parse(rel);
      for (const fn of functionsOf(sf).filter((f) => f.exported && MUTATING.has(f.name))) {
        if (!callsAny(fn.body, new Set(["checkOrigin"]))) missing.push(`${rel} ${fn.name}: checkOrigin yok`);
        if (!callsAny(fn.body, new Set(["requireApiSession"]))) missing.push(`${rel} ${fn.name}: requireApiSession yok`);
      }
      // A re-export (`export { handler as POST }`) would hide the body from the check above.
      const reexported = exportedNames(sf).filter((n) => MUTATING.has(n))
        .filter((n) => !functionsOf(sf).some((f) => f.exported && f.name === n));
      if (reexported.length > 0) missing.push(`${rel}: ${reexported.join(", ")} yeniden-dışa-aktarım ile denetimden kaçıyor`);
    }
    expect(missing).toEqual([]);
  });

  it("her JSON route handler oturumu requireApiSession() ile doğrular (getCurrentUser/requireSession değil)", () => {
    const wrong: string[] = [];
    for (const rel of routeFiles) {
      if (MACHINE_AUTH.has(rel) || PUBLIC_PROBES.has(rel) || MEASUREMENT.has(rel) || PENDING_QUARANTINE.has(rel)) continue;
      const sf = parse(rel);
      for (const fn of functionsOf(sf).filter((f) => f.exported && HTTP_METHODS.has(f.name))) {
        if (!callsAny(fn.body, new Set(["requireApiSession"]))) wrong.push(`${rel} ${fn.name}: requireApiSession yok`);
      }
      // getCurrentUser ignores the forced password change; requireSession redirects, which a JSON
      // client cannot follow (and `.catch(() => null)` around it hid real failures as 401s).
      if (callsAny(sf, new Set(["getCurrentUser", "requireSession", "requireAdmin"]))) {
        wrong.push(`${rel}: getCurrentUser/requireSession/requireAdmin doğrudan çağrılıyor`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it("makine rotası (Telegram asistanı) sabit-zamanlı sır karşılaştırır ve yalnız okuyan modülleri içe aktarır", () => {
    for (const rel of MACHINE_AUTH) {
      const sf = parse(rel);
      expect(callsAny(sf, new Set(["timingSafeEqual"])), rel).toBe(true);
      expect(callsAny(sf, new Set(["runAsReadOnlySystem"])), rel).toBe(true);
      expect(referencesIdentifier(sf, "runAsSystem"), rel).toBe(false);

      const allowed: Record<string, readonly string[] | "*"> = {
        "node:crypto": ["createHash", "timingSafeEqual"],
        "next/server": "*",
        zod: "*",
        "@/lib/api-response": ["apiError", "withApiHandler"],
        "@/lib/correlation": ["CORRELATION_HEADER"],
        "@/lib/db": ["getPool", "runAsReadOnlySystem"],
        "@/lib/env": ["env"],
        "@/lib/logger": ["log"],
        "@/lib/reports/rules": ["istanbulDateISO"],
        "@/lib/telegram/assistant": ["answerTelegramQuestion"],
      };
      for (const imp of importsOf(sf)) {
        const rule = allowed[imp.from];
        expect(rule, `${rel}: izin listesinde olmayan modül ${imp.from}`).toBeDefined();
        if (rule !== "*") {
          for (const name of imp.names) expect(rule, `${rel}: ${imp.from} içinden ${name}`).toContain(name);
        }
      }
    }
  });

  it("src/app altındaki hiçbir kod runAsSystem (finance_manager iş kimliği) kullanmaz", () => {
    const users = walk("src/app", (rel) => /\.(ts|tsx)$/.test(rel) && !isTest(rel))
      .filter((rel) => !PENDING_QUARANTINE.has(rel))
      .filter((rel) => referencesIdentifier(parse(rel), "runAsSystem"));
    expect(users).toEqual([]);
  });
});

describe("server action'lar", () => {
  it("dışa aktarılan her server action İLK ifadesinde oturum/rol kapısını çağırır", () => {
    const GLOBAL_GATES = new Set(["requireSession", "requireAdmin"]);
    const offenders: string[] = [];
    for (const rel of actionFiles) {
      if (PRE_AUTH_ACTIONS.has(rel) || PENDING_QUARANTINE.has(rel)) continue;
      const fns = functionsOf(parse(rel));
      // A module-local helper counts as a gate only if it, in turn, starts with a real gate
      // (data/imports/v2's authorize(), reminders' requireReminderOperator()).
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
  ];
  for (const rel of REMOVED) {
    it(`${rel} yok`, () => {
      expect(existsSync(path.join(ROOT, rel))).toBe(false);
    });
  }

  it("hiçbir dosya kaldırılan ERP / mini-app / webhook yollarına bağlanmaz", () => {
    const needles = ["/api/erp/", "/data/erp", "/telegram/miniapp", "/api/telegram/webhook", "@/lib/erp", "@/lib/telegram/cfo-bot"];
    const hits: string[] = [];
    for (const rel of walk("src", (r) => /\.(ts|tsx)$/.test(r))) {
      // middleware.test.ts asserts these very paths are refused; that is the point, not a link.
      if (rel === "src/middleware.test.ts") continue;
      for (const s of stringsOf(parse(rel))) {
        for (const n of needles) if (s.includes(n)) hits.push(`${rel}: ${n}`);
      }
    }
    expect(hits).toEqual([]);
  });
});

describe("sır ve derleme güvenliği", () => {
  it("bilinen varsayılan sırlar hiçbir izlenen kaynakta yok", () => {
    // Built from parts so this file does not match itself.
    const needles = ["erp_mas_" + "default", "mas-radar-" + "default-secret"];
    const files = [
      ...walk("src", () => true),
      ...walk("tests", () => true),
      ...walk("scripts", () => true),
      ...walk("public", () => true),
      "bot.py",
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
