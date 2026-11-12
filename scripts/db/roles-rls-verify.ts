// Faz 24B + Faz 39 (A1) gate — proves the five-tier role matrix AND view security_invoker shield
// are enforced by PostgreSQL, not just believed by the application.
//
// Usage:
//   MIGRATION_DATABASE_URL=... DATABASE_URL=<mas_radar_app> pnpm db:roles-rls:verify
import { Pool, type PoolClient } from "pg";
import { audit, type AuditEntry } from "../../src/lib/audit";
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
          `gerekir (${DISPOSABLE_MARKERS.join(", ")}).`,
      );
    }
  }
  if (ownerDb !== appDb) {
    throw new Error(
      `GÜVENLİK DURDURMASI: MIGRATION_DATABASE_URL ('${ownerDb}') ve DATABASE_URL ('${appDb}') ` +
        "FARKLI veritabanlarını gösteriyor.",
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
    return false;
  } catch (e) {
    await c.query("rollback to savepoint p");
    return sqlstate(e) === "42501";
  }
}

async function ensureFixtures(): Promise<void> {
  await owner.query(
    `insert into public.payments(name, recurrence_type, due_day, default_amount, currency)
     select 'P24B fixture', 'monthly', 15, 1000, 'TRY'
     where not exists (select 1 from public.payments where name = 'P24B fixture')`);
  await owner.query(
    `insert into public.settings(key, value, description)
     select 'p24b_fixture_setting', '{"fixture": true}'::jsonb, 'roles-rls gate fixture'
     where not exists (select 1 from public.settings where key = 'p24b_fixture_setting')`);
  for (const tag of ["a", "b"]) {
    await owner.query(
      `insert into public.users(username, password_hash, display_name, role)
       select $1, 'x', $2, 'viewer'
       where not exists (select 1 from public.users where username = $1)`,
      [`p24b_fixture_${tag}`, `P24B fixture ${tag}`]);
  }
  await owner.query(
    `insert into public.users(username, password_hash, display_name, role, is_active, must_change_password)
     select 'p24b_fixture_admin', 'x', 'P24B fixture admin', 'admin', true, false
     where not exists (select 1 from public.users where username = 'p24b_fixture_admin')`);
}

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

  const selfRead = await asTier("finance_approver", async (c) => {
    await c.query(`select set_config('app.user_id',$1,true)`, [rowLevel.maker]);
    return Number((await c.query(`select count(*)::int n from public.users`)).rows[0].n);
  });
  const totalUsers = Number((await owner.query(`select count(*)::int n from public.users`)).rows[0].n);
  record("SATIR SEVİYESİ: katman users'tan yalnız KENDİ satırını görüyor",
    selfRead === 1 && totalUsers > 1, `katman ${selfRead} / toplam ${totalUsers}`);

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

  /* ── H. Wave 0 / 0096: a user's OWN password change, for every tier ─────────────────── */
  const fixtureIds = (await owner.query<{ id: string }>(
    `select id from public.users where username in ('p24b_fixture_a', 'p24b_fixture_b') order by username`,
  )).rows.map((r) => r.id);
  const [selfId, otherId] = fixtureIds;

  const ownChangeRow = (actor: string, entityId: string, action = "change_own_password", entityTable = "users"): AuditEntry => ({
    actor, action, entityTable, entityId,
    before: { must_change_password: true },
    after: { password_changed: true, must_change_password: false, other_sessions_revoked: 0 },
  });

  async function ownChangeAs(tier: AppRole, appUserId: string | null, entry: AuditEntry): Promise<string> {
    const client = await app.connect();
    try {
      await client.query("begin");
      const updated = await client.query(
        `update public.users set must_change_password = false, failed_login_count = 0, locked_until = null
          where id = $1`, [selfId]);
      if ((updated.rowCount ?? 0) !== 1) return `users güncellemesi ${updated.rowCount ?? 0} satır`;
      await client.query(
        `update public.sessions set revoked_at = now()
          where user_id = $1 and token_hash <> $2 and revoked_at is null`, [selfId, "roles-rls-verify"]);
      if (appUserId) await client.query("select set_config('app.user_id', $1, true)", [appUserId]);
      await client.query(`set local role ${DB_ROLE[tier]}`);
      try {
        await audit(client, entry);
        return "allowed";
      } catch (e) {
        return sqlstate(e) === "42501" ? "refused" : `hata ${sqlstate(e)}: ${messageOf(e)}`;
      }
    } finally {
      await client.query("rollback").catch(() => {});
      client.release();
    }
  }

  record("0096 fixture'ı: kendi ve başka bir kullanıcı var",
    fixtureIds.length === 2, `${fixtureIds.length} fixture kullanıcısı`);

  const ownChangeResults: string[] = [];
  for (const tier of TIERS) {
    const got = await ownChangeAs(tier, selfId, ownChangeRow(selfId, selfId));
    if (got !== "allowed") ownChangeResults.push(`${tier}: ${got}`);
  }
  record("POZİTİF KONTROL: beş katmanın her biri KENDİ parola değişikliğini yazıp denetleyebiliyor",
    ownChangeResults.length === 0, ownChangeResults.length === 0 ? "5/5 izin" : ownChangeResults.join(" | "));

  const viewerProbes: Array<[string, string | null, AuditEntry]> = [
    ["başka kullanıcı adına (actor)", selfId, ownChangeRow(otherId, otherId)],
    ["başka kullanıcının hesabı (entity_id)", selfId, ownChangeRow(selfId, otherId)],
    ["başka eylem", selfId, ownChangeRow(selfId, selfId, "reset_user_password")],
    ["başka tablo", selfId, ownChangeRow(selfId, selfId, "change_own_password", "payments")],
    ["app.user_id yok (makine kimliği)", null, ownChangeRow(selfId, selfId)],
  ];
  const viewerLeaks: string[] = [];
  for (const [label, appUserId, entry] of viewerProbes) {
    const got = await ownChangeAs("viewer", appUserId, entry);
    if (got !== "refused") viewerLeaks.push(`${label}: ${got}`);
  }
  record("SATIR SEVİYESİ: izleyici YALNIZ kendi change_own_password satırını yazabiliyor",
    viewerLeaks.length === 0,
    viewerLeaks.length === 0 ? `${viewerProbes.length}/${viewerProbes.length} sapma reddedildi` : viewerLeaks.join(" | "));

  const viewerWritePolicies = (await owner.query<{ p: string }>(
    `select tablename || '.' || policyname as p from pg_policies
      where schemaname = 'public' and cmd <> 'SELECT' and 'mas_radar_viewer' = any (roles::text[])
      order by 1`)).rows.map((r) => r.p);
  record("izleyicinin veritabanındaki TEK yazma politikası 0096'nınki",
    viewerWritePolicies.length === 1 && viewerWritePolicies[0] === "audit_logs.audit_logs_insert_own_password_change",
    viewerWritePolicies.join(", ") || "yok");

  /* ── I. Faz 39 (0098): View security_invoker shield, admin sessions, writeback & planning ── */
  const viewRows = (await owner.query<{ relname: string; invoker: boolean }>(
    `select c.relname,
            coalesce('security_invoker=true' = any(c.reloptions), false) as invoker
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind = 'v'
      order by c.relname`,
  )).rows;
  const unprotectedViews = viewRows.filter((v) => !v.invoker).map((v) => v.relname);
  record("0098-1: public şemasındaki TÜM görünümlerde security_invoker=true aktif (0 istisna)",
    viewRows.length >= 81 && unprotectedViews.length === 0,
    unprotectedViews.length === 0
      ? `${viewRows.length}/${viewRows.length} görünüm security_invoker=true`
      : `KORUMASIZ: ${unprotectedViews.join(", ")}`);

  // Auto-updatable single-table views must reject UPDATE and DELETE with 42501; non-updatable aggregated views
  // reject at rewrite time with 55000 AND must also carry zero INSERT/UPDATE/DELETE privileges across all 5 tiers.
  const targetViewNames = [
    "costing_invoice_facts",
    "profitability_by_department",
    "control_unmatched_bank_aged",
    "anomaly_unusual_record_hour",
  ] as const;
  const viewMeta = (await owner.query<{ table_name: string; is_updatable: string }>(
    `select table_name, is_updatable
       from information_schema.views
      where table_schema = 'public' and table_name = any($1::text[])`,
    [[...targetViewNames]],
  )).rows;
  const updatableByView = new Map(viewMeta.map((r) => [r.table_name, r.is_updatable === "YES"]));
  const writableViews = (await owner.query<{ view_name: string; role_name: string }>(
    `select v.table_name as view_name, r.rolname as role_name
       from information_schema.views v
       cross join pg_roles r
      where v.table_schema = 'public'
        and r.rolname in ('mas_radar_viewer','mas_radar_finance_operator','mas_radar_finance_approver','mas_radar_finance_manager','mas_radar_admin')
        and (
          has_table_privilege(r.oid, format('public.%I', v.table_name), 'INSERT')
          or has_table_privilege(r.oid, format('public.%I', v.table_name), 'UPDATE')
          or has_table_privilege(r.oid, format('public.%I', v.table_name), 'DELETE')
        )`,
  )).rows;
  const viewCols = (await owner.query<{ table_name: string; column_name: string }>(
    `select distinct on (table_name) table_name, column_name
       from information_schema.columns
      where table_schema = 'public' and table_name = any($1::text[])
      order by table_name, case when is_updatable = 'YES' then 0 else 1 end, ordinal_position`,
    [[...targetViewNames]],
  )).rows;
  const colByView = new Map(viewCols.map((r) => [r.table_name, r.column_name]));

  const viewWriteFailures: string[] = [];
  for (const tier of ["viewer", "finance_operator"] as const) {
    await asTier(tier, async (c) => {
      for (const view of targetViewNames) {
        const col = colByView.get(view) ?? "id";
        for (const [verb, sql] of [
          ["UPDATE", `update public.${view} set "${col}" = "${col}" where false`],
          ["DELETE", `delete from public.${view} where false`],
        ] as const) {
          await c.query("savepoint sp_view");
          try {
            await c.query(sql);
            await c.query("rollback to savepoint sp_view");
            viewWriteFailures.push(`${tier}/${view}/${verb}: KABUL EDİLDİ`);
          } catch (e) {
            await c.query("rollback to savepoint sp_view");
            const code = sqlstate(e);
            const isUpdatable = updatableByView.get(view) !== false;
            const okCode = isUpdatable ? code === "42501" : code === "42501" || code === "55000";
            if (!okCode) {
              viewWriteFailures.push(`${tier}/${view}/${verb}: beklenen ${isUpdatable ? "42501" : "42501|55000"}, gelen ${code}`);
            }
          }
        }
      }
    });
  }
  for (const w of writableViews) {
    viewWriteFailures.push(`GRANT SIZINTISI: ${w.role_name} -> ${w.view_name}`);
  }
  record("0098-2: görünümler üzerinden UPDATE/DELETE reddediliyor ve 5 katmanda sıfır görünüm yazma izni var",
    viewWriteFailures.length === 0,
    viewWriteFailures.length === 0
      ? `2 katman × ${targetViewNames.length} görünüm × 2 fiil reddedildi; yazılabilir görünüm = 0`
      : viewWriteFailures.join(" | "));

  // approval_queue readable under security_invoker = true by viewer & finance_approver with display name populated.
  const approvalQueueName = await asTier("viewer", async (c) => {
    await c.query(`select set_config('app.user_id',$1,true)`, [selfId]);
    const res = await c.query<{ requested_by_name: string | null }>(
      `select requested_by_name from public.approval_queue where id = $1`,
      [rowLevel.own],
    );
    return res.rows[0]?.requested_by_name ?? null;
  });
  record("0098-2b: approval_queue security_invoker=true altında görünen adı (PII sızdırmadan) döndürüyor",
    approvalQueueName === "P24B maker",
    `requested_by_name=${JSON.stringify(approvalQueueName)}`);

  // Admin revoking another user's active session returns rowCount === 1.
  const adminUserId = (await owner.query<{ id: string }>(
    `select id from public.users where username = 'p24b_fixture_admin'`,
  )).rows[0].id;
  const sessionFixture = await asOwner(async (oc) => {
    const tokenHash = `p39_sess_${Math.random().toString(36).slice(2, 10)}`;
    const sid = (await oc.query<{ id: string }>(
      `insert into public.sessions (user_id, token_hash, expires_at)
       values ($1, $2, now() + interval '1 day') returning id`,
      [selfId, tokenHash],
    )).rows[0].id;
    await oc.query("commit");
    return { sid };
  });

  const managerRevokeCount = await asTier("finance_manager", async (c) => {
    await c.query(`select set_config('app.user_id',$1,true)`, [rowLevel.maker]);
    return (await c.query(
      `update public.sessions set revoked_at = now() where id = $1 and revoked_at is null`,
      [sessionFixture.sid],
    )).rowCount ?? 0;
  });
  const adminRevokeCount = await asTier("admin", async (c) => {
    await c.query(`select set_config('app.user_id',$1,true)`, [adminUserId]);
    return (await c.query(
      `update public.sessions set revoked_at = now() where id = $1 and revoked_at is null`,
      [sessionFixture.sid],
    )).rowCount ?? 0;
  });
  record("0098-3: mas_radar_admin başka kullanıcının aktif oturumunu iptal edebiliyor (rowCount=1; manager=0)",
    adminRevokeCount === 1 && managerRevokeCount === 0,
    `admin=${adminRevokeCount}, manager=${managerRevokeCount}`);

  // finance_approver writeback on mapping_reviews & external_assumptions succeeds, while finance_operator
  // self-approval on budget_lines.version_status = 'approved' is rejected with 42501.
  const p39Fixtures = await asOwner(async (oc) => {
    const wbId = (await oc.query<{ id: string }>(
      `insert into public.source_workbooks (original_filename, status)
       values ('p39_probe.xlsx', 'parsed') returning id`,
    )).rows[0].id;
    const mrId = (await oc.query<{ id: string }>(
      `insert into public.mapping_reviews (workbook_id, issue_type, severity, status, message)
       values ($1, 'p39_probe', 'medium', 'open', 'P39 mapping review fixture') returning id`,
      [wbId],
    )).rows[0].id;
    const eaId = (await oc.query<{ id: string }>(
      `insert into public.external_assumptions
         (assumption_type, label, value_numeric, unit, source_kind, source_name, source_date, review_status)
       values ('other', 'P39 assumption fixture', 100.00, 'percent', 'manual', 'P39', '2026-05-01', 'pending_review')
       returning id`,
    )).rows[0].id;
    const bName = `P39 Bütçe ${Math.random().toString(36).slice(2, 8)}`;
    const budgetId = (await oc.query<{ id: string }>(
      `insert into public.budgets (name, fiscal_year, period_kind, currency, created_by)
       values ($1, 2026, 'monthly', 'TRY', $2) returning id`,
      [bName, ownedProbe.u],
    )).rows[0].id;
    const budgetLineId = (await oc.query<{ id: string }>(
      `insert into public.budget_lines (budget_id, period_start, direction, amount, currency, version_status, created_by)
       values ($1, '2026-05-01', 'expense', 25000.00, 'TRY', 'draft', $2) returning id`,
      [budgetId, ownedProbe.u],
    )).rows[0].id;
    await oc.query("commit");
    return { mrId, eaId, budgetId, budgetLineId };
  });

  const approverWritebacks = await asTier("finance_approver", async (c) => {
    await c.query(`select set_config('app.user_id',$1,true)`, [rowLevel.maker]);
    const mrRows = (await c.query(
      `update public.mapping_reviews set status = 'accepted', reviewed_at = now(), reviewed_by = $2 where id = $1`,
      [p39Fixtures.mrId, rowLevel.maker],
    )).rowCount ?? 0;
    const eaRows = (await c.query(
      `update public.external_assumptions
          set review_status = 'approved', reviewed_at = now(), reviewed_by = $2
        where id = $1`,
      [p39Fixtures.eaId, rowLevel.maker],
    )).rowCount ?? 0;
    let payloadTamperRefused = false;
    await c.query("savepoint sp_tamper");
    try {
      await c.query(
        `update public.mapping_reviews set message = 'SAHTE', status = 'rejected', reviewed_by = $2 where id = $1`,
        [p39Fixtures.mrId, rowLevel.maker],
      );
      await c.query("rollback to savepoint sp_tamper");
    } catch (e) {
      await c.query("rollback to savepoint sp_tamper");
      payloadTamperRefused = sqlstate(e) === "42501";
    }
    return { mrRows, eaRows, payloadTamperRefused };
  });
  record("0098-4a: mas_radar_finance_approver mapping_reviews & external_assumptions kararını geri yazabiliyor (içerik tahrifatı 42501)",
    approverWritebacks.mrRows === 1 && approverWritebacks.eaRows === 1 && approverWritebacks.payloadTamperRefused,
    `mr=${approverWritebacks.mrRows}, ea=${approverWritebacks.eaRows}, tamperRefused=${approverWritebacks.payloadTamperRefused}`);

  const operatorSelfApproveRefused = await asTier("finance_operator", async (c) => {
    await c.query(`select set_config('app.user_id',$1,true)`, [ownedProbe.u]);
    await c.query("savepoint sp_budget");
    try {
      await c.query(
        `update public.budget_lines
            set version_status = 'approved', approved_at = now(), approved_by = $2
          where id = $1`,
        [p39Fixtures.budgetLineId, ownedProbe.u],
      );
      await c.query("rollback to savepoint sp_budget");
      return false;
    } catch (e) {
      await c.query("rollback to savepoint sp_budget");
      return sqlstate(e) === "42501";
    }
  });
  const approverBudgetApproveRows = await asTier("finance_approver", async (c) => {
    await c.query(`select set_config('app.user_id',$1,true)`, [rowLevel.maker]);
    return (await c.query(
      `update public.budget_lines
          set version_status = 'approved', approved_at = now(), approved_by = $2
        where id = $1`,
      [p39Fixtures.budgetLineId, rowLevel.maker],
    )).rowCount ?? 0;
  });
  record("0098-4b: mas_radar_finance_operator kendi kendine bütçe onaylayamıyor (42501); finance_approver onaylayabiliyor (rowCount=1)",
    operatorSelfApproveRefused && approverBudgetApproveRows === 1,
    `operatorRefused=${operatorSelfApproveRefused}, approverRows=${approverBudgetApproveRows}`);

  const spoofingRefused = await asTier("finance_operator", async (c) => {
    await c.query(`select set_config('app.user_id',$1,true)`, [ownedProbe.u]);
    await c.query("savepoint sp_spoof");
    try {
      await c.query(
        `insert into public.saved_views (name, module_key, filters, created_by)
         values ('P39 spoof', 'payments', '{}'::jsonb, $1)`,
        [selfId],
      );
      await c.query("rollback to savepoint sp_spoof");
      return false;
    } catch (e) {
      await c.query("rollback to savepoint sp_spoof");
      return sqlstate(e) === "42501";
    }
  });
  record("0098-5: saved_views üzerinde başka kullanıcı adına (created_by sahteciliği) INSERT 42501 ile reddediliyor",
    spoofingRefused,
    `spoofingRefused=${spoofingRefused}`);

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
