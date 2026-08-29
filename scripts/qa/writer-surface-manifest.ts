// P24B / writer-surface-audit — enumerate EVERY file in this repository that can write to a
// database, and classify each one by how its target is chosen and what stops it.
//
// WHY A SCRIPT AND NOT A GREP. The first pass of this audit was `grep -rlE "insert into|update"`.
// It found 133 files and it MISSED scripts/perf/measure.ts — the one genuinely unsafe writer in
// the repository — because measure.ts contains no SQL at all. It writes by CALLING generateVolume()
// from another module. A writer surface that only counts files containing SQL literals is not a
// writer surface; it is a list of files containing SQL literals.
//
// So this script detects seven independent classes of write capability (the `SCAN` table below),
// and treats "calls a function that writes" as writing. Every candidate carries the evidence that
// put it in the list, so a reader can re-check the verdict instead of trusting it.
//
// WHAT "guardRunsBeforeFirstWrite" MEANS. A gate that runs after the first INSERT is decoration.
// The check is positional: the line number of the disposable gate must be smaller than the line
// number of the first write-capable statement. Where the target is not env-derived at all
// (a hard-coded disposable database name) the question does not arise and the field is true.
//
// Usage:  node --import tsx scripts/qa/writer-surface-manifest.ts <out.json> <out.md>
import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();

/* ── the seven scan classes required by the audit ─────────────────────────────────────────── */
const SCAN = {
  sqlTokens: /\b(insert\s+into|update\s+[a-z_."]+\s+set|delete\s+from|truncate|alter\s+(table|role|database)|create\s+(table|database|index|role|schema|extension)|drop\s+(table|database|schema|role|index)|copy\s+\S+\s+from|vacuum)\b/i,
  pgProcess: /\b(new\s+Pool|new\s+Client|psql|createdb|dropdb|pg_restore|pg_dump)\b/,
  childProcess: /\b(execSync|execFileSync|execFile|spawnSync|spawn|fork)\s*\(/,
  indirectWriterFns:
    /\b(seed[A-Z]\w*|ensure[A-Z]\w*|fixture[A-Z]\w*|generate[A-Z]\w*|archive[A-Z]\w*|cancel[A-Z]\w*|mark[A-Z]\w*|refresh[A-Z]\w*|reconcile[A-Z]\w*|import[A-Z]\w*|enqueue[A-Z]\w*|prepare[A-Z]\w*|migrate[A-Z]\w*|restore[A-Z]\w*|dropVolume|generateVolume)\s*\(/,
  poolAccess: /\b(getPool|getRawPool)\s*\(|from\s+"@\/lib\/db"|from\s+"@\/lib\/env"/,
  networkMutation: /\b(method\s*:\s*["'](POST|PUT|PATCH|DELETE)["']|fetch\s*\([^)]*["'](POST|PUT|PATCH|DELETE))/,
} as const;

/* ── target-source and guard detection ───────────────────────────────────────────────────── */
const ENV_TARGET = /process\.env\.(DATABASE_URL|MIGRATION_DATABASE_URL)|ownerDatabaseUrl\s*\(|requireOwnerDatabaseUrl\s*\(/;
// The TypeScript gate, plus its hand-written shell equivalent. scripts/ci/provision-verify-db.sh
// cannot `import` owner-url.ts, so it re-implements both halves of the gate as `case` statements —
// the disposable-marker list and the protected-name list — before its dropdb. Detecting only the
// TS identifiers would file the one CI provisioning script in the repository as UNKNOWN.
const DISPOSABLE_GATE =
  /requireDisposableOwnerDatabaseUrl|isDisposableDatabaseName|PROTECTED_DB_NAMES|FORBIDDEN_DB_NAME|DISPOSABLE_PREFIX|mas_radar_dev\|postgres\|template0\|template1/;
// Deliberately NOT anchored on quotes: shell assigns targets bare (`DB=mas_radar_verify` in
// scripts/db/verify.sh), and an earlier draft that required quote delimiters classified that
// file as UNKNOWN purely because it is written in sh rather than TypeScript.
const HARDCODED_DISPOSABLE = /\bmas_radar_[a-z0-9_]*(verify|clone|test|tmp|temp|sandbox|restore|snapshot|probe|drill|empty|volume|fixture|scratch)[a-z0-9_]*\b/;
const ROLLBACK = /\brollback\b/i;

/** Files whose classification was established by READING them, not by pattern. */
const CURATED: Record<string, { classification: string; note: string }> = {
  "scripts/perf/measure.ts": {
    classification: "UNSAFE_ENV_TARGETED",
    note: "FIXED in this audit — see 10-perf-measure-fix.md. Before the fix: raw process.env.MIGRATION_DATABASE_URL, no gate, --seed calls generateVolume().",
  },
  "scripts/perf/volume.ts": {
    classification: "LIBRARY_REQUIRES_CALLER_GUARD",
    note: "Takes a Pool parameter; chooses no target of its own. Safety is the caller's obligation.",
  },
  "scripts/db/roles-verify.ts": {
    classification: "SAFE_ROLLBACK_ONLY",
    note: "Deliberately targets the REAL runtime URL — that is the point of the gate. The single INSERT probe is wrapped in begin/rollback with rollback in a finally block.",
  },
  "scripts/db/constraints-verify.ts": {
    classification: "SAFE_DISPOSABLE_ENFORCED",
    note: "Target is hard-coded (mas_radar_constraints_verify) and never read from env; subprocess env pins BOTH URLs. archivePayment import closure proven env-free and pool-free — see 06-constraints-verify-audit.md.",
  },
  "scripts/db/migrate.ts": {
    classification: "INTENTIONAL_REAL_WRITE",
    note: "The cutover tool. MUST be able to target the real database; owner-url.ts documents why the disposable gate is deliberately NOT applied here.",
  },
  "scripts/prepare-runtime.ts": {
    classification: "INTENTIONAL_REAL_WRITE",
    note: "Runs on every dev/start. ensureWindow(...,24) materialises a 26-month instance window against the real DB by design. This is the AMPLIFIER in the P24B incident, not its root cause.",
  },
  "scripts/db/seed-admin.ts": { classification: "INTENTIONAL_REAL_WRITE", note: "Operator-run account creation." },
  "scripts/db/seed-system-actor.ts": { classification: "INTENTIONAL_REAL_WRITE", note: "Idempotent system actor row; called by prepare-runtime and by provisioning." },
  "scripts/db/set-app-role-password.ts": { classification: "INTENTIONAL_REAL_WRITE", note: "ALTER ROLE on the real cluster; a cutover step." },
  "scripts/import-real.ts": { classification: "INTENTIONAL_REAL_WRITE", note: "The reviewed workbook import. Writing real data is its purpose." },
  "scripts/db/legacy-repair-apply.ts": { classification: "INTENTIONAL_REAL_WRITE", note: "Repairs real legacy rows under an advisory lock with a receipt; commits deliberately." },
  "scripts/db/ensure.ts": { classification: "INTENTIONAL_REAL_WRITE", note: "Container/database lifecycle (createdb). Provisioning, not fixture writing." },
  "scripts/db/create-testsprite-db.ts": { classification: "INTENTIONAL_REAL_WRITE", note: "Creates the synthetic TestSprite database. Target is a separate database by construction." },
  "scripts/db/dev-reset.sh": {
    classification: "INTENTIONAL_REAL_WRITE",
    note: "DESTRUCTIVE AND HARD-CODED TO THE REAL DATABASE: `DB=mas_radar_dev`, then dropdb --if-exists + createdb + replay every migration. Not env-targeted, so no gate can help; its safety rests entirely on nobody running it. Developer reset tool.",
  },
  "scripts/deploy/local-start.sh": {
    classification: "INTENTIONAL_REAL_WRITE",
    note: "`DB=${MAS_DB_NAME:-mas_radar_dev}` — defaults to the REAL database, then createdb + local-bootstrap.sql + migrate.ts + seed.sql. Local deployment provisioning.",
  },
  "scripts/deploy/restore-db.sh": {
    classification: "INTENTIONAL_REAL_WRITE",
    note: "dropdb + createdb + `pg_restore -d $TARGET`. Restoring into a real database is the tool's purpose; target comes from its argument.",
  },
  "scripts/db/p24b-readonly-psql.sh": {
    classification: "SAFE_ROLLBACK_ONLY",
    note: "Read-only wrapper: refuses any target but mas_radar_dev AND opens the session with PGOPTIONS=-c default_transaction_read_only=on, so the ENGINE rejects every mutation. Stronger than rollback — the write never begins.",
  },
  "scripts/db/fixture-cleanup.ts": {
    classification: "INTENTIONAL_REAL_WRITE",
    note: "NOT AUTHORIZED / OUTDATED. Env-targeted deletes against the real DB by design, but its hard-coded footprint is stale (4 of 6 p24b users; no settings/action_items). Must not run.",
  },
};

/* ── enumeration ─────────────────────────────────────────────────────────────────────────── */
const AREAS = ["scripts", "src", "tests", ".github"];
const EXTS = new Set([".ts", ".tsx", ".js", ".mjs", ".sh", ".yml", ".yaml"]);
const SKIP_DIR = /node_modules|\.next|\.venv|\.git$|__snapshots__/;

function walk(dir: string, out: string[] = []): string[] {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e);
    if (SKIP_DIR.test(p)) continue;
    let st;
    try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) walk(p, out);
    else if (EXTS.has(path.extname(p))) out.push(p);
  }
  return out;
}

interface Candidate {
  file: string;
  entryPoint: string;
  writeMechanisms: string[];
  tablesOrObjects: string[];
  targetSource: string;
  guard: string;
  guardRunsBeforeFirstWrite: boolean;
  transitiveWriter: boolean;
  callers: string[];
  classification: string;
  evidence: string[];
}

const all = AREAS.flatMap((a) => walk(path.join(ROOT, a))).map((p) =>
  path.relative(ROOT, p).split(path.sep).join("/"),
);

/* Known writer functions exported by libraries, for transitive detection. */
const WRITER_EXPORTS: Record<string, string> = {
  generateVolume: "scripts/perf/volume.ts",
  dropVolume: "scripts/perf/volume.ts",
  ensureWindow: "src/lib/radar/engine.ts",
  generateInstancesForMonth: "src/lib/radar/engine.ts",
  archivePayment: "src/lib/payments/engine.ts",
  ensureSystemActor: "scripts/db/seed-system-actor.ts",
  prepareLegacyCheckpointForCancellationValidation: "scripts/db/legacy-cancellation-fixture.ts",
};

const text = new Map<string, string>();
for (const f of all) {
  try { text.set(f, readFileSync(path.join(ROOT, f), "utf8")); } catch { /* unreadable */ }
}

/** package.json script that runs this file, if any. */
const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
  scripts: Record<string, string>;
};
function entryPointFor(file: string): string {
  const hits = Object.entries(pkg.scripts)
    .filter(([, cmd]) => cmd.includes(file))
    .map(([name]) => `pnpm ${name}`);
  return hits.length ? hits.join(" · ") : "(module / not a package script)";
}

function tablesIn(src: string): string[] {
  const t = new Set<string>();
  const re = /\b(?:insert\s+into|delete\s+from|update|truncate(?:\s+table)?)\s+((?:public|auth)\.[a-z_]+)/gi;
  let m;
  while ((m = re.exec(src)) !== null) t.add(m[1].toLowerCase());
  return [...t].sort();
}

function firstWriteLine(src: string): number {
  const lines = src.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*(\/\/|\*|\/\*)/.test(l)) continue; // comments are not writes
    if (SCAN.sqlTokens.test(l) || /\b(generateVolume|dropVolume|ensureWindow)\s*\(/.test(l)) return i + 1;
  }
  return Number.MAX_SAFE_INTEGER;
}
function guardLine(src: string): number {
  const lines = src.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(\/\/|\*|\/\*)/.test(lines[i])) continue;
    if (DISPOSABLE_GATE.test(lines[i])) return i + 1;
  }
  return Number.MAX_SAFE_INTEGER;
}

const candidates: Candidate[] = [];

for (const f of all) {
  const src = text.get(f);
  if (!src) continue;

  // Strip comment-only lines before deciding "does this write?", so a file that merely DISCUSSES
  // TRUNCATE (phase18-verify.ts) does not enter the manifest as a writer. Shell and YAML comment
  // with `#`; this repository's scripts carry long `#` prologues that name every destructive verb
  // they avoid, so missing them would flood the manifest with false writers.
  const shellish = /\.(sh|ya?ml)$/.test(f);
  const commentLine = shellish ? /^\s*#/ : /^\s*(\/\/|\*|\/\*)/;
  const code = src
    .split(/\r?\n/)
    .filter((l) => !commentLine.test(l))
    .join("\n");

  const mech: string[] = [];
  if (SCAN.sqlTokens.test(code)) mech.push("SQL DML/DDL");
  if (/new\s+Pool|new\s+Client/.test(code)) mech.push("pg Pool/Client");
  if (/\bpsql\b/.test(code)) mech.push("psql");
  if (/\bcreatedb\b|\bdropdb\b/.test(code)) mech.push("createdb/dropdb");
  if (/pg_restore|pg_dump/.test(code)) mech.push("pg_dump/pg_restore");
  if (SCAN.childProcess.test(code)) mech.push("child process");
  if (SCAN.networkMutation.test(code)) mech.push("HTTP mutation");
  if (/migrate/i.test(code) && /\.sql\b|schema_migrations/.test(code)) mech.push("migration");

  const transitiveCalls = Object.keys(WRITER_EXPORTS).filter(
    (fn) => new RegExp(`\\b${fn}\\s*\\(`).test(code) && WRITER_EXPORTS[fn] !== f,
  );
  const transitiveWriter = transitiveCalls.length > 0;
  if (transitiveWriter) mech.push(`calls writer: ${transitiveCalls.join(", ")}`);

  // A candidate must be able to REACH a database. SQL text alone is not enough — phase18-verify.ts
  // discusses TRUNCATE at length and opens no connection at all — and neither is a child process
  // (most are docker or git). Reaching means: its own pg client, the app's pool accessor, a
  // psql/createdb/dropdb/pg_restore subprocess, or a call into a module that writes.
  const usesAppPool = /\b(getPool|getRawPool)\s*\(/.test(code);
  const reaches =
    /new\s+Pool|new\s+Client/.test(code) ||
    usesAppPool ||
    /\bpsql\b|\bcreatedb\b|\bdropdb\b|pg_restore|pg_dump/.test(code) ||
    transitiveWriter;
  if (!reaches) continue;
  // …and it must actually MUTATE a DATABASE. Two distinctions that decide four files:
  //   · `pg_dump` reads. It produces a file; it never changes a row.
  //   · `pg_restore --list` prints an archive's table of contents. Only `pg_restore -d` loads.
  // scripts/db/backup-docker-postgres.ts uses pg_restore EXCLUSIVELY with --list to prove a dump
  // is readable, and scripts/ops/{backup-lib,offdevice-copy}.ts only ever move files. Counting
  // those as database writers would inflate the surface with tools that cannot touch a row.
  const restoresIntoDb = /pg_restore(?![^\n]*--list)/.test(code);
  const mutates =
    SCAN.sqlTokens.test(code) || transitiveWriter || /\b(createdb|dropdb)\b/.test(code) || restoresIntoDb;
  if (!mutates) continue;

  const envTargeted = ENV_TARGET.test(code);
  const gated = DISPOSABLE_GATE.test(code);
  const hardcoded = HARDCODED_DISPOSABLE.test(code);
  const takesPool = /\(\s*pool\s*:\s*Pool|client\s*:\s*PoolClient/.test(code);

  const targetSource = gated
    ? "env, validated by disposable gate"
    : hardcoded && !envTargeted
      ? "hard-coded disposable database name"
      : envTargeted
        ? "env (DATABASE_URL / MIGRATION_DATABASE_URL)"
        : takesPool
          ? "caller-supplied Pool"
          : "none (no DB target of its own)";

  const guard = gated
    ? "requireDisposableOwnerDatabaseUrl / isDisposableDatabaseName"
    : hardcoded && !envTargeted
      ? "hard-coded disposable target (no env path)"
      : ROLLBACK.test(code) && !SCAN.sqlTokens.test(code.replace(/rollback/gi, ""))
        ? "rollback-only"
        : "NONE";

  const gl = guardLine(src);
  const fw = firstWriteLine(src);
  const guardRunsBeforeFirstWrite = gated ? gl < fw : true;

  const callers = all.filter(
    (o) => o !== f && (text.get(o) ?? "").includes(path.basename(f, path.extname(f))) &&
      new RegExp(`from\\s+["'][^"']*${path.basename(f, path.extname(f))}["']`).test(text.get(o) ?? ""),
  );

  // NO CATCH-ALL. An earlier draft ended with `else -> SAFE_DISPOSABLE_ENFORCED`, which quietly
  // certified 24 files nobody had looked at — including every server action in src/app. A writer
  // this script cannot place lands in UNKNOWN, and UNKNOWN blocks the audit (exit 1 below). That
  // is the only way the count means anything.
  const appRuntime = (f.startsWith("src/app/") || f.startsWith("src/lib/")) && usesAppPool;

  let classification: string;
  const curated = CURATED[f];
  if (curated) classification = curated.classification;
  else if (appRuntime) classification = "INTENTIONAL_REAL_WRITE";
  else if (gated) classification = "SAFE_DISPOSABLE_ENFORCED";
  else if (hardcoded && !envTargeted) classification = "SAFE_DISPOSABLE_ENFORCED";
  else if (takesPool && !envTargeted && !usesAppPool) classification = "LIBRARY_REQUIRES_CALLER_GUARD";
  else if (envTargeted) classification = "UNSAFE_ENV_TARGETED";
  else classification = "UNKNOWN";

  const evidence: string[] = [];
  if (gated) evidence.push(`disposable gate at line ${gl}, first write-capable line ${fw === Number.MAX_SAFE_INTEGER ? "-" : fw}`);
  if (hardcoded) evidence.push("hard-coded disposable database name present");
  if (envTargeted) evidence.push("reads DATABASE_URL / MIGRATION_DATABASE_URL");
  if (transitiveWriter) evidence.push(`transitive writer via ${transitiveCalls.join(", ")}`);
  if (curated) evidence.push(curated.note);

  candidates.push({
    file: f,
    entryPoint: entryPointFor(f),
    writeMechanisms: mech,
    tablesOrObjects: tablesIn(code),
    targetSource,
    guard,
    guardRunsBeforeFirstWrite,
    transitiveWriter,
    callers,
    classification,
    evidence,
  });
}

candidates.sort((a, b) => a.file.localeCompare(b.file));

const ORDER = [
  "UNSAFE_ENV_TARGETED",
  "UNKNOWN",
  "LIBRARY_REQUIRES_CALLER_GUARD",
  "INTENTIONAL_REAL_WRITE",
  "SAFE_ROLLBACK_ONLY",
  "SAFE_DISPOSABLE_ENFORCED",
];
const counts: Record<string, number> = {};
for (const c of candidates) counts[c.classification] = (counts[c.classification] ?? 0) + 1;

const manifest = {
  generatedAtUtc: new Date().toISOString(),
  filesScanned: all.length,
  writerCandidates: candidates.length,
  scanClasses: Object.keys(SCAN),
  counts,
  candidates,
};

const outJson = process.argv[2] ?? "05-writer-surface-manifest.json";
const outMd = process.argv[3] ?? "05-writer-surface-manifest.md";
writeFileSync(outJson, JSON.stringify(manifest, null, 2) + "\n", "utf8");

const md: string[] = [
  "# Writer surface manifest",
  "",
  `Üretim: \`node --import tsx scripts/qa/writer-surface-manifest.ts\` · ${manifest.generatedAtUtc}`,
  "",
  `Taranan dosya: **${all.length}** · writer aday: **${candidates.length}**`,
  "",
  "| sınıf | adet |",
  "|---|---|",
  ...ORDER.filter((k) => counts[k]).map((k) => `| ${k} | ${counts[k]} |`),
  "",
  "| file | entry point | mechanisms | target source | guard | guard<1st write | classification |",
  "|---|---|---|---|---|---|---|",
  ...candidates
    .slice()
    .sort((a, b) => ORDER.indexOf(a.classification) - ORDER.indexOf(b.classification) || a.file.localeCompare(b.file))
    .map(
      (c) =>
        `| \`${c.file}\` | ${c.entryPoint} | ${c.writeMechanisms.join("; ") || "-"} | ${c.targetSource} | ${c.guard} | ${c.guardRunsBeforeFirstWrite ? "✔" : "✘"} | **${c.classification}** |`,
    ),
  "",
];
writeFileSync(outMd, md.join("\n"), "utf8");

console.log(`taranan ${all.length} dosya · ${candidates.length} writer adayı`);
for (const k of ORDER) if (counts[k]) console.log(`  ${k.padEnd(32)} ${counts[k]}`);
if (counts.UNKNOWN) {
  console.error(`\nUNKNOWN = ${counts.UNKNOWN} — sınıflandırılmamış writer varken audit PASS olamaz.`);
  for (const c of candidates.filter((x) => x.classification === "UNKNOWN")) console.error(`  ${c.file}`);
  process.exit(1);
}
