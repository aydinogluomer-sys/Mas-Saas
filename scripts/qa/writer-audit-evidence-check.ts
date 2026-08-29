// P24B writer-surface audit — evidence integrity checker.
//
// WHY THIS EXISTS. The audit's own report drifted from its own artifacts in four places before
// anyone noticed: the prose said 101 writer candidates while the README said 100, it cited four
// quiescence snapshots while three were on disk, it claimed "16 files" for a directory holding
// 15, and it described a commit as docs-only when that commit also changed a script.
//
// Every one of those is the same failure: a number typed by hand next to a number produced by a
// generator. Numbers typed by hand drift. So the README now DECLARES its counts in a parseable
// block, and this script re-derives each one from the artifacts and refuses any mismatch.
//
// It reads only files. It never connects to a database.
//
// Usage:  node --import tsx scripts/qa/writer-audit-evidence-check.ts [evidence-dir]
import { readFileSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";

const DIR =
  process.argv[2] ?? "docs/release-evidence/final-production-readiness/writer-surface-audit";

/** Files the audit is not complete without. */
const REQUIRED = [
  "README.md",
  "00-runtime-freeze.md",
  "01-quiescence-m1.json",
  "02-quiescence-m2.json",
  "03-quiescence-m3.json",
  "04-quiescence-summary.json",
  "05-writer-surface-manifest.json",
  "05-writer-surface-manifest.md",
  "06-constraints-verify-audit.md",
  "07-invocation-path.md",
  "08-amplifier-provenance.md",
  "09-scan-coverage.json",
  "09-scan-coverage.md",
  "10-perf-measure-fix.md",
  "11-runbook-contract-fix.md",
  "12-dev-reset-safety.md",
];

const CLASSES = [
  "SAFE_DISPOSABLE_ENFORCED",
  "SAFE_ROLLBACK_ONLY",
  "INTENTIONAL_REAL_WRITE",
  "LIBRARY_REQUIRES_CALLER_GUARD",
  "UNSAFE_ENV_TARGETED",
  "UNKNOWN",
] as const;

interface Check {
  name: string;
  pass: boolean;
  detail: string;
}
const checks: Check[] = [];
const record = (name: string, pass: boolean, detail: string): void => {
  checks.push({ name, pass, detail });
};

const p = (f: string): string => path.join(DIR, f);

/* ── 0. required files ───────────────────────────────────────────────────────────────────── */
const missing = REQUIRED.filter((f) => !existsSync(p(f)));
record("zorunlu kanıt dosyaları mevcut", missing.length === 0, missing.length ? `eksik: ${missing.join(", ")}` : `${REQUIRED.length}/${REQUIRED.length}`);
if (missing.length) {
  report();
  process.exit(1);
}

/* ── 1. README's declared numbers ────────────────────────────────────────────────────────── */
const readme = readFileSync(p("README.md"), "utf8");
function declared(key: string): number | null {
  // `key = value` on its own line, anywhere in the README.
  const m = new RegExp(`^\\s*${key}\\s*=\\s*(\\d+)\\s*$`, "m").exec(readme);
  return m ? Number(m[1]) : null;
}
const decl = {
  writerCandidates: declared("writerCandidates"),
  artifactFiles: declared("artifactFiles"),
  quiescenceSnapshots: declared("quiescenceSnapshots"),
  unknownWriters: declared("unknownWriters"),
  unsafeEnvTargeted: declared("unsafeEnvTargeted"),
};
const undeclared = Object.entries(decl).filter(([, v]) => v === null).map(([k]) => k);
record("README beyan bloğu tam", undeclared.length === 0, undeclared.length ? `beyan edilmemiş: ${undeclared.join(", ")}` : Object.entries(decl).map(([k, v]) => `${k}=${v}`).join(" · "));

/* ── 2. manifest ─────────────────────────────────────────────────────────────────────────── */
interface Manifest {
  writerCandidates: number;
  counts: Record<string, number>;
  candidates: Array<{ file: string; classification: string }>;
}
const manifest = JSON.parse(readFileSync(p("05-writer-surface-manifest.json"), "utf8")) as Manifest;
const rows = manifest.candidates.length;

record("manifest satır sayısı == manifest.writerCandidates", rows === manifest.writerCandidates, `${rows} vs ${manifest.writerCandidates}`);
record("README writerCandidates == manifest satır sayısı", decl.writerCandidates === rows, `README ${decl.writerCandidates} vs manifest ${rows}`);

const summed = CLASSES.reduce((a, c) => a + (manifest.counts[c] ?? 0), 0);
record("sınıf toplamları == satır sayısı", summed === rows, `${summed} vs ${rows}`);

const unexpected = Object.keys(manifest.counts).filter((k) => !CLASSES.includes(k as never));
record("yalnız tanımlı sınıflar kullanılmış", unexpected.length === 0, unexpected.length ? `tanımsız: ${unexpected.join(", ")}` : CLASSES.length + " sınıf");

const unknown = manifest.counts.UNKNOWN ?? 0;
const unsafe = manifest.counts.UNSAFE_ENV_TARGETED ?? 0;
record("UNKNOWN == 0", unknown === 0, String(unknown));
record("UNSAFE_ENV_TARGETED == 0", unsafe === 0, String(unsafe));
record("README unknownWriters == manifest", decl.unknownWriters === unknown, `${decl.unknownWriters} vs ${unknown}`);
record("README unsafeEnvTargeted == manifest", decl.unsafeEnvTargeted === unsafe, `${decl.unsafeEnvTargeted} vs ${unsafe}`);

// Her satır gerçekten sınıflandırılmış olmalı — boş string sessizce "0 UNKNOWN" üretebilirdi.
const unclassified = manifest.candidates.filter((c) => !CLASSES.includes(c.classification as never));
record("her manifest satırı geçerli bir sınıf taşıyor", unclassified.length === 0, unclassified.length ? unclassified.map((c) => c.file).join(", ") : `${rows}/${rows}`);

/* ── 3. quiescence snapshots ─────────────────────────────────────────────────────────────── */
const onDisk = readdirSync(DIR).filter((f) => /^0\d[a-z]?-quiescence-m\d/.test(f)).sort();
interface Summary {
  tablesMeasured: number;
  snapshots?: string[];
  pairwiseEqual?: Record<string, boolean>;
  liveDbQuiescent: boolean;
  ledger: string;
}
const summary = JSON.parse(readFileSync(p("04-quiescence-summary.json"), "utf8")) as Summary;
const declaredSnaps = summary.snapshots?.length ?? 0;

record("summary snapshot sayısı == diskteki snapshot dosyaları", declaredSnaps === onDisk.length, `summary ${declaredSnaps} vs disk ${onDisk.length} (${onDisk.join(", ")})`);
record("README quiescenceSnapshots == diskteki dosyalar", decl.quiescenceSnapshots === onDisk.length, `README ${decl.quiescenceSnapshots} vs disk ${onDisk.length}`);

// Her snapshot gerçekten salt-okunur bir oturumda alınmış olmalı.
const notReadOnly = onDisk.filter((f) => {
  const s = JSON.parse(readFileSync(p(f), "utf8")) as { transactionReadOnly?: string };
  return s.transactionReadOnly !== "on";
});
record("her snapshot transaction_read_only=on ile alınmış", notReadOnly.length === 0, notReadOnly.length ? notReadOnly.join(", ") : `${onDisk.length}/${onDisk.length}`);

// Ve hepsi aynı parmak izini taşımalı — audit sırasında yazma olmadığının kanıtı.
const fingerprints = onDisk.map((f) => {
  const s = JSON.parse(readFileSync(p(f), "utf8")) as { tables: unknown[] };
  return JSON.stringify(s.tables);
});
const allEqual = fingerprints.every((x) => x === fingerprints[0]);
record("tüm snapshot'lar birebir aynı (audit sırasında yazma yok)", allEqual, allEqual ? `${onDisk.length} snapshot, tek parmak izi` : "FARK VAR");
record("summary liveDbQuiescent == ölçülen", summary.liveDbQuiescent === allEqual, `${summary.liveDbQuiescent} vs ${allEqual}`);

/* ── 4. artifact count ───────────────────────────────────────────────────────────────────── */
const actualFiles = readdirSync(DIR).filter((f) => !f.startsWith(".")).sort();
record("README artifactFiles == dizindeki gerçek dosya sayısı", decl.artifactFiles === actualFiles.length, `README ${decl.artifactFiles} vs dizin ${actualFiles.length}`);

/* ── 5. ledger ───────────────────────────────────────────────────────────────────────────── */
record("migration ledger 0087/87", summary.ledger === "0087/87", summary.ledger);

/* ── report ──────────────────────────────────────────────────────────────────────────────── */
function report(): void {
  for (const c of checks) console.log(`${c.pass ? "PASS" : "FAIL"}  ${c.name}  (${c.detail})`);
}
report();
const failed = checks.filter((c) => !c.pass);
console.log("");
console.log(`WRITER_AUDIT_EVIDENCE_INTEGRITY = ${failed.length === 0 ? "PASS" : "FAIL"}  (${checks.length - failed.length}/${checks.length})`);
if (failed.length) process.exit(1);
