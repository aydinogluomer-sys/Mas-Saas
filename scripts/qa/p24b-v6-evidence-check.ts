// P24B V6.1 — evidence hard gate.
//
// The agent that produced the footprint must not also be the thing that certifies it. This script
// re-derives every claim from the artifacts and fails the audit on any mismatch. It reads files
// only; it never opens a database connection.
//
// The rule it exists to enforce: a row may be a DELETE_TARGET only with at least TWO INDEPENDENT
// evidence classes, and TIME is never one of them. Two approvals in this footprint were originally
// found by a time-window sweep alone; without this gate "found in the right minute" could quietly
// become "safe to delete".
//
// Usage:  node --import tsx scripts/qa/p24b-v6-evidence-check.ts [evidence-dir]
import { readFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";

const DIR = process.argv[2] ?? "docs/release-evidence/final-production-readiness/p24b-v6";
const p = (f: string): string => path.join(DIR, f);

const REQUIRED = [
  "00-v6-synthesis.md",
  "01-exact-manifest.json",
  "02-row-evidence-manifest.json",
  "02-row-evidence-manifest.md",
  "03-v6-readonly-proof.json",
  "03-v6-readonly-proof.md",
  "04-metric-snapshot-recompute-dryrun.json",
  "04-metric-snapshot-recompute-dryrun.md",
  "05-cleanup-dry-plan.json",
  "05-cleanup-dry-plan.md",
];

interface Check { name: string; pass: boolean; detail: string }
const checks: Check[] = [];
const rec = (name: string, pass: boolean, detail: string): void => { checks.push({ name, pass, detail }); };

function report(): number {
  for (const c of checks) console.log(`${c.pass ? "PASS" : "FAIL"}  ${c.name}  (${c.detail})`);
  const failed = checks.filter((c) => !c.pass).length;
  console.log("");
  console.log(`P24B_V6_EVIDENCE_INTEGRITY = ${failed === 0 ? "PASS" : "FAIL"}  (${checks.length - failed}/${checks.length})`);
  return failed;
}

const missing = REQUIRED.filter((f) => !existsSync(p(f)));
rec("zorunlu artifact'ler mevcut", missing.length === 0, missing.length ? `eksik: ${missing.join(", ")}` : `${REQUIRED.length}/${REQUIRED.length}`);
if (missing.length) { process.exit(report() ? 1 : 0); }

/* ── exact manifest vs row manifest ──────────────────────────────────────────────────────── */
interface Exact {
  counts: Record<string, number>;
  directContamination: Record<string, Array<{ id?: string; key?: string }>>;
}
interface RowEv {
  total: number;
  counts: Record<string, number>;
  classificationTotals: Record<string, number>;
  rows: Array<{
    table: string; id: string; classification: string; xmin: string;
    evidence: Array<{ class: string }>; independentEvidenceClassCount: number; baselineAbsent: boolean;
    deleteOrder: number | null;
  }>;
}
const exact = JSON.parse(readFileSync(p("01-exact-manifest.json"), "utf8")) as Exact;
const rowEv = JSON.parse(readFileSync(p("02-row-evidence-manifest.json"), "utf8")) as RowEv;

// Expected per-table counts are DERIVED from the exact manifest, never hard-coded here: a literal
// `users: 6` in this file would keep passing after the footprint changed underneath it.
const expected = exact.counts;
for (const t of ["users", "action_items", "payments", "settings", "approvals", "payment_instances"]) {
  rec(`tablo sayısı eşleşiyor: ${t}`, rowEv.counts[t] === expected[t], `row-manifest ${rowEv.counts[t]} vs exact ${expected[t]}`);
}
rec("toplam == exact manifest total", rowEv.total === expected.total, `${rowEv.total} vs ${expected.total}`);
rec("toplam == satır dizisi uzunluğu", rowEv.total === rowEv.rows.length, `${rowEv.total} vs ${rowEv.rows.length}`);

// ID-level identity, not just counts.
const exactIds = new Set<string>();
for (const [, arr] of Object.entries(exact.directContamination)) {
  for (const r of arr) exactIds.add(String(r.id ?? r.key));
}
const rowIds = new Set(rowEv.rows.map((r) => r.id));
const onlyExact = [...exactIds].filter((x) => !rowIds.has(x));
const onlyRow = [...rowIds].filter((x) => !exactIds.has(x));
rec("exact manifest ID'leri == row manifest ID'leri", onlyExact.length === 0 && onlyRow.length === 0,
  onlyExact.length || onlyRow.length ? `yalnız-exact: ${onlyExact.join(",")} · yalnız-row: ${onlyRow.join(",")}` : `${rowIds.size} ID birebir`);

rec("duplicate satır yok", rowIds.size === rowEv.rows.length, `${rowEv.rows.length} satır, ${rowIds.size} benzersiz ID`);

/* ── the evidence rule ───────────────────────────────────────────────────────────────────── */
const targets = rowEv.rows.filter((r) => r.classification === "DELETE_TARGET");
const weak = targets.filter((r) => r.independentEvidenceClassCount < 2);
rec("her DELETE_TARGET >= 2 bağımsız kanıt sınıfı", weak.length === 0,
  weak.length ? weak.map((w) => `${w.table}/${w.id.slice(0, 8)}=${w.independentEvidenceClassCount}`).join(", ") : `${targets.length}/${targets.length}`);

// The count must have been computed with TIME excluded — verify independently from `evidence`.
const miscounted = rowEv.rows.filter((r) => {
  const classes = new Set(r.evidence.map((e) => e.class).filter((k) => k !== "TIME"));
  return classes.size !== r.independentEvidenceClassCount;
});
rec("kanıt sınıfı sayımı TIME'ı hariç tutuyor", miscounted.length === 0,
  miscounted.length ? miscounted.map((m) => m.id.slice(0, 8)).join(", ") : "yeniden türetildi, eşleşti");

const timeOnly = targets.filter((r) => {
  const classes = new Set(r.evidence.map((e) => e.class));
  return classes.size === 1 && classes.has("TIME");
});
rec("hiçbir DELETE_TARGET yalnız TIME'a dayanmıyor", timeOnly.length === 0, timeOnly.length ? timeOnly.map((t) => t.id).join(", ") : "0");

const notBaseline = targets.filter((r) => !r.baselineAbsent);
rec("her DELETE_TARGET temiz tabanda YOK", notBaseline.length === 0, notBaseline.length ? String(notBaseline.length) : `${targets.length}/${targets.length}`);

const noOrder = targets.filter((r) => r.deleteOrder === null);
rec("her DELETE_TARGET bir silme sırası taşıyor", noOrder.length === 0, noOrder.length ? String(noOrder.length) : "42/42");

const unresolved = rowEv.classificationTotals.UNRESOLVED ?? 0;
rec("UNRESOLVED = 0", unresolved === 0, String(unresolved));

/* ── negative guards: things that must NEVER be delete targets ───────────────────────────── */
const ATILLA = "eb9c61e7-ef57-4dae-b180-0e9d5b7fe8ae";
rec("atilla DELETE_TARGET değil", !rowIds.has(ATILLA), rowIds.has(ATILLA) ? "MANİFESTTE!" : "manifestte yok");
rec("audit_logs DELETE_TARGET değil", !rowEv.rows.some((r) => r.table === "audit_logs"), "manifestte audit_logs satırı yok");
const forbidden = rowEv.rows.filter((r) => !Object.keys(expected).includes(r.table) && r.table !== "total");
rec("yalnız beklenen 6 tablo hedeflenmiş", forbidden.length === 0, forbidden.length ? [...new Set(forbidden.map((f) => f.table))].join(", ") : "6 tablo");

/* ── dry-run cross-checks ────────────────────────────────────────────────────────────────── */
interface Dry {
  deleteOrder: Array<{ step: number; table: string; deleted: number }>;
  orphanInstancesAfterDelete: number;
  semanticChangeCount: number;
  technicalOnlyChangeCount: number;
  beforeCount: number; afterCount: number;
}
const dry = JSON.parse(readFileSync(p("04-metric-snapshot-recompute-dryrun.json"), "utf8")) as Dry;
const dryTotal = dry.deleteOrder.reduce((a, d) => a + d.deleted, 0);
rec("dry-run silinen toplam == 42", dryTotal === rowEv.total, `${dryTotal} vs ${rowEv.total}`);
rec("dry-run sonrası orphan payment_instances = 0", dry.orphanInstancesAfterDelete === 0, String(dry.orphanInstancesAfterDelete));
rec("beklenmedik semantik değişim yok (== 2)", dry.semanticChangeCount === 2, `${dry.semanticChangeCount} semantik, ${dry.technicalOnlyChangeCount} teknik-only`);
rec("snapshot satır sayısı korunuyor (upsert)", dry.beforeCount === dry.afterCount, `${dry.beforeCount} -> ${dry.afterCount}`);

// The dry-run's delete order must match the order the row manifest assigns.
const dryOrder = dry.deleteOrder.map((d) => d.table).join(" > ");
const manifestOrder = [...new Set(rowEv.rows.slice().sort((a, b) => (a.deleteOrder ?? 0) - (b.deleteOrder ?? 0)).map((r) => r.table))].join(" > ");
rec("dry-run silme sırası == manifest sırası", dryOrder === manifestOrder, `${dryOrder}`);

/* ── readonly proof ──────────────────────────────────────────────────────────────────────── */
interface Proof {
  readonly: { transactionReadOnly: string; wrapperUsed: boolean };
  comparison: { changedTables: string[]; changedRows: number; fingerprintEqual: boolean };
  preDiscovery: { schemaMigrations: string };
}
const proof = JSON.parse(readFileSync(p("03-v6-readonly-proof.json"), "utf8")) as Proof;
rec("keşif salt-okunur oturumda koştu", proof.readonly.transactionReadOnly === "on" && proof.readonly.wrapperUsed, `read_only=${proof.readonly.transactionReadOnly}`);
rec("keşif öncesi/sonrası parmak izi aynı", proof.comparison.fingerprintEqual && proof.comparison.changedRows === 0 && proof.comparison.changedTables.length === 0, `changedRows=${proof.comparison.changedRows}`);
rec("ledger 0087/87", proof.preDiscovery.schemaMigrations === "0087/87", proof.preDiscovery.schemaMigrations);

/* ── artifact/file count ─────────────────────────────────────────────────────────────────── */
const actual = readdirSync(DIR).filter((f) => !f.startsWith(".")).length;
rec("dizindeki dosya sayısı beklenen setle tutarlı", actual >= REQUIRED.length, `${actual} dosya, en az ${REQUIRED.length} bekleniyor`);

process.exit(report() ? 1 : 0);
