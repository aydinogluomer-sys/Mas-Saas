// Faz 24B gate — proves the five-tier role matrix is enforced by PostgreSQL, not just believed
// by the application.
//
// A NEW script rather than an extension of db:roles:verify, per the plan. That one asks "is the
// runtime connected as a low-privilege role at all" (Faz 15). This one asks "given that it is,
// can each tier do exactly what the matrix says and nothing more".
//
// HOW IT CONNECTS, AND WHY THAT IS THE WHOLE POINT
//
//   MIGRATION_DATABASE_URL  owner. Builds fixtures only. Superusers bypass RLS entirely, so
//                           nothing is ever *judged* on this connection — using it to test a
//                           policy would pass no matter how broken the policy was. That is the
//                           Faz 15 lesson, and it is the reason this file has two pools.
//   DATABASE_URL            the real `mas_radar_app` credential the Next.js runtime uses. Every
//                           assertion below is made here, after SET ROLE into a tier — the same
//                           mechanism @/lib/db uses in production.
//
// LESSONS APPLIED FROM FAZ 20/22/23 (built in from the first line, not retrofitted)
//   1. Structural targeting: policies are matched by the roles in pg_policies.roles, never by a
//      name pattern, and cardinality is asserted.
//   2. No vacuous pass. This one bit hard here: a DENIED select and an EMPTY table look
//      identical, and a denied UPDATE/DELETE is not an error at all — PostgreSQL simply reports
//      zero rows affected. So reads are judged against an owner-visible count, and writes are
//      judged by AFFECTED ROW COUNT on a row this script created, never by catching an
//      exception that would never have been raised.
//   3. Values, not positions, and ties tested positively.
//
// THE GENERIC INSERT PROBE
//   `insert into <t> default values` is refused with SQLSTATE 42501 when RLS denies the command,
//   and with an ordinary data error (23502 not-null, 23503 FK, ...) when RLS ALLOWS it and the
//   empty row is simply invalid. Measured on this cluster before being relied on: RLS is
//   evaluated before NOT NULL. That distinction gives a real INSERT verdict for all 61 tables
//   without inventing valid fixture data for each, and without ever writing a row.
//
// Usage:
//   MIGRATION_DATABASE_URL=... DATABASE_URL=<mas_radar_app> pnpm db:roles-rls:verify
import { Pool, type PoolClient } from "pg";
import {
  APP_ROLES, CLASS_MATRIX, DB_ROLE, OWNER_SCOPED_TABLES, TABLE_CLASS,
  can, type AppRole,
} from "../../src/lib/authz/matrix";
import { formatTargetIdentity } from "./env-source";
import { databaseNameFromUrl, isDisposableDatabaseName, DISPOSABLE_MARKERS } from "./owner-url";

const ownerUrl = process.env.MIGRATION_DATABASE_URL;
const appUrl = process.env.DATABASE_URL;
if (!ownerUrl) throw new Error("MIGRATION_DATABASE_URL gerekli (fixture kurulumu için).");
if (!appUrl) throw new Error("DATABASE_URL gerekli (mas_radar_app kimliğiyle test için).");

/**
 * HARCANABİLİR HEDEF KAPISI — bu kapı iki kez GERÇEK VERİYE fixture yazdıktan sonra eklendi.
 *
 * NE OLDU. Bu script bir doğrulama kapısı gibi görünür ama `ensureFixtures()` içinde BEŞ
 * tabloya gerçek satır YAZAR: payments, settings, users, action_items, approvals. Hedefi
 * yalnızca `MIGRATION_DATABASE_URL` / `DATABASE_URL` belirliyordu ve HİÇBİR koruma yoktu —
 * yani env ne gösteriyorsa oraya yazıyordu. Ölçülen sonuç:
 *
 *   2026-08-25 10:09–10:10 UTC  → mas_radar_dev'e fixture yazıldı (P0-DRIFT-01)
 *   2026-08-26 15:16:19 UTC     → AYNI ŞEY TEKRAR OLDU
 *
 * İkinci koşu birincinin kanıt paketi hazırlanırken gerçekleşti. Kullanıcı adlarındaki
 * rastgele son ek (`p24b_op_${Math.random()...}`) yüzünden her koşu YENİ satırlar birakir,
 * yani kirlilik birikir: users 4 → 6, action_items 1 → 4.
 *
 * Bir doğrulama kapısının gerçek finansal veriye yazabilmesi, kapının kendisini bir risk
 * kaynağına çevirir. Hedef artık ADIYLA harcanabilir olduğunu söylemek zorunda.
 *
 * CI ETKİSİ YOK: CI hedefi `mas_radar_roles_verify` zaten `verify` işaretini taşır.
 */
{
  const ownerDb = databaseNameFromUrl(ownerUrl);
  const appDb = databaseNameFromUrl(appUrl);
  for (const [label, name] of [["MIGRATION_DATABASE_URL", ownerDb], ["DATABASE_URL", appDb]] as const) {
    if (!isDisposableDatabaseName(name)) {
      const shown = name ?? "(bağlantı dizesinden veritabanı adı okunamadı)";
      throw new Error(
        `GÜVENLİK DURDURMASI (db:roles-rls:verify): ${label} → '${shown}'.\n` +
          "Bu script ensureFixtures() ile payments/settings/users/action_items/approvals " +
          "tablolarına GERÇEK SATIR YAZAR; hedefin adıyla harcanabilir olduğunu söylemesi " +
          `gerekir (${DISPOSABLE_MARKERS.join(", ")}).\n` +
          "Bu kapı, 2026-08-25 ve 2026-08-26'da mas_radar_dev'e iki kez fixture yazıldıktan " +
          "sonra eklendi — kapının kendisi kirlilik kaynağıydı.",
      );
    }
  }
  if (ownerDb !== appDb) {
    throw new Error(
      `GÜVENLİK DURDURMASI: MIGRATION_DATABASE_URL ('${ownerDb}') ve DATABASE_URL ('${appDb}') ` +
        "FARKLI veritabanlarını gösteriyor. Fixture bir yere yazılıp doğrulama başka yerde " +
        "koşarsa sonuç anlamsızdır — ve yazılan yer gerçek DB olabilir.",
    );
  }
}

const owner = new Pool({ connectionString: ownerUrl });
const app = new Pool({ connectionString: appUrl });

interface Check { name: string; pass: boolean; detail: string }
const checks: Check[] = [];
function record(name: string, pass: boolean, detail: string): void {
  checks.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name} — ${detail}`);
}
const messageOf = (e: unknown) => (e instanceof Error ? e.message : String(e));
const sqlstate = (e: unknown) =>
  typeof e === "object" && e !== null && "code" in e ? String((e as { code: unknown }).code) : "";

const TIERS = APP_ROLES;

/** Run fn on an app connection switched into `tier`, always rolled back. */
async function asTier<T>(tier: AppRole, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await app.connect();
  try {
    await client.query("begin");
    await client.query(`set role ${DB_ROLE[tier]}`);
    return await fn(client);
  } finally {
    await client.query("rollback").catch(() => {});
    await client.query("reset role").catch(() => {});
    client.release();
  }
}

/** Run fn on an app connection that has NOT switched — the login path's identity. */
async function asAppRole<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await app.connect();
  try {
    await client.query("begin");
    return await fn(client);
  } finally {
    await client.query("rollback").catch(() => {});
    client.release();
  }
}

async function asOwner<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query("begin");
    return await fn(client);
  } finally {
    await client.query("rollback").catch(() => {});
    client.release();
  }
}

/** true when RLS refused the INSERT; false when it allowed it (whatever the data did after). */
async function insertRefused(c: PoolClient, table: string): Promise<boolean> {
  await c.query("savepoint p");
  try {
    await c.query(`insert into public.${table} default values`);
    await c.query("rollback to savepoint p");
    return false; // it went through — RLS allowed it
  } catch (e) {
    await c.query("rollback to savepoint p");
    return sqlstate(e) === "42501";
  }
}


/**
 * Fixtures this gate creates for itself, committed so the tier connections (separate sessions)
 * can see them.
 *
 * Written after the first run failed: it leaned on seeded data, `payments` happened to be empty,
 * and four checks reported "denied" when the truth was "nothing to deny". A read test whose
 * subject may not exist is not a test — it is the vacuous pass rule from Faz 20/23, and it
 * caught me in the very gate written to honour it.
 */
async function ensureFixtures(): Promise<void> {
  await owner.query(
    `insert into public.payments(name, recurrence_type, due_day, default_amount, currency)
     select 'P24B fixture', 'monthly', 15, 1000, 'TRY'
     where not exists (select 1 from public.payments where name = 'P24B fixture')`);
  // Faz 33: settings was NOT fixtured, and on a freshly migrated + seed:demo'd database it is
  // EMPTY — so `update public.settings` affected 0 rows for admin too, and the check that only
  // admin may change settings failed while enforcing nothing. Exactly the vacuous-pass rule this
  // file's own header cites, in the one subject that had no fixture.
  await owner.query(
    `insert into public.settings(key, value, description)
     select 'p24b_fixture_setting', '{"fixture": true}'::jsonb, 'roles-rls gate fixture'
     where not exists (select 1 from public.settings where key = 'p24b_fixture_setting')`);
  // At least two users, so "a tier sees exactly one row" is a restriction rather than a tautology.
  for (const tag of ['a', 'b']) {
    await owner.query(
      `insert into public.users(username, password_hash, display_name, role)
       select $1, 'x', $2, 'viewer'
       where not exists (select 1 from public.users where username = $1)`,
      [`p24b_fixture_${tag}`, `P24B fixture ${tag}`]);
  }
}

/**
 * AŞAMA 20 / P2 — kapının ilk satırı: HANGİ veritabanı, HANGİ kimlik.
 *
 * Bu kapının iki bağlantısı var ve yargılar YALNIZ app bağlantısında veriliyor; satır bu
 * yüzden app hedefini önde, owner hedefini parantezde gösterir. İkisi FARKLI veritabanlarını
 * gösteriyorsa sonuç anlamsızdır — ve bu, çıktıya bakan biri için ancak yazılıysa görünür.
 * Ölçülür (`current_database()`), bağlantı dizesinden türetilmez; host/port/parola yazılmaz.
 */
async function logTargetIdentity(): Promise<void> {
  const read = async (p: Pool): Promise<{ db?: string; usr?: string }> => {
    try {
      const r = await p.query<{ db: string; usr: string }>(
        "select current_database() as db, current_user as usr",
      );
      return { db: r.rows[0]?.db, usr: r.rows[0]?.usr };
    } catch {
      return {};
    }
  };
  const [appId, ownerId] = await Promise.all([read(app), read(owner)]);
  console.log(
    `${formatTargetIdentity(appId.db, appId.usr)} (owner bağlantısı: ` +
      `db=${ownerId.db ?? "(bilinmiyor)"} user=${ownerId.usr ?? "(bilinmiyor)"})\n`,
  );
}

async function main(): Promise<void> {
  await logTargetIdentity();
  await ensureFixtures();

  /* ── A. structure ───────────────────────────────────────────────────────────────────── */
  const liveTables: string[] = (await owner.query(
    `select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace
     where n.nspname='public' and c.relkind='r' order by c.relname`)).rows.map((r) => r.relname);

  const unclassified = liveTables.filter((t) => TABLE_CLASS[t] === undefined);
  record("her canlı tablo kod matrisinde sınıflandırılmış",
    unclassified.length === 0,
    unclassified.length === 0 ? `${liveTables.length} tablo` : `sınıfsız: ${unclassified.join(", ")}`);

  const phantom = Object.keys(TABLE_CLASS).filter((t) => !liveTables.includes(t));
  record("kod matrisinde var olmayan tablo yok",
    phantom.length === 0, phantom.length === 0 ? "matris şemayla birebir" : `hayalet: ${phantom.join(", ")}`);

  const blanket = Number((await owner.query(
    `select count(*)::int n from pg_policies where schemaname='public' and policyname like '%\\_authenticated\\_all'`)).rows[0].n);
  record("hiçbir blanket 'authenticated_all' politikası kalmadı", blanket === 0, `${blanket} adet`);

  // Structural, by target roles — not by policy name.
  const tierRoleSet = TIERS.map((t) => DB_ROLE[t]).sort().join(",");
  const selectPolicies = (await owner.query(
    `select tablename, policyname, roles::text[] as roles from pg_policies
     where schemaname='public' and cmd='SELECT'`)).rows as { tablename: string; roles: string[] }[];
  const fullReadTables = new Set(
    selectPolicies.filter((p) => [...p.roles].sort().join(",") === tierRoleSet).map((p) => p.tablename));
  const missingRead = liveTables.filter(
    (t) => t !== "schema_migrations" && t !== "users" && t !== "sessions" && !fullReadTables.has(t));
  record("her tablo tam beş katmanı hedefleyen bir SELECT politikası taşıyor",
    missingRead.length === 0,
    missingRead.length === 0 ? `${fullReadTables.size} tablo` : `eksik: ${missingRead.join(", ")}`);

  const roleAttrs = (await owner.query(
    `select rolname, rolcanlogin, rolsuper, rolbypassrls from pg_roles
     where rolname = any($1::text[]) order by rolname`, [TIERS.map((t) => DB_ROLE[t])])).rows;
  record("beş katman rolü var; hiçbiri login/superuser/bypassrls değil",
    roleAttrs.length === 5 && roleAttrs.every((r) => !r.rolcanlogin && !r.rolsuper && !r.rolbypassrls),
    roleAttrs.map((r) => r.rolname).join(", ") || "yok");

  // The PG16 grant that makes the whole design safe: SET may, INHERIT may not.
  const memberships = (await owner.query(
    `select m.rolname as tier, am.set_option, am.inherit_option
     from pg_auth_members am
     join pg_roles r on r.oid = am.member
     join pg_roles m on m.oid = am.roleid
     where r.rolname = 'mas_radar_app' and m.rolname = any($1::text[])`,
    [TIERS.map((t) => DB_ROLE[t])])).rows;
  record("mas_radar_app beş katmana SET edebilir ama HİÇBİRİNİ devralmıyor (inherit=false)",
    memberships.length === 5 && memberships.every((m) => m.set_option === true && m.inherit_option === false),
    memberships.length === 5
      ? "set=true inherit=false (5/5)"
      : memberships.map((m) => `${m.tier}:set=${m.set_option}/inh=${m.inherit_option}`).join(" "));

  // Faz 15's auth pattern must be untouched.
  const authPolicies = (await owner.query(
    `select tablename||'.'||policyname as p, roles::text[] as roles from pg_policies
     where schemaname='public' and policyname in
       ('users_deny_all','sessions_deny_all','users_app_runtime','sessions_app_runtime')
     order by 1`)).rows as { p: string; roles: string[] }[];
  record("Faz 15'in users/sessions deseni (deny_all + app_runtime) AYNEN duruyor",
    authPolicies.length === 4
      && authPolicies.filter((r) => r.p.endsWith("app_runtime")).every((r) => r.roles.join() === "mas_radar_app")
      && authPolicies.filter((r) => r.p.endsWith("deny_all")).every((r) => r.roles.join() === "authenticated"),
    authPolicies.map((r) => r.p).join(", ") || "BOZULDU");

  const ledgerPolicies = Number((await owner.query(
    `select count(*)::int n from pg_policies where schemaname='public' and tablename='schema_migrations'`)).rows[0].n);
  record("schema_migrations hâlâ politikasız (yalnız owner)", ledgerPolicies === 0, `${ledgerPolicies} politika`);

  /* ── B. the INSERT matrix, every tier × every table ─────────────────────────────────── */
  const insertMismatches: string[] = [];
  let insertChecked = 0;
  for (const tier of TIERS) {
    await asTier(tier, async (c) => {
      for (const table of liveTables) {
        const expectedAllowed = can(tier, table, "insert");
        const refused = await insertRefused(c, table);
        insertChecked += 1;
        if (refused === expectedAllowed) {
          insertMismatches.push(`${tier}/${table}: beklenen=${expectedAllowed ? "izin" : "ret"} gerçek=${refused ? "ret" : "izin"}`);
        }
      }
    });
  }
  record(`INSERT matrisi: ${insertChecked} (katman × tablo) kombinasyonunun tamamı koda uyuyor`,
    insertMismatches.length === 0,
    insertMismatches.length === 0
      ? `${TIERS.length} katman × ${liveTables.length} tablo`
      : insertMismatches.slice(0, 6).join(" | "));

  /* ── C. reads: denied and empty are not the same thing ──────────────────────────────── */
  // A fixture row the owner creates, so "0 rows" can only mean refused.
  const ownerPaymentCount = Number((await owner.query(`select count(*)::int n from public.payments`)).rows[0].n);
  record("okuma testleri boşlukta değil: payments'ta owner'ın gördüğü satır var",
    ownerPaymentCount > 0, `${ownerPaymentCount} satır`);

  const tierReads: string[] = [];
  for (const tier of TIERS) {
    const n = await asTier(tier, async (c) =>
      Number((await c.query(`select count(*)::int n from public.payments`)).rows[0].n));
    if (n !== ownerPaymentCount) tierReads.push(`${tier}:${n}`);
  }
  record("POZİTİF KONTROL: beş katmanın hepsi payments'ı okuyabiliyor",
    tierReads.length === 0, tierReads.length === 0 ? `hepsi ${ownerPaymentCount} satır görüyor` : tierReads.join(" "));

  const unswitched = await asAppRole(async (c) =>
    Number((await c.query(`select count(*)::int n from public.payments`)).rows[0].n));
  record("KATMANA GEÇMEMİŞ mas_radar_app iş tablosunu OKUYAMIYOR",
    unswitched === 0, `${unswitched} satır (owner ${ownerPaymentCount} görüyor)`);

  const unswitchedUsers = await asAppRole(async (c) =>
    Number((await c.query(`select count(*)::int n from public.users`)).rows[0].n));
  record("POZİTİF KONTROL: katmana geçmemiş bağlantı users'ı OKUYABİLİYOR (giriş akışı sağlam)",
    unswitchedUsers > 0, `${unswitchedUsers} kullanıcı — login/session sorgusu çalışır`);

  // schema_migrations is GRANT-denied, so this one really is an error.
  const ledgerDenied: string[] = [];
  for (const tier of TIERS) {
    const denied = await asTier(tier, async (c) => {
      try { await c.query(`select count(*) from public.schema_migrations`); return false; }
      catch { return true; }
    });
    if (!denied) ledgerDenied.push(tier);
  }
  record("hiçbir katman migration ledger'ını okuyamıyor",
    ledgerDenied.length === 0, ledgerDenied.length === 0 ? "5/5 reddedildi" : `okuyabilen: ${ledgerDenied.join(", ")}`);

  /* ── D. UPDATE / DELETE judged by AFFECTED ROWS, not by exceptions ──────────────────── */
  // The trap this avoids: with no matching policy PostgreSQL does not raise on UPDATE/DELETE,
  // it reports zero rows. A gate that awaited an exception would pass while enforcing nothing.
  // `archived_at is null` scoping added in Faz 33, when running the full chain against a freshly
  // migrated + seed:demo'd database reproduced a failure that has nothing to do with RLS:
  // seed:demo archives one payment, and 0026's archived-immutability trigger rejects ANY update
  // touching it — including this no-op, and including one made by the owner. The blanket UPDATE
  // was therefore testing two invariants at once and reporting the wrong one.
  //
  // What this check exists to measure is whether a TIER may update payments, judged by affected
  // rows. Scoping to live rows measures exactly that; the archive invariant has its own coverage
  // in db:constraints:verify and db:transitions:verify.
  const updateResults: string[] = [];
  for (const tier of TIERS) {
    const affected = await asTier(tier, async (c) =>
      (await c.query(
        `update public.payments set source_notes = source_notes where archived_at is null`)).rowCount ?? 0);
    const expected = can(tier, "payments", "update");
    const observed = affected > 0;
    if (observed !== expected) updateResults.push(`${tier}: beklenen=${expected} gerçek=${observed} (${affected} satır)`);
  }
  record("payments UPDATE'i ETKİLENEN SATIR SAYISIYLA doğrulandı (istisna beklenerek değil)",
    updateResults.length === 0,
    updateResults.length === 0 ? "operator/manager/admin yazabiliyor; viewer/approver 0 satır" : updateResults.join(" | "));

  const deleteResults: string[] = [];
  for (const tier of TIERS) {
    const affected = await asTier(tier, async (c) =>
      // Scoped for the same reason as the UPDATE above: an archived payment is protected by a
      // different invariant, and this check is about tier permissions. (Every statement here is
      // rolled back by asTier, so nothing is actually deleted either way.)
      (await c.query(`delete from public.payments where archived_at is null`)).rowCount ?? 0);
    const expected = can(tier, "payments", "delete");
    const observed = affected > 0;
    if (observed !== expected) deleteResults.push(`${tier}: beklenen=${expected} gerçek=${observed}`);
  }
  record("payments DELETE'i yalnız manager/admin için etkili",
    deleteResults.length === 0,
    deleteResults.length === 0 ? "operator dahil kimse silemiyor, manager/admin silebiliyor" : deleteResults.join(" | "));

  const settingsResults: string[] = [];
  for (const tier of TIERS) {
    const affected = await asTier(tier, async (c) =>
      (await c.query(`update public.settings set value = value`)).rowCount ?? 0);
    const expected = can(tier, "settings", "update");
    if ((affected > 0) !== expected) settingsResults.push(`${tier}:${affected}`);
  }
  record("settings'i yalnız admin değiştirebiliyor (kritik ödeme eşiği burada)",
    settingsResults.length === 0, settingsResults.length === 0 ? "4 katman 0 satır, admin > 0" : settingsResults.join(" "));

  const auditResults: string[] = [];
  for (const tier of TIERS) {
    const affected = await asTier(tier, async (c) =>
      (await c.query(`update public.audit_logs set action = action`)).rowCount ?? 0);
    if (affected > 0) auditResults.push(`${tier}:${affected}`);
  }
  record("denetim izini HİÇBİR katman güncelleyemiyor (admin dahil)",
    auditResults.length === 0, auditResults.length === 0 ? "5/5 sıfır satır" : auditResults.join(" "));

  /* ── E. row level, where the data supports it ───────────────────────────────────────── */
  // approvals: an approver may not decide a request they made. Built from scratch here.
  const rowLevel = await asOwner(async (oc) => {
    const maker = (await oc.query(
      `insert into public.users(username,password_hash,display_name,role)
       values ($1,'x','P24B maker','finance_approver') returning id`,
      [`p24b_mk_${Math.random().toString(36).slice(2, 8)}`])).rows[0].id;
    const own = (await oc.query(
      `insert into public.approvals(subject_table,subject_id,request_kind,status,requested_by)
       values ('invoices',gen_random_uuid(),'other','pending',$1) returning id`, [maker])).rows[0].id;
    const other = (await oc.query(
      `insert into public.approvals(subject_table,subject_id,request_kind,status,requested_by)
       values ('invoices',gen_random_uuid(),'other','pending',null) returning id`)).rows[0].id;
    await oc.query("commit");
    return { maker, own, other };
  });

  const ownAffected = await asTier("finance_approver", async (c) => {
    await c.query(`select set_config('app.user_id',$1,true)`, [rowLevel.maker]);
    return (await c.query(`update public.approvals set decision_note='x' where id=$1`, [rowLevel.own])).rowCount ?? 0;
  });
  record("SATIR SEVİYESİ: onaylayıcı KENDİ talebini güncelleyemiyor (maker-checker, RLS katmanında)",
    ownAffected === 0, `${ownAffected} satır etkilendi`);

  const otherAffected = await asTier("finance_approver", async (c) => {
    await c.query(`select set_config('app.user_id',$1,true)`, [rowLevel.maker]);
    return (await c.query(`update public.approvals set decision_note='x' where id=$1`, [rowLevel.other])).rowCount ?? 0;
  });
  record("POZİTİF KONTROL: aynı onaylayıcı BAŞKASININ talebini güncelleyebiliyor",
    otherAffected === 1, `${otherAffected} satır etkilendi`);

  // users_self_read — a tier sees its own row, not the table.
  const selfRead = await asTier("finance_approver", async (c) => {
    await c.query(`select set_config('app.user_id',$1,true)`, [rowLevel.maker]);
    return Number((await c.query(`select count(*)::int n from public.users`)).rows[0].n);
  });
  const totalUsers = Number((await owner.query(`select count(*)::int n from public.users`)).rows[0].n);
  record("SATIR SEVİYESİ: katman users'tan yalnız KENDİ satırını görüyor",
    selfRead === 1 && totalUsers > 1, `katman ${selfRead} / toplam ${totalUsers}`);

  // operator owner-scoping on the tables that actually carry created_by.
  const ownedProbe = await asOwner(async (oc) => {
    const u = (await oc.query(
      `insert into public.users(username,password_hash,display_name,role)
       values ($1,'x','P24B op','finance_operator') returning id`,
      [`p24b_op_${Math.random().toString(36).slice(2, 8)}`])).rows[0].id;
    const mine = (await oc.query(
      `insert into public.action_items(title, status, created_by) values ('P24B mine','open',$1) returning id`, [u])).rows[0].id;
    const theirs = (await oc.query(
      `insert into public.action_items(title, status, created_by) values ('P24B theirs','open',null) returning id`)).rows[0].id;
    await oc.query("commit");
    return { u, mine, theirs };
  });

  const mineAffected = await asTier("finance_operator", async (c) => {
    await c.query(`select set_config('app.user_id',$1,true)`, [ownedProbe.u]);
    return (await c.query(`update public.action_items set title='P24B edited' where id=$1`, [ownedProbe.mine])).rowCount ?? 0;
  });
  const theirsAffected = await asTier("finance_operator", async (c) => {
    await c.query(`select set_config('app.user_id',$1,true)`, [ownedProbe.u]);
    return (await c.query(`update public.action_items set title='P24B edited' where id=$1`, [ownedProbe.theirs])).rowCount ?? 0;
  });
  record("SATIR SEVİYESİ: operatör KENDİ girdiği action_item'ı güncelleyebiliyor",
    mineAffected === 1, `${mineAffected} satır`);
  record("SATIR SEVİYESİ: operatör BAŞKASININ action_item'ını güncelleyemiyor",
    theirsAffected === 0, `${theirsAffected} satır`);
  // Faz 36 fix. This asserted `OWNER_SCOPED_TABLES.length === 3` — a pinned size, which is the
  // exact brittleness class Faz 31 found in `action_items.source_type`: adding `saved_views` broke
  // a check whose NAME claims to compare code against the migration, and which was in fact
  // comparing code against a number somebody typed.
  //
  // Now it does what it says: every table the code calls owner-scoped must actually carry a policy
  // whose predicate references current_app_user() in the live database. That auto-syncs as the
  // list grows, and it fails if a table is declared owner-scoped in code while the database scopes
  // it to nobody.
  const ownerPolicyMisses: string[] = [];
  for (const table of OWNER_SCOPED_TABLES) {
    const found = await owner.query(
      `select count(*)::int n from pg_policies
        where schemaname='public' and tablename=$1
          and (coalesce(qual,'') like '%current_app_user%'
               or coalesce(with_check,'') like '%current_app_user%')`, [table]);
    if (Number(found.rows[0].n) === 0) ownerPolicyMisses.push(table);
  }
  record("owner-scoped tabloların HEPSİ veritabanında gerçekten sahiplik kapsamlı",
    OWNER_SCOPED_TABLES.length > 0 && ownerPolicyMisses.length === 0,
    ownerPolicyMisses.length === 0
      ? `${OWNER_SCOPED_TABLES.length} tablo: ${OWNER_SCOPED_TABLES.join(", ")}`
      : `politikası eksik: ${ownerPolicyMisses.join(", ")}`);

  /* ── F. the tier really is the tier ─────────────────────────────────────────────────── */
  const roleNames: string[] = [];
  for (const tier of TIERS) {
    const got = await asTier(tier, async (c) =>
      String((await c.query(`select public.current_app_role() as r`)).rows[0].r));
    if (got !== tier) roleNames.push(`${tier}->${got}`);
  }
  record("current_app_role() her katmanda doğru katmanı bildiriyor",
    roleNames.length === 0, roleNames.length === 0 ? "5/5" : roleNames.join(" "));

  const unswitchedRole = await asAppRole(async (c) =>
    String((await c.query(`select public.current_app_role() as r`)).rows[0].r));
  record("katmana geçmemiş bağlantı yanıltıcı bir katman adı döndürmüyor",
    unswitchedRole === "mas_radar_app", `current_app_role()=${unswitchedRole}`);

  /* ── G. the code matrix is internally coherent ──────────────────────────────────────── */
  const evidenceWritable = Object.entries(TABLE_CLASS)
    .filter(([, cls]) => cls === "evidence")
    .filter(([t]) => TIERS.some((r) => can(r, t, "update") || can(r, t, "delete")));
  record("kod matrisinde hiçbir katman evidence tablosunu güncelleyemiyor/silemiyor",
    evidenceWritable.length === 0, `${Object.values(TABLE_CLASS).filter((c) => c === "evidence").length} evidence tablosu`);

  const viewerWrites = Object.keys(TABLE_CLASS)
    .filter((t) => (["insert", "update", "delete"] as const).some((a) => can("viewer", t, a)));
  record("izleyici kod matrisinde hiçbir tabloya yazamıyor",
    viewerWrites.length === 0, viewerWrites.length === 0 ? "0 yazma izni" : viewerWrites.join(", "));

  record("her sınıf beş katmanın tamamı için tanımlı",
    Object.values(CLASS_MATRIX).every((m) => TIERS.every((r) => Array.isArray(m[r]))),
    `${Object.keys(CLASS_MATRIX).length} sınıf × ${TIERS.length} katman`);

  const failed = checks.filter((c) => !c.pass);
  console.log(`\n${checks.length - failed.length}/${checks.length} kontrol geçti.`);
  await owner.end(); await app.end();
  if (failed.length > 0) {
    console.error(`\nROLES-RLS VERIFY FAIL — ${failed.length} kontrol başarısız:`);
    for (const c of failed) console.error(`  - ${c.name}: ${c.detail}`);
    process.exit(1);
  }
  console.log("ROLES-RLS VERIFY: ALL PASS");
}

main().catch(async (e) => {
  console.error("ROLES-RLS VERIFY FAIL:", messageOf(e));
  await owner.end().catch(() => {}); await app.end().catch(() => {});
  process.exit(1);
});
