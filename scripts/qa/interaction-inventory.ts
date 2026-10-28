/**
 * STATİK ETKİLEŞİM ENVANTERİ — "Interaction & Action Audit" kapısının kaynak tarafı.
 *
 * ═══ NEDEN REGEX DEĞİL, TypeScript AST ═══
 *
 * Repoda daha önce `.testsprite/button-inventory.mjs` vardı ve yalnız TARAYICIDA render olan
 * <button>'ları sayıyordu. Bu iki yönden eksik:
 *
 *   1. Bir kontrol yalnız belirli veri/rol/feature-flag durumunda render olur. Tarayıcı taraması
 *      o an görünmeyeni GÖREMEZ, dolayısıyla "hepsini gördüm" diyemez.
 *   2. Tersi de doğru: kaynakta duran ama hiçbir rotada kullanılmayan bir bileşen, tarayıcı
 *      taramasında hiç çıkmaz ve "kapsam tam" yanılsaması üretir.
 *
 * Bu yüzden envanter İKİ TARAFLIDIR: burası kaynağı AST ile okur, `tests/interaction/` tarafı
 * çalışan production sunucusunu okur, ve kapı ikisini KARŞILAŞTIRIR.
 *
 * Regex yerine `typescript` derleyici API'si kullanılmasının somut sebebi: bir <button>'ın hangi
 * server action'a bağlı olduğu, ONU SARAN <form action={...}> ile belirlenir. Bu ata-çocuk ilişkisi
 * düz metinde güvenilir biçimde kurulamaz — iç içe form/fragment/koşullu render (`{x ? <form…>`)
 * desenleri repoda yaygın (bkz. src/components/radar/instance-row.tsx). AST'de ise sadece
 * yukarı doğru yürümek yeterli.
 *
 * ═══ ROTA ATIFI ═══
 *
 * Bir kontrol `src/components/...` içinde tanımlıysa hangi ekranda görüneceği doğrudan belli
 * değildir. Import grafiği page.tsx'ten başlayarak geçişli olarak takip edilir; böylece her kontrol
 * onu (dolaylı da olsa) render eden BÜTÜN rotalara atfedilir. Hiçbir sayfaya bağlanamayan kontrol
 * `orphan` olarak işaretlenir — sessizce düşürülmez, çünkü "ölü kod mu, yoksa atıf mı kaçtı"
 * sorusu bir insanın bakması gereken bir sorudur.
 *
 * Çıktı: docs/interaction-audit/static-inventory.json  (makine-okunur, CI kapısı bunu tüketir)
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { execFileSync } from "node:child_process";

const REPO = process.cwd();
const SRC = path.join(REPO, "src");

/** Kullanıcı tetikleyebilen JSX etiketleri. Küçük harf = DOM, büyük harf = bileşen. */
const INTERACTIVE_TAGS = new Set([
  "button",
  "a",
  "summary",
  "select",
  "Link",
  "Button",
  "DropdownMenuItem",
  "DropdownMenuTrigger",
  "CommandItem",
  "SheetTrigger",
  "TooltipTrigger",
]);

/** `<input>` yalnız bazı type'larda iş akışı tetikler; `type="text"` bir aksiyon değildir. */
const INTERACTIVE_INPUT_TYPES = new Set(["submit", "button", "checkbox", "radio", "reset", "image", "file"]);

export type ControlKind =
  | "submit"
  | "button"
  | "link"
  | "menuitem"
  | "toggle"
  | "select"
  | "disclosure"
  | "input-action";

export interface StaticControl {
  /** Kararlı kimlik: dosya + satır + etiket. Satır kayarsa etiket+dosya ile yeniden eşleşir. */
  id: string;
  file: string;
  line: number;
  tag: string;
  kind: ControlKind;
  /** Görünen metin ya da aria-label/title. Boşsa "(etiketsiz)". */
  label: string;
  /** Saran <form>'un action={...} ifadesi — server action adı. */
  formAction: string | null;
  /** Butonun kendi formAction={...} override'ı (aynı formda ikinci bir aksiyon). */
  ownFormAction: string | null;
  /** onClick handler ifadesi (varsa). */
  onClick: string | null;
  href: string | null;
  /** Kaynakta koşulsuz `disabled` mı, yoksa ifadeye mi bağlı. */
  disabled: "always" | "conditional" | null;
  /** Bu kontrolü (geçişli olarak) render eden rotalar. */
  routes: string[];
  /** Bir mutation mı, yoksa yalnız gezinme/görünüm mü. */
  mutating: boolean;
}

// ───────────────────────────── dosya toplama ─────────────────────────────

function gitFiles(pattern: string): string[] {
  const out = execFileSync("git", ["ls-files", pattern], { cwd: REPO, encoding: "utf8" });
  return out.split("\n").map((s) => s.trim()).filter(Boolean);
}

const TSX_FILES = [...gitFiles("src/**/*.tsx"), ...gitFiles("src/**/*.ts")];

// ───────────────────────────── import grafiği ─────────────────────────────

/** `@/x` ve göreli import'ları repo-göreli dosya yoluna çözer. */
function resolveImport(fromFile: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = path.join(SRC, spec.slice(2));
  else if (spec.startsWith(".")) base = path.resolve(path.dirname(path.join(REPO, fromFile)), spec);
  else return null; // node_modules — envanter dışı

  for (const ext of [".tsx", ".ts", "/index.tsx", "/index.ts"]) {
    const candidate = base + ext;
    if (existsSync(candidate)) return path.relative(REPO, candidate).split(path.sep).join("/");
  }
  if (existsSync(base) && !existsSync(base + ".tsx")) {
    // klasör importu
    for (const ext of ["/index.tsx", "/index.ts"]) {
      if (existsSync(base + ext)) return path.relative(REPO, base + ext).split(path.sep).join("/");
    }
  }
  return null;
}

const sourceCache = new Map<string, ts.SourceFile>();
function parse(file: string): ts.SourceFile {
  const cached = sourceCache.get(file);
  if (cached) return cached;
  const text = readFileSync(path.join(REPO, file), "utf8");
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TSX);
  sourceCache.set(file, sf);
  return sf;
}

const importsOf = new Map<string, string[]>();
function importsFor(file: string): string[] {
  const cached = importsOf.get(file);
  if (cached) return cached;
  const sf = parse(file);
  const out: string[] = [];
  sf.forEachChild((node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const resolved = resolveImport(file, node.moduleSpecifier.text);
      if (resolved) out.push(resolved);
    }
  });
  importsOf.set(file, out);
  return out;
}

/**
 * page.tsx → o sayfanın (geçişli) modül kapanışı.
 *
 * `layout.tsx` de dahil edilir: sidebar, komut paleti ve üst çubuk oradan gelir ve kullanıcı için
 * o kontroller de HER rotada gerçek birer aksiyondur.
 */
function routeIdFromPage(pageFile: string): string {
  const rel = pageFile.replace(/^src\/app\//, "").replace(/\/page\.tsx$/, "");
  const cleaned = rel
    .split("/")
    .filter((seg) => !(seg.startsWith("(") && seg.endsWith(")")))
    .join("/");
  return "/" + cleaned;
}

const PAGE_FILES = TSX_FILES.filter((f) => /^src\/app\/.*\/page\.tsx$/.test(f) || f === "src/app/page.tsx");
const LAYOUT_FILES = TSX_FILES.filter((f) => /^src\/app\/.*layout\.tsx$/.test(f) || f === "src/app/layout.tsx");

/** Bir sayfa dosyasının kendi layout zinciri (klasör hiyerarşisinde yukarı doğru). */
function layoutChainFor(pageFile: string): string[] {
  const dir = path.dirname(pageFile);
  return LAYOUT_FILES.filter((l) => dir === path.dirname(l) || dir.startsWith(path.dirname(l) + "/"));
}

function closure(entry: string[], limit = 4000): Set<string> {
  const seen = new Set<string>();
  const stack = [...entry];
  while (stack.length && seen.size < limit) {
    const f = stack.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    for (const dep of importsFor(f)) if (!seen.has(dep)) stack.push(dep);
  }
  return seen;
}

/** dosya → onu render eden rotalar */
const fileToRoutes = new Map<string, Set<string>>();
for (const page of PAGE_FILES) {
  const route = routeIdFromPage(page);
  for (const f of closure([page, ...layoutChainFor(page)])) {
    if (!fileToRoutes.has(f)) fileToRoutes.set(f, new Set());
    fileToRoutes.get(f)!.add(route);
  }
}

// ───────────────────────────── JSX kontrol çıkarımı ─────────────────────────────

function attrText(node: ts.JsxOpeningLikeElement, name: string): string | null {
  for (const p of node.attributes.properties) {
    if (!ts.isJsxAttribute(p) || p.name.getText() !== name) continue;
    const init = p.initializer;
    if (!init) return "true"; // boolean shorthand: `disabled`
    if (ts.isStringLiteral(init)) return init.text;
    if (ts.isJsxExpression(init) && init.expression) return init.expression.getText().replace(/\s+/g, " ").trim();
    return "";
  }
  return null;
}

/** JSX ağacında görünen metni topla; ifadeler `{…}` olarak korunur ki etiket boş görünmesin. */
function visibleText(node: ts.Node): string {
  const parts: string[] = [];
  const walk = (n: ts.Node): void => {
    if (ts.isJsxText(n)) {
      const t = n.text.replace(/\s+/g, " ").trim();
      if (t) parts.push(t);
    } else if (ts.isJsxExpression(n) && n.expression) {
      const t = n.expression.getText().replace(/\s+/g, " ").trim();
      if (t && t.length < 60) parts.push(`{${t}}`);
    }
    n.forEachChild(walk);
  };
  node.forEachChild(walk);
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

/** Yukarı doğru yürüyerek saran <form>'un action'ını bul. */
function enclosingFormAction(node: ts.Node): string | null {
  let cur: ts.Node | undefined = node.parent;
  while (cur) {
    if (ts.isJsxElement(cur) && cur.openingElement.tagName.getText() === "form") {
      return attrText(cur.openingElement, "action");
    }
    cur = cur.parent;
  }
  return null;
}

function classifyKind(tag: string, opening: ts.JsxOpeningLikeElement, formAction: string | null): ControlKind {
  if (tag === "a" || tag === "Link") return "link";
  if (tag === "summary") return "disclosure";
  if (tag === "select") return "select";
  if (tag === "input") {
    const t = attrText(opening, "type");
    if (t === "checkbox" || t === "radio") return "toggle";
    if (t === "submit") return "submit";
    return "input-action";
  }
  if (tag.includes("MenuItem") || tag.includes("CommandItem")) return "menuitem";
  const explicitType = attrText(opening, "type");
  if (explicitType === "button") return "button";
  // React'te <form> içindeki type'sız <button> VARSAYILAN OLARAK submit'tir. Repo bu varsayılana
  // bilerek yaslanıyor (instance-row.tsx'te `<button className="button-primary">ödendi</button>`
  // hiçbir type taşımaz ama markPaidAction'ı tetikler). Bunu "button" saymak, envanterin en
  // kritik mutation'larını gezinme sanmasına yol açardı.
  if (formAction) return "submit";
  return "button";
}

const MUTATION_HINT = /Action$|^handle|mutate|submit/i;

function extractControls(file: string): StaticControl[] {
  const sf = parse(file);
  const out: StaticControl[] = [];

  const visit = (node: ts.Node): void => {
    let opening: ts.JsxOpeningLikeElement | null = null;
    let container: ts.Node = node;
    if (ts.isJsxElement(node)) {
      opening = node.openingElement;
      container = node;
    } else if (ts.isJsxSelfClosingElement(node)) {
      opening = node;
      container = node;
    }

    if (opening) {
      const tag = opening.tagName.getText();
      const isInput = tag === "input";
      const inputType = isInput ? attrText(opening, "type") : null;
      const interesting =
        INTERACTIVE_TAGS.has(tag) || (isInput && inputType != null && INTERACTIVE_INPUT_TYPES.has(inputType));

      if (interesting) {
        const formAction = enclosingFormAction(opening);
        const ownFormAction = attrText(opening, "formAction");
        const onClick = attrText(opening, "onClick");
        const href = attrText(opening, "href");
        const disabledRaw = attrText(opening, "disabled");
        const label =
          (ts.isJsxElement(container) ? visibleText(container) : "") ||
          attrText(opening, "aria-label") ||
          attrText(opening, "title") ||
          attrText(opening, "value") ||
          "(etiketsiz)";
        const { line } = sf.getLineAndCharacterOfPosition(opening.getStart(sf));
        const kind = classifyKind(tag, opening, ownFormAction ?? formAction);
        const effectiveAction = ownFormAction ?? formAction;

        // `<a>` içinde href yoksa ve onClick de yoksa bu bir kontrol değil, çapa/ankor'dur.
        const isDeadAnchor = (tag === "a" || tag === "Link") && !href && !onClick;

        if (!isDeadAnchor) {
          out.push({
            id: `${file}:${line + 1}:${label.slice(0, 48)}`,
            file,
            line: line + 1,
            tag,
            kind,
            label: label.slice(0, 120),
            formAction: formAction,
            ownFormAction,
            onClick,
            href,
            disabled: disabledRaw === "true" ? "always" : disabledRaw != null ? "conditional" : null,
            routes: [...(fileToRoutes.get(file) ?? [])].sort(),
            mutating: Boolean(effectiveAction) || (onClick != null && MUTATION_HINT.test(onClick)),
          });
        }
      }
    }
    node.forEachChild(visit);
  };

  visit(sf);
  return out;
}

// ───────────────────────────── çalıştır ─────────────────────────────

const controls: StaticControl[] = [];
for (const file of TSX_FILES) {
  if (!file.endsWith(".tsx")) continue;
  controls.push(...extractControls(file));
}

const orphans = controls.filter((c) => c.routes.length === 0);

const summary = {
  generatedFrom: "static AST scan (typescript compiler API)",
  totalControls: controls.length,
  byKind: controls.reduce<Record<string, number>>((acc, c) => {
    acc[c.kind] = (acc[c.kind] ?? 0) + 1;
    return acc;
  }, {}),
  mutating: controls.filter((c) => c.mutating).length,
  orphanControls: orphans.length,
  routesCovered: new Set(controls.flatMap((c) => c.routes)).size,
};

const OUT_DIR = path.join(REPO, "docs", "interaction-audit");
mkdirSync(OUT_DIR, { recursive: true });
writeFileSync(
  path.join(OUT_DIR, "static-inventory.json"),
  JSON.stringify({ summary, controls: controls.sort((a, b) => a.id.localeCompare(b.id)) }, null, 2) + "\n",
  "utf8",
);

console.log(JSON.stringify(summary, null, 2));
if (orphans.length) {
  console.log("\nHiçbir rotaya bağlanamayan kontroller (ölü kod mu, atıf mı kaçtı — insan bakmalı):");
  for (const o of orphans.slice(0, 40)) console.log(`  ${o.file}:${o.line}  ${o.kind}  ${o.label}`);
  if (orphans.length > 40) console.log(`  … +${orphans.length - 40} tane daha`);
}
