// P24B v2.3 — concurrent whole-database freeze, negative control.
//
// v2.2 introduced a whole-database binding and then locked eight tables. The binding's promise was
// about all 86: "nothing in this database has moved since the backup." Between measuring that
// fingerprint and committing, another session could still write to any of the other 78 tables, so
// the promise was not defended by the freeze that was supposed to defend it.
//
// The static control (p24b-wholedb-control.ts) proves the COMPARISON works — it mutates before the
// cleanup starts. This one proves the FREEZE works: it mutates while the cleanup's locks are held.
//
// As always the negative case alone would not be evidence. If session B were blocked for some
// unrelated reason, a "blocked" result would look like success. So the same write is attempted a
// second time with no locks held, and it must succeed.
//
// Writes only to a disposable database.
//
// Usage: MIGRATION_DATABASE_URL=<disposable> node --import tsx scripts/qa/p24b-concurrent-wholedb-control.ts [out.json]
import { writeFileSync } from "node:fs";
import { Pool, type PoolClient } from "pg";
import { ownerDatabaseUrl, isDisposableDatabaseName, databaseNameFromUrl } from "../db/owner-url";
import { wholeDbFingerprintDigest } from "../db/p24b-cleanup-fingerprint";

/** Mirrors the cleanup's own lock construction, including the quoting and the ordering. */
function q(ident: string): string { return `"${ident.replace(/"/g, '""')}"`; }

async function baseTables(c: PoolClient): Promise<Array<{ schema: string; name: string }>> {
  return (await c.query<{ schema: string; name: string }>(
    `select table_schema as schema, table_name as name
       from information_schema.tables
      where table_type = 'BASE TABLE' and table_schema = any($1::text[])
      order by table_schema, table_name`, [["public", "auth"]])).rows;
}

async function main(): Promise<void> {
  const url = ownerDatabaseUrl();
  if (!url) { console.error("MIGRATION_DATABASE_URL gerekli"); process.exit(1); }
  const db = databaseNameFromUrl(url);
  if (!db || !isDisposableDatabaseName(db)) {
    console.error(`GÜVENLİK DURDURMASI: bu kontrol yazma dener; '${db}' harcanabilir değil.`);
    process.exit(9);
  }

  const pool = new Pool({ connectionString: url, max: 5 });
  const out: Record<string, unknown> = { database: db, generatedAtUtc: new Date().toISOString() };

  // A NON-target table with rows — the whole point is that the freeze covers more than the six
  // tables the cleanup deletes from.
  const probe = await pool.query<{ id: string }>(`select id::text from public.sessions order by id limit 1`);
  if (probe.rowCount === 0) { console.error("public.sessions boş — kontrol çalıştırılamaz"); process.exit(1); }
  const victimId = probe.rows[0].id;
  out.nonTargetTable = "public.sessions";
  out.victimId = victimId;

  async function attemptNonTargetWrite(): Promise<{ blocked: boolean; code: string | null; message: string }> {
    const b = await pool.connect();
    try {
      await b.query("begin");
      await b.query("set local lock_timeout = '1s'");
      await b.query(`update public.sessions set last_seen_at = now() where id = $1::uuid`, [victimId]);
      await b.query("rollback");
      return { blocked: false, code: null, message: "UPDATE geçti" };
    } catch (e) {
      await b.query("rollback").catch(() => {});
      const err = e as { code?: string; message: string };
      return { blocked: true, code: err.code ?? null, message: err.message.split("\n")[0] };
    } finally { b.release(); }
  }

  /* ── Case 1: the cleanup's full freeze is held ──────────────────────────────────────────── */
  const a = await pool.connect();
  let withLock: { blocked: boolean; code: string | null; message: string };
  let before: string; let after: string; let lockedCount = 0; let baseCount = 0;
  try {
    await a.query("begin");
    await a.query("set local lock_timeout = '10s'");
    const tables = await baseTables(a);
    baseCount = tables.length;
    await a.query(`lock table ${tables.map((t) => `${q(t.schema)}.${q(t.name)}`).join(", ")} in share row exclusive mode`);
    lockedCount = tables.length;
    before = await wholeDbFingerprintDigest(a);
    withLock = await attemptNonTargetWrite();
    after = await wholeDbFingerprintDigest(a);
  } finally {
    await a.query("rollback").catch(() => {});
    a.release();
  }
  out.baseTableCount = baseCount;
  out.lockedTableCount = lockedCount;
  out.withLockHeld = withLock;
  out.wholeDbFingerprintUnchangedUnderLock = before === after;

  /* ── Case 2: nothing held. The same write must succeed. ─────────────────────────────────── */
  const withoutLock = await attemptNonTargetWrite();
  out.withoutLock = withoutLock;

  const pass = withLock.blocked && withLock.code === "55P03"
    && !withoutLock.blocked
    && before === after
    && lockedCount === baseCount && baseCount > 0;
  out.verdict = pass ? "PASS" : "FAIL";
  out.reasoning = pass
    ? `Tüm ${baseCount} base table kilitliyken HEDEF DIŞI bir tabloya yazma lock_timeout (55P03) ile reddedildi ve tüm-DB parmak izi değişmedi; aynı yazma kilit yokken geçti. Dondurma, binding'in kapsadığı her tabloyu gerçekten koruyor.`
    : "Beklenen davranış gözlenmedi.";

  console.log(`  base table            : ${baseCount}  · kilitlenen: ${lockedCount}`);
  console.log(`  kilit tutulurken yazma: blocked=${withLock.blocked} code=${withLock.code ?? "-"}`);
  console.log(`  kilit yokken yazma    : blocked=${withoutLock.blocked}`);
  console.log(`  parmak izi değişmedi  : ${before === after}`);
  console.log(`CONCURRENT_WHOLE_DB_BINDING = ${out.verdict}`);

  if (process.argv[2]) { writeFileSync(process.argv[2], JSON.stringify(out, null, 2) + "\n", "utf8"); console.log(`artifact: ${process.argv[2]}`); }
  await pool.end();
  if (!pass) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
