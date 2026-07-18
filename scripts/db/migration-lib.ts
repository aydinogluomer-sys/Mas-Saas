// Shared primitives for the migration ledger runner (scripts/db/migrate.ts),
// its disposable-DB test suite (scripts/db/migrate-verify.ts), and the one-time
// legacy baseline manifest. No DB connection here — pure filesystem/string logic.
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

export const MIGRATIONS_DIR = path.join(process.cwd(), "supabase", "migrations");
const FILENAME_RE = /^(\d{4})_[a-z0-9_]+\.sql$/;

export interface MigrationFile {
  version: string;
  name: string;
  path: string;
  content: string;
}

/** BOM-strip + CRLF/CR→LF, so Windows/Linux checkouts of the same file checksum identically. */
export function normalizeForChecksum(raw: string): string {
  let s = raw;
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  return s.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function checksumContent(raw: string): string {
  return createHash("sha256").update(normalizeForChecksum(raw), "utf8").digest("hex");
}

/** Blanks out line comments, block comments, string literals, and dollar-quoted bodies
 * (e.g. `language plpgsql as $$ begin ... end $$`) so the transaction-control scan below
 * doesn't false-positive on a PL/pgSQL function's own BEGIN/END keywords. Each removed
 * span is replaced by a single newline so surrounding lines never get merged. */
function stripSqlNoise(sql: string): string {
  let result = "";
  let i = 0;
  const n = sql.length;
  while (i < n) {
    if (sql[i] === "-" && sql[i + 1] === "-") {
      while (i < n && sql[i] !== "\n") i++;
      continue;
    }
    if (sql[i] === "/" && sql[i + 1] === "*") {
      i += 2;
      while (i < n && !(sql[i] === "*" && sql[i + 1] === "/")) i++;
      i = Math.min(i + 2, n);
      result += "\n";
      continue;
    }
    if (sql[i] === "$") {
      const m = /^\$([a-zA-Z_][a-zA-Z0-9_]*)?\$/.exec(sql.slice(i));
      if (m) {
        const tag = m[0];
        const end = sql.indexOf(tag, i + tag.length);
        if (end !== -1) {
          i = end + tag.length;
          result += "\n";
          continue;
        }
      }
    }
    if (sql[i] === "'") {
      let j = i + 1;
      while (j < n) {
        if (sql[j] === "'" && sql[j + 1] === "'") {
          j += 2;
          continue;
        }
        if (sql[j] === "'") {
          j++;
          break;
        }
        j++;
      }
      i = j;
      result += "\n";
      continue;
    }
    result += sql[i];
    i++;
  }
  return result;
}

const FORBIDDEN_STATEMENT_RE = /^[ \t]*(BEGIN|COMMIT|ROLLBACK|START\s+TRANSACTION)\b/im;
const CONCURRENTLY_RE = /CREATE\s+INDEX\s+CONCURRENTLY/i;

export interface FileSetValidationResult {
  ok: boolean;
  errors: string[];
  files: MigrationFile[];
}

/** Pre-flight, read-only, DB-untouched validation of supabase/migrations/*.sql:
 * filename pattern, duplicate/gapped versions, forbidden transaction-control statements,
 * and CREATE INDEX CONCURRENTLY (unsupported inside this runner's transactions). */
export function validateFileSet(dir: string = MIGRATIONS_DIR): FileSetValidationResult {
  const errors: string[] = [];
  const entries = readdirSync(dir).filter((f) => f.endsWith(".sql"));
  const byVersion = new Map<string, string[]>();

  for (const entry of entries) {
    if (!FILENAME_RE.test(entry)) {
      errors.push(`Geçersiz dosya adı: ${entry} (beklenen desen: ^\\d{4}_[a-z0-9_]+\\.sql$)`);
      continue;
    }
    const version = entry.slice(0, 4);
    const list = byVersion.get(version) ?? [];
    list.push(entry);
    byVersion.set(version, list);
  }

  for (const [version, names] of byVersion) {
    if (names.length > 1) {
      errors.push(`Versiyon çakışması: ${version} için birden fazla dosya var: ${names.join(", ")}`);
    }
  }

  const versions = [...byVersion.keys()].sort();
  for (let i = 0; i < versions.length; i++) {
    const expected = String(i + 1).padStart(4, "0");
    if (versions[i] !== expected) {
      errors.push(`Versiyon sırasında boşluk: ${expected} bekleniyordu, ${versions[i]} bulundu.`);
      break;
    }
  }

  const files: MigrationFile[] = [];
  for (const version of versions) {
    const names = byVersion.get(version)!;
    if (names.length !== 1) continue;
    const name = names[0];
    const filePath = path.join(dir, name);
    const content = readFileSync(filePath, "utf8");
    const stripped = stripSqlNoise(content);
    if (FORBIDDEN_STATEMENT_RE.test(stripped)) {
      errors.push(
        `${name}: satır başında BEGIN/COMMIT/ROLLBACK/START TRANSACTION içeriyor — runner kendi transaction'ını yönetir, çakışma riski.`,
      );
    }
    if (CONCURRENTLY_RE.test(stripped)) {
      errors.push(
        `${name}: CREATE INDEX CONCURRENTLY içeriyor — bu runner transaction-içi çalışır, CONCURRENTLY desteklenmiyor.`,
      );
    }
    files.push({ version, name, path: filePath, content });
  }

  return { ok: errors.length === 0, errors, files };
}

export interface LedgerRow {
  version: string;
  name: string;
  checksum: string;
}

export interface WellFormedResult {
  ok: boolean;
  reasons: string[];
}

/** A ledger is well-formed only if: 0020 is present; every on-disk 0001..0019 file is
 * also in the ledger (0020 is never inserted without its 0001-0019 siblings — see the
 * atomic bootstrap transactions in migrate.ts); no version gap between 0020 and the
 * highest applied version; and every row's recorded name matches the file currently on
 * disk for that version. Any violation routes the caller to INCONSISTENT_PARTIAL instead
 * of treating a malformed/partial ledger as healthy steady-state. */
export function isLedgerWellFormed(rows: LedgerRow[], diskFiles: MigrationFile[]): WellFormedResult {
  const reasons: string[] = [];
  const ledgerVersions = new Set(rows.map((r) => r.version));

  if (!ledgerVersions.has("0020")) {
    reasons.push("0020 ledger'da bulunmuyor.");
    return { ok: false, reasons };
  }

  for (const f of diskFiles) {
    if (f.version < "0020" && !ledgerVersions.has(f.version)) {
      reasons.push(`Diskte olan ${f.version} (${f.name}) ledger'da yok.`);
    }
  }

  const maxApplied = rows.map((r) => r.version).sort().at(-1) ?? "0000";
  for (const f of diskFiles) {
    if (f.version > "0020" && f.version <= maxApplied && !ledgerVersions.has(f.version)) {
      reasons.push(`${f.version} (${f.name}), en yüksek uygulanan versiyon ${maxApplied}'ın altında ama ledger'da yok — gap.`);
    }
  }

  const diskByVersion = new Map(diskFiles.map((f) => [f.version, f]));
  for (const row of rows) {
    const disk = diskByVersion.get(row.version);
    if (disk && disk.name !== row.name) {
      reasons.push(`${row.version}: ledger adı '${row.name}', disk adı '${disk.name}' — uyuşmuyor.`);
    }
  }

  return { ok: reasons.length === 0, reasons };
}

export interface LegacyBaselineEntry {
  version: string;
  name: string;
  checksum: string;
}

/** Verifies every on-disk 0001..0019 file's checksum against the committed
 * legacy-baseline-0019.json manifest. Pure comparison, no DB access. */
export function verifyLegacyBaseline(
  manifest: LegacyBaselineEntry[],
  diskFiles: MigrationFile[],
): { ok: boolean; mismatches: string[] } {
  const mismatches: string[] = [];
  const byVersion = new Map(diskFiles.map((f) => [f.version, f]));
  for (const entry of manifest) {
    const disk = byVersion.get(entry.version);
    if (!disk) {
      mismatches.push(`${entry.version}: manifest'te var ama diskte yok (${entry.name}).`);
      continue;
    }
    if (disk.name !== entry.name) {
      mismatches.push(`${entry.version}: dosya adı uyuşmuyor — manifest '${entry.name}', disk '${disk.name}'.`);
    }
    const diskChecksum = checksumContent(disk.content);
    if (diskChecksum !== entry.checksum) {
      mismatches.push(
        `${entry.version} (${disk.name}): checksum uyuşmuyor — manifest ${entry.checksum}, disk ${diskChecksum}.`,
      );
    }
  }
  return { ok: mismatches.length === 0, mismatches };
}
