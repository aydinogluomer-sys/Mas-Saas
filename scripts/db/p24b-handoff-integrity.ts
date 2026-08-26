// P24B kesif zincirinde DOSYA AKTARIMI BUTUNLUGU — deterministik, ajan beyanina bagli DEGIL.
//
// NEDEN VAR. Kesif ajanlari bulgularini JSON dosyalarina yazip donus degerinde bir
// `findingCount` BEYAN ediyor. Beyan, kanit degildir: bir ajan 40 bulgu yazip 40 diyebilecegi
// gibi 12 yazip 40 da diyebilir, ya da dosyayi hic yazmadan sayi uydurabilir. Bu script
// dosyalari GERCEKTEN ayristirir ve sayar; beyanla olculen arasindaki her fark bir ihlaldir.
//
// KULLANIM:
//   node --import tsx scripts/db/p24b-handoff-integrity.ts \
//     --declare 10-metin.json=42 --declare 11-uuid.json=7 ... [--out 15-handoff-integrity.json]
//
// Cikis kodu 0 yalnizca pass=true iken. Zincirin uc noktasinda kosulur:
//   candidate manifest ONCESI · expanded candidates ONCESI · final synthesis ONCESI
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";

const DIR = "docs/release-evidence/final-production-readiness/p24b-discovery";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface FileReport {
  path: string;
  declared: number;
  actual: number;
  match: boolean;
  parseError: string | null;
  shapeError: string | null;
  ids: string[];
}

/** `--declare <dosya>=<sayi>` ciftlerini oku. */
function readDeclarations(): Array<{ file: string; declared: number }> {
  const out: Array<{ file: string; declared: number }> = [];
  for (let i = 0; i < process.argv.length; i++) {
    if (process.argv[i] !== "--declare") continue;
    const raw = process.argv[i + 1] ?? "";
    const eq = raw.lastIndexOf("=");
    if (eq === -1) throw new Error(`--declare bicimi '<dosya>=<sayi>' olmali, '${raw}' geldi`);
    const file = raw.slice(0, eq);
    const declared = Number(raw.slice(eq + 1));
    if (!Number.isInteger(declared) || declared < 0) {
      throw new Error(`--declare sayisi tam sayi olmali: '${raw}'`);
    }
    out.push({ file, declared });
  }
  return out;
}

/**
 * Bir bulgu dosyasini ayristirip GERCEK bulgu sayisini ve tasidigi kimlikleri cikarir.
 *
 * Beklenen sekil: { findings: [...], metadata?: {...} }
 * `findings` dizi degilse bu bir SEKIL HATASIDIR ve sessizce 0 sayilmaz — cunku "dosyayi
 * yanlis sekilde yazdim" ile "hic bulgu yok" arasindaki fark, tam da bu kapinin yakalamasi
 * gereken sey.
 */
function inspect(file: string, declared: number): FileReport {
  const full = path.isAbsolute(file) ? file : path.join(DIR, path.basename(file));
  const base: FileReport = { path: full, declared, actual: -1, match: false, parseError: null, shapeError: null, ids: [] };
  if (!existsSync(full)) return { ...base, parseError: "dosya yok" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(full, "utf8"));
  } catch (err) {
    return { ...base, parseError: err instanceof Error ? err.message : String(err) };
  }
  if (parsed === null || typeof parsed !== "object") {
    return { ...base, shapeError: "kok bir JSON nesnesi degil" };
  }
  const findings = (parsed as { findings?: unknown }).findings;
  if (!Array.isArray(findings)) {
    return { ...base, shapeError: "'findings' bir dizi degil" };
  }

  // Bulgularin tasidigi kimlikleri topla: id / ids / rowIds alanlarinin hepsi.
  const ids: string[] = [];
  for (const f of findings) {
    if (f === null || typeof f !== "object") continue;
    const o = f as Record<string, unknown>;
    if (typeof o.id === "string") ids.push(o.id);
    for (const key of ["ids", "rowIds", "matchedIds"]) {
      const v = o[key];
      if (Array.isArray(v)) for (const x of v) if (typeof x === "string") ids.push(x);
    }
  }
  const actual = findings.length;
  return { ...base, actual, match: actual === declared, ids };
}

function main(): void {
  const declarations = readDeclarations();
  if (declarations.length === 0) {
    console.error("Kullanim: --declare <dosya>=<sayi> [--declare ...] [--out <dosya>]");
    process.exit(2);
  }

  const files = declarations.map((d) => inspect(d.file, d.declared));

  const declaredTotal = files.reduce((n, f) => n + f.declared, 0);
  const actualTotal = files.reduce((n, f) => n + Math.max(0, f.actual), 0);
  const droppedFindings = declaredTotal - actualTotal;

  const allIds = files.flatMap((f) => f.ids);
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const id of allIds) {
    if (seen.has(id)) dupes.add(id);
    seen.add(id);
  }
  // Kimlik gorunumlu ama bicimsiz degerler: UUID olmayan ve UUID'ye benzemeye calisan.
  const malformed = allIds.filter((id) => id.length >= 32 && id.includes("-") && !UUID_RE.test(id));

  const parseErrors = files.filter((f) => f.parseError !== null).length;
  const shapeErrors = files.filter((f) => f.shapeError !== null).length;
  const mismatches = files.filter((f) => !f.match);

  const pass =
    parseErrors === 0 && shapeErrors === 0 && mismatches.length === 0 &&
    droppedFindings === 0 && malformed.length === 0;

  const report = {
    checkedAt: new Date().toISOString(),
    files: files.map((f) => ({
      path: f.path, declared: f.declared, actual: f.actual, match: f.match,
      parseError: f.parseError, shapeError: f.shapeError, idCount: f.ids.length,
    })),
    declaredTotal,
    actualTotal,
    droppedFindings,
    duplicateFindingIds: dupes.size,
    duplicateSamples: [...dupes].slice(0, 20),
    malformedIds: malformed.length,
    malformedSamples: malformed.slice(0, 20),
    parseErrors,
    shapeErrors,
    pass,
  };

  const outFlag = process.argv.indexOf("--out");
  const outPath = outFlag === -1
    ? path.join(DIR, "15-handoff-integrity.json")
    : (path.isAbsolute(process.argv[outFlag + 1]) ? process.argv[outFlag + 1] : path.join(DIR, path.basename(process.argv[outFlag + 1])));
  writeFileSync(outPath, JSON.stringify(report, null, 2), "utf8");

  for (const f of files) {
    const state = f.parseError ?? f.shapeError ?? (f.match ? "ok" : `beyan ${f.declared} != gercek ${f.actual}`);
    console.log(`  ${f.match && !f.parseError && !f.shapeError ? "PASS" : "FAIL"}  ${path.basename(f.path).padEnd(28)} ${state}`);
  }
  console.log(`\nbeyan toplam=${declaredTotal} · gercek toplam=${actualTotal} · dusen=${droppedFindings}`);
  console.log(`tekrarli kimlik=${dupes.size} · bicimsiz kimlik=${malformed.length} · ayristirma hatasi=${parseErrors} · sekil hatasi=${shapeErrors}`);
  console.log(`Rapor: ${outPath}`);
  console.log(pass ? "HANDOFF INTEGRITY: PASS" : "HANDOFF INTEGRITY: FAIL");
  process.exit(pass ? 0 : 1);
}

main();
