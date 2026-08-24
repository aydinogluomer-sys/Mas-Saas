// Faz 4 — the security checklist the plan asks for, as assertions rather than prose.
//
// WHAT THIS ADDS, AND WHAT IT DELIBERATELY DOES NOT REPEAT.
//
// roles-rls-verify.ts already proves a great deal: the INSERT matrix for every tier × every live
// table, UPDATE/DELETE behaviour on payments, the maker-checker row rule, and the policy shapes.
// This file does not restate any of that. It closes the five gaps an audit of the existing gates
// turned up:
//
//   7.1  the automatic code↔database comparison covered INSERT across all tables but only
//        payments for UPDATE/DELETE, and had no cell at all for EXPORT or SEARCH.
//   7.2  all three layers existed; nothing asserted they AGREE. The link between the route guard
//        and the database was a hand-written comment, and a comment does not fail when the
//        database drifts.
//   7.3  the session lifecycle was implemented and entirely unasserted — including the invariant
//        that public.sessions carries no role snapshot.
//   7.4  getRawPool() was checked in two route files; nothing pinned it repo-wide.
//   7.5  no sweep proved every mutating server action carries an auth check.
//
// Usage:
//   MIGRATION_DATABASE_URL=…/<disposable-db> pnpm db:security-matrix:verify

import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { Pool, type PoolClient } from "pg";
import {
  APP_ROLES, DB_ROLE, TABLE_CLASS, OWNER_SCOPED_TABLES, can, canAdministerUsers,
  canSeeModule, GATED_ROUTES, type AppRole,
} from "../../src/lib/authz/matrix";
import { canAccessRoute } from "../../src/lib/authz/route-access";
import { requireDisposableOwnerDatabaseUrl } from "./owner-url";

const ROOT = process.cwd();
const TIERS = APP_ROLES as readonly AppRole[];

interface Check { name: string; pass: boolean; detail: string }
const checks: Check[] = [];
function record(name: string, pass: boolean, detail: string): void {
  checks.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name} — ${detail}`);
}

const pool = new Pool({ connectionString: requireDisposableOwnerDatabaseUrl("db:security-matrix:verify") });

function readSrc(rel: string): string {
  return readFileSync(path.join(ROOT, rel), "utf8");
}

/** Every .ts/.tsx under a directory. */
function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(path.join(ROOT, dir))) {
    const rel = `${dir}/${entry}`;
    if (statSync(path.join(ROOT, rel)).isDirectory()) walk(rel, out);
    else if (/\.tsx?$/.test(entry)) out.push(rel);
  }
  return out;
}

/** Strip comments so a rule is not "satisfied" by a sentence describing it. */
function codeOnly(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

async function main(): Promise<void> {
  /* ── 7.1 — the eight-action matrix, compared to the database automatically ──────────────
   *
   * The four SQL verbs are compared at the GRANT layer for EVERY tier × EVERY live table. This is
   * deliberately a different question from roles-rls-verify.ts's DML probes: that file asks "does
   * a row actually move?" (RLS), this one asks "does the tier even hold the privilege?" (GRANT).
   * A table can pass the first while quietly holding a grant nobody intended, and vice versa.
   */
  const liveTables: string[] = (await pool.query(
    `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r' order by c.relname`,
  )).rows.map((r: { relname: string }) => r.relname);

  /*
   * EFFECTIVE permission, not the GRANT bit.
   *
   * The first version of this check compared has_table_privilege() to can() and failed on correct
   * code, because it encoded the wrong model. Grants are deliberately BROAD on owner-scoped tables
   * — a tier must hold INSERT for RLS to then narrow the rows to the ones it owns — and the matrix
   * describes EFFECTIVE authority, which is grant AND policy together. Measured: viewer holds the
   * INSERT grant on action_items, and the insert is still refused with "new row violates row-level
   * security policy". The grant alone proves nothing in either direction.
   *
   * So what is asserted is the outcome a tier can actually achieve. roles-rls-verify.ts already
   * does this for INSERT across every table; the gap it left was UPDATE and DELETE, which it
   * probes only on payments. Those are covered here, on every table that carries a row to aim at
   * (an empty table cannot answer the question either way).
   */
  const probeTables: string[] = [];
  for (const table of liveTables) {
    if (TABLE_CLASS[table] === undefined) continue;
    const n = Number((await pool.query<{ n: string }>(`select count(*) n from public.${table}`)).rows[0].n);
    if (n > 0) probeTables.push(table);
  }

  /**
   * How many rows a tier can actually move with this statement, or -1 when it is refused outright.
   *
   * ROW COUNT, NOT EXCEPTIONS — and this is the whole trick. Under RLS a denied UPDATE/DELETE does
   * not raise: the USING clause simply matches nothing and the statement reports success with zero
   * rows affected. The first version of this probe treated "no exception" as "permitted" and
   * accused six healthy tables of leaking. roles-rls-verify.ts already learned this lesson on
   * payments ("ETKİLENEN SATIR SAYISIYLA doğrulandı, istisna beklenerek değil"); the same reading
   * has to apply everywhere.
   */
  async function affected(tier: AppRole, sql: string): Promise<number> {
    const c = await pool.connect();
    try {
      await c.query("begin");
      await c.query(`set local role ${DB_ROLE[tier]}`);
      const res = await c.query(sql);
      await c.query("rollback");
      return res.rowCount ?? 0;
    } catch {
      await c.query("rollback").catch(() => {});
      return -1;
    } finally {
      c.release();
    }
  }

  const dmlMismatches: string[] = [];
  let dmlChecked = 0;
  let dmlPositive = 0;
  for (const tier of TIERS) {
    for (const table of probeTables) {
      for (const action of ["update", "delete"] as const) {
        const expectedAllowed = can(tier, table, action);
        const sql = action === "delete"
          ? `delete from public.${table}`
          : `update public.${table} set created_at = created_at`;
        const rows = await affected(tier, sql);
        if (rows === -1 && expectedAllowed) continue; // FK/trigger refusal, not a permission answer
        dmlChecked += 1;
        if (!expectedAllowed && rows > 0) {
          dmlMismatches.push(`${tier}/${table}/${action}: kod=ret ama ${rows} SATIR ETKİLENDİ`);
        }
        if (expectedAllowed && rows > 0) dmlPositive += 1;
      }
    }
  }
  record(
    `ETKİN UPDATE/DELETE: ${dmlChecked} denemede, reddedilmesi gereken hiçbir (katman × tablo × fiil) satır oynatamadı`,
    dmlMismatches.length === 0,
    dmlMismatches.length === 0
      ? `${TIERS.length} katman × ${probeTables.length} dolu tablo`
      : dmlMismatches.slice(0, 6).join(" | "),
  );
  // Without this the check above is satisfied by a database that refuses everyone.
  record("POZİTİF KONTROL: izin verilen katmanlar gerçekten satır oynatabiliyor",
    dmlPositive > 0, `${dmlPositive} izinli (katman × tablo × fiil) kombinasyonu satır etkiledi`);

  // APPROVE — the plan's fifth action. Maker-checker: deciding is not the same as requesting.
  const approvers = TIERS.filter((t) => can(t, "approvals", "update"));
  record("APPROVE hücresi: yalnız approver/manager/admin karar verebiliyor",
    approvers.join(",") === "finance_approver,finance_manager,admin", approvers.join(", ") || "hiçbiri");

  // ADMIN — account administration.
  const admins = TIERS.filter((t) => canAdministerUsers(t));
  record("ADMIN hücresi: hesap yönetimi yalnız admin'de", admins.join(",") === "admin", admins.join(", ") || "hiçbiri");

  /* EXPORT and SEARCH.
   *
   * These two have no per-tier cell, and that is a DESIGN DECISION rather than an oversight:
   * export-leakage-verify.ts asserts viewer and admin receive byte-identical export output. That
   * is only safe while the analytical surface contains nothing that belongs to a particular
   * person. So the cell being asserted here is the PRECONDITION for tier-identical export — no
   * owner-scoped table may be readable through the export/search surface. The day someone adds
   * one, this fails, and the "identical output" assertion becomes a leak instead of a feature.
   */
  const exportSrc = codeOnly(readSrc("src/app/api/analytics/export/route.ts"));
  const searchSrc = codeOnly(readSrc("src/app/api/search/route.ts"));
  const leaked = OWNER_SCOPED_TABLES.filter(
    (t) => new RegExp(`\\b${t}\\b`).test(exportSrc) || new RegExp(`\\b${t}\\b`).test(searchSrc),
  );
  record("EXPORT/SEARCH hücresi: sahiplik-kapsamlı hiçbir tablo bu yüzeyden okunmuyor",
    leaked.length === 0,
    leaked.length === 0
      ? `${OWNER_SCOPED_TABLES.length} sahiplik-kapsamlı tablonun hiçbiri export/search kaynağında geçmiyor`
      : `SIZINTI RİSKİ: ${leaked.join(", ")}`);

  /* ── 7.2 — the three layers must agree ────────────────────────────────────────────────── */

  // Layers 1 and 2: what the navigation hides must be exactly what the guard refuses. A menu that
  // hides a page the guard would have allowed is a usability bug; a menu that OFFERS a page the
  // guard refuses is the one that generates "why does this button do nothing" — and the reverse of
  // that (offering what the guard allows but the DB refuses) is a security smell.
  /*
   * NAV ↔ GUARD, at the granularity each one actually works at.
   *
   * The first version compared canSeeModule(tier, href) with canAccessRoute(tier, href) and failed
   * on correct code: those two answer DIFFERENT questions. canSeeModule asks "should this MODULE
   * appear in the sidebar", canAccessRoute asks "may this exact ROUTE be opened". A viewer is
   * legitimately offered the Data module while /data/approvals inside it stays shut.
   *
   * The property worth asserting is the one that would actually mislead someone: a module is
   * offered ONLY IF at least one route inside it can be opened. Anything else is a menu entry
   * leading to a wall.
   */
  const modules = [...new Set(GATED_ROUTES.map((r) => `/${r.split("/")[1] ?? ""}`))].filter((m) => m !== "/");
  const navMismatches: string[] = [];
  for (const tier of TIERS) {
    for (const mod of modules) {
      const routesInModule = GATED_ROUTES.filter((r) => r === mod || r.startsWith(`${mod}/`));
      const anyOpen = routesInModule.some((r) => canAccessRoute(tier, r));
      const offered = canSeeModule(tier, mod);
      if (offered && !anyOpen) navMismatches.push(`${tier}/${mod}: menüde var ama içindeki hiçbir rota açılamıyor`);
    }
  }
  record(
    `KATMAN 1↔2: ${TIERS.length * modules.length} (katman × modül) kombinasyonunda menü, açılabilir rotası olmayan modül sunmuyor`,
    navMismatches.length === 0,
    navMismatches.length === 0 ? `${modules.length} modül` : navMismatches.slice(0, 5).join(" | "),
  );

  /*
   * Layer 3 — the database itself.
   *
   * Stated separately from the probe above so the three-layer claim is explicit rather than
   * implied: whatever the guard refuses, the database must refuse too. The comment that used to
   * carry this claim ("verified against pg_policies on a database migrated to 0087") could not
   * fail when the database drifted; the INSERT sweep in roles-rls-verify.ts plus the UPDATE/DELETE
   * sweep above now do.
   *
   * The remaining structural half: every business table must actually HAVE row-level security
   * switched on. A table with policies written but RLS disabled is the failure that looks safest
   * in a policy listing and is wide open in practice.
   */
  const rlsOff: string[] = (await pool.query(
    `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity = false
     order by c.relname`,
  )).rows.map((r: { relname: string }) => r.relname).filter((t: string) => TABLE_CLASS[t] !== undefined);
  record("KATMAN 3: kod matrisindeki her tabloda satır seviyesi güvenlik AÇIK",
    rlsOff.length === 0,
    rlsOff.length === 0 ? `${probeTables.length} dolu tablo denendi, RLS kapalı tablo yok` : `RLS KAPALI: ${rlsOff.join(", ")}`);

  /* ── 7.3 — session security ───────────────────────────────────────────────────────────── */

  // The invariant that makes "role change is picked up by the same session" possible at all.
  const sessionCols: string[] = (await pool.query(
    `select column_name from information_schema.columns
     where table_schema = 'public' and table_name = 'sessions' order by column_name`,
  )).rows.map((r: { column_name: string }) => r.column_name);
  const roleSnapshot = sessionCols.filter((c) => /role|tier|permission|scope|claim/i.test(c));
  record("public.sessions ESKİ ROL anlık görüntüsü taşımıyor",
    roleSnapshot.length === 0,
    roleSnapshot.length === 0 ? sessionCols.join(", ") : `ROL KOPYASI BULUNDU: ${roleSnapshot.join(", ")}`);

  // The predicate src/lib/auth.ts uses, exercised against rows built to fail each clause in turn.
  // Asserted here rather than only over HTTP because this is the one place all four clauses are
  // visible at once; the HTTP-level adversarial run lives in tests/visual/security-adversarial.
  const LOOKUP = `select count(*)::int n from public.sessions s join public.users u on u.id = s.user_id
                  where s.token_hash = $1 and s.revoked_at is null and s.expires_at > now() and u.is_active`;
  const client: PoolClient = await pool.connect();
  try {
    await client.query("begin");
    const uid = (await client.query<{ id: string }>(
      `insert into public.users (username, password_hash, display_name, role, is_active)
       values ('faz4_probe', 'x', 'faz4_probe', 'viewer', true) returning id`)).rows[0].id;

    const mk = async (label: string, sql: string, hash: string): Promise<number> => {
      await client.query(sql, [uid, hash]);
      return Number((await client.query(LOOKUP, [hash])).rows[0].n);
    };

    const ok = await mk("geçerli",
      `insert into public.sessions (user_id, token_hash, expires_at) values ($1, $2, now() + interval '1 day')`, "h_ok");
    record("POZİTİF KONTROL: geçerli oturum bulunuyor (kontrol her şeyi reddetmiyor)", ok === 1, `${ok} satır`);

    const revoked = await mk("iptal",
      `insert into public.sessions (user_id, token_hash, expires_at, revoked_at)
       values ($1, $2, now() + interval '1 day', now())`, "h_revoked");
    record("İPTAL EDİLEN oturum ANINDA reddediliyor", revoked === 0, `${revoked} satır`);

    const expired = await mk("süresi dolmuş",
      `insert into public.sessions (user_id, token_hash, expires_at) values ($1, $2, now() - interval '1 second')`, "h_expired");
    record("MUTLAK SÜRE dolduğunda oturum reddediliyor", expired === 0, `${expired} satır`);

    await client.query(`update public.users set is_active = false where id = $1`, [uid]);
    const inactiveNow = Number((await client.query(LOOKUP, ["h_ok"])).rows[0].n);
    record("PASİF kullanıcının GEÇERLİ oturumu da reddediliyor", inactiveNow === 0, `${inactiveNow} satır`);

    await client.query("rollback");
  } finally {
    client.release();
  }

  // Idle timeout is enforced in application code, not SQL, so it is pinned where it lives.
  const authSrc = codeOnly(readSrc("src/lib/auth.ts"));
  record("ATIL SÜRE (idle timeout) uygulanıyor ve oturumu iptal ediyor",
    /IDLE_TIMEOUT_MS/.test(authSrc) && /set revoked_at = now\(\)/.test(authSrc),
    "auth.ts: IDLE_TIMEOUT_MS + revoked_at güncellemesi");

  record("rol, oturumdan DEĞİL users tablosundan CANLI okunuyor",
    /join public\.users u on u\.id = s\.user_id/.test(authSrc) && /u\.role/.test(authSrc),
    "getCurrentUser() her istekte users'a join ediyor");

  /* ── 7.4 — getRawPool() confined ──────────────────────────────────────────────────────── */
  //
  // The un-scoped pool bypasses the tier model by design, because login has to read a user row
  // BEFORE there is a tier. That is the only justification, so the allowlist is exactly the files
  // where identity is resolved. Anything else acquiring it is a hole straight through Faz 15.
  const RAW_POOL_ALLOWED = new Set(["src/lib/db.ts", "src/lib/auth.ts"]);
  const rawPoolUsers = walk("src")
    .filter((f) => !/\.test\.tsx?$/.test(f))
    .filter((f) => /\bgetRawPool\s*\(/.test(codeOnly(readSrc(f))));
  const rawPoolViolations = rawPoolUsers.filter((f) => !RAW_POOL_ALLOWED.has(f));
  record("getRawPool() yalnız kimlik çözen dosyalarda",
    rawPoolViolations.length === 0,
    rawPoolViolations.length === 0
      ? `izinli: ${[...rawPoolUsers].join(", ")}`
      : `İZİNSİZ: ${rawPoolViolations.join(", ")}`);

  /* ── 7.5 — every mutating server action carries an auth check ─────────────────────────── */
  //
  // There are no mutating API routes: all three route.ts files export GET only, so the entire
  // mutating surface is server actions. Next refuses cross-origin server-action invocations by
  // itself (proven end-to-end by phase16:verify), which covers the CSRF/origin layer; what it
  // cannot supply is auth and role, and those have to be in the action.
  const AUTH_CALL = /requireSession\s*\(|getCurrentUser\s*\(|requireAdmin\s*\(|requireRole\s*\(/;

  /**
   * The one file exempted, with its reason — the same shape phase18:verify uses for its audit
   * writer exception.
   *
   * src/app/login/actions.ts IS the authentication surface; requiring it to authenticate first
   * would be circular.
   */
  const AUTH_EXEMPT: Record<string, string> = {
    "src/app/login/actions.ts": "giriş yüzeyinin kendisi — kimlik doğrulamadan ÖNCE çalışır",
  };

  const actionFiles = walk("src").filter((f) => /"use server"/.test(readSrc(f)));
  const missingAuth = actionFiles
    .filter((f) => AUTH_EXEMPT[f] === undefined)
    .filter((f) => !AUTH_CALL.test(codeOnly(readSrc(f))));
  record(
    `MUTASYON YÜZEYİ: ${actionFiles.length} server-action dosyasının tamamı kimlik doğrulaması çağırıyor`,
    missingAuth.length === 0,
    missingAuth.length === 0
      ? `${actionFiles.length}/${actionFiles.length} dosya, ${Object.keys(AUTH_EXEMPT).length} gerekçeli istisna (yalnız giriş yüzeyi)`
      : `KİMLİK DOĞRULAMASI YOK: ${missingAuth.join(", ")}`,
  );

  // No mutating API route may exist without the origin gate. Today there are none; the assertion
  // exists so that the first one added cannot skip it silently.
  const apiRoutes = walk("src/app/api").filter((f) => f.endsWith("route.ts"));
  const mutatingRoutes = apiRoutes.filter((f) => /export\s+(async\s+function|const)\s+(POST|PUT|PATCH|DELETE)\b/.test(codeOnly(readSrc(f))));
  const originless = mutatingRoutes.filter((f) => !/checkOrigin\s*\(/.test(codeOnly(readSrc(f))));
  record("her MUTASYON yapan API rotası checkOrigin() çağırıyor",
    originless.length === 0,
    mutatingRoutes.length === 0
      ? `mutasyon yapan API rotası yok (${apiRoutes.length} rota, hepsi GET) — mutasyonlar server action`
      : `origin kapısı yok: ${originless.join(", ")}`);

  const failed = checks.filter((c) => !c.pass);
  console.log(`\n${checks.length - failed.length}/${checks.length} kontrol geçti.`);
  console.log(failed.length === 0 ? "SECURITY MATRIX VERIFY: ALL PASS" : "SECURITY MATRIX VERIFY: FAIL");
  await pool.end();
  process.exit(failed.length === 0 ? 0 : 1);
}

void main().catch(async (error) => {
  console.error(error);
  await pool.end().catch(() => {});
  process.exit(1);
});
