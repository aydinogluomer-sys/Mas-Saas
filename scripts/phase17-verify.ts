// Faz 17 verification — the standing guard that keeps money out of float8.
//
// This is a SOURCE check, not a database check: it needs no connection string and touches no
// data, which is deliberate. The property it defends ("no money value crosses the SQL/JS
// boundary through a lossy cast") lives entirely in the source tree, and a gate that needs a
// database is a gate people skip. It is also why this one is safe to run in CI, where the
// data-dependent phase scripts cannot run at all (see docs/status-notes.md, Faz 16).
//
// implementation.md §17 rule 6 makes this a STANDING rule rather than a one-off cleanup:
// after Faz 17 a new `::float8` cast is forbidden, and every later phase inherits this check.
//
// THREE DIFFERENT STANDARDS, ON PURPOSE:
//
//   src/**              zero casts in code. This is the application; it is what Faz 17 fixed.
//   supabase/**         zero float8/double precision/real COLUMNS. This was already true
//                       before Faz 17 and the check exists so it stays true.
//   scripts/**          the count is PINNED, not zero. The verify scripts are the independent
//                       oracle that proves the application's numbers still match the source
//                       workbook. Migrating them in the same commit that migrates the code
//                       they check would mean changing the ruler and the object together — a
//                       compensating error on both sides would become invisible. They stay on
//                       their existing float8 path so that the Faz 17 gates compare the new
//                       application against an UNCHANGED reference. Pinning the count is what
//                       stops this from turning into a licence to add more.
//
// Usage:
//   pnpm phase17:verify
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();

interface Check {
  name: string;
  pass: boolean;
  detail: string;
}
const checks: Check[] = [];
function record(name: string, pass: boolean, detail: string): void {
  checks.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name} — ${detail}`);
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Documentation allowances inside src/.
 *
 * Every entry needs a reason and an exact expected count, so "one documented mention" cannot
 * quietly become "eleven casts nobody reviewed". These are prose ABOUT the problem, in files
 * that contain no such cast in code.
 *
 * There are deliberately no code exceptions in src/. If a genuine one ever appears (a query
 * where float8 is provably right — a statistical aggregate, never a money value), add it here
 * WITH the reason, and say so in docs/status-notes.md.
 */
interface Allowance {
  file: string;
  occurrences: number;
  reason: string;
}
const SRC_DOC_ALLOWANCES: Allowance[] = [
  {
    file: "src/lib/money.ts",
    occurrences: 4,
    reason:
      "Dokümantasyon: modül başlığı ::float8'in neden kaldırıldığını ve hangi ölçümle " +
      "kanıtlandığını anlatıyor; iki JSDoc 'bu yardımcı hangi cast'in yerine geçer' diyor. " +
      "Dosyada tek satır SQL yok.",
  },
  {
    file: "src/lib/radar/queries.ts",
    occurrences: 2,
    reason:
      "Dokümantasyon: dosya başlığı ve paymentHistoryEvents'in JSDoc'u, Faz 17'de düzeltilen " +
      "karışık ::numeric/::float8 tutarsızlığını anlatıyor. İkisi de yorum satırı.",
  },
];

/**
 * The oracle scripts, pinned at the count Faz 17 found them with.
 *
 * Deferred to a later phase (Faz 17B) rather than migrated here — see the header. The numbers
 * below are occurrences, not lines: several lines carry two casts.
 */
const SCRIPT_BASELINE: Record<string, number> = {
  "scripts/phase4-verify.ts": 16,
  "scripts/phase5-verify.ts": 2,
  "scripts/phase6-verify.ts": 3,
  "scripts/phase7-verify.ts": 2,
  "scripts/phase8-verify.ts": 14,
  "scripts/phase9b-verify.ts": 2,
  "scripts/phase9d-verify.ts": 3,
  "scripts/phase13a-verify.ts": 3,
  "scripts/seed-demo.ts": 2,
};

/** This file names the pattern it hunts for, so it can never scan itself. */
const SELF = "scripts/phase17-verify.ts";

/** A line is documentation if it is a comment line. This is a heuristic, and its one blind
 * spot is a SQL line inside a template literal that happens to begin with `*` — no such line
 * exists in this repo, and a real cast would still be caught by the per-file count. */
function isCommentLine(line: string): boolean {
  const t = line.trim();
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
}

interface Hit {
  file: string;
  line: number;
  text: string;
  comment: boolean;
}

/**
 * Tracked files PLUS files that are new but not ignored.
 *
 * The `--others --exclude-standard` half matters: without it a brand-new file (money.ts on the
 * day it was written) is invisible to the gate, which is the one moment a gate must not blink.
 */
function sourceFiles(prefixes: string[]): string[] {
  const run = (args: string[]) =>
    execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 })
      .split("\n")
      .map((f) => f.trim())
      .filter(Boolean);
  const tracked = run(["ls-files", ...prefixes]);
  const untracked = run(["ls-files", "--others", "--exclude-standard", ...prefixes]);
  return [...new Set([...tracked, ...untracked])].filter((f) => /\.(ts|tsx|sql)$/.test(f));
}

function scan(prefixes: string[]): Hit[] {
  const hits: Hit[] = [];
  for (const file of sourceFiles(prefixes)) {
    if (file === SELF) continue;
    let content: string;
    try {
      content = readFileSync(path.join(ROOT, file), "utf8");
    } catch {
      continue;
    }
    if (!content.includes("::float8")) continue;
    content.split("\n").forEach((text, i) => {
      let from = 0;
      for (;;) {
        const at = text.indexOf("::float8", from);
        if (at === -1) break;
        hits.push({ file, line: i + 1, text: text.trim(), comment: isCommentLine(text) });
        from = at + 1;
      }
    });
  }
  return hits;
}

function main(): void {
  // ── 1) src/: zero casts in code ────────────────────────────────────────────────────────
  const srcHits = scan(["src"]);
  const srcCode = srcHits.filter((h) => !h.comment);
  const allowedFiles = new Set(SRC_DOC_ALLOWANCES.map((a) => a.file));
  const offending = srcCode.filter((h) => !allowedFiles.has(h.file));
  record(
    "src/ içinde izin-listesi dışında hiç ::float8 SQL cast'i yok",
    offending.length === 0,
    offending.length === 0
      ? "uygulama kodunda sıfır cast"
      : offending.map((h) => `${h.file}:${h.line} ${h.text.slice(0, 80)}`).join(" | "),
  );

  // any code-level cast, even inside an allowed file, is a failure
  const codeInAllowed = srcCode.filter((h) => allowedFiles.has(h.file));
  record(
    "izin verilen dosyalarda da cast KOD içinde değil, yalnız yorumda",
    codeInAllowed.length === 0,
    codeInAllowed.length === 0
      ? "izin verilenlerin hepsi yorum satırı"
      : codeInAllowed.map((h) => `${h.file}:${h.line}`).join(", "),
  );

  // ── 2) each documentation allowance still matches exactly ──────────────────────────────
  for (const entry of SRC_DOC_ALLOWANCES) {
    const found = srcHits.filter((h) => h.file === entry.file);
    const ok = found.length === entry.occurrences;
    record(
      `izin listesi: ${entry.file}`,
      ok,
      ok
        ? `${found.length} adet yorum — ${entry.reason}`
        : `beklenen ${entry.occurrences}, bulunan ${found.length} — izin listesi güncellenmeli`,
    );
  }

  // ── 3) migrations still declare no float8/real column ──────────────────────────────────
  // Faz 17's premise was that the schema is already clean; this keeps it that way. The
  // pattern deliberately looks for column TYPES, not the word appearing in a comment.
  const migrationOffenders: string[] = [];
  let migrationFileCount = 0;
  for (const file of sourceFiles(["supabase"])) {
    if (file.endsWith(".sql")) migrationFileCount++;
    const content = readFileSync(path.join(ROOT, file), "utf8");
    content.split("\n").forEach((line, i) => {
      const t = line.trim();
      if (t.startsWith("--")) return;
      if (/\b(double\s+precision|float8|float4|\breal\b)\b/i.test(t)) {
        migrationOffenders.push(`${file}:${i + 1} ${t.slice(0, 70)}`);
      }
    });
  }
  record(
    "migration'larda hiç float8/double precision/real kolon yok (para hep numeric)",
    migrationOffenders.length === 0,
    migrationOffenders.length === 0
      // Sayı dinamik: tablo sayısı her yeni fazla büyüyor ve sabit bir metin bayatlıyor
      // (Faz 19/20 sekiz + üç tablo ekledi). Tarama zaten migration dosyalarının tamamı
      // üzerinde; burada yalnız kaç dosyanın tarandığı bildiriliyor.
      ? `${migrationFileCount} migration dosyasının tamamında para kolonları numeric(p,s)`
      : migrationOffenders.join(" | "),
  );

  // ── 4) oracle scripts: pinned, may not grow ────────────────────────────────────────────
  const scriptHits = scan(["scripts"]);
  const byFile = new Map<string, number>();
  for (const h of scriptHits) byFile.set(h.file, (byFile.get(h.file) ?? 0) + 1);

  const grown: string[] = [];
  const newFiles: string[] = [];
  for (const [file, count] of byFile) {
    const baseline = SCRIPT_BASELINE[file];
    if (baseline === undefined) newFiles.push(`${file} (+${count})`);
    else if (count > baseline) grown.push(`${file}: ${baseline} → ${count}`);
  }
  record(
    "scripts/ içinde YENİ ::float8 cast'i eklenmemiş (sayım sabitlenmiş)",
    grown.length === 0 && newFiles.length === 0,
    grown.length === 0 && newFiles.length === 0
      ? `${scriptHits.length} cast, ${Object.keys(SCRIPT_BASELINE).length} script'te — Faz 17B'ye bilinçli olarak ertelendi`
      : [...grown, ...newFiles].join(" | "),
  );

  // Shrinking is fine (that is Faz 17B doing its job) but the baseline must then be updated,
  // so it is reported rather than silently tolerated.
  const shrunk = Object.entries(SCRIPT_BASELINE)
    .filter(([file, baseline]) => (byFile.get(file) ?? 0) < baseline)
    .map(([file, baseline]) => `${file}: ${baseline} → ${byFile.get(file) ?? 0}`);
  if (shrunk.length > 0) {
    console.log(`\nBilgi: script sayımı azalmış (Faz 17B ilerliyor) — baseline güncellenmeli: ${shrunk.join(", ")}`);
  }

  // ── 5) the shared money module ─────────────────────────────────────────────────────────
  let moneySrc = "";
  try {
    moneySrc = readFileSync(path.join(ROOT, "src", "lib", "money.ts"), "utf8");
  } catch {
    /* reported below */
  }
  record(
    "src/lib/money.ts mevcut ve big.js üzerine kurulu",
    moneySrc.includes('from "big.js"'),
    moneySrc ? `${moneySrc.split("\n").length} satır` : "dosya okunamadı",
  );

  // The scoped constructor is the guarantee that nobody else's Big.DP/Big.RM change can move
  // this application's rounding. Losing it would be a silent correctness regression.
  record(
    "money.ts kendi Big yapıcısını kullanıyor (global Big yapılandırmasından yalıtık)",
    /const\s+MoneyBig\s*=\s*Big\(\)/.test(moneySrc),
    "MoneyBig = Big() — DP/RM global mutasyonlardan etkilenmez",
  );

  // ── 6) nobody bypasses the configured constructor ──────────────────────────────────────
  const directImporters = sourceFiles(["src"])
    .filter((f) => /\.(ts|tsx)$/.test(f) && f !== "src/lib/money.ts")
    .filter((f) => {
      try {
        return /from\s+["']big\.js["']/.test(readFileSync(path.join(ROOT, f), "utf8"));
      } catch {
        return false;
      }
    });
  record(
    "money.ts dışında hiçbir dosya big.js'i doğrudan içe aktarmıyor",
    directImporters.length === 0,
    directImporters.length === 0 ? "tek giriş noktası korunuyor" : directImporters.join(", "),
  );

  // ── 7) the money unit tests actually run ───────────────────────────────────────────────
  try {
    execFileSync("pnpm", ["exec", "vitest", "run", "src/lib/money.test.ts"], {
      cwd: ROOT,
      stdio: "pipe",
      shell: process.platform === "win32",
    });
    record("money birim testleri geçiyor", true, "vitest exit 0");
  } catch (e) {
    record("money birim testleri geçiyor", false, messageOf(e).slice(0, 300));
  }

  const failed = checks.filter((c) => !c.pass);
  console.log(`\n${checks.length - failed.length}/${checks.length} kontrol geçti.`);
  if (failed.length > 0) {
    console.error(`\nPHASE17 VERIFY FAIL — ${failed.length} kontrol başarısız:`);
    for (const c of failed) console.error(`  - ${c.name}: ${c.detail}`);
    process.exit(1);
  }
  console.log("PHASE17 VERIFY: ALL PASS");
}

try {
  main();
} catch (e) {
  console.error("PHASE17 VERIFY FAIL:", messageOf(e));
  process.exit(1);
}
