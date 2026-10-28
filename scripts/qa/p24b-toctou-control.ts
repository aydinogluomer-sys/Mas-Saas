// P24B — TOCTOU negative control.
//
// v2.0 measured its preconditions, counts, money and whole-database fingerprint and THEN opened a
// transaction and took locks. Every number the commit rested on was read while other sessions were
// free to write. The defence offered was "the runtime is switched off" — an operational claim, and
// precisely the claim that failed twice in this incident.
//
// v2.1 inverts the order: BEGIN, LOCK, then measure. This script proves the lock actually does the
// work, rather than asserting it. Two real sessions against a disposable database:
//
//   A: BEGIN → LOCK … IN SHARE ROW EXCLUSIVE MODE → hold
//   B: UPDATE a target row, with a short lock_timeout
//
// B must FAIL with lock_timeout (SQLSTATE 55P03). If B succeeds, the window v2.0 left open is
// still open and the whole precondition set is worthless.
//
// It also runs the mirror case: with A holding NO lock, B succeeds — otherwise a test that
// "passes" because of some unrelated blockage would look like proof.
//
// Usage:  MIGRATION_DATABASE_URL=<disposable> node --import tsx scripts/qa/p24b-toctou-control.ts [out.json]
import { writeFileSync } from "node:fs";
import { Pool } from "pg";
import { ownerDatabaseUrl, isDisposableDatabaseName, databaseNameFromUrl } from "../db/owner-url";

const LOCK_TABLES = ["action_items", "approvals", "payment_instances", "payments", "users", "settings", "metric_snapshots", "audit_logs"];
const LOCK_SQL = `lock table ${LOCK_TABLES.map((t) => `public.${t}`).join(", ")} in share row exclusive mode`;

async function main(): Promise<void> {
  const url = ownerDatabaseUrl();
  if (!url) { console.error("MIGRATION_DATABASE_URL gerekli"); process.exit(1); }
  const name = databaseNameFromUrl(url);
  // This control WRITES. It may only ever run somewhere expendable.
  if (!isDisposableDatabaseName(name)) {
    console.error(`GÜVENLİK DURDURMASI: TOCTOU kontrolü yazma yapar; '${name}' harcanabilir değil.`);
    process.exit(9);
  }

  const pool = new Pool({ connectionString: url, max: 4 });
  const out: Record<string, unknown> = { database: name, generatedAtUtc: new Date().toISOString(), lockMode: "SHARE ROW EXCLUSIVE" };

  // A row that exists in both the contaminated and cleaned states, so the control does not depend
  // on fixture rows still being present.
  const victim = (await pool.query<{ id: string }>(`select id::text from public.payments order by id limit 1`)).rows[0];
  if (!victim) { console.error("payments boş — kontrol çalıştırılamaz"); process.exit(1); }
  out.victimPaymentId = victim.id;

  async function attemptWrite(timeoutMs: string): Promise<{ blocked: boolean; code: string | null; message: string }> {
    const b = await pool.connect();
    try {
      await b.query("begin");
      await b.query(`set local lock_timeout = '${timeoutMs}'`);
      await b.query(`update public.payments set updated_at = now() where id = $1::uuid`, [victim.id]);
      await b.query("rollback");
      return { blocked: false, code: null, message: "UPDATE geçti" };
    } catch (e) {
      await b.query("rollback").catch(() => {});
      const err = e as { code?: string; message: string };
      return { blocked: true, code: err.code ?? null, message: err.message.split("\n")[0] };
    } finally { b.release(); }
  }

  /* ── Case 1: A holds the cleanup's locks; B must be blocked ─────────────────────────────── */
  const a = await pool.connect();
  let blockedCase: { blocked: boolean; code: string | null; message: string };
  try {
    await a.query("begin");
    await a.query("set local lock_timeout = '10s'");
    await a.query(LOCK_SQL);
    blockedCase = await attemptWrite("1s");
  } finally {
    await a.query("rollback").catch(() => {});
    a.release();
  }
  out.withLockHeld = blockedCase;

  /* ── Case 2: nobody holds the locks; B must succeed ─────────────────────────────────────── */
  const freeCase = await attemptWrite("1s");
  out.withoutLock = freeCase;

  const pass = blockedCase.blocked && blockedCase.code === "55P03" && !freeCase.blocked;
  out.verdict = pass ? "PASS" : "FAIL";
  out.reasoning = pass
    ? "Kilit tutulurken eşzamanlı UPDATE lock_timeout (55P03) ile reddedildi; kilit yokken aynı UPDATE geçti. Kilidin engellediği kanıtlandı, ortam koşulu değil."
    : "Beklenen davranış gözlenmedi — kilit ya engellemiyor ya da kontrol başka bir sebeple bloke oluyor.";

  console.log(`kilit tutulurken : blocked=${blockedCase.blocked} code=${blockedCase.code ?? "-"}`);
  console.log(`kilit yokken     : blocked=${freeCase.blocked}`);
  console.log(`TOCTOU_NEGATIVE_CONTROL = ${out.verdict}`);

  if (process.argv[2]) { writeFileSync(process.argv[2], JSON.stringify(out, null, 2) + "\n", "utf8"); console.log(`artifact: ${process.argv[2]}`); }
  await pool.end();
  if (!pass) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
