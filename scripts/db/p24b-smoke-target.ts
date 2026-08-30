// P24B — the restore-smoke target gate.
//
// WHAT WAS WRONG IN v2.1. The binding generator took a database name from argv[3] and fed it
// straight into destructive commands:
//
//     execFileSync("docker", ["exec", C, "dropdb", "-U", "postgres", "--if-exists", smokeDb])
//     execFileSync("docker", ["exec", "-i", C, "bash", "-c", `cat > /tmp/${smokeDb}.dump`])
//
// Two defects in three lines. First, NOTHING checked the name: passing `mas_radar_dev` would have
// dropped the real database — from the very tool whose job is to prove a backup exists. Second,
// the name was interpolated into a `bash -c` STRING, so it was not merely a wrong-target risk but
// a shell-injection one; `foo; drop database mas_radar_dev` is a valid argv entry.
//
// The lesson the rest of this incident already taught, applied here: a destructive tool must
// refuse to name its target before it can act on it. The gate below runs BEFORE the first
// subprocess, and the caller has no path to a drop that bypasses it.
import { isDisposableDatabaseName, PROTECTED_DB_NAMES } from "./owner-url";

/**
 * Deliberately narrower than PostgreSQL allows. Quoted identifiers may contain almost anything,
 * but a smoke database is created by this tool for this tool: there is no reason to accept a name
 * that needs quoting, and every reason to reject one that could be mistaken for shell syntax.
 */
export const SMOKE_DB_PATTERN = /^[a-z][a-z0-9_]{0,62}$/;

export interface SmokeTargetDecision { ok: boolean; blockers: string[] }

/**
 * Decide whether `smokeDb` may be dropped and recreated.
 *
 * Pure and side-effect free, so the negative controls can assert the DECISION without a database —
 * and so the destructive caller has exactly one place to consult.
 */
export function smokeTargetBlockers(smokeDb: string | undefined, sourceDb: string | undefined): SmokeTargetDecision {
  const blockers: string[] = [];
  if (smokeDb === undefined || smokeDb === "") {
    return { ok: false, blockers: ["restore smoke veritabanı adı verilmedi"] };
  }
  if (!SMOKE_DB_PATTERN.test(smokeDb)) {
    blockers.push(
      `'${smokeDb}' geçerli bir sade PostgreSQL tanımlayıcısı değil (${SMOKE_DB_PATTERN.source}) — ` +
        "tırnak gerektiren veya kabuk sözdizimine benzeyen adlar reddedilir",
    );
    // No further checks: an unparseable name must not reach the disposable/protected logic at all.
    return { ok: false, blockers };
  }
  if (PROTECTED_DB_NAMES.includes(smokeDb.toLowerCase())) {
    blockers.push(`'${smokeDb}' korunan bir veritabanı — restore smoke onu asla DROP etmez`);
  }
  if (smokeDb.toLowerCase() === "mas_radar_dev") {
    // Explicit, on top of the protected-list check. This is the one name whose loss ends the
    // investigation, and it should be refused by more than one rule.
    blockers.push("'mas_radar_dev' gerçek veritabanıdır — restore smoke hedefi olamaz");
  }
  if (!isDisposableDatabaseName(smokeDb)) {
    blockers.push(`'${smokeDb}' harcanabilir işaretlerinden hiçbirini taşımıyor`);
  }
  if (sourceDb !== undefined && smokeDb.toLowerCase() === sourceDb.toLowerCase()) {
    blockers.push(`restore smoke hedefi kaynak veritabanının kendisi olamaz ('${sourceDb}')`);
  }
  return { ok: blockers.length === 0, blockers };
}

/** A container-side temp path that does NOT embed the database name. */
export function smokeDumpPath(): string {
  return `/tmp/mas-p24b-smoke-${process.pid}-${Date.now()}.dump`;
}
