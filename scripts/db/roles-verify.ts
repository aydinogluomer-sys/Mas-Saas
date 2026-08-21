// Faz 15 gate — proves the running application really is connected as the low-privilege
// role, and that the privilege split actually holds in both directions:
//   * it must NOT be able to do owner things (superuser, bypassrls, write the ledger), and
//   * it MUST still be able to do everything the app legitimately needs.
//
// Connects with DATABASE_URL — that is, with the exact credential the Next.js runtime uses
// (src/lib/env.ts), not an owner one. Read-only by construction: the single write it
// attempts is the one that is supposed to be refused, and even that runs inside a
// transaction that is always rolled back, so a broken REVOKE cannot leave a row behind.
import { Pool } from "pg";

const ROLE = "mas_radar_app";

interface Check {
  name: string;
  pass: boolean;
  detail: string;
}

const checks: Check[] = [];
function record(name: string, pass: boolean, detail: string): void {
  checks.push({ name, pass, detail });
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Postgres SQLSTATE 42501 — insufficient_privilege. Matching the code rather than the
 * message keeps this stable across locales and server versions. */
function isPermissionDenied(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: string }).code === "42501";
}

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL tanımlı değil — bu script uygulamanın gerçek runtime bağlantısını test eder.");

  const pool = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 5_000 });
  try {
    // 1 — identity
    const who = await pool.query<{ who: string }>("select current_user as who");
    const currentUser = who.rows[0]?.who ?? "(bilinmiyor)";
    record("current_user = " + ROLE, currentUser === ROLE, `current_user='${currentUser}'`);

    // 2 — the two attributes that would silently make every RLS policy decorative again
    const attrs = await pool.query<{ rolsuper: boolean; rolbypassrls: boolean }>(
      "select rolsuper, rolbypassrls from pg_roles where rolname = current_user",
    );
    const rolsuper = attrs.rows[0]?.rolsuper;
    const rolbypassrls = attrs.rows[0]?.rolbypassrls;
    record(
      "rol superuser DEĞİL ve bypassrls DEĞİL",
      rolsuper === false && rolbypassrls === false,
      `rolsuper=${rolsuper} rolbypassrls=${rolbypassrls}`,
    );

    // 3 — the migration ledger must be unreachable for writes. Wrapped in a transaction that
    // is rolled back no matter what: if the REVOKE ever regressed, this must not persist.
    const client = await pool.connect();
    let ledgerDetail: string;
    let ledgerPass: boolean;
    try {
      await client.query("begin");
      try {
        await client.query(
          "insert into public.schema_migrations (version, name, checksum) values ('9999','roles-verify-probe','0')",
        );
        ledgerPass = false;
        ledgerDetail = "INSERT KABUL EDİLDİ — revoke tutmuyor (işlem geri alındı)";
      } catch (e) {
        ledgerPass = isPermissionDenied(e);
        ledgerDetail = ledgerPass
          ? "permission denied (42501) — beklenen"
          : `beklenmedik hata: ${messageOf(e)}`;
      }
    } finally {
      await client.query("rollback").catch(() => {});
      client.release();
    }
    record("schema_migrations'a INSERT reddedilir", ledgerPass, ledgerDetail);

    // 4 — an ordinary domain table must still be readable: proves the GRANTs did not break
    // the app. `payments` is the table the whole product is built around.
    try {
      await pool.query("select 1 from public.payments limit 1");
      record("public.payments okunabilir", true, "select başarılı");
    } catch (e) {
      record("public.payments okunabilir", false, messageOf(e));
    }

    // 5 — the auth tables. This is the check that matters most in this phase: 0031 locked
    // users/sessions behind `using (false)` deny-all policies that were written while the
    // app was still superuser. If 0035's runtime-scoped policies were missing or wrong,
    // these queries return no rows / throw, and login would be impossible for everyone —
    // while every other check above still passed. Read-only: counts only.
    for (const table of ["users", "sessions"] as const) {
      try {
        await pool.query(`select count(*) from public.${table}`);
        record(`public.${table} okunabilir (login için şart)`, true, "select başarılı");
      } catch (e) {
        record(`public.${table} okunabilir (login için şart)`, false, messageOf(e));
      }
    }

    // A successful count is necessary but not sufficient: `select count(*)` returns 0 both
    // when RLS filtered every row away and when the table is genuinely empty. Any correctly
    // bootstrapped database has at least the reserved 'system' actor, so a visible row count
    // above zero is what actually distinguishes "policy lets us through" from "policy hides
    // everything". A zero here is reported as a failure with that ambiguity spelled out.
    try {
      const visible = await pool.query<{ n: string }>("select count(*)::text as n from public.users");
      const n = Number(visible.rows[0]?.n ?? "0");
      record(
        "users satırları RLS üzerinden GERÇEKTEN görünüyor",
        n > 0,
        n > 0
          ? `${n} kullanıcı satırı görülebiliyor`
          : "0 satır görülüyor — ya deny-all hâlâ engelliyor ya da DB hiç seed edilmemiş (seed-system-actor/seed-admin)",
      );
    } catch (e) {
      record("users satırları RLS üzerinden GERÇEKTEN görünüyor", false, messageOf(e));
    }

    // 6 — 0031's defense-in-depth must still be standing. 0035 adds a runtime-scoped policy
    // beside the deny-all; it must not have replaced it.
    const policies = await pool.query<{ tablename: string; policyname: string }>(
      `select tablename, policyname from pg_policies
        where schemaname = 'public' and tablename in ('users','sessions')`,
    );
    const names = new Set(policies.rows.map((r) => `${r.tablename}.${r.policyname}`));
    const expected = ["users.users_deny_all", "users.users_app_runtime", "sessions.sessions_deny_all", "sessions.sessions_app_runtime"];
    const missing = expected.filter((p) => !names.has(p));
    record(
      "users/sessions'ta hem deny_all hem app_runtime policy'si duruyor",
      missing.length === 0,
      missing.length === 0 ? expected.join(", ") : `eksik: ${missing.join(", ")}`,
    );
  } finally {
    await pool.end();
  }

  const failed = checks.filter((c) => !c.pass);
  for (const c of checks) console.log(`${c.pass ? "PASS" : "FAIL"}  ${c.name} — ${c.detail}`);
  console.log(`\n${checks.length - failed.length}/${checks.length} kontrol geçti.`);
  if (failed.length > 0) {
    console.error(`\n${failed.length} kontrol BAŞARISIZ:`);
    for (const c of failed) console.error(`  - ${c.name}: ${c.detail}`);
    process.exit(1);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
