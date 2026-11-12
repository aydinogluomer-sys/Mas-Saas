// Faz 40 (A2) — Closed-circuit runtime & secret hygiene preflight (`scripts/check-env.ts`).
//
// Enforces:
//   1. No plaintext `.env.local.bak*` / `.env*.bak*` files sitting in the project root
//      (operators must move backups to an encrypted vault or shred them).
//   2. `DATABASE_URL` connects strictly as `mas_radar_app` (never `postgres` / owner).
//   3. No `CHANGE_ME` placeholder values remain in `DATABASE_URL`, `MIGRATION_DATABASE_URL`,
//      `MAS_RADAR_APP_DB_PASSWORD`, or `SEED_ADMIN_PASSWORD`.
//   4. `EMAIL_API_URL` (if set) uses HTTPS, is non-private/non-loopback, and matches
//      `MAS_ALLOWED_EMAIL_HOSTS` when configured.
//
// NEVER prints connection strings, passwords, or secret values.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateEmailApiUrl } from "../src/lib/env";

export interface EnvAuditIssue {
  code:
    | "PLAINTEXT_ENV_BACKUP"
    | "MISSING_DATABASE_URL"
    | "INVALID_DATABASE_URL"
    | "WRONG_RUNTIME_DB_USER"
    | "PLACEHOLDER_SECRET"
    | "INVALID_EMAIL_API_URL";
  message: string;
}

export interface EnvAuditWarning {
  code: "LOCAL_PASSWORDLESS_ACTIVE";
  message: string;
}

export interface EnvAuditResult {
  ok: boolean;
  issues: EnvAuditIssue[];
  warnings: EnvAuditWarning[];
  backupFiles: string[];
}

export function parseDotEnvText(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

export function findPlaintextEnvBackups(rootDir: string): string[] {
  if (!existsSync(rootDir)) return [];
  return readdirSync(rootDir)
    .filter((name) => /^\.env(\..+)?\.bak/i.test(name))
    .sort();
}

function containsPlaceholder(value: string | undefined): boolean {
  if (!value) return false;
  return /CHANGE_ME|<REPLACE_WITH/i.test(value);
}

export function auditEnvironment(options: {
  rootDir?: string;
  envVars?: Record<string, string | undefined>;
} = {}): EnvAuditResult {
  const rootDir = options.rootDir ?? process.cwd();
  const issues: EnvAuditIssue[] = [];
  const warnings: EnvAuditWarning[] = [];

  const backupFiles = findPlaintextEnvBackups(rootDir);
  if (backupFiles.length > 0) {
    issues.push({
      code: "PLAINTEXT_ENV_BACKUP",
      message:
        `Kök dizinde düz metin ortam yedeği bulundu (${backupFiles.join(", ")}). ` +
        `Başlamadan önce yedeği şifreli kasaya taşıyın veya güvenli biçimde kaldırın.`,
    });
  }

  let vars: Record<string, string | undefined>;
  if (options.envVars) {
    vars = options.envVars;
  } else {
    const envLocalPath = path.join(rootDir, ".env.local");
    const fileVars = existsSync(envLocalPath) ? parseDotEnvText(readFileSync(envLocalPath, "utf8")) : {};
    vars = { ...fileVars, ...process.env };
  }

  const dbUrlRaw = vars.DATABASE_URL?.trim();
  if (!dbUrlRaw) {
    issues.push({
      code: "MISSING_DATABASE_URL",
      message: "DATABASE_URL tanımlı değil.",
    });
  } else {
    let parsedDb: URL | null = null;
    try {
      parsedDb = new URL(dbUrlRaw);
    } catch {
      issues.push({
        code: "INVALID_DATABASE_URL",
        message: "DATABASE_URL geçerli bir PostgreSQL bağlantı adresi değil.",
      });
    }
    if (parsedDb) {
      const username = decodeURIComponent(parsedDb.username || "");
      if (username !== "mas_radar_app") {
        issues.push({
          code: "WRONG_RUNTIME_DB_USER",
          message: `DATABASE_URL kullanıcı adı 'mas_radar_app' olmalı (mevcut rol: '${username || "(boş)"}').`,
        });
      }
      if (containsPlaceholder(decodeURIComponent(parsedDb.password || ""))) {
        issues.push({
          code: "PLACEHOLDER_SECRET",
          message: "DATABASE_URL parolasında örnek 'CHANGE_ME' yer tutucusu bırakılmış.",
        });
      }
    }
  }

  for (const key of ["MIGRATION_DATABASE_URL", "MAS_RADAR_APP_DB_PASSWORD", "SEED_ADMIN_PASSWORD"] as const) {
    if (containsPlaceholder(vars[key])) {
      issues.push({
        code: "PLACEHOLDER_SECRET",
        message: `${key} değişkeninde örnek 'CHANGE_ME' yer tutucusu bırakılmış.`,
      });
    }
  }

  const emailErr = validateEmailApiUrl(
    vars.EMAIL_API_URL?.trim() || undefined,
    vars.MAS_ALLOWED_EMAIL_HOSTS?.trim() || undefined,
  );
  if (emailErr) {
    issues.push({
      code: "INVALID_EMAIL_API_URL",
      message: emailErr,
    });
  }

  if (vars.MAS_LOCAL_PASSWORDLESS?.trim() === "1") {
    warnings.push({
      code: "LOCAL_PASSWORDLESS_ACTIVE",
      message:
        "MAS_LOCAL_PASSWORDLESS=1 etkin (loopback parolasız yerel geliştirme modu açık). " +
        "Canlı / çok kullanıcılı geçişten (cutover) önce bu değişkeni kaldırın veya 0 yapın.",
    });
  }

  return {
    ok: issues.length === 0,
    issues,
    warnings,
    backupFiles,
  };
}

const isMain =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMain) {
  const result = auditEnvironment();
  for (const warning of result.warnings) {
    console.warn(`CHECK-ENV WARN [${warning.code}]: ${warning.message}`);
  }
  if (!result.ok) {
    console.error(`CHECK-ENV RED (${result.issues.length} güvenlik bulgusu):`);
    for (const issue of result.issues) {
      console.error(`  - [${issue.code}] ${issue.message}`);
    }
    process.exit(1);
  }
  console.log("CHECK-ENV: OK (mas_radar_app, düz metin .env.local.bak* yok, yer tutucu sır yok)");
}

