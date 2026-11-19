// Faz 62 — Runtime ↔ Schema Migration Ledger Parity Gate.
//
// Reads the expected migration manifest from `supabase/migrations/*.sql` on disk (with optional
// container/standalone fallback env vars `APP_EXPECTED_MIGRATION_COUNT` and
// `APP_EXPECTED_LATEST_MIGRATION`) and compares it against `public.get_schema_ledger_summary()`
// (`SECURITY DEFINER`, granted to `mas_radar_app` and all five application tiers in 0122).
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import type { Pool } from "pg";
import { getRawPool } from "@/lib/db";

export interface ExpectedSchemaManifest {
  expectedCount: number;
  expectedLatestVersion: string;
}

export interface SchemaParityResult {
  aligned: boolean;
  expectedCount: number;
  expectedLatestVersion: string;
  actualCount: number | null;
  actualLatestVersion: string | null;
  checksumDigest: string | null;
  lastAppliedAt: string | null;
  error: string | null;
}

type QueryablePool = Pick<Pool, "query">;

export function readExpectedSchemaManifest(cwd?: string): ExpectedSchemaManifest {
  const baseCwd = cwd ?? process.cwd();
  const candidateRoots =
    cwd !== undefined
      ? [baseCwd]
      : [
          ...(process.env.MAS_PROJECT_ROOT?.trim() ? [process.env.MAS_PROJECT_ROOT.trim()] : []),
          baseCwd,
          path.resolve(baseCwd, ".."),
          path.resolve(baseCwd, "..", ".."),
        ];

  for (const rootDir of candidateRoots) {
    const migrationsDir = path.join(rootDir, "supabase", "migrations");
    try {
      if (existsSync(migrationsDir)) {
        const sqlFiles = readdirSync(migrationsDir)
          .filter((f) => f.endsWith(".sql"))
          .sort();
        if (sqlFiles.length > 0) {
          const versions = sqlFiles
            .map((f) => /^(\d{4})/.exec(f)?.[1] ?? f.slice(0, 4))
            .filter((v) => v.length > 0)
            .sort();
          const latest = versions[versions.length - 1] ?? "?";
          return {
            expectedCount: sqlFiles.length,
            expectedLatestVersion: latest,
          };
        }
      }
    } catch {
      // Try next candidate root or fall through to environment fallback.
    }
  }

  const envCountRaw = process.env.APP_EXPECTED_MIGRATION_COUNT?.trim();
  const envLatestRaw = process.env.APP_EXPECTED_LATEST_MIGRATION?.trim();
  const parsedCount = envCountRaw ? Number(envCountRaw) : Number.NaN;

  if (Number.isInteger(parsedCount) && parsedCount > 0 && envLatestRaw) {
    return {
      expectedCount: parsedCount,
      expectedLatestVersion: envLatestRaw,
    };
  }

  return {
    expectedCount: 0,
    expectedLatestVersion: "?",
  };
}

export async function checkSchemaParity(pool: QueryablePool = getRawPool()): Promise<SchemaParityResult> {
  const { expectedCount, expectedLatestVersion } = readExpectedSchemaManifest();

  if (expectedCount <= 0 || expectedLatestVersion === "?") {
    return {
      aligned: false,
      expectedCount,
      expectedLatestVersion,
      actualCount: null,
      actualLatestVersion: null,
      checksumDigest: null,
      lastAppliedAt: null,
      error: "Beklenen migration manifesti okunamadı (supabase/migrations veya APP_EXPECTED_MIGRATION_* eksik).",
    };
  }

  try {
    const res = await pool.query<{
      migration_count: number | string | null;
      latest_version: string | null;
      checksum_digest: string | null;
      last_applied_at: string | null;
    }>(
      `select migration_count,
              latest_version,
              checksum_digest,
              last_applied_at::text as last_applied_at
         from public.get_schema_ledger_summary()`,
    );

    const row = res.rows[0];
    const actualCount =
      typeof row?.migration_count === "number"
        ? row.migration_count
        : row?.migration_count != null
          ? Number(row.migration_count)
          : null;
    const normalizedActualCount =
      actualCount !== null && Number.isFinite(actualCount) ? actualCount : null;
    const actualLatestVersion = row?.latest_version ?? null;
    const checksumDigest = row?.checksum_digest ?? null;
    const lastAppliedAt = row?.last_applied_at ?? null;

    const aligned =
      normalizedActualCount === expectedCount &&
      actualLatestVersion === expectedLatestVersion;

    return {
      aligned,
      expectedCount,
      expectedLatestVersion,
      actualCount: normalizedActualCount,
      actualLatestVersion,
      checksumDigest,
      lastAppliedAt,
      error: null,
    };
  } catch (err) {
    return {
      aligned: false,
      expectedCount,
      expectedLatestVersion,
      actualCount: null,
      actualLatestVersion: null,
      checksumDigest: null,
      lastAppliedAt: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function assertSchemaParity(pool: QueryablePool = getRawPool()): Promise<SchemaParityResult> {
  const res = await checkSchemaParity(pool);
  if (!res.aligned) {
    const expectedLabel = `${res.expectedCount}/${res.expectedLatestVersion}`;
    const actualLabel = `${res.actualCount ?? "?"}/${res.actualLatestVersion ?? "?"}`;
    const detail = res.error ? ` Hata: ${res.error}` : "";
    throw new Error(
      `Veritabanı şema defteri uygulama sürümüyle uyuşmuyor (beklenen: ${expectedLabel}, veritabanı: ${actualLabel}).${detail} ` +
        "Uygulamayı başlatmadan önce `pnpm db:migrate` komutunu çalıştırın.",
    );
  }
  return res;
}
