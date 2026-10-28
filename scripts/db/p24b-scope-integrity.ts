// P24B KAPSAM BUTUNLUGU — aday manifestlerinin TUM bulgulari GERCEKTEN tasidigini kanitlar.
//
// NEDEN AYRI BIR KAPI. `p24b-handoff-integrity.ts` her KAYNAK dosyanin kendi icinde tutarli
// oldugunu (beyan == gercek, sekil dogru, dosya ici tekrar yok) dogrular. Ama bir bulgunun
// dosyada VAR OLMASI, aday manifestine AKTARILDIGI anlamina gelmez. Aday manifesti bir sonraki
// fazin KAPSAMIDIR: oraya girmeyen tablo, FK kapanisinda ve normalize karsilastirmasinda HIC
// gorulmez. Yani "kaynak dosya saglam" ile "kapsam eksiksiz" iki AYRI iddiadir ve ikisi de
// makine tarafindan kanitlanmalidir.
//
// KANITLANAN DORT ONERME:
//   A) 10/11/12'de bulunan TUM satir ve tablolar  ⊆  Aday V1
//   B) Aday V1                                     ⊆  Aday V2
//   C) FK kapanisinda bulunan TUM satir/tablolar  ⊆  Aday V2
//   D) Aday V2 == unique(V1 ∪ FK kesfi)  — ne eksik ne FAZLA (beklenmeyen kapsam da hatadir)
//
// KULLANIM:
//   node --import tsx scripts/db/p24b-scope-integrity.ts [--out 16-scope-integrity.json]
// Cikis kodu 0 yalnizca pass=true iken. NORMALIZE bu kapi gecmeden BASLAMAZ.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import path from "node:path";

const DIR = "docs/release-evidence/final-production-readiness/p24b-discovery";

const SOURCES = ["10-metin.json", "11-uuid.json", "12-zaman.json"] as const;
const CANDIDATES_V1 = "20-candidates.json";
const FK_CLOSURE = "30-fk-closure.json";
const CANDIDATES_V2 = "25-expanded-candidates.json";

function load(file: string): unknown {
  const full = path.join(DIR, file);
  if (!existsSync(full)) throw new Error(`dosya yok: ${full}`);
  return JSON.parse(readFileSync(full, "utf8"));
}

/** Bir bulgu dosyasindan tum satir kimliklerini ve tablo adlarini toplar. */
function harvest(raw: unknown): { ids: Set<string>; tables: Set<string> } {
  const ids = new Set<string>();
  const tables = new Set<string>();
  const findings = (raw as { findings?: unknown })?.findings;
  if (!Array.isArray(findings)) return { ids, tables };
  for (const f of findings) {
    if (f === null || typeof f !== "object") continue;
    const o = f as Record<string, unknown>;
    if (typeof o.table === "string") tables.add(o.table);
    if (typeof o.child === "string") tables.add(o.child);
    if (typeof o.id === "string") ids.add(o.id);
    for (const key of ["ids", "rowIds", "matchedIds", "referringRowIds"]) {
      const v = o[key];
      if (Array.isArray(v)) for (const x of v) if (typeof x === "string") ids.add(x);
    }
  }
  return { ids, tables };
}

function arr(raw: unknown, key: string): string[] {
  const v = (raw as Record<string, unknown>)?.[key];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

const missing = (need: Set<string>, have: Set<string>): string[] =>
  [...need].filter((x) => !have.has(x)).sort();

function main(): void {
  // ── kaynak bulgular
  const src = { ids: new Set<string>(), tables: new Set<string>() };
  for (const f of SOURCES) {
    const h = harvest(load(f));
    for (const i of h.ids) src.ids.add(i);
    for (const t of h.tables) src.tables.add(t);
  }

  // ── aday V1
  const v1raw = load(CANDIDATES_V1);
  const v1Tables = new Set(arr(v1raw, "candidateTables"));
  const v1Rows = new Set(arr(v1raw, "candidateRowIds"));

  // ── FK kapanisi
  const fkRaw = load(FK_CLOSURE);
  const fkH = harvest(fkRaw);
  const fkTablesDeclared = new Set([...arr(fkRaw, "fkDiscoveredTables"), ...arr((fkRaw as Record<string, unknown>).metadata, "fkDiscoveredTables")]);
  const fkRowsDeclared = new Set([...arr(fkRaw, "fkDiscoveredRows"), ...arr((fkRaw as Record<string, unknown>).metadata, "fkDiscoveredRows")]);
  // Beyan edilen kesif kumesi bos kalirsa bulgulardan hasat edilen kume kullanilir —
  // "beyan etmeyi unuttum" sessizce "hicbir sey bulmadim"a donusmesin.
  const fkTables = fkTablesDeclared.size > 0 ? fkTablesDeclared : fkH.tables;
  const fkRows = fkRowsDeclared.size > 0 ? fkRowsDeclared : fkH.ids;

  // ── aday V2
  const v2raw = load(CANDIDATES_V2);
  const v2Tables = new Set(arr(v2raw, "candidateTablesV2"));
  const v2Rows = new Set(arr(v2raw, "candidateRowsV2"));

  // ── A) kaynak ⊆ V1
  const missingFromV1 = missing(src.ids, v1Rows);
  const missingTablesV1 = missing(src.tables, v1Tables);

  // ── B) V1 ⊆ V2   ve   C) FK ⊆ V2
  const missingFromV2 = [...missing(v1Rows, v2Rows), ...missing(fkRows, v2Rows)]
    .filter((x, i, a) => a.indexOf(x) === i).sort();
  const missingTablesV2 = [...missing(v1Tables, v2Tables), ...missing(fkTables, v2Tables)]
    .filter((x, i, a) => a.indexOf(x) === i).sort();

  // ── D) V2 == unique(V1 ∪ FK) — FAZLA kapsam da hatadir
  const expectedRows = new Set([...v1Rows, ...fkRows]);
  const expectedTables = new Set([...v1Tables, ...fkTables]);
  const unexpectedInV2 = missing(v2Rows, expectedRows);
  const unexpectedTablesV2 = missing(v2Tables, expectedTables);
  const exactUnionMatch =
    missingFromV2.length === 0 && unexpectedInV2.length === 0 &&
    missingTablesV2.length === 0 && unexpectedTablesV2.length === 0;

  const pass =
    missingFromV1.length === 0 && missingTablesV1.length === 0 && exactUnionMatch;

  const report = {
    checkedAt: new Date().toISOString(),
    sourceRows: src.ids.size,
    candidateV1Rows: v1Rows.size,
    fkDiscoveredRows: fkRows.size,
    candidateV2Rows: v2Rows.size,
    missingFromV1,
    missingFromV2,
    unexpectedInV2,
    sourceTables: [...src.tables].sort(),
    candidateV1Tables: [...v1Tables].sort(),
    fkDiscoveredTables: [...fkTables].sort(),
    candidateV2Tables: [...v2Tables].sort(),
    missingTablesV1,
    missingTablesV2,
    unexpectedTablesV2,
    exactUnionMatch,
    pass,
  };

  const outFlag = process.argv.indexOf("--out");
  const outPath = outFlag === -1
    ? path.join(DIR, "16-scope-integrity.json")
    : path.join(DIR, path.basename(process.argv[outFlag + 1]));
  writeFileSync(outPath, JSON.stringify(report, null, 2), "utf8");

  const line = (ok: boolean, label: string, detail: string) =>
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(46)} ${detail}`);
  line(missingFromV1.length === 0 && missingTablesV1.length === 0,
    "A) kaynak bulgular ⊆ Aday V1", `eksik satir ${missingFromV1.length} · eksik tablo ${missingTablesV1.length}`);
  line(missingFromV2.length === 0 && missingTablesV2.length === 0,
    "B+C) V1 ve FK kesfi ⊆ Aday V2", `eksik satir ${missingFromV2.length} · eksik tablo ${missingTablesV2.length}`);
  line(unexpectedInV2.length === 0 && unexpectedTablesV2.length === 0,
    "D) V2'de BEKLENMEYEN kapsam yok", `fazla satir ${unexpectedInV2.length} · fazla tablo ${unexpectedTablesV2.length}`);
  console.log(`\nkaynak=${src.ids.size} satir · V1=${v1Rows.size} · FK kesfi=${fkRows.size} · V2=${v2Rows.size}`);
  console.log(`tablolar: kaynak=${src.tables.size} · V1=${v1Tables.size} · FK=${fkTables.size} · V2=${v2Tables.size}`);
  console.log(`Rapor: ${outPath}`);
  console.log(pass ? "SCOPE INTEGRITY: PASS" : "SCOPE INTEGRITY: FAIL");
  process.exit(pass ? 0 : 1);
}

try {
  main();
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  console.error("SCOPE INTEGRITY: FAIL");
  process.exit(1);
}
