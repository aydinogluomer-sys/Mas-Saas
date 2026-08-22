// Faz 18 verification — one audit writer, one validation boundary, one current schema doc.
//
// A source check like phase17:verify: no connection string, no data touched, safe in CI.
//
// The property being defended is narrow and worth stating precisely: `public.audit_logs` has
// been append-only since migration 0022 (BEFORE triggers refuse UPDATE/DELETE/TRUNCATE even
// for a superuser), so the trail can only ever be wrong in one direction — by a row being
// written incorrectly in the first place. Thirteen helpers with three different parameter
// orders were exactly that risk. This gate keeps the insert in one reviewed place.
//
// Usage:
//   pnpm phase18:verify
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

/** The canonical writer. Everything else must go through it. */
const AUDIT_MODULE = "src/lib/audit.ts";

/**
 * The single justified exception, outside src/.
 *
 * `scripts/db/constraints-verify.ts` inserts a row directly to PROVE migration 0022's
 * append-only triggers reject the UPDATE and DELETE that follow. Routing that probe through
 * `audit()` would test the helper instead of the constraint, which is the opposite of what
 * the check is for.
 */
const ALLOWED_DIRECT_INSERT: Record<string, { occurrences: number; reason: string }> = {
  "scripts/db/constraints-verify.ts": {
    occurrences: 1,
    reason:
      "0022 append-only trigger'ını kanıtlayan sonda: satırı bilerek doğrudan yazıp ardından " +
      "UPDATE/DELETE'in reddedildiğini gösteriyor. audit() üzerinden geçirmek constraint'i " +
      "değil yardımcıyı test etmek olurdu.",
  },
  "scripts/perf/volume.ts": {
    occurrences: 1,
    reason:
      "Faz 33: TEK KULLANIMLIK veritabanına performans ölçümü için hacim üreteci. audit_logs'a " +
      "doğrudan yazan tek yer, çünkü üretilen şey denetim OLAYI değil, denetim TABLOSUNUN " +
      "kendisinin hacmi — 40.000 satır generate_series ile toplu yazılıyor. audit() üzerinden " +
      "geçirmek, ölçülmek istenen tabloyu doldurmak için 40.000 ayrı çağrı yapmak olurdu. " +
      "mas_radar_dev'e asla çalıştırılmıyor; gate'in Usage satırı disposable URL'i adlandırıyor.",
  },
};

/** This file names the patterns it hunts for, so it never scans itself. */
const SELF = "scripts/phase18-verify.ts";

/** Tracked + untracked-but-not-ignored, with no extension filter. */
function sourceFilesRaw(prefixes: string[]): string[] {
  const run = (args: string[]) =>
    execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 })
      .split("\n")
      .map((f) => f.trim())
      .filter(Boolean);
  return [
    ...new Set([...run(["ls-files", ...prefixes]), ...run(["ls-files", "--others", "--exclude-standard", ...prefixes])]),
  ];
}

function sourceFiles(prefixes: string[]): string[] {
  const run = (args: string[]) =>
    execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 })
      .split("\n")
      .map((f) => f.trim())
      .filter(Boolean);
  const tracked = run(["ls-files", ...prefixes]);
  // Untracked-but-not-ignored too: a brand-new file is exactly when a gate must not blink.
  const untracked = run(["ls-files", "--others", "--exclude-standard", ...prefixes]);
  return [...new Set([...tracked, ...untracked])].filter((f) => /\.(ts|tsx)$/.test(f));
}

function isCommentLine(line: string): boolean {
  const t = line.trim();
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
}

interface Hit {
  file: string;
  line: number;
  text: string;
}

function findInsertSites(prefixes: string[]): Hit[] {
  const hits: Hit[] = [];
  for (const file of sourceFiles(prefixes)) {
    if (file === SELF) continue;
    let content: string;
    try {
      content = readFileSync(path.join(ROOT, file), "utf8");
    } catch {
      continue;
    }
    if (!/insert\s+into\s+(public\.)?audit_logs/i.test(content)) continue;
    content.split("\n").forEach((text, i) => {
      if (isCommentLine(text)) return;
      if (/insert\s+into\s+(public\.)?audit_logs/i.test(text)) {
        hits.push({ file, line: i + 1, text: text.trim().slice(0, 90) });
      }
    });
  }
  return hits;
}

function main(): void {
  // ── 1) the whole point: only audit.ts writes the trail ─────────────────────────────────
  const appHits = findInsertSites(["src"]);
  const offending = appHits.filter((h) => h.file !== AUDIT_MODULE);
  record(
    "src/ içinde audit.ts DIŞINDA hiç `insert into public.audit_logs` yok",
    offending.length === 0,
    offending.length === 0
      ? `denetim yazımı tek noktada (${AUDIT_MODULE})`
      : offending.map((h) => `${h.file}:${h.line} ${h.text}`).join(" | "),
  );

  record(
    "audit.ts gerçekten insert ediyor (kontrol boş bir dosyayla kandırılamaz)",
    appHits.some((h) => h.file === AUDIT_MODULE),
    `${AUDIT_MODULE} içinde ${appHits.filter((h) => h.file === AUDIT_MODULE).length} insert`,
  );

  // ── 2) scripts/: only the documented constraint probe ──────────────────────────────────
  const scriptHits = findInsertSites(["scripts"]);
  const scriptOffenders = scriptHits.filter((h) => !(h.file in ALLOWED_DIRECT_INSERT));
  record(
    "scripts/ içinde yalnız gerekçeli istisna doğrudan yazıyor",
    scriptOffenders.length === 0,
    scriptOffenders.length === 0
      ? Object.entries(ALLOWED_DIRECT_INSERT)
          .map(([f, a]) => `${f} (${a.occurrences})`)
          .join(", ")
      : scriptOffenders.map((h) => `${h.file}:${h.line}`).join(" | "),
  );

  for (const [file, allowance] of Object.entries(ALLOWED_DIRECT_INSERT)) {
    const found = scriptHits.filter((h) => h.file === file).length;
    record(
      `izin listesi: ${file}`,
      found === allowance.occurrences,
      found === allowance.occurrences
        ? `${found} adet — ${allowance.reason}`
        : `beklenen ${allowance.occurrences}, bulunan ${found} — izin listesi güncellenmeli`,
    );
  }

  // ── 3) no module may grow its own audit() helper again ─────────────────────────────────
  const localHelpers: string[] = [];
  for (const file of sourceFiles(["src"])) {
    if (file === AUDIT_MODULE || file === SELF) continue;
    let content: string;
    try {
      content = readFileSync(path.join(ROOT, file), "utf8");
    } catch {
      continue;
    }
    content.split("\n").forEach((text, i) => {
      if (isCommentLine(text)) return;
      if (/(async\s+function\s+audit\s*\(|const\s+audit\s*=)/.test(text)) {
        localHelpers.push(`${file}:${i + 1}`);
      }
    });
  }
  record(
    "hiçbir modül kendi audit() kopyasını yeniden tanımlamıyor",
    localHelpers.length === 0,
    localHelpers.length === 0 ? "13 kopyanın tamamı kaldırıldı" : localHelpers.join(", "),
  );

  // ── 4) the shared modules exist and export what callers rely on ────────────────────────
  const readOr = (rel: string): string => {
    try {
      return readFileSync(path.join(ROOT, rel), "utf8");
    } catch {
      return "";
    }
  };
  const auditSrc = readOr(AUDIT_MODULE);
  record(
    "src/lib/audit.ts tek kanonik audit() dışa aktarıyor",
    /export\s+async\s+function\s+audit\s*\(/.test(auditSrc) && /AuditEntry/.test(auditSrc),
    auditSrc ? `${auditSrc.split("\n").length} satır` : "dosya okunamadı",
  );

  // A named-field object is what makes the old before/after order bug unrepresentable —
  // reverting to positional parameters would be a silent regression.
  record(
    "audit() konumsal değil, adlandırılmış alanlı bir nesne alıyor",
    /entry:\s*AuditEntry/.test(auditSrc),
    "audit(client, { actor, action, entityTable, entityId, before, after, createdAt })",
  );

  const validationSrc = readOr("src/lib/validation/index.ts");
  record(
    "src/lib/validation/index.ts parseOrThrow sınırını sağlıyor",
    /export\s+function\s+parseOrThrow/.test(validationSrc) && /DomainError/.test(validationSrc),
    validationSrc ? `${validationSrc.split("\n").length} satır` : "dosya okunamadı",
  );

  // ── 5) raw ZodError.message must not reach a user-facing error ─────────────────────────
  // Zod v4 renders ZodError.message as a JSON dump of the issue array, and api-response.ts
  // passes a DomainError's message straight to the client. formatIssues exists for this.
  const zodLeaks: string[] = [];
  for (const file of sourceFiles(["src"])) {
    if (file === SELF) continue;
    let content: string;
    try {
      content = readFileSync(path.join(ROOT, file), "utf8");
    } catch {
      continue;
    }
    content.split("\n").forEach((text, i) => {
      if (isCommentLine(text)) return;
      if (/\berror\.message\b/.test(text) && /(parsed|result|parse)/i.test(text)) {
        zodLeaks.push(`${file}:${i + 1}`);
      }
    });
  }
  record(
    "ham ZodError.message kullanıcıya açılan bir hataya gömülmüyor",
    zodLeaks.length === 0,
    zodLeaks.length === 0 ? "formatIssues kullanılıyor" : zodLeaks.join(", "),
  );

  // ── 6) the schema document is current ──────────────────────────────────────────────────
  // docs/database-schema.md fell ~14 migrations behind before this phase. Pinning it to the
  // highest migration on disk is what stops that from happening again quietly.
  // Faz 19 caught a blind spot here: this used tracked files only, so on the day migrations
  // 0036-0039 were written (still untracked) the check computed `latest` as 0035 and happily
  // passed while the document said nothing about the four new ones. sourceFiles() already
  // includes untracked-but-not-ignored files, which is exactly what a gate needs.
  const migrations = sourceFilesRaw(["supabase/migrations"])
    .map((f) => f.trim())
    .filter((f) => f.endsWith(".sql"))
    .map((f) => path.basename(f).slice(0, 4))
    .filter((v) => /^\d{4}$/.test(v))
    .sort();
  const latest = migrations[migrations.length - 1] ?? "";
  const schemaDoc = readOr("docs/database-schema.md");
  record(
    `docs/database-schema.md en son migration'ı (${latest}) kapsıyor`,
    latest !== "" && schemaDoc.includes(latest),
    latest === "" ? "migration bulunamadı" : `${migrations.length} migration, en son ${latest}`,
  );

  // Every migration from 0022 on is what Faz 18 was asked to catch up on; spot-check that
  // none of them is missing from the document.
  const missing = migrations.filter((v) => v >= "0022" && !schemaDoc.includes(v));
  record(
    "0022–" + latest + " arası her migration şema belgesinde anılıyor",
    missing.length === 0,
    missing.length === 0 ? "hepsi kayıtlı" : `eksik: ${missing.join(", ")}`,
  );

  // ── 7) the unit tests actually run ─────────────────────────────────────────────────────
  try {
    execFileSync(
      "pnpm",
      ["exec", "vitest", "run", "src/lib/audit.test.ts", "src/lib/validation/validation.test.ts"],
      { cwd: ROOT, stdio: "pipe", shell: process.platform === "win32" },
    );
    record("audit + validation birim testleri geçiyor", true, "vitest exit 0");
  } catch (e) {
    record("audit + validation birim testleri geçiyor", false, messageOf(e).slice(0, 300));
  }

  const failed = checks.filter((c) => !c.pass);
  console.log(`\n${checks.length - failed.length}/${checks.length} kontrol geçti.`);
  if (failed.length > 0) {
    console.error(`\nPHASE18 VERIFY FAIL — ${failed.length} kontrol başarısız:`);
    for (const c of failed) console.error(`  - ${c.name}: ${c.detail}`);
    process.exit(1);
  }
  console.log("PHASE18 VERIFY: ALL PASS");
}

try {
  main();
} catch (e) {
  console.error("PHASE18 VERIFY FAIL:", messageOf(e));
  process.exit(1);
}
